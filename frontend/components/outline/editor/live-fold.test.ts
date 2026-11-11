/**
 * A live page as the tree the folding reads (`live-fold.ts`): what a block is, its marks, and
 * what counts as an unanswered question before the page's summary arrived.
 */
import { describe, expect, test } from "bun:test";
import { buildFoldTree } from "@shared/outline-fold";
import type { BlockMark } from "./chrome";
import type { LiveClient } from "./live-client";
import { liveFoldSource, liveUnderTask } from "./live-fold";

interface Rec {
	parentId: string | null;
	task?: " " | "/" | "x" | "-";
	question?: boolean;
	text?: string;
}

/** page → task (done) → note → q (a question); page → report line → para; page → fact. */
const BLOCKS: Record<string, Rec> = {
	page: { parentId: null },
	task: { parentId: "page", task: "x" },
	note: { parentId: "task" },
	q: { parentId: "note", question: true, text: "Which way?" },
	todo: { parentId: "page", task: "/" },
	report: { parentId: "page", text: "Report (generation 1 · 2026-11-09 17:38 UTC)" },
	head: { parentId: "report", text: "## Findings" },
	para: { parentId: "head" },
	fact: { parentId: "page" },
};

const client = {
	visible: {
		get: (id: string) => BLOCKS[id],
		children: (id: string) => Object.keys(BLOCKS).filter((k) => BLOCKS[k]?.parentId === id),
	},
	textOf: (id: string) => BLOCKS[id]?.text ?? id,
} as unknown as LiveClient;

const NONE: ReadonlyMap<string, BlockMark> = new Map();

describe("a live page as a fold source", () => {
	test("tasks, reports (by their line too), headings and children", () => {
		const source = liveFoldSource(client, { marks: NONE });
		expect(source.task("task")).toBe("done");
		expect(source.task("todo")).toBe("doing");
		expect(source.task("note")).toBeNull();
		expect(source.report("report")).toBe(true);
		expect(source.report(`dlrp${"a".repeat(28)}`)).toBe(true);
		expect(source.report("fact")).toBe(false);
		expect(source.heading?.("head")).toBe(true);
		expect(source.heading?.("para")).toBe(false);
		expect(source.children("page")).toEqual(["task", "todo", "report", "fact"]);
		// What the view leaves out is not part of the tree.
		const facts = liveFoldSource(client, { marks: NONE, omit: (id) => !!BLOCKS[id]?.task });
		expect(facts.children("page")).toEqual(["report", "fact"]);
	});

	test("under a task or inside a report, by the same test the fold source uses", () => {
		expect(liveUnderTask(client, "note")).toBe(true);
		expect(liveUnderTask(client, "q")).toBe(true);
		// A report known by its line, not its id.
		expect(liveUnderTask(client, "para")).toBe(true);
		expect(liveUnderTask(client, "task")).toBe(false);
		expect(liveUnderTask(client, "fact")).toBe(false);
		expect(liveUnderTask(client, "nope")).toBe(false);
	});

	test("marks: a lock, a pending change and an unanswered question, one each", () => {
		const marks = new Map<string, BlockMark>([
			["note", { lockedBy: "alice", pending: ["a", "b"] }],
			["q", { openQuestion: true }],
			["fact", {}],
		]);
		const source = liveFoldSource(client, { marks, questionsKnown: true });
		expect(source.marks?.("note")).toEqual({ pending: 1, locked: 1 });
		expect(source.marks?.("q")).toEqual({ question: 1 });
		expect(source.marks?.("fact")).toEqual({});
		expect(source.marks?.("para")).toBeNull();
	});

	test("until the page's summary arrived, every question counts as unanswered", () => {
		const open = (known: boolean, marks = NONE) =>
			buildFoldTree(liveFoldSource(client, { marks, questionsKnown: known }), { rootId: "page" });
		// Not known yet: the finished task over the question stays open (nothing folds by mistake).
		const early = open(false);
		expect(early.nodes.get("task")?.open).toBe(true);
		expect(early.nodes.get("q")?.visible).toBe(true);
		// Known, and it is answered (no mark): the usual rule folds the finished task.
		expect(open(true).nodes.get("task")?.open).toBe(false);
		// Known, and still open: it stays on screen.
		const still = open(true, new Map([["q", { openQuestion: true }]]));
		expect(still.nodes.get("task")?.open).toBe(true);
		expect(still.nodes.get("q")?.visible).toBe(true);
		// A lock beside it does not change that either way.
		const locked = open(false, new Map([["q", { lockedBy: "bob" }]]));
		expect(locked.nodes.get("q")?.visible).toBe(true);
	});
});
