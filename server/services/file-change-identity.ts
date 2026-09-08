import { createHash } from "node:crypto";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeExecutionBinding,
	type FileChangeIdentity,
	type FileChangePathFlavor,
} from "@shared/file-change-protocol";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";

/** The durable workspace instance, not the current connection to it. */
export interface FileChangeScopeIdentity {
	id: string;
	sourceInstanceId: string;
	deviceId: string;
	workspaceInstanceId: string;
	pathFlavor: FileChangePathFlavor;
	/** Already resolved by the authorized execution backend. */
	canonicalRoot: string;
}

export interface ResolvedFileChangeTarget {
	deviceId: string;
	pathFlavor: FileChangePathFlavor | "spec";
	lexicalPath: string;
	canonicalPath: string;
	objectRole: FileChangeIdentity["objectRole"];
}

function assertBoundedIdentityValue(value: string, name: string, maxBytes: number): void {
	if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) {
		throw new Error(`Invalid file-change ${name}`);
	}
}

function assertPersistentIdentity(identity: FileChangeIdentity): void {
	for (const key of ["sourceInstanceId", "deviceId", "workspaceInstanceId", "scopeId"] as const) {
		assertBoundedIdentityValue(identity[key], key, 256);
	}
	if (identity.pathFlavor !== "posix" && identity.pathFlavor !== "windows") {
		throw new Error("File-change evidence requires an explicit disk path flavor");
	}
	if (identity.objectRole !== "entry" && identity.objectRole !== "referent") {
		throw new Error("File-change evidence requires an explicit object role");
	}
	const paths = targetPathSemantics(identity.pathFlavor);
	for (const key of ["canonicalPath", "lexicalPath"] as const) {
		assertBoundedIdentityValue(identity[key], key, FILE_CHANGE_LIMITS.metadataBytes);
		if (!paths.isAbsolute(identity[key])) {
			throw new Error(`File-change ${key} must be absolute on its recorded device`);
		}
	}
	assertBoundedIdentityValue(identity.displayPath, "displayPath", FILE_CHANGE_LIMITS.metadataBytes);
	if (Buffer.byteLength(JSON.stringify(identity), "utf8") > FILE_CHANGE_LIMITS.metadataBytes) {
		throw new Error("File-change identity exceeds its metadata budget");
	}
}

/**
 * Build presentation and identity from the SAME canonical root. The caller must
 * supply paths resolved by the approved backend; this pure function neither
 * authorizes a path nor claims to have checked the live filesystem.
 *
 * An out-of-workspace target needs its own scope. It must not be stored under a
 * parent's scope with a ../ path that the parent's Git list can never match.
 */
export function createFileChangeIdentity(
	scope: FileChangeScopeIdentity,
	target: ResolvedFileChangeTarget,
): FileChangeIdentity {
	if (target.deviceId !== scope.deviceId || target.pathFlavor !== scope.pathFlavor) {
		throw new Error("File-change target does not match its device/path scope");
	}
	const paths = targetPathSemantics(scope.pathFlavor);
	if (!paths.isAbsolute(scope.canonicalRoot) || !paths.isAbsolute(target.canonicalPath)) {
		throw new Error("File-change scope and canonical target must be absolute");
	}
	const canonicalPath = paths.normalize(target.canonicalPath);
	const relative = paths.relative(scope.canonicalRoot, canonicalPath);
	const parentPrefix = scope.pathFlavor === "windows" ? "..\\" : "../";
	if (
		!relative ||
		relative === ".." ||
		relative.startsWith(parentPrefix) ||
		paths.isAbsolute(relative)
	) {
		throw new Error("File-change target needs its own file scope");
	}
	const identity: FileChangeIdentity = {
		sourceInstanceId: scope.sourceInstanceId,
		deviceId: scope.deviceId,
		workspaceInstanceId: scope.workspaceInstanceId,
		scopeId: scope.id,
		pathFlavor: scope.pathFlavor,
		objectRole: target.objectRole,
		canonicalPath,
		lexicalPath: paths.normalize(target.lexicalPath),
		// A backslash is data in a POSIX filename, not a path separator.
		displayPath: scope.pathFlavor === "windows" ? relative.replaceAll("\\", "/") : relative,
	};
	assertPersistentIdentity(identity);
	return Object.freeze(identity);
}

/** Stable across reconnects and lexical aliases, distinct across devices/incarnations. */
export function fileChangeIdentityKey(identity: FileChangeIdentity): string {
	assertPersistentIdentity(identity);
	const pathKey = targetPathSemantics(identity.pathFlavor).identityKey(identity.canonicalPath);
	return createHash("sha256")
		.update(
			JSON.stringify([
				identity.sourceInstanceId,
				identity.deviceId,
				identity.workspaceInstanceId,
				identity.pathFlavor,
				identity.objectRole,
				pathKey,
			]),
		)
		.digest("hex");
}

/** null means the parent's workspace is unknown, never a claim that the file is inside it. */
export function isOutsideFileChangeWorkspace(
	identity: FileChangeIdentity,
	parent: Pick<
		FileChangeScopeIdentity,
		"sourceInstanceId" | "deviceId" | "workspaceInstanceId"
	> | null,
): boolean | null {
	if (!parent) return null;
	return (
		identity.sourceInstanceId !== parent.sourceInstanceId ||
		identity.deviceId !== parent.deviceId ||
		identity.workspaceInstanceId !== parent.workspaceInstanceId
	);
}

/** Revalidation must fail on a stale connection or lease, even for the same path. */
export function fileChangeExecutionBindingMatches(
	expected: FileChangeExecutionBinding,
	current: FileChangeExecutionBinding,
): boolean {
	return (
		!!expected.deviceId &&
		!!expected.runtimeEpoch &&
		Number.isSafeInteger(expected.runtimeGeneration) &&
		expected.runtimeGeneration >= 0 &&
		Number.isSafeInteger(expected.fencingToken) &&
		expected.fencingToken >= 0 &&
		expected.deviceId === current.deviceId &&
		expected.runtimeEpoch === current.runtimeEpoch &&
		expected.runtimeGeneration === current.runtimeGeneration &&
		expected.fencingToken === current.fencingToken
	);
}
