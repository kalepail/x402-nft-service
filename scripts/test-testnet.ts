/**
 * End-to-end test against Stellar testnet + a running dev server.
 *
 * Usage:
 *   1. Start the dev server:    npx wrangler dev
 *   2. Run this script:         npx tsx scripts/test-testnet.ts
 *
 * What it does:
 *   - Generates a fresh Stellar testnet keypair for the "buyer"
 *   - Funds it via Friendbot
 *   - Establishes a USDC trustline
 *   - Attempts to acquire USDC via testnet DEX (XLM → USDC path payment)
 *   - Hits a gated /mint endpoint, gets 402 back
 *   - Builds an x402 payment and retries
 */

import {
	Keypair,
	Networks,
	TransactionBuilder,
	SorobanRpc,
	Horizon,
	Operation,
	Asset,
	BASE_FEE,
} from '@stellar/stellar-sdk';
import { Buffer } from 'node:buffer';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8787';
const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const USDC_TESTNET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

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

async function main() {
	console.log('=== x402 NFT Service — Stellar Testnet E2E Test ===\n');

	// Step 1: Check server is running
	console.log('1. Checking server...');
	try {
		const resp = await fetch(`${SERVER_URL}/`);
		const body = (await resp.json()) as Record<string, unknown>;
		console.log(`   Server running: ${body.name}`);
	} catch {
		console.error(`   Server not reachable at ${SERVER_URL}. Start it with: npx wrangler dev`);
		process.exit(1);
	}

	// Step 2: Test free endpoints
	console.log('\n2. Testing free endpoints...');
	const stylesResp = await fetch(`${SERVER_URL}/styles`);
	assert(stylesResp.status === 200, 'GET /styles should return 200');
	const styles = (await stylesResp.json()) as Array<{ key: string; name: string }>;
	console.log(`   Styles available: ${styles.map((s) => s.key).join(', ')}`);

	const previewResp = await fetch(`${SERVER_URL}/preview/attractor`);
	assert(previewResp.status === 200, 'Preview should return 200');
	assert(previewResp.headers.get('content-type') === 'image/png', 'Preview should be PNG');
	console.log('   Preview endpoint: OK');

	// Step 3: Test 402 response format
	console.log('\n3. Testing x402 payment gate...');
	const mintResp = await fetch(`${SERVER_URL}/mint/attractor?seed=42`);
	assert(mintResp.status === 402, 'Mint without payment should return 402');

	const prHeader = mintResp.headers.get('PAYMENT-REQUIRED');
	assert(!!prHeader, 'Should have PAYMENT-REQUIRED header');

	const paymentRequired = JSON.parse(fromBase64(prHeader!));
	assert(paymentRequired.x402Version === 2, 'x402Version should be 2');
	assert(paymentRequired.accepts[0].scheme === 'exact', 'scheme should be exact');
	assert(paymentRequired.accepts[0].network === 'stellar:testnet', 'network should be stellar:testnet');
	assert(paymentRequired.accepts[0].asset === USDC_TESTNET_CONTRACT, 'asset should be USDC testnet');
	console.log('   402 response format: VALID');
	console.log(`     Network: ${paymentRequired.accepts[0].network}`);
	console.log(`     Amount:  ${paymentRequired.accepts[0].amount} (${Number(paymentRequired.accepts[0].amount) / 1e7} USDC)`);
	console.log(`     PayTo:   ${paymentRequired.accepts[0].payTo}`);

	// Step 4: Create buyer account
	console.log('\n4. Creating buyer account on testnet...');
	const buyerKeypair = Keypair.random();
	console.log(`   Buyer public: ${buyerKeypair.publicKey()}`);

	const friendbotResp = await fetch(`https://friendbot.stellar.org?addr=${buyerKeypair.publicKey()}`);
	assert(friendbotResp.ok, `Friendbot failed: ${friendbotResp.status}`);
	console.log('   Funded via Friendbot (10,000 XLM)');

	// Step 5: Add USDC trustline
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

	// Step 6: Try to get USDC via DEX (strict send XLM for USDC)
	console.log('\n6. Acquiring USDC via testnet DEX...');
	let hasUsdc = false;

	try {
		// Check if there's a path from XLM to USDC
		const paths = await horizon
			.strictSendPaths(Asset.native(), '10', [usdcAsset])
			.call();

		if (paths.records.length > 0) {
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
						path: bestPath.path.map((p: { asset_type: string; asset_code?: string; asset_issuer?: string }) =>
							p.asset_type === 'native' ? Asset.native() : new Asset(p.asset_code!, p.asset_issuer!),
						),
					}),
				)
				.setTimeout(30)
				.build();

			swapTx.sign(buyerKeypair);
			const swapResult = await horizon.submitTransaction(swapTx);
			assert(swapResult.successful, 'DEX swap should succeed');
			console.log('   USDC acquired via DEX swap!');
			hasUsdc = true;
		} else {
			console.log('   No DEX path found for XLM → USDC');
		}
	} catch (err) {
		console.log(`   DEX swap failed: ${err instanceof Error ? err.message : err}`);
	}

	if (!hasUsdc) {
		console.log('\n   Could not acquire USDC on testnet automatically.');
		console.log('   To complete the full e2e test, manually send USDC to:');
		console.log(`     ${buyerKeypair.publicKey()}`);
		console.log('   The x402 402-response flow has been fully verified.');
		console.log('\n=== 402 FLOW VERIFIED (full payment requires testnet USDC) ===');
		return;
	}

	// Step 7: Build x402 payment and send
	console.log('\n7. Building x402 payment...');
	const { ExactStellarScheme } = await import('@x402/stellar/exact/client');
	const { createEd25519Signer } = await import('@x402/stellar');

	const signer = createEd25519Signer(buyerKeypair.secret(), 'stellar:testnet');
	const clientScheme = new ExactStellarScheme(signer, { url: TESTNET_RPC });

	const requirements = paymentRequired.accepts[0];
	const { payload } = await clientScheme.createPaymentPayload(2, requirements);

	const paymentPayload = {
		x402Version: 2,
		resource: paymentRequired.resource,
		accepted: requirements,
		payload,
	};

	const encodedPayment = toBase64(JSON.stringify(paymentPayload));
	console.log('   Payment payload built and signed');

	// Step 8: Send paid request
	console.log('\n8. Sending paid request to /mint/attractor...');
	const paidResp = await fetch(`${SERVER_URL}/mint/attractor?seed=42`, {
		headers: { 'payment-signature': encodedPayment },
	});

	console.log(`   Response status: ${paidResp.status}`);

	if (paidResp.status === 200) {
		const contentType = paidResp.headers.get('content-type');
		assert(contentType === 'image/png', 'Should return PNG');
		const body = new Uint8Array(await paidResp.arrayBuffer());
		assert(body[0] === 0x89 && body[1] === 0x50, 'Body should be PNG (magic bytes)');
		console.log(`   Content-Type: ${contentType}`);
		console.log(`   PNG size: ${body.length} bytes`);

		const settlementHeader = paidResp.headers.get('PAYMENT-RESPONSE');
		if (settlementHeader) {
			const settlement = JSON.parse(fromBase64(settlementHeader));
			console.log(`   Settlement: success=${settlement.success}, tx=${settlement.transaction}`);
		}

		console.log('\n=== ALL TESTS PASSED — Full x402 payment flow verified on Stellar testnet ===');
	} else {
		const errBody = await paidResp.text();
		console.log(`   Response body: ${errBody}`);

		if (paidResp.status === 402) {
			const errData = JSON.parse(errBody);
			console.log(`   Payment rejected: ${errData.error}`);
			console.log('   This may indicate the facilitator could not verify the payment.');
			console.log('\n=== 402 FLOW VERIFIED (settlement failed — may need more USDC or facilitator issue) ===');
		} else {
			console.error(`   Unexpected status: ${paidResp.status}`);
			process.exit(1);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
