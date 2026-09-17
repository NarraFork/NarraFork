import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { GitWorkspace, GitWorkspaceState } from "@shared/git-workspace";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects } from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { localBackend, resolveBackend } from "../lib/agent/execution/registry";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";
import { getHome } from "../lib/platform";
import { normalizePathForComparison } from "../lib/platform-path";
import { safeSpawn } from "../lib/spawn";
import { resolveNarratorSessionCwd } from "./narrator-cwd";
import { activeNarrators } from "./narrator-session-state";
import { createRemoteGitService, supportsRemoteGitWorkspace } from "./remote-git-service";

/** Legacy path consumers retain their local path key; management uses device/root keys. */
export interface ResolvedWorkspace {
	workspacePath: string;
	rawPath: string;
	chapterId?: string;
	projectId?: string;
	baseBranch?: string;
}

export function normalizeWorkspacePath(path: string): string {
	return normalizePathForComparison(path);
}

export const GIT_PROBE_TIMEOUT_MS = 10_000;
export const GIT_PROBE_MAX_BYTES = 32 * 1024;

export interface GitProbe {
	state: GitWorkspaceState;
	rootPath?: string;
	repositoryPath?: string;
	reason?: string;
}

/** Real Git probing handles unborn repositories, linked worktrees, submodules and bare repos. */
export async function probeLocalGitWorkspace(cwd: string, signal?: AbortSignal): Promise<GitProbe> {
	try {
		if (!(await stat(cwd)).isDirectory()) return { state: "missing_directory" };
	} catch (error) {
		return {
			state:
				(error as NodeJS.ErrnoException).code === "EACCES" ? "access_denied" : "missing_directory",
		};
	}
	try {
		const result = await safeSpawn({
			cmd: [
				"git",
				"--no-optional-locks",
				"-C",
				cwd,
				"rev-parse",
				"--is-inside-work-tree",
				"--is-bare-repository",
				"--path-format=absolute",
				"--show-toplevel",
				"--git-common-dir",
			],
			timeout: GIT_PROBE_TIMEOUT_MS,
			maxOutputBytes: GIT_PROBE_MAX_BYTES,
			signal,
		});
		if (result.stdoutTruncated || result.stderrTruncated)
			return { state: "unsupported", reason: "Git workspace probe exceeded its output budget" };
		const [inside, bare, root, repository] = result.stdout.trim().split("\n");
		if (bare === "true")
			return { state: "unsupported", reason: "Bare repositories have no working tree" };
		if (result.exitCode !== 0 || inside !== "true" || !root || !repository) {
			if (/dubious ownership|permission denied|access denied/i.test(result.stderr))
				return { state: "access_denied", reason: "Git refused access to this working tree" };
			return { state: "not_git", reason: "Directory is not a Git working tree" };
		}
		return {
			state: "ready",
			rootPath: await realpath(root),
			repositoryPath: await realpath(repository),
		};
	} catch (error) {
		signal?.throwIfAborted();
		return {
			state: /ENOENT|not found/i.test(String(error)) ? "git_unavailable" : "unsupported",
			reason: "Git workspace probe failed",
		};
	}
}

export function gitWorkspaceIdentity(
	backend: Pick<ExecutionBackend, "deviceId" | "paths">,
	root: string,
): string {
	return createHash("sha256")
		.update(JSON.stringify([backend.deviceId, backend.paths.identityKey(root)]))
		.digest("hex");
}

export interface GitWorkspaceTarget {
	workspace: GitWorkspace;
	backend?: ExecutionBackend;
	repositoryPath?: string;
	/** Associated project is for authorization even when cwd overrides the chapter. */
	contextProjectId?: string;
	/** The local session cwd is NOT used as a remote cwd fallback. */
	configuredCwd?: string;
	/** Request-bound authorization refresh, never serialized to clients. */
	beforeWrite?: () => Promise<void>;
}

export async function resolveNarratorGitTarget(
	narratorId: string,
	signal?: AbortSignal,
	beforeResolve?: (target: GitWorkspaceTarget) => Promise<void>,
	beforeProbe?: (target: GitWorkspaceTarget) => Promise<void>,
): Promise<GitWorkspaceTarget> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: {
			id: true,
			cwd: true,
			chapterId: true,
			contextProjectId: true,
			defaultDeviceId: true,
		},
	});
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	const chapter = narrator.chapterId
		? await db.query.chapters.findFirst({
				where: eq(chapters.id, narrator.chapterId),
				columns: { id: true, projectId: true, worktreePath: true },
			})
		: undefined;
	if (narrator.chapterId && !chapter) throw new NotFoundError("Chapter", narrator.chapterId);
	const projectId = chapter?.projectId ?? narrator.contextProjectId ?? undefined;
	const project = projectId
		? await db.query.projects.findFirst({
				where: eq(projects.id, projectId),
				columns: { gitPath: true },
			})
		: undefined;
	if (projectId && !project) throw new NotFoundError("Project", projectId);
	const active = activeNarrators.get(narratorId);
	const localCwd =
		active?.cwd ??
		resolveNarratorSessionCwd(narrator.cwd, chapter?.worktreePath, project?.gitPath, getHome());
	const deviceId = active
		? (active._defaultDeviceId ?? "local")
		: (narrator.defaultDeviceId ?? "local");
	const workspace: GitWorkspace = {
		narratorId,
		projectId,
		deviceId,
		cwd: deviceId === "local" ? localCwd : "",
		rootPath: null,
		workspaceKey: null,
		repositoryKey: null,
		state: "device_offline",
		capabilities: { read: false, write: false },
	};
	// No backend resolution, device RPC or local Git probe is allowed before this access gate.
	await beforeResolve?.({ workspace, contextProjectId: projectId, configuredCwd: localCwd });
	let backend: ExecutionBackend;
	try {
		backend = resolveBackend({ requested: deviceId });
	} catch {
		return { workspace, contextProjectId: projectId, configuredCwd: localCwd };
	}
	// Match toolBaseCwd: remote tools use the executor's cwd, never the host-side
	// narrator.cwd. Local tools use the live session cwd, then the persisted override.
	workspace.cwd = backend.kind === "remote" ? (backend.defaultCwd ?? "") : localCwd;
	const target: GitWorkspaceTarget = {
		workspace,
		backend,
		contextProjectId: projectId,
		configuredCwd: localCwd,
	};
	if (!workspace.cwd || !backend.paths.isAbsolute(workspace.cwd)) {
		workspace.state = "missing_directory";
		workspace.reason = "Execution device has no absolute working directory";
		return target;
	}
	// The cwd itself must pass execution policy before Git reads any metadata from it.
	await beforeProbe?.(target);
	if (backend.kind === "remote" && !supportsRemoteGitWorkspace(backend)) {
		workspace.state = "unsupported";
		workspace.reason = "Upgrade the remote executor to support Git workspace management";
		return target;
	}
	let probe: GitProbe;
	try {
		const result =
			backend.kind === "local"
				? await probeLocalGitWorkspace(workspace.cwd, signal)
				: await createRemoteGitService(backend, signal).probe(workspace.cwd);
		probe = { ...result, state: result.state ?? "unsupported" };
	} catch (error) {
		signal?.throwIfAborted();
		workspace.state = /offline|connection|unavailable|disconnect/i.test(String(error))
			? "device_offline"
			: /denied|forbidden|path.*rule|outside/i.test(String(error))
				? "access_denied"
				: "unsupported";
		workspace.reason = "Execution device could not resolve the Git working tree";
		return target;
	}
	workspace.state = probe.state ?? "unsupported";
	workspace.reason = probe.reason;
	if (probe.state !== "ready" || !probe.rootPath || !probe.repositoryPath) return target;
	workspace.rootPath = probe.rootPath;
	target.repositoryPath = probe.repositoryPath;
	workspace.workspaceKey = gitWorkspaceIdentity(backend, probe.rootPath);
	workspace.repositoryKey = gitWorkspaceIdentity(backend, probe.repositoryPath);
	// A chapter is only a side-effect adapter for its *actual* worktree.
	if (backend.kind === "local" && chapter?.worktreePath) {
		const chapterRoot = await realpath(chapter.worktreePath).catch(() => null);
		if (chapterRoot && backend.paths.equals(chapterRoot, probe.rootPath))
			workspace.chapterId = chapter.id;
	}
	return target;
}

export async function resolveWorkspaceFromChapter(chapterId: string): Promise<ResolvedWorkspace> {
	const ch = await db.query.chapters.findFirst({ where: eq(chapters.id, chapterId) });
	if (!ch) throw new NotFoundError("Chapter", chapterId);
	if (!ch.worktreePath) throw new ValidationError("Chapter has no active worktree");
	return {
		workspacePath: normalizeWorkspacePath(ch.worktreePath),
		rawPath: ch.worktreePath,
		chapterId: ch.id,
		projectId: ch.projectId,
		baseBranch: ch.baseBranch,
	};
}

export async function resolveChapterGitTarget(
	chapterId: string,
	signal?: AbortSignal,
): Promise<GitWorkspaceTarget> {
	const legacy = await resolveWorkspaceFromChapter(chapterId);
	const probe = await probeLocalGitWorkspace(legacy.rawPath, signal);
	const root = probe.rootPath ?? null;
	return {
		backend: localBackend,
		repositoryPath: probe.repositoryPath,
		contextProjectId: legacy.projectId,
		workspace: {
			cwd: legacy.rawPath,
			deviceId: "local",
			rootPath: root,
			workspaceKey: root ? gitWorkspaceIdentity(localBackend, root) : null,
			repositoryKey: probe.repositoryPath
				? gitWorkspaceIdentity(localBackend, probe.repositoryPath)
				: null,
			state: probe.state,
			reason: probe.reason,
			capabilities: { read: false, write: false },
			chapterId,
			projectId: legacy.projectId,
		},
	};
}

export async function resolveWorkspaceFromNarrator(
	narratorId: string,
): Promise<ResolvedWorkspace | null> {
	const { workspace } = await resolveNarratorGitTarget(narratorId);
	if (workspace.state !== "ready" || !workspace.rootPath || !workspace.workspaceKey) return null;
	return {
		rawPath: workspace.rootPath,
		workspacePath:
			workspace.deviceId === "local"
				? normalizeWorkspacePath(workspace.rootPath)
				: workspace.workspaceKey,
		chapterId: workspace.chapterId,
		projectId: workspace.projectId,
	};
}

export function assertGitWorkspaceKey(workspace: GitWorkspace, expected: unknown): void {
	if (typeof expected !== "string" || !expected || expected.length > 256)
		throw new ValidationError("workspaceKey is required");
	if (workspace.workspaceKey !== expected)
		throw new AppError(
			"Git workspace changed; refresh before retrying",
			409,
			"GIT_WORKSPACE_CHANGED",
		);
}

export function resolveWorkspaceFromPath(rawPath: string): ResolvedWorkspace {
	return { workspacePath: normalizeWorkspacePath(rawPath), rawPath };
}
