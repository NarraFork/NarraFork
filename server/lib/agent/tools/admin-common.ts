import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { users } from "../../../db/schema";
import type { ToolContext, ToolResult } from "../types";

/**
 * Shared helpers for admin-only agent tools (MCP / hooks / scheduled tasks /
 * plugin lifecycle). These tools mutate privileged system state, so they follow
 * the same pattern as NarraForkAdmin / KnowledgeAdmin:
 *
 *  1. Admin check at execution time (second line of defence beyond the
 *     ADMIN_ONLY_LOAD_TOOLS load gate).
 *  2. Write actions go through `ctx.requestPermission(...)` approval.
 *  3. Read actions run directly.
 */

export async function isAdminUser(userId: string | null | undefined): Promise<boolean> {
	if (!userId) return false;
	const user = await db.query.users.findFirst({
		where: eq(users.id, userId),
		columns: { role: true },
	});
	return user?.role === "admin";
}

export function errorResult(message: string, title = "Admin tool failed"): ToolResult {
	return { output: message, isError: true, title };
}

/**
 * Request approval for a privileged write action. Returns an error message when
 * the user denied the action or a danger-reflection is pending, or null when the
 * action is approved and may proceed.
 */
export async function requestWritePermission(
	ctx: ToolContext,
	toolName: string,
	input: Record<string, unknown>,
): Promise<string | null> {
	const decision = await ctx.requestPermission(toolName, input, ctx.currentToolUseId ?? toolName);
	if (decision.behavior === "dangerReflection") {
		return `${toolName} is waiting for danger reflection approval.`;
	}
	if (decision.behavior !== "allow") {
		return decision.message ?? `${toolName} was denied by the user.`;
	}
	return null;
}

/** Truncate long string fields for model-facing output. */
export function truncateText(value: unknown, max = 2_000): unknown {
	if (typeof value !== "string") return value;
	return value.length > max
		? `${value.slice(0, max)}…(truncated ${value.length - max} chars)`
		: value;
}
