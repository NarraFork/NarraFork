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

const DATABASE_STORAGE_CATEGORY_KEYS = [
	"sessions",
	"apiRequests",
	"projects",
	"runtime",
	"users",
	"search",
	"gateway",
	"benchmarks",
	"internal",
	"free",
	"other",
] as const;

export type DatabaseStorageCategoryKey = (typeof DATABASE_STORAGE_CATEGORY_KEYS)[number];

export type DatabaseTableKind = "table" | "virtual" | "shadow" | "internal";

interface SqliteTableListRow {
	schema?: string;
	name: string;
	type: string;
}

interface SqliteIndexRow {
	name: string;
	tableName: string;
}

interface SqliteTableColumnRow {
	name: string;
	hidden?: number | string | bigint;
}

interface TableSessionRelation {
	tableName: string;
	alias: string;
	narratorColumn: string;
	countAs?: "toolCalls" | "apiRequests";
}

const SESSION_OWNED_TABLES: TableSessionRelation[] = [
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

const SEARCH_TABLE_PREFIXES = ["chapters_fts", "narrator_messages_fts", "narrators_fts"];

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

export interface DatabaseStorageCategorySummary {
	key: DatabaseStorageCategoryKey;
	tableCount: number;
	rowCount: number;
	approxContentBytes: number;
	diskBytes: number;
	indexBytes: number;
	totalBytes: number;
}

export interface DatabaseStorageTableSummary {
	name: string;
	category: DatabaseStorageCategoryKey;
	kind: DatabaseTableKind;
	rowCount: number | null;
	approxContentBytes: number;
	diskBytes: number;
	indexBytes: number;
	totalBytes: number;
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

function totalDatabaseBytes(sizes: DatabaseFileSizes): number {
	return sizes.mainBytes + sizes.walBytes + sizes.shmBytes;
}

function quoteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function readPragmaNumber(name: string): number {
	try {
		const row = sqlite.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
		return numberFromRow(row?.[name]);
	} catch {
		return 0;
	}
}

function isSearchTableName(tableName: string): boolean {
	return SEARCH_TABLE_PREFIXES.some(
		(prefix) => tableName === prefix || tableName.startsWith(`${prefix}_`),
	);
}

export function getDatabaseStorageCategory(tableName: string): DatabaseStorageCategoryKey {
	if (tableName.startsWith("sqlite_")) return "internal";
	if (isSearchTableName(tableName)) return "search";
	if (
		[
			"narrators",
			"narrator_messages",
			"narrator_message_refs",
			"narrator_sidecars",
			"narrator_tool_calls",
			"narrator_buffered_messages",
			"narrator_file_snapshots",
			"narrator_patches",
			"narrator_whitelist_dirs",
			"narrator_blacklist_dirs",
			"narrator_whitelist_cmds",
			"narrator_blacklist_cmds",
			"background_tasks",
		].includes(tableName)
	) {
		return "sessions";
	}
	if (tableName === "api_requests") return "apiRequests";
	if (
		[
			"projects",
			"exploration_groups",
			"chapters",
			"chapter_edges",
			"chapter_commits",
			"merge_sessions",
			"review_conclusions",
		].includes(tableName)
	) {
		return "projects";
	}
	if (
		[
			"terminals",
			"terminal_tabs",
			"terminal_view_state",
			"container_instances",
			"port_allocations",
			"volume_snapshots",
			"volume_snapshot_applications",
		].includes(tableName)
	) {
		return "runtime";
	}
	if (
		["users", "user_preferences", "user_favorite_directories", "workspaces", "hooks"].includes(
			tableName,
		)
	) {
		return "users";
	}
	if (tableName === "gateway_session_mappings") return "gateway";
	if (["benchmark_suites", "benchmark_runs", "benchmark_task_results"].includes(tableName)) {
		return "benchmarks";
	}
	return "other";
}

function normalizeTableKind(type: string): DatabaseTableKind {
	if (type === "virtual" || type === "shadow") return type;
	return type === "internal" ? "internal" : "table";
}

function tableExists(tableName: string): boolean {
	const row = sqlite
		.prepare("SELECT 1 FROM sqlite_schema WHERE name = ? AND type IN ('table', 'view') LIMIT 1")
		.get(tableName);
	return Boolean(row);
}

function loadSqliteTables(): Array<{ name: string; kind: DatabaseTableKind }> {
	try {
		const rows = sqlite.prepare("PRAGMA table_list").all() as SqliteTableListRow[];
		return rows
			.filter((row) => (row.schema ?? "main") === "main")
			.filter((row) => ["table", "virtual", "shadow"].includes(row.type))
			.filter((row) => !row.name.startsWith("sqlite_"))
			.map((row) => ({ name: row.name, kind: normalizeTableKind(row.type) }))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		const rows = sqlite
			.prepare(
				"SELECT name, type FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
			)
			.all() as SqliteTableListRow[];
		return rows
			.map((row) => ({ name: row.name, kind: normalizeTableKind(row.type) }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}
}

function loadSqliteIndexes(): SqliteIndexRow[] {
	return sqlite
		.prepare("SELECT name, tbl_name AS tableName FROM sqlite_schema WHERE type = 'index'")
		.all() as SqliteIndexRow[];
}

function loadDbstatObjectBytes(): { supported: boolean; bytesByName: Map<string, number> } {
	try {
		const rows = sqlite
			.prepare(
				"SELECT name, COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE schema = 'main' GROUP BY name",
			)
			.all() as Array<{ name: string; bytes: number | string | bigint }>;
		return {
			supported: true,
			bytesByName: new Map(rows.map((row) => [row.name, numberFromRow(row.bytes)])),
		};
	} catch {
		try {
			const rows = sqlite
				.prepare("SELECT name, COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat GROUP BY name")
				.all() as Array<{ name: string; bytes: number | string | bigint }>;
			return {
				supported: true,
				bytesByName: new Map(rows.map((row) => [row.name, numberFromRow(row.bytes)])),
			};
		} catch {
			return { supported: false, bytesByName: new Map() };
		}
	}
}

const tableColumnCache = new Map<string, string[]>();

function getTableValueColumnNames(tableName: string): string[] {
	const cached = tableColumnCache.get(tableName);
	if (cached) return cached;
	try {
		const rows = sqlite
			.prepare(`PRAGMA table_xinfo(${quoteIdentifier(tableName)})`)
			.all() as SqliteTableColumnRow[];
		const columns = rows
			.filter((row) => numberFromRow(row.hidden) === 0)
			.map((row) => row.name)
			.filter(Boolean);
		tableColumnCache.set(tableName, columns);
		return columns;
	} catch {
		tableColumnCache.set(tableName, []);
		return [];
	}
}

function buildApproxBytesExpression(tableName: string, alias: string): string {
	const columns = getTableValueColumnNames(tableName);
	if (columns.length === 0) return "0";
	return columns
		.map((column) => `length(CAST(coalesce(${alias}.${quoteIdentifier(column)}, '') AS BLOB))`)
		.join(" + ");
}

function sumTableApproxBytes(tableName: string, alias: string, fromClause: string): number {
	return sumBytesQuery(buildApproxBytesExpression(tableName, alias), fromClause);
}

function safeCountRows(tableName: string): number | null {
	try {
		return countQuery(`FROM ${quoteIdentifier(tableName)}`);
	} catch {
		return null;
	}
}

function safeEstimateTableContentBytes(tableName: string): number {
	try {
		return sumTableApproxBytes(tableName, "t", `FROM ${quoteIdentifier(tableName)} t`);
	} catch {
		return 0;
	}
}

function scanDatabaseObjectStorage(mainBytes: number): {
	pageSize: number;
	pageCount: number;
	freelistBytes: number;
	objectBytes: number;
	scanMode: "dbstat" | "approximate";
	categories: DatabaseStorageCategorySummary[];
	topTables: DatabaseStorageTableSummary[];
} {
	const pageSize = readPragmaNumber("page_size");
	const pageCount = readPragmaNumber("page_count");
	const rawFreelistBytes = pageSize * readPragmaNumber("freelist_count");
	const freelistBytes = Math.min(rawFreelistBytes, Math.max(mainBytes, pageSize * pageCount));
	const tables = loadSqliteTables();
	const indexes = loadSqliteIndexes();
	const indexesByTable = new Map<string, string[]>();
	for (const index of indexes) {
		const names = indexesByTable.get(index.tableName) ?? [];
		names.push(index.name);
		indexesByTable.set(index.tableName, names);
	}

	const dbstat = loadDbstatObjectBytes();
	const usedObjectNames = new Set<string>();
	const tableSummaries: DatabaseStorageTableSummary[] = tables.map((table) => {
		const rowCount = safeCountRows(table.name);
		// dbstat already gives exact page-level object sizes. Avoid an additional
		// SUM(length(...)) full-table scan for large message/dump tables on the
		// storage settings page; only compute content bytes in approximate mode.
		const approxContentBytes =
			dbstat.supported || table.kind === "virtual" ? 0 : safeEstimateTableContentBytes(table.name);
		const indexNames = indexesByTable.get(table.name) ?? [];
		const diskBytes = dbstat.supported
			? (dbstat.bytesByName.get(table.name) ?? 0)
			: approxContentBytes;
		const indexBytes = dbstat.supported
			? indexNames.reduce((sum, indexName) => sum + (dbstat.bytesByName.get(indexName) ?? 0), 0)
			: 0;
		usedObjectNames.add(table.name);
		for (const indexName of indexNames) {
			usedObjectNames.add(indexName);
		}
		return {
			name: table.name,
			category: getDatabaseStorageCategory(table.name),
			kind: table.kind,
			rowCount,
			approxContentBytes,
			diskBytes,
			indexBytes,
			totalBytes: diskBytes + indexBytes,
		};
	});

	const categoryMap = new Map<DatabaseStorageCategoryKey, DatabaseStorageCategorySummary>();
	const ensureCategory = (key: DatabaseStorageCategoryKey): DatabaseStorageCategorySummary => {
		const existing = categoryMap.get(key);
		if (existing) return existing;
		const created: DatabaseStorageCategorySummary = {
			key,
			tableCount: 0,
			rowCount: 0,
			approxContentBytes: 0,
			diskBytes: 0,
			indexBytes: 0,
			totalBytes: 0,
		};
		categoryMap.set(key, created);
		return created;
	};
	for (const table of tableSummaries) {
		const category = ensureCategory(table.category);
		category.tableCount += 1;
		category.rowCount += table.rowCount ?? 0;
		category.approxContentBytes += table.approxContentBytes;
		category.diskBytes += table.diskBytes;
		category.indexBytes += table.indexBytes;
		category.totalBytes += table.totalBytes;
	}

	let objectBytes = tableSummaries.reduce((sum, table) => sum + table.totalBytes, 0);
	if (dbstat.supported) {
		let internalBytes = 0;
		for (const [objectName, bytes] of dbstat.bytesByName) {
			if (usedObjectNames.has(objectName)) continue;
			internalBytes += bytes;
		}
		if (internalBytes > 0) {
			const internal = ensureCategory("internal");
			internal.diskBytes += internalBytes;
			internal.totalBytes += internalBytes;
			objectBytes += internalBytes;
		}
	}

	if (freelistBytes > 0) {
		const free = ensureCategory("free");
		free.diskBytes += freelistBytes;
		free.totalBytes += freelistBytes;
	}

	const categories = DATABASE_STORAGE_CATEGORY_KEYS.map((key) => categoryMap.get(key))
		.filter((category): category is DatabaseStorageCategorySummary => Boolean(category))
		.filter((category) => category.totalBytes > 0 || category.tableCount > 0);
	const topTables = tableSummaries
		.filter((table) => table.totalBytes > 0 || table.approxContentBytes > 0)
		.sort((a, b) => b.totalBytes - a.totalBytes || a.name.localeCompare(b.name))
		.slice(0, 12);

	return {
		pageSize,
		pageCount,
		freelistBytes,
		objectBytes,
		scanMode: dbstat.supported ? "dbstat" : "approximate",
		categories,
		topTables,
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
		const narratorFrom = `FROM narrators n JOIN ${narratorTable} target_n ON target_n.id = n.id`;
		const narrators = countQuery(narratorFrom);
		let toolCalls = 0;
		let apiRequests = 0;
		let approxBytes = sumTableApproxBytes("narrators", "n", narratorFrom);

		for (const relation of SESSION_OWNED_TABLES) {
			if (!tableExists(relation.tableName)) continue;
			const fromClause = `FROM ${quoteIdentifier(relation.tableName)} ${relation.alias}
				JOIN ${narratorTable} target_n ON target_n.id = ${relation.alias}.${quoteIdentifier(
					relation.narratorColumn,
				)}`;
			const count = countQuery(fromClause);
			approxBytes += sumTableApproxBytes(relation.tableName, relation.alias, fromClause);
			if (relation.countAs === "toolCalls") {
				toolCalls += count;
			} else if (relation.countAs === "apiRequests") {
				apiRequests += count;
			}
		}

		let dumpsCleared = 0;
		if (tableExists("api_requests")) {
			dumpsCleared = countQuery(
				`FROM api_requests ar
				 JOIN ${narratorTable} target_n ON target_n.id = ar.narrator_id
				 WHERE ar.raw_dump_json IS NOT NULL`,
			);
		}

		if (tableExists("background_tasks")) {
			const fromClause = `FROM background_tasks bt
				WHERE EXISTS (
					SELECT 1 FROM ${narratorTable} target_n
					WHERE target_n.id = bt.parent_narrator_id
					   OR target_n.id = bt.subagent_narrator_id
				)`;
			approxBytes += sumTableApproxBytes("background_tasks", "bt", fromClause);
		}

		const messageIds = tableExists("narrator_messages")
			? (sqlite
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
					.all() as Array<{ id: string }>)
			: [];
		const messageIdList = messageIds.map((row) => row.id);
		let messages = 0;
		if (messageIdList.length > 0) {
			messages = messageIdList.length;
			approxBytes += await withTempIdTable(
				messageIdList,
				"cleanup_messages",
				async (messageTable) =>
					sumTableApproxBytes(
						"narrator_messages",
						"m",
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
			approxBytes,
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
			const [archivedSessions, staleSessions, apiRequestDumps, objectStorage] = await Promise.all([
				summarizeSessionTarget("archivedSessions", cleanupContext),
				summarizeSessionTarget("staleSessions", cleanupContext, DEFAULT_STALE_SESSION_DAYS),
				summarizeDumpTarget(DEFAULT_API_REQUEST_DUMP_DAYS),
				Promise.resolve(scanDatabaseObjectStorage(fileSizes.mainBytes)),
			]);
			return {
				...fileSizes,
				...objectStorage,
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
				const beforeSizes = await getDatabaseFileSizes();
				const beforeBytes = totalDatabaseBytes(beforeSizes);
				const beforeStorage = scanDatabaseObjectStorage(beforeSizes.mainBytes);
				let checkpointRan = false;
				let optimized = false;

				try {
					sqlite.run("PRAGMA wal_checkpoint(TRUNCATE)");
					checkpointRan = true;
				} catch (error) {
					logger.warn("Database checkpoint before VACUUM failed", { error: String(error) });
				}

				sqlite.run("VACUUM");

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
				const afterStorage = scanDatabaseObjectStorage(afterSizes.mainBytes);
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
