import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";
import { type PathFlavor, platformPathFlavor } from "../lib/agent/execution/path-semantics";
import { getNarraforkPath } from "../lib/narrafork-home";
import { normalizePathForComparison } from "../lib/platform-path";

type SnapshotPathFlavor = Exclude<PathFlavor, "spec">;
const hostPathFlavor = platformPathFlavor(process.platform);

function isFullyAbsolute(path: string, flavor: SnapshotPathFlavor): boolean {
	if (flavor === "posix") return posix.isAbsolute(path);
	const root = win32.parse(path).root;
	// A rooted Windows path still needs a current drive, unavailable for remote targets.
	return win32.isAbsolute(path) && root !== "\\" && root !== "/";
}

/**
 * Absolute lexical identity, with the local host grammar unless explicitly selected.
 * POSIX backslashes stay literal; Windows keeps the existing slash/case convention.
 * A foreign grammar must be fully absolute so it cannot borrow the host's cwd/drive.
 */
export function snapshotPathIdentity(
	worktreePath: string,
	pathFlavor: SnapshotPathFlavor = hostPathFlavor,
): string {
	if (pathFlavor !== hostPathFlavor && !isFullyAbsolute(worktreePath, pathFlavor))
		throw new Error("A foreign snapshot path must be fully absolute");
	if (pathFlavor === "posix") return posix.resolve(worktreePath);
	const normalized = win32.resolve(worktreePath).replaceAll("\\", "/").toLowerCase();
	// Preserve drive roots, but match the legacy key for UNC roots without a final slash.
	return /^[a-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/+$/, "");
}

function snapshotDevicePathFlavor(
	deviceId: string,
	worktreePath: string,
	pathFlavor?: SnapshotPathFlavor,
): SnapshotPathFlavor {
	if (deviceId === "local") return pathFlavor ?? hostPathFlavor;
	// Remote paths never resolve against the host cwd. Leading '/' is always POSIX,
	// including POSIX names with literal backslashes; ambiguous //UNC needs a flavor.
	const flavor =
		pathFlavor ??
		(worktreePath.startsWith("/")
			? "posix"
			: isFullyAbsolute(worktreePath, "windows")
				? "windows"
				: undefined);
	if (!flavor || !isFullyAbsolute(worktreePath, flavor))
		throw new Error("A remote snapshot path must be fully absolute");
	return flavor;
}

/** Shared physical footprint contract; no snapshot or lifecycle service dependency. */
export function treeSnapshotKey(
	deviceId: string,
	worktreePath: string,
	pathFlavor?: SnapshotPathFlavor,
): string {
	const flavor = snapshotDevicePathFlavor(deviceId, worktreePath, pathFlavor);
	const identity = snapshotPathIdentity(worktreePath, flavor);
	// Remote UNC keys must remain self-describing when their two-part key is read
	// without a flavor: // is POSIX, while \\\\ identifies Windows. Keep local v1 keys.
	const keyPath =
		deviceId !== "local" && flavor === "windows" && identity.startsWith("//")
			? identity.replaceAll("/", "\\")
			: identity;
	return `${deviceId}\u0000${keyPath}`;
}

function physicalDirForKey(key: string): string {
	const digest = createHash("sha256").update(key).digest("hex");
	return getNarraforkPath("tree-snapshots", digest.slice(0, 32));
}

export function treeSnapshotPhysicalDir(
	deviceId: string,
	worktreePath: string,
	pathFlavor?: SnapshotPathFlavor,
): string {
	return physicalDirForKey(treeSnapshotKey(deviceId, worktreePath, pathFlavor));
}

/** Exact v1 key, only for validating old markers or locating read-only historical objects. */
export function legacyTreeSnapshotKey(deviceId: string, worktreePath: string): string {
	return `${deviceId}\u0000${normalizePathForComparison(worktreePath)}`;
}

/** Do not use the legacy footprint as current identity or adopt it for new captures. */
export function legacyTreeSnapshotPhysicalDir(deviceId: string, worktreePath: string): string {
	return physicalDirForKey(legacyTreeSnapshotKey(deviceId, worktreePath));
}
