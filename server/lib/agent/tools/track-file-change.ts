import { relative, resolve } from "node:path";
import { toForwardSlash } from "@server/lib/platform-path";
import type { ExecutionBackend } from "../execution/backend";
import { localBackend } from "../execution/local-backend";
import type { ToolContext } from "../types";

/**
 * Record a file change for team-status tracking, the outline overlap index AND file attribution.
 *
 * - Team tracking: no-op unless the narrator is a subagent (parentNarratorId).
 * - Overlap (outline P2 PR 10b, `services/outline/overlap.ts`): which session's task in progress
 *   changed the file. Resolves to the one line the tool's result ends with when another session's
 *   task in progress changed the same file (never for Bash), else null.
 * - Attribution: records who/which tool changed the file, keyed by workspace
 *   path. Fully fault-tolerant; never throws.
 *
 * @param filePath  Absolute (resolved) path to the changed file.
 * @param action    Which tool produced the change ("write" | "edit" | "bash").
 * @param lineStats Lines added/removed, when the caller measured them. Omit for
 *                  Bash, binary writes, or a diff that exceeded its budget — the
 *                  column then records "not measured" rather than zero. This is
 *                  the SAME value the tool puts in its result metadata, passed
 *                  through so the header figure and the aggregate cannot disagree.
 */
export async function trackFileChange(
	ctx: ToolContext,
	filePath: string,
	action: "write" | "edit" | "bash" = "edit",
	backend: ExecutionBackend = localBackend,
	lineStats?: { added: number; removed: number } | null,
	options?: { evidenceRecorded: boolean; toolName?: "StructSed" },
): Promise<string | null> {
	// Team file-change tracking (subagents only). A UI projection failure cannot
	// turn a durably settled mutation into a failed execution.
	try {
		if (ctx.parentNarratorId) {
			const { recordTeamFileChange } = await import("@server/services/narrator-subagent");
			const remoteCwd = ctx.executionTarget?.cwd ?? backend.defaultCwd;
			recordTeamFileChange(ctx.parentNarratorId, ctx.narratorId, filePath, {
				deviceId: backend.deviceId,
				workspacePath:
					backend.kind === "local"
						? ctx.cwd
						: remoteCwd
							? backend.paths.identityKey(remoteCwd)
							: null,
			});
		}
	} catch {
		// Rebuildable team display, not mutation evidence.
	}
	const hint = await outlineOverlap(ctx, filePath, action, backend);
	// The local v2 runtime already persisted exactly one effect projection. Never
	// add a legacy row for it or write a decoded first-touch baseline again.
	if (options?.evidenceRecorded) return hint;

	// File attribution (all narrators, including standalone)
	try {
		const { recordAttribution } = await import("@server/services/file-attribution-service");
		// Keep local Git UI compatibility with repo-relative paths. Remote paths must
		// never pass through the server's node:path grammar, so retain the normalized
		// absolute target path produced by the execution backend.
		const isLocal = backend.kind === "local";
		const workspacePath = isLocal
			? ctx.cwd
			: backend.paths.identityKey(ctx.executionTarget?.cwd ?? backend.defaultCwd ?? filePath);
		const attributedPath = isLocal
			? toForwardSlash(relative(ctx.cwd, resolve(ctx.cwd, filePath))) || filePath
			: backend.paths.identityKey(filePath);
		await recordAttribution({
			deviceId: backend.deviceId,
			workspacePath,
			filePath: attributedPath,
			narratorId: ctx.narratorId,
			action,
			toolName:
				options?.toolName ?? (action === "write" ? "Write" : action === "bash" ? "Bash" : "Edit"),
			toolUseId: ctx.currentToolUseId ?? null,
			...(lineStats ? { lineStats } : {}),
		});
	} catch {
		// Non-fatal — attribution must never block tool execution.
	}
	return hint;
}

/**
 * The outline overlap index (`services/outline/overlap.ts`): loaded only while the outline is on,
 * and never able to fail the tool.
 */
async function outlineOverlap(
	ctx: ToolContext,
	filePath: string,
	action: "write" | "edit" | "bash",
	backend: ExecutionBackend,
): Promise<string | null> {
	try {
		const { isOutlineEnabled } = await import("@server/services/outline/feature");
		if (!isOutlineEnabled()) return null;
		const { noteOutlineFileChange } = await import("@server/services/outline/overlap");
		return await noteOutlineFileChange({
			narratorId: ctx.narratorId,
			projectId: ctx.projectId ?? null,
			cwd:
				backend.kind === "local"
					? ctx.cwd
					: (ctx.executionTarget?.cwd ?? backend.defaultCwd ?? ctx.cwd),
			filePaths: [filePath],
			backend,
			locale: ctx.locale,
			hint: action !== "bash",
		});
	} catch {
		return null;
	}
}

/** A tool result with the overlap hint as its last line (unchanged without one, or on an error). */
export function withOverlapHint<T extends { output: string; isError?: boolean }>(
	result: T,
	hint: string | null,
): T {
	if (!hint || result.isError) return result;
	return { ...result, output: `${result.output}\n\n${hint}` };
}
