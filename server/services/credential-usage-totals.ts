/**
 * Lifetime token/cost rollup per (provider, credential, model).
 *
 * `api_requests` carries the per-request detail, but it is deleted along with
 * its narrator — the database cleanup UI even warns that this "deletesUsageHistory".
 * So it cannot answer "how much has this credential consumed in total". This
 * module maintains the durable counterpart, written on the same path as the
 * detail row so the two cannot drift, and cleared only when the credential
 * itself is deleted (archiving deliberately keeps it).
 *
 * Costs are USD at the vendors' official reference prices. For subscription
 * access (Codex on a ChatGPT plan) that is an equivalent-
 * consumption figure, not an amount actually billed — `unpricedRequestCount`
 * records how many requests had no known price so the UI can qualify the total
 * instead of silently undercounting.
 */

import { db as defaultDb } from "@server/db";
import { credentialUsageTotals } from "@server/db/schema";
import { aggregateCostStatus, type CostStatus } from "@server/lib/cost-estimate";
import { generateId } from "@server/lib/id";
import { logger } from "@server/lib/logger";
import { and, desc, eq, sql } from "drizzle-orm";

/** Injectable for tests; production callers use the shared connection. */
type Db = typeof defaultDb;

/** One request's contribution to the rollup. */
export interface CredentialUsageDelta {
	provider: string;
	credentialId: string;
	model: string;
	inputTokens?: number;
	outputTokens?: number;
	cachedInputTokens?: number;
	cacheCreationTokens?: number;
	reasoningTokens?: number;
	/** USD cost, or null when the model has no reference price. */
	costUsd?: number | null;
	costStatus?: CostStatus;
	/** Timestamp for first/last seen bookkeeping. Defaults to now. */
	at?: string;
}

export interface CredentialUsageTotalRow {
	provider: string;
	credentialId: string;
	model: string;
	requestCount: number;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	cacheCreationTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	costUsd: number;
	unpricedRequestCount: number;
	partialRequestCount: number;
	costStatus: CostStatus;
	firstSeenAt: string;
	lastSeenAt: string;
}

/** Aggregate across every model a credential has used. */
export interface CredentialUsageSummary {
	provider: string;
	credentialId: string;
	requestCount: number;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	cacheCreationTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	costUsd: number;
	unpricedRequestCount: number;
	partialRequestCount: number;
	costStatus: CostStatus;
	/** True when at least one request could not be priced. */
	costIsPartial: boolean;
	firstSeenAt: string | null;
	lastSeenAt: string | null;
	byModel: CredentialUsageTotalRow[];
	/**
	 * True when the credential has used more models than `byModel` returns.
	 *
	 * The aggregate above is always complete — it is summed in SQL over every
	 * row — but the breakdown is capped, so the UI must say the per-model list is
	 * incomplete rather than let the two silently disagree.
	 */
	byModelTruncated: boolean;
}

function nonNegativeInt(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return Math.round(value);
}

/**
 * The single test for "does this request contribute a usable cost".
 *
 * Returns 0 for anything that cannot be added to a running total: null (no
 * price), NaN/Infinity, and negatives. A negative cost is not a credit — it is
 * malformed input — and dropping it while still counting the request as priced
 * would produce "cost 0, coverage complete", which reads as free rather than
 * unknown. So `isPricedCost` is derived from this same function: whatever gets
 * discarded here is necessarily counted as unpriced.
 */
function nonNegativeCost(value: number | null | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
	return value;
}

/**
 * True when the request carries a cost we can actually attribute.
 *
 * Deliberately the same judgement as {@link nonNegativeCost}: a request whose
 * cost was discarded must land in `unpricedRequestCount`, never in the priced
 * bucket with a silent 0. Note this also treats an exact 0 as unpriced — a
 * genuinely free request is indistinguishable from a dropped one at this layer,
 * and over-reporting coverage is the more misleading of the two errors.
 */
function isPricedCost(value: number | null | undefined): boolean {
	return nonNegativeCost(value) > 0;
}

/**
 * Add one request to the rollup.
 *
 * Implemented as a single-row upsert on the natural key so it stays inside the
 * "small, fast, indexed" budget for the main thread — no scans, no aggregation.
 * Never throws: usage accounting must not fail a request that already succeeded,
 * so the whole body (not just the DB call) is guarded.
 */
export function recordCredentialUsage(delta: CredentialUsageDelta, db: Db = defaultDb): void {
	try {
		const provider = delta.provider?.trim();
		const credentialId = delta.credentialId?.trim();
		if (!provider || !credentialId) return;
		// An empty model would collide across every unnamed request; bucket those
		// under an explicit sentinel instead so the natural key stays meaningful.
		const model = delta.model?.trim() || "unknown";

		const at = delta.at ?? new Date().toISOString();
		const inputTokens = nonNegativeInt(delta.inputTokens);
		const outputTokens = nonNegativeInt(delta.outputTokens);
		const cachedInputTokens = nonNegativeInt(delta.cachedInputTokens);
		const cacheCreationTokens = nonNegativeInt(delta.cacheCreationTokens);
		const reasoningTokens = nonNegativeInt(delta.reasoningTokens);
		const priced =
			delta.costStatus === "complete"
				? typeof delta.costUsd === "number" && Number.isFinite(delta.costUsd) && delta.costUsd >= 0
				: delta.costStatus
					? false
					: isPricedCost(delta.costUsd);
		const partial = delta.costStatus === "partial" ? 1 : 0;
		const costUsd = nonNegativeCost(delta.costUsd);

		db.insert(credentialUsageTotals)
			.values({
				id: generateId(),
				provider,
				credentialId,
				model,
				requestCount: 1,
				inputTokens,
				outputTokens,
				cachedInputTokens,
				cacheCreationTokens,
				reasoningTokens,
				costUsd,
				unpricedRequestCount: priced ? 0 : 1,
				partialRequestCount: partial,
				firstSeenAt: at,
				lastSeenAt: at,
			})
			.onConflictDoUpdate({
				target: [
					credentialUsageTotals.provider,
					credentialUsageTotals.credentialId,
					credentialUsageTotals.model,
				],
				set: {
					requestCount: sql`${credentialUsageTotals.requestCount} + 1`,
					inputTokens: sql`${credentialUsageTotals.inputTokens} + ${inputTokens}`,
					outputTokens: sql`${credentialUsageTotals.outputTokens} + ${outputTokens}`,
					cachedInputTokens: sql`${credentialUsageTotals.cachedInputTokens} + ${cachedInputTokens}`,
					cacheCreationTokens: sql`${credentialUsageTotals.cacheCreationTokens} + ${cacheCreationTokens}`,
					reasoningTokens: sql`${credentialUsageTotals.reasoningTokens} + ${reasoningTokens}`,
					costUsd: sql`${credentialUsageTotals.costUsd} + ${costUsd}`,
					unpricedRequestCount: sql`${credentialUsageTotals.unpricedRequestCount} + ${priced ? 0 : 1}`,
					partialRequestCount: sql`${credentialUsageTotals.partialRequestCount} + ${partial}`,
					// firstSeenAt is intentionally left alone: it is the earliest sighting.
					lastSeenAt: at,
				},
			})
			.run();
	} catch (err) {
		// Logged from the raw delta so the message survives a throw from anywhere
		// in the body, including before the normalized locals exist.
		//
		// Under SQLITE_BUSY (busy_timeout is 250ms by design — see
		// db/connection.ts) this drops one request from the rollup. That is the
		// intended trade: the request itself already succeeded and losing a count
		// is strictly better than failing it or blocking the main thread.
		logger.warn("Failed to record credential usage totals", {
			provider: delta.provider,
			credentialId: delta.credentialId,
			model: delta.model,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

function toRow(row: typeof credentialUsageTotals.$inferSelect): CredentialUsageTotalRow {
	return {
		provider: row.provider,
		credentialId: row.credentialId,
		model: row.model,
		requestCount: row.requestCount,
		inputTokens: row.inputTokens,
		outputTokens: row.outputTokens,
		cachedInputTokens: row.cachedInputTokens,
		cacheCreationTokens: row.cacheCreationTokens,
		reasoningTokens: row.reasoningTokens,
		totalTokens:
			row.inputTokens + row.outputTokens + row.cachedInputTokens + row.cacheCreationTokens,
		costUsd: row.costUsd,
		unpricedRequestCount: row.unpricedRequestCount,
		partialRequestCount: row.partialRequestCount,
		costStatus: aggregateCostStatus(
			row.requestCount,
			row.unpricedRequestCount,
			row.partialRequestCount,
		),
		firstSeenAt: row.firstSeenAt,
		lastSeenAt: row.lastSeenAt,
	};
}

/**
 * Lifetime totals for one credential, broken down by model.
 *
 * The aggregate and the breakdown are two separate queries on purpose. Summing
 * the capped `byModel` rows would undercount any credential that has touched
 * more models than `limit` — one row accrues per distinct model string, so a
 * long-lived account collects one per renamed custom model plus the `unknown`
 * bucket — and the shortfall would be invisible in the UI. The aggregate is
 * therefore summed in SQL over every row; the breakdown stays capped and sets
 * `byModelTruncated` when it did not return everything.
 *
 * Both queries hit `idx_credential_usage_totals_credential` on an equality
 * prefix, so the scanned row count is bounded by the model count — small enough
 * for the main thread even without a limit.
 */
export function getCredentialUsageTotals(
	provider: string,
	credentialId: string,
	limit = 50,
	db: Db = defaultDb,
): CredentialUsageSummary {
	const credentialScope = and(
		eq(credentialUsageTotals.provider, provider),
		eq(credentialUsageTotals.credentialId, credentialId),
	);
	const effectiveLimit = Math.max(1, Math.min(limit, 500));

	const [aggregate] = db
		.select({
			modelCount: sql<number>`count(*)`,
			requestCount: sql<number>`sum(${credentialUsageTotals.requestCount})`,
			inputTokens: sql<number>`sum(${credentialUsageTotals.inputTokens})`,
			outputTokens: sql<number>`sum(${credentialUsageTotals.outputTokens})`,
			cachedInputTokens: sql<number>`sum(${credentialUsageTotals.cachedInputTokens})`,
			cacheCreationTokens: sql<number>`sum(${credentialUsageTotals.cacheCreationTokens})`,
			reasoningTokens: sql<number>`sum(${credentialUsageTotals.reasoningTokens})`,
			costUsd: sql<number>`sum(${credentialUsageTotals.costUsd})`,
			unpricedRequestCount: sql<number>`sum(${credentialUsageTotals.unpricedRequestCount})`,
			partialRequestCount: sql<number>`sum(${credentialUsageTotals.partialRequestCount})`,
			firstSeenAt: sql<string | null>`min(${credentialUsageTotals.firstSeenAt})`,
			lastSeenAt: sql<string | null>`max(${credentialUsageTotals.lastSeenAt})`,
		})
		.from(credentialUsageTotals)
		.where(credentialScope)
		.all();

	// `byModel` is ordered by recency: when the list is capped, the models the
	// credential actually still uses are the ones worth showing.
	const rows = db
		.select()
		.from(credentialUsageTotals)
		.where(credentialScope)
		.orderBy(desc(credentialUsageTotals.lastSeenAt))
		.limit(effectiveLimit)
		.all()
		.map(toRow);

	const inputTokens = Number(aggregate?.inputTokens ?? 0);
	const outputTokens = Number(aggregate?.outputTokens ?? 0);
	const cachedInputTokens = Number(aggregate?.cachedInputTokens ?? 0);
	const cacheCreationTokens = Number(aggregate?.cacheCreationTokens ?? 0);
	const unpricedRequestCount = Number(aggregate?.unpricedRequestCount ?? 0);

	return {
		provider,
		credentialId,
		requestCount: Number(aggregate?.requestCount ?? 0),
		inputTokens,
		outputTokens,
		cachedInputTokens,
		cacheCreationTokens,
		reasoningTokens: Number(aggregate?.reasoningTokens ?? 0),
		// reasoning tokens are already part of the reported output count upstream.
		totalTokens: inputTokens + outputTokens + cachedInputTokens + cacheCreationTokens,
		costUsd: Number(aggregate?.costUsd ?? 0),
		unpricedRequestCount,
		partialRequestCount: Number(aggregate?.partialRequestCount ?? 0),
		costStatus: aggregateCostStatus(
			Number(aggregate?.requestCount ?? 0),
			unpricedRequestCount,
			Number(aggregate?.partialRequestCount ?? 0),
		),
		costIsPartial: unpricedRequestCount > 0,
		firstSeenAt: aggregate?.firstSeenAt ?? null,
		lastSeenAt: aggregate?.lastSeenAt ?? null,
		byModel: rows,
		byModelTruncated: Number(aggregate?.modelCount ?? 0) > rows.length,
	};
}

/**
 * Lifetime totals for every credential of a provider, aggregated per credential.
 *
 * Grouped in SQL over an indexed prefix, with an explicit row cap so a large
 * pool cannot produce an unbounded result set.
 */
export function listProviderCredentialTotals(
	provider: string,
	limit = 200,
	db: Db = defaultDb,
): Array<Omit<CredentialUsageSummary, "byModel" | "byModelTruncated">> {
	const rows = db
		.select({
			credentialId: credentialUsageTotals.credentialId,
			requestCount: sql<number>`sum(${credentialUsageTotals.requestCount})`,
			inputTokens: sql<number>`sum(${credentialUsageTotals.inputTokens})`,
			outputTokens: sql<number>`sum(${credentialUsageTotals.outputTokens})`,
			cachedInputTokens: sql<number>`sum(${credentialUsageTotals.cachedInputTokens})`,
			cacheCreationTokens: sql<number>`sum(${credentialUsageTotals.cacheCreationTokens})`,
			reasoningTokens: sql<number>`sum(${credentialUsageTotals.reasoningTokens})`,
			costUsd: sql<number>`sum(${credentialUsageTotals.costUsd})`,
			unpricedRequestCount: sql<number>`sum(${credentialUsageTotals.unpricedRequestCount})`,
			partialRequestCount: sql<number>`sum(${credentialUsageTotals.partialRequestCount})`,
			firstSeenAt: sql<string>`min(${credentialUsageTotals.firstSeenAt})`,
			lastSeenAt: sql<string>`max(${credentialUsageTotals.lastSeenAt})`,
		})
		.from(credentialUsageTotals)
		.where(eq(credentialUsageTotals.provider, provider))
		.groupBy(credentialUsageTotals.credentialId)
		.orderBy(sql`max(${credentialUsageTotals.lastSeenAt}) desc`)
		.limit(Math.max(1, Math.min(limit, 1000)))
		.all();

	return rows.map((row) => ({
		provider,
		credentialId: row.credentialId,
		requestCount: Number(row.requestCount ?? 0),
		inputTokens: Number(row.inputTokens ?? 0),
		outputTokens: Number(row.outputTokens ?? 0),
		cachedInputTokens: Number(row.cachedInputTokens ?? 0),
		cacheCreationTokens: Number(row.cacheCreationTokens ?? 0),
		reasoningTokens: Number(row.reasoningTokens ?? 0),
		totalTokens:
			Number(row.inputTokens ?? 0) +
			Number(row.outputTokens ?? 0) +
			Number(row.cachedInputTokens ?? 0) +
			Number(row.cacheCreationTokens ?? 0),
		costUsd: Number(row.costUsd ?? 0),
		unpricedRequestCount: Number(row.unpricedRequestCount ?? 0),
		partialRequestCount: Number(row.partialRequestCount ?? 0),
		costStatus: aggregateCostStatus(
			Number(row.requestCount ?? 0),
			Number(row.unpricedRequestCount ?? 0),
			Number(row.partialRequestCount ?? 0),
		),
		costIsPartial: Number(row.unpricedRequestCount ?? 0) > 0,
		firstSeenAt: row.firstSeenAt ?? null,
		lastSeenAt: row.lastSeenAt ?? null,
	}));
}

/**
 * Round a `real` cost for the wire.
 *
 * `costUsd` is summed by SQLite as a float, so it carries a long binary tail
 * (0.030000000000000002). Rounding happens here — at the single serialization
 * boundary the routes call — rather than inside each query, so the aggregate and
 * the per-model rows cannot drift apart as either side is edited.
 */
export function roundCostForSerialization(cost: number): number {
	if (!Number.isFinite(cost)) return 0;
	return Number(cost.toFixed(6));
}

/** Round every cost field in one summary (aggregate + per-model breakdown). */
export function serializeCredentialUsageSummary(
	summary: CredentialUsageSummary,
): CredentialUsageSummary {
	return {
		...summary,
		costUsd: roundCostForSerialization(summary.costUsd),
		byModel: summary.byModel.map((row) => ({
			...row,
			costUsd: roundCostForSerialization(row.costUsd),
		})),
	};
}

/** Round the cost field of every per-credential aggregate row. */
export function serializeCredentialUsageTotalsList<T extends { costUsd: number }>(
	entries: T[],
): T[] {
	return entries.map((entry) => ({
		...entry,
		costUsd: roundCostForSerialization(entry.costUsd),
	}));
}

/**
 * Drop the rollup for a credential. Only for real deletion — archiving keeps
 * the totals, which is the whole point of having an archive state.
 */
export function deleteCredentialUsageTotals(
	provider: string,
	credentialId: string,
	db: Db = defaultDb,
): void {
	try {
		db.delete(credentialUsageTotals)
			.where(
				and(
					eq(credentialUsageTotals.provider, provider),
					eq(credentialUsageTotals.credentialId, credentialId),
				),
			)
			.run();
	} catch (err) {
		logger.warn("Failed to delete credential usage totals", {
			provider,
			credentialId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
