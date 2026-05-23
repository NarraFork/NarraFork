import { describe, expect, test } from "bun:test";
import { coerceCommitSyncErrorEvent } from "./useNarratorWS";

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
