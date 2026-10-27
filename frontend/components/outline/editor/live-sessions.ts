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
 * A session let go before it was ever live (a panel hidden while its page still showed the HTTP
 * read) is not kept for the grace period: it leaves as soon as the server answers its join. Not
 * before: a leave that overtakes the join on the server would be dropped and the server would
 * keep the participant until the socket closes. Unless something was typed on the read: then it
 * stays for the grace period after the answer, so the merged text is sent first.
 *
 * TYPING NOT ACKNOWLEDGED
 * -----------------------
 * A session is never dropped (grace period, making room) while the page has not acknowledged
 * everything typed into it (`pending` or `awaiting`): it waits, offline included, for the socket
 * to come back and the page to take it. At most `DEFAULT_UNACKED_WAIT_MS` (2 minutes) after its
 * last editor let go: then it is dropped all the same, and the client gives what was not taken to
 * the unsaved-text store (`dispose`), where every editor of the page shows it — what was sent but
 * never acknowledged too, even on a connection that looks live (it may be dead without knowing
 * it). A client is never disposed with typing still inside.
 *
 * ADMISSION
 * ---------
 * The server takes at most `OUTLINE_LIVE_LIMITS.sessionsPerSocket` sessions per socket and
 * answers one more with a bare `unavailable`. So the tab counts its own: a new page first makes
 * room by dropping sessions that were held and released (in their grace period, oldest release
 * first), except ones still waiting for their join's answer or for typing to be acknowledged;
 * when no session can go, the page is refused here (`null`) and the surface says why, instead of
 * sending a join the server would refuse.
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
	/** Let go before it was live: leaves once its join is answered (see LIFETIME). */
	dropWhenJoined: (() => void) | null;
}

/** How long a page's session outlives its last editor (tab flicks and focus changes). */
const DEFAULT_GRACE_MS = 5_000;
let graceMs = DEFAULT_GRACE_MS;
/**
 * How long a session with typing the page has not acknowledged waits for it once let go (the
 * socket coming back, the join, the acknowledgement); then its typing goes to the unsaved-text
 * store. Long enough for a reconnect after a network change or a server restart.
 */
const DEFAULT_UNACKED_WAIT_MS = 2 * 60_000;
let unackedWaitMs = DEFAULT_UNACKED_WAIT_MS;

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

/** Typing the page has not acknowledged (sent or not). */
function unacked(client: LiveClient): boolean {
	return client.pending.length > 0 || client.awaiting.length > 0;
}

/** Still waiting for typing to be acknowledged, and not too long yet (see TYPING NOT ACKNOWLEDGED). */
function mustWait(shared: SharedLiveSession): number {
	if (shared.client.status === "closed" || !unacked(shared.client)) return 0;
	return Math.max(0, shared.releasedAt + unackedWaitMs - Date.now());
}

function dispose(
	map: Map<string, SharedLiveSession>,
	key: string,
	shared: SharedLiveSession,
	opts: { unconfirmed?: boolean } = {},
) {
	if (shared.timer) clearTimeout(shared.timer);
	shared.timer = null;
	shared.dropWhenJoined?.();
	shared.dropWhenJoined = null;
	shared.client.dispose(opts);
	if (map.get(key) === shared) map.delete(key);
}

/**
 * Drop released sessions, oldest release first, until a new one fits. A session whose join is
 * still on its way is left alone (its leave could reach the server before the join is bound), and
 * so is one with typing not acknowledged yet (it would leave without it).
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
				shared.client.status !== "connecting" &&
				!unacked(shared.client),
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
		dropWhenJoined: null,
		drop: () => {
			shared.timer = null;
			if (shared.refs > 0) return;
			// Typing not acknowledged yet: look again a little later (until the wait is over).
			const wait = shared.releasedAt > 0 ? mustWait(shared) : 0;
			if (wait > 0) {
				shared.timer = setTimeout(shared.drop, Math.min(graceMs, wait));
				return;
			}
			// Waited as long as it may with typing not acknowledged: none of it counts as written.
			const unconfirmed =
				shared.releasedAt > 0 && shared.client.status !== "closed" && unacked(shared.client);
			dispose(map, key, shared, { unconfirmed });
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
	shared.dropWhenJoined?.();
	shared.dropWhenJoined = null;
	shared.releasedAt = 0;
	shared.refs++;
}

export function releaseLiveSession(shared: SharedLiveSession): void {
	shared.refs--;
	if (shared.refs > 0) return;
	shared.releasedAt = Date.now();
	if (shared.timer) clearTimeout(shared.timer);
	shared.timer = null;
	const client = shared.client;
	const unsent = () => client.pending.length > 0 || client.awaiting.length > 0;
	// Offline with something typed on the read: it waits for the socket, and then the join.
	const waiting = () =>
		!client.ready && (client.status === "connecting" || (client.status === "offline" && unsent()));
	if (waiting()) {
		// Never live, its join on its way: wait for the server's answer (a leave before it would be
		// lost). Then nothing typed on the read: leave at once; something typed: it was merged and
		// is being sent, so the usual grace period lets it go out (and be acknowledged). Offline
		// with typing: not longer than the wait for typing (then it goes to the store).
		const off = client.on(() => {
			if (waiting()) return;
			off();
			shared.dropWhenJoined = null;
			if (shared.timer) clearTimeout(shared.timer);
			shared.timer = null;
			if (client.ready && unsent()) {
				if (shared.refs === 0) shared.timer = setTimeout(shared.drop, graceMs);
			} else shared.drop();
		});
		shared.dropWhenJoined = off;
		if (unsent()) shared.timer = setTimeout(shared.drop, unackedWaitMs);
		return;
	}
	shared.timer = setTimeout(shared.drop, client.ready || unsent() ? graceMs : 0);
}

/** The page's session client on this socket, live or not (no session is made). */
export function liveSessionClient(
	transport: LiveTransport,
	pageId: string,
	mode: "edit" | "view",
): LiveClient | null {
	const shared = sessionsBySocket.get(transport)?.get(`${pageId}\u0000${mode}`);
	return shared && shared.client.status !== "closed" ? shared.client : null;
}

/** The page's session on this socket if it is live (no session is made). */
export function liveSessionIfReady(
	transport: LiveTransport,
	pageId: string,
	mode: "edit" | "view",
): LiveClient | null {
	const shared = sessionsBySocket.get(transport)?.get(`${pageId}\u0000${mode}`);
	return shared?.client.ready && shared.client.status !== "closed" ? shared.client : null;
}

/**
 * Sessions of this tab that no editor holds but that keep their slot while the page has not
 * acknowledged typing (TYPING NOT ACKNOWLEDGED): how many, and when the first of them goes at the
 * latest (it may go sooner, once acknowledged). For the notice of a page refused for lack of room.
 */
export function liveSessionsWaitingOn(transport: LiveTransport): {
	count: number;
	freeBy: number | null;
} {
	let count = 0;
	let freeBy: number | null = null;
	for (const shared of sessionsBySocket.get(transport)?.values() ?? []) {
		if (shared.refs > 0 || shared.releasedAt === 0 || !occupies(shared)) continue;
		if (!unacked(shared.client)) continue;
		count++;
		const by = shared.releasedAt + unackedWaitMs;
		freeBy = freeBy === null ? by : Math.min(freeBy, by);
	}
	return { count, freeBy };
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

/** Tests: a shorter wait for typing not acknowledged (null restores the default). */
export function setLiveSessionUnackedWaitForTests(ms: number | null): void {
	unackedWaitMs = ms ?? DEFAULT_UNACKED_WAIT_MS;
}
