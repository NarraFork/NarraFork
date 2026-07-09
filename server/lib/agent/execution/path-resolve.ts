/**
 * Path resolution for file/command tools that may target a remote device.
 *
 * The tools historically resolved every path with `node:path` against the
 * narrator's `ctx.cwd` — both of which describe the *server's* filesystem. When
 * a tool routes to a remote backend that machine may run a different OS with a
 * different path grammar and a different working directory, so resolving on the
 * server is wrong.
 *
 * These helpers keep local behaviour byte-for-byte identical (they delegate to
 * the platform `node:path`) while, for remote backends, resolving against the
 * device's reported default cwd using the device OS's path semantics.
 */
import {
	isAbsolute,
	dirname as nodeDirname,
	posix as nodePosix,
	win32 as nodeWin32,
	resolve,
} from "node:path";
import type { ExecutionBackend } from "./backend";

/**
 * The base directory a tool should resolve relative paths against for a backend.
 * Local: the narrator's cwd (unchanged). Remote: the device's default cwd when
 * known, else the narrator's cwd as a last resort (better than nothing, and the
 * remote executor will surface a clear error if it doesn't exist).
 */
export function toolBaseCwd(backend: ExecutionBackend, localCwd: string): string {
	if (backend.kind === "remote") {
		return backend.defaultCwd || localCwd;
	}
	return localCwd;
}

/** True when the backend targets a Windows device (affects path grammar). */
function isWindowsBackend(backend: ExecutionBackend): boolean {
	return backend.kind === "remote" && backend.platform?.os === "windows";
}

/**
 * Resolve a (possibly relative) tool path for the given backend.
 *
 * Local backend: identical to the previous `isAbsolute(p) ? p : resolve(cwd, p)`
 * using the server platform's `node:path`.
 *
 * Remote backend: use the device OS's path module so absoluteness and joining
 * match the remote grammar (e.g. `C:\...` on Windows, `/...` on POSIX). We never
 * run the server's `node:path` against a remote path, which would mis-handle
 * separators and drive letters.
 */
export function resolveBackendPath(
	backend: ExecutionBackend,
	base: string,
	inputPath: string,
): string {
	if (backend.kind === "local") {
		return isAbsolute(inputPath) ? inputPath : resolve(base, inputPath);
	}
	const p = isWindowsBackend(backend) ? nodeWin32 : nodePosix;
	if (p.isAbsolute(inputPath)) return inputPath;
	// `resolve` would prepend the *server's* cwd for a relative base, so only use
	// it when base is absolute; otherwise fall back to a plain join.
	return p.isAbsolute(base) ? p.resolve(base, inputPath) : p.join(base, inputPath);
}

/**
 * Directory name of an already-resolved backend path, using the backend's path
 * grammar. Local backend delegates to the server platform's `dirname`; remote
 * backends use the device OS's module so Windows/POSIX separators are handled
 * correctly (used for mkdir-p before a remote write).
 */
export function backendDirname(backend: ExecutionBackend, resolvedPath: string): string {
	if (backend.kind === "local") return nodeDirname(resolvedPath);
	const p = isWindowsBackend(backend) ? nodeWin32 : nodePosix;
	return p.dirname(resolvedPath);
}
