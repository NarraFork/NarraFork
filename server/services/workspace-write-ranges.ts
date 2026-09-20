import { posix, win32 } from "node:path";
import type { FileChangeScopeIdentity } from "./file-change-identity";

export type WorkspaceWriteRange = Readonly<{
	kind: "file" | "subtree";
	canonicalPath: string;
}>;
export type WorkspaceRangeIdentity = Pick<FileChangeScopeIdentity, "deviceId" | "pathFlavor">;
export const WORKSPACE_RANGE_LIMITS = Object.freeze({
	count: 256,
	pathBytes: 16_384,
	jsonBytes: 128 * 1024,
});

function key(identity: WorkspaceRangeIdentity, path: string): string {
	if (identity.pathFlavor !== "posix" && identity.pathFlavor !== "windows")
		throw new Error("Workspace range requires an explicit path flavor");
	if (
		typeof path !== "string" ||
		!path ||
		path.includes("\0") ||
		Buffer.byteLength(path) > WORKSPACE_RANGE_LIMITS.pathBytes
	)
		throw new Error("Invalid workspace range path");
	const paths = identity.pathFlavor === "windows" ? win32 : posix;
	const normalized = paths.normalize(path);
	if (
		!paths.isAbsolute(normalized) ||
		(identity.pathFlavor === "windows" && !/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/i.test(normalized))
	)
		throw new Error("Workspace range must be fully qualified");
	const root = paths.parse(normalized).root;
	const trimmed =
		normalized.length > root.length
			? normalized.replace(identity.pathFlavor === "windows" ? /\\+$/ : /\/+$/, "")
			: normalized;
	return identity.pathFlavor === "windows" ? trimmed.toLowerCase() : trimmed;
}

function contains(
	identity: WorkspaceRangeIdentity,
	parent: WorkspaceWriteRange,
	child: WorkspaceWriteRange,
): boolean {
	const a = key(identity, parent.canonicalPath);
	const b = key(identity, child.canonicalPath);
	if (parent.kind === "file") return child.kind === "file" && a === b;
	const separator = identity.pathFlavor === "windows" ? "\\" : "/";
	return a === b || b.startsWith(a.endsWith(separator) ? a : a + separator);
}

/** No filesystem access: callers supply paths already resolved by the authorized backend. */
export function freezeWorkspaceRanges(
	scope: Readonly<FileChangeScopeIdentity>,
	input?: readonly WorkspaceWriteRange[],
): readonly WorkspaceWriteRange[] {
	const ranges = input ?? [{ kind: "subtree" as const, canonicalPath: scope.canonicalRoot }];
	if (!Array.isArray(ranges) || ranges.length === 0 || ranges.length > WORKSPACE_RANGE_LIMITS.count)
		throw new Error("Workspace range count exceeds budget");
	const parent = { kind: "subtree" as const, canonicalPath: scope.canonicalRoot };
	const copied = Array.from({ length: ranges.length }, (_, i) => {
		const range = ranges[i];
		if (!range || (range.kind !== "file" && range.kind !== "subtree"))
			throw new Error("Invalid workspace range kind");
		const copy = Object.freeze({ kind: range.kind, canonicalPath: range.canonicalPath });
		if (!contains(scope, parent, copy)) throw new Error("Workspace range escapes its scope");
		return copy;
	});
	if (
		Buffer.byteLength(JSON.stringify({ version: 1, ranges: copied })) >
		WORKSPACE_RANGE_LIMITS.jsonBytes
	)
		throw new Error("Workspace ranges exceed byte budget");
	return Object.freeze(copied);
}

export function workspaceRangesContain(
	identity: WorkspaceRangeIdentity,
	parent: readonly WorkspaceWriteRange[],
	child: readonly WorkspaceWriteRange[],
): boolean {
	return child.every((range) => parent.some((container) => contains(identity, container, range)));
}

export function workspaceRangesIntersect(
	left: WorkspaceRangeIdentity,
	a: readonly WorkspaceWriteRange[],
	right: WorkspaceRangeIdentity,
	b: readonly WorkspaceWriteRange[],
): boolean {
	if (left.deviceId !== right.deviceId || left.pathFlavor !== right.pathFlavor) return false;
	return a.some((x) => b.some((y) => contains(left, x, y) || contains(left, y, x)));
}

/** Malformed/version-incompatible persistent ranges fail closed, never become an empty barrier. */
export function readWorkspaceRanges(
	identity: WorkspaceRangeIdentity,
	value: unknown,
): readonly WorkspaceWriteRange[] {
	if (
		!value ||
		typeof value !== "object" ||
		!("version" in value) ||
		value.version !== 1 ||
		!("ranges" in value)
	)
		throw new Error("Invalid persisted workspace ranges");
	const ranges = value.ranges as readonly WorkspaceWriteRange[];
	if (
		!Array.isArray(ranges) ||
		!ranges.length ||
		ranges.length > WORKSPACE_RANGE_LIMITS.count ||
		Buffer.byteLength(JSON.stringify(value)) > WORKSPACE_RANGE_LIMITS.jsonBytes
	)
		throw new Error("Persisted workspace ranges exceed budget");
	return Object.freeze(
		ranges.map((range) => {
			if (!range || (range.kind !== "file" && range.kind !== "subtree"))
				throw new Error("Invalid persisted workspace range");
			key(identity, range.canonicalPath);
			return Object.freeze({ kind: range.kind, canonicalPath: range.canonicalPath });
		}),
	);
}
