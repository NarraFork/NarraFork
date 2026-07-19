import { describe, expect, test } from "bun:test";
import {
	coerceCommitSyncErrorEvent,
	coercePermissionRoutingFields,
	normalizeSubagentActivityCatchUp,
} from "./useNarratorWS";

describe("coerceCommitSyncErrorEvent", () => {
	test("preserves structured commit sync diagnostics", () => {
		expect(
			coerceCommitSyncErrorEvent({
				chapterId: "chapter-1",
				code: "WORKTREE_WATCHER_COMMIT_SYNC_FAILED",
				reason: "failed to read git log",
				error: "git log failed",
				fallback: true,
				fatal: false,
				backgroundSync: true,
				extra: "kept",
			}),
		).toEqual({
			chapterId: "chapter-1",
			code: "WORKTREE_WATCHER_COMMIT_SYNC_FAILED",
			reason: "failed to read git log",
			error: "git log failed",
			message: undefined,
			fallback: true,
			fatal: false,
			backgroundSync: true,
			extra: "kept",
		});
	});

	test("ignores events without a chapter id", () => {
		expect(coerceCommitSyncErrorEvent({ code: "WORKTREE_WATCHER_COMMIT_SYNC_FAILED" })).toBeNull();
	});
});

describe("coercePermissionRoutingFields", () => {
	test("keeps subagent permission ownership fields from reflection events", () => {
		expect(
			coercePermissionRoutingFields({
				parentToolUseId: "parent-tool",
				subagentNarratorId: "subagent-1",
				ownerNarratorId: "subagent-1",
			}),
		).toEqual({
			parentToolUseId: "parent-tool",
			subagentNarratorId: "subagent-1",
			ownerNarratorId: "subagent-1",
		});
	});
});

describe("normalizeSubagentActivityCatchUp", () => {
	test("normalizes the array contract and legacy record contract", () => {
		const activity = {
			subagentNarratorId: "subagent-1",
			model: "model-1",
			latestToolCalls: [
				{
					toolCallId: "row-1",
					toolUseId: "tool-1",
					toolName: "Read",
					status: "success",
					createdAt: "2026-07-18T00:00:00.000Z",
					completedAt: "2026-07-18T00:00:01.000Z",
					durationMs: 1000,
				},
			],
		};

		for (const payload of [
			[{ parentToolUseId: "parent-tool", activity }],
			{ "parent-tool": activity },
		]) {
			expect(normalizeSubagentActivityCatchUp(payload)).toEqual([
				{
					parentToolUseId: "parent-tool",
					activity: {
						subagentNarratorId: "subagent-1",
						model: "model-1",
						latestToolCalls: [
							{
								toolCallId: "row-1",
								toolUseId: "tool-1",
								toolName: "Read",
								status: "success",
								createdAt: "2026-07-18T00:00:00.000Z",
								timing: {
									completedAt: "2026-07-18T00:00:01.000Z",
									durationMs: 1000,
								},
							},
						],
					},
				},
			]);
		}
	});
});
