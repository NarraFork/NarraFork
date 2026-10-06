/**
 * strip-citation-markers.test.ts — replaying provider-internal citation markers
 * into the model history is what makes the leak self-sustaining: the model reads
 * its own prior envelope and concludes the markers belong to its response format,
 * so it keeps emitting them even after ingress is fixed.
 *
 * Two boundaries are asserted because both are easy to get wrong in the safe
 * direction and the unsafe one:
 *  - user messages must NEVER be rewritten (a user may be quoting the marker to
 *    ask about it, and silently editing their words is worse than the leak);
 *  - the returned objects must be copies, since the same rows are held by caches
 *    and the UI, which must keep rendering the original.
 */

import { describe, expect, test } from "bun:test";
import { CHATGPT_CITATION_CLOSE, CHATGPT_CITATION_OPEN } from "@shared/citations";
import type { DbMessage } from "../provider";
import { stripCitationMarkersForModel } from "../strip-citation-markers";

const MARKER = `${CHATGPT_CITATION_OPEN}turn0search1${CHATGPT_CITATION_CLOSE}`;

function assistant(blocks: unknown[], contentText: string | null = null): DbMessage {
	return {
		id: "a1",
		role: "assistant",
		contentJson: blocks,
		contentText,
		parentToolUseId: null,
		messageUuid: null,
	};
}

function user(text: string): DbMessage {
	return {
		id: "u1",
		role: "user",
		contentJson: [{ type: "text", text }],
		contentText: text,
		parentToolUseId: null,
		messageUuid: null,
	};
}

describe("assistant history cleaning", () => {
	test("removes markers from text blocks and contentText", () => {
		const raw = `结论${MARKER}`;
		const input = [assistant([{ type: "text", text: raw }], raw)];
		const [out] = stripCitationMarkersForModel(input);

		expect((out.contentJson as Array<{ text: string }>)[0].text).toBe("结论");
		expect(out.contentText).toBe("结论");
	});

	test("leaves non-text blocks untouched", () => {
		const toolBlock = { type: "tool_use", id: "t1", name: "Read", input: { path: "a" } };
		const input = [assistant([toolBlock, { type: "text", text: `x ${MARKER}` }])];
		const [out] = stripCitationMarkersForModel(input);
		const blocks = out.contentJson as Array<Record<string, unknown>>;

		expect(blocks[0]).toBe(toolBlock);
		expect(blocks[1].text).toBe("x ");
	});

	test("preserves markers the assistant showed inside a code fence", () => {
		const text = ["示例：", "```", MARKER, "```"].join("\n");
		const [out] = stripCitationMarkersForModel([assistant([{ type: "text", text }])]);

		expect((out.contentJson as Array<{ text: string }>)[0].text).toBe(text);
	});

	test("returns the SAME array when nothing needs cleaning", () => {
		const input = [assistant([{ type: "text", text: "clean" }], "clean")];
		expect(stripCitationMarkersForModel(input)).toBe(input);
	});

	/**
	 * Other protocols never emit this envelope, so their history must be handed to
	 * the model byte-for-byte — including identifiers and URLs that merely contain
	 * a ref-shaped substring.
	 */
	test("passes through history that has no exact envelope", () => {
		const input = [
			assistant(
				[{ type: "text", text: "见 https://example.com/turn0search1 与 turn0view0_suffix" }],
				"见 https://example.com/turn0search1 与 turn0view0_suffix",
			),
		];
		expect(stripCitationMarkersForModel(input)).toBe(input);
	});

	test("does not mutate the original rows", () => {
		const raw = `结论${MARKER}`;
		const block = { type: "text", text: raw };
		const input = [assistant([block], raw)];
		stripCitationMarkersForModel(input);

		expect(block.text).toBe(raw);
		expect(input[0].contentText).toBe(raw);
	});
});

describe("non-assistant roles are never rewritten", () => {
	test("a user quoting the marker keeps it verbatim", () => {
		const input = [user(`为什么出现 ${MARKER} ？`)];
		const out = stripCitationMarkersForModel(input);

		expect(out).toBe(input);
		expect(out[0].contentText).toContain(MARKER);
	});

	test("mixed conversation cleans only the assistant side", () => {
		const raw = `内部标记${MARKER}`;
		const input = [user(`${MARKER} 是什么`), assistant([{ type: "text", text: raw }], raw)];
		const out = stripCitationMarkersForModel(input);

		expect(out[0]).toBe(input[0]);
		expect((out[1].contentJson as Array<{ text: string }>)[0].text).toBe("内部标记");
	});
});
