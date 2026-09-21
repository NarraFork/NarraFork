/**
 * vlist-message-append.tool-status.test.ts — upsert must not rewind tool status.
 *
 * A projection / catch-up snapshot can still say `running` for a call the
 * document already live-patched to `success`. Blindly replacing `toolCalls` and
 * `tool_use` blocks put the spinner back on the finished call until the next
 * structural reload — the "status lags by one tool call" bug.
 */

import { describe, expect, it } from "bun:test";
import type { AppendCandidate } from "./vlist-message-append";
import { upsertLoadedMessage } from "./vlist-message-append";

function toolMessage(
	id: string,
	status: string,
	extra: Record<string, unknown> = {},
): AppendCandidate {
	return {
		id,
		seq: 2,
		role: "assistant",
		parentToolUseId: null,
		contentJson: [
			{
				type: "tool_use",
				id: "tool-1",
				name: "Edit",
				status,
				...extra,
			},
		],
		toolCalls: [
			{
				toolUseId: "tool-1",
				toolName: "Edit",
				status,
				...extra,
			},
		],
	};
}

describe("upsertLoadedMessage preserves live tool lifecycle", () => {
	it("does not overwrite success with a stale running snapshot", () => {
		const previous = toolMessage("m1", "success", {
			durationMs: 15_000,
			outputJson: [{ type: "text", text: "ok" }],
			completedAt: 100,
		});
		const stale = toolMessage("m1", "running", {
			inputJson: { file_path: "trace-shimmer.css" },
		});
		const result = upsertLoadedMessage([previous], stale, false);
		expect(result.changed).toBe(true);
		const msg = result.messages[0] as {
			contentJson: Array<{ status?: string; durationMs?: number }>;
			toolCalls: Array<{ status?: string; durationMs?: number }>;
		};
		expect(msg.toolCalls[0]?.status).toBe("success");
		expect(msg.toolCalls[0]?.durationMs).toBe(15_000);
		const block = msg.contentJson.find((b) => (b as { id?: string }).id === "tool-1");
		expect(block?.status).toBe("success");
		expect(block?.durationMs).toBe(15_000);
	});

	it("still applies a forward completion over running", () => {
		const previous = toolMessage("m1", "running", { startedAt: 10 });
		const next = toolMessage("m1", "success", { durationMs: 4, completedAt: 20 });
		const result = upsertLoadedMessage([previous], next, false);
		const msg = result.messages[0] as {
			toolCalls: Array<{ status?: string; startedAt?: number; durationMs?: number }>;
		};
		expect(msg.toolCalls[0]?.status).toBe("success");
		expect(msg.toolCalls[0]?.durationMs).toBe(4);
		expect(msg.toolCalls[0]?.startedAt).toBe(10);
	});

	it("keeps previous toolCalls when the snapshot omits them", () => {
		const previous = toolMessage("m1", "success", { durationMs: 9 });
		const sparse = {
			id: "m1",
			seq: 2,
			role: "assistant",
			parentToolUseId: null,
			contentJson: [{ type: "text", text: "hello" }],
		} satisfies AppendCandidate;
		const result = upsertLoadedMessage([previous], sparse, false);
		const msg = result.messages[0] as { toolCalls: Array<{ status?: string }> };
		expect(msg.toolCalls[0]?.status).toBe("success");
	});
});
