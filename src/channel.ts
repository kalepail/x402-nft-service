import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

export interface ChannelPaymentHeader {
	scheme: 'channel';
	channelId: string;
	iteration: string;
	agentBalance: string;
	serverBalance: string;
	deposit?: string;
	agentPublicKey?: string;
	agentSig: string;
}

export interface ChannelPaymentResponse {
	scheme: 'channel';
	channelId: string;
	iteration: string;
	serverSig: string;
}

export interface ChannelConfig {
	serverKeypair: Keypair;
	facilitatorKeypair: Keypair;
	price: bigint;
	channelContractId: string;
	networkPassphrase: string;
	rpcUrl: string;
	suggestedDeposit?: bigint;
}

export interface ChannelStateSnapshot {
	channelId: string;
	iteration: string;
	agentBalance: string;
	serverBalance: string;
	deposit: string;
	agentPublicKey: string;
	agentSig: string;
	serverSig: string;
}

export interface StoredChannelRecord extends ChannelStateSnapshot {
	payer: string;
	payTo: string;
	asset: string;
	openedTxHash: string;
	closedTxHash?: string;
	status: 'open' | 'closed';
}

function writeBigInt128BE(buf: Buffer, value: bigint, offset: number): void {
	const mask64 = (1n << 64n) - 1n;
	const hi = (value >> 64n) & mask64;
	const lo = value & mask64;
	buf.writeBigUInt64BE(hi, offset);
	buf.writeBigUInt64BE(lo, offset + 8);
}

export function stateMessage(
	channelId: Buffer,
	iteration: bigint,
	agentBalance: bigint,
	serverBalance: bigint,
): Buffer {
	const buf = Buffer.alloc(72);
	channelId.copy(buf, 0);
	buf.writeBigUInt64BE(iteration, 32);
	writeBigInt128BE(buf, agentBalance, 40);
	writeBigInt128BE(buf, serverBalance, 56);
	return buf;
}

export function closeIntentMessage(channelId: string): Buffer {
	return Buffer.concat([Buffer.from(channelId, 'hex'), Buffer.from('close', 'utf8')]);
}

export function signStateHex(
	keypair: Keypair,
	channelId: string,
	iteration: bigint,
	agentBalance: bigint,
	serverBalance: bigint,
): string {
	const msg = stateMessage(Buffer.from(channelId, 'hex'), iteration, agentBalance, serverBalance);
	return Buffer.from(keypair.sign(msg)).toString('hex');
}

export function signCloseIntentHex(keypair: Keypair, channelId: string): string {
	return Buffer.from(keypair.sign(closeIntentMessage(channelId))).toString('hex');
}

export function verifyStateSignature(
	publicKeyStrkey: string,
	signatureHex: string,
	channelId: string,
	iteration: bigint,
	agentBalance: bigint,
	serverBalance: bigint,
): boolean {
	const msg = stateMessage(Buffer.from(channelId, 'hex'), iteration, agentBalance, serverBalance);
	const keypair = Keypair.fromPublicKey(publicKeyStrkey);
	return keypair.verify(msg, Buffer.from(signatureHex, 'hex'));
}

export function verifyCloseIntentSignature(
	publicKeyStrkey: string,
	signatureHex: string,
	channelId: string,
): boolean {
	const keypair = Keypair.fromPublicKey(publicKeyStrkey);
	return keypair.verify(closeIntentMessage(channelId), Buffer.from(signatureHex, 'hex'));
}

export function deriveChannelIdHex(agentPublicKey: string, nonce: Uint8Array): string {
	return createHash('sha256')
		.update(Buffer.from(StrKey.decodeEd25519PublicKey(agentPublicKey)))
		.update(Buffer.from(nonce))
		.digest('hex');
}

export interface VerifiedChannelPayment {
	iteration: bigint;
	agentBalance: bigint;
	serverBalance: bigint;
	deposit: bigint;
	currentCumulative: bigint;
	remainingBalance: bigint;
	counterSig: string;
}

export function verifyStateChannelPayment(
	header: ChannelPaymentHeader,
	record: StoredChannelRecord,
	config: ChannelConfig,
): { ok: true; payment: VerifiedChannelPayment } | { ok: false; error: string } {
	const iteration = BigInt(header.iteration);
	const agentBalance = BigInt(header.agentBalance);
	const serverBalance = BigInt(header.serverBalance);
	const deposit = BigInt(record.deposit);
	const previousIteration = BigInt(record.iteration);
	const previousServerBalance = BigInt(record.serverBalance);

	if (record.status !== 'open') {
		return { ok: false, error: 'channel/finalized' };
	}
	if (header.channelId !== record.channelId) {
		return { ok: false, error: 'channel/not-found' };
	}
	if (header.agentPublicKey && header.agentPublicKey !== record.agentPublicKey) {
		return { ok: false, error: 'channel/agent-key-mismatch' };
	}
	if (agentBalance + serverBalance !== deposit) {
		return { ok: false, error: 'channel/bad-balances' };
	}
	if (agentBalance < 0n || serverBalance < 0n) {
		return { ok: false, error: 'channel/bad-balances' };
	}
	if (iteration !== previousIteration + 1n) {
		return { ok: false, error: 'channel/bad-iteration' };
	}
	if (serverBalance - previousServerBalance !== config.price) {
		return { ok: false, error: 'channel/amount-mismatch' };
	}
	if (serverBalance > deposit) {
		return { ok: false, error: 'channel/insufficient-balance' };
	}
	try {
		if (
			!verifyStateSignature(
				record.agentPublicKey,
				header.agentSig,
				record.channelId,
				iteration,
				agentBalance,
				serverBalance,
			)
		) {
			return { ok: false, error: 'channel/invalid-signature' };
		}
	} catch {
		return { ok: false, error: 'channel/invalid-signature' };
	}

	const counterSig = signStateHex(
		config.serverKeypair,
		record.channelId,
		iteration,
		agentBalance,
		serverBalance,
	);
	return {
		ok: true,
		payment: {
			iteration,
			agentBalance,
			serverBalance,
			deposit,
			currentCumulative: serverBalance,
			remainingBalance: agentBalance,
			counterSig,
		},
	};
}
