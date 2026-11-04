/**
 * The outline tool cards' words (`outline-tool-card.ts`) and the display they come from
 * (`shared/outline-tool-display.ts`): a change per line, titles as outline links, a checkbox from
 * → to as chips, the space by name; an older call without a display from its input; decisions
 * and failed calls; Ask; the header's figures; and the bounds a stored display is held to.
 */
import { describe, expect, it } from "bun:test";
import {
	boundOutlineEditDisplay,
	OUTLINE_TOOL_DISPLAY_LIMITS,
	type OutlineEditDisplay,
	readOutlineEditDisplay,
} from "../outline-tool-display";
import {
	outlineAskRows,
	outlineDecisionRows,
	outlineEditHeaderStats,
	outlineEditRows,
	outlineLegacyEditRows,
	outlineSpaceChips,
} from "./outline-tool-card";
import { classifyToolDetail, type ToolChangeRow } from "./tool-detail";

const K = "MTBXwl1Y";
const TASK = { address: `${K}/LUwB3JZb`, title: "Fix the retry button" };
const href = (sid: string) => `/outline/ref?a=${encodeURIComponent(`${K}/${sid}`)}`;

/** A row as one readable line: `[glyph] words <link> [chip]`. */
function line(row: ToolChangeRow): string {
	return [
		`${row.indent ? "  " : ""}${row.glyph ?? "-"}:`,
		...row.parts.map((p) =>
			p.kind === "text" ? p.text : p.kind === "link" ? `<${p.text}>` : `[${p.label}]`,
		),
	].join(" ");
}

const ZH = {
	outlineAddedUnder: "在 {link} 下新增 {n} 块",
	outlineMoved: "移动 {link} 到 {to} 下",
	taskNoticeStatusDoing: "进行中",
	taskNoticeStatusDone: "完成",
};

describe("an edit's change list, from its display", () => {
	const display: OutlineEditDisplay = {
		v: 1,
		space: { key: K, kind: "session", own: true },
		ops: [
			{
				op: "add",
				parent: TASK,
				created: [
					{ address: `${K}/RQvana8Z`, title: "Pushed the branch", depth: 0 },
					{ address: `${K}/AEguaeis`, title: "Root cause", depth: 0, status: "todo" },
				],
				more: 2,
			},
			{ op: "set", target: TASK, status: { from: "doing", to: "done" } },
			{ op: "set", target: TASK, assignee: { to: "agent:review-1" } },
			{ op: "set", target: TASK, alias: { to: "Q7" } },
			{ op: "replace", target: { address: `${K}/AEguaeis`, title: "Root cause" }, merged: true },
			{ op: "move", target: TASK, to: { address: `${K}/qZQGaQCV`, title: "Notes" } },
			{ op: "move", target: TASK, to: null },
			{ op: "delete", target: { address: `${K}/Old9Plan`, title: "Old plan" }, under: 4 },
			{
				op: "add",
				parent: { address: `${K}/Rel2v2Pl`, title: "Release v2" },
				created: [{ address: `${K}/Gray10Pc`, title: "Canary", depth: 0 }],
				held: true,
			},
		],
		pending: { label: "P1a2B3c4D", decider: "alice" },
	};

	it("says each change in a line: titled links, chips, the held change and who decides it", () => {
		expect(outlineEditRows(display, undefined).map(line)).toEqual([
			"add: Added 4 under <Fix the retry button>",
			"  child: <Pushed the branch>",
			"  child: <Root cause> [To do]",
			"  more: 2 more",
			"done: <Fix the retry button> [In progress] → [Done]",
			"assign: Handed <Fix the retry button> to [@agent:review-1]",
			"alias: Gave <Fix the retry button> the alias [Q7]",
			"edit: Rewrote <Root cause> [merged with someone's change]",
			"move: Moved <Fix the retry button> under <Notes>",
			"move: Made <Fix the retry button> a page",
			"delete: Deleted <Old plan> and 4 block(s) under it",
			"add: Added 1 under <Release v2> [awaiting confirmation]",
			"  child: <Canary>",
			"pending: Waiting for alice to confirm [P1a2B3c4D]",
		]);
	});

	it("links each block to the outline, its address on hover; ids and aliases verbatim", () => {
		const rows = outlineEditRows(display, undefined);
		const tick = rows.find((r) => r.glyph === "done");
		expect(tick?.parts[0]).toEqual({
			kind: "link",
			text: "Fix the retry button",
			href: href("LUwB3JZb"),
			tip: `${K}/LUwB3JZb`,
		});
		const alias = rows.find((r) => r.glyph === "alias")?.parts.find((p) => p.kind === "chip");
		expect(alias).toMatchObject({ label: "Q7", verbatim: true });
		const pending = rows.at(-1)?.parts.find((p) => p.kind === "chip");
		expect(pending).toMatchObject({ label: "P1a2B3c4D", verbatim: true });
	});

	it("follows the reader's word order", () => {
		const rows = outlineEditRows(display, ZH);
		expect(line(rows[0] as ToolChangeRow)).toBe("add: 在 <Fix the retry button> 下新增 4 块");
		expect(rows.map(line)).toContain("move: 移动 <Fix the retry button> 到 <Notes> 下");
		expect(rows.map(line)).toContain("done: <Fix the retry button> [进行中] → [完成]");
	});

	it("counts what the header shows: tasks done, blocks added and deleted (not held), the commit", () => {
		expect(
			outlineEditHeaderStats({ display, commit: { id: "c", seq: 6 }, space: { key: K } }),
		).toEqual({ added: 4, removed: 5, done: 1, commit: 6 });
		// An older call: its commit only.
		expect(outlineEditHeaderStats({ commit: { id: "c", seq: 6 } })).toEqual({
			added: 0,
			removed: 0,
			commit: 6,
		});
		expect(outlineEditHeaderStats({ commit: null })).toBeUndefined();
	});

	it("names the space by its name, then its key as written", () => {
		expect(outlineSpaceChips({ display, space: { key: K, kind: "session" } }, undefined)).toEqual([
			{ label: "This session's notes", color: "teal" },
			{ label: K, color: "gray", verbatim: true },
		]);
		// An older call knows the kind only.
		expect(outlineSpaceChips({ space: { key: K, kind: "project" } }, undefined)).toEqual([
			{ label: "Project", color: "teal" },
			{ label: K, color: "gray", verbatim: true },
		]);
		expect(
			outlineSpaceChips(
				{ display: { v: 1, space: { key: K, kind: "project", name: "NarraFork" }, ops: [] } },
				undefined,
			)[0],
		).toEqual({ label: "NarraFork", color: "teal" });
	});
});

describe("an older edit's change list (no display), from its input", () => {
	it("names the references as written, linked where its result gives their addresses", () => {
		const rows = outlineLegacyEditRows(
			{
				edits: [
					{ add: "LUwB3JZb", markdown: "- first\n  - nested\n- second" },
					{ set: "LUwB3JZb", checkbox: "x" },
					{ delete: "Q1" },
					{ move: "Q2", to: `${K}/` },
				],
			},
			{
				space: { key: K },
				edits: [
					{ op: "add", created: [`${K}/N1N1N1N1`, `${K}/N2N2N2N2`, `${K}/N3N3N3N3`] },
					{ op: "set", address: `${K}/LUwB3JZb` },
					{ op: "delete", address: `${K}/Qq1Sid00` },
					{ op: "move", address: `${K}/Qq2Sid00` },
				],
			},
			undefined,
		);
		expect(rows.map(line)).toEqual([
			"add: Added 2 under <LUwB3JZb>",
			"  child: <first>",
			"  child: <second>",
			"done: <LUwB3JZb> → [Done]",
			"delete: Deleted <Q1>",
			"move: Made <Q2> a page",
		]);
		const del = rows.find((r) => r.glyph === "delete")?.parts[1];
		expect(del).toMatchObject({ kind: "link", text: "Q1", href: href("Qq1Sid00") });
		expect(rows[0]?.parts[1]).toMatchObject({ href: href("LUwB3JZb") });
	});
});

describe("decisions", () => {
	it("say what was decided, the commit a confirmation wrote linked to the timeline", () => {
		const rows = outlineDecisionRows(
			{ edits: [{ confirm: "P1a2B3c4D" }, { reject: "P9z8Y7x6W" }] },
			{
				decided: [
					{ confirm: "P1a2B3c4D", commit: { id: "c9", seq: 9 }, space: K },
					{ reject: "P9z8Y7x6W", status: "withdrawn", space: K },
				],
			},
			undefined,
		);
		expect(rows.map(line)).toEqual([
			"confirm: Confirmed [P1a2B3c4D] → <commit #9>",
			"withdraw: Withdrew [P9z8Y7x6W]",
		]);
		expect(rows[0]?.parts.at(-1)).toMatchObject({
			href: `/outline/ref?space=${K}&commit=9`,
		});
	});
});

describe("Ask", () => {
	it("lists the questions (sub-questions under them), each linked, with the recommendation", () => {
		const rows = outlineAskRows(
			{
				questions: [
					{
						question: "Where does the button go?",
						options: ["bottom", "top right"],
						recommend: 2,
						items: [{ question: "Codex too?", recommend: "Anthropic first" }],
					},
				],
			},
			{ addresses: [`${K}/Zx81aaQe`, `${K}/Zx81aaQf`] },
			undefined,
		);
		expect(rows.map(line)).toEqual([
			"question: <Where does the button go?> [→ top right] 1. bottom  2. top right",
			"  child: <Codex too?> [→ Anthropic first]",
		]);
		expect(rows[0]?.parts[0]).toMatchObject({ href: href("Zx81aaQe") });
	});

	it("names a withdrawn question by its alias and title (from its display)", () => {
		const rows = outlineAskRows(
			{ withdraw: ["Q3"] },
			{
				display: {
					v: 1,
					questions: [{ address: `${K}/Zx81aaQe`, alias: "Q3", title: "Where?" }],
				},
			},
			undefined,
		);
		expect(rows.map(line)).toEqual(["withdraw: [Q3] Withdrew <Where?>"]);
	});
});

describe("the card", () => {
	const base = {
		previewId: "p",
		toolName: "OutlineEdit",
		category: "outline",
		inputJson: { edits: [{ set: "LUwB3JZb", checkbox: "x" }] },
	} as const;

	it("shows a failed call's input and result (nothing to list, the result says why)", () => {
		const d = classifyToolDetail({
			...base,
			status: "error",
			outputJson: "Nothing was written.\n- edit 1: …",
			metadata: { tool: "OutlineEdit", commit: null },
		});
		expect(d?.sections.map((s) => s.key)).toEqual(["input.edits", "output.main"]);
	});

	it("shows a call that wrote nothing the same way", () => {
		const d = classifyToolDetail({
			...base,
			outputJson: "Nothing changed: the edits leave the outline as it was.",
			metadata: { tool: "OutlineEdit", space: { key: K, kind: "session" }, commit: null },
		});
		expect(d?.sections.map((s) => s.key)).toEqual(["meta.edit", "input.edits", "output.main"]);
	});

	it("draws a decision as its rows, never a bare Edit, with only the result in its fold", () => {
		const d = classifyToolDetail({
			...base,
			inputJson: { edits: [{ confirm: "P1a2B3c4D" }] },
			outputJson: "1. Confirmed P1a2B3c4D; it is committed as #9.",
			metadata: { tool: "OutlineEdit", decided: [{ confirm: "P1a2B3c4D", space: K }] },
			rawOpen: true,
		});
		expect(d?.sections.map((s) => s.key)).toEqual(["output.changes", "output.main"]);
	});
});

describe("the stored display", () => {
	it("is read back bounded: clipped titles, capped lists, unknown fields dropped", () => {
		const long = "x".repeat(500);
		const created = Array.from({ length: 30 }, (_, i) => ({
			address: `${K}/C${String(i).padStart(7, "0")}`,
			title: long,
			depth: 0,
			extra: "dropped",
		}));
		const read = readOutlineEditDisplay({
			display: {
				v: 1,
				space: { key: K, kind: "session" },
				ops: [{ op: "add", parent: null, created }, { op: "bogus" }],
				junk: true,
			},
		});
		const add = read?.ops[0];
		expect(add?.op).toBe("add");
		if (add?.op !== "add") return;
		expect(add.created).toHaveLength(OUTLINE_TOOL_DISPLAY_LIMITS.created);
		expect(add.more).toBe(30 - OUTLINE_TOOL_DISPLAY_LIMITS.created);
		expect(Array.from(add.created[0]?.title ?? "").length).toBe(
			OUTLINE_TOOL_DISPLAY_LIMITS.titleChars,
		);
		expect(add.created[0]).not.toHaveProperty("extra");
		// The unknown op is dropped and counted.
		expect(read?.more).toBe(1);
		expect(read).not.toHaveProperty("junk");
	});

	it("never exceeds its byte bound: edits are dropped from the end and counted", () => {
		const ops = Array.from({ length: 200 }, (_, i) => ({
			op: "set",
			target: { address: `${K}/T${String(i).padStart(7, "0")}`, title: "任务".repeat(40) },
			status: { from: "todo", to: "done" },
		}));
		const bounded = boundOutlineEditDisplay({ v: 1, space: { key: K, kind: "session" }, ops });
		expect(bounded).not.toBeNull();
		const bytes = new TextEncoder().encode(JSON.stringify(bounded)).length;
		expect(bytes).toBeLessThanOrEqual(OUTLINE_TOOL_DISPLAY_LIMITS.bytes);
		expect((bounded?.ops.length ?? 0) + (bounded?.more ?? 0)).toBe(200);
	});

	it("is not a display when it is not one", () => {
		expect(
			readOutlineEditDisplay({ display: { v: 2, space: { key: K, kind: "x" }, ops: [] } }),
		).toBeNull();
		expect(readOutlineEditDisplay({ display: "nope" })).toBeNull();
		expect(readOutlineEditDisplay(null)).toBeNull();
	});
});
