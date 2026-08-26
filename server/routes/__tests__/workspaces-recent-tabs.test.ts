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
const { WORKSPACE_TREE_MAX_BYTES } = await import("../../lib/validators/workspaces");
const { buildAppErrorResponse } = await import("../../lib/app-error-response");
const NOW = "2026-07-19T00:00:00.000Z";
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "workspace-user", role: "user", iat: 0, exp: 0 });
	await next();
});
app.route("/workspaces", workspaceRoutes);
// Mirror the real app's error handling. Without it an `AppError` escapes as a
// generic 500, so a test asserting "rejected with 400" would pass for the wrong
// reason (or fail while the production behaviour is correct).
app.onError((err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: String(err) }, 500));

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

function seedWorkspace(id: string, tree = "{}"): void {
	db.insert(workspaces)
		.values({
			id,
			userId: "workspace-user",
			title: id,
			tree,
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

describe("workspace layout payload handling", () => {
	// The listing returns every workspace a user owns, and each `tree` may hold up
	// to WORKSPACE_TREE_MAX_BYTES of layout JSON. Reading the column here would put
	// tens of megabytes through the single JS thread for a list of titles.
	it("omits the tree blob from the listing and reports its size instead", async () => {
		seedUser();
		const tree = JSON.stringify({ kind: "dockview", pad: "x".repeat(4096) });
		seedWorkspace("workspace-listed", tree);

		const response = await app.request("/workspaces");
		expect(response.status).toBe(200);
		const rows = (await response.json()) as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("workspace-listed");
		expect("tree" in rows[0]).toBe(false);
		expect(rows[0].treeBytes).toBe(Buffer.byteLength(tree, "utf8"));
	});

	it("still returns the full tree from the single-workspace route", async () => {
		seedUser();
		const tree = JSON.stringify({ kind: "dockview", marker: "kept" });
		seedWorkspace("workspace-detail", tree);

		const response = await app.request("/workspaces/workspace-detail");
		expect(response.status).toBe(200);
		expect(((await response.json()) as { tree: string }).tree).toBe(tree);
	});

	it("rejects an over-cap layout with 413 rather than accepting a truncated row", async () => {
		seedUser();
		seedWorkspace("workspace-cap");

		const oversized = "x".repeat(WORKSPACE_TREE_MAX_BYTES + 512 * 1024);
		const response = await app.request("/workspaces/workspace-cap", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ tree: oversized }),
		});
		expect(response.status).toBe(413);
		expect(((await response.json()) as { code: string }).code).toBe("WORKSPACE_TREE_TOO_LARGE");
		// The stored layout must be untouched by a rejected write.
		expect(
			db
				.select({ tree: workspaces.tree })
				.from(workspaces)
				.where(eq(workspaces.id, "workspace-cap"))
				.get()?.tree,
		).toBe("{}");
	});

	// Between the body cap and the schema ceiling there is a band where the request
	// is small enough to buffer but the tree itself is too large to store. That band
	// must fail validation, not be written.
	it("rejects a tree past the schema ceiling that still fits under the body cap", async () => {
		seedUser();
		seedWorkspace("workspace-schema-cap");

		const response = await app.request("/workspaces/workspace-schema-cap", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ tree: "x".repeat(WORKSPACE_TREE_MAX_BYTES + 1) }),
		});
		expect(response.status).toBe(400);
		expect(
			db
				.select({ tree: workspaces.tree })
				.from(workspaces)
				.where(eq(workspaces.id, "workspace-schema-cap"))
				.get()?.tree,
		).toBe("{}");
	});

	it("accepts a layout that the previous 500 KB ceiling refused", async () => {
		seedUser();
		seedWorkspace("workspace-large");

		const tree = JSON.stringify({ kind: "dockview", pad: "x".repeat(700_000) });
		expect(Buffer.byteLength(tree, "utf8")).toBeGreaterThan(500_000);
		const response = await app.request("/workspaces/workspace-large", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ tree }),
		});
		expect(response.status).toBe(200);
		expect(
			db
				.select({ tree: workspaces.tree })
				.from(workspaces)
				.where(eq(workspaces.id, "workspace-large"))
				.get()?.tree,
		).toBe(tree);
	});
});
