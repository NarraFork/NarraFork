import { afterAll, describe, expect, test } from "bun:test";
import { installCanvasStub } from "../../frontend/components/narrator/vlist/measure/test-canvas-stub";
import { fileTargetFromHref, isLocalFileHref } from "../markdown-file-path";
import type { KatexRuntime } from "./katex-geometry";
import type { PreparedBlock, PreparedInlineBlock, PreparedTableCell } from "./prepared-block";

const disposeCanvasStub = installCanvasStub();
afterAll(disposeCanvasStub);
const { parseMarkdownToPreparedBlocks, parseMarkdownUnits } = await import("./parse-markdown");
const { materializeRichInlineLineRange, walkRichInlineLineRanges } = await import(
	"@chenglou/pretext/rich-inline"
);
// KaTeX's public declarations omit the private tree API used by our geometry layer.
const katex = (await import("katex")).default as unknown as KatexRuntime;
const context = { deviceId: "DeviceABC", cwd: "/repo" };

function inlineFlows(blocks: PreparedBlock[]): Array<PreparedInlineBlock | PreparedTableCell> {
	return blocks.flatMap<PreparedInlineBlock | PreparedTableCell>((block) => {
		if (block.kind === "inline") return [block];
		if (block.kind === "table") return [...block.header, ...block.rows.flat()];
		return [];
	});
}

function hrefs(blocks: PreparedBlock[]) {
	return inlineFlows(blocks).flatMap((block) => block.hrefs.filter((href) => href !== null));
}

describe("prepared markdown file links", () => {
	test("keeps path selections and devices in authored links across code, lists and tables", () => {
		const blocks = parseMarkdownToPreparedBlocks(
			[
				"[src/a.ts](src/a.ts:2:3-4:5) and [`docs/my notes.md`](docs/my%20notes.md#L6-L8)",
				"- [file](file:///tmp/b.ts#L9)",
				"| File |\n|---|\n| [remote](nf-file://open?device=RemoteCase&path=%2Fapp%2Fc.ts#L10) |",
			].join("\n\n"),
		);
		const found = [...new Set(hrefs(blocks))];
		expect(found).toHaveLength(4);
		expect(found.filter(isLocalFileHref)).toHaveLength(2);
		expect(found.map((href) => fileTargetFromHref(href, context))).toEqual([
			{
				deviceId: "DeviceABC",
				path: "/repo/src/a.ts",
				selection: { startLineNumber: 2, startColumn: 3, endLineNumber: 4, endColumn: 5 },
			},
			{
				deviceId: "DeviceABC",
				path: "/repo/docs/my notes.md",
				selection: { startLineNumber: 6, startColumn: 1, endLineNumber: 9, endColumn: 1 },
			},
			{
				deviceId: "DeviceABC",
				path: "/tmp/b.ts",
				selection: { startLineNumber: 9, startColumn: 1, endLineNumber: 10, endColumn: 1 },
			},
			{
				deviceId: "RemoteCase",
				path: "/app/c.ts",
				selection: { startLineNumber: 10, startColumn: 1, endLineNumber: 11, endColumn: 1 },
			},
		]);
	});

	test("never autolinks any explicit link label, including sanitized destinations", () => {
		for (const destination of ["https://example.com/", "#fragment", "javascript:alert(1)"]) {
			const source = `[src/a.ts **src/b.ts** \`src/c.ts\`](${destination})`;
			const found = hrefs(parseMarkdownToPreparedBlocks(source));
			expect(found.some(isLocalFileHref)).toBe(false);
			expect([...new Set(found)]).toEqual(
				destination.startsWith("javascript:") ? [] : [destination],
			);
		}
		const reference = "[src/a.ts `src/b.ts`][ref]\n\n[ref]: data:text/plain,rejected";
		expect(hrefs(parseMarkdownToPreparedBlocks(reference))).toEqual([]);
	});

	test("keeps bare prose, inline code, fences, image labels and HTML blocks unlinked", () => {
		for (const source of [
			"核对：实际调用只剩diff-core.test.ts、DiffView.tsx中的computeDiff。",
			"src/a.ts:2 /tmp/b.ts C:/repo/c.ts",
			"`中文diff-core.test.ts`",
			"- src/list.ts\n\n| File |\n|---|\n| src/table.ts |",
			"`cat src/a.ts --flag`",
			"Before <span>src/inline.ts</span> after.",
			"```ts\nsrc/a.ts:2\n```",
			"![src/a.ts](image.png)",
			'<div title="src/a.ts">src/b.ts</div>',
		]) {
			expect(hrefs(parseMarkdownToPreparedBlocks(source)), source).toEqual([]);
		}
	});

	test("converts only validated special destinations to markers", () => {
		for (const target of [
			"file:///tmp/a.ts#L2-L3",
			"C:/repo/a.ts#L2-L3",
			"nf-file://open?device=RemoteCase&path=%2Fapp%2Fa.ts#L2-L3",
			"nf-file://open?device=RemoteCase&amp;path=%2Fapp%2Fa.ts#L2-L3",
		]) {
			const [href] = hrefs(parseMarkdownToPreparedBlocks(`[file](${target})`));
			expect(isLocalFileHref(href), target).toBe(true);
			expect(fileTargetFromHref(href, context)?.selection).toEqual({
				startLineNumber: 2,
				startColumn: 1,
				endLineNumber: 4,
				endColumn: 1,
			});
		}
		for (const target of [
			"file://other/tmp/a.ts",
			"nf-file://open?device=RemoteCase&path=relative.ts",
			"nf-file://open?device=RemoteCase&path=%2Fapp%2Fa.ts&extra=true",
			"javascript:alert(1)",
			"java&Tab;script:alert(1)",
		]) {
			expect(hrefs(parseMarkdownToPreparedBlocks(`[src/a.ts](${target})`)), target).toEqual([]);
		}
	});

	test("preserves ordinary explicit targets and does not canonicalize application paths", () => {
		const targets = ["src/a.ts#L2", "/knowledge/e1", "e1", "#fragment", "https://example.com/"];
		expect(
			hrefs(parseMarkdownToPreparedBlocks(targets.map((href) => `[label](${href})`).join(" "))),
		).toEqual(targets);
	});

	test("leaves math atoms and fallback sources untouched beside authored links", () => {
		const [block] = inlineFlows(
			parseMarkdownToPreparedBlocks("[a](src/a.ts) $\\text{src/b.ts}$ [c](src/c.ts#L2)", { katex }),
		);
		expect(block).toBeDefined();
		if (!block) throw new Error("missing block");
		expect(block.mathHtmls?.filter(Boolean).map((item) => item?.latex)).toEqual([
			"\\text{src/b.ts}",
		]);
		expect(
			block.hrefs
				.filter(Boolean)
				.map((href) => fileTargetFromHref(href ?? undefined, context)?.path),
		).toEqual(["/repo/src/a.ts", "/repo/src/c.ts"]);
		for (const [index, math] of (block.mathHtmls ?? []).entries()) {
			if (math) expect(block.hrefs[index]).toBeNull();
		}
		const failedMath: KatexRuntime = {
			__renderToHTMLTree() {
				throw new Error("unavailable");
			},
			renderToString() {
				return "";
			},
		};
		expect(
			hrefs(parseMarkdownToPreparedBlocks("$\\text{src/a.ts}$", { katex: failedMath })),
		).toEqual([]);
		const [html] = inlineFlows(parseMarkdownToPreparedBlocks("<div>$src/a.ts$</div>", { katex }));
		expect(html?.mathHtmls?.filter(Boolean).map((item) => item?.latex)).toEqual(["src/a.ts"]);
		expect(html?.hrefs.every((href) => href === null)).toBe(true);
	});

	test("measures an added line suffix exactly like authored text and appends it only once", () => {
		const path = `src/${"directory/".repeat(15)}file.ts`;
		const auto = inlineFlows(parseMarkdownToPreparedBlocks(`[\`${path}\`](${path}#L10-L20)`))[0];
		const authored = inlineFlows(
			parseMarkdownToPreparedBlocks(`[\`${path}\`:10-20](${path}#L10-L20)`),
		)[0];
		if (!auto || !authored) throw new Error("missing inline flow");
		const paint = (block: PreparedInlineBlock | PreparedTableCell) => {
			let text = "";
			let lineCount = 0;
			walkRichInlineLineRanges(block.flow, 100, (range) => {
				lineCount++;
				for (const fragment of materializeRichInlineLineRange(block.flow, range).fragments)
					text += fragment.text;
			});
			return { text, lineCount };
		};
		expect(paint(auto)).toEqual(paint(authored));
		expect(paint(auto).text).toBe(`${path}:10-20`);
		expect(paint(auto).lineCount).toBeGreaterThan(1);
		expect(auto.fonts).toEqual(authored.fonts);
		expect(auto.hrefs).toEqual(authored.hrefs);
	});

	test("gives every wrapped fragment the same target without requiring DOM layout", () => {
		const path = `src/${"directory/".repeat(15)}file.ts#L12-L14`;
		const source = `[${path}](${path})`;
		const [block] = inlineFlows(parseMarkdownToPreparedBlocks(source));
		if (!block) throw new Error("missing inline flow");
		const targets: unknown[] = [];
		walkRichInlineLineRanges(block.flow, 100, (range) => {
			for (const fragment of materializeRichInlineLineRange(block.flow, range).fragments) {
				targets.push(fileTargetFromHref(block.hrefs[fragment.itemIndex] ?? undefined, context));
			}
		});
		expect(targets.length).toBeGreaterThan(1);
		for (const target of targets) expect(target).toEqual(targets[0]);
		expect(hrefs(parseMarkdownUnits(source).flatMap((unit) => unit.blocks))).toEqual(
			hrefs(parseMarkdownToPreparedBlocks(source)),
		);
	});
});
