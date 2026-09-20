import type {
	FileChangeExecutionReceipt,
	FileChangeLocalIoEvidence,
} from "@shared/file-change-protocol";
import type {
	FileChangeLocalIo,
	LocalFileApplyInput,
	LocalFileApplyResult,
} from "./file-change-local-io";
import { normalizeLocalIoEvidence } from "./file-change-local-io-evidence";
import type { LocalWriteFootprint } from "./file-change-write-footprint";

export interface LocalFileApplySummary {
	readonly result: LocalFileApplyResult;
	readonly receiptOutcome: FileChangeExecutionReceipt["outcome"];
	readonly confirmed: boolean;
	readonly leaseOutcome: "applied" | "not_applied" | "unknown";
	readonly diagnostics: FileChangeLocalIoEvidence;
}

/** A rejected/invalid adapter promise is NOT proof of no dispatch. Only the
 * controlled stage-aware IO implementation can positively acknowledge it. */
export async function applyLocalFileChange(
	io: FileChangeLocalIo,
	input: LocalFileApplyInput,
	footprint: LocalWriteFootprint,
): Promise<LocalFileApplySummary> {
	let result: LocalFileApplyResult;
	try {
		result = await io.apply(input);
		if (!result?.parentEffects) throw new Error("Missing local IO execution proof");
		const { createdPaths, possiblePaths } = result.parentEffects;
		if (
			!Array.isArray(createdPaths) ||
			!Array.isArray(possiblePaths) ||
			possiblePaths.length > 1 ||
			createdPaths.length + possiblePaths.length > 128 ||
			(result.kind === "parent_only" && createdPaths.length + possiblePaths.length === 0) ||
			(result.kind === "applied" && result.error !== null)
		)
			throw new Error("Invalid local IO execution proof", { cause: result.error });
		normalizeLocalIoEvidence({
			version: 1,
			outcome: result.kind,
			createdParentCount: createdPaths.length,
			uncertainParentCount: possiblePaths.length,
		});
		for (const path of [...createdPaths, ...possiblePaths]) {
			if (
				typeof path !== "string" ||
				!input.backend.paths.isAbsolute(path) ||
				!footprint.ranges.some(
					(range) =>
						range.kind === "subtree" && input.backend.paths.contains(range.canonicalPath, path),
				)
			)
				throw new Error("Local IO parent effect escaped its admitted range");
		}
		if (result.kind !== "applied" && result.error == null)
			result = { ...result, error: new Error("Local file mutation did not complete") };
	} catch (error) {
		result = {
			kind: "target_mutation_unknown",
			error,
			parentEffects: { createdPaths: [], possiblePaths: [] },
		};
	}
	const applied = result.kind === "applied";
	const targetUnchanged = result.kind === "not_applied" || result.kind === "parent_only";
	return {
		result,
		receiptOutcome: applied ? "applied" : targetUnchanged ? "not_applied" : "unknown",
		confirmed: applied || targetUnchanged,
		leaseOutcome:
			result.parentEffects.possiblePaths.length > 0
				? "unknown"
				: applied
					? "applied"
					: targetUnchanged
						? "not_applied"
						: "unknown",
		diagnostics: {
			version: 1,
			outcome: result.kind,
			createdParentCount: result.parentEffects.createdPaths.length,
			uncertainParentCount: result.parentEffects.possiblePaths.length,
		},
	};
}
