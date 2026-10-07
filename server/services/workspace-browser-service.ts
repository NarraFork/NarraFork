import { opendir } from "node:fs/promises";
import type { WorkspaceContext } from "@shared/workspace-context";
import type { DirEntry, ExecutionBackend } from "../lib/agent/execution/backend";
import { AppError } from "../lib/errors";
import type { WorkspaceFileAccess } from "../lib/plan-file-path";
import { createNarratorWorkspaceFileAccess } from "./workspace-file-access";

export const WORKSPACE_BROWSER_LIMITS = Object.freeze({
	maxScanned: 10_000,
	maxEntries: 500,
	maxBytes: 256 * 1024,
	timeoutMs: 2_000,
});
export interface WorkspaceBrowseInput {
	expectedRevision: number;
	contextKey: string;
	path?: string;
	showHidden?: boolean;
	directoriesOnly?: boolean;
}

/** Separate from permission-rule navigation: no blacklist-anchor exception. */
export async function browseWorkspaceDirectory(
	narratorId: string,
	context: WorkspaceContext,
	input: WorkspaceBrowseInput,
	options: { userId?: string; signal?: AbortSignal; access?: WorkspaceFileAccess } = {},
) {
	if (input.expectedRevision !== context.revision || input.contextKey !== context.contextKey)
		throw new AppError("Workspace identity changed", 409, "WORKSPACE_STALE");
	const signal = AbortSignal.any([
		AbortSignal.timeout(WORKSPACE_BROWSER_LIMITS.timeoutMs),
		...(options.signal ? [options.signal] : []),
	]);
	signal.throwIfAborted();
	const access =
		options.access ??
		createNarratorWorkspaceFileAccess(narratorId, context, { userId: options.userId, signal });
	const backend = access.backend;
	if (backend.deviceId !== context.deviceId) throw outside();
	const authorize = async (path: string) => {
		if ((await access.authorizeRead(path, backend, signal)) === false)
			throw new AppError("Workspace read denied", 403, "WORKSPACE_READ_DENIED");
	};
	const lexicalPath = backend.paths.resolve(context.cwd, input.path ?? ".");
	if (!backend.paths.contains(context.cwd, lexicalPath)) throw outside();
	const identity = await backend.resolvePathIdentity(lexicalPath, { signal, timeoutMs: 2_000 });
	if (!identity.exists || !backend.paths.contains(context.cwd, identity.canonicalPath))
		throw outside();
	await authorize(lexicalPath);
	if (!backend.paths.equals(lexicalPath, identity.canonicalPath))
		await authorize(identity.canonicalPath);
	const stat = await backend.statFile(identity.canonicalPath, { signal, timeoutMs: 2_000 });
	if (!stat?.isDirectory)
		throw new AppError("Workspace directory is missing", 404, "WORKSPACE_DIRECTORY_MISSING");
	if (backend.kind !== "local" && (!backend.listBounded || backend.supportsFsListBounded !== true))
		throw new AppError(
			"Executor upgrade required: fs.list.bounded.v1",
			409,
			"WORKSPACE_BROWSE_UPGRADE_REQUIRED",
		);
	const listing =
		backend.kind === "local"
			? await listLocalBounded(backend, identity.canonicalPath, input, signal)
			: await listRemoteBounded(backend, identity.canonicalPath, input, signal);
	const entries: Array<DirEntry & { path: string }> = [];
	let truncated = listing.truncated;
	let reason = listing.reason;
	let outputBytes =
		256 +
		Buffer.byteLength(
			JSON.stringify({
				path: identity.canonicalPath,
				parent: backend.paths.dirname(identity.canonicalPath),
				deviceId: context.deviceId,
				contextKey: context.contextKey,
				revision: context.revision,
			}),
		);
	// Resolve and authorize at most eight children concurrently, never an unbounded
	// Promise.all over a directory. Both lexical denyRead and canonical escapes apply.
	const authorizeEntry = async (entry: DirEntry) => {
		signal.throwIfAborted();
		if (!entry.name || /[/\\\0]/.test(entry.name) || entry.name === "." || entry.name === "..")
			return null;
		if (!input.showHidden && entry.name.startsWith(".")) return null;
		if (input.directoriesOnly && !entry.isDirectory) return null;
		const path = backend.paths.resolve(identity.canonicalPath, entry.name);
		const child = await backend.resolvePathIdentity(path, { signal, timeoutMs: 2_000 });
		if (!child.exists || !backend.paths.contains(context.cwd, child.canonicalPath)) return null;
		try {
			await authorize(path);
			if (!backend.paths.equals(path, child.canonicalPath)) await authorize(child.canonicalPath);
		} catch (error) {
			if (error instanceof AppError && error.statusCode === 403) return null;
			throw error;
		}
		return { name: entry.name, isDirectory: entry.isDirectory, isSymlink: entry.isSymlink, path };
	};
	batchLoop: for (
		let start = 0;
		start < Math.min(listing.entries.length, WORKSPACE_BROWSER_LIMITS.maxEntries);
		start += 8
	) {
		const batch = await Promise.all(
			listing.entries
				.slice(start, Math.min(start + 8, WORKSPACE_BROWSER_LIMITS.maxEntries))
				.map(authorizeEntry),
		);
		for (const item of batch) {
			if (!item) continue;
			const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
			if (outputBytes + bytes > WORKSPACE_BROWSER_LIMITS.maxBytes) {
				truncated = true;
				reason = "byte_limit";
				break batchLoop;
			}
			entries.push(item);
			outputBytes += bytes;
		}
	}
	if (listing.entries.length > WORKSPACE_BROWSER_LIMITS.maxEntries) {
		truncated = true;
		reason = "entry_limit";
	}
	await authorize(lexicalPath);
	if (!backend.paths.equals(lexicalPath, identity.canonicalPath))
		await authorize(identity.canonicalPath);
	const finalIdentity = await backend.resolvePathIdentity(lexicalPath, {
		signal,
		timeoutMs: 2_000,
	});
	if (!backend.paths.equals(finalIdentity.canonicalPath, identity.canonicalPath)) throw outside();
	entries.sort(
		(a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name),
	);
	const parent = backend.paths.dirname(identity.canonicalPath);
	return {
		path: identity.canonicalPath,
		parent:
			backend.paths.contains(context.cwd, parent) &&
			!backend.paths.equals(parent, identity.canonicalPath)
				? parent
				: null,
		entries,
		truncated,
		scanned: listing.scanned,
		reason,
		deviceId: context.deviceId,
		contextKey: context.contextKey,
		revision: context.revision,
	};
}

function outside() {
	return new AppError("Path is outside the workspace", 403, "WORKSPACE_READ_DENIED");
}

async function listRemoteBounded(
	backend: ExecutionBackend,
	path: string,
	input: WorkspaceBrowseInput,
	signal: AbortSignal,
) {
	if (!backend.listBounded || backend.supportsFsListBounded !== true)
		throw new AppError(
			"Executor upgrade required: fs.list.bounded.v1",
			409,
			"WORKSPACE_BROWSE_UPGRADE_REQUIRED",
		);
	return backend.listBounded(path, {
		...WORKSPACE_BROWSER_LIMITS,
		signal,
		expectedResolvedPath: path,
		showHidden: input.showHidden ?? false,
		directoriesOnly: input.directoriesOnly ?? false,
	});
}

async function listLocalBounded(
	backend: ExecutionBackend,
	path: string,
	input: WorkspaceBrowseInput,
	signal: AbortSignal,
) {
	const dir = await opendir(path, { bufferSize: 32 });
	const entries: DirEntry[] = [];
	let scanned = 0,
		bytes = 256,
		truncated = false,
		reason = "";
	try {
		for await (const entry of dir) {
			signal.throwIfAborted();
			if (scanned >= WORKSPACE_BROWSER_LIMITS.maxScanned) {
				truncated = true;
				reason = "scan_limit";
				break;
			}
			scanned++;
			if (!input.showHidden && entry.name.startsWith(".")) continue;
			let isDirectory = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				const stat = await backend.statFile(backend.paths.resolve(path, entry.name), {
					signal,
					timeoutMs: 2_000,
				});
				if (!stat) continue;
				isDirectory = stat.isDirectory;
			}
			if (input.directoriesOnly && !isDirectory) continue;
			const item = { name: entry.name, isDirectory, isSymlink: entry.isSymbolicLink() };
			const size = Buffer.byteLength(JSON.stringify(item)) + 1;
			if (
				entries.length >= WORKSPACE_BROWSER_LIMITS.maxEntries ||
				bytes + size > WORKSPACE_BROWSER_LIMITS.maxBytes
			) {
				truncated = true;
				reason =
					entries.length >= WORKSPACE_BROWSER_LIMITS.maxEntries ? "entry_limit" : "byte_limit";
				break;
			}
			entries.push(item);
			bytes += size;
		}
	} finally {
		await dir.close().catch(() => {});
	}
	return { entries, truncated, scanned, reason };
}
