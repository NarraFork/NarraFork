import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

describe("parseMarkdownToPreparedBlocks — unpredictable fences", () => {
	it("emits PreparedUnknownBlock for ```mermaid (not a code block)", async () => {
		const { parseMarkdownToPreparedBlocks, MARKDOWN_CONSTANTS } = await import("./parse-markdown");
		const blocks = parseMarkdownToPreparedBlocks("```mermaid\nflowchart TD\n  A-->B\n```");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.kind).toBe("unknown");
		if (blocks[0]!.kind !== "unknown") throw new Error("expected unknown");
		expect(blocks[0].tag).toBe("mermaid");
		expect(blocks[0].placeholderHeight).toBe(MARKDOWN_CONSTANTS.MERMAID_PLACEHOLDER_HEIGHT);
		expect((blocks[0].data as { source?: string }).source).toContain("flowchart");
	});

	it("emits katex unknown for math/katex/latex fences", async () => {
		const { parseMarkdownToPreparedBlocks, MARKDOWN_CONSTANTS } = await import("./parse-markdown");
		for (const lang of ["math", "katex", "latex"]) {
			const blocks = parseMarkdownToPreparedBlocks("```" + lang + "\nE=mc^2\n```");
			expect(blocks[0]!.kind).toBe("unknown");
			if (blocks[0]!.kind !== "unknown") throw new Error("expected unknown");
			expect(blocks[0].tag).toBe("katex");
			expect(blocks[0].placeholderHeight).toBe(MARKDOWN_CONSTANTS.KATEX_PLACEHOLDER_HEIGHT);
		}
	});

	it("keeps ordinary fenced code as PreparedCodeBlock", async () => {
		const { parseMarkdownToPreparedBlocks } = await import("./parse-markdown");
		const blocks = parseMarkdownToPreparedBlocks("```ts\nconst x = 1;\n```");
		expect(blocks).toHaveLength(1);
		expect(blocks[0]!.kind).toBe("code");
		if (blocks[0]!.kind !== "code") throw new Error("expected code");
		expect(blocks[0].lang).toBe("ts");
	});
});
