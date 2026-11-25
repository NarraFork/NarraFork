import {
	type CommunicationClientMessage,
	type CommunicationScope,
	type CommunicationServerMessage,
	type CommunicationTopology,
	diffCommunicationTopology,
	COMMUNICATION_LIMITS as limits,
} from "@shared/narrator-communication";
import { eventBus, type NarraForkEvent } from "../lib/event-bus";
import { hotOnce, hotSafe } from "../lib/hot-safe";

export interface CommunicationSocket {
	data: { userId?: string; userRole?: string; sessionId?: string; publicShare?: unknown };
	send(frame: string): unknown;
	getBufferedAmount?(): number;
	close?(code?: number, reason?: string): void;
}
type Reader = (
	scope: CommunicationScope,
	principal: { userId: string; isAdmin: boolean },
	options: { signal: AbortSignal; maxNodes: number; maxPeers: number },
	ws: CommunicationSocket,
) => Promise<CommunicationTopology>;
interface Subscription {
	ws: CommunicationSocket;
	id: string;
	scope: CommunicationScope;
	epoch: string;
	seq: number;
	generation: number;
	accessEpoch: number;
	topology: CommunicationTopology | null;
	reading: boolean;
	controller?: AbortController;
}

/** Ephemeral authorized projections, never an event log or a message subscription. */
export class CommunicationSubscriptions {
	private sockets = new Map<CommunicationSocket, Map<string, Subscription>>();
	private dirty = new Set<Subscription>();
	private timer?: ReturnType<typeof setTimeout>;
	private count = 0;
	private running = 0;
	constructor(
		private readonly read: Reader,
		private readonly options = {
			timeoutMs: 5000,
			coalesceMs: limits.coalesceMs as number,
			maxReads: 8,
		},
	) {}
	stats() {
		return { total: this.count, reading: this.running };
	}
	private current(sub: Subscription) {
		return this.sockets.get(sub.ws)?.get(sub.id) === sub;
	}
	private remove(sub: Subscription) {
		if (!this.current(sub)) return;
		sub.controller?.abort();
		this.dirty.delete(sub);
		const entries = this.sockets.get(sub.ws);
		if (!entries) return;
		entries.delete(sub.id);
		this.count--;
		if (!entries.size) this.sockets.delete(sub.ws);
		sub.topology = null;
	}
	release(ws: CommunicationSocket) {
		for (const sub of this.sockets.get(ws)?.values() ?? []) this.remove(sub);
	}
	private send(ws: CommunicationSocket, frame: CommunicationServerMessage): boolean {
		const text = JSON.stringify(frame);
		if ((ws.getBufferedAmount?.() ?? 0) + Buffer.byteLength(text) > limits.maxBufferedBytes) {
			this.release(ws);
			ws.close?.(1013, "Communication backpressure; reconnect");
			return false;
		}
		try {
			// Bun returns -1 when queued and 0 when dropped. Never advance seq on a dropped frame.
			if (ws.send(text) === 0) {
				this.release(ws);
				ws.close?.(1013, "Communication frame dropped; reconnect");
				return false;
			}
			return true;
		} catch {
			this.release(ws);
			return false;
		}
	}
	private fail(sub: Subscription, code: "access_denied" | "unavailable") {
		if (!this.current(sub)) return;
		this.remove(sub);
		this.send(sub.ws, { type: "communication_error", subscriptionId: sub.id, code });
	}
	handle(ws: CommunicationSocket, message: CommunicationClientMessage): void {
		const old = this.sockets.get(ws)?.get(message.subscriptionId);
		if (old) this.remove(old);
		if (message.type === "communication_unsubscribe") return;
		if (!ws.data.userId || ws.data.publicShare) {
			this.send(ws, {
				type: "communication_error",
				subscriptionId: message.subscriptionId,
				code: "access_denied",
			});
			return;
		}
		if (
			(this.sockets.get(ws)?.size ?? 0) >= limits.maxSubscriptionsPerSocket ||
			this.count >= limits.maxSubscriptions
		) {
			this.send(ws, {
				type: "communication_error",
				subscriptionId: message.subscriptionId,
				code: "unavailable",
			});
			return;
		}
		const sub: Subscription = {
			ws,
			id: message.subscriptionId,
			scope: message.scope,
			epoch: crypto.randomUUID(),
			seq: 0,
			generation: 0,
			accessEpoch: 0,
			topology: null,
			reading: false,
		};
		let entries = this.sockets.get(ws);
		if (!entries) {
			entries = new Map();
			this.sockets.set(ws, entries);
		}
		entries.set(sub.id, sub);
		this.count++;
		// Register before the first async read: changes during snapshot construction remain dirty.
		this.mark(sub);
	}
	private mark(sub: Subscription) {
		if (!this.current(sub)) return;
		sub.generation++;
		this.dirty.add(sub);
		this.schedule();
	}
	private schedule() {
		if (this.timer || !this.dirty.size || this.running >= this.options.maxReads) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, this.options.coalesceMs);
		this.timer.unref?.();
	}
	private flush() {
		for (const sub of this.dirty) {
			if (this.running >= this.options.maxReads) break;
			if (sub.reading || !this.current(sub)) continue;
			this.dirty.delete(sub);
			void this.refresh(sub);
		}
	}
	private async refresh(sub: Subscription) {
		const userId = sub.ws.data.userId;
		if (!userId) return this.fail(sub, "access_denied");
		sub.reading = true;
		this.running++;
		const generation = sub.generation;
		const accessEpoch = sub.accessEpoch;
		const controller = new AbortController();
		sub.controller = controller;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let cancel: (() => void) | undefined;
		try {
			const canceled = new Promise<never>((_, reject) => {
				cancel = () => reject(new Error("Communication read canceled"));
				controller.signal.addEventListener("abort", cancel, { once: true });
				timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
				timer.unref?.();
			});
			const next = await Promise.race([
				this.read(
					sub.scope,
					{ userId, isAdmin: sub.ws.data.userRole === "admin" },
					{
						signal: controller.signal,
						maxNodes: limits.maxVisibleNodes,
						maxPeers: limits.maxVisiblePeers,
					},
					sub.ws,
				),
				canceled,
			]);
			if (!this.current(sub) || accessEpoch !== sub.accessEpoch || controller.signal.aborted)
				return;
			if (userId !== sub.ws.data.userId) return this.fail(sub, "access_denied");
			if (
				next.nodes.length > limits.maxVisibleNodes ||
				next.peers.length > limits.maxVisiblePeers ||
				Buffer.byteLength(JSON.stringify(next)) > limits.maxSnapshotBytes
			)
				return this.fail(sub, "unavailable");
			if (!sub.topology) {
				if (
					!this.send(sub.ws, {
						type: "communication_snapshot",
						subscriptionId: sub.id,
						epoch: sub.epoch,
						seq: 0,
						topology: next,
					})
				)
					return;
				sub.seq = 0;
			} else {
				const delta = diffCommunicationTopology(sub.topology, next);
				if (
					delta.upsertNodes.length ||
					delta.removeNodeIds.length ||
					delta.upsertPeers.length ||
					delta.removePeerIds.length ||
					delta.truncated !== sub.topology.truncated
				) {
					if (
						!this.send(sub.ws, {
							type: "communication_delta",
							subscriptionId: sub.id,
							epoch: sub.epoch,
							baseSeq: sub.seq,
							seq: sub.seq + 1,
							delta,
						})
					)
						return;
					sub.seq++;
				}
			}
			sub.topology = next;
		} catch (error) {
			if (this.current(sub) && accessEpoch === sub.accessEpoch) {
				const status = (error as { statusCode?: number }).statusCode;
				this.fail(sub, status === 403 || status === 404 ? "access_denied" : "unavailable");
			}
		} finally {
			clearTimeout(timer);
			if (cancel) controller.signal.removeEventListener("abort", cancel);
			sub.reading = false;
			this.running--;
			if (this.current(sub) && sub.generation !== generation) this.dirty.add(sub);
			this.schedule();
		}
	}
	onEvent(event: NarraForkEvent) {
		const access = [
			"narrator:access_changed",
			"project:access_changed",
			"auth:changed",
			"narrator:execution_principal_changed",
		].includes(event.type);
		const structural = [
			"narrator:communication_changed",
			"team:communication_changed",
			"narrator:imported",
			"narrator:deleted",
			"narrator:forked",
			"narrator:subagent_started",
		].includes(event.type);
		if (
			!access &&
			!structural &&
			event.type !== "narrator:status_changed" &&
			event.type !== "narrator:title_updated"
		)
			return;
		for (const entries of this.sockets.values())
			for (const sub of entries.values()) {
				if (event.type === "auth:changed" && event.userId && event.userId !== sub.ws.data.userId)
					continue;
				// A coordinator title is also its team's name on visible worker annotations;
				// it can change projections that do not include the coordinator card itself.
				if (
					event.type === "narrator:status_changed" &&
					sub.topology &&
					!sub.topology.nodes.some((node) => node.id === event.narratorId)
				)
					continue;
				if (access) {
					// Synchronous invalidation before any asynchronous re-authorization. Also tell the
					// browser to erase cached sensitive facts immediately, not after a worker returns.
					sub.accessEpoch++;
					sub.controller?.abort();
					sub.topology = null;
					sub.epoch = crypto.randomUUID();
					if (
						!this.send(sub.ws, {
							type: "communication_error",
							subscriptionId: sub.id,
							code: "resync_required",
						})
					)
						continue;
				}
				this.mark(sub);
			}
	}
}

const subscriptions = hotSafe(
	"narrafork.communicationWs",
	() =>
		new CommunicationSubscriptions(async (scope, principal, options, ws) => {
			// Do not trust the upgrade-time admin shortcut while the general socket-session
			// revalidation is still pending (or failed). This read shares the cancellation budget.
			const { resolveLiveSession } = await import("../lib/auth");
			const session = ws.data.sessionId
				? await resolveLiveSession(ws.data.sessionId, options)
				: null;
			if (!session || session.sub !== principal.userId)
				throw Object.assign(new Error("Communication access denied"), { statusCode: 403 });
			const { getCommunicationTopology } = await import("../services/narrator-communication/index");
			return getCommunicationTopology(
				scope,
				{ userId: session.sub, isAdmin: session.role === "admin" },
				options,
			);
		}),
);
export const handleCommunicationMessage = (
	ws: CommunicationSocket,
	message: CommunicationClientMessage,
) => subscriptions.handle(ws, message);
export const releaseCommunicationSubscriptions = (ws: CommunicationSocket) =>
	subscriptions.release(ws);
export const communicationSubscriptionStats = () => subscriptions.stats();
if (hotOnce("narrafork.communicationWs.listeners")) {
	for (const type of [
		"narrator:communication_changed",
		"team:communication_changed",
		"narrator:imported",
		"narrator:deleted",
		"narrator:forked",
		"narrator:subagent_started",
		"narrator:status_changed",
		"narrator:title_updated",
		"narrator:access_changed",
		"project:access_changed",
		"auth:changed",
		"narrator:execution_principal_changed",
	] as const)
		eventBus.on(type, (event) => subscriptions.onEvent(event));
}
