import { describe, expect, it } from "bun:test";
import {
	createProjectSchema,
	createScheduledTaskSchema,
	localeSchema,
	registerSchema,
	updateUserPreferencesSchema,
} from "../../../server/lib/validators";
import {
	recentTabSchema,
	restoreRecentTabsSchema,
	upsertRecentTabSchema,
} from "../../../server/lib/validators/settings";
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

describe("shared locale validation", () => {
	it("accepts every locale from the shared registry", () => {
		for (const locale of SUPPORTED_LOCALES) {
			expect(updateUserPreferencesSchema.safeParse({ language: locale }).success).toBe(true);
			expect(localeSchema.safeParse(locale).success).toBe(true);
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
		expect(localeSchema.safeParse("unsupported").success).toBe(false);
		expect(
			createScheduledTaskSchema.safeParse({
				name: "Hourly task",
				cronExpr: "0 * * * *",
				prompt: "Run checks",
				locale: "unsupported",
			}).success,
		).toBe(false);
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
 * Folder fields on the recent-tab payload.
 *
 * Zod strips unknown keys, so folder structure must be DECLARED for the full-list
 * restore path to carry it back; and only the known icon/colour keys may be stored.
 */
describe("recentTabSchema — folder fields", () => {
	const base = {
		type: "narrator" as const,
		id: "n-1",
		title: "Tab",
		lastVisitedAt: 1,
	};

	it("carries folder membership and metadata through the restore payload", () => {
		const result = restoreRecentTabsSchema.safeParse({
			tabs: [
				{
					...base,
					type: "folder",
					id: "f-1",
					folderIcon: "rocket",
					folderColor: "teal",
					folderPreviewCount: 0,
				},
				{ ...base, folderId: "f-1" },
			],
		});
		expect(result.success).toBe(true);
		expect(result.success && result.data.tabs?.[0]).toMatchObject({
			folderIcon: "rocket",
			folderColor: "teal",
			folderPreviewCount: 0,
		});
		expect(result.success && result.data.tabs?.[1]?.folderId).toBe("f-1");
	});

	it("refuses retired tab types so a restore cannot store them", () => {
		for (const type of ["workspace", "group", "chapter"]) {
			expect(recentTabSchema.safeParse({ ...base, type }).success).toBe(false);
		}
	});

	it("rejects an unknown icon or colour and a negative preview count", () => {
		expect(recentTabSchema.safeParse({ ...base, folderIcon: "nope" }).success).toBe(false);
		expect(recentTabSchema.safeParse({ ...base, folderColor: "nope" }).success).toBe(false);
		expect(recentTabSchema.safeParse({ ...base, folderPreviewCount: -1 }).success).toBe(false);
	});
});

describe("upsertRecentTabSchema — placement anchors", () => {
	const base = {
		type: "narrator" as const,
		id: "n-1",
		title: "Tab",
		lastVisitedAt: 1,
	};

	it("accepts either anchor on its own", () => {
		const before = upsertRecentTabSchema.safeParse({ ...base, beforeKey: "narrator:n-2" });
		expect(before.success && before.data.beforeKey).toBe("narrator:n-2");
		const after = upsertRecentTabSchema.safeParse({ ...base, afterKey: "narrator:n-2" });
		expect(after.success && after.data.afterKey).toBe("narrator:n-2");
	});

	// Both at once has no single meaning, and the service reads `beforeKey` first — so
	// accepting the pair would silently discard the other half of the request.
	it("rejects both anchors together", () => {
		const result = upsertRecentTabSchema.safeParse({
			...base,
			beforeKey: "narrator:n-2",
			afterKey: "narrator:n-3",
		});
		expect(result.success).toBe(false);
	});

	it("stays valid with no anchor at all (the ordinary visit path)", () => {
		const result = upsertRecentTabSchema.safeParse(base);
		expect(result.success).toBe(true);
		expect(result.success && result.data.beforeKey).toBeUndefined();
		expect(result.success && result.data.afterKey).toBeUndefined();
	});
});
