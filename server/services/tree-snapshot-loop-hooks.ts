/**
 * Execution-owned tree boundaries shared by primary, subagent and recovery runners.
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
 * - Only an unambiguous local session/call target is measured; execution runners
 *   additionally check the frozen target. A trailing slash or the canonical path
 *   of a symlinked cwd is still this workspace. Remote overrides and paths that
 *   remain outside after canonical resolution have missing evidence, not equal
 *   local hashes proving a no-op.
 * - `isInGitRepo: false` means "return no hooks at all" rather than "hooks that
 *   do nothing", so the loop never awaits a call that cannot produce anything.
 * - The hooks never throw. A capture failure degrades that boundary to null;
 *   snapshotting must not break a turn.
 * - Capture runs through `tryCaptureHot`, so an over-budget scan returns null
 *   and continues in the background instead of stalling tool execution indefinitely
 *   (see `worktree-tree-snapshot.tryCaptureHot`). The
 *   `workspace.treeSnapshotsEnabled` escape hatch is honoured inside
 *   `captureSessionTree`, so it applies to every caller of this module.
 */
import { lstat } from "node:fs/promises";
import { GEN_UI_TOOL_NAME, isGenUiReadAction } from "@shared/gen-ui-tool-policy";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { localBackend } from "../lib/agent/execution/local-backend";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import { SHELL_TOOL_NAME } from "../lib/agent/tools/bash";
import type {
	AgentConfig,
	AgentToolUse,
	ToolCallBinding,
	ToolExecutionTarget,
} from "../lib/agent/types";
import { logger } from "../lib/logger";
import { pathsEqualForOS } from "../lib/platform-path";
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
export const FILE_MUTATING_TOOLS = new Set([
	"Write",
	"Edit",
	"StructSed",
	SHELL_TOOL_NAME,
	GEN_UI_TOOL_NAME,
]);

function isFileMutation(toolName: string, input: unknown): boolean {
	return (
		FILE_MUTATING_TOOLS.has(toolName) &&
		!(
			toolName === GEN_UI_TOOL_NAME &&
			isGenUiReadAction((input as Record<string, unknown> | null)?.action)
		)
	);
}

/** Strictly inside the worktree. The worktree directory itself is not a file target. */
function fileInsideWorkspace(root: string, candidate: string): boolean {
	return declaredWorktreePaths(root, { file_path: candidate }).length > 0;
}

/**
 * Existing canonical directory, or null when the path is missing, not a directory,
 * or cannot be resolved. Symlinks are followed so `/tmp/project` and `/private/tmp/project`
 * compare as one workspace.
 */
async function canonicalWorkspaceDirectory(path: string): Promise<string | null> {
	try {
		const identity = await localBackend.resolvePathIdentity(path);
		if (!identity.exists) return null;
		const info = await lstat(identity.canonicalPath);
		if (!info.isDirectory() || info.isSymbolicLink()) return null;
		return identity.canonicalPath;
	} catch {
		return null;
	}
}

function workspaceRootResolver(cwd: string): () => Promise<string | null> {
	let pending: Promise<string | null> | undefined;
	return () => {
		pending ??= canonicalWorkspaceDirectory(cwd);
		return pending;
	};
}

/** Same directory as the session cwd, or a directory nested inside its canonical root. */
async function directoryCoversWorkspace(
	sessionCwd: string,
	candidate: string,
	root: () => Promise<string | null>,
): Promise<boolean> {
	const resolved = localPathSemantics.resolve(sessionCwd, candidate);
	if (pathsEqualForOS(sessionCwd, resolved, process.platform)) return true;
	const canonicalRoot = await root();
	if (!canonicalRoot) return false;
	if (pathsEqualForOS(canonicalRoot, resolved, process.platform)) return true;
	const canonical = await canonicalWorkspaceDirectory(resolved);
	if (!canonical) return false;
	return (
		pathsEqualForOS(canonicalRoot, canonical, process.platform) ||
		fileInsideWorkspace(canonicalRoot, canonical)
	);
}

/**
 * `canonicalPath` from the executor has already had symlinks resolved, so a lexical
 * hit against the session cwd cannot be an escape. A miss can still be the real
 * spelling of this same workspace.
 */
async function canonicalFileInsideWorkspace(
	sessionCwd: string,
	candidate: string,
	root: () => Promise<string | null>,
): Promise<boolean> {
	if (fileInsideWorkspace(sessionCwd, candidate)) return true;
	const canonicalRoot = await root();
	if (!canonicalRoot) return false;
	if (fileInsideWorkspace(canonicalRoot, candidate)) return true;
	try {
		const absolute = localPathSemantics.isAbsolute(candidate)
			? candidate
			: localPathSemantics.resolve(sessionCwd, candidate);
		const identity = await localBackend.resolvePathIdentity(absolute);
		return fileInsideWorkspace(canonicalRoot, identity.canonicalPath);
	} catch {
		return false;
	}
}

/** Paths whose lexical spelling missed the cwd but whose real files sit inside it. */
async function declaredPathsFromCanonicalWorkspace(
	sessionCwd: string,
	input: unknown,
	root: () => Promise<string | null>,
): Promise<string[]> {
	const args = input as Record<string, unknown> | null;
	const candidates = [args?.file_path, args?.to_file].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	if (candidates.length === 0) return [];
	const canonicalRoot = await root();
	if (!canonicalRoot) return [];
	const declared: string[] = [];
	for (const candidate of candidates) {
		if (specVfsService.isSpecUri(candidate)) continue;
		const absolute = localPathSemantics.resolve(sessionCwd, candidate);
		let canonical = absolute;
		if (!fileInsideWorkspace(canonicalRoot, absolute)) {
			try {
				canonical = (await localBackend.resolvePathIdentity(absolute)).canonicalPath;
			} catch {
				continue;
			}
		}
		for (const path of declaredWorktreePaths(canonicalRoot, { file_path: canonical })) {
			if (!declared.includes(path)) declared.push(path);
		}
	}
	return declared;
}

type WorkspaceAdmission =
	| { admit: false; reason: string }
	| { admit: true; declared: string[] | null };

/**
 * Decide whether this call's bytes land in the session worktree.
 * Null `declared` means the tool cannot name its files (Bash, UI create).
 */
async function assessLocalWorkspaceTarget(input: {
	sessionCwd: string;
	toolName: string;
	toolInput: unknown;
	declared: string[] | null;
	defaultDeviceId: string;
	requestedDevice: unknown;
	workdir: unknown;
	target: ToolExecutionTarget | undefined;
}): Promise<WorkspaceAdmission> {
	try {
		if (
			input.target &&
			(input.target.deviceId !== LOCAL_DEVICE_ID || input.target.backendKind !== "local")
		) {
			return { admit: false, reason: "remote_target" };
		}
		if (input.defaultDeviceId !== LOCAL_DEVICE_ID)
			return { admit: false, reason: "remote_session" };
		if (input.requestedDevice !== undefined && input.requestedDevice !== LOCAL_DEVICE_ID) {
			return { admit: false, reason: "requested_device" };
		}
		const root = workspaceRootResolver(input.sessionCwd);
		if (
			input.target &&
			!(await directoryCoversWorkspace(input.sessionCwd, input.target.cwd, root))
		) {
			return { admit: false, reason: "target_cwd" };
		}
		if (
			input.target?.canonicalPath !== undefined &&
			!(await canonicalFileInsideWorkspace(input.sessionCwd, input.target.canonicalPath, root))
		) {
			return { admit: false, reason: "canonical_path" };
		}
		if (input.toolName === SHELL_TOOL_NAME && input.workdir !== undefined) {
			if (
				typeof input.workdir !== "string" ||
				!(await directoryCoversWorkspace(input.sessionCwd, input.workdir, root))
			) {
				return { admit: false, reason: "bash_workdir" };
			}
		}
		if (input.declared !== null && input.declared.length === 0) {
			const recovered = await declaredPathsFromCanonicalWorkspace(
				input.sessionCwd,
				input.toolInput,
				root,
			);
			if (recovered.length === 0) return { admit: false, reason: "declared_paths" };
			return { admit: true, declared: recovered };
		}
		return { admit: true, declared: input.declared };
	} catch (error) {
		logger.debug("Tree snapshot target verification failed", { error: String(error) });
		return { admit: false, reason: "verification_failed" };
	}
}

/**
 * Build the snapshot hook pair for one agent loop.
 *
 * Returns `{}` when the workspace cannot be snapshotted at all (not a git repo),
 * which callers can spread into their `EventHooks` unconditionally.
 */
interface TreeSnapshotHookOptions {
	/** Mutable per-loop session state; must outlive a single tool call. */
	session: TreeSnapshotSession;
	narratorId: string;
	/** False for a cwd outside any git repository — no shadow repo is possible. */
	isInGitRepo: boolean;
	binding?: ToolCallBinding;
	executionTarget?: ToolExecutionTarget;
}

/** Legacy direct-call adapter. Runtime events no longer invoke these callbacks. */
export function buildTreeSnapshotEventHooks(
	opts: TreeSnapshotHookOptions,
): Pick<EventHooks, "onSnapshotBefore" | "onSnapshotAfter"> {
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
			if (!isFileMutation(toolName, input)) return;
			// Write/Edit can name their target up front, which is what lets the
			// resulting tree delta be attributed in a shared worktree. Bash cannot,
			// so it declares nothing and its set is derived instead.
			const lexicalDeclared =
				toolName === SHELL_TOOL_NAME || toolName === GEN_UI_TOOL_NAME
					? null // create allocates its unique directory at execution time.
					: declaredWorktreePaths(session.cwd, input);
			localCalls.delete(toolUseId);
			const args = input as Record<string, unknown> | null;
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
			const admission = await assessLocalWorkspaceTarget({
				sessionCwd: session.cwd,
				toolName,
				toolInput: input,
				declared: lexicalDeclared,
				defaultDeviceId: session._defaultDeviceId ?? LOCAL_DEVICE_ID,
				requestedDevice: args?.device,
				workdir: args?.workdir,
				target: opts.executionTarget,
			});
			if (!admission.admit) {
				abandonTreeSnapshot(session, narratorId, toolUseId);
				logger.warn(
					"Tree snapshot skipped: tool target is not verified inside the local workspace",
					{
						narratorId,
						toolUseId,
						toolName,
						reason: admission.reason,
					},
				);
				return;
			}
			const declared = admission.declared;
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
			// show never admitted a before boundary; do not manufacture an unavailable after.
			if (toolName === GEN_UI_TOOL_NAME && !localCalls.has(toolUseId)) return;
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
				await recordTreeSnapshotAfter(session, narratorId, toolUseId, {
					unavailable: true,
					binding: opts.binding,
				});
				return;
			}
			if (
				capturedCwd !== session.cwd ||
				(session._defaultDeviceId ?? LOCAL_DEVICE_ID) !== LOCAL_DEVICE_ID
			) {
				abandonTreeSnapshot(session, narratorId, toolUseId);
				await recordTreeSnapshotAfter(session, narratorId, toolUseId, {
					unavailable: true,
					binding: opts.binding,
				});
				return;
			}
			const { changedFiles } = await recordTreeSnapshotAfter(session, narratorId, toolUseId, {
				binding: opts.binding,
			});
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
			// The outline overlap index learns Bash's files too, without a hint in Bash's result:
			// the change is observed after the fact, not owned by one command (P2 PR 10b).
			try {
				const { isOutlineEnabled } = await import("./outline/feature");
				if (isOutlineEnabled()) {
					const { noteOutlineFileChange } = await import("./outline/overlap");
					await noteOutlineFileChange({
						narratorId,
						cwd: session.cwd,
						filePaths: changedFiles,
						backend: localBackend,
						locale: "en",
						hint: false,
					});
				}
			} catch {
				// The index is a convenience; Bash's result does not depend on it.
			}
		},
	};
}

/**
 * Execution-owned boundaries: UI events are allowed to run independently of captures.
 * Each admitted invocation keeps its own hooks and persisted identity, including re-runs.
 * The executor pairs after with before even when capture or tool execution throws/aborts.
 */
export function buildTreeSnapshotExecutionHooks(
	opts: TreeSnapshotHookOptions,
): Pick<AgentConfig, "onToolExecutionBefore" | "onToolExecutionAfter"> {
	if (!opts.isInGitRepo) return {};
	// Background completions may arrive after the primary switched cwd. The capture
	// pair must remain attached to the pass that admitted the original attempt.
	const sourceSession = opts.session;
	const passCwd = sourceSession.cwd;
	sourceSession._treeHashBefore ??= new Map();
	const beforeHashes = sourceSession._treeHashBefore;
	const calls = new WeakMap<AgentToolUse, ReturnType<typeof buildTreeSnapshotEventHooks>>();
	return {
		onToolExecutionBefore: async (context) => {
			if (!isFileMutation(context.toolUse.name, context.effectiveInput)) return;
			const hooks = buildTreeSnapshotEventHooks({
				...opts,
				session: {
					cwd: passCwd,
					// SwitchDevice retains its existing within-pass behavior. Freeze its
					// selected default at this attempt, not when the pass was built.
					_defaultDeviceId: sourceSession._defaultDeviceId,
					_treeHashBefore: beforeHashes,
				},
				binding: context.binding,
				executionTarget: context.executionTarget,
			});
			calls.set(context.toolUse, hooks);
			await hooks.onSnapshotBefore?.(
				context.toolUse.toolUseId,
				context.toolUse.name,
				context.effectiveInput,
			);
		},
		onToolExecutionAfter: async (context) => {
			const hooks = calls.get(context.toolUse);
			calls.delete(context.toolUse);
			if (!hooks) return;
			try {
				await hooks.onSnapshotAfter?.(context.toolUse.toolUseId, context.toolUse.name);
			} catch (error) {
				abandonTreeSnapshot(opts.session, opts.narratorId, context.toolUse.toolUseId);
				throw error;
			}
		},
	};
}
