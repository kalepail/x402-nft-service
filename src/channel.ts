/**
 * Channel payment verification for x402.
 *
 * Enables stateless verification of off-chain payment channel states.
 * Each state is self-describing — no server-side storage needed.
 *
 * The canonical 72-byte state message matches the on-chain Soroban contract:
 *   channel_id (32 BE) || iteration (8 BE) || agent_balance (16 BE) || server_balance (16 BE)
 */

import { Buffer } from 'node:buffer';
import { Keypair } from '@stellar/stellar-sdk';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChannelPaymentHeader {
	scheme: 'channel';
	channelId: string; // hex 32 bytes
	iteration: string; // bigint as decimal string
	agentBalance: string;
	serverBalance: string;
	deposit: string;
	agentPublicKey: string; // G... Stellar strkey
	agentSig: string; // hex 64-byte ed25519 signature
}

export interface ChannelPaymentResponse {
	scheme: 'channel';
	channelId: string;
	iteration: string;
	serverSig: string; // hex 64-byte ed25519 counter-signature
}

export interface ChannelConfig {
	/** Server keypair for counter-signing channel states. */
	serverKeypair: Keypair;
	/** Price per request in the token's smallest unit. */
	price: bigint;
}

// ── State message ────────────────────────────────────────────────────────────

function writeBigInt128BE(buf: Buffer, value: bigint, offset: number): void {
	const mask64 = (1n << 64n) - 1n;
	const hi = (value >> 64n) & mask64;
	const lo = value & mask64;
	buf.writeBigUInt64BE(hi, offset);
	buf.writeBigUInt64BE(lo, offset + 8);
}

function stateMessage(
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

// ── Verify + Counter-sign ────────────────────────────────────────────────────

export interface VerifyResult {
	valid: boolean;
	error?: string;
	counterSig?: string; // hex
}

/**
 * Verify a channel payment header and produce a counter-signature.
 *
 * Fully stateless — validates the payment math and ed25519 signature
 * without any server-side state. Replay of the same iteration is
 * harmless (agent gets the same resource twice; server's balance only
 * grows with higher iterations).
 */
export function verifyChannelPayment(
	header: ChannelPaymentHeader,
	config: ChannelConfig,
): VerifyResult {
	const iteration = BigInt(header.iteration);
	const agentBalance = BigInt(header.agentBalance);
	const serverBalance = BigInt(header.serverBalance);
	const deposit = BigInt(header.deposit);

	// 1. Conservation: balances must sum to deposit
	if (agentBalance + serverBalance !== deposit) {
		return { valid: false, error: 'Balances do not sum to deposit' };
	}

	// 2. Non-negative balances
	if (agentBalance < 0n || serverBalance < 0n) {
		return { valid: false, error: 'Negative balance' };
	}

	// 3. Payment amount: server must have received at least iteration × price
	if (serverBalance < iteration * config.price) {
		return { valid: false, error: 'Insufficient payment for iteration count' };
	}

	// 4. Verify ed25519 signature
	const channelIdBuf = Buffer.from(header.channelId, 'hex');
	const agentSig = Buffer.from(header.agentSig, 'hex');
	const msg = stateMessage(channelIdBuf, iteration, agentBalance, serverBalance);

	try {
		const agentKp = Keypair.fromPublicKey(header.agentPublicKey);
		if (!agentKp.verify(msg, agentSig)) {
			return { valid: false, error: 'Invalid agent signature' };
		}
	} catch {
		return { valid: false, error: 'Invalid agent public key or signature format' };
	}

	// 5. Counter-sign the state
	const counterSig = Buffer.from(config.serverKeypair.sign(msg)).toString('hex');

	return { valid: true, counterSig };
}
