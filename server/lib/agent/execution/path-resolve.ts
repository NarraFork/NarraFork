/**
 * Compatibility helpers for callers that have not yet moved to backend.paths.
 * Path grammar lives on ExecutionBackend; these wrappers intentionally contain
 * no host-OS path logic.
 */
import type { WorkspaceContext } from "@shared/workspace-context";
import type { ExecutionBackend } from "./backend";

export type { PathFlavor, TargetPathSemantics } from "./path-semantics";
export {
	localPathSemantics,
	platformPathFlavor,
	posixPathSemantics,
	specPathSemantics,
	targetPathSemantics,
	windowsPathSemantics,
} from "./path-semantics";

/** Effective base cwd for a routed tool call. */
export function toolBaseCwd(backend: ExecutionBackend, localCwd: string): string {
	return backend.kind === "remote" ? backend.defaultCwd || localCwd : localCwd;
}

/**
 * Bind the session's own directory on this device to a resolved backend.
 *
 * A remote backend reports the *device* default directory, but a session that
 * selected a working directory on that device must run there — otherwise the
 * directory shown in the UI and the one tools use disagree. Binding happens only
 * when the context belongs to this exact device: a per-call `device` override
 * (a local session running one Bash call on a remote machine) must keep the
 * device default, and a POSIX path from a Windows-only context must never
 * become a remote POSIX session's base directory.
 */
export function bindSessionWorkspaceCwd<T extends ExecutionBackend>(
	backend: T,
	context?: WorkspaceContext,
): T {
	const cwd = context?.cwd?.trim();
	if (backend.kind !== "remote" || !context || context.deviceId !== backend.deviceId)
		return backend;
	if (!cwd || !backend.paths.isAbsolute(cwd)) return backend;
	if (backend.defaultCwd && backend.paths.equals(backend.defaultCwd, cwd)) return backend;
	return Object.assign(Object.create(backend) as T, { defaultCwd: cwd });
}

/** Resolve a path using the target backend's lexical grammar. */
export function resolveBackendPath(
	backend: ExecutionBackend,
	base: string,
	inputPath: string,
): string {
	return backend.paths.resolve(base, inputPath);
}

/** Return a directory name using the target backend's lexical grammar. */
export function backendDirname(backend: ExecutionBackend, resolvedPath: string): string {
	return backend.paths.dirname(resolvedPath);
}
