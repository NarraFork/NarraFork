/**
 * A delegated subagent's report as outline blocks (`report-text.ts`, outline P2 PR 9a): structure,
 * nothing read as outline syntax, large blocks cut, the 199 blocks / 120 KiB limits, and the same
 * result on the edit-text worker as inline.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { normalizeBlock } from "@shared/outline";
import { processEditText, stopEditTextWorker } from "../edit-text-runner";
import { contentLinks } from "../links";
import { convertReport, OUTLINE_REPORT_LIMITS, type ReportBlock } from "../report-text";

afterAll(() => stopEditTextWorker());

const convert = (text: string) => convertReport({ text, continued: "(cont.)" });

type Shape = string | { c: string; k: Shape[] };
function shape(blocks: readonly ReportBlock[]): Shape[] {
	return blocks.map((b) =>
		b.children.length > 0 ? { c: b.content, k: shape(b.children) } : b.content,
	);
}
function all(blocks: readonly ReportBlock[]): ReportBlock[] {
	return blocks.flatMap((b) => [b, ...all(b.children)]);
}
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("report structure", () => {
	test("headings hold their sections, by level; a list after a paragraph goes under it", () => {
		const r = convert(
			[
				"Summary first.",
				"# One",
				"Intro:",
				"",
				"- a",
				"  - a.1",
				"- b",
				"## One.Two",
				"Under two.",
				"#### Deep",
				"Under deep.",
				"### Three",
				"Under three.",
				"# Second top",
				"Points:",
				"- x",
				"",
				"Separate paragraph.",
				"- not under it? yes, right after it",
			].join("\n"),
		);
		expect(shape(r.blocks)).toEqual([
			"Summary first.",
			{
				c: "# One",
				k: [
					{ c: "Intro:", k: [{ c: "a", k: ["a.1"] }, "b"] },
					{
						c: "## One.Two",
						k: [
							"Under two.",
							{ c: "**Deep**", k: ["Under deep."] },
							{ c: "### Three", k: ["Under three."] },
						],
					},
				],
			},
			{
				c: "# Second top",
				k: [
					{ c: "Points:", k: ["x"] },
					{ c: "Separate paragraph.", k: ["not under it? yes, right after it"] },
				],
			},
		]);
		expect(r.count).toBe(all(r.blocks).length);
		expect(r.omittedBytes).toBe(0);
	});

	test("nothing is outline syntax: boxes, links, embeds, properties and mentions stay text", () => {
		const r = convert(
			[
				"- [ ] open item @agent:x",
				"- [x] done item",
				"- [/] doing item",
				"- see [[Kx81mPqa/Ab3dEf9Q|a block]] and ![[embed me]]",
				"- key:: value",
				"",
				"![[a whole embed]]",
			].join("\n"),
		);
		expect(shape(r.blocks)).toEqual([
			"[ ] open item @agent:x",
			"[x] done item",
			"[/] doing item",
			"see \\[[Kx81mPqa/Ab3dEf9Q|a block]] and !\\[[embed me]]",
			"key:: value",
			"!\\[[a whole embed]]",
		]);
		for (const block of all(r.blocks)) {
			expect(block.links).toEqual([]);
			expect(contentLinks(block.content)).toEqual([]);
			expect(normalizeBlock(block.content).content).toBe(block.content);
		}
	});

	test("a link in a table cell or a heading stays text too", () => {
		const r = convert(
			"# See [[Kx81mPqa/Ab3dEf9Q]]\n| case | where |\n|---|---|\n| race | [[Kx81mPqa/Zz9yXw8V]] |",
		);
		expect(shape(r.blocks)).toEqual([
			{
				c: "# See \\[[Kx81mPqa/Ab3dEf9Q]]",
				k: ["| case | where |\n| --- | --- |\n| race | \\[[Kx81mPqa/Zz9yXw8V]] |"],
			},
		]);
		for (const block of all(r.blocks)) expect(contentLinks(block.content)).toEqual([]);
	});

	test("tables, quotes and code are one block each", () => {
		const r = convert(
			"| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n> more\n\n```sh\nls\n# not a heading\n```",
		);
		expect(shape(r.blocks)).toEqual([
			"| a | b |\n| --- | --- |\n| 1 | 2 |",
			"> quoted\n> more",
			"```sh\nls\n# not a heading\n```",
		]);
	});

	test("an empty report has no blocks", () => {
		expect(convert("")).toEqual({ blocks: [], count: 0, bytes: 0, omittedBytes: 0 });
		expect(convert("\n\n   \n").count).toBe(0);
	});
});

describe("large blocks and the limits", () => {
	test("a long code block becomes several code blocks; a long paragraph pieces marked (cont.); a long table repeats its header", () => {
		const code = Array.from({ length: 1200 }, (_, i) => `const v${i} = ${i}; // ${"c".repeat(10)}`);
		const para = Array.from({ length: 900 }, (_, i) => `line ${i} of a long paragraph`);
		const rows = Array.from({ length: 1500 }, (_, i) => `| r${i} | v${i} |`);
		const r = convert(
			`\`\`\`ts\n${code.join("\n")}\n\`\`\`\n\n${para.join("\n")}\n\n| a | b |\n|---|---|\n${rows.join("\n")}`,
		);
		const blocks = all(r.blocks);
		for (const block of blocks) {
			expect(bytes(block.content)).toBeLessThanOrEqual(OUTLINE_REPORT_LIMITS.maxBlockBytes);
			expect(normalizeBlock(block.content).content).toBe(block.content);
		}
		const codes = blocks.filter((b) => b.content.startsWith("```ts\n"));
		expect(codes.length).toBeGreaterThan(1);
		expect(codes.map((b) => b.content.split("\n").slice(1, -1).join("\n")).join("\n")).toBe(
			code.join("\n"),
		);
		const paras = blocks.filter((b) => b.content.includes("of a long paragraph"));
		expect(paras.length).toBeGreaterThan(1);
		expect(paras[0]?.content.startsWith("line 0")).toBe(true);
		for (const p of paras.slice(1)) expect(p.content.startsWith("(cont.) line")).toBe(true);
		const tables = blocks.filter((b) => b.content.startsWith("| a | b |\n| --- | --- |\n"));
		expect(tables.length).toBeGreaterThan(1);
		expect(r.omittedBytes).toBe(0);
	});

	test("at most 199 blocks: one kept for the line saying what was left out", () => {
		const r = convert(Array.from({ length: 400 }, (_, i) => `- item ${i}`).join("\n"));
		expect(r.count).toBe(OUTLINE_REPORT_LIMITS.maxBlocks - 1);
		expect(r.blocks.at(-1)?.content).toBe(`item ${OUTLINE_REPORT_LIMITS.maxBlocks - 2}`);
		expect(r.omittedBytes).toBeGreaterThan(0);
		// Exactly the limit fits whole.
		const full = convert(
			Array.from({ length: OUTLINE_REPORT_LIMITS.maxBlocks }, (_, i) => `- item ${i}`).join("\n"),
		);
		expect(full.count).toBe(OUTLINE_REPORT_LIMITS.maxBlocks);
		expect(full.omittedBytes).toBe(0);
	});

	test("at most 120 KiB, a block before the blocks under it; input past what can fit is counted, not parsed", () => {
		const sections = Array.from(
			{ length: 30 },
			(_, i) => `# Section ${i}\n${"word ".repeat(1200)}\n- point ${i}`,
		);
		const r = convert(sections.join("\n\n"));
		expect(r.bytes).toBeLessThanOrEqual(
			OUTLINE_REPORT_LIMITS.maxBytes - OUTLINE_REPORT_LIMITS.omissionReserveBytes,
		);
		expect(r.omittedBytes).toBeGreaterThan(0);
		// Document order: every kept heading's own text is kept before what is under it.
		expect(r.blocks.every((b) => b.content.startsWith("# Section"))).toBe(true);
		const huge = "x ".repeat(300 * 1024);
		const big = convert(huge);
		expect(big.omittedBytes).toBeGreaterThan(bytes(huge) - OUTLINE_REPORT_LIMITS.maxBytes);
		expect(big.bytes).toBeLessThanOrEqual(OUTLINE_REPORT_LIMITS.maxBytes);
	});

	test("the worker gives what the inline path gives", async () => {
		const text = `# Big\n${Array.from({ length: 300 }, (_, i) => `- [ ] item ${i} [[x]]`).join("\n")}`;
		const job = { kind: "report" as const, text, continued: "（续）" };
		const inline = await processEditText(job, { worker: false });
		const worker = await processEditText(job, { worker: true });
		expect(worker).toEqual(inline);
		expect(inline.count).toBe(OUTLINE_REPORT_LIMITS.maxBlocks - 1);
	});
});
