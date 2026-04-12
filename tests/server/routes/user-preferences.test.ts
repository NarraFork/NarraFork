import { afterEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { narrators, userPreferences } from "../../../server/db/schema";
import type { JwtPayload } from "../../../server/lib/auth";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

mock.module("../../../server/db", () => ({ db, sqlite }));
mock.module("../../../server/websocket/narrator-ws", () => ({
	broadcastToUser: () => {},
	getNarratorPresenceBatch: () => new Map(),
}));

const { userPreferencesRoutes } = await import("../../../server/routes/user-preferences");

const authUser: JwtPayload = {
	sub: "user-1",
	role: "user",
	iat: 1735689600,
	exp: 1736294400,
};

const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", authUser);
	await next();
});
app.route("/", userPreferencesRoutes);

afterEach(() => cleanDb(sqlite));

const NOW = "2025-01-01T00:00:00.000Z";

function seedRecentTabs(tabs: unknown[]) {
	db.insert(userPreferences)
		.values({
			id: "pref-1",
			userId: "user-1",
			recentTabs: JSON.stringify(tabs),
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedNarrator(id: string) {
	db.insert(narrators)
		.values({
			id,
			type: "primary",
			inheritMode: "fresh",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

async function upsertRecentTab(tab: Record<string, unknown>) {
	const res = await app.request("/recent-tabs", {
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(tab),
	});
	expect(res.status).toBe(200);
	return (await res.json()) as Array<Record<string, unknown>>;
}

function tabKeys(tabs: Array<Record<string, unknown>>) {
	return tabs.map((tab) => `${tab.type}:${tab.id}`);
}

describe("recent tabs pinned ordering", () => {
	it("keeps pinned tabs above newly opened top-level tabs", async () => {
		seedRecentTabs([
			{
				type: "project",
				id: "pinned-project",
				title: "Pinned",
				lastVisitedAt: 100,
				pinned: true,
			},
			{
				type: "project",
				id: "existing-project",
				title: "Existing",
				lastVisitedAt: 90,
			},
		]);

		const tabs = await upsertRecentTab({
			type: "project",
			id: "new-project",
			title: "New",
			lastVisitedAt: 110,
		});

		expect(tabKeys(tabs)).toEqual([
			"project:pinned-project",
			"project:new-project",
			"project:existing-project",
		]);
	});

	it("moves a revisited unpinned tab to the front of the unpinned section only", async () => {
		seedRecentTabs([
			{
				type: "project",
				id: "pinned-project",
				title: "Pinned",
				lastVisitedAt: 100,
				pinned: true,
			},
			{
				type: "project",
				id: "older-project",
				title: "Older",
				lastVisitedAt: 80,
			},
			{
				type: "project",
				id: "revisited-project",
				title: "Revisited",
				lastVisitedAt: 70,
			},
		]);

		const tabs = await upsertRecentTab({
			type: "project",
			id: "revisited-project",
			title: "Revisited again",
			lastVisitedAt: 120,
		});

		expect(tabKeys(tabs)).toEqual([
			"project:pinned-project",
			"project:revisited-project",
			"project:older-project",
		]);
		expect(tabs[1]?.title).toBe("Revisited again");
	});

	it("keeps workspace children attached when a workspace is revisited behind pinned tabs", async () => {
		seedNarrator("narrator-1");
		seedRecentTabs([
			{
				type: "project",
				id: "pinned-project",
				title: "Pinned",
				lastVisitedAt: 100,
				pinned: true,
			},
			{
				type: "project",
				id: "other-project",
				title: "Other",
				lastVisitedAt: 90,
			},
			{
				type: "workspace",
				id: "ws-1",
				title: "Workspace 1",
				lastVisitedAt: 80,
			},
			{
				type: "narrator",
				id: "narrator-1",
				workspaceId: "ws-1",
				title: "Narrator 1",
				lastVisitedAt: 79,
			},
		]);

		const tabs = await upsertRecentTab({
			type: "workspace",
			id: "ws-1",
			title: "Workspace 1",
			lastVisitedAt: 130,
		});

		expect(tabKeys(tabs)).toEqual([
			"project:pinned-project",
			"workspace:ws-1",
			"narrator:narrator-1",
			"project:other-project",
		]);
		expect(tabs[2]?.workspaceId).toBe("ws-1");
	});
});
