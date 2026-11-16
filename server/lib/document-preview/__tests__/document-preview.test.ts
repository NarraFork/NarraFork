import { describe, expect, test } from "bun:test";
import { parseDocx, readDocxAsset } from "../docx";
import { renderMarkdown } from "../markdown";
import { detectFormat } from "../probe";
import { readCentralDirectory } from "../zip";
import { buildDocx, buildZip, pictureParagraph, TINY_PNG } from "./docx-fixture";

const FILE_PATH = "/repo/design/spec.docx";

/** Body covering the constructs a read-only preview must show. */
const RICH_BODY = `
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>设计说明</w:t></w:r></w:p>
<w:p><w:r><w:t>这是一段正文，包含 *星号* 与 | 竖线。</w:t></w:r></w:p>
<w:p><w:pPr><w:numId w:val="1"/></w:pPr><w:r><w:t>第一项</w:t></w:r></w:p>
<w:p><w:pPr><w:numId w:val="1"/><w:ilvl w:val="1"/></w:pPr><w:r><w:t>子项</w:t></w:r></w:p>
<w:tbl>
  <w:tr><w:tc><w:t>名称</w:t></w:tc><w:tc><w:t>数量</w:t></w:tc></w:tr>
  <w:tr><w:tc><w:t>甲</w:t></w:tc><w:tc><w:t>2</w:t></w:tc></w:tr>
</w:tbl>
${pictureParagraph()}
`;

describe("document format detection", () => {
	test("decides by content signature, not by extension", () => {
		const docx = buildDocx({ bodyXml: RICH_BODY });
		// A DOCX renamed to .zip is still a DOCX.
		expect(detectFormat(docx, "/repo/spec.zip").kind).toBe("docx");

		const pdf = Buffer.from("%PDF-1.7\n...", "ascii");
		expect(detectFormat(pdf, "/repo/spec.docx").kind).toBe("pdf");

		const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])]);
		expect(detectFormat(ole, "/repo/spec.docx").kind).toBe("legacy-office");

		// A ZIP that is not a Word document must not be parsed as one.
		const other = buildZip([{ name: "readme.txt", data: "hi" }]);
		expect(detectFormat(other, "/repo/other.docx").kind).toBe("unsupported");

		expect(detectFormat(Buffer.alloc(0), "/repo/empty.docx").kind).toBe("unsupported");
	});
});

describe("docx parsing", () => {
	const result = parseDocx(buildDocx({ bodyXml: RICH_BODY }), { filePath: FILE_PATH });

	test("renders headings, escaped paragraphs, lists and tables as Markdown", () => {
		expect(result.markdown).toContain("# 设计说明");
		// Document text must not turn into Markdown syntax.
		expect(result.markdown).toContain("\\*星号\\*");
		expect(result.markdown).toContain("\\| 竖线");
		expect(result.markdown).toContain("- 第一项");
		expect(result.markdown).toContain("  - 子项");
		expect(result.markdown).toContain("| 名称 | 数量 |");
		expect(result.markdown).toContain("| 甲 | 2 |");
	});

	test("exposes embedded pictures as addressable assets, never as ZIP paths", () => {
		expect(result.assets).toHaveLength(1);
		expect(result.assets[0].id).toBe("a1");
		expect(result.assets[0].mime).toBe("image/png");
		expect(result.assets[0].byteLength).toBe(TINY_PNG.length);
		// The placeholder carries the document path so the renderer can resolve it alone.
		expect(result.markdown).toContain(`nf-doc-asset:?doc=${encodeURIComponent(FILE_PATH)}&id=a1`);
		// The archive part name must never leak into the rendered Markdown.
		expect(result.markdown).not.toContain("word/media/image1.png");
	});

	test("reads one asset's bytes back by id and refuses unknown ids", () => {
		const buffer = buildDocx({ bodyXml: RICH_BODY });
		const asset = readDocxAsset(buffer, "a1", FILE_PATH);
		expect(asset?.mime).toBe("image/png");
		expect(asset?.bytes).toEqual(new Uint8Array(TINY_PNG));
		expect(readDocxAsset(buffer, "a2", FILE_PATH)).toBeUndefined();
		// Not an id the parser mints: no ZIP part can be addressed directly.
		expect(readDocxAsset(buffer, "word/media/image1.png", FILE_PATH)).toBeUndefined();
	});

	test("keeps document metadata for the preview header", () => {
		expect(result.meta.title).toBe("设计说明");
		expect(result.meta.author).toBe("Kether");
	});

	test("refuses a package without word/document.xml", () => {
		const notDocx = buildZip([{ name: "word/styles.xml", data: "<x/>" }]);
		expect(() => parseDocx(notDocx, { filePath: FILE_PATH })).toThrow("word/document.xml");
	});
});

describe("document parser bounds", () => {
	test("refuses a central directory that declares too many entries", () => {
		// 4097 entries would be a denial-of-service vector for the reader's walk.
		const buffer = buildZip([{ name: "a.txt", data: "x" }]);
		// Rewrite the entry count in both the EOCD record to an over-limit value.
		buffer.writeUInt16LE(4097, buffer.length - 14);
		buffer.writeUInt16LE(4097, buffer.length - 12);
		expect(() => readCentralDirectory(buffer)).toThrow("the limit is 4096");
	});

	test("reports truncation instead of reading an unbounded document", () => {
		// MAX_BLOCKS is 20000; parallel list paragraphs collapse into few blocks, so drive the
		// block budget with headings that each produce their own block.
		const headings = Array.from(
			{ length: 20_050 },
			(_, index) =>
				`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>h${index}</w:t></w:r></w:p>`,
		).join("");
		const result = parseDocx(buildDocx({ bodyXml: headings }), { filePath: FILE_PATH });
		expect(result.truncated).toBe(true);
		expect(result.omitted.length).toBeGreaterThan(0);
	});
});

describe("markdown rendering", () => {
	test("groups blocks with blank lines and drops empty paragraphs", () => {
		const markdown = renderMarkdown(
			[
				{ type: "heading", level: 2, text: "标题" },
				{ type: "paragraph", text: "" },
				{ type: "paragraph", text: "正文" },
				{ type: "image", assetId: "a1", alt: "" },
			],
			"/repo/doc.docx",
		);
		expect(markdown).toBe(
			`## 标题\n\n正文\n\n![](nf-doc-asset:?doc=${encodeURIComponent("/repo/doc.docx")}&id=a1)`,
		);
	});
});
