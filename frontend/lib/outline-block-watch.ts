/**
 * The client of the outline's block watch (`shared/outline-block-events.ts`, `/ws/narrator`): a
 * view that shows a lazily loaded tree of one space names the LEVELS it has open (parent keys)
 * and the SUBTREES it shows something about (a closed row's marks), and is told which of them a
 * commit touched. Ids and seqs only: the view re-reads over HTTP.
 *
 * One {@link OutlineWatchHandle} is one wire subscription. The view hands over its whole set
 * whenever a row opens or closes ({@link OutlineWatchHandle.set}); sends are debounced, and a
 * send REPLACES what the subscription watched (the server carries changes not yet sent over to
 * the keys still watched). After a reconnect the set is sent again.
 *
 * WHAT THE VIEW MUST DO (the protocol's client obligations), and what this class tells it:
 *   - `onWatching(seq, added)`: the server confirmed a set as of `seq`. Keys in `added` were
 *     not in the set confirmed before (after a reconnect: every key): a key new in the set has
 *     no past, so the view re-reads those it read before `seq`. And when `seq` is past
 *     everything the view has read or been told, it re-reads everything it watches.
 *   - `onChanged`: the watched levels and subtrees commits concern; `all`: everything watched.
 *   - `onPending`: changes waiting for confirmation changed: re-read what shows them.
 *   - `onError`: `access_denied` (re-read: the server answers not found) or `unavailable` (no
 *     room: the view keeps what it read; this class tries again after a while).
 *
 * Limits (`OUTLINE_WATCH_LIMITS`): 2,000 keys per subscription (levels first when a caller
 * hands over more), 24 subscriptions per person per space, 16 per socket.
 */
import { OUTLINE_WATCH_LIMITS, type OutlineWatchErrorCode } from "@shared/outline-block-events";
import type { ListenerHandle, ListenerOptions, MessageCallback } from "./narrator-ws-manager";

export interface OutlineWatchTransport {
	readonly connected: boolean;
	send(message: Record<string, unknown>): boolean;
	addListener(options: ListenerOptions, callback: MessageCallback): ListenerHandle;
	removeListener(handle: ListenerHandle): void;
	onConnectionChange(callback: (connected: boolean, reconnect: boolean) => void): () => void;
}

export interface OutlineWatchHandlers {
	onWatching(seq: number, added: { levels: string[]; subtrees: string[] }): void;
	onChanged(frame: { seq: number; levels: string[]; subtrees: string[]; all: boolean }): void;
	onPending?(): void;
	onError?(code: OutlineWatchErrorCode): void;
}

export interface OutlineWatchHandle {
	/** The whole set to watch from now on (sent after a short delay; the last call wins). */
	set(levels: Iterable<string>, subtrees: Iterable<string>): void;
	dispose(): void;
}

/** How long a burst of opening and closing rows is gathered into one send. */
export const OUTLINE_WATCH_DEBOUNCE_MS = 150;
/** How long after `unavailable` the set is sent again. */
export const OUTLINE_WATCH_RETRY_MS = 10_000;

interface KeySet {
	levels: string[];
	subtrees: string[];
}

function bounded(levels: Iterable<string>, subtrees: Iterable<string>): KeySet {
	const max = OUTLINE_WATCH_LIMITS.keysPerSubscription;
	const outLevels = [...new Set(levels)].slice(0, max);
	const outSubtrees = [...new Set(subtrees)].slice(0, max - outLevels.length);
	return { levels: outLevels.sort(), subtrees: outSubtrees.sort() };
}

function same(a: KeySet | null, b: KeySet): boolean {
	return (
		a !== null &&
		a.levels.length === b.levels.length &&
		a.subtrees.length === b.subtrees.length &&
		a.levels.every((key, i) => key === b.levels[i]) &&
		a.subtrees.every((key, i) => key === b.subtrees[i])
	);
}

let nextId = 0;

export class OutlineBlockWatch {
	private handles = 0;

	constructor(
		private readonly transport: OutlineWatchTransport,
		private readonly debounceMs = OUTLINE_WATCH_DEBOUNCE_MS,
		private readonly retryMs = OUTLINE_WATCH_RETRY_MS,
	) {}

	/** Open subscriptions of this tab (each takes one of the person's places in its space). */
	get size(): number {
		return this.handles;
	}

	open(spaceId: string, handlers: OutlineWatchHandlers): OutlineWatchHandle {
		const subscriptionId = `outline-watch-${++nextId}`;
		this.handles++;
		let wanted: KeySet = { levels: [], subtrees: [] };
		/** Sets sent and not answered yet, oldest first: each `outline_watching` answers one. */
		let inFlight: KeySet[] = [];
		/** The set the server last confirmed; null: none (never, or the socket dropped). */
		let confirmed: KeySet | null = null;
		/** The set last sent; null: nothing is on the wire. */
		let sent: KeySet | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let disposed = false;

		const send = () => {
			timer = null;
			if (disposed || !this.transport.connected) return;
			if (wanted.levels.length + wanted.subtrees.length === 0) {
				if (sent) this.transport.send({ type: "outline_unwatch", subscriptionId });
				sent = null;
				confirmed = null;
				inFlight = [];
				return;
			}
			if (same(sent, wanted)) return;
			sent = wanted;
			inFlight.push(wanted);
			this.transport.send({
				type: "outline_watch",
				subscriptionId,
				spaceId,
				levels: wanted.levels,
				subtrees: wanted.subtrees,
			});
		};
		const schedule = (delay: number) => {
			if (timer !== null) clearTimeout(timer);
			timer = setTimeout(send, delay);
		};

		const listener = this.transport.addListener(
			{
				types: [
					"outline_watching",
					"outline_watch_changed",
					"outline_watch_pending",
					"outline_watch_error",
				],
			},
			(frame) => {
				if (disposed || frame.subscriptionId !== subscriptionId) return;
				if (frame.type === "outline_watch_error") {
					const code = frame.code === "access_denied" ? "access_denied" : "unavailable";
					sent = null;
					confirmed = null;
					inFlight = [];
					handlers.onError?.(code);
					// No room now (another tab may close): the same set is tried again later.
					if (code === "unavailable") schedule(this.retryMs);
					return;
				}
				if (frame.spaceId !== spaceId) return;
				if (frame.type === "outline_watch_pending") {
					handlers.onPending?.();
					return;
				}
				if (!Number.isSafeInteger(frame.seq)) return;
				const seq = frame.seq as number;
				if (frame.type === "outline_watching") {
					const now = inFlight.shift() ?? sent ?? wanted;
					const before = confirmed;
					confirmed = now;
					const hadLevel = new Set(before?.levels ?? []);
					const hadSubtree = new Set(before?.subtrees ?? []);
					handlers.onWatching(seq, {
						levels: now.levels.filter((key) => !hadLevel.has(key)),
						subtrees: now.subtrees.filter((key) => !hadSubtree.has(key)),
					});
					return;
				}
				const list = (value: unknown) =>
					Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
				handlers.onChanged({
					seq,
					levels: list(frame.levels),
					subtrees: list(frame.subtrees),
					all: frame.all === true,
				});
			},
		);
		const off = this.transport.onConnectionChange((connected) => {
			// The server remembers nothing of a socket that dropped: every key is new again.
			sent = null;
			confirmed = null;
			inFlight = [];
			if (connected) schedule(0);
		});

		return {
			set: (levels, subtrees) => {
				if (disposed) return;
				const next = bounded(levels, subtrees);
				if (same(wanted, next)) return;
				wanted = next;
				schedule(this.debounceMs);
			},
			dispose: () => {
				if (disposed) return;
				disposed = true;
				this.handles--;
				if (timer !== null) clearTimeout(timer);
				off();
				this.transport.removeListener(listener);
				if (sent) this.transport.send({ type: "outline_unwatch", subscriptionId });
			},
		};
	}
}

let shared: OutlineBlockWatch | null = null;
let sharedTransport: OutlineWatchTransport | null = null;

/** The transport block watches of this tab go over; a fixture sets its own before any opens. */
export function setOutlineWatchTransport(transport: OutlineWatchTransport | null): void {
	sharedTransport = transport;
	shared = null;
}

/** This tab's block watches, over `transport` the first time (the narrator socket). */
export function outlineBlockWatch(transport: () => OutlineWatchTransport): OutlineBlockWatch {
	shared ??= new OutlineBlockWatch(sharedTransport ?? transport());
	return shared;
}
