import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
	Account,
	Address,
	Contract,
	Keypair,
	Networks,
	TransactionBuilder,
	rpc,
	nativeToScVal,
} from '@stellar/stellar-sdk';
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, afterEach } from 'vitest';

const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const TESTNET_PASSPHRASE = Networks.TESTNET;

function toBase64(str: string): string {
	return Buffer.from(str, 'utf-8').toString('base64');
}
function fromBase64(b64: string): string {
	return Buffer.from(b64, 'base64').toString('utf-8');
}

function writeBigInt128BE(buf: Buffer, value: bigint, offset: number): void {
	const mask64 = (1n << 64n) - 1n;
	const hi = (value >> 64n) & mask64;
	const lo = value & mask64;
	buf.writeBigUInt64BE(hi, offset);
	buf.writeBigUInt64BE(lo, offset + 8);
}

function stateMessage(
	keypair: Keypair,
	channelId: string,
	iteration: bigint,
	agentBalance: bigint,
	serverBalance: bigint,
): { signatureHex: string; message: Buffer } {
	const channelIdBytes = Buffer.from(channelId, 'hex');
	const buf = Buffer.alloc(72);
	channelIdBytes.copy(buf, 0);
	buf.writeBigUInt64BE(iteration, 32);
	writeBigInt128BE(buf, agentBalance, 40);
	writeBigInt128BE(buf, serverBalance, 56);
	return { signatureHex: Buffer.from(keypair.sign(buf)).toString('hex'), message: buf };
}

function signDemoState(
	keypair: Keypair,
	channelId: string,
	iteration: bigint,
	agentBalance: bigint,
	serverBalance: bigint,
): string {
	return stateMessage(keypair, channelId, iteration, agentBalance, serverBalance).signatureHex;
}

function makeDemoChannelPaymentSignature(): string {
	const agent = Keypair.random();
	const channelId = 'aa'.repeat(32);
	const iteration = 1n;
	const agentBalance = 990000n;
	const serverBalance = 10000n;
	const deposit = 1000000n;
	return toBase64(
		JSON.stringify({
			x402Version: 2,
			accepted: { scheme: 'channel', network: 'stellar:testnet' },
			payload: {
				scheme: 'channel',
				mode: 'stateless-demo',
				channelId,
				iteration: iteration.toString(),
				agentBalance: agentBalance.toString(),
				serverBalance: serverBalance.toString(),
				deposit: deposit.toString(),
				agentPublicKey: agent.publicKey(),
				agentSig: signDemoState(agent, channelId, iteration, agentBalance, serverBalance),
			},
		}),
	);
}

function deriveChannelId(agentPublicKey: string, nonce: Buffer): string {
	return createHash('sha256')
		.update(Buffer.from(Keypair.fromPublicKey(agentPublicKey).rawPublicKey()))
		.update(nonce)
		.digest('hex');
}

function buildStateChannelOpenTransaction(
	channelContract: string,
	asset: string,
	payTo: string,
	serverPublicKey: string,
	payer: Keypair,
	agentKey: Keypair,
	deposit: bigint,
	nonce: Buffer,
): string {
	const account = new Account(payer.publicKey(), '1');
	return new TransactionBuilder(account, {
		fee: '100',
		networkPassphrase: TESTNET_PASSPHRASE,
	})
		.addOperation(
			new Contract(channelContract).call(
				'open_channel',
				new Address(payer.publicKey()).toScVal(),
				nativeToScVal(Buffer.from(agentKey.rawPublicKey())),
				new Address(payTo).toScVal(),
				nativeToScVal(Buffer.from(Keypair.fromPublicKey(serverPublicKey).rawPublicKey())),
				new Address(asset).toScVal(),
				nativeToScVal(deposit, { type: 'i128' }),
				nativeToScVal(nonce),
			),
		)
		.setTimeout(30)
		.build()
		.toEnvelope()
		.toXDR('base64');
}

function makeStateChannelOpenPaymentSignature(
	channelAccept: Record<string, unknown>,
	deposit: bigint,
	payer: Keypair,
	agentKey: Keypair,
): string {
	const nonce = Buffer.alloc(32, 7);
	const channelId = deriveChannelId(agentKey.publicKey(), nonce);
	const initialStateSignature = signDemoState(agentKey, channelId, 0n, deposit, 0n);
	return toBase64(
		JSON.stringify({
			x402Version: 2,
			accepted: channelAccept,
			payload: {
				action: 'open',
				transaction: buildStateChannelOpenTransaction(
					channelAccept.extra.channelContract as string,
					channelAccept.asset as string,
					channelAccept.payTo as string,
					channelAccept.extra.serverPublicKey as string,
					payer,
					agentKey,
					deposit,
					nonce,
				),
				initialStateSignature,
			},
		}),
	);
}

function makeStateChannelPayPaymentSignature(
	channelAccept: Record<string, unknown>,
	channelId: string,
	agentKey: Keypair,
	iteration: bigint,
	agentBalance: bigint,
	serverBalance: bigint,
): string {
	return toBase64(
		JSON.stringify({
			x402Version: 2,
			accepted: channelAccept,
			payload: {
				action: 'pay',
				channelId,
				iteration: iteration.toString(),
				agentBalance: agentBalance.toString(),
				serverBalance: serverBalance.toString(),
				agentSig: signDemoState(agentKey, channelId, iteration, agentBalance, serverBalance),
			},
		}),
	);
}

function makeStateChannelClosePaymentSignature(
	channelAccept: Record<string, unknown>,
	channelId: string,
	agentKey: Keypair,
): string {
	return toBase64(
		JSON.stringify({
			x402Version: 2,
			accepted: channelAccept,
			payload: {
				action: 'close',
				channelId,
				signature: Buffer.from(
					agentKey.sign(Buffer.concat([Buffer.from(channelId, 'hex'), Buffer.from('close', 'utf8')])),
				).toString('hex'),
			},
		}),
	);
}

function mockChannelRpc(): void {
	const originalFetch = globalThis.fetch;
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (
			url === 'https://soroban-testnet.stellar.org' ||
			url === 'https://soroban-rpc.testnet.stellar.gateway.fm' ||
			url === 'https://soroban-rpc.testnet.stellar.gateway.fm/'
		) {
			const payload = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
			if (payload.method === 'sendTransaction') {
				return new Response(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'sendTransaction',
						result: { hash: 'tx-hash-123', status: 'PENDING' },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
			if (payload.method === 'getTransaction') {
				return new Response(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 'getTransaction',
						result: { status: 'SUCCESS' },
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}
		}
		return originalFetch(input, init);
	});
	vi.spyOn(rpc.Server.prototype, 'getAccount').mockImplementation(
		async (accountId) => new Account(String(accountId), '1'),
	);
	vi.spyOn(rpc.Server.prototype, 'prepareTransaction').mockImplementation(
		async (tx) => tx as Awaited<ReturnType<(typeof rpc.Server.prototype)['prepareTransaction']>>,
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

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
				expect((channel.extra as Record<string, unknown>).channelMode).toBe('stellar-state-channel-v1');
				expect((channel.extra as Record<string, unknown>).channelContract).toBeTruthy();
				expect((channel.extra as Record<string, unknown>).serverPublicKey).toBeTruthy();
				expect((channel.extra as Record<string, unknown>).supportsClose).toBe(true);
				expect((channel.extra as Record<string, unknown>).supportsTopUp).toBe(false);
				expect(channel.price).toBe('10000');
				expect(channel.serverPublicKey).toBeTruthy();
				expect(channel.channelContract).toBeTruthy();
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

	it('accepts valid stateless demo channel payments wrapped in x402 PAYMENT-SIGNATURE payloads', async () => {
		const resp = await SELF.fetch('https://example.com/mint/attractor', {
			headers: {
				'payment-signature': makeDemoChannelPaymentSignature(),
			},
		});
		expect(resp.status).toBe(200);
		expect(resp.headers.get('PAYMENT-RESPONSE')).toBeTruthy();
	});

	it('opens a real x402 state channel, accepts a pay action, and closes it on-chain', async () => {
		mockChannelRpc();
		const discoveryResp = await SELF.fetch('https://example.com/.well-known/x402.json');
		const discovery = (await discoveryResp.json()) as Record<string, unknown>;
		const endpoint = (discovery.endpoints as Array<Record<string, unknown>>).find(
			(item) => item.path === '/mint/attractor',
		)!;
		const channelAccept = (endpoint.accepts as Array<Record<string, unknown>>).find(
			(item) => item.scheme === 'channel',
		)!;

		const payer = Keypair.random();
		const agentKey = Keypair.random();
		const deposit = 1000000n;

		const openResp = await SELF.fetch('https://example.com/mint/attractor', {
			headers: {
				'payment-signature': makeStateChannelOpenPaymentSignature(channelAccept, deposit, payer, agentKey),
			},
		});
		expect(openResp.status).toBe(200);
		const openBody = (await openResp.json()) as Record<string, unknown>;
		expect(openBody.success).toBe(true);
		expect(openBody.resourceGranted).toBe(false);
		expect(typeof openBody.channelId).toBe('string');
		expect(openBody.transaction).toBe('tx-hash-123');
		expect(openBody.iteration).toBe('0');
		expect(openBody.serverSig).toBeTruthy();

		const payResp = await SELF.fetch('https://example.com/mint/attractor?seed=7', {
			headers: {
				'payment-signature': makeStateChannelPayPaymentSignature(
					channelAccept,
					String(openBody.channelId),
					agentKey,
					1n,
					990000n,
					10000n,
				),
			},
		});
		expect(payResp.status).toBe(200);
		expect(payResp.headers.get('content-type')).toBe('image/png');
		const settlement = JSON.parse(fromBase64(payResp.headers.get('PAYMENT-RESPONSE')!));
		expect(settlement.channelId).toBe(openBody.channelId);
		expect(settlement.currentCumulative).toBe('10000');
		expect(settlement.remainingBalance).toBe('990000');
		expect(settlement.iteration).toBe('1');
		expect(settlement.serverSig).toBeTruthy();
		expect(payResp.headers.get('X-Payment-Response')).toBeTruthy();

		const closeResp = await SELF.fetch('https://example.com/mint/attractor', {
			headers: {
				'payment-signature': makeStateChannelClosePaymentSignature(
					channelAccept,
					String(openBody.channelId),
					agentKey,
				),
			},
		});
		expect(closeResp.status).toBe(200);
		const closeBody = (await closeResp.json()) as Record<string, unknown>;
		expect(closeBody.success).toBe(true);
		expect(closeBody.channelId).toBe(openBody.channelId);
		expect(closeBody.transaction).toBe('tx-hash-123');
		expect(closeBody.finalAmount).toBe('10000');
		expect(closeBody.refunded).toBe('990000');
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

	it('warns and omits channel requirements when channel bindings are blank', async () => {
		const originalServerSecret = env.CHANNEL_SERVER_SECRET;
		const originalFacilitatorSecret = env.CHANNEL_FACILITATOR_SECRET;
		const originalContractId = env.CHANNEL_CONTRACT_ID;
		env.CHANNEL_SERVER_SECRET = '';
		env.CHANNEL_FACILITATOR_SECRET = '';
		env.CHANNEL_CONTRACT_ID = '';
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		try {
			const resp = await SELF.fetch('https://example.com/.well-known/x402.json');
			expect(resp.status).toBe(200);
			const body = (await resp.json()) as Record<string, unknown>;
			const endpoints = body.endpoints as Array<Record<string, unknown>>;
			for (const ep of endpoints) {
				const accepts = ep.accepts as Array<Record<string, unknown>>;
				expect(accepts.find((a) => a.scheme === 'channel')).toBeUndefined();
			}
			expect(warn).toHaveBeenCalledWith(
				'x402 channel support disabled due to missing or blank bindings',
				{ missing: ['CHANNEL_SERVER_SECRET', 'CHANNEL_FACILITATOR_SECRET', 'CHANNEL_CONTRACT_ID'] },
			);
		} finally {
			env.CHANNEL_SERVER_SECRET = originalServerSecret;
			env.CHANNEL_FACILITATOR_SECRET = originalFacilitatorSecret;
			env.CHANNEL_CONTRACT_ID = originalContractId;
		}
	});
});
