/**
 * Global singleton WebSocket manager for all narrator-related communication.
 *
 * Every hook that previously created its own `/ws/narrator` connection now goes
 * through this manager instead.  The manager maintains a single WebSocket,
 * reference-counted narrator subscriptions, presence tracking, stats
 * subscription, and fan-out message dispatch to registered listeners.
 *
 * Terminal WebSocket (`/ws/terminal`) is NOT managed here — it keeps its own
 * dedicated connection via `useTerminalWS`.
 */

import type { CatchUpChildAnchor, CatchUpCursor } from "@shared/narrator-catch-up";
import { MAX_CATCH_UP_CHILD_ANCHORS } from "@shared/narrator-catch-up";
import {
	NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
	RECENT_TABS_WS_BATCH_SIZE,
} from "@shared/recent-tabs";
import { getToken } from "./api";
import { buildWsUrl, safeCloseWs } from "./ws";
import { removeWSStatus, setWSStatus } from "./ws-status";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NarratorSubscriptionKind = "list" | "panel" | "messages";

/** Opaque handle returned by `subscribe()` — pass to `unsubscribe()`. */
export interface SubscriptionHandle {
	/** @internal */ _id: number;
	/** @internal */ _narratorIds: string[];
	/** @internal */ _kind: NarratorSubscriptionKind;
}

/** Opaque handle returned by `addListener()` — pass to `removeListener()`. */
export interface ListenerHandle {
	/** @internal */ _id: number;
}

export type MessageCallback = (data: Record<string, unknown>) => void;

export interface ListenerOptions {
	/** Only receive messages whose `narratorId` is in this set.  `"*"` = all. */
	narratorIds?: string[] | "*";
	/** Only receive messages whose `type` matches one of these prefixes. */
	typePrefixes?: string[];
	/** Only receive messages whose `type` exactly matches one of these. */
	types?: string[];
	/** Do not receive messages whose `type` exactly matches one of these. */
	excludeTypes?: readonly string[];
	/** Receive request-scoped snapshot/catch-up frames for this subscription only. */
	subscriptionId?: number;
}

interface SubscriptionRecord {
	id: number;
	narratorIds: string[];
	kind: NarratorSubscriptionKind;
	activeRequestIds: Set<string>;
}

interface RequestMessageVersionSnapshot {
	messageVersionEpochs: Map<string, number>;
}

interface ListenerEntry {
	id: number;
	opts: ListenerOptions;
	cb: MessageCallback;
}

type ConnectionChangeCallback = (connected: boolean, isReconnect: boolean) => void;

type MinimalTreeMessage = {
	id?: unknown;
	narratorId?: unknown;
	parentToolUseId?: unknown;
	toolCalls?: unknown;
	contentJson?: unknown;
};

/**
 * Input accepted from a catch-up or realtime event. A cursor and an authoritative
 * version are kept together by `stageCatchUpState`; unversioned realtime events
 * retain their epoch instead of pretending the cursor belongs to a known version.
 */
export interface StagedCatchUpState {
	cursor?: CatchUpCursor;
	messageVersion?: number;
	realtimeEpoch?: number;
}

/** One cursor coordinate; the version and epoch identify the same snapshot/event. */
interface CatchUpCoordinate {
	cursor?: CatchUpCursor;
	messageVersion?: number;
	realtimeEpoch: number;
	reconcileGeneration: number;
}

interface StagedCatchUpRecord {
	/** A cursor paired with an authoritative server messageVersion. */
	versioned?: CatchUpCoordinate;
	/** A cursor received without an authoritative version; never merged into `versioned`. */
	realtime?: CatchUpCoordinate;
}

/** Snapshot used to reject a manifest response that crossed a coordinate-changing event. */
export interface MessageReconcileToken {
	generation: number;
	structuralEpoch: number;
	/** Realtime epoch at which this reconcile request started. */
	realtimeEpoch?: number;
}

function upsertChildAnchor(cursor: CatchUpCursor, anchor: CatchUpChildAnchor): CatchUpCursor {
	const anchors = new Map<string, CatchUpChildAnchor>();
	for (const item of cursor.childAnchors ?? []) {
		if (!item.parentToolUseId) continue;
		anchors.set(item.parentToolUseId, item);
	}
	const existing = anchors.get(anchor.parentToolUseId);
	anchors.delete(anchor.parentToolUseId);
	anchors.set(anchor.parentToolUseId, {
		parentToolUseId: anchor.parentToolUseId,
		narratorId: anchor.narratorId ?? existing?.narratorId,
		lastMessageId: anchor.lastMessageId ?? existing?.lastMessageId,
	});
	return { ...cursor, childAnchors: [...anchors.values()].slice(-MAX_CATCH_UP_CHILD_ANCHORS) };
}

function normalizeCatchUpCursor(cursor: CatchUpCursor): CatchUpCursor {
	let normalized: CatchUpCursor = { parentLastMessageId: cursor.parentLastMessageId };
	for (const anchor of cursor.childAnchors ?? []) {
		if (anchor.parentToolUseId) normalized = upsertChildAnchor(normalized, anchor);
	}
	return normalized;
}

function extractToolUseIds(message: MinimalTreeMessage): string[] {
	const ids = new Set<string>();
	if (Array.isArray(message.toolCalls)) {
		for (const tc of message.toolCalls) {
			if (tc && typeof tc === "object") {
				const toolUseId = (tc as { toolUseId?: unknown }).toolUseId;
				if (typeof toolUseId === "string") ids.add(toolUseId);
			}
		}
	}
	if (Array.isArray(message.contentJson)) {
		for (const block of message.contentJson) {
			if (block && typeof block === "object") {
				const record = block as { type?: unknown; id?: unknown };
				if (record.type === "tool_use" && typeof record.id === "string") ids.add(record.id);
			}
		}
	}
	return [...ids];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const DISCONNECTED_THRESHOLD = 3;
const CLIENT_PING_TIMEOUT_MS = 60_000;
/**
 * Stop reconnecting after this many consecutive failures.
 * With exponential backoff capped at 30s this is roughly 25 minutes.
 */
const MAX_RECONNECT_ATTEMPTS = 50;
/** Server close code for "the session token that opened this socket expired". */
const SESSION_EXPIRED_CLOSE_CODE = 4001;
const WS_STATUS_ID = "narrator-global";
const MAX_CATCH_UP_CURSORS = 100;
/**
 * How long the tab must be hidden before we force a full reconnect on return.
 *
 * Chosen to sit between the server heartbeat interval (30s) and its timeout
 * (90s, see ws-handler.ts): within this window the connection is almost always
 * still alive, so we prefer a lightweight sync_check over tearing down and
 * rebuilding the shared socket (which re-subscribes every handle and can stampede
 * catch-up queries). Past the threshold a clean reconnect is safer. Staying below
 * the 90s server timeout guarantees a genuinely dead connection is still rebuilt.
 */
const VISIBILITY_RECONNECT_THRESHOLD_MS = 60_000;
const FOREGROUND_RECOVERY_COALESCE_MS = 250;

export function chunkNarratorIds(
	narratorIds: readonly string[],
	batchSize = RECENT_TABS_WS_BATCH_SIZE,
): string[][] {
	if (batchSize <= 0) return [];
	const batches: string[][] = [];
	for (let index = 0; index < narratorIds.length; index += batchSize) {
		batches.push(narratorIds.slice(index, index + batchSize));
	}
	return batches;
}

export function limitNarratorSubscriptionIds(
	currentlySubscribed: ReadonlySet<string>,
	requestedIds: readonly string[],
	maxSubscriptions = NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION,
): { accepted: string[]; dropped: string[] } {
	const accepted: string[] = [];
	const dropped: string[] = [];
	const seen = new Set<string>();
	let uniqueCount = currentlySubscribed.size;
	for (const narratorId of requestedIds) {
		if (seen.has(narratorId)) continue;
		seen.add(narratorId);
		if (currentlySubscribed.has(narratorId)) {
			accepted.push(narratorId);
			continue;
		}
		if (uniqueCount < maxSubscriptions) {
			accepted.push(narratorId);
			uniqueCount++;
		} else {
			dropped.push(narratorId);
		}
	}
	return { accepted, dropped };
}

/** Persisted history events advance the live-event epoch before any listener runs. */
const REALTIME_HISTORY_EVENT_TYPES = new Set([
	"message",
	"user_message",
	"catch_up",
	"messages_deleted",
	"message_updated",
	"tool_started",
	"tool_completed",
	"tool_long_running",
	"timeout_updated",
	"permission_request",
	"permission_resolved",
	"danger_reflection_started",
	"danger_reflection_resolved",
	"danger_reflection_stopped",
	"plan_reflection_started",
	"plan_reflection_resolved",
	"plan_reflection_stopped",
	"task_reflection_started",
	"task_reflection_resolved",
	"task_reflection_stopped",
	"question_reflection_started",
	"question_reflection_resolved",
	"question_reflection_stopped",
	"compact_done",
	"compact_failed",
	"segment_compact_hide",
	"subagent_conclusion_updated",
	"full_reload",
]);

/** Frames whose matching server write advances narrator.messageVersion exactly once. */
const MESSAGE_VERSION_EVENT_TYPES = new Set([
	"message",
	"user_message",
	"tool_completed",
	"messages_deleted",
	"message_updated",
	"subagent_conclusion_updated",
]);

/** Events that can change top-level manifest coordinates, not just live card fields. */
const STRUCTURAL_HISTORY_EVENT_TYPES = new Set([
	"message",
	"user_message",
	"catch_up",
	"messages_deleted",
	"compact_done",
	"compact_failed",
	"segment_compact_hide",
	"full_reload",
]);

export type NarratorForegroundSocketState = "missing" | "connecting" | "open" | "closed";
export type NarratorForegroundRecoveryAction = "none" | "reconnect" | "sync";

export interface NarratorForegroundRecoveryCoalescer {
	schedule(callback: () => void): boolean;
	cancel(): void;
}

export function createNarratorForegroundRecoveryCoalescer(
	delayMs = FOREGROUND_RECOVERY_COALESCE_MS,
): NarratorForegroundRecoveryCoalescer {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		schedule(callback) {
			if (timer !== undefined) return false;
			timer = setTimeout(() => {
				timer = undefined;
				callback();
			}, delayMs);
			return true;
		},
		cancel() {
			clearTimeout(timer);
			timer = undefined;
		},
	};
}

export function decideNarratorForegroundRecovery(opts: {
	hiddenElapsedMs: number;
	socketState: NarratorForegroundSocketState;
	hasPendingReconnect: boolean;
}): NarratorForegroundRecoveryAction {
	if (opts.hiddenElapsedMs >= VISIBILITY_RECONNECT_THRESHOLD_MS) return "reconnect";
	if (opts.socketState === "missing" || opts.socketState === "closed") {
		return opts.hasPendingReconnect ? "none" : "reconnect";
	}
	return opts.socketState === "open" ? "sync" : "none";
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class NarratorWSManager {
	private ws: WebSocket | null = null;
	private _connected = false;
	private _disconnected = false;
	private hasConnectedOnce = false;
	private networkOffline = false;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private pingTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
	private foregroundRecovery = createNarratorForegroundRecoveryCoalescer();
	private cancelled = false;

	// --- Subscription ref-counting ---
	// narratorId → Set of subscription handle IDs
	private narratorRefCounts = new Map<string, Set<number>>();
	private subscriptions = new Map<number, SubscriptionRecord>();
	private requestToSubscription = new Map<string, number>();
	private requestMessageVersionSnapshots = new Map<string, RequestMessageVersionSnapshot>();

	// --- Presence ref-counting ---
	// narratorId → Set of handle IDs that requested presence
	private presenceRefCounts = new Map<string, Set<number>>();

	// --- Stats ---
	private statsRefCount = 0;

	// --- Compound catch-up cursors for top-level + subagent child streams ---
	private catchUpCursors = new Map<string, CatchUpCursor>();
	/** Cursors retained across a last unsubscribe, but not yet proven to match this version lifecycle. */
	private legacyCatchUpCursors = new Set<string>();

	// --- Message version tracking for sync_check ---
	/** Optimistic current version: authoritative baseline plus realtime frames observed locally. */
	private messageVersions = new Map<string, number>();
	/** Last accepted server-authoritative version, used to reject genuinely stale responses. */
	private authoritativeMessageVersions = new Map<string, number>();
	/** Monotonic count of raw frames that optimistically advance messageVersion. */
	private messageVersionEpochs = new Map<string, number>();
	/** Monotonic epoch of persisted realtime events observed by this manager. */
	private realtimeEpochs = new Map<string, number>();
	/** Monotonic epoch of events that can change manifest coordinates. */
	private structuralEpochs = new Map<string, number>();
	/** Generation changes whenever a narrator enters a new reconcile window. */
	private reconcileGenerations = new Map<string, number>();
	/** Narrators whose chunk manifest is being reconciled; suppress stale sync checks. */
	private pendingMessageReconciles = new Set<string>();
	/** Catch-up coordinates received during a structural reconcile, committed atomically on success. */
	private stagedCatchUpStates = new Map<string, StagedCatchUpRecord>();

	// --- Listeners ---
	private nextId = 1;
	private listeners = new Map<number, ListenerEntry>();

	// --- Connection change callbacks ---
	private connectionChangeCallbacks = new Set<ConnectionChangeCallback>();

	// --- Microtask dispatch batching ---
	// Non-latency-sensitive messages are queued and flushed in a single
	// microtask so that multiple WS frames arriving in the same event-loop
	// turn only trigger one round of listener callbacks.
	private pendingDispatchQueue: Record<string, unknown>[] = [];
	private dispatchScheduled = false;

	// -----------------------------------------------------------------------
	// ID allocation (for presence handles etc.)
	// -----------------------------------------------------------------------

	/** Allocate a unique numeric ID (same counter as subscriptions/listeners). */
	allocateId(): number {
		return this.nextId++;
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	connect(): void {
		if (this.ws) return; // already connected / connecting
		this.cancelled = false;
		this._listenVisibility();
		this._listenNetwork();
		this.networkOffline = this._browserReportsOffline();
		this._doConnect();
	}

	disconnect(): void {
		this.cancelled = true;
		this._unlistenVisibility();
		this._unlistenNetwork();
		clearTimeout(this.reconnectTimer);
		clearTimeout(this.pingTimeoutTimer);
		this.foregroundRecovery.cancel();
		this.reconnectTimer = undefined;
		this.pingTimeoutTimer = undefined;
		this.pendingDispatchQueue = [];
		this.dispatchScheduled = false;
		removeWSStatus(WS_STATUS_ID);
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			safeCloseWs(ws, (w) => {
				// Send unsubscribe + presence_leave for everything
				const allIds = [...this.narratorRefCounts.keys()];
				if (allIds.length) {
					for (const id of this.presenceRefCounts.keys()) {
						w.send(JSON.stringify({ type: "presence_leave", narratorId: id }));
					}
					for (const narratorIds of chunkNarratorIds(allIds)) {
						w.send(JSON.stringify({ type: "unsubscribe", narratorIds }));
					}
				}
				if (this.statsRefCount > 0) {
					w.send(JSON.stringify({ type: "unsubscribe_stats" }));
				}
			});
		}
		this._setConnected(false, false);
		this.hasConnectedOnce = false;
		this.networkOffline = false;
	}

	// -----------------------------------------------------------------------
	// Subscriptions (ref-counted)
	// -----------------------------------------------------------------------

	/**
	 * Subscribe to one or more narrator IDs. Returns a handle that MUST be
	 * passed to `unsubscribe()` when the consumer unmounts.
	 *
	 * A single messages subscription may seed its canonical catch-up cursor.
	 */
	subscribe(
		narratorIds: string[],
		opts?: { catchUpCursor?: CatchUpCursor; kind?: NarratorSubscriptionKind },
	): SubscriptionHandle {
		const id = this.nextId++;
		const kind = opts?.kind ?? "list";
		const { accepted, dropped } = limitNarratorSubscriptionIds(
			new Set(this.narratorRefCounts.keys()),
			narratorIds,
		);
		if (dropped.length > 0 && import.meta.env.DEV) {
			console.warn(
				`[NarratorWSManager] Dropped ${dropped.length} ${kind} subscription(s); unique limit is ${NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION}`,
			);
		}
		const handle: SubscriptionHandle = { _id: id, _narratorIds: accepted, _kind: kind };
		this.subscriptions.set(id, {
			id,
			narratorIds: accepted,
			kind,
			activeRequestIds: new Set(),
		});

		for (const nId of accepted) {
			let refs = this.narratorRefCounts.get(nId);
			if (!refs) {
				refs = new Set();
				this.narratorRefCounts.set(nId, refs);
			}
			refs.add(id);
		}

		if (kind === "messages" && opts?.catchUpCursor && accepted.length === 1) {
			this.seedCatchUpCursor(accepted[0], opts.catchUpCursor);
		}

		// Send the request in a microtask so hooks can register their listener in the
		// same effect before request-scoped snapshots/catch-up frames can arrive.
		this._scheduleSubscribe(handle, accepted);

		return handle;
	}

	/**
	 * Release a subscription.  When the last subscriber for a narratorId is
	 * removed, an `unsubscribe` message is sent to the server.
	 */
	unsubscribe(handle: SubscriptionHandle): void {
		const removedIds: string[] = [];
		this._clearRequestsForHandle(handle._id);
		this.subscriptions.delete(handle._id);
		for (const nId of handle._narratorIds) {
			const refs = this.narratorRefCounts.get(nId);
			if (!refs) continue;
			refs.delete(handle._id);
			if (refs.size === 0) {
				this.narratorRefCounts.delete(nId);
				this._clearMessageVersionState(nId);
				if (this.catchUpCursors.has(nId)) this.legacyCatchUpCursors.add(nId);
				this.realtimeEpochs.delete(nId);
				this.structuralEpochs.delete(nId);
				this.reconcileGenerations.delete(nId);
				this.pendingMessageReconciles.delete(nId);
				this.stagedCatchUpStates.delete(nId);
				// Keep the catch-up cursor so that re-subscribe (page navigation back)
				// can still trigger server-side catch-up. The map is bounded by
				// _trimCatchUpState so it never grows unbounded.
				removedIds.push(nId);
			}
		}
		if (removedIds.length && this.ws?.readyState === WebSocket.OPEN) {
			for (const narratorIds of chunkNarratorIds(removedIds)) {
				this.ws.send(JSON.stringify({ type: "unsubscribe", narratorIds }));
			}
		}
	}

	/**
	 * Update the set of narrator IDs for an existing subscription handle.
	 * Sends incremental subscribe/unsubscribe for the diff.
	 */
	updateSubscription(handle: SubscriptionHandle, newNarratorIds: string[]): void {
		const desired = [...new Set(newNarratorIds)];
		const desiredSet = new Set(desired);
		const oldSet = new Set(handle._narratorIds);
		const toRemove = handle._narratorIds.filter((id) => !desiredSet.has(id));

		const actuallyRemoved: string[] = [];
		for (const narratorId of toRemove) {
			const refs = this.narratorRefCounts.get(narratorId);
			if (!refs) continue;
			refs.delete(handle._id);
			if (refs.size === 0) {
				this.narratorRefCounts.delete(narratorId);
				this._clearMessageVersionState(narratorId);
				if (this.catchUpCursors.has(narratorId)) this.legacyCatchUpCursors.add(narratorId);
				this.realtimeEpochs.delete(narratorId);
				this.structuralEpochs.delete(narratorId);
				this.reconcileGenerations.delete(narratorId);
				this.pendingMessageReconciles.delete(narratorId);
				this.stagedCatchUpStates.delete(narratorId);
				actuallyRemoved.push(narratorId);
			}
		}

		const kept = new Set(
			desired.filter((narratorId) => this.narratorRefCounts.get(narratorId)?.has(handle._id)),
		);
		const candidates = desired.filter((narratorId) => !oldSet.has(narratorId));
		const { accepted, dropped } = limitNarratorSubscriptionIds(
			new Set(this.narratorRefCounts.keys()),
			candidates,
		);
		if (dropped.length > 0 && import.meta.env.DEV) {
			console.warn(
				`[NarratorWSManager] Dropped ${dropped.length} ${handle._kind} subscription update(s); unique limit is ${NARRATOR_WS_MAX_SUBSCRIPTIONS_PER_CONNECTION}`,
			);
		}
		for (const narratorId of accepted) {
			let refs = this.narratorRefCounts.get(narratorId);
			if (!refs) {
				refs = new Set();
				this.narratorRefCounts.set(narratorId, refs);
			}
			refs.add(handle._id);
		}

		const acceptedNew = new Set(accepted);
		const acceptedNarratorIds = desired.filter(
			(narratorId) => kept.has(narratorId) || acceptedNew.has(narratorId),
		);
		handle._narratorIds = acceptedNarratorIds;
		const record = this.subscriptions.get(handle._id);
		if (record) record.narratorIds = acceptedNarratorIds;

		if (this.ws?.readyState === WebSocket.OPEN) {
			for (const narratorIds of chunkNarratorIds(actuallyRemoved)) {
				this.ws.send(JSON.stringify({ type: "unsubscribe", narratorIds }));
			}
			if (accepted.length) this._scheduleSubscribe(handle, accepted);
		}
	}

	// -----------------------------------------------------------------------
	// Presence (ref-counted)
	// -----------------------------------------------------------------------

	joinPresence(narratorId: string, handleId: number): void {
		let refs = this.presenceRefCounts.get(narratorId);
		if (!refs) {
			refs = new Set();
			this.presenceRefCounts.set(narratorId, refs);
			// First joiner — send to server
			if (this.ws?.readyState === WebSocket.OPEN) {
				this.ws.send(JSON.stringify({ type: "presence_join", narratorId }));
			}
		}
		refs.add(handleId);
	}

	leavePresence(narratorId: string, handleId: number): void {
		const refs = this.presenceRefCounts.get(narratorId);
		if (!refs) return;
		refs.delete(handleId);
		if (refs.size === 0) {
			this.presenceRefCounts.delete(narratorId);
			if (this.ws?.readyState === WebSocket.OPEN) {
				this.ws.send(JSON.stringify({ type: "presence_leave", narratorId }));
			}
		}
	}

	// -----------------------------------------------------------------------
	// Stats (ref-counted)
	// -----------------------------------------------------------------------

	subscribeStats(): void {
		this.statsRefCount++;
		if (this.statsRefCount === 1 && this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: "subscribe_stats" }));
		}
	}

	unsubscribeStats(): void {
		this.statsRefCount = Math.max(0, this.statsRefCount - 1);
		if (this.statsRefCount === 0 && this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: "unsubscribe_stats" }));
		}
	}

	// -----------------------------------------------------------------------
	// Listeners
	// -----------------------------------------------------------------------

	addListener(opts: ListenerOptions, cb: MessageCallback): ListenerHandle {
		const id = this.nextId++;
		this.listeners.set(id, { id, opts, cb });
		return { _id: id };
	}

	removeListener(handle: ListenerHandle): void {
		this.listeners.delete(handle._id);
	}

	// -----------------------------------------------------------------------
	// Send arbitrary client message
	// -----------------------------------------------------------------------

	send(message: Record<string, unknown>): boolean {
		if (this.ws?.readyState !== WebSocket.OPEN) return false;
		this.ws.send(JSON.stringify(message));
		return true;
	}

	// -----------------------------------------------------------------------
	// Local (synthetic) frame injection — DEV/mock only
	// -----------------------------------------------------------------------

	/**
	 * Fan a synthetic frame out to listeners as if the server had sent it.
	 *
	 * Used ONLY by the temporary mock-stream panel
	 * (`components/narrator/mock/`), which replays scripted streaming output so
	 * the virtual list's measurement/animation work can be tuned without asking a
	 * real model for a turn.
	 *
	 * ⚠️ DELIBERATELY skips every piece of sync bookkeeping that
	 * `_dispatchImmediate` performs (`noteRealtimeEvent`, `bumpMessageVersion`,
	 * `noteStructuralEvent`). Mock content is never persisted, so counting it
	 * would leave the client's `messageVersion` ahead of the server's; the next
	 * `sync_check` would then answer with a `catch_up` or `full_reload` and
	 * disturb the REAL document. Mock frames are purely visual and disappear on
	 * reload.
	 *
	 * Delivery uses the same listener filter as real frames, so a mock frame
	 * reaches exactly the consumers a real one would.
	 */
	dispatchLocalFrame(data: Record<string, unknown>): void {
		const msgType = typeof data.type === "string" ? data.type : undefined;
		const narratorId = typeof data.narratorId === "string" ? data.narratorId : undefined;
		for (const entry of this.listeners.values()) {
			// No `subscriptionRequestId`: a synthetic frame is always a realtime
			// frame, never a response to a snapshot/catch-up request.
			if (!shouldDeliverToListener(entry.opts, msgType, narratorId, undefined, undefined)) {
				continue;
			}
			try {
				entry.cb(data);
			} catch {
				// listener error — ignore
			}
		}
	}

	// -----------------------------------------------------------------------
	// Last message ID tracking (for catch-up on reconnect)
	// -----------------------------------------------------------------------

	updateLastMessageId(narratorId: string, messageId: string): void {
		this.updateCatchUpCursor(narratorId, { parentLastMessageId: messageId });
	}

	/** Seed an initial REST-derived cursor without replacing live state from this lifecycle. */
	seedCatchUpCursor(narratorId: string, cursor: CatchUpCursor | undefined): boolean {
		if (!cursor) return false;
		const staged = this.stagedCatchUpStates.get(narratorId);
		if (staged?.realtime?.cursor || staged?.versioned?.cursor) return false;
		if (this.catchUpCursors.has(narratorId) && !this.legacyCatchUpCursors.has(narratorId)) {
			return false;
		}
		this._commitCatchUpCursor(narratorId, cursor);
		return true;
	}

	updateCatchUpCursor(narratorId: string, cursor: CatchUpCursor | undefined): void {
		if (!cursor) return;
		if (this.pendingMessageReconciles.has(narratorId)) {
			this.stageCatchUpState(narratorId, { cursor });
			return;
		}
		this._commitCatchUpCursor(narratorId, cursor);
	}

	/** Publish a catch-up cursor and version together when no structural gate is open. */
	updateCatchUpCoordinate(narratorId: string, incoming: StagedCatchUpState): void {
		if (this.pendingMessageReconciles.has(narratorId)) {
			this.stageCatchUpState(narratorId, incoming);
			return;
		}
		const cursor = incoming.cursor;
		if (
			incoming.messageVersion != null &&
			!this._commitAuthoritativeMessageVersion(narratorId, incoming.messageVersion)
		)
			return;
		if (cursor) this._commitCatchUpCursor(narratorId, cursor);
	}

	/** Stage the latest structural catch-up coordinates until manifest reconciliation succeeds. */
	stageCatchUpState(narratorId: string, incoming: StagedCatchUpState): void {
		if (
			incoming.messageVersion != null &&
			this._isStaleAuthoritativeVersion(narratorId, incoming.messageVersion)
		) {
			return;
		}
		if (!this.pendingMessageReconciles.has(narratorId)) {
			this.reconcileGenerations.set(
				narratorId,
				(this.reconcileGenerations.get(narratorId) ?? 0) + 1,
			);
			this.pendingMessageReconciles.add(narratorId);
		}

		const cursor = incoming.cursor ? normalizeCatchUpCursor(incoming.cursor) : undefined;
		if (!cursor && incoming.messageVersion == null) return;

		const coordinate: CatchUpCoordinate = {
			...(cursor ? { cursor } : {}),
			...(incoming.messageVersion != null ? { messageVersion: incoming.messageVersion } : {}),
			realtimeEpoch: incoming.realtimeEpoch ?? this.getRealtimeEpoch(narratorId),
			reconcileGeneration: this.reconcileGenerations.get(narratorId) ?? 0,
		};
		const record = this.stagedCatchUpStates.get(narratorId) ?? {};

		if (coordinate.messageVersion != null) {
			const previous = record.versioned;
			const previousVersion = previous?.messageVersion ?? Number.NEGATIVE_INFINITY;
			const isNewer =
				!previous ||
				coordinate.messageVersion > previousVersion ||
				(coordinate.messageVersion === previousVersion &&
					coordinate.realtimeEpoch >= previous.realtimeEpoch);
			if (isNewer) {
				// `sync_ok` is intentionally version-only. Keep the cursor from the
				// last versioned snapshot (including subagent childAnchors) instead of
				// replacing it with an empty coordinate and making the next sync fall
				// back to a full reload. An incoming cursor remains authoritative when
				// present; only the absent-cursor case inherits the previous anchor.
				const inheritedCursor = coordinate.cursor ?? previous?.cursor;
				record.versioned = {
					...previous,
					...coordinate,
					...(inheritedCursor ? { cursor: inheritedCursor } : {}),
				};
			}

			// A versioned catch-up carrying a newer cursor supersedes an older, unversioned
			// echo. Do not clear a newer realtime coordinate: it still needs the next
			// authoritative snapshot.
			if (
				record.realtime &&
				coordinate.cursor &&
				coordinate.messageVersion > (previous?.messageVersion ?? Number.NEGATIVE_INFINITY) &&
				coordinate.realtimeEpoch >= record.realtime.realtimeEpoch
			) {
				record.realtime = undefined;
			}
		} else {
			// A realtime cursor has no server version. Keep it in a separate coordinate so
			// it can never overwrite a versioned cursor while this reconcile is open.
			const previous = record.realtime;
			if (!previous || coordinate.realtimeEpoch >= previous.realtimeEpoch) {
				record.realtime = {
					...coordinate,
					cursor: coordinate.cursor ?? previous?.cursor,
				};
			}
		}

		this.stagedCatchUpStates.set(narratorId, record);
		this._trimCatchUpState();
	}

	/** Check whether a manifest response is still eligible to publish its coordinates. */
	canCommitMessageReconcile(
		narratorId: string,
		authoritativeVersion: number,
		token?: MessageReconcileToken,
	): boolean {
		if (!this.pendingMessageReconciles.has(narratorId)) return false;
		if (token && !this.isMessageReconcileTokenCurrent(narratorId, token)) return false;
		const staged = this.stagedCatchUpStates.get(narratorId);
		const committedVersion = this.authoritativeMessageVersions.get(narratorId);
		if (committedVersion != null && authoritativeVersion < committedVersion) return false;
		const versioned = staged?.versioned;
		if (versioned?.messageVersion != null && versioned.messageVersion > authoritativeVersion)
			return false;

		const realtime = staged?.realtime;
		if (!realtime) return true;
		const requestEpoch = token?.realtimeEpoch ?? this.getRealtimeEpoch(narratorId);
		const currentGeneration = this.reconcileGenerations.get(narratorId) ?? 0;
		if (realtime.reconcileGeneration >= currentGeneration) return false;
		if (realtime.realtimeEpoch > requestEpoch) return false;
		// If the authoritative snapshot has not advanced past the versioned coordinate,
		// an unversioned cursor cannot be attached to it. The next reconcile must fetch
		// the snapshot that includes that realtime event.
		if (
			versioned?.messageVersion != null &&
			versioned.messageVersion >= authoritativeVersion &&
			realtime.realtimeEpoch > versioned.realtimeEpoch
		)
			return false;
		if (!versioned && committedVersion != null && authoritativeVersion <= committedVersion)
			return false;
		return true;
	}

	/** Atomically publish staged coordinates and the manifest's authoritative version. */
	commitMessageReconcile(
		narratorId: string,
		authoritativeVersion: number,
		token?: MessageReconcileToken,
		fallbackCursor?: CatchUpCursor,
	): boolean {
		if (!this.canCommitMessageReconcile(narratorId, authoritativeVersion, token)) return false;
		const staged = this.stagedCatchUpStates.get(narratorId);
		const versioned = staged?.versioned;
		const realtime = staged?.realtime;
		const requestEpoch = token?.realtimeEpoch ?? this.getRealtimeEpoch(narratorId);
		let coordinate = versioned;

		// Once a subsequent reconcile starts after the realtime event, its authoritative
		// manifest version can safely pair with that separately staged cursor.
		if (
			realtime &&
			realtime.reconcileGeneration < (this.reconcileGenerations.get(narratorId) ?? 0) &&
			realtime.realtimeEpoch <= requestEpoch &&
			(!versioned?.cursor ||
				(versioned.messageVersion ?? Number.NEGATIVE_INFINITY) < authoritativeVersion) &&
			(!versioned || realtime.realtimeEpoch >= versioned.realtimeEpoch)
		) {
			coordinate = { ...realtime, messageVersion: authoritativeVersion };
		}

		const committedCursor = this.catchUpCursors.get(narratorId);
		const cursor =
			coordinate?.cursor ??
			(this.legacyCatchUpCursors.has(narratorId)
				? fallbackCursor
				: (committedCursor ?? fallbackCursor));
		if (!this._commitAuthoritativeMessageVersion(narratorId, authoritativeVersion)) return false;
		if (cursor) {
			this._commitCatchUpCursor(narratorId, cursor);
		} else if (this.legacyCatchUpCursors.delete(narratorId)) {
			// An authoritative empty snapshot must not retain an anchor from the
			// previous subscription lifecycle beside its new version.
			this.catchUpCursors.delete(narratorId);
		}
		this.stagedCatchUpStates.delete(narratorId);
		this.pendingMessageReconciles.delete(narratorId);
		return true;
	}

	/** Drop only committed sync anchors before falling back to a full manifest reload. */
	clearCommittedCatchUpAnchor(narratorId: string): void {
		this.catchUpCursors.delete(narratorId);
		this.legacyCatchUpCursors.delete(narratorId);
		this._clearMessageVersionState(narratorId);
	}

	private _clearMessageVersionState(narratorId: string): void {
		this.messageVersions.delete(narratorId);
		this.authoritativeMessageVersions.delete(narratorId);
		this.messageVersionEpochs.delete(narratorId);
	}

	clearCatchUpState(narratorId: string): void {
		this.clearCommittedCatchUpAnchor(narratorId);
		this.stagedCatchUpStates.delete(narratorId);
		this.pendingMessageReconciles.delete(narratorId);
		this.reconcileGenerations.set(narratorId, (this.reconcileGenerations.get(narratorId) ?? 0) + 1);
	}

	private _commitCatchUpCursor(narratorId: string, cursor: CatchUpCursor): void {
		const normalized = normalizeCatchUpCursor(cursor);
		this.catchUpCursors.delete(narratorId);
		this.catchUpCursors.set(narratorId, normalized);
		this.legacyCatchUpCursors.delete(narratorId);
		this._trimCatchUpState();
	}

	private _trimCatchUpState(): void {
		while (this.catchUpCursors.size > MAX_CATCH_UP_CURSORS) {
			const oldest = this.catchUpCursors.keys().next().value;
			if (oldest === undefined) break;
			this.catchUpCursors.delete(oldest);
			this.legacyCatchUpCursors.delete(oldest);
		}
		while (this.stagedCatchUpStates.size > MAX_CATCH_UP_CURSORS) {
			const oldest = this.stagedCatchUpStates.keys().next().value;
			if (oldest === undefined) break;
			this.stagedCatchUpStates.delete(oldest);
			this.pendingMessageReconciles.delete(oldest);
		}
	}

	private _clearRequestsForHandle(handleId: number): void {
		const record = this.subscriptions.get(handleId);
		for (const requestId of record?.activeRequestIds ?? []) {
			this.requestToSubscription.delete(requestId);
			this.requestMessageVersionSnapshots.delete(requestId);
		}
		record?.activeRequestIds.clear();
	}

	private _registerRequest(handle: SubscriptionHandle): string | undefined {
		if (handle._kind === "list") return undefined;
		const record = this.subscriptions.get(handle._id);
		if (!record) return undefined;
		this._clearRequestsForHandle(handle._id);
		const requestId = `${handle._kind}-${handle._id}-${Date.now()}-${this.nextId++}`;
		record.activeRequestIds.add(requestId);
		this.requestToSubscription.set(requestId, handle._id);
		this.requestMessageVersionSnapshots.set(requestId, {
			messageVersionEpochs: new Map(
				record.narratorIds.map((narratorId) => [
					narratorId,
					this.messageVersionEpochs.get(narratorId) ?? 0,
				]),
			),
		});
		return requestId;
	}

	noteMessage(narratorId: string, message: MinimalTreeMessage | undefined): void {
		if (!message || typeof message.id !== "string") return;
		const staged = this.stagedCatchUpStates.get(narratorId);
		let cursor =
			staged?.realtime?.cursor ??
			staged?.versioned?.cursor ??
			this.catchUpCursors.get(narratorId) ??
			{};
		if (typeof message.parentToolUseId === "string" && message.parentToolUseId) {
			cursor = upsertChildAnchor(cursor, {
				parentToolUseId: message.parentToolUseId,
				narratorId: typeof message.narratorId === "string" ? message.narratorId : undefined,
				lastMessageId: message.id,
			});
		} else {
			cursor = { ...cursor, parentLastMessageId: message.id };
			for (const toolUseId of extractToolUseIds(message)) {
				cursor = upsertChildAnchor(cursor, { parentToolUseId: toolUseId });
			}
		}
		this.updateCatchUpCursor(narratorId, cursor);
	}

	/** Keep a bounded activity-only anchor for a loaded parent SubagentCard. */
	noteSubagentActivityAnchor(
		narratorId: string,
		parentToolUseId: string,
		subagentNarratorId?: string,
	): void {
		if (!parentToolUseId) return;
		const staged = this.stagedCatchUpStates.get(narratorId);
		const cursor =
			staged?.realtime?.cursor ??
			staged?.versioned?.cursor ??
			this.catchUpCursors.get(narratorId) ??
			{};
		this.updateCatchUpCursor(
			narratorId,
			upsertChildAnchor(cursor, {
				parentToolUseId,
				narratorId: subagentNarratorId,
			}),
		);
	}

	// -----------------------------------------------------------------------
	// Message version tracking (for sync_check)
	// -----------------------------------------------------------------------

	/** Record one persisted realtime event before its consumer runs. */
	noteRealtimeEvent(narratorId: string): number {
		const epoch = (this.realtimeEpochs.get(narratorId) ?? 0) + 1;
		this.realtimeEpochs.set(narratorId, epoch);
		return epoch;
	}

	getRealtimeEpoch(narratorId: string): number {
		return this.realtimeEpochs.get(narratorId) ?? 0;
	}

	/** Record one event that can invalidate manifest coordinates. */
	noteStructuralEvent(narratorId: string): number {
		const epoch = (this.structuralEpochs.get(narratorId) ?? 0) + 1;
		this.structuralEpochs.set(narratorId, epoch);
		return epoch;
	}

	getStructuralEpoch(narratorId: string): number {
		return this.structuralEpochs.get(narratorId) ?? 0;
	}

	getMessageVersion(narratorId: string): number | undefined {
		return this.messageVersions.get(narratorId);
	}

	updateMessageVersion(
		narratorId: string,
		version: number,
		options?: { requestId?: string; preserveOptimisticCurrent?: boolean },
	): void {
		if (this._isStaleAuthoritativeVersion(narratorId, version)) return;
		const requestEpoch = options?.requestId
			? this.requestMessageVersionSnapshots
					.get(options.requestId)
					?.messageVersionEpochs.get(narratorId)
			: undefined;
		const crossedPersistedFrame =
			requestEpoch != null && (this.messageVersionEpochs.get(narratorId) ?? 0) > requestEpoch;
		const preserveOptimisticCurrent =
			options?.preserveOptimisticCurrent === true || crossedPersistedFrame;
		if (this.pendingMessageReconciles.has(narratorId) && !preserveOptimisticCurrent) {
			this.stageCatchUpState(narratorId, { messageVersion: version });
			return;
		}
		this._commitAuthoritativeMessageVersion(narratorId, version, {
			preserveOptimisticCurrent,
		});
	}

	private _isStaleAuthoritativeVersion(narratorId: string, version: number): boolean {
		const authoritative = this.authoritativeMessageVersions.get(narratorId);
		return authoritative != null && version < authoritative;
	}

	private _commitAuthoritativeMessageVersion(
		narratorId: string,
		version: number,
		options?: { preserveOptimisticCurrent?: boolean },
	): boolean {
		if (this._isStaleAuthoritativeVersion(narratorId, version)) return false;
		this.authoritativeMessageVersions.set(narratorId, version);
		const current = this.messageVersions.get(narratorId);
		// A request response that crossed a newer persisted frame is still useful as
		// an authoritative floor, but must not erase the optimistic frame already seen.
		if (!options?.preserveOptimisticCurrent || current == null || version >= current) {
			this.messageVersions.set(narratorId, version);
		}
		return true;
	}

	markMessageReconcilePending(
		narratorId: string,
		options?: { restart?: boolean },
	): MessageReconcileToken {
		// Preserve idempotent marking for callers that only need the gate. A request
		// restart explicitly advances the generation so staged realtime coordinates
		// participate in the next snapshot instead of the current one.
		if (!this.pendingMessageReconciles.has(narratorId) || options?.restart) {
			this.reconcileGenerations.set(
				narratorId,
				(this.reconcileGenerations.get(narratorId) ?? 0) + 1,
			);
		}
		this.pendingMessageReconciles.add(narratorId);
		return this.getMessageReconcileToken(narratorId);
	}

	getMessageReconcileToken(narratorId: string): MessageReconcileToken {
		return {
			generation: this.reconcileGenerations.get(narratorId) ?? 0,
			structuralEpoch: this.getStructuralEpoch(narratorId),
			realtimeEpoch: this.getRealtimeEpoch(narratorId),
		};
	}

	isMessageReconcileTokenCurrent(narratorId: string, token: MessageReconcileToken): boolean {
		if (!this.pendingMessageReconciles.has(narratorId)) return false;
		const current = this.getMessageReconcileToken(narratorId);
		return (
			current.generation === token.generation && current.structuralEpoch === token.structuralEpoch
		);
	}

	clearMessageReconcilePending(narratorId: string): void {
		this.pendingMessageReconciles.delete(narratorId);
		this.stagedCatchUpStates.delete(narratorId);
		this.reconcileGenerations.set(narratorId, (this.reconcileGenerations.get(narratorId) ?? 0) + 1);
	}

	isMessageReconcilePending(narratorId: string): boolean {
		return this.pendingMessageReconciles.has(narratorId);
	}

	/**
	 * Optimistically increment the current version for one raw persisted-history frame.
	 *
	 * This runs once in the manager before listener fan-out. The counter remains only a
	 * best-effort sync hint; accepted server-authoritative responses may correct it in either
	 * direction, while the separate authoritative baseline rejects genuinely older responses.
	 */
	bumpMessageVersion(narratorId: string): void {
		const current = this.messageVersions.get(narratorId) ?? 0;
		this.messageVersions.set(narratorId, current + 1);
		this.messageVersionEpochs.set(narratorId, (this.messageVersionEpochs.get(narratorId) ?? 0) + 1);
	}

	/**
	 * Send a lightweight sync_check for a single narrator.
	 * The server compares the version and replies with sync_ok (in sync),
	 * catch_up (incremental), or full_reload (too far behind / deleted).
	 */
	checkSync(narratorId: string): void {
		if (this.pendingMessageReconciles.has(narratorId)) return;
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		const handle = [...this.subscriptions.values()].find(
			(record) => record.kind === "messages" && record.narratorIds.includes(narratorId),
		);
		if (!handle) return;
		const version = this.messageVersions.get(narratorId) ?? 0;
		const cursor = this.catchUpCursors.get(narratorId);
		const requestId = this._registerRequest({
			_id: handle.id,
			_narratorIds: handle.narratorIds,
			_kind: handle.kind,
		});
		const msg: Record<string, unknown> = {
			type: "sync_check",
			narratorId,
			version,
			kind: "messages",
			...(requestId ? { requestId } : {}),
		};
		if (cursor) msg.catchUpCursor = cursor;
		this.ws.send(JSON.stringify(msg));
	}

	/**
	 * Send sync_check for all currently subscribed narrators.
	 * Called on window focus to detect any missed messages.
	 */
	checkAllSubscribedSync(): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		const ids = new Set<string>();
		for (const record of this.subscriptions.values()) {
			if (record.kind !== "messages") continue;
			for (const narratorId of record.narratorIds) ids.add(narratorId);
		}
		for (const narratorId of ids) {
			this.checkSync(narratorId);
		}
	}

	// -----------------------------------------------------------------------
	// Connection state
	// -----------------------------------------------------------------------

	get connected(): boolean {
		return this._connected;
	}

	get disconnected(): boolean {
		return this._disconnected;
	}

	onConnectionChange(cb: ConnectionChangeCallback): () => void {
		this.connectionChangeCallbacks.add(cb);
		return () => this.connectionChangeCallbacks.delete(cb);
	}

	/** Force a reconnect (e.g. from the UI reconnect button). */
	reconnect(): void {
		clearTimeout(this.reconnectTimer);
		clearTimeout(this.pingTimeoutTimer);
		this.foregroundRecovery.cancel();
		this.reconnectTimer = undefined;
		this.pingTimeoutTimer = undefined;
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			safeCloseWs(ws);
		}
		// Notify listeners that we're disconnected so reconnect-aware effects
		// (e.g. getPendingPermissions, invalidateQueries) fire when the new
		// connection opens.  Without this, _connected stays true and the
		// onopen _setConnected(true) is a no-op (no change → no notification).
		if (this._connected) {
			this._setConnected(false, false);
		}
		this.reconnectAttempts = 0;
		// A manual/foreground reconnect should recover even if an earlier offline
		// event was observed but its matching online event was missed.
		this.networkOffline = this._browserReportsOffline();
		this._doConnect();
	}

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	private _doConnect(): void {
		if (this.cancelled) return;
		this.reconnectTimer = undefined;
		if (this._isNetworkOffline()) {
			this.networkOffline = true;
			this._setConnected(false, false, true);
			return;
		}

		const token = getToken();
		if (!token) {
			// No token yet — retry after a short delay
			this.reconnectTimer = setTimeout(() => {
				this.reconnectTimer = undefined;
				this._doConnect();
			}, 1000);
			return;
		}

		const tokenQuery = `token=${encodeURIComponent(token)}`;
		const ws = new WebSocket(buildWsUrl("/ws/narrator", tokenQuery));
		this.ws = ws;

		ws.onopen = () => {
			if (this.cancelled || this.ws !== ws) {
				ws.close();
				return;
			}
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
			const isReconnect = this.hasConnectedOnce || this.reconnectAttempts > 0;
			this.hasConnectedOnce = true;
			this.reconnectAttempts = 0;
			this._setConnected(true, isReconnect);
			this._resetPingTimeout();
			this._restoreSubscriptions();
		};

		ws.onmessage = (event) => {
			if (this.cancelled || this.ws !== ws) return;
			try {
				const data = JSON.parse(event.data);
				if (data.type === "ping") {
					ws.send(JSON.stringify({ type: "pong" }));
					this._resetPingTimeout();
					return;
				}
				// Global events that aren't narrator-scoped — dispatch as DOM events
				if (data.type === "summary_model_unavailable") {
					window.dispatchEvent(
						new CustomEvent("narrafork:summary-model-unavailable", {
							detail: { model: data.model, error: data.error },
						}),
					);
					return;
				}
				if (data.type === "summary_model_error") {
					window.dispatchEvent(
						new CustomEvent("narrafork:summary-model-error", {
							detail: { model: data.model, error: data.error },
						}),
					);
					return;
				}
				// Startup recovery found narrators pinned to an unusable model. Only the
				// summary travels over WS; the full list is fetched on demand.
				if (data.type === "broken_model_narrators_detected") {
					window.dispatchEvent(
						new CustomEvent("narrafork:broken-model-narrators", {
							detail: {
								totalBroken: data.totalBroken,
								totalSuspect: data.totalSuspect,
								providerPrefixes: data.providerPrefixes,
								truncated: data.truncated,
							},
						}),
					);
					return;
				}
				if (data.type === "provider_baseurl_fix_suggested") {
					window.dispatchEvent(
						new CustomEvent("narrafork:provider-baseurl-fix", {
							detail: {
								providerId: data.providerId,
								providerPrefix: data.providerPrefix,
								providerName: data.providerName,
								currentBaseUrl: data.currentBaseUrl,
								suggestedBaseUrl: data.suggestedBaseUrl,
							},
						}),
					);
					return;
				}
				// The shared NUG availability poller refreshed a provider's model list
				// (a suspended narrator is waiting for recovery). Signal model pickers
				// to re-fetch so the available/unavailable state updates live.
				if (data.type === "nug_model_availability_changed") {
					window.dispatchEvent(
						new CustomEvent("narrafork:nug-model-availability-changed", {
							detail: { providerId: data.providerId },
						}),
					);
					return;
				}
				this._dispatch(data);
			} catch {
				if (import.meta.env.DEV) {
					console.warn("[NarratorWSManager] Failed to parse WS message");
				}
			}
		};

		ws.onclose = (ev) => {
			if (this.cancelled || this.ws !== ws) return;
			this.ws = null;
			clearTimeout(this.pingTimeoutTimer);
			this.pingTimeoutTimer = undefined;
			// 1001 = Going Away — server is shutting down, don't reconnect.
			this._setConnected(false, false, ev.code === 1001 ? true : this._disconnected);
			if (ev.code === 1001) return;
			// 4001 = the session token this socket was opened with expired. HTTP
			// sliding renewal has very likely already stored a fresh one, so retry
			// immediately with whatever is in localStorage instead of backing off.
			if (ev.code === SESSION_EXPIRED_CLOSE_CODE) {
				this.reconnectAttempts = 0;
			}
			this._scheduleReconnect();
		};

		ws.onerror = () => {
			// onclose will fire after this
		};
	}

	private _scheduleReconnect(): void {
		if (this.cancelled) return;
		if (this._isNetworkOffline()) {
			this.networkOffline = true;
			this._setConnected(false, false, true);
			return;
		}
		if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			// Give up — server is likely down for good.
			this._setConnected(false, false, true);
			return;
		}
		if (this.reconnectAttempts >= DISCONNECTED_THRESHOLD && !this._disconnected) {
			this._setConnected(false, false, true);
		}
		const delay = Math.min(
			RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
			RECONNECT_MAX_DELAY_MS,
		);
		this.reconnectAttempts++;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this._doConnect();
		}, delay);
	}

	private _resetPingTimeout(): void {
		clearTimeout(this.pingTimeoutTimer);
		this.pingTimeoutTimer = setTimeout(() => {
			if (!this.cancelled && this.ws?.readyState === WebSocket.OPEN) {
				this.ws.close(4000, "ping timeout");
			}
		}, CLIENT_PING_TIMEOUT_MS);
	}

	private _setConnected(
		connected: boolean,
		isReconnect: boolean,
		disconnected = connected ? false : this._disconnected,
	): void {
		const changed = this._connected !== connected || this._disconnected !== disconnected;
		this._connected = connected;
		this._disconnected = disconnected;
		this._syncGlobalStatus();
		if (changed) {
			for (const cb of this.connectionChangeCallbacks) {
				try {
					cb(connected, isReconnect);
				} catch {
					// listener error — ignore
				}
			}
		}
	}

	private _syncGlobalStatus(): void {
		if (this.cancelled) {
			removeWSStatus(WS_STATUS_ID);
			return;
		}
		setWSStatus(WS_STATUS_ID, {
			label: "Narrator",
			connected: this._connected || !this._disconnected,
			reconnect: () => this.reconnect(),
		});
	}

	/**
	 * After (re)connect, re-send all active subscriptions, presence joins,
	 * and stats subscription.
	 */
	private _restoreSubscriptions(): void {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;

		// Restore every handle, not just every narrator. Request-scoped snapshots
		// (panel runtime / message catch-up) must be delivered to the consumer that
		// asked for them, and multiple panels may watch the same narrator.
		for (const record of this.subscriptions.values()) {
			if (record.narratorIds.length === 0) continue;
			this._scheduleSubscribe(
				{ _id: record.id, _narratorIds: record.narratorIds, _kind: record.kind },
				record.narratorIds,
			);
		}

		// Presence
		for (const narratorId of this.presenceRefCounts.keys()) {
			ws.send(JSON.stringify({ type: "presence_join", narratorId }));
		}

		// Stats
		if (this.statsRefCount > 0) {
			ws.send(JSON.stringify({ type: "subscribe_stats" }));
		}
	}

	// -----------------------------------------------------------------------
	// Browser network changes — recover half-open sockets immediately
	// -----------------------------------------------------------------------

	private _boundOnlineHandler: (() => void) | null = null;
	private _boundOfflineHandler: (() => void) | null = null;

	private _browserReportsOffline(): boolean {
		return typeof navigator !== "undefined" && navigator.onLine === false;
	}

	private _isNetworkOffline(): boolean {
		return this.networkOffline || this._browserReportsOffline();
	}

	private _listenNetwork(): void {
		if (this._boundOnlineHandler || this._boundOfflineHandler) return;
		this._boundOnlineHandler = () => this._handleNetworkOnline();
		this._boundOfflineHandler = () => this._handleNetworkOffline();
		window.addEventListener("online", this._boundOnlineHandler);
		window.addEventListener("offline", this._boundOfflineHandler);
	}

	private _unlistenNetwork(): void {
		if (this._boundOnlineHandler) {
			window.removeEventListener("online", this._boundOnlineHandler);
			this._boundOnlineHandler = null;
		}
		if (this._boundOfflineHandler) {
			window.removeEventListener("offline", this._boundOfflineHandler);
			this._boundOfflineHandler = null;
		}
	}

	private _handleNetworkOffline(): void {
		if (this.cancelled) return;
		this.networkOffline = true;
		clearTimeout(this.reconnectTimer);
		clearTimeout(this.pingTimeoutTimer);
		this.foregroundRecovery.cancel();
		this.reconnectTimer = undefined;
		this.pingTimeoutTimer = undefined;

		// Browsers may keep readyState=OPEN after the physical network disappears.
		// Detach that half-open socket now so no sync or permission messages are sent to it.
		const ws = this.ws;
		this.ws = null;
		safeCloseWs(ws);
		this._setConnected(false, false, true);
	}

	private _handleNetworkOnline(): void {
		if (this.cancelled) return;
		this.networkOffline = false;
		// Never trust the old readyState after a network transition. A clean socket
		// guarantees _restoreSubscriptions() runs and catch-up snapshots are requested.
		this.reconnect();
	}

	// -----------------------------------------------------------------------
	// Visibility change — recover from browser background throttling
	// -----------------------------------------------------------------------

	private _boundVisibilityHandler: (() => void) | null = null;
	private _hiddenAt = 0;

	private _listenVisibility(): void {
		if (this._boundVisibilityHandler) return;
		this._boundVisibilityHandler = () => this._handleVisibilityChange();
		document.addEventListener("visibilitychange", this._boundVisibilityHandler);
		window.addEventListener("focus", this._boundVisibilityHandler);
		window.addEventListener("pageshow", this._boundVisibilityHandler);
	}

	private _unlistenVisibility(): void {
		this.foregroundRecovery.cancel();
		if (this._boundVisibilityHandler) {
			document.removeEventListener("visibilitychange", this._boundVisibilityHandler);
			window.removeEventListener("focus", this._boundVisibilityHandler);
			window.removeEventListener("pageshow", this._boundVisibilityHandler);
			this._boundVisibilityHandler = null;
		}
	}

	/**
	 * When the tab returns to the foreground after being hidden for a while,
	 * browsers may have throttled timers and frozen the WS data flow.
	 *
	 * We track how long the tab was hidden.  If it exceeds the threshold
	 * (one server heartbeat interval), we force a full reconnect so that
	 * `_restoreSubscriptions` runs cleanly on a fresh connection — this
	 * avoids duplicate streaming snapshots or catch-up races on a stale
	 * connection that may have silently lost messages.
	 *
	 * Short tab switches (< threshold) trigger a lightweight sync_check
	 * for all subscribed narrators — this detects missed messages without
	 * the overhead of a full reconnect.
	 */
	private _handleVisibilityChange(): void {
		if (this.cancelled) return;

		if (document.visibilityState === "hidden") {
			if (!this._hiddenAt) this._hiddenAt = Date.now();
			this.foregroundRecovery.cancel();
			return;
		}

		// `visibilitychange`, `focus`, and `pageshow` commonly fire together when a
		// frozen tab resumes. Coalesce them so one foreground transition performs at
		// most one reconnect/sync cycle.
		this.foregroundRecovery.schedule(() => {
			if (this.cancelled || document.visibilityState !== "visible") return;
			this._recoverForeground();
		});
	}

	private _recoverForeground(): void {
		const elapsed = this._hiddenAt ? Date.now() - this._hiddenAt : 0;
		this._hiddenAt = 0;
		const socketState: NarratorForegroundSocketState = !this.ws
			? "missing"
			: this.ws.readyState === WebSocket.OPEN
				? "open"
				: this.ws.readyState === WebSocket.CONNECTING
					? "connecting"
					: "closed";
		const action = decideNarratorForegroundRecovery({
			hiddenElapsedMs: elapsed,
			socketState,
			hasPendingReconnect: this.reconnectTimer !== undefined,
		});

		if (action === "reconnect") {
			this.reconnect();
			return;
		}
		if (action === "sync") this.checkAllSubscribedSync();
	}

	private _scheduleSubscribe(handle: SubscriptionHandle, narratorIds: string[]): void {
		if (narratorIds.length === 0) return;
		// When the socket isn't OPEN there's nothing to send now; reconnect replays
		// every active handle via `_restoreSubscriptions`, so we simply drop this.
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		queueMicrotask(() => this._sendSubscribe(handle, narratorIds));
	}

	private _sendSubscribe(handle: SubscriptionHandle, narratorIds: string[]): void {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		const record = this.subscriptions.get(handle._id);
		if (!record) return;
		const activeNarratorIds = narratorIds.filter((nId) => {
			const refs = this.narratorRefCounts.get(nId);
			return refs?.has(handle._id) && record.narratorIds.includes(nId);
		});
		if (activeNarratorIds.length === 0) return;
		const kind = record.kind;
		const requestId = this._registerRequest(handle);

		if (kind === "messages" && activeNarratorIds.length === 1) {
			const narratorId = activeNarratorIds[0];
			const cursor = this.catchUpCursors.get(narratorId);
			const version = this.messageVersions.get(narratorId);
			const msg: Record<string, unknown> = {
				type: "subscribe",
				narratorIds: activeNarratorIds,
				kind,
				...(requestId ? { requestId } : {}),
			};
			if (cursor) msg.catchUpCursor = cursor;
			// Report the last-known version so the server can short-circuit to
			// sync_ok when nothing changed since we last synced (skips catch-up).
			if (version != null) msg.version = version;
			ws.send(JSON.stringify(msg));
			return;
		}

		for (const narratorIds of chunkNarratorIds(activeNarratorIds)) {
			ws.send(
				JSON.stringify({
					type: "subscribe",
					narratorIds,
					kind,
					...(requestId ? { requestId } : {}),
				}),
			);
		}
	}

	// Message types that are latency-sensitive and must be dispatched immediately
	// (they already have their own RAF-based batching in consumers).
	private static IMMEDIATE_TYPES = new Set([
		"stream_event",
		"tool_use_chunk",
		"message",
		"user_message",
	]);

	private _dispatch(data: Record<string, unknown>): void {
		const msgType = data.type as string | undefined;

		// Latency-sensitive messages (streaming) are dispatched immediately —
		// their consumers already have RAF-based batching.
		if (msgType && NarratorWSManager.IMMEDIATE_TYPES.has(msgType)) {
			this._dispatchImmediate(data);
			return;
		}

		// Non-latency-sensitive messages are queued and flushed together
		// in a microtask, so multiple WS frames in the same event-loop turn
		// only trigger one round of listener callbacks.
		this.pendingDispatchQueue.push(data);
		if (!this.dispatchScheduled) {
			this.dispatchScheduled = true;
			queueMicrotask(() => {
				this.dispatchScheduled = false;
				const queue = this.pendingDispatchQueue;
				this.pendingDispatchQueue = [];
				for (const msg of queue) {
					this._dispatchImmediate(msg);
				}
			});
		}
	}

	private _dispatchImmediate(data: Record<string, unknown>): void {
		const msgType = typeof data.type === "string" ? data.type : undefined;
		const narratorId = typeof data.narratorId === "string" ? data.narratorId : undefined;
		const subscriptionRequestId =
			typeof data.subscriptionRequestId === "string" ? data.subscriptionRequestId : undefined;
		const targetSubscriptionId = subscriptionRequestId
			? this.requestToSubscription.get(subscriptionRequestId)
			: undefined;
		if (narratorId && msgType && REALTIME_HISTORY_EVENT_TYPES.has(msgType)) {
			// Advance before fan-out so listeners observe this frame in the live-event epoch.
			this.noteRealtimeEvent(narratorId);
		}
		if (narratorId && msgType && MESSAGE_VERSION_EVENT_TYPES.has(msgType)) {
			// Count the raw WS frame once, regardless of how many matching listeners receive it.
			this.bumpMessageVersion(narratorId);
		}
		if (narratorId && msgType === "compact_done" && typeof data.messageVersion === "number") {
			// Compact completion summarizes the final persisted coordinate. Preserve any
			// newer frame that raced ahead of this broadcast instead of blindly bumping.
			this.updateMessageVersion(narratorId, data.messageVersion, {
				preserveOptimisticCurrent: true,
			});
		}
		if (narratorId && msgType && STRUCTURAL_HISTORY_EVENT_TYPES.has(msgType)) {
			// Tool/permission field updates are replayable and intentionally do not cross this barrier.
			this.noteStructuralEvent(narratorId);
		}

		for (const entry of this.listeners.values()) {
			if (
				!shouldDeliverToListener(
					entry.opts,
					msgType,
					narratorId,
					subscriptionRequestId,
					targetSubscriptionId,
				)
			)
				continue;
			try {
				entry.cb(data);
			} catch {
				// listener error — ignore
			}
		}
	}
}

/** Type/narrator filter used by both real-time and request-scoped dispatch. */
export function matchesListenerFilter(
	opts: ListenerOptions,
	msgType: string | undefined,
	narratorId: string | undefined,
): boolean {
	// Check type filters first (if specified)
	if (opts.excludeTypes && msgType && opts.excludeTypes.includes(msgType)) return false;
	if (opts.types && msgType) {
		if (!opts.types.includes(msgType)) return false;
	}
	if (opts.typePrefixes && msgType) {
		const matched = opts.typePrefixes.some((p) => msgType.startsWith(p));
		if (!matched) return false;
	}
	// If both types and typePrefixes are unset, no type filtering

	// Check narratorId filter
	if (opts.narratorIds) {
		if (opts.narratorIds === "*") return true;
		if (!narratorId) {
			// Message has no narratorId — only match if type filters already
			// narrowed it down (e.g. typePrefixes: ["container:"] or types: ["output_stats"]).
			// Without type filters, a specific-narrator listener should NOT
			// receive unrelated broadcast messages.
			return !!(opts.types || opts.typePrefixes);
		}
		return opts.narratorIds.includes(narratorId);
	}

	// No narratorId filter — match all
	return true;
}

/**
 * Decide whether a dispatched frame should reach a given listener.
 *
 * Request-scoped frames (snapshot / catch-up carrying `subscriptionRequestId`) are
 * delivered ONLY to the listener bound to the subscription handle that issued the
 * request, so a later panel/chunk mount cannot reset sibling consumers watching
 * the same narrator on the same socket. Frames without a `subscriptionRequestId`
 * fall back to the normal type/narrator filter.
 */
export function shouldDeliverToListener(
	opts: ListenerOptions,
	msgType: string | undefined,
	narratorId: string | undefined,
	subscriptionRequestId: string | undefined,
	targetSubscriptionId: number | undefined,
): boolean {
	if (subscriptionRequestId) {
		if (targetSubscriptionId == null || opts.subscriptionId !== targetSubscriptionId) return false;
	}
	return matchesListenerFilter(opts, msgType, narratorId);
}

export const narratorWSManager = new NarratorWSManager();
