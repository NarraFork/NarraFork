/**
 * vlist-live-patch.test.ts — Pins down the live-patch channel that keeps the
 * exact vlist's tool / reflection / subagent state truthful.
 *
 * The load-bearing assertion is "writes BOTH sides": a tool's facts live on the
 * `toolCalls[]` row AND on the enriched `tool_use` block in `contentJson`, and
 * the layout adapter reads the BLOCK first. A patch that updates only the row
 * looks correct in isolation yet changes nothing on screen — the exact failure
 * mode this module exists to prevent, and the reason it is asserted explicitly.
 */

import { describe, expect, it } from "bun:test";
import type { SubagentToolCallHeader, TreeMessage } from "@frontend/lib/api";
import {
	composeLivePatches,
	patchReflection,
	patchSubagentActivity,
	patchSubagentActivitySnapshots,
	patchToolCallFields,
} from "./vlist-live-patch";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface ToolSeed {
	toolUseId: string;
	toolName?: string;
	status?: string;
	permissionSuggestions?: unknown[] | null;
	inputJson?: unknown;
	outputJson?: unknown;
}

/** An assistant message carrying `tool_use` blocks enriched exactly as the API does. */
function assistantWithTools(id: string, tools: readonly ToolSeed[]): TreeMessage {
	return {
		id,
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: tools.map((tool) => ({
			type: "tool_use",
			id: tool.toolUseId,
			name: tool.toolName ?? "Bash",
			input: {},
			// enrichToolUseBlocks copies the row's fields onto the block.
			status: tool.status ?? "running",
			inputJson: tool.inputJson,
			outputJson: tool.outputJson,
			permissionSuggestions: tool.permissionSuggestions ?? null,
		})) as TreeMessage["contentJson"],
		contentText: null,
		toolCalls: tools.map((tool, index) => ({
			id: `tc-${tool.toolUseId}-${index}`,
			narratorId: "n1",
			messageId: id,
			toolUseId: tool.toolUseId,
			toolName: tool.toolName ?? "Bash",
			status: tool.status ?? "running",
			inputJson: tool.inputJson,
			outputJson: tool.outputJson,
			permissionSuggestions: tool.permissionSuggestions ?? null,
			createdAt: "2026-01-01T00:00:00.000Z",
		})) as unknown as TreeMessage["toolCalls"],
		createdAt: "2026-01-01T00:00:00.000Z",
		children: [],
	};
}

/** Read the patched status off BOTH storage sites for one toolUseId. */
function readStatuses(
	messages: readonly TreeMessage[],
	toolUseId: string,
): { row?: string; block?: string } {
	for (const msg of messages) {
		const row = msg.toolCalls?.find((tc) => tc.toolUseId === toolUseId);
		const block = msg.contentJson?.find((b) => b.type === "tool_use" && b.id === toolUseId);
		if (row || block) {
			return {
				...(row ? { row: row.status as string } : {}),
				...(block ? { block: (block as { status?: string }).status } : {}),
			};
		}
		if (msg.children?.length) {
			const nested = readStatuses(msg.children, toolUseId);
			if (nested.row || nested.block) return nested;
		}
	}
	return {};
}

function findBlock(
	messages: readonly TreeMessage[],
	toolUseId: string,
): Record<string, unknown> | undefined {
	for (const msg of messages) {
		const block = msg.contentJson?.find((b) => b.type === "tool_use" && b.id === toolUseId);
		if (block) return block as unknown as Record<string, unknown>;
		if (msg.children?.length) {
			const nested = findBlock(msg.children, toolUseId);
			if (nested) return nested;
		}
	}
	return undefined;
}

const reflectionSuggestion = (status: string, requestId: string) => [
	{ type: "danger_reflection", status, requestId },
];

// ─────────────────────────────────────────────────────────────────────────────
// patchToolCallFields
// ─────────────────────────────────────────────────────────────────────────────

describe("patchToolCallFields", () => {
	it("writes the status onto BOTH the toolCalls row and the enriched content block", () => {
		// THE critical assertion: the adapter reads the block first, so a row-only
		// patch would leave the card rendering "running" forever.
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1", status: "running" }])];
		const result = patchToolCallFields(messages, "tu-1", {
			status: "success",
			outputJson: "done",
			durationMs: 1234,
		});

		expect(result.changed).toBe(true);
		expect(readStatuses(result.messages, "tu-1")).toEqual({ row: "success", block: "success" });
		const block = findBlock(result.messages, "tu-1");
		expect(block?.outputJson).toBe("done");
		expect(block?.durationMs).toBe(1234);
	});

	it("does not mutate the input list (immutable patch)", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1", status: "running" }])];
		patchToolCallFields(messages, "tu-1", { status: "fail" });
		// The original snapshot must still read "running" on both sides.
		expect(readStatuses(messages, "tu-1")).toEqual({ row: "running", block: "running" });
	});

	it("returns the ORIGINAL reference when the toolUseId is not loaded", () => {
		// Referential no-op lets the coordinator skip the rebuild entirely, so a
		// narrator without this tool pays nothing per event.
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1" }])];
		const result = patchToolCallFields(messages, "tu-absent", { status: "success" });
		expect(result.changed).toBe(false);
		expect(result.messages).toBe(messages);
	});

	it("treats an empty field set and a blank id as no-ops", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1" }])];
		expect(patchToolCallFields(messages, "tu-1", {}).messages).toBe(messages);
		expect(patchToolCallFields(messages, "", { status: "success" }).messages).toBe(messages);
		expect(patchToolCallFields([], "tu-1", { status: "success" }).changed).toBe(false);
	});

	it("patches a tool call nested in a child (subagent) message tree", () => {
		const child = assistantWithTools("c1", [{ toolUseId: "tu-child", status: "running" }]);
		const parent: TreeMessage = {
			...assistantWithTools("m1", [{ toolUseId: "tu-parent", toolName: "Agent" }]),
			children: [{ ...child, parentToolUseId: "tu-parent" }],
		};
		const result = patchToolCallFields([parent], "tu-child", { status: "fail" });
		expect(result.changed).toBe(true);
		expect(readStatuses(result.messages, "tu-child")).toEqual({ row: "fail", block: "fail" });
	});

	it("preserves a persisted input when the incoming one is streaming-only", () => {
		// Mirrors mergeToolFields: a `_streaming*` marker merges INTO the real input
		// rather than replacing it, so a live chunk cannot erase the tool's target.
		const messages = [
			assistantWithTools("m1", [{ toolUseId: "tu-1", inputJson: { file_path: "/a.ts" } }]),
		];
		const result = patchToolCallFields(messages, "tu-1", {
			inputJson: { _streamingChars: 12 },
		});
		const block = findBlock(result.messages, "tu-1");
		expect(block?.inputJson).toEqual({ file_path: "/a.ts", _streamingChars: 12 });
	});

	it("keeps an existing output when the patch omits outputJson", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1", outputJson: "kept" }])];
		const result = patchToolCallFields(messages, "tu-1", { status: "success" });
		expect(findBlock(result.messages, "tu-1")?.outputJson).toBe("kept");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal-status guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WS ordering only holds while the socket stays up. On a reconnect the catch-up
 * replay can deliver a `permission_resolved` / `tool_started` AFTER the
 * `tool_completed` that superseded it. Both write their status unconditionally, so
 * without a guard a finished card flips back to `running` with a fresh `startedAt`
 * and spins forever — nothing will complete it a second time.
 */
describe("terminal-status guard", () => {
	it("refuses to push a finished tool back to running", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1", status: "success" }])];
		const result = patchToolCallFields(messages, "tu-1", {
			status: "running",
			startedAt: 12345,
		});
		expect(result.changed).toBe(false);
		expect(result.messages).toBe(messages);
	});

	it("refuses to push a finished tool back to pending", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1", status: "fail" }])];
		expect(patchToolCallFields(messages, "tu-1", { status: "pending" }).changed).toBe(false);
	});

	it("drops the regressing status but KEEPS the rest of a late decision's fields", () => {
		// A late deny still records its reason on the finished card; only the lifecycle
		// position is pinned. `startedAt` goes with the status (it exists solely to
		// start the header's live timer, so keeping it would restart a finished card's
		// elapsed counter).
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1", status: "success" }])];
		const result = patchToolCallFields(messages, "tu-1", {
			status: "running",
			startedAt: 999,
			permissionDecisionReason: "reviewed late",
		});
		expect(result.changed).toBe(true);
		const block = findBlock(result.messages, "tu-1");
		expect(block?.status).toBe("success");
		expect(block?.startedAt).toBeUndefined();
		expect(block?.permissionDecisionReason).toBe("reviewed late");
	});

	it("allows one terminal status to replace another (fail after success)", () => {
		// Only REGRESSIONS are blocked. A corrected terminal status must still land.
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1", status: "success" }])];
		const result = patchToolCallFields(messages, "tu-1", { status: "fail" });
		expect(readStatuses(result.messages, "tu-1")).toEqual({ row: "fail", block: "fail" });
	});

	it("still advances a non-terminal card normally", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1", status: "pending" }])];
		const result = patchToolCallFields(messages, "tu-1", { status: "running", startedAt: 5 });
		expect(readStatuses(result.messages, "tu-1")).toEqual({ row: "running", block: "running" });
		expect(findBlock(result.messages, "tu-1")?.startedAt).toBe(5);
	});

	it("guards the reflection path too", () => {
		// The request-id gating makes this rare, not impossible: a reconnect can replay
		// the gate that is still the newest one on a card the completion already ended.
		const messages = [
			assistantWithTools("m1", [
				{
					toolUseId: "tu-1",
					status: "success",
					permissionSuggestions: reflectionSuggestion("running", "req-1"),
				},
			]),
		];
		const result = patchReflection(messages, "tu-1", "req-1", "danger_reflection", "terminal", {
			status: "running",
			permissionSuggestions: reflectionSuggestion("confirmed", "req-1"),
		});
		expect(result.changed).toBe(true);
		const block = findBlock(result.messages, "tu-1");
		// The gate's own state advances; the tool's lifecycle position does not regress.
		expect(block?.status).toBe("success");
		expect(block?.permissionSuggestions).toEqual(reflectionSuggestion("confirmed", "req-1"));
	});

	it("judges regression against the NEWEST occurrence of a reused toolUseId", () => {
		// An older finished card must not veto a legitimate start on the newest one.
		const older = assistantWithTools("m1", [{ toolUseId: "tu-dup", status: "success" }]);
		const newer = assistantWithTools("m2", [{ toolUseId: "tu-dup", status: "pending" }]);
		const result = patchToolCallFields([older, newer], "tu-dup", { status: "running" });
		expect(result.changed).toBe(true);
		expect(
			(result.messages[1]?.contentJson[0] as unknown as { status?: string } | undefined)?.status,
		).toBe("running");
	});

	it("recognizes terminal aliases the backend may persist", () => {
		for (const terminal of ["completed", "failed", "canceled", "aborted", "timeout", "denied"]) {
			const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1", status: terminal }])];
			expect(patchToolCallFields(messages, "tu-1", { status: "running" }).changed).toBe(false);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// patchReflection
// ─────────────────────────────────────────────────────────────────────────────

describe("patchReflection", () => {
	it("accepts a `started` gate when the card carries no request id yet", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1" }])];
		const result = patchReflection(messages, "tu-1", "req-1", "danger_reflection", "started", {
			status: "pending",
			permissionSuggestions: reflectionSuggestion("running", "req-1"),
		});
		expect(result.changed).toBe(true);
		expect(findBlock(result.messages, "tu-1")?.permissionSuggestions).toEqual(
			reflectionSuggestion("running", "req-1"),
		);
	});

	it("applies a `terminal` transition for the SAME request id (running → confirmed)", () => {
		const messages = [
			assistantWithTools("m1", [
				{ toolUseId: "tu-1", permissionSuggestions: reflectionSuggestion("running", "req-1") },
			]),
		];
		const result = patchReflection(messages, "tu-1", "req-1", "danger_reflection", "terminal", {
			status: "running",
			permissionSuggestions: reflectionSuggestion("confirmed", "req-1"),
		});
		expect(result.changed).toBe(true);
		// Both sides again — the reflection notice is measured off the block.
		expect(findBlock(result.messages, "tu-1")?.permissionSuggestions).toEqual(
			reflectionSuggestion("confirmed", "req-1"),
		);
	});

	it("rejects a `terminal` transition from a superseded request id", () => {
		// A late resolve for an older gate must not clobber the live one.
		const messages = [
			assistantWithTools("m1", [
				{ toolUseId: "tu-1", permissionSuggestions: reflectionSuggestion("running", "req-2") },
			]),
		];
		const result = patchReflection(messages, "tu-1", "req-1", "danger_reflection", "terminal", {
			permissionSuggestions: reflectionSuggestion("cancelled", "req-1"),
		});
		expect(result.changed).toBe(false);
		expect(result.messages).toBe(messages);
	});

	it("rejects a `started` gate that collides with a different live request id", () => {
		const messages = [
			assistantWithTools("m1", [
				{ toolUseId: "tu-1", permissionSuggestions: reflectionSuggestion("running", "req-2") },
			]),
		];
		const result = patchReflection(messages, "tu-1", "req-1", "danger_reflection", "started", {
			permissionSuggestions: reflectionSuggestion("running", "req-1"),
		});
		expect(result.changed).toBe(false);
	});

	it("is idempotent for a duplicate `started` with the same request id", () => {
		const messages = [
			assistantWithTools("m1", [
				{ toolUseId: "tu-1", permissionSuggestions: reflectionSuggestion("running", "req-1") },
			]),
		];
		const result = patchReflection(messages, "tu-1", "req-1", "danger_reflection", "started", {
			permissionSuggestions: reflectionSuggestion("running", "req-1"),
		});
		expect(result.changed).toBe(true);
		expect(findBlock(result.messages, "tu-1")?.permissionSuggestions).toEqual(
			reflectionSuggestion("running", "req-1"),
		);
	});

	it("no-ops when the tool occurrence is not loaded", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1" }])];
		const result = patchReflection(messages, "tu-absent", "req-1", "danger_reflection", "started", {
			status: "pending",
		});
		expect(result.changed).toBe(false);
		expect(result.messages).toBe(messages);
	});

	it("targets only the NEWEST occurrence of a reused toolUseId", () => {
		// Reflection identity is per-occurrence: the older card must stay untouched.
		const older = assistantWithTools("m1", [{ toolUseId: "tu-dup", status: "success" }]);
		const newer = assistantWithTools("m2", [{ toolUseId: "tu-dup", status: "running" }]);
		const result = patchReflection(
			[older, newer],
			"tu-dup",
			"req-1",
			"plan_reflection",
			"started",
			{
				permissionSuggestions: [{ type: "plan_reflection", status: "running", requestId: "req-1" }],
			},
		);
		expect(result.changed).toBe(true);
		expect(result.messages[0]?.contentJson[0]?.permissionSuggestions).toBeNull();
		expect(result.messages[1]?.contentJson[0]?.permissionSuggestions).toEqual([
			{ type: "plan_reflection", status: "running", requestId: "req-1" },
		]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Subagent activity
// ─────────────────────────────────────────────────────────────────────────────

function header(toolUseId: string, status: string): SubagentToolCallHeader {
	return { toolCallId: null, toolUseId, toolName: "Read", status, createdAt: 1, timing: null };
}

describe("patchSubagentActivity", () => {
	it("upserts a child tool header onto the parent card's activity summary", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-parent", toolName: "Agent" }])];
		const result = patchSubagentActivity(messages, "tu-parent", header("tu-child", "running"), {
			subagentNarratorId: "sub-1",
			model: "claude",
		});
		expect(result.changed).toBe(true);
		const activity = findBlock(result.messages, "tu-parent")?._subagentActivity as {
			subagentNarratorId?: string;
			model?: string;
			latestToolCalls: SubagentToolCallHeader[];
		};
		expect(activity.subagentNarratorId).toBe("sub-1");
		expect(activity.model).toBe("claude");
		expect(activity.latestToolCalls).toHaveLength(1);
		expect(activity.latestToolCalls[0]?.status).toBe("running");
	});

	it("does not let a blank incoming model erase a known one", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-parent", toolName: "Agent" }])];
		const seeded = patchSubagentActivity(messages, "tu-parent", header("tu-c1", "running"), {
			model: "claude",
		});
		const updated = patchSubagentActivity(
			seeded.messages,
			"tu-parent",
			header("tu-c1", "success"),
			{
				model: "   ",
			},
		);
		const activity = findBlock(updated.messages, "tu-parent")?._subagentActivity as {
			model?: string;
		};
		expect(activity.model).toBe("claude");
	});

	it("no-ops for an unknown parent tool use", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-parent", toolName: "Agent" }])];
		const result = patchSubagentActivity(messages, "tu-other", header("tu-child", "running"));
		expect(result.changed).toBe(false);
		expect(result.messages).toBe(messages);
	});
});

describe("patchSubagentActivitySnapshots", () => {
	it("replaces activity from the authoritative catch-up snapshot", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-parent", toolName: "Agent" }])];
		const result = patchSubagentActivitySnapshots(messages, [
			{
				parentToolUseId: "tu-parent",
				activity: {
					subagentNarratorId: "sub-9",
					model: "gpt",
					latestToolCalls: [header("tu-a", "success")],
				},
			},
		]);
		expect(result.changed).toBe(true);
		const activity = findBlock(result.messages, "tu-parent")?._subagentActivity as {
			subagentNarratorId?: string;
			latestToolCalls: SubagentToolCallHeader[];
		};
		expect(activity.subagentNarratorId).toBe("sub-9");
		expect(activity.latestToolCalls).toHaveLength(1);
	});

	it("no-ops for an empty snapshot list", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-parent" }])];
		expect(patchSubagentActivitySnapshots(messages, []).messages).toBe(messages);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// composeLivePatches
// ─────────────────────────────────────────────────────────────────────────────

describe("composeLivePatches", () => {
	it("threads several patches into one result so a batch rebuilds once", () => {
		const messages = [
			assistantWithTools("m1", [
				{ toolUseId: "tu-1", status: "running" },
				{ toolUseId: "tu-2", status: "running" },
			]),
		];
		const composed = composeLivePatches([
			(list) => patchToolCallFields(list, "tu-1", { status: "success" }),
			(list) => patchToolCallFields(list, "tu-2", { status: "fail" }),
		]);
		const result = composed(messages);
		expect(result.changed).toBe(true);
		expect(readStatuses(result.messages, "tu-1").block).toBe("success");
		expect(readStatuses(result.messages, "tu-2").block).toBe("fail");
	});

	it("reports no change (original reference) when every patch misses", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1" }])];
		const composed = composeLivePatches([
			(list) => patchToolCallFields(list, "nope-1", { status: "success" }),
			(list) => patchToolCallFields(list, "nope-2", { status: "fail" }),
		]);
		const result = composed(messages);
		expect(result.changed).toBe(false);
		expect(result.messages).toBe(messages);
	});

	it("still applies the remaining patches when one misses", () => {
		const messages = [assistantWithTools("m1", [{ toolUseId: "tu-1", status: "running" }])];
		const composed = composeLivePatches([
			(list) => patchToolCallFields(list, "nope", { status: "success" }),
			(list) => patchToolCallFields(list, "tu-1", { status: "success" }),
		]);
		const result = composed(messages);
		expect(result.changed).toBe(true);
		expect(readStatuses(result.messages, "tu-1").block).toBe("success");
	});
});
