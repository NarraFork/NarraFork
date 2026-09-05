/**
 * The `onSnapshotBefore` / `onSnapshotAfter` pair every agent loop installs.
 *
 * ## Why this is shared rather than written per loop
 *
 * The primary narrator (`narrator-session.ts`) and a subagent
 * (`subagent-executor.ts`) each own an orchestration layer around the same
 * `executeAgentLoop`. Both must record workspace tree boundaries, and both must
 * do it identically — the boundaries are read back by ONE rollback path
 * (`snapshot-revert.ts`), which cannot tell which loop wrote them. A subagent
 * whose Write lands with a null `treeHashBefore` silently degrades that call to
 * per-file replay, and a Bash call whose delta is never attributed makes another
 * narrator's real write look unrevertable.
 *
 * The two loops had diverged exactly that way: the subagent passed only
 * `onContextUsage`, so no subagent tool call ever recorded a boundary. Keeping
 * the construction in one function is what stops the next capability from
 * landing on one side only.
 *
 * ## Contract for callers
 *
 * - Pass a session object that lives as long as the loop: the staged `before`
 *   hashes and the reused `_lastTreeHash` cache are stored ON it, so a fresh
 *   object per pass would lose the pairing between the two hooks.
 * - `isInGitRepo: false` means "return no hooks at all" rather than "hooks that
 *   do nothing", so the loop never awaits a call that cannot produce anything.
 * - The hooks never throw. A capture failure degrades that boundary to null;
 *   snapshotting must not break a turn.
 * - Capture runs through `tryCaptureHot`, so an over-budget scan returns null
 *   and continues in the background instead of stalling the event consumer that
 *   awaits these hooks (see `worktree-tree-snapshot.tryCaptureHot`). The
 *   `chapters.treeSnapshotsEnabled` escape hatch is honoured inside
 *   `captureSessionTree`, so it applies to every caller of this module.
 */
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import { logger } from "../lib/logger";
import type { EventHooks } from "./narrator-event-handler";
import {
	declaredWorktreePaths,
	recordTreeSnapshotAfter,
	recordTreeSnapshotBefore,
	type TreeSnapshotSession,
} from "./narrator-tree-snapshot-hooks";

/** Tools that may modify files on disk, i.e. the ones worth a boundary pair. */
export const FILE_MUTATING_TOOLS = new Set(["Write", "Edit", SHELL_TOOL_NAME]);

/**
 * Build the snapshot hook pair for one agent loop.
 *
 * Returns `{}` when the workspace cannot be snapshotted at all (not a git repo),
 * which callers can spread into their `EventHooks` unconditionally.
 */
export function buildTreeSnapshotEventHooks(opts: {
	/** Mutable per-loop session state; must outlive a single tool call. */
	session: TreeSnapshotSession;
	narratorId: string;
	/** False for a cwd outside any git repository — no shadow repo is possible. */
	isInGitRepo: boolean;
}): Pick<EventHooks, "onSnapshotBefore" | "onSnapshotAfter"> {
	const { session, narratorId, isInGitRepo } = opts;
	if (!isInGitRepo) return {};

	return {
		// Capture the workspace state before a file-mutating tool runs. This is a
		// content-addressed git tree of the whole worktree, so it also covers
		// writes the tool inputs do not describe (Bash, build scripts, editors).
		onSnapshotBefore: async (toolUseId, toolName, input) => {
			if (!FILE_MUTATING_TOOLS.has(toolName)) return;
			// Write/Edit can name their target up front, which is what lets the
			// resulting tree delta be attributed in a shared worktree. Bash cannot,
			// so it declares nothing and its set is derived instead.
			const declared =
				toolName === SHELL_TOOL_NAME ? null : declaredWorktreePaths(session.cwd, input);
			await recordTreeSnapshotBefore(session, narratorId, toolUseId, declared);
		},
		// Capture the resulting state, persist both boundaries, and attribute the
		// files Bash changed using the authoritative tree diff.
		onSnapshotAfter: async (toolUseId, toolName) => {
			if (!FILE_MUTATING_TOOLS.has(toolName)) return;
			const { changedFiles } = await recordTreeSnapshotAfter(session, narratorId, toolUseId);
			if (toolName !== SHELL_TOOL_NAME || changedFiles.length === 0) return;
			try {
				const { recordAttributions } = await import("./file-attribution-service");
				await recordAttributions(
					{
						deviceId: LOCAL_DEVICE_ID,
						workspacePath: session.cwd,
						narratorId,
						action: "bash",
						toolName: SHELL_TOOL_NAME,
						toolUseId,
					},
					changedFiles,
				);
			} catch (err) {
				logger.debug("Bash attribution failed", {
					narratorId,
					toolUseId,
					error: String(err),
				});
			}
		},
	};
}
