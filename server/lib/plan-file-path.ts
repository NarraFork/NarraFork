/**
 * plan-file-path.ts — single source of truth for the designated plan file path.
 *
 * Plan files live under `<narrator cwd>/.narrafork/plans/`. The path is always
 * built RELATIVE to the narrator's working directory: the same relative string is
 * resolved by the tool execution layer against whatever backend actually runs the
 * write (local worktree, project git path, or a remote executor's default cwd).
 *
 * Everything that needs the path — path generation, the permission gate, the
 * plan-mode system reminder, ExitPlanMode resolution — must go through here.
 * These used to be nine separate `.narrafork/plan-${id}.md` literals, which is
 * exactly the kind of duplication where one missed site silently makes the plan
 * file invisible to either the model or the approval gate.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { WorkspaceContext } from "@shared/workspace-context";
import type { ExecutionBackend, FileStat } from "./agent/execution/backend";
import type { TargetPathSemantics } from "./agent/execution/path-semantics";

/** Automatic engineering reads use the same actor/project/device/path policy as tools. */
export interface WorkspaceFileAccess {
	backend: ExecutionBackend;
	workspaceContext?: WorkspaceContext;
	signal?: AbortSignal;
	runtimeGeneration?: number;
	authorizeRead: (
		canonicalPath: string,
		backend: ExecutionBackend,
		signal?: AbortSignal,
	) => Promise<boolean | undefined>;
}

export interface PlanFileBinding {
	workspaceContext: WorkspaceContext;
	planFileId: string;
	planFilePath: string;
}

/** Runtime layer supplies the authorization intersection; this helper freezes IO identity. */
export function createWorkspaceFileAccess(input: WorkspaceFileAccess): WorkspaceFileAccess {
	if (input.workspaceContext && input.workspaceContext.deviceId !== input.backend.deviceId) {
		throw new Error("Workspace file backend does not match frozen workspace");
	}
	return Object.freeze({
		...input,
		runtimeGeneration: input.backend.runtimeGeneration,
		workspaceContext: input.workspaceContext
			? Object.freeze(structuredClone(input.workspaceContext))
			: undefined,
	});
}

export const WORKSPACE_READ_TIMEOUT_MS = 5_000;

function waitWorkspaceRead<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				if (signal.aborted) reject(signal.reason);
				else resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
		if (signal.aborted) abort();
	});
}

/** Canonicalize and authorize before even metadata is exposed; never use host filesystem. */
export async function statWorkspaceFile(
	access: WorkspaceFileAccess,
	filePath: string,
): Promise<FileStat | null> {
	const { backend } = access;
	const signal = access.signal
		? AbortSignal.any([access.signal, AbortSignal.timeout(WORKSPACE_READ_TIMEOUT_MS)])
		: AbortSignal.timeout(WORKSPACE_READ_TIMEOUT_MS);
	signal.throwIfAborted();
	if (access.workspaceContext && access.workspaceContext.deviceId !== backend.deviceId) {
		throw new Error("Workspace file backend does not match frozen workspace");
	}
	const generation = access.runtimeGeneration ?? backend.runtimeGeneration;
	if (backend.runtimeGeneration !== generation)
		throw new Error("Workspace read backend generation changed");
	const identity = await waitWorkspaceRead(
		backend.resolvePathIdentity(filePath, {
			signal,
			timeoutMs: WORKSPACE_READ_TIMEOUT_MS,
		}),
		signal,
	);
	if (identity.runtimeGeneration !== generation || backend.runtimeGeneration !== generation) {
		throw new Error("Workspace read backend generation changed");
	}
	if (
		(await waitWorkspaceRead(
			access.authorizeRead(identity.canonicalPath, backend, signal),
			signal,
		)) === false
	) {
		throw new Error(`Workspace read denied: ${identity.canonicalPath}`);
	}
	signal.throwIfAborted();
	if (backend.runtimeGeneration !== generation)
		throw new Error("Workspace read backend generation changed");
	const info = await waitWorkspaceRead(
		backend.statFile(identity.lexicalPath, {
			signal,
			timeoutMs: WORKSPACE_READ_TIMEOUT_MS,
		}),
		signal,
	);
	if (backend.runtimeGeneration !== generation)
		throw new Error("Workspace read backend generation changed");
	if (info?.resolvedPath && !backend.paths.equals(info.resolvedPath, identity.canonicalPath)) {
		throw new Error("Workspace read path identity changed");
	}
	return info ? { ...info, resolvedPath: identity.canonicalPath } : null;
}

export async function readWorkspaceText(
	access: WorkspaceFileAccess,
	filePath: string,
	maxBytes: number,
): Promise<{ content: string; truncated: boolean } | null> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1_048_576) {
		throw new Error("Automatic workspace reads require a limit between 1 byte and 1 MiB");
	}
	const generation = access.backend.runtimeGeneration;
	const info = await statWorkspaceFile(access, filePath);
	if (!info?.isFile) return null;
	if (access.backend.runtimeGeneration !== generation)
		throw new Error("Workspace read backend generation changed");
	const signal = access.signal
		? AbortSignal.any([access.signal, AbortSignal.timeout(WORKSPACE_READ_TIMEOUT_MS)])
		: AbortSignal.timeout(WORKSPACE_READ_TIMEOUT_MS);
	const result = await waitWorkspaceRead(
		access.backend.readFileBytes(filePath, {
			maxBytes,
			signal,
			timeoutMs: WORKSPACE_READ_TIMEOUT_MS,
			expectedResolvedPath: info.resolvedPath,
		}),
		signal,
	);
	if (result.bytes.byteLength > maxBytes) throw new Error("Workspace read exceeded byte limit");
	if (
		access.backend.runtimeGeneration !== generation ||
		(result.resolvedPath &&
			info.resolvedPath &&
			!access.backend.paths.equals(result.resolvedPath, info.resolvedPath))
	) {
		throw new Error("Workspace read source changed");
	}
	return {
		content: new TextDecoder().decode(result.bytes, { stream: result.truncated }),
		truncated: result.truncated,
	};
}

/** Directory (relative to the narrator cwd) holding every designated plan file. */
export const PLAN_DIR_REL = ".narrafork/plans";

/** Canonical relative path of the designated plan file for a plan identity. */
export function buildPlanFileRelPath(planFileId: string): string {
	return `${PLAN_DIR_REL}/plan-${planFileId}.md`;
}

/**
 * Pre-`plans/` layout: `.narrafork/plan-<id>.md`.
 *
 * TODO(migration): delete together with the legacy resolution in
 * narrator-session.ts once no plan cycle started before the move is still open.
 */
export function buildLegacyPlanFileRelPath(planFileId: string): string {
	return `.narrafork/plan-${planFileId}.md`;
}

/**
 * Is this plan identity safe to interpolate into a path?
 *
 * Identities are generated server-side, but restored narrators carry whatever is
 * in the DB, so refuse anything that could escape the plan directory.
 */
export function isSafePlanFileIdForPath(
	planFileId: string | null | undefined,
): planFileId is string {
	if (!planFileId) return false;
	if (planFileId.includes("/") || planFileId.includes("\\")) return false;
	if (planFileId.includes("..")) return false;
	return true;
}

/**
 * Does `candidate` resolve inside `<baseCwd>/.narrafork/plans/`?
 *
 * Purely lexical, and deliberately parameterized on the TARGET's path grammar:
 * a remote Windows executor must be judged with Windows semantics, not the
 * server's. Symlink escapes are not visible here — callers that read the file
 * must re-check the canonical path returned by stat (see resolveExitPlanMode).
 */
export function isInsidePlansDir(
	paths: TargetPathSemantics,
	baseCwd: string,
	candidate: string,
): boolean {
	const plansDir = paths.resolve(baseCwd, PLAN_DIR_REL);
	return paths.contains(plansDir, paths.resolve(baseCwd, candidate));
}

/**
 * Is this write TARGETING the plan itself rather than the project?
 *
 * Plan mode's whole contract is "write the plan, not the code", so a Write/Edit aimed
 * at the plan file is the model DOING what plan mode asked — not something to warn it
 * about. Anything under `<baseCwd>/.narrafork/plans/` counts, because relaxed plan mode
 * lets a model choose its own file in that directory (ExitPlanMode's `plan_file_path`).
 *
 * `designatedPlanFilePath` is checked separately for exactly one reason: a cycle still
 * anchored to the pre-`plans/` layout (`.narrafork/plan-<id>.md`) writes OUTSIDE the
 * directory, and that file is just as much the plan.
 *
 * Purely lexical, like {@link isInsidePlansDir}, and judged with the TARGET's grammar.
 * A false negative only costs a redundant reminder, so no filesystem probe is needed.
 */
export function isPlanAuthoringPath(
	paths: TargetPathSemantics,
	baseCwd: string,
	candidate: string,
	designatedPlanFilePath?: string | null,
): boolean {
	if (!candidate.trim()) return false;
	const designated = designatedPlanFilePath?.trim();
	if (
		designated &&
		paths.equals(paths.resolve(baseCwd, designated), paths.resolve(baseCwd, candidate))
	) {
		return true;
	}
	return isInsidePlansDir(paths, baseCwd, candidate);
}

/** Does this relative path hold a non-empty file under `cwd`? */
export type PlanFileContentProbe = (cwd: string, relPath: string) => Promise<boolean>;

const localPlanFileContentProbe: PlanFileContentProbe = async (cwd, relPath) => {
	try {
		const stats = await stat(resolve(cwd, relPath));
		return stats.isFile() && stats.size > 0;
	} catch {
		return false;
	}
};

/**
 * Anchor a plan cycle to the plan file that actually holds content.
 *
 * Plan files moved from `.narrafork/plan-<id>.md` into `.narrafork/plans/`. A cycle
 * already writing to the legacy path must keep using it: switching paths mid-cycle
 * would hide an in-progress plan from both the system reminder and ExitPlanMode, and
 * the model would silently start a second, empty plan.
 *
 * Bounded to at most two probes, and only called when a narrator session is created
 * for a narrator already in plan mode — never on a normal request path. A narrator
 * whose plan file lives on a remote executor sees both local probes miss and lands
 * on the canonical path: the same result the pre-move code produced by building the
 * relative path blind.
 *
 * TODO(migration): delete together with `buildLegacyPlanFileRelPath` once no plan
 * cycle started before the move is still open.
 */
export async function resolveExistingPlanFileRelPath(
	cwd: string,
	planFileId: string | null | undefined,
	probeOrAccess: PlanFileContentProbe | WorkspaceFileAccess = localPlanFileContentProbe,
): Promise<string | undefined> {
	if (!isSafePlanFileIdForPath(planFileId)) return undefined;
	const canonical = buildPlanFileRelPath(planFileId);
	const access = typeof probeOrAccess === "function" ? undefined : probeOrAccess;
	const probe: PlanFileContentProbe =
		typeof probeOrAccess === "function"
			? probeOrAccess
			: async (base, rel) => {
					const info = await statWorkspaceFile(
						probeOrAccess,
						probeOrAccess.backend.paths.resolve(base, rel),
					);
					return !!info?.isFile && info.size > 0;
				};
	const baseCwd = access?.workspaceContext?.cwd ?? cwd;
	if (!(access ? access.backend.paths.isAbsolute(baseCwd) : isAbsolute(baseCwd))) return canonical;
	if (await probe(baseCwd, canonical)) return canonical;
	const legacy = buildLegacyPlanFileRelPath(planFileId);
	if (await probe(baseCwd, legacy)) return legacy;
	return canonical;
}
