import { createHash } from "node:crypto";
import { getNarraforkPath } from "../lib/narrafork-home";
import { normalizePathForComparison } from "../lib/platform-path";

/** Shared physical footprint contract; no snapshot or lifecycle service dependency. */
export function treeSnapshotKey(deviceId: string, worktreePath: string): string {
	return `${deviceId}\u0000${normalizePathForComparison(worktreePath)}`;
}

export function treeSnapshotPhysicalDir(deviceId: string, worktreePath: string): string {
	const digest = createHash("sha256").update(treeSnapshotKey(deviceId, worktreePath)).digest("hex");
	return getNarraforkPath("tree-snapshots", digest.slice(0, 32));
}
