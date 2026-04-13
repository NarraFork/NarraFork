import { db } from "@server/db";
import { apiRequests, chapters, narrators } from "@server/db/schema";
import { getCodexManager } from "@server/lib/codex-manager";
import { settings } from "@server/lib/settings";
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
				if (!snapshot) return null;
				const cred = snapshot.entries.find((c) => c.id === credentialId);
				return cred?.displayName || cred?.email || null;
			}
			if (provider === "codex") {
				const manager = getCodexManager();
				const snapshot = manager.snapshot();
				const cred = snapshot.entries.find((c) => c.id === credentialId);
				return cred?.displayName || cred?.email || null;
			}
			}
			// Anthropic and OpenAI don't have credential management
		} catch {
			// Ignore errors from snapshot calls (e.g., plugin not loaded)
		}

		return null;
	}

	private parseRawDump(rawDumpJson: string | null): unknown | null {
		if (!rawDumpJson) return null;
		try {
			return JSON.parse(rawDumpJson);
		} catch {
			return { invalidJson: true, rawText: rawDumpJson };
		}
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

	async getUsageRecord(id: string): Promise<UsageHistoryRecord | null> {
		const [record] = await db
			.select({
				id: apiRequests.id,
				narratorId: apiRequests.narratorId,
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
		};
	}

	private buildWhereConditions(filters: UsageHistoryFilters) {
		const conditions = [];

		if (filters.narratorId) conditions.push(eq(apiRequests.narratorId, filters.narratorId));
		if (filters.chapterId) conditions.push(eq(narrators.chapterId, filters.chapterId));
		if (filters.projectId) conditions.push(eq(chapters.projectId, filters.projectId));
		if (filters.provider) conditions.push(eq(apiRequests.provider, filters.provider));
		if (filters.model) conditions.push(like(apiRequests.model, `%${filters.model}%`));
		if (filters.startDate) conditions.push(gte(apiRequests.createdAt, filters.startDate));
		if (filters.endDate) conditions.push(lte(apiRequests.createdAt, filters.endDate));

		return conditions;
	}
}

export const usageHistoryService = new UsageHistoryService();
