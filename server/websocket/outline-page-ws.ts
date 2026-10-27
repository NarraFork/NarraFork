/**
 * Read-only outline page subscriptions on `/ws/narrator`.
 *
 * A client subscribes to a page it is showing; when a commit changes the page, the subscriber
 * gets the page id, the newest seq and the commit ids, never content, and re-reads over HTTP.
 *
 *   - Authorized at subscribe time against the page's space (`canReadSpace`), and again whenever
 *     access may have changed (`narrator:access_changed`, `project:access_changed`,
 *     `auth:changed`): a subscription that lost access gets `access_denied` and ends. A page that
 *     does not exist answers the same `access_denied`, so nothing tells the two apart.
 *   - Notifications are coalesced: commits that land within {@link OUTLINE_PAGE_COALESCE_MS}
 *     become one frame per subscription. The event bus emits synchronously from the write
 *     path, so its listener only marks subscriptions and arms a timer.
 *   - Bounded: {@link OUTLINE_PAGE_SUBSCRIPTION_LIMITS} per socket and per page, plus a global
 *     ceiling. A socket whose send buffer is past {@link OUTLINE_PAGE_BACKPRESSURE_BYTES} is
 *     closed so the client reconnects and re-reads instead of missing a change.
 *   - `outline.enabled` off: subscribing answers `unavailable`, and turning it off ends every
 *     subscription.
 */
import {
	OUTLINE_PAGE_SUBSCRIPTION_LIMITS,
	type OutlinePageClientMessage,
	type OutlinePageErrorCode,
	type OutlinePageServerMessage,
} from "@shared/outline-page-events";
import { eventBus, type NarraForkEvent } from "../lib/event-bus";
import { hotOnce, hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { subscribeSettingsChanges } from "../lib/settings";
import { canReadSpace } from "../services/outline/access";
import { isOutlineEnabled } from "../services/outline/feature";
import { outlineStore } from "../services/outline/store";
import type { OutlineSpaceRow } from "../services/outline/store/port";

export const OUTLINE_PAGE_COALESCE_MS = 50;
export const OUTLINE_PAGE_BACKPRESSURE_BYTES = 256 * 1024;
/** Subscriptions across every socket of the process. */
export const OUTLINE_PAGE_MAX_SUBSCRIPTIONS = 4096;

export interface OutlinePageSocket {
	data: { userId?: string; userRole?: string };
	send(frame: string): unknown;
	getBufferedAmount?(): number;
	close?(code?: number, reason?: string): void;
}

interface Subscription {
	ws: OutlinePageSocket;
	id: string;
	pageId: string;
	/** The page's space once authorized; null while the first check runs. */
	space: OutlineSpaceRow | null;
	active: boolean;
	/** Newest seq not sent yet; 0 when nothing is pending. */
	pendingSeq: number;
	pendingCommits: string[];
}

type ReauthFilter = (sub: Subscription) => boolean;

const state = hotSafe("narrafork.outlinePageWs.state", () => ({
	bySocket: new Map<OutlinePageSocket, Map<string, Subscription>>(),
	byPage: new Map<string, Set<Subscription>>(),
	count: 0,
	dirty: new Set<Subscription>(),
	flushTimer: undefined as ReturnType<typeof setTimeout> | undefined,
	reauthFilters: [] as ReauthFilter[],
	reauthTimer: undefined as ReturnType<typeof setTimeout> | undefined,
	/** Bumped by every access change, so an authorization that raced one runs again. */
	accessEpoch: 0,
}));

function principalOf(ws: OutlinePageSocket) {
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
	const watchers = state.byPage.get(sub.pageId);
	if (watchers?.delete(sub) && watchers.size === 0) state.byPage.delete(sub.pageId);
}

/** End every page subscription of a socket (it closed, or fell behind). */
export function releaseOutlinePageSubscriptions(ws: OutlinePageSocket): void {
	for (const sub of [...(state.bySocket.get(ws)?.values() ?? [])]) remove(sub);
}

function send(ws: OutlinePageSocket, frame: OutlinePageServerMessage): void {
	if ((ws.getBufferedAmount?.() ?? 0) > OUTLINE_PAGE_BACKPRESSURE_BYTES) {
		// Dropping a change would leave the page stale without the client knowing; a reconnect
		// re-subscribes and re-reads.
		releaseOutlinePageSubscriptions(ws);
		ws.close?.(1013, "Outline backpressure; reconnect");
		return;
	}
	try {
		ws.send(JSON.stringify(frame));
	} catch {
		releaseOutlinePageSubscriptions(ws);
	}
}

function fail(sub: Subscription, code: OutlinePageErrorCode): void {
	const wasActive = sub.active;
	remove(sub);
	if (wasActive) send(sub.ws, { type: "outline_page_error", subscriptionId: sub.id, code });
}

/** Whether the socket's person may read the page now; the page's space when they may. */
async function authorize(sub: Subscription): Promise<OutlineSpaceRow | null> {
	const principal = principalOf(sub.ws);
	if (!principal.userId) return null;
	const page = await outlineStore.getBlock(sub.pageId);
	if (!page || page.pageId !== page.id) return null;
	const space = await outlineStore.getSpace(page.spaceId);
	if (!space || !(await canReadSpace(principal, space))) return null;
	return space;
}

async function subscribe(ws: OutlinePageSocket, subscriptionId: string, pageId: string) {
	let entries = state.bySocket.get(ws);
	const sub: Subscription = {
		ws,
		id: subscriptionId,
		pageId,
		space: null,
		active: true,
		pendingSeq: 0,
		pendingCommits: [],
	};
	const refuse = (code: OutlinePageErrorCode) =>
		send(ws, { type: "outline_page_error", subscriptionId, code });
	if (!isOutlineEnabled() || !ws.data.userId) return refuse("unavailable");
	if (
		(entries?.size ?? 0) >= OUTLINE_PAGE_SUBSCRIPTION_LIMITS.perSocket ||
		state.count >= OUTLINE_PAGE_MAX_SUBSCRIPTIONS
	) {
		return refuse("unavailable");
	}
	if (!entries) {
		entries = new Map();
		state.bySocket.set(ws, entries);
	}
	entries.set(subscriptionId, sub);
	state.count++;

	let space: OutlineSpaceRow | null = null;
	try {
		for (;;) {
			const epoch = state.accessEpoch;
			space = await authorize(sub);
			if (!isCurrent(sub)) return;
			if (epoch === state.accessEpoch) break;
		}
	} catch (error) {
		logger.warn("Outline page subscription failed", { error: String(error) });
		if (isCurrent(sub)) fail(sub, "unavailable");
		return;
	}
	if (!space) return fail(sub, "access_denied");
	if (!isOutlineEnabled()) return fail(sub, "unavailable");
	let watchers = state.byPage.get(pageId);
	if ((watchers?.size ?? 0) >= OUTLINE_PAGE_SUBSCRIPTION_LIMITS.perPage) {
		return fail(sub, "unavailable");
	}
	if (!watchers) {
		watchers = new Set();
		state.byPage.set(pageId, watchers);
	}
	watchers.add(sub);
	sub.space = space;
	send(ws, {
		type: "outline_page_subscribed",
		subscriptionId,
		pageId,
		seq: space.nextSeq - 1,
	});
}

export async function handleOutlinePageMessage(
	ws: OutlinePageSocket,
	message: OutlinePageClientMessage,
): Promise<void> {
	const existing = state.bySocket.get(ws)?.get(message.subscriptionId);
	if (existing) remove(existing);
	if (message.type === "outline_page_unsubscribe") return;
	await subscribe(ws, message.subscriptionId, message.pageId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Change notifications
// ─────────────────────────────────────────────────────────────────────────────

function dropAll(code: OutlinePageErrorCode): void {
	for (const entries of [...state.bySocket.values()]) {
		for (const sub of [...entries.values()]) fail(sub, code);
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
		if (!isCurrent(sub) || sub.pendingSeq === 0) continue;
		const frame: OutlinePageServerMessage = {
			type: "outline_page_changed",
			subscriptionId: sub.id,
			pageId: sub.pageId,
			seq: sub.pendingSeq,
			commitIds: sub.pendingCommits,
		};
		sub.pendingSeq = 0;
		sub.pendingCommits = [];
		send(sub.ws, frame);
	}
}

function onCommitted(event: Extract<NarraForkEvent, { type: "outline:committed" }>): void {
	for (const pageId of event.pageIds) {
		const watchers = state.byPage.get(pageId);
		if (!watchers) continue;
		for (const sub of watchers) {
			if (sub.space?.id !== event.spaceId) continue;
			sub.pendingSeq = Math.max(sub.pendingSeq, event.seq);
			sub.pendingCommits.push(event.commitId);
			if (sub.pendingCommits.length > OUTLINE_PAGE_SUBSCRIPTION_LIMITS.commitIdsPerFrame) {
				sub.pendingCommits.shift();
			}
			state.dirty.add(sub);
		}
	}
	if (state.dirty.size > 0 && !state.flushTimer) {
		state.flushTimer = setTimeout(flush, OUTLINE_PAGE_COALESCE_MS);
		state.flushTimer.unref?.();
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
		const key = `${sub.ws.data.userId ?? ""}\u0000${sub.ws.data.userRole ?? ""}\u0000${sub.pageId}`;
		let verdict = verdicts.get(key);
		if (!verdict) {
			verdict = authorize(sub).catch((error) => {
				logger.warn("Outline page re-authorization failed", { error: String(error) });
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
		state.reauthTimer = setTimeout(() => void reauthorize(), OUTLINE_PAGE_COALESCE_MS);
		state.reauthTimer.unref?.();
	}
}

/**
 * Re-check the subscriptions an access change may affect. Exported for tests; production
 * calls it from the event-bus listeners below.
 */
export function onOutlineAccessEvent(event: NarraForkEvent): void {
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
export function outlinePageSubscriptionStats(): { sockets: number; pages: number; total: number } {
	return { sockets: state.bySocket.size, pages: state.byPage.size, total: state.count };
}

if (hotOnce("narrafork.outlinePageWs.listenersRegistered")) {
	eventBus.on("outline:committed", onCommitted);
	eventBus.on("narrator:access_changed", onOutlineAccessEvent);
	eventBus.on("project:access_changed", onOutlineAccessEvent);
	eventBus.on("auth:changed", onOutlineAccessEvent);
	subscribeSettingsChanges(() => {
		if (!isOutlineEnabled() && state.count > 0) dropAll("unavailable");
	});
}
