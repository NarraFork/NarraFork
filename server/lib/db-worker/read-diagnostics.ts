import { logger } from "../logger";
import { DOMAIN_READ_DEFINITIONS, type DomainReadTaskKind } from "./domain-protocol";
import { DbReadError } from "./errors";
import {
	type DbReadTaskParams,
	SELECT_ROWS_MAX_PARAMS,
	SELECT_ROWS_MAX_PARAMS_BYTES,
	SELECT_ROWS_MAX_ROWS,
	SELECT_ROWS_MAX_SQL_BYTES,
} from "./protocol";
import type { ReadBudgetMeter, ReadBudgetSnapshot } from "./read-budget";
import { type HostSqlDiagnosticState, sqlDiagnosticSnapshot } from "./sql-diagnostics";

/** Host-only cancellation context. This snapshot never enters worker messages or error properties. */
export interface DbReadAbortDiagnostics {
	readonly taskId?: string;
	readonly kind: DbReadTaskParams["kind"];
	readonly domainTask?: DomainReadTaskKind;
	readonly phase: "admission" | "acquiring" | "queued" | "dispatching" | "running";
}
const taskKinds = {
	benchmarkRead: true,
	compactSummary: true,
	publicationTerminalResult: true,
	executionPolicyFacts: true,
	toolEditPreview: true,
	knowledgeEntryDetail: true,
	recallToolCall: true,
	recallConversation: true,
	revertSelectionBody: true,
	subagentActivity: true,
	databaseCleanupContext: true,
	storageScanContext: true,
	storageScanTables: true,
	storageScanSerial: true,
	storageScanCleanupSummaries: true,
	storageScanSessionPreview: true,
	selectRows: true,
	selectDigestBatch: true,
	selectValues: true,
	selectChunks: true,
	domainRead: true,
	displayPageMessages: true,
	displayPageMessagesPostgres: true,
	blockBackfillSlice: true,
	blockVerifySlice: true,
	blockReindexSlice: true,
	blockIndexQueueSlice: true,
	blockProjectionSlice: true,
	storageHistoryRead: true,
	storageHistoryBody: true,
} satisfies Record<string, true>;
export function isTaskKind(value: unknown): value is DbReadTaskParams["kind"] {
	return typeof value === "string" && Object.hasOwn(taskKinds, value);
}
const abortPhases = new Set<DbReadAbortDiagnostics["phase"]>([
	"admission",
	"acquiring",
	"queued",
	"dispatching",
	"running",
]);
const abortDiagnostics = new WeakMap<DbReadError, DbReadAbortDiagnostics>();

/** Keep the first actual execution's immutable, allowlisted context when callers share an error. */
export function attachDbReadAbortDiagnostics(error: unknown, input: DbReadAbortDiagnostics): void {
	try {
		if (
			!(error instanceof DbReadError) ||
			error.code !== "DB_READ_ABORTED" ||
			abortDiagnostics.has(error)
		)
			return;
		const { kind, phase, taskId, domainTask } = input;
		if (!isTaskKind(kind) || !abortPhases.has(phase)) return;
		abortDiagnostics.set(
			error,
			Object.freeze({
				kind,
				phase,
				...(typeof taskId === "string" && /^dbr-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/.test(taskId)
					? { taskId }
					: {}),
				...(kind === "domainRead" &&
				typeof domainTask === "string" &&
				Object.hasOwn(DOMAIN_READ_DEFINITIONS, domainTask)
					? { domainTask }
					: {}),
			}),
		);
	} catch {
		// Diagnostics must never replace the original exception, even for malformed host metadata.
	}
}

export function getDbReadAbortDiagnostics(error: unknown): DbReadAbortDiagnostics | undefined {
	try {
		return error instanceof DbReadError && error.code === "DB_READ_ABORTED"
			? abortDiagnostics.get(error)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Pool pressure diagnostics retain only these fixed labels, never caller text or query content. */
export type ReadPoolDiagnosticSource =
	| "auth.session"
	| "knowledge.keyword-signature"
	| "execution-policy-facts"
	| "narrator.request-recording"
	| "narrator.message-language"
	| "narrator.tool-detail"
	| "unattributed";
export interface ReadPoolTaskLabels {
	kind: DbReadTaskParams["kind"] | "unattributed";
	source: ReadPoolDiagnosticSource;
	domainTask?: DomainReadTaskKind;
}
export interface ReadPoolTaskDiagnostics extends ReadPoolTaskLabels {
	requestId?: string;
	startedAt: number;
	queuedAt?: number;
	dispatchedAt?: number;
	taskClass?: "normal" | "short";
	shortSource?: "auth-session" | "readerProbe";
	queueReason?: "capacity" | "key" | "active-bytes";
	/** Present only for the opt-in worker SQL session; no query text or secret. */
	sql?: HostSqlDiagnosticState;
}
export function readPoolDiagnosticSource(source: unknown): ReadPoolDiagnosticSource {
	return source === "auth.session" ||
		source === "knowledge.keyword-signature" ||
		source === "execution-policy-facts" ||
		source === "narrator.request-recording" ||
		source === "narrator.message-language" ||
		source === "narrator.tool-detail"
		? source
		: "unattributed";
}
export function readPoolTaskLabels(
	params: { kind?: unknown; task?: unknown } | undefined,
	options?: { diagnosticSource?: unknown },
): ReadPoolTaskLabels {
	const labels: ReadPoolTaskLabels = { kind: "unattributed", source: "unattributed" };
	try {
		const kind = params?.kind;
		if (isTaskKind(kind)) labels.kind = kind;
		const domainTask = kind === "domainRead" ? params?.task : undefined;
		if (typeof domainTask === "string" && Object.hasOwn(DOMAIN_READ_DEFINITIONS, domainTask))
			labels.domainTask = domainTask as DomainReadTaskKind;
	} catch {
		// Host metadata is optional, including when a caller supplies throwing getters.
	}
	try {
		labels.source = readPoolDiagnosticSource(options?.diagnosticSource);
	} catch {
		// A failed label lookup cannot affect task admission.
	}
	return labels;
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
		...readPoolTaskLabels(
			{ kind: task?.kind, task: task?.domainTask },
			{ diagnosticSource: task?.source },
		),
		...(typeof requestId === "string" &&
		(/^[A-Za-z0-9_-]{21}$/.test(requestId) || /^dbr-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/.test(requestId))
			? { requestId }
			: {}),
		...(task?.taskClass === "normal" || task?.taskClass === "short"
			? { taskClass: task.taskClass }
			: {}),
		...(task?.shortSource === "auth-session" || task?.shortSource === "readerProbe"
			? { shortSource: task.shortSource }
			: {}),
		...(task?.queueReason ? { queueReason: task.queueReason } : {}),
		ageMs: taskAge(now, since),
		...(task?.sql ? { sql: sqlDiagnosticSnapshot(task.sql, now) } : {}),
	};
}

const WINDOW_MS = 10_000;
const MAX_LOGS = 5;
const SOURCE_BYTES = 256;
const STACK_BYTES = 4096;
interface DiagnosticRateLimit {
	windowStartedAt: number;
	count: number;
	suppressed: number;
}
const diagnosticRateLimit: DiagnosticRateLimit = { windowStartedAt: 0, count: 0, suppressed: 0 };
// Queue rejection bursts must not consume the timeout evidence budget.
const timeoutRateLimit: DiagnosticRateLimit = { windowStartedAt: 0, count: 0, suppressed: 0 };
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
export interface ReadTaskDiagnostics {
	meter: ReadBudgetMeter;
	requestId?: string;
	partial: boolean;
	/** An explicit logical owner accounts for postprocessed rows/results and emits the final log. */
	observedRows?: number;
	observedBytes?: number;
	sqlTemplate?: { text: string; truncated: boolean };
}
export function boundedReadLogText(value: string, maxBytes: number) {
	const prefix = value.slice(0, maxBytes);
	const bytes = Buffer.from(prefix);
	let end = Math.min(bytes.length, maxBytes);
	while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
	return {
		text: bytes.subarray(0, end).toString(),
		truncated: end < bytes.length || prefix.length < value.length,
	};
}
function writeDiagnostic(
	message: string,
	fields: () => Record<string, unknown>,
	limit = diagnosticRateLimit,
): void {
	try {
		const now = Date.now();
		if (now - limit.windowStartedAt >= WINDOW_MS || now < limit.windowStartedAt) {
			limit.windowStartedAt = now;
			limit.count = 0;
		}
		if (limit.count >= MAX_LOGS) {
			limit.suppressed = Math.min(limit.suppressed + 1, Number.MAX_SAFE_INTEGER);
			return;
		}
		limit.count++;
		logger.warn(message, {
			...fields(),
			rateLimitWindowMs: WINDOW_MS,
			rateLimitMaxLogs: MAX_LOGS,
			suppressedSinceLastLog: limit.suppressed,
		});
		limit.suppressed = 0;
	} catch {
		// Observability must not change execution, rejection, cancellation or cleanup.
	}
}
function sourceFields(source: string) {
	const bounded = boundedReadLogText(source, SOURCE_BYTES);
	return { source: bounded.text, sourceTruncated: bounded.truncated, sourceMaxBytes: SOURCE_BYTES };
}
/** At most 64 KiB across all SQL templates, including digest batches. No binds are inspected here. */
function sqlFields(params: DbReadTaskParams): Record<string, unknown> {
	if ("sql" in params) {
		const query = boundedReadLogText(params.sql, SELECT_ROWS_MAX_SQL_BYTES);
		return { sql: query.text, sqlTruncated: query.truncated };
	}
	if (params.kind !== "selectDigestBatch") return {};
	const examples: string[] = [];
	let remaining = SELECT_ROWS_MAX_SQL_BYTES;
	let truncated = false;
	for (const entry of params.entries) {
		if (examples.length >= 3 || remaining <= 0) {
			truncated = true;
			break;
		}
		const query = boundedReadLogText(entry.query, remaining);
		examples.push(query.text);
		remaining -= Buffer.byteLength(query.text);
		truncated ||= query.truncated;
	}
	return { sqlTemplates: examples, sqlTruncated: truncated };
}
export function warnReadQueryRejected(
	error: DbReadError,
	sql: string,
	binds: readonly unknown[],
	options: { diagnosticSource?: string; maxRows?: number } = {},
): void {
	writeDiagnostic("Database read query rejected", () => {
		const query = boundedReadLogText(sql, SELECT_ROWS_MAX_SQL_BYTES);
		const stack = boundedReadLogText(error.stack ?? "", STACK_BYTES);
		return {
			code: error.code,
			sql: query.text,
			sqlTruncated: query.truncated,
			sqlBytes: Buffer.byteLength(sql),
			sqlMaxBytes: SELECT_ROWS_MAX_SQL_BYTES,
			parameterCount: binds.length,
			maxParameters: SELECT_ROWS_MAX_PARAMS,
			parameterMaxBytes: SELECT_ROWS_MAX_PARAMS_BYTES,
			maxRows: options.maxRows ?? SELECT_ROWS_MAX_ROWS,
			maxRowsBudget: SELECT_ROWS_MAX_ROWS,
			...sourceFields(options.diagnosticSource ?? "unspecified"),
			stack: stack.text,
			stackTruncated: stack.truncated,
			stackMaxBytes: STACK_BYTES,
		};
	});
}
/** Admission-only snapshot: no SQL, binds, database identity or caller-owned labels. */
export function warnReadQueueFull(
	input: {
		reason: "count" | "bytes" | "normal-count" | "normal-bytes";
		taskClass?: "normal" | "short";
		reservedCapacity?: number;
		normalCapacity?: number;
		normalMaxQueued?: number;
		normalMaxQueuedBytes?: number;
		activeByClass?: { normal: number; short: number };
		queuedByClass?: { normal: number; short: number };
		queuedBytesByClass?: { normal: number; short: number };
		reservation?: unknown;
		taskKind: ReadPoolTaskLabels["kind"];
		queued: number;
		queuedBytes: number;
		incomingBytes: number;
		maxQueued: number;
		maxQueuedBytes: number;
		workers: number;
		busy: number;
		retiring: number;
		pendingSpawns: number;
		concurrency: number;
	},
	/** Evaluated only after rate limiting; the pool owns and bounds every field. */
	snapshot?: () => Record<string, unknown>,
): void {
	writeDiagnostic("Database read queue admission rejected", () => ({
		reason: input.reason,
		taskKind: input.taskKind,
		queued: input.queued,
		queuedBytes: input.queuedBytes,
		incomingBytes: input.incomingBytes,
		maxQueued: input.maxQueued,
		maxQueuedBytes: input.maxQueuedBytes,
		workers: input.workers,
		busy: input.busy,
		retiring: input.retiring,
		pendingSpawns: input.pendingSpawns,
		concurrency: input.concurrency,
		...(input.taskClass
			? {
					taskClass: input.taskClass,
					reservedCapacity: input.reservedCapacity,
					normalCapacity: input.normalCapacity,
					normalMaxQueued: input.normalMaxQueued,
					normalMaxQueuedBytes: input.normalMaxQueuedBytes,
					activeByClass: input.activeByClass,
					queuedByClass: input.queuedByClass,
					queuedBytesByClass: input.queuedBytesByClass,
					reservation: input.reservation,
				}
			: {}),
		...snapshot?.(),
	}));
}

/** Separate, bounded evidence for pool-owned deadlines; no native error text, paths or stacks. */
export function warnReadPoolTaskTimeout(
	task: ReadPoolTaskDiagnostics,
	phase: DbReadAbortDiagnostics["phase"],
): void {
	writeDiagnostic(
		"Database read task timed out",
		() => {
			const now = Date.now();
			return {
				code: "DB_READ_TASK_TIMEOUT",
				phase,
				...readPoolTaskSnapshot(task, now, task.startedAt),
				runningAgeMs: taskAge(now, task.dispatchedAt),
				...(phase === "queued" ? { queuedAgeMs: taskAge(now, task.queuedAt) } : {}),
			};
		},
		timeoutRateLimit,
	);
}

export function warnReadBudgetExceeded(input: {
	snapshot: ReadBudgetSnapshot;
	params?: DbReadTaskParams;
	sqlTemplate?: { text: string; truncated: boolean };
	source?: string;
	task: string;
	requestId?: string;
	elapsedMs: number;
	partial: boolean;
	status: "completed" | "failed";
	code?: string;
}): void {
	const exceeded = input.snapshot.filter((item) => item.actual > item.threshold);
	if (!exceeded.length) return;
	writeDiagnostic("Database read observation threshold exceeded", () => ({
		...sourceFields(input.source ?? input.task),
		task: input.task,
		requestId: input.requestId,
		...(input.params
			? sqlFields(input.params)
			: input.sqlTemplate
				? { sql: input.sqlTemplate.text, sqlTruncated: input.sqlTemplate.truncated }
				: {}),
		exceeded,
		metrics: Object.fromEntries(input.snapshot.map((item) => [item.kind, item.actual])),
		elapsedMs: input.elapsedMs,
		partial: input.partial,
		status: input.status,
		code: input.code,
	}));
}
