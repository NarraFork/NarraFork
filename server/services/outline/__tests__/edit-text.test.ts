/**
 * The text side of OutlineEdit and OutlineRead, with no database: parsing edits (labels a read
 * put after bullets, annotations, one-block texts), rewriting links to their stored form, showing
 * links with titles, and running the work on the worker thread (same results, timeouts, limits).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { normalizeBlock, serializeMarkdownOutline } from "@shared/outline";
import { type EditTextJob, itemOutline, runEditTextJob } from "../edit-text";
import {
	OUTLINE_EDIT_TEXT_LIMITS,
	OutlineEditTextError,
	processEditText,
	stopEditTextWorker,
} from "../edit-text-runner";
import { linkDisplayTitle, withLinkTitles } from "../link-display";
import { contentLinks } from "../links";
import { stripReadAnnotations } from "../render";

afterAll(() => stopEditTextWorker());

function parse(text: string, labels: string[] = [], mode: "outline" | "item" = "outline") {
	const [result] = runEditTextJob({ kind: "parse", inputs: [{ mode, text }], labels });
	if (!result) throw new Error("no result");
	return result;
}

describe("parse", () => {
	test("takes off only the labels it is told name blocks, and drops read notes", () => {
		const text = [
			"‹space Kx81mPqa · project›",
			"- [Ab3dEf9Q] Page",
			"  - [Zz91kLmN] [ ] task @agent:x",
			"  - [CRITICAL] stays text",
			"  ‹… 3 more›",
			"‹facts only: 2 blocks under tasks not shown›",
		].join("\n");
		const { items, notes } = parse(text, ["Ab3dEf9Q", "Zz91kLmN"]);
		expect(notes).toEqual([]);
		expect(items).toHaveLength(1);
		const page = items[0];
		expect(page?.label).toBe("Ab3dEf9Q");
		expect(page?.content).toBe("Page");
		expect(page?.children.map((c) => [c.label, c.content, c.task])).toEqual([
			["Zz91kLmN", "task", { status: "todo", assignee: "agent:x" }],
			[undefined, "[CRITICAL] stays text", null],
		]);
	});

	test("a code fence after a label keeps annotation-like lines as code", () => {
		const text = "- [Ab3dEf9Q] ```\n  ‹… 3 more›\n  ```";
		expect(stripReadAnnotations(text)).toBe(text);
		const { items } = parse(text, ["Ab3dEf9Q"]);
		expect(items[0]?.content).toBe("```\n‹… 3 more›\n```");
	});

	test("an item text reads like one outline item without its bullet", () => {
		expect(itemOutline("[x] done @human:ann\ndue:: 2026-11-01\n- child")).toBe(
			"- [x] done @human:ann\n  due:: 2026-11-01\n  - child",
		);
		const { items, notes } = parse("First paragraph\n\nSecond one", [], "item");
		expect(items).toHaveLength(1);
		expect(items[0]?.content).toBe("First paragraph");
		expect(items[0]?.children.map((c) => c.content)).toEqual(["Second one"]);
		expect(notes.map((n) => n.code)).toEqual(["split-paragraphs"]);
		expect(parse("- a\n- b", [], "item").items).toHaveLength(2);
	});

	test("items come with their links, references and title", () => {
		// An embed inside a line is a `!` and a mention: embeds take a block of their own.
		const { items } = parse("- **Bold** see [[Q17]] and ![[k1/Ab3dEf9Q|x]]");
		const item = items[0];
		expect(item?.title).toBe("Bold see Q17 and !x");
		expect(item?.refs).toEqual([
			{ kind: "mention", ref: "Q17", label: null },
			{ kind: "mention", ref: "k1/Ab3dEf9Q", label: "x" },
		]);
		expect(item?.links).toEqual(contentLinks(item?.content ?? ""));
		const embed = parse("- ![[k1/Ab3dEf9Q|x]]").items[0];
		expect(embed?.refs).toEqual([{ kind: "embed", ref: "k1/Ab3dEf9Q", label: "x" }]);
	});
});

describe("rewrite", () => {
	test("references take their stored form; a display text equal to the title goes", () => {
		const contents = [
			"see [[Q17]] and [[k1/Ab3dEf9Q|Old title]] and [[k1/Ab3dEf9Q|my words]]",
			"| a | [[Q17\\|Old title]] |\n| --- | --- |\n| x | y |",
			"![[Q17]]",
			"code `[[Q17]]` and [[unknown]]",
		];
		const targets = {
			Q17: { ref: "k1/Ab3dEf9Q", title: "Old title" },
			"k1/Ab3dEf9Q": { ref: "k1/Ab3dEf9Q", title: "Old title" },
		};
		const out = runEditTextJob({ kind: "rewrite", contents, targets });
		expect(out.map((r) => r.content)).toEqual([
			"see [[k1/Ab3dEf9Q]] and [[k1/Ab3dEf9Q]] and [[k1/Ab3dEf9Q|my words]]",
			"| a | [[k1/Ab3dEf9Q]] |\n| --- | --- |\n| x | y |",
			"![[k1/Ab3dEf9Q]]",
			"code `[[Q17]]` and [[unknown]]",
		]);
		for (const r of out) {
			expect(normalizeBlock(r.content).content).toBe(r.content);
			expect(r.links).toEqual(contentLinks(r.content));
		}
	});
});

describe("link titles in reads", () => {
	const titles = new Map([["k1/Ab3dEf9Q", "Target"]]);

	test("only real links get the title", () => {
		expect(withLinkTitles("a [[k1/Ab3dEf9Q]] b", ["k1/Ab3dEf9Q"], titles)).toBe(
			"a [[k1/Ab3dEf9Q|Target]] b",
		);
		expect(withLinkTitles("`[[k1/Ab3dEf9Q]]` [[k1/Ab3dEf9Q]]", ["k1/Ab3dEf9Q"], titles)).toBe(
			"`[[k1/Ab3dEf9Q]]` [[k1/Ab3dEf9Q|Target]]",
		);
		expect(withLinkTitles("\\[[k1/Ab3dEf9Q]]", ["k1/Ab3dEf9Q"], titles)).toBe("\\[[k1/Ab3dEf9Q]]");
		expect(withLinkTitles("```\n[[k1/Ab3dEf9Q]]\n```", ["k1/Ab3dEf9Q"], titles)).toBe(
			"```\n[[k1/Ab3dEf9Q]]\n```",
		);
		expect(withLinkTitles("![[k1/Ab3dEf9Q]]", ["k1/Ab3dEf9Q"], titles)).toBe(
			"![[k1/Ab3dEf9Q|Target]]",
		);
		expect(withLinkTitles("| [[k1/Ab3dEf9Q]] |\n| --- |", ["k1/Ab3dEf9Q"], titles)).toBe(
			"| [[k1/Ab3dEf9Q\\|Target]] |\n| --- |",
		);
		expect(withLinkTitles("a [[k1/Ab3dEf9Q|mine]]", ["k1/Ab3dEf9Q"], titles)).toBe(
			"a [[k1/Ab3dEf9Q|mine]]",
		);
	});

	test("what a read shows parses back to the same links", () => {
		const shown = withLinkTitles("x [[k1/Ab3dEf9Q]] y", ["k1/Ab3dEf9Q"], titles);
		expect(normalizeBlock(shown).content).toBe(shown);
		const [back] = runEditTextJob({
			kind: "rewrite",
			contents: [shown],
			targets: { "k1/Ab3dEf9Q": { ref: "k1/Ab3dEf9Q", title: "Target" } },
		});
		expect(back?.content).toBe("x [[k1/Ab3dEf9Q]] y");
	});

	test("display titles are one line, without brackets, at most 80 characters", () => {
		expect(linkDisplayTitle("  Fix [urgent]\tnow ")).toBe("Fix (urgent) now");
		expect(linkDisplayTitle("")).toBeNull();
		expect(Array.from(linkDisplayTitle("长".repeat(200)) ?? "")).toHaveLength(80);
	});
});

describe("runner", () => {
	const big = serializeMarkdownOutline(
		Array.from({ length: 60 }, (_, i) => ({
			content: `Item ${i} with **bold**, \`code\`, [[Q${i}]] and 中文内容。`.repeat(3),
			task: i % 3 === 0 ? { status: "todo" as const, assignee: null } : null,
			props: {},
			children: [],
		})),
	);
	const job: EditTextJob = { kind: "parse", inputs: [{ mode: "outline", text: big }], labels: [] };

	test("the worker gives exactly what the inline path gives", async () => {
		expect(Buffer.byteLength(big)).toBeGreaterThan(OUTLINE_EDIT_TEXT_LIMITS.inlineBytes);
		const inline = runEditTextJob(job);
		expect(await processEditText(job, { worker: true })).toEqual(inline);
		// By size: this job is large enough to go to the worker on its own.
		expect(await processEditText(job)).toEqual(inline);
	});

	test("a job past its time is abandoned; the next job gets a fresh worker", async () => {
		const error = await processEditText(job, { worker: true, timeoutMs: 1 }).catch((e) => e);
		expect(error).toBeInstanceOf(OutlineEditTextError);
		expect((error as OutlineEditTextError).code).toBe("OUTLINE_TEXT_TIMEOUT");
		expect(await processEditText(job, { worker: true })).toEqual(runEditTextJob(job));
	});

	test("too much text is refused before any work", async () => {
		const huge: EditTextJob = {
			kind: "parse",
			inputs: [{ mode: "outline", text: "x".repeat(OUTLINE_EDIT_TEXT_LIMITS.maxBytes + 1) }],
			labels: [],
		};
		const error = await processEditText(huge).catch((e) => e);
		expect((error as OutlineEditTextError).code).toBe("OUTLINE_TEXT_TOO_LARGE");
	});

	test("a cancelled call stops waiting", async () => {
		const controller = new AbortController();
		const pending = processEditText(job, { worker: true, signal: controller.signal });
		controller.abort();
		const error = await pending.catch((e) => e);
		expect(error).toBeInstanceOf(OutlineEditTextError);
		expect(await processEditText(job, { worker: true })).toEqual(runEditTextJob(job));
	});
});
