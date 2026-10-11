/**
 * Compatibility helpers for callers that have not yet moved to backend.paths.
 * Engineering path grammar lives on ExecutionBackend. Only the explicitly local
 * default directory uses the host resolver; remote paths never enter host path logic.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { settings } from "@server/lib/settings";
import { resolveStandaloneNarratorCwd } from "@server/services/standalone-narrator-cwd";
import type { WorkspaceContext } from "@shared/workspace-context";
import type { ToolContext } from "../types";
import type { ExecutionBackend, FileMetadataOptions, PathIdentity } from "./backend";

export type { PathFlavor, TargetPathSemantics } from "./path-semantics";
export {
	localPathSemantics,
	platformPathFlavor,
	posixPathSemantics,
	specPathSemantics,
	targetPathSemantics,
	windowsPathSemantics,
} from "./path-semantics";

/** Pure local default resolution: selecting an endpoint must never create a directory. */
export function localToolBaseCwd(): string {
	return resolveStandaloneNarratorCwd(
		{},
		{
			home: homedir(),
			configuredDir: settings.paths.defaultProjectDir,
			toAbsolute: resolve,
			ensureDir: () => {},
		},
	) as string;
}

/** Same-device calls retain the selected directory; overrides never borrow another device's cwd. */
export function toolBaseCwd(
	backend: ExecutionBackend,
	cwd: string,
	workspaceContext?: WorkspaceContext,
): string {
	if (workspaceContext?.deviceId === backend.deviceId) {
		if (
			workspaceContext.pathFlavor !== backend.paths.flavor ||
			!backend.paths.isAbsolute(workspaceContext.cwd)
		) {
			throw new Error(
				"Frozen workspace path grammar or absolute directory no longer matches its backend.",
			);
		}
		return workspaceContext.cwd;
	}
	if (backend.kind === "local") return workspaceContext ? localToolBaseCwd() : cwd;
	if (backend.defaultCwd && backend.paths.isAbsolute(backend.defaultCwd)) return backend.defaultCwd;
	throw new Error(
		`Execution device "${backend.deviceId}" has no absolute default working directory; supply an absolute workdir.`,
	);
}

/** Tools consume the admitted endpoint, not a fresh device default or a reapplied workdir. */
export function toolExecutionCwd(
	backend: ExecutionBackend,
	ctx: Pick<ToolContext, "cwd" | "workspaceContext" | "executionTarget">,
): string {
	if (ctx.executionTarget) {
		if (ctx.executionTarget.deviceId !== backend.deviceId) {
			throw new Error("Tool backend does not match its frozen execution target.");
		}
		if (!backend.paths.isAbsolute(ctx.executionTarget.cwd)) {
			throw new Error("Frozen execution target cwd must be fully qualified on its device.");
		}
		return ctx.executionTarget.cwd;
	}
	return toolBaseCwd(backend, ctx.cwd, ctx.workspaceContext);
}

/** Resolve a path using the target backend's lexical grammar. */
export function resolveBackendPath(
	backend: ExecutionBackend,
	base: string,
	inputPath: string,
): string {
	return backend.paths.resolve(base, inputPath);
}

/** Freeze target grammar first, then obtain the executor's original native proof. */
export async function resolveNativeBackendPath(
	backend: ExecutionBackend,
	baseCwd: string,
	inputPath: string,
	options: FileMetadataOptions = {},
): Promise<PathIdentity> {
	// Fail drive ambiguity/device/ADS before dispatch, with no implicit cwd fallback.
	backend.paths.resolve(baseCwd, inputPath);
	return backend.resolvePathIdentity(inputPath, { ...options, baseCwd });
}

/** Return a directory name using the target backend's lexical grammar. */
export function backendDirname(backend: ExecutionBackend, resolvedPath: string): string {
	return backend.paths.dirname(resolvedPath);
}
