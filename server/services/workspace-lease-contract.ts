import { posix, win32 } from "node:path";
import { FILE_CHANGE_LIMITS, type FileChangeExecutionBinding } from "@shared/file-change-protocol";
import type { FileChangeScopeIdentity } from "./file-change-identity";

export const WORKSPACE_WRITE_COORDINATOR_LIMITS = Object.freeze({
	waitTimeoutMs: 2_000,
	maxWaitTimeoutMs: 30_000,
	queueItems: 64,
	queueScopes: 256,
	batchScopes: 32,
	activeLeases: 256,
	activities: 256,
	verificationScopes: 256,
	// Distinct apply + compensation IDs across two phases, NOT a larger file/raw/scope budget.
	mutationsPerLease: 2 * FILE_CHANGE_LIMITS.revertFiles,
	nestedExecutions: 64,
});

export type WorkspaceRuntimeBinding = Readonly<
	Pick<FileChangeExecutionBinding, "runtimeEpoch" | "runtimeGeneration">
>;
export type WorkspaceWriteCoordinatorErrorCode =
	| "invalid_input"
	| "scope_not_found"
	| "scope_identity_mismatch"
	| "scope_inactive"
	| "needs_verification"
	| "verification_backlog"
	| "runtime_mismatch"
	| "stale_lease"
	| "invalid_nesting"
	| "mutation_conflict"
	| "uncoordinated_activity"
	| "rollback_active"
	| "activity_not_found"
	| "queue_full"
	| "capacity_exceeded"
	| "wait_timeout"
	| "aborted"
	| "persistence_failed"
	| "recovery_conflict";

export class WorkspaceWriteCoordinatorError extends Error {
	constructor(
		readonly code: WorkspaceWriteCoordinatorErrorCode,
		message: string,
		cause?: unknown,
		readonly recoveryReason?: "owner_unknown",
	) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "WorkspaceWriteCoordinatorError";
	}
}

export type PhysicalScope = Pick<
	FileChangeScopeIdentity,
	"deviceId" | "pathFlavor" | "canonicalRoot"
>;
const immutablePhysicalKeys = new WeakMap<object, string>();

function pathKey(scope: Pick<PhysicalScope, "pathFlavor" | "canonicalRoot">): string {
	const cached = immutablePhysicalKeys.get(scope);
	if (cached !== undefined) return cached;
	if (scope.pathFlavor !== "posix" && scope.pathFlavor !== "windows") {
		throw fail("invalid_input", "An explicit disk path flavor is required");
	}
	assertString(scope.canonicalRoot, "canonicalRoot", FILE_CHANGE_LIMITS.metadataBytes);
	const paths = scope.pathFlavor === "windows" ? win32 : posix;
	const normalized = paths.normalize(scope.canonicalRoot);
	if (
		!paths.isAbsolute(normalized) ||
		(scope.pathFlavor === "windows" && !/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/i.test(normalized))
	) {
		throw fail("invalid_input", "Scope requires a fully qualified canonical root on its device");
	}
	const root = paths.parse(normalized).root;
	const trimmed =
		normalized.length > root.length
			? normalized.replace(scope.pathFlavor === "windows" ? /\\+$/ : /\/+$/, "")
			: normalized;
	const key = scope.pathFlavor === "windows" ? trimmed.toLowerCase() : trimmed;
	// Only immutable internal descriptors are cached; mutable caller input is copied.
	if (Object.isFrozen(scope)) immutablePhysicalKeys.set(scope, key);
	return key;
}

function containsScope(parent: PhysicalScope, child: PhysicalScope): boolean {
	if (parent.deviceId !== child.deviceId || parent.pathFlavor !== child.pathFlavor) return false;
	const a = pathKey(parent);
	const b = pathKey(child);
	const separator = parent.pathFlavor === "windows" ? "\\" : "/";
	// Keys are absolute, normalized and trailing-separator-free except at roots.
	// Component boundaries preserve both POSIX backslashes and names like ..cache.
	return a === b || b.startsWith(a.endsWith(separator) ? a : a + separator);
}

function overlaps(left: PhysicalScope, right: PhysicalScope): boolean {
	return containsScope(left, right) || containsScope(right, left);
}

/** Legacy scope-only callers are conservative in BOTH directions. Actual files
 * use immutable range intersection above; a scope identity is not a write range. */
export type RecoveryBarrierMode = "write" | "strict";

function barrierBlocks(
	target: PhysicalScope,
	blocker: PhysicalScope,
	_mode: RecoveryBarrierMode,
): boolean {
	return overlaps(target, blocker);
}

function sameScope(
	left: Readonly<FileChangeScopeIdentity>,
	right: Readonly<FileChangeScopeIdentity>,
) {
	return (
		left.id === right.id &&
		left.sourceInstanceId === right.sourceInstanceId &&
		left.deviceId === right.deviceId &&
		left.workspaceInstanceId === right.workspaceInstanceId &&
		left.pathFlavor === right.pathFlavor &&
		pathKey(left) === pathKey(right)
	);
}

function copyScope(scope: Readonly<FileChangeScopeIdentity>): Readonly<FileChangeScopeIdentity> {
	if (!scope || typeof scope !== "object") throw fail("invalid_input", "Invalid scope identity");
	const copied = Object.freeze({
		id: scope.id,
		sourceInstanceId: scope.sourceInstanceId,
		deviceId: scope.deviceId,
		workspaceInstanceId: scope.workspaceInstanceId,
		pathFlavor: scope.pathFlavor,
		canonicalRoot: scope.canonicalRoot,
	});
	for (const key of ["id", "sourceInstanceId", "deviceId", "workspaceInstanceId"] as const) {
		assertString(copied[key], key, 256);
	}
	pathKey(copied);
	return copied;
}

function pendingCount(record: {
	mutations: ReadonlyMap<string, "pending" | "applied" | "not_applied" | "unknown">;
}): number {
	let count = 0;
	for (const outcome of record.mutations.values()) {
		if (outcome === "pending" || outcome === "unknown") count++;
	}
	return count;
}

function sameRuntime(a: WorkspaceRuntimeBinding, b: WorkspaceRuntimeBinding): boolean {
	return a.runtimeEpoch === b.runtimeEpoch && a.runtimeGeneration === b.runtimeGeneration;
}

function assertRuntime(runtime: WorkspaceRuntimeBinding): void {
	if (!runtime) throw fail("invalid_input", "An authoritative runtime binding is required");
	assertString(runtime.runtimeEpoch, "runtimeEpoch", 256);
	assertInteger(runtime.runtimeGeneration, "runtimeGeneration");
}

function assertString(value: string, name: string, maxBytes: number): void {
	if (
		typeof value !== "string" ||
		!value ||
		value.includes("\0") ||
		Buffer.byteLength(value) > maxBytes
	) {
		throw fail("invalid_input", `Invalid ${name}`);
	}
}

function assertInteger(value: number, name: string, max = Number.MAX_SAFE_INTEGER): void {
	if (!Number.isSafeInteger(value) || value < 0 || value > max) {
		throw fail("invalid_input", `Invalid ${name}`);
	}
}

function assertWaitTimeout(value: number): void {
	assertInteger(value, "waitTimeoutMs", WORKSPACE_WRITE_COORDINATOR_LIMITS.maxWaitTimeoutMs);
}

function next(value: number): number {
	assertInteger(value, "revision/fence", Number.MAX_SAFE_INTEGER - 1);
	return value + 1;
}

function scopeStatusError(status: "active" | "needs_verification" | "retired") {
	return status === "needs_verification"
		? fail(
				"needs_verification",
				"Scope needs verification before a destructive operation. Check Settings → Storage → Workspace write barriers for the affected scope, recovery or administrator maintenance; retrying the edit does not clear this barrier.",
			)
		: fail("scope_inactive", "Scope is not active");
}

function fail(code: WorkspaceWriteCoordinatorErrorCode, message: string, cause?: unknown) {
	return new WorkspaceWriteCoordinatorError(code, message, cause);
}

function now(): string {
	return new Date().toISOString();
}

/**
 * The dialect-free contract shared by the SQLite coordinator and PostgreSQL lease store.
 *
 * Everything here is pure identity, range, barrier, validation or counter logic:
 * no SQL fragment, no drizzle object, no driver shape. The pieces that DO carry a
 * dialect (`behavior: "immediate"`, the sync `.get()/.run()/.all()` chaining) stay
 * in workspace-write-coordinator.ts; the PG store uses its own schema. The
 * in-process scheduler itself is NOT ported — see the PG store's header for why
 * its durable sections are the portable unit.
 */
export const workspaceLeaseInternals = {
	pathKey,
	copyScope,
	sameScope,
	sameRuntime,
	barrierBlocks,
	overlaps,
	pendingCount,
	assertRuntime,
	assertString,
	assertInteger,
	assertWaitTimeout,
	next,
	scopeStatusError,
	fail,
	now,
};
