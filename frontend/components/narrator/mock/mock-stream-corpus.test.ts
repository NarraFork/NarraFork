/**
 * mock-stream-corpus.test.ts — Runs the REAL markdown pipeline over the corpus
 * and asserts on the prepared blocks it produces.
 *
 * TEMPORARY MODULE (see ./README-REMOVAL.md).
 *
 * Why this exists separately from the regex checks in mock-stream-script.test.ts:
 * a source-level `expect(text).toContain("```mermaid")` proves the characters are
 * present, NOT that the parser lifted them into their own block. Those differ in
 * practice — while writing this corpus, two display formulas silently degraded to
 * plain paragraphs:
 *
 *   1. A continuation line starting with `+ ` is lexed by marked as a LIST, which
 *      splits the `$$…$$` region in half.
 *   2. A continuation line indented by 4 spaces matches `CODE_SEGMENT_PATTERN`
 *      (an indented code block), and math is never detected inside a code region.
 *
 * Both produced a corpus that *looked* correct and covered nothing. This file is
 * the guard: it asserts on block KINDS, so a future edit that reintroduces either
 * trap fails here instead of quietly reducing coverage.
 *
 * A canvas stub is installed first (pretext measures text through a canvas, which
 * bun's runtime lacks), and KaTeX is supplied so display/inline math is measured
 * rather than degraded to literal source.
 */

import { afterAll, describe, expect, it } from "bun:test";

// The canvas stub is reached by a DYNAMIC import on purpose: `vlist-isolation.guard`
// forbids any static import of `vlist/` from outside that directory (with the
// virtual-list flag off, vlist code must never even be fetched). A top-level await
// still guarantees the ordering this file needs — the stub is installed before any
// pretext-backed module is loaded below.
//
// The stub is GLOBAL, so it is disposed after this file to avoid leaking into tests
// that assert on a canvas-free environment.
const { installCanvasStub } = await import("../vlist/measure/test-canvas-stub");
const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

const katexModule = await import("katex");
const math = { katex: katexModule.default as never };

const { REASONING_ROUNDS, TEXT_ROUNDS, TOOL_ROUNDS, MOCK_ROUND_COUNT } = await import(
	"./mock-stream-corpus"
);
const { parseMarkdownToPreparedBlocks } = await import("@shared/pretext-layout/parse-markdown");

// biome-ignore lint/suspicious/noExplicitAny: prepared-block union is read structurally here
type AnyBlock = any;

/** Every prepared block across every round, in order. */
function allBlocks(): AnyBlock[] {
	const out: AnyBlock[] = [];
	for (const body of TEXT_ROUNDS) {
		out.push(...(parseMarkdownToPreparedBlocks(body, math) as AnyBlock[]));
	}
	return out;
}

/** `kind` counts, with `unknown` split by its tag (katex vs mermaid). */
function blockKindCounts(): Map<string, number> {
	const counts = new Map<string, number>();
	for (const block of allBlocks()) {
		const key = block.kind === "unknown" ? `unknown:${block.tag}` : String(block.kind);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

describe("corpus produces every prepared-block kind the pipeline has a path for", () => {
	it("lifts BOTH display formulas into their own measured katex blocks", () => {
		// The trap this guards: a `+ `-leading or 4-space-indented continuation line
		// makes marked lex the region as a list / indented code, and the formula
		// degrades to a plain paragraph with no error anywhere.
		expect(blockKindCounts().get("unknown:katex")).toBe(2);
	});

	it("lifts the mermaid fence into an unknown-height block", () => {
		// The one intrinsically unpredictable block: its height is known only after
		// paint, which is the most interesting case for scroll-anchor tuning.
		expect(blockKindCounts().get("unknown:mermaid")).toBe(1);
	});

	it("produces fenced code blocks and tables", () => {
		const counts = blockKindCounts();
		expect(counts.get("code")).toBeGreaterThanOrEqual(2);
		expect(counts.get("table")).toBeGreaterThanOrEqual(3);
	});

	it("produces a thematic rule block", () => {
		expect(blockKindCounts().get("rule")).toBeGreaterThanOrEqual(1);
	});

	it("produces inline math atoms inside prose", () => {
		let fragments = 0;
		for (const block of allBlocks()) {
			if (block.kind !== "inline") continue;
			fragments += (block.mathHtmls ?? []).filter(Boolean).length;
		}
		// Several `$…$` formulas across the cost-model section and the tables.
		expect(fragments).toBeGreaterThanOrEqual(6);
	});

	it("renders every formula without a KaTeX strict-mode warning", () => {
		// KaTeX emits an inter-word space inside a `\text{}` label as U+00A0, and the
		// geometry prober then re-measures that character and warns
		// (`Unrecognized Unicode character " " (160)`). It is only a warning, but it
		// means one glyph's advance was guessed rather than measured — so the corpus
		// keeps such labels single-word. Caught here rather than left as console noise.
		const original = console.warn;
		let warned = "";
		console.warn = (...args: unknown[]) => {
			warned += args.join(" ");
		};
		try {
			for (const body of TEXT_ROUNDS) parseMarkdownToPreparedBlocks(body, math);
		} finally {
			console.warn = original;
		}
		expect(warned).toBe("");
	});

	it("renders every formula without a KaTeX error", () => {
		// A formula that fails to parse degrades to its literal source, which
		// measures differently — silent coverage loss again.
		const errors: string[] = [];
		for (const block of allBlocks()) {
			if (block.kind === "unknown" && block.error) errors.push(String(block.error));
			for (const fragment of block.mathHtmls ?? []) {
				if (fragment?.error) errors.push(String(fragment.error));
			}
		}
		expect(errors).toEqual([]);
	});

	it("puts math inside table cells (a distinct measurement path)", () => {
		const tablesWithMath = allBlocks().filter(
			(block) => block.kind === "table" && JSON.stringify(block).includes("katex"),
		);
		expect(tablesWithMath.length).toBeGreaterThanOrEqual(1);
	});
});

describe("corpus round structure", () => {
	it("defines the same number of rounds for each channel", () => {
		expect(REASONING_ROUNDS).toHaveLength(MOCK_ROUND_COUNT);
		expect(TEXT_ROUNDS).toHaveLength(MOCK_ROUND_COUNT);
		expect(TOOL_ROUNDS).toHaveLength(MOCK_ROUND_COUNT);
	});

	it("gives every round a non-trivial reasoning and text body", () => {
		for (const body of REASONING_ROUNDS) expect(body.length).toBeGreaterThan(200);
		for (const body of TEXT_ROUNDS) expect(body.length).toBeGreaterThan(200);
	});

	it("gives every round at least one tool call", () => {
		for (const specs of TOOL_ROUNDS) expect(specs.length).toBeGreaterThan(0);
	});

	it("keeps reasoning free of markdown structure (it renders as prose)", () => {
		for (const body of REASONING_ROUNDS) {
			expect(body).not.toContain("```");
			expect(body).not.toMatch(/^#{1,6} /m);
			expect(body).not.toMatch(/^\| /m);
		}
	});
});

describe("tool specs are shaped for the real classifiers", () => {
	const specs = TOOL_ROUNDS.flat();

	it("streams only fields that exist on the resolved input", () => {
		for (const spec of specs) {
			for (const field of spec.streamFields) {
				expect(Object.hasOwn(spec.input, field)).toBe(true);
			}
		}
	});

	it("gives every tool a non-empty terminal output string", () => {
		for (const spec of specs) {
			expect(typeof spec.output).toBe("string");
			expect(spec.output.length).toBeGreaterThan(0);
		}
	});

	it("renders the plan body as markdown (ExitPlanMode → plan cap)", () => {
		const plan = specs.find((spec) => spec.toolName === "ExitPlanMode");
		expect(plan).toBeDefined();
		const body = String(plan?.input.plan);
		expect(body).toMatch(/^#{2,3} /m);
		// A plan carries math too, so the plan card's markdown path is exercised.
		expect(body).toMatch(/\$[^$\n]+\$/);
	});

	it("writes a parseable task queue so the spec-tasks board renders", () => {
		const write = specs.find(
			(spec) => spec.toolName === "Write" && spec.input.file_path === "spec://tasks.json",
		);
		expect(write).toBeDefined();
		const parsed = JSON.parse(String(write?.input.content)) as {
			tasks: Array<{ text: string; status: string; protected?: boolean }>;
		};
		expect(parsed.tasks.length).toBeGreaterThan(2);
		// Exercise every status glyph plus the protected lock lane.
		const statuses = new Set(parsed.tasks.map((task) => task.status));
		expect(statuses.has("done")).toBe(true);
		expect(statuses.has("doing")).toBe(true);
		expect(statuses.has("todo")).toBe(true);
		expect(parsed.tasks.some((task) => task.protected === true)).toBe(true);
	});

	it("shapes Edit with a real old/new pair so the diff body has both sides", () => {
		const edit = specs.find((spec) => spec.toolName === "Edit");
		const oldStr = String(edit?.input.old_string);
		const newStr = String(edit?.input.new_string);
		expect(oldStr.length).toBeGreaterThan(0);
		expect(newStr.length).toBeGreaterThan(0);
		expect(oldStr).not.toBe(newStr);
		// A multi-line hunk, so the diff gutter renders more than one row.
		expect(oldStr.split("\n").length).toBeGreaterThan(1);
		expect(newStr.split("\n").length).toBeGreaterThan(1);
	});

	it("covers the distinct card bodies, including a failing call", () => {
		const byName = new Map(specs.map((spec) => [spec.toolName, spec]));
		for (const name of [
			"Glob",
			"Read",
			"Grep",
			"Agent",
			"Edit",
			"Write",
			"Bash",
			"WebSearch",
			"ExitPlanMode",
		]) {
			expect(byName.has(name)).toBe(true);
		}
		expect(specs.some((spec) => spec.status === "fail")).toBe(true);
		// At least one tool streams stdout incrementally (the terminal transcript).
		expect(specs.some((spec) => spec.streamOutput === true)).toBe(true);
	});

	it("gives Read a totalLines metadata so its header shows the line count", () => {
		const read = specs.find((spec) => spec.toolName === "Read");
		expect(typeof read?.metadata?.totalLines).toBe("number");
	});
});
