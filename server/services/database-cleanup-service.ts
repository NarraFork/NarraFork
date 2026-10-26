import { stat } from "node:fs/promises";
import { databaseMaintenance, sqlite } from "@server/db";
import { describeUnsupported, type ReusableSpaceReport } from "@server/db/backend";
import { getDbPath } from "@server/db/connection";
import {
	clearLegacyRequestDumpBatch,
	hasRetainedLegacyRequestDump,
} from "@server/db/legacy-request-storage";
import { AsyncMutex } from "@server/lib/async-mutex";
import {
	runEphemeralReadTask,
	runReadTask,
	shutdownDbWorkerPool,
	WorkersUnavailableError,
} from "@server/lib/db-worker/pool";
import {
	assertSessionPreviewBudget,
	SESSION_PREVIEW_MAX_SAMPLES,
	SessionPreviewBudgetError,
	type StorageScanCleanupSummariesParams,
	type StorageScanCleanupSummariesResult,
	type StorageScanSessionPreviewParams,
	type StorageScanSessionPreviewResult,
} from "@server/lib/db-worker/protocol";
import {
	type ParallelScanOutcome,
	runParallelObjectStorageScan,
} from "@server/lib/db-worker/storage-scan-runner";
import { AppError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import { narratorService } from "@server/services/narrator-service";
import {
	buildNarratorCleanupPlan,
	type CleanupPlanBlockedRoot,
	type CleanupPlanRoot,
	type DatabaseCleanupBlockedReasonCode,
	type DatabaseCleanupTarget,
	type NarratorCleanupPlan,
	type NarratorCleanupRecord,
} from "./database-cleanup-utils";
// Storage-scan query primitives live in a DB-singleton-free module so the read worker can import
// them without re-bootstrapping the database. See storage-scan-queries.ts for why that matters.
import {
	type DatabaseStorageCategoryKey,
	type DatabaseStorageCategorySummary,
	type DatabaseStorageReadFailures,
	type DatabaseStorageTableSummary,
	type DatabaseTableKind,
	getDatabaseStorageCategory,
	numberFromRow,
	type SessionOwnedTableRelation,
	summarizeToolCallPayloads,
} from "./storage-scan-queries";

export type {
	DatabaseCleanupBlockedReasonCode,
	DatabaseCleanupTarget,
	DatabaseStorageCategoryKey,
	DatabaseStorageCategorySummary,
	DatabaseStorageReadFailures,
	DatabaseStorageTableSummary,
	DatabaseTableKind,
};
export { getDatabaseStorageCategory };

export const DEFAULT_STALE_SESSION_DAYS = 90;
/**
 * Retention default for tool-call payloads.
 *
 * Long because these payloads are what the execution
 * log shows; 180 days keeps a couple of release cycles of history readable while
 * still bounding a table measured at 561k rows / 6.6 GB.
 */
export const DEFAULT_TOOL_CALL_PAYLOAD_DAYS = 180;
const DEFAULT_PREVIEW_SAMPLE_LIMIT = 10;
const DATABASE_MAINTENANCE_LOCK_KEY = "database-maintenance";
/** Rows per legacy dump batch. Each row may hold megabytes, so batches stay small. */
const LEGACY_REQUEST_DUMP_BATCH_ROWS = 32;
/**
 * Set once this process cleared every dump. The column stays until the next startup, and probing
 * an all-NULL column would read every row header on each storage scan.
 */
let legacyRequestDumpsCleared = false;

function legacyRequestDumpsRetained(): boolean {
	if (legacyRequestDumpsCleared) return false;
	return hasRetainedLegacyRequestDump(sqlite);
}
const databaseMaintenanceLock = new AsyncMutex();

const SESSION_OWNED_TABLES: SessionOwnedTableRelation[] = [
	{ tableName: "narrator_message_refs", alias: "r", narratorColumn: "narrator_id" },
	{
		tableName: "narrator_tool_calls",
		alias: "tc",
		narratorColumn: "narrator_id",
		countAs: "toolCalls",
	},
	{ tableName: "api_requests", alias: "ar", narratorColumn: "narrator_id", countAs: "apiRequests" },
	{ tableName: "terminal_view_state", alias: "tvs", narratorColumn: "narrator_id" },
	{ tableName: "terminals", alias: "t", narratorColumn: "narrator_id" },
	{ tableName: "narrator_buffered_messages", alias: "nbm", narratorColumn: "narrator_id" },
	{ tableName: "narrator_file_snapshots", alias: "nfs", narratorColumn: "narrator_id" },
	{ tableName: "narrator_patches", alias: "np", narratorColumn: "narrator_id" },
	{ tableName: "narrator_whitelist_dirs", alias: "nwd", narratorColumn: "narrator_id" },
	{ tableName: "narrator_blacklist_dirs", alias: "nbd", narratorColumn: "narrator_id" },
	{ tableName: "narrator_whitelist_cmds", alias: "nwc", narratorColumn: "narrator_id" },
	{ tableName: "narrator_blacklist_cmds", alias: "nbc", narratorColumn: "narrator_id" },
	{ tableName: "knowledge_pack_activations", alias: "kpa", narratorColumn: "narrator_id" },
	{ tableName: "gateway_session_mappings", alias: "gsm", narratorColumn: "narrator_id" },
];

interface DatabaseFileSizes {
	mainBytes: number;
	walBytes: number;
	shmBytes: number;
}

export interface DatabaseCleanupCandidateSummary {
	count: number;
	approxBytes: number;
	blockedCount: number;
	oldestAt: string | null;
	retentionDays?: number;
}

export interface DatabaseStorageBreakdown {
	mainBytes: number;
	walBytes: number;
	shmBytes: number;
	pageSize: number;
	pageCount: number;
	freelistBytes: number;
	objectBytes: number;
	scanMode: "dbstat" | "approximate";
	categories: DatabaseStorageCategorySummary[];
	topTables: DatabaseStorageTableSummary[];
	/** Non-zero when some tables could not be measured, so the report is incomplete. */
	readFailures: DatabaseStorageReadFailures;
	cleanupCandidates: {
		archivedSessions: DatabaseCleanupCandidateSummary;
		staleSessions: DatabaseCleanupCandidateSummary;
		toolCallPayloads: DatabaseCleanupCandidateSummary;
	};
	/** Request dumps kept by an upgrade that deferred migration 0207's column rewrites. */
	legacyRequestDumps: { retained: boolean };
}

/**
 * `statisticsUnavailable`: sizes and message/tool/request counts could not be measured (plan too
 * large for one read task, or no read worker), so they read 0. Session counts stay exact.
 */
export type DatabaseCleanupWarningCode = "deletesUsageHistory" | "statisticsUnavailable";

export interface DatabaseCleanupPreviewCounts {
	sessions: number;
	narrators: number;
	descendantNarrators: number;
	messages: number;
	toolCalls: number;
	apiRequests: number;
}

export interface DatabaseCleanupNarratorSample {
	type: "narrator";
	id: string;
	title: string | null;
	status: string;
	lastActivityAt: string;
	messageCount: number;
	descendantNarratorCount: number;
	approxBytes: number;
}

export interface DatabaseCleanupApiRequestSample {
	type: "apiRequest";
	id: string;
	narratorId: string | null;
	narratorTitle: string | null;
	createdAt: string;
	approxBytes: number;
}

export interface DatabaseCleanupBlockedItem {
	narratorId: string;
	title: string | null;
	lastActivityAt: string;
	reasonCode: DatabaseCleanupBlockedReasonCode;
	blockingNarratorId: string;
	blockingTitle: string | null;
	blockingStatus: string;
}

export interface DatabaseCleanupPreviewResult {
	target: DatabaseCleanupTarget;
	olderThanDays?: number;
	approxBytes: number;
	oldestAt: string | null;
	counts: DatabaseCleanupPreviewCounts;
	blockedCount: number;
	warningCodes: DatabaseCleanupWarningCode[];
	samples: Array<DatabaseCleanupNarratorSample | DatabaseCleanupApiRequestSample>;
	blocked: DatabaseCleanupBlockedItem[];
}

export interface DatabaseCleanupExecutionResult extends DatabaseCleanupPreviewResult {
	ok: true;
	beforeBytes: number;
	afterBytes: number;
	freedBytes: number;
	vacuumRan: boolean;
	changed: boolean;
	/** Planned sessions left in place because they changed (resumed, new child, ...) mid-cleanup. */
	skippedSessions: number;
}

export interface LegacyRequestDumpClearResult {
	ok: true;
	cleared: number;
	beforeBytes: number;
	afterBytes: number;
	/** The column drops run on the next startup, once no dump is retained. */
	restartRequired: boolean;
}

export interface DatabaseVacuumResult {
	ok: true;
	beforeBytes: number;
	afterBytes: number;
	freedBytes: number;
	freelistBeforeBytes: number;
	freelistAfterBytes: number;
	vacuumRan: boolean;
	checkpointRan: boolean;
	optimized: boolean;
	durationMs: number;
}

interface CleanupNarratorContext {
	narrators: NarratorCleanupRecord[];
	runningTerminalIds: Set<string>;
}

interface SessionPreviewData {
	preview: DatabaseCleanupPreviewResult;
	safeRoots: CleanupPlanRoot[];
}

interface SessionCleanupPlan {
	target: Extract<DatabaseCleanupTarget, "archivedSessions" | "staleSessions">;
	normalizedDays: number | undefined;
	staleCutoffIso: string | undefined;
	plan: NarratorCleanupPlan;
}

function minIso(values: Array<string | null | undefined>): string | null {
	let current: string | null = null;
	for (const value of values) {
		if (!value) continue;
		if (!current || value < current) current = value;
	}
	return current;
}

function getDefaultOlderThanDays(target: DatabaseCleanupTarget): number | undefined {
	if (target === "staleSessions") return DEFAULT_STALE_SESSION_DAYS;
	if (target === "toolCallPayloads") return DEFAULT_TOOL_CALL_PAYLOAD_DAYS;
	return undefined;
}

function getCutoffIso(days: number): string {
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function normalizePreviewDays(
	target: DatabaseCleanupTarget,
	olderThanDays?: number,
): number | undefined {
	if (target === "archivedSessions") return undefined;
	return olderThanDays ?? getDefaultOlderThanDays(target);
}

function toBlockedItem(blocked: CleanupPlanBlockedRoot): DatabaseCleanupBlockedItem {
	return {
		narratorId: blocked.narratorId,
		title: blocked.title,
		lastActivityAt: blocked.lastActivityAt,
		reasonCode: blocked.reasonCode,
		blockingNarratorId: blocked.blockingNarratorId,
		blockingTitle: blocked.blockingTitle,
		blockingStatus: blocked.blockingStatus,
	};
}

async function fileSizeOrZero(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}

async function getDatabaseFileSizes(): Promise<DatabaseFileSizes> {
	const dbPath = getDbPath();
	return {
		mainBytes: await fileSizeOrZero(dbPath),
		walBytes: await fileSizeOrZero(`${dbPath}-wal`),
		shmBytes: await fileSizeOrZero(`${dbPath}-shm`),
	};
}

function totalDatabaseBytes(sizes: DatabaseFileSizes): number {
	return sizes.mainBytes + sizes.walBytes + sizes.shmBytes;
}

// ── Shared-connection bindings ─────────────────────────────────────────────
// The query primitives are connection-agnostic (so the read worker can reuse them). These thin
// wrappers bind them to this process' shared read-write connection.

function normalizeNarratorCleanupRecord(row: Record<string, unknown>): NarratorCleanupRecord {
	let traits: string[] | null = null;
	if (row.traits != null) {
		try {
			const parsed = typeof row.traits === "string" ? JSON.parse(row.traits) : row.traits;
			traits = Array.isArray(parsed) ? parsed : null;
		} catch {
			traits = null;
		}
	}
	return {
		id: String(row.id ?? ""),
		parentNarratorId: row.parentNarratorId ? String(row.parentNarratorId) : null,
		type: String(row.type ?? "primary"),
		variant: String(row.variant ?? "primary"),
		traits,
		title: row.title ? String(row.title) : null,
		status: String(row.status ?? "idle"),
		messageCount: numberFromRow(row.messageCount),
		createdAt: String(row.createdAt ?? ""),
		updatedAt: String(row.updatedAt ?? ""),
		lastMessageAt: row.lastMessageAt ? String(row.lastMessageAt) : null,
		isBackground: numberFromRow(row.isBackground) === 1,
		backgroundStatus: row.backgroundStatus ? String(row.backgroundStatus) : null,
	};
}

const NARRATOR_CLEANUP_COLUMNS = `
	id,
	parent_narrator_id AS parentNarratorId,
	type,
	variant,
	traits,
	title,
	status,
	COALESCE(message_count, 0) AS messageCount,
	created_at AS createdAt,
	updated_at AS updatedAt,
	last_message_at AS lastMessageAt,
	COALESCE(is_background, 0) AS isBackground,
	background_status AS backgroundStatus`;

async function loadCleanupNarratorContext(): Promise<CleanupNarratorContext> {
	const narratorRows = sqlite
		.prepare(`SELECT ${NARRATOR_CLEANUP_COLUMNS} FROM narrators`)
		.all() as Record<string, unknown>[];
	const terminalRows = sqlite
		.prepare(
			`SELECT DISTINCT narrator_id AS narratorId
			 FROM terminals
			 WHERE status = 'running' AND narrator_id IS NOT NULL`,
		)
		.all() as Array<{ narratorId: string }>;
	return {
		narrators: narratorRows.map(normalizeNarratorCleanupRecord),
		runningTerminalIds: new Set(terminalRows.map((row) => row.narratorId)),
	};
}

/** One root's current subtree and its running terminals, via the parent index. */
function loadRootSubtreeContext(rootNarratorId: string): CleanupNarratorContext {
	const subtree = `WITH RECURSIVE subtree(id) AS (
		SELECT ? UNION SELECT n.id FROM narrators n JOIN subtree s ON n.parent_narrator_id = s.id
	)`;
	const narratorRows = sqlite
		.prepare(
			`${subtree} SELECT ${NARRATOR_CLEANUP_COLUMNS} FROM narrators
			 WHERE id IN (SELECT id FROM subtree)`,
		)
		.all(rootNarratorId) as Record<string, unknown>[];
	const terminalRows = sqlite
		.prepare(
			`${subtree} SELECT DISTINCT narrator_id AS narratorId FROM terminals
			 WHERE status = 'running' AND narrator_id IN (SELECT id FROM subtree)`,
		)
		.all(rootNarratorId) as Array<{ narratorId: string }>;
	return {
		narrators: narratorRows.map(normalizeNarratorCleanupRecord),
		runningTerminalIds: new Set(terminalRows.map((row) => row.narratorId)),
	};
}

/**
 * Whether a planned root would still be planned with the same subtree. Checked right before each
 * removal: measuring and every earlier removal yield the main thread, so a session may resume,
 * gain a child, start a terminal or see new activity in between.
 */
function isCleanupRootStillEligible(
	sessionPlan: SessionCleanupPlan,
	root: CleanupPlanRoot,
): boolean {
	const context = loadRootSubtreeContext(root.rootNarratorId);
	const [latest] = buildNarratorCleanupPlan(sessionPlan.target, context.narrators, {
		staleCutoffIso: sessionPlan.staleCutoffIso,
		runningTerminalIds: context.runningTerminalIds,
		rootNarratorIds: new Set([root.rootNarratorId]),
	}).safeRoots;
	if (!latest) return false;
	const expectedIds = new Set(root.deletedNarratorIds);
	return (
		latest.deletedNarratorIds.length === expectedIds.size &&
		latest.deletedNarratorIds.every((id) => expectedIds.has(id))
	);
}

/** Never scan payload columns on the HTTP/agent thread, even when both worker paths fail. */
async function runCleanupReadTask<T>(
	params: StorageScanCleanupSummariesParams | StorageScanSessionPreviewParams,
	signal?: AbortSignal,
): Promise<T> {
	if (params.kind === "storageScanSessionPreview") {
		try {
			assertSessionPreviewBudget(params);
		} catch (err) {
			if (err instanceof SessionPreviewBudgetError) {
				throw new AppError(err.message, 413, err.code);
			}
			throw err;
		}
	}
	const dbPath = getDbPath();
	try {
		return await runReadTask<T>(dbPath, params, { signal });
	} catch (err) {
		if (signal?.aborted) throw err;
		if (err instanceof WorkersUnavailableError && err.reason === "pool_shutdown") throw err;
		try {
			return await runEphemeralReadTask<T>(dbPath, params, { signal });
		} catch (ephemeralErr) {
			if (signal?.aborted) throw ephemeralErr;
			logger.warn("Database cleanup read workers unavailable", {
				task: params.kind,
				reason: ephemeralErr instanceof Error ? ephemeralErr.message : String(ephemeralErr),
			});
			throw new AppError(
				"Database cleanup statistics are unavailable: read workers failed",
				503,
				"DATABASE_CLEANUP_WORKERS_UNAVAILABLE",
			);
		}
	}
}

function planSessionCleanup(
	target: SessionCleanupPlan["target"],
	olderThanDays: number | undefined,
	context: CleanupNarratorContext,
): SessionCleanupPlan {
	const normalizedDays = normalizePreviewDays(target, olderThanDays);
	const staleCutoffIso =
		target === "staleSessions" && normalizedDays ? getCutoffIso(normalizedDays) : undefined;
	const plan = buildNarratorCleanupPlan(target, context.narrators, {
		staleCutoffIso,
		runningTerminalIds: context.runningTerminalIds,
	});
	return { target, normalizedDays, staleCutoffIso, plan };
}

/** Failures that only cost the byte/row statistics; the plan itself is still exact. */
function isStatisticsOnlyFailure(err: unknown): boolean {
	return (
		err instanceof AppError &&
		(err.code === "DATABASE_CLEANUP_PREVIEW_BUDGET_EXCEEDED" ||
			err.code === "DATABASE_CLEANUP_WORKERS_UNAVAILABLE")
	);
}

async function buildSessionPreview(
	sessionPlan: SessionCleanupPlan,
	sampleLimit = DEFAULT_PREVIEW_SAMPLE_LIMIT,
): Promise<SessionPreviewData> {
	const { target, normalizedDays, plan } = sessionPlan;
	const allNarratorIds = [...new Set(plan.safeRoots.flatMap((root) => root.deletedNarratorIds))];
	const limit = Math.min(SESSION_PREVIEW_MAX_SAMPLES, Math.max(0, sampleLimit));
	const limitedRoots = plan.safeRoots.slice(0, limit);
	let measured: StorageScanSessionPreviewResult | null = null;
	try {
		measured = await runCleanupReadTask<StorageScanSessionPreviewResult>({
			kind: "storageScanSessionPreview",
			narratorIds: allNarratorIds,
			sampleNarratorIds: limitedRoots.map((root) => root.deletedNarratorIds),
			relations: SESSION_OWNED_TABLES,
		});
	} catch (err) {
		if (!isStatisticsOnlyFailure(err)) throw err;
		logger.warn("Session cleanup statistics unavailable; plan counts only", {
			target,
			code: (err as AppError).code,
			narrators: allNarratorIds.length,
		});
	}
	const aggregate = measured?.aggregate ?? {
		narrators: allNarratorIds.length,
		messages: 0,
		toolCalls: 0,
		apiRequests: 0,
		approxBytes: 0,
	};
	const warningCodes: DatabaseCleanupWarningCode[] = [];
	if (plan.safeRoots.length > 0) warningCodes.push("deletesUsageHistory");
	if (!measured) warningCodes.push("statisticsUnavailable");
	const samples: DatabaseCleanupNarratorSample[] = limitedRoots.map((root, index) => ({
		type: "narrator",
		id: root.rootNarratorId,
		title: root.rootTitle,
		status: root.rootStatus,
		lastActivityAt: root.lastActivityAt,
		messageCount: root.rootMessageCount,
		descendantNarratorCount: root.descendantNarratorCount,
		approxBytes: measured?.sampleBytes[index] ?? 0,
	}));
	return {
		preview: {
			target,
			olderThanDays: normalizedDays,
			approxBytes: aggregate.approxBytes,
			oldestAt: minIso(plan.safeRoots.map((root) => root.lastActivityAt)),
			counts: {
				sessions: plan.safeRoots.length,
				narrators: aggregate.narrators,
				descendantNarrators: Math.max(0, aggregate.narrators - plan.safeRoots.length),
				messages: aggregate.messages,
				toolCalls: aggregate.toolCalls,
				apiRequests: aggregate.apiRequests,
			},
			blockedCount: plan.blockedRoots.length,
			warningCodes,
			samples,
			blocked: plan.blockedRoots.slice(0, limit).map(toBlockedItem),
		},
		safeRoots: plan.safeRoots,
	};
}

/**
 * Preview for clearing aged tool-call PAYLOADS.
 *
 * ⚠️ Nulls `input_json` / `output_json` and leaves the ROW in place. The rows are load-bearing well beyond the execution log:
 * `snapshot-revert` reads `tree_hash_before` off them to roll a workspace back, and
 * `file-state-rebuild` replays recorded Write/Edit inputs from checkpoint rows.
 * Deleting rows by age would silently disable file-history revert for older work —
 * a much worse trade than losing the ability to re-read an old command's output.
 *
 * Checkpoint rows (`is_file_history_checkpoint = 1`) are excluded outright: their
 * `input_json` IS the replay source, so clearing it destroys the reconstruction path
 * rather than merely a log entry.
 *
 * `created_at` rather than the `started_at` generated column: this is an age policy
 * about when the row was written, and `created_at` is non-null on every row
 * including those predating the lifecycle timestamps.
 */
async function buildToolCallPayloadPreview(
	olderThanDays = DEFAULT_TOOL_CALL_PAYLOAD_DAYS,
	sampleLimit = DEFAULT_PREVIEW_SAMPLE_LIMIT,
): Promise<DatabaseCleanupPreviewResult> {
	const cutoffIso = getCutoffIso(olderThanDays);
	const summary = summarizeToolCallPayloads(sqlite, cutoffIso);
	const samples = sqlite
		.prepare(
			`SELECT
			tc.id AS id,
			tc.narrator_id AS narratorId,
			n.title AS narratorTitle,
			tc.created_at AS createdAt,
			length(CAST(coalesce(tc.input_json, '') AS BLOB)) +
				length(CAST(coalesce(tc.output_json, '') AS BLOB)) AS approxBytes
		 FROM narrator_tool_calls tc
		 LEFT JOIN narrators n ON n.id = tc.narrator_id
		 WHERE tc.created_at <= ?
			 AND tc.is_file_history_checkpoint = 0
			 AND (tc.input_json IS NOT NULL OR tc.output_json IS NOT NULL)
		 ORDER BY tc.created_at ASC
		 LIMIT ?`,
		)
		.all(cutoffIso, Math.max(0, sampleLimit)) as Array<{
		id: string;
		narratorId: string | null;
		narratorTitle: string | null;
		createdAt: string;
		approxBytes: number | string | bigint;
	}>;
	return {
		target: "toolCallPayloads",
		olderThanDays,
		approxBytes: summary.approxBytes,
		oldestAt: summary.oldestAt,
		counts: {
			sessions: 0,
			narrators: 0,
			descendantNarrators: 0,
			messages: 0,
			toolCalls: summary.count,
			apiRequests: 0,
		},
		blockedCount: 0,
		warningCodes: [],
		samples: samples.map((sample) => ({
			type: "apiRequest",
			id: sample.id,
			narratorId: sample.narratorId,
			narratorTitle: sample.narratorTitle,
			createdAt: sample.createdAt,
			approxBytes: numberFromRow(sample.approxBytes),
		})),
		blocked: [],
	};
}

function logSlowDatabaseStep(
	step: string,
	startedAt: number,
	data: Record<string, unknown> = {},
): void {
	const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
	if (durationMs >= 1_000) {
		logger.warn("Slow database cleanup step", { step, durationMs, ...data });
	}
}

/**
 * Page/freelist accounting, or an `AppError` explaining why the backend cannot provide it.
 *
 * `AppError` rather than the port's `UnsupportedCapabilityError` because this reaches an admin HTTP
 * route: 501 says "valid request, absent capability", which is neither a client mistake nor an
 * internal fault, and it stops a client from retrying something that will never work.
 */
function requireReusableSpace(mainBytes: number): ReusableSpaceReport {
	const measured = databaseMaintenance.measureReusableSpace(mainBytes);
	if (!measured.supported) {
		logger.warn("Reusable-space measurement is unavailable on this backend", {
			code: measured.code,
			reason: measured.reason,
		});
		throw new AppError(
			`Reusable-space measurement is unavailable: ${describeUnsupported(measured)}`,
			501,
			"DATABASE_SPACE_REPORT_UNSUPPORTED",
		);
	}
	return measured.value;
}

/**
 * Lightweight post-cleanup maintenance. Returns whether a space-reclaiming rewrite ran — always
 * false here, and deliberately so.
 *
 * VACUUM is NOT run on this path: on large databases it freezes the main thread long enough to make
 * the backend appear dead, and this code runs inside an HTTP request. Space reclamation is a
 * separate, admin-confirmed maintenance window (`vacuumDatabase`).
 *
 * Both steps go through the maintenance port, which reports failure rather than throwing — a
 * checkpoint hiccup must not cost the caller its cleanup result. An unsupported capability is
 * skipped quietly at debug level: on a backend with no WAL there is genuinely nothing to flush, and
 * warning about it on every cleanup would train operators to ignore the log.
 */
function compactDatabaseIfNeeded(changed: boolean): boolean {
	if (!changed) return false;
	const startedAt = performance.now();
	try {
		const checkpoint = databaseMaintenance.checkpoint({ truncate: false });
		if (!checkpoint.supported) {
			logger.debug("Database cleanup checkpoint unavailable", {
				code: checkpoint.code,
				reason: checkpoint.reason,
			});
		}
		const optimized = databaseMaintenance.refreshPlannerStatistics();
		if (!optimized.supported) {
			logger.debug("Database cleanup planner refresh unavailable", {
				code: optimized.code,
				reason: optimized.reason,
			});
		}
		return false;
	} finally {
		logSlowDatabaseStep("maintenance", startedAt, { vacuumSkipped: true });
	}
}

function cleanupCandidateFromPlan(
	plan: { safeRoots: CleanupPlanRoot[]; blockedRoots: CleanupPlanBlockedRoot[] },
	approxBytes: number,
	retentionDays?: number,
): DatabaseCleanupCandidateSummary {
	return {
		count: plan.safeRoots.length,
		approxBytes,
		blockedCount: plan.blockedRoots.length,
		oldestAt: minIso(plan.safeRoots.map((root) => root.lastActivityAt)),
		...(retentionDays != null ? { retentionDays } : {}),
	};
}

function cleanupSummariesFromAggregates(
	archivedPlan: { safeRoots: CleanupPlanRoot[]; blockedRoots: CleanupPlanBlockedRoot[] },
	stalePlan: { safeRoots: CleanupPlanRoot[]; blockedRoots: CleanupPlanBlockedRoot[] },
	aggregates: StorageScanCleanupSummariesResult,
): DatabaseStorageBreakdown["cleanupCandidates"] {
	return {
		archivedSessions: cleanupCandidateFromPlan(archivedPlan, aggregates.archivedApproxBytes),
		staleSessions: cleanupCandidateFromPlan(
			stalePlan,
			aggregates.staleApproxBytes,
			DEFAULT_STALE_SESSION_DAYS,
		),
		toolCallPayloads: {
			count: aggregates.toolCalls.count,
			approxBytes: aggregates.toolCalls.approxBytes,
			blockedCount: 0,
			oldestAt: aggregates.toolCalls.oldestAt,
			retentionDays: DEFAULT_TOOL_CALL_PAYLOAD_DAYS,
		},
	};
}

/**
 * Cleanup-candidate byte totals.
 *
 * The plan (which sessions are eligible) is pure data and stays on the main thread. The
 * COUNT/SUM(length) aggregates run on a read worker. If neither worker path can run, fail
 * explicitly instead of blocking the main thread or reporting an unknown total as zero.
 */
async function measureCleanupCandidatesOffThread(
	signal?: AbortSignal,
): Promise<DatabaseStorageBreakdown["cleanupCandidates"]> {
	const cleanupContext = await loadCleanupNarratorContext();
	const archivedPlan = buildNarratorCleanupPlan("archivedSessions", cleanupContext.narrators, {
		runningTerminalIds: cleanupContext.runningTerminalIds,
	});
	const stalePlan = buildNarratorCleanupPlan("staleSessions", cleanupContext.narrators, {
		staleCutoffIso: getCutoffIso(DEFAULT_STALE_SESSION_DAYS),
		runningTerminalIds: cleanupContext.runningTerminalIds,
	});
	const archivedNarratorIds = [
		...new Set(archivedPlan.safeRoots.flatMap((root) => root.deletedNarratorIds)),
	];
	const staleNarratorIds = [
		...new Set(stalePlan.safeRoots.flatMap((root) => root.deletedNarratorIds)),
	];
	const params = {
		kind: "storageScanCleanupSummaries" as const,
		archivedNarratorIds,
		staleNarratorIds,
		relations: SESSION_OWNED_TABLES,
		toolCallCutoffIso: getCutoffIso(DEFAULT_TOOL_CALL_PAYLOAD_DAYS),
	};
	const aggregates = await runCleanupReadTask<StorageScanCleanupSummariesResult>(params, signal);
	return cleanupSummariesFromAggregates(archivedPlan, stalePlan, aggregates);
}

export const databaseCleanupService = {
	/**
	 * Whole-database storage breakdown for the settings page.
	 *
	 * Per-table measurement and cleanup-candidate aggregates both run on read workers. The main
	 * thread stats the database files, builds the cleanup plan from narrator rows, and merges.
	 * When the shared pool cannot shard, the object scan continues on a single worker.
	 */
	async scanDatabaseBreakdown(
		options: {
			onProgress?: (progress: { done: number; total: number; tableName: string }) => void;
			signal?: AbortSignal;
		} = {},
	): Promise<DatabaseStorageBreakdown> {
		const startedAt = performance.now();
		let executedOn: ParallelScanOutcome["executedOn"] = "workers";
		if (options.signal?.aborted) throw new Error("database storage scan aborted");
		const cleanup = measureCleanupCandidatesOffThread(options.signal);
		// It runs concurrently with the object scan, which may outlive a fast worker failure.
		cleanup.catch(() => {});
		try {
			const fileSizes = await getDatabaseFileSizes();
			const objectStorage = await runParallelObjectStorageScan({
				sqlite,
				dbPath: getDbPath(),
				mainBytes: fileSizes.mainBytes,
				onProgress: options.onProgress,
				signal: options.signal,
			});
			executedOn = objectStorage.executedOn;
			const cleanupCandidates = await cleanup;
			const { executedOn: _executedOn, workerCount, durationMs, ...storage } = objectStorage;
			logger.info("Database storage scan completed", {
				executedOn: objectStorage.executedOn,
				workerCount,
				scanDurationMs: durationMs,
				scanMode: storage.scanMode,
			});
			return {
				...fileSizes,
				...storage,
				cleanupCandidates,
				legacyRequestDumps: { retained: legacyRequestDumpsRetained() },
			};
		} catch (err) {
			cleanup.catch(() => {});
			throw err;
		} finally {
			logSlowDatabaseStep("scanDatabaseBreakdown", startedAt, { executedOn });
		}
	},

	async previewCleanup(
		target: DatabaseCleanupTarget,
		options: { olderThanDays?: number; sampleLimit?: number } = {},
	): Promise<DatabaseCleanupPreviewResult> {
		const startedAt = performance.now();
		try {
			const sampleLimit = options.sampleLimit ?? DEFAULT_PREVIEW_SAMPLE_LIMIT;
			if (target === "toolCallPayloads") {
				return buildToolCallPayloadPreview(
					normalizePreviewDays(target, options.olderThanDays),
					sampleLimit,
				);
			}
			const sessionPlan = planSessionCleanup(
				target,
				options.olderThanDays,
				await loadCleanupNarratorContext(),
			);
			const { preview } = await buildSessionPreview(sessionPlan, sampleLimit);
			return preview;
		} finally {
			logSlowDatabaseStep("previewCleanup", startedAt, { target });
		}
	},

	async executeCleanup(
		target: DatabaseCleanupTarget,
		options: { olderThanDays?: number } = {},
	): Promise<DatabaseCleanupExecutionResult> {
		const startedAt = performance.now();
		try {
			return await databaseMaintenanceLock.acquire(DATABASE_MAINTENANCE_LOCK_KEY, async () => {
				const beforeSizes = await getDatabaseFileSizes();
				const beforeBytes = totalDatabaseBytes(beforeSizes);
				let preview: DatabaseCleanupPreviewResult;
				let changed = false;
				let skippedSessions = 0;

				if (target === "toolCallPayloads") {
					preview = await buildToolCallPayloadPreview(
						normalizePreviewDays(target, options.olderThanDays),
						0,
					);
					if (preview.counts.toolCalls > 0) {
						const cutoffIso = getCutoffIso(preview.olderThanDays ?? DEFAULT_TOOL_CALL_PAYLOAD_DAYS);
						// The WHERE clause mirrors the preview exactly, checkpoint exclusion
						// included: a divergence here would clear rows the preview promised to
						// keep, and the checkpoint rows are the file-history replay source.
						const result = sqlite
							.prepare(
								`UPDATE narrator_tool_calls
							 SET input_json = NULL, output_json = NULL
							 WHERE created_at <= ?
								 AND is_file_history_checkpoint = 0
								 AND (input_json IS NOT NULL OR output_json IS NOT NULL)`,
							)
							.run(cutoffIso);
						changed = numberFromRow(result?.changes) > 0;
					}
				} else {
					const sessionPlan = planSessionCleanup(
						target,
						options.olderThanDays,
						await loadCleanupNarratorContext(),
					);
					// Statistics are best effort here: deleting never depends on a read worker.
					preview = (await buildSessionPreview(sessionPlan, 0)).preview;
					for (const root of sessionPlan.plan.safeRoots) {
						if (!isCleanupRootStillEligible(sessionPlan, root)) {
							skippedSessions++;
							continue;
						}
						await narratorService.remove(root.rootNarratorId);
						changed = true;
					}
					if (skippedSessions > 0) {
						logger.warn("Database cleanup skipped sessions that changed after planning", {
							target,
							skippedSessions,
						});
					}
				}

				const vacuumRan = compactDatabaseIfNeeded(changed);
				const afterSizes = await getDatabaseFileSizes();
				const afterBytes = totalDatabaseBytes(afterSizes);
				const result: DatabaseCleanupExecutionResult = {
					...preview,
					ok: true,
					beforeBytes,
					afterBytes,
					freedBytes: Math.max(0, beforeBytes - afterBytes),
					vacuumRan,
					changed,
					skippedSessions,
				};
				logger.info("Database cleanup completed", {
					target,
					olderThanDays: result.olderThanDays,
					changed,
					freedBytes: result.freedBytes,
					beforeBytes,
					afterBytes,
				});
				return result;
			});
		} finally {
			logSlowDatabaseStep("executeCleanup", startedAt, { target });
		}
	},

	/**
	 * Clear request dumps retained by a deferred 0207, in small batches that yield between them.
	 * Only NULLs the payload: the column drops run at the next startup, when they no longer copy
	 * any dump. Freed pages become reusable at once; VACUUM returns them to disk.
	 */
	async clearLegacyRequestDumps(): Promise<LegacyRequestDumpClearResult> {
		const startedAt = performance.now();
		try {
			return await databaseMaintenanceLock.acquire(DATABASE_MAINTENANCE_LOCK_KEY, async () => {
				const beforeBytes = totalDatabaseBytes(await getDatabaseFileSizes());
				let cleared = 0;
				let cursor = 0;
				for (;;) {
					const batch = clearLegacyRequestDumpBatch(sqlite, cursor, LEGACY_REQUEST_DUMP_BATCH_ROWS);
					if (!batch) break;
					cursor = batch.lastRowid;
					cleared += batch.cleared;
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
				legacyRequestDumpsCleared = true;
				compactDatabaseIfNeeded(cleared > 0);
				const afterBytes = totalDatabaseBytes(await getDatabaseFileSizes());
				logger.info("Legacy request dumps cleared", { cleared, beforeBytes, afterBytes });
				return { ok: true, cleared, beforeBytes, afterBytes, restartRequired: cleared > 0 };
			});
		} finally {
			logSlowDatabaseStep("clearLegacyRequestDumps", startedAt);
		}
	},

	async vacuumDatabase(): Promise<DatabaseVacuumResult> {
		const startedAt = performance.now();
		try {
			return await databaseMaintenanceLock.acquire(DATABASE_MAINTENANCE_LOCK_KEY, async () => {
				// The maintenance lock only serialises callers inside this process. Read workers hold
				// their OWN connections, and a worker mid-scan keeps a read transaction open — which
				// makes VACUUM's exclusive lock fail with SQLITE_BUSY. Terminate the pool first so the
				// maintenance window really is exclusive. The pool respawns lazily on the next scan.
				shutdownDbWorkerPool();
				const beforeSizes = await getDatabaseFileSizes();
				const beforeBytes = totalDatabaseBytes(beforeSizes);
				// Pragmas only. A full object scan here would read every table just to keep one number,
				// and would itself contend with the writer we are about to hand an exclusive lock to.
				//
				// A refusal rather than a silent zero: an operator who explicitly asked for space
				// reclamation must be told the backend cannot measure it, not handed a report full of
				// zeroes that reads like "nothing to reclaim".
				const beforeStorage = requireReusableSpace(beforeSizes.mainBytes);
				let checkpointRan = false;
				let optimized = false;

				/**
				 * Whether the step actually did its work.
				 *
				 * `supported` alone is not enough: the port reports a best-effort step that FAILED as
				 * `supported: { ok: false }`, because an absent capability and a failed one are different
				 * facts. Reporting `checkpointRan: true` for a checkpoint that threw would tell the
				 * operator the WAL was flushed when it was not.
				 */
				const ran = (result: ReturnType<typeof databaseMaintenance.checkpoint>): boolean =>
					result.supported && result.value.ok;

				// Truncating checkpoint before the rewrite: PASSIVE cannot shrink the WAL, and WAL bytes
				// left behind would show up as "freed nothing" after a VACUUM that did work.
				checkpointRan = ran(databaseMaintenance.checkpoint({ truncate: true }));

				try {
					const reclaimed = databaseMaintenance.reclaimSpace();
					if (!reclaimed.supported) {
						// "This backend cannot reclaim space" is a different answer from "the rewrite
						// failed", and conflating them would tell the operator to retry something that will
						// never work. 501 rather than 500: the request was valid, the capability is absent.
						logger.warn("Database space reclamation is unavailable on this backend", {
							code: reclaimed.code,
							reason: reclaimed.reason,
						});
						throw new AppError(
							`Space reclamation is unavailable: ${describeUnsupported(reclaimed)}`,
							501,
							"DATABASE_VACUUM_UNSUPPORTED",
						);
					}
				} catch (error) {
					if (error instanceof AppError) throw error;
					// Previously unguarded, so a lock conflict surfaced as a bare 500. The port classifies
					// the failure so this decision no longer depends on SQLite error strings.
					const failure = databaseMaintenance.classifyFailure(error);
					logger.warn("Database space reclamation failed", {
						kind: failure.kind,
						error: failure.message,
					});
					throw new AppError(
						`VACUUM could not run: ${failure.message}`,
						failure.kind === "conflict" ? 409 : 500,
						"DATABASE_VACUUM_FAILED",
					);
				}

				optimized = ran(databaseMaintenance.refreshPlannerStatistics());
				// Checkpoint again: VACUUM leaves its work in the WAL, so without this the file on disk
				// has not actually shrunk yet and the after-size would understate what was reclaimed.
				// `||` keeps the flag true when the first checkpoint succeeded and this one did not:
				// the field means "a checkpoint ran", matching the pre-refactor behaviour.
				checkpointRan = ran(databaseMaintenance.checkpoint({ truncate: true })) || checkpointRan;

				const afterSizes = await getDatabaseFileSizes();
				const afterBytes = totalDatabaseBytes(afterSizes);
				const afterStorage = requireReusableSpace(afterSizes.mainBytes);
				const result: DatabaseVacuumResult = {
					ok: true,
					beforeBytes,
					afterBytes,
					freedBytes: Math.max(0, beforeBytes - afterBytes),
					freelistBeforeBytes: beforeStorage.freelistBytes,
					freelistAfterBytes: afterStorage.freelistBytes,
					vacuumRan: true,
					checkpointRan,
					optimized,
					durationMs: Math.round(performance.now() - startedAt),
				};
				logger.info("Database VACUUM completed", {
					freedBytes: result.freedBytes,
					freelistBeforeBytes: result.freelistBeforeBytes,
					freelistAfterBytes: result.freelistAfterBytes,
					durationMs: result.durationMs,
				});
				return result;
			});
		} finally {
			logSlowDatabaseStep("vacuumDatabase", startedAt);
		}
	},
};
