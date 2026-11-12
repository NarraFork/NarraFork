import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narrators,
	userPreferences,
	userRecentTabs,
	userRecentTabsMeta,
	users,
	workspacePanels,
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

const { workspaceRoutes } = await import("../workspaces");
const { WORKSPACE_TREE_MAX_BYTES } = await import("../../lib/validators/workspaces");
const { buildAppErrorResponse } = await import("../../lib/app-error-response");
const { clearRecentTabs, listPage, removeRecentTab } = await import(
	"../../services/recent-tabs-service"
);
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
			foldersMigrated: true,
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
	type: "workspace" | "narrator" | "folder";
	entityId: string;
	title: string;
	sortOrder: number;
	workspaceId?: string;
	folderId?: string;
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
			folderId: input.folderId ?? null,
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

function seedNarrator(id: string): void {
	db.insert(narrators).values({ id, title: id, createdAt: NOW, updatedAt: NOW }).run();
}

function readRevision(): number | undefined {
	return db
		.select({ revision: userRecentTabsMeta.revision })
		.from(userRecentTabsMeta)
		.where(eq(userRecentTabsMeta.userId, "workspace-user"))
		.get()?.revision;
}

// The sidebar used to mirror workspace membership (a `workspace` header with the
// members underneath). Folders replaced that grouping, so the two are now independent:
// no workspace write may touch the sidebar, and no sidebar write may touch a workspace.
describe("workspaces are independent of the sidebar", () => {
	it("deleting a workspace leaves the sidebar alone", async () => {
		seedUser();
		seedWorkspace("ws");
		seedTab({
			id: "tab-n1",
			tabKey: "narrator:n1",
			type: "narrator",
			entityId: "n1",
			title: "n1",
			sortOrder: 0,
			representedNarratorId: "n1",
		});

		const response = await app.request("/workspaces/ws", { method: "DELETE" });

		expect(response.status).toBe(200);
		expect(db.select().from(workspaces).where(eq(workspaces.id, "ws")).get()).toBe(undefined);
		expect(db.select({ tabKey: userRecentTabs.tabKey }).from(userRecentTabs).all()).toEqual([
			{ tabKey: "narrator:n1" },
		]);
		expect(readRevision()).toBe(7);
		expect(broadcasts.some(({ event }) => event.type === "user:recent_tabs_delta")).toBe(false);
	});

	it("adding and removing a narrator panel never changes the sidebar", async () => {
		seedUser();
		seedWorkspace("ws");
		seedNarrator("n1");
		seedTab({
			id: "tab-n1",
			tabKey: "narrator:n1",
			type: "narrator",
			entityId: "n1",
			title: "n1",
			sortOrder: 0,
			representedNarratorId: "n1",
		});

		const created = (await (
			await app.request("/workspaces/ws/panels", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "narrator", narratorId: "n1" }),
			})
		).json()) as { panel: { id: string } };
		await app.request(`/workspaces/ws/panels/${created.panel.id}`, { method: "DELETE" });

		const tab = db
			.select()
			.from(userRecentTabs)
			.where(eq(userRecentTabs.tabKey, "narrator:n1"))
			.get();
		expect(tab?.folderId).toBe(null);
		expect(tab?.workspaceId).toBe(null);
		expect(readRevision()).toBe(7);
	});

	it("closing a sidebar tab keeps the narrator's workspace panel", async () => {
		seedUser();
		seedWorkspace("ws");
		seedNarrator("n1");
		seedTab({
			id: "tab-n1",
			tabKey: "narrator:n1",
			type: "narrator",
			entityId: "n1",
			title: "n1",
			sortOrder: 0,
			representedNarratorId: "n1",
		});
		await app.request("/workspaces/ws/panels", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "narrator", narratorId: "n1" }),
		});
		broadcasts.length = 0;

		await removeRecentTab("workspace-user", "narrator", "n1", { storeUndo: true });

		expect(
			db.select().from(workspacePanels).where(eq(workspacePanels.workspaceId, "ws")).all(),
		).toHaveLength(1);
		expect(broadcasts.some(({ event }) => event.type === "workspace_changed")).toBe(false);
	});

	// Before folders, a cleared workspace group scheduled its workspace for deletion.
	it("clearing inactive tabs never deletes a workspace", async () => {
		seedUser();
		seedWorkspace("ws");
		seedNarrator("n1");
		seedTab({
			id: "tab-n1",
			tabKey: "narrator:n1",
			type: "narrator",
			entityId: "n1",
			title: "n1",
			sortOrder: 0,
			representedNarratorId: "n1",
		});

		await clearRecentTabs("workspace-user", "inactive_narrators");

		expect(db.select({ id: workspaces.id }).from(workspaces).all()).toEqual([{ id: "ws" }]);
	});

	// The one-time folder conversion turns a legacy `workspace` header into a folder with
	// the same id. That must not cost the user the workspace itself.
	it("converting a legacy workspace group keeps the workspace and its backfill source", async () => {
		seedUser();
		db.update(userRecentTabsMeta).set({ foldersMigrated: false }).run();
		seedWorkspace("ws");
		seedNarrator("n1");
		seedNarrator("n2");
		seedTab({
			id: "tab-ws",
			tabKey: "workspace:ws",
			type: "workspace",
			entityId: "ws",
			title: "Legacy group",
			sortOrder: 0,
		});
		for (const [index, id] of ["n1", "n2"].entries()) {
			seedTab({
				id: `tab-${id}`,
				tabKey: `narrator:${id}`,
				type: "narrator",
				entityId: id,
				title: id,
				sortOrder: index + 1,
				workspaceId: "ws",
				representedNarratorId: id,
			});
		}

		const page = await listPage("workspace-user", "work");

		expect(page.items.map((tab) => [tab.type, tab.id, tab.folderId ?? null])).toEqual([
			["folder", "ws", null],
			["narrator", "n1", "ws"],
			["narrator", "n2", "ws"],
		]);
		expect(page.items[0].title).toBe("Legacy group");
		expect(db.select({ id: workspaces.id }).from(workspaces).all()).toEqual([{ id: "ws" }]);
		// The frozen projection still recovers both narrators for a workspace that never
		// had membership rows.
		const opened = (await (await app.request("/workspaces/ws")).json()) as {
			panels: Array<{ narratorId: string | null }>;
		};
		expect(opened.panels.map((panel) => panel.narratorId).sort()).toEqual(["n1", "n2"]);
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
		const response = await app.request("/workspaces/workspace-cap/layout", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ layout: oversized, expectedRevision: 0 }),
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

		const response = await app.request("/workspaces/workspace-schema-cap/layout", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				layout: "x".repeat(WORKSPACE_TREE_MAX_BYTES + 1),
				expectedRevision: 0,
			}),
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
		const response = await app.request("/workspaces/workspace-large/layout", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ layout: tree, expectedRevision: 0 }),
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

describe("membership routes", () => {
	// Opening a workspace must deliver membership and arrangement together. If a
	// client could render the layout before knowing the member set, it would be
	// able to display exactly the state this redesign removes.
	it("returns membership alongside the layout on GET /:id", async () => {
		seedUser();
		seedWorkspace("ws");
		seedNarrator("n1");
		await app.request("/workspaces/ws/panels", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "narrator", narratorId: "n1" }),
		});

		const response = await app.request("/workspaces/ws");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			layout: string;
			tree: string;
			layoutRevision: number;
			panels: Array<{ kind: string; narratorId: string | null }>;
		};
		expect(body.panels).toHaveLength(1);
		expect(body.panels[0]).toMatchObject({ kind: "narrator", narratorId: "n1" });
		// `layout` is the new name for the same blob; `tree` stays for compatibility.
		expect(body.layout).toBe(body.tree);
		expect(body.layoutRevision).toBe(0);
	});

	it("creates a panel with 201 and reports an existing one with 200", async () => {
		seedUser();
		seedWorkspace("ws");
		seedNarrator("n1");

		const first = await app.request("/workspaces/ws/panels", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "narrator", narratorId: "n1" }),
		});
		const second = await app.request("/workspaces/ws/panels", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "narrator", narratorId: "n1" }),
		});

		expect(first.status).toBe(201);
		// Idempotent: the status is how a caller distinguishes the two outcomes.
		expect(second.status).toBe(200);
		expect(
			db.select().from(workspacePanels).where(eq(workspacePanels.workspaceId, "ws")).all(),
		).toHaveLength(1);
	});

	it("rejects a foreign workspace's panels as not found", async () => {
		seedUser();
		db.insert(users)
			.values({
				id: "someone-else",
				username: "someone-else",
				passwordHash: "test-password-hash",
				role: "user",
				createdAt: NOW,
			})
			.run();
		db.insert(workspaces)
			.values({
				id: "other-ws",
				userId: "someone-else",
				title: "other",
				tree: "{}",
				createdAt: new Date(NOW),
				updatedAt: new Date(NOW),
			})
			.run();

		const response = await app.request("/workspaces/other-ws/panels");
		expect(response.status).toBe(404);
	});
});

describe("layout arrangement is guarded by a revision", () => {
	it("accepts a matching revision and advances it", async () => {
		seedUser();
		seedWorkspace("ws");
		const layout = JSON.stringify({ kind: "dockview", marker: "v1" });

		const response = await app.request("/workspaces/ws/layout", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ layout, expectedRevision: 0 }),
		});

		expect(response.status).toBe(200);
		expect(((await response.json()) as { layoutRevision: number }).layoutRevision).toBe(1);
		expect(
			db.select({ tree: workspaces.tree }).from(workspaces).where(eq(workspaces.id, "ws")).get()
				?.tree,
		).toBe(layout);
	});

	// Two tabs open on one workspace used to overwrite each other's arrangement on
	// every drag. The loser now learns it lost, and gets the revision it needs to
	// rebase without an extra read.
	it("rejects a stale revision with 409 and reports the current one", async () => {
		seedUser();
		seedWorkspace("ws");
		await app.request("/workspaces/ws/layout", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				layout: JSON.stringify({ kind: "dockview", marker: "winner" }),
				expectedRevision: 0,
			}),
		});

		const response = await app.request("/workspaces/ws/layout", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				layout: JSON.stringify({ kind: "dockview", marker: "loser" }),
				expectedRevision: 0,
			}),
		});

		expect(response.status).toBe(409);
		const body = (await response.json()) as { code: string; currentRevision: number };
		expect(body.code).toBe("WORKSPACE_LAYOUT_CONFLICT");
		expect(body.currentRevision).toBe(1);
		// The winner's arrangement must survive.
		expect(
			db.select({ tree: workspaces.tree }).from(workspaces).where(eq(workspaces.id, "ws")).get()
				?.tree,
		).toContain("winner");
	});

	it("requires expectedRevision rather than defaulting to last-write-wins", async () => {
		seedUser();
		seedWorkspace("ws");

		const response = await app.request("/workspaces/ws/layout", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ layout: JSON.stringify({ kind: "dockview" }) }),
		});

		expect(response.status).toBe(400);
	});
});

// Cross-device sync: every workspace write must announce itself so a second
// device holding the same workspace open re-fetches immediately instead of
// waiting for a window refocus. The frame is an invalidation signal — it carries
// ids and the layout revision, never the layout blob.
describe("workspace change broadcasts", () => {
	function workspaceChangedEvents(): Array<Record<string, unknown>> {
		return broadcasts
			.map(({ event }) => event)
			.filter((event) => event.type === "workspace_changed");
	}

	it("announces a saved layout with the new revision", async () => {
		seedUser();
		seedWorkspace("ws");

		const response = await app.request("/workspaces/ws/layout", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				layout: JSON.stringify({ kind: "dockview", marker: "v1" }),
				expectedRevision: 0,
			}),
		});

		expect(response.status).toBe(200);
		expect(workspaceChangedEvents()).toEqual([
			{ type: "workspace_changed", workspaceId: "ws", reason: "layout", layoutRevision: 1 },
		]);
	});

	it("does not announce a layout save that lost the revision race", async () => {
		seedUser();
		seedWorkspace("ws");
		await app.request("/workspaces/ws/layout", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ layout: JSON.stringify({ kind: "dockview" }), expectedRevision: 0 }),
		});
		broadcasts.length = 0;

		const response = await app.request("/workspaces/ws/layout", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ layout: JSON.stringify({ kind: "dockview" }), expectedRevision: 0 }),
		});

		expect(response.status).toBe(409);
		expect(workspaceChangedEvents()).toEqual([]);
	});

	it("announces a created panel, but not an idempotent replay", async () => {
		seedUser();
		seedWorkspace("ws");
		db.insert(narrators).values({ id: "n1", title: "n1", createdAt: NOW, updatedAt: NOW }).run();

		const first = await app.request("/workspaces/ws/panels", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "narrator", narratorId: "n1" }),
		});
		expect(first.status).toBe(201);
		expect(workspaceChangedEvents()).toEqual([
			{ type: "workspace_changed", workspaceId: "ws", reason: "membership" },
		]);

		broadcasts.length = 0;
		const replay = await app.request("/workspaces/ws/panels", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "narrator", narratorId: "n1" }),
		});
		expect(replay.status).toBe(200);
		// Nothing changed, so nothing is announced.
		expect(workspaceChangedEvents()).toEqual([]);
	});

	it("announces a removed panel", async () => {
		seedUser();
		seedWorkspace("ws");
		db.insert(narrators).values({ id: "n1", title: "n1", createdAt: NOW, updatedAt: NOW }).run();
		const created = (await (
			await app.request("/workspaces/ws/panels", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "narrator", narratorId: "n1" }),
			})
		).json()) as { panel: { id: string } };
		broadcasts.length = 0;

		const response = await app.request(`/workspaces/ws/panels/${created.panel.id}`, {
			method: "DELETE",
		});

		expect(response.status).toBe(200);
		expect(workspaceChangedEvents()).toEqual([
			{ type: "workspace_changed", workspaceId: "ws", reason: "membership" },
		]);
	});

	it("announces a rename and a deletion", async () => {
		seedUser();
		seedWorkspace("ws");

		const renamed = await app.request("/workspaces/ws", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "renamed" }),
		});
		expect(renamed.status).toBe(200);
		expect(workspaceChangedEvents()).toEqual([
			{ type: "workspace_changed", workspaceId: "ws", reason: "title" },
		]);

		broadcasts.length = 0;
		const deleted = await app.request("/workspaces/ws", { method: "DELETE" });
		expect(deleted.status).toBe(200);
		expect(workspaceChangedEvents()).toEqual([
			{ type: "workspace_changed", workspaceId: "ws", reason: "deleted" },
		]);
	});
});

describe("legacy sidebar grouping is a one-time backfill source", () => {
	// Before folders, removing a panel also cleared the tab's `workspace_id`. Now nothing
	// writes the column, so the backfill must consume it — otherwise removing every
	// panel would bring them all back on the next open.
	it("removed panels stay removed after the legacy grouping filled them in", async () => {
		seedUser();
		seedWorkspace("ws");
		seedNarrator("n1");
		seedTab({
			id: "tab-n1",
			tabKey: "narrator:n1",
			type: "narrator",
			entityId: "n1",
			title: "n1",
			sortOrder: 0,
			workspaceId: "ws",
			representedNarratorId: "n1",
		});

		const first = (await (await app.request("/workspaces/ws")).json()) as {
			panels: Array<{ id: string; narratorId: string | null }>;
		};
		expect(first.panels.map((panel) => panel.narratorId)).toEqual(["n1"]);
		expect(
			db.select({ workspaceId: userRecentTabs.workspaceId }).from(userRecentTabs).get()
				?.workspaceId,
		).toBe(null);

		await app.request(`/workspaces/ws/panels/${first.panels[0].id}`, { method: "DELETE" });
		const second = (await (await app.request("/workspaces/ws")).json()) as {
			panels: unknown[];
		};
		expect(second.panels).toEqual([]);
	});
});
