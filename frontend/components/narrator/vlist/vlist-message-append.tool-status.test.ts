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

describe("upsertLoadedMessage preserves subagent file evidence", () => {
	const fileChanges = {
		files: [{ filePath: "src/file.ts", linesAdded: 3, linesRemoved: 1, editCount: 2 }],
		totalFiles: 1,
		totalUnmeasured: 0,
		bashTouchedCount: 0,
		countsTruncated: false,
	};
	const activity = {
		subagentNarratorId: "child",
		model: "model",
		latestToolCalls: [],
		fileChanges,
	};
	function activities(message: AppendCandidate) {
		return [
			...(message.contentJson as Array<{ _subagentActivity?: typeof activity | null }>),
			...(message.toolCalls as Array<{ _subagentActivity?: typeof activity | null }>),
		].map((row) => row._subagentActivity);
	}
	it.each([
		{},
		{ _subagentActivity: { subagentNarratorId: "child", model: null, latestToolCalls: [] } },
	])("retains the aggregate in both carriers when a projection omits it: %j", (extra) => {
		const previous = toolMessage("m1", "running", { _subagentActivity: activity });
		const result = upsertLoadedMessage([previous], toolMessage("m1", "running", extra), false);
		for (const next of activities(result.messages[0]))
			expect(next?.fileChanges).toEqual(fileChanges);
		expect(activities(previous)).toEqual([activity, activity]);
	});
	it("accepts explicit aggregate clearing and activity removal", () => {
		const previous = toolMessage("m1", "running", { _subagentActivity: activity });
		const empty = { ...fileChanges, files: [], totalFiles: 0 };
		for (const nextActivity of [{ ...activity, fileChanges: empty }, null, undefined]) {
			const result = upsertLoadedMessage(
				[previous],
				toolMessage("m1", "running", { _subagentActivity: nextActivity }),
				false,
			);
			expect(activities(result.messages[0])).toEqual([nextActivity, nextActivity]);
		}
	});
	it("does not copy files to a different child", () => {
		const previous = toolMessage("m1", "running", { _subagentActivity: activity });
		const { fileChanges: _files, ...omitted } = activity;
		const nextActivity = { ...omitted, subagentNarratorId: "new-child" };
		const result = upsertLoadedMessage(
			[previous],
			toolMessage("m1", "running", { _subagentActivity: nextActivity }),
			false,
		);
		for (const next of activities(result.messages[0])) {
			expect(next?.subagentNarratorId).toBe("new-child");
			expect(next?.fileChanges).toBeUndefined();
		}
	});
	it.each([
		{},
		{ _subagentActivity: { subagentNarratorId: "child", model: null, latestToolCalls: [] } },
	])("does not inherit the previous attempt on retry: %j", (extra) => {
		const previous = toolMessage("m1", "fail", {
			executionAttempt: 1,
			_subagentActivity: activity,
		});
		const result = upsertLoadedMessage(
			[previous],
			toolMessage("m1", "initializing", { executionAttempt: 2, ...extra }),
			false,
		);
		for (const next of activities(result.messages[0])) expect(next?.fileChanges).toBeUndefined();
	});
	it.each([
		{},
		{ executionAttempt: null },
	])("keeps attempt ownership across sparse updates before retry: %j", (sparseExtra) => {
		const previous = toolMessage("m1", "fail", {
			executionAttempt: 1,
			_subagentActivity: activity,
		});
		const sparse = upsertLoadedMessage(
			[previous],
			toolMessage("m1", "running", sparseExtra),
			false,
		);
		for (const summary of activities(sparse.messages[0]))
			expect(summary?.fileChanges).toEqual(fileChanges);
		const retry = upsertLoadedMessage(
			sparse.messages,
			toolMessage("m1", "initializing", { executionAttempt: 2 }),
			false,
		);
		for (const summary of activities(retry.messages[0])) expect(summary).toBeUndefined();
	});
	it("does not restore a tool block removed by an authoritative edit", () => {
		const previous = toolMessage("m1", "running", { _subagentActivity: activity });
		const incoming = {
			...toolMessage("m1", "running"),
			contentJson: [{ type: "text", text: "edited" }],
		};
		const result = upsertLoadedMessage([previous], incoming, false);
		expect(result.messages[0].contentJson).toEqual(incoming.contentJson);
	});
});
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
