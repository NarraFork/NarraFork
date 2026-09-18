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
 * - Pass a session object that lives as long as the loop: staged `before` hashes
 *   are stored ON it, so a fresh object per pass loses the boundary pairing.
 * - Until actual execution-target receipts are available, only an unambiguous
 *   local session/call target is measured. Remote overrides and out-of-workspace
 *   paths have missing evidence, not equal local hashes proving a no-op.
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
	abandonTreeSnapshot,
	type BashCaptureWindow,
	beginBashCaptureWindow,
	declaredWorktreePaths,
	recordTreeSnapshotAfter,
	recordTreeSnapshotBefore,
	type TreeSnapshotSession,
} from "./narrator-tree-snapshot-hooks";
import { specVfsService } from "./spec-vfs-service";

/**
 * Tools that may modify files on disk, i.e. the ones worth a boundary pair.
 *
 * A file-mutating tool missing from this set gets NO tree snapshot boundary, so the
 * preferred revert path cannot cover it and `narrator-scoped-revert` reports
 * `incomplete_coverage` for the whole range. That fails closed rather than pretending a
 * revert succeeded, but the capability is simply absent until the name is listed here.
 */
export const FILE_MUTATING_TOOLS = new Set(["Write", "Edit", "StructSed", SHELL_TOOL_NAME]);

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
	// Keep the accepted scope per attempt without mutating the session's default
	// device to impersonate a per-call override. A remote cwd is not a local cwd.
	const localCalls = new Map<string, string>();
	const bashCaptureWindows = new Map<string, BashCaptureWindow>();

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
			localCalls.delete(toolUseId);
			const args = input as Record<string, unknown> | null;
			const defaultDeviceId = session._defaultDeviceId ?? LOCAL_DEVICE_ID;
			const requestedDevice = args?.device;
			const workdir = args?.workdir;
			const fileTargets = [args?.file_path, args?.to_file].filter(
				(value): value is string => typeof value === "string" && value.length > 0,
			);
			const isVirtualSpecTarget =
				toolName !== SHELL_TOOL_NAME &&
				fileTargets.length > 0 &&
				fileTargets.every((value) => specVfsService.isSpecUri(value));
			if (isVirtualSpecTarget) {
				// Spec files are persisted by the virtual filesystem, not the worktree. They
				// intentionally have no tree boundary and should not look like an unverified
				// local target in the server log.
				abandonTreeSnapshot(session, narratorId, toolUseId);
				logger.debug("Tree snapshot skipped for virtual Spec target", {
					narratorId,
					toolUseId,
					toolName,
				});
				return;
			}
			if (
				defaultDeviceId !== LOCAL_DEVICE_ID ||
				(requestedDevice !== undefined && requestedDevice !== LOCAL_DEVICE_ID) ||
				(toolName === SHELL_TOOL_NAME && workdir !== undefined && workdir !== session.cwd) ||
				(declared !== null && declared.length === 0)
			) {
				abandonTreeSnapshot(session, narratorId, toolUseId);
				logger.warn(
					"Tree snapshot skipped: tool target is not verified inside the local workspace",
					{
						narratorId,
						toolUseId,
						toolName,
					},
				);
				return;
			}
			localCalls.set(toolUseId, session.cwd);
			if (toolName === SHELL_TOOL_NAME) {
				const window = beginBashCaptureWindow(session.cwd, toolUseId);
				bashCaptureWindows.set(toolUseId, window);
				if (!window.eligible) {
					logger.info("Bash tree capture skipped because another Bash is active", {
						narratorId,
						toolUseId,
					});
					return;
				}
			}
			await recordTreeSnapshotBefore(session, narratorId, toolUseId, declared);
		},
		// Capture the resulting state, persist both boundaries, and attribute the
		// files Bash changed using the authoritative tree diff.
		onSnapshotAfter: async (toolUseId, toolName) => {
			if (!FILE_MUTATING_TOOLS.has(toolName)) return;
			const capturedCwd = localCalls.get(toolUseId);
			localCalls.delete(toolUseId);
			const bashWindow =
				toolName === SHELL_TOOL_NAME ? bashCaptureWindows.get(toolUseId) : undefined;
			bashCaptureWindows.delete(toolUseId);
			bashWindow?.end();
			if (
				toolName === SHELL_TOOL_NAME &&
				(bashWindow === undefined || !bashWindow.eligible || bashWindow.wasOverlapped())
			) {
				abandonTreeSnapshot(session, narratorId, toolUseId);
				await recordTreeSnapshotAfter(session, narratorId, toolUseId, { unavailable: true });
				return;
			}
			if (
				capturedCwd !== session.cwd ||
				(session._defaultDeviceId ?? LOCAL_DEVICE_ID) !== LOCAL_DEVICE_ID
			) {
				abandonTreeSnapshot(session, narratorId, toolUseId);
				await recordTreeSnapshotAfter(session, narratorId, toolUseId, { unavailable: true });
				return;
			}
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
