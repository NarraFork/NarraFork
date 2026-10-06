/**
 * markdown-emphasis-compat.test.ts — Flanking relaxation for `*` / `**` / `***`.
 *
 * Locks the product behaviour Chinese AI output depends on (`**注意：**说明`)
 * without rewriting already-legal pairs (streaming diff stability).
 */

import { describe, expect, it } from "bun:test";
import { marked, type Tokens } from "marked";
import {
	EMPHASIS_FLANK_SENTINEL,
	prepareMarkdownEmphasis,
	remarkStripEmphasisSentinel,
	stripEmphasisSentinel,
} from "./markdown-emphasis-compat";

type InlineToken = Tokens.Generic & { text?: string; raw?: string; type: string };

function inlineTypes(source: string): string[] {
	const tokens = marked.lexer(prepareMarkdownEmphasis(source), { gfm: true });
	const first = tokens[0] as { tokens?: InlineToken[] } | undefined;
	const inline = first?.tokens ?? [];
	return inline.map((token) =>
		token.type === "strong" || token.type === "em"
			? `${token.type}(${token.text ?? ""})`
			: (token.text ?? token.raw ?? ""),
	);
}

function hasStrong(source: string): boolean {
	const tokens = marked.lexer(prepareMarkdownEmphasis(source), { gfm: true });
	return tokens.some((token) => {
		const inline = (token as { tokens?: InlineToken[] }).tokens ?? [];
		return inline.some((t) => t.type === "strong" || t.type === "em");
	});
}

describe("prepareMarkdownEmphasis — rewrites illegal pairs", () => {
	it("bold content ending with fullwidth colon before more text", () => {
		const out = prepareMarkdownEmphasis("**注意：**说明");
		expect(out).toContain(EMPHASIS_FLANK_SENTINEL);
		expect(stripEmphasisSentinel(out)).toBe("**注意：**说明");
		expect(hasStrong("**注意：**说明")).toBe(true);
		expect(inlineTypes("**注意：**说明")).toEqual([
			`strong(注意：${EMPHASIS_FLANK_SENTINEL})`,
			"说明",
		]);
		expect(stripEmphasisSentinel(inlineTypes("**注意：**说明")[0] ?? "")).toBe("strong(注意：)");
	});

	it("common AI label patterns", () => {
		for (const source of [
			"**结果：**继续",
			"**第 1 步：**安装",
			"**原因：**上游未返回。",
			"**foo:**bar",
			"**foo.**bar",
			"**foo,**bar",
			"**详细说明：**第一点",
		]) {
			expect(hasStrong(source), source).toBe(true);
		}
	});

	it("opening delimiter preceded by text and followed by punctuation", () => {
		expect(hasStrong("字**：粗**")).toBe(true);
		expect(hasStrong("foo**:bar**")).toBe(true);
		expect(hasStrong("字**：粗**继续")).toBe(true);
	});

	it("bold wrapping codespan followed by text", () => {
		expect(hasStrong("**`code`**文字")).toBe(true);
		expect(hasStrong("**文件 `a.ts`**中")).toBe(true);
	});

	it("single-star form of the same defect", () => {
		expect(hasStrong("*结果：*继续")).toBe(true);
	});
});

describe("prepareMarkdownEmphasis — leaves legal pairs untouched", () => {
	it("mid-sentence CJK bold is byte-identical", () => {
		for (const source of [
			"这是**加粗**文字",
			"**结果**继续",
			"a**b**c",
			"前缀**bold**后缀",
			"**结果：**",
			"**结果：** 继续",
			"**加粗**",
			"***both***",
			"**bold**，**bold2**",
		]) {
			expect(prepareMarkdownEmphasis(source), source).toBe(source);
			expect(hasStrong(source), source).toBe(true);
		}
	});

	it("idempotent after a rewrite", () => {
		const once = prepareMarkdownEmphasis("**注意：**说明");
		const twice = prepareMarkdownEmphasis(once);
		expect(twice).toBe(once);
	});
});

describe("prepareMarkdownEmphasis — never touches code or math", () => {
	it("fenced and inline code stay literal", () => {
		const fence = "```\n**注意：**\n```";
		expect(prepareMarkdownEmphasis(fence)).toBe(fence);
		const inline = "`**注意：**`";
		expect(prepareMarkdownEmphasis(inline)).toBe(inline);
	});

	it("protects arbitrary code delimiters, multiline spans and open fences byte-for-byte", () => {
		for (const source of [
			"``**注意：**说明``",
			"```inline ` **注意：**说明```",
			"``first\n**注意：**说明\nlast``",
			"````lang\n```\n**注意：**说明\n````",
			"~~~~lang\n~~~\n**注意：**说明\n~~~~",
			"```lang\n**注意：**说明",
			"~~~~lang\n**注意：**说明\n~~~",
			"> ```\n> **注意：**说明",
			"- ```\n  **注意：**说明",
			"    **注意：**说明\n\n    **结果：**原样",
		]) {
			expect(prepareMarkdownEmphasis(source), source).toBe(source);
		}
		expect(hasStrong("``literal`` **注意：**说明")).toBe(true);
		expect(hasStrong("**``code``**文字")).toBe(true);
		for (const source of [
			"> ```\n> code\n\n**注意：**说明",
			"- ```\n  code\n\n**注意：**说明",
			"`unclosed\n\n**注意：**说明\n\nend`",
		]) {
			expect(prepareMarkdownEmphasis(source), source).toContain(EMPHASIS_FLANK_SENTINEL);
		}
	});

	it("protects link metadata, references, autolinks and HTML attributes", () => {
		for (const source of [
			"[x](https://example.com/?q=**注意：**说明)",
			"[x](https://example.com/a(b)?q=**注意：**说明)",
			"[x](<https://example.com/?q=**注意：**说明>)",
			"[x](<https://example.com/?q=)**注意：**说明>)",
			'[x](/url "**注意：**说明")',
			"[x](/url '**注意：**说明')",
			"[x](/url (**注意：**说明))",
			"[x](https://example.com/?q=**注意：**说明",
			"[x][**注意：**说明]\n\n[**注意：**说明]: /url",
			"[**注意：**说明]\n\n[**注意：**说明]: /url",
			'[id]: https://example.com/?q=**注意：**说明 "**标题：**原样"',
			'[id]: /url\n  "**标题：**原样"',
			'[id]: /url\n"第一行\n**标题：**原样"',
			'[id]:\n  https://example.com/?q=**注意：**说明\n  "**标题：**原样"',
			"> [id]: https://example.com/?q=**注意：**说明",
			"<https://example.com/?q=**注意：**说明>",
			"https://example.com/?q=**注意：**说明",
			'<span data-title="**注意：**说明">x</span>',
		]) {
			expect(prepareMarkdownEmphasis(source), source).toBe(source);
		}
		const label = "[**注意：**说明](https://example.com/?q=**结果：**原样)";
		const prepared = prepareMarkdownEmphasis(label);
		expect(prepared).toContain(`**注意：${EMPHASIS_FLANK_SENTINEL}**说明`);
		expect(prepared).toContain("https://example.com/?q=**结果：**原样");
	});

	it("protects all math forms without losing surrounding nested emphasis", () => {
		for (const source of [
			"$**注意：**说明$",
			"$$**注意：**说明$$",
			"\\(**注意：**说明\\)",
			"\\[**注意：**说明\\]",
		]) {
			expect(prepareMarkdownEmphasis(source)).toBe(source);
		}
		expect(hasStrong("**外层 *内层* 注意：**说明")).toBe(true);
		expect(hasStrong("***注意：***说明")).toBe(true);
	});

	it("escaped stars stay literal", () => {
		const source = "\\*not em\\*";
		expect(prepareMarkdownEmphasis(source)).toBe(source);
	});

	it("math interior stars are not emphasis", () => {
		const source = "$a*b*c$";
		expect(prepareMarkdownEmphasis(source)).toBe(source);
		const display = "$$a*b*c$$";
		expect(prepareMarkdownEmphasis(display)).toBe(display);
	});

	it("unpaired openers are left alone", () => {
		const source = "半截 **未闭合";
		expect(prepareMarkdownEmphasis(source)).toBe(source);
	});
});

describe("bounded preprocessing", () => {
	it("handles many unmatched runs and metadata openers without suffix rescans", () => {
		for (const prefix of [
			"* ".repeat(20_000),
			"<".repeat(40_000),
			"\\(".repeat(20_000),
			"``literal`` ".repeat(4_000),
		]) {
			const source = `${prefix}\n\n**注意：**说明`;
			const output = prepareMarkdownEmphasis(source);
			expect(stripEmphasisSentinel(output)).toBe(source);
			expect(output).toContain(`注意：${EMPHASIS_FLANK_SENTINEL}`);
		}
	});
});

describe("stripEmphasisSentinel", () => {
	it("removes every sentinel and is idempotent", () => {
		expect(stripEmphasisSentinel(`a${EMPHASIS_FLANK_SENTINEL}b${EMPHASIS_FLANK_SENTINEL}`)).toBe(
			"ab",
		);
		expect(stripEmphasisSentinel("clean")).toBe("clean");
		expect(stripEmphasisSentinel(stripEmphasisSentinel(`x${EMPHASIS_FLANK_SENTINEL}`))).toBe("x");
	});
});

describe("both markdown pipelines agree", () => {
	it("keeps parsed code-copy text, link destinations and titles byte-identical", async () => {
		const { unified } = await import("unified");
		const { default: remarkParse } = await import("remark-parse");
		const fixtures = [
			"``**注意：**说明``",
			"````js\n**注意：**说明\n````",
			"```js\n**注意：**说明",
			'[x](https://example.com/?q=**注意：**说明 "**标题：**说明")',
			'[x][ref]\n\n[ref]: https://example.com/?q=**注意：**说明 "**标题：**说明"',
		];
		const metadata = (node: unknown): unknown[] => {
			if (!node || typeof node !== "object") return [];
			if (Array.isArray(node)) return node.flatMap(metadata);
			const record = node as Record<string, unknown>;
			const own = ["code", "codespan", "inlineCode", "link", "definition"].includes(
				String(record.type),
			)
				? [
						{
							type: record.type,
							text: record.type === "link" ? undefined : record.text,
							value: record.value,
							href: record.href,
							url: record.url,
							title: record.title,
						},
					]
				: [];
			return [...own, ...metadata(record.tokens), ...metadata(record.children)];
		};
		for (const fixture of fixtures) {
			const source = `**修复：**生效\n\n${fixture}`;
			const prepared = prepareMarkdownEmphasis(source);
			expect(prepared).toContain(EMPHASIS_FLANK_SENTINEL);
			expect(metadata(marked.lexer(prepared))).toEqual(metadata(marked.lexer(source)));
			const processor = unified().use(remarkParse);
			expect(metadata(processor.parse(prepared))).toEqual(metadata(processor.parse(source)));
		}
	});

	it("marked and micromark both emit strong for the product cases", async () => {
		const { unified } = await import("unified");
		const { default: remarkParse } = await import("remark-parse");
		const sources = [
			"**注意：**说明",
			"**结果：**继续",
			"字**：粗**",
			"**`code`**文字",
			"这是**加粗**文字",
		];
		for (const source of sources) {
			const prepared = prepareMarkdownEmphasis(source);
			const markedHasStrong = hasStrong(source);
			const tree = unified().use(remarkParse).parse(prepared);
			// Walk the mdast for a strong node after the same prepare step.
			let mdastHasStrong = false;
			const walk = (node: { type?: string; children?: unknown[] }) => {
				if (node.type === "strong" || node.type === "emphasis") mdastHasStrong = true;
				if (Array.isArray(node.children)) {
					for (const child of node.children) {
						if (child && typeof child === "object") {
							walk(child as { type?: string; children?: unknown[] });
						}
					}
				}
			};
			walk(tree as { type?: string; children?: unknown[] });
			expect(markedHasStrong, source).toBe(true);
			expect(mdastHasStrong, source).toBe(true);
		}
	});
});

describe("remarkStripEmphasisSentinel", () => {
	it("strips text nodes only", () => {
		const tree = {
			type: "root",
			children: [
				{
					type: "paragraph",
					children: [{ type: "text", value: `注意：${EMPHASIS_FLANK_SENTINEL}` }],
				},
				{ type: "inlineCode", value: `code${EMPHASIS_FLANK_SENTINEL}` },
			],
		};
		remarkStripEmphasisSentinel()(tree);
		expect((tree.children[0] as { children: { value: string }[] }).children[0]?.value).toBe(
			"注意：",
		);
		expect((tree.children[1] as { value: string }).value).toBe(`code${EMPHASIS_FLANK_SENTINEL}`);
	});
});
