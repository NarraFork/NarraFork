/**
 * message-tree-utils.tool-status.test.ts — tree merges must not rewind status.
 *
 * Catch-up reconciliation and live patches both go through `mergeToolFields`.
 * A stale `running` field set used to overwrite a live-patched `success`.
 */

import { describe, expect, it } from "bun:test";
import type { TreeMessage } from "@frontend/lib/api";
import { mergeToolCallFieldsInTree } from "./message-tree-utils";

function msg(status: string, extra: Record<string, unknown> = {}): TreeMessage {
	return {
		id: "m1",
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: "tu-1", name: "Edit", status, ...extra }],
		contentText: null,
		toolCalls: [{ toolUseId: "tu-1", toolName: "Edit", status, ...extra }],
		createdAt: "2026-01-01T00:00:00.000Z",
		children: [],
	} as TreeMessage;
}

describe("mergeToolCallFieldsInTree", () => {
	it("ignores a status regression from a late snapshot", () => {
		const previous = msg("success", { durationMs: 12_000, outputJson: "ok" });
		const result = mergeToolCallFieldsInTree([previous], "tu-1", {
			status: "running",
			inputJson: { file_path: "a.css" },
		});
		expect(result.changed).toBe(true);
		const message = result.messages[0];
		const tc = message.toolCalls?.[0] as { status?: string; durationMs?: number };
		expect(tc.status).toBe("success");
		expect(tc.durationMs).toBe(12_000);
		const block = message.contentJson?.find((b) => b.id === "tu-1") as {
			status?: string;
			durationMs?: number;
		};
		expect(block.status).toBe("success");
		expect(block.durationMs).toBe(12_000);
	});

	it("applies a forward completion", () => {
		const previous = msg("running", { startedAt: 5 });
		const result = mergeToolCallFieldsInTree([previous], "tu-1", {
			status: "success",
			durationMs: 7,
		});
		const tc = result.messages[0].toolCalls?.[0] as {
			status?: string;
			durationMs?: number;
			startedAt?: number;
		};
		expect(tc.status).toBe("success");
		expect(tc.durationMs).toBe(7);
		expect(tc.startedAt).toBe(5);
	});
});
