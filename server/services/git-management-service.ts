import { lstat, realpath } from "node:fs/promises";
import type {
	GitStatusPageCacheState,
	GitStatusPageQuery,
	GitStatusPageScopeProof,
	GitStatusPageStatsQuery,
} from "@shared/git-status-page";
import type { GitLineStats } from "../../shared/git-line-stats";
import type { PathFlavor } from "../lib/agent/execution/path-semantics";
import { AppError, ValidationError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { gitDiscoveryCache } from "./git-discovery-cache";
import { getGitLineStats } from "./git-line-stats";
import {
	getGitLineStatsCached,
	invalidateGitLineStats,
	invalidateLocalGitLineStats,
	validateGitLineStatsCache,
} from "./git-line-stats-cache";
import { gitService, withGitRequestContext } from "./git-service";
import { invalidateStatus } from "./git-status-cache";
import {
	assertGitStatusPageScope,
	type GitStatusPageSource,
	getGitStatusPagesCacheState,
	invalidateGitStatusPageStats,
	invalidateGitStatusPages,
	observeGitStatusPages,
	readGitStatusPage,
	readGitStatusPageStats,
	releaseGitStatusPages,
	retainGitStatusPages,
	validateGitStatusPages,
} from "./git-status-page";
import {
	getLocalGitStatusQueryKey,
	invalidateGitStatusQuery,
	invalidateLocalGitStatusQueries,
	validateGitStatusQuery,
} from "./git-status-query";
import { type GitWorkspaceTarget, normalizeWorkspacePath } from "./git-workspace";
import { createRemoteGitService, getRemoteGitStatusQueryKey } from "./remote-git-service";
import type { WorkspaceAttributionScope } from "./workspace-modification-view";

// All existing local writes, file mutations and remote writes publish this bounded identity.
// Subscribe once for the service lifetime; authorization still runs before every page read.
eventBus.on("git:workspace_invalidated", ({ queryKey }) => {
	invalidateGitStatusPages(queryKey);
	invalidateGitStatusPageStats(queryKey);
});

export function gitManagementService(target: GitWorkspaceTarget, signal?: AbortSignal) {
	if (!target.backend)
		throw new AppError("Git execution device unavailable", 409, "GIT_WORKSPACE_UNAVAILABLE");
	if (target.backend.kind !== "remote") return gitService;
	return createRemoteGitService(target.backend, signal, target.beforeWrite);
}

/** Caller must authorize the workspace on every request, before any cache lookup. */
export function getGitWorkspaceStatus(
	target: GitWorkspaceTarget,
	signal?: AbortSignal,
	ttlMs?: number,
) {
	if (!target.backend || !target.workspace.rootPath)
		throw new AppError("Git execution device unavailable", 409, "GIT_WORKSPACE_UNAVAILABLE");
	const path = target.workspace.rootPath;
	const read = () => gitManagementService(target, signal).getStatusSummary(path, { ttlMs });
	return signal ? withGitRequestContext(signal, read) : read();
}

/** Build sources only from a freshly authorized canonical target, never a client cwd. */
function gitStatusPageTarget(target: GitWorkspaceTarget) {
	const { backend, workspace } = target;
	if (!backend || !workspace.rootPath || !workspace.workspaceKey)
		throw new AppError("Git execution device unavailable", 409, "GIT_WORKSPACE_UNAVAILABLE");
	const cwd = workspace.rootPath;
	const queryKey =
		backend.kind === "remote"
			? getRemoteGitStatusQueryKey(backend, cwd)
			: getLocalGitStatusQueryKey(cwd);
	const source: GitStatusPageSource =
		backend.kind === "remote"
			? {
					kind: "remote",
					identity: queryKey,
					async read(readSignal) {
						const result = await createRemoteGitService(backend, readSignal).getRawStatus(cwd);
						const complete =
							backend.supportsGitWorkspaceStatus === true &&
							result.totalFilesExact === true &&
							result.truncated === false &&
							typeof result.outputs?.status === "string";
						return {
							stdout: result.outputs?.status ?? "",
							complete,
							...(!complete
								? {
										limitReason: result.truncated
											? ("remote-truncated" as const)
											: ("remote-incomplete" as const),
									}
								: {}),
						};
					},
				}
			: { kind: "local", cwd };
	return { queryKey, source, workspaceKey: workspace.workspaceKey };
}

/** Every page is authorized independently before any snapshot lookup. */
export function getGitWorkspaceStatusPage(
	target: GitWorkspaceTarget,
	actorId: string,
	query: GitStatusPageQuery,
	signal?: AbortSignal,
) {
	const { queryKey, source, workspaceKey } = gitStatusPageTarget(target);
	return readGitStatusPage({ scope: { actorId, workspaceKey, queryKey }, source, query, signal });
}

/** Statistics share the authorized page identity and its pinned execution transport. */
export function getGitWorkspaceStatusPageStats(
	target: GitWorkspaceTarget,
	actorId: string,
	query: GitStatusPageStatsQuery,
	signal?: AbortSignal,
) {
	const pinnedTarget = { ...target, workspace: { ...target.workspace } };
	const { queryKey, source, workspaceKey } = gitStatusPageTarget(pinnedTarget);
	return readGitStatusPageStats({
		scope: { actorId, workspaceKey, queryKey },
		source,
		query,
		signal,
	});
}

/** Shared producer receives full measurements before the bounded WebSocket projection. */
export function observeGitWorkspaceStatusPages(
	target: GitWorkspaceTarget,
	signal: AbortSignal,
	readStats: (signal: AbortSignal) => Promise<GitLineStats>,
	onPublished?: (cache: GitStatusPageCacheState) => void,
) {
	const { queryKey, source } = gitStatusPageTarget(target);
	return observeGitStatusPages({ queryKey, source, signal, readStats, onPublished });
}
export function getGitWorkspaceStatusPagesCacheState(
	target: GitWorkspaceTarget,
	signal?: AbortSignal,
) {
	const { queryKey, source } = gitStatusPageTarget(target);
	return getGitStatusPagesCacheState({ queryKey, source, signal });
}
export function retainGitWorkspaceStatusPages(target: GitWorkspaceTarget): void {
	if (!target.backend || !target.workspace.rootPath || !target.workspace.workspaceKey) return;
	const { queryKey, source } = gitStatusPageTarget(target);
	retainGitStatusPages(queryKey, source);
}
export function releaseGitWorkspaceStatusPages(target: GitWorkspaceTarget): void {
	if (!target.backend || !target.workspace.rootPath || !target.workspace.workspaceKey) return;
	const { queryKey, source } = gitStatusPageTarget(target);
	releaseGitStatusPages(queryKey, source);
}

/** Watch uncertainty is checked in the paging Worker, independently of summary revalidation. */
export function validateGitWorkspaceStatusPages(target: GitWorkspaceTarget, signal?: AbortSignal) {
	const { queryKey, source } = gitStatusPageTarget(target);
	return validateGitStatusPages({ queryKey, source, signal });
}

/** Called within the existing repository write lock, before a scoped Git mutation. */
export function assertGitWorkspaceStatusPageScope(
	target: GitWorkspaceTarget,
	actorId: string,
	proof: GitStatusPageScopeProof,
	files: string[],
	signal?: AbortSignal,
) {
	const { queryKey, source, workspaceKey } = gitStatusPageTarget(target);
	return assertGitStatusPageScope({
		scope: { actorId, workspaceKey, queryKey },
		source,
		proof,
		files,
		signal,
	});
}

/** Refresh summary/statistics without declaring that the file snapshot changed. */
export function invalidateGitWorkspaceFacts(target: GitWorkspaceTarget): void {
	const { backend, workspace } = target;
	if (!backend || !workspace.rootPath) return;
	if (backend.kind === "remote") {
		const key = getRemoteGitStatusQueryKey(backend, workspace.rootPath);
		invalidateGitStatusQuery(key);
		invalidateGitLineStats(key);
		invalidateGitStatusPageStats(key);
	} else {
		invalidateLocalGitStatusQueries(workspace.rootPath);
		invalidateLocalGitLineStats(workspace.rootPath);
		invalidateGitStatusPageStats(getLocalGitStatusQueryKey(workspace.rootPath));
	}
}

/** Called only after per-request workspace authorization, independently of status. */
export function getGitWorkspaceLineStats(
	target: GitWorkspaceTarget,
	signal?: AbortSignal,
	ttlMs?: number,
) {
	const { backend, workspace } = target;
	if (!backend || !workspace.rootPath)
		throw new AppError("Git execution device unavailable", 409, "GIT_WORKSPACE_UNAVAILABLE");
	const path = workspace.rootPath;
	const key =
		backend.kind === "remote"
			? getRemoteGitStatusQueryKey(backend, path)
			: getLocalGitStatusQueryKey(path);
	return getGitLineStatsCached(
		key,
		(sharedSignal) =>
			backend.kind === "remote"
				? createRemoteGitService(backend, sharedSignal).getLineStats(path)
				: getGitLineStats(path, sharedSignal),
		signal,
		ttlMs,
	);
}

/** An unchanged fingerprint renews existing clean results, never creates statistics. */
export function validateGitWorkspaceCache(target: GitWorkspaceTarget): void {
	const { backend, workspace } = target;
	if (!backend || !workspace.rootPath) return;
	const key =
		backend.kind === "remote"
			? getRemoteGitStatusQueryKey(backend, workspace.rootPath)
			: getLocalGitStatusQueryKey(workspace.rootPath);
	validateGitStatusQuery(key);
	validateGitLineStatsCache(key);
}

export function invalidateGitWorkspace(target: GitWorkspaceTarget): void {
	gitDiscoveryCache.invalidate(
		target.workspace.deviceId,
		target.workspace.rootPath ?? target.workspace.cwd,
		target.repositoryPath,
		target.backend?.paths.equals,
	);
	const { backend, workspace } = target;
	if (!backend || !workspace.rootPath) return;
	if (backend.kind === "remote") {
		// Watch events must queue a fresh read rather than reuse pre-event RPC work.
		const key = getRemoteGitStatusQueryKey(backend, workspace.rootPath);
		invalidateGitStatusQuery(key);
		invalidateGitLineStats(key);
		eventBus.emit({ type: "git:workspace_invalidated", queryKey: key });
	} else {
		invalidateStatus(workspace.rootPath);
	}
}

/** Discover possible legacy cwd scopes from the bounded Git paths, not from narrator ownership. */
export function gitAttributionScopes(target: GitWorkspaceTarget, files: string[]) {
	const { backend, workspace } = target;
	const scopes = new Map<string, WorkspaceAttributionScope>();
	let truncated = false;
	if (!backend || !workspace.rootPath) return { scopes: [], truncated };
	const root = workspace.rootPath;
	const add = (path: string) => {
		if (!backend.paths.contains(root, path)) return;
		const prefix = backend.paths.relative(root, path).replaceAll("\\", "/");
		const key =
			backend.kind === "local" ? normalizeWorkspacePath(path) : backend.paths.identityKey(path);
		if (backend.kind === "local" && !prefix) return;
		if (scopes.has(key)) return;
		if (scopes.size >= 32) {
			truncated = true;
			return;
		}
		scopes.set(key, {
			workspacePath: key,
			prefix,
			...(backend.kind === "remote"
				? {
						absoluteGitRoot: backend.paths.identityKey(root),
						absoluteSeparator: backend.pathFlavor === "windows" ? "\\" : "/",
					}
				: {}),
		});
	};
	add(root);
	add(workspace.cwd);
	for (const file of files.slice(0, 400)) {
		let dir = backend.paths.dirname(backend.paths.resolve(root, file));
		for (let depth = 0; depth < 64 && backend.paths.contains(root, dir); depth++) {
			add(dir);
			if (backend.paths.equals(dir, root)) break;
			dir = backend.paths.dirname(dir);
		}
	}
	return { scopes: [...scopes.values()], truncated };
}

export function validateFilePaths(
	files: string[],
	maxPaths = 1000,
	pathFlavor: PathFlavor = process.platform === "win32" ? "windows" : "posix",
): void {
	if (files.length > maxPaths) throw new ValidationError("Too many file paths");
	for (const path of files) {
		if (
			!path ||
			path.length > 4096 ||
			path.split(/[\\/]/).some((part) => part === ".." || part.toLowerCase() === ".git") ||
			/^[\\/]|^[a-z]:[\\/]/i.test(path) ||
			(pathFlavor === "windows" && path.includes(":")) ||
			path.includes("\0")
		)
			throw new ValidationError(`Invalid file path: ${path}`);
	}
}

/** Git acts on symlink entries; never permit traversing a symlink to a directory. */
export async function validateGitFileTargets(
	target: GitWorkspaceTarget,
	files: string[],
	maxPaths = 1000,
): Promise<void> {
	validateFilePaths(files, maxPaths, target.backend?.pathFlavor);
	if (!target.backend || !target.workspace.rootPath)
		throw new ValidationError("Git workspace unavailable");
	if (target.backend.kind === "remote") return; // Atomic executor guards use the target OS and path policy.
	const paths = target.backend.paths;
	const root = target.workspace.rootPath;
	for (const file of files) {
		const absolute = paths.resolve(root, file);
		if (!paths.contains(root, absolute)) throw new ValidationError("File escapes Git working tree");
		const components = paths.relative(root, absolute).split(/[\\/]/).filter(Boolean);
		let current = root;
		for (let index = 0; index < components.length; index++) {
			current = paths.resolve(current, components[index]);
			const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return null;
				throw error;
			});
			if (!metadata) break;
			if (metadata.isSymbolicLink() && index < components.length - 1)
				throw new ValidationError("Git paths cannot traverse symbolic links");
			if (!metadata.isSymbolicLink() && !paths.contains(root, await realpath(current)))
				throw new ValidationError("File escapes Git working tree");
		}
	}
}
