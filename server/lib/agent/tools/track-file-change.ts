import type { ToolContext } from "../types";

/**
 * Record a file change for team-status tracking (subagent file_changes action).
 * No-op when the narrator is not a subagent (no parentNarratorId).
 */
export async function trackFileChange(ctx: ToolContext, filePath: string): Promise<void> {
	if (!ctx.parentNarratorId) return;
	const { recordTeamFileChange } = await import("@server/services/narrator-subagent");
	recordTeamFileChange(ctx.parentNarratorId, ctx.narratorId, filePath);
}
