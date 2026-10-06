import { db } from "@server/db";
import { getDbPath } from "@server/db/connection";
import { apiRequests, chapters, narrators, users } from "@server/db/schema";
import { redactSpillPointerPaths } from "@server/lib/api-request-dump-store";
import { aggregateCostStatus, type CostStatus } from "@server/lib/cost-estimate";
import { resolveCredentialDisplayName } from "@server/lib/credential-display-name";
import { runReadTask } from "@server/lib/db-worker/pool";
import { AppError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import {
	encodeUsageHistoryCursor,
	type UsageHistoryCursor,
} from "@server/lib/usage-history-cursor";
import { normalizeModelFamily } from "@shared/model-id";

const costCoverageSelection = {
	unpricedRequestCount: sql<number>`coalesce(sum(case when ${apiRequests.costStatus} in ('partial','unknown') or (${apiRequests.costStatus} is null and ${apiRequests.costUsd} is null) then 1 else 0 end), 0)`,
	partialRequestCount: sql<number>`coalesce(sum(case when ${apiRequests.costStatus} = 'partial' then 1 else 0 end), 0)`,
};
function costCoverage(row?: {
	totalRequests?: number;
	requestCount?: number;
	count?: number;
	unpricedRequestCount?: number;
	partialRequestCount?: number;
}) {
	const unpricedRequestCount = Number(row?.unpricedRequestCount ?? 0);
	const partialRequestCount = Number(row?.partialRequestCount ?? 0);
	return {
		unpricedRequestCount,
		partialRequestCount,
		costStatus: aggregateCostStatus(
			Number(row?.totalRequests ?? row?.requestCount ?? row?.count ?? 0),
			unpricedRequestCount,
			partialRequestCount,
		),
		costIsPartial: unpricedRequestCount > 0,
	};
}
interface CostCoverage {
	costStatus: CostStatus;
	costIsPartial: boolean;
	unpricedRequestCount: number;
	partialRequestCount: number;
}

import { and, desc, eq, gte, lte, or, sql } from "drizzle-orm";

export interface UsageHistoryFilters {
	/** Historical owner; __unattributed__ selects requests with no recorded owner. */
	userId?: string;
	narratorId?: string;
	chapterId?: string;
	projectId?: string;
	provider?: string;
	/** Exact credential id — narrows history to one account in a provider pool. */
	credentialId?: string;
	model?: string;
	kind?: string;
	startDate?: string;
	endDate?: string;
	includeSubagents?: boolean;
}

export interface UsageHistoryStats extends CostCoverage {
	totalRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheCreationTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreation5mTokens: number;
	totalCacheCreation1hTokens: number;
	totalReasoningTokens: number;
	totalTokens: number;
	totalCost: number;
	averageDurationMs: number;
	averageTtftMs: number;
}

export type UsageHistoryGranularity = "hour" | "day" | "month";

export interface UsageHistoryTimeSeriesPoint extends CostCoverage {
	timestamp: string;
	requestCount: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheCreationTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreation5mTokens: number;
	totalCacheCreation1hTokens: number;
	totalReasoningTokens: number;
	totalTokens: number;
	totalCost: number;
	averageDurationMs: number;
	averageTtftMs: number;
	errorCount: number;
	meterUsage: number;
	meterUnit: string | null;
}

export interface UsageHistoryTimeSeriesResponse {
	granularity: UsageHistoryGranularity;
	points: UsageHistoryTimeSeriesPoint[];
	bucketCount: number;
	maxBuckets: number;
	truncated: boolean;
	requestedStartDate: string;
	requestedEndDate: string;
	effectiveStartDate: string;
	effectiveEndDate: string;
	generatedAt: string;
}

export interface UsageHistoryTimeSeriesOptions {
	granularity?: UsageHistoryGranularity;
	now?: Date;
}

export type UsageBreakdownDimension = "provider" | "model" | "kind" | "user";
export type UsageBreakdownMetric =
	| "requests"
	| "tokens"
	| "cost"
	| "inputTokens"
	| "outputTokens"
	| "reasoningTokens";

export interface UsageBreakdownEntry {
	label: string;
	value: number;
	percentage: number;
	count: number;
}

export interface UsageBreakdownResponse extends CostCoverage {
	dimension: UsageBreakdownDimension;
	metric: UsageBreakdownMetric;
	entries: UsageBreakdownEntry[];
	total: number;
}

export interface UsageStackedTimeSeriesResponse extends CostCoverage {
	granularity: UsageHistoryGranularity;
	dimension: UsageBreakdownDimension;
	metric: UsageBreakdownMetric;
	series: Array<{
		label: string;
		color: string;
		data: Array<{ timestamp: string; value: number }>;
	}>;
	timestamps: string[];
	truncated: boolean;
	effectiveStartDate: string;
	effectiveEndDate: string;
}

const USAGE_TIME_SERIES_CONFIG = {
	hour: { maxBuckets: 744, defaultBuckets: 24 * 7 },
	day: { maxBuckets: 366, defaultBuckets: 90 },
	month: { maxBuckets: 60, defaultBuckets: 24 },
} satisfies Record<UsageHistoryGranularity, { maxBuckets: number; defaultBuckets: number }>;

interface UsageTimeSeriesRange {
	startBucketDate: Date;
	endBucketDate: Date;
	requestedStartDate: string;
	requestedEndDate: string;
	effectiveStartDate: string;
	effectiveEndDate: string;
	truncated: boolean;
}

function parseDateOrNull(value: string | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Longest model substring we will match on. Model ids are far shorter. */
const MODEL_FILTER_MAX_LENGTH = 128;

/**
 * Normalize a model filter into a safe LIKE needle.
 *
 * Escapes the LIKE wildcards so a `%` typed by the user narrows nothing
 * unexpectedly, and caps the length so the per-row comparison stays cheap on a
 * filter that is already known to scan (see buildWhereConditions).
 */
function normalizeModelFilter(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return trimmed.slice(0, MODEL_FILTER_MAX_LENGTH).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function normalizeToBucketStart(date: Date, granularity: UsageHistoryGranularity): Date {
	const normalized = new Date(date.getTime());
	if (granularity === "hour") {
		normalized.setUTCMinutes(0, 0, 0);
		return normalized;
	}
	if (granularity === "day") {
		normalized.setUTCHours(0, 0, 0, 0);
		return normalized;
	}
	normalized.setUTCDate(1);
	normalized.setUTCHours(0, 0, 0, 0);
	return normalized;
}

function addBuckets(date: Date, amount: number, granularity: UsageHistoryGranularity): Date {
	const next = new Date(date.getTime());
	if (granularity === "hour") next.setUTCHours(next.getUTCHours() + amount);
	else if (granularity === "day") next.setUTCDate(next.getUTCDate() + amount);
	else next.setUTCMonth(next.getUTCMonth() + amount);
	return next;
}

function countBucketsBetween(start: Date, end: Date, granularity: UsageHistoryGranularity): number {
	if (start.getTime() > end.getTime()) return 0;
	if (granularity === "hour") {
		return Math.floor((end.getTime() - start.getTime()) / (60 * 60 * 1000)) + 1;
	}
	if (granularity === "day") {
		return Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
	}
	return (
		(end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
		(end.getUTCMonth() - start.getUTCMonth()) +
		1
	);
}

function buildBucketTimestamps(
	start: Date,
	end: Date,
	granularity: UsageHistoryGranularity,
): string[] {
	const timestamps: string[] = [];
	let cursor = new Date(start.getTime());
	const maxBuckets = USAGE_TIME_SERIES_CONFIG[granularity].maxBuckets;
	while (cursor.getTime() <= end.getTime() && timestamps.length < maxBuckets) {
		timestamps.push(cursor.toISOString());
		cursor = addBuckets(cursor, 1, granularity);
	}
	return timestamps;
}

function resolveUsageTimeSeriesRange(
	filters: UsageHistoryFilters,
	granularity: UsageHistoryGranularity,
	now: Date,
): UsageTimeSeriesRange {
	const config = USAGE_TIME_SERIES_CONFIG[granularity];
	const parsedEnd = parseDateOrNull(filters.endDate);
	const requestedEnd = parsedEnd ?? now;
	const requestedEndBucket = normalizeToBucketStart(requestedEnd, granularity);
	const parsedStart = parseDateOrNull(filters.startDate);
	let requestedStart =
		parsedStart ?? addBuckets(requestedEndBucket, -(config.defaultBuckets - 1), granularity);

	if (requestedStart.getTime() > requestedEnd.getTime()) {
		requestedStart = new Date(requestedEnd.getTime());
	}

	let startBucketDate = normalizeToBucketStart(requestedStart, granularity);
	const endBucketDate = normalizeToBucketStart(requestedEnd, granularity);
	let effectiveStart = requestedStart;
	let truncated = false;

	const bucketCount = countBucketsBetween(startBucketDate, endBucketDate, granularity);
	if (bucketCount > config.maxBuckets) {
		startBucketDate = addBuckets(endBucketDate, -(config.maxBuckets - 1), granularity);
		effectiveStart = startBucketDate;
		truncated = true;
	}

	return {
		startBucketDate,
		endBucketDate,
		requestedStartDate: requestedStart.toISOString(),
		requestedEndDate: requestedEnd.toISOString(),
		effectiveStartDate: effectiveStart.toISOString(),
		effectiveEndDate: requestedEnd.toISOString(),
		truncated,
	};
}

function getBucketExpression(granularity: UsageHistoryGranularity) {
	if (granularity === "hour") {
		return sql<string>`substr(${apiRequests.createdAt}, 1, 13) || ':00:00.000Z'`;
	}
	if (granularity === "day") {
		return sql<string>`substr(${apiRequests.createdAt}, 1, 10) || 'T00:00:00.000Z'`;
	}
	return sql<string>`substr(${apiRequests.createdAt}, 1, 7) || '-01T00:00:00.000Z'`;
}

function toNumber(value: unknown): number {
	const numberValue = Number(value ?? 0);
	return Number.isFinite(numberValue) ? numberValue : 0;
}

export interface UsageHistoryRecord {
	id: string;
	userId: string | null;
	username: string | null;
	narratorId: string | null;
	// 外部 Agent 写入时自带的叙述者文本（无 narrator 关联时用于占位显示）
	agentLabel?: string | null;
	kind: string;
	provider: string | null;
	credentialId: string | null;
	credentialName: string | null;
	model: string | null;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	cacheCreationInputTokens: number;
	cacheCreation5mTokens: number;
	cacheCreation1hTokens: number;
	reasoningTokens: number;
	ttftMs: number | null;
	durationMs: number | null;
	costUsd: number | null;
	costStatus: CostStatus | null;
	costMissingFields: string[] | null;
	contextPercent: number | null;
	meterUsage: number | null;
	meterUnit: string | null;
	createdAt: string;
	errorMessage?: string | null;
	narratorTitle?: string | null;
	chapterTitle?: string | null;
	chapterId?: string | null;
	projectId?: string | null;
	hasRawDump?: boolean;
	rawDump?: unknown | null;
}

/**
 * Row backing a dump download: the identity a forwarded dump needs, plus the raw JSON text.
 *
 * The dump stays a STRING here on purpose — parsing it would pull a multi-MB row through
 * the main thread for a response that may end up streaming a file instead.
 */
export interface RawDumpSource {
	id: string;
	userId: string | null;
	username: string | null;
	narratorId: string | null;
	narratorTitle: string | null;
	chapterId: string | null;
	chapterTitle: string | null;
	projectId: string | null;
	kind: string;
	provider: string | null;
	credentialId: string | null;
	credentialName: string | null;
	model: string | null;
	errorMessage: string | null;
	createdAt: string;
	rawDumpJson: string | null;
}

interface UsageHistoryListRow {
	id: string;
	userId: string | null;
	username: string | null;
	narratorId: string | null;
	agentLabel: string | null;
	kind: string;
	provider: string | null;
	credentialId: string | null;
	model: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cachedInputTokens: number | null;
	cacheCreationInputTokens: number | null;
	cacheCreation5mTokens: number | null;
	cacheCreation1hTokens: number | null;
	reasoningTokens: number | null;
	ttftMs: number | null;
	durationMs: number | null;
	costUsd: number | null;
	costStatus: CostStatus | null;
	costMissingFields: string[] | null;
	contextPercent: number | null;
	meterUsage: number | null;
	meterUnit: string | null;
	hasRawDump: number | null;
	errorMessage: string | null;
	createdAt: string;
	narratorTitle: string | null;
	chapterTitle: string | null;
	chapterId: string | null;
	projectId: string | null;
}

export interface UsageHistoryExecutionOptions {
	signal?: AbortSignal;
}

interface UsageAggregateQuery<Row> extends PromiseLike<Row[]> {
	toSQL(): { sql: string; params: unknown[] };
	_: { selectedFields: Record<string, unknown> };
}

export class UsageHistoryService {
	constructor(
		private readonly database: typeof db = db,
		private readonly workerDbPath: string | null = database === db ? getDbPath() : null,
	) {}

	/** Injected in-memory databases execute locally; production never falls back to a scan. */
	private async aggregate<Row>(
		query: UsageAggregateQuery<Row>,
		maxRows: number,
		execution: UsageHistoryExecutionOptions = {},
	): Promise<Row[]> {
		if (!this.workerDbPath) return await query;
		const startedAt = Date.now();
		const compiled = query.toSQL();
		try {
			return await runReadTask<Row[]>(
				this.workerDbPath,
				{
					kind: "usageHistoryQuery",
					sql: compiled.sql,
					params: compiled.params as (string | number | null)[],
					columns: Object.keys(query._.selectedFields),
					maxRows,
				},
				{ timeoutMs: 30_000, signal: execution.signal },
			);
		} catch (error) {
			logger.warn("Usage history aggregation worker failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw new AppError(
				"Usage statistics are temporarily unavailable",
				503,
				"USAGE_QUERY_UNAVAILABLE",
			);
		} finally {
			const durationMs = Date.now() - startedAt;
			if (durationMs > 1000) logger.warn("Slow usage history aggregation", { durationMs });
		}
	}

	/**
	 * Get credential display name from provider snapshots.
	 *
	 * Delegates to the shared resolver: the dump spill store needs the same answer, and two
	 * copies of this lookup would drift the moment a provider changes its snapshot shape.
	 */
	private getCredentialName(provider: string | null, credentialId: string | null): string | null {
		return resolveCredentialDisplayName(provider, credentialId);
	}

	private mapListRecord(row: UsageHistoryListRow): UsageHistoryRecord {
		return {
			...row,
			costMissingFields:
				typeof row.costMissingFields === "string"
					? JSON.parse(row.costMissingFields)
					: row.costMissingFields,
			credentialName: this.getCredentialName(row.provider, row.credentialId),
			inputTokens: row.inputTokens ?? 0,
			outputTokens: row.outputTokens ?? 0,
			cachedInputTokens: row.cachedInputTokens ?? 0,
			cacheCreationInputTokens: row.cacheCreationInputTokens ?? 0,
			cacheCreation5mTokens: row.cacheCreation5mTokens ?? 0,
			cacheCreation1hTokens: row.cacheCreation1hTokens ?? 0,
			reasoningTokens: row.reasoningTokens ?? 0,
			hasRawDump: Number(row.hasRawDump) === 1,
			errorMessage: row.errorMessage,
		};
	}

	private parseRawDump(rawDumpJson: string | null): unknown | null {
		if (!rawDumpJson) return null;
		try {
			// The spill pointer's absolute path is a property of the host, not of the request
			// being diagnosed, and it carries the OS account name. Strip it on the way out; the
			// download route resolves the path from the row itself.
			return redactSpillPointerPaths(JSON.parse(rawDumpJson));
		} catch {
			return { invalidJson: true, rawText: rawDumpJson };
		}
	}

	async listProviders(execution: UsageHistoryExecutionOptions = {}): Promise<string[]> {
		const query = this.database
			.select({ provider: apiRequests.provider })
			.from(apiRequests)
			.where(sql`${apiRequests.provider} is not null and trim(${apiRequests.provider}) <> ''`)
			.groupBy(apiRequests.provider)
			.orderBy(sql`lower(${apiRequests.provider}) asc`)
			.limit(1000);

		const rows = await this.aggregate(query, 1000, execution);
		return rows.flatMap((row) => (row.provider ? [row.provider] : []));
	}

	async listUsageHistory(
		filters: UsageHistoryFilters,
		page = 1,
		pageSize = 50,
		execution: UsageHistoryExecutionOptions = {},
	): Promise<{ records: UsageHistoryRecord[]; total: number }> {
		const offset = (page - 1) * pageSize;
		const conditions = this.buildWhereConditions(filters);

		const countQuery = this.database
			.select({ count: sql<number>`count(*)` })
			.from(apiRequests)
			.leftJoin(narrators, eq(apiRequests.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.leftJoin(users, eq(apiRequests.userId, users.id))
			.where(and(...conditions));

		const [countResult] = await this.aggregate(countQuery, 1, execution);
		const total = countResult?.count ?? 0;

		const records = await this.database
			.select({
				id: apiRequests.id,
				userId: apiRequests.userId,
				username: users.username,
				narratorId: apiRequests.narratorId,
				agentLabel: apiRequests.agentLabel,
				kind: apiRequests.kind,
				provider: apiRequests.provider,
				credentialId: apiRequests.credentialId,
				model: apiRequests.model,
				inputTokens: apiRequests.inputTokens,
				outputTokens: apiRequests.outputTokens,
				cachedInputTokens: apiRequests.cachedInputTokens,
				cacheCreationInputTokens: apiRequests.cacheCreationInputTokens,
				cacheCreation5mTokens: apiRequests.cacheCreation5mTokens,
				cacheCreation1hTokens: apiRequests.cacheCreation1hTokens,
				reasoningTokens: apiRequests.reasoningTokens,
				ttftMs: apiRequests.ttftMs,
				durationMs: apiRequests.durationMs,
				costUsd: apiRequests.costUsd,
				costStatus: apiRequests.costStatus,
				costMissingFields: apiRequests.costMissingFields,
				contextPercent: apiRequests.contextPercent,
				meterUsage: apiRequests.meterUsage,
				meterUnit: apiRequests.meterUnit,
				hasRawDump: sql<number>`CASE WHEN ${apiRequests.rawDumpJson} IS NOT NULL THEN 1 ELSE 0 END`,
				errorMessage: apiRequests.errorMessage,
				createdAt: apiRequests.createdAt,
				narratorTitle: narrators.title,
				chapterTitle: chapters.title,
				chapterId: narrators.chapterId,
				projectId: chapters.projectId,
			})
			.from(apiRequests)
			.leftJoin(narrators, eq(apiRequests.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.leftJoin(users, eq(apiRequests.userId, users.id))
			.where(and(...conditions))
			.orderBy(desc(apiRequests.createdAt), desc(apiRequests.id))
			.limit(pageSize)
			.offset(offset);

		return {
			records: records.map((row) => this.mapListRecord(row as UsageHistoryListRow)),
			total,
		};
	}

	async listUsageHistoryCursor(
		filters: UsageHistoryFilters,
		limit = 50,
		cursor?: UsageHistoryCursor,
	): Promise<{
		records: UsageHistoryRecord[];
		hasMore: boolean;
		nextCursor: string | null;
		limit: number;
	}> {
		const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 50;
		const boundedLimit = Math.min(Math.max(requestedLimit, 1), 100);
		const conditions = this.buildWhereConditions(filters);
		if (cursor) {
			conditions.push(
				sql`(${apiRequests.createdAt}, ${apiRequests.id}) < (${cursor.createdAt}, ${cursor.id})`,
			);
		}

		const rows = await this.database
			.select({
				id: apiRequests.id,
				userId: apiRequests.userId,
				username: users.username,
				narratorId: apiRequests.narratorId,
				agentLabel: apiRequests.agentLabel,
				kind: apiRequests.kind,
				provider: apiRequests.provider,
				credentialId: apiRequests.credentialId,
				model: apiRequests.model,
				inputTokens: apiRequests.inputTokens,
				outputTokens: apiRequests.outputTokens,
				cachedInputTokens: apiRequests.cachedInputTokens,
				cacheCreationInputTokens: apiRequests.cacheCreationInputTokens,
				cacheCreation5mTokens: apiRequests.cacheCreation5mTokens,
				cacheCreation1hTokens: apiRequests.cacheCreation1hTokens,
				reasoningTokens: apiRequests.reasoningTokens,
				ttftMs: apiRequests.ttftMs,
				durationMs: apiRequests.durationMs,
				costUsd: apiRequests.costUsd,
				costStatus: apiRequests.costStatus,
				costMissingFields: apiRequests.costMissingFields,
				contextPercent: apiRequests.contextPercent,
				meterUsage: apiRequests.meterUsage,
				meterUnit: apiRequests.meterUnit,
				hasRawDump: sql<number>`CASE WHEN ${apiRequests.rawDumpJson} IS NOT NULL THEN 1 ELSE 0 END`,
				errorMessage: apiRequests.errorMessage,
				createdAt: apiRequests.createdAt,
				narratorTitle: narrators.title,
				chapterTitle: chapters.title,
				chapterId: narrators.chapterId,
				projectId: chapters.projectId,
			})
			.from(apiRequests)
			.leftJoin(narrators, eq(apiRequests.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.leftJoin(users, eq(apiRequests.userId, users.id))
			.where(and(...conditions))
			.orderBy(desc(apiRequests.createdAt), desc(apiRequests.id))
			.limit(boundedLimit + 1);

		const hasMore = rows.length > boundedLimit;
		const records = (hasMore ? rows.slice(0, boundedLimit) : rows).map((row) =>
			this.mapListRecord(row as UsageHistoryListRow),
		);
		const lastRow = rows[boundedLimit - 1];

		return {
			records,
			hasMore,
			nextCursor:
				hasMore && lastRow
					? encodeUsageHistoryCursor({ createdAt: lastRow.createdAt, id: lastRow.id })
					: null,
			limit: boundedLimit,
		};
	}

	async getUsageStats(
		filters: UsageHistoryFilters,
		execution: UsageHistoryExecutionOptions = {},
	): Promise<UsageHistoryStats> {
		const conditions = this.buildWhereConditions(filters);

		const query = this.database
			.select({
				totalRequests: sql<number>`count(*)`,
				totalInputTokens: sql<number>`coalesce(sum(${apiRequests.inputTokens}), 0)`,
				totalOutputTokens: sql<number>`coalesce(sum(${apiRequests.outputTokens}), 0)`,
				totalCacheCreationTokens: sql<number>`coalesce(sum(${apiRequests.cacheCreationInputTokens}), 0)`,
				totalCacheReadTokens: sql<number>`coalesce(sum(${apiRequests.cachedInputTokens}), 0)`,
				totalCacheCreation5mTokens: sql<number>`coalesce(sum(${apiRequests.cacheCreation5mTokens}), 0)`,
				totalCacheCreation1hTokens: sql<number>`coalesce(sum(${apiRequests.cacheCreation1hTokens}), 0)`,
				totalReasoningTokens: sql<number>`coalesce(sum(${apiRequests.reasoningTokens}), 0)`,
				totalCost: sql<number>`coalesce(sum(${apiRequests.costUsd}), 0)`,
				...costCoverageSelection,
				averageDurationMs: sql<number>`coalesce(avg(${apiRequests.durationMs}), 0)`,
				averageTtftMs: sql<number>`coalesce(avg(${apiRequests.ttftMs}), 0)`,
			})
			.from(apiRequests)
			.leftJoin(narrators, eq(apiRequests.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.leftJoin(users, eq(apiRequests.userId, users.id))
			.where(and(...conditions));

		const [stats] = await this.aggregate(query, 1, execution);
		const totalInputTokens = stats?.totalInputTokens ?? 0;
		const totalOutputTokens = stats?.totalOutputTokens ?? 0;
		const totalCacheCreationTokens = stats?.totalCacheCreationTokens ?? 0;
		const totalCacheReadTokens = stats?.totalCacheReadTokens ?? 0;
		const totalReasoningTokens = stats?.totalReasoningTokens ?? 0;

		return {
			totalRequests: stats?.totalRequests ?? 0,
			totalInputTokens,
			totalOutputTokens,
			totalCacheCreationTokens,
			totalCacheReadTokens,
			totalCacheCreation5mTokens: stats?.totalCacheCreation5mTokens ?? 0,
			totalCacheCreation1hTokens: stats?.totalCacheCreation1hTokens ?? 0,
			totalReasoningTokens,
			totalTokens:
				totalInputTokens + totalOutputTokens + totalCacheCreationTokens + totalCacheReadTokens,
			totalCost: stats?.totalCost ?? 0,
			...costCoverage(stats),
			averageDurationMs: stats?.averageDurationMs ?? 0,
			averageTtftMs: stats?.averageTtftMs ?? 0,
		};
	}

	async getUsageTimeSeries(
		filters: UsageHistoryFilters,
		options: UsageHistoryTimeSeriesOptions = {},
		execution: UsageHistoryExecutionOptions = {},
	): Promise<UsageHistoryTimeSeriesResponse> {
		const granularity = options.granularity ?? "day";
		const config = USAGE_TIME_SERIES_CONFIG[granularity];
		const range = resolveUsageTimeSeriesRange(filters, granularity, options.now ?? new Date());
		const conditions = this.buildWhereConditions({
			...filters,
			startDate: range.effectiveStartDate,
			endDate: range.effectiveEndDate,
		});
		const bucket = getBucketExpression(granularity);

		const query = this.database
			.select({
				bucket,
				requestCount: sql<number>`count(*)`,
				totalInputTokens: sql<number>`coalesce(sum(${apiRequests.inputTokens}), 0)`,
				totalOutputTokens: sql<number>`coalesce(sum(${apiRequests.outputTokens}), 0)`,
				totalCacheCreationTokens: sql<number>`coalesce(sum(${apiRequests.cacheCreationInputTokens}), 0)`,
				totalCacheReadTokens: sql<number>`coalesce(sum(${apiRequests.cachedInputTokens}), 0)`,
				totalCacheCreation5mTokens: sql<number>`coalesce(sum(${apiRequests.cacheCreation5mTokens}), 0)`,
				totalCacheCreation1hTokens: sql<number>`coalesce(sum(${apiRequests.cacheCreation1hTokens}), 0)`,
				totalReasoningTokens: sql<number>`coalesce(sum(${apiRequests.reasoningTokens}), 0)`,
				totalCost: sql<number>`coalesce(sum(${apiRequests.costUsd}), 0)`,
				...costCoverageSelection,
				averageDurationMs: sql<number>`coalesce(avg(${apiRequests.durationMs}), 0)`,
				averageTtftMs: sql<number>`coalesce(avg(${apiRequests.ttftMs}), 0)`,
				errorCount: sql<number>`coalesce(sum(case when ${apiRequests.errorMessage} is not null and trim(${apiRequests.errorMessage}) <> '' then 1 else 0 end), 0)`,
				meterUsage: sql<number>`coalesce(sum(${apiRequests.meterUsage}), 0)`,
				meterUnit: sql<
					string | null
				>`case when count(distinct ${apiRequests.meterUnit}) = 1 then max(${apiRequests.meterUnit}) when count(distinct ${apiRequests.meterUnit}) > 1 then 'mixed' else null end`,
			})
			.from(apiRequests)
			.leftJoin(narrators, eq(apiRequests.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.leftJoin(users, eq(apiRequests.userId, users.id))
			.where(and(...conditions))
			.groupBy(bucket)
			.orderBy(bucket);

		const rows = await this.aggregate(query, config.maxBuckets, execution);
		const rowsByBucket = new Map(rows.map((row) => [row.bucket, row]));
		const points = buildBucketTimestamps(
			range.startBucketDate,
			range.endBucketDate,
			granularity,
		).map((timestamp) => {
			const row = rowsByBucket.get(timestamp);
			const totalInputTokens = toNumber(row?.totalInputTokens);
			const totalOutputTokens = toNumber(row?.totalOutputTokens);
			const totalCacheCreationTokens = toNumber(row?.totalCacheCreationTokens);
			const totalCacheReadTokens = toNumber(row?.totalCacheReadTokens);
			return {
				timestamp,
				requestCount: toNumber(row?.requestCount),
				totalInputTokens,
				totalOutputTokens,
				totalCacheCreationTokens,
				totalCacheReadTokens,
				totalCacheCreation5mTokens: toNumber(row?.totalCacheCreation5mTokens),
				totalCacheCreation1hTokens: toNumber(row?.totalCacheCreation1hTokens),
				totalReasoningTokens: toNumber(row?.totalReasoningTokens),
				totalTokens:
					totalInputTokens + totalOutputTokens + totalCacheCreationTokens + totalCacheReadTokens,
				totalCost: toNumber(row?.totalCost),
				...costCoverage(row),
				averageDurationMs: toNumber(row?.averageDurationMs),
				averageTtftMs: toNumber(row?.averageTtftMs),
				errorCount: toNumber(row?.errorCount),
				meterUsage: toNumber(row?.meterUsage),
				meterUnit: row?.meterUnit ?? null,
			};
		});

		return {
			granularity,
			points,
			bucketCount: points.length,
			maxBuckets: config.maxBuckets,
			truncated: range.truncated,
			requestedStartDate: range.requestedStartDate,
			requestedEndDate: range.requestedEndDate,
			effectiveStartDate: range.effectiveStartDate,
			effectiveEndDate: range.effectiveEndDate,
			generatedAt: new Date().toISOString(),
		};
	}

	/**
	 * Everything needed to serve a complete dump download.
	 *
	 * Separate from {@link getUsageRecord} because the download route must not read the
	 * dump text into a JSON response envelope when a spill file exists — it streams the
	 * file instead. Returning the raw JSON string lets the route decide.
	 */
	async getRawDumpSource(id: string): Promise<RawDumpSource | null> {
		const [record] = await this.database
			.select({
				id: apiRequests.id,
				userId: apiRequests.userId,
				username: users.username,
				narratorId: apiRequests.narratorId,
				kind: apiRequests.kind,
				provider: apiRequests.provider,
				credentialId: apiRequests.credentialId,
				model: apiRequests.model,
				errorMessage: apiRequests.errorMessage,
				createdAt: apiRequests.createdAt,
				rawDumpJson: apiRequests.rawDumpJson,
				// Joined only here, never in the list query: a downloaded dump gets forwarded to
				// whoever is helping diagnose it, and `narratorId` alone does not say which
				// conversation or project produced it. One row, indexed lookups — the CLAUDE.md
				// rule this respects is "list summaries stay lean", not "never join".
				narratorTitle: narrators.title,
				chapterId: narrators.chapterId,
				chapterTitle: chapters.title,
				projectId: chapters.projectId,
			})
			.from(apiRequests)
			.leftJoin(narrators, eq(apiRequests.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.leftJoin(users, eq(apiRequests.userId, users.id))
			.where(eq(apiRequests.id, id));
		if (!record) return null;
		return {
			...record,
			credentialName: this.getCredentialName(record.provider, record.credentialId),
		};
	}

	async getUsageRecord(id: string): Promise<UsageHistoryRecord | null> {
		const [record] = await this.database
			.select({
				id: apiRequests.id,
				userId: apiRequests.userId,
				username: users.username,
				narratorId: apiRequests.narratorId,
				kind: apiRequests.kind,
				provider: apiRequests.provider,
				credentialId: apiRequests.credentialId,
				model: apiRequests.model,
				inputTokens: apiRequests.inputTokens,
				outputTokens: apiRequests.outputTokens,
				cachedInputTokens: apiRequests.cachedInputTokens,
				cacheCreationInputTokens: apiRequests.cacheCreationInputTokens,
				cacheCreation5mTokens: apiRequests.cacheCreation5mTokens,
				cacheCreation1hTokens: apiRequests.cacheCreation1hTokens,
				reasoningTokens: apiRequests.reasoningTokens,
				ttftMs: apiRequests.ttftMs,
				durationMs: apiRequests.durationMs,
				costUsd: apiRequests.costUsd,
				costStatus: apiRequests.costStatus,
				costMissingFields: apiRequests.costMissingFields,
				contextPercent: apiRequests.contextPercent,
				meterUsage: apiRequests.meterUsage,
				meterUnit: apiRequests.meterUnit,
				rawDumpJson: apiRequests.rawDumpJson,
				errorMessage: apiRequests.errorMessage,
				createdAt: apiRequests.createdAt,
				narratorTitle: narrators.title,
				chapterTitle: chapters.title,
				chapterId: narrators.chapterId,
				projectId: chapters.projectId,
			})
			.from(apiRequests)
			.leftJoin(narrators, eq(apiRequests.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.leftJoin(users, eq(apiRequests.userId, users.id))
			.where(eq(apiRequests.id, id));

		if (!record) return null;
		const { rawDumpJson, ...rest } = record;
		return {
			...rest,
			credentialName: this.getCredentialName(record.provider, record.credentialId),
			inputTokens: record.inputTokens ?? 0,
			outputTokens: record.outputTokens ?? 0,
			cachedInputTokens: record.cachedInputTokens ?? 0,
			cacheCreationInputTokens: record.cacheCreationInputTokens ?? 0,
			cacheCreation5mTokens: record.cacheCreation5mTokens ?? 0,
			cacheCreation1hTokens: record.cacheCreation1hTokens ?? 0,
			reasoningTokens: record.reasoningTokens ?? 0,
			hasRawDump: !!rawDumpJson,
			rawDump: this.parseRawDump(rawDumpJson),
			errorMessage: record.errorMessage,
		};
	}

	async getUsageBreakdown(
		filters: UsageHistoryFilters,
		options: {
			dimension: UsageBreakdownDimension;
			metric: UsageBreakdownMetric;
			cluster?: boolean;
		},
		execution: UsageHistoryExecutionOptions = {},
	): Promise<UsageBreakdownResponse> {
		const { dimension, metric, cluster = true } = options;
		const conditions = this.buildWhereConditions(filters);

		const dimensionColumn = this.getDimensionColumn(dimension);
		const metricAgg = this.getMetricAggregation(metric);
		const shouldCluster = dimension === "model" && cluster;
		const queryLimit = shouldCluster ? 200 : 20;

		const query = this.database
			.select({
				label: dimension === "user" ? this.getDimensionLabel(dimension) : dimensionColumn,
				value: metricAgg,
				count: sql<number>`count(*)`,
				// Window totals are evaluated before LIMIT, so user proportions include all users.
				overallValue:
					dimension === "user" ? sql<number>`sum(${metricAgg}) over ()` : sql<number>`0`,
				overallCount: dimension === "user" ? sql<number>`sum(count(*)) over ()` : sql<number>`0`,
			})
			.from(apiRequests)
			.leftJoin(narrators, eq(apiRequests.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.leftJoin(users, eq(apiRequests.userId, users.id))
			.where(and(...conditions))
			.groupBy(dimensionColumn)
			.orderBy(sql`${metricAgg} DESC`)
			.limit(queryLimit);

		const rows = await this.aggregate(query, queryLimit, execution);
		const grouped = new Map<string, { value: number; count: number }>();
		const entries: UsageBreakdownEntry[] = [];
		for (const row of rows) {
			const label = shouldCluster ? normalizeModelFamily(row.label) : row.label;
			if (shouldCluster) {
				const previous = grouped.get(label) ?? { value: 0, count: 0 };
				previous.value += toNumber(row.value);
				previous.count += toNumber(row.count);
				grouped.set(label, previous);
			} else {
				entries.push({
					label,
					value: toNumber(row.value),
					count: toNumber(row.count),
					percentage: 0,
				});
			}
		}
		if (shouldCluster) {
			entries.push(
				...[...grouped.entries()]
					.sort((a, b) => b[1].value - a[1].value)
					.slice(0, 20)
					.map(([label, value]) => ({ label, ...value, percentage: 0 })),
			);
		}

		const visibleTotal = entries.reduce((sum, entry) => sum + entry.value, 0);
		const total = dimension === "user" ? toNumber(rows[0]?.overallValue) : visibleTotal;
		if (dimension === "user") {
			const otherCount =
				toNumber(rows[0]?.overallCount) - entries.reduce((sum, entry) => sum + entry.count, 0);
			if (otherCount > 0)
				entries.push({
					label: "other",
					value: total - visibleTotal,
					count: otherCount,
					percentage: 0,
				});
		}
		for (const entry of entries) {
			entry.percentage = total > 0 ? Math.round((entry.value / total) * 10000) / 100 : 0;
		}

		// Coverage is over the whole filter, not merely the visible top-N slice.
		const coverage = await this.getUsageStats(filters, execution);
		return { dimension, metric, entries, total, ...costCoverage(coverage) };
	}

	async getUsageTimeSeriesStacked(
		filters: UsageHistoryFilters,
		options: {
			dimension: UsageBreakdownDimension;
			metric: UsageBreakdownMetric;
			granularity?: UsageHistoryGranularity;
			topN?: number;
			cluster?: boolean;
			now?: Date;
		},
		execution: UsageHistoryExecutionOptions = {},
	): Promise<UsageStackedTimeSeriesResponse> {
		const granularity = options.granularity ?? "day";
		const topN = Math.min(Math.max(options.topN ?? 5, 2), 10);
		const { dimension, metric, cluster = true } = options;
		const shouldCluster = dimension === "model" && cluster;
		const range = resolveUsageTimeSeriesRange(filters, granularity, options.now ?? new Date());
		const conditions = this.buildWhereConditions({
			...filters,
			startDate: range.effectiveStartDate,
			endDate: range.effectiveEndDate,
		});

		const dimensionColumn = this.getDimensionColumn(dimension);
		const metricAgg = this.getMetricAggregation(metric);

		// Group users by historical ID, never by their mutable display names.
		const topQuery = this.database
			.select({
				label: dimensionColumn,
				displayLabel: dimension === "user" ? this.getDimensionLabel(dimension) : dimensionColumn,
				total: metricAgg,
			})
			.from(apiRequests)
			.leftJoin(narrators, eq(apiRequests.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.leftJoin(users, eq(apiRequests.userId, users.id))
			.where(and(...conditions))
			.groupBy(dimensionColumn)
			.orderBy(sql`${metricAgg} DESC`, dimensionColumn)
			.limit(shouldCluster ? 200 : topN);
		const topLabelsRaw = await this.aggregate(topQuery, shouldCluster ? 200 : topN, execution);
		const familyTotals = new Map<string, number>();
		if (shouldCluster) {
			for (const row of topLabelsRaw) {
				const family = normalizeModelFamily(row.label);
				familyTotals.set(family, (familyTotals.get(family) ?? 0) + toNumber(row.total));
			}
		}
		const topLabelSet = new Set(
			shouldCluster
				? [...familyTotals.entries()]
						.sort((a, b) => b[1] - a[1])
						.slice(0, topN)
						.map(([label]) => label)
				: topLabelsRaw.map((row) => row.label),
		);
		const displayLabels = new Map(topLabelsRaw.map((row) => [row.label, row.displayLabel]));

		// Fold non-top dimensions into NULL in SQL, not after transferring every dimension.
		// NULL is an internal "other" bucket distinct from real labels such as "other".
		const bucket = getBucketExpression(granularity);
		const groupedLabel = shouldCluster
			? dimensionColumn
			: topLabelSet.size
				? sql<string | null>`case when ${dimensionColumn} in (${sql.join(
						[...topLabelSet].map((label) => sql`${label}`),
						sql`, `,
					)}) then ${dimensionColumn} else null end`
				: sql<string | null>`null`;
		const bucketQuery = this.database
			.select({
				bucket,
				label: groupedLabel,
				value: metricAgg,
				requestCount: sql<number>`count(*)`,
				...costCoverageSelection,
			})
			.from(apiRequests)
			.leftJoin(narrators, eq(apiRequests.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.leftJoin(users, eq(apiRequests.userId, users.id))
			.where(and(...conditions))
			.groupBy(bucket, groupedLabel)
			.orderBy(bucket);
		const rows = await this.aggregate(
			bucketQuery,
			shouldCluster ? 10_000 : USAGE_TIME_SERIES_CONFIG[granularity].maxBuckets * (topN + 1),
			execution,
		);

		// Step 3: build timestamps and series
		const timestamps = buildBucketTimestamps(
			range.startBucketDate,
			range.endBucketDate,
			granularity,
		);

		// Group data by label+bucket
		const dataMap = new Map<string, Map<string, number>>();
		const otherMap = new Map<string, number>();

		for (const row of rows) {
			const label = shouldCluster ? normalizeModelFamily(row.label) : row.label;
			const ts = row.bucket;
			const value = toNumber(row.value);

			if (label !== null && topLabelSet.has(label)) {
				let labelMap = dataMap.get(label);
				if (!labelMap) {
					labelMap = new Map();
					dataMap.set(label, labelMap);
				}
				const existing = labelMap.get(ts) ?? 0;
				labelMap.set(ts, existing + value);
			} else {
				const existing = otherMap.get(ts) ?? 0;
				otherMap.set(ts, existing + value);
			}
		}

		// Build series
		const STACKED_COLORS = [
			"var(--mantine-color-indigo-6)",
			"var(--mantine-color-cyan-6)",
			"var(--mantine-color-green-6)",
			"var(--mantine-color-orange-6)",
			"var(--mantine-color-violet-6)",
			"var(--mantine-color-red-6)",
			"var(--mantine-color-teal-6)",
			"var(--mantine-color-yellow-6)",
			"var(--mantine-color-pink-6)",
			"var(--mantine-color-blue-6)",
		];

		const series: UsageStackedTimeSeriesResponse["series"] = [];
		let colorIndex = 0;
		for (const label of topLabelSet) {
			const labelData = dataMap.get(label);
			series.push({
				label: displayLabels.get(label) ?? label,
				color: STACKED_COLORS[colorIndex % STACKED_COLORS.length],
				data: timestamps.map((ts) => ({ timestamp: ts, value: labelData?.get(ts) ?? 0 })),
			});
			colorIndex++;
		}

		// Add "other" series if there's any data
		const hasOtherData = otherMap.size > 0;
		if (hasOtherData) {
			series.push({
				label: "other",
				color: "var(--mantine-color-gray-6)",
				data: timestamps.map((ts) => ({ timestamp: ts, value: otherMap.get(ts) ?? 0 })),
			});
		}

		return {
			granularity,
			dimension,
			metric,
			series,
			...costCoverage(
				rows.reduce(
					(sum, row) => ({
						requestCount: sum.requestCount + toNumber(row.requestCount),
						unpricedRequestCount: sum.unpricedRequestCount + toNumber(row.unpricedRequestCount),
						partialRequestCount: sum.partialRequestCount + toNumber(row.partialRequestCount),
					}),
					{ requestCount: 0, unpricedRequestCount: 0, partialRequestCount: 0 },
				),
			),
			timestamps,
			truncated: range.truncated,
			effectiveStartDate: range.effectiveStartDate,
			effectiveEndDate: range.effectiveEndDate,
		};
	}

	private getDimensionLabel(dimension: UsageBreakdownDimension) {
		return dimension === "user"
			? sql<string>`case when ${apiRequests.userId} is null then '__unattributed__' else coalesce(${users.username}, ${apiRequests.userId}) end`
			: this.getDimensionColumn(dimension);
	}

	private getDimensionColumn(dimension: UsageBreakdownDimension) {
		switch (dimension) {
			case "provider":
				return sql<string>`coalesce(${apiRequests.provider}, 'unknown')`;
			case "model":
				return sql<string>`coalesce(${apiRequests.model}, 'unknown')`;
			case "kind":
				return sql<string>`${apiRequests.kind}`;
			case "user":
				return sql<string>`coalesce(${apiRequests.userId}, '__unattributed__')`;
		}
	}

	private getMetricAggregation(metric: UsageBreakdownMetric) {
		switch (metric) {
			case "requests":
				return sql<number>`count(*)`;
			case "tokens":
				return sql<number>`coalesce(sum(${apiRequests.inputTokens}), 0) + coalesce(sum(${apiRequests.outputTokens}), 0) + coalesce(sum(${apiRequests.cachedInputTokens}), 0) + coalesce(sum(${apiRequests.cacheCreationInputTokens}), 0)`;
			case "cost":
				return sql<number>`coalesce(sum(${apiRequests.costUsd}), 0)`;
			case "inputTokens":
				return sql<number>`coalesce(sum(${apiRequests.inputTokens}), 0)`;
			case "outputTokens":
				return sql<number>`coalesce(sum(${apiRequests.outputTokens}), 0)`;
			case "reasoningTokens":
				return sql<number>`coalesce(sum(${apiRequests.reasoningTokens}), 0)`;
		}
	}

	private buildWhereConditions(filters: UsageHistoryFilters) {
		const conditions = [];
		const provider = filters.provider?.trim();
		const model = normalizeModelFilter(filters.model);
		const kind = filters.kind?.trim();
		const credentialId = filters.credentialId?.trim();
		const userId = filters.userId?.trim();
		if (userId) {
			conditions.push(
				userId === "__unattributed__"
					? sql`${apiRequests.userId} IS NULL`
					: eq(apiRequests.userId, userId),
			);
		}

		if (filters.narratorId) {
			// Both sides of the OR must be predicates on `api_requests.narrator_id` so
			// SQLite can serve them from idx_api_requests_narrator (it plans this as a
			// MULTI-INDEX OR). Matching `narrators.parentNarratorId` directly puts a
			// joined-table column in the OR instead, which defeats that index and
			// degrades every caller into a full scan of api_requests — measured at
			// 223ms vs 46ms over 385k rows, on a query that runs whenever a narrator
			// page is opened.
			conditions.push(
				filters.includeSubagents
					? or(
							eq(apiRequests.narratorId, filters.narratorId),
							sql`${apiRequests.narratorId} IN (SELECT ${narrators.id} FROM ${narrators} WHERE ${narrators.parentNarratorId} = ${filters.narratorId})`,
						)
					: eq(apiRequests.narratorId, filters.narratorId),
			);
		}
		if (filters.chapterId) conditions.push(eq(narrators.chapterId, filters.chapterId));
		if (filters.projectId) conditions.push(eq(chapters.projectId, filters.projectId));
		if (provider) conditions.push(eq(apiRequests.provider, provider));
		// Exact match, backed by idx_api_requests_credential: credential ids are
		// opaque nanoids, so a LIKE here would only buy a table scan.
		if (credentialId) conditions.push(eq(apiRequests.credentialId, credentialId));
		if (kind) conditions.push(eq(apiRequests.kind, kind));
		// KNOWN SCAN: substring matching cannot use idx_api_requests_provider, so a
		// model filter reads every candidate row. Kept as a substring because the UI
		// exposes it as a free-text box ("Filter by model") and users rely on partial
		// names like "codex" or "mini"; switching to a prefix would silently change
		// what their saved filters return.
		//
		// It is bounded in practice: this filter is only reachable from the admin
		// usage-history page, every caller of buildWhereConditions applies a LIMIT
		// (page/cursor pagination) or aggregates into a fixed number of buckets, and
		// the pattern is length-capped above so a pathological input cannot make the
		// per-row comparison expensive. Escaped for LIKE so `%`/`_` in the input
		// cannot widen the match beyond what the user typed.
		if (model) {
			conditions.push(sql`${apiRequests.model} LIKE ${`%${model}%`} ESCAPE '\\'`);
		}
		if (filters.startDate) conditions.push(gte(apiRequests.createdAt, filters.startDate));
		if (filters.endDate) conditions.push(lte(apiRequests.createdAt, filters.endDate));

		return conditions;
	}
}

export const usageHistoryService = new UsageHistoryService();
