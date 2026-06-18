import { relative, resolve } from "node:path";
import { toForwardSlash } from "@server/lib/platform-path";
import type { ToolContext } from "../types";

/**
 * Record a file change for team-status tracking AND file attribution.
 *
 * - Team tracking: no-op unless the narrator is a subagent (parentNarratorId).
 * - Attribution: records who/which tool changed the file, keyed by workspace
 *   path. Fully fault-tolerant; never throws.
 *
 * @param filePath  Absolute (resolved) path to the changed file.
 * @param action    Which tool produced the change ("write" | "edit" | "bash").
 */
export async function trackFileChange(
	ctx: ToolContext,
	filePath: string,
	action: "write" | "edit" | "bash" = "edit",
): Promise<void> {
	// Team file-change tracking (subagents only)
	if (ctx.parentNarratorId) {
		const { recordTeamFileChange } = await import("@server/services/narrator-subagent");
		recordTeamFileChange(ctx.parentNarratorId, ctx.narratorId, filePath);
	}

	// File attribution (all narrators, including standalone)
	try {
		const { recordAttribution } = await import("@server/services/file-attribution-service");
		// Store a workspace-relative path for consistency with git status output.
		const rel = toForwardSlash(relative(ctx.cwd, resolve(ctx.cwd, filePath))) || filePath;
		await recordAttribution({
			workspacePath: ctx.cwd,
			filePath: rel,
			narratorId: ctx.narratorId,
			action,
			toolName: action === "write" ? "Write" : action === "bash" ? "Bash" : "Edit",
			toolUseId: ctx.currentToolUseId ?? null,
		});
	} catch {
		// Non-fatal — attribution must never block tool execution.
	}
}
