import type { ExecutionBackend } from "@server/lib/agent/execution/backend";
import {
	platformPathFlavor,
	specPathSemantics,
	targetPathSemantics,
} from "@server/lib/agent/execution/path-semantics";
import type { ToolExecutionTarget } from "@server/lib/agent/types";
import type { ExecutionDeviceClass, ExecutionTargetContext, FrozenExecutionTarget } from "./types";

function isSpecExecutionTarget(target: Readonly<ToolExecutionTarget>): boolean {
	return (
		target.pathFlavor === "spec" ||
		target.cwd.startsWith("spec://") ||
		target.canonicalPath?.startsWith("spec://") === true ||
		target.lexicalPath?.startsWith("spec://") === true ||
		target.resolvedFilePath?.startsWith("spec://") === true
	);
}

function backendPathFlavor(backend: ExecutionBackend): "posix" | "windows" {
	return backend.pathFlavor === "windows" || backend.paths?.flavor === "windows"
		? "windows"
		: platformPathFlavor(backend.platform?.os);
}

function backendRuntimeGeneration(backend: ExecutionBackend): number {
	const generation = backend.runtimeGeneration;
	return typeof generation === "number" && Number.isFinite(generation) ? generation : 0;
}

function pathIdentityCandidate(target: Readonly<ToolExecutionTarget>): string | undefined {
	return target.lexicalPath ?? target.resolvedFilePath ?? target.canonicalPath;
}

function assertSamePath(
	label: string,
	expected: string | undefined,
	actual: string,
	context: Pick<ExecutionTargetContext, "paths">,
): void {
	if (expected !== undefined && !context.paths.equals(expected, actual)) {
		throw new Error(
			`Frozen execution target ${label} drifted: expected "${expected}", got "${actual}".`,
		);
	}
}

/**
 * Freeze and validate a routed execution target against its live backend. Re-running this after
 * a reconnect verifies runtime generation, path grammar, and canonical identity before policy
 * evaluation; any drift is rejected instead of silently re-authorizing a different target.
 */
export async function createExecutionTargetContext(input: {
	backend: ExecutionBackend;
	target: ToolExecutionTarget;
	deviceClass?: ExecutionDeviceClass | null;
}): Promise<ExecutionTargetContext> {
	const { backend } = input;
	const sourceTarget = input.target;
	if (backend.deviceId !== sourceTarget.deviceId || backend.kind !== sourceTarget.backendKind) {
		throw new Error(
			`Frozen execution target mismatch: expected ${sourceTarget.backendKind}/${sourceTarget.deviceId}, ` +
				`got ${backend.kind}/${backend.deviceId}.`,
		);
	}

	const paths = isSpecExecutionTarget(sourceTarget)
		? specPathSemantics
		: (backend.paths ?? targetPathSemantics(backendPathFlavor(backend)));
	if (sourceTarget.pathFlavor && sourceTarget.pathFlavor !== paths.flavor) {
		throw new Error(
			`Frozen execution target path flavor drifted: expected ${sourceTarget.pathFlavor}, ` +
				`got ${paths.flavor}.`,
		);
	}
	const runtimeGeneration = backendRuntimeGeneration(backend);
	if (
		sourceTarget.runtimeGeneration !== undefined &&
		sourceTarget.runtimeGeneration !== runtimeGeneration
	) {
		throw new Error(
			`Frozen execution target runtime generation drifted: expected ` +
				`${sourceTarget.runtimeGeneration}, got ${runtimeGeneration}.`,
		);
	}

	const partialContext = { paths };
	let lexicalPath = sourceTarget.lexicalPath;
	let canonicalPath = sourceTarget.canonicalPath;
	const identityCandidate = pathIdentityCandidate(sourceTarget);
	if (identityCandidate) {
		if (paths.flavor === "spec") {
			lexicalPath = paths.normalize(identityCandidate);
			canonicalPath = lexicalPath;
			assertSamePath("lexical path", sourceTarget.lexicalPath, lexicalPath, partialContext);
			assertSamePath("canonical path", sourceTarget.canonicalPath, canonicalPath, partialContext);
			assertSamePath("resolved path", sourceTarget.resolvedFilePath, lexicalPath, partialContext);
		} else {
			if (typeof backend.resolvePathIdentity !== "function") {
				if (!sourceTarget.lexicalPath || !sourceTarget.canonicalPath) {
					throw new Error(
						`Execution backend ${backend.deviceId} cannot freeze canonical path identity.`,
					);
				}
				lexicalPath = paths.normalize(sourceTarget.lexicalPath);
				canonicalPath = paths.normalize(sourceTarget.canonicalPath);
			} else {
				const identity = await backend.resolvePathIdentity(identityCandidate);
				if (identity.runtimeGeneration !== runtimeGeneration) {
					throw new Error(
						`Execution path identity generation drifted: expected ${runtimeGeneration}, ` +
							`got ${identity.runtimeGeneration}.`,
					);
				}
				assertSamePath(
					"lexical path",
					sourceTarget.lexicalPath,
					identity.lexicalPath,
					partialContext,
				);
				assertSamePath(
					"canonical path",
					sourceTarget.canonicalPath,
					identity.canonicalPath,
					partialContext,
				);
				if (!sourceTarget.lexicalPath && sourceTarget.resolvedFilePath) {
					assertSamePath(
						"resolved path",
						sourceTarget.resolvedFilePath,
						identity.lexicalPath,
						partialContext,
					);
				}
				lexicalPath = identity.lexicalPath;
				canonicalPath = identity.canonicalPath;
			}
		}
	}

	const target = Object.freeze({
		deviceId: sourceTarget.deviceId,
		backendKind: sourceTarget.backendKind,
		cwd: paths.normalize(sourceTarget.cwd),
		pathFlavor: paths.flavor,
		...(lexicalPath !== undefined ? { lexicalPath: paths.normalize(lexicalPath) } : {}),
		...(canonicalPath !== undefined ? { canonicalPath: paths.normalize(canonicalPath) } : {}),
		...(sourceTarget.resolvedFilePath !== undefined
			? { resolvedFilePath: sourceTarget.resolvedFilePath }
			: {}),
		runtimeGeneration,
		selectionSource: sourceTarget.selectionSource,
	} satisfies FrozenExecutionTarget);

	return Object.freeze({
		backend,
		target,
		paths,
		deviceClass: input.deviceClass ?? null,
	});
}

export function withExecutionDeviceClass(
	context: ExecutionTargetContext,
	deviceClass: ExecutionDeviceClass | null,
): ExecutionTargetContext {
	if (context.deviceClass === deviceClass) return context;
	return Object.freeze({ ...context, deviceClass });
}

/** Canonical primary identity when available, otherwise the frozen lexical identity. */
export function executionTargetPolicyPath(context: ExecutionTargetContext): string | undefined {
	return (
		context.target.canonicalPath ?? context.target.lexicalPath ?? context.target.resolvedFilePath
	);
}

export function executionTargetContextKey(context: ExecutionTargetContext): string {
	return [
		context.target.deviceId,
		context.target.backendKind,
		context.paths.flavor,
		context.target.runtimeGeneration ?? context.backend.runtimeGeneration ?? 0,
		context.deviceClass ?? "ordinary",
		context.paths.identityKey(context.target.cwd),
		executionTargetPolicyPath(context)
			? context.paths.identityKey(executionTargetPolicyPath(context) as string)
			: "no-primary-path",
	].join(":");
}
