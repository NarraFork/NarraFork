import { diffArrays } from "diff";

/** Text only. The reader must reject non-reversible decoding and Git clean filters first. */
export interface TextOwnershipLimits {
	maxBytes?: number;
	maxLines?: number;
	timeoutMs?: number;
	maxEditLength?: number;
}

export interface TextChangeUnit {
	id: string;
	groupId: string;
	/** All coordinates are zero-based, half-open; deletions have an empty work range. */
	baseStart: number;
	baseEnd: number;
	workStart: number;
	workEnd: number;
	insertedLines: string[];
	deletedLineIds: string[];
	needsReview: boolean;
	sourceGroupIds: string[];
	reviewReason?: "overlappingOwners" | "ambiguousContext" | "headChanged";
	leftAnchor: string | null;
	rightAnchor: string | null;
}

export interface TextSourceLine {
	id: string;
	text: string;
	baseLineId: string | null;
	unitId: string | null;
}

export interface TextOwnershipSnapshot {
	version: 1;
	fileId: string;
	baseText: string;
	workText: string;
	baseLineIds: string[];
	workLines: TextSourceLine[];
	units: TextChangeUnit[];
	/** Legacy v1 metadata, validated on read and omitted from normalized observations. */
	structuralSourceGroupIds?: Record<string, string[]>;
}

export interface TextCommitMapping {
	fileId: string;
	baseText: string;
	workText: string;
	text: string;
	selectedUnitIds: string[];
	/** Stable line identities in the candidate tree, including selected insertions. */
	lineIds: string[];
}

export interface TextHeadConflict {
	baseStart: number;
	baseEnd: number;
	unitIds: string[];
	oldBaseText: string;
	newBaseText: string;
	workText: string;
}

/** Observation assigns rebuilt regions to its target; commit projection preserves proven owners. */
export type TextOwnershipMode = "observe" | "commit";

export type TextRebaseResult =
	| { status: "ok"; snapshot: TextOwnershipSnapshot; conflicts: []; headRebuilt?: true }
	| { status: "headConflict"; snapshot: TextOwnershipSnapshot; conflicts: TextHeadConflict[] };

export class TextOwnershipError extends Error {
	constructor(
		public readonly code:
			| "textTooLarge"
			| "tooManyLines"
			| "diffBudgetExceeded"
			| "invalidSnapshot"
			| "unknownUnit"
			| "needsReview"
			| "invalidCommitMapping",
		message: string,
	) {
		super(message);
		this.name = "TextOwnershipError";
	}
}

interface Budget {
	deadline: number;
	maxBytes: number;
	maxLines: number;
	maxEditLength: number;
	check: () => void;
}

interface Edit {
	oldStart: number;
	oldEnd: number;
	newStart: number;
	newEnd: number;
}

interface WindowedEdit {
	edit: Edit;
	window: { start: number; end: number };
}

interface Region {
	start: number;
	end: number;
	edits: WindowedEdit[];
	touched: Set<number>;
	ambiguousDeletionEdge: boolean;
}

interface Attribution {
	id: string;
	groupId: string;
	needsReview: boolean;
	sourceGroupIds: string[];
	reviewReason?: TextChangeUnit["reviewReason"];
}

const HARD_MAX_BYTES = 2 * 1024 * 1024;
const HARD_MAX_LINES = 100_000;
const HARD_TIMEOUT_MS = 500;

function boundedLimit(value: number | undefined, hardLimit: number): number {
	return value !== undefined && Number.isFinite(value)
		? Math.max(0, Math.min(hardLimit, Math.floor(value)))
		: hardLimit;
}

function budgetFor(limits: TextOwnershipLimits = {}): Budget {
	const deadline = performance.now() + boundedLimit(limits.timeoutMs, HARD_TIMEOUT_MS);
	return {
		deadline,
		maxBytes: boundedLimit(limits.maxBytes, HARD_MAX_BYTES),
		maxLines: boundedLimit(limits.maxLines, HARD_MAX_LINES),
		maxEditLength: boundedLimit(limits.maxEditLength, 20_000),
		check() {
			if (performance.now() >= deadline) {
				throw new TextOwnershipError("diffBudgetExceeded", "Text ownership deadline exceeded");
			}
		},
	};
}

/** The terminator belongs to its line: CRLF, bare CR, and missing EOF stay byte-exact. */
export function splitOwnershipLines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function checkedLines(text: string, budget: Budget): string[] {
	budget.check();
	if (text.length > budget.maxBytes || Buffer.byteLength(text, "utf8") > budget.maxBytes) {
		throw new TextOwnershipError("textTooLarge", "Text exceeds the per-file byte budget");
	}
	const lines = splitOwnershipLines(text);
	if (lines.length > budget.maxLines) {
		throw new TextOwnershipError("tooManyLines", "Text exceeds the per-file line budget");
	}
	budget.check();
	return lines;
}

function validateStructuralSources(
	sources: TextOwnershipSnapshot["structuralSourceGroupIds"],
	budget: Budget,
): void {
	if (sources === undefined) return;
	if (sources === null || typeof sources !== "object" || Array.isArray(sources)) {
		throw new TextOwnershipError("invalidSnapshot", "Structural source candidates must be a map");
	}
	for (const [id, groups] of Object.entries(sources)) {
		budget.check();
		if (!id || !Array.isArray(groups) || !groups.length) {
			throw new TextOwnershipError(
				"invalidSnapshot",
				"Structural units must have nonempty source candidates",
			);
		}
		for (const [index, group] of groups.entries()) {
			if ((index & 255) === 0) budget.check();
			if (typeof group !== "string" || !group.length) {
				throw new TextOwnershipError(
					"invalidSnapshot",
					"Structural source group identities must be nonempty strings",
				);
			}
		}
	}
}

function normalizedUnit(unit: TextChangeUnit): TextChangeUnit {
	if (
		!unit.needsReview &&
		unit.reviewReason === undefined &&
		unit.sourceGroupIds.length === 1 &&
		unit.sourceGroupIds[0] === unit.groupId
	)
		return unit;
	const { reviewReason: _reason, ...rest } = unit;
	return { ...rest, needsReview: false, sourceGroupIds: [unit.groupId] };
}

function validateOwnershipSnapshot(
	snapshot: TextOwnershipSnapshot,
	budget: Budget,
): { base: string[]; work: string[] } {
	validateStructuralSources(snapshot.structuralSourceGroupIds, budget);
	const base = checkedLines(snapshot.baseText, budget);
	const work = checkedLines(snapshot.workText, budget);
	const invalid = () => {
		throw new TextOwnershipError(
			"invalidSnapshot",
			"Text ownership source identities are inconsistent",
		);
	};
	if (snapshot.baseLineIds.length !== base.length || snapshot.workLines.length !== work.length)
		invalid();
	const baseTexts = new Map<string, string>();
	for (const [index, id] of snapshot.baseLineIds.entries()) {
		if ((index & 255) === 0) budget.check();
		if (typeof id !== "string" || !id || (baseTexts.has(id) && baseTexts.get(id) !== base[index]))
			invalid();
		// Old v1 projections may alias a moved copy with a still-uncommitted deletion.
		// Work identity uniqueness and the positional unit walk below prove deletion coverage.
		baseTexts.set(id, base[index]);
	}
	const workIds = new Set<string>();
	let baseAt = 0;
	let workAt = 0;
	const checkLine = (text: string, unitId: string | null, baseLineId: string | null) => {
		if ((workAt & 255) === 0) budget.check();
		const line = snapshot.workLines[workAt];
		if (
			!line ||
			line.text !== text ||
			line.text !== work[workAt] ||
			line.unitId !== unitId ||
			line.baseLineId !== baseLineId ||
			typeof line.id !== "string" ||
			!line.id ||
			workIds.has(line.id) ||
			(baseLineId !== null && line.id !== baseLineId)
		)
			invalid();
		workIds.add(line.id);
		workAt++;
	};
	const unitIds = new Set<string>();
	for (const unit of sortedUnits(snapshot.units)) {
		budget.check();
		if (
			!Number.isInteger(unit.baseStart) ||
			!Number.isInteger(unit.baseEnd) ||
			unit.baseStart < baseAt ||
			unit.baseEnd < unit.baseStart ||
			unit.baseEnd > base.length ||
			typeof unit.id !== "string" ||
			!unit.id ||
			unitIds.has(unit.id)
		)
			invalid();
		unitIds.add(unit.id);
		for (; baseAt < unit.baseStart; baseAt++)
			checkLine(base[baseAt], null, snapshot.baseLineIds[baseAt]);
		if (
			unit.workStart !== workAt ||
			unit.workEnd !== workAt + unit.insertedLines.length ||
			unit.leftAnchor !== (snapshot.baseLineIds[unit.baseStart - 1] ?? null) ||
			unit.rightAnchor !== (snapshot.baseLineIds[unit.baseEnd] ?? null) ||
			unit.deletedLineIds.length !== unit.baseEnd - unit.baseStart
		)
			invalid();
		for (let index = unit.baseStart; index < unit.baseEnd; index++) {
			if ((index & 255) === 0) budget.check();
			if (unit.deletedLineIds[index - unit.baseStart] !== snapshot.baseLineIds[index]) invalid();
		}
		for (const text of unit.insertedLines) checkLine(text, unit.id, null);
		baseAt = unit.baseEnd;
	}
	for (; baseAt < base.length; baseAt++)
		checkLine(base[baseAt], null, snapshot.baseLineIds[baseAt]);
	if (workAt !== work.length) invalid();
	budget.check();
	return { base, work };
}

function normalizeWithBudget(
	snapshot: TextOwnershipSnapshot,
	budget: Budget,
): TextOwnershipSnapshot {
	validateOwnershipSnapshot(snapshot, budget);
	const units = snapshot.units.map((unit, index) => {
		if ((index & 255) === 0) budget.check();
		return normalizedUnit(unit);
	});
	budget.check();
	if (
		snapshot.structuralSourceGroupIds === undefined &&
		units.every((unit, index) => unit === snapshot.units[index])
	)
		return snapshot;
	const { structuralSourceGroupIds: _sources, ...rest } = snapshot;
	return { ...rest, units };
}

/** Upgrade tracking metadata without changing content, owners, or any unit/line identity. */
export function normalizeTextOwnership(
	snapshot: TextOwnershipSnapshot,
	limits?: TextOwnershipLimits,
): TextOwnershipSnapshot {
	return normalizeWithBudget(snapshot, budgetFor(limits));
}

function newIdentity(fileId: string, kind: string): string {
	return `${fileId}:${kind}:${crypto.randomUUID()}`;
}

/** Unique byte-equal lines anchor repeated contexts before bounded Myers diffs fill the gaps. */
function uniqueAnchors(
	before: string[],
	after: string[],
	start: number,
	oldEnd: number,
	newEnd: number,
	budget: Budget,
): [number, number][] {
	const oldPositions = new Map<string, number>();
	const newPositions = new Map<string, number>();
	for (let i = start; i < oldEnd; i++) {
		if ((i & 255) === 0) budget.check();
		const text = before[i];
		oldPositions.set(text, oldPositions.has(text) ? -1 : i);
	}
	for (let i = start; i < newEnd; i++) {
		if ((i & 255) === 0) budget.check();
		const text = after[i];
		newPositions.set(text, newPositions.has(text) ? -1 : i);
	}
	const pairs: [number, number][] = [];
	for (let i = start; i < oldEnd; i++) {
		const text = before[i];
		const next = newPositions.get(text);
		if (oldPositions.get(text) === i && next !== undefined && next >= 0) pairs.push([i, next]);
	}
	// Longest increasing subsequence leaves real moves out of the equality anchors.
	const tails: number[] = [];
	const predecessors = new Int32Array(pairs.length).fill(-1);
	for (let i = 0; i < pairs.length; i++) {
		if ((i & 255) === 0) budget.check();
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (pairs[tails[middle]][1] < pairs[i][1]) low = middle + 1;
			else high = middle;
		}
		if (low > 0) predecessors[i] = tails[low - 1];
		tails[low] = i;
	}
	const result: [number, number][] = [];
	let at = tails.at(-1) ?? -1;
	while (at >= 0) {
		result.push(pairs[at]);
		at = predecessors[at];
	}
	return result.reverse();
}

/** No coarse fallback: a partial diff must never replace complete ownership evidence. */
function exactEdits(before: string[], after: string[], budget: Budget): Edit[] {
	budget.check();
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
		prefix++;
	}
	let oldEnd = before.length;
	let newEnd = after.length;
	while (oldEnd > prefix && newEnd > prefix && before[oldEnd - 1] === after[newEnd - 1]) {
		oldEnd--;
		newEnd--;
	}
	if (oldEnd === prefix && newEnd === prefix) return [];
	const anchors = uniqueAnchors(before, after, prefix, oldEnd, newEnd, budget);
	anchors.push([oldEnd, newEnd]);
	const edits: Edit[] = [];
	let oldAt = prefix;
	let newAt = prefix;
	let remainingEdits = budget.maxEditLength;
	for (const [anchorOld, anchorNew] of anchors) {
		budget.check();
		if (oldAt < anchorOld || newAt < anchorNew) {
			const changes = diffArrays(before.slice(oldAt, anchorOld), after.slice(newAt, anchorNew), {
				maxEditLength: remainingEdits,
				timeout: Math.max(1, Math.floor(budget.deadline - performance.now())),
			});
			budget.check();
			if (!changes) {
				throw new TextOwnershipError(
					"diffBudgetExceeded",
					"Exact line diff exceeded its edit budget",
				);
			}
			let current: Edit | undefined;
			for (const change of changes) {
				if (!change.added && !change.removed) {
					if (current) edits.push(current);
					current = undefined;
					oldAt += change.value.length;
					newAt += change.value.length;
				} else {
					remainingEdits -= change.value.length;
					current ??= { oldStart: oldAt, oldEnd: oldAt, newStart: newAt, newEnd: newAt };
					if (change.removed) oldAt += change.value.length;
					else newAt += change.value.length;
					current.oldEnd = oldAt;
					current.newEnd = newAt;
				}
			}
			if (current) edits.push(current);
		}
		oldAt = anchorOld + 1;
		newAt = anchorNew + 1;
	}
	return edits;
}

function sortedUnits(units: readonly TextChangeUnit[]): TextChangeUnit[] {
	return [...units].sort((a, b) => a.baseStart - b.baseStart || a.workStart - b.workStart);
}

function selectedUnits(
	snapshot: TextOwnershipSnapshot,
	selection: { groupIds?: readonly string[]; unitIds?: readonly string[] } = {},
): TextChangeUnit[] {
	const groups = selection.groupIds ? new Set(selection.groupIds) : undefined;
	const ids = selection.unitIds ? new Set(selection.unitIds) : undefined;
	if (ids) {
		const known = new Set(snapshot.units.map((unit) => unit.id));
		if ([...ids].some((id) => !known.has(id))) {
			throw new TextOwnershipError("unknownUnit", "The selection contains an unknown text unit");
		}
	}
	return sortedUnits(
		snapshot.units.filter(
			(unit) => (!groups || groups.has(unit.groupId)) && (!ids || ids.has(unit.id)),
		),
	);
}

function applyUnits(base: string[], units: readonly TextChangeUnit[]): string[] {
	const result: string[] = [];
	let at = 0;
	for (const unit of units) {
		if (
			!Number.isInteger(unit.baseStart) ||
			!Number.isInteger(unit.baseEnd) ||
			unit.baseStart < at ||
			unit.baseEnd < unit.baseStart ||
			unit.baseEnd > base.length
		) {
			throw new TextOwnershipError("invalidSnapshot", "Text units overlap or have invalid ranges");
		}
		for (; at < unit.baseStart; at++) result.push(base[at]);
		for (const line of unit.insertedLines) result.push(line);
		at = unit.baseEnd;
	}
	for (; at < base.length; at++) result.push(base[at]);
	return result;
}

export function materializeTextOwnership(
	snapshot: TextOwnershipSnapshot,
	selection: { groupIds?: readonly string[]; unitIds?: readonly string[] } = {},
): string {
	return applyUnits(
		splitOwnershipLines(snapshot.baseText),
		selectedUnits(snapshot, selection),
	).join("");
}

function finalize(
	fileId: string,
	baseText: string,
	workText: string,
	baseLineIds: string[],
	units: TextChangeUnit[],
	workIds: (string | undefined)[],
	budget: Budget,
	structuralSourceGroupIds?: TextOwnershipSnapshot["structuralSourceGroupIds"],
): TextOwnershipSnapshot {
	validateStructuralSources(structuralSourceGroupIds, budget);
	const base = checkedLines(baseText, budget);
	const work = checkedLines(workText, budget);
	const ordered = sortedUnits(units).map(normalizedUnit);
	if (baseLineIds.length !== base.length || applyUnits(base, ordered).join("") !== workText) {
		throw new TextOwnershipError(
			"invalidSnapshot",
			"All text units must materialize the observed bytes",
		);
	}
	// A repeated-context re-diff may retain a baseline line at another position.
	// Its identity cannot also be carried into a newly normalized insertion.
	const retainedIds = new Set(workIds.length ? baseLineIds : []);
	if (workIds.length) {
		for (const unit of ordered) {
			for (let i = unit.baseStart; i < unit.baseEnd; i++) {
				if ((i & 255) === 0) budget.check();
				retainedIds.delete(baseLineIds[i]);
			}
		}
	}
	const insertedIds = new Set<string>();
	const workLines: TextSourceLine[] = [];
	let baseAt = 0;
	let workAt = 0;
	for (const unit of ordered) {
		for (; baseAt < unit.baseStart; baseAt++, workAt++) {
			workLines.push({
				id: baseLineIds[baseAt],
				text: base[baseAt],
				baseLineId: baseLineIds[baseAt],
				unitId: null,
			});
		}
		unit.workStart = workAt;
		unit.deletedLineIds = baseLineIds.slice(unit.baseStart, unit.baseEnd);
		unit.leftAnchor = baseLineIds[unit.baseStart - 1] ?? null;
		unit.rightAnchor = baseLineIds[unit.baseEnd] ?? null;
		for (const text of unit.insertedLines) {
			const carriedId = workIds[workAt];
			const id =
				carriedId && !retainedIds.has(carriedId) && !insertedIds.has(carriedId)
					? carriedId
					: newIdentity(fileId, "insert");
			insertedIds.add(id);
			workLines.push({
				id,
				text,
				baseLineId: null,
				unitId: unit.id,
			});
			workAt++;
		}
		unit.workEnd = workAt;
		baseAt = unit.baseEnd;
	}
	for (; baseAt < base.length; baseAt++) {
		workLines.push({
			id: baseLineIds[baseAt],
			text: base[baseAt],
			baseLineId: baseLineIds[baseAt],
			unitId: null,
		});
	}
	if (workLines.length !== work.length || workLines.some((line, i) => line.text !== work[i])) {
		throw new TextOwnershipError(
			"invalidSnapshot",
			"Text source lines do not match observed bytes",
		);
	}
	budget.check();
	return {
		version: 1,
		fileId,
		baseText,
		workText,
		baseLineIds,
		workLines,
		units: ordered,
	};
}

function makeUnit(
	edit: Edit,
	insertedLines: string[],
	attribution: Attribution,
	baseOffset = 0,
): TextChangeUnit {
	return {
		...attribution,
		baseStart: baseOffset + edit.oldStart,
		baseEnd: baseOffset + edit.oldEnd,
		workStart: 0,
		workEnd: 0,
		insertedLines,
		deletedLineIds: [],
		leftAnchor: null,
		rightAnchor: null,
	};
}

export function createTextOwnership(input: {
	fileId: string;
	baseText: string;
	workText: string;
	activeGroupId: string;
	structuralSourceGroupIds?: TextOwnershipSnapshot["structuralSourceGroupIds"];
	limits?: TextOwnershipLimits;
}): TextOwnershipSnapshot {
	const budget = budgetFor(input.limits);
	const base = checkedLines(input.baseText, budget);
	const work = checkedLines(input.workText, budget);
	const units = exactEdits(base, work, budget).map((edit) =>
		makeUnit(edit, work.slice(edit.newStart, edit.newEnd), {
			id: newIdentity(input.fileId, "unit"),
			groupId: input.activeGroupId,
			needsReview: false,
			sourceGroupIds: [input.activeGroupId],
		}),
	);
	return finalize(
		input.fileId,
		input.baseText,
		input.workText,
		base.map((_, i) => `${input.fileId}:base:${i}`),
		units,
		[],
		budget,
		input.structuralSourceGroupIds,
	);
}

function touches(unit: TextChangeUnit, edit: Edit, base: string[], after: string[]): boolean {
	if (unit.workStart === unit.workEnd) {
		const position = unit.workStart;
		if (edit.oldStart < position && position < edit.oldEnd) return true;
		if (edit.oldStart === edit.oldEnd) return position === edit.oldStart;
		// An adjacent edit does not consume a deletion merely because its work range is empty.
		// Restored original edge lines, however, must rejoin the deleted baseline interval.
		return (
			edit.newStart < edit.newEnd &&
			((position === edit.oldStart && after[edit.newStart] === base[unit.baseStart]) ||
				(position === edit.oldEnd && after[edit.newEnd - 1] === base[unit.baseEnd - 1]))
		);
	}
	if (edit.oldStart === edit.oldEnd) {
		return unit.workStart < edit.oldStart && edit.oldStart < unit.workEnd;
	}
	return unit.workStart < edit.oldEnd && edit.oldStart < unit.workEnd;
}

function regionsFor(
	units: TextChangeUnit[],
	edits: Edit[],
	base: string[],
	before: string[],
	after: string[],
	budget: Budget,
): Region[] {
	const regions: Region[] = [];
	const deletionsAt = new Map<number, number[]>();
	for (const [index, unit] of units.entries()) {
		if ((index & 255) === 0) budget.check();
		if (unit.workStart !== unit.workEnd) continue;
		const siblings = deletionsAt.get(unit.workStart) ?? [];
		siblings.push(index);
		deletionsAt.set(unit.workStart, siblings);
	}
	for (const [editIndex, edit] of edits.entries()) {
		budget.check();
		const window = ambiguousWindow(
			before,
			after,
			edit,
			budget,
			edits[editIndex - 1],
			edits[editIndex + 1],
		);
		const region: Region = {
			start: window.start,
			end: window.end,
			edits: [{ edit, window }],
			touched: new Set(),
			ambiguousDeletionEdge: false,
		};
		let low = 0;
		let high = units.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (units[middle].workEnd < window.start) low = middle + 1;
			else high = middle;
		}
		for (let i = low; i < units.length; i++) {
			const unit = units[i];
			if (unit.workStart > window.end) break;
			if ((i & 255) === 0) budget.check();
			const withinAmbiguity =
				(window.start < edit.oldStart || window.end > edit.oldEnd) &&
				unit.workStart < window.end &&
				window.start < unit.workEnd;
			let directTouch = touches(unit, edit, base, after);
			if (unit.workStart === unit.workEnd) {
				const oldLength = edit.oldEnd - edit.oldStart;
				const lastStart = window.end - oldLength;
				// A deleted unit has no work line. Probe its edges and one strict interior
				// position in the original edit window, not the expanded reconstruction region.
				for (const position of [
					unit.workStart,
					unit.workStart - oldLength,
					Math.min(lastStart, unit.workStart - 1),
				]) {
					if (position < window.start || position > lastStart) continue;
					const shift = position - edit.oldStart;
					const candidate = {
						oldStart: position,
						oldEnd: position + oldLength,
						newStart: edit.newStart + shift,
						newEnd: edit.newEnd + shift,
					};
					if (!touches(unit, candidate, base, after)) continue;
					directTouch = true;
					if (
						oldLength > 0 &&
						(unit.workStart === candidate.oldStart || unit.workStart === candidate.oldEnd)
					) {
						// Restoring a deleted edge can also replace its surviving HEAD neighbour.
						region.ambiguousDeletionEdge = true;
					}
				}
			}
			if (withinAmbiguity || directTouch) {
				region.touched.add(i);
				region.start = Math.min(region.start, unit.workStart);
				region.end = Math.max(region.end, unit.workEnd);
			}
		}
		// Co-located deletions occupy adjacent baseline intervals. Reconstructing
		// one must include its siblings or the expanded base range can overlap them.
		const includedDeletions = new Set<number>();
		for (const index of region.touched) {
			const unit = units[index];
			if (unit.workStart !== unit.workEnd || includedDeletions.has(unit.workStart)) continue;
			includedDeletions.add(unit.workStart);
			for (const sibling of deletionsAt.get(unit.workStart) ?? []) {
				if ((sibling & 255) === 0) budget.check();
				region.touched.add(sibling);
			}
		}
		while (regions.length) {
			const last = regions[regions.length - 1];
			const sharesAmbiguousEdge =
				last.start === last.end &&
				region.edits.some(
					({ edit, window }) =>
						(window.start < edit.oldStart || window.end > edit.oldEnd) &&
						window.start <= last.start &&
						last.start <= window.end,
				);
			if (
				region.start >= last.end &&
				!sharesAmbiguousEdge &&
				![...region.touched].some((index) => last.touched.has(index))
			)
				break;
			regions.pop();
			region.end = Math.max(last.end, region.end);
			region.start = Math.min(last.start, region.start);
			region.edits.unshift(...last.edits);
			region.ambiguousDeletionEdge ||= last.ambiguousDeletionEdge;
			for (const index of last.touched) region.touched.add(index);
		}
		regions.push(region);
	}
	return regions;
}

function mapPosition(position: number, edits: Edit[], edge: "start" | "end"): number {
	let low = 0;
	let high = edits.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (edits[middle].oldEnd < position) low = middle + 1;
		else high = middle;
	}
	const edit = edits[low];
	if (edit && position >= edit.oldStart) {
		if (position === edit.oldStart && edge === "start") return edit.newStart;
		if (position === edit.oldEnd) return edit.newEnd;
		return edge === "start" ? edit.newStart : edit.newEnd;
	}
	const preceding = edits[low - 1];
	return position + (preceding ? preceding.newEnd - preceding.oldEnd : 0);
}

function baselinePosition(
	snapshot: TextOwnershipSnapshot,
	position: number,
	edge: "start" | "end",
): number {
	let low = 0;
	let high = snapshot.units.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (snapshot.units[middle].workEnd < position) low = middle + 1;
		else high = middle;
	}
	for (let i = low; i < snapshot.units.length; i++) {
		const unit = snapshot.units[i];
		if (position < unit.workStart) return position + unit.baseStart - unit.workStart;
		if (unit.workStart === unit.workEnd && position === unit.workStart) {
			if (edge === "end") return unit.baseStart;
		} else if (position === unit.workStart) return unit.baseStart;
		else if (position < unit.workEnd) {
			throw new TextOwnershipError(
				"invalidSnapshot",
				"An edit cut through an unexpanded source unit",
			);
		} else if (position === unit.workEnd && edge === "end") return unit.baseEnd;
	}
	return position + snapshot.baseLineIds.length - snapshot.workLines.length;
}

function uniqueFragment(text: string, fragment: string, budget: Budget): boolean {
	if (!fragment) return false;
	let count = 0;
	let at = text.indexOf(fragment);
	while (at >= 0) {
		budget.check();
		const lineStart = at === 0 || text[at - 1] === "\n";
		const lineEnd = fragment.endsWith("\n") || at + fragment.length === text.length;
		if (lineStart && lineEnd && ++count > 1) return false;
		at = text.indexOf(fragment, at + 1);
	}
	return count === 1;
}

/** Slide an edit only while the retained prefix/suffix still produces the exact same text. */
function ambiguousWindow(
	before: string[],
	after: string[],
	edit: Edit,
	budget: Budget,
	previous?: Edit,
	next?: Edit,
): { start: number; end: number } {
	let left = 0;
	while (
		edit.oldStart - left > (previous?.oldEnd ?? 0) &&
		edit.newStart - left > (previous?.newEnd ?? 0) &&
		before[edit.oldEnd - left - 1] === after[edit.newEnd - left - 1]
	) {
		left++;
		if ((left & 255) === 0) budget.check();
	}
	let right = 0;
	while (
		edit.oldEnd + right < (next?.oldStart ?? before.length) &&
		edit.newEnd + right < (next?.newStart ?? after.length) &&
		before[edit.oldStart + right] === after[edit.newStart + right]
	) {
		right++;
		if ((right & 255) === 0) budget.check();
	}
	const exactWindow = { start: edit.oldStart - left, end: edit.oldEnd + right };
	if (!previous && !next) return exactWindow;
	// Several edits may exchange which duplicate survives. Their joint ambiguity
	// cannot be proved away by sliding each individual edit with its peers fixed.
	let start = edit.oldStart;
	let end = edit.oldEnd;
	for (const pattern of [
		before.slice(edit.oldStart, edit.oldEnd),
		after.slice(edit.newStart, edit.newEnd),
	]) {
		if (!pattern.length) continue;
		let low = edit.oldStart;
		let high = edit.oldEnd;
		while (
			low > 0 &&
			before[low - 1] === pattern[pattern.length - 1 - ((edit.oldStart - low) % pattern.length)]
		) {
			low--;
			if ((low & 255) === 0) budget.check();
		}
		while (
			high < before.length &&
			before[high] === pattern[(high - edit.oldEnd) % pattern.length]
		) {
			high++;
			if ((high & 255) === 0) budget.check();
		}
		start = Math.min(start, low);
		end = Math.max(end, high);
	}
	return [previous, next].some((peer) => peer && peer.oldStart <= end && start <= peer.oldEnd)
		? { start, end }
		: exactWindow;
}

function carriedWorkIds(
	snapshot: TextOwnershipSnapshot,
	work: string[],
	edits: Edit[],
): (string | undefined)[] {
	const ids: (string | undefined)[] = new Array(work.length);
	let oldAt = 0;
	let newAt = 0;
	for (const edit of edits) {
		while (oldAt < edit.oldStart) ids[newAt++] = snapshot.workLines[oldAt++].id;
		oldAt = edit.oldEnd;
		newAt = edit.newEnd;
	}
	while (oldAt < snapshot.workLines.length) ids[newAt++] = snapshot.workLines[oldAt++].id;
	return ids;
}

export function updateTextOwnership(
	previous: TextOwnershipSnapshot,
	input: {
		workText: string;
		activeGroupId: string;
		mode?: TextOwnershipMode;
		limits?: TextOwnershipLimits;
	},
): TextOwnershipSnapshot {
	return updateWithBudget(
		previous,
		input.workText,
		input.activeGroupId,
		budgetFor(input.limits),
		input.mode ?? "observe",
	);
}

function updateWithBudget(
	previous: TextOwnershipSnapshot,
	workText: string,
	activeGroupId: string,
	budget: Budget,
	mode: TextOwnershipMode,
): TextOwnershipSnapshot {
	previous = normalizeWithBudget(previous, budget);
	const base = checkedLines(previous.baseText, budget);
	const before = checkedLines(previous.workText, budget);
	const after = checkedLines(workText, budget);
	if (previous.workText === workText) {
		if (materializeTextOwnership(previous) !== workText) {
			throw new TextOwnershipError("invalidSnapshot", "Previous text ownership is inconsistent");
		}
		return previous;
	}
	previous = projectEditedSourceAliases(previous, budget);
	if (workText === previous.baseText) {
		return finalize(
			previous.fileId,
			previous.baseText,
			workText,
			[...previous.baseLineIds],
			[],
			[],
			budget,
			previous.structuralSourceGroupIds,
		);
	}
	const edits = exactEdits(before, after, budget);
	const regions = regionsFor(previous.units, edits, base, before, after, budget);
	const affected = new Set(regions.flatMap((region) => [...region.touched]));
	const units = previous.units
		.filter((_, i) => !affected.has(i))
		.map((unit) => ({
			...unit,
			workStart: mapPosition(unit.workStart, edits, "end"),
			workEnd: mapPosition(unit.workEnd, edits, "start"),
		}));
	const ids = carriedWorkIds(previous, after, edits);
	const byId = new Map(previous.units.map((unit) => [unit.id, unit]));
	const removedWindows: { start: number; end: number }[] = [];
	for (const { edit, window } of regions.flatMap((region) => region.edits)) {
		if (edit.oldStart === edit.oldEnd) continue;
		const last = removedWindows.at(-1);
		if (last && window.start <= last.end) last.end = Math.max(last.end, window.end);
		else removedWindows.push({ ...window });
	}
	const lineStarts = new Map<number, number>();
	if (removedWindows.length) {
		let offset = 0;
		for (const [index, line] of before.entries()) {
			if ((index & 255) === 0) budget.check();
			lineStarts.set(offset, index);
			offset += line.length;
		}
	}
	const movedFragments = new Map<string, number[]>();
	const deletionPositions = new Set(
		previous.units.filter((unit) => unit.workStart === unit.workEnd).map((unit) => unit.workStart),
	);
	for (const region of regions) {
		budget.check();
		const sources = new Map(
			[...region.touched].map((index) => [previous.units[index].id, previous.units[index]]),
		);
		const candidateGroups = new Set<string>();
		if (region.ambiguousDeletionEdge) candidateGroups.add(activeGroupId);
		for (const { edit, window } of region.edits) {
			budget.check();
			const insertion = edit.oldStart === edit.oldEnd;
			let uniqueMove = false;
			if (insertion && edit.newStart < edit.newEnd) {
				const fragment = after.slice(edit.newStart, edit.newEnd).join("");
				const lineCount = edit.newEnd - edit.newStart;
				let candidates = movedFragments.get(fragment);
				if (!candidates) {
					candidates = [];
					let rangeIndex = 0;
					let at = previous.workText.indexOf(fragment);
					while (at >= 0 && rangeIndex < removedWindows.length) {
						budget.check();
						const position = lineStarts.get(at);
						if (position !== undefined) {
							while (removedWindows[rangeIndex]?.end <= position) rangeIndex++;
							const removed = removedWindows[rangeIndex];
							if (
								removed &&
								removed.start <= position &&
								position + lineCount <= removed.end &&
								(fragment.endsWith("\n") || at + fragment.length === previous.workText.length)
							) {
								candidates.push(position);
							}
						}
						at = previous.workText.indexOf(fragment, at + 1);
					}
					movedFragments.set(fragment, candidates);
				}
				uniqueMove =
					candidates.length === 1 &&
					uniqueFragment(previous.workText, fragment, budget) &&
					uniqueFragment(workText, fragment, budget);
				for (const position of candidates) {
					for (let offset = 0; offset < lineCount; offset++) {
						if ((offset & 255) === 0) budget.check();
						const line = previous.workLines[position + offset];
						const source = byId.get(line.unitId ?? "");
						if (source) sources.set(source.id, source);
						else candidateGroups.add(activeGroupId);
						if (uniqueMove) ids[edit.newStart + offset] = line.id;
					}
				}
			}
			if (insertion && !uniqueMove) {
				for (let position = window.start; position <= window.end; position++) {
					if ((position & 255) === 0) budget.check();
					const left = previous.workLines[position - 1]?.unitId;
					const right = previous.workLines[position]?.unitId;
					// Only strict interior insertions inherit. A feasible unit boundary or
					// HEAD position can instead be an independent new active-group block.
					if ((!left || left !== right) && !deletionPositions.has(position)) {
						candidateGroups.add(activeGroupId);
					}
				}
			} else if (!insertion) {
				// Replacing consumed HEAD lines is a new active-group edit too, even
				// when the indivisible replacement also consumes an existing unit.
				for (let i = window.start; i < window.end; i++) {
					if ((i & 255) === 0) budget.check();
					if (previous.workLines[i].unitId === null) candidateGroups.add(activeGroupId);
				}
			}
		}
		const uniqueSources = [...sources.values()];
		const owners = [...new Set(uniqueSources.map((source) => source.groupId))];
		for (const owner of owners) candidateGroups.add(owner);
		const groupId =
			mode === "commit" && candidateGroups.size === 1
				? (owners[0] ?? activeGroupId)
				: activeGroupId;
		const attribution: Attribution = {
			id:
				region.touched.size === 1
					? previous.units[[...region.touched][0]].id
					: newIdentity(previous.fileId, "unit"),
			groupId,
			needsReview: false,
			sourceGroupIds: [groupId],
		};
		let baseStart = baselinePosition(previous, region.start, "start");
		let baseEnd = baselinePosition(previous, region.end, "end");
		for (const index of region.touched) {
			baseStart = Math.min(baseStart, previous.units[index].baseStart);
			baseEnd = Math.max(baseEnd, previous.units[index].baseEnd);
		}
		const firstEdit = region.edits[0].edit;
		const lastEdit = region.edits[region.edits.length - 1].edit;
		// Expanded old units must not consume an independent insertion at their edge.
		const newStart =
			region.start === firstEdit.oldStart
				? firstEdit.newStart
				: mapPosition(region.start, edits, "end");
		const newEnd =
			region.end === lastEdit.oldEnd ? lastEdit.newEnd : mapPosition(region.end, edits, "start");
		const replacement = after.slice(newStart, newEnd);
		const normalized = exactEdits(base.slice(baseStart, baseEnd), replacement, budget);
		for (let i = 0; i < normalized.length; i++) {
			const edit = normalized[i];
			const unit = makeUnit(
				edit,
				replacement.slice(edit.newStart, edit.newEnd),
				{
					...attribution,
					id: i === 0 ? attribution.id : newIdentity(previous.fileId, "unit"),
				},
				baseStart,
			);
			unit.workStart = newStart + edit.newStart;
			unit.workEnd = newStart + edit.newEnd;
			units.push(unit);
		}
	}
	return finalize(
		previous.fileId,
		previous.baseText,
		workText,
		[...previous.baseLineIds],
		units,
		ids,
		budget,
		previous.structuralSourceGroupIds,
	);
}

export function moveTextUnits(
	snapshot: TextOwnershipSnapshot,
	input: { unitIds: readonly string[]; targetGroupId: string },
): TextOwnershipSnapshot {
	const ids = new Set(input.unitIds);
	const selected = selectedUnits(snapshot, { unitIds: input.unitIds });
	if (selected.every((unit) => unit.groupId === input.targetGroupId)) {
		if (materializeTextOwnership(snapshot) !== snapshot.workText) {
			throw new TextOwnershipError("invalidSnapshot", "Text ownership is inconsistent");
		}
		return snapshot;
	}
	const units = snapshot.units.map((unit) => {
		if (!ids.has(unit.id)) return unit;
		const { reviewReason: _reason, ...rest } = unit;
		return {
			...rest,
			groupId: input.targetGroupId,
			needsReview: false,
			sourceGroupIds: [input.targetGroupId],
		};
	});
	const result = { ...snapshot, units };
	if (materializeTextOwnership(result) !== snapshot.workText) {
		throw new TextOwnershipError(
			"invalidSnapshot",
			"Moving text ownership changed the observed bytes",
		);
	}
	return result;
}

function candidateLineIds(
	snapshot: TextOwnershipSnapshot,
	units: readonly TextChangeUnit[],
	budget: Budget,
): string[] {
	const lineIds: string[] = [];
	let at = 0;
	for (const unit of units) {
		budget.check();
		for (; at < unit.baseStart; at++) {
			if ((at & 255) === 0) budget.check();
			lineIds.push(snapshot.baseLineIds[at]);
		}
		for (let index = unit.workStart; index < unit.workEnd; index++) {
			if ((index & 255) === 0) budget.check();
			lineIds.push(snapshot.workLines[index].id);
		}
		at = unit.baseEnd;
	}
	for (; at < snapshot.baseLineIds.length; at++) {
		if ((at & 255) === 0) budget.check();
		lineIds.push(snapshot.baseLineIds[at]);
	}
	budget.check();
	return lineIds;
}

export function prepareTextCommit(
	snapshot: TextOwnershipSnapshot,
	input: { groupIds: readonly string[] },
): { text: string; mapping: TextCommitMapping } {
	const budget = budgetFor();
	snapshot = normalizeWithBudget(snapshot, budget);
	const selected = selectedUnits(snapshot, input);
	const text = materializeTextOwnership(snapshot, input);
	const lineIds = candidateLineIds(snapshot, selected, budget);
	return {
		text,
		mapping: {
			fileId: snapshot.fileId,
			baseText: snapshot.baseText,
			workText: snapshot.workText,
			text,
			selectedUnitIds: selected.map((unit) => unit.id),
			lineIds,
		},
	};
}

function rangesIntersect(unit: TextChangeUnit, edit: Edit): boolean {
	if (unit.baseStart === unit.baseEnd && edit.oldStart === edit.oldEnd)
		return unit.baseStart === edit.oldStart;
	if (unit.baseStart === unit.baseEnd)
		return edit.oldStart < unit.baseStart && unit.baseStart < edit.oldEnd;
	if (edit.oldStart === edit.oldEnd) {
		const lastInserted = unit.insertedLines.at(-1);
		return (
			unit.baseStart < edit.oldStart &&
			(edit.oldStart < unit.baseEnd ||
				(edit.oldStart === unit.baseEnd &&
					lastInserted !== undefined &&
					!lastInserted.endsWith("\n")))
		);
	}
	return unit.baseStart < edit.oldEnd && edit.oldStart < unit.baseEnd;
}

/** Re-diff only the conflicted file and assign every remaining unit to its fallback group. */
function rebuildHeadWithBudget(
	previous: TextOwnershipSnapshot,
	baseText: string,
	workText: string,
	groupId: string,
	budget: Budget,
): TextOwnershipSnapshot {
	const base = checkedLines(baseText, budget);
	const work = checkedLines(workText, budget);
	const units = exactEdits(base, work, budget).map((edit) =>
		makeUnit(edit, work.slice(edit.newStart, edit.newEnd), {
			id: newIdentity(previous.fileId, "unit"),
			groupId,
			needsReview: false,
			sourceGroupIds: [groupId],
		}),
	);
	return finalize(
		previous.fileId,
		baseText,
		workText,
		base.map(() => newIdentity(previous.fileId, "base")),
		units,
		[],
		budget,
		previous.structuralSourceGroupIds,
	);
}

function projectedBaseIds(
	fileId: string,
	ids: string[],
	budget: Budget,
	units: readonly TextChangeUnit[],
): string[] {
	budget.check();
	const originalIds = new Set(ids);
	if (originalIds.size === ids.length) return ids;
	const preferred = new Map<string, number>();
	let at = 0;
	const retain = (index: number) => {
		if ((index & 255) === 0) budget.check();
		if (!preferred.has(ids[index])) preferred.set(ids[index], index);
	};
	for (const unit of sortedUnits(units)) {
		budget.check();
		for (; at < unit.baseStart; at++) retain(at);
		at = unit.baseEnd;
	}
	for (; at < ids.length; at++) retain(at);
	const seen = new Set<string>();
	return ids.map((sourceId, index) => {
		if ((index & 255) === 0) budget.check();
		let id = sourceId;
		// Keep the already-visible occurrence; hidden aliases receive fresh identities.
		if (seen.has(id) || (preferred.has(id) && preferred.get(id) !== index)) {
			do {
				budget.check();
				id = newIdentity(fileId, "base");
			} while (seen.has(id) || originalIds.has(id));
		}
		seen.add(id);
		return id;
	});
}

function projectEditedSourceAliases(
	previous: TextOwnershipSnapshot,
	budget: Budget,
): TextOwnershipSnapshot {
	const baseLineIds = projectedBaseIds(
		previous.fileId,
		previous.baseLineIds,
		budget,
		previous.units,
	);
	if (baseLineIds === previous.baseLineIds) return previous;
	return finalize(
		previous.fileId,
		previous.baseText,
		previous.workText,
		baseLineIds,
		previous.units.map((unit) => ({ ...unit })),
		previous.workLines.map((line) => line.id),
		budget,
	);
}

export function rebaseTextOwnership(
	previous: TextOwnershipSnapshot,
	input: {
		baseText: string;
		workText: string;
		activeGroupId: string;
		/** External HEAD fallback and newly rebuilt differences use this target group. */
		headConflictGroupId?: string;
		/** Commit/recovery projection never enables the external HEAD fallback. */
		mode?: TextOwnershipMode;
		commitMapping?: TextCommitMapping;
		limits?: TextOwnershipLimits;
	},
): TextRebaseResult {
	const budget = budgetFor(input.limits);
	const { base } = validateOwnershipSnapshot(previous, budget);
	const nextBase = checkedLines(input.baseText, budget);
	checkedLines(input.workText, budget);
	const mapping = input.commitMapping;
	const mode = mapping ? "commit" : (input.mode ?? "observe");
	const absorbed = new Set<string>();
	let baseLineIds: string[];
	let edits: Edit[];
	if (mapping) {
		if (
			mapping.fileId !== previous.fileId ||
			mapping.baseText !== previous.baseText ||
			mapping.workText !== previous.workText ||
			mapping.text !== input.baseText
		) {
			throw new TextOwnershipError(
				"invalidCommitMapping",
				"Commit provenance does not match this baseline and observation",
			);
		}
		const selected = selectedUnits(previous, { unitIds: mapping.selectedUnitIds });
		const expectedLineIds = candidateLineIds(previous, selected, budget);
		if (
			materializeTextOwnership(previous, { unitIds: mapping.selectedUnitIds }) !== input.baseText ||
			!Array.isArray(mapping.lineIds) ||
			mapping.lineIds.length !== nextBase.length ||
			mapping.lineIds.length !== expectedLineIds.length ||
			mapping.lineIds.some((id, index) => id !== expectedLineIds[index])
		) {
			throw new TextOwnershipError(
				"invalidCommitMapping",
				"Commit provenance does not materialize the committed bytes",
			);
		}
		let shift = 0;
		edits = selected.map((unit) => {
			absorbed.add(unit.id);
			const newStart = unit.baseStart + shift;
			const newEnd = newStart + unit.insertedLines.length;
			shift += unit.insertedLines.length - (unit.baseEnd - unit.baseStart);
			return { oldStart: unit.baseStart, oldEnd: unit.baseEnd, newStart, newEnd };
		});
		baseLineIds = [...mapping.lineIds];
	} else {
		edits = exactEdits(base, nextBase, budget);
		const conflicts: TextHeadConflict[] = [];
		baseLineIds = new Array(nextBase.length);
		let oldAt = 0;
		let newAt = 0;
		for (const edit of edits) {
			budget.check();
			while (oldAt < edit.oldStart) baseLineIds[newAt++] = previous.baseLineIds[oldAt++];
			const window = ambiguousWindow(base, nextBase, edit, budget);
			const probe = { ...edit, oldStart: window.start, oldEnd: window.end };
			let low = 0;
			let high = previous.units.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (previous.units[middle].baseEnd < window.start) low = middle + 1;
				else high = middle;
			}
			const touched: TextChangeUnit[] = [];
			for (let i = low; i < previous.units.length; i++) {
				const unit = previous.units[i];
				if (unit.baseStart > window.end) break;
				if (rangesIntersect(unit, probe)) touched.push(unit);
			}
			const inside = touched.every(
				(unit) => edit.oldStart <= unit.baseStart && unit.baseEnd <= edit.oldEnd,
			);
			const local = inside
				? applyUnits(
						base.slice(edit.oldStart, edit.oldEnd),
						touched.map((unit) => ({
							...unit,
							baseStart: unit.baseStart - edit.oldStart,
							baseEnd: unit.baseEnd - edit.oldStart,
						})),
					)
				: [];
			const absorbedExactly =
				touched.length > 0 &&
				inside &&
				local.join("") === nextBase.slice(edit.newStart, edit.newEnd).join("");
			if (touched.length && !absorbedExactly) {
				if (mode === "observe" && input.headConflictGroupId !== undefined) {
					return {
						status: "ok",
						snapshot: rebuildHeadWithBudget(
							previous,
							input.baseText,
							input.workText,
							input.headConflictGroupId,
							budget,
						),
						conflicts: [],
						headRebuilt: true,
					};
				}
				conflicts.push({
					baseStart: edit.oldStart,
					baseEnd: edit.oldEnd,
					unitIds: touched.map((unit) => unit.id),
					oldBaseText: base.slice(edit.oldStart, edit.oldEnd).join(""),
					newBaseText: nextBase.slice(edit.newStart, edit.newEnd).join(""),
					workText: previous.workText,
				});
				// A conflict publishes no projection. One bounded witness plus the untouched
				// complete snapshot is sufficient; do not repeat a 2 MiB work text per edit.
				return { status: "headConflict", snapshot: previous, conflicts };
			}
			for (const unit of touched) if (absorbedExactly) absorbed.add(unit.id);
			const sourceIds: string[] = [];
			if (absorbedExactly) {
				let at = edit.oldStart;
				for (const unit of touched) {
					for (; at < unit.baseStart; at++) sourceIds.push(previous.baseLineIds[at]);
					for (let i = unit.workStart; i < unit.workEnd; i++)
						sourceIds.push(previous.workLines[i].id);
					at = unit.baseEnd;
				}
				for (; at < edit.oldEnd; at++) sourceIds.push(previous.baseLineIds[at]);
			}
			for (; newAt < edit.newEnd; newAt++)
				baseLineIds[newAt] =
					sourceIds[newAt - edit.newStart] ?? newIdentity(previous.fileId, "base");
			oldAt = edit.oldEnd;
		}
		while (oldAt < base.length) baseLineIds[newAt++] = previous.baseLineIds[oldAt++];
		if (conflicts.length) return { status: "headConflict", snapshot: previous, conflicts };
	}
	let committedShift = 0;
	const remaining: TextChangeUnit[] = [];
	for (const unit of previous.units) {
		if (absorbed.has(unit.id)) {
			committedShift += unit.insertedLines.length - (unit.baseEnd - unit.baseStart);
			continue;
		}
		// Candidate order disambiguates several insertions at one baseline boundary.
		// Text diff alone cannot reconstruct that order after only one owner is committed.
		remaining.push({
			...unit,
			baseStart: mapping
				? unit.baseStart + committedShift
				: mapPosition(unit.baseStart, edits, unit.baseStart === unit.baseEnd ? "start" : "end"),
			baseEnd: mapping ? unit.baseEnd + committedShift : mapPosition(unit.baseEnd, edits, "start"),
		});
	}
	baseLineIds = projectedBaseIds(previous.fileId, baseLineIds, budget, remaining);
	const intermediateText = applyUnits(nextBase, sortedUnits(remaining)).join("");
	const oldIdsByUnit = new Map(
		previous.units.map((unit) => [
			unit.id,
			previous.workLines.slice(unit.workStart, unit.workEnd).map((line) => line.id),
		]),
	);
	const intermediateIds: (string | undefined)[] = [];
	let at = 0;
	for (const unit of sortedUnits(remaining)) {
		for (; at < unit.baseStart; at++) intermediateIds.push(baseLineIds[at]);
		intermediateIds.push(...(oldIdsByUnit.get(unit.id) ?? []));
		at = unit.baseEnd;
	}
	for (; at < baseLineIds.length; at++) intermediateIds.push(baseLineIds[at]);
	const rebased = finalize(
		previous.fileId,
		input.baseText,
		intermediateText,
		baseLineIds,
		remaining,
		intermediateIds,
		budget,
		previous.structuralSourceGroupIds,
	);
	return {
		status: "ok",
		snapshot: updateWithBudget(
			rebased,
			input.workText,
			mode === "observe" ? (input.headConflictGroupId ?? input.activeGroupId) : input.activeGroupId,
			budget,
			mode,
		),
		conflicts: [],
	};
}
