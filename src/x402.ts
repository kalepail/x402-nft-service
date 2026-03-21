import { Buffer } from 'node:buffer';
import type { Context, MiddlewareHandler, Next } from 'hono';
import {
	DRAFT_CHANNEL_FACTORY_CONTRACT,
	DRAFT_REFUND_WAITING_PERIOD,
	networkPassphraseForNetwork,
	parseDraftOpenTransaction,
} from './channel-draft';
import {
	verifyChannelPayment,
	type ChannelConfig,
	type ChannelPaymentHeader,
	type ChannelPaymentResponse,
} from './channel';

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

interface X402PaymentPayload {
	x402Version: number;
	resource?: Record<string, unknown>;
	accepted?: Partial<PaymentRequirements> & { scheme?: string; extra?: Record<string, unknown> };
	payload?: Record<string, unknown>;
}

type ParsedChannelPayment =
	| { kind: 'demo'; header: ChannelPaymentHeader }
	| { kind: 'draft'; payload: X402PaymentPayload; action: 'open' | 'pay' };

function paymentResponseHeaders(settlement: Record<string, unknown>): Headers {
	return new Headers({
		'PAYMENT-RESPONSE': toBase64(JSON.stringify(settlement)),
		'Content-Type': 'application/json',
	});
}

function normalizeAcceptedRequirement(
	accepted: X402PaymentPayload['accepted'],
	requirements: PaymentRequirements,
): PaymentRequirements {
	return {
		scheme: accepted?.scheme ?? requirements.scheme,
		network: accepted?.network ?? requirements.network,
		asset: accepted?.asset ?? requirements.asset,
		amount: accepted?.amount ?? requirements.amount,
		payTo: accepted?.payTo ?? requirements.payTo,
		maxTimeoutSeconds: accepted?.maxTimeoutSeconds ?? requirements.maxTimeoutSeconds,
		extra: accepted?.extra ?? requirements.extra,
	};
}

function assertAcceptedMatchesRoute(
	accepted: PaymentRequirements,
	requirements: PaymentRequirements,
): void {
	if (accepted.scheme !== 'channel') throw new Error('channel payload must use scheme=channel');
	if (accepted.network !== requirements.network) throw new Error('channel payload network mismatch');
	if (accepted.asset !== requirements.asset) throw new Error('channel payload asset mismatch');
	if (accepted.amount !== requirements.amount) throw new Error('channel payload amount mismatch');
	if (accepted.payTo !== requirements.payTo) throw new Error('channel payload payTo mismatch');
}

export function buildChannelRequirements(
	config: X402RouteConfig,
	channelConfig: ChannelConfig,
): Record<string, unknown> {
	const suggestedDeposit = String(channelConfig.suggestedDeposit ?? channelConfig.price * 100n);
	return {
		scheme: 'channel',
		network: config.requirements.network,
		asset: config.requirements.asset,
		amount: String(channelConfig.price),
		payTo: config.requirements.payTo,
		maxTimeoutSeconds: config.requirements.maxTimeoutSeconds,
		extra: {
			areFeesSponsored: true,
			suggestedDeposit,
			factoryContract: DRAFT_CHANNEL_FACTORY_CONTRACT,
			refundWaitingPeriod: DRAFT_REFUND_WAITING_PERIOD,
			serverPublicKey: channelConfig.serverKeypair.publicKey(),
			channelMode: 'hybrid-experimental',
		},
		// Legacy demo fields kept for compatibility with existing clients.
		price: String(channelConfig.price),
		serverPublicKey: channelConfig.serverKeypair.publicKey(),
		suggestedDeposit,
	};
}

export function x402Middleware(
	facilitatorUrl: string,
	routeConfigs: Record<string, X402RouteConfig>,
	channelConfig?: ChannelConfig,
	channelState?: DurableObjectNamespace,
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

		const channelPayment = tryParseChannelPayment(paymentHeader);
		if (channelPayment && channelConfig) {
			if (channelPayment.kind === 'demo') {
				return handleDemoChannelPayment(c, next, channelPayment.header, channelConfig);
			}
			if (channelState) {
				return handleDraftChannelPayment(c, next, channelPayment, config, channelState);
			}
		}

		return handleExactPayment(c, next, paymentHeader, facilitatorUrl, config);
	};
}

function tryParseChannelPayment(header: string): ParsedChannelPayment | null {
	try {
		const parsed = JSON.parse(header);
		if (parsed && parsed.scheme === 'channel' && parsed.channelId && parsed.agentSig) {
			return { kind: 'demo', header: parsed as ChannelPaymentHeader };
		}
	} catch {
		// Not raw JSON, continue.
	}

	try {
		const decoded = JSON.parse(fromBase64(header)) as X402PaymentPayload;
		const payload = decoded.payload;
		if (decoded.accepted?.scheme !== 'channel' || !payload) {
			return null;
		}

		if (payload.action === 'open' || payload.action === 'pay') {
			return { kind: 'draft', payload: decoded, action: payload.action };
		}

		if (payload.channelId && payload.agentSig) {
			return {
				kind: 'demo',
				header: {
					scheme: 'channel',
					channelId: String(payload.channelId),
					iteration: String(payload.iteration),
					agentBalance: String(payload.agentBalance),
					serverBalance: String(payload.serverBalance),
					deposit: String(payload.deposit ?? '0'),
					agentPublicKey: String(payload.agentPublicKey),
					agentSig: String(payload.agentSig),
				},
			};
		}
	} catch {
		// Not a base64 x402 payload either.
	}

	return null;
}

async function handleDraftChannelPayment(
	c: Context,
	next: Next,
	payment: Extract<ParsedChannelPayment, { kind: 'draft' }>,
	config: X402RouteConfig,
	channelState: DurableObjectNamespace,
): Promise<Response | void> {
	const accepted = normalizeAcceptedRequirement(payment.payload.accepted, config.requirements);
	assertAcceptedMatchesRoute(accepted, config.requirements);

	if (payment.action === 'open') {
		return handleDraftOpen(c, payment.payload, accepted, channelState);
	}

	if (payment.action === 'pay') {
		return handleDraftPay(c, next, payment.payload, accepted, channelState);
	}

	return c.json({ error: 'Unsupported channel action' }, 400);
}

async function handleDraftOpen(
	c: Context,
	payload: X402PaymentPayload,
	accepted: PaymentRequirements,
	channelState: DurableObjectNamespace,
): Promise<Response> {
	const transaction = payload.payload?.transaction;
	const commitmentKey = payload.payload?.commitmentKey;
	if (typeof transaction !== 'string' || typeof commitmentKey !== 'string') {
		return c.json({ error: 'channel/open requires transaction and commitmentKey' }, 400);
	}

	const networkPassphrase = networkPassphraseForNetwork(accepted.network);
	let parsed;
	try {
		parsed = parseDraftOpenTransaction(transaction, networkPassphrase);
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
	}

	if (parsed.factoryContract !== DRAFT_CHANNEL_FACTORY_CONTRACT) {
		return c.json({ error: 'channel/open factoryContract mismatch' }, 402);
	}
	if (parsed.asset !== accepted.asset || parsed.payTo !== accepted.payTo) {
		return c.json({ error: 'channel/open transaction args mismatch challenge' }, 402);
	}
	if (parsed.commitmentKey !== commitmentKey) {
		return c.json({ error: 'channel/open commitmentKey mismatch' }, 402);
	}

	const stub = channelState.get(channelState.idFromName(parsed.channelId));
	const response = await stub.fetch('https://channel/open', {
		method: 'POST',
		body: JSON.stringify({
			channelId: parsed.channelId,
			asset: parsed.asset,
			payTo: parsed.payTo,
			payer: parsed.payer,
			commitmentKey: parsed.commitmentKey,
			deposit: parsed.deposit,
			refundWaitingPeriod: parsed.refundWaitingPeriod,
		}),
	});
	const settlement = (await response.json()) as Record<string, unknown>;
	return new Response(JSON.stringify(settlement), {
		status: response.status,
		headers: paymentResponseHeaders(settlement),
	});
}

async function handleDraftPay(
	c: Context,
	next: Next,
	payload: X402PaymentPayload,
	accepted: PaymentRequirements,
	channelState: DurableObjectNamespace,
): Promise<Response | void> {
	const channelId = payload.payload?.channelId;
	const cumulativeAmount = payload.payload?.cumulativeAmount;
	const signature = payload.payload?.signature;
	if (
		typeof channelId !== 'string' ||
		typeof cumulativeAmount !== 'string' ||
		typeof signature !== 'string'
	) {
		return c.json({ error: 'channel/pay requires channelId, cumulativeAmount, and signature' }, 400);
	}

	const stub = channelState.get(channelState.idFromName(channelId));
	const settlementResponse = await stub.fetch('https://channel/pay', {
		method: 'POST',
		body: JSON.stringify({
			channelId,
			cumulativeAmount,
			signature,
			expectedAmount: accepted.amount,
			networkPassphrase: networkPassphraseForNetwork(accepted.network),
		}),
	});
	const settlement = (await settlementResponse.json()) as Record<string, unknown>;
	if (!settlementResponse.ok) {
		return new Response(JSON.stringify(settlement), {
			status: settlementResponse.status,
			headers: paymentResponseHeaders(settlement),
		});
	}

	await next();
	if (c.res.status < 400) {
		const headers = new Headers(c.res.headers);
		headers.set('PAYMENT-RESPONSE', toBase64(JSON.stringify(settlement)));
		c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
	}
}

async function handleDemoChannelPayment(
	c: Context,
	next: Next,
	header: ChannelPaymentHeader,
	config: ChannelConfig,
): Promise<Response | void> {
	const result = verifyChannelPayment(header, config);
	if (!result.valid) {
		return c.json({ error: result.error }, 402);
	}

	await next();
	if (c.res.status < 400 && result.counterSig) {
		const responseHeader: ChannelPaymentResponse = {
			scheme: 'channel',
			channelId: header.channelId,
			iteration: header.iteration,
			serverSig: result.counterSig,
		};
		const settlement = {
			success: true,
			channelId: header.channelId,
			currentCumulative: header.serverBalance,
			remainingBalance: header.agentBalance,
			iteration: header.iteration,
		};
		const headers = new Headers(c.res.headers);
		headers.set('PAYMENT-RESPONSE', toBase64(JSON.stringify(settlement)));
		headers.set('X-Payment-Response', JSON.stringify(responseHeader));
		c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
	}
}

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

	await next();
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
		} catch (err) {
			console.error('x402: settlement call failed', err);
		}
	}
}

function send402(c: Context, config: X402RouteConfig, channelConfig?: ChannelConfig): Response {
	const accepts: unknown[] = [config.requirements];
	if (channelConfig) {
		accepts.push(buildChannelRequirements(config, channelConfig));
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
