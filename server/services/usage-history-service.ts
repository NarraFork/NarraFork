import { db } from "@server/db";
import { apiRequests, chapters, narrators } from "@server/db/schema";
import { getCodexManager } from "@server/lib/codex-manager";
import { settings } from "@server/lib/settings";
import { and, desc, eq, gte, like, lte, or, sql } from "drizzle-orm";

export interface UsageHistoryFilters {
	narratorId?: string;
	chapterId?: string;
	projectId?: string;
	provider?: string;
	model?: string;
	kind?: string;
	startDate?: string;
	endDate?: string;
	includeSubagents?: boolean;
}

export interface UsageHistoryStats {
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

export interface UsageHistoryTimeSeriesPoint {
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
	narratorId: string | null;
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

export class UsageHistoryService {
	/**
	 * Get credential display name from provider snapshots
	 */
	private getCredentialName(provider: string | null, credentialId: string | null): string | null {
		if (!provider || !credentialId) return null;

		try {
				if (!snapshot) return credentialId;
				const cred = snapshot.entries.find((c) => c.id === credentialId);
				return cred?.displayName || cred?.email || credentialId;
			}
			if (provider === "codex") {
				const manager = getCodexManager();
				const snapshot = manager.snapshot();
				const cred = snapshot.entries.find((c) => c.id === credentialId);
				return cred?.displayName || cred?.email || cred?.accountId || credentialId;
			}
			}
			// Anthropic and OpenAI don't have credential management
		} catch {
			// Ignore errors from snapshot calls (e.g., plugin not loaded)
		}

		return credentialId;
	}

	private parseRawDump(rawDumpJson: string | null): unknown | null {
		if (!rawDumpJson) return null;
		try {
			return JSON.parse(rawDumpJson);
		} catch {
			return { invalidJson: true, rawText: rawDumpJson };
		}
	}

	async listProviders(): Promise<string[]> {
		const rows = await db
			.select({ provider: apiRequests.provider })
			.from(apiRequests)
			.where(sql`${apiRequests.provider} is not null and trim(${apiRequests.provider}) <> ''`)
			.groupBy(apiRequests.provider)
			.orderBy(sql`lower(${apiRequests.provider}) asc`);

		return rows.flatMap((row) => (row.provider ? [row.provider] : []));
	}

	async listUsageHistory(
		filters: UsageHistoryFilters,
		page = 1,
		pageSize = 50,
	): Promise<{ records: UsageHistoryRecord[]; total: number }> {
		const offset = (page - 1) * pageSize;
		const conditions = this.buildWhereConditions(filters);

		const [countResult] = await db
			.select({ count: sql<number>`count(*)` })
			.from(apiRequests)
			.leftJoin(narrators, eq(apiRequests.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.where(and(...conditions));

		const total = countResult?.count ?? 0;

		const records = await db
			.select({
				id: apiRequests.id,
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
			.where(and(...conditions))
			.orderBy(desc(apiRequests.createdAt))
			.limit(pageSize)
			.offset(offset);

		return {
			records: records.map((r) => ({
				...r,
				credentialName: this.getCredentialName(r.provider, r.credentialId),
				inputTokens: r.inputTokens ?? 0,
				outputTokens: r.outputTokens ?? 0,
				cachedInputTokens: r.cachedInputTokens ?? 0,
				cacheCreationInputTokens: r.cacheCreationInputTokens ?? 0,
				cacheCreation5mTokens: r.cacheCreation5mTokens ?? 0,
				cacheCreation1hTokens: r.cacheCreation1hTokens ?? 0,
				reasoningTokens: r.reasoningTokens ?? 0,
				hasRawDump: !!r.rawDumpJson,
				errorMessage: r.errorMessage,
			})) as UsageHistoryRecord[],
			total,
		};
	}

	async getUsageStats(filters: UsageHistoryFilters): Promise<UsageHistoryStats> {
		const conditions = this.buildWhereConditions(filters);

		const [stats] = await db
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
				averageDurationMs: sql<number>`coalesce(avg(${apiRequests.durationMs}), 0)`,
				averageTtftMs: sql<number>`coalesce(avg(${apiRequests.ttftMs}), 0)`,
			})
			.from(apiRequests)
			.leftJoin(narrators, eq(apiRequests.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.where(and(...conditions));

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
			averageDurationMs: stats?.averageDurationMs ?? 0,
			averageTtftMs: stats?.averageTtftMs ?? 0,
		};
	}

	async getUsageTimeSeries(
		filters: UsageHistoryFilters,
		options: UsageHistoryTimeSeriesOptions = {},
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

		const rows = await db
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
			.where(and(...conditions))
			.groupBy(bucket)
			.orderBy(bucket);

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

	async getUsageRecord(id: string): Promise<UsageHistoryRecord | null> {
		const [record] = await db
			.select({
				id: apiRequests.id,
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

	private buildWhereConditions(filters: UsageHistoryFilters) {
		const conditions = [];
		const provider = filters.provider?.trim();
		const model = filters.model?.trim();
		const kind = filters.kind?.trim();

		if (filters.narratorId) {
			conditions.push(
				filters.includeSubagents
					? or(
							eq(apiRequests.narratorId, filters.narratorId),
							eq(narrators.parentNarratorId, filters.narratorId),
						)
					: eq(apiRequests.narratorId, filters.narratorId),
			);
		}
		if (filters.chapterId) conditions.push(eq(narrators.chapterId, filters.chapterId));
		if (filters.projectId) conditions.push(eq(chapters.projectId, filters.projectId));
		if (provider) conditions.push(eq(apiRequests.provider, provider));
		if (kind) conditions.push(eq(apiRequests.kind, kind));
		if (model) conditions.push(like(apiRequests.model, `%${model}%`));
		if (filters.startDate) conditions.push(gte(apiRequests.createdAt, filters.startDate));
		if (filters.endDate) conditions.push(lte(apiRequests.createdAt, filters.endDate));

		return conditions;
	}
}

export const usageHistoryService = new UsageHistoryService();
