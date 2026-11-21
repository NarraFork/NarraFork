import type { GitStagingUnit, GitStagingUnitDiffMapping } from "@shared/git-staging-lists";
import type { DiffLine } from "@shared/pretext-layout/diff-core";

/** Fail closed: a code-side action must cover one complete, uniquely mapped unit. */
export function completeStagingDiffMappings(
	units: readonly GitStagingUnit[],
	mappings: readonly GitStagingUnitDiffMapping[] | undefined,
	lines: readonly DiffLine[],
	visibleCount: number,
	truncated: boolean,
): GitStagingUnitDiffMapping[] {
	if (truncated || !mappings?.length) return [];
	const byId = new Map(units.map((unit) => [unit.id, unit]));
	const invalid = new Set<string>();
	const unitIds = new Set<string>();
	for (const unit of units) {
		if (unitIds.has(unit.id)) invalid.add(unit.id);
		unitIds.add(unit.id);
	}
	let lineBudget = lines.length;
	const seen = new Set<string>();
	const owners = new Map<number, string>();
	const candidates: GitStagingUnitDiffMapping[] = [];
	for (const mapping of mappings) {
		const unit = byId.get(mapping.unitId);
		if (seen.has(mapping.unitId)) invalid.add(mapping.unitId);
		seen.add(mapping.unitId);
		if (!unit || unit.kind !== "text" || !mapping.lineRanges.length) continue;
		let added = 0;
		let removed = 0;
		let previousEnd = -1;
		let valid = true;
		for (const { start, end } of mapping.lineRanges) {
			if (
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 0 ||
				end <= start ||
				start < previousEnd ||
				end > lines.length
			)
				return [];
			lineBudget -= end - start;
			if (lineBudget < 0) return [];
			previousEnd = end;
			if (end > visibleCount) valid = false;
			for (let index = start; index < end; index++) {
				const owner = owners.get(index);
				if (owner && owner !== unit.id) {
					invalid.add(owner);
					invalid.add(unit.id);
				}
				owners.set(index, unit.id);
				if (lines[index].type === "added") added++;
				else if (lines[index].type === "removed") removed++;
				else valid = false;
			}
		}
		if (!valid || added !== unit.added || removed !== unit.removed || added + removed === 0)
			invalid.add(unit.id);
		candidates.push(mapping);
	}
	return candidates.filter((mapping) => !invalid.has(mapping.unitId));
}
