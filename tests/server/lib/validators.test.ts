import { describe, expect, it } from "bun:test";
import {
	batchMergeSchema,
	createProjectSchema,
	createReviewSchema,
	createScheduledTaskSchema,
	forkChapterSchema,
	mergeChapterSchema,
	registerSchema,
	updateUserPreferencesSchema,
} from "../../../server/lib/validators";
import { recentTabSchema, restoreRecentTabsSchema } from "../../../server/lib/validators/settings";
import { narratorWsMessageSchema } from "../../../server/lib/validators/websocket";
import { SUPPORTED_LOCALES } from "../../../shared/i18n-locales";

describe("createProjectSchema", () => {
	it("accepts valid input", () => {
		const result = createProjectSchema.safeParse({
			name: "My Project",
			repoMode: "existing",
			gitPath: "/tmp/my-project",
		});
		expect(result.success).toBe(true);
	});

	it("rejects empty name", () => {
		const result = createProjectSchema.safeParse({
			name: "",
			repoMode: "existing",
			gitPath: "/tmp/my-project",
		});
		expect(result.success).toBe(false);
	});

	it("rejects name over 200 chars", () => {
		const result = createProjectSchema.safeParse({
			name: "x".repeat(201),
			repoMode: "existing",
			gitPath: "/tmp/my-project",
		});
		expect(result.success).toBe(false);
	});
});

describe("registerSchema", () => {
	it("accepts valid credentials", () => {
		const result = registerSchema.safeParse({ username: "alice", password: "12345678" });
		expect(result.success).toBe(true);
	});

	it("rejects short username", () => {
		const result = registerSchema.safeParse({ username: "ab", password: "12345678" });
		expect(result.success).toBe(false);
	});

	it("rejects short password", () => {
		const result = registerSchema.safeParse({ username: "alice", password: "1234567" });
		expect(result.success).toBe(false);
	});

	it("rejects special chars in username", () => {
		const result = registerSchema.safeParse({ username: "al ice!", password: "12345678" });
		expect(result.success).toBe(false);
	});
});

describe("forkChapterSchema", () => {
	it("accepts valid fork input", () => {
		const result = forkChapterSchema.safeParse({
			title: "Experiment",
			inheritMode: "compressed",
		});
		expect(result.success).toBe(true);
	});

	it("rejects invalid inherit mode", () => {
		const result = forkChapterSchema.safeParse({
			title: "Test",
			inheritMode: "invalid",
		});
		expect(result.success).toBe(false);
	});
});

describe("mergeChapterSchema", () => {
	it("accepts valid merge input", () => {
		const result = mergeChapterSchema.safeParse({
			targetChapterId: "abc",
			strategy: "squash",
		});
		expect(result.success).toBe(true);
	});

	it("rejects invalid strategy", () => {
		const result = mergeChapterSchema.safeParse({
			targetChapterId: "abc",
			strategy: "rebase",
		});
		expect(result.success).toBe(false);
	});
});

describe("batchMergeSchema", () => {
	it("requires at least one source chapter", () => {
		const result = batchMergeSchema.safeParse({
			baseChapterId: "a",
			sourceChapterIds: [],
			title: "Merge",
		});
		expect(result.success).toBe(false);
	});
});

describe("shared locale validation", () => {
	it("accepts every locale from the shared registry", () => {
		for (const locale of SUPPORTED_LOCALES) {
			expect(updateUserPreferencesSchema.safeParse({ language: locale }).success).toBe(true);
			expect(createReviewSchema.safeParse({ locale }).success).toBe(true);
			expect(
				createScheduledTaskSchema.safeParse({
					name: "Hourly task",
					cronExpr: "0 * * * *",
					prompt: "Run checks",
					locale,
				}).success,
			).toBe(true);
		}
	});

	it("rejects locales outside the shared registry", () => {
		expect(updateUserPreferencesSchema.safeParse({ language: "unsupported" }).success).toBe(false);
		expect(createReviewSchema.safeParse({ locale: "unsupported" }).success).toBe(false);
	});
});

describe("narrator websocket catch-up cursor validation", () => {
	const catchUpCursor = {
		parentLastMessageId: "parent-message",
		childAnchors: [
			{
				parentToolUseId: "parent-tool",
				narratorId: "child-narrator",
				lastMessageId: "child-message",
			},
		],
	};

	it("accepts the canonical cursor including child anchor lastMessageId", () => {
		expect(
			narratorWsMessageSchema.safeParse({
				type: "subscribe",
				narratorIds: ["narrator-1"],
				kind: "messages",
				catchUpCursor,
			}).success,
		).toBe(true);
		expect(
			narratorWsMessageSchema.safeParse({
				type: "sync_check",
				narratorId: "narrator-1",
				version: 4,
				catchUpCursor,
			}).success,
		).toBe(true);
	});

	it("rejects the removed top-level lastMessageId field", () => {
		expect(
			narratorWsMessageSchema.safeParse({
				type: "subscribe",
				narratorIds: ["narrator-1"],
				kind: "messages",
				lastMessageId: "old-anchor",
			}).success,
		).toBe(false);
		expect(
			narratorWsMessageSchema.safeParse({
				type: "sync_check",
				narratorId: "narrator-1",
				version: 4,
				lastMessageId: "old-anchor",
			}).success,
		).toBe(false);
	});

	it("limits subscribe and unsubscribe frames to 100 narrator ids", () => {
		const oneHundred = Array.from({ length: 100 }, (_, index) => `narrator-${index}`);
		const oneHundredOne = [...oneHundred, "narrator-100"];

		for (const type of ["subscribe", "unsubscribe"] as const) {
			expect(narratorWsMessageSchema.safeParse({ type, narratorIds: oneHundred }).success).toBe(
				true,
			);
			expect(narratorWsMessageSchema.safeParse({ type, narratorIds: oneHundredOne }).success).toBe(
				false,
			);
		}
	});
});

/**
 * The recent-tab payload's `dirSortOrder`.
 *
 * Zod strips unknown keys, so a field the client sends and the service honours is
 * silently discarded unless the schema DECLARES it. That is what happened to the
 * hand-arranged directory position: the undo-restore path dropped it on every
 * request, flattening the groups back to recency order with no error anywhere. The
 * service-level tests cannot see this — they call the service directly, past Zod —
 * so the guarantee has to be asserted at the schema.
 */
describe("recentTabSchema — dirSortOrder", () => {
	const base = {
		type: "narrator" as const,
		id: "n-1",
		title: "Tab",
		lastVisitedAt: 1,
	};

	it("PRESERVES a hand-arranged position instead of stripping it", () => {
		const result = recentTabSchema.safeParse({ ...base, dirSortOrder: 3 });
		expect(result.success).toBe(true);
		expect(result.success && result.data.dirSortOrder).toBe(3);
	});

	it("accepts 0 as a real position, not a missing one", () => {
		// 0 is the first slot in a group; a falsy check anywhere in the path would
		// silently demote it to "never hand-ordered".
		const result = recentTabSchema.safeParse({ ...base, dirSortOrder: 0 });
		expect(result.success && result.data.dirSortOrder).toBe(0);
	});

	it("leaves it absent when the client never hand-ordered the tab", () => {
		const result = recentTabSchema.safeParse(base);
		expect(result.success).toBe(true);
		expect(result.success && result.data.dirSortOrder).toBeUndefined();
	});

	it("rejects a negative or non-integer position", () => {
		expect(recentTabSchema.safeParse({ ...base, dirSortOrder: -1 }).success).toBe(false);
		expect(recentTabSchema.safeParse({ ...base, dirSortOrder: 1.5 }).success).toBe(false);
	});

	it("carries the position through the restore payload", () => {
		// The path that regressed: a full-list restore (the undo fallback when no token
		// is available).
		const result = restoreRecentTabsSchema.safeParse({
			tabs: [{ ...base, dirSortOrder: 2 }],
		});
		expect(result.success).toBe(true);
		expect(result.success && result.data.tabs?.[0]?.dirSortOrder).toBe(2);
	});
});
