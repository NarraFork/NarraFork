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
import type { WorkspacePanelMembershipWrite } from "../../services/recent-tabs-service";

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
const { applyWorkspaceMembershipProjection } = await import("../../services/recent-tabs-service");
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
	function seedNarrator(id: string): void {
		db.insert(narrators).values({ id, title: id, createdAt: NOW, updatedAt: NOW }).run();
	}

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

	it("deletes a panel and releases its sidebar tab", async () => {
		seedUser();
		seedWorkspace("ws");
		seedNarrator("n1");
		seedTab({
			id: "tab-n1",
			tabKey: "narrator:n1",
			type: "narrator",
			entityId: "n1",
			title: "n1",
			sortOrder: 1,
			workspaceId: "ws",
			representedNarratorId: "n1",
		});
		const created = (await (
			await app.request("/workspaces/ws/panels", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ kind: "narrator", narratorId: "n1" }),
			})
		).json()) as { panel: { id: string } };

		const response = await app.request(`/workspaces/ws/panels/${created.panel.id}`, {
			method: "DELETE",
		});

		expect(response.status).toBe(200);
		expect(
			db.select().from(workspacePanels).where(eq(workspacePanels.workspaceId, "ws")).all(),
		).toHaveLength(0);
		expect(
			db
				.select({ workspaceId: userRecentTabs.workspaceId })
				.from(userRecentTabs)
				.where(eq(userRecentTabs.tabKey, "narrator:n1"))
				.get()?.workspaceId,
		).toBe(null);
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

describe("membership write atomicity", () => {
	function seedNarrator(id: string): void {
		db.insert(narrators).values({ id, title: id, createdAt: NOW, updatedAt: NOW }).run();
	}

	function panelRow(id: string, workspaceId: string, narratorId: string, sortOrder = 1000) {
		return {
			id,
			workspaceId,
			kind: "narrator" as const,
			narratorId,
			configJson: null,
			sortOrder,
			createdAt: new Date(NOW),
			updatedAt: new Date(NOW),
		};
	}

	function readRevision(): number | undefined {
		return db
			.select({ revision: userRecentTabsMeta.revision })
			.from(userRecentTabsMeta)
			.where(eq(userRecentTabsMeta.userId, "workspace-user"))
			.get()?.revision;
	}

	// The projection already matches (the tab is attached), so no tab row changes —
	// the membership write must STILL land, in its own transaction.
	it("lands the membership row when the tab projection is already in place", async () => {
		seedUser();
		seedWorkspace("ws");
		seedNarrator("n1");
		// The workspace header tab must exist, or `regroupWorkspaces` treats the
		// child as an orphan and detaches it — which would be a CHANGE, not the
		// no-op branch this test is about.
		seedTab({
			id: "tab-ws",
			tabKey: "workspace:ws",
			type: "workspace",
			entityId: "ws",
			title: "ws",
			sortOrder: 0,
		});
		seedTab({
			id: "tab-n1",
			tabKey: "narrator:n1",
			type: "narrator",
			entityId: "n1",
			title: "n1",
			sortOrder: 1,
			workspaceId: "ws",
			representedNarratorId: "n1",
		});

		const result = await applyWorkspaceMembershipProjection("workspace-user", {
			narratorId: "n1",
			workspaceId: "ws",
			panelMembership: { action: "insert", row: panelRow("panel-n1", "ws", "n1") },
		});

		expect(result.changed).toBe(false);
		expect(
			db.select().from(workspacePanels).where(eq(workspacePanels.workspaceId, "ws")).all(),
		).toHaveLength(1);
		// A no-op projection bumps no revision and broadcasts nothing.
		expect(readRevision()).toBe(7);
		expect(broadcasts.some(({ event }) => event.type === "user:recent_tabs_delta")).toBe(false);
	});

	// A failure inside the declared write (here: the (workspace, narrator) unique
	// index) must roll the WHOLE transaction back — tab rows, revision bump and
	// broadcast included — not just skip the panel row.
	it("rolls back the tab projection, revision and broadcast when the membership write fails", async () => {
		seedUser();
		seedWorkspace("ws");
		seedNarrator("n1");
		seedTab({
			id: "tab-ws",
			tabKey: "workspace:ws",
			type: "workspace",
			entityId: "ws",
			title: "ws",
			sortOrder: 0,
		});
		// The tab is NOT attached, so the projection would change rows this time.
		seedTab({
			id: "tab-n1",
			tabKey: "narrator:n1",
			type: "narrator",
			entityId: "n1",
			title: "n1",
			sortOrder: 1,
			representedNarratorId: "n1",
		});
		// A pre-existing row makes the declared insert violate the unique index
		// mid-transaction, after the tab diff has already been applied.
		db.insert(workspacePanels)
			.values(panelRow("panel-existing", "ws", "n1"))
			.run();

		await expect(
			applyWorkspaceMembershipProjection("workspace-user", {
				narratorId: "n1",
				workspaceId: "ws",
				panelMembership: { action: "insert", row: panelRow("panel-dupe", "ws", "n1", 2000) },
			}),
		).rejects.toThrow();

		expect(
			db
				.select({ workspaceId: userRecentTabs.workspaceId })
				.from(userRecentTabs)
				.where(eq(userRecentTabs.tabKey, "narrator:n1"))
				.get()?.workspaceId,
		).toBe(null);
		expect(readRevision()).toBe(7);
		expect(
			db.select().from(workspacePanels).where(eq(workspacePanels.workspaceId, "ws")).all(),
		).toHaveLength(1);
		expect(broadcasts.some(({ event }) => event.type === "user:recent_tabs_delta")).toBe(false);
	});

	// Removing a panel whose row is already gone is a no-op write, not an error:
	// the tab release is the intent and is idempotent.
	it("releases the tab even when the membership row is already gone", async () => {
		seedUser();
		seedWorkspace("ws");
		seedNarrator("n1");
		seedTab({
			id: "tab-ws",
			tabKey: "workspace:ws",
			type: "workspace",
			entityId: "ws",
			title: "ws",
			sortOrder: 0,
		});
		seedTab({
			id: "tab-n1",
			tabKey: "narrator:n1",
			type: "narrator",
			entityId: "n1",
			title: "n1",
			sortOrder: 1,
			workspaceId: "ws",
			representedNarratorId: "n1",
		});

		const result = await applyWorkspaceMembershipProjection("workspace-user", {
			narratorId: "n1",
			workspaceId: null,
			panelMembership: { action: "remove", panelId: "panel-never-existed" },
		});

		expect(result.changed).toBe(true);
		expect(
			db
				.select({ workspaceId: userRecentTabs.workspaceId })
				.from(userRecentTabs)
				.where(eq(userRecentTabs.tabKey, "narrator:n1"))
				.get()?.workspaceId,
		).toBe(null);
	});

	// Compile-time negative test, enforced by `tsgo --noEmit`: the membership port
	// takes DATA, so no function — sync or async — can be supplied as the write.
	// This is what keeps the SQLite early-commit hazard inexpressible rather than
	// merely unidiomatic.
	it("statically refuses callback-shaped work", () => {
		// @ts-expect-error — a callback is not a declarative membership write
		const notAWrite: WorkspacePanelMembershipWrite = async () => {};
		void notAWrite;
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
