/**
 * parse-markdown-task-list.test.ts — GFM task list items (`- [ ]` / `- [x]`)
 * must render as a checkbox MARKER plus the item text — never with a literal
 * `[ ]` / `[x]` leaking into the painted text.
 *
 * The regression this pins: marked (gfm) surfaces the checkbox as its own token,
 * but neither token walk had a case for it —
 *
 *   - a TIGHT list unshifts `{ type: "checkbox", raw: "[ ] " }` as a BLOCK token
 *     into `item.tokens`; `parseBlockTokens`'s default branch printed its raw
 *     text as a fallback block, so the item rendered as TWO lines: `☐[ ]` (the
 *     real marker glued to the leaked raw text) and the item text below it.
 *   - a LOOSE list unshifts the checkbox into the opening paragraph's INLINE
 *     tokens; `collectInlineLines`'s default branch painted `[ ] ` before the
 *     item text on the same line.
 *
 * Both walks now skip the token: the box is painted from `item.task` /
 * `item.checked` as structured task-marker state, so the token carries no content.
 *
 * Runs against real pretext with the deterministic canvas stub.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "../../frontend/components/narrator/vlist/measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

async function load() {
	const [parse, pretext] = await Promise.all([
		import("./parse-markdown"),
		import("@chenglou/pretext/rich-inline"),
	]);
	return { ...parse, ...pretext };
}

type AnyBlock = {
	kind: string;
	markerText: string | null;
	taskMarker?: { checked: boolean; label: string };
	flow?: unknown;
};

/** Materialize an inline block's visible text the way the render layer does. */
function visibleText(
	block: AnyBlock,
	walk: (prepared: unknown, maxWidth: number, onLine: (line: never) => void) => number,
	materialize: (prepared: unknown, line: never) => { fragments: { text: string }[] },
): string {
	if (block.kind !== "inline" || block.flow == null) return "";
	let text = "";
	walk(block.flow, 800, (line) => {
		for (const frag of materialize(block.flow, line).fragments) text += frag.text;
	});
	return text;
}

describe("GFM task list items", () => {
	it("tight list: one block per item, box as marker, no literal [ ]", async () => {
		const { parseMarkdownToPreparedBlocks, walkRichInlineLineRanges, ...rest } = await load();
		const blocks = parseMarkdownToPreparedBlocks("- [ ] 待办事项\n- [x] 已完成\n") as AnyBlock[];
		// The regression painted FOUR blocks here: a "[ ] " fallback block plus the
		// text block per item.
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.markerText).toBe("[ ]");
		expect(blocks[1]?.markerText).toBe("[x]");
		const first = visibleText(
			blocks[0] as AnyBlock,
			walkRichInlineLineRanges as never,
			rest.materializeRichInlineLineRange as never,
		);
		const second = visibleText(
			blocks[1] as AnyBlock,
			walkRichInlineLineRanges as never,
			rest.materializeRichInlineLineRange as never,
		);
		expect(blocks[0]?.taskMarker).toEqual({ checked: false, label: "待办事项" });
		expect(blocks[1]?.taskMarker).toEqual({ checked: true, label: "已完成" });
		expect(first).toBe("待办事项");
		expect(second).toBe("已完成");
	});

	it("loose list: inline checkbox token is skipped the same way", async () => {
		const { parseMarkdownToPreparedBlocks, walkRichInlineLineRanges, ...rest } = await load();
		// Blank lines make marked treat the list as loose, which moves the checkbox
		// token from block level into the paragraph's inline tokens.
		const blocks = parseMarkdownToPreparedBlocks(
			"- [ ] item one\n\n- [x] item two\n",
		) as AnyBlock[];
		expect(blocks).toHaveLength(2);
		expect(blocks[0]?.markerText).toBe("[ ]");
		expect(blocks[1]?.markerText).toBe("[x]");
		for (const [index, expected] of ["item one", "item two"].entries()) {
			const text = visibleText(
				blocks[index] as AnyBlock,
				walkRichInlineLineRanges as never,
				rest.materializeRichInlineLineRange as never,
			);
			expect(text).not.toContain("[");
			// Fragments split at whitespace (the gap becomes fragment spacing), so
			// compare with spaces removed.
			expect(text.replaceAll(" ", "")).toBe(expected.replaceAll(" ", ""));
		}
	});

	it("task items nested under a heading line keep text and marker paired", async () => {
		const { parseMarkdownToPreparedBlocks, walkRichInlineLineRanges, ...rest } = await load();
		const source = [
			"**调查清单**：",
			"",
			"- [ ] AskUserQuestion 工具的服务端实现",
			"- [ ] 权限挂起/恢复机制",
			"",
			"开始调查：",
		].join("\n");
		const blocks = parseMarkdownToPreparedBlocks(source) as AnyBlock[];
		const items = blocks.filter((b) => b.markerText != null);
		expect(items).toHaveLength(2);
		for (const item of items) {
			expect(item.markerText).toBe("[ ]");
			const text = visibleText(
				item,
				walkRichInlineLineRanges as never,
				rest.materializeRichInlineLineRange as never,
			);
			expect(text).not.toContain("[");
			expect(text.length).toBeGreaterThan(0);
		}
	});

	it("a literal [ ] in ordinary prose is NOT a checkbox and stays visible", async () => {
		const { parseMarkdownToPreparedBlocks, walkRichInlineLineRanges, ...rest } = await load();
		const blocks = parseMarkdownToPreparedBlocks("占位符 [ ] 不是任务\n") as AnyBlock[];
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.markerText).toBeNull();
		const text = visibleText(
			blocks[0] as AnyBlock,
			walkRichInlineLineRanges as never,
			rest.materializeRichInlineLineRange as never,
		);
		expect(text.replaceAll(" ", "")).toBe("占位符[]不是任务");
	});
});
