/**
 * Membership is the authority; the sidebar grouping is its projection.
 *
 * Every test here is about a way the previous two-source design could diverge:
 * a persisted sidebar tab with no panel anywhere, duplicate cells for one
 * narrator, or a workspace that renders empty because its layout blob lost its
 * contents. The backfill cases additionally cover REPAIR of data already damaged
 * by that design.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { asc, eq } from "drizzle-orm";
import {
	narrators,
	userPreferences,
	userRecentTabs,
	userRecentTabsMeta,
	users,
	workspacePanels,
	workspaces,
} from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../server/db")) };
const realNarratorWsModule = { ...(await import("../../../server/websocket/narrator-ws")) };
mock.module("../../../server/db", () => ({ db, sqlite }));
mock.module("../../../server/websocket/narrator-ws", () => ({
	broadcastToUser: () => {},
	getNarratorPresenceBatch: () => new Map(),
}));

const {
	addWorkspacePanel,
	listWorkspacePanels,
	recoverPanelsFromLayout,
	removeWorkspacePanel,
	updateWorkspacePanelConfig,
} = await import("../../../server/services/workspace-panel-service");
const { createWorkspacePanelSchema } = await import("../../../server/lib/validators/workspaces");

const USER = "panel-user";
const NOW_ISO = "2026-08-01T00:00:00.000Z";
const NOW = new Date(NOW_ISO);

function seedUser(): void {
	db.insert(users)
		.values({
			id: USER,
			username: USER,
			passwordHash: "test-password-hash",
			role: "user",
			createdAt: NOW_ISO,
		})
		.run();
	db.insert(userPreferences)
		.values({
			id: "panel-pref",
			userId: USER,
			recentTabs: "[]",
			createdAt: NOW_ISO,
			updatedAt: NOW_ISO,
		})
		.run();
	db.insert(userRecentTabsMeta)
		.values({
			userId: USER,
			revision: 3,
			migratedAt: NOW_ISO,
			createdAt: NOW_ISO,
			updatedAt: NOW_ISO,
		})
		.run();
}

function seedWorkspace(id: string, tree = "{}"): void {
	db.insert(workspaces)
		.values({
			id,
			userId: USER,
			title: id,
			tree,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedNarrator(id: string): void {
	db.insert(narrators).values({ id, title: id, createdAt: NOW_ISO, updatedAt: NOW_ISO }).run();
}

/** A sidebar tab for a narrator, optionally already grouped under a workspace. */
function seedNarratorTab(narratorId: string, workspaceId?: string, sortOrder = 0): void {
	db.insert(userRecentTabs)
		.values({
			id: `tab-${narratorId}`,
			userId: USER,
			tabKey: `narrator:${narratorId}`,
			section: "work",
			type: "narrator",
			entityId: narratorId,
			representedNarratorId: narratorId,
			workspaceId: workspaceId ?? null,
			title: narratorId,
			lastVisitedAt: 100 - sortOrder,
			sortOrder,
			createdAt: NOW_ISO,
			updatedAt: NOW_ISO,
		})
		.run();
}

function seedWorkspaceTab(workspaceId: string, sortOrder = 0): void {
	db.insert(userRecentTabs)
		.values({
			id: `tab-${workspaceId}`,
			userId: USER,
			tabKey: `workspace:${workspaceId}`,
			section: "work",
			type: "workspace",
			entityId: workspaceId,
			title: workspaceId,
			lastVisitedAt: 100 - sortOrder,
			sortOrder,
			createdAt: NOW_ISO,
			updatedAt: NOW_ISO,
		})
		.run();
}

function panelRows(workspaceId: string) {
	return db
		.select()
		.from(workspacePanels)
		.where(eq(workspacePanels.workspaceId, workspaceId))
		.orderBy(asc(workspacePanels.sortOrder))
		.all();
}

function tabWorkspaceId(narratorId: string): string | null | undefined {
	return db
		.select({ workspaceId: userRecentTabs.workspaceId })
		.from(userRecentTabs)
		.where(eq(userRecentTabs.tabKey, `narrator:${narratorId}`))
		.get()?.workspaceId;
}

function tabRevision(): number | undefined {
	return db
		.select({ revision: userRecentTabsMeta.revision })
		.from(userRecentTabsMeta)
		.where(eq(userRecentTabsMeta.userId, USER))
		.get()?.revision;
}

/** A current-format layout envelope naming the given narrators as panels. */
function dockviewLayout(narratorIds: string[], extraPanels: Record<string, unknown> = {}): string {
	const panels: Record<string, unknown> = { ...extraPanels };
	for (const narratorId of narratorIds) {
		panels[narratorId] = {
			id: narratorId,
			contentComponent: "narrator",
			params: { panelType: "narrator", narratorId },
		};
	}
	return JSON.stringify({
		version: 2,
		kind: "dockview",
		layout: {
			grid: {
				root: { type: "branch", data: [] },
				width: 1920,
				height: 1080,
				orientation: "HORIZONTAL",
			},
			panels,
		},
		director: { mode: "grid", primaryPanelId: null, primaryRatio: 0.72 },
	});
}

beforeEach(() => {
	seedUser();
});

afterEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.module("../../../server/websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

describe("membership and its sidebar projection commit together", () => {
	it("adding a narrator panel writes the row and attaches the tab in one revision", async () => {
		seedWorkspace("ws");
		seedWorkspaceTab("ws");
		seedNarrator("n1");
		seedNarratorTab("n1", undefined, 1);
		const before = tabRevision();

		const { panel, created } = await addWorkspacePanel(USER, "ws", {
			kind: "narrator",
			narratorId: "n1",
		});

		expect(created).toBe(true);
		expect(panel.kind).toBe("narrator");
		expect(panelRows("ws").map((row) => row.narratorId)).toEqual(["n1"]);
		expect(tabWorkspaceId("n1")).toBe("ws");
		// One revision, not two: the row and the projection are the same write.
		expect(tabRevision()).toBe((before ?? 0) + 1);
	});

	it("removing a narrator panel releases the tab back to the top level", async () => {
		seedWorkspace("ws");
		seedWorkspaceTab("ws");
		seedNarrator("n1");
		seedNarratorTab("n1", "ws", 1);
		const { panel } = await addWorkspacePanel(USER, "ws", { kind: "narrator", narratorId: "n1" });

		await removeWorkspacePanel(USER, "ws", panel.id);

		expect(panelRows("ws")).toHaveLength(0);
		// Released, not deleted: the narrator still exists and stays reachable.
		expect(tabWorkspaceId("n1")).toBe(null);
	});

	// The behaviour that made the reported bug possible was a client-side
	// uniqueness check. Two concurrent adds could both pass it.
	it("adding the same narrator twice is idempotent", async () => {
		seedWorkspace("ws");
		seedNarrator("n1");
		seedNarratorTab("n1");

		const first = await addWorkspacePanel(USER, "ws", { kind: "narrator", narratorId: "n1" });
		const second = await addWorkspacePanel(USER, "ws", { kind: "narrator", narratorId: "n1" });

		expect(second.created).toBe(false);
		expect(second.panel.id).toBe(first.panel.id);
		expect(panelRows("ws")).toHaveLength(1);
	});

	it("attaching a narrator that has no sidebar tab still creates the panel", async () => {
		seedWorkspace("ws");
		seedNarrator("n1");

		const { created } = await addWorkspacePanel(USER, "ws", { kind: "narrator", narratorId: "n1" });

		// Membership does not depend on the projection existing.
		expect(created).toBe(true);
		expect(panelRows("ws")).toHaveLength(1);
	});

	it("deleting the narrator removes its panel row via cascade", async () => {
		seedWorkspace("ws");
		seedNarrator("n1");
		await addWorkspacePanel(USER, "ws", { kind: "narrator", narratorId: "n1" });

		db.delete(narrators).where(eq(narrators.id, "n1")).run();

		expect(panelRows("ws")).toHaveLength(0);
	});
});

describe("non-narrator panels", () => {
	it("stores several terminals independently", async () => {
		seedWorkspace("ws");

		await addWorkspacePanel(USER, "ws", {
			kind: "terminal",
			config: { panelType: "terminal", terminalConfig: { cwd: "/a" } },
		});
		await addWorkspacePanel(USER, "ws", {
			kind: "terminal",
			config: { panelType: "terminal", terminalConfig: { cwd: "/b" } },
		});

		// The narrator uniqueness index must not collapse these (narrator_id is null).
		expect(panelRows("ws")).toHaveLength(2);
	});

	it("rejects a config past the byte ceiling without writing a row", async () => {
		seedWorkspace("ws");

		await expect(
			addWorkspacePanel(USER, "ws", {
				kind: "webview",
				config: {
					panelType: "webview",
					webviewConfig: { url: `https://example.com/${"x".repeat(32 * 1024)}` },
				},
			}),
		).rejects.toThrow(/UTF-8 bytes/);
		expect(panelRows("ws")).toHaveLength(0);
	});

	// A plugin panel inside a workspace binds to an owning narrator, so it is that
	// narrator's resource rather than membership. Accepting it here would create a row
	// that no client ever produces — and the membership sync would then close the live
	// plugin panel as a "stale member".
	it("refuses plugin panels, which are narrator-owned resources", async () => {
		seedWorkspace("ws");

		expect(
			createWorkspacePanelSchema.safeParse({ kind: "plugin", config: { panelType: "plugin" } })
				.success,
		).toBe(false);
	});

	it("refuses to set a config on a narrator panel", async () => {
		seedWorkspace("ws");
		seedNarrator("n1");
		const { panel } = await addWorkspacePanel(USER, "ws", { kind: "narrator", narratorId: "n1" });

		await expect(
			updateWorkspacePanelConfig(USER, "ws", panel.id, { any: "thing" }),
		).rejects.toThrow(/no config/);
	});

	it("updates a webview config in place", async () => {
		seedWorkspace("ws");
		const { panel } = await addWorkspacePanel(USER, "ws", {
			kind: "webview",
			config: { panelType: "webview", webviewConfig: { url: "https://a.example" } },
		});

		const updated = await updateWorkspacePanelConfig(USER, "ws", panel.id, {
			panelType: "webview",
			webviewConfig: { url: "https://b.example" },
		});

		expect(updated.config).toEqual({
			panelType: "webview",
			webviewConfig: { url: "https://b.example" },
		});
	});
});

describe("outline pages as members", () => {
	it("stores an outline page with only its place, and lists it back", async () => {
		seedWorkspace("ws");
		const { panel } = await addWorkspacePanel(USER, "ws", {
			kind: "outline",
			config: {
				panelType: "outline",
				spaceId: "space1",
				blockId: "page1",
				view: "all",
				asOf: 12,
				title: "Kept out of the row",
				hostNarratorId: "n1",
			},
		});
		expect(panel.kind).toBe("outline");
		expect(panel.config).toEqual({ spaceId: "space1", blockId: "page1", view: "all" });
		expect(JSON.parse(panelRows("ws")[0]?.configJson ?? "null")).toEqual({
			spaceId: "space1",
			blockId: "page1",
			view: "all",
		});
		// Two pages, or the same page twice, are two members.
		await addWorkspacePanel(USER, "ws", { kind: "outline", config: { spaceId: "space1" } });
		const listed = await listWorkspacePanels(USER, "ws");
		expect(listed.map((member) => [member.kind, member.config])).toEqual([
			["outline", { spaceId: "space1", blockId: "page1", view: "all" }],
			["outline", { spaceId: "space1" }],
		]);
	});

	it("accepts the kind at the API boundary and refuses a config naming no space", async () => {
		seedWorkspace("ws");
		expect(
			createWorkspacePanelSchema.safeParse({ kind: "outline", config: { spaceId: "s" } }).success,
		).toBe(true);
		for (const config of [null, {}, { spaceId: "" }, { spaceId: "bad/id" }, { spaceId: 3 }]) {
			await expect(addWorkspacePanel(USER, "ws", { kind: "outline", config })).rejects.toThrow(
				/spaceId/,
			);
		}
		expect(panelRows("ws")).toHaveLength(0);
	});

	it("updates the place in place and refuses to clear it", async () => {
		seedWorkspace("ws");
		const { panel } = await addWorkspacePanel(USER, "ws", {
			kind: "outline",
			config: { spaceId: "space1", blockId: "page1" },
		});
		const updated = await updateWorkspacePanelConfig(USER, "ws", panel.id, {
			spaceId: "space1",
			blockId: "block7",
			pageId: "page1",
		});
		expect(updated.config).toEqual({ spaceId: "space1", blockId: "block7" });
		await expect(updateWorkspacePanelConfig(USER, "ws", panel.id, {})).rejects.toThrow(/spaceId/);
		expect(JSON.parse(panelRows("ws")[0]?.configJson ?? "null")).toEqual({
			spaceId: "space1",
			blockId: "block7",
		});
	});

	it("backfills an outline member from an old layout, but not a session's outline resource", () => {
		const layout = dockviewLayout(["n1"], {
			wsp_row1: {
				id: "wsp_row1",
				params: { panelType: "outline", spaceId: "space1", blockId: "page1", panelRowId: "row1" },
			},
			woutline_n1_x: {
				id: "woutline_n1_x",
				params: { panelType: "outline", spaceId: "space1", blockId: "page2", hostNarratorId: "n1" },
			},
		});
		const recovered = recoverPanelsFromLayout(layout);
		expect(recovered).toContainEqual({
			kind: "outline",
			narratorId: null,
			config: { spaceId: "space1", blockId: "page1" },
		});
		expect(recovered.filter((panel) => panel.kind === "outline")).toHaveLength(1);
	});
});

describe("ownership", () => {
	it("treats another user's workspace as missing and writes nothing", async () => {
		seedWorkspace("ws");
		seedNarrator("n1");

		await expect(
			addWorkspacePanel("someone-else", "ws", { kind: "narrator", narratorId: "n1" }),
		).rejects.toThrow(/not found/i);
		expect(panelRows("ws")).toHaveLength(0);
	});

	it("treats a missing workspace as missing on read", async () => {
		await expect(listWorkspacePanels(USER, "nope")).rejects.toThrow(/not found/i);
	});
});

describe("backfill on first read", () => {
	it("materialises top-level panels from a dockview layout", async () => {
		seedWorkspace("ws", dockviewLayout(["n1", "n2"]));
		seedNarrator("n1");
		seedNarrator("n2");

		const panels = await listWorkspacePanels(USER, "ws");

		expect(panels.map((panel) => panel.narratorId).sort()).toEqual(["n1", "n2"]);
	});

	// THE REPORTED BUG, as data: the sidebar knows about `n2` but the layout never
	// received it. A union is the only merge that does not lose it, and it needs no
	// guess about whether the panel was dropped or deliberately closed.
	it("unions the layout with the sidebar projection so a layout-only loss is repaired", async () => {
		seedWorkspace("ws", dockviewLayout(["n1"]));
		seedWorkspaceTab("ws");
		seedNarrator("n1");
		seedNarrator("n2");
		seedNarratorTab("n1", "ws", 1);
		db.insert(userRecentTabs)
			.values({
				id: "tab-n2",
				userId: USER,
				tabKey: "narrator:n2",
				section: "work",
				type: "narrator",
				entityId: "n2",
				representedNarratorId: "n2",
				workspaceId: "ws",
				title: "n2",
				lastVisitedAt: 98,
				sortOrder: 2,
				createdAt: NOW_ISO,
				updatedAt: NOW_ISO,
			})
			.run();

		const panels = await listWorkspacePanels(USER, "ws");

		expect(panels.map((panel) => panel.narratorId).sort()).toEqual(["n1", "n2"]);
	});

	it("falls back to the sidebar projection alone when the layout is corrupt", async () => {
		seedWorkspace("ws", "{not valid json");
		seedWorkspaceTab("ws");
		seedNarrator("n1");
		seedNarratorTab("n1", "ws", 1);

		const panels = await listWorkspacePanels(USER, "ws");

		// A workspace with every panel present and a default arrangement is the
		// acceptable degradation; an empty surface is not.
		expect(panels.map((panel) => panel.narratorId)).toEqual(["n1"]);
	});

	it("runs only once", async () => {
		seedWorkspace("ws", dockviewLayout(["n1"]));
		seedNarrator("n1");

		await listWorkspacePanels(USER, "ws");
		await listWorkspacePanels(USER, "ws");

		expect(panelRows("ws")).toHaveLength(1);
	});

	it("adding a panel to a legacy workspace preserves its existing panels", async () => {
		seedWorkspace("ws", dockviewLayout(["n1"]));
		seedNarrator("n1");
		seedNarrator("n2");

		await addWorkspacePanel(USER, "ws", { kind: "narrator", narratorId: "n2" });

		// Without the backfill inside add, `n1` would have been silently dropped the
		// first time anything was added.
		expect(
			panelRows("ws")
				.map((row) => row.narratorId)
				.sort(),
		).toEqual(["n1", "n2"]);
	});
});

describe("recoverPanelsFromLayout", () => {
	it("ignores dependent panels, which stay in the layout blob", () => {
		const layout = dockviewLayout(["n1"], {
			wtool_n1_git: {
				id: "wtool_n1_git",
				params: { panelType: "narrator-tool", toolType: "git", narratorId: "n1" },
			},
			wsubagent_n1_s1: {
				id: "wsubagent_n1_s1",
				params: { panelType: "subagent", hostNarratorId: "n1", subagentNarratorId: "s1" },
			},
		});

		const recovered = recoverPanelsFromLayout(layout);

		expect(recovered).toHaveLength(1);
		expect(recovered[0]).toEqual({ kind: "narrator", narratorId: "n1", config: null });
	});

	it("recovers terminal and webview panels with their config", () => {
		const layout = dockviewLayout([], {
			t1: { id: "t1", params: { panelType: "terminal", terminalConfig: { cwd: "/x" } } },
			w1: { id: "w1", params: { panelType: "webview", webviewConfig: { url: "https://x" } } },
		});

		const recovered = recoverPanelsFromLayout(layout);

		expect(recovered.map((panel) => panel.kind).sort()).toEqual(["terminal", "webview"]);
	});

	it("reads a seed envelope", () => {
		const seed = JSON.stringify({
			kind: "seed",
			seed: [
				{ id: "a", params: { panelType: "narrator", narratorId: "n1" }, title: "N" },
				{ id: "b", params: { panelType: "narrator", narratorId: "n2" }, title: "N" },
			],
		});

		expect(recoverPanelsFromLayout(seed).map((panel) => panel.narratorId)).toEqual(["n1", "n2"]);
	});

	it("reads a legacy split-tree, defaulting leaves to narrator", () => {
		const legacy = JSON.stringify({
			type: "branch",
			id: "b",
			direction: "horizontal",
			sizes: [50, 50],
			children: [
				{ type: "leaf", id: "l1", narratorId: "n1" },
				{ type: "leaf", id: "l2", narratorId: "n2" },
			],
		});

		expect(recoverPanelsFromLayout(legacy).map((panel) => panel.narratorId)).toEqual(["n1", "n2"]);
	});

	it("returns nothing for corrupt or empty input rather than throwing", () => {
		expect(recoverPanelsFromLayout("{not json")).toEqual([]);
		expect(recoverPanelsFromLayout(null)).toEqual([]);
		expect(recoverPanelsFromLayout("{}")).toEqual([]);
	});

	it("skips a narrator entry with no id", () => {
		const layout = dockviewLayout([], {
			broken: { id: "broken", params: { panelType: "narrator" } },
		});

		expect(recoverPanelsFromLayout(layout)).toEqual([]);
	});
});
