import { Buffer } from 'node:buffer';
import { env, SELF, fetchMock } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

function toBase64(str: string): string {
	return Buffer.from(str, 'utf-8').toString('base64');
}
function fromBase64(b64: string): string {
	return Buffer.from(b64, 'base64').toString('utf-8');
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => {
	fetchMock.assertNoPendingInterceptors();
});

describe('free endpoints', () => {
	it('GET / returns service info', async () => {
		const resp = await SELF.fetch('https://example.com/');
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as Record<string, unknown>;
		expect(body.name).toBe('x402 Generative NFT Service');
		expect(body.styles).toEqual(['attractor', 'flow', 'hyperbolic', 'moire']);
	});

	it('GET /styles lists all styles', async () => {
		const resp = await SELF.fetch('https://example.com/styles');
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as Array<Record<string, unknown>>;
		expect(body.length).toBe(4);
		expect(body[0]).toHaveProperty('key');
		expect(body[0]).toHaveProperty('name');
		expect(body[0]).toHaveProperty('description');
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

	it('GET /preview/invalid returns 404', async () => {
		const resp = await SELF.fetch('https://example.com/preview/invalid');
		expect(resp.status).toBe(404);
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
		expect(decoded.accepts).toHaveLength(1);
		expect(decoded.accepts[0].scheme).toBe('exact');
		expect(decoded.accepts[0].network).toBe('stellar:testnet');
		expect(decoded.accepts[0].asset).toBe(USDC_TESTNET);
		expect(decoded.accepts[0].amount).toBe('1000000');
		expect(decoded.accepts[0].payTo).toBe(env.STELLAR_PAY_TO);
		expect(decoded.accepts[0].maxTimeoutSeconds).toBe(60);
		expect(decoded.accepts[0].extra.areFeesSponsored).toBe(true);
	});

	it('returns 402 for all gated styles', async () => {
		for (const style of ['attractor', 'flow', 'hyperbolic', 'moire']) {
			const resp = await SELF.fetch(`https://example.com/mint/${style}`);
			expect(resp.status).toBe(402);
			expect(resp.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
		}
	});

	it('returns 400 for malformed payment header', async () => {
		const resp = await SELF.fetch('https://example.com/mint/attractor', {
			headers: { 'payment-signature': 'not-valid-base64!!!' },
		});
		expect(resp.status).toBe(400);
	});

	it('returns 402 when facilitator says payment is invalid', async () => {
		fetchMock
			.get('https://x402.org')
			.intercept({ path: '/facilitator/verify', method: 'POST' })
			.reply(200, { isValid: false, invalidReason: 'expired auth entries' });

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
	});

	it('returns PNG and settlement header when payment is valid', async () => {
		const facilitatorMock = fetchMock.get('https://x402.org');

		facilitatorMock.intercept({ path: '/facilitator/verify', method: 'POST' }).reply(200, { isValid: true, payer: 'GBUYER...' });

		facilitatorMock
			.intercept({ path: '/facilitator/settle', method: 'POST' })
			.reply(200, { success: true, transaction: 'abc123def456', network: 'stellar:testnet', payer: 'GBUYER...' });

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
	});
});
