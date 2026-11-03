import type { db as defaultDb } from "@server/db";
import { type apiRequests, narrators, usageDaily } from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { eq, sql } from "drizzle-orm";
import { narratorProjectIdColumn } from "./narrator-project";

type Tx = Parameters<Parameters<typeof defaultDb.transaction>[0]>[0];
type RequestRecord = typeof apiRequests.$inferInsert;

export interface RequestAttribution {
	billingUserId: string | null;
	projectId: string | null;
}

/**
 * Who pays for a request and which project it belongs to, read from the root narrator
 * (subagents inherit both from the session they run under). Requests without a
 * narrator are paid by their initiator and belong to no project. Two primary-key
 * lookups; the project expression is served by the partial unique index on links.
 */
export function resolveRequestAttribution(
	tx: Tx,
	narratorId: string | null | undefined,
	initiatorUserId: string | null | undefined,
): RequestAttribution {
	if (!narratorId) return { billingUserId: initiatorUserId ?? null, projectId: null };
	const source = tx
		.select({ rootId: sql<string>`coalesce(${narrators.aclRootNarratorId}, ${narrators.id})` })
		.from(narrators)
		.where(eq(narrators.id, narratorId))
		.get();
	if (!source) return { billingUserId: null, projectId: null };
	const root = tx
		.select({ ownerUserId: narrators.ownerUserId, projectId: narratorProjectIdColumn })
		.from(narrators)
		.where(eq(narrators.id, source.rootId))
		.get();
	return { billingUserId: root?.ownerUserId ?? null, projectId: root?.projectId ?? null };
}

function nonNegativeInt(value: number | null | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** One indexed upsert into the day's bucket; called inside the detail-row transaction. */
export function addUsageDaily(tx: Tx, record: RequestRecord): void {
	const priced =
		(record.costStatus == null || record.costStatus === "complete") &&
		typeof record.costUsd === "number" &&
		Number.isFinite(record.costUsd) &&
		record.costUsd >= 0;
	const costUsd =
		typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costUsd > 0
			? record.costUsd
			: 0;
	const tokens = {
		inputTokens: nonNegativeInt(record.inputTokens),
		outputTokens: nonNegativeInt(record.outputTokens),
		cachedInputTokens: nonNegativeInt(record.cachedInputTokens),
		cacheCreationTokens: nonNegativeInt(record.cacheCreationInputTokens),
		reasoningTokens: nonNegativeInt(record.reasoningTokens),
	};
	tx.insert(usageDaily)
		.values({
			id: generateId(),
			day: record.createdAt.slice(0, 10),
			billingUserId: record.billingUserId ?? "",
			projectId: record.projectId ?? "",
			provider: record.provider ?? "",
			credentialId: record.credentialId ?? "",
			model: record.model ?? "",
			requestCount: 1,
			...tokens,
			costUsd,
			unpricedRequestCount: priced ? 0 : 1,
		})
		.onConflictDoUpdate({
			target: [
				usageDaily.day,
				usageDaily.billingUserId,
				usageDaily.projectId,
				usageDaily.provider,
				usageDaily.credentialId,
				usageDaily.model,
			],
			set: {
				requestCount: sql`${usageDaily.requestCount} + 1`,
				inputTokens: sql`${usageDaily.inputTokens} + ${tokens.inputTokens}`,
				outputTokens: sql`${usageDaily.outputTokens} + ${tokens.outputTokens}`,
				cachedInputTokens: sql`${usageDaily.cachedInputTokens} + ${tokens.cachedInputTokens}`,
				cacheCreationTokens: sql`${usageDaily.cacheCreationTokens} + ${tokens.cacheCreationTokens}`,
				reasoningTokens: sql`${usageDaily.reasoningTokens} + ${tokens.reasoningTokens}`,
				costUsd: sql`${usageDaily.costUsd} + ${costUsd}`,
				unpricedRequestCount: sql`${usageDaily.unpricedRequestCount} + ${priced ? 0 : 1}`,
			},
		})
		.run();
}
