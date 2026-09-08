import type { PublicLiveBlock, PublicShareEvent } from "@shared/public-narrator-share";
import { RateLimitError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { getStreamingSnapshot } from "./narrator-event-handler";
import { PUBLIC_SHARE_LIMITS as L } from "./public-narrator-share-limits";
import { publicReadLineage } from "./public-narrator-share-lineage";
import { projectPublicLiveBlocks, publicLiveId, record } from "./public-narrator-share-projection";
import {
	onPublicShareRevoked,
	revalidatePublicShare,
	type VerifiedPublicShare,
} from "./public-narrator-share-service";

type Frame = { event: PublicShareEvent; bytes: Uint8Array };
type Delta = Extract<PublicShareEvent, { type: "delta" }>;
interface Client {
	auth: VerifiedPublicShare;
	ip: string;
	hub: Hub;
	controller: ReadableStreamDefaultController<Uint8Array>;
	queue: Frame[];
	queuedBytes: number;
	waiting: boolean;
	closed: boolean;
	offsets: Map<string, number>;
	startedAt: number;
	lastWrite: number;
	lastPing: number;
	cleanupAbort: () => void;
}
interface Hub {
	narratorId: string;
	clients: Set<Client>;
	blocks: PublicLiveBlock[];
	truncated: boolean;
	deltas: Map<string, Delta>;
	invalidations: Set<"messages" | "discussion" | "session">;
	refresh: boolean;
	ancestors: Set<string>;
	refreshAncestors: boolean;
	timer?: ReturnType<typeof setTimeout>;
}
interface Dependencies {
	snapshot: (narratorId: string) => readonly unknown[];
	lineage?: (narratorId: string) => readonly string[];
	validate: (auth: VerifiedPublicShare) => VerifiedPublicShare;
	subscribe: (listener: (event: unknown) => void) => () => void;
	subscribeRevoked: (listener: (shareId: string) => void) => () => void;
	now?: () => number;
}

const encoder = new TextEncoder();
function frame(event: PublicShareEvent): Frame {
	const bytes = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
	if (bytes.byteLength > L.frameBytes) return frame({ type: "reset" });
	return { event, bytes };
}

/** One bounded aggregator per narrator, one listener/timer for the entire registry. */
export class PublicNarratorShareStreams {
	private hubs = new Map<string, Hub>();
	private inherited = new Map<string, Set<Hub>>();
	private clients = new Set<Client>();
	private byShare = new Map<string, Set<Client>>();
	private ipCounts = new Map<string, number>();
	private timer?: ReturnType<typeof setInterval>;
	private unsubscribe?: () => void;
	private unsubscribeRevoked?: () => void;
	private now: () => number;

	constructor(private deps: Dependencies) {
		this.now = deps.now ?? Date.now;
	}

	open(auth: VerifiedPublicShare, ip: string, signal?: AbortSignal): ReadableStream<Uint8Array> {
		const current = this.deps.validate(auth);
		if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
		if (
			this.clients.size >= L.connectionsTotal ||
			(this.byShare.get(current.shareId)?.size ?? 0) >= L.connectionsPerShare ||
			(this.ipCounts.get(ip) ?? 0) >= L.connectionsPerIp
		) {
			throw new RateLimitError(
				"PUBLIC_SHARE_CONNECTION_LIMIT",
				L.heartbeatMs,
				"Too many sharing connections",
			);
		}
		if (!this.unsubscribe) {
			this.unsubscribe = this.deps.subscribe((event) => this.accept(event));
			this.unsubscribeRevoked = this.deps.subscribeRevoked((id) => this.revoke(id));
			this.timer = setInterval(() => this.tick(), 1000);
			this.timer.unref?.();
		}
		let hub = this.hubs.get(current.narratorId);
		if (!hub) {
			hub = {
				narratorId: current.narratorId,
				clients: new Set(),
				blocks: [],
				truncated: false,
				deltas: new Map(),
				invalidations: new Set(),
				refresh: false,
				ancestors: new Set(),
				refreshAncestors: false,
			};
			// Install the hub before taking the synchronous snapshot: there is no
			// await gap in registration/snapshot/subscription. No history replay buffer.
			this.hubs.set(current.narratorId, hub);
			try {
				this.updateAncestors(hub);
				Object.assign(hub, projectPublicLiveBlocks(this.deps.snapshot(current.narratorId)));
			} catch (error) {
				this.removeAncestors(hub);
				this.hubs.delete(current.narratorId);
				this.releaseIdle();
				throw error;
			}
		}
		const selectedHub = hub;
		let client: Client;
		return new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					const now = this.now();
					client = {
						auth: current,
						ip,
						hub: selectedHub,
						controller,
						queue: [],
						queuedBytes: 0,
						waiting: false,
						closed: false,
						offsets: new Map(),
						startedAt: now,
						lastWrite: now,
						lastPing: now,
						cleanupAbort: () => {},
					};
					this.clients.add(client);
					selectedHub.clients.add(client);
					let shares = this.byShare.get(current.shareId);
					if (!shares) {
						shares = new Set();
						this.byShare.set(current.shareId, shares);
					}
					shares.add(client);
					this.ipCounts.set(ip, (this.ipCounts.get(ip) ?? 0) + 1);
					const abort = () => this.close(client);
					signal?.addEventListener("abort", abort, { once: true });
					client.cleanupAbort = () => signal?.removeEventListener("abort", abort);
					// The initial snapshot makes the public client refresh its REST pages.
					// `reset` is reserved for closing a stream and forcing a reconnect;
					// sending it here would abort the client before it receives the snapshot.
					this.enqueue(client, this.snapshotFrame(selectedHub));
				},
				pull: () => {
					client.waiting = true;
					this.drain(client);
				},
				cancel: () => this.close(client),
			},
			{ highWaterMark: 0 },
		);
	}

	private removeAncestors(hub: Hub): void {
		for (const id of hub.ancestors) {
			const subscribers = this.inherited.get(id);
			subscribers?.delete(hub);
			if (!subscribers?.size) this.inherited.delete(id);
		}
		hub.ancestors.clear();
	}

	private updateAncestors(hub: Hub): void {
		const ids = this.deps.lineage?.(hub.narratorId) ?? [];
		if (ids.length > L.lineageDepth) throw new Error("Invalid public lineage");
		this.removeAncestors(hub);
		for (const id of ids) {
			if (id === hub.narratorId) continue;
			hub.ancestors.add(id);
			let subscribers = this.inherited.get(id);
			if (!subscribers) {
				subscribers = new Set();
				this.inherited.set(id, subscribers);
			}
			subscribers.add(hub);
		}
	}

	private releaseIdle(): void {
		if (this.clients.size) return;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.unsubscribe?.();
		this.unsubscribeRevoked?.();
		this.unsubscribe = undefined;
		this.unsubscribeRevoked = undefined;
	}

	private snapshotFrame(hub: Hub): Frame {
		return frame({
			type: "snapshot",
			blocks: hub.blocks.map((block) => ({ ...block })),
			truncated: hub.truncated,
		});
	}

	private enqueue(client: Client, next: Frame): void {
		if (client.closed) return;
		let outgoing = next;
		if (next.event.type === "snapshot") {
			client.offsets = new Map(next.event.blocks.map((block) => [block.id, block.text.length]));
		} else if (next.event.type === "delta") {
			const event = next.event;
			const known = client.offsets.get(event.blockId) ?? 0;
			if (known > event.offset) {
				const skip = known - event.offset;
				if (skip >= event.text.length) return;
				outgoing = frame({ ...event, offset: known, text: event.text.slice(skip) });
			} else if (known < event.offset) {
				this.close(client, "reset");
				return;
			}
			client.offsets.set(event.blockId, event.offset + event.text.length);
		}
		if (client.queuedBytes + outgoing.bytes.byteLength > L.queueBytes) {
			this.close(client, "reset");
			return;
		}
		client.queue.push(outgoing);
		client.queuedBytes += outgoing.bytes.byteLength;
		this.drain(client);
	}

	private drain(client: Client): void {
		if (client.closed || !client.waiting || !client.queue.length) return;
		// No await between this check and enqueue. Queued payloads can never survive
		// a committed revoke, even if the consumer was paused for several seconds.
		try {
			const current = this.deps.validate(client.auth);
			if (current.narratorId !== client.auth.narratorId || current.roomId !== client.auth.roomId) {
				this.close(client, "revoked");
				return;
			}
		} catch {
			this.close(client, "revoked");
			return;
		}
		const next = client.queue.shift();
		if (!next) return;
		client.queuedBytes -= next.bytes.byteLength;
		client.waiting = false;
		client.lastWrite = this.now();
		try {
			client.controller.enqueue(next.bytes);
		} catch {
			this.close(client);
		}
	}

	private schedule(hub: Hub): void {
		if (hub.timer) return;
		hub.timer = setTimeout(() => {
			hub.timer = undefined;
			this.flushHub(hub);
		}, L.mergeMs);
		hub.timer.unref?.();
	}

	/** Closed event selection. Nothing from an internal object is spread into a DTO. */
	accept(raw: unknown): void {
		const event = record(raw);
		if (!event || typeof event.narratorId !== "string") return;
		const ancestorMessage =
			event.type === "narrator:message_broadcast" ? record(event.message) : null;
		if (
			ancestorMessage &&
			!ancestorMessage.parentToolUseId &&
			!ancestorMessage.subagentNarratorId &&
			["message", "message_updated", "messages_deleted", "compact_done"].includes(
				String(ancestorMessage.type),
			)
		) {
			for (const dependent of this.inherited.get(event.narratorId) ?? []) {
				// An ancestor's current output is NEVER forwarded to a fork. Only the
				// virtual history version may have changed below its exclusive bound.
				dependent.invalidations.add("messages");
				dependent.invalidations.add("session");
				dependent.refreshAncestors = true;
				this.schedule(dependent);
			}
		}
		const hub = this.hubs.get(event.narratorId);
		if (!hub) return;
		if (event.type === "chat:message_created" || event.type === "chat:message_deleted") {
			if (![...hub.clients].some((client) => client.auth.roomId === event.roomId)) return;
			hub.invalidations.add("discussion");
			this.schedule(hub);
			return;
		}
		if (event.type === "narrator:title_updated" || event.type === "narrator:status_changed") {
			hub.invalidations.add("session");
			this.schedule(hub);
			return;
		}
		if (event.type !== "narrator:message_broadcast") return;
		const message = record(event.message);
		if (!message || message.parentToolUseId || message.subagentNarratorId) return;
		if (message.type === "stream_event") {
			const stream = record(message.event);
			if (
				!stream ||
				stream.subagentToolUseId ||
				stream.parentToolUseId ||
				stream.subagentNarratorId ||
				stream.type !== "content_block_delta"
			)
				return;
			const delta = record(stream.delta);
			if (
				!delta ||
				(delta.type !== "text_delta" && delta.type !== "reasoning_delta") ||
				typeof delta.text !== "string"
			)
				return;
			const kind = delta.type === "text_delta" ? "text" : "reasoning";
			const last = hub.blocks.findLast((block) => block.kind === kind);
			const id = publicLiveId(delta.id, last?.id ?? `live-${kind}-0`);
			let block = hub.blocks.find((item) => item.id === id && item.kind === kind);
			if (!block) {
				if (hub.blocks.length >= L.liveBlocks) {
					this.truncate(hub);
					return;
				}
				block = { id, kind, text: "" };
				hub.blocks.push(block);
			}
			const remaining =
				L.liveTextChars - hub.blocks.reduce((sum, item) => sum + item.text.length, 0);
			if (remaining <= 0) {
				this.truncate(hub);
				return;
			}
			const text = delta.text.slice(0, remaining);
			const offset = block.text.length;
			block.text += text;
			const previous = hub.deltas.get(id);
			if (previous && previous.offset + previous.text.length === offset) previous.text += text;
			else hub.deltas.set(id, { type: "delta", blockId: id, kind, text, offset });
			if (text.length < delta.text.length) this.truncate(hub);
			this.schedule(hub);
			return;
		}
		if (
			[
				"message",
				"message_updated",
				"messages_deleted",
				"compact_done",
				"streaming_reset",
				"status_change",
				"tool_completed",
				"tool_started",
				"tool_executing",
			].includes(String(message.type))
		) {
			hub.invalidations.add(message.type === "status_change" ? "session" : "messages");
			if (
				[
					"message",
					"message_updated",
					"messages_deleted",
					"compact_done",
					"streaming_reset",
					"status_change",
				].includes(String(message.type))
			)
				hub.refresh = true;
			if (
				["message", "message_updated", "messages_deleted", "compact_done"].includes(
					String(message.type),
				)
			)
				hub.refreshAncestors = true;
			this.schedule(hub);
		}
	}

	private truncate(hub: Hub): void {
		if (hub.truncated) return;
		hub.truncated = true;
		// One bounded snapshot exposes the truncation marker. Do not resend the
		// growing full text for every later chunk once the budget is exhausted.
		hub.refresh = true;
		this.schedule(hub);
	}

	private flushHub(hub: Hub): void {
		if (!hub.clients.size) return;
		const frames: Frame[] = [];
		try {
			if (hub.refreshAncestors) this.updateAncestors(hub);
			if (hub.refresh) {
				Object.assign(hub, projectPublicLiveBlocks(this.deps.snapshot(hub.narratorId)));
				frames.push(this.snapshotFrame(hub));
			} else for (const delta of hub.deltas.values()) frames.push(frame(delta));
		} catch {
			for (const client of [...hub.clients]) this.close(client, "reset");
			return;
		}
		hub.refreshAncestors = false;
		for (const scope of hub.invalidations) frames.push(frame({ type: "invalidate", scope }));
		hub.refresh = false;
		hub.deltas.clear();
		hub.invalidations.clear();
		// Projection and encoding happened once, not once per viewer/chunk.
		for (const client of [...hub.clients]) for (const next of frames) this.enqueue(client, next);
	}

	/** Also provides deterministic timer-budget testing without real sleeps. */
	tick(): void {
		const now = this.now();
		for (const client of [...this.clients]) {
			if (now - client.startedAt >= L.connectionMs) {
				this.close(client, "reset");
				continue;
			}
			if (client.queuedBytes && now - client.lastWrite >= L.stallMs) {
				logger.warn("Public sharing consumer stalled", { queuedBytes: client.queuedBytes });
				this.close(client, "reset");
				continue;
			}
			if (now - client.lastPing >= L.heartbeatMs) {
				client.lastPing = now;
				try {
					this.deps.validate(client.auth);
				} catch {
					this.close(client, "revoked");
					continue;
				}
				this.enqueue(client, frame({ type: "ping" }));
			}
		}
	}

	flush(): void {
		for (const hub of this.hubs.values()) {
			if (hub.timer) {
				clearTimeout(hub.timer);
				hub.timer = undefined;
			}
			this.flushHub(hub);
		}
	}

	revoke(shareId: string): void {
		for (const client of [...(this.byShare.get(shareId) ?? [])]) this.close(client, "revoked");
	}

	private close(client: Client, terminal?: "revoked" | "reset"): void {
		if (client.closed) return;
		client.closed = true;
		client.queue = [];
		client.queuedBytes = 0;
		client.offsets.clear();
		client.cleanupAbort();
		this.clients.delete(client);
		client.hub.clients.delete(client);
		const shares = this.byShare.get(client.auth.shareId);
		shares?.delete(client);
		if (!shares?.size) this.byShare.delete(client.auth.shareId);
		const ipCount = (this.ipCounts.get(client.ip) ?? 1) - 1;
		if (ipCount === 0) this.ipCounts.delete(client.ip);
		else this.ipCounts.set(client.ip, ipCount);
		if (!client.hub.clients.size) {
			this.removeAncestors(client.hub);
			if (client.hub.timer) clearTimeout(client.hub.timer);
			client.hub.deltas.clear();
			client.hub.blocks = [];
			client.hub.invalidations.clear();
			this.hubs.delete(client.hub.narratorId);
		}
		try {
			if (terminal) client.controller.enqueue(frame({ type: terminal }).bytes);
			client.controller.close();
		} catch {
			/* Reader cancelled. */
		}
		this.releaseIdle();
	}

	dispose(): void {
		for (const client of [...this.clients]) this.close(client);
	}
	get stats() {
		return {
			connections: this.clients.size,
			hubs: this.hubs.size,
			shares: this.byShare.size,
			ips: this.ipCounts.size,
			listening: Boolean(this.unsubscribe),
			queuedBytes: [...this.clients].reduce((sum, client) => sum + client.queuedBytes, 0),
		};
	}
}

export const publicNarratorShareStreams = new PublicNarratorShareStreams({
	snapshot: (id) => getStreamingSnapshot(id)?.streamingBlocks ?? [],
	lineage: (id) => publicReadLineage(id).map((scope) => scope.narratorId),
	validate: revalidatePublicShare,
	subscribe: (listener) => {
		eventBus.onAny(listener);
		return () => eventBus.offAny(listener);
	},
	subscribeRevoked: onPublicShareRevoked,
});
