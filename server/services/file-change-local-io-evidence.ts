import type { FileChangeLocalIoEvidence } from "@shared/file-change-protocol";

/** Receipt normalizers share this strict, bounded diagnostic schema. It carries
 * counts only: physical paths are frozen separately by the workspace lease. */
export function normalizeLocalIoEvidence(
	value: FileChangeLocalIoEvidence,
): FileChangeLocalIoEvidence {
	if (
		!value ||
		typeof value !== "object" ||
		Object.keys(value).some(
			(key) => !["version", "outcome", "createdParentCount", "uncertainParentCount"].includes(key),
		) ||
		value.version !== 1 ||
		!["not_applied", "parent_only", "target_mutation_unknown", "applied"].includes(value.outcome) ||
		![value.createdParentCount, value.uncertainParentCount].every(
			(count) => Number.isSafeInteger(count) && count >= 0 && count <= 128,
		) ||
		(value.outcome === "not_applied" &&
			(value.createdParentCount !== 0 || value.uncertainParentCount !== 0)) ||
		(value.outcome === "applied" && value.uncertainParentCount !== 0)
	)
		throw new Error("Invalid local IO receipt diagnostics");
	return {
		version: 1,
		outcome: value.outcome,
		createdParentCount: value.createdParentCount,
		uncertainParentCount: value.uncertainParentCount,
	};
}
