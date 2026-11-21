import { expect, spyOn, test } from "bun:test";
import { createTwoFilesPatch } from "diff";
import {
	type GitStagingDiff,
	type GitStagingUnit,
	GIT_STAGING_LIMITS as LIMITS,
} from "../../../shared/git-staging-lists";
import { parseUnifiedDiff } from "../../../shared/pretext-layout/parse-unified-diff";
import {
	materializeTextOwnership,
	splitOwnershipLines,
	type TextOwnershipSnapshot,
} from "../git-changelist-ownership";
import { projectGitStagingUnitDiff } from "../git-staging-unit-diff";

function fixture(
	baseText: string,
	edits: Array<{ start: number; end: number; insert: string; group?: string }>,
) {
	const base = splitOwnershipLines(baseText);
	const ownership: TextOwnershipSnapshot = {
		version: 1,
		fileId: "file",
		baseText,
		workText: "",
		baseLineIds: base.map((_, index) => `base-${index}`),
		workLines: [],
		units: [],
	};
	let baseAt = 0;
	for (const [index, edit] of edits.entries()) {
		for (; baseAt < edit.start; baseAt++)
			ownership.workLines.push({
				id: `base-${baseAt}`,
				baseLineId: `base-${baseAt}`,
				unitId: null,
				text: base[baseAt],
			});
		const insertedLines = splitOwnershipLines(edit.insert);
		const id = `unit-${index}`;
		const workStart = ownership.workLines.length;
		for (const [lineIndex, text] of insertedLines.entries())
			ownership.workLines.push({
				id: `${id}-${lineIndex}`,
				baseLineId: null,
				unitId: id,
				text,
			});
		ownership.units.push({
			id,
			groupId: edit.group ?? "selected",
			baseStart: edit.start,
			baseEnd: edit.end,
			workStart,
			workEnd: ownership.workLines.length,
			insertedLines,
			deletedLineIds: ownership.baseLineIds.slice(edit.start, edit.end),
			leftAnchor: ownership.baseLineIds[edit.start - 1] ?? null,
			rightAnchor: ownership.baseLineIds[edit.end] ?? null,
			needsReview: false,
			sourceGroupIds: [edit.group ?? "selected"],
		});
		baseAt = edit.end;
	}
	for (; baseAt < base.length; baseAt++)
		ownership.workLines.push({
			id: `base-${baseAt}`,
			baseLineId: `base-${baseAt}`,
			unitId: null,
			text: base[baseAt],
		});
	ownership.workText = ownership.workLines.map((line) => line.text).join("");
	const units: GitStagingUnit[] = ownership.units
		.filter((unit) => unit.groupId === "selected")
		.map((unit) => ({
			id: unit.id,
			fileId: ownership.fileId,
			path: "f",
			kind: "text",
			listId: unit.groupId,
			baseStart: unit.baseStart,
			baseEnd: unit.baseEnd,
			workStart: unit.workStart,
			workEnd: unit.workEnd,
			added: unit.insertedLines.length,
			removed: unit.baseEnd - unit.baseStart,
			needsReview: false,
		}));
	const selectedText = materializeTextOwnership(ownership, { groupIds: ["selected"] });
	const diff = createTwoFilesPatch("f", "f", baseText, selectedText, "HEAD", "selected", {
		context: 3,
	});
	return { ownership, units, selectedText, diff, listId: "selected" };
}

function mappedRows(input: ReturnType<typeof fixture>) {
	const parsed = parseUnifiedDiff(input.diff);
	return projectGitStagingUnitDiff(input).map(({ unitId, lineRanges }) => ({
		unitId,
		rows: lineRanges.flatMap(({ start, end }) => parsed.lines.slice(start, end)),
	}));
}

for (const foreign of [
	{ start: 0, end: 0, insert: "foreign one\nforeign two\n", group: "other" },
	{ start: 0, end: 1, insert: "", group: "other" },
])
	test(`selected projection ignores earlier foreign ${foreign.insert ? "insertions" : "deletions"}`, () => {
		const input = fixture("first\ncontext1\ncontext2\nlast\n", [
			foreign,
			{ start: 3, end: 4, insert: "selected last\n" },
		]);
		expect(input.units[0].workStart).not.toBe(3);
		expect(mappedRows(input)).toMatchObject([
			{
				unitId: "unit-1",
				rows: [
					{ type: "removed", oldLineNo: 4, content: "last" },
					{ type: "added", newLineNo: 4, content: "selected last" },
				],
			},
		]);
	});

test("one merged hunk retains separate unit identities and excludes context", () => {
	const input = fixture("first\ncontext1\ncontext2\nlast\n", [
		{ start: 0, end: 1, insert: "FIRST\n" },
		{ start: 3, end: 4, insert: "LAST\n" },
	]);
	expect(parseUnifiedDiff(input.diff).hunks).toHaveLength(1);
	expect(projectGitStagingUnitDiff(input)).toEqual([
		{ unitId: "unit-0", lineRanges: [{ start: 0, end: 2 }] },
		{ unitId: "unit-1", lineRanges: [{ start: 4, end: 6 }] },
	]);
});

test("adjacent replacements keep disjoint removal and addition ranges per unit", () => {
	const input = fixture("one\ntwo\n", [
		{ start: 0, end: 1, insert: "ONE\n" },
		{ start: 1, end: 2, insert: "TWO\n" },
	]);
	expect(projectGitStagingUnitDiff(input)).toEqual([
		{
			unitId: "unit-0",
			lineRanges: [
				{ start: 0, end: 1 },
				{ start: 2, end: 3 },
			],
		},
		{
			unitId: "unit-1",
			lineRanges: [
				{ start: 1, end: 2 },
				{ start: 3, end: 4 },
			],
		},
	]);
});

for (const edit of [
	{ start: 0, end: 1, insert: "" },
	{ start: 1, end: 1, insert: "inserted\n" },
	{ start: 0, end: 1, insert: "replacement\nextra\n" },
])
	test(`complete deletion/insertion/replacement ${JSON.stringify(edit)} has exact row counts`, () => {
		const input = fixture("one\ntwo\n", [edit]);
		const mappings = mappedRows(input);
		expect(mappings).toHaveLength(1);
		expect(mappings[0].rows.filter((line) => line.type === "removed")).toHaveLength(
			input.units[0].removed,
		);
		expect(mappings[0].rows.filter((line) => line.type === "added")).toHaveLength(
			input.units[0].added,
		);
		expect(mappings[0].rows.every((line) => line.type !== "context")).toBe(true);
	});

test("empty-side hunks preserve line indexes for complete text creation and deletion", () => {
	for (const input of [
		fixture("", [{ start: 0, end: 0, insert: "created\n" }]),
		fixture("deleted\n", [{ start: 0, end: 1, insert: "" }]),
	])
		expect(projectGitStagingUnitDiff(input)).toEqual([
			{ unitId: "unit-0", lineRanges: [{ start: 0, end: 1 }] },
		]);
});

test("separate hunks share the final parsed row indexes rather than raw patch offsets", () => {
	const base = Array.from({ length: 20 }, (_, index) => `line-${index}\n`).join("");
	const input = fixture(base, [
		{ start: 0, end: 1, insert: "FIRST\n" },
		{ start: 19, end: 20, insert: "LAST\n" },
	]);
	expect(parseUnifiedDiff(input.diff).hunks).toHaveLength(2);
	expect(projectGitStagingUnitDiff(input)).toEqual([
		{ unitId: "unit-0", lineRanges: [{ start: 0, end: 2 }] },
		{ unitId: "unit-1", lineRanges: [{ start: 8, end: 10 }] },
	]);
});

test("same text realignment omits the shifted insertion without losing a proven unit", () => {
	const input = fixture("head\nsame\nsame\ntail\n", [
		{ start: 1, end: 1, insert: "same\n" },
		{ start: 3, end: 4, insert: "TAIL\n" },
	]);
	expect(input.units).toHaveLength(2);
	expect(mappedRows(input)).toMatchObject([
		{
			unitId: "unit-1",
			rows: [
				{ type: "removed", content: "tail" },
				{ type: "added", content: "TAIL" },
			],
		},
	]);
});

test("same text deletion realignment does not bind an equivalent neighboring line", () => {
	const input = fixture("head\nsame\nsame\ntail\n", [{ start: 1, end: 2, insert: "" }]);
	expect(projectGitStagingUnitDiff(input)).toEqual([]);
	expect(input.units).toHaveLength(1);
});

test("a unit partly represented as context has no partial action range", () => {
	const input = fixture("one\ntwo\n", [{ start: 0, end: 2, insert: "one\nTWO\n" }]);
	expect(projectGitStagingUnitDiff(input)).toEqual([]);
});

for (const [base, insert] of [
	["before\r\ncontext\r\n", "after\r\n"],
	["before", "after"],
	["before\n", "after"],
	["before", "after\n"],
	[`${"x".repeat(20_000)}\n`, `${"y".repeat(20_000)}\n`],
])
	test(`raw text verification preserves CRLF/EOF and clamped row indexes (${base.length}/${insert.length})`, () => {
		const input = fixture(base, [{ start: 0, end: 1, insert }]);
		expect(projectGitStagingUnitDiff(input)).toEqual([
			{ unitId: "unit-0", lineRanges: [{ start: 0, end: 2 }] },
		]);
	});

test("header-shaped source text uses the unit list instead of incompatible parsed rows", () => {
	const input = fixture("-- header\ncontext\n", [{ start: 0, end: 1, insert: "changed\n" }]);
	expect(projectGitStagingUnitDiff(input)).toEqual([]);
});

test("binary, multi-file and incompatible preambles preserve parser-safe list selection", () => {
	const input = fixture("one\ntwo\n", [{ start: 0, end: 1, insert: "ONE\n" }]);
	for (const preamble of [
		"Binary files a and b differ\n",
		"GIT binary patch\n",
		"diff --git a/one b/one\ndiff --git a/two b/two\n",
		"@@ -1,0 +1,0 @@heading\n",
	])
		expect(projectGitStagingUnitDiff({ ...input, diff: preamble + input.diff })).toEqual([]);
});

test("structural units never receive text mappings", () => {
	const input = fixture("one\ntwo\n", [{ start: 0, end: 1, insert: "ONE\n" }]);
	for (const kind of [
		"mode",
		"create",
		"delete",
		"rename",
		"binary",
		"symlink",
		"gitlink",
	] as const)
		expect(projectGitStagingUnitDiff({ ...input, units: [{ ...input.units[0], kind }] })).toEqual(
			[],
		);
});

test("incomplete patches, inconsistent projections and bounded inputs retain list fallback", () => {
	const input = fixture("one\ntwo\n", [{ start: 0, end: 1, insert: "ONE\n" }]);
	expect(
		projectGitStagingUnitDiff({ ...input, diff: input.diff.slice(0, input.diff.indexOf("+ONE")) }),
	).toEqual([]);
	expect(projectGitStagingUnitDiff({ ...input, selectedText: "wrong\ntwo\n" })).toEqual([]);
	expect(
		projectGitStagingUnitDiff({ ...input, diff: "x".repeat(LIMITS.maxDiffBytes + 1) }),
	).toEqual([]);
	expect(
		projectGitStagingUnitDiff({ ...input, selectedText: "x".repeat(2 * 1024 * 1024 + 1) }),
	).toEqual([]);
	expect(projectGitStagingUnitDiff({ ...input, selectedText: "\n".repeat(100_001) })).toEqual([]);
	expect(projectGitStagingUnitDiff({ ...input, units: Array(5_001).fill(input.units[0]) })).toEqual(
		[],
	);
});

test("mapping computation stops at its deadline while the complete unit list remains available", () => {
	const input = fixture("one\ntwo\n", [{ start: 0, end: 1, insert: "ONE\n" }]);
	let elapsed = 0;
	const clock = spyOn(performance, "now").mockImplementation(() => (elapsed += 200));
	try {
		expect(projectGitStagingUnitDiff(input)).toEqual([]);
		expect(input.units).toHaveLength(1);
	} finally {
		clock.mockRestore();
	}
});

test("the optional metadata contract accepts an older preview response", () => {
	const legacy: GitStagingDiff = {
		path: "f",
		diff: "",
		truncated: false,
		units: [],
		generation: 1,
		observationId: "observation",
		snapshotVersion: "snapshot",
	};
	expect(legacy.unitMappings).toBeUndefined();
});
