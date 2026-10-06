import { lstat, realpath } from "node:fs/promises";
import { AppError, ValidationError } from "../lib/errors";
import { invalidateBoundaries } from "./git-commit-boundary-cache";
import { gitDiscoveryCache } from "./git-discovery-cache";
import { gitService } from "./git-service";
import { invalidateStatus } from "./git-status-cache";
import { type GitWorkspaceTarget, normalizeWorkspacePath } from "./git-workspace";
import { createRemoteGitService } from "./remote-git-service";
import type { WorkspaceAttributionScope } from "./workspace-modification-view";

export function gitManagementService(target: GitWorkspaceTarget, signal?: AbortSignal) {
	if (!target.backend)
		throw new AppError("Git execution device unavailable", 409, "GIT_WORKSPACE_UNAVAILABLE");
	return target.backend.kind === "remote"
		? createRemoteGitService(target.backend, signal, target.beforeWrite)
		: gitService;
}

export function invalidateGitWorkspace(target: GitWorkspaceTarget): void {
	gitDiscoveryCache.invalidate(
		target.workspace.deviceId,
		target.workspace.rootPath ?? target.workspace.cwd,
		target.repositoryPath,
		target.backend?.paths.equals,
	);
	// Remote reads deliberately have no host-path cache. Local legacy consumers keep sharing theirs.
	if (target.backend?.kind === "local" && target.workspace.rootPath) {
		invalidateStatus(target.workspace.rootPath);
		invalidateBoundaries(target.workspace.rootPath);
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

export function validateFilePaths(files: string[]): void {
	if (files.length > 1000) throw new ValidationError("Too many file paths");
	for (const path of files) {
		if (
			!path ||
			path.length > 4096 ||
			path.split(/[\\/]/).some((part) => part === ".." || part.toLowerCase() === ".git") ||
			/^[\\/]|^[a-z]:/i.test(path) ||
			path.includes("\0")
		)
			throw new ValidationError(`Invalid file path: ${path}`);
	}
}

/** Git acts on symlink entries; never permit traversing a symlink to a directory. */
export async function validateGitFileTargets(
	target: GitWorkspaceTarget,
	files: string[],
): Promise<void> {
	validateFilePaths(files);
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
