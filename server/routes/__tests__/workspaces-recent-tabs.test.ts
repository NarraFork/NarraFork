import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	userPreferences,
	userRecentTabs,
	userRecentTabsMeta,
	users,
	workspaces,
} from "../../db/schema";

const { db, sqlite } = getTestDb();
const broadcasts: Array<{ userId: string; event: Record<string, unknown> }> = [];
const realDbModule = { ...(await import("../../db")) };
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../db", () => ({ db, sqlite }));
mock.module("../../websocket/narrator-ws", () => ({
	broadcastToUser: (userId: string, event: Record<string, unknown>) => {
		broadcasts.push({ userId, event });
	},
	getNarratorPresenceBatch: () => new Map(),
}));

const { dissolveOrphanWorkspaces, workspaceRoutes } = await import("../workspaces");
const NOW = "2026-07-19T00:00:00.000Z";
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "workspace-user", role: "user", iat: 0, exp: 0 });
	await next();
});
app.route("/workspaces", workspaceRoutes);

function seedUser(): void {
	db.insert(users)
		.values({
			id: "workspace-user",
			username: "workspace-user",
			passwordHash: "test-password-hash",
			role: "user",
			createdAt: NOW,
		})
		.run();
	db.insert(userPreferences)
		.values({
			id: "workspace-pref",
			userId: "workspace-user",
			recentTabs: "[]",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(userRecentTabsMeta)
		.values({
			userId: "workspace-user",
			revision: 7,
			migratedAt: NOW,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedWorkspace(id: string): void {
	db.insert(workspaces)
		.values({
			id,
			userId: "workspace-user",
			title: id,
			tree: "{}",
			createdAt: new Date(NOW),
			updatedAt: new Date(NOW),
		})
		.run();
}

function seedTab(input: {
	id: string;
	tabKey: string;
	type: "workspace" | "narrator";
	entityId: string;
	title: string;
	sortOrder: number;
	workspaceId?: string;
	representedNarratorId?: string;
}): void {
	db.insert(userRecentTabs)
		.values({
			id: input.id,
			userId: "workspace-user",
			tabKey: input.tabKey,
			section: "work",
			type: input.type,
			entityId: input.entityId,
			representedNarratorId: input.representedNarratorId ?? null,
			workspaceId: input.workspaceId ?? null,
			title: input.title,
			lastVisitedAt: 100 - input.sortOrder,
			sortOrder: input.sortOrder,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

beforeEach(() => {
	broadcasts.length = 0;
});

afterEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

describe("workspace normalized recent-tabs consumers", () => {
	it("keeps normalized references and dissolves only unreferenced workspaces", async () => {
		seedUser();
		seedWorkspace("workspace-kept");
		seedWorkspace("workspace-orphan");
		seedTab({
			id: "tab-kept",
			tabKey: "workspace:workspace-kept",
			type: "workspace",
			entityId: "workspace-kept",
			title: "Kept workspace",
			sortOrder: 0,
		});

		expect(await dissolveOrphanWorkspaces()).toBe(1);
		expect(db.select({ id: workspaces.id }).from(workspaces).orderBy(workspaces.id).all()).toEqual([
			{ id: "workspace-kept" },
		]);
	});

	it("deleting a workspace releases children and emits a revision delta", async () => {
		seedUser();
		seedWorkspace("workspace-delete");
		seedTab({
			id: "tab-header",
			tabKey: "workspace:workspace-delete",
			type: "workspace",
			entityId: "workspace-delete",
			title: "Delete workspace",
			sortOrder: 0,
		});
		seedTab({
			id: "tab-child",
			tabKey: "narrator:workspace-child",
			type: "narrator",
			entityId: "workspace-child",
			title: "Workspace child",
			sortOrder: 1,
			workspaceId: "workspace-delete",
			representedNarratorId: "workspace-child",
		});

		const response = await app.request("/workspaces/workspace-delete", { method: "DELETE" });
		expect(response.status).toBe(200);
		expect(db.select().from(workspaces).where(eq(workspaces.id, "workspace-delete")).get()).toBe(
			undefined,
		);
		expect(
			db
				.select({ tabKey: userRecentTabs.tabKey, workspaceId: userRecentTabs.workspaceId })
				.from(userRecentTabs)
				.where(eq(userRecentTabs.userId, "workspace-user"))
				.all(),
		).toEqual([{ tabKey: "narrator:workspace-child", workspaceId: null }]);
		expect(
			db
				.select({ revision: userRecentTabsMeta.revision })
				.from(userRecentTabsMeta)
				.where(eq(userRecentTabsMeta.userId, "workspace-user"))
				.get()?.revision,
		).toBe(8);
		expect(broadcasts.some(({ event }) => event.type === "user:recent_tabs_delta")).toBe(true);
	});
});
