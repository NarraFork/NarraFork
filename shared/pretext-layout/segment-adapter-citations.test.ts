/**
 * segment-adapter-citations.test.ts — the adapter is the ONE place VList and Pixi
 * share for assistant markdown, so it is where the citation projection has to
 * happen for both renderers to agree.
 *
 * Two asymmetries are load-bearing and easy to break:
 *  - assistant text is projected, user text is NOT (a user quoting `citeturn…`
 *    must see their own words back);
 *  - a live block additionally hides a half-arrived marker, a settled one does
 *    not (on finished text a trailing "cite" can be a real word).
 */

import { describe, expect, it } from "bun:test";
import { CHATGPT_CITATION_CLOSE, CHATGPT_CITATION_OPEN } from "../citations";
import {
	type AdapterContentBlock,
	type AdapterContext,
	type AdapterMessage,
	adaptSegment,
} from "./segment-adapter";
import { STREAMING_MESSAGE_ID } from "./streaming-live-blocks";

/** L1 is the default reading level; citation projection is LOD-independent. */
const CTX: AdapterContext = { lod: 1 };
const MARKER = `${CHATGPT_CITATION_OPEN}turn204588view0${CHATGPT_CITATION_CLOSE}`;

function assistantMessage(blocks: AdapterContentBlock[], id = "m1"): AdapterMessage {
	return { id, role: "assistant", contentJson: blocks };
}

function markdownSpecs(msg: AdapterMessage) {
	return adaptSegment({ kind: "message", msg }, CTX).filter((spec) => spec.kind === "markdown");
}

describe("assistant markdown citation projection", () => {
	it("renders a resolved citation as a Markdown link", () => {
		const specs = markdownSpecs(
			assistantMessage([
				{
					type: "text",
					text: "结论成立",
					citations: [
						{ startIndex: 4, endIndex: 4, sources: [{ url: "https://a.test", title: "A" }] },
					],
				},
			]),
		);

		expect(specs).toHaveLength(1);
		expect(specs[0].data).toBe("结论成立[1](<https://a.test>)");
	});

	it("renders an internal-only citation as a plain number, never the raw ref", () => {
		const specs = markdownSpecs(
			assistantMessage([
				{
					type: "text",
					text: "结论成立",
					citations: [{ startIndex: 4, endIndex: 4, sources: [{ sourceRef: "turn0view0" }] }],
				},
			]),
		);

		expect(specs[0].data).toBe("结论成立[1]");
		expect(specs[0].data as string).not.toContain("turn0view0");
	});

	it("strips exact legacy envelopes from historical rows", () => {
		const specs = markdownSpecs(assistantMessage([{ type: "text", text: `已修复${MARKER}` }]));

		expect(specs[0].data).toBe("已修复[1]");
		expect(specs[0].data as string).not.toContain("turn204588view0");
	});

	it("leaves marker-free assistant text byte-identical", () => {
		const text = "普通正文，没有任何引用。";
		const specs = markdownSpecs(assistantMessage([{ type: "text", text }]));

		expect(specs[0].data).toBe(text);
	});

	it("does not rewrite an exact envelope shown inside a code fence", () => {
		const text = ["示例：", "```text", MARKER, "```"].join("\n");
		const specs = markdownSpecs(assistantMessage([{ type: "text", text }]));

		expect(specs[0].data).toBe(text);
	});
});

describe("user text is never projected", () => {
	it("keeps a quoted marker verbatim in the user bubble", () => {
		const msg: AdapterMessage = {
			id: "u1",
			role: "user",
			contentJson: [{ type: "text", text: `为什么会出现 ${MARKER} ？` }],
		};
		const specs = adaptSegment({ kind: "message", msg }, CTX);
		const bubble = specs.find((spec) => spec.kind === "message-bubble");

		expect(bubble).toBeDefined();
		expect((bubble?.data as { text: string }).text).toContain(MARKER);
	});
});

describe("streaming tail handling", () => {
	it("hides a half-arrived exact opener on the live block", () => {
		const msg = assistantMessage([{ type: "text", text: "进行中\ue200ci" }], STREAMING_MESSAGE_ID);
		const specs = markdownSpecs(msg);

		expect(specs[0].data).toBe("进行中");
	});

	it("keeps a trailing word that only looks like a marker prefix once settled", () => {
		const msg = assistantMessage([{ type: "text", text: "please cite" }], "settled");
		const specs = markdownSpecs(msg);

		expect(specs[0].data).toBe("please cite");
	});
});
