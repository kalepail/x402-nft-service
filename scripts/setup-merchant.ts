/**
 * Generate a Stellar testnet merchant keypair, fund it via Friendbot,
 * establish USDC trustline, and print the values to set in wrangler.jsonc.
 */
import { Keypair, Networks, TransactionBuilder, Horizon, Operation, Asset, BASE_FEE } from '@stellar/stellar-sdk';

const TESTNET_HORIZON = 'https://horizon-testnet.stellar.org';
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

async function main() {
	const kp = Keypair.random();
	console.log('=== Stellar Testnet Merchant Setup ===');
	console.log(`Public Key:  ${kp.publicKey()}`);
	console.log(`Secret Key:  ${kp.secret()}`);

	console.log('\nFunding via Friendbot...');
	const resp = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
	if (!resp.ok) {
		console.error(`Friendbot failed: ${resp.status} ${await resp.text()}`);
		process.exit(1);
	}
	console.log('Funded!');

	console.log('\nEstablishing USDC trustline...');
	const horizon = new Horizon.Server(TESTNET_HORIZON);
	const account = await horizon.loadAccount(kp.publicKey());
	const usdcAsset = new Asset('USDC', USDC_ISSUER);

	const tx = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase: Networks.TESTNET,
	})
		.addOperation(Operation.changeTrust({ asset: usdcAsset }))
		.setTimeout(30)
		.build();

	tx.sign(kp);
	const result = await horizon.submitTransaction(tx);
	if (!result.successful) {
		console.error('Trustline transaction failed');
		process.exit(1);
	}
	console.log('USDC trustline established!');

	console.log(`\nSet this in wrangler.jsonc:\n  "STELLAR_PAY_TO": "${kp.publicKey()}"`);
}

main().catch(console.error);
