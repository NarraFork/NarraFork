/**
 * "Is this NarraFork instance completely quiet right now?"
 *
 * This is the single question unattended mode needs answered before it may power a machine
 * off, so it is answered conservatively and from authoritative sources only:
 *
 *   - In-memory runtime state for narrators. `narrators.status` in the database explicitly
 *     "can lag behind reality" (see `narrator-session-state.ts`), so it is reported for
 *     diagnosis but never used to decide. A stale `working` row must not keep a machine on
 *     forever, and — more importantly — must not be trusted in the other direction either.
 *   - The update coordinator's execution counters, which are the same numbers the update
 *     pipeline uses to decide that an instance has drained.
 *   - Bounded existence probes for durable queues. Only deliveries that represent work a live
 *     session will actually pick up count (see `readDurableQueues` for the exact predicate):
 *     `task_notice` rows and archived sessions' leftovers are inert by design and must not
 *     block a shutdown forever.
 *
 * Anything unexpected (a probe throwing, a missing PostgreSQL runtime) resolves to
 * `unknown: true`, which callers treat as BLOCKED. Never power off on uncertainty.
 */

import { compactLocks, listRuntimeBusyNarratorIds } from "./narrator-session-state";
import { getUpdateCoordinationStatus } from "./update-coordinator";

/** Bounded diagnostics: enough to name the work, never the whole table. */
const BLOCKER_ID_LIMIT = 5;

export interface UnattendedExecutionBlockers {
	backgroundBash: number;
	ordinary: number;
	responses: number;
	preAdmission: number;
	toolStartGrants: number;
	pausedTools: number;
}

export interface UnattendedBlockers {
	/** Busy narrators, decided from runtime state (not the DB status column). */
	narrators: { count: number; ids: string[] };
	/** In-flight context compactions; the loop is not running but the session is still writing. */
	compacting: number;
	executions: UnattendedExecutionBlockers;
	/** An update/restart/shutdown is already scheduled; never race the lifecycle machinery. */
	maintenance: boolean;
	queuedDeliveries: boolean;
	backgroundTasks: boolean;
	/** Informational only — a stale `reserved` row must not block a power-off forever. */
	pendingPublications: boolean;
	/** A scheduled task fires inside the quiet window, so work is still coming. */
	dueScheduledTasks: boolean;
	/** Informational: DB rows that claim to be busy but have no runtime owner. */
	dbWorkingNarrators: number;
	unknown: boolean;
	error?: string;
}

export interface UnattendedProbeInput {
	/** How far ahead a scheduled run counts as "work is coming" (the quiet window). */
	dueWithinMs: number;
}

/** A conservative boolean: every field either means "work exists" or is informational. */
export function isBlocked(report: UnattendedBlockers): boolean {
	return (
		report.unknown ||
		report.narrators.count > 0 ||
		report.compacting > 0 ||
		report.maintenance ||
		report.executions.backgroundBash > 0 ||
		report.executions.ordinary > 0 ||
		report.executions.responses > 0 ||
		report.executions.preAdmission > 0 ||
		report.executions.toolStartGrants > 0 ||
		report.executions.pausedTools > 0 ||
		report.queuedDeliveries ||
		report.backgroundTasks ||
		report.dueScheduledTasks
	);
}

/** A fresh, all-clear report. Also the value the watcher exposes while nothing is armed. */
export function emptyUnattendedBlockers(): UnattendedBlockers {
	return {
		narrators: { count: 0, ids: [] },
		compacting: 0,
		executions: {
			backgroundBash: 0,
			ordinary: 0,
			responses: 0,
			preAdmission: 0,
			toolStartGrants: 0,
			pausedTools: 0,
		},
		maintenance: false,
		queuedDeliveries: false,
		backgroundTasks: false,
		pendingPublications: false,
		dueScheduledTasks: false,
		dbWorkingNarrators: 0,
		unknown: false,
	};
}

function readRuntime(report: UnattendedBlockers): void {
	let compacting = 0;
	try {
		// Compact locks are separate from the loop: a compaction writes messages while the
		// loop is parked, and its continuation may start a new turn immediately after.
		compacting = compactLocks.size;
	} catch {
		compacting = 0;
	}
	// Enumerate every authority that can hold a narrator, not just live sessions: a pending
	// permission, a loop-less runtime claim or an admission lease keeps a narrator busy with
	// no `activeNarrators` entry at all.
	const busy = listRuntimeBusyNarratorIds();
	report.narrators = { count: busy.length, ids: busy.slice(0, BLOCKER_ID_LIMIT) };
	report.compacting = compacting;
	const coordination = getUpdateCoordinationStatus();
	report.maintenance = coordination.scheduled;
	report.executions = {
		backgroundBash: coordination.pendingBackgroundBashCount,
		ordinary: coordination.pendingOrdinaryExecutionCount,
		responses: coordination.activeResponseCount,
		preAdmission: coordination.pendingPreAdmissionCount,
		toolStartGrants: coordination.pendingToolStartGrantCount,
		pausedTools: coordination.pausedToolCount,
	};
}

/**
 * One SQL text for both engines. Columns are snake_case in both schemas and `?` is the
 * placeholder the PostgreSQL adapter rewrites (see `context-composition-history.ts`).
 */
type Query = { get<T>(sql: string, bindings: readonly unknown[]): Promise<T | null> };

async function openQuery(): Promise<Query> {
	const database = await import("../db");
	if (database.activeDatabaseBackend === "postgres") {
		const runtime = database.postgresRuntime;
		if (!runtime) throw new Error("PostgreSQL runtime is not connected");
		const { postgresContextQuery } = await import("./context-composition-history");
		return postgresContextQuery(runtime.client.sql) as unknown as Query;
	}
	const { sqliteContextQuery } = await import("./context-composition-history");
	return sqliteContextQuery(database.sqlite) as unknown as Query;
}

async function hit(query: Query, sql: string, bindings: readonly unknown[] = []): Promise<boolean> {
	const row = await query.get<{ hit?: number }>(sql, bindings);
	return row?.hit != null;
}

async function readDurableQueues(report: UnattendedBlockers, input: UnattendedProbeInput) {
	const query = await openQuery();
	// Only deliveries that will actually be executed count:
	//  - `user_input` / `agent_message` start or continue a turn;
	//  - `queued` / `claimed` are pending or in flight; `failed` is terminal and needs a
	//    human retry, so it must never hold the machine on (same rule the outbox follows);
	//  - `task_notice` is consumed only by a loop that is ALREADY running (nothing wakes an
	//    idle narrator for it), so it is passive — the coordinator counters and the busy
	//    narrator check cover its producing run;
	//  - archived sessions never run again, so their leftovers are inert.
	report.queuedDeliveries = await hit(
		query,
		`SELECT 1 AS hit FROM narrator_buffered_messages m
		   JOIN narrators n ON n.id = m.narrator_id
		  WHERE m.state IN ('queued','claimed')
		    AND m.kind IN ('user_input','agent_message')
		    AND n.status <> 'archived'
		  LIMIT 1`,
	);
	report.backgroundTasks = await hit(
		query,
		`SELECT 1 AS hit FROM background_tasks
		  WHERE status IN ('running','paused') LIMIT 1`,
	);
	report.pendingPublications = await hit(
		query,
		`SELECT 1 AS hit FROM runtime_publication_outbox
		  WHERE state IN ('reserved','pending') LIMIT 1`,
	);
	report.dueScheduledTasks = await hit(
		query,
		`SELECT 1 AS hit FROM scheduled_tasks
		  WHERE enabled = ? AND next_run_at IS NOT NULL AND next_run_at <= ? LIMIT 1`,
		[true, new Date(Date.now() + Math.max(0, input.dueWithinMs)).toISOString()],
	);
	const working = await query.get<{ c?: number }>(
		`SELECT COUNT(*) AS c FROM narrators WHERE status IN ('working','waiting')`,
		[],
	);
	report.dbWorkingNarrators = Number(working?.c ?? 0);
}

/** Probe the instance. Never throws: a failure is reported as `unknown`. */
export async function probeUnattendedIdle(
	input: UnattendedProbeInput,
): Promise<UnattendedBlockers> {
	const report = emptyUnattendedBlockers();
	try {
		await readDurableQueues(report, input);
	} catch (error) {
		report.unknown = true;
		report.error = `database: ${error instanceof Error ? error.message : String(error)}`;
		return report;
	}
	try {
		readRuntime(report);
	} catch (error) {
		report.unknown = true;
		report.error = `runtime: ${error instanceof Error ? error.message : String(error)}`;
	}
	return report;
}
