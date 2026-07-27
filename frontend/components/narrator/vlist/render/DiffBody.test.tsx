/**
 * DiffBody.test.tsx — Render contract for the virtual list's diff body.
 *
 * These are the three things that were visibly wrong before:
 *   1. NO LINE NUMBERS — the gutter did not exist, so there was nothing to read
 *      positions from. It must now be a fixed-width two-column `oldNo newNo±`.
 *   2. WRONG BACKGROUNDS — added/removed rows only tinted the TEXT colour. They
 *      must paint a full-row background, with different values per colour scheme.
 *   3. EVERYTHING LOOKED CHANGED — unchanged lines were emitted as removed+added,
 *      so no row was ever context and word-level tints never appeared.
 *
 * The tests render through the real component and assert on the produced DOM, so
 * they fail if the gutter, the backgrounds or the word tints regress.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MantineProvider } from "@mantine/core";
import { computeDiff } from "@shared/pretext-layout/diff-core";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { cappedUsefulLines } from "../measure/measure-tool-call";
import { __TEST__DiffLines } from "./RenderToolCall";

let parse: (html: string) => Element;

beforeAll(() => {
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

interface RenderOpts {
	oldStr: string;
	newStr: string;
	startLine?: number;
	lineNumberPrefix?: string;
	lang?: string;
	/** Which scheme to mount under (the palette itself is CSS-variable driven). */
	scheme?: "dark" | "light";
	/** The measured box cap (px) — decides the render layer's row budget. */
	cap?: number;
	/** Injected truncation wording (a literal `{count}` is substituted). */
	truncatedLabel?: string;
}

/** Render a node inside a Mantine provider pinned to one colour scheme. */
function renderInProvider(node: React.ReactNode, scheme: "dark" | "light"): Element {
	return parse(
		renderToStaticMarkup(<MantineProvider forceColorScheme={scheme}>{node}</MantineProvider>),
	);
}

/** Render the diff body the way the tool card does, via the measured block data. */
function renderDiff({
	oldStr,
	newStr,
	startLine,
	lineNumberPrefix,
	lang,
	scheme = "dark",
	cap,
	truncatedLabel,
}: RenderOpts): Element {
	const lines = computeDiff(oldStr, newStr, startLine ?? 1);
	const text = lines
		.map((l) => `${l.type === "removed" ? "-" : l.type === "added" ? "+" : " "}${l.content}`)
		.join("\n");
	const data: Record<string, unknown> = { diffLines: lines };
	if (startLine != null) data.diffLineNoWidth = 3;
	if (lineNumberPrefix != null) {
		data.diffLineNoWidth = 3;
		data.diffLineNumberPrefix = lineNumberPrefix;
	}
	if (cap != null) data.cap = cap;
	return renderInProvider(__TEST__DiffLines({ text, lang, data, truncatedLabel }), scheme);
}

const rowsOf = (root: Element) => Array.from(root.querySelectorAll("[data-diff-row]"));
const gutterOf = (row: Element) => row.querySelector("[data-diff-gutter]")?.textContent ?? "";
const styleOf = (el: Element) => el.getAttribute("style") ?? "";

describe("diff gutter (line numbers)", () => {
	it("renders a two-column oldNo/newNo gutter with the right markers", () => {
		const root = renderDiff({ oldStr: "a\nb", newStr: "a\nB", startLine: 1 });
		const rows = rowsOf(root);
		expect(rows.map((r) => r.getAttribute("data-diff-row"))).toEqual([
			"context",
			"removed",
			"added",
		]);
		expect(rows.map(gutterOf)).toEqual([
			"  1   1 ", // context: numbered on both sides
			"  2    -", // removed: old side only
			"      2+", // added: new side only
		]);
	});

	it("keeps every gutter the same width so code starts at one column", () => {
		const root = renderDiff({ oldStr: "a\nb\nc", newStr: "a\nB\nc", startLine: 98 });
		const widths = new Set(rowsOf(root).map((r) => gutterOf(r).length));
		expect(widths.size).toBe(1);
	});

	it("offsets the numbers by the edit's real start line", () => {
		const root = renderDiff({ oldStr: "a\nb", newStr: "a\nB", startLine: 42 });
		expect(gutterOf(rowsOf(root)[0] as Element)).toContain("42");
	});

	it("shows provisional numbers with the xx prefix while streaming", () => {
		const root = renderDiff({
			oldStr: "a\nb",
			newStr: "a\nb",
			startLine: 1,
			lineNumberPrefix: "xx",
		});
		expect(gutterOf(rowsOf(root)[0] as Element)).toContain("xx1");
	});

	it("falls back to a bare marker column when there are no line numbers", () => {
		const root = renderDiff({ oldStr: "a", newStr: "b" });
		// No diffLineNoWidth → single-character marker gutter (chunked parity).
		expect(rowsOf(root).map(gutterOf)).toEqual(["-", "+"]);
	});

	it("marks the gutter unselectable so copying yields code, not line numbers", () => {
		const root = renderDiff({ oldStr: "a\nb", newStr: "a\nB", startLine: 1 });
		for (const row of rowsOf(root)) {
			const gutter = row.querySelector("[data-diff-gutter]");
			expect(styleOf(gutter as Element)).toContain("user-select:none");
		}
	});
});

describe("diff row backgrounds", () => {
	it("paints a full-row background on added and removed rows, none on context", () => {
		const root = renderDiff({ oldStr: "a\nb", newStr: "a\nB", startLine: 1 });
		const [context, removed, added] = rowsOf(root);
		// The bug: these used to set only `color`, never a background.
		expect(styleOf(context as Element)).not.toContain("background");
		expect(styleOf(removed as Element)).toContain("background");
		expect(styleOf(added as Element)).toContain("background");
	});

	it("uses distinct removed and added backgrounds", () => {
		const root = renderDiff({ oldStr: "a", newStr: "b" });
		const [removed, added] = rowsOf(root);
		const removedBg = styleOf(removed as Element);
		const addedBg = styleOf(added as Element);
		expect(removedBg).not.toBe(addedBg);
		expect(removedBg).toContain("--vlist-diff-removed-bg");
		expect(addedBg).toContain("--vlist-diff-added-bg");
	});

	/**
	 * The palette is CSS-variable driven, so the per-scheme values live in
	 * vlist-markdown.css rather than in a JS branch. The rendered markup is
	 * therefore scheme-independent (that is the point: a theme switch no longer
	 * needs a re-render), and the two-scheme contract is asserted on the stylesheet.
	 */
	it("renders scheme-independent markup, leaving the palette to the cascade", () => {
		const dark = rowsOf(renderDiff({ oldStr: "a", newStr: "b", scheme: "dark" }));
		const light = rowsOf(renderDiff({ oldStr: "a", newStr: "b", scheme: "light" }));
		expect(styleOf(light[0] as Element)).toBe(styleOf(dark[0] as Element));
		expect(styleOf(light[0] as Element)).toContain("background");
	});

	it("defines a distinct value per scheme for every diff variable", () => {
		const css = readFileSync(join(import.meta.dir, "..", "vlist-markdown.css"), "utf8");
		const readVar = (block: string, name: string) =>
			new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
		const lightStart = css.indexOf(':root[data-mantine-color-scheme="light"]');
		expect(lightStart).toBeGreaterThan(-1);
		const darkBlock = css.slice(0, lightStart);
		const lightBlock = css.slice(lightStart);
		for (const name of [
			"--vlist-diff-added-bg",
			"--vlist-diff-removed-bg",
			"--vlist-diff-added-word-bg",
			"--vlist-diff-removed-word-bg",
		]) {
			const dark = readVar(darkBlock, name);
			const light = readVar(lightBlock, name);
			expect(dark).toBeTruthy();
			expect(light).toBeTruthy();
			// Mantine's `*-light` variants wash out on a light surface, so the light
			// scheme must carry its own higher-opacity value.
			expect(light).not.toBe(dark);
		}
	});

	it("paints word tints in both schemes", () => {
		for (const scheme of ["dark", "light"] as const) {
			const root = renderDiff({
				oldStr: "const a = 1;",
				newStr: "const a = 2;",
				startLine: 1,
				scheme,
			});
			const tinted = Array.from(root.querySelectorAll("span")).filter((s) =>
				styleOf(s).includes("background"),
			);
			expect(tinted.length).toBeGreaterThan(0);
		}
	});
});

/**
 * The render layer paints only as many rows as the capped scroll box can reveal.
 * The box HEIGHT is owned by the measure layer (measureDiffContentHeight), so the
 * row budget cannot desync the two — and it is deliberately larger than the point
 * where measure stops counting (`cappedUsefulLines(cap)` ≈ cap/15 + 1) so only
 * bodies measure ALREADY treats as overflowing can be truncated.
 */
describe("diff row budget", () => {
	const bigDiff = (rows: number) => {
		const oldStr = Array.from({ length: rows }, (_, i) => `old ${i}`).join("\n");
		const newStr = Array.from({ length: rows }, (_, i) => `new ${i}`).join("\n");
		return { oldStr, newStr };
	};

	it("does not truncate a body whose rows all fit the measured height", () => {
		// 6 rows at a 200px cap: measure counts them exactly, so every row must paint.
		const root = renderDiff({ ...bigDiff(3), startLine: 1, cap: 200 });
		expect(rowsOf(root)).toHaveLength(6);
		expect(root.textContent).not.toContain("more rows");
	});

	it("caps the painted rows for a diff far taller than its box", () => {
		const root = renderDiff({ ...bigDiff(250), startLine: 1, cap: 200 });
		const rows = rowsOf(root);
		// 200px / 15px per line ≈ 14 visible rows × 4 screens of overscan = 56.
		expect(rows.length).toBeLessThanOrEqual(56);
		// Still far more than the box can show, so nothing visible is lost.
		expect(rows.length).toBeGreaterThan(Math.ceil(200 / 15));
	});

	it("keeps the row budget near the node ceiling for a huge cap", () => {
		// A plan-sized cap (0.85 × viewport) must not scale the node count with the overscan
		// multiplier: 4000px / 15px × 4 screens would be 1068 rows. The budget stays at the
		// measure layer's own threshold for that cap (268), which is the smallest count that
		// still keeps render and measure consistent — see diffRenderRowLimit.
		const root = renderDiff({ ...bigDiff(400), startLine: 1, cap: 4_000 });
		expect(rowsOf(root).length).toBe(cappedUsefulLines(4_000));
	});

	it("never paints fewer rows than the measure layer counts, at any cap", () => {
		// The height-safety argument is "truncation only happens on a body measure already
		// classified as overflowing". That holds only while the row budget stays at or above
		// `cappedUsefulLines(cap)` — the point measure stops counting and returns `cap`. A flat
		// 200-row ceiling silently broke this past cap ≈ 2986px: measure would return an exact
		// 250-row height while render painted 200, leaving a ~730px hole. Assert the relation
		// across the regime boundary instead of trusting one cap value.
		//
		// `MAX_DIFF_LINES` bounds how many rows can exist at all, so the reachable requirement is
		// min(threshold, available) — a diff that cannot produce 535 rows can hardly be faulted
		// for not painting them.
		for (const cap of [200, 750, 3_000, 4_000, 8_000]) {
			const usefulLines = cappedUsefulLines(cap);
			// Ask for more rows than either bound so the budget, not the input, is what is measured.
			const source = bigDiff(usefulLines);
			const available = computeDiff(source.oldStr, source.newStr, 1).length;
			const rows = rowsOf(renderDiff({ ...source, startLine: 1, cap }));
			expect(rows.length).toBeGreaterThanOrEqual(Math.min(usefulLines, available));
		}
	});

	it("reports how many rows were left out, in the injected wording", () => {
		const root = renderDiff({
			...bigDiff(250),
			startLine: 1,
			cap: 200,
			truncatedLabel: "省略 {count} 行",
		});
		const hidden = 500 - rowsOf(root).length;
		expect(root.textContent).toContain(`省略 ${hidden} 行`);
	});

	it("applies the same budget to the plain +/- fallback", () => {
		const text = Array.from({ length: 400 }, (_, i) => `+line ${i}`).join("\n");
		const root = renderInProvider(
			__TEST__DiffLines({ text, lang: undefined, data: { cap: 200 } }),
			"dark",
		);
		// The fallback emits plain divs (no data-diff-row), so count them directly.
		const painted = Array.from(root.querySelectorAll("div")).filter((d) =>
			styleOf(d).includes("pre-wrap"),
		);
		expect(painted.length).toBeLessThanOrEqual(56);
		expect(root.textContent).toContain("more rows not shown");
	});
});

describe("diff word-level highlighting", () => {
	it("tints only the changed words inside a modified pair", () => {
		const root = renderDiff({
			oldStr: "const a = 1;",
			newStr: "const a = 2;",
			startLine: 1,
		});
		const [removed, added] = rowsOf(root);
		// The unchanged prefix must be present but NOT tinted.
		const removedTinted = Array.from((removed as Element).querySelectorAll("span"))
			.filter((s) => styleOf(s).includes("background"))
			.map((s) => s.textContent ?? "");
		const addedTinted = Array.from((added as Element).querySelectorAll("span"))
			.filter((s) => styleOf(s).includes("background"))
			.map((s) => s.textContent ?? "");
		expect(removedTinted.join("")).toContain("1");
		expect(addedTinted.join("")).toContain("2");
		expect(removedTinted.join("")).not.toContain("const");
		expect(addedTinted.join("")).not.toContain("const");
	});

	it("still renders the row's full text when words are tinted", () => {
		const root = renderDiff({ oldStr: "const a = 1;", newStr: "const a = 2;", startLine: 1 });
		const [removed, added] = rowsOf(root);
		// Gutter + content; strip the gutter to compare the code itself.
		expect((removed as Element).textContent).toContain("const a = 1;");
		expect((added as Element).textContent).toContain("const a = 2;");
	});

	it("leaves unpaired insertions untinted at word level", () => {
		const root = renderDiff({ oldStr: "a\n", newStr: "a\nb\n", startLine: 1 });
		const inserted = rowsOf(root).find((r) => r.textContent?.includes("b"));
		const tinted = Array.from((inserted as Element).querySelectorAll("span")).filter((s) =>
			styleOf(s).includes("background"),
		);
		// No counterpart to diff against → no word tints, just the row background.
		expect(tinted).toHaveLength(0);
	});
});

describe("diff content fidelity", () => {
	it("shows unchanged lines ONCE, as context", () => {
		const root = renderDiff({ oldStr: "keep\ndrop", newStr: "keep\nadd", startLine: 1 });
		const rows = rowsOf(root);
		const keepRows = rows.filter((r) => r.textContent?.includes("keep"));
		// The old behaviour emitted `keep` twice (once removed, once added).
		expect(keepRows).toHaveLength(1);
		expect(keepRows[0]?.getAttribute("data-diff-row")).toBe("context");
	});

	it("preserves indentation in the rendered rows", () => {
		const root = renderDiff({ oldStr: "\t\tconst a = 1;", newStr: "\t\tconst a = 2;" });
		expect(root.textContent).toContain("\t\tconst a = 1;");
	});

	it("wraps rows rather than clipping them", () => {
		const root = renderDiff({ oldStr: "a", newStr: "b" });
		for (const row of rowsOf(root)) {
			expect(styleOf(row)).toContain("pre-wrap");
		}
	});

	it("renders the plain +/- fallback when no structured rows are carried", () => {
		const root = renderInProvider(
			__TEST__DiffLines({ text: "-a\n+b", lang: undefined, data: undefined }),
			"dark",
		);
		// No data-diff-row markers (that is the structured path), but the content and
		// the row backgrounds must still be there.
		expect(root.textContent).toContain("a");
		expect(root.textContent).toContain("b");
		expect(root.innerHTML).toContain("background");
	});
});
