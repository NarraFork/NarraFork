import type { ExecutionBackend } from "@server/lib/agent/execution/backend";
import { AppError } from "@server/lib/errors";
import {
	INTELLIGENT_UI_DIRECTORY,
	INTELLIGENT_UI_ENTRY,
	type IntelligentUiFileReference,
	INTELLIGENT_UI_FILE_LIMITS as LIMITS,
} from "@shared/intelligent-ui-files";
import type { WorkspaceContext } from "@shared/workspace-context";

export function uiError(message: string, status = 422): AppError {
	return new AppError(message, status, "INTELLIGENT_UI_ERROR");
}
export function workspaceKey(workspace: WorkspaceContext): string {
	return workspace.git?.workspaceKey ?? workspace.contextKey;
}
export async function workspaceRoot(
	backend: ExecutionBackend,
	workspace: WorkspaceContext,
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	if (backend.deviceId !== workspace.deviceId)
		throw uiError("Workspace execution device changed", 409);
	const root = await backend.resolvePathIdentity(workspace.git?.rootPath ?? workspace.cwd, {
		signal,
		timeoutMs: LIMITS.timeoutMs,
	});
	if (!root.exists) throw uiError("Workspace no longer exists", 409);
	return root.canonicalPath;
}
/** Reject aliases at every boundary; descendants may never escape their canonical workspace. */
export async function checkedIdentity(
	backend: ExecutionBackend,
	path: string,
	signal: AbortSignal,
): Promise<string> {
	signal.throwIfAborted();
	const identity = await backend.resolvePathIdentity(path, { signal, timeoutMs: LIMITS.timeoutMs });
	if (!backend.paths.equals(path, identity.canonicalPath))
		throw uiError("UI paths must not traverse symbolic links or junctions", 403);
	return identity.canonicalPath;
}
export async function validateDirectory(
	backend: ExecutionBackend,
	workspace: WorkspaceContext,
	input: string,
	signal: AbortSignal,
): Promise<{ directory: string; entryPath: string }> {
	const root = await workspaceRoot(backend, workspace, signal);
	const base = backend.paths.resolve(root, INTELLIGENT_UI_DIRECTORY);
	const resolved = backend.paths.resolve(workspace.cwd, input);
	const directory =
		backend.paths.basename(resolved) === INTELLIGENT_UI_ENTRY
			? backend.paths.dirname(resolved)
			: resolved;
	if (!backend.paths.equals(backend.paths.dirname(directory), base))
		throw uiError(
			"UI directory must be directly inside the current workspace's .narrafork/intelligent_ui",
			403,
		);
	await checkedIdentity(backend, directory, signal);
	const entryPath = backend.paths.resolve(directory, INTELLIGENT_UI_ENTRY);
	await checkedIdentity(backend, entryPath, signal);
	const [dir, entry] = await Promise.all([
		backend.statFile(directory, { signal, timeoutMs: LIMITS.timeoutMs }),
		backend.statFile(entryPath, { signal, timeoutMs: LIMITS.timeoutMs }),
	]);
	if (!dir?.isDirectory || !entry?.isFile)
		throw uiError("UI directory must contain a regular App.tsx file", 404);
	if (entry.size > LIMITS.fileBytes) throw uiError("App.tsx exceeds the 512 KiB file limit", 413);
	return { directory, entryPath };
}
export function assertReferenceWorkspace(
	reference: IntelligentUiFileReference,
	workspace: WorkspaceContext,
	backend: ExecutionBackend,
): void {
	if (
		reference.deviceId !== workspace.deviceId ||
		reference.workspaceKey !== workspaceKey(workspace) ||
		!backend.paths.equals(reference.cwd, workspace.cwd) ||
		reference.entry !== INTELLIGENT_UI_ENTRY
	)
		throw uiError(
			"UI belongs to a different execution workspace; show it again in this workspace",
			409,
		);
}
export interface SourceFile {
	path: string;
	bytes: Uint8Array;
}
export type AuthorizeFile = (path: string, signal: AbortSignal) => Promise<string>;
const SOURCE_EXTENSION = /\.(?:tsx?|jsx?|json|css|png|jpe?g|gif|webp|svg|avif|ico)$/i;

export async function collectSources(
	backend: ExecutionBackend,
	directory: string,
	authorize: AuthorizeFile,
	signal: AbortSignal,
): Promise<SourceFile[]> {
	const matches = await backend.glob("**/*", {
		cwd: directory,
		dot: true,
		maxResults: LIMITS.files + 1,
		maxBytes: 64 * 1024,
		timeoutMs: LIMITS.timeoutMs,
		signal,
	});
	if (matches.truncated || matches.length > LIMITS.files)
		throw uiError("UI exceeds the 128-file limit", 413);
	const sources: SourceFile[] = [];
	let total = 0;
	for (const name of matches.sort()) {
		signal.throwIfAborted();
		const path = backend.paths.resolve(directory, name);
		if (!backend.paths.contains(directory, path) || backend.paths.equals(directory, path))
			throw uiError("UI file escapes its directory", 403);
		if (!SOURCE_EXTENSION.test(path)) continue;
		await checkedIdentity(backend, path, signal);
		const canonical = await authorize(path, signal);
		if (!backend.paths.equals(canonical, path))
			throw uiError("UI file authorization identity changed", 409);
		const stat = await backend.statFile(path, { signal, timeoutMs: LIMITS.timeoutMs });
		if (!stat?.isFile || stat.size > LIMITS.fileBytes)
			throw uiError("UI files must be regular files no larger than 512 KiB", 413);
		const read = await backend.readFileBytes(path, {
			maxBytes: Math.min(LIMITS.fileBytes, LIMITS.sourceBytes - total),
			expectedResolvedPath: canonical,
			timeoutMs: LIMITS.timeoutMs,
			signal,
		});
		if (read.truncated || !read.resolvedPath || !backend.paths.equals(read.resolvedPath, canonical))
			throw uiError("UI source limit or canonical identity changed", 413);
		total += read.bytes.byteLength;
		if (total > LIMITS.sourceBytes) throw uiError("UI exceeds the 2 MiB source limit", 413);
		sources.push({
			path: backend.paths.relative(directory, path).replaceAll("\\", "/"),
			bytes: read.bytes,
		});
	}
	if (!sources.some((source) => source.path === INTELLIGENT_UI_ENTRY))
		throw uiError("App.tsx is missing", 404);
	return sources;
}
