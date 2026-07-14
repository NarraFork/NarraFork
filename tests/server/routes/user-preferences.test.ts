import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { narrators, userPreferences } from "../../../server/db/schema";
import type { JwtPayload } from "../../../server/lib/auth";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({ db, sqlite }));
mock.module("../../../server/websocket/narrator-ws", () => ({
	broadcastToUser: () => {},
	getNarratorPresenceBatch: () => new Map(),
}));

const { userPreferencesRoutes } = await import("../../../server/routes/user-preferences");
const { syncNarratorTitleToRecentTabs } = await import(
	"../../../server/services/user-preferences-service"
);

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

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.restore();
});

const NOW = "2025-01-01T00:00:00.000Z";

function seedRecentTabsForUser(userId: string, tabs: unknown[]) {
	db.insert(userPreferences)
		.values({
			id: `pref-${userId}`,
			userId,
			recentTabs: JSON.stringify(tabs),
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedRecentTabs(tabs: unknown[]) {
	seedRecentTabsForUser("user-1", tabs);
}

function seedNarrator(
	id: string,
	opts: { status?: "idle" | "working" | "waiting" | "archived"; substatus?: string[] } = {},
) {
	db.insert(narrators)
		.values({
			id,
			type: "primary",
			inheritMode: "fresh",
			status: opts.status,
			substatus: opts.substatus ? JSON.stringify(opts.substatus) : undefined,
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

describe("recent tabs upsert validation", () => {
	it("accepts frontend-normalized long titles and subtitles", async () => {
		const longText = "x".repeat(1_000);

		const tabs = await upsertRecentTab({
			type: "narrator",
			id: "n-long",
			title: longText,
			subtitle: longText,
			lastVisitedAt: 110,
		});

		expect(tabs[0]?.title).toBe(longText);
		expect(tabs[0]?.subtitle).toBe(longText);
	});
});

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

	it("keeps a revisited unpinned tab in place while updating its metadata", async () => {
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
			"project:older-project",
			"project:revisited-project",
		]);
		expect(tabs[2]?.title).toBe("Revisited again");
	});

	it("prefers keeping regular narrator tabs over unpinned subagents when trimming the list", async () => {
		const existingTabs = Array.from({ length: 19 }, (_, i) => ({
			type: "narrator",
			id: `n-${i}`,
			title: `Narrator ${i}`,
			lastVisitedAt: 100 - i,
		}));
		seedRecentTabs([
			...existingTabs,
			{
				type: "subagent",
				id: "old-subagent",
				title: "Old subagent",
				lastVisitedAt: 1,
			},
		]);

		const tabs = await upsertRecentTab({
			type: "subagent",
			id: "new-subagent",
			title: "New subagent",
			lastVisitedAt: 120,
		});

		expect(tabs).toHaveLength(20);
		expect(tabKeys(tabs)).toContain("subagent:new-subagent");
		expect(tabKeys(tabs)).not.toContain("subagent:old-subagent");
		for (const tab of existingTabs) {
			expect(tabKeys(tabs)).toContain(`${tab.type}:${tab.id}`);
		}
	});

	it("keeps a freshly opened subagent even when the full list has no other subagent to evict", async () => {
		// Regression: opening a background agent while the list is full would
		// insert the new subagent at the top, then trimming evicted the first
		// matching subagent — which was the just-added one (the only subagent),
		// so it never showed up in recent tabs.
		const existingTabs = Array.from({ length: 20 }, (_, i) => ({
			type: "narrator",
			id: `n-${i}`,
			title: `Narrator ${i}`,
			lastVisitedAt: 100 - i,
		}));
		seedRecentTabs(existingTabs);

		const tabs = await upsertRecentTab({
			type: "subagent",
			id: "new-subagent",
			title: "New subagent",
			lastVisitedAt: 120,
		});

		expect(tabs).toHaveLength(20);
		expect(tabKeys(tabs)).toContain("subagent:new-subagent");
		// The oldest unpinned non-subagent tab is dropped instead.
		expect(tabKeys(tabs)).not.toContain("narrator:n-19");
	});

	it("keeps a revisited workspace group in place with its children attached", async () => {
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
			"project:other-project",
			"workspace:ws-1",
			"narrator:narrator-1",
		]);
		expect(tabs[3]?.workspaceId).toBe("ws-1");
	});
});

describe("recent tabs service sync", () => {
	it("updates narrator titles through the locked recent-tabs service path", async () => {
		seedRecentTabs([
			{
				type: "narrator",
				id: "n-title",
				title: "Old title",
				lastVisitedAt: 100,
			},
			{
				type: "project",
				id: "project-1",
				title: "Project title",
				lastVisitedAt: 90,
			},
		]);
		seedRecentTabsForUser("user-2", [
			{
				type: "chapter",
				id: "chapter-1",
				narratorId: "n-title",
				title: "Old chapter title",
				lastVisitedAt: 80,
			},
		]);

		await syncNarratorTitleToRecentTabs("n-title", "New title");

		const rows = await db.select().from(userPreferences);
		const byUser = new Map(rows.map((row) => [row.userId, JSON.parse(row.recentTabs)]));
		expect(byUser.get("user-1")?.[0]?.title).toBe("New title");
		expect(byUser.get("user-1")?.[1]?.title).toBe("Project title");
		expect(byUser.get("user-2")?.[0]?.title).toBe("New title");
	});
});

describe("recent tabs narrator substatus enrichment", () => {
	it("returns live narrator substatus for recent tabs", async () => {
		seedNarrator("n-unread", { substatus: ["unread", "compacting"] });
		seedRecentTabs([
			{
				type: "narrator",
				id: "n-unread",
				title: "Unread narrator",
				status: "idle",
				lastVisitedAt: 100,
			},
		]);

		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { recentTabs: Array<Record<string, unknown>> };

		expect(body.recentTabs[0]?.status).toBe("idle");
		expect(body.recentTabs[0]?.substatus).toEqual(["unread", "compacting"]);
	});

	it("removes stale substatus when the narrator no longer exists", async () => {
		seedRecentTabs([
			{
				type: "narrator",
				id: "missing-narrator",
				title: "Missing narrator",
				status: "idle",
				substatus: ["unread"],
				lastVisitedAt: 100,
			},
		]);

		const res = await app.request("/");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { recentTabs: Array<Record<string, unknown>> };

		expect(body.recentTabs[0]?.substatus).toBeUndefined();
	});
});
