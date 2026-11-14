import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorToolCalls } from "../db/schema";
import {
	compactLocks,
	hasOtherNarratorAdmissionWork,
	isNarratorRuntimeBusy,
} from "./narrator-session-state";

export type RevertBlockerKind = "running_tool" | "narrator_busy" | "planner_busy";
export interface RevertBlocker {
	kind: RevertBlockerKind;
	toolCallId?: string;
	toolName?: string;
	operationId?: string;
	messageId?: string;
	detail?: string;
}
export function boundedDetail(value: unknown, max = 160): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : undefined;
}
/** Only live work affecting this narrator's selected history is relevant. Archived scopes and attempts are diagnostic history. */
export function collectRevertBlockers(narratorId: string, code?: string): RevertBlocker[] {
	if (/PLANNER_BUSY/.test(code ?? ""))
		return [{ kind: "planner_busy", detail: "Another preview is running" }];
	const tools = db
		.select({
			id: narratorToolCalls.id,
			toolName: narratorToolCalls.toolName,
			messageId: narratorToolCalls.messageId,
		})
		.from(narratorToolCalls)
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				// COW snapshots retain the source status, but own no running execution.
				isNull(narratorToolCalls.executionOriginToolCallId),
				sql`${narratorToolCalls.status} IN ('initializing','pending','running')`,
			),
		)
		.orderBy(asc(narratorToolCalls.createdAt), asc(narratorToolCalls.id))
		.limit(12)
		.all();
	const blockers: RevertBlocker[] = tools.map((tool) => ({
		kind: "running_tool",
		toolCallId: tool.id,
		toolName: tool.toolName,
		messageId: tool.messageId,
	}));
	if (
		compactLocks.has(narratorId) ||
		hasOtherNarratorAdmissionWork(narratorId) ||
		isNarratorRuntimeBusy(narratorId)
	)
		blockers.push({ kind: "narrator_busy" });
	return blockers;
}
