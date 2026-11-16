/**
 * The live sessions of the process: one per space (`LiveSpace`), who watches what in it, the
 * spaces' lanes, the barrier for writes from outside, re-authorization, and the life cycle of
 * sessions.
 *
 * A client joins a SPACE with a watch set (protocol version 4, `shared/outline-live-protocol.ts`);
 * clients of one space are in the same session whatever they watch.
 *
 *   - Join: the space must exist and be readable by the socket's person (a space that does not
 *     exist and one they may not read answer the same `access_denied`, as does a watched block
 *     that is not a live block of the space); write access decides editing or viewing. Checked
 *     again on every access change (`narrator:access_changed`, `project:access_changed`,
 *     `auth:changed`): losing read ends the participant's session, losing write turns it into a
 *     viewer. A socket whose login session ends is closed by the WebSocket layer, which ends its
 *     participants. A client of an older protocol version (it names a page) is told `outdated`.
 *   - A space's session opens in the space's lane on the first join; a watch is loaded into it
 *     on its first watcher and unloaded {@link OUTLINE_LIVE_TIMING.idleCloseMs} after its last
 *     watcher let go (sooner when the session needs the room). The session closes (committing
 *     everything) when its last watch goes, when the outline is switched off, and at shutdown.
 *   - Limits: {@link OUTLINE_LIVE_LIMITS} per socket, space and process, the session's own
 *     budgets (`OUTLINE_LIVE_BOUNDS`), and the blocks loaded across the process
 *     ({@link OUTLINE_LIVE_SOCKET_BOUNDS.processBlocks}); joins per socket are rate-limited; a
 *     participant's frames waiting in the lane are bounded in bytes; frames of viewers and of
 *     refused participants are answered without being queued.
 *   - A session ended by a close, or recovered after a crash, leaves for each client how far its
 *     changes reached the space (`recovered`), so a client resuming it does not replay them.
 */
import { eventBus, type NarraForkEvent } from "@server/lib/event-bus";
import { hotOnce, hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import { subscribeSettingsChanges } from "@server/lib/settings";
import { type LiveTimer, liveNow, liveTimeout } from "@shared/outline-live-clock";
import {
	encodeLiveFrame,
	isLiveHandle,
	isLiveWatch,
	LIVE_FRAME,
	type LiveCloseCode,
	type LiveFrame,
	type LiveJoinHead,
	type LiveLostWire,
	type LivePresenceUp,
	liveWatchKey,
	OUTLINE_LIVE_LIMITS,
	OUTLINE_LIVE_PROTOCOL_VERSION,
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
	type LiveSocket,
	LiveSpace,
	type LiveView,
	OUTLINE_LIVE_TIMING,
	type Participant,
} from "./session";

interface Binding {
	space: LiveSpace;
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
	/** Ended sessions of one space whose client positions the log keeps. */
	endedPerSpace: 32,
	/**
	 * Blocks all sessions of the process hold in their mirrors at most: a join or watch that, once
	 * read, would take them past it is refused (`unavailable`).
	 */
	processBlocks: 200_000,
	/** Leftover epochs one open replays at most (the rest wait for the startup job). */
	replayPerOpen: 64,
} as const;

type ReauthFilter = (space: OutlineSpaceRow, socket: LiveSocket) => boolean;

const state = hotSafe("narrafork.outlineLive.state", () => ({
	/** By space id. */
	sessions: new Map<string, LiveSpace>(),
	spaces: new Map<string, OutlineSpaceRow>(),
	lanes: new Map<string, SpaceLane>(),
	pending: new Map<string, CommittedEvent[]>(),
	sockets: new Map<LiveSocket, Map<number, Binding>>(),
	/** Joins being authorized or opened, per socket (they count toward the socket's limit). */
	joining: new Map<LiveSocket, Set<number>>(),
	reauthFilters: [] as ReauthFilter[],
	reauthTimer: undefined as LiveTimer | undefined,
	accessEpoch: 0,
	replayDone: null as Promise<unknown> | null,
	/**
	 * `${spaceId}:${epoch}` of an ended session → client key → highest transaction in the space.
	 * A cache of the log's epoch-0 rows (`recordEnded`).
	 */
	recovered: new Map<
		string,
		{ at: number; keys: Map<string, number>; lost: Map<string, LiveLostWire[]> }
	>(),
	/** Epochs whose log cannot be read, so opens do not read them again (an operator's job). */
	unreadable: new Set<string>(),
	/** Join tokens per socket. */
	joinBudget: new WeakMap<LiveSocket, { tokens: number; at: number }>(),
	warned: 0,
}));

/**
 * The log keeps, under epoch {@link ENDED_EPOCH} of a space, one row per ended session (seq =
 * that session's epoch, a sync row with `k` only): how far each client's transactions reached
 * the space. A client that comes back after the session ended (a close, a crash and replay, a
 * restart, a night offline) learns it at its join and does not replay what the space has.
 */
export const ENDED_EPOCH = 0;

type LostByKey = Map<string, LiveLostWire[]>;

function cacheRecovered(
	spaceId: string,
	epoch: number,
	keys: Map<string, number>,
	lost: LostByKey = new Map(),
): void {
	const now = Date.now();
	for (const [key, entry] of state.recovered) {
		if (now - entry.at <= OUTLINE_LIVE_SOCKET_BOUNDS.recoveredMs) break;
		state.recovered.delete(key);
	}
	state.recovered.set(`${spaceId}:${epoch}`, { at: now, keys, lost });
	while (state.recovered.size > OUTLINE_LIVE_SOCKET_BOUNDS.recoveredSessions) {
		const oldest = state.recovered.keys().next().value;
		if (oldest === undefined) break;
		state.recovered.delete(oldest);
	}
}

function fresh(createdAt: string): boolean {
	return Date.now() - Date.parse(createdAt) <= OUTLINE_LIVE_SOCKET_BOUNDS.recoveredMs;
}

/** Record an ended session's client positions (memory and log). In the space's lane. */
async function recordEnded(
	spaceId: string,
	epoch: number,
	keys: Map<string, number>,
	/** Text of clients' transactions the session did not take and had not told them of. */
	lost: LostByKey = new Map(),
): Promise<void> {
	if (keys.size === 0) return;
	cacheRecovered(spaceId, epoch, keys, lost);
	try {
		const rows = (
			await outlineStore.listLiveLog(spaceId, ENDED_EPOCH, {
				limit: 2 * OUTLINE_LIVE_SOCKET_BOUNDS.endedPerSpace,
			})
		)
			.filter((r) => r.seq !== epoch && fresh(r.createdAt))
			.sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))
			.slice(0, OUTLINE_LIVE_SOCKET_BOUNDS.endedPerSpace - 1);
		rows.push({
			spaceId,
			epoch: ENDED_EPOCH,
			seq: epoch,
			updateB64: Buffer.from(
				JSON.stringify({
					k: Object.fromEntries(keys),
					...(lost.size > 0 ? { x: Object.fromEntries(lost) } : {}),
				}),
			).toString("base64"),
			actorKind: "system",
			actorId: LIVE_SYNC_ACTOR,
			createdAt: new Date().toISOString(),
		});
		rows.sort((x, y) => x.seq - y.seq);
		await outlineStore.replaceLiveLog(spaceId, ENDED_EPOCH, rows);
	} catch (error) {
		logger.warn("Outline live session end could not be recorded", {
			spaceId,
			error: String(error),
		});
	}
}

/**
 * Of a client's earlier session of a space (now ended): its transactions the space has, and
 * what of them was not taken that it was never told of.
 */
async function endedTx(
	spaceId: string,
	head: LiveJoinHead,
): Promise<{ tx: number | undefined; lost: LiveLostWire[] } | undefined> {
	const epoch = head.resume?.epoch;
	if (epoch === undefined || epoch <= ENDED_EPOCH) return undefined;
	const entry = state.recovered.get(`${spaceId}:${epoch}`);
	if (entry && Date.now() - entry.at <= OUTLINE_LIVE_SOCKET_BOUNDS.recoveredMs)
		return { tx: entry.keys.get(head.key), lost: entry.lost.get(head.key) ?? [] };
	const [row] = await outlineStore.listLiveLog(spaceId, ENDED_EPOCH, {
		afterSeq: epoch - 1,
		limit: 1,
	});
	if (!row || row.seq !== epoch || !fresh(row.createdAt)) return undefined;
	try {
		const parsed = JSON.parse(Buffer.from(row.updateB64, "base64").toString("utf8")) as {
			k?: Record<string, number>;
			x?: Record<string, LiveLostWire[]>;
		};
		const keys = new Map(
			Object.entries(parsed.k ?? {}).filter(([, tx]) => Number.isSafeInteger(tx)),
		);
		const lost: LostByKey = new Map(
			Object.entries(parsed.x ?? {}).filter(([, list]) => Array.isArray(list)),
		);
		cacheRecovered(spaceId, epoch, keys, lost);
		return { tx: keys.get(head.key), lost: lost.get(head.key) ?? [] };
	} catch {
		return undefined;
	}
}

/** Drop the ended-session rows of a space that are past keeping (the startup job). */
async function pruneEnded(spaceId: string): Promise<void> {
	const rows = await outlineStore.listLiveLog(spaceId, ENDED_EPOCH, {
		limit: 2 * OUTLINE_LIVE_SOCKET_BOUNDS.endedPerSpace,
	});
	const keep = rows.filter((r) => fresh(r.createdAt));
	if (keep.length === rows.length) return;
	if (keep.length === 0) await outlineStore.deleteLiveLog(spaceId, ENDED_EPOCH);
	else await outlineStore.replaceLiveLog(spaceId, ENDED_EPOCH, keep);
}

/** A rate-limited warning (a misbehaving client must not flood the log). */
function warnRarely(message: string, fields: Record<string, unknown>): void {
	if (Date.now() - state.warned < 60_000) return;
	state.warned = Date.now();
	logger.warn(message, fields);
}

function takeJoinToken(socket: LiveSocket): boolean {
	const now = liveNow();
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

function watchCount(): number {
	let n = 0;
	for (const s of state.sessions.values()) n += s.scopes.size;
	return n;
}

function loadedBlocks(): number {
	let n = 0;
	for (const s of state.sessions.values()) n += s.loadedBlocks;
	return n;
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
	liveTimeout(() => {
		const lane = state.lanes.get(spaceId);
		if (lane && !lane.busy && !state.sessions.has(spaceId)) {
			state.lanes.delete(spaceId);
			state.pending.delete(spaceId);
		}
	}, 0);
}

/** Push commits recorded for the space into its sessions (runs after every lane task). */
async function drainCommits(spaceId: string): Promise<void> {
	const list = state.pending.get(spaceId);
	if (!list || list.length === 0) return;
	state.pending.delete(spaceId);
	const session = state.sessions.get(spaceId);
	if (!session || session.closed) return;
	await session.applyCommits(list);
	// An outside write merged into the live text is logged right away.
	await session.persistNow();
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
		const session = state.sessions.get(spaceId);
		if (session && !session.closed && !(await session.flushContent()))
			throw new OutlineBusyError(spaceId, 1);
		return await fn();
	});
}

setOutlineLiveBarrier({ run: runBehindBarrier, holds: holdsLane });

// ─────────────────────────────────────────────────────────────────────────────
// Joining and leaving
// ─────────────────────────────────────────────────────────────────────────────

/** Tell a socket a join failed. Never throws. */
function sendClosed(socket: LiveSocket, handle: number, code: LiveCloseCode, j?: number): void {
	try {
		socket.send(
			encodeLiveFrame({
				kind: LIVE_FRAME.closed,
				handle,
				head: j === undefined ? { code } : { code, j },
			}),
		);
	} catch {
		// Nothing to tell a socket that cannot take a frame.
	}
}

/** The space a person may read, and whether they may write it. Null when not (or not there). */
async function authorize(
	socket: LiveSocket,
	spaceId: string,
): Promise<{ space: OutlineSpaceRow; canWrite: boolean } | null> {
	if (!socket.userId) return null;
	const space = await outlineStore.getSpace(spaceId);
	if (!space) return null;
	const principal = { userId: socket.userId, isAdmin: socket.isAdmin };
	if (!(await canReadSpace(principal, space))) return null;
	return { space, canWrite: await canWriteSpace(principal, space) };
}

function validJoinHead(head: unknown): LiveJoinHead | null {
	const h = head as Partial<LiveJoinHead> | null;
	// A space that is not there (an empty id included) is refused like one the person may not
	// read: `access_denied`, from `authorize`.
	if (!h || typeof h.space !== "string" || h.space.length > 128) return null;
	if (
		!Array.isArray(h.watch) ||
		h.watch.length === 0 ||
		h.watch.length > OUTLINE_LIVE_LIMITS.maxWatch ||
		!h.watch.every(isLiveWatch)
	)
		return null;
	if (h.mode !== "edit" && h.mode !== "view") return null;
	if (typeof h.key !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(h.key)) return null;
	const r = h.resume;
	if (
		r !== undefined &&
		(!r ||
			!Number.isSafeInteger(r.epoch) ||
			!Number.isSafeInteger(r.op) ||
			!Number.isSafeInteger(r.tx) ||
			(r.reset !== undefined && typeof r.reset !== "boolean") ||
			(r.g !== undefined && (!Number.isSafeInteger(r.g) || r.g < 0)))
	)
		return null;
	if (h.j !== undefined && (!Number.isSafeInteger(h.j) || h.j < 0)) return null;
	return h as LiveJoinHead;
}

/**
 * Open the session of a space, replaying any log a previous session left. In the lane. A log
 * whose text cannot be committed is taken over by the new session (the levels holding that
 * text are loaded into it, people see the text and it is committed with theirs); a log that
 * cannot be read is left for an operator. Neither keeps the space from being edited.
 */
async function openSession(space: OutlineSpaceRow): Promise<LiveSpace> {
	const existing = state.sessions.get(space.id);
	if (existing && !existing.closed) return existing;
	const adopted: Array<{ epoch: number; changes: RecoveredChange[] }> = [];
	let after = { spaceId: space.id, epoch: 0 };
	for (let replayed = 0; replayed < OUTLINE_LIVE_SOCKET_BOUNDS.replayPerOpen; ) {
		const epochs = await outlineStore.listLiveLogEpochs({ after, limit: 8 });
		const mine = epochs.filter((e) => e.spaceId === space.id);
		for (const e of mine) {
			after = e;
			replayed++;
			const tag = `${space.id}:${e.epoch}`;
			if (state.unreadable.has(tag)) continue;
			const r = await replayLiveEpochDetailed(space.id, e.epoch);
			if (r.outcome !== "kept" || r.changes || r.partial)
				await recordEnded(space.id, e.epoch, r.keys, r.lost);
			if (r.outcome !== "kept") continue;
			if (r.changes) adopted.push({ epoch: e.epoch, changes: r.changes });
			else state.unreadable.add(tag);
		}
		if (mine.length < 8) break;
	}
	const lane = laneFor(space.id);
	const opened = new LiveSpace(
		space.id,
		(task) => void lane.run(task),
		(session, code, idle) => void lane.run(() => closeSession(session, code, idle)),
		// What the process may still load: checked with the size of the tree just read.
		() => OUTLINE_LIVE_SOCKET_BOUNDS.processBlocks - loadedBlocks(),
	);
	state.sessions.set(space.id, opened);
	state.spaces.set(space.id, space);
	if (adopted.length > 0) {
		// The blocks of the text taken over are loaded: the level each is in (or, past the
		// bound, its own subtree), unloaded again once it is committed and nobody watches them; a
		// block that cannot be loaded keeps its log for the next open.
		const ids = adopted.flatMap((a) => a.changes.map((c) => c.id));
		const byParent = new Map<string | null, string[]>();
		for (let at = 0; at < ids.length; at += 200)
			for (const m of await outlineStore.getBlockMetas(space.id, { ids: ids.slice(at, at + 200) }))
				if (!m.deleted) byParent.set(m.parentId, [...(byParent.get(m.parentId) ?? []), m.id]);
		let all = true;
		const loaded: LiveView[] = [];
		for (const [parentId, blocks] of byParent) {
			const level = await opened.ensureView({ l: parentId });
			if (!("refused" in level)) {
				loaded.push(level);
				continue;
			}
			for (const id of blocks) {
				const own = await opened.ensureView({ s: id });
				if ("refused" in own) all = false;
				else loaded.push(own);
			}
		}
		for (const view of loaded) if (view.participants.size === 0) view.armIdle();
		for (const a of adopted) opened.adoptRecovered(a.changes);
		// Once this session's log holds the text, the old one can go.
		if (all && (await opened.persistNow())) {
			for (const a of adopted) await outlineStore.deleteLiveLog(space.id, a.epoch);
		}
	}
	return opened;
}

/** Close one space's session (commit everything, end its participants). In its lane. */
async function closeSession(session: LiveSpace, code: LiveCloseCode, idle = false): Promise<void> {
	// Someone joined during the idle period.
	if (idle && session.participants.size > 0) return;
	if (session.closed && state.sessions.get(session.spaceId) !== session) return;
	for (const bindings of state.sockets.values()) {
		for (const [handle, binding] of [...bindings])
			if (binding.space === session) bindings.delete(handle);
	}
	await session.close(code);
	await recordEnded(
		session.spaceId,
		session.epoch,
		session.durableKeys(session.closedClean),
		session.lostUntold,
	);
	if (state.sessions.get(session.spaceId) === session) state.sessions.delete(session.spaceId);
	retireLane(session.spaceId);
}

/** A `join` frame. */
export async function joinLive(socket: LiveSocket, frame: LiveFrame): Promise<void> {
	const handle = frame.handle;
	// The join's number, said back with a refusal (`LiveJoinHead.j`).
	const rawJ = (frame.head as { j?: unknown } | null)?.j;
	const j = Number.isSafeInteger(rawJ) && (rawJ as number) >= 0 ? (rawJ as number) : undefined;
	// A handle no frame can carry cannot be answered either: ignored.
	if (!isLiveHandle(handle)) {
		warnRarely("Outline live join with an invalid handle ignored", { handle });
		return;
	}
	// A client of another protocol version (a page loaded before an upgrade) cannot be served
	// and is told so. What it does then is its own code's doing: this version's client keeps
	// what was typed for the person and asks for a reload (`live-client.ts`, `OutlineSurface`).
	const named = frame.head as { v?: unknown; page?: unknown; space?: unknown } | null;
	if (
		handle !== 0 &&
		named?.v !== OUTLINE_LIVE_PROTOCOL_VERSION &&
		(typeof named?.page === "string" || typeof named?.space === "string")
	)
		return sendClosed(socket, handle, "outdated", j);
	const head = validJoinHead(frame.head);
	if (!head || handle === 0) return sendClosed(socket, handle, "unavailable", j);
	if (!isOutlineEnabled()) return sendClosed(socket, handle, "unavailable", j);
	if (!takeJoinToken(socket)) return sendClosed(socket, handle, "unavailable", j);
	let bindings = state.sockets.get(socket);
	// Joining again on a handle (a resync, a resume) replaces what was there.
	const previous = bindings?.get(handle);
	if (previous) {
		bindings?.delete(handle);
		const prior = previous;
		void laneFor(prior.space.spaceId).run(() => prior.space.leave(prior.participant));
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
		return sendClosed(socket, handle, "unavailable", j);
	joining.add(handle);
	try {
		let verdict: Awaited<ReturnType<typeof authorize>> = null;
		let checked = 0;
		for (;;) {
			checked = state.accessEpoch;
			verdict = await authorize(socket, head.space);
			if (checked === state.accessEpoch) break;
		}
		if (!verdict) return sendClosed(socket, handle, "access_denied", j);
		const space = verdict.space;
		let canWrite = verdict.canWrite;
		const result = await laneFor(space.id).run(async () => {
			if (!isOutlineEnabled()) return { refused: "unavailable" as LiveCloseCode };
			// Access changed while the join waited for the lane: ask again (the re-check of
			// joined participants never saw this one).
			while (checked !== state.accessEpoch) {
				checked = state.accessEpoch;
				const again = await authorize(socket, head.space);
				if (!again || again.space.id !== space.id)
					return { refused: "access_denied" as LiveCloseCode };
				canWrite = again.canWrite;
			}
			if (socket.closed) return { refused: "ended" as LiveCloseCode };
			const session = await openSession(space);
			// Watches that would have to be loaded: the process's bounds first.
			const fresh = head.watch.filter((w) => !session.scopes.has(liveWatchKey(w))).length;
			if (fresh > 0 && watchCount() + fresh > OUTLINE_LIVE_LIMITS.liveWatches) {
				if (session.scopes.size === 0 && session.participants.size === 0)
					await closeSession(session, "ended", true);
				return { refused: "unavailable" as LiveCloseCode };
			}
			const ended =
				head.resume && head.resume.epoch !== session.epoch
					? await endedTx(space.id, head)
					: undefined;
			const joined = await session.join(
				socket,
				handle,
				head,
				frame.body,
				head.mode === "edit" && canWrite,
				ended?.tx,
				ended?.lost,
			);
			if ("refused" in joined) {
				// A session opened for a join that came to nothing does not stay.
				if (session.scopes.size === 0 && session.participants.size === 0)
					await closeSession(session, "ended", true);
				return joined;
			}
			return { space: session, participant: joined };
		});
		if ("refused" in result) return sendClosed(socket, handle, result.refused, j);
		if (socket.closed) {
			// The socket closed while the join ran.
			void laneFor(space.id).run(() => result.space.leave(result.participant));
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
		sendClosed(socket, handle, "unavailable", j);
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
	const { space: live, participant } = binding;
	switch (frame.kind) {
		case LIVE_FRAME.leave:
			state.sockets.get(socket)?.delete(frame.handle);
			void laneFor(live.spaceId).run(() => live.leave(participant));
			break;
		case LIVE_FRAME.update:
		case LIVE_FRAME.tx: {
			// Refused participants' frames are dropped and viewers' answered, without queueing.
			if (participant.blocked) break;
			if (!participant.canWrite) {
				live.refuseFrame(participant, frame.n);
				break;
			}
			const size = frame.body.length + 256;
			if (participant.queuedBytes + size > OUTLINE_LIVE_SOCKET_BOUNDS.queuedBytes) {
				warnRarely("Outline live participant queued too much; dismissed", {
					spaceId: live.spaceId,
					bytes: participant.queuedBytes,
				});
				state.sockets.get(socket)?.delete(frame.handle);
				void laneFor(live.spaceId).run(() => live.dismiss(participant, "unavailable"));
				break;
			}
			participant.queuedBytes += size;
			// The socket's buffer may be reused once this returns.
			const body = frame.body.slice();
			const head = frame.head;
			const n = frame.n;
			const kind = frame.kind;
			void laneFor(live.spaceId).run(async () => {
				participant.queuedBytes -= size;
				if (kind === LIVE_FRAME.update) live.handleUpdate(participant, n, body);
				else await live.handleTx(participant, n, head, body);
			});
			break;
		}
		case LIVE_FRAME.selection:
			live.setSelection(participant, (frame.head as LivePresenceUp | null)?.s ?? null);
			break;
		case LIVE_FRAME.watch: {
			// Refused participants' frames are dropped: their rejoin names the whole set.
			if (participant.blocked) break;
			const head = frame.head;
			if (watchCount() >= OUTLINE_LIVE_LIMITS.liveWatches) {
				const add = (head as { add?: unknown } | null)?.add;
				const w = (head as { w?: unknown } | null)?.w;
				if (Array.isArray(add) && add.length > 0 && Number.isSafeInteger(w)) {
					try {
						socket.send(
							encodeLiveFrame({
								kind: LIVE_FRAME.watched,
								handle: frame.handle,
								head: {
									w,
									refused: add.filter(isLiveWatch).map((x) => [x, "unavailable"]),
								},
							}),
						);
					} catch {
						// The socket is gone.
					}
					break;
				}
			}
			void laneFor(live.spaceId).run(() => live.handleWatch(participant, head));
			break;
		}
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
	for (const { space: live, participant } of bindings.values()) {
		void laneFor(live.spaceId).run(() => live.leave(participant));
	}
}

/** The socket drained: participants that fell behind are told to rejoin. */
export function drainLiveSocket(socket: LiveSocket): void {
	for (const { space: live, participant } of state.sockets.get(socket)?.values() ?? []) {
		live.onDrain(participant);
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
			const space = state.spaces.get(binding.space.spaceId);
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
			const { space: live, participant } = binding;
			if (!read) {
				bindings.delete(handle);
				void laneFor(live.spaceId).run(() => live.dismiss(participant, "access_denied"));
			} else {
				void laneFor(live.spaceId).run(() =>
					live.setWrite(participant, participant.wantsEdit && write),
				);
			}
		}
	}
}

function scheduleReauth(filter: ReauthFilter): void {
	state.accessEpoch++;
	state.reauthFilters.push(filter);
	if (!state.reauthTimer) {
		state.reauthTimer = liveTimeout(() => void reauthorize(), OUTLINE_LIVE_TIMING.broadcastMs);
	}
}

/** Re-check the participants an access change may affect (exported for tests). */
export function onOutlineLiveAccessEvent(event: NarraForkEvent): void {
	// Who may see an agent's name can change with any of these (P2 PR 10b).
	if (
		event.type === "narrator:access_changed" ||
		event.type === "project:access_changed" ||
		event.type === "auth:changed"
	)
		for (const session of state.sessions.values())
			for (const view of session.scopes.values()) view.agentAccessChanged();
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
		sessions.map((live) => laneFor(live.spaceId).run(() => closeSession(live, code))),
	);
}

/**
 * Write every session's pending log rows now and acknowledge them (shutdown, before the
 * sockets close).
 */
export async function persistAllLiveSessions(): Promise<void> {
	await Promise.all(
		[...state.sessions.values()].map(async (live) => {
			await live.persistNow();
			live.flushBroadcast();
		}),
	);
}

/**
 * The log table of before a space had one session (`outline_live_updates`) is not read any
 * more. Rows in it are what a crash right before the upgrade left uncommitted (a clean shutdown
 * leaves none): said once at startup, with how many (counted up to a bound), so an operator
 * knows text may be in there. The table and this warning go with the page-keyed storage (X2).
 */
async function warnOfLegacyLog(): Promise<void> {
	try {
		const rows = await outlineStore.countLegacyLiveUpdates(1001);
		if (rows > 0)
			logger.warn(
				"Outline: outline_live_updates holds rows of live sessions that ended without committing before the upgrade; they are not replayed",
				{ rows: rows > 1000 ? "more than 1000" : rows },
			);
	} catch (error) {
		logger.warn("Outline legacy live log could not be counted", { error: String(error) });
	}
}

/**
 * Replay what earlier sessions left in the log (the startup job). One run per process; later
 * calls return the same promise.
 */
export function startLiveReplay(): Promise<unknown> {
	if (!state.replayDone) void warnOfLegacyLog();
	state.replayDone ??= replayAllLiveEpochs(
		(spaceId, epoch) => state.sessions.get(spaceId)?.epoch === epoch,
		async (spaceId, epoch) => {
			const run = async () => {
				if (epoch === ENDED_EPOCH) {
					await pruneEnded(spaceId);
					return "empty" as const;
				}
				const r = await replayLiveEpochDetailed(spaceId, epoch);
				if (r.outcome !== "kept" || r.changes || r.partial)
					await recordEnded(spaceId, epoch, r.keys, r.lost);
				return r.outcome;
			};
			// Always in the space's lane: a join opening the space replays in it too, so the two
			// never replay one epoch at once. An open session took the log over already.
			const lane = laneFor(spaceId);
			try {
				return await lane.run(async () =>
					state.sessions.get(spaceId) && epoch !== ENDED_EPOCH ? ("empty" as const) : await run(),
				);
			} finally {
				retireLane(spaceId);
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

/**
 * Counts for tests and diagnostics. `sessions` counts the watches loaded (what a session was
 * before L2: a page's tree), `spaces` the sessions themselves.
 */
export function outlineLiveStats(): {
	sessions: number;
	spaces: number;
	lanes: number;
	sockets: number;
	participants: number;
	loadedBlocks: number;
	documents: number;
} {
	let participants = 0;
	let documents = 0;
	for (const s of state.sessions.values()) {
		participants += s.participants.size;
		documents += s.textDocs;
	}
	return {
		sessions: watchCount(),
		spaces: state.sessions.size,
		lanes: state.lanes.size,
		sockets: state.sockets.size,
		participants,
		loadedBlocks: loadedBlocks(),
		documents,
	};
}

/** Whether nothing is queued in any lane or waiting to be broadcast (tests). */
export function outlineLiveQuiet(): boolean {
	for (const lane of state.lanes.values()) if (lane.busy) return false;
	for (const s of state.sessions.values()) if (!s.quiet) return false;
	return true;
}

/** Drop the session of a block's space as if the process had died (tests of the replay). */
export function abandonLiveSessionForTests(rootId: string): void {
	const session = liveSessionOf(rootId)?.space;
	if (!session) return;
	session.abandon();
	state.sessions.delete(session.spaceId);
	for (const bindings of state.sockets.values()) {
		for (const [handle, binding] of [...bindings])
			if (binding.space === session) bindings.delete(handle);
	}
	retireLane(session.spaceId);
}

/** Forget the in-memory copy of ended sessions' client positions, as a new process (tests). */
export function forgetEndedSessionsForTests(): void {
	state.recovered.clear();
}

/** The watch of a block's subtree in its space's session, if loaded (tests and diagnostics). */
export function liveSessionOf(rootId: string): LiveView | undefined {
	for (const session of state.sessions.values()) {
		const view = session.scopes.get(liveWatchKey({ s: rootId }));
		if (view) return view;
	}
	return undefined;
}

/** The session of a space, if one is open (tests and diagnostics). */
export function liveSpaceOf(spaceId: string): LiveSpace | undefined {
	return state.sessions.get(spaceId);
}

/** Run `fn` in a space's lane (tests). */
export function runInLane<T>(spaceId: string, fn: () => Promise<T> | T): Promise<T> {
	return laneFor(spaceId).run(fn);
}

/**
 * A narrator's run started or ended: the watches whose agents may change with it work them out
 * again (agent presence, P2 PR 10b: only running sessions are shown).
 */
function onNarratorStatus(
	event: Extract<NarraForkEvent, { type: "narrator:status_changed" }>,
): void {
	for (const session of state.sessions.values())
		for (const view of session.scopes.values())
			if (view.agentInterest.has(event.narratorId)) view.requestAgents();
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

if (hotOnce("narrafork.outlineLive.agentListeners")) {
	eventBus.on("narrator:status_changed", onNarratorStatus);
}
