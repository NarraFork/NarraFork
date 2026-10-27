/**
 * The live page sessions of this tab, per socket: one session client per page and mode, shared
 * by every editor of that page (the outline page, dock panels, drawers), so one server session
 * and one undo stack per person and page.
 *
 * LIFETIME
 * --------
 * Rendering only looks a session up (or creates it); mounted editors hold it (`retain` /
 * `release`). One nobody holds is dropped after a grace period, so flicking between tabs or
 * moving the focus reuses it, and a render that never mounts (or strict mode's extra one)
 * leaks nothing. Editors are only mounted while their panel is on screen, so a hidden panel
 * leaves its page after the grace period and joins again when shown.
 *
 * ADMISSION
 * ---------
 * The server takes at most `OUTLINE_LIVE_LIMITS.sessionsPerSocket` sessions per socket and
 * answers one more with a bare `unavailable`. So the tab counts its own: a new page first makes
 * room by dropping sessions that were held and released (in their grace period, oldest release
 * first); when every session is still held by an editor on screen, the page is refused here
 * (`null`) and the surface says why, instead of sending a join the server would refuse.
 */
import { OUTLINE_LIVE_LIMITS } from "@shared/outline-live-protocol";
import { LiveClient, type LiveTransport } from "./live-client";

export interface SharedLiveSession {
	readonly client: LiveClient;
	refs: number;
	timer: ReturnType<typeof setTimeout> | null;
	/** When the last holder let go (0 while held, or before anyone held it). */
	releasedAt: number;
	drop: () => void;
}

/** How long a page's session outlives its last editor (tab flicks and focus changes). */
const DEFAULT_GRACE_MS = 5_000;
let graceMs = DEFAULT_GRACE_MS;

const sessionsBySocket = new WeakMap<LiveTransport, Map<string, SharedLiveSession>>();

function sessionsOf(transport: LiveTransport): Map<string, SharedLiveSession> {
	let sessions = sessionsBySocket.get(transport);
	if (!sessions) {
		sessions = new Map();
		sessionsBySocket.set(transport, sessions);
	}
	return sessions;
}

/** Whether the session counts against the socket's limit (the server holds it, or will). */
function occupies(shared: SharedLiveSession): boolean {
	return shared.client.status !== "closed";
}

function dispose(map: Map<string, SharedLiveSession>, key: string, shared: SharedLiveSession) {
	if (shared.timer) clearTimeout(shared.timer);
	shared.timer = null;
	shared.client.dispose();
	if (map.get(key) === shared) map.delete(key);
}

/**
 * Drop released sessions, oldest release first, until a new one fits. A session whose join is
 * still on its way is left alone: its leave could reach the server before the join is bound.
 */
function makeRoom(map: Map<string, SharedLiveSession>, limit: number): void {
	let used = 0;
	for (const shared of map.values()) if (occupies(shared)) used++;
	if (used < limit) return;
	const idle = [...map.entries()]
		.filter(
			([, shared]) =>
				occupies(shared) &&
				shared.refs === 0 &&
				shared.releasedAt > 0 &&
				shared.client.status !== "connecting",
		)
		.sort((a, b) => a[1].releasedAt - b[1].releasedAt);
	for (const [key, shared] of idle) {
		if (used < limit) break;
		dispose(map, key, shared);
		used--;
	}
}

/**
 * The page's shared session on this socket, created on first use; null when the socket already
 * holds as many sessions as the server takes and every one of them is in use.
 */
export function acquireLiveSession(
	transport: LiveTransport,
	pageId: string,
	mode: "edit" | "view",
): SharedLiveSession | null {
	const map = sessionsOf(transport);
	const key = `${pageId}\u0000${mode}`;
	const existing = map.get(key);
	if (existing && existing.client.status !== "closed") return existing;
	if (existing) dispose(map, key, existing);
	const limit = OUTLINE_LIVE_LIMITS.sessionsPerSocket;
	makeRoom(map, limit);
	let used = 0;
	for (const shared of map.values()) if (occupies(shared)) used++;
	if (used >= limit) return null;
	const shared: SharedLiveSession = {
		client: new LiveClient(transport, pageId, mode),
		refs: 0,
		timer: null,
		releasedAt: 0,
		drop: () => {
			shared.timer = null;
			if (shared.refs > 0) return;
			dispose(map, key, shared);
		},
	};
	map.set(key, shared);
	// Never held (a render that did not mount): dropped after the grace period.
	shared.timer = setTimeout(shared.drop, graceMs);
	return shared;
}

export function retainLiveSession(shared: SharedLiveSession): void {
	if (shared.timer) clearTimeout(shared.timer);
	shared.timer = null;
	shared.releasedAt = 0;
	shared.refs++;
}

export function releaseLiveSession(shared: SharedLiveSession): void {
	shared.refs--;
	if (shared.refs > 0) return;
	shared.releasedAt = Date.now();
	if (shared.timer) clearTimeout(shared.timer);
	shared.timer = setTimeout(shared.drop, graceMs);
}

/** The sessions this tab holds on `transport` (tests and diagnostics). */
export function liveSessionsOn(transport: LiveTransport): Array<{
	pageId: string;
	mode: "edit" | "view";
	refs: number;
	status: LiveClient["status"];
}> {
	return [...(sessionsBySocket.get(transport)?.values() ?? [])].map((shared) => ({
		pageId: shared.client.pageId,
		mode: shared.client.mode,
		refs: shared.refs,
		status: shared.client.status,
	}));
}

/** Tests: a shorter grace period (null restores the default). */
export function setLiveSessionGraceForTests(ms: number | null): void {
	graceMs = ms ?? DEFAULT_GRACE_MS;
}
