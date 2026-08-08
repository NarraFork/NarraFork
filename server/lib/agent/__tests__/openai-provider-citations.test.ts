/**
 * openai-provider-citations.test.ts — Responses API annotations are the STRUCTURED
 * source list; the inline `citeturn…` markers are the same information leaking
 * into the visible text. Parsing the annotations is what makes stripping the
 * markers lossless instead of destructive.
 *
 * Two regressions this pins:
 *  - the assistant-message branch used to `return` as soon as it captured the
 *    item id, so annotations riding on the SAME `output_item.done` event were
 *    silently dropped (the only fallback for gateways that never send the
 *    incremental annotation events);
 *  - non-URL annotations must still yield a reference, but never expose the
 *    provider's internal id as visible text.
 *
 * `parseResponsesAPIEvent` is shared by the HTTP SSE reader and the Codex
 * WebSocket transport, so covering it once covers both.
 */

import { describe, expect, test } from "bun:test";
import {
	parseResponsesAPIEvent,
	type ResponsesReasoningAccum,
	type ResponsesToolAccum,
} from "../openai-provider";

function parse(chunk: Record<string, unknown>) {
	const toolAccum = new Map<number, ResponsesToolAccum>();
	const reasoningAccum = new Map<number, ResponsesReasoningAccum>();
	return parseResponsesAPIEvent(chunk, toolAccum, reasoningAccum);
}

describe("streamed url_citation annotations", () => {
	test("maps start/end index, url and title", () => {
		const events = parse({
			type: "response.output_text.annotation.added",
			output_index: 1,
			annotation: {
				type: "url_citation",
				start_index: 10,
				end_index: 24,
				url: "https://example.test/a",
				title: "Example",
			},
		});

		const citations = events.flatMap((event) => event.textCitations ?? []);
		expect(citations).toEqual([
			{
				startIndex: 10,
				endIndex: 24,
				url: "https://example.test/a",
				title: "Example",
				sourceRef: undefined,
				outputIndex: 1,
			},
		]);
	});

	test("keeps a non-URL annotation as an internal ref", () => {
		const events = parse({
			type: "response.output_text.annotation.added",
			output_index: 0,
			annotation: { type: "file_citation", end_index: 5, file_id: "file_abc" },
		});

		const citations = events.flatMap((event) => event.textCitations ?? []);
		expect(citations).toHaveLength(1);
		expect(citations[0].sourceRef).toBe("file_abc");
		expect(citations[0].url).toBeUndefined();
	});

	test("drops an annotation with no usable position", () => {
		const events = parse({
			type: "response.output_text.annotation.added",
			annotation: { type: "url_citation", url: "https://example.test" },
		});

		expect(events.flatMap((event) => event.textCitations ?? [])).toHaveLength(0);
	});

	test("drops an annotation carrying no source at all", () => {
		const events = parse({
			type: "response.output_text.annotation.added",
			annotation: { type: "url_citation", start_index: 0, end_index: 3 },
		});

		expect(events.flatMap((event) => event.textCitations ?? [])).toHaveLength(0);
	});
});

describe("final output_item.done fallback", () => {
	test("emits both the message id and the item's annotations", () => {
		const events = parse({
			type: "response.output_item.done",
			output_index: 2,
			item: {
				type: "message",
				role: "assistant",
				id: "msg_123",
				content: [
					{
						type: "output_text",
						text: "answer",
						annotations: [
							{
								type: "url_citation",
								start_index: 0,
								end_index: 6,
								url: "https://example.test/b",
								title: "B",
							},
						],
					},
				],
			},
		});

		// The message id must survive, and the same event closes this output item's
		// stream parser just like Codex's `finish_item(item_id)`.
		expect(
			events.some(
				(event) =>
					event.messageId === "msg_123" &&
					event.textItemDone === true &&
					event.textOutputIndex === 2,
			),
		).toBe(true);
		const citations = events.flatMap((event) => event.textCitations ?? []);
		expect(citations).toHaveLength(1);
		expect(citations[0].url).toBe("https://example.test/b");
		expect(citations[0].outputIndex).toBe(2);
	});

	test("output_item.added does not emit citations", () => {
		const events = parse({
			type: "response.output_item.added",
			item: { type: "message", role: "assistant", id: "msg_1", content: [] },
		});

		expect(events.some((event) => event.messageId === "msg_1")).toBe(true);
		expect(events.flatMap((event) => event.textCitations ?? [])).toHaveLength(0);
	});

	test("collects annotations across several output_text parts", () => {
		const events = parse({
			type: "response.output_item.done",
			item: {
				type: "message",
				role: "assistant",
				id: "msg_2",
				content: [
					{
						type: "output_text",
						annotations: [{ type: "url_citation", end_index: 1, url: "https://a.test" }],
					},
					{
						type: "output_text",
						annotations: [{ type: "url_citation", end_index: 2, url: "https://b.test" }],
					},
				],
			},
		});

		expect(events.flatMap((event) => event.textCitations ?? [])).toHaveLength(2);
	});

	test("an assistant item without annotations behaves exactly as before", () => {
		const events = parse({
			type: "response.output_item.done",
			item: { type: "message", role: "assistant", id: "msg_3", content: [{ type: "output_text" }] },
		});

		expect(events).toEqual([
			{ messageId: "msg_3", textItemDone: true, textOutputIndex: undefined },
		]);
	});
});

describe("unrelated events are unaffected", () => {
	test("text deltas carry no citation payload", () => {
		const events = parse({
			type: "response.output_text.delta",
			delta: "hello",
			output_index: 0,
		});

		expect(events).toEqual([{ text: "hello", textOutputIndex: 0 }]);
	});
});
