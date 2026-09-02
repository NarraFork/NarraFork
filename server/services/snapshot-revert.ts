/** Device-aware, compensating snapshot rollback helpers used before history deletion. */
import { resolve as nodeResolve } from "node:path";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
} from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { LOCAL_DEVICE_ID, readCompleteFileBytes } from "../lib/agent/execution/backend";
import { backendDirname } from "../lib/agent/execution/path-resolve";
import { ExecutionTargetError, resolveBackend } from "../lib/agent/execution/registry";
import { encodeFileBytes } from "../lib/agent/tools/encoding";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { getDevice, isDeviceAuthorizedForProject } from "./device-service";
import {
	type DeviceFileIdentity,
	type DeviceFileState,
	FileHistoryError,
	getAffectedDeviceFilesStrict,
	ReplayDivergedError,
	rebuildDeviceFileStatesExcluding,
} from "./file-state-rebuild";
import { resolveProjectIdForNarratorId as resolveNarratorProjectId } from "./narrator-project";
import { invalidateWorkspaceTreeCache } from "./narrator-session-state";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

export type RevertFailureCode =
	| "REMOTE_DEVICE_UNAVAILABLE"
	| "REMOTE_DEVICE_UNAUTHORIZED"
	| "MISSING_EXECUTION_PATH"
	| "MISSING_LOCAL_CWD"
	| "UNSAFE_LEGACY_REMOTE_TARGET"
	| "REPLAY_DIVERGED"
	| "TREE_SNAPSHOT_MISSING"
	| "TREE_RESTORE_FAILED"
	/**
	 * A narrator-scoped rollback could not be applied because another actor changed
	 * the same regions. Reported instead of falling back to a workspace-wide restore,
	 * which would silently discard that other actor's work.
	 */
	| "REVERT_CONFLICT"
	| "PREPARE_FAILED"
	| "WRITE_FAILED"
	| "DELETE_FAILED"
	| "COMPENSATION_FAILED";

export interface RevertFailure {
	deviceId: string;
	filePath: string;
	pathFlavor?: DeviceFileIdentity["pathFlavor"];
	identityKey?: string;
	code: RevertFailureCode;
	message: string;
}

/**
 * How wide a rollback reaches.
 *
 * `narrator` undoes only the requesting narrator's own changes, keeping work that
 * other narrators, subagents or the user's editor did in the same window. It is
 * the default because a worktree is shared and discarding someone else's work is
 * not reversible from the UI.
 *
 * `workspace` restores every file to the recorded boundary. Still needed when the
 * intent really is "put this directory back", and for windows the scoped path
 * cannot express (see `narrator-scoped-revert`).
 */
export type RevertScope = "narrator" | "workspace";

export const DEFAULT_REVERT_SCOPE: RevertScope = "narrator";

/**
 * An advisory note about changes a rollback discarded beyond the caller's intent.
 *
 * Structured rather than prose: these surface in a bilingual UI, so the wording has
 * to be chosen by the client's i18n layer. The counts are what the server knows;
 * `sampleFilePaths` is a bounded excerpt, never the full set.
 */
export type RevertWarning =
	| {
			/** A workspace-wide restore also reverted work by other actors in the window. */
			code: "WORKSPACE_SCOPE_DISCARDED_OTHERS";
			otherActorCount: number;
			externalCount: number;
			unserializedCount: number;
			/** Edits a person made through NarraFork's own editor inside the window. */
			humanCount: number;
			sampleFilePaths: string[];
	  }
	| {
			/**
			 * A narrator-scoped rollback also reverted subagent changes. Subagent work
			 * records no tree boundary, so the merge decides its fate; this reports the
			 * measured outcome rather than an assumption.
			 */
			code: "SUBAGENT_CHANGES_REVERTED";
			changeCount: number;
			sampleFilePaths: string[];
	  };

export interface RevertResult {
	reverted: boolean;
	fileCount: number;
	files: string[];
	failures: RevertFailure[];
	/**
	 * Advisory notes about changes the rollback may have discarded beyond the
	 * caller's intent — another narrator's edits, an external edit, or a command
	 * whose write set was never serialized.
	 *
	 * Advisory on purpose: a workspace rollback is all-or-nothing, so the honest
	 * option is to report reduced confidence rather than to refuse, or to silently
	 * imply the change set was exactly one actor's.
	 */
	warnings?: RevertWarning[];
}

/**
 * Shared "nothing was reverted" value.
 *
 * Frozen because callers spread it into new objects (`{...EMPTY_RESULT, failures}`)
 * and a single in-place mutation of `files` would otherwise leak into every future
 * result that shares it.
 */
export const EMPTY_RESULT: RevertResult = Object.freeze({
	reverted: false,
	fileCount: 0,
	files: [] as string[],
	failures: [] as RevertFailure[],
});

/**
 * Compensation plans for reverts that already touched the filesystem but whose
 * history mutation has not been committed yet.
 *
 * A `WeakMap` is wrong here: if a caller drops the `RevertResult` without calling
 * `commitSnapshotRevert`, the plan is collected and the files stay rolled back
 * while the history they belonged to is still present. A strong `Map` keeps the
 * plan reachable so {@link discardSnapshotRevert} can undo it, and every entry is
 * removed on commit, discard, or expiry.
 */
const compensationPlans = new Map<RevertResult, { plan: RevertPlanItem[]; createdAt: number }>();

/**
 * Upper bound on how long an uncommitted plan is retained. A caller that neither
 * commits nor discards is a bug, but the map must not grow without limit in a
 * long-running server.
 */
const COMPENSATION_PLAN_TTL_MS = 10 * 60_000;

/** Drop plans whose owner never committed or discarded them. */
function evictStaleCompensationPlans(): void {
	if (compensationPlans.size === 0) return;
	const cutoff = Date.now() - COMPENSATION_PLAN_TTL_MS;
	for (const [result, entry] of compensationPlans) {
		if (entry.createdAt < cutoff) {
			compensationPlans.delete(result);
			logger.warn("Discarded stale snapshot compensation plan without commit", {
				fileCount: entry.plan.length,
			});
		}
	}
}

export class SnapshotRevertError extends AppError {
	constructor(public readonly failures: RevertFailure[]) {
		const first = failures[0];
		const detail = first ? `${first.code}: ${first.message}` : "unknown rollback failure";
		super(
			`File rollback did not complete; history was not deleted. ${detail}`,
			409,
			"SNAPSHOT_REVERT_FAILED",
		);
		this.name = "SnapshotRevertError";
	}
}

export function assertSnapshotRevertComplete(result: RevertResult): void {
	if (result.failures.length > 0) throw new SnapshotRevertError(result.failures);
}

/**
 * Resolve the local workspace path for a narrator.
 *
 * Must mirror `resolveNarratorSessionCwd`, which the running session uses:
 * `narrator.cwd` (explicit override) → chapter worktree → project git path.
 * Any divergence means snapshots get captured against one directory and reverted
 * against another. In particular a standalone narrator scoped to a project has a
 * null `cwd` and no chapter, so without the project fallback its history would be
 * unrevertable even though snapshots were recorded.
 *
 * The session's final `getHome()` fallback is deliberately not reproduced: the home
 * directory is not a workspace, and rolling files back there would be destructive.
 */
export async function resolveNarratorCwd(narratorId: string): Promise<string | null> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true, cwd: true, contextProjectId: true },
	});
	if (!narrator) return null;

	// An explicit cwd is the session's highest-priority source, so it wins here too.
	if (narrator.cwd) return narrator.cwd;

	if (narrator.chapterId) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
			columns: { worktreePath: true, projectId: true },
		});
		if (chapter?.worktreePath) return chapter.worktreePath;
		// Chapter dormant: the session falls back to the project repo, so we must too.
		if (chapter?.projectId) {
			const project = await db.query.projects.findFirst({
				where: eq(projects.id, chapter.projectId),
				columns: { gitPath: true },
			});
			if (project?.gitPath) return project.gitPath;
		}
		return null;
	}

	// Standalone narrator scoped to a project: the session runs in the project repo.
	if (narrator.contextProjectId) {
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, narrator.contextProjectId),
			columns: { gitPath: true },
		});
		if (project?.gitPath) return project.gitPath;
	}
	return null;
}

// Project resolution moved to `narrator-project.ts`. The copy that used to live
// here only looked at `chapterId`, so a standalone externally provisioned narrator
// always resolved to "no project" — which reads as "nothing to enforce".

function displayFile(identity: DeviceFileIdentity): string {
	return identity.deviceId === LOCAL_DEVICE_ID
		? identity.filePath
		: `${identity.deviceId}:${identity.filePath}`;
}

interface CapturedFileState {
	exists: boolean;
	bytes: Uint8Array | null;
}

interface RevertPlanItem {
	backend: ExecutionBackend;
	state: DeviceFileState;
	before: CapturedFileState;
}

async function captureFileState(
	backend: ExecutionBackend,
	filePath: string,
): Promise<CapturedFileState> {
	const stat = await backend.statFile(filePath);
	if (!stat) return { exists: false, bytes: null };
	if (!stat.isFile) throw new Error(`Rollback target is not a regular file: ${filePath}`);
	const current = await readCompleteFileBytes(backend, filePath);
	return { exists: true, bytes: Uint8Array.from(current.bytes) };
}

async function applyFileState(
	backend: ExecutionBackend,
	filePath: string,
	content: string | null,
	encoding?: string | null,
): Promise<void> {
	if (content === null) {
		await backend.removeFile(filePath);
		return;
	}
	await backend.mkdirp(backendDirname(backend, filePath));
	// Re-encode with the charset the baseline was decoded with. Writing UTF-8
	// unconditionally would silently convert legacy-encoded files (GBK, Shift_JIS…).
	await backend.writeFileBytes(filePath, encodeFileBytes(content, encoding ?? "utf-8"));
}

async function restoreCapturedState(item: RevertPlanItem): Promise<void> {
	if (!item.before.exists) {
		await item.backend.removeFile(item.state.filePath);
		return;
	}
	if (!item.before.bytes) throw new Error("Captured file bytes are missing");
	await item.backend.mkdirp(backendDirname(item.backend, item.state.filePath));
	await item.backend.writeFileBytes(item.state.filePath, item.before.bytes);
}

function validateResolvedBackend(deviceId: string, backend: ExecutionBackend): void {
	const expectedKind = deviceId === LOCAL_DEVICE_ID ? "local" : "remote";
	if (backend.deviceId !== deviceId || backend.kind !== expectedKind) {
		throw new Error(
			`Resolved backend mismatch for ${deviceId}: got ${backend.kind}/${backend.deviceId}`,
		);
	}
}

function failure(
	state: DeviceFileIdentity,
	code: RevertFailureCode,
	error: unknown,
): RevertFailure {
	return {
		deviceId: state.deviceId,
		filePath: state.filePath,
		...(state.pathFlavor && { pathFlavor: state.pathFlavor }),
		...(state.identityKey && { identityKey: state.identityKey }),
		code,
		message: error instanceof Error ? error.message : String(error),
	};
}

async function prepareRevertPlan(
	states: DeviceFileState[],
	projectId: string | null,
): Promise<{
	plan: RevertPlanItem[];
	failures: RevertFailure[];
}> {
	const plan: RevertPlanItem[] = [];
	const failures: RevertFailure[] = [];
	const backends = new Map<string, ExecutionBackend>();

	for (const state of states) {
		let backend = backends.get(state.deviceId);
		if (!backend) {
			if (state.deviceId !== LOCAL_DEVICE_ID) {
				const device = await getDevice(state.deviceId);
				if (!device) {
					failures.push(
						failure(
							state,
							"REMOTE_DEVICE_UNAVAILABLE",
							new Error(`Remote device "${state.deviceId}" is unknown or revoked.`),
						),
					);
					continue;
				}
				if (!isDeviceAuthorizedForProject(device, projectId)) {
					failures.push(
						failure(
							state,
							"REMOTE_DEVICE_UNAUTHORIZED",
							new Error(
								projectId
									? `Remote device "${state.deviceId}" is not authorized for project "${projectId}".`
									: `Standalone narrator history may only target global remote devices; "${state.deviceId}" is project-scoped.`,
							),
						),
					);
					continue;
				}
			}
			try {
				backend = resolveBackend({ requested: state.deviceId });
				validateResolvedBackend(state.deviceId, backend);
				backends.set(state.deviceId, backend);
			} catch (error) {
				const code =
					error instanceof ExecutionTargetError ? error.code : ("PREPARE_FAILED" as const);
				failures.push(failure(state, code, error));
				continue;
			}
		}
		try {
			plan.push({ backend, state, before: await captureFileState(backend, state.filePath) });
		} catch (error) {
			failures.push(failure(state, "PREPARE_FAILED", error));
		}
	}
	return { plan, failures };
}

async function compensateAttempted(items: RevertPlanItem[]): Promise<RevertFailure[]> {
	const failures: RevertFailure[] = [];
	for (const item of [...items].reverse()) {
		try {
			await restoreCapturedState(item);
		} catch (error) {
			failures.push(failure(item.state, "COMPENSATION_FAILED", error));
		}
	}
	return failures;
}

/**
 * Commit the accompanying history mutation. If it fails, restore the exact file
 * bytes captured before rollback so filesystem state and retained history agree.
 */
export async function commitSnapshotRevert<T>(
	result: RevertResult,
	commit: () => T | Promise<T>,
): Promise<T> {
	assertSnapshotRevertComplete(result);
	try {
		const value = await commit();
		compensationPlans.delete(result);
		treeCompensations.delete(result);
		return value;
	} catch (error) {
		const compensationFailures = await undoRevert(result);
		if (compensationFailures.length > 0) {
			logger.error("History mutation failed and snapshot compensation was incomplete", {
				commitError: String(error),
				compensationFailureCount: compensationFailures.length,
			});
			throw new SnapshotRevertError(compensationFailures);
		}
		throw error;
	}
}

/**
 * Accept the reverted filesystem state as final and release the plan.
 *
 * Use this for reverts that are an end in themselves (the explicit revert /
 * unrevert endpoints), where no history mutation follows and the new file state
 * must be kept. Without this the plan would linger until it expires.
 */
export function finalizeSnapshotRevert(result: RevertResult): void {
	compensationPlans.delete(result);
	treeCompensations.delete(result);
}

/**
 * Roll the filesystem back to its pre-revert state and forget the plan.
 *
 * Use this when a revert succeeded but its accompanying history mutation will
 * not be attempted, so the filesystem must not stay in the reverted state.
 */
export async function discardSnapshotRevert(result: RevertResult): Promise<RevertFailure[]> {
	const failures = await undoRevert(result);
	if (failures.length > 0) {
		logger.error("Snapshot revert discard left the filesystem partially reverted", {
			failureCount: failures.length,
		});
	}
	return failures;
}

/** Undo whichever kind of rollback this result performed, then forget it. */
async function undoRevert(result: RevertResult): Promise<RevertFailure[]> {
	const tree = treeCompensations.get(result);
	treeCompensations.delete(result);
	const plan = compensationPlans.get(result)?.plan ?? [];
	compensationPlans.delete(result);

	const failures = await compensateAttempted(plan);
	if (tree) {
		try {
			await worktreeTreeSnapshot.restore(tree.worktreePath, tree.previousTreeHash, LOCAL_DEVICE_ID);
		} catch (error) {
			failures.push(treeFailure(tree.worktreePath, "COMPENSATION_FAILED", error));
		}
		// Compensation is itself a write outside the tool path.
		invalidateWorkspaceTreeCache(tree.worktreePath);
	}
	return failures;
}

export async function applyDeviceFileStates(
	narratorId: string,
	states: DeviceFileState[],
): Promise<RevertResult> {
	if (states.length === 0) return EMPTY_RESULT;
	const projectId = await resolveNarratorProjectId(narratorId);
	const sortedStates = [...states].sort(
		(left, right) =>
			left.deviceId.localeCompare(right.deviceId) || left.filePath.localeCompare(right.filePath),
	);
	const prepared = await prepareRevertPlan(sortedStates, projectId);
	if (prepared.failures.length > 0) {
		return { ...EMPTY_RESULT, failures: prepared.failures };
	}

	// Replay writes bypass the tool path, so any live session's cached tree hash
	// stops describing the disk the moment the first file lands. Resolved before
	// writing so the invalidation cannot be skipped by an early failure exit.
	const sessionWorktree = prepared.plan.length > 0 ? await resolveNarratorCwd(narratorId) : null;

	const attempted: RevertPlanItem[] = [];
	for (const item of prepared.plan) {
		attempted.push(item);
		try {
			await applyFileState(
				item.backend,
				item.state.filePath,
				item.state.content,
				item.state.encoding,
			);
		} catch (error) {
			const code = item.state.content === null ? "DELETE_FAILED" : "WRITE_FAILED";
			const applyFailure = failure(item.state, code, error);
			const compensationFailures = await compensateAttempted(attempted);
			// Compensation restores content but not necessarily byte-identically to
			// what the cached hash described, so the cache is dropped either way.
			if (sessionWorktree) invalidateWorkspaceTreeCache(sessionWorktree);
			logger.warn("Snapshot rollback failed and was compensated", {
				deviceId: item.state.deviceId,
				filePath: item.state.filePath,
				compensationFailureCount: compensationFailures.length,
			});
			return {
				...EMPTY_RESULT,
				failures: [applyFailure, ...compensationFailures],
			};
		}
	}
	if (sessionWorktree) invalidateWorkspaceTreeCache(sessionWorktree);

	const files = prepared.plan.map((item) => displayFile(item.state));
	const result = { reverted: files.length > 0, fileCount: files.length, files, failures: [] };
	if (prepared.plan.length > 0) {
		evictStaleCompensationPlans();
		compensationPlans.set(result, { plan: prepared.plan, createdAt: Date.now() });
	}
	return result;
}

async function applyRebuiltStates(
	narratorId: string,
	identities: DeviceFileIdentity[],
	excludeToolUseIds: Set<string>,
): Promise<RevertResult> {
	if (identities.length === 0) return EMPTY_RESULT;
	try {
		const states = await rebuildDeviceFileStatesExcluding(
			narratorId,
			identities,
			excludeToolUseIds,
		);
		return applyDeviceFileStates(narratorId, [...states.values()]);
	} catch (error) {
		const code = error instanceof FileHistoryError ? error.code : "PREPARE_FAILED";
		// A diverged replay knows exactly which file could not be rebuilt; prefer it
		// over the first requested identity so the user sees the real culprit.
		const identity = (error instanceof ReplayDivergedError ? error.identity : null) ??
			identities[0] ?? { deviceId: LOCAL_DEVICE_ID, filePath: "(unknown)" };
		return { ...EMPTY_RESULT, failures: [failure(identity, code, error)] };
	}
}

type RevertableToolCall = {
	toolUseId: string;
	toolName: string;
	inputJson: unknown;
	executionDeviceId: string | null;
	executionCwd: string | null;
	executionPathFlavor: "posix" | "windows" | "spec" | null;
	resolvedFilePath: string | null;
	canonicalFilePath: string | null;
	runtimeGeneration: number | null;
	executionTargetsJson: unknown;
};

function rawToolPath(toolCall: RevertableToolCall): string {
	const input = toolCall.inputJson as Record<string, unknown> | null;
	return typeof input?.file_path === "string" ? input.file_path : "(unknown)";
}

async function revertToolCalls(
	narratorId: string,
	toolCalls: RevertableToolCall[],
	excludeToolUseIds: Set<string>,
): Promise<RevertResult> {
	const legacyLocalCwd = await resolveNarratorCwd(narratorId);
	let affectedFiles: DeviceFileIdentity[];
	try {
		affectedFiles = getAffectedDeviceFilesStrict(toolCalls, legacyLocalCwd);
	} catch (error) {
		const historyError = error instanceof FileHistoryError ? error : null;
		const toolCall = historyError?.toolUseId
			? toolCalls.find((candidate) => candidate.toolUseId === historyError.toolUseId)
			: toolCalls[0];
		const input = toolCall?.inputJson as Record<string, unknown> | null;
		const deviceId =
			toolCall?.executionDeviceId ??
			(typeof input?.device === "string" ? input.device : LOCAL_DEVICE_ID);
		return {
			...EMPTY_RESULT,
			failures: [
				{
					deviceId,
					filePath: toolCall ? rawToolPath(toolCall) : "(unknown)",
					code: historyError?.code ?? "PREPARE_FAILED",
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
	return applyRebuiltStates(narratorId, affectedFiles, excludeToolUseIds);
}

export async function revertPatchesForMessages(
	narratorId: string,
	messageIds: string[],
): Promise<RevertResult> {
	if (messageIds.length === 0) return EMPTY_RESULT;
	const toolCalls = await db.query.narratorToolCalls.findMany({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			inArray(narratorToolCalls.messageId, messageIds),
			eq(narratorToolCalls.status, "success"),
		),
		columns: {
			toolUseId: true,
			toolName: true,
			inputJson: true,
			executionDeviceId: true,
			executionCwd: true,
			executionPathFlavor: true,
			resolvedFilePath: true,
			canonicalFilePath: true,
			runtimeGeneration: true,
			executionTargetsJson: true,
		},
	});
	const result = await revertToolCalls(
		narratorId,
		toolCalls,
		new Set(toolCalls.map((toolCall) => toolCall.toolUseId)),
	);
	logger.info("Auto-reverted file changes for deleted messages", {
		narratorId,
		messageCount: messageIds.length,
		fileCount: result.fileCount,
		failureCount: result.failures.length,
	});
	return result;
}

export async function revertPatchForToolUse(
	narratorId: string,
	toolUseId: string,
): Promise<RevertResult> {
	return revertPatchForToolUses(narratorId, [toolUseId]);
}

export async function revertPatchForToolUses(
	narratorId: string,
	toolUseIds: string[],
): Promise<RevertResult> {
	if (toolUseIds.length === 0) return EMPTY_RESULT;
	const toolCalls = await db.query.narratorToolCalls.findMany({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			inArray(narratorToolCalls.toolUseId, toolUseIds),
			eq(narratorToolCalls.status, "success"),
		),
		columns: {
			toolUseId: true,
			toolName: true,
			inputJson: true,
			executionDeviceId: true,
			executionCwd: true,
			executionPathFlavor: true,
			resolvedFilePath: true,
			canonicalFilePath: true,
			runtimeGeneration: true,
			executionTargetsJson: true,
		},
	});
	const result = await revertToolCalls(
		narratorId,
		toolCalls,
		new Set(toolCalls.map((toolCall) => toolCall.toolUseId)),
	);
	logger.info("Auto-reverted file changes for deleted blocks", {
		narratorId,
		toolUseIdCount: toolUseIds.length,
		fileCount: result.fileCount,
		failureCount: result.failures.length,
	});
	return result;
}

// === Tree-based rollback ===================================================
//
// Restores a whole workspace to a recorded git tree instead of rebuilding files
// from recorded edits. This is the preferred path whenever a tree hash exists:
// it is byte-exact, covers changes no tool input describes, and cannot end up
// partially applied.

/** Compensation state for an in-flight tree rollback. */
interface TreeCompensation {
	worktreePath: string;
	/** Tree captured immediately before restoring, used to undo it. */
	previousTreeHash: string;
}

const treeCompensations = new Map<RevertResult, TreeCompensation>();

export function treeFailure(
	worktreePath: string,
	code: RevertFailureCode,
	error: unknown,
): RevertFailure {
	return {
		deviceId: LOCAL_DEVICE_ID,
		filePath: worktreePath,
		code,
		message: error instanceof Error ? error.message : String(error),
	};
}

/**
 * Register the undo state for a tree-based rollback that already touched disk.
 *
 * Exported so other tree-based rollback strategies (see `narrator-scoped-revert`)
 * participate in the same capture-then-compensate contract instead of duplicating
 * it: `commitSnapshotRevert` / `discardSnapshotRevert` then restore the pre-rollback
 * state if the accompanying history mutation fails.
 */
export function registerTreeCompensation(
	result: RevertResult,
	worktreePath: string,
	previousTreeHash: string,
): void {
	evictStaleCompensationPlans();
	treeCompensations.set(result, { worktreePath, previousTreeHash });
}

/**
 * Restore a narrator's workspace to a recorded tree snapshot.
 *
 * Captures the current state first so the rollback itself can be undone, then
 * hands the result to {@link commitSnapshotRevert} / {@link finalizeSnapshotRevert}
 * exactly like the per-file path.
 *
 * Fails (without touching any file) when the tree object is absent from the
 * shadow repository — a snapshot recorded on another machine, or one lost to gc.
 */
export async function revertWorkspaceToTree(
	narratorId: string,
	treeHash: string,
	/**
	 * Start of the window being undone, as an ISO timestamp. When given, changes in
	 * that window are inspected so the result can warn about ones this rollback will
	 * discard beyond the caller's intent.
	 */
	windowStartedAt?: string,
): Promise<RevertResult> {
	const worktreePath = await resolveNarratorCwd(narratorId);
	if (!worktreePath) {
		return {
			...EMPTY_RESULT,
			failures: [
				treeFailure(
					"(unknown)",
					"PREPARE_FAILED",
					new Error(`Narrator ${narratorId} has no resolvable workspace path.`),
				),
			],
		};
	}

	try {
		if (!(await worktreeTreeSnapshot.hasTree(worktreePath, treeHash, LOCAL_DEVICE_ID))) {
			return {
				...EMPTY_RESULT,
				failures: [
					treeFailure(
						worktreePath,
						"TREE_SNAPSHOT_MISSING",
						new Error(`Snapshot ${treeHash.slice(0, 12)} is not available for this workspace.`),
					),
				],
			};
		}
	} catch (error) {
		return { ...EMPTY_RESULT, failures: [treeFailure(worktreePath, "PREPARE_FAILED", error)] };
	}

	// Record where we are so a failed history mutation can be undone.
	let previousTreeHash: string;
	try {
		previousTreeHash = await worktreeTreeSnapshot.capture(worktreePath, LOCAL_DEVICE_ID);
	} catch (error) {
		return { ...EMPTY_RESULT, failures: [treeFailure(worktreePath, "PREPARE_FAILED", error)] };
	}

	let changedFiles: string[];
	try {
		changedFiles = await worktreeTreeSnapshot.restore(worktreePath, treeHash, LOCAL_DEVICE_ID);
	} catch (error) {
		// A restore can fail after touching some files, so the cache is suspect even
		// on the error path.
		invalidateWorkspaceTreeCache(worktreePath);
		return { ...EMPTY_RESULT, failures: [treeFailure(worktreePath, "TREE_RESTORE_FAILED", error)] };
	}
	invalidateWorkspaceTreeCache(worktreePath);

	const warnings = windowStartedAt
		? await buildImpreciseRevertWarnings(worktreePath, narratorId, windowStartedAt)
		: [];

	const result: RevertResult = {
		reverted: changedFiles.length > 0,
		fileCount: changedFiles.length,
		files: changedFiles,
		failures: [],
		...(warnings.length > 0 && { warnings }),
	};
	if (previousTreeHash !== treeHash) {
		evictStaleCompensationPlans();
		treeCompensations.set(result, { worktreePath, previousTreeHash });
	}
	logger.info("Reverted workspace to tree snapshot", {
		narratorId,
		worktreePath,
		treeHash,
		fileCount: changedFiles.length,
		warningCount: warnings.length,
	});
	return result;
}

/**
 * Describe changes in the reverted window that this rollback also discarded.
 *
 * A workspace rollback restores every file to the boundary, so anything written in
 * the window by another actor goes with it. Reporting that lets the caller (or the
 * model) verify the result instead of assuming the change set was one actor's.
 *
 * Never throws: a failure to build advice must not fail an otherwise good rollback.
 */
export async function buildImpreciseRevertWarnings(
	worktreePath: string,
	narratorId: string,
	windowStartedAt: string,
): Promise<RevertWarning[]> {
	try {
		const { findImpreciseChanges } = await import("./workspace-modification-view");
		const report = await findImpreciseChanges(worktreePath, {
			deviceId: LOCAL_DEVICE_ID,
			since: windowStartedAt,
			excludeNarratorId: narratorId,
		});
		if (!report.hasImprecise) return [];
		return [
			{
				code: "WORKSPACE_SCOPE_DISCARDED_OTHERS",
				otherActorCount: report.otherActorCount,
				externalCount: report.externalCount,
				unserializedCount: report.unserializedCount,
				// Must be threaded through: `hasImprecise` already counts human edits, so
				// omitting the number here would produce an advisory whose every category is
				// zero — the renderer names only non-zero parts, so the warning would appear
				// as an empty sentence and the user would be told nothing at all.
				humanCount: report.humanCount,
				sampleFilePaths: report.sampleFilePaths,
			},
		];
	} catch {
		return [];
	}
}

/**
 * Restore a narrator's workspace to the state recorded just before a tool ran.
 * Returns null when that tool has no recorded boundary, so callers can fall back
 * to the per-file replay path.
 */
export async function revertToToolCallTree(
	narratorId: string,
	toolUseId: string,
): Promise<RevertResult | null> {
	const toolCall = await db.query.narratorToolCalls.findFirst({
		where: and(
			eq(narratorToolCalls.narratorId, narratorId),
			eq(narratorToolCalls.toolUseId, toolUseId),
		),
		columns: { treeHashBefore: true, createdAt: true },
	});
	if (!toolCall?.treeHashBefore) return null;
	// The tool's own start time bounds the window this rollback undoes.
	return revertWorkspaceToTree(narratorId, toolCall.treeHashBefore, toolCall.createdAt);
}

/**
 * Restore a narrator's workspace to the state recorded at a message boundary.
 * Returns null when that message has no recorded boundary.
 */
export async function revertToMessageTree(
	narratorId: string,
	messageId: string,
): Promise<RevertResult | null> {
	const message = await db.query.narratorMessages.findFirst({
		where: eq(narratorMessages.id, messageId),
		columns: { treeHashAfter: true },
	});
	if (!message?.treeHashAfter) return null;
	return revertWorkspaceToTree(narratorId, message.treeHashAfter);
}

/**
 * Restore the workspace to the state that preceded every tool call from `minSeq`
 * onwards — the target of "undo everything from this message on".
 *
 * Resolves to the earliest recorded pre-tool boundary in that range. Returns null
 * when no tool call in the range has one, so the caller can fall back to replay.
 *
 * Requires that the *first* tool call in the range carry a boundary: starting from
 * a later one would silently keep the earlier tools' writes. When it is missing,
 * replay is the honest answer rather than a partial rollback.
 */
export async function revertFromSeqTree(
	narratorId: string,
	minSeq: number,
): Promise<RevertResult | null> {
	const boundary = await resolveSeqTreeBoundary(narratorId, minSeq);
	if (!boundary) return null;
	return revertWorkspaceToTree(narratorId, boundary.treeHash, boundary.startedAt);
}

/**
 * Restore the workspace to the state that preceded a set of messages about to be
 * deleted. Returns null when the earliest affected tool call has no boundary.
 *
 * Only sound when the messages form a contiguous tail of the timeline, which is
 * how deletion and rollback use it: restoring the first boundary also discards
 * everything recorded after it.
 */
export async function revertForMessagesTree(
	narratorId: string,
	messageIds: string[],
): Promise<RevertResult | null> {
	const boundary = await resolveMessagesTreeBoundary(narratorId, messageIds);
	if (!boundary) return null;
	return revertWorkspaceToTree(narratorId, boundary.treeHash, boundary.startedAt);
}

/** A recorded boundary plus when the change it precedes started. */
interface TreeBoundary {
	treeHash: string;
	startedAt: string;
}

/** Earliest recorded pre-tool boundary among a set of messages. */
async function resolveMessagesTreeBoundary(
	narratorId: string,
	messageIds: string[],
): Promise<TreeBoundary | null> {
	if (messageIds.length === 0) return null;
	const [earliest] = await db
		.select({
			treeHashBefore: narratorToolCalls.treeHashBefore,
			createdAt: narratorToolCalls.createdAt,
		})
		.from(narratorToolCalls)
		.innerJoin(
			narratorMessageRefs,
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
			),
		)
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.status, "success"),
				inArray(narratorToolCalls.messageId, messageIds),
			),
		)
		.orderBy(asc(narratorMessageRefs.seq), asc(narratorToolCalls.createdAt))
		.limit(1);
	return earliest?.treeHashBefore
		? { treeHash: earliest.treeHashBefore, startedAt: earliest.createdAt }
		: null;
}

/** Earliest recorded pre-tool boundary from `minSeq` onwards. */
async function resolveSeqTreeBoundary(
	narratorId: string,
	minSeq: number,
): Promise<TreeBoundary | null> {
	const [earliest] = await db
		.select({
			treeHashBefore: narratorToolCalls.treeHashBefore,
			createdAt: narratorToolCalls.createdAt,
		})
		.from(narratorToolCalls)
		.innerJoin(
			narratorMessageRefs,
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
			),
		)
		.where(
			and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.status, "success"),
				gte(narratorMessageRefs.seq, minSeq),
			),
		)
		.orderBy(asc(narratorMessageRefs.seq), asc(narratorToolCalls.createdAt))
		.limit(1);
	return earliest?.treeHashBefore
		? { treeHash: earliest.treeHashBefore, startedAt: earliest.createdAt }
		: null;
}

export interface TreeRevertPreviewFile {
	deviceId: string;
	filePath: string;
	/** True when restoring the boundary removes this path. */
	willBeDeleted: boolean;
	/** Path relative to the worktree, used to read blob contents on demand. */
	relPath: string;
}

export interface TreeRevertPreview {
	treeHash: string;
	worktreePath: string;
	/** State the workspace is in now, for content diffs. */
	currentTreeHash: string;
	files: TreeRevertPreviewFile[];
}

/** Attach current/reverted text to a tree preview, for diff views. */
export async function loadTreePreviewContents(
	preview: TreeRevertPreview,
): Promise<
	Array<TreeRevertPreviewFile & { currentContent: string | null; revertedContent: string | null }>
> {
	const out: Array<
		TreeRevertPreviewFile & { currentContent: string | null; revertedContent: string | null }
	> = [];
	for (const file of preview.files) {
		const [currentContent, revertedContent] = await Promise.all([
			worktreeTreeSnapshot.readFileAtTree(
				preview.worktreePath,
				preview.currentTreeHash,
				file.relPath,
				LOCAL_DEVICE_ID,
			),
			worktreeTreeSnapshot.readFileAtTree(
				preview.worktreePath,
				preview.treeHash,
				file.relPath,
				LOCAL_DEVICE_ID,
			),
		]);
		out.push({ ...file, currentContent, revertedContent });
	}
	return out;
}

/**
 * Describe what a tree rollback would change, for the confirmation dialogs.
 *
 * This must come from the same tree comparison the rollback performs. Deriving the
 * list from recorded Write/Edit inputs instead would under-report: a tree restore
 * also reverts files touched by Bash or external tools, which have no tool input
 * to enumerate.
 *
 * Returns null when there is no boundary (so the caller previews the replay path)
 * or when the snapshot is unavailable.
 */
async function previewTreeBoundary(
	narratorId: string,
	treeHash: string | null,
): Promise<TreeRevertPreview | null> {
	if (!treeHash) return null;
	const worktreePath = await resolveNarratorCwd(narratorId);
	if (!worktreePath) return null;
	try {
		if (!(await worktreeTreeSnapshot.hasTree(worktreePath, treeHash, LOCAL_DEVICE_ID))) {
			return null;
		}
		const current = await worktreeTreeSnapshot.capture(worktreePath, LOCAL_DEVICE_ID);
		const changed = await worktreeTreeSnapshot.diffPaths(
			worktreePath,
			treeHash,
			current,
			LOCAL_DEVICE_ID,
		);
		const inBoundary = new Set(
			await worktreeTreeSnapshot.listPaths(worktreePath, treeHash, LOCAL_DEVICE_ID),
		);
		return {
			treeHash,
			worktreePath,
			currentTreeHash: current,
			files: changed.map((relPath) => ({
				deviceId: LOCAL_DEVICE_ID,
				filePath: joinWorktreePath(worktreePath, relPath),
				relPath,
				// Absent from the boundary means it was created afterwards, so restoring removes it.
				willBeDeleted: !inBoundary.has(relPath),
			})),
		};
	} catch (error) {
		logger.debug("Tree revert preview unavailable", { narratorId, treeHash, error: String(error) });
		return null;
	}
}

function joinWorktreePath(worktreePath: string, relPath: string): string {
	return nodeResolve(worktreePath, relPath);
}

/**
 * Preview the rollback that "undo everything from this sequence onwards" performs.
 *
 * Both the rollback and delete confirmation dialogs use this, because both operate
 * on a contiguous tail starting at a message's seq.
 */
export async function previewSeqTreeRevert(
	narratorId: string,
	minSeq: number,
): Promise<TreeRevertPreview | null> {
	const boundary = await resolveSeqTreeBoundary(narratorId, minSeq);
	return previewTreeBoundary(narratorId, boundary?.treeHash ?? null);
}

/** Preview the rollback that deleting a set of messages would perform. */
export async function previewMessagesTreeRevert(
	narratorId: string,
	messageIds: string[],
): Promise<TreeRevertPreview | null> {
	const boundary = await resolveMessagesTreeBoundary(narratorId, messageIds);
	return previewTreeBoundary(narratorId, boundary?.treeHash ?? null);
}

/** @deprecated compatibility context for routes that still require the local cwd. */
export async function resolveSnapshotContext(
	narratorId: string,
): Promise<{ scopeId: string; worktreePath: string } | null> {
	const cwd = await resolveNarratorCwd(narratorId);
	return cwd ? { scopeId: narratorId, worktreePath: cwd } : null;
}
