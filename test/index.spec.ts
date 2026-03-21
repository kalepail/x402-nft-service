import { Buffer } from 'node:buffer';
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';

const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

function toBase64(str: string): string {
	return Buffer.from(str, 'utf-8').toString('base64');
}
function fromBase64(b64: string): string {
	return Buffer.from(b64, 'base64').toString('utf-8');
}

function makeChannelPaymentSignature(overrides: Record<string, unknown> = {}): string {
	return toBase64(
		JSON.stringify({
			x402Version: 2,
			accepted: { scheme: 'channel', network: 'stellar:testnet' },
			payload: {
				scheme: 'channel',
				mode: 'stateless-demo',
				channelId: 'aa'.repeat(32),
				iteration: '1',
				agentBalance: '999000',
				serverBalance: '1000',
				deposit: '1000000',
				agentPublicKey: 'GBAZQWDLJRWQ6ZZ6L7K3Z4RJOJ2WQFJJWQ5YAXHNSJZPZ7XIGK7QHCM5',
				agentSig: '00'.repeat(64),
				...overrides,
			},
		}),
	);
}

describe('free endpoints', () => {
	it('GET / returns service info', async () => {
		const resp = await SELF.fetch('https://example.com/');
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as Record<string, unknown>;
		expect(body.name).toBe('x402 Generative NFT Service');
		expect(body.styles).toEqual(['attractor', 'flow', 'hyperbolic', 'moire']);
		const discovery = body.discovery as Record<string, string>;
		expect(discovery.openapi).toContain('/openapi.json');
		expect(discovery.x402).toContain('/.well-known/x402.json');
	});

	it('GET /styles lists all styles with full shape', async () => {
		const resp = await SELF.fetch('https://example.com/styles');
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as Array<Record<string, unknown>>;
		expect(body.length).toBe(4);
		for (const item of body) {
			expect(item).toHaveProperty('key');
			expect(item).toHaveProperty('name');
			expect(item).toHaveProperty('description');
			expect(item).toHaveProperty('previewUrl');
			expect(item).toHaveProperty('mintUrl');
			expect((item.previewUrl as string).startsWith('/preview/')).toBe(true);
			expect((item.mintUrl as string).startsWith('/mint/')).toBe(true);
		}
	});

	it('GET /preview/:style returns PNG', async () => {
		const resp = await SELF.fetch('https://example.com/preview/attractor');
		expect(resp.status).toBe(200);
		expect(resp.headers.get('content-type')).toBe('image/png');
		const body = new Uint8Array(await resp.arrayBuffer());
		// PNG magic bytes: 0x89 P N G
		expect(body[0]).toBe(0x89);
		expect(body[1]).toBe(0x50); // P
		expect(body[2]).toBe(0x4e); // N
		expect(body[3]).toBe(0x47); // G
	});

	it('GET /preview/:style sets long-lived cache-control', async () => {
		const resp = await SELF.fetch('https://example.com/preview/flow');
		expect(resp.headers.get('cache-control')).toBe('public, max-age=86400');
	});

	it('GET /preview/invalid returns 404', async () => {
		const resp = await SELF.fetch('https://example.com/preview/invalid');
		expect(resp.status).toBe(404);
	});
});

describe('discovery endpoints', () => {
	it('GET /.well-known/x402.json returns valid x402 manifest', async () => {
		const resp = await SELF.fetch('https://example.com/.well-known/x402.json');
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as Record<string, unknown>;
		expect(body.x402Version).toBe(2);
		expect(body.facilitator).toBe('https://x402.org/facilitator');
		const endpoints = body.endpoints as Array<Record<string, unknown>>;
		expect(endpoints).toHaveLength(4);
		const paths = endpoints.map((e) => e.path);
		expect(paths).toContain('/mint/attractor');
		expect(paths).toContain('/mint/flow');
		expect(paths).toContain('/mint/hyperbolic');
		expect(paths).toContain('/mint/moire');
		for (const ep of endpoints) {
			expect(ep.method).toBe('GET');
			expect(ep.mimeType).toBe('image/png');
			expect((ep.url as string).startsWith('https://')).toBe(true);
			const accepts = ep.accepts as Array<Record<string, unknown>>;
			// exact scheme is always present; channel scheme is present when CHANNEL_SERVER_SECRET is set
			expect(accepts.length).toBeGreaterThanOrEqual(1);
			const exact = accepts.find((a) => a.scheme === 'exact')!;
			expect(exact).toBeDefined();
			expect(exact.network).toBe('stellar:testnet');
			expect(exact.asset).toBe(USDC_TESTNET);
			expect(exact.amount).toBe('10000');
			expect(exact.payTo).toBe(env.STELLAR_PAY_TO);
			expect(exact.maxTimeoutSeconds).toBe(60);
			expect((exact.extra as Record<string, unknown>).areFeesSponsored).toBe(true);
			const channel = accepts.find((a) => a.scheme === 'channel');
			if (channel) {
				expect(channel.amount).toBe('10000');
				expect(channel.payTo).toBe(env.STELLAR_PAY_TO);
				expect(channel.maxTimeoutSeconds).toBe(60);
				expect((channel.extra as Record<string, unknown>).channelMode).toBe('stateless-demo');
				expect((channel.extra as Record<string, unknown>).serverPublicKey).toBeTruthy();
				expect(channel.price).toBe('10000');
				expect(channel.serverPublicKey).toBeTruthy();
			}
		}
	});

	it('GET /openapi.json returns valid OpenAPI 3.1 spec', async () => {
		const resp = await SELF.fetch('https://example.com/openapi.json');
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as Record<string, unknown>;
		expect(body.openapi).toBe('3.1.0');
		const info = body.info as Record<string, unknown>;
		expect(info.title).toBe('x402 Generative NFT Service');
		expect(info['x-agent-instructions']).toBeTruthy();
		const paths = body.paths as Record<string, unknown>;
		expect(paths).toHaveProperty('/styles');
		expect(paths).toHaveProperty('/preview/{style}');
		expect(paths).toHaveProperty('/mint/{style}');
		// Mint path must document both 200 and 402 responses
		const mintPath = (paths['/mint/{style}'] as Record<string, unknown>).get as Record<string, unknown>;
		const responses = mintPath.responses as Record<string, unknown>;
		expect(responses).toHaveProperty('200');
		expect(responses).toHaveProperty('402');
	});
});

describe('x402 payment gate', () => {
	it('returns 402 when no payment header is sent', async () => {
		const resp = await SELF.fetch('https://example.com/mint/attractor');
		expect(resp.status).toBe(402);

		const prHeader = resp.headers.get('PAYMENT-REQUIRED');
		expect(prHeader).toBeTruthy();

		const decoded = JSON.parse(fromBase64(prHeader!));
		expect(decoded.x402Version).toBe(2);
		expect(decoded.accepts.length).toBeGreaterThanOrEqual(1);
		const exact = decoded.accepts.find((a: Record<string, unknown>) => a.scheme === 'exact');
		expect(exact).toBeDefined();
		expect(exact.network).toBe('stellar:testnet');
		expect(exact.asset).toBe(USDC_TESTNET);
		expect(exact.amount).toBe('10000');
		expect(exact.payTo).toBe(env.STELLAR_PAY_TO);
		expect(exact.maxTimeoutSeconds).toBe(60);
		expect(exact.extra.areFeesSponsored).toBe(true);
	});

	it('returns 402 for all gated styles', async () => {
		for (const style of ['attractor', 'flow', 'hyperbolic', 'moire']) {
			const resp = await SELF.fetch(`https://example.com/mint/${style}`);
			expect(resp.status).toBe(402);
			expect(resp.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
		}
	});

	it('GET /mint/unknown-style returns 404 without triggering x402 gate', async () => {
		const resp = await SELF.fetch('https://example.com/mint/unknown');
		expect(resp.status).toBe(404);
		expect(resp.headers.get('PAYMENT-REQUIRED')).toBeNull();
	});

	it('returns 400 for malformed payment header', async () => {
		const resp = await SELF.fetch('https://example.com/mint/attractor', {
			headers: { 'payment-signature': 'not-valid-base64!!!' },
		});
		expect(resp.status).toBe(400);
	});

	it('returns 402 when facilitator says payment is invalid', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes('/facilitator/verify')) {
				return new Response(JSON.stringify({ isValid: false, invalidReason: 'expired auth entries' }), {
					headers: { 'Content-Type': 'application/json' },
				});
			}
			return originalFetch(input, init);
		};

		try {
			const fakePayload = toBase64(
				JSON.stringify({
					x402Version: 2,
					accepted: { scheme: 'exact', network: 'stellar:testnet' },
					payload: { transaction: 'fakexdr' },
				}),
			);

			const resp = await SELF.fetch('https://example.com/mint/attractor', {
				headers: { 'payment-signature': fakePayload },
			});
			expect(resp.status).toBe(402);
			const body = (await resp.json()) as Record<string, unknown>;
			expect(body.error).toBe('expired auth entries');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it('accepts channel payments wrapped in x402 PAYMENT-SIGNATURE payloads', async () => {
		const resp = await SELF.fetch('https://example.com/mint/attractor', {
			headers: {
				'payment-signature': makeChannelPaymentSignature(),
			},
		});
		expect(resp.status).toBe(402);
	});

	it('returns PNG and settlement header when payment is valid', async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes('/facilitator/verify')) {
				return new Response(JSON.stringify({ isValid: true, payer: 'GBUYER...' }), {
					headers: { 'Content-Type': 'application/json' },
				});
			}
			if (url.includes('/facilitator/settle')) {
				return new Response(
					JSON.stringify({ success: true, transaction: 'abc123def456', network: 'stellar:testnet', payer: 'GBUYER...' }),
					{ headers: { 'Content-Type': 'application/json' } },
				);
			}
			return originalFetch(input, init);
		};

		try {
			const fakePayload = toBase64(
				JSON.stringify({
					x402Version: 2,
					accepted: { scheme: 'exact', network: 'stellar:testnet' },
					payload: { transaction: 'validxdr' },
				}),
			);

			const resp = await SELF.fetch('https://example.com/mint/attractor?seed=42', {
				headers: { 'payment-signature': fakePayload },
			});
			expect(resp.status).toBe(200);
			expect(resp.headers.get('content-type')).toBe('image/png');

			const body = new Uint8Array(await resp.arrayBuffer());
			// PNG magic bytes
			expect(body[0]).toBe(0x89);
			expect(body[1]).toBe(0x50);
			expect(body.length).toBeGreaterThan(1000);

			const prHeader = resp.headers.get('PAYMENT-RESPONSE');
			expect(prHeader).toBeTruthy();
			const settlement = JSON.parse(fromBase64(prHeader!));
			expect(settlement.success).toBe(true);
			expect(settlement.transaction).toBe('abc123def456');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
