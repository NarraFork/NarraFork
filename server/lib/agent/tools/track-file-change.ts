import { relative, resolve } from "node:path";
import { toForwardSlash } from "@server/lib/platform-path";
import type { ExecutionBackend } from "../execution/backend";
import { localBackend } from "../execution/local-backend";
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
	backend: ExecutionBackend = localBackend,
): Promise<void> {
	// Team file-change tracking (subagents only)
	if (ctx.parentNarratorId) {
		const { recordTeamFileChange } = await import("@server/services/narrator-subagent");
		recordTeamFileChange(ctx.parentNarratorId, ctx.narratorId, filePath);
	}

	// File attribution (all narrators, including standalone)
	try {
		const { recordAttribution } = await import("@server/services/file-attribution-service");
		// Keep local Git UI compatibility with repo-relative paths. Remote paths must
		// never pass through the server's node:path grammar, so retain the normalized
		// absolute target path produced by the execution backend.
		const isLocal = backend.kind === "local";
		const workspacePath = isLocal
			? ctx.cwd
			: (ctx.executionTarget?.cwd ?? backend.defaultCwd ?? filePath);
		const attributedPath = isLocal
			? toForwardSlash(relative(ctx.cwd, resolve(ctx.cwd, filePath))) || filePath
			: backend.paths.identityKey(filePath);
		await recordAttribution({
			deviceId: backend.deviceId,
			workspacePath,
			filePath: attributedPath,
			narratorId: ctx.narratorId,
			action,
			toolName: action === "write" ? "Write" : action === "bash" ? "Bash" : "Edit",
			toolUseId: ctx.currentToolUseId ?? null,
		});
	} catch {
		// Non-fatal — attribution must never block tool execution.
	}
}
