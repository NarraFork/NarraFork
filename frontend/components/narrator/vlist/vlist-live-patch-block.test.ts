import { describe, expect, test } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api/types";
import { messageBody } from "@shared/narrator-blocks/message-blocks";
import { toolCompletedPatch } from "./vlist-live-events";

/** Two rows holding the same call id (a reused provider id), each in its own tool block. */
function rows(): TreeMessage[] {
	const row = (id: string, blockId: string) =>
		({
			id,
			narratorId: "n1",
			parentToolUseId: null,
			role: "assistant",
			contentText: null,
			createdAt: "2026-10-01T00:00:00.000Z",
			toolCalls: [],
			blocks: [
				{
					id: blockId,
					kind: "tool",
					subtype: null,
					phase: "open",
					revision: 0,
					wireId: "call_1",
					attemptId: null,
					hasOriginal: false,
					named: true,
					elements: [
						{ type: "tool_use", id: "call_1", name: "Bash", input: {}, status: "running" },
					],
				},
			],
		}) as unknown as TreeMessage;
	return [row("m1", "b-old"), row("m2", "b-new")];
}

const status = (messages: readonly TreeMessage[]) =>
	messages.map((message) => (messageBody(message)[0] as { status?: string }).status);

describe("tool lifecycle patches", () => {
	test("a frame naming its tool block patches only that block's row", () => {
		const patch = toolCompletedPatch({ toolUseId: "call_1", blockId: "b-old", status: "success" });
		const result = patch(rows());
		expect(result.changed).toBe(true);
		expect(status(result.messages)).toEqual(["success", "running"]);
	});

	test("without a block id every occurrence of the call is patched, as before", () => {
		const result = toolCompletedPatch({ toolUseId: "call_1", status: "success" })(rows());
		expect(status(result.messages)).toEqual(["success", "success"]);
	});

	test("a block no loaded row holds falls back to every occurrence", () => {
		const result = toolCompletedPatch({ toolUseId: "call_1", blockId: "b-gone", status: "fail" })(
			rows(),
		);
		expect(status(result.messages)).toEqual(["fail", "fail"]);
	});
});
