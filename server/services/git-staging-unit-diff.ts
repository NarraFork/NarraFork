import {
	type GitStagingUnit,
	type GitStagingUnitDiffMapping,
	GIT_STAGING_LIMITS as LIMITS,
} from "../../shared/git-staging-lists";
import type { TextOwnershipSnapshot } from "./git-changelist-ownership";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_LINES = 100_000;
const MAX_CHANGED_LINES = 20_000;
const MAX_MAPPING_MS = 100;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

interface Projection {
	unitId: string;
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
	removed: number;
	added: number;
	lineRanges: GitStagingUnitDiffMapping["lineRanges"];
}

/** Bounded line offsets, including the final sentinel but no phantom EOF line. */
function lineOffsets(text: string, deadline: number): number[] | null {
	if (text.length > MAX_TEXT_BYTES || Buffer.byteLength(text) > MAX_TEXT_BYTES) return null;
	const offsets = [0];
	for (let at = 0; at < text.length; at++) {
		if ((at & 4095) === 0 && performance.now() >= deadline) return null;
		if (text.charCodeAt(at) === 10 && at + 1 < text.length) offsets.push(at + 1);
		if (offsets.length > MAX_LINES) return null;
	}
	if (text.length) offsets.push(text.length);
	return offsets;
}

function equalRange(
	left: string,
	start: number,
	end: number,
	right: string,
	rightStart: number,
	rightEnd: number,
	deadline: number,
): boolean {
	if (end - start !== rightEnd - rightStart) return false;
	for (let at = start; at < end; at++) {
		if ((at & 4095) === 0 && performance.now() >= deadline) return false;
		if (left.charCodeAt(at) !== right.charCodeAt(rightStart + at - start)) return false;
	}
	return true;
}

/**
 * Match ownership identities to the FINAL patch, without another diff or word diff.
 * Numeric indexes and scans are bounded by the ownership and preview budgets. Any
 * uncertainty disables the affected projection; this is never a write selector.
 */
export function projectGitStagingUnitDiff(input: {
	ownership: TextOwnershipSnapshot;
	listId: string;
	units: readonly GitStagingUnit[];
	selectedText: string;
	diff: string;
}): GitStagingUnitDiffMapping[] {
	const { ownership, listId, units, selectedText, diff } = input;
	if (
		ownership.units.length > LIMITS.maxUnitsPerOperation ||
		units.length > LIMITS.maxUnitsPerOperation ||
		diff.length > LIMITS.maxDiffBytes ||
		Buffer.byteLength(diff) > LIMITS.maxDiffBytes
	)
		return [];
	const deadline = performance.now() + MAX_MAPPING_MS;
	const base = lineOffsets(ownership.baseText, deadline);
	const selected = lineOffsets(selectedText, deadline);
	if (!base || !selected) return [];
	const displayed = new Map(units.filter((unit) => unit.kind === "text").map((u) => [u.id, u]));
	const projections: Projection[] = [];
	// HEAD gaps plus selected insertions define this projection. workStart belongs
	// to the all-group worktree and cannot locate an added row in this preview.
	let baseAt = 0;
	let newAt = 0;
	let previousEnd = 0;
	const ids = new Set<string>();
	for (const unit of ownership.units) {
		if (
			performance.now() >= deadline ||
			ids.has(unit.id) ||
			!Number.isInteger(unit.baseStart) ||
			!Number.isInteger(unit.baseEnd) ||
			unit.baseStart < previousEnd ||
			unit.baseEnd < unit.baseStart ||
			unit.baseEnd >= base.length
		)
			return [];
		ids.add(unit.id);
		previousEnd = unit.baseEnd;
		if (unit.groupId !== listId) continue;
		const gap = unit.baseStart - baseAt;
		if (
			newAt + gap >= selected.length ||
			!equalRange(
				ownership.baseText,
				base[baseAt],
				base[unit.baseStart],
				selectedText,
				selected[newAt],
				selected[newAt + gap],
				deadline,
			)
		)
			return [];
		newAt += gap;
		const newStart = newAt;
		for (const line of unit.insertedLines) {
			if (
				((newAt & 255) === 0 && performance.now() >= deadline) ||
				newAt + 1 >= selected.length ||
				selected[newAt + 1] - selected[newAt] !== line.length ||
				!selectedText.startsWith(line, selected[newAt])
			)
				return [];
			newAt++;
		}
		const dto = displayed.get(unit.id);
		if (
			dto?.listId === listId &&
			dto.baseStart === unit.baseStart &&
			dto.baseEnd === unit.baseEnd &&
			dto.removed === unit.baseEnd - unit.baseStart &&
			dto.added === unit.insertedLines.length
		)
			projections.push({
				unitId: unit.id,
				oldStart: unit.baseStart,
				oldEnd: unit.baseEnd,
				newStart,
				newEnd: newAt,
				removed: 0,
				added: 0,
				lineRanges: [],
			});
		baseAt = unit.baseEnd;
	}
	if (
		newAt + base.length - 1 - baseAt !== selected.length - 1 ||
		!equalRange(
			ownership.baseText,
			base[baseAt],
			ownership.baseText.length,
			selectedText,
			selected[newAt],
			selectedText.length,
			deadline,
		)
	)
		return [];

	const removed = projections.filter((p) => p.oldEnd > p.oldStart);
	const added = projections.filter((p) => p.newEnd > p.newStart);
	let removedAt = 0;
	let addedAt = 0;
	let rowIndex = 0;
	let oldLine = 0;
	let newLine = 0;
	let oldLeft = 0;
	let newLeft = 0;
	let oldEnd = 0;
	let newEnd = 0;
	let inHunk = false;
	let sawFileStart = false;
	let sawAdded = false;
	let changed = 0;
	const patchLines = diff.split("\n");
	for (let at = 0; at < patchLines.length; at++) {
		if ((at & 255) === 0 && performance.now() >= deadline) return [];
		const raw = patchLines[at];
		if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) return [];
		if (raw.startsWith("diff --git")) {
			if (sawFileStart || inHunk) return [];
			sawFileStart = true;
			continue;
		}
		const hunk = HUNK.exec(raw);
		if (raw.startsWith("@@") && !hunk) return [];
		if (hunk) {
			if (oldLeft || newLeft) return [];
			oldLeft = Number(hunk[2] ?? 1);
			newLeft = Number(hunk[4] ?? 1);
			oldLine = Number(hunk[1]) - (oldLeft ? 1 : 0);
			newLine = Number(hunk[3]) - (newLeft ? 1 : 0);
			if (oldLine < oldEnd || newLine < newEnd) return [];
			oldEnd = oldLine + oldLeft;
			newEnd = newLine + newLeft;
			inHunk = true;
			sawAdded = false;
			continue;
		}
		if (!inHunk) continue;
		if (raw === "\\ No newline at end of file") continue;
		if (raw === "" && at === patchLines.length - 1) break;
		// The shared parser skips header-shaped content even inside a hunk. Such
		// patches cannot safely share its row indexes, so keep the unit list only.
		if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw === "---" || raw === "+++")
			return [];
		const prefix = raw[0];
		if (prefix !== "-" && prefix !== "+" && prefix !== " ") return [];
		const noNewline = patchLines[at + 1] === "\\ No newline at end of file";
		const matches = (text: string, offsets: number[], line: number): boolean => {
			if (line < 0 || line + 1 >= offsets.length) return false;
			const end = offsets[line + 1];
			const hasNewline = text.charCodeAt(end - 1) === 10;
			return (
				hasNewline !== noNewline &&
				equalRange(text, offsets[line], end - (hasNewline ? 1 : 0), raw, 1, raw.length, deadline)
			);
		};
		if (prefix !== "+" && !matches(ownership.baseText, base, oldLine)) return [];
		if (prefix !== "-" && !matches(selectedText, selected, newLine)) return [];
		let projection: Projection | undefined;
		if (prefix === "-") {
			// createTwoFilesPatch emits removals before additions, as does the shared
			// parser's buffer flush. Reject other ordering instead of guessing rows.
			if (sawAdded) return [];
			while (removedAt < removed.length && removed[removedAt].oldEnd <= oldLine) removedAt++;
			const candidate = removed[removedAt];
			if (candidate && candidate.oldStart <= oldLine) {
				projection = candidate;
				candidate.removed++;
			}
		} else if (prefix === "+") {
			sawAdded = true;
			while (addedAt < added.length && added[addedAt].newEnd <= newLine) addedAt++;
			const candidate = added[addedAt];
			if (candidate && candidate.newStart <= newLine) {
				projection = candidate;
				candidate.added++;
			}
		} else sawAdded = false;
		if (projection) {
			const last = projection.lineRanges[projection.lineRanges.length - 1];
			if (last?.end === rowIndex) last.end++;
			else projection.lineRanges.push({ start: rowIndex, end: rowIndex + 1 });
		}
		if (prefix !== "+") {
			oldLine++;
			oldLeft--;
		}
		if (prefix !== "-") {
			newLine++;
			newLeft--;
		}
		if (oldLeft < 0 || newLeft < 0) return [];
		if (prefix !== " " && ++changed > MAX_CHANGED_LINES) return [];
		rowIndex++;
	}
	if (oldLeft || newLeft || performance.now() >= deadline) return [];
	return projections
		.filter(
			(p) =>
				p.lineRanges.length > 0 &&
				p.removed === p.oldEnd - p.oldStart &&
				p.added === p.newEnd - p.newStart,
		)
		.map(({ unitId, lineRanges }) => ({ unitId, lineRanges }));
}
