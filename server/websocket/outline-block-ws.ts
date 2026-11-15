/**
 * Read-only outline subscriptions by BLOCK on `/ws/narrator` (pageless outline, H2): the
 * protocol and its two kinds of watch are in `shared/outline-block-events.ts`. The page
 * subscriptions (`outline-page-ws.ts`) keep working beside it until pages go.
 *
 * A client watches, in one space, the levels it has open and the subtrees it shows something
 * about; when a commit concerns one of them the subscriber gets the keys, the newest seq and
 * the commit ids, never content, and re-reads over HTTP.
 *
 *   - Authorized against the SPACE (`canReadSpace`) at subscribe time, and again whenever
 *     access may have changed (`narrator:access_changed`, `project:access_changed`,
 *     `auth:changed`): a subscription that lost access gets `access_denied` and ends. A space
 *     that does not exist answers the same `access_denied`. The keys are never looked up: a
 *     commit is matched by its space first and by key second, so a key of another space (or of
 *     nothing) matches no commit, and nothing tells whether it exists.
 *   - Coalesced: commits that land within {@link OUTLINE_BLOCK_COALESCE_MS} become one frame
 *     per subscription. The event bus emits synchronously from the write path, so its listener
 *     only records the commit against the space's subscriptions and arms a timer; matching a
 *     commit costs the smaller of "its changed ids" and "the keys watched", per subscription.
 *   - Bounded: {@link OUTLINE_WATCH_LIMITS} per socket, per space and per subscription, plus a
 *     global ceiling; a frame names at most `keysPerFrame` keys and says `all` past that. A
 *     socket whose send buffer is past {@link OUTLINE_BLOCK_BACKPRESSURE_BYTES} is closed so
 *     the client reconnects and re-reads instead of missing a change.
 *   - `outline.enabled` off: watching answers `unavailable`, and turning it off ends every
 *     subscription.
 *   - Pending changes of the space changing (`outline:pending`) send `outline_watch_pending`.
 */
import {
	indexOutlineCommitChanges,
	OUTLINE_WATCH_LIMITS,
	type OutlineCommitChangeIndex,
	type OutlineWatchClientMessage,
	type OutlineWatchErrorCode,
	type OutlineWatchServerMessage,
} from "@shared/outline-block-events";
import { eventBus, type NarraForkEvent } from "../lib/event-bus";
import { hotOnce, hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { subscribeSettingsChanges } from "../lib/settings";
import { canReadSpace } from "../services/outline/access";
import { isOutlineEnabled } from "../services/outline/feature";
import { outlineStore } from "../services/outline/store";
import type { OutlineSpaceRow } from "../services/outline/store/port";

export const OUTLINE_BLOCK_COALESCE_MS = 50;
export const OUTLINE_BLOCK_BACKPRESSURE_BYTES = 256 * 1024;
/** Subscriptions across every socket of the process. */
export const OUTLINE_BLOCK_MAX_SUBSCRIPTIONS = 4096;

export interface OutlineBlockSocket {
	data: { userId?: string; userRole?: string };
	send(frame: string): unknown;
	getBufferedAmount?(): number;
	close?(code?: number, reason?: string): void;
}

interface Subscription {
	ws: OutlineBlockSocket;
	id: string;
	spaceId: string;
	levels: ReadonlySet<string>;
	subtrees: ReadonlySet<string>;
	/** The space once authorized; null while the first check runs. */
	space: OutlineSpaceRow | null;
	active: boolean;
	/** Newest seq not sent yet; 0 when nothing is pending. */
	pendingSeq: number;
	pendingCommits: string[];
	pendingLevels: Set<string>;
	pendingSubtrees: Set<string>;
	pendingAll: boolean;
	/** The space's pending changes changed since the last frame. */
	pendingChanges: boolean;
}

type ReauthFilter = (sub: Subscription) => boolean;

const state = hotSafe("narrafork.outlineBlockWs.state", () => ({
	bySocket: new Map<OutlineBlockSocket, Map<string, Subscription>>(),
	bySpace: new Map<string, Set<Subscription>>(),
	count: 0,
	dirty: new Set<Subscription>(),
	flushTimer: undefined as ReturnType<typeof setTimeout> | undefined,
	reauthFilters: [] as ReauthFilter[],
	reauthTimer: undefined as ReturnType<typeof setTimeout> | undefined,
	/** Bumped by every access change, so an authorization that raced one runs again. */
	accessEpoch: 0,
}));

function principalOf(ws: OutlineBlockSocket) {
	return { userId: ws.data.userId ?? "", isAdmin: ws.data.userRole === "admin" };
}

function isCurrent(sub: Subscription): boolean {
	return sub.active && state.bySocket.get(sub.ws)?.get(sub.id) === sub;
}

function remove(sub: Subscription): void {
	if (!sub.active) return;
	sub.active = false;
	state.dirty.delete(sub);
	const entries = state.bySocket.get(sub.ws);
	if (entries?.get(sub.id) === sub) {
		entries.delete(sub.id);
		state.count--;
		if (entries.size === 0) state.bySocket.delete(sub.ws);
	}
	const watchers = state.bySpace.get(sub.spaceId);
	if (watchers?.delete(sub) && watchers.size === 0) state.bySpace.delete(sub.spaceId);
}

/** End every block subscription of a socket (it closed, or fell behind). */
export function releaseOutlineBlockSubscriptions(ws: OutlineBlockSocket): void {
	for (const sub of [...(state.bySocket.get(ws)?.values() ?? [])]) remove(sub);
}

function send(ws: OutlineBlockSocket, frame: OutlineWatchServerMessage): void {
	if ((ws.getBufferedAmount?.() ?? 0) > OUTLINE_BLOCK_BACKPRESSURE_BYTES) {
		// Dropping a change would leave the view stale without the client knowing; a reconnect
		// watches again and re-reads.
		releaseOutlineBlockSubscriptions(ws);
		ws.close?.(1013, "Outline backpressure; reconnect");
		return;
	}
	try {
		ws.send(JSON.stringify(frame));
	} catch {
		releaseOutlineBlockSubscriptions(ws);
	}
}

function fail(sub: Subscription, code: OutlineWatchErrorCode): void {
	const wasActive = sub.active;
	remove(sub);
	if (wasActive) send(sub.ws, { type: "outline_watch_error", subscriptionId: sub.id, code });
}

/** The space, when the socket's person may read it now. */
async function authorize(sub: Subscription): Promise<OutlineSpaceRow | null> {
	const principal = principalOf(sub.ws);
	if (!principal.userId) return null;
	const space = await outlineStore.getSpace(sub.spaceId);
	if (!space || !(await canReadSpace(principal, space))) return null;
	return space;
}

async function watch(
	ws: OutlineBlockSocket,
	message: Extract<OutlineWatchClientMessage, { type: "outline_watch" }>,
): Promise<void> {
	const subscriptionId = message.subscriptionId;
	const refuse = (code: OutlineWatchErrorCode) =>
		send(ws, { type: "outline_watch_error", subscriptionId, code });
	if (!isOutlineEnabled() || !ws.data.userId) return refuse("unavailable");
	const levels = new Set(message.levels ?? []);
	const subtrees = new Set(message.subtrees ?? []);
	if (levels.size + subtrees.size > OUTLINE_WATCH_LIMITS.keysPerSubscription)
		return refuse("unavailable");
	let entries = state.bySocket.get(ws);
	if (
		(entries?.size ?? 0) >= OUTLINE_WATCH_LIMITS.perSocket ||
		state.count >= OUTLINE_BLOCK_MAX_SUBSCRIPTIONS
	) {
		return refuse("unavailable");
	}
	const sub: Subscription = {
		ws,
		id: subscriptionId,
		spaceId: message.spaceId,
		levels,
		subtrees,
		space: null,
		active: true,
		pendingSeq: 0,
		pendingCommits: [],
		pendingLevels: new Set(),
		pendingSubtrees: new Set(),
		pendingAll: false,
		pendingChanges: false,
	};
	if (!entries) {
		entries = new Map();
		state.bySocket.set(ws, entries);
	}
	entries.set(subscriptionId, sub);
	state.count++;
	// Registered before the check, so a commit that lands while it runs is not missed: it is
	// held until the subscription is confirmed (`flush` skips an unauthorized one).
	let watchers = state.bySpace.get(sub.spaceId);
	if ((watchers?.size ?? 0) >= OUTLINE_WATCH_LIMITS.perSpace) return fail(sub, "unavailable");
	if (!watchers) {
		watchers = new Set();
		state.bySpace.set(sub.spaceId, watchers);
	}
	watchers.add(sub);

	let space: OutlineSpaceRow | null = null;
	try {
		for (;;) {
			const epoch = state.accessEpoch;
			space = await authorize(sub);
			if (!isCurrent(sub)) return;
			if (epoch === state.accessEpoch) break;
		}
	} catch (error) {
		logger.warn("Outline block subscription failed", { error: String(error) });
		if (isCurrent(sub)) fail(sub, "unavailable");
		return;
	}
	if (!space) return fail(sub, "access_denied");
	if (!isOutlineEnabled()) return fail(sub, "unavailable");
	sub.space = space;
	send(ws, {
		type: "outline_watching",
		subscriptionId,
		spaceId: space.id,
		seq: space.nextSeq - 1,
	});
	// Commits that landed during the check: the seq above may not include them.
	if (isCurrent(sub) && (sub.pendingSeq !== 0 || sub.pendingChanges)) arm(sub);
}

export async function handleOutlineBlockMessage(
	ws: OutlineBlockSocket,
	message: OutlineWatchClientMessage,
): Promise<void> {
	const existing = state.bySocket.get(ws)?.get(message.subscriptionId);
	if (existing) remove(existing);
	if (message.type === "outline_unwatch") return;
	await watch(ws, message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Change notifications
// ─────────────────────────────────────────────────────────────────────────────

function dropAll(code: OutlineWatchErrorCode): void {
	for (const entries of [...state.bySocket.values()]) {
		for (const sub of [...entries.values()]) fail(sub, code);
	}
}

function arm(sub: Subscription): void {
	state.dirty.add(sub);
	if (!state.flushTimer) {
		state.flushTimer = setTimeout(flush, OUTLINE_BLOCK_COALESCE_MS);
		state.flushTimer.unref?.();
	}
}

function flush(): void {
	state.flushTimer = undefined;
	if (!isOutlineEnabled()) {
		dropAll("unavailable");
		return;
	}
	const batch = [...state.dirty];
	state.dirty.clear();
	for (const sub of batch) {
		if (!isCurrent(sub) || !sub.space) continue;
		if (sub.pendingSeq !== 0) {
			const all =
				sub.pendingAll ||
				sub.pendingLevels.size + sub.pendingSubtrees.size > OUTLINE_WATCH_LIMITS.keysPerFrame;
			const frame: OutlineWatchServerMessage = {
				type: "outline_watch_changed",
				subscriptionId: sub.id,
				spaceId: sub.spaceId,
				seq: sub.pendingSeq,
				commitIds: sub.pendingCommits,
				levels: all ? [] : [...sub.pendingLevels],
				subtrees: all ? [] : [...sub.pendingSubtrees],
				all,
			};
			sub.pendingSeq = 0;
			sub.pendingCommits = [];
			sub.pendingLevels = new Set();
			sub.pendingSubtrees = new Set();
			sub.pendingAll = false;
			send(sub.ws, frame);
		}
		if (sub.pendingChanges && isCurrent(sub)) {
			sub.pendingChanges = false;
			send(sub.ws, {
				type: "outline_watch_pending",
				subscriptionId: sub.id,
				spaceId: sub.spaceId,
			});
		}
	}
}

/**
 * Note the watched keys of `watched` a commit names in `changed`, walking the smaller of the
 * two; whether there was one.
 */
function collect(
	watched: ReadonlySet<string>,
	changed: ReadonlySet<string>,
	into: Set<string>,
): boolean {
	let found = false;
	const [walk, probe] = watched.size <= changed.size ? [watched, changed] : [changed, watched];
	for (const key of walk) {
		if (!probe.has(key)) continue;
		into.add(key);
		found = true;
	}
	return found;
}

/** Note what of a subscription a commit concerns; whether it concerns any of it. */
function matchCommit(sub: Subscription, index: OutlineCommitChangeIndex): boolean {
	if (index.all) {
		sub.pendingAll = true;
		return true;
	}
	const level = collect(sub.levels, index.parents, sub.pendingLevels);
	let subtree = collect(sub.subtrees, index.touched, sub.pendingSubtrees);
	// The space's own key: anything in the space.
	if (sub.subtrees.has(index.spaceId)) {
		sub.pendingSubtrees.add(index.spaceId);
		subtree = true;
	}
	return level || subtree;
}

function onCommitted(event: Extract<NarraForkEvent, { type: "outline:committed" }>): void {
	const watchers = state.bySpace.get(event.spaceId);
	if (!watchers) return;
	const index = indexOutlineCommitChanges(event.spaceId, event.changes);
	for (const sub of watchers) {
		if (!sub.active || !matchCommit(sub, index)) continue;
		sub.pendingSeq = Math.max(sub.pendingSeq, event.seq);
		sub.pendingCommits.push(event.commitId);
		if (sub.pendingCommits.length > OUTLINE_WATCH_LIMITS.commitIdsPerFrame)
			sub.pendingCommits.shift();
		arm(sub);
	}
}

function onPending(event: Extract<NarraForkEvent, { type: "outline:pending" }>): void {
	const watchers = state.bySpace.get(event.spaceId);
	if (!watchers) return;
	for (const sub of watchers) {
		if (!sub.active) continue;
		sub.pendingChanges = true;
		arm(sub);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-authorization
// ─────────────────────────────────────────────────────────────────────────────

async function reauthorize(): Promise<void> {
	state.reauthTimer = undefined;
	const filters = state.reauthFilters;
	state.reauthFilters = [];
	const affected: Subscription[] = [];
	for (const entries of state.bySocket.values()) {
		for (const sub of entries.values()) {
			if (sub.space && filters.some((matches) => matches(sub))) affected.push(sub);
		}
	}
	// One check per person and space, however many sockets and tabs they have open.
	const verdicts = new Map<string, Promise<OutlineSpaceRow | null>>();
	for (const sub of affected) {
		const key = `${sub.ws.data.userId ?? ""}\u0000${sub.ws.data.userRole ?? ""}\u0000${sub.spaceId}`;
		let verdict = verdicts.get(key);
		if (!verdict) {
			verdict = authorize(sub).catch((error) => {
				logger.warn("Outline block re-authorization failed", { error: String(error) });
				return null;
			});
			verdicts.set(key, verdict);
		}
		const space = await verdict;
		if (!isCurrent(sub)) continue;
		if (space) sub.space = space;
		else fail(sub, "access_denied");
	}
}

function scheduleReauth(filter: ReauthFilter): void {
	state.accessEpoch++;
	state.reauthFilters.push(filter);
	if (!state.reauthTimer) {
		state.reauthTimer = setTimeout(() => void reauthorize(), OUTLINE_BLOCK_COALESCE_MS);
		state.reauthTimer.unref?.();
	}
}

/**
 * Re-check the subscriptions an access change may affect. Exported for tests; production
 * calls it from the event-bus listeners below.
 */
export function onOutlineBlockAccessEvent(event: NarraForkEvent): void {
	switch (event.type) {
		case "narrator:access_changed":
			scheduleReauth((sub) => sub.space?.narratorId === event.narratorId);
			break;
		case "project:access_changed":
			// A session's readers pass its project's gate, so session spaces may change too.
			scheduleReauth(
				(sub) => sub.space?.projectId === event.projectId || sub.space?.kind === "session",
			);
			break;
		case "auth:changed":
			scheduleReauth((sub) =>
				event.userId === undefined ? true : sub.ws.data.userId === event.userId,
			);
			break;
		default:
			break;
	}
}

/** Counts for tests and diagnostics. */
export function outlineBlockSubscriptionStats(): {
	sockets: number;
	spaces: number;
	total: number;
} {
	return { sockets: state.bySocket.size, spaces: state.bySpace.size, total: state.count };
}

if (hotOnce("narrafork.outlineBlockWs.listenersRegistered")) {
	eventBus.on("outline:committed", onCommitted);
	eventBus.on("outline:pending", onPending);
	eventBus.on("narrator:access_changed", onOutlineBlockAccessEvent);
	eventBus.on("project:access_changed", onOutlineBlockAccessEvent);
	eventBus.on("auth:changed", onOutlineBlockAccessEvent);
	subscribeSettingsChanges(() => {
		if (!isOutlineEnabled() && state.count > 0) dropAll("unavailable");
	});
}
