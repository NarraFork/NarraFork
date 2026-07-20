import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narrators,
	userPreferences,
	userRecentTabs,
	userRecentTabsMeta,
	users,
} from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../db", () => ({ db, sqlite }));
mock.module("../../websocket/narrator-ws", () => ({
	broadcastToUser: () => {},
	getNarratorPresenceBatch: () => new Map(),
}));

const { handleAttention } = await import("../notification-service");
const NOW = "2026-07-19T00:00:00.000Z";
const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; init?: RequestInit }> = [];

beforeEach(() => {
	requests.length = 0;
	globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), init });
		return new Response("ok", { status: 200 });
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

function seedUser(userId: string, notifyEnabled: boolean): void {
	db.insert(users)
		.values({
			id: userId,
			username: userId,
			passwordHash: "test-password-hash",
			role: "user",
			createdAt: NOW,
		})
		.run();
	db.insert(userPreferences)
		.values({
			id: `pref-${userId}`,
			userId,
			recentTabs: "[]",
			notifyDingtalkEnabled: notifyEnabled,
			notifyDingtalkWebhook: notifyEnabled ? "https://example.test/hook?access=1" : "",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

describe("notification recent-tabs consumer", () => {
	it("notifies users indexed by normalized rows when legacy JSON is empty", async () => {
		seedUser("relevant-user", true);
		seedUser("unrelated-user", true);
		db.insert(narrators)
			.values({
				id: "narrator-notify",
				title: "Indexed narrator",
				status: "idle",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.insert(userRecentTabsMeta)
			.values({
				userId: "relevant-user",
				revision: 1,
				migratedAt: NOW,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.insert(userRecentTabs)
			.values({
				id: "recent-notify",
				userId: "relevant-user",
				tabKey: "narrator:narrator-notify",
				section: "work",
				type: "narrator",
				entityId: "narrator-notify",
				representedNarratorId: "narrator-notify",
				title: "Indexed narrator",
				lastVisitedAt: 1,
				sortOrder: 0,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();

		await handleAttention("narrator-notify", "done");

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toContain("https://example.test/hook?access=1");
		expect(String(requests[0]?.init?.body)).toContain("Indexed narrator");
		expect(
			db
				.select({ recentTabs: userPreferences.recentTabs })
				.from(userPreferences)
				.where(eq(userPreferences.userId, "relevant-user"))
				.get()?.recentTabs,
		).toBe("[]");
	});
});
