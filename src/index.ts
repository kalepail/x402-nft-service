import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Keypair } from '@stellar/stellar-sdk';
import { x402Middleware, type X402RouteConfig } from './x402';
import type { ChannelConfig } from './channel';
import { STYLES, STYLE_KEYS, type StyleKey } from './generators';
import { svgToPng } from './render';

// Stellar testnet USDC (7 decimals)
const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const DEFAULT_FACILITATOR = 'https://x402.org/facilitator';
const PRICE_AMOUNT = '10000'; // $0.001 USDC (7 decimals)
const PRICE_BIGINT = 10_000n;
const NETWORK = 'stellar:testnet';

type Bindings = {
	STELLAR_PAY_TO: string;
	FACILITATOR_URL?: string;
	/** Server secret key for counter-signing channel states. Set as a Worker secret. */
	CHANNEL_SERVER_SECRET?: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors());

// ─── x402 payment gate on /mint/* ───────────────────────────────────────────

app.use('/mint/*', async (c, next) => {
	const facilitatorUrl = c.env.FACILITATOR_URL || DEFAULT_FACILITATOR;
	const payTo = c.env.STELLAR_PAY_TO;

	const routeConfigs: Record<string, X402RouteConfig> = {};
	for (const key of STYLE_KEYS) {
		routeConfigs[`GET /mint/${key}`] = {
			requirements: {
				scheme: 'exact',
				network: NETWORK,
				asset: USDC_TESTNET,
				amount: PRICE_AMOUNT,
				payTo,
				maxTimeoutSeconds: 60,
				extra: { areFeesSponsored: true },
			},
			description: STYLES[key].description,
			mimeType: 'image/png',
		};
	}

	// Enable channel scheme if server secret is configured
	let channelConfig: ChannelConfig | undefined;
	if (c.env.CHANNEL_SERVER_SECRET) {
		channelConfig = {
			serverKeypair: Keypair.fromSecret(c.env.CHANNEL_SERVER_SECRET),
			price: PRICE_BIGINT,
		};
	}

	const mw = x402Middleware(facilitatorUrl, routeConfigs, channelConfig);
	return mw(c, next);
});

// ─── Agent discovery endpoints ──────────────────────────────────────────────

app.get('/', (c) => {
	const baseUrl = new URL(c.req.url).origin;
	return c.json({
		name: 'x402 Generative NFT Service',
		description: 'Mathematically complex generative art gated by x402 micropayments on Stellar testnet',
		network: NETWORK,
		price: '$0.10 USDC',
		styles: STYLE_KEYS,
		endpoints: {
			styles: 'GET /styles',
			preview: 'GET /preview/:style',
			mint: 'GET /mint/:style?seed=<number>  (x402 payment required)',
		},
		discovery: {
			openapi: `${baseUrl}/openapi.json`,
			x402: `${baseUrl}/.well-known/x402.json`,
		},
	});
});

app.get('/openapi.json', (c) => {
	const baseUrl = new URL(c.req.url).origin;
	const payTo = c.env.STELLAR_PAY_TO;
	const styleEnum = STYLE_KEYS as unknown as string[];

	return c.json({
		openapi: '3.1.0',
		info: {
			title: 'x402 Generative NFT Service',
			version: '1.0.0',
			description:
				'Generates mathematically complex generative art (strange attractors, flow fields, hyperbolic tessellations, moire patterns) as PNG images. Minting requires an x402 micropayment of $0.10 USDC on Stellar testnet. Previews are free.',
			'x-agent-instructions':
				'To mint: GET /mint/{style}?seed={number}. The first request returns HTTP 402 with a PAYMENT-REQUIRED header containing base64-encoded JSON payment requirements. Build a Stellar Soroban transfer transaction for the specified USDC amount, sign the auth entries, and retry with a payment-signature header containing the base64-encoded payment payload. Use @x402/fetch or @x402/stellar to handle this automatically.',
		},
		servers: [{ url: baseUrl }],
		paths: {
			'/styles': {
				get: {
					operationId: 'listStyles',
					summary: 'List all available generative art styles',
					responses: {
						'200': {
							description: 'Array of style objects',
							content: {
								'application/json': {
									schema: {
										type: 'array',
										items: {
											type: 'object',
											properties: {
												key: { type: 'string', enum: styleEnum },
												name: { type: 'string' },
												description: { type: 'string' },
												previewUrl: { type: 'string' },
												mintUrl: { type: 'string' },
											},
										},
									},
								},
							},
						},
					},
				},
			},
			'/preview/{style}': {
				get: {
					operationId: 'previewStyle',
					summary: 'Get a free low-fidelity preview PNG of a style (fixed seed)',
					parameters: [
						{
							name: 'style',
							in: 'path',
							required: true,
							schema: { type: 'string', enum: styleEnum },
						},
					],
					responses: {
						'200': { description: 'PNG image', content: { 'image/png': {} } },
						'404': { description: 'Unknown style' },
					},
				},
			},
			'/mint/{style}': {
				get: {
					operationId: 'mintNFT',
					summary: 'Mint a unique generative art PNG (x402 payment required: $0.10 USDC on Stellar testnet)',
					description: `Requires x402 payment. First request without payment returns 402 with PAYMENT-REQUIRED header. Payment: ${PRICE_AMOUNT} stroops (= $0.10) of USDC (${USDC_TESTNET}) on ${NETWORK} to ${payTo}. Use @x402/fetch to handle payment automatically.`,
					parameters: [
						{
							name: 'style',
							in: 'path',
							required: true,
							schema: { type: 'string', enum: styleEnum },
						},
						{
							name: 'seed',
							in: 'query',
							required: false,
							schema: { type: 'integer' },
							description: 'Seed for deterministic generation. Omit for a unique timestamp-based seed.',
						},
					],
					responses: {
						'200': {
							description: 'Generated PNG image with PAYMENT-RESPONSE header containing settlement receipt',
							content: { 'image/png': {} },
							headers: {
								'PAYMENT-RESPONSE': {
									description: 'Base64-encoded JSON settlement receipt with transaction hash',
									schema: { type: 'string' },
								},
							},
						},
						'402': {
							description: 'Payment required — PAYMENT-REQUIRED header contains base64-encoded JSON with payment instructions',
							headers: {
								'PAYMENT-REQUIRED': {
									description: 'Base64-encoded JSON with x402Version, accepts[] containing scheme, network, asset, amount, payTo',
									schema: { type: 'string' },
								},
							},
						},
					},
				},
			},
		},
	});
});

app.get('/.well-known/x402.json', (c) => {
	const baseUrl = new URL(c.req.url).origin;
	const payTo = c.env.STELLAR_PAY_TO;

	const exactScheme = {
		scheme: 'exact',
		network: NETWORK,
		asset: USDC_TESTNET,
		amount: PRICE_AMOUNT,
		payTo,
		maxTimeoutSeconds: 60,
		extra: { areFeesSponsored: true },
	};

	const accepts: unknown[] = [exactScheme];

	if (c.env.CHANNEL_SERVER_SECRET) {
		const serverKeypair = Keypair.fromSecret(c.env.CHANNEL_SERVER_SECRET);
		accepts.push({
			scheme: 'channel',
			network: NETWORK,
			asset: USDC_TESTNET,
			price: PRICE_AMOUNT,
			serverPublicKey: serverKeypair.publicKey(),
		});
	}

	return c.json({
		x402Version: 2,
		facilitator: c.env.FACILITATOR_URL || DEFAULT_FACILITATOR,
		endpoints: STYLE_KEYS.map((key) => ({
			method: 'GET',
			path: `/mint/${key}`,
			url: `${baseUrl}/mint/${key}`,
			description: STYLES[key].description,
			mimeType: 'image/png',
			accepts,
		})),
	});
});

// ─── Free endpoints ─────────────────────────────────────────────────────────

app.get('/styles', (c) =>
	c.json(
		Object.entries(STYLES).map(([key, { name, description }]) => ({
			key,
			name,
			description,
			previewUrl: `/preview/${key}`,
			mintUrl: `/mint/${key}`,
		})),
	),
);

// Free preview — fixed seed, no uniqueness
app.get('/preview/:style', async (c) => {
	const style = c.req.param('style') as StyleKey;
	if (!STYLES[style]) {
		return c.json({ error: `Unknown style. Available: ${STYLE_KEYS.join(', ')}` }, 404);
	}
	const svg = STYLES[style].fn(0);

	const accept = c.req.header('accept') || '';
	if (accept.includes('image/svg+xml') || c.req.query('format') === 'svg') {
		return c.body(svg, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
	}

	const png = await svgToPng(svg);
	return c.body(png, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
});

// ─── Paid mint endpoints ────────────────────────────────────────────────────

app.get('/mint/:style', async (c) => {
	const style = c.req.param('style') as StyleKey;
	if (!STYLES[style]) {
		return c.json({ error: `Unknown style. Available: ${STYLE_KEYS.join(', ')}` }, 404);
	}
	const seedParam = c.req.query('seed');
	const seed = seedParam ? parseInt(seedParam, 10) : Date.now();
	const svg = STYLES[style].fn(seed);

	// Return SVG directly if requested (much faster — skips resvg-wasm PNG rendering)
	const accept = c.req.header('accept') || '';
	if (accept.includes('image/svg+xml') || c.req.query('format') === 'svg') {
		return c.body(svg, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
	}

	const png = await svgToPng(svg);
	return c.body(png, 200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
});

export default app;
