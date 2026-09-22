import { db as defaultDb } from "@server/db";
import { apiRequests, users, userUsageTotals } from "@server/db/schema";
import { aggregateCostStatus } from "@server/lib/cost-estimate";
import { asc, eq, gt, sql } from "drizzle-orm";

type Db = typeof defaultDb;
type RequestRecord = typeof apiRequests.$inferInsert;

function nonNegative(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Commit detail and lifetime user totals together. Only one indexed insert/upsert,
 * never an aggregate scan. Duplicate completion cannot charge the user twice.
 * Throw on failure so callers can log/retry; never leave a detail without its rollup.
 * Unknown initiators remain null and do not get attributed to any real user.
 */
export function insertApiRequestWithUserUsage(
	record: RequestRecord,
	database: Db = defaultDb,
): boolean {
	return database.transaction((tx) => {
		const inserted = tx
			.insert(apiRequests)
			.values(record)
			.onConflictDoNothing({ target: apiRequests.id })
			.returning({ id: apiRequests.id })
			.get();
		if (!inserted) return false;
		if (!record.userId) return true;

		const inputTokens = Math.round(nonNegative(record.inputTokens));
		const outputTokens = Math.round(nonNegative(record.outputTokens));
		const cachedInputTokens = Math.round(nonNegative(record.cachedInputTokens));
		const cacheCreationTokens = Math.round(nonNegative(record.cacheCreationInputTokens));
		const reasoningTokens = Math.round(nonNegative(record.reasoningTokens));
		const priced =
			(record.costStatus == null || record.costStatus === "complete") &&
			typeof record.costUsd === "number" &&
			Number.isFinite(record.costUsd) &&
			record.costUsd >= 0;
		const partial = record.costStatus === "partial" ? 1 : 0;
		const costUsd = nonNegative(record.costUsd);
		const at = record.createdAt;
		tx.insert(userUsageTotals)
			.values({
				userId: record.userId,
				requestCount: 1,
				inputTokens,
				outputTokens,
				cachedInputTokens,
				cacheCreationTokens,
				reasoningTokens,
				costUsd,
				unpricedRequestCount: priced ? 0 : 1,
				partialRequestCount: partial,
				firstUsedAt: at,
				lastUsedAt: at,
			})
			.onConflictDoUpdate({
				target: userUsageTotals.userId,
				set: {
					requestCount: sql`${userUsageTotals.requestCount} + 1`,
					inputTokens: sql`${userUsageTotals.inputTokens} + ${inputTokens}`,
					outputTokens: sql`${userUsageTotals.outputTokens} + ${outputTokens}`,
					cachedInputTokens: sql`${userUsageTotals.cachedInputTokens} + ${cachedInputTokens}`,
					cacheCreationTokens: sql`${userUsageTotals.cacheCreationTokens} + ${cacheCreationTokens}`,
					reasoningTokens: sql`${userUsageTotals.reasoningTokens} + ${reasoningTokens}`,
					costUsd: sql`${userUsageTotals.costUsd} + ${costUsd}`,
					unpricedRequestCount: sql`${userUsageTotals.unpricedRequestCount} + ${priced ? 0 : 1}`,
					partialRequestCount: sql`${userUsageTotals.partialRequestCount} + ${partial}`,
					firstUsedAt: sql`min(${userUsageTotals.firstUsedAt}, ${at})`,
					lastUsedAt: sql`max(${userUsageTotals.lastUsedAt}, ${at})`,
				},
			})
			.run();
		return true;
	});
}

/** One row per user, keyset-paginated by the primary key; no COUNT or SUM at read time. */
export function listUserUsageTotals(limit = 50, cursor?: string, database: Db = defaultDb) {
	const boundedLimit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 50;
	const rows = database
		.select({
			userId: userUsageTotals.userId,
			username: users.username,
			requestCount: userUsageTotals.requestCount,
			inputTokens: userUsageTotals.inputTokens,
			outputTokens: userUsageTotals.outputTokens,
			cachedInputTokens: userUsageTotals.cachedInputTokens,
			cacheCreationTokens: userUsageTotals.cacheCreationTokens,
			reasoningTokens: userUsageTotals.reasoningTokens,
			costUsd: userUsageTotals.costUsd,
			unpricedRequestCount: userUsageTotals.unpricedRequestCount,
			partialRequestCount: userUsageTotals.partialRequestCount,
			firstUsedAt: userUsageTotals.firstUsedAt,
			lastUsedAt: userUsageTotals.lastUsedAt,
		})
		.from(userUsageTotals)
		.leftJoin(users, eq(users.id, userUsageTotals.userId))
		.where(cursor ? gt(userUsageTotals.userId, cursor) : undefined)
		.orderBy(asc(userUsageTotals.userId))
		.limit(boundedLimit + 1)
		.all();
	const hasMore = rows.length > boundedLimit;
	const records = rows.slice(0, boundedLimit).map((row) => ({
		...row,
		costUsd: Number(row.costUsd.toFixed(6)),
		costStatus: aggregateCostStatus(
			row.requestCount,
			row.unpricedRequestCount,
			row.partialRequestCount,
		),
		costIsPartial: row.unpricedRequestCount > 0,
	}));
	return {
		records,
		hasMore,
		nextCursor: hasMore ? (records.at(-1)?.userId ?? null) : null,
		limit: boundedLimit,
	};
}
