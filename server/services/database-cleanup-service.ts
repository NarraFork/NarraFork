import { stat } from "node:fs/promises";
import { sqlite } from "@server/db";
import { getDbPath } from "@server/db/connection";
import { AsyncMutex } from "@server/lib/async-mutex";
import { shutdownDbWorkerPool } from "@server/lib/db-worker/pool";
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
	type NarratorCleanupRecord,
} from "./database-cleanup-utils";
// Storage-scan query primitives live in a DB-singleton-free module so the read worker can import
// them without re-bootstrapping the database. See storage-scan-queries.ts for why that matters.
import {
	collectSessionAggregateStats as collectSessionAggregateStatsOn,
	type DatabaseStorageCategoryKey,
	type DatabaseStorageCategorySummary,
	type DatabaseStorageReadFailures,
	type DatabaseStorageTableSummary,
	type DatabaseTableKind,
	getDatabaseStorageCategory,
	numberFromRow,
	readFreelistSummary,
	type SessionAggregateStats,
	type SessionOwnedTableRelation,
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
export const DEFAULT_API_REQUEST_DUMP_DAYS = 30;
const DEFAULT_PREVIEW_SAMPLE_LIMIT = 10;
const DATABASE_MAINTENANCE_LOCK_KEY = "database-maintenance";
const databaseMaintenanceLock = new AsyncMutex();

const SESSION_OWNED_TABLES: SessionOwnedTableRelation[] = [
	{ tableName: "narrator_message_refs", alias: "r", narratorColumn: "narrator_id" },
	{
		tableName: "narrator_tool_calls",
		alias: "tc",
		narratorColumn: "narrator_id",
		countAs: "toolCalls",
	},
	{ tableName: "narrator_sidecars", alias: "ns", narratorColumn: "narrator_id" },
	{ tableName: "api_requests", alias: "ar", narratorColumn: "narrator_id", countAs: "apiRequests" },
	{ tableName: "terminal_view_state", alias: "tvs", narratorColumn: "narrator_id" },
	{ tableName: "terminal_tabs", alias: "tt", narratorColumn: "narrator_id" },
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
		apiRequestDumps: DatabaseCleanupCandidateSummary;
	};
}

export type DatabaseCleanupWarningCode = "deletesUsageHistory";

export interface DatabaseCleanupPreviewCounts {
	sessions: number;
	narrators: number;
	descendantNarrators: number;
	messages: number;
	toolCalls: number;
	apiRequests: number;
	dumpsCleared: number;
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
	chapterTitle: string | null;
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
	if (target === "apiRequestDumps") return DEFAULT_API_REQUEST_DUMP_DAYS;
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
		chapterId: row.chapterId ? String(row.chapterId) : null,
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

async function loadCleanupNarratorContext(): Promise<CleanupNarratorContext> {
	const narratorRows = sqlite
		.prepare(
			`SELECT
				id,
				parent_narrator_id AS parentNarratorId,
				chapter_id AS chapterId,
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
				background_status AS backgroundStatus
			 FROM narrators`,
		)
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

function collectSessionAggregateStats(narratorIds: string[]): SessionAggregateStats {
	return collectSessionAggregateStatsOn(sqlite, narratorIds, SESSION_OWNED_TABLES);
}

function estimateNarratorSampleApproxBytes(root: CleanupPlanRoot): number {
	return collectSessionAggregateStats(root.deletedNarratorIds).approxBytes;
}

async function buildSessionPreview(
	target: Extract<DatabaseCleanupTarget, "archivedSessions" | "staleSessions">,
	olderThanDays: number | undefined,
	sampleLimit = DEFAULT_PREVIEW_SAMPLE_LIMIT,
	context?: CleanupNarratorContext,
): Promise<SessionPreviewData> {
	const cleanupContext = context ?? (await loadCleanupNarratorContext());
	const normalizedDays = normalizePreviewDays(target, olderThanDays);
	const staleCutoffIso =
		target === "staleSessions" && normalizedDays ? getCutoffIso(normalizedDays) : undefined;
	const plan = buildNarratorCleanupPlan(target, cleanupContext.narrators, {
		staleCutoffIso,
		runningTerminalIds: cleanupContext.runningTerminalIds,
	});
	const allNarratorIds = [...new Set(plan.safeRoots.flatMap((root) => root.deletedNarratorIds))];
	const aggregate = collectSessionAggregateStats(allNarratorIds);
	const limitedRoots = plan.safeRoots.slice(0, Math.max(0, sampleLimit));
	// Synchronous on purpose: these are bun:sqlite aggregates, so Promise.all would only have wrapped
	// blocking calls in promises without buying any concurrency.
	const sampleBytes = limitedRoots.map((root) => estimateNarratorSampleApproxBytes(root));
	const samples: DatabaseCleanupNarratorSample[] = limitedRoots.map((root, index) => ({
		type: "narrator",
		id: root.rootNarratorId,
		title: root.rootTitle,
		status: root.rootStatus,
		lastActivityAt: root.lastActivityAt,
		messageCount: root.rootMessageCount,
		descendantNarratorCount: root.descendantNarratorCount,
		approxBytes: sampleBytes[index] ?? 0,
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
				dumpsCleared: aggregate.dumpsCleared,
			},
			blockedCount: plan.blockedRoots.length,
			warningCodes: plan.safeRoots.length > 0 ? ["deletesUsageHistory"] : [],
			samples,
			blocked: plan.blockedRoots.slice(0, Math.max(0, sampleLimit)).map(toBlockedItem),
		},
		safeRoots: plan.safeRoots,
	};
}

async function buildDumpPreview(
	olderThanDays = DEFAULT_API_REQUEST_DUMP_DAYS,
	sampleLimit = DEFAULT_PREVIEW_SAMPLE_LIMIT,
): Promise<DatabaseCleanupPreviewResult> {
	const cutoffIso = getCutoffIso(olderThanDays);
	const summary = sqlite
		.prepare(
			`SELECT
			COUNT(*) AS count,
			COALESCE(SUM(length(CAST(coalesce(raw_dump_json, '') AS BLOB))), 0) AS approxBytes,
			MIN(created_at) AS oldestAt
		 FROM api_requests
		 WHERE raw_dump_json IS NOT NULL AND created_at <= ?`,
		)
		.get(cutoffIso) as {
		count: number | string | bigint;
		approxBytes: number | string | bigint;
		oldestAt: string | null;
	};
	const samples = sqlite
		.prepare(
			`SELECT
			ar.id AS id,
			ar.narrator_id AS narratorId,
			n.title AS narratorTitle,
			c.title AS chapterTitle,
			ar.created_at AS createdAt,
			length(CAST(coalesce(ar.raw_dump_json, '') AS BLOB)) AS approxBytes
		 FROM api_requests ar
		 LEFT JOIN narrators n ON n.id = ar.narrator_id
		 LEFT JOIN chapters c ON c.id = n.chapter_id
		 WHERE ar.raw_dump_json IS NOT NULL AND ar.created_at <= ?
		 ORDER BY ar.created_at ASC
		 LIMIT ?`,
		)
		.all(cutoffIso, Math.max(0, sampleLimit)) as Array<{
		id: string;
		narratorId: string | null;
		narratorTitle: string | null;
		chapterTitle: string | null;
		createdAt: string;
		approxBytes: number | string | bigint;
	}>;
	return {
		target: "apiRequestDumps",
		olderThanDays,
		approxBytes: numberFromRow(summary?.approxBytes),
		oldestAt: summary?.oldestAt ?? null,
		counts: {
			sessions: 0,
			narrators: 0,
			descendantNarrators: 0,
			messages: 0,
			toolCalls: 0,
			apiRequests: numberFromRow(summary?.count),
			dumpsCleared: numberFromRow(summary?.count),
		},
		blockedCount: 0,
		warningCodes: [],
		samples: samples.map((sample) => ({
			type: "apiRequest",
			id: sample.id,
			narratorId: sample.narratorId,
			narratorTitle: sample.narratorTitle,
			chapterTitle: sample.chapterTitle,
			createdAt: sample.createdAt,
			approxBytes: numberFromRow(sample.approxBytes),
		})),
		blocked: [],
	};
}

async function summarizeSessionTarget(
	target: Extract<DatabaseCleanupTarget, "archivedSessions" | "staleSessions">,
	context: CleanupNarratorContext,
	olderThanDays?: number,
): Promise<DatabaseCleanupCandidateSummary> {
	const { preview } = await buildSessionPreview(target, olderThanDays, 0, context);
	return {
		count: preview.counts.sessions,
		approxBytes: preview.approxBytes,
		blockedCount: preview.blockedCount,
		oldestAt: preview.oldestAt,
		...(preview.olderThanDays != null ? { retentionDays: preview.olderThanDays } : {}),
	};
}

async function summarizeDumpTarget(
	olderThanDays = DEFAULT_API_REQUEST_DUMP_DAYS,
): Promise<DatabaseCleanupCandidateSummary> {
	const preview = await buildDumpPreview(olderThanDays, 0);
	return {
		count: preview.counts.dumpsCleared,
		approxBytes: preview.approxBytes,
		blockedCount: 0,
		oldestAt: preview.oldestAt,
		retentionDays: olderThanDays,
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

function compactDatabaseIfNeeded(changed: boolean): boolean {
	if (!changed) return false;
	const startedAt = performance.now();
	try {
		// Avoid running VACUUM synchronously in the HTTP request path: on large SQLite
		// files it can freeze Bun's main thread long enough to make the backend appear dead.
		// Keep only lightweight best-effort maintenance here; a future background job can
		// run full compaction outside request handling.
		sqlite.run("PRAGMA wal_checkpoint(PASSIVE)");
		sqlite.run("PRAGMA optimize");
		return false;
	} catch (error) {
		logger.warn("Database cleanup maintenance failed", { error: String(error) });
		return false;
	} finally {
		logSlowDatabaseStep("maintenance", startedAt, { vacuumSkipped: true });
	}
}

export const databaseCleanupService = {
	/**
	 * Whole-database storage breakdown for the settings page.
	 *
	 * The per-table measurement is the expensive part (measured: ~4.9s over 116 tables on a 5.3 GB
	 * database) and runs in read workers so it does not block the main thread. It degrades to a
	 * serial main-thread scan when workers are unavailable.
	 *
	 * KNOWN REMAINING COST — do not describe this as cheap. The cleanup-candidate summaries below
	 * still run whole-table aggregates SYNCHRONOUSLY on the main thread:
	 *   - `summarizeDumpTarget` sums `length(raw_dump_json)` over all of `api_requests` (the table
	 *     weighted at 480ms in the scan cost table).
	 *   - `summarizeSessionTarget` runs one COUNT+SUM per narrator-owned table, so its cost grows
	 *     with the number of sessions being cleaned.
	 * `Promise.all` below buys no concurrency for them either: bun:sqlite is synchronous, so those
	 * calls simply run one after another inside the promise wrapper. Only the worker scan is
	 * genuinely off-thread. Moving these into the worker requires shipping the cleanup plan's
	 * narrator ids across the wire as a new task kind; the unbounded `.all()` they used to do has
	 * already been removed (see collectSessionAggregateStats in storage-scan-queries.ts).
	 */
	async scanDatabaseBreakdown(
		options: {
			onProgress?: (progress: { done: number; total: number; tableName: string }) => void;
			signal?: AbortSignal;
		} = {},
	): Promise<DatabaseStorageBreakdown> {
		const startedAt = performance.now();
		let executedOn: ParallelScanOutcome["executedOn"] = "main-thread";
		if (options.signal?.aborted) throw new Error("database storage scan aborted");
		try {
			const [fileSizes, cleanupContext] = await Promise.all([
				getDatabaseFileSizes(),
				loadCleanupNarratorContext(),
			]);
			const [archivedSessions, staleSessions, apiRequestDumps, objectStorage] = await Promise.all([
				summarizeSessionTarget("archivedSessions", cleanupContext),
				summarizeSessionTarget("staleSessions", cleanupContext, DEFAULT_STALE_SESSION_DAYS),
				summarizeDumpTarget(DEFAULT_API_REQUEST_DUMP_DAYS),
				runParallelObjectStorageScan({
					sqlite,
					dbPath: getDbPath(),
					mainBytes: fileSizes.mainBytes,
					onProgress: options.onProgress,
					signal: options.signal,
				}),
			]);
			executedOn = objectStorage.executedOn;
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
				cleanupCandidates: {
					archivedSessions,
					staleSessions,
					apiRequestDumps,
				},
			};
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
			if (target === "apiRequestDumps") {
				return buildDumpPreview(normalizePreviewDays(target, options.olderThanDays), sampleLimit);
			}
			const cleanupContext = await loadCleanupNarratorContext();
			const { preview } = await buildSessionPreview(
				target,
				normalizePreviewDays(target, options.olderThanDays),
				sampleLimit,
				cleanupContext,
			);
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

				if (target === "apiRequestDumps") {
					preview = await buildDumpPreview(normalizePreviewDays(target, options.olderThanDays), 0);
					if (preview.counts.dumpsCleared > 0) {
						const cutoffIso = getCutoffIso(preview.olderThanDays ?? DEFAULT_API_REQUEST_DUMP_DAYS);
						const result = sqlite
							.prepare(
								`UPDATE api_requests
							 SET raw_dump_json = NULL
							 WHERE raw_dump_json IS NOT NULL AND created_at <= ?`,
							)
							.run(cutoffIso);
						changed = numberFromRow(result?.changes) > 0;
					}
				} else {
					const cleanupContext = await loadCleanupNarratorContext();
					const sessionPreview = await buildSessionPreview(
						target,
						normalizePreviewDays(target, options.olderThanDays),
						0,
						cleanupContext,
					);
					preview = sessionPreview.preview;
					if (sessionPreview.safeRoots.length > 0) {
						for (const root of sessionPreview.safeRoots) {
							await narratorService.remove(root.rootNarratorId);
						}
						changed = true;
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
				const beforeStorage = readFreelistSummary(sqlite, beforeSizes.mainBytes);
				let checkpointRan = false;
				let optimized = false;

				try {
					sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
					checkpointRan = true;
				} catch (error) {
					logger.warn("Database checkpoint before VACUUM failed", { error: String(error) });
				}

				try {
					sqlite.run("VACUUM");
				} catch (error) {
					// Previously unguarded, so a lock conflict surfaced as a bare 500. Report it as a
					// retryable conflict instead, and keep the message actionable.
					const message = String(error);
					logger.warn("Database VACUUM failed", { error: message });
					throw new AppError(
						`VACUUM could not run: ${message}`,
						/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message) ? 409 : 500,
						"DATABASE_VACUUM_FAILED",
					);
				}

				try {
					sqlite.run("PRAGMA optimize");
					optimized = true;
				} catch (error) {
					logger.warn("Database optimize after VACUUM failed", { error: String(error) });
				}

				try {
					sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
					checkpointRan = true;
				} catch (error) {
					logger.warn("Database checkpoint after VACUUM failed", { error: String(error) });
				}

				const afterSizes = await getDatabaseFileSizes();
				const afterBytes = totalDatabaseBytes(afterSizes);
				const afterStorage = readFreelistSummary(sqlite, afterSizes.mainBytes);
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
