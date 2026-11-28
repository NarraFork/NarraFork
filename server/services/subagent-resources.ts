/**
 * What a subagent's terminals and browser sessions become when it is done (Project Teams S2).
 *
 * - **Archived or deleted**: every running terminal it created and every browser session it
 *   launched is closed. Nobody can drive an archived subagent, so nothing it left running has
 *   an owner any more.
 * - **A run ends** (foreground or background) with no pending work: the browser sessions open
 *   at that moment are closed. Pending work is a helper still working or waiting, or input
 *   already queued for it (a Send that will start its next run). A run that was stopped or
 *   timed out closes them despite its helpers (they are being stopped too). Never while the
 *   subagent is already busy again: a newer run owns it, its status is working or waiting, or
 *   one of its launches is opening (re-checked synchronously right before closing). Terminals
 *   stay: a dev server or REPL a worker started is meant to outlive one turn, and the subagent
 *   can be told to use it again.
 *
 * Why browsers close at the end of a run rather than only at archive: a subagent between runs
 * is idle until someone sends it more work, possibly never, and every open session holds a
 * Chrome tab against the subagent, team and process caps (`agent-resource-caps.ts`). A
 * follow-up run relaunches in a moment; a tab left open would otherwise sit until its
 * inactivity TTL (10 minutes by default, up to a day) blocking another agent's launch.
 *
 * Primary narrators are never touched here. Every function is best-effort and never throws:
 * archive, delete and run finalization must not fail because a PTY or a tab would not close.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db";
import { narrators, terminals } from "../db/schema";
import { logger } from "../lib/logger";

/** More running terminals than the per-subagent cap can only come from before the cap. */
const TERMINAL_CLOSE_LIMIT = 50;

async function isSubagent(narratorId: string): Promise<boolean> {
	const row = await db
		.select({ type: narrators.type })
		.from(narrators)
		.where(eq(narrators.id, narratorId))
		.get();
	return row?.type === "subagent";
}

async function closeBrowserSessions(narratorId: string): Promise<number> {
	const { cleanupNarrator, listSessions } = await import("../lib/browser/session");
	const open = listSessions(narratorId).length;
	if (open > 0) await cleanupNarrator(narratorId);
	return open;
}

async function closeTerminals(narratorId: string): Promise<number> {
	const running = await db
		.select({ id: terminals.id })
		.from(terminals)
		.where(
			and(
				eq(terminals.narratorId, narratorId),
				eq(terminals.status, "running"),
				isNull(terminals.worktreeResourceId),
			),
		)
		.limit(TERMINAL_CLOSE_LIMIT)
		.all();
	if (running.length === 0) return 0;
	const { terminalService } = await import("./terminal-service");
	let closed = 0;
	for (const terminal of running) {
		try {
			await terminalService.kill(terminal.id);
			closed++;
		} catch (error) {
			logger.warn("Failed to close a subagent's terminal", {
				narratorId,
				terminalId: terminal.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return closed;
}

/** Close a subagent's running terminals and browser sessions (archive and delete). */
export async function closeSubagentResources(
	narratorId: string,
): Promise<{ terminals: number; browserSessions: number }> {
	const none = { terminals: 0, browserSessions: 0 };
	try {
		if (!(await isSubagent(narratorId))) return none;
		const [closedTerminals, closedSessions] = await Promise.all([
			closeTerminals(narratorId).catch(() => 0),
			closeBrowserSessions(narratorId).catch(() => 0),
		]);
		if (closedTerminals || closedSessions)
			logger.info("Closed a retired subagent's terminals and browser sessions", {
				narratorId,
				terminals: closedTerminals,
				browserSessions: closedSessions,
			});
		return { terminals: closedTerminals, browserSessions: closedSessions };
	} catch (error) {
		logger.warn("Failed to close a retired subagent's resources", {
			narratorId,
			error: error instanceof Error ? error.message : String(error),
		});
		return none;
	}
}

/** Whether a subagent still has work under way that may want its browser. */
async function hasPendingWork(narratorId: string): Promise<boolean> {
	const helper = await db
		.select({ id: narrators.id })
		.from(narrators)
		.where(
			and(
				eq(narrators.parentNarratorId, narratorId),
				eq(narrators.type, "subagent"),
				inArray(narrators.status, ["working", "waiting"]),
			),
		)
		.limit(1)
		.get();
	if (helper) return true;
	const { hasInboxKind } = await import("./agent-runtime/inbox");
	return hasInboxKind(narratorId, ["user_input", "agent_message"]);
}

/**
 * Whether something else is already driving the subagent: a newer run or loop owns its
 * execution (a Send that arrived while the old run was finishing), or one of its browser
 * launches is still opening. Synchronous, so it can be the last check before closing.
 */
function busyAfterRun(
	narratorId: string,
	finishedRun: unknown,
	ownership: typeof import("./agent-runtime/ownership"),
	caps: typeof import("./agent-resource-caps"),
): boolean {
	const owner = ownership.getExecutionOwner(narratorId);
	if (owner && ownership.getRunControl(narratorId) !== finishedRun) return true;
	return caps.hasPendingBrowserLaunch(narratorId);
}

/**
 * A subagent's run ended: close its browser sessions unless work is pending (see the file
 * header). `stopped` is a run that was cancelled or timed out; `run` is the finishing run's
 * control, so a newer run is told apart from it.
 *
 * Only the sessions open when the run ended are closed, and only if, right before closing,
 * no newer run owns the subagent, its status is not working or waiting, and no launch is in
 * flight: a Send that starts the next run while this one is finishing keeps its tabs.
 */
export async function releaseSubagentBrowsersAtRunEnd(
	narratorId: string,
	options: { stopped: boolean; run?: unknown },
): Promise<number> {
	try {
		const session = await import("../lib/browser/session");
		const atEnd = session.listSessions(narratorId).map(({ id }) => id);
		if (atEnd.length === 0) return 0;
		const [ownership, caps] = await Promise.all([
			import("./agent-runtime/ownership"),
			import("./agent-resource-caps"),
		]);
		if (busyAfterRun(narratorId, options.run, ownership, caps)) return 0;
		const row = await db
			.select({ type: narrators.type, status: narrators.status })
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.get();
		if (row?.type !== "subagent") return 0;
		if (row.status === "working" || row.status === "waiting") return 0;
		if (!options.stopped && (await hasPendingWork(narratorId))) return 0;
		// Last check, with no await before the closes start.
		if (busyAfterRun(narratorId, options.run, ownership, caps)) return 0;
		const closed = await Promise.all(
			atEnd.map((id) => session.closeSession(narratorId, id).catch(() => false)),
		);
		return closed.filter(Boolean).length;
	} catch (error) {
		logger.warn("Failed to close a subagent's browser sessions at the end of its run", {
			narratorId,
			error: error instanceof Error ? error.message : String(error),
		});
		return 0;
	}
}
