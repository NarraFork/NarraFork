import { stat } from "node:fs/promises";
import { sqlite } from "@server/db";
import { getDbPath } from "@server/db/connection";
import { AsyncMutex } from "@server/lib/async-mutex";
import { generateShortId } from "@server/lib/id";
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

export type { DatabaseCleanupBlockedReasonCode, DatabaseCleanupTarget };

export const DEFAULT_STALE_SESSION_DAYS = 90;
export const DEFAULT_API_REQUEST_DUMP_DAYS = 30;
const DEFAULT_PREVIEW_SAMPLE_LIMIT = 10;
const DATABASE_MAINTENANCE_LOCK_KEY = "database-maintenance";
const databaseMaintenanceLock = new AsyncMutex();

const NARRATOR_BYTES_EXPR = [
	"length(CAST(coalesce(n.id, '') AS BLOB))",
	"length(CAST(coalesce(n.chapter_id, '') AS BLOB))",
	"length(CAST(coalesce(n.api_conversation_id, '') AS BLOB))",
	"length(CAST(coalesce(n.fork_message_id, '') AS BLOB))",
	"length(CAST(coalesce(n.type, '') AS BLOB))",
	"length(CAST(coalesce(n.subagent_type, '') AS BLOB))",
	"length(CAST(coalesce(n.title, '') AS BLOB))",
	"length(CAST(coalesce(n.inherit_mode, '') AS BLOB))",
	"length(CAST(coalesce(n.parent_narrator_id, '') AS BLOB))",
	"length(CAST(coalesce(n.context_summary, '') AS BLOB))",
	"length(CAST(coalesce(n.model, '') AS BLOB))",
	"length(CAST(coalesce(n.pending_model_restore, '') AS BLOB))",
	"length(CAST(coalesce(n.system_prompt, '') AS BLOB))",
	"length(CAST(coalesce(n.permission_mode, '') AS BLOB))",
	"length(CAST(coalesce(n.previous_permission_mode, '') AS BLOB))",
	"length(CAST(coalesce(n.reasoning_effort, '') AS BLOB))",
	"length(CAST(coalesce(n.last_message_at, '') AS BLOB))",
	"length(CAST(coalesce(n.status, '') AS BLOB))",
	"length(CAST(coalesce(n.cwd, '') AS BLOB))",
	"length(CAST(coalesce(n.error_message, '') AS BLOB))",
	"length(CAST(coalesce(n.todos_json, '') AS BLOB))",
	"length(CAST(coalesce(n.todos_tool_use_id, '') AS BLOB))",
	"length(CAST(coalesce(n.prune_boundary_message_id, '') AS BLOB))",
	"length(CAST(coalesce(n.enabled_tools, '') AS BLOB))",
	"length(CAST(coalesce(n.background_status, '') AS BLOB))",
	"length(CAST(coalesce(n.background_result, '') AS BLOB))",
	"length(CAST(coalesce(n.background_completed_at, '') AS BLOB))",
	"length(CAST(coalesce(n.turn_started_at, '') AS BLOB))",
	"length(CAST(coalesce(n.created_at, '') AS BLOB))",
	"length(CAST(coalesce(n.updated_at, '') AS BLOB))",
].join(" + ");

const MESSAGE_BYTES_EXPR = [
	"length(CAST(coalesce(m.id, '') AS BLOB))",
	"length(CAST(coalesce(m.narrator_id, '') AS BLOB))",
	"length(CAST(coalesce(m.sdk_message_uuid, '') AS BLOB))",
	"length(CAST(coalesce(m.parent_tool_use_id, '') AS BLOB))",
	"length(CAST(coalesce(m.role, '') AS BLOB))",
	"length(CAST(coalesce(m.content_json, '') AS BLOB))",
	"length(CAST(coalesce(m.content_text, '') AS BLOB))",
	"length(CAST(coalesce(m.turn_usage_json, '') AS BLOB))",
	"length(CAST(coalesce(m.provider, '') AS BLOB))",
	"length(CAST(coalesce(m.credential_id, '') AS BLOB))",
	"length(CAST(coalesce(m.model, '') AS BLOB))",
	"length(CAST(coalesce(m.commit_sha, '') AS BLOB))",
	"length(CAST(coalesce(m.command_text, '') AS BLOB))",
	"length(CAST(coalesce(m.created_by, '') AS BLOB))",
	"length(CAST(coalesce(m.created_at, '') AS BLOB))",
].join(" + ");

const MESSAGE_REF_BYTES_EXPR = [
	"length(CAST(coalesce(r.id, '') AS BLOB))",
	"length(CAST(coalesce(r.narrator_id, '') AS BLOB))",
	"length(CAST(coalesce(r.message_id, '') AS BLOB))",
	"length(CAST(coalesce(r.segment_compact_id, '') AS BLOB))",
].join(" + ");

const TOOL_CALL_BYTES_EXPR = [
	"length(CAST(coalesce(tc.id, '') AS BLOB))",
	"length(CAST(coalesce(tc.narrator_id, '') AS BLOB))",
	"length(CAST(coalesce(tc.message_id, '') AS BLOB))",
	"length(CAST(coalesce(tc.tool_use_id, '') AS BLOB))",
	"length(CAST(coalesce(tc.tool_name, '') AS BLOB))",
	"length(CAST(coalesce(tc.input_json, '') AS BLOB))",
	"length(CAST(coalesce(tc.output_json, '') AS BLOB))",
	"length(CAST(coalesce(tc.status, '') AS BLOB))",
	"length(CAST(coalesce(tc.error_message, '') AS BLOB))",
	"length(CAST(coalesce(tc.permission_decided_by, '') AS BLOB))",
	"length(CAST(coalesce(tc.permission_decided_at, '') AS BLOB))",
	"length(CAST(coalesce(tc.permission_deny_message, '') AS BLOB))",
	"length(CAST(coalesce(tc.permission_decision_reason, '') AS BLOB))",
	"length(CAST(coalesce(tc.permission_suggestions, '') AS BLOB))",
	"length(CAST(coalesce(tc.created_at, '') AS BLOB))",
].join(" + ");

const API_REQUEST_BYTES_EXPR = [
	"length(CAST(coalesce(ar.id, '') AS BLOB))",
	"length(CAST(coalesce(ar.narrator_id, '') AS BLOB))",
	"length(CAST(coalesce(ar.message_id, '') AS BLOB))",
	"length(CAST(coalesce(ar.provider, '') AS BLOB))",
	"length(CAST(coalesce(ar.credential_id, '') AS BLOB))",
	"length(CAST(coalesce(ar.model, '') AS BLOB))",
	"length(CAST(coalesce(ar.meter_unit, '') AS BLOB))",
	"length(CAST(coalesce(ar.raw_dump_json, '') AS BLOB))",
	"length(CAST(coalesce(ar.created_at, '') AS BLOB))",
].join(" + ");

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

interface CleanupNarratorContext {
	narrators: NarratorCleanupRecord[];
	runningTerminalIds: Set<string>;
}

interface SessionAggregateStats {
	narrators: number;
	messages: number;
	toolCalls: number;
	apiRequests: number;
	dumpsCleared: number;
	approxBytes: number;
}

interface SessionPreviewData {
	preview: DatabaseCleanupPreviewResult;
	safeRoots: CleanupPlanRoot[];
}

function numberFromRow(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	if (typeof value === "string") return Number(value) || 0;
	return 0;
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

async function withTempIdTable<T>(
	ids: string[],
	prefix: string,
	fn: (tableName: string) => Promise<T> | T,
): Promise<T> {
	const suffix = generateShortId().replace(/[^a-zA-Z0-9_]/g, "_");
	const tableName = `temp_${prefix}_${suffix}`;
	sqlite.run(`CREATE TEMP TABLE ${tableName} (id TEXT PRIMARY KEY)`);
	try {
		const insertStmt = sqlite.prepare(`INSERT INTO ${tableName} (id) VALUES (?)`);
		const insertTx = sqlite.transaction((values: string[]) => {
			for (const value of values) {
				insertStmt.run(value);
			}
		});
		insertTx(ids);
		return await fn(tableName);
	} finally {
		sqlite.run(`DROP TABLE IF EXISTS ${tableName}`);
	}
}

function sumBytesQuery(expression: string, fromClause: string): number {
	const row = sqlite
		.prepare(`SELECT COALESCE(SUM(${expression}), 0) AS bytes ${fromClause}`)
		.get() as { bytes: number | string | bigint };
	return numberFromRow(row?.bytes);
}

function countQuery(fromClause: string): number {
	const row = sqlite.prepare(`SELECT COUNT(*) AS count ${fromClause}`).get() as {
		count: number | string | bigint;
	};
	return numberFromRow(row?.count);
}

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

async function collectSessionAggregateStats(narratorIds: string[]): Promise<SessionAggregateStats> {
	if (narratorIds.length === 0) {
		return {
			narrators: 0,
			messages: 0,
			toolCalls: 0,
			apiRequests: 0,
			dumpsCleared: 0,
			approxBytes: 0,
		};
	}
	return withTempIdTable(narratorIds, "cleanup_narrators", async (narratorTable) => {
		const narrators = countQuery(
			`FROM narrators n JOIN ${narratorTable} target_n ON target_n.id = n.id`,
		);
		const toolCalls = countQuery(
			`FROM narrator_tool_calls tc JOIN ${narratorTable} target_n ON target_n.id = tc.narrator_id`,
		);
		const apiRequests = countQuery(
			`FROM api_requests ar JOIN ${narratorTable} target_n ON target_n.id = ar.narrator_id`,
		);
		const dumpsCleared = countQuery(
			`FROM api_requests ar
			 JOIN ${narratorTable} target_n ON target_n.id = ar.narrator_id
			 WHERE ar.raw_dump_json IS NOT NULL`,
		);
		const narratorBytes = sumBytesQuery(
			NARRATOR_BYTES_EXPR,
			`FROM narrators n JOIN ${narratorTable} target_n ON target_n.id = n.id`,
		);
		const messageRefBytes = sumBytesQuery(
			MESSAGE_REF_BYTES_EXPR,
			`FROM narrator_message_refs r JOIN ${narratorTable} target_n ON target_n.id = r.narrator_id`,
		);
		const toolCallBytes = sumBytesQuery(
			TOOL_CALL_BYTES_EXPR,
			`FROM narrator_tool_calls tc JOIN ${narratorTable} target_n ON target_n.id = tc.narrator_id`,
		);
		const apiRequestBytes = sumBytesQuery(
			API_REQUEST_BYTES_EXPR,
			`FROM api_requests ar JOIN ${narratorTable} target_n ON target_n.id = ar.narrator_id`,
		);

		const messageIds = sqlite
			.prepare(
				`SELECT m.id AS id
			 FROM narrator_messages m
			 JOIN ${narratorTable} target_n ON target_n.id = m.narrator_id
			 WHERE NOT EXISTS (
				SELECT 1
				FROM narrator_message_refs r
				WHERE r.message_id = m.id
				  AND r.narrator_id NOT IN (SELECT id FROM ${narratorTable})
			 )`,
			)
			.all() as Array<{ id: string }>;
		const messageIdList = messageIds.map((row) => row.id);
		let messages = 0;
		let messageBytes = 0;
		if (messageIdList.length > 0) {
			messages = messageIdList.length;
			messageBytes = await withTempIdTable(
				messageIdList,
				"cleanup_messages",
				async (messageTable) =>
					sumBytesQuery(
						MESSAGE_BYTES_EXPR,
						`FROM narrator_messages m JOIN ${messageTable} target_m ON target_m.id = m.id`,
					),
			);
		}

		return {
			narrators,
			messages,
			toolCalls,
			apiRequests,
			dumpsCleared,
			approxBytes: narratorBytes + messageRefBytes + toolCallBytes + apiRequestBytes + messageBytes,
		};
	});
}

async function estimateNarratorSampleApproxBytes(root: CleanupPlanRoot): Promise<number> {
	const stats = await collectSessionAggregateStats(root.deletedNarratorIds);
	return stats.approxBytes;
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
	const aggregate = await collectSessionAggregateStats(allNarratorIds);
	const limitedRoots = plan.safeRoots.slice(0, Math.max(0, sampleLimit));
	const sampleBytes = await Promise.all(
		limitedRoots.map((root) => estimateNarratorSampleApproxBytes(root)),
	);
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
	async scanDatabaseBreakdown(): Promise<DatabaseStorageBreakdown> {
		const startedAt = performance.now();
		try {
			const [fileSizes, cleanupContext] = await Promise.all([
				getDatabaseFileSizes(),
				loadCleanupNarratorContext(),
			]);
			const [archivedSessions, staleSessions, apiRequestDumps] = await Promise.all([
				summarizeSessionTarget("archivedSessions", cleanupContext),
				summarizeSessionTarget("staleSessions", cleanupContext, DEFAULT_STALE_SESSION_DAYS),
				summarizeDumpTarget(DEFAULT_API_REQUEST_DUMP_DAYS),
			]);
			return {
				...fileSizes,
				cleanupCandidates: {
					archivedSessions,
					staleSessions,
					apiRequestDumps,
				},
			};
		} finally {
			logSlowDatabaseStep("scanDatabaseBreakdown", startedAt);
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
				const beforeBytes = beforeSizes.mainBytes + beforeSizes.walBytes + beforeSizes.shmBytes;
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
				const afterBytes = afterSizes.mainBytes + afterSizes.walBytes + afterSizes.shmBytes;
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
};
