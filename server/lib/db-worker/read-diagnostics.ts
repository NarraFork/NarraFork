import { logger } from "../logger";
import type { DbReadTaskParams } from "./protocol";
import { type HostSqlDiagnosticState, sqlDiagnosticSnapshot } from "./sql-diagnostics";

export interface ReadPoolTaskDiagnostics {
	kind: DbReadTaskParams["kind"];
	source:
		| "auth.session"
		| "knowledge.keyword-signature"
		| "narrator.request-recording"
		| "narrator.message-language"
		| "narrator.tool-detail"
		| "unattributed";
	requestId?: string;
	startedAt: number;
	dispatchedAt?: number;
	sql?: HostSqlDiagnosticState;
}
export function readPoolDiagnosticSource(source: unknown): ReadPoolTaskDiagnostics["source"] {
	return source === "auth.session" ||
		source === "knowledge.keyword-signature" ||
		source === "narrator.request-recording" ||
		source === "narrator.message-language" ||
		source === "narrator.tool-detail"
		? source
		: "unattributed";
}
function taskAge(now: number, since: number | undefined): number | null {
	return typeof since === "number" && Number.isFinite(since)
		? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(now - since)))
		: null;
}
export function readPoolTaskSnapshot(
	task: ReadPoolTaskDiagnostics | undefined,
	now: number,
	since: number | undefined,
	requestId = task?.requestId,
) {
	return {
		kind: task?.kind,
		source: readPoolDiagnosticSource(task?.source),
		...(typeof requestId === "string" && /^[A-Za-z0-9_-]{21}$/.test(requestId)
			? { requestId }
			: {}),
		ageMs: taskAge(now, since),
		...(task?.sql ? { sql: sqlDiagnosticSnapshot(task.sql, now) } : {}),
	};
}

const WINDOW_MS = 10_000;
const MAX_LOGS = 5;
interface DiagnosticRateLimit {
	windowStartedAt: number;
	count: number;
	suppressed: number;
}
const sqlRateLimit: DiagnosticRateLimit = { windowStartedAt: 0, count: 0, suppressed: 0 };
/** Separate from admission/timeout evidence. No timer and no work when the session is absent. */
export function logReadSqlDiagnostic(
	phase:
		| "dispatch"
		| "sql-start"
		| "sql-end"
		| "coverage-lost"
		| "finish"
		| "close-start"
		| "close-complete",
	task: ReadPoolTaskDiagnostics | undefined,
	closeDurationMs?: number,
): void {
	if (!task?.sql) return;
	try {
		const now = Date.now();
		if (now - sqlRateLimit.windowStartedAt >= WINDOW_MS || now < sqlRateLimit.windowStartedAt) {
			sqlRateLimit.windowStartedAt = now;
			sqlRateLimit.count = 0;
		}
		if (sqlRateLimit.count >= 20) {
			sqlRateLimit.suppressed = Math.min(Number.MAX_SAFE_INTEGER, sqlRateLimit.suppressed + 1);
			task.sql.logSuppressed = Math.min(Number.MAX_SAFE_INTEGER, task.sql.logSuppressed + 1);
			return;
		}
		sqlRateLimit.count++;
		logger.warn("Database read worker SQL diagnostic", {
			phase,
			...readPoolTaskSnapshot(task, now, task.dispatchedAt ?? task.startedAt),
			...(closeDurationMs !== undefined ? { closeDurationMs } : {}),
			rateLimitWindowMs: WINDOW_MS,
			rateLimitMaxLogs: 20,
			suppressedSinceLastLog: sqlRateLimit.suppressed,
		});
		sqlRateLimit.suppressed = 0;
	} catch {
		// Logging must not affect SQLite delivery, cancellation, permits or exit confirmation.
	}
}

const failureLimits = new Map<string, DiagnosticRateLimit>();
export function warnReadPoolFailure(
	task: ReadPoolTaskDiagnostics,
	code: string,
	stats: { queued: number; queuedBytes: number; workers: number; active: number; starting: number },
) {
	try {
		const now = Date.now();
		let limit = failureLimits.get(code);
		if (!limit || now - limit.windowStartedAt >= WINDOW_MS || now < limit.windowStartedAt) {
			limit = { windowStartedAt: now, count: 0, suppressed: limit?.suppressed ?? 0 };
			failureLimits.set(code, limit);
		}
		if (limit.count >= MAX_LOGS) {
			limit.suppressed = Math.min(Number.MAX_SAFE_INTEGER, limit.suppressed + 1);
			return;
		}
		limit.count++;
		logger.warn(
			code === "TASK_QUEUE_TIMEOUT"
				? "Database read task timed out"
				: "Database read queue admission rejected",
			{
				...readPoolTaskSnapshot(task, now, task.startedAt),
				phase: task.dispatchedAt === undefined ? "queued" : "running",
				code,
				queued: stats.queued,
				queuedBytes: stats.queuedBytes,
				workers: stats.workers,
				busy: stats.active - stats.starting,
				pendingSpawns: stats.starting,
				rateLimitWindowMs: WINDOW_MS,
				rateLimitMaxLogs: MAX_LOGS,
				suppressedSinceLastLog: limit.suppressed,
			},
		);
		limit.suppressed = 0;
	} catch {
		/* diagnostics cannot affect admission or settlement */
	}
}
