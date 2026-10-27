/**
 * The live sessions of the process: who is in which page, the spaces' lanes, the barrier for
 * writes from outside, re-authorization, and the life cycle of sessions.
 *
 *   - Join: the page must exist and be readable by the socket's person (a page that does not
 *     exist and one they may not read answer the same `access_denied`); write access decides
 *     editing or viewing. Checked again on every access change (`narrator:access_changed`,
 *     `project:access_changed`, `auth:changed`): losing read ends the participant's session,
 *     losing write turns it into a viewer. A socket whose login session ends is closed by the
 *     WebSocket layer, which ends its participants.
 *   - A session opens in its space's lane on the first join, and closes (committing everything)
 *     {@link OUTLINE_LIVE_TIMING.idleCloseMs} after the last participant left, when the outline
 *     is switched off, and at shutdown.
 *   - Limits: {@link OUTLINE_LIVE_LIMITS} per socket, page and process; joins per socket are
 *     rate-limited ({@link OUTLINE_LIVE_SOCKET_BOUNDS}); a participant's frames waiting in the
 *     lane are bounded in bytes; frames of viewers and of refused participants are answered
 *     without being queued.
 *   - A session ended by a close, or recovered after a crash, leaves for each client how far its
 *     changes reached the page (`recovered`), so a client resuming it does not replay them.
 */
import { eventBus, type NarraForkEvent } from "@server/lib/event-bus";
import { hotOnce, hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import { subscribeSettingsChanges } from "@server/lib/settings";
import {
	encodeLiveFrame,
	isLiveHandle,
	LIVE_FRAME,
	type LiveCloseCode,
	type LiveFrame,
	type LiveJoinHead,
	type LivePresenceUp,
	OUTLINE_LIVE_LIMITS,
} from "@shared/outline-live-protocol";
import { canReadSpace, canWriteSpace } from "../access";
import { OutlineBusyError } from "../errors";
import { isOutlineEnabled } from "../feature";
import { setOutlineLiveBarrier } from "../live-barrier";
import { outlineStore } from "../store";
import type { OutlineSpaceRow } from "../store/port";
import { holdsLane, isOwnLiveWrite, SpaceLane } from "./lane";
import { type RecoveredChange, replayAllLiveEpochs, replayLiveEpochDetailed } from "./replay";
import {
	type CommittedEvent,
	LIVE_SYNC_ACTOR,
	LivePage,
	type LiveSocket,
	OUTLINE_LIVE_TIMING,
	type Participant,
} from "./session";

interface Binding {
	page: LivePage;
	participant: Participant;
}

export const OUTLINE_LIVE_SOCKET_BOUNDS = {
	/** Joins a socket may make in a burst… */
	joinBurst: 20,
	/** …refilled at this many per second. */
	joinsPerSecond: 2,
	/**
	 * Bytes of one participant's frames waiting in the lane. A client stops at
	 * `maxPendingBytes` unacknowledged, so only a misbehaving one gets here; it is dismissed.
	 */
	queuedBytes: 2 * OUTLINE_LIVE_LIMITS.maxPendingBytes,
	/** How long an ended session's client positions are kept (memory and log), and how many. */
	recoveredMs: 7 * 24 * 60 * 60_000,
	recoveredSessions: 1_000,
	/** Ended sessions of one page whose client positions the log keeps. */
	endedPerPage: 32,
	/** Leftover epochs one open replays at most (the rest wait for the startup job). */
	replayPerOpen: 64,
} as const;

type ReauthFilter = (space: OutlineSpaceRow, socket: LiveSocket) => boolean;

const state = hotSafe("narrafork.outlineLive.state", () => ({
	sessions: new Map<string, LivePage>(),
	spaces: new Map<string, OutlineSpaceRow>(),
	lanes: new Map<string, SpaceLane>(),
	pending: new Map<string, CommittedEvent[]>(),
	sockets: new Map<LiveSocket, Map<number, Binding>>(),
	/** Joins being authorized or opened, per socket (they count toward the socket's limit). */
	joining: new Map<LiveSocket, Set<number>>(),
	reauthFilters: [] as ReauthFilter[],
	reauthTimer: undefined as ReturnType<typeof setTimeout> | undefined,
	accessEpoch: 0,
	replayDone: null as Promise<unknown> | null,
	/**
	 * `${pageId}:${epoch}` of an ended session → client key → highest transaction in the page.
	 * A cache of the log's epoch-0 rows (`recordEnded`).
	 */
	recovered: new Map<string, { at: number; keys: Map<string, number> }>(),
	/** Epochs whose log cannot be read, so opens do not read them again (an operator's job). */
	unreadable: new Set<string>(),
	/** Join tokens per socket. */
	joinBudget: new WeakMap<LiveSocket, { tokens: number; at: number }>(),
	warned: 0,
}));

/**
 * The log keeps, under epoch {@link ENDED_EPOCH} of a page, one row per ended session (seq =
 * that session's epoch, a sync row with `k` only): how far each client's transactions reached
 * the page. A client that comes back after the session ended (a close, a crash and replay, a
 * restart, a night offline) learns it at its join and does not replay what the page has.
 */
export const ENDED_EPOCH = 0;

function cacheRecovered(pageId: string, epoch: number, keys: Map<string, number>): void {
	const now = Date.now();
	for (const [key, entry] of state.recovered) {
		if (now - entry.at <= OUTLINE_LIVE_SOCKET_BOUNDS.recoveredMs) break;
		state.recovered.delete(key);
	}
	state.recovered.set(`${pageId}:${epoch}`, { at: now, keys });
	while (state.recovered.size > OUTLINE_LIVE_SOCKET_BOUNDS.recoveredSessions) {
		const oldest = state.recovered.keys().next().value;
		if (oldest === undefined) break;
		state.recovered.delete(oldest);
	}
}

function fresh(createdAt: string): boolean {
	return Date.now() - Date.parse(createdAt) <= OUTLINE_LIVE_SOCKET_BOUNDS.recoveredMs;
}

/** Record an ended session's client positions (memory and log). In the page's space lane. */
async function recordEnded(
	pageId: string,
	epoch: number,
	keys: Map<string, number>,
): Promise<void> {
	if (keys.size === 0) return;
	cacheRecovered(pageId, epoch, keys);
	try {
		const rows = (
			await outlineStore.listLiveUpdates(pageId, ENDED_EPOCH, {
				limit: 2 * OUTLINE_LIVE_SOCKET_BOUNDS.endedPerPage,
			})
		)
			.filter((r) => r.seq !== epoch && fresh(r.createdAt))
			.sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))
			.slice(0, OUTLINE_LIVE_SOCKET_BOUNDS.endedPerPage - 1);
		rows.push({
			pageBlockId: pageId,
			epoch: ENDED_EPOCH,
			seq: epoch,
			updateB64: Buffer.from(JSON.stringify({ k: Object.fromEntries(keys) })).toString("base64"),
			actorKind: "system",
			actorId: LIVE_SYNC_ACTOR,
			createdAt: new Date().toISOString(),
		});
		rows.sort((x, y) => x.seq - y.seq);
		await outlineStore.replaceLiveUpdates(pageId, ENDED_EPOCH, rows);
	} catch (error) {
		logger.warn("Outline live session end could not be recorded", {
			pageId,
			error: String(error),
		});
	}
}

/** Of a client's earlier session of a page (now ended), its transactions the page has. */
async function endedTx(pageId: string, head: LiveJoinHead): Promise<number | undefined> {
	const epoch = head.resume?.epoch;
	if (epoch === undefined || epoch <= ENDED_EPOCH) return undefined;
	const entry = state.recovered.get(`${pageId}:${epoch}`);
	if (entry && Date.now() - entry.at <= OUTLINE_LIVE_SOCKET_BOUNDS.recoveredMs)
		return entry.keys.get(head.key);
	const [row] = await outlineStore.listLiveUpdates(pageId, ENDED_EPOCH, {
		afterSeq: epoch - 1,
		limit: 1,
	});
	if (!row || row.seq !== epoch || !fresh(row.createdAt)) return undefined;
	try {
		const parsed = JSON.parse(Buffer.from(row.updateB64, "base64").toString("utf8")) as {
			k?: Record<string, number>;
		};
		const keys = new Map(
			Object.entries(parsed.k ?? {}).filter(([, tx]) => Number.isSafeInteger(tx)),
		);
		cacheRecovered(pageId, epoch, keys);
		return keys.get(head.key);
	} catch {
		return undefined;
	}
}

/** Drop the ended-session rows of a page that are past keeping (the startup job). */
async function pruneEnded(pageId: string): Promise<void> {
	const rows = await outlineStore.listLiveUpdates(pageId, ENDED_EPOCH, {
		limit: 2 * OUTLINE_LIVE_SOCKET_BOUNDS.endedPerPage,
	});
	const keep = rows.filter((r) => fresh(r.createdAt));
	if (keep.length === rows.length) return;
	if (keep.length === 0) await outlineStore.deleteLiveUpdates(pageId, ENDED_EPOCH);
	else await outlineStore.replaceLiveUpdates(pageId, ENDED_EPOCH, keep);
}

/** A rate-limited warning (a misbehaving client must not flood the log). */
function warnRarely(message: string, fields: Record<string, unknown>): void {
	if (Date.now() - state.warned < 60_000) return;
	state.warned = Date.now();
	logger.warn(message, fields);
}

function takeJoinToken(socket: LiveSocket): boolean {
	const now = Date.now();
	const b = state.joinBudget.get(socket) ?? {
		tokens: OUTLINE_LIVE_SOCKET_BOUNDS.joinBurst,
		at: now,
	};
	b.tokens = Math.min(
		OUTLINE_LIVE_SOCKET_BOUNDS.joinBurst,
		b.tokens + ((now - b.at) / 1000) * OUTLINE_LIVE_SOCKET_BOUNDS.joinsPerSecond,
	);
	b.at = now;
	state.joinBudget.set(socket, b);
	if (b.tokens < 1) return false;
	b.tokens -= 1;
	return true;
}

function sessionsOf(spaceId: string): LivePage[] {
	return [...state.sessions.values()].filter((s) => s.spaceId === spaceId);
}

function laneFor(spaceId: string): SpaceLane {
	let lane = state.lanes.get(spaceId);
	if (!lane) {
		lane = new SpaceLane(spaceId, () => drainCommits(spaceId));
		state.lanes.set(spaceId, lane);
	}
	return lane;
}

/** Drop a lane nothing uses any more. */
function retireLane(spaceId: string): void {
	setTimeout(() => {
		const lane = state.lanes.get(spaceId);
		if (lane && !lane.busy && sessionsOf(spaceId).length === 0) {
			state.lanes.delete(spaceId);
			state.pending.delete(spaceId);
		}
	}, 0).unref?.();
}

/** Push commits recorded for the space into its sessions (runs after every lane task). */
async function drainCommits(spaceId: string): Promise<void> {
	const list = state.pending.get(spaceId);
	if (!list || list.length === 0) return;
	state.pending.delete(spaceId);
	for (const session of sessionsOf(spaceId)) {
		await session.applyCommits(list);
		// An outside write merged into the live text is logged right away.
		await session.persistNow();
	}
}

function onCommitted(event: Extract<NarraForkEvent, { type: "outline:committed" }>): void {
	if (isOwnLiveWrite()) return;
	const lane = state.lanes.get(event.spaceId);
	if (!lane) return;
	const list = state.pending.get(event.spaceId);
	if (list) list.push(event);
	else state.pending.set(event.spaceId, [event]);
	// Outside a lane task (a write that started before the session existed): drain soon.
	if (!holdsLane(event.spaceId)) void lane.run(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// The barrier (`live-barrier.ts`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A write from outside waits for the space's lane and goes after the live text is committed.
 * When that commit fails the write is refused (busy, try again): written now, it would not see
 * the people's changes (an agent's stale read would pass, its text would merge into
 * uncommitted text).
 */
async function runBehindBarrier<T>(spaceId: string, fn: () => Promise<T>): Promise<T> {
	const lane = state.lanes.get(spaceId);
	if (!lane) return await fn();
	return await lane.run(async () => {
		for (const session of sessionsOf(spaceId)) {
			if (!(await session.flushContent())) throw new OutlineBusyError(spaceId, 1);
		}
		return await fn();
	});
}

setOutlineLiveBarrier({ run: runBehindBarrier, holds: holdsLane });

// ─────────────────────────────────────────────────────────────────────────────
// Joining and leaving
// ─────────────────────────────────────────────────────────────────────────────

/** Tell a socket a join failed. Never throws. */
function sendClosed(socket: LiveSocket, handle: number, code: LiveCloseCode): void {
	try {
		socket.send(encodeLiveFrame({ kind: LIVE_FRAME.closed, handle, head: { code } }));
	} catch {
		// Nothing to tell a socket that cannot take a frame.
	}
}

async function authorize(
	socket: LiveSocket,
	pageId: string,
): Promise<{ space: OutlineSpaceRow; canWrite: boolean } | null> {
	if (!socket.userId) return null;
	const page = await outlineStore.getBlock(pageId);
	if (!page || page.deleted || page.parentId !== null || page.pageId !== page.id) return null;
	const space = await outlineStore.getSpace(page.spaceId);
	if (!space) return null;
	const principal = { userId: socket.userId, isAdmin: socket.isAdmin };
	if (!(await canReadSpace(principal, space))) return null;
	return { space, canWrite: await canWriteSpace(principal, space) };
}

function validJoinHead(head: unknown): LiveJoinHead | null {
	const h = head as Partial<LiveJoinHead> | null;
	if (!h || typeof h.page !== "string" || h.page.length === 0 || h.page.length > 128) return null;
	if (h.mode !== "edit" && h.mode !== "view") return null;
	if (typeof h.key !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(h.key)) return null;
	const r = h.resume;
	if (
		r !== undefined &&
		(!r ||
			!Number.isSafeInteger(r.epoch) ||
			!Number.isSafeInteger(r.op) ||
			!Number.isSafeInteger(r.tx) ||
			(r.reset !== undefined && typeof r.reset !== "boolean"))
	)
		return null;
	return h as LiveJoinHead;
}

/**
 * Open the session of a page, replaying any log a previous session left. In the lane. A log
 * whose text cannot be committed is taken over by the new session (people see the text and it
 * is committed with theirs); a log that cannot be read is left for an operator. Neither keeps
 * the page from being edited.
 */
async function openSession(
	pageId: string,
	space: OutlineSpaceRow,
): Promise<LivePage | { refused: LiveCloseCode }> {
	const existing = state.sessions.get(pageId);
	if (existing && !existing.closed) return existing;
	if (state.sessions.size >= OUTLINE_LIVE_LIMITS.livePages) return { refused: "unavailable" };
	const adopted: Array<{ epoch: number; changes: RecoveredChange[] }> = [];
	let after = { pageBlockId: pageId, epoch: 0 };
	for (let replayed = 0; replayed < OUTLINE_LIVE_SOCKET_BOUNDS.replayPerOpen; ) {
		const epochs = await outlineStore.listLiveEpochs({ after, limit: 8 });
		const mine = epochs.filter((e) => e.pageBlockId === pageId);
		for (const e of mine) {
			after = e;
			replayed++;
			const tag = `${pageId}:${e.epoch}`;
			if (state.unreadable.has(tag)) continue;
			const r = await replayLiveEpochDetailed(pageId, e.epoch);
			if (r.outcome !== "kept" || r.changes) await recordEnded(pageId, e.epoch, r.keys);
			if (r.outcome !== "kept") continue;
			if (r.changes) adopted.push({ epoch: e.epoch, changes: r.changes });
			else state.unreadable.add(tag);
		}
		if (mine.length < 8) break;
	}
	const lane = laneFor(space.id);
	const opened = await LivePage.open(
		pageId,
		space.id,
		(task) => void lane.run(task),
		(page, code, idle) => void lane.run(() => closeSession(page, code, idle)),
	);
	if ("refused" in opened) return opened;
	state.sessions.set(pageId, opened);
	state.spaces.set(space.id, space);
	if (adopted.length > 0) {
		for (const a of adopted) opened.adoptRecovered(a.changes);
		// Once this session's log holds the text, the old one can go.
		if (await opened.persistNow()) {
			for (const a of adopted) await outlineStore.deleteLiveUpdates(pageId, a.epoch);
		}
	}
	return opened;
}

/** Close one session (commit everything, end its participants). In its lane. */
async function closeSession(page: LivePage, code: LiveCloseCode, idle = false): Promise<void> {
	// Someone joined during the idle period.
	if (idle && page.participants.size > 0) return;
	for (const bindings of state.sockets.values()) {
		for (const [handle, binding] of [...bindings])
			if (binding.page === page) bindings.delete(handle);
	}
	await page.close(code);
	await recordEnded(page.pageId, page.epoch, page.durableKeys(page.closedClean));
	if (state.sessions.get(page.pageId) === page) state.sessions.delete(page.pageId);
	retireLane(page.spaceId);
}

/** A `join` frame. */
export async function joinLive(socket: LiveSocket, frame: LiveFrame): Promise<void> {
	const handle = frame.handle;
	// A handle no frame can carry cannot be answered either: ignored.
	if (!isLiveHandle(handle)) {
		warnRarely("Outline live join with an invalid handle ignored", { handle });
		return;
	}
	const head = validJoinHead(frame.head);
	if (!head || handle === 0) return sendClosed(socket, handle, "unavailable");
	if (!isOutlineEnabled()) return sendClosed(socket, handle, "unavailable");
	if (!takeJoinToken(socket)) return sendClosed(socket, handle, "unavailable");
	let bindings = state.sockets.get(socket);
	// Joining again on a handle (a resync, a resume) replaces what was there.
	const previous = bindings?.get(handle);
	if (previous) {
		bindings?.delete(handle);
		const prior = previous;
		void laneFor(prior.page.spaceId).run(() => prior.page.leave(prior.participant));
	}
	let joining = state.joining.get(socket);
	if (!joining) {
		joining = new Set();
		state.joining.set(socket, joining);
	}
	if (
		(bindings?.size ?? 0) + joining.size >= OUTLINE_LIVE_LIMITS.sessionsPerSocket ||
		joining.has(handle)
	)
		return sendClosed(socket, handle, "unavailable");
	joining.add(handle);
	try {
		let verdict: Awaited<ReturnType<typeof authorize>> = null;
		let checked = 0;
		for (;;) {
			checked = state.accessEpoch;
			verdict = await authorize(socket, head.page);
			if (checked === state.accessEpoch) break;
		}
		if (!verdict) return sendClosed(socket, handle, "access_denied");
		const space = verdict.space;
		let canWrite = verdict.canWrite;
		const result = await laneFor(space.id).run(async () => {
			if (!isOutlineEnabled()) return { refused: "unavailable" as LiveCloseCode };
			// Access changed while the join waited for the lane: ask again (the re-check of
			// joined participants never saw this one).
			while (checked !== state.accessEpoch) {
				checked = state.accessEpoch;
				const again = await authorize(socket, head.page);
				if (!again || again.space.id !== space.id)
					return { refused: "access_denied" as LiveCloseCode };
				canWrite = again.canWrite;
			}
			if (socket.closed) return { refused: "ended" as LiveCloseCode };
			const page = await openSession(head.page, space);
			if ("refused" in page) return page;
			const ended =
				head.resume && head.resume.epoch !== page.epoch
					? await endedTx(head.page, head)
					: undefined;
			const joined = page.join(
				socket,
				handle,
				head,
				frame.body,
				head.mode === "edit" && canWrite,
				ended,
			);
			if ("refused" in joined) return joined;
			return { page, participant: joined };
		});
		if ("refused" in result) return sendClosed(socket, handle, result.refused);
		if (socket.closed) {
			// The socket closed while the join ran.
			void laneFor(space.id).run(() => result.page.leave(result.participant));
			return;
		}
		bindings = state.sockets.get(socket);
		if (!bindings) {
			bindings = new Map();
			state.sockets.set(socket, bindings);
		}
		bindings.set(handle, result);
	} catch (error) {
		logger.warn("Outline live join failed", { error: String(error) });
		sendClosed(socket, handle, "unavailable");
	} finally {
		joining.delete(handle);
		if (joining.size === 0) state.joining.delete(socket);
	}
}

function bindingOf(socket: LiveSocket, handle: number): Binding | undefined {
	return state.sockets.get(socket)?.get(handle);
}

/** Every frame of a socket after the join. */
export function handleLiveFrame(socket: LiveSocket, frame: LiveFrame): void {
	if (frame.kind === LIVE_FRAME.join) {
		void joinLive(socket, frame);
		return;
	}
	const binding = bindingOf(socket, frame.handle);
	if (!binding) return;
	const { page, participant } = binding;
	switch (frame.kind) {
		case LIVE_FRAME.leave:
			state.sockets.get(socket)?.delete(frame.handle);
			void laneFor(page.spaceId).run(() => page.leave(participant));
			break;
		case LIVE_FRAME.update:
		case LIVE_FRAME.tx: {
			// Refused participants' frames are dropped and viewers' answered, without queueing.
			if (participant.blocked) break;
			if (!participant.canWrite) {
				page.refuseFrame(participant, frame.n);
				break;
			}
			const size = frame.body.length + 256;
			if (participant.queuedBytes + size > OUTLINE_LIVE_SOCKET_BOUNDS.queuedBytes) {
				warnRarely("Outline live participant queued too much; dismissed", {
					pageId: page.pageId,
					bytes: participant.queuedBytes,
				});
				state.sockets.get(socket)?.delete(frame.handle);
				void laneFor(page.spaceId).run(() => page.dismiss(participant, "unavailable"));
				break;
			}
			participant.queuedBytes += size;
			// The socket's buffer may be reused once this returns.
			const body = frame.body.slice();
			const head = frame.head;
			const n = frame.n;
			const kind = frame.kind;
			void laneFor(page.spaceId).run(async () => {
				participant.queuedBytes -= size;
				if (kind === LIVE_FRAME.update) page.handleUpdate(participant, n, body);
				else await page.handleTx(participant, n, head, body);
			});
			break;
		}
		case LIVE_FRAME.selection:
			page.setSelection(participant, (frame.head as LivePresenceUp | null)?.s ?? null);
			break;
		default:
			break;
	}
}

/** The socket closed: its participants leave. */
export function releaseLiveSocket(socket: LiveSocket): void {
	const bindings = state.sockets.get(socket);
	state.sockets.delete(socket);
	state.joining.delete(socket);
	if (!bindings) return;
	for (const { page, participant } of bindings.values()) {
		void laneFor(page.spaceId).run(() => page.leave(participant));
	}
}

/** The socket drained: participants that fell behind are told to rejoin. */
export function drainLiveSocket(socket: LiveSocket): void {
	for (const { page, participant } of state.sockets.get(socket)?.values() ?? []) {
		page.onDrain(participant);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-authorization, the switch, shutdown
// ─────────────────────────────────────────────────────────────────────────────

async function reauthorize(): Promise<void> {
	state.reauthTimer = undefined;
	const filters = state.reauthFilters;
	state.reauthFilters = [];
	const verdicts = new Map<string, Promise<{ read: boolean; write: boolean }>>();
	for (const [socket, bindings] of [...state.sockets]) {
		for (const [handle, binding] of [...bindings]) {
			const space = state.spaces.get(binding.page.spaceId);
			if (!space || !filters.some((matches) => matches(space, socket))) continue;
			const key = `${socket.userId}\u0000${socket.isAdmin}\u0000${space.id}`;
			let verdict = verdicts.get(key);
			if (!verdict) {
				const principal = { userId: socket.userId, isAdmin: socket.isAdmin };
				verdict = (async () => {
					const fresh = await outlineStore.getSpace(space.id);
					// A space that is gone can be read by nobody.
					if (!fresh) return { read: false, write: false };
					const read = await canReadSpace(principal, fresh);
					return { read, write: read && (await canWriteSpace(principal, fresh)) };
				})().catch((error) => {
					logger.warn("Outline live re-authorization failed", { error: String(error) });
					return { read: false, write: false };
				});
				verdicts.set(key, verdict);
			}
			const { read, write } = await verdict;
			if (bindings.get(handle) !== binding) continue;
			const { page, participant } = binding;
			if (!read) {
				bindings.delete(handle);
				void laneFor(page.spaceId).run(() => page.dismiss(participant, "access_denied"));
			} else {
				void laneFor(page.spaceId).run(() =>
					page.setWrite(participant, participant.wantsEdit && write),
				);
			}
		}
	}
}

function scheduleReauth(filter: ReauthFilter): void {
	state.accessEpoch++;
	state.reauthFilters.push(filter);
	if (!state.reauthTimer) {
		state.reauthTimer = setTimeout(() => void reauthorize(), OUTLINE_LIVE_TIMING.broadcastMs);
		state.reauthTimer.unref?.();
	}
}

/** Re-check the participants an access change may affect (exported for tests). */
export function onOutlineLiveAccessEvent(event: NarraForkEvent): void {
	switch (event.type) {
		case "narrator:access_changed":
			scheduleReauth((space) => space.narratorId === event.narratorId);
			break;
		case "project:access_changed":
			// A session's readers pass its project's gate, so session spaces may change too.
			scheduleReauth((space) => space.projectId === event.projectId || space.kind === "session");
			break;
		case "auth:changed":
			scheduleReauth((_space, socket) =>
				event.userId === undefined ? true : socket.userId === event.userId,
			);
			break;
		default:
			break;
	}
}

/** Close every session (commit everything first). The switch went off, or shutdown. */
export async function closeAllLiveSessions(code: LiveCloseCode): Promise<void> {
	const sessions = [...state.sessions.values()];
	await Promise.all(
		sessions.map((page) => laneFor(page.spaceId).run(() => closeSession(page, code))),
	);
}

/**
 * Write every session's pending log rows now and acknowledge them (shutdown, before the
 * sockets close).
 */
export async function persistAllLiveSessions(): Promise<void> {
	await Promise.all(
		[...state.sessions.values()].map(async (page) => {
			await page.persistNow();
			page.flushBroadcast();
		}),
	);
}

/**
 * Replay what earlier sessions left in the log (the startup job). One run per process; later
 * calls return the same promise.
 */
export function startLiveReplay(): Promise<unknown> {
	state.replayDone ??= replayAllLiveEpochs(
		(pageId, epoch) => state.sessions.get(pageId)?.epoch === epoch,
		async (pageId, epoch) => {
			const page = await outlineStore.getBlock(pageId);
			const run = async () => {
				if (epoch === ENDED_EPOCH) {
					await pruneEnded(pageId);
					return "empty" as const;
				}
				const r = await replayLiveEpochDetailed(pageId, epoch);
				if (r.outcome !== "kept" || r.changes) await recordEnded(pageId, epoch, r.keys);
				return r.outcome;
			};
			if (!page) return await run();
			// Always in the space's lane: a join opening the page replays in it too, so the two
			// never replay one epoch at once. An open session took the log over already.
			const lane = laneFor(page.spaceId);
			try {
				return await lane.run(async () =>
					state.sessions.get(pageId) && epoch !== ENDED_EPOCH ? ("empty" as const) : await run(),
				);
			} finally {
				retireLane(page.spaceId);
			}
		},
	)
		.then((result) => {
			if (result.committed || result.kept) logger.info("Outline live log replayed", result);
			return result;
		})
		.catch((error) => logger.warn("Outline live log replay failed", { error: String(error) }));
	return state.replayDone;
}

/** Counts for tests and diagnostics. */
export function outlineLiveStats(): {
	sessions: number;
	lanes: number;
	sockets: number;
	participants: number;
} {
	let participants = 0;
	for (const s of state.sessions.values()) participants += s.participants.size;
	return {
		sessions: state.sessions.size,
		lanes: state.lanes.size,
		sockets: state.sockets.size,
		participants,
	};
}

/** Whether nothing is queued in any lane or waiting to be broadcast (tests). */
export function outlineLiveQuiet(): boolean {
	for (const lane of state.lanes.values()) if (lane.busy) return false;
	for (const s of state.sessions.values()) if (!s.quiet) return false;
	return true;
}

/** Drop a page's session as if the process had died (tests of the replay). */
export function abandonLiveSessionForTests(pageId: string): void {
	const session = state.sessions.get(pageId);
	if (!session) return;
	session.abandon();
	state.sessions.delete(pageId);
	for (const bindings of state.sockets.values()) {
		for (const [handle, binding] of [...bindings])
			if (binding.page === session) bindings.delete(handle);
	}
	retireLane(session.spaceId);
}

/** Forget the in-memory copy of ended sessions' client positions, as a new process (tests). */
export function forgetEndedSessionsForTests(): void {
	state.recovered.clear();
}

/** The session of a page, if one is open (tests and diagnostics). */
export function liveSessionOf(pageId: string): LivePage | undefined {
	return state.sessions.get(pageId);
}

/** Run `fn` in a space's lane (tests). */
export function runInLane<T>(spaceId: string, fn: () => Promise<T> | T): Promise<T> {
	return laneFor(spaceId).run(fn);
}

if (hotOnce("narrafork.outlineLive.listenersRegistered")) {
	eventBus.on("outline:committed", onCommitted);
	eventBus.on("narrator:access_changed", onOutlineLiveAccessEvent);
	eventBus.on("project:access_changed", onOutlineLiveAccessEvent);
	eventBus.on("auth:changed", onOutlineLiveAccessEvent);
	subscribeSettingsChanges(() => {
		if (!isOutlineEnabled() && state.sessions.size > 0) void closeAllLiveSessions("unavailable");
	});
}
