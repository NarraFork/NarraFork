import { db } from "@server/db";
import { chapters, narratorMessages, narrators } from "@server/db/schema";
import { and, desc, eq, gte, like, lte, sql } from "drizzle-orm";

export interface UsageHistoryFilters {
	narratorId?: string;
	chapterId?: string;
	projectId?: string;
	provider?: string;
	model?: string;
	startDate?: string;
	endDate?: string;
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

export interface UsageHistoryRecord {
	id: string;
	narratorId: string;
	provider: string | null;
	credentialId: string | null;
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
	narratorTitle?: string | null;
	chapterTitle?: string | null;
	chapterId?: string | null;
	projectId?: string | null;
}

export class UsageHistoryService {
	async listUsageHistory(
		filters: UsageHistoryFilters,
		page = 1,
		pageSize = 50,
	): Promise<{ records: UsageHistoryRecord[]; total: number }> {
		const offset = (page - 1) * pageSize;
		const conditions = this.buildWhereConditions(filters);

		const [countResult] = await db
			.select({ count: sql<number>`count(*)` })
			.from(narratorMessages)
			.leftJoin(narrators, eq(narratorMessages.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.where(and(...conditions));

		const total = countResult?.count ?? 0;

		const records = await db
			.select({
				id: narratorMessages.id,
				narratorId: narratorMessages.narratorId,
				provider: narratorMessages.provider,
				credentialId: narratorMessages.credentialId,
				model: narratorMessages.model,
				inputTokens: narratorMessages.tokensIn,
				outputTokens: narratorMessages.outputTokens,
				cachedInputTokens: narratorMessages.cachedInputTokens,
				cacheCreationInputTokens: narratorMessages.cacheCreationInputTokens,
				cacheCreation5mTokens: narratorMessages.cacheCreation5mTokens,
				cacheCreation1hTokens: narratorMessages.cacheCreation1hTokens,
				reasoningTokens: narratorMessages.reasoningTokens,
				ttftMs: narratorMessages.ttftMs,
				durationMs: narratorMessages.durationMs,
				costUsd: narratorMessages.costUsd,
				contextPercent: narratorMessages.contextPercent,
				meterUsage: narratorMessages.meterUsage,
				meterUnit: narratorMessages.meterUnit,
				createdAt: narratorMessages.createdAt,
				narratorTitle: narrators.title,
				chapterTitle: chapters.title,
				chapterId: chapters.id,
				projectId: chapters.projectId,
			})
			.from(narratorMessages)
			.leftJoin(narrators, eq(narratorMessages.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.where(and(...conditions))
			.orderBy(desc(narratorMessages.createdAt))
			.limit(pageSize)
			.offset(offset);

		return {
			records: records.map((r) => ({
				...r,
				inputTokens: r.inputTokens ?? 0,
				outputTokens: r.outputTokens ?? 0,
				cachedInputTokens: r.cachedInputTokens ?? 0,
				cacheCreationInputTokens: r.cacheCreationInputTokens ?? 0,
				cacheCreation5mTokens: r.cacheCreation5mTokens ?? 0,
				cacheCreation1hTokens: r.cacheCreation1hTokens ?? 0,
				reasoningTokens: r.reasoningTokens ?? 0,
			})) as UsageHistoryRecord[],
			total,
		};
	}

	async getUsageStats(filters: UsageHistoryFilters): Promise<UsageHistoryStats> {
		const conditions = this.buildWhereConditions(filters);

		const [stats] = await db
			.select({
				totalRequests: sql<number>`count(*)`,
				totalInputTokens: sql<number>`coalesce(sum(${narratorMessages.tokensIn}), 0)`,
				totalOutputTokens: sql<number>`coalesce(sum(${narratorMessages.outputTokens}), 0)`,
				totalCacheCreationTokens: sql<number>`coalesce(sum(${narratorMessages.cacheCreationInputTokens}), 0)`,
				totalCacheReadTokens: sql<number>`coalesce(sum(${narratorMessages.cachedInputTokens}), 0)`,
				totalCacheCreation5mTokens: sql<number>`coalesce(sum(${narratorMessages.cacheCreation5mTokens}), 0)`,
				totalCacheCreation1hTokens: sql<number>`coalesce(sum(${narratorMessages.cacheCreation1hTokens}), 0)`,
				totalReasoningTokens: sql<number>`coalesce(sum(${narratorMessages.reasoningTokens}), 0)`,
				totalCost: sql<number>`coalesce(sum(${narratorMessages.costUsd}), 0)`,
				averageDurationMs: sql<number>`coalesce(avg(${narratorMessages.durationMs}), 0)`,
				averageTtftMs: sql<number>`coalesce(avg(${narratorMessages.ttftMs}), 0)`,
			})
			.from(narratorMessages)
			.leftJoin(narrators, eq(narratorMessages.narratorId, narrators.id))
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

	async getUsageRecord(id: string): Promise<UsageHistoryRecord | null> {
		const [record] = await db
			.select({
				id: narratorMessages.id,
				narratorId: narratorMessages.narratorId,
				provider: narratorMessages.provider,
				credentialId: narratorMessages.credentialId,
				model: narratorMessages.model,
				inputTokens: narratorMessages.tokensIn,
				outputTokens: narratorMessages.outputTokens,
				cachedInputTokens: narratorMessages.cachedInputTokens,
				cacheCreationInputTokens: narratorMessages.cacheCreationInputTokens,
				cacheCreation5mTokens: narratorMessages.cacheCreation5mTokens,
				cacheCreation1hTokens: narratorMessages.cacheCreation1hTokens,
				reasoningTokens: narratorMessages.reasoningTokens,
				ttftMs: narratorMessages.ttftMs,
				durationMs: narratorMessages.durationMs,
				costUsd: narratorMessages.costUsd,
				contextPercent: narratorMessages.contextPercent,
				meterUsage: narratorMessages.meterUsage,
				meterUnit: narratorMessages.meterUnit,
				createdAt: narratorMessages.createdAt,
				narratorTitle: narrators.title,
				chapterTitle: chapters.title,
				chapterId: chapters.id,
				projectId: chapters.projectId,
			})
			.from(narratorMessages)
			.leftJoin(narrators, eq(narratorMessages.narratorId, narrators.id))
			.leftJoin(chapters, eq(narrators.chapterId, chapters.id))
			.where(eq(narratorMessages.id, id));

		if (!record) return null;
		return {
			...record,
			inputTokens: record.inputTokens ?? 0,
			outputTokens: record.outputTokens ?? 0,
			cachedInputTokens: record.cachedInputTokens ?? 0,
			cacheCreationInputTokens: record.cacheCreationInputTokens ?? 0,
			cacheCreation5mTokens: record.cacheCreation5mTokens ?? 0,
			cacheCreation1hTokens: record.cacheCreation1hTokens ?? 0,
			reasoningTokens: record.reasoningTokens ?? 0,
		};
	}

	private buildWhereConditions(filters: UsageHistoryFilters) {
		const conditions = [
			eq(narratorMessages.role, "assistant"),
			sql`(
				coalesce(${narratorMessages.tokensIn}, 0) > 0 OR
				coalesce(${narratorMessages.outputTokens}, 0) > 0 OR
				coalesce(${narratorMessages.cachedInputTokens}, 0) > 0 OR
				coalesce(${narratorMessages.cacheCreationInputTokens}, 0) > 0
			)`,
		];

		if (filters.narratorId) conditions.push(eq(narratorMessages.narratorId, filters.narratorId));
		if (filters.chapterId) conditions.push(eq(narrators.chapterId, filters.chapterId));
		if (filters.projectId) conditions.push(eq(chapters.projectId, filters.projectId));
		if (filters.provider) conditions.push(eq(narratorMessages.provider, filters.provider));
		if (filters.model) conditions.push(like(narratorMessages.model, `%${filters.model}%`));
		if (filters.startDate) conditions.push(gte(narratorMessages.createdAt, filters.startDate));
		if (filters.endDate) conditions.push(lte(narratorMessages.createdAt, filters.endDate));

		return conditions;
	}
}

export const usageHistoryService = new UsageHistoryService();
