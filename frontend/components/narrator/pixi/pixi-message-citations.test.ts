/**
 * pixi-message-citations.test.ts — Pixi is the third renderer, and unlike VList it
 * does NOT consume the shared segment adapter: it builds its own block models.
 * That makes it the one path where a citation fix silently fails to apply, so the
 * three invariants are pinned here directly.
 *
 * Asserted through `buildPixiMessageItems` rather than the private helper so the
 * test exercises the same entry point the renderer uses.
 */

import { describe, expect, test } from "bun:test";
import { CHATGPT_CITATION_CLOSE, CHATGPT_CITATION_OPEN } from "@shared/citations";
import type { NarratorMsg } from "../narrator-panel-types";
import { buildPixiMessageItems, type PixiMessageItem } from "./pixi-message-model";

const MARKER = `${CHATGPT_CITATION_OPEN}turn204588view0${CHATGPT_CITATION_CLOSE}`;

// biome-ignore lint/suspicious/noExplicitAny: test fixtures are structural
function msg(partial: Record<string, any>): NarratorMsg {
	return { children: [], contentText: null, ...partial } as unknown as NarratorMsg;
}

function textBlocks(items: PixiMessageItem[]) {
	return items.flatMap((item) =>
		item.kind === "message" ? item.blocks.filter((block) => block.type === "text") : [],
	);
}

function build(messages: NarratorMsg[]): PixiMessageItem[] {
	return buildPixiMessageItems({
		pages: [],
		orderedMessages: messages,
		narratorId: "n1",
	});
}

describe("pixi assistant text citations", () => {
	test("projects a resolved citation into a Markdown link", () => {
		const items = build([
			msg({
				id: "m1",
				role: "assistant",
				seq: 1,
				contentJson: [
					{
						type: "text",
						text: "结论成立",
						citations: [
							{ startIndex: 4, endIndex: 4, sources: [{ url: "https://a.test", title: "A" }] },
						],
					},
				],
			}),
		]);

		const blocks = textBlocks(items);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].text).toBe("结论成立[1](<https://a.test>)");
		// The clipboard keeps the prose, not the link syntax.
		expect(blocks[0].copyText).toBe("结论成立");
	});

	test("strips an exact legacy envelope from a historical row", () => {
		const items = build([
			msg({
				id: "m2",
				role: "assistant",
				seq: 2,
				contentJson: [{ type: "text", text: `已修复${MARKER}` }],
			}),
		]);

		const blocks = textBlocks(items);
		expect(blocks[0].text).toBe("已修复[1]");
		expect(blocks[0].text).not.toContain("turn204588view0");
		expect(blocks[0].copyText).toBe("已修复");
	});

	/**
	 * Pixi builds its own block models, so it is the path where a shared fix can
	 * silently fail to apply — in either direction. This pins the no-op case for
	 * protocols that never emit the envelope.
	 */
	test("leaves ref-shaped text from other protocols byte-identical", () => {
		const text = "见 https://example.com/turn0search1 与 turn204588view0";
		const items = build([
			msg({ id: "m4", role: "assistant", seq: 4, contentJson: [{ type: "text", text }] }),
		]);

		const blocks = textBlocks(items);
		expect(blocks[0].text).toBe(text);
		expect(blocks[0].copyText).toBe(text);
	});

	test("leaves marker-free assistant text and its copyText identical", () => {
		const items = build([
			msg({
				id: "m3",
				role: "assistant",
				seq: 3,
				contentJson: [{ type: "text", text: "普通正文" }],
			}),
		]);

		const blocks = textBlocks(items);
		expect(blocks[0].text).toBe("普通正文");
		expect(blocks[0].copyText).toBe("普通正文");
	});
});

describe("pixi user text is never projected", () => {
	test("a quoted marker stays verbatim in text and copyText", () => {
		const quoted = `${MARKER} 是什么`;
		const items = build([
			msg({
				id: "u1",
				role: "user",
				seq: 5,
				contentText: quoted,
				contentJson: [{ type: "text", text: quoted }],
			}),
		]);

		const blocks = textBlocks(items);
		expect(blocks[0].text).toBe(quoted);
		expect(blocks[0].copyText).toBe(quoted);
	});
});
