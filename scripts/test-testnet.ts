/**
 * End-to-end test against Stellar testnet + a running dev server.
 *
 * Usage:
 *   1. Start the dev server:    npm run dev
 *   2. Run this script:         npm run test:testnet
 *
 * Environment:
 *   SERVER_URL   default http://localhost:8787
 *   TEST_SCHEME  exact | channel | both (default both)
 *   BUYER_SECRET optional funded Stellar secret to skip Friendbot + DEX setup
 *
 * What it does:
 *   - Generates a fresh Stellar testnet keypair for the buyer
 *   - Funds it via Friendbot
 *   - Establishes a USDC trustline
 *   - Attempts to acquire USDC via testnet DEX (XLM → USDC path payment)
 *   - Verifies the 402 challenge for the gated mint endpoint
 *   - Exercises exact x402 and/or real channel x402 flows
 */

import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import {
	Address,
	Asset,
	BASE_FEE,
	Contract,
	Horizon,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
	nativeToScVal,
	rpc,
	xdr,
} from '@stellar/stellar-sdk';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8787';
const TEST_SCHEME = process.env.TEST_SCHEME || 'both';
const TESTNET_RPC =
	process.env.RPC_URL || 'https://soroban-rpc.testnet.stellar.gateway.fm/';
const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const USDC_TESTNET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

type PaymentRequired = {
	x402Version: number;
	resource?: Record<string, unknown>;
	accepts: Array<Record<string, unknown>>;
};

function toBase64(str: string): string {
	return Buffer.from(str, 'utf-8').toString('base64');
}

function fromBase64(b64: string): string {
	return Buffer.from(b64, 'base64').toString('utf-8');
}

function assert(cond: boolean, msg: string) {
	if (!cond) {
		console.error(`ASSERTION FAILED: ${msg}`);
		process.exit(1);
	}
}

function writeBigInt128BE(buf: Buffer, value: bigint, offset: number): void {
	const mask64 = (1n << 64n) - 1n;
	buf.writeBigUInt64BE((value >> 64n) & mask64, offset);
	buf.writeBigUInt64BE(value & mask64, offset + 8);
}

function signStateHex(
	keypair: Keypair,
	channelId: string,
	iteration: bigint,
	agentBalance: bigint,
	serverBalance: bigint,
): string {
	const channelIdBytes = Buffer.from(channelId, 'hex');
	const buf = Buffer.alloc(72);
	channelIdBytes.copy(buf, 0);
	buf.writeBigUInt64BE(iteration, 32);
	writeBigInt128BE(buf, agentBalance, 40);
	writeBigInt128BE(buf, serverBalance, 56);
	return Buffer.from(keypair.sign(buf)).toString('hex');
}

function signCloseIntentHex(keypair: Keypair, channelId: string): string {
	return Buffer.from(
		keypair.sign(Buffer.concat([Buffer.from(channelId, 'hex'), Buffer.from('close', 'utf8')])),
	).toString('hex');
}

function deriveChannelId(agentPublicKey: string, nonce: Buffer): string {
	return createHash('sha256')
		.update(Buffer.from(Keypair.fromPublicKey(agentPublicKey).rawPublicKey()))
		.update(nonce)
		.digest('hex');
}

async function checkServer(): Promise<void> {
	console.log('1. Checking server...');
	try {
		const resp = await fetch(`${SERVER_URL}/`);
		const body = (await resp.json()) as Record<string, unknown>;
		console.log(`   Server running: ${body.name}`);
	} catch {
		console.error(`   Server not reachable at ${SERVER_URL}. Start it with: npm run dev or npm run dev:remote`);
		process.exit(1);
	}
}

async function verifyFreeEndpoints(): Promise<void> {
	console.log('\n2. Testing free endpoints...');
	const stylesResp = await fetch(`${SERVER_URL}/styles`);
	assert(stylesResp.status === 200, 'GET /styles should return 200');
	const styles = (await stylesResp.json()) as Array<{ key: string; name: string }>;
	console.log(`   Styles available: ${styles.map((s) => s.key).join(', ')}`);

	const previewResp = await fetch(`${SERVER_URL}/preview/attractor`);
	assert(previewResp.status === 200, 'GET /preview/attractor should return 200');
	assert(previewResp.headers.get('content-type') === 'image/png', 'Preview should be PNG');
	console.log('   Preview endpoint: OK');
}

async function getPaymentRequired(path = '/mint/attractor?seed=42'): Promise<PaymentRequired> {
	const mintResp = await fetch(`${SERVER_URL}${path}`);
	assert(mintResp.status === 402, 'Mint without payment should return 402');
	const prHeader = mintResp.headers.get('PAYMENT-REQUIRED');
	assert(!!prHeader, 'Should have PAYMENT-REQUIRED header');
	return JSON.parse(fromBase64(prHeader!)) as PaymentRequired;
}

async function verify402Challenge(): Promise<PaymentRequired> {
	console.log('\n3. Testing x402 payment gate...');
	const paymentRequired = await getPaymentRequired();
	assert(paymentRequired.x402Version === 2, 'x402Version should be 2');
	assert(paymentRequired.accepts.length >= 1, 'accepts should not be empty');

	const exact = paymentRequired.accepts.find((item) => item.scheme === 'exact');
	assert(!!exact, 'exact scheme should be present');
	assert(exact!.network === 'stellar:testnet', 'network should be stellar:testnet');
	assert(exact!.asset === USDC_TESTNET_CONTRACT, 'asset should be USDC testnet');
	console.log('   402 response format: VALID');
	console.log(`     Network: ${exact!.network}`);
	console.log(`     Amount:  ${exact!.amount} (${Number(exact!.amount) / 1e7} USDC)`);
	console.log(`     PayTo:   ${exact!.payTo}`);

	const channel = paymentRequired.accepts.find((item) => item.scheme === 'channel');
	if (channel) {
		console.log('   Channel offer: present');
		console.log(`     Contract: ${String((channel.extra as Record<string, unknown>).channelContract ?? '')}`);
		console.log(`     Signer:   ${String((channel.extra as Record<string, unknown>).serverPublicKey ?? '')}`);
	}

	return paymentRequired;
}

async function createBuyer(): Promise<Keypair> {
	if (process.env.BUYER_SECRET) {
		const buyerKeypair = Keypair.fromSecret(process.env.BUYER_SECRET);
		console.log('\n4. Using existing buyer account...');
		console.log(`   Buyer public: ${buyerKeypair.publicKey()}`);
		return buyerKeypair;
	}

	console.log('\n4. Creating buyer account on testnet...');
	const buyerKeypair = Keypair.random();
	console.log(`   Buyer public: ${buyerKeypair.publicKey()}`);
	const friendbotResp = await fetch(`https://friendbot.stellar.org?addr=${buyerKeypair.publicKey()}`);
	assert(friendbotResp.ok, `Friendbot failed: ${friendbotResp.status}`);
	console.log('   Funded via Friendbot (10,000 XLM)');
	return buyerKeypair;
}

async function establishUsdcTrustline(buyerKeypair: Keypair): Promise<void> {
	console.log('\n5. Establishing USDC trustline...');
	const horizon = new Horizon.Server(TESTNET_HORIZON);
	const buyerAccount = await horizon.loadAccount(buyerKeypair.publicKey());
	const usdcAsset = new Asset('USDC', USDC_ISSUER);

	const trustlineTx = new TransactionBuilder(buyerAccount, {
		fee: BASE_FEE,
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(Operation.changeTrust({ asset: usdcAsset }))
		.setTimeout(30)
		.build();

	trustlineTx.sign(buyerKeypair);
	const trustlineResult = await horizon.submitTransaction(trustlineTx);
	assert(trustlineResult.successful, 'Trustline transaction should succeed');
	console.log('   Trustline established for USDC');
}

async function acquireUsdc(buyerKeypair: Keypair): Promise<boolean> {
	console.log('\n6. Acquiring USDC via testnet DEX...');
	const horizon = new Horizon.Server(TESTNET_HORIZON);
	const usdcAsset = new Asset('USDC', USDC_ISSUER);

	try {
		const paths = await horizon.strictSendPaths(Asset.native(), '10', [usdcAsset]).call();
		if (paths.records.length === 0) {
			console.log('   No DEX path found for XLM → USDC');
			return false;
		}

		const bestPath = paths.records[0];
		console.log(`   DEX path found: 10 XLM → ${bestPath.destination_amount} USDC`);

		const freshAccount = await horizon.loadAccount(buyerKeypair.publicKey());
		const swapTx = new TransactionBuilder(freshAccount, {
			fee: BASE_FEE,
			networkPassphrase: Networks.TESTNET,
		})
			.addOperation(
				Operation.pathPaymentStrictSend({
					sendAsset: Asset.native(),
					sendAmount: '10',
					destination: buyerKeypair.publicKey(),
					destAsset: usdcAsset,
					destMin: '0.0000001',
					path: bestPath.path.map(
						(p: { asset_type: string; asset_code?: string; asset_issuer?: string }) =>
							p.asset_type === 'native' ? Asset.native() : new Asset(p.asset_code!, p.asset_issuer!),
					),
				}),
			)
			.setTimeout(30)
			.build();

		swapTx.sign(buyerKeypair);
		const swapResult = await horizon.submitTransaction(swapTx);
		assert(swapResult.successful, 'DEX swap should succeed');
		console.log('   USDC acquired via DEX swap');
		return true;
	} catch (error) {
		console.log(`   DEX swap failed: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	}
}

async function runExactFlow(
	paymentRequired: PaymentRequired,
	buyerKeypair: Keypair,
): Promise<void> {
	console.log('\n7. Running exact x402 flow...');
	const { ExactStellarScheme } = await import('@x402/stellar/exact/client');
	const { createEd25519Signer } = await import('@x402/stellar');

	const signer = createEd25519Signer(buyerKeypair.secret(), 'stellar:testnet');
	const clientScheme = new ExactStellarScheme(signer, { url: TESTNET_RPC });
	const requirements = paymentRequired.accepts.find((item) => item.scheme === 'exact');
	assert(!!requirements, 'exact requirements should be present');

	const { payload } = await clientScheme.createPaymentPayload(2, requirements!);
	const paymentPayload = {
		x402Version: 2,
		resource: paymentRequired.resource,
		accepted: requirements,
		payload,
	};

	const paidResp = await fetch(`${SERVER_URL}/mint/attractor?seed=42`, {
		headers: { 'payment-signature': toBase64(JSON.stringify(paymentPayload)) },
	});
	assert(paidResp.status === 200, `Exact payment should return 200, got ${paidResp.status}`);
	assert(paidResp.headers.get('content-type') === 'image/png', 'Exact response should be PNG');
	const settlementHeader = paidResp.headers.get('PAYMENT-RESPONSE');
	assert(!!settlementHeader, 'Exact flow should return PAYMENT-RESPONSE');
	const settlement = JSON.parse(fromBase64(settlementHeader!)) as Record<string, unknown>;
	console.log(`   Exact flow settled: tx=${String(settlement.transaction ?? '')}`);
}

async function buildOpenTransaction(
	payer: Keypair,
	commitmentKeypair: Keypair,
	channelAccept: Record<string, unknown>,
	deposit: bigint,
	nonce: Buffer,
): Promise<string> {
	const rpcServer = new rpc.Server(TESTNET_RPC);
	const account = await rpcServer.getAccount(payer.publicKey());
	const contract = new Contract(String((channelAccept.extra as Record<string, unknown>).channelContract));
	const tx = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(
			contract.call(
				'open_channel',
				new Address(payer.publicKey()).toScVal(),
				xdr.ScVal.scvBytes(Buffer.from(commitmentKeypair.rawPublicKey())),
				new Address(String(channelAccept.payTo)).toScVal(),
				xdr.ScVal.scvBytes(
					Buffer.from(
						Keypair.fromPublicKey(
							String((channelAccept.extra as Record<string, unknown>).serverPublicKey),
						).rawPublicKey(),
					),
				),
				new Address(String(channelAccept.asset)).toScVal(),
				nativeToScVal(deposit, { type: 'i128' }),
				xdr.ScVal.scvBytes(Buffer.from(nonce)),
			),
		)
		.setTimeout(Math.max(Number(channelAccept.maxTimeoutSeconds ?? 60), 30))
		.build();
	const prepared = await rpcServer.prepareTransaction(tx);
	prepared.sign(payer);
	return prepared.toXDR();
}

async function runChannelFlow(
	paymentRequired: PaymentRequired,
	buyerKeypair: Keypair,
): Promise<void> {
	console.log('\n8. Running real channel x402 flow...');
	const channelAccept = paymentRequired.accepts.find((item) => item.scheme === 'channel');
	assert(!!channelAccept, 'channel requirements should be present');

	const extra = channelAccept!.extra as Record<string, unknown>;
	const channelContract = String(extra.channelContract ?? '');
	const serverPublicKey = String(extra.serverPublicKey ?? '');
	assert(channelContract.length > 0, 'channelContract should be present');
	assert(serverPublicKey.length > 0, 'serverPublicKey should be present');

	const deposit = BigInt(
		String(extra.suggestedDeposit ?? BigInt(String(channelAccept!.amount)) * 100n),
	);
	const commitmentKeypair = Keypair.random();
	const nonce = randomBytes(32);
	const channelId = deriveChannelId(commitmentKeypair.publicKey(), nonce);

	const transaction = await buildOpenTransaction(
		buyerKeypair,
		commitmentKeypair,
		channelAccept!,
		deposit,
		nonce,
	);

	const openResp = await fetch(`${SERVER_URL}/mint/attractor?seed=42&format=svg&size=100`, {
		headers: {
			Accept: 'application/json',
			'payment-signature': toBase64(
				JSON.stringify({
					x402Version: paymentRequired.x402Version,
					resource: paymentRequired.resource,
					accepted: channelAccept,
					payload: {
						action: 'open',
						transaction,
						initialStateSignature: signStateHex(commitmentKeypair, channelId, 0n, deposit, 0n),
					},
				}),
			),
		},
	});
	if (openResp.status !== 200) {
		console.error(`   Channel open failed: ${openResp.status} ${await openResp.text()}`);
		process.exit(1);
	}
	const openBody = (await openResp.json()) as Record<string, unknown>;
	assert(openBody.success === true, 'Channel open should succeed');
	assert(openBody.channelId === channelId, 'Open response channelId should match derived channelId');
	console.log(`   Channel opened: tx=${String(openBody.transaction ?? '')}`);

	const paymentAmount = BigInt(String(channelAccept!.amount));
	const nextIteration = 1n;
	const nextServerBalance = paymentAmount;
	const nextAgentBalance = deposit - paymentAmount;
	const payResp = await fetch(`${SERVER_URL}/mint/attractor?seed=42&format=svg&size=100`, {
		headers: {
			Accept: 'image/svg+xml',
			'payment-signature': toBase64(
				JSON.stringify({
					x402Version: paymentRequired.x402Version,
					resource: paymentRequired.resource,
					accepted: channelAccept,
					payload: {
						action: 'pay',
						channelId,
						iteration: nextIteration.toString(),
						agentBalance: nextAgentBalance.toString(),
						serverBalance: nextServerBalance.toString(),
						agentSig: signStateHex(
							commitmentKeypair,
							channelId,
							nextIteration,
							nextAgentBalance,
							nextServerBalance,
						),
					},
				}),
			),
		},
	});
	if (payResp.status !== 200) {
		console.error(`   Channel pay failed: ${payResp.status} ${await payResp.text()}`);
		process.exit(1);
	}
	assert(payResp.headers.get('content-type') === 'image/svg+xml', 'Channel pay should return SVG');
	const payBody = await payResp.text();
	assert(payBody.includes('<svg'), 'Channel pay should return SVG body');
	const settlementHeader = payResp.headers.get('PAYMENT-RESPONSE');
	assert(!!settlementHeader, 'Channel pay should return PAYMENT-RESPONSE');
	const settlement = JSON.parse(fromBase64(settlementHeader!)) as Record<string, unknown>;
	assert(settlement.channelId === channelId, 'Channel pay settlement should include channelId');
	assert(settlement.currentCumulative === nextServerBalance.toString(), 'currentCumulative should match');
	assert(settlement.remainingBalance === nextAgentBalance.toString(), 'remainingBalance should match');
	console.log(`   Channel pay settled: cumulative=${String(settlement.currentCumulative ?? '')}`);

	const closeResp = await fetch(`${SERVER_URL}/mint/attractor?seed=42&format=svg&size=100`, {
		headers: {
			Accept: 'application/json',
			'payment-signature': toBase64(
				JSON.stringify({
					x402Version: paymentRequired.x402Version,
					resource: paymentRequired.resource,
					accepted: channelAccept,
					payload: {
						action: 'close',
						channelId,
						signature: signCloseIntentHex(commitmentKeypair, channelId),
					},
				}),
			),
		},
	});
	if (closeResp.status !== 200) {
		console.error(`   Channel close failed: ${closeResp.status} ${await closeResp.text()}`);
		process.exit(1);
	}
	const closeBody = (await closeResp.json()) as Record<string, unknown>;
	assert(closeBody.success === true, 'Channel close should succeed');
	assert(closeBody.channelId === channelId, 'Close response should include channelId');
	console.log(`   Channel closed: tx=${String(closeBody.transaction ?? '')}`);
}

async function main() {
	console.log('=== x402 NFT Service — Stellar Testnet E2E Test ===\n');
	await checkServer();
	await verifyFreeEndpoints();
	const paymentRequired = await verify402Challenge();
	const buyerKeypair = await createBuyer();
	let hasUsdc = true;
	if (!process.env.BUYER_SECRET) {
		await establishUsdcTrustline(buyerKeypair);
		hasUsdc = await acquireUsdc(buyerKeypair);
	} else {
		console.log('\n5. Skipping Friendbot/trustline/DEX setup for existing buyer secret');
	}

	if (!hasUsdc) {
		console.log('\n   Could not acquire USDC on testnet automatically.');
		console.log('   To complete the full e2e test, manually send USDC to:');
		console.log(`     ${buyerKeypair.publicKey()}`);
		console.log('   The free endpoints and 402 challenge flow were fully verified.');
		console.log('\n=== CHALLENGE FLOW VERIFIED (payment flows require testnet USDC) ===');
		return;
	}

	if (TEST_SCHEME === 'exact' || TEST_SCHEME === 'both') {
		await runExactFlow(paymentRequired, buyerKeypair);
	}
	if (TEST_SCHEME === 'channel' || TEST_SCHEME === 'both') {
		await runChannelFlow(paymentRequired, buyerKeypair);
	}

	console.log('\n=== ALL TESTS PASSED — Exact and real channel x402 flows verified on Stellar testnet ===');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
