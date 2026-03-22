import { Buffer } from 'node:buffer';
import type { Context, MiddlewareHandler, Next } from 'hono';
import {
	type ChannelConfig,
	type ChannelPaymentHeader,
	type ChannelPaymentResponse,
	type StoredChannelRecord,
	signStateHex,
	verifyCloseIntentSignature,
	verifyStateChannelPayment,
	verifyStateSignature,
} from './channel';
import {
	networkPassphraseForNetwork,
	parseOpenChannelTransaction,
	relayOpenChannelTransaction,
	submitCloseChannelTransaction,
} from './channel-chain';

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
	| { kind: 'state'; payload: X402PaymentPayload; action: 'open' | 'pay' | 'close' };

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
			channelContract: channelConfig.channelContractId,
			serverPublicKey: channelConfig.serverKeypair.publicKey(),
			channelMode: 'stellar-state-channel-v1',
			supportsClose: true,
			supportsTopUp: false,
		},
		price: String(channelConfig.price),
		serverPublicKey: channelConfig.serverKeypair.publicKey(),
		channelContract: channelConfig.channelContractId,
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
				return handleStateChannelPayment(c, next, channelPayment, config, channelConfig, channelState);
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

		if (payload.action === 'open' || payload.action === 'pay' || payload.action === 'close') {
			return { kind: 'state', payload: decoded, action: payload.action };
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
					deposit: payload.deposit === undefined ? undefined : String(payload.deposit),
					agentPublicKey:
						payload.agentPublicKey === undefined ? undefined : String(payload.agentPublicKey),
					agentSig: String(payload.agentSig),
				},
			};
		}
	} catch {
		// Not a base64 x402 payload either.
	}

	return null;
}

async function getStoredChannel(
	channelState: DurableObjectNamespace,
	channelId: string,
): Promise<StoredChannelRecord | null> {
	const stub = channelState.get(channelState.idFromName(channelId));
	const response = await stub.fetch('https://channel/state');
	if (response.status === 404) return null;
	if (!response.ok) {
		throw new Error(`channel state lookup failed: ${await response.text()}`);
	}
	return (await response.json()) as StoredChannelRecord;
}

async function putStoredChannel(
	channelState: DurableObjectNamespace,
	channelId: string,
	endpoint: 'open' | 'pay' | 'close',
	record: StoredChannelRecord,
): Promise<void> {
	const stub = channelState.get(channelState.idFromName(channelId));
	const response = await stub.fetch(`https://channel/${endpoint}`, {
		method: 'POST',
		body: JSON.stringify(record),
	});
	if (!response.ok) {
		throw new Error(`channel state update failed: ${await response.text()}`);
	}
}

function mapChannelErrorStatus(error: string): number {
	switch (error) {
		case 'channel/not-found':
			return 404;
		case 'channel/finalized':
			return 410;
		default:
			return 402;
	}
}

async function handleStateChannelPayment(
	c: Context,
	next: Next,
	payment: Extract<ParsedChannelPayment, { kind: 'state' }>,
	config: X402RouteConfig,
	channelConfig: ChannelConfig,
	channelState: DurableObjectNamespace,
): Promise<Response | void> {
	const accepted = normalizeAcceptedRequirement(payment.payload.accepted, config.requirements);
	assertAcceptedMatchesRoute(accepted, config.requirements);

	if (payment.action === 'open') {
		return handleStateChannelOpen(c, payment.payload, accepted, channelConfig, channelState);
	}
	if (payment.action === 'pay') {
		return handleStateChannelPay(c, next, payment.payload, accepted, channelConfig, channelState);
	}
	if (payment.action === 'close') {
		return handleStateChannelClose(c, payment.payload, accepted, channelConfig, channelState);
	}

	return c.json({ error: 'Unsupported channel action' }, 400);
}

async function handleStateChannelOpen(
	c: Context,
	payload: X402PaymentPayload,
	accepted: PaymentRequirements,
	channelConfig: ChannelConfig,
	channelState: DurableObjectNamespace,
): Promise<Response> {
	const transaction = payload.payload?.transaction;
	const initialStateSignature = payload.payload?.initialStateSignature;
	if (typeof transaction !== 'string' || typeof initialStateSignature !== 'string') {
		return c.json({ error: 'channel/open requires transaction and initialStateSignature' }, 400);
	}

	const networkPassphrase = networkPassphraseForNetwork(accepted.network);
	let parsed;
	try {
		parsed = parseOpenChannelTransaction(transaction, networkPassphrase);
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
	}

	if (parsed.channelContractId !== channelConfig.channelContractId) {
		return c.json({ error: 'channel/open contract mismatch' }, 402);
	}
	if (parsed.asset !== accepted.asset || parsed.payTo !== accepted.payTo) {
		return c.json({ error: 'channel/open transaction args mismatch challenge' }, 402);
	}
	if (parsed.serverPublicKey !== channelConfig.serverKeypair.publicKey()) {
		return c.json({ error: 'channel/open server key mismatch' }, 402);
	}
	if (
		!verifyStateSignature(
			parsed.agentPublicKey,
			initialStateSignature,
			parsed.channelId,
			0n,
			BigInt(parsed.deposit),
			0n,
		)
	) {
		return c.json({ error: 'channel/open invalid initial state signature' }, 402);
	}

	const existing = await getStoredChannel(channelState, parsed.channelId);
	if (existing?.status === 'open') {
		return c.json(
			{
				success: false,
				error: 'channel/already-exists',
				channelId: existing.channelId,
				currentCumulative: existing.serverBalance,
				remainingBalance: existing.agentBalance,
			},
			409,
		);
	}

	let transactionHash: string;
	try {
		transactionHash = await relayOpenChannelTransaction(channelConfig, transaction);
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
	}

	const serverSig = signStateHex(
		channelConfig.serverKeypair,
		parsed.channelId,
		0n,
		BigInt(parsed.deposit),
		0n,
	);
	const record: StoredChannelRecord = {
		channelId: parsed.channelId,
		payer: parsed.payer,
		payTo: parsed.payTo,
		asset: parsed.asset,
		deposit: parsed.deposit,
		agentPublicKey: parsed.agentPublicKey,
		iteration: '0',
		agentBalance: parsed.deposit,
		serverBalance: '0',
		agentSig: initialStateSignature,
		serverSig,
		openedTxHash: transactionHash,
		status: 'open',
	};
	await putStoredChannel(channelState, parsed.channelId, 'open', record);

	const settlement = {
		success: true,
		transaction: transactionHash,
		network: accepted.network,
		payer: parsed.payer,
		channelId: parsed.channelId,
		deposit: parsed.deposit,
		iteration: '0',
		currentCumulative: '0',
		remainingBalance: parsed.deposit,
		serverSig,
		resourceGranted: false,
	};
	return new Response(JSON.stringify(settlement), {
		status: 200,
		headers: paymentResponseHeaders(settlement),
	});
}

async function handleStateChannelPay(
	c: Context,
	next: Next,
	payload: X402PaymentPayload,
	accepted: PaymentRequirements,
	channelConfig: ChannelConfig,
	channelState: DurableObjectNamespace,
): Promise<Response | void> {
	const channelId = payload.payload?.channelId;
	const iteration = payload.payload?.iteration;
	const agentBalance = payload.payload?.agentBalance;
	const serverBalance = payload.payload?.serverBalance;
	const agentSig = payload.payload?.agentSig;
	if (
		typeof channelId !== 'string' ||
		typeof iteration !== 'string' ||
		typeof agentBalance !== 'string' ||
		typeof serverBalance !== 'string' ||
		typeof agentSig !== 'string'
	) {
		return c.json(
			{ error: 'channel/pay requires channelId, iteration, agentBalance, serverBalance, and agentSig' },
			400,
		);
	}

	const record = await getStoredChannel(channelState, channelId);
	if (!record) {
		return c.json({ success: false, error: 'channel/not-found' }, 404);
	}

	const verified = verifyStateChannelPayment(
		{
			scheme: 'channel',
			channelId,
			iteration,
			agentBalance,
			serverBalance,
			agentSig,
		},
		record,
		channelConfig,
	);
	if (!verified.ok) {
		return new Response(JSON.stringify({ success: false, error: verified.error }), {
			status: mapChannelErrorStatus(verified.error),
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const updatedRecord: StoredChannelRecord = {
		...record,
		iteration,
		agentBalance,
		serverBalance,
		agentSig,
		serverSig: verified.payment.counterSig,
		status: 'open',
	};
	await putStoredChannel(channelState, channelId, 'pay', updatedRecord);

	await next();
	if (c.res.status < 400) {
		const responseHeader: ChannelPaymentResponse = {
			scheme: 'channel',
			channelId,
			iteration,
			serverSig: verified.payment.counterSig,
		};
		const settlement = {
			success: true,
			network: accepted.network,
			channelId,
			iteration,
			currentCumulative: serverBalance,
			remainingBalance: agentBalance,
			serverSig: verified.payment.counterSig,
		};
		const headers = new Headers(c.res.headers);
		headers.set('PAYMENT-RESPONSE', toBase64(JSON.stringify(settlement)));
		headers.set('X-Payment-Response', JSON.stringify(responseHeader));
		c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
	}
}

async function handleStateChannelClose(
	c: Context,
	payload: X402PaymentPayload,
	accepted: PaymentRequirements,
	channelConfig: ChannelConfig,
	channelState: DurableObjectNamespace,
): Promise<Response> {
	const channelId = payload.payload?.channelId;
	const signature = payload.payload?.signature;
	if (typeof channelId !== 'string' || typeof signature !== 'string') {
		return c.json({ error: 'channel/close requires channelId and signature' }, 400);
	}

	const record = await getStoredChannel(channelState, channelId);
	if (!record) {
		return c.json({ success: false, error: 'channel/not-found' }, 404);
	}
	if (record.status !== 'open') {
		return c.json({ success: false, error: 'channel/finalized' }, 410);
	}
	if (!verifyCloseIntentSignature(record.agentPublicKey, signature, channelId)) {
		return c.json({ success: false, error: 'channel/invalid-signature' }, 402);
	}

	let transactionHash: string;
	try {
		transactionHash = await submitCloseChannelTransaction(channelConfig, record);
	} catch (error) {
		return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
	}

	const closedRecord: StoredChannelRecord = {
		...record,
		status: 'closed',
		closedTxHash: transactionHash,
	};
	await putStoredChannel(channelState, channelId, 'close', closedRecord);

	const settlement = {
		success: true,
		transaction: transactionHash,
		network: accepted.network,
		channelId,
		iteration: record.iteration,
		finalAmount: record.serverBalance,
		refunded: record.agentBalance,
	};
	return new Response(JSON.stringify(settlement), {
		status: 200,
		headers: paymentResponseHeaders(settlement),
	});
}

async function handleDemoChannelPayment(
	c: Context,
	next: Next,
	header: ChannelPaymentHeader,
	config: ChannelConfig,
): Promise<Response | void> {
	const deposit = header.deposit ?? (BigInt(header.serverBalance) + BigInt(header.agentBalance)).toString();
	const record: StoredChannelRecord = {
		channelId: header.channelId,
		payer: 'legacy-demo',
		payTo: 'legacy-demo',
		asset: 'legacy-demo',
		deposit,
		agentPublicKey: header.agentPublicKey ?? '',
		iteration: (BigInt(header.iteration) - 1n).toString(),
		agentBalance: (BigInt(header.agentBalance) + config.price).toString(),
		serverBalance: (BigInt(header.serverBalance) - config.price).toString(),
		agentSig: header.agentSig,
		serverSig: '',
		openedTxHash: '',
		status: 'open',
	};
	const result = verifyStateChannelPayment(header, record, config);
	if (!result.ok) {
		return c.json({ error: result.error }, 402);
	}

	await next();
	if (c.res.status < 400) {
		const responseHeader: ChannelPaymentResponse = {
			scheme: 'channel',
			channelId: header.channelId,
			iteration: header.iteration,
			serverSig: result.payment.counterSig,
		};
		const settlement = {
			success: true,
			channelId: header.channelId,
			iteration: header.iteration,
			currentCumulative: header.serverBalance,
			remainingBalance: header.agentBalance,
			serverSig: result.payment.counterSig,
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
