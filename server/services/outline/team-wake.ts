/**
 * How often team events may wake one session (outline P2 PR 10a, design §D.2 「限流」, §7.2): at
 * most {@link OUTLINE_TEAM_WAKE_LIMITS.perWindow} wakes in any
 * {@link OUTLINE_TEAM_WAKE_LIMITS.windowMs}, per session, counted over a sliding window. The
 * producers (team events `team-events.ts`, PR 7's answers `questions.ts`) write their row either
 * way; only the wake is counted.
 *
 * A wake that finds no room is not lost: the row is written without one, and the session gets ONE
 * later wake when the window has room again ({@link wakeForTeam} returns `deferred`). A session
 * has at most one such timer, however many rows wait: they are all in its history, and the turn
 * that wake starts reads them together. The later wake is asked through the callback given with
 * the LAST deferral, which decides for itself whether a wake is still due (the session may have
 * run meanwhile and read the rows).
 *
 * Memory only, O(1) per call: a process that restarts starts with empty windows (the startup
 * re-push of `team-events.ts` wakes what a crash cut off, through this same limit). At most
 * {@link OUTLINE_TEAM_WAKE_LIMITS.sessions} sessions are remembered; one with no wake in the
 * window and no timer is forgotten.
 */
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";

export const OUTLINE_TEAM_WAKE_LIMITS = {
	/** Wakes one session takes in a window. */
	perWindow: 6,
	windowMs: 60_000,
	/** Sessions remembered at most. */
	sessions: 2000,
} as const;

interface WakeState {
	/** When its wakes of the current window were taken (ms), oldest first. */
	taken: number[];
	/** The later wake waiting for room, with how to cancel its timer. */
	deferred: { wake: () => Promise<boolean>; cancel: () => void } | null;
}

/** The clock and the timer: a seam tests replace. */
export interface OutlineTeamWakeClock {
	now(): number;
	/** Run `fn` after `ms`; returns how to cancel it. */
	after(ms: number, fn: () => void): () => void;
}

const realClock: OutlineTeamWakeClock = {
	now: () => Date.now(),
	after(ms, fn) {
		const timer = setTimeout(fn, ms);
		// A waiting wake never keeps the process alive.
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};

const state = hotSafe("narrafork.outlineTeamWake.state", () => ({
	sessions: new Map<string, WakeState>(),
	clock: realClock,
}));

/** Replace the clock (tests); null restores the real one. Returns the previous. */
export function setOutlineTeamWakeClock(next: OutlineTeamWakeClock | null): OutlineTeamWakeClock {
	const previous = state.clock;
	state.clock = next ?? realClock;
	return previous;
}

/** Forget every window and cancel every waiting wake (tests). */
export function resetOutlineTeamWakeForTests(): void {
	for (const session of state.sessions.values()) session.deferred?.cancel();
	state.sessions.clear();
}

function live(session: WakeState, now: number): number[] {
	const from = now - OUTLINE_TEAM_WAKE_LIMITS.windowMs;
	while (session.taken.length > 0 && (session.taken[0] as number) <= from) session.taken.shift();
	return session.taken;
}

function sessionOf(narratorId: string, now: number): WakeState {
	let session = state.sessions.get(narratorId);
	if (session) return session;
	if (state.sessions.size >= OUTLINE_TEAM_WAKE_LIMITS.sessions) {
		// Room for a new session: forget those with nothing to remember.
		for (const [id, other] of state.sessions) {
			if (other.deferred === null && live(other, now).length === 0) state.sessions.delete(id);
		}
		// Still full (thousands of sessions woken within a minute): the oldest entry goes.
		if (state.sessions.size >= OUTLINE_TEAM_WAKE_LIMITS.sessions) {
			const [oldest] = state.sessions.keys();
			if (oldest !== undefined) {
				state.sessions.get(oldest)?.deferred?.cancel();
				state.sessions.delete(oldest);
			}
		}
	}
	session = { taken: [], deferred: null };
	state.sessions.set(narratorId, session);
	return session;
}

/**
 * Take one wake of the session's window: true when there was room. A session with a wake waiting
 * for room gets no other before it (the waiting one is first in line).
 */
export function takeTeamWake(narratorId: string): boolean {
	const now = state.clock.now();
	const session = sessionOf(narratorId, now);
	if (session.deferred !== null) return false;
	if (live(session, now).length >= OUTLINE_TEAM_WAKE_LIMITS.perWindow) return false;
	session.taken.push(now);
	return true;
}

/** Take back the wake taken at `at`: it started nothing. */
function giveBack(narratorId: string, at: number | undefined): void {
	const taken = state.sessions.get(narratorId)?.taken;
	if (!taken || at === undefined) return;
	const index = taken.lastIndexOf(at);
	if (index >= 0) taken.splice(index, 1);
}

/** How many wakes the session has left in the window now (tests, logs). */
export function teamWakesLeft(narratorId: string): number {
	const session = state.sessions.get(narratorId);
	if (!session) return OUTLINE_TEAM_WAKE_LIMITS.perWindow;
	return Math.max(0, OUTLINE_TEAM_WAKE_LIMITS.perWindow - live(session, state.clock.now()).length);
}

/** Whether a later wake of the session waits for room. */
export function hasDeferredTeamWake(narratorId: string): boolean {
	return state.sessions.get(narratorId)?.deferred != null;
}

function arm(narratorId: string, session: WakeState, wake: () => Promise<boolean>): void {
	session.deferred?.cancel();
	const now = state.clock.now();
	const taken = live(session, now);
	const oldest = taken[0];
	// Room again when the oldest wake of the window leaves it.
	const wait =
		taken.length < OUTLINE_TEAM_WAKE_LIMITS.perWindow || oldest === undefined
			? 0
			: Math.max(1, oldest + OUTLINE_TEAM_WAKE_LIMITS.windowMs - now + 1);
	const cancel = state.clock.after(wait, () => {
		const current = state.sessions.get(narratorId);
		if (current !== session || session.deferred === null) return;
		const due = session.deferred.wake;
		session.deferred = null;
		const at = state.clock.now();
		if (live(session, at).length >= OUTLINE_TEAM_WAKE_LIMITS.perWindow) {
			// Not yet (the clock ran early): wait again.
			arm(narratorId, session, due);
			return;
		}
		session.taken.push(at);
		void due()
			.then((woke) => {
				if (!woke) giveBack(narratorId, at);
			})
			.catch((error) => {
				giveBack(narratorId, at);
				logger.warn("A deferred team wake failed", { narratorId, error: String(error) });
			});
	});
	session.deferred = { wake, cancel };
}

/**
 * Wake the session for a team event: now when its window has room (`wake` is called, its result
 * returned as `woke`), or once later when it has not (`deferred`). The later wake is `later`
 * (default: `wake`), which replaces the one already waiting, and is called when there is room.
 * Both return whether a turn was started.
 */
export async function wakeForTeam(
	narratorId: string,
	wake: () => Promise<boolean>,
	later: () => Promise<boolean> = wake,
): Promise<{ woke: boolean; deferred: boolean }> {
	if (takeTeamWake(narratorId)) {
		const at = state.sessions.get(narratorId)?.taken.at(-1);
		const woke = await wake().catch((error) => {
			logger.warn("A team wake failed", { narratorId, error: String(error) });
			return false;
		});
		// A wake that started nothing (the session is running, or may not be started) is not
		// counted: the limit is on turns started.
		if (!woke) giveBack(narratorId, at);
		return { woke, deferred: false };
	}
	const session = sessionOf(narratorId, state.clock.now());
	arm(narratorId, session, later);
	return { woke: false, deferred: true };
}
