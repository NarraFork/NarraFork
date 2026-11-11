/**
 * The note rules as a pure check (`shared/outline-note-structure.ts`): which blocks a call writes
 * under a task are over their limit, which of those are clearly over, what both modes do with
 * them, and what a task being ticked off is asked for.
 */
import { describe, expect, test } from "bun:test";
import {
	isNoteHeading,
	type NoteWriteBlock,
	noteTextChars,
	noteWriteIssues,
	noteWriteRefused,
	OUTLINE_NOTE_RULES,
	taskResultCheck,
} from "../outline-note-structure";
import { OUTLINE_PLAN_STRUCTURE } from "../outline-plan-structure";

const { titleChars, noteChars, detailChars, clearNoteChars, maxChildren } = OUTLINE_NOTE_RULES;

function block(
	ref: string,
	content: string,
	children: NoteWriteBlock[] = [],
	task = false,
): NoteWriteBlock {
	return { ref, content, task, children };
}

const many = (n: number, prefix = "n") =>
	Array.from({ length: n }, (_, i) => block(`${prefix}${i}`, `note ${i}`));

describe("limits", () => {
	test("the numbers are the plan format's, and the first version only warns", () => {
		expect(titleChars).toBe(OUTLINE_PLAN_STRUCTURE.pointChars);
		expect(noteChars).toBe(OUTLINE_PLAN_STRUCTURE.pointChars);
		expect(detailChars).toBe(OUTLINE_PLAN_STRUCTURE.detailChars);
		expect(maxChildren).toBe(OUTLINE_PLAN_STRUCTURE.maxChildren);
		expect(clearNoteChars).toBe(noteChars * 5);
		expect(OUTLINE_NOTE_RULES.mode).toBe("warn");
	});
});

describe("noteWriteIssues", () => {
	test("conclusion, evidence and detail within their limits: nothing", () => {
		const report = noteWriteIssues([
			{
				kind: "under",
				parent: { ref: "task", depth: 0 },
				blocks: [
					block("c", "结".repeat(noteChars), [
						block("e", "据".repeat(detailChars), [block("d", "x".repeat(detailChars))]),
					]),
				],
			},
		]);
		expect(report).toEqual({ issues: [], total: 0, clear: 0 });
	});

	test("a note directly under a task: over its limit is a hint, five times over is clear", () => {
		const report = noteWriteIssues([
			{
				kind: "under",
				parent: { ref: "task", depth: 0 },
				blocks: [
					block("a", "字".repeat(noteChars + 1)),
					block("b", "字".repeat(clearNoteChars)),
					block("c", "字".repeat(clearNoteChars + 1)),
				],
			},
		]);
		expect(report.total).toBe(3);
		expect(report.clear).toBe(1);
		// The clear one is named first.
		expect(report.issues.map((i) => [i.ref, i.clear])).toEqual([
			["c", true],
			["a", false],
			["b", false],
		]);
		expect(report.issues[0]).toMatchObject({
			kind: "long",
			role: "note",
			chars: clearNoteChars + 1,
		});
	});

	test("deeper blocks are details: held to the longer limit, never clear", () => {
		const report = noteWriteIssues([
			{
				kind: "under",
				parent: { ref: "note", depth: 1 },
				blocks: [block("ok", "x".repeat(detailChars)), block("long", "x".repeat(detailChars * 9))],
			},
		]);
		expect(report.issues).toEqual([
			{ kind: "long", ref: "long", chars: detailChars * 9, lines: 1, role: "detail", clear: false },
		]);
	});

	test("code blocks and tables are not prose: not held to a length", () => {
		const code = `\`\`\`\n${"x".repeat(clearNoteChars * 2)}\n\`\`\``;
		const table = `| a | b |\n| --- | --- |\n| ${"x".repeat(clearNoteChars * 2)} | y |`;
		const report = noteWriteIssues([
			{
				kind: "under",
				parent: { ref: "task", depth: 0 },
				blocks: [block("code", code), block("table", table)],
			},
		]);
		expect(report.total).toBe(0);
	});

	test("markup and link targets do not count: text is counted as a reader sees it", () => {
		const content = `**${"字".repeat(noteChars - 2)}** [[Kx81mPqa/Ab3dEf9Q|页]]`;
		expect(content.length).toBeGreaterThan(noteChars);
		const report = noteWriteIssues([
			{ kind: "under", parent: { ref: "task", depth: 0 }, blocks: [block("a", content)] },
		]);
		expect(report.total).toBe(0);
	});

	test("a task's title is one line within its limit, wherever the task is", () => {
		const report = noteWriteIssues([
			{
				kind: "under",
				parent: { ref: "/", depth: null },
				blocks: [
					block("long", "t".repeat(titleChars + 1), [], true),
					block("lines", "one\\\ntwo", [], true),
					block("fine", "t".repeat(titleChars), [], true),
				],
			},
		]);
		expect(report.issues).toEqual([
			{ kind: "long", ref: "long", chars: titleChars + 1, lines: 1, role: "title", clear: false },
			{ kind: "long", ref: "lines", chars: 6, lines: 2, role: "title", clear: false },
		]);
	});

	test("blocks with no task above them are facts: not looked at", () => {
		const report = noteWriteIssues([
			{
				kind: "under",
				parent: { ref: "page", depth: null },
				blocks: [block("fact", "字".repeat(5000), many(40))],
			},
			{ kind: "self", depth: null, block: block("other", "字".repeat(5000)) },
		]);
		expect(report.total).toBe(0);
	});

	test("a new task starts the levels again for what is under it", () => {
		const report = noteWriteIssues([
			{
				kind: "under",
				parent: { ref: "page", depth: null },
				blocks: [block("t", "A task", [block("n", "字".repeat(clearNoteChars + 1))], true)],
			},
			{
				kind: "under",
				parent: { ref: "deep", depth: 4 },
				blocks: [block("sub", "A subtask", [block("m", "字".repeat(noteChars + 1))], true)],
			},
		]);
		expect(report.issues.map((i) => [i.ref, i.kind === "long" ? i.role : i.kind, i.clear])).toEqual(
			[
				["n", "note", true],
				["m", "note", false],
			],
		);
	});

	test("too many blocks added under one task in one call is clear, counted over its adds", () => {
		const report = noteWriteIssues([
			{ kind: "under", parent: { ref: "task", depth: 0 }, blocks: many(maxChildren, "a") },
			{ kind: "under", parent: { ref: "task", depth: 0 }, blocks: many(1, "b") },
			{ kind: "under", parent: { ref: "other", depth: 0 }, blocks: many(maxChildren, "c") },
		]);
		expect(report.issues).toEqual([
			{ kind: "flat", ref: "task", children: maxChildren + 1, clear: true },
		]);
	});

	test("too many under a note, or under a block the call adds: a hint under a note, clear under a task", () => {
		const report = noteWriteIssues([
			{
				kind: "under",
				parent: { ref: "note", depth: 1 },
				blocks: [
					...many(maxChildren + 1, "a"),
					block("newNote", "A note", many(maxChildren + 1, "b")),
				],
			},
			{
				kind: "under",
				parent: { ref: "page", depth: null },
				blocks: [block("newTask", "A task", many(maxChildren + 1, "c"), true)],
			},
		]);
		expect(report.issues).toEqual([
			{ kind: "flat", ref: "newTask", children: maxChildren + 1, clear: true },
			{ kind: "flat", ref: "note", children: maxChildren + 2, clear: false },
			{ kind: "flat", ref: "newNote", children: maxChildren + 1, clear: false },
		]);
	});

	test("a rewritten block is checked where it sits, with what the rewrite adds under it", () => {
		const report = noteWriteIssues([
			{ kind: "self", depth: 1, block: block("n", "字".repeat(clearNoteChars + 1)) },
			{
				kind: "self",
				depth: 0,
				block: block(
					"t",
					"t".repeat(titleChars + 1),
					[block("k", "字".repeat(noteChars + 1))],
					true,
				),
			},
		]);
		expect(report.issues.map((i) => [i.ref, i.kind === "long" ? i.role : i.kind, i.clear])).toEqual(
			[
				["n", "note", true],
				["t", "title", false],
				["k", "note", false],
			],
		);
	});

	test("names the first few and counts the rest", () => {
		const blocks = Array.from({ length: 20 }, (_, i) => block(`b${i}`, "字".repeat(noteChars + 1)));
		const report = noteWriteIssues([
			{ kind: "under", parent: { ref: "note", depth: 0 }, blocks: blocks.slice(0, 10) },
			{ kind: "under", parent: { ref: "note2", depth: 0 }, blocks: blocks.slice(10) },
		]);
		expect(report.total).toBe(20);
		expect(report.issues).toHaveLength(OUTLINE_NOTE_RULES.listed);
	});
});

describe("warn or refuse", () => {
	const clear = { clear: 1 };
	const mild = { clear: 0 };
	test("warn never refuses; reject refuses only what is clearly over", () => {
		expect(noteWriteRefused(clear, "warn")).toBe(false);
		expect(noteWriteRefused(mild, "warn")).toBe(false);
		expect(noteWriteRefused(clear, "reject")).toBe(true);
		expect(noteWriteRefused(mild, "reject")).toBe(false);
	});
	test("without a mode, the configured one decides", () => {
		expect(noteWriteRefused(clear)).toBe(OUTLINE_NOTE_RULES.mode === "reject");
	});
});

describe("headings under a task", () => {
	test("a heading under a task is an issue, never a clear one; a task's own title and facts are not", () => {
		const report = noteWriteIssues([
			{
				kind: "under",
				parent: { ref: "task", depth: 0 },
				blocks: [
					block("h", "## Root cause", [block("deep", "### Deeper")]),
					block("plain", "Root cause"),
					block("tag", "#tag is not a heading"),
					block("code", "```\n# a comment\n```"),
				],
			},
			{
				kind: "under",
				parent: { ref: "page", depth: null },
				blocks: [block("fact", "## A fact's heading"), block("t", "# Title", [], true)],
			},
		]);
		expect(report.issues).toEqual([
			{ kind: "heading", ref: "h", clear: false },
			{ kind: "heading", ref: "deep", clear: false },
		]);
		expect(report.clear).toBe(0);
		expect(noteWriteRefused(report, "reject")).toBe(false);
	});

	test("isNoteHeading", () => {
		expect(isNoteHeading("## Root **cause**")).toBe(true);
		expect(isNoteHeading("### three")).toBe(true);
		// (The dialect has three heading levels: deeper marks are text.)
		expect(isNoteHeading("###### six")).toBe(false);
		expect(isNoteHeading("A paragraph")).toBe(false);
		expect(isNoteHeading("#notheading")).toBe(false);
		expect(isNoteHeading("```\n# code\n```")).toBe(false);
	});
});

describe("bare URLs", () => {
	const url = `https://example.com/${"a".repeat(130)}`;

	test("a bare URL counts as a link's label would, not in full", () => {
		expect(noteTextChars(`see ${url}`)).toBe(4 + OUTLINE_NOTE_RULES.urlChars);
		expect(noteTextChars("see https://a.io/x")).toBe(18);
		expect(noteTextChars(`${url} and ${url}`)).toBe(5 + 2 * OUTLINE_NOTE_RULES.urlChars);
		expect(noteTextChars("no link here")).toBe(12);
	});

	test("text in another script after a URL is the note's text, with or without a space", () => {
		const cjk = "字".repeat(700);
		const short = "https://a.cn/x";
		for (const [text, chars] of [
			[`见${short}${cjk}`, 1 + short.length + 700],
			[`见 ${short}，${cjk}`, 2 + short.length + 1 + 700],
			[`见 ${short} ${cjk}`, 2 + short.length + 1 + 700],
			[`见${url}${cjk}`, 1 + OUTLINE_NOTE_RULES.urlChars + 700],
			[`${url}。${cjk}`, OUTLINE_NOTE_RULES.urlChars + 1 + 700],
		] as const) {
			expect({ text: text.slice(0, 30), chars: noteTextChars(text) }).toEqual({
				text: text.slice(0, 30),
				chars,
			});
			const report = noteWriteIssues([
				{ kind: "under", parent: { ref: "task", depth: 0 }, blocks: [block("n", text)] },
			]);
			expect(report.clear).toBe(1);
			expect(noteWriteRefused(report, "reject")).toBe(true);
			// And the tick-done check sees it as long.
			expect(taskResultCheck([{ ref: "n", head: text, other: false }]).longTotal).toBe(1);
		}
	});

	test("a short note with a long URL is within the limit; long text beside it is not", () => {
		const report = noteWriteIssues([
			{
				kind: "under",
				parent: { ref: "task", depth: 0 },
				blocks: [block("ok", `see ${url}`), block("long", `${"字".repeat(noteChars)} ${url}`)],
			},
		]);
		expect(report.issues).toEqual([
			{
				kind: "long",
				ref: "long",
				chars: noteChars + 1 + OUTLINE_NOTE_RULES.urlChars,
				lines: 1,
				role: "note",
				clear: false,
			},
		]);
	});
});

describe("taskResultCheck", () => {
	const note = (ref: string, head: string) => ({ ref, head, other: false });
	const other = (ref: string) => ({ ref, head: "", other: true });

	test("a note under the task is its result", () => {
		expect(taskResultCheck([other("sub"), note("r", "Fixed in auth.ts:12")])).toEqual({
			hasResult: true,
			heading: null,
			long: [],
			longTotal: 0,
			flat: null,
		});
	});

	test("subtasks, questions, reports and empty blocks are not a result", () => {
		expect(taskResultCheck([]).hasResult).toBe(false);
		expect(taskResultCheck([other("sub"), other("report"), note("blank", " ")]).hasResult).toBe(
			false,
		);
	});

	test("a heading standing first is a label, not the result", () => {
		expect(
			taskResultCheck([other("sub"), note("h", "## Result"), note("r", "Fixed in auth.ts:12")]),
		).toMatchObject({ hasResult: false, heading: "h" });
		// A heading further down does not take the result's place.
		expect(taskResultCheck([note("r", "Fixed"), note("h", "## Notes")])).toMatchObject({
			hasResult: true,
			heading: null,
		});
	});

	test("long notes are named (a few), with their length when all of it was read", () => {
		const long = Array.from({ length: 7 }, (_, i) => note(`l${i}`, "字".repeat(noteChars + 1 + i)));
		const cut = note("cut", "x".repeat(OUTLINE_NOTE_RULES.tidyHeadChars));
		const report = taskResultCheck([cut, ...long, note("ok", "short")]);
		expect(report.longTotal).toBe(8);
		expect(report.long).toHaveLength(OUTLINE_NOTE_RULES.tidyListed);
		expect(report.long[0]).toEqual({ ref: "cut", chars: null });
		expect(report.long[1]).toEqual({ ref: "l0", chars: noteChars + 1 });
	});

	test("a code block is a result and is not long", () => {
		const report = taskResultCheck([note("c", `\`\`\`\n${"x".repeat(900)}\n\`\`\``)]);
		expect(report).toMatchObject({ hasResult: true, longTotal: 0 });
	});

	test("more notes than a level holds", () => {
		const notes = Array.from({ length: maxChildren + 1 }, (_, i) => note(`n${i}`, "short"));
		expect(taskResultCheck(notes.slice(0, maxChildren)).flat).toBeNull();
		expect(taskResultCheck(notes).flat).toBe(maxChildren + 1);
		expect(taskResultCheck(notes.slice(0, 3), true).flat).toBe(3);
	});
});
