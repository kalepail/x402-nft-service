import { Buffer } from 'node:buffer';
import type { Context, MiddlewareHandler, Next } from 'hono';
import { verifyChannelPayment, type ChannelConfig, type ChannelPaymentHeader, type ChannelPaymentResponse } from './channel';

const X402_VERSION = 2;

function toBase64(str: string): string {
	return Buffer.from(str, 'utf-8').toString('base64');
}

function fromBase64(b64: string): string {
	return Buffer.from(b64, 'base64').toString('utf-8');
}

export interface PaymentRequirements {
	scheme: string;
	network: string;
	asset: string;
	amount: string;
	payTo: string;
	maxTimeoutSeconds: number;
	extra: Record<string, unknown>;
}

export interface X402RouteConfig {
	requirements: PaymentRequirements;
	description?: string;
	mimeType?: string;
}

/**
 * x402 middleware supporting both exact and channel payment schemes.
 *
 * - Exact scheme: verify/settle via facilitator (on-chain per request)
 * - Channel scheme: verify locally via ed25519 (off-chain, ~microseconds)
 *
 * When channelConfig is provided, the 402 response advertises both schemes.
 * Clients choose which to use based on their needs.
 */
export function x402Middleware(
	facilitatorUrl: string,
	routeConfigs: Record<string, X402RouteConfig>,
	channelConfig?: ChannelConfig,
): MiddlewareHandler {
	return async (c, next) => {
		const pathname = new URL(c.req.url).pathname;
		const routeKey = `${c.req.method} ${pathname}`;
		const config = routeConfigs[routeKey];

		if (!config) {
			return next();
		}

		const paymentHeader = c.req.header('payment-signature') || c.req.header('x-payment');

		if (!paymentHeader) {
			return send402(c, config, channelConfig);
		}

		// Detect channel scheme: the header is raw JSON with scheme field
		// Exact scheme: the header is base64-encoded JSON
		const channelPayment = tryParseChannelHeader(paymentHeader);

		if (channelPayment && channelConfig) {
			return handleChannelPayment(c, next, channelPayment, channelConfig);
		}

		// Fall through to exact scheme
		return handleExactPayment(c, next, paymentHeader, facilitatorUrl, config);
	};
}

// ── Channel scheme (local verification, no facilitator) ──────────────────────

function tryParseChannelHeader(header: string): ChannelPaymentHeader | null {
	try {
		const parsed = JSON.parse(header);
		if (parsed && parsed.scheme === 'channel' && parsed.channelId && parsed.agentSig) {
			return parsed as ChannelPaymentHeader;
		}
	} catch {
		// Not JSON — likely base64-encoded exact scheme
	}
	return null;
}

async function handleChannelPayment(
	c: Context,
	next: Next,
	header: ChannelPaymentHeader,
	config: ChannelConfig,
): Promise<Response | void> {
	const result = verifyChannelPayment(header, config);

	if (!result.valid) {
		return c.json({ error: result.error }, 402);
	}

	// Execute the route handler
	await next();

	// Attach counter-signature to successful responses
	if (c.res.status < 400 && result.counterSig) {
		const responseHeader: ChannelPaymentResponse = {
			scheme: 'channel',
			channelId: header.channelId,
			iteration: header.iteration,
			serverSig: result.counterSig,
		};
		const headers = new Headers(c.res.headers);
		headers.set('X-Payment-Response', JSON.stringify(responseHeader));
		c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
	}
}

// ── Exact scheme (facilitator-based verification) ────────────────────────────

async function handleExactPayment(
	c: Context,
	next: Next,
	paymentHeader: string,
	facilitatorUrl: string,
	config: X402RouteConfig,
): Promise<Response | void> {
	let paymentPayload: unknown;
	try {
		paymentPayload = JSON.parse(fromBase64(paymentHeader));
	} catch {
		return c.json({ error: 'Invalid payment header encoding' }, 400);
	}

	// Verify with facilitator
	let verification: { isValid?: boolean; invalidReason?: string };
	try {
		const resp = await fetch(`${facilitatorUrl}/verify`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements: config.requirements }),
		});
		verification = (await resp.json()) as typeof verification;
	} catch (err) {
		return c.json({ error: 'Facilitator unreachable', detail: String(err) }, 502);
	}

	if (!verification.isValid) {
		const errPayload = {
			x402Version: X402_VERSION,
			error: verification.invalidReason || 'Payment verification failed',
			resource: { url: c.req.url },
			accepts: [config.requirements],
		};
		return c.json(errPayload, 402, {
			'PAYMENT-REQUIRED': toBase64(JSON.stringify(errPayload)),
		});
	}

	// Execute the route handler
	await next();

	// Only settle if the handler succeeded
	if (c.res.status < 400) {
		try {
			const resp = await fetch(`${facilitatorUrl}/settle`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ x402Version: X402_VERSION, paymentPayload, paymentRequirements: config.requirements }),
			});
			const settlement = await resp.json();
			const headers = new Headers(c.res.headers);
			headers.set('PAYMENT-RESPONSE', toBase64(JSON.stringify(settlement)));
			c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
		} catch {
			console.error('x402: settlement call failed');
		}
	}
}

// ── 402 response ─────────────────────────────────────────────────────────────

function send402(c: Context, config: X402RouteConfig, channelConfig?: ChannelConfig): Response {
	const accepts: unknown[] = [config.requirements];

	if (channelConfig) {
		accepts.push({
			scheme: 'channel',
			price: String(channelConfig.price),
			network: config.requirements.network,
			asset: config.requirements.asset,
			serverPublicKey: channelConfig.serverKeypair.publicKey(),
		});
	}

	const paymentRequired = {
		x402Version: X402_VERSION,
		resource: { url: c.req.url, description: config.description, mimeType: config.mimeType },
		accepts,
	};

	return c.json(paymentRequired, 402, {
		'PAYMENT-REQUIRED': toBase64(JSON.stringify(paymentRequired)),
	});
}
