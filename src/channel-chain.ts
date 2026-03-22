import { Buffer } from 'node:buffer';
import {
	Address,
	BASE_FEE,
	Contract,
	Keypair,
	Networks,
	StrKey,
	TransactionBuilder,
	rpc,
	type Transaction,
	xdr,
} from '@stellar/stellar-sdk';
import type { ChannelConfig, StoredChannelRecord } from './channel';
import { deriveChannelIdHex } from './channel';

export interface ParsedOpenChannelTransaction {
	transaction: Transaction;
	channelId: string;
	payer: string;
	agentPublicKey: string;
	payTo: string;
	serverPublicKey: string;
	asset: string;
	deposit: string;
	nonceHex: string;
	channelContractId: string;
}

interface JsonRpcSuccess<T> {
	result: T;
}

interface JsonRpcFailure {
	error?: {
		code?: number;
		message?: string;
		data?: unknown;
	};
}

interface RawSendTransactionResult {
	hash: string;
	status: string;
	errorResultXdr?: string;
}

interface RawGetTransactionResult {
	status: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRpcError(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return (
		message.includes('internal error') ||
		message.includes('fetch failed') ||
		message.includes('timeout') ||
		message.includes('temporarily unavailable')
	);
}

async function withRpcRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (!isRetryableRpcError(error) || attempt === 5) {
				throw error;
			}
			console.warn(`${label} failed, retrying`, {
				attempt: attempt + 1,
				error: error instanceof Error ? error.message : String(error),
			});
			await sleep(1500 * (attempt + 1));
		}
	}
	throw lastError;
}

async function rpcRequest<T>(rpcUrl: string, method: string, params: Record<string, unknown>): Promise<T> {
	const response = await fetch(rpcUrl, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: method,
			method,
			params,
		}),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`rpc ${method} failed with HTTP ${response.status}: ${text}`);
	}
	const payload = JSON.parse(text) as JsonRpcSuccess<T> & JsonRpcFailure;
	if (payload.error) {
		throw new Error(payload.error.message || JSON.stringify(payload.error));
	}
	return payload.result;
}

function extractI128(value: xdr.ScVal): bigint {
	const i128 = value.i128();
	return (BigInt(i128.hi().toString()) << 64n) + BigInt(i128.lo().toString());
}

export function networkPassphraseForNetwork(network: string): string {
	switch (network) {
		case 'stellar:testnet':
			return Networks.TESTNET;
		case 'stellar:pubnet':
			return Networks.PUBLIC;
		default:
			throw new Error(`Unsupported Stellar network: ${network}`);
	}
}

export function parseOpenChannelTransaction(
	transactionXdr: string,
	networkPassphrase: string,
): ParsedOpenChannelTransaction {
	const transaction = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
	if ('innerTransaction' in transaction) {
		throw new Error('channel/open must provide a non-fee-bump transaction');
	}
	if (transaction.operations.length !== 1) {
		throw new Error('channel/open transaction must contain exactly one operation');
	}

	const operation = transaction.operations[0];
	if (operation.type !== 'invokeHostFunction') {
		throw new Error('channel/open transaction must use invokeHostFunction');
	}

	const invoke = operation.func.invokeContract();
	if (invoke.functionName().toString() !== 'open_channel') {
		throw new Error('channel/open transaction must call open_channel');
	}

	const args = invoke.args();
	if (args.length < 7) {
		throw new Error('channel/open transaction is missing required arguments');
	}

	const payer = Address.fromScVal(args[0]).toString();
	const agentPublicKey = StrKey.encodeEd25519PublicKey(Buffer.from(args[1].bytes()));
	const payTo = Address.fromScVal(args[2]).toString();
	const serverPublicKey = StrKey.encodeEd25519PublicKey(Buffer.from(args[3].bytes()));
	const asset = Address.fromScVal(args[4]).toString();
	const deposit = extractI128(args[5]).toString();
	const nonce = Buffer.from(args[6].bytes());
	const channelContractId = StrKey.encodeContract(
		Buffer.from(invoke.contractAddress().contractId() as unknown as Uint8Array),
	);

	return {
		transaction,
		channelId: deriveChannelIdHex(agentPublicKey, nonce),
		payer,
		agentPublicKey,
		payTo,
		serverPublicKey,
		asset,
		deposit,
		nonceHex: nonce.toString('hex'),
		channelContractId,
	};
}

async function waitForTransaction(rpcUrl: string, hash: string): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const result = await withRpcRetry('rpc.getTransaction', () =>
			rpcRequest<RawGetTransactionResult>(rpcUrl, 'getTransaction', { hash }),
		);
		if (result.status === 'SUCCESS') return;
		if (result.status === 'FAILED') {
			throw new Error(`transaction failed: ${JSON.stringify(result)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 1500));
	}
	throw new Error(`transaction ${hash} not confirmed after 20 polls`);
}

export async function relayOpenChannelTransaction(
	config: ChannelConfig,
	transactionXdr: string,
): Promise<string> {
	const transaction = TransactionBuilder.fromXDR(
		transactionXdr,
		config.networkPassphrase,
	) as Transaction;
	const fee = String(Number(transaction.fee) * 2 + 100000);
	const feeBump = TransactionBuilder.buildFeeBumpTransaction(
		config.facilitatorKeypair,
		fee,
		transaction,
		config.networkPassphrase,
	);
	feeBump.sign(config.facilitatorKeypair);

	const result = await withRpcRetry('rpc.sendTransaction(open)', () =>
		rpcRequest<RawSendTransactionResult>(config.rpcUrl, 'sendTransaction', {
			transaction: feeBump.toXDR(),
		}),
	);
	if (result.status === 'ERROR') {
		throw new Error(`channel/open submit error: ${JSON.stringify(result)}`);
	}
	await waitForTransaction(config.rpcUrl, result.hash);
	return result.hash;
}

function channelStateScVal(record: StoredChannelRecord): xdr.ScVal {
	return xdr.ScVal.scvMap([
		new xdr.ScMapEntry({
			key: xdr.ScVal.scvSymbol('agent_balance'),
			val: xdr.ScVal.scvI128(
				new xdr.Int128Parts({
					hi: xdr.Int64.fromString((BigInt(record.agentBalance) >> 64n).toString()),
					lo: xdr.Uint64.fromString((BigInt(record.agentBalance) & ((1n << 64n) - 1n)).toString()),
				}),
			),
		}),
		new xdr.ScMapEntry({
			key: xdr.ScVal.scvSymbol('channel_id'),
			val: xdr.ScVal.scvBytes(Buffer.from(record.channelId, 'hex')),
		}),
		new xdr.ScMapEntry({
			key: xdr.ScVal.scvSymbol('iteration'),
			val: xdr.ScVal.scvU64(xdr.Uint64.fromString(record.iteration)),
		}),
		new xdr.ScMapEntry({
			key: xdr.ScVal.scvSymbol('server_balance'),
			val: xdr.ScVal.scvI128(
				new xdr.Int128Parts({
					hi: xdr.Int64.fromString((BigInt(record.serverBalance) >> 64n).toString()),
					lo: xdr.Uint64.fromString((BigInt(record.serverBalance) & ((1n << 64n) - 1n)).toString()),
				}),
			),
		}),
	]);
}

export async function submitCloseChannelTransaction(
	config: ChannelConfig,
	record: StoredChannelRecord,
): Promise<string> {
	const server = new rpc.Server(config.rpcUrl);
	const account = await server.getAccount(config.facilitatorKeypair.publicKey());
	const contract = new Contract(config.channelContractId);
	const tx = new TransactionBuilder(account, {
		fee: BASE_FEE,
		networkPassphrase: config.networkPassphrase,
	})
		.addOperation(
			contract.call(
				'close_channel',
				xdr.ScVal.scvBytes(Buffer.from(record.channelId, 'hex')),
				channelStateScVal(record),
				xdr.ScVal.scvBytes(Buffer.from(record.agentSig, 'hex')),
				xdr.ScVal.scvBytes(Buffer.from(record.serverSig, 'hex')),
			),
		)
		.setTimeout(30)
		.build();
	const prepared = await server.prepareTransaction(tx);
	prepared.sign(config.facilitatorKeypair);

	const result = await withRpcRetry('rpc.sendTransaction(close)', () =>
		rpcRequest<RawSendTransactionResult>(config.rpcUrl, 'sendTransaction', {
			transaction: prepared.toXDR(),
		}),
	);
	if (result.status === 'ERROR') {
		throw new Error(`channel/close submit error: ${JSON.stringify(result)}`);
	}
	await waitForTransaction(config.rpcUrl, result.hash);
	return result.hash;
}
