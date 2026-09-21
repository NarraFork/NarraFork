/**
 * Cleanup for tool-call rows that never reached execution.
 *
 * A non-terminal row with `execution_started_at IS NULL` is not live work: the
 * process never claimed it, so no side effect ran. Ordinary paths leave such
 * rows behind on provider errors, process death between tool_use persistence
 * and permission/claim, and — most painfully — subagent Send reports that sat
 * in `pending` until nobody approved them.
 *
 * Those abandoned rows inflate update-checkpoint scans, leave the UI stuck on
 * "waiting", and (when a parent Agent/await is still live) keep planned updates
 * blocked behind work that will never finish.
 *
 * Deliberately scoped to never-started rows only. A `running` row with an
 * execution timestamp may still be a legitimate long Bash/Agent; recovery and
 * user interrupt own those.
 */

import { and, inArray, isNull, lt } from "drizzle-orm";
import { db } from "../db";
import { narratorToolCalls } from "../db/schema";
import { logger } from "../lib/logger";
import { pendingPermissions } from "./narrator-session-state";

/** Never-started non-terminal rows older than this are considered abandoned. */
export const ABANDONED_TOOL_CALL_TTL_MS = 30 * 60_000;

export const ABANDONED_TOOL_CALL_ERROR =
	"Tool call abandoned: execution never started (stale pending/initializing row)";

const NON_TERMINAL_STATUSES = ["initializing", "pending", "running"] as const;

export function isAbandonedNeverStartedToolCall(input: {
	status: string;
	executionStartedAt?: string | Date | null;
	createdAt: string;
	now?: number;
	ttlMs?: number;
}): boolean {
	if (!NON_TERMINAL_STATUSES.includes(input.status as (typeof NON_TERMINAL_STATUSES)[number])) {
		return false;
	}
	if (input.executionStartedAt != null) return false;
	const created = Date.parse(input.createdAt);
	if (!Number.isFinite(created)) return false;
	const ttl = input.ttlMs ?? ABANDONED_TOOL_CALL_TTL_MS;
	return created <= (input.now ?? Date.now()) - ttl;
}

export interface CleanupAbandonedToolCallsOptions {
	now?: number;
	ttlMs?: number;
	/** Live permission waits in THIS process must never be cleaned. */
	livePendingToolCallIds?: ReadonlySet<string>;
}

/**
 * Mark abandoned never-started tool rows as failed so protocol history has a
 * terminal tool_result and update/UI observers stop treating them as live.
 */
export async function cleanupAbandonedToolCalls(
	options: CleanupAbandonedToolCallsOptions = {},
): Promise<{ cleaned: number; skippedLive: number }> {
	const now = options.now ?? Date.now();
	const ttlMs = options.ttlMs ?? ABANDONED_TOOL_CALL_TTL_MS;
	const cutoff = new Date(now - ttlMs).toISOString();
	const live =
		options.livePendingToolCallIds ??
		new Set([...pendingPermissions.keys()].filter((id) => typeof id === "string"));

	const candidates = await db
		.select({
			id: narratorToolCalls.id,
			narratorId: narratorToolCalls.narratorId,
			toolName: narratorToolCalls.toolName,
			status: narratorToolCalls.status,
			createdAt: narratorToolCalls.createdAt,
			executionStartedAt: narratorToolCalls.executionStartedAt,
		})
		.from(narratorToolCalls)
		.where(
			and(
				inArray(narratorToolCalls.status, [...NON_TERMINAL_STATUSES]),
				isNull(narratorToolCalls.executionStartedAt),
				lt(narratorToolCalls.createdAt, cutoff),
			),
		)
		.limit(5_000);

	let cleaned = 0;
	let skippedLive = 0;
	const completedAt = new Date(now).toISOString();
	for (const row of candidates) {
		if (live.has(row.id)) {
			skippedLive++;
			continue;
		}
		if (
			!isAbandonedNeverStartedToolCall({
				status: row.status,
				executionStartedAt: row.executionStartedAt,
				createdAt: row.createdAt,
				now,
				ttlMs,
			})
		) {
			continue;
		}
		const updated = await db
			.update(narratorToolCalls)
			.set({
				status: "fail",
				errorMessage: ABANDONED_TOOL_CALL_ERROR,
				completedAt,
			})
			.where(
				and(
					inArray(narratorToolCalls.id, [row.id]),
					inArray(narratorToolCalls.status, [...NON_TERMINAL_STATUSES]),
					isNull(narratorToolCalls.executionStartedAt),
				),
			)
			.returning({ id: narratorToolCalls.id });
		if (updated.length === 1) cleaned++;
	}

	if (cleaned > 0 || skippedLive > 0) {
		logger.info("Abandoned never-started tool call cleanup", {
			cleaned,
			skippedLive,
			candidates: candidates.length,
			ttlMs,
		});
	}
	return { cleaned, skippedLive };
}
