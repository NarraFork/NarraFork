/**
 * Compatibility helpers for callers that have not yet moved to backend.paths.
 * Path grammar lives on ExecutionBackend; these wrappers intentionally contain
 * no host-OS path logic.
 */
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
