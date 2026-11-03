import type { Database } from "bun:sqlite";
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

/**
 * Add requests inserted in bulk (a data import) to the daily ledger, in one SQL
 * statement. `afterRowid` is the largest `api_requests` rowid before the insert, so
 * re-importing the same rows (skipped by primary key) never counts them twice. Older
 * exports carry no billing user or project: the narrator owner, then the initiator,
 * stands in for the former.
 */
export function addImportedRequestsToUsageDaily(sqlite: Database, afterRowid: number): void {
	const positive = (column: string) => `SUM(MAX(COALESCE(r.${column}, 0), 0))`;
	sqlite
		.prepare(
			`INSERT INTO usage_daily (id, day, billing_user_id, project_id, provider, credential_id, model,
			request_count, input_tokens, output_tokens, cached_input_tokens, cache_creation_tokens,
			reasoning_tokens, cost_usd, unpriced_request_count)
		SELECT lower(hex(randomblob(12))), substr(r.created_at, 1, 10),
			COALESCE(r.billing_user_id, root.owner_user_id, r.user_id, ''), COALESCE(r.project_id, ''),
			COALESCE(r.provider, ''), COALESCE(r.credential_id, ''), COALESCE(r.model, ''),
			COUNT(*), ${positive("input_tokens")}, ${positive("output_tokens")},
			${positive("cached_input_tokens")}, ${positive("cache_creation_input_tokens")},
			${positive("reasoning_tokens")}, ${positive("cost_usd")},
			SUM(CASE WHEN (r.cost_status IS NULL OR r.cost_status = 'complete')
				AND r.cost_usd IS NOT NULL AND r.cost_usd >= 0 THEN 0 ELSE 1 END)
		FROM api_requests r
		LEFT JOIN narrators n ON n.id = r.narrator_id
		LEFT JOIN narrators root ON root.id = COALESCE(n.acl_root_narrator_id, n.id)
		WHERE r.rowid > ?
		GROUP BY 2, 3, 4, 5, 6, 7
		ON CONFLICT (day, billing_user_id, project_id, provider, credential_id, model) DO UPDATE SET
			request_count = request_count + excluded.request_count,
			input_tokens = input_tokens + excluded.input_tokens,
			output_tokens = output_tokens + excluded.output_tokens,
			cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
			cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
			reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
			cost_usd = cost_usd + excluded.cost_usd,
			unpriced_request_count = unpriced_request_count + excluded.unpriced_request_count`,
		)
		.run(afterRowid);
}
