import { createHash } from 'node:crypto';
import { DurableObject } from 'cloudflare:workers';
import { Address, Keypair, StrKey, TransactionBuilder, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk';

const DRAFT_CHANNEL_DOMAIN = 'x402-nft-service:experimental-channel-factory';
export const DRAFT_REFUND_WAITING_PERIOD = 24;
export const DRAFT_CHANNEL_FACTORY_CONTRACT = StrKey.encodeContract(
	createHash('sha256').update(DRAFT_CHANNEL_DOMAIN).digest(),
);

export interface DraftChannelRecord {
	channelId: string;
	asset: string;
	payTo: string;
	payer: string;
	commitmentKey: string;
	deposit: string;
	currentCumulative: string;
	remainingBalance: string;
	refundWaitingPeriod: number;
}

export interface DraftOpenRequest {
	channelId: string;
	asset: string;
	payTo: string;
	payer: string;
	commitmentKey: string;
	deposit: string;
	refundWaitingPeriod: number;
}

export interface DraftPayRequest {
	channelId: string;
	cumulativeAmount: string;
	signature: string;
	expectedAmount: string;
	networkPassphrase: string;
}

export function networkPassphraseForNetwork(network: string): string {
	switch (network) {
		case 'stellar:testnet':
			return 'Test SDF Network ; September 2015';
		case 'stellar:pubnet':
			return 'Public Global Stellar Network ; September 2015';
		default:
			throw new Error(`Unsupported Stellar network: ${network}`);
	}
}

function extractI128(value: xdr.ScVal): bigint {
	const i128 = value.i128();
	return (BigInt(i128.hi().toString()) << 64n) + BigInt(i128.lo().toString());
}

export function buildDraftCommitmentBytes(
	channelId: string,
	networkPassphrase: string,
	amount: bigint,
): Buffer {
	const entries = [
		new xdr.ScMapEntry({
			key: xdr.ScVal.scvSymbol('amount'),
			val: nativeToScVal(amount, { type: 'i128' }),
		}),
		new xdr.ScMapEntry({
			key: xdr.ScVal.scvSymbol('channel'),
			val: new Address(channelId).toScVal(),
		}),
		new xdr.ScMapEntry({
			key: xdr.ScVal.scvSymbol('domain'),
			val: xdr.ScVal.scvSymbol('chancmmt'),
		}),
		new xdr.ScMapEntry({
			key: xdr.ScVal.scvSymbol('network'),
			val: xdr.ScVal.scvBytes(hash(Buffer.from(networkPassphrase))),
		}),
	];
	return Buffer.from(xdr.ScVal.scvMap(entries).toXDR());
}

export function parseDraftOpenTransaction(
	transactionXdr: string,
	networkPassphrase: string,
): DraftOpenRequest & { factoryContract: string } {
	const tx = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
	if (tx.operations.length !== 1) {
		throw new Error('draft channel open transaction must contain exactly one operation');
	}

	const operation = tx.operations[0];
	if (operation.type !== 'invokeHostFunction') {
		throw new Error('draft channel open transaction must use invokeHostFunction');
	}

	const invoke = operation.func.invokeContract();
	if (invoke.functionName().toString() !== 'open') {
		throw new Error('draft channel open transaction must call open');
	}

	const args = invoke.args();
	if (args.length < 7) {
		throw new Error('draft channel open transaction is missing required arguments');
	}

	const salt = Buffer.from(args[0].bytes());
	const asset = Address.fromScVal(args[1]).toString();
	const payer = Address.fromScVal(args[2]).toString();
	const commitmentKey = StrKey.encodeEd25519PublicKey(Buffer.from(args[3].bytes()));
	const payTo = Address.fromScVal(args[4]).toString();
	const deposit = extractI128(args[5]);
	const refundWaitingPeriod = args[6].u32();
	const factoryContract = StrKey.encodeContract(
		Buffer.from(invoke.contractAddress().contractId() as unknown as Uint8Array),
	);
	const channelId = StrKey.encodeContract(
		createHash('sha256')
			.update(Buffer.from(StrKey.decodeEd25519PublicKey(payer)))
			.update(Buffer.from(StrKey.decodeEd25519PublicKey(commitmentKey)))
			.update(Buffer.from(StrKey.decodeContract(asset)))
			.update(Buffer.from(StrKey.decodeEd25519PublicKey(payTo)))
			.update(salt)
			.digest(),
	);

	return {
		channelId,
		factoryContract,
		asset,
		payTo,
		payer,
		commitmentKey,
		deposit: deposit.toString(),
		refundWaitingPeriod,
	};
}

export class ChannelStateDurableObject extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		if (url.pathname === '/open') {
			const open = (await request.json()) as DraftOpenRequest;
			const existing = await this.ctx.storage.get<DraftChannelRecord>('channel');
			if (existing) {
				return Response.json(
					{
						success: false,
						error: 'channel/already-exists',
						channelId: existing.channelId,
						currentCumulative: existing.currentCumulative,
						remainingBalance: existing.remainingBalance,
					},
					{ status: 409 },
				);
			}

			const record: DraftChannelRecord = {
				...open,
				currentCumulative: '0',
				remainingBalance: open.deposit,
			};
			await this.ctx.storage.put('channel', record);
			return Response.json({
				success: true,
				channelId: record.channelId,
				deposit: record.deposit,
				currentCumulative: '0',
				remainingBalance: record.deposit,
				resourceGranted: false,
			});
		}

		if (url.pathname === '/pay') {
			const pay = (await request.json()) as DraftPayRequest;
			const record = await this.ctx.storage.get<DraftChannelRecord>('channel');
			if (!record || record.channelId !== pay.channelId) {
				return Response.json({ success: false, error: 'channel/not-found' }, { status: 404 });
			}

			const current = BigInt(record.currentCumulative);
			const next = BigInt(pay.cumulativeAmount);
			const expectedIncrement = BigInt(pay.expectedAmount);
			if (next <= current) {
				return Response.json({ success: false, error: 'channel/stale-commitment' }, { status: 402 });
			}
			if (next - current !== expectedIncrement) {
				return Response.json({ success: false, error: 'channel/amount-mismatch' }, { status: 402 });
			}
			if (next > BigInt(record.deposit)) {
				return Response.json(
					{
						success: false,
						error: 'channel/insufficient-balance',
						channelId: record.channelId,
						currentCumulative: record.currentCumulative,
						remainingBalance: record.remainingBalance,
						requiredAmount: pay.expectedAmount,
					},
					{ status: 402 },
				);
			}

			const signature = Buffer.from(pay.signature, 'base64');
			const message = buildDraftCommitmentBytes(
				record.channelId,
				pay.networkPassphrase,
				next,
			);
			const commitmentKeypair = Keypair.fromPublicKey(record.commitmentKey);
			if (!commitmentKeypair.verify(message, signature)) {
				return Response.json({ success: false, error: 'channel/invalid-signature' }, { status: 402 });
			}

			record.currentCumulative = next.toString();
			record.remainingBalance = (BigInt(record.deposit) - next).toString();
			await this.ctx.storage.put('channel', record);
			return Response.json({
				success: true,
				channelId: record.channelId,
				currentCumulative: record.currentCumulative,
				remainingBalance: record.remainingBalance,
			});
		}

		return new Response('Not Found', { status: 404 });
	}
}
