import { Buffer } from 'node:buffer';
import type { MiddlewareHandler } from 'hono';

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
 * Minimal x402 middleware implementing the server-side HTTP 402 payment flow.
 *
 * 1. No payment header → 402 with PAYMENT-REQUIRED header
 * 2. Payment header → verify with facilitator → execute handler → settle
 */
export function x402Middleware(facilitatorUrl: string, routeConfigs: Record<string, X402RouteConfig>): MiddlewareHandler {
	return async (c, next) => {
		const pathname = new URL(c.req.url).pathname;
		const routeKey = `${c.req.method} ${pathname}`;
		const config = routeConfigs[routeKey];

		if (!config) {
			return next();
		}

		const paymentHeader = c.req.header('payment-signature') || c.req.header('x-payment');

		if (!paymentHeader) {
			const paymentRequired = {
				x402Version: X402_VERSION,
				resource: { url: c.req.url, description: config.description, mimeType: config.mimeType },
				accepts: [config.requirements],
			};
			return c.json(paymentRequired, 402, {
				'PAYMENT-REQUIRED': toBase64(JSON.stringify(paymentRequired)),
			});
		}

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
				// Attach settlement receipt to response
				const headers = new Headers(c.res.headers);
				headers.set('PAYMENT-RESPONSE', toBase64(JSON.stringify(settlement)));
				c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
			} catch {
				// Settlement failed — still return the resource but log the failure
				console.error('x402: settlement call failed');
			}
		}
	};
}
