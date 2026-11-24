import { afterAll, describe, expect, test } from "bun:test";
import { installCanvasStub } from "../../frontend/components/narrator/vlist/measure/test-canvas-stub";
import type { PreparedBlock, PreparedFixedBlock, PreparedInlineBlock } from "./prepared-block";

const disposeCanvasStub = installCanvasStub();
afterAll(disposeCanvasStub);
const {
	MARKDOWN_CONSTANTS,
	parseMarkdownToPreparedBlocks: parse,
	parseMarkdownUnits,
} = await import("./parse-markdown");
const { accumulateFrame } = await import("./prepared-block");
const { materializeRichInlineLineRange, walkRichInlineLineRanges } = await import(
	"@chenglou/pretext/rich-inline"
);
const { getPreparedMarkdownBlocks } = await import("./prepared-markdown-cache");
const { StreamingBlockCache } = await import(
	"../../frontend/components/narrator/vlist/streaming-block-cache"
);
const { default: katex } = await import("katex");

function images(blocks: readonly PreparedBlock[]): PreparedFixedBlock[] {
	return blocks.filter(
		(block): block is PreparedFixedBlock =>
			block.kind === "fixed" && block.tag === "markdown-image",
	);
}

function inlines(blocks: readonly PreparedBlock[]): PreparedInlineBlock[] {
	return blocks.filter((block): block is PreparedInlineBlock => block.kind === "inline");
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("expected a prepared value");
	return value;
}

function text(block: PreparedInlineBlock): string {
	let result = "";
	walkRichInlineLineRanges(block.flow, 100000, (range) => {
		for (const fragment of materializeRichInlineLineRange(block.flow, range).fragments) {
			result += fragment.text;
		}
	});
	return result;
}

describe("Markdown image fixed previews", () => {
	test("independent images reserve exactly 200px and carry only source metadata", () => {
		const blocks = parse('![示意](./图.png "说明")');
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			kind: "fixed",
			tag: "markdown-image",
			height: 200,
			marginTop: 0,
			data: { src: "./图.png", alt: "示意", title: "说明" },
		});
		expect(MARKDOWN_CONSTANTS.IMAGE_PREVIEW_HEIGHT).toBe(200);
		expect(blocks[0]).not.toHaveProperty("placeholderHeight");
		expect(blocks[0]).not.toHaveProperty("displayWidth");
		expect(images(parse("![](image.png)"))[0]?.data).toEqual({ src: "image.png", alt: "" });
		expect(images(parse('![A &amp; B](image.png "C &amp; D")'))[0]?.data).toEqual({
			src: "image.png",
			alt: "A & B",
			title: "C & D",
		});
	});

	test("splits prose and consecutive images without manufacturing whitespace rows", () => {
		const blocks = parse("前 ![一](a.png)\n![二](b.png) 后");
		expect(blocks.map((block) => block.kind)).toEqual(["inline", "fixed", "fixed", "inline"]);
		expect(inlines(blocks).map(text)).toEqual(["前", "后"]);
		expect(images(blocks).map((block) => block.data?.src)).toEqual(["a.png", "b.png"]);
		expect(parse("![一](a.png) ![二](b.png)").map((block) => block.kind)).toEqual([
			"fixed",
			"fixed",
		]);
	});

	test("retains marks across nested formatting and linked images", () => {
		const blocks = parse("**粗 *前 ![图](a.png) 后* 末** [![链接图](b.png)](https://outer.test)");
		expect(images(blocks).map((block) => block.data?.src)).toEqual(["a.png", "b.png"]);
		const before = inlines(blocks)[0];
		const after = inlines(blocks)[1];
		expect(before).toBeDefined();
		expect(after).toBeDefined();
		expect(text(required(before))).toBe("粗前");
		expect(text(required(after))).toBe("后末");
		expect(before?.fonts[0]).toBe(after?.fonts[1]);
		expect(before?.fonts[1]).toBe(after?.fonts[0]);
		const reference = parse("[**前 ![图](agent.png) 后**](nf-agent://open?id=child)");
		expect(images(reference)).toHaveLength(0);
		expect(inlines(reference).map(text)).toEqual(["前 图 后"]);
		const linked = parse("[前 ![图](c.png) 后](https://outer.test)");
		expect(images(linked)).toHaveLength(1);
		expect(inlines(linked).flatMap((block) => block.hrefs)).toEqual([
			"https://outer.test/",
			"https://outer.test/",
		]);
	});

	test("preserves list markers, task state, nested indent and quote rails", () => {
		for (const source of ["- ![一](a.png) 后", "- ![一](a.png)\n\n  后"]) {
			const blocks = parse(source);
			expect(blocks[0]).toMatchObject({
				kind: "fixed",
				markerText: "•",
				contentLeft: MARKDOWN_CONSTANTS.LIST_INDENT,
			});
			expect(inlines(blocks).map(text)).toEqual(["后"]);
			expect(blocks.slice(1).every((block) => block.markerText === null)).toBe(true);
		}
		const quoted = parse("> - [x] ![一](a.png)\n>   - **前 ![二](b.png) 后**");
		expect(images(quoted)).toHaveLength(2);
		expect(quoted[0]).toMatchObject({ markerText: "[x]", taskMarker: { checked: true } });
		expect(images(quoted)[0]?.quoteRailLefts).toHaveLength(1);
		expect(images(quoted)[1]?.contentLeft).toBeGreaterThan(required(images(quoted)[0]).contentLeft);
		expect(inlines(quoted).map(text).join("")).toContain("前");
		expect(inlines(quoted).map(text).join("")).toContain("后");
	});

	test("allows safe URLs and keeps source paths unresolved", () => {
		for (const src of [
			"https://EXAMPLE.test/a.png",
			"http://example.test/a.png",
			"//example.test/a.png",
			"../assets/a.png",
			"/tmp/a.png",
			"assets/a:b.png",
			"?asset=a:b",
			"#image",
			"nf-doc-asset:?doc=report.docx&id=pic1",
			"nf-file://open?device=DeviceCase&path=%2Ftmp%2Fa.png",
			"mailto:test@example.test",
			"irc://example.test/a",
			"ircs://example.test/a",
			"xmpp:test@example.test",
		]) {
			expect(images(parse(`![图](${src})`))[0]?.data?.src, src).toBe(src);
		}
		expect(images(parse("![图](https://example.test/a?x=1&amp;y=2)"))[0]?.data?.src).toBe(
			"https://example.test/a?x=1&y=2",
		);
	});

	test("rejects executable, opaque and obfuscated schemes, retaining alt as text", () => {
		for (const src of [
			"javascript:alert(1)",
			"JaVaScRiPt:alert(1)",
			"vbscript:run",
			"data:image/png;base64,AAA",
			"blob:https://example.test/a",
			"file:///tmp/a.png",
			"unknown:foo",
			"java&#x73;cript:alert(1)",
			"javascript&colon;alert(1)",
			"java&Tab;script:alert(1)",
			"&amp;#106;avascript:alert(1)",
			"nf-file://open?device=dev&path=relative.png",
		]) {
			const blocks = parse(`![保留](${src})`);
			expect(images(blocks), src).toHaveLength(0);
			expect(inlines(blocks).map(text).join(""), src).toBe("保留");
		}
	});

	test("does not upgrade code, headings or table cell images; keeps heading anchors", () => {
		for (const source of [
			"`![图](a.png)`",
			"```md\n![图](a.png)\n```",
			"    ![图](a.png)",
			"# ![图](a.png)",
			"| A |\n|---|\n| ![图](a.png) |",
			"\\![图](a.png)",
		]) {
			expect(images(parse(source)), source).toHaveLength(0);
		}
		const heading = inlines(parse("# ![图](a.png)"))[0];
		expect(heading?.headingSlug).toBe("图");
		expect(text(required(heading))).toBe("图");
	});

	test("reference images and the display math prose path preserve image previews", () => {
		expect(
			images(parse('[![图][pic]](https://outer.test)\n\n[pic]: ./a.png "标题"'))[0]?.data,
		).toEqual({ src: "./a.png", alt: "图", title: "标题" });
		const blocks = parse("前 ![一](a.png) $$x^2$$ 后 ![二](b.png)", { katex: katex as never });
		expect(images(blocks).map((block) => block.data?.src)).toEqual(["a.png", "b.png"]);
		expect(blocks.some((block) => block.kind === "unknown" && block.tag === "katex")).toBe(true);
		expect(inlines(blocks).map(text).join("")).toContain("前");
		expect(inlines(blocks).map(text).join("")).toContain("后");
	});

	test("source ranges retain the original mixed paragraph and each list item", () => {
		const source =
			"# 标题\r\n\r\n**注意：**前 ![图](a.png) 后\r\n\r\n- ![一](b.png) 后\r\n- ![二](c.png)";
		const blocks = parse(source, undefined, true);
		const ranges = images(blocks).map((block) => block.sourceRange);
		expect(ranges.every((range) => range !== undefined)).toBe(true);
		expect(ranges.map((range) => source.slice(required(range).start, required(range).end))).toEqual(
			["**注意：**前 ![图](a.png) 后", "- ![一](b.png) 后", "- ![二](c.png)"],
		);
		expect(inlines(blocks).find((block) => text(block).includes("注意"))?.sourceRange).toEqual(
			ranges[0],
		);
	});

	test("cache and incremental streaming retain fixed blocks with identical geometry", () => {
		const cache = new StreamingBlockCache();
		const prefixes = [
			"前 ![",
			"前 ![图](a.png)",
			"前 ![图](a.png) 后\n\n",
			"前 ![图](a.png) 后\n\n![二](b.png)\n\n末\n\n尾",
		];
		for (const source of prefixes) {
			const whole = parse(source);
			expect(cache.get("image-test", source)).toEqual(whole);
			expect(parseMarkdownUnits(source).flatMap((unit) => unit.blocks)).toEqual(whole);
			expect(getPreparedMarkdownBlocks(source, undefined, 0)).toEqual(whole);
		}
		const source = required(prefixes.at(-1));
		expect(images(cache.get("image-test", source))).toHaveLength(2);
		const cached = getPreparedMarkdownBlocks(source, undefined, 0);
		expect(getPreparedMarkdownBlocks(source, undefined, 0)).toBe(cached);
		expect(structuredClone(images(cached))).toEqual(images(cached));
	});

	test("image slots fill shrink-wrap columns and stay 200px at every width, including quotes", () => {
		for (const source of ["![](a.png)", "> - ![](a.png)"]) {
			const blocks = parse(source);
			for (const width of [80, 320, 1000]) {
				const frame = accumulateFrame(blocks, width, () => {
					throw new Error("image must not measure text");
				});
				expect(frame.contentHeight).toBe(200);
				expect(frame.blocks[0]?.height).toBe(200);
				expect(frame.usedWidth).toBe(width);
			}
		}
	});
});
