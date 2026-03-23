import { DurableObject } from 'cloudflare:workers';
import type { StoredChannelRecord } from './channel';

export class ChannelStateDurableObject extends DurableObject {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/state' && request.method === 'GET') {
			const record = await this.ctx.storage.get<StoredChannelRecord>('channel');
			if (!record) {
				return Response.json({ error: 'channel/not-found' }, { status: 404 });
			}
			return Response.json(record);
		}

		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		if (url.pathname === '/open') {
			const record = (await request.json()) as StoredChannelRecord;
			const existing = await this.ctx.storage.get<StoredChannelRecord>('channel');
			if (existing && existing.status === 'open') {
				return Response.json(
					{
						error: 'channel/already-exists',
						channelId: existing.channelId,
						status: existing.status,
					},
					{ status: 409 },
				);
			}
			await this.ctx.storage.put('channel', record);
			return Response.json(record);
		}

		if (url.pathname === '/pay') {
			const newRecord = (await request.json()) as StoredChannelRecord;
			const existing = await this.ctx.storage.get<StoredChannelRecord>('channel');
			if (!existing || existing.status !== 'open') {
				return Response.json({ error: 'channel/not-found' }, { status: 404 });
			}
			if (BigInt(newRecord.iteration) !== BigInt(existing.iteration) + 1n) {
				return Response.json(
					{ error: 'channel/bad-iteration', currentIteration: existing.iteration },
					{ status: 409 },
				);
			}
			if (existing.price !== undefined) {
				const delta = BigInt(newRecord.serverBalance) - BigInt(existing.serverBalance);
				if (delta !== BigInt(existing.price)) {
					return Response.json({ error: 'channel/amount-mismatch' }, { status: 409 });
				}
			}
			await this.ctx.storage.put('channel', newRecord);
			return Response.json(newRecord);
		}

		if (url.pathname === '/close') {
			const record = (await request.json()) as StoredChannelRecord;
			await this.ctx.storage.put('channel', record);
			return Response.json(record);
		}

		return new Response('Not Found', { status: 404 });
	}
}
