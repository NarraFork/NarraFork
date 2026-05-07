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

import { getToken } from "./api";
import { buildWsUrl, safeCloseWs } from "./ws";
import { removeWSStatus, setWSStatus } from "./ws-status";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Opaque handle returned by `subscribe()` — pass to `unsubscribe()`. */
export interface SubscriptionHandle {
	/** @internal */ _id: number;
	/** @internal */ _narratorIds: string[];
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
}

interface ListenerEntry {
	id: number;
	opts: ListenerOptions;
	cb: MessageCallback;
}

type ConnectionChangeCallback = (connected: boolean, isReconnect: boolean) => void;

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
const WS_STATUS_ID = "narrator-global";
/**
 * Maximum number of lastMessageId entries to keep.
 * Prevents unbounded growth when the user browses many narrators over time.
 */
const MAX_LAST_MESSAGE_IDS = 100;
/**
 * How long the tab must be hidden before we force a reconnect on return.
 * Matches the server heartbeat interval — if we missed at least one ping
 * cycle, the connection state is unreliable.
 */
const VISIBILITY_RECONNECT_THRESHOLD_MS = 30_000;

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

class NarratorWSManager {
	private ws: WebSocket | null = null;
	private _connected = false;
	private _disconnected = false;
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private pingTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
	private cancelled = false;

	// --- Subscription ref-counting ---
	// narratorId → Set of subscription handle IDs
	private narratorRefCounts = new Map<string, Set<number>>();

	// --- Pending subscribes (queued while WS is not OPEN) ---
	// Tracks narrator IDs whose subscribe message hasn't been sent yet.
	// lastMessageId is already stored in this.lastMessageIds by subscribe(),
	// so we only need to track the IDs themselves.
	private pendingSubscribeIds = new Set<string>();

	// --- Presence ref-counting ---
	// narratorId → Set of handle IDs that requested presence
	private presenceRefCounts = new Map<string, Set<number>>();

	// --- Stats ---
	private statsRefCount = 0;

	// --- Last message IDs for catch-up ---
	private lastMessageIds = new Map<string, string>();

	// --- Message version tracking for sync_check ---
	private messageVersions = new Map<string, number>();

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
		this._doConnect();
	}

	disconnect(): void {
		this.cancelled = true;
		this._unlistenVisibility();
		clearTimeout(this.reconnectTimer);
		clearTimeout(this.pingTimeoutTimer);
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
					w.send(JSON.stringify({ type: "unsubscribe", narratorIds: allIds }));
				}
				if (this.statsRefCount > 0) {
					w.send(JSON.stringify({ type: "unsubscribe_stats" }));
				}
			});
		}
		this._setConnected(false, false);
	}

	// -----------------------------------------------------------------------
	// Subscriptions (ref-counted)
	// -----------------------------------------------------------------------

	/**
	 * Subscribe to one or more narrator IDs.  Returns a handle that MUST be
	 * passed to `unsubscribe()` when the consumer unmounts.
	 *
	 * If `lastMessageId` is provided and there is exactly one narratorId, the
	 * server will send catch-up messages since that point.
	 */
	subscribe(
		narratorIds: string[],
		opts?: { lastMessageId?: string; fullSubscribe?: boolean },
	): SubscriptionHandle {
		const id = this.nextId++;
		const handle: SubscriptionHandle = { _id: id, _narratorIds: [...narratorIds] };

		const newIds: string[] = [];
		for (const nId of narratorIds) {
			let refs = this.narratorRefCounts.get(nId);
			if (!refs) {
				refs = new Set();
				this.narratorRefCounts.set(nId, refs);
				newIds.push(nId);
			}
			refs.add(id);
		}

		if (opts?.lastMessageId && narratorIds.length === 1) {
			this.lastMessageIds.delete(narratorIds[0]);
			this.lastMessageIds.set(narratorIds[0], opts.lastMessageId);
			while (this.lastMessageIds.size > MAX_LAST_MESSAGE_IDS) {
				const oldest = this.lastMessageIds.keys().next().value;
				if (oldest !== undefined) this.lastMessageIds.delete(oldest);
				else break;
			}
		}

		// When fullSubscribe is true (panel-level), always send subscribe to the
		// server even if the ID was already ref-counted by a list-level subscriber.
		// This ensures the server sends back the streaming snapshot (including
		const idsToSend = opts?.fullSubscribe ? narratorIds : newIds;
		if (idsToSend.length) {
			if (this.ws?.readyState === WebSocket.OPEN) {
				this._sendSubscribe(idsToSend, opts?.lastMessageId);
			} else {
				for (const nId of idsToSend) {
					this.pendingSubscribeIds.add(nId);
				}
			}
		}

		return handle;
	}

	/**
	 * Release a subscription.  When the last subscriber for a narratorId is
	 * removed, an `unsubscribe` message is sent to the server.
	 */
	unsubscribe(handle: SubscriptionHandle): void {
		const removedIds: string[] = [];
		for (const nId of handle._narratorIds) {
			const refs = this.narratorRefCounts.get(nId);
			if (!refs) continue;
			refs.delete(handle._id);
			if (refs.size === 0) {
				this.narratorRefCounts.delete(nId);
				this.pendingSubscribeIds.delete(nId);
				this.messageVersions.delete(nId);
				// Keep lastMessageId so that re-subscribe (page navigation back)
				// can still trigger server-side catch-up.
				removedIds.push(nId);
			}
		}
		if (removedIds.length && this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: "unsubscribe", narratorIds: removedIds }));
		}
	}

	/**
	 * Update the set of narrator IDs for an existing subscription handle.
	 * Sends incremental subscribe/unsubscribe for the diff.
	 */
	updateSubscription(handle: SubscriptionHandle, newNarratorIds: string[]): void {
		const oldSet = new Set(handle._narratorIds);
		const newSet = new Set(newNarratorIds);

		const toAdd = newNarratorIds.filter((id) => !oldSet.has(id));
		const toRemove = handle._narratorIds.filter((id) => !newSet.has(id));

		// Remove old
		const actuallyRemoved: string[] = [];
		for (const nId of toRemove) {
			const refs = this.narratorRefCounts.get(nId);
			if (!refs) continue;
			refs.delete(handle._id);
			if (refs.size === 0) {
				this.narratorRefCounts.delete(nId);
				this.pendingSubscribeIds.delete(nId);
				this.lastMessageIds.delete(nId);
				this.messageVersions.delete(nId);
				actuallyRemoved.push(nId);
			}
		}

		// Add new
		const actuallyAdded: string[] = [];
		for (const nId of toAdd) {
			let refs = this.narratorRefCounts.get(nId);
			if (!refs) {
				refs = new Set();
				this.narratorRefCounts.set(nId, refs);
				actuallyAdded.push(nId);
			}
			refs.add(handle._id);
		}

		handle._narratorIds = [...newNarratorIds];

		if (this.ws?.readyState === WebSocket.OPEN) {
			if (actuallyRemoved.length) {
				this.ws.send(JSON.stringify({ type: "unsubscribe", narratorIds: actuallyRemoved }));
			}
			if (actuallyAdded.length) {
				this._sendSubscribe(actuallyAdded);
			}
		} else if (actuallyAdded.length) {
			for (const nId of actuallyAdded) {
				this.pendingSubscribeIds.add(nId);
			}
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
	// Last message ID tracking (for catch-up on reconnect)
	// -----------------------------------------------------------------------

	updateLastMessageId(narratorId: string, messageId: string): void {
		// Move to end (most recently used) by re-inserting
		this.lastMessageIds.delete(narratorId);
		this.lastMessageIds.set(narratorId, messageId);
		// Evict oldest entries if over limit
		while (this.lastMessageIds.size > MAX_LAST_MESSAGE_IDS) {
			const oldest = this.lastMessageIds.keys().next().value;
			if (oldest !== undefined) this.lastMessageIds.delete(oldest);
			else break;
		}
	}

	// -----------------------------------------------------------------------
	// Message version tracking (for sync_check)
	// -----------------------------------------------------------------------

	updateMessageVersion(narratorId: string, version: number): void {
		this.messageVersions.set(narratorId, version);
	}

	/** Optimistically increment the local version by 1 (called on each received message). */
	bumpMessageVersion(narratorId: string): void {
		const current = this.messageVersions.get(narratorId) ?? 0;
		this.messageVersions.set(narratorId, current + 1);
	}

	/**
	 * Send a lightweight sync_check for a single narrator.
	 * The server compares the version and replies with sync_ok (in sync),
	 * catch_up (incremental), or full_reload (too far behind / deleted).
	 */
	checkSync(narratorId: string): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		const version = this.messageVersions.get(narratorId) ?? 0;
		const lastMessageId = this.lastMessageIds.get(narratorId);
		const msg: Record<string, unknown> = {
			type: "sync_check",
			narratorId,
			version,
		};
		if (lastMessageId) msg.lastMessageId = lastMessageId;
		this.ws.send(JSON.stringify(msg));
	}

	/**
	 * Send sync_check for all currently subscribed narrators.
	 * Called on window focus to detect any missed messages.
	 */
	checkAllSubscribedSync(): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		for (const narratorId of this.narratorRefCounts.keys()) {
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
		this._doConnect();
	}

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	private _doConnect(): void {
		if (this.cancelled) return;

		const token = getToken();
		if (!token) {
			// No token yet — retry after a short delay
			this.reconnectTimer = setTimeout(() => this._doConnect(), 1000);
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
			const isReconnect = this.reconnectAttempts > 0;
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
			// 1001 = Going Away — server is shutting down, don't reconnect.
			if (ev.code === 1001) this._disconnected = true;
			this._setConnected(false, false);
			if (ev.code === 1001) return;
			this._scheduleReconnect();
		};

		ws.onerror = () => {
			// onclose will fire after this
		};
	}

	private _scheduleReconnect(): void {
		if (this.cancelled) return;
		if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			// Give up — server is likely down for good.
			if (!this._disconnected) {
				this._disconnected = true;
				this._syncGlobalStatus();
			}
			return;
		}
		if (this.reconnectAttempts >= DISCONNECTED_THRESHOLD && !this._disconnected) {
			this._disconnected = true;
			this._syncGlobalStatus();
		}
		const delay = Math.min(
			RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
			RECONNECT_MAX_DELAY_MS,
		);
		this.reconnectAttempts++;
		this.reconnectTimer = setTimeout(() => this._doConnect(), delay);
	}

	private _resetPingTimeout(): void {
		clearTimeout(this.pingTimeoutTimer);
		this.pingTimeoutTimer = setTimeout(() => {
			if (!this.cancelled && this.ws?.readyState === WebSocket.OPEN) {
				this.ws.close(4000, "ping timeout");
			}
		}, CLIENT_PING_TIMEOUT_MS);
	}

	private _setConnected(connected: boolean, isReconnect: boolean): void {
		const changed = this._connected !== connected;
		this._connected = connected;
		if (connected) this._disconnected = false;
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

		// Clear pending queue — everything in narratorRefCounts will be sent below
		this.pendingSubscribeIds.clear();

		// Subscribe narrators — send individually so each can carry its own lastMessageId
		for (const [narratorId] of this.narratorRefCounts) {
			const lastMessageId = this.lastMessageIds.get(narratorId);
			const msg: Record<string, unknown> = {
				type: "subscribe",
				narratorIds: [narratorId],
			};
			if (lastMessageId) msg.lastMessageId = lastMessageId;
			ws.send(JSON.stringify(msg));
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
	// Visibility change — recover from browser background throttling
	// -----------------------------------------------------------------------

	private _boundVisibilityHandler: (() => void) | null = null;
	private _hiddenAt = 0;

	private _listenVisibility(): void {
		if (this._boundVisibilityHandler) return;
		this._boundVisibilityHandler = () => this._handleVisibilityChange();
		document.addEventListener("visibilitychange", this._boundVisibilityHandler);
	}

	private _unlistenVisibility(): void {
		if (this._boundVisibilityHandler) {
			document.removeEventListener("visibilitychange", this._boundVisibilityHandler);
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
			this._hiddenAt = Date.now();
			return;
		}

		// visible
		const elapsed = this._hiddenAt ? Date.now() - this._hiddenAt : 0;
		this._hiddenAt = 0;

		// If reconnection was exhausted (ws is null, no pending timer), always
		// try again when the tab becomes visible — this is the only automatic
		// recovery path after MAX_RECONNECT_ATTEMPTS.
		if (!this.ws && !this.reconnectTimer) {
			this.reconnect();
			return;
		}

		// Long hidden — force a clean reconnect
		if (elapsed >= VISIBILITY_RECONNECT_THRESHOLD_MS) {
			this.reconnect();
			return;
		}

		// Short switch — send lightweight sync_check to detect missed messages
		this.checkAllSubscribedSync();
	}

	private _sendSubscribe(narratorIds: string[], lastMessageId?: string): void {
		const ws = this.ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;

		if (lastMessageId && narratorIds.length === 1) {
			ws.send(
				JSON.stringify({
					type: "subscribe",
					narratorIds,
					lastMessageId,
				}),
			);
		} else {
			// For batch subscribes (no catch-up), send as one message
			ws.send(JSON.stringify({ type: "subscribe", narratorIds }));
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
		const msgType = data.type as string | undefined;
		const narratorId = data.narratorId as string | undefined;

		for (const entry of this.listeners.values()) {
			if (this._matchesFilter(entry.opts, msgType, narratorId)) {
				try {
					entry.cb(data);
				} catch {
					// listener error — ignore
				}
			}
		}
	}

	private _matchesFilter(
		opts: ListenerOptions,
		msgType: string | undefined,
		narratorId: string | undefined,
	): boolean {
		// Check type filters first (if specified)
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
}

export const narratorWSManager = new NarratorWSManager();
