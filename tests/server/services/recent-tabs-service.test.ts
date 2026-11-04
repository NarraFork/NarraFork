import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { type PersistedRecentTab, RECENT_TABS_STORAGE_LIMIT } from "@shared/recent-tabs";
import { eq } from "drizzle-orm";
import {
	narrators,
	userPreferences,
	userRecentTabs,
	userRecentTabsMeta,
	users,
	workspaces,
} from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
const broadcasts: Array<{ userId: string; event: Record<string, unknown> }> = [];
const realDbModule = { ...(await import("../../../server/db")) };
const realNarratorWsModule = { ...(await import("../../../server/websocket/narrator-ws")) };
mock.module("../../../server/db", () => ({ db, sqlite }));
mock.module("../../../server/websocket/narrator-ws", () => ({
	broadcastToUser: (userId: string, event: Record<string, unknown>) => {
		broadcasts.push({ userId, event });
	},
	getNarratorPresenceBatch: () => new Map(),
}));

const recentTabs = await import("../../../server/services/recent-tabs-service");
const { reduceRecentTabsOperations } = await import("../../../frontend/hooks/useRecentTabs");
const { applyRecentTabMove } = await import("../../../frontend/hooks/recent-tab-folders");

const NOW = "2026-07-19T00:00:00.000Z";

function seedUser(userId = "user-1"): void {
	db.insert(users)
		.values({
			id: userId,
			username: userId,
			passwordHash: "test-password-hash",
			role: "user",
			createdAt: NOW,
		})
		.run();
}

/**
 * Seed through the legacy JSON path. Tabs are written in the CURRENT shape and
 * translated to what pre-folder clients stored (a `workspace` header plus children
 * carrying `workspaceId`), which the lazy migration converts back into folders — so
 * these scenarios also exercise that conversion.
 */
function toLegacyShape(tab: PersistedRecentTab): Record<string, unknown> {
	const { folderId, ...rest } = tab;
	if (tab.type === "folder") return { ...rest, type: "workspace" };
	return folderId ? { ...rest, workspaceId: folderId } : rest;
}

function seedLegacyTabs(tabs: PersistedRecentTab[], userId = "user-1"): void {
	seedUser(userId);
	db.insert(userPreferences)
		.values({
			id: `pref-${userId}`,
			userId,
			recentTabs: JSON.stringify(tabs.map(toLegacyShape)),
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function makeTab(id: string, overrides: Partial<PersistedRecentTab> = {}): PersistedRecentTab {
	return {
		type: "narrator",
		id,
		title: `Tab ${id}`,
		lastVisitedAt: 10_000 - Number(id.replace(/\D/g, "") || 0),
		...overrides,
	};
}

function storedKeys(userId = "user-1"): string[] {
	return db
		.select({ key: userRecentTabs.tabKey })
		.from(userRecentTabs)
		.where(eq(userRecentTabs.userId, userId))
		.orderBy(userRecentTabs.sortOrder)
		.all()
		.map((row) => row.key);
}

beforeEach(() => {
	broadcasts.length = 0;
});

afterEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.module("../../../server/websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

describe("hidden narrators", () => {
	it("leaves a ModelTrace cabin out of the sidebar", async () => {
		seedUser();
		db.insert(narrators)
			.values([
				{
					id: "cabin",
					title: "ModelTrace",
					hiddenFromLists: true,
					createdAt: NOW,
					updatedAt: NOW,
				},
				{
					id: "sub-cabin",
					title: "ModelTrace sub",
					hiddenFromLists: true,
					createdAt: NOW,
					updatedAt: NOW,
				},
				{
					id: "visible",
					title: "Visible",
					hiddenFromLists: false,
					createdAt: NOW,
					updatedAt: NOW,
				},
			])
			.run();

		const saved = await recentTabs.upsertRecentTabsBatch("user-1", [
			makeTab("cabin"),
			makeTab("sub-cabin", { type: "subagent" }),
			makeTab("visible"),
		]);
		expect(saved.changed).toBe(true);
		expect(storedKeys()).toEqual(["narrator:visible"]);

		const skipped = await recentTabs.upsertRecentTab("user-1", makeTab("cabin"));
		expect(skipped).toEqual({
			changed: false,
			baseRevision: saved.revision,
			revision: saved.revision,
			operations: [],
		});
		expect(storedKeys()).toEqual(["narrator:visible"]);
	});
});

describe("recent-tabs indexed side paths", () => {
	it("promotes a draft tab without disturbing the pinned zone", async () => {
		seedLegacyTabs([
			makeTab("pinned", { type: "project", pinned: true }),
			makeTab("older"),
			makeTab("draft-target"),
		]);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.syncNarratorDraftToRecentTabs("user-1", "draft-target", {
			promote: true,
		});
		expect(storedKeys()).toEqual(["project:pinned", "narrator:draft-target", "narrator:older"]);
	});

	it("ignores folder membership carried by an updateOnly upsert", async () => {
		seedLegacyTabs([
			makeTab("folder-1", { type: "folder", title: "F" }),
			makeTab("child-1", { folderId: "folder-1" }),
			makeTab("child-2", { folderId: "folder-1" }),
		]);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.upsertRecentTab("user-1", makeTab("child-1", { title: "Renamed" }), {
			updateOnly: true,
		});
		const child = db
			.select({ folderId: userRecentTabs.folderId, title: userRecentTabs.title })
			.from(userRecentTabs)
			.where(eq(userRecentTabs.tabKey, "narrator:child-1"))
			.get();
		expect(child).toEqual({ folderId: "folder-1", title: "Renamed" });
	});

	it("uses narrator/entity membership indexes for title sync and all-user removal", async () => {
		seedLegacyTabs([
			makeTab("n-title", { title: "Old title" }),
			makeTab("project-1", { type: "project" }),
		]);
		seedLegacyTabs(
			[
				// A legacy chapter tab pointing at the same narrator: chapters were removed, so it
				// is dropped on migration and must not count as narrator membership.
				makeTab("chapter-1", {
					type: "chapter",
					narratorId: "n-title",
					title: "Old chapter title",
				}),
				makeTab("n-title", { title: "Old title" }),
				makeTab("project-1", { type: "project" }),
			],
			"user-2",
		);
		expect((await recentTabs.getRecentTabUserIdsForNarrator("n-title")).sort()).toEqual([
			"user-1",
			"user-2",
		]);
		expect(storedKeys("user-2")).toEqual(["narrator:n-title", "project:project-1"]);
		expect(await recentTabs.getRecentTabUserIdsForNarrator("n-title", 1)).toEqual(["user-1"]);
		expect(await recentTabs.getRecentTabUserIdsForNarrator("n-title", 0)).toEqual([]);
		await recentTabs.syncNarratorTitleToRecentTabs("n-title", "New title");
		const titleRows = db
			.select({ title: userRecentTabs.title })
			.from(userRecentTabs)
			.where(eq(userRecentTabs.representedNarratorId, "n-title"))
			.all();
		expect(titleRows.map((row) => row.title)).toEqual(["New title", "New title"]);

		expect((await recentTabs.getRecentTabUserIds("project", "project-1")).sort()).toEqual([
			"user-1",
			"user-2",
		]);
		await recentTabs.removeTabFromAllUsers("project", "project-1");
		expect(await recentTabs.getRecentTabUserIds("project", "project-1")).toEqual([]);
	});
});

describe("recent-tabs lazy migration", () => {
	it("migrates the legacy JSON once and shadows only the first 20 tabs", async () => {
		const legacy = Array.from({ length: 35 }, (_, index) => makeTab(`n-${index}`));
		seedLegacyTabs(legacy);

		expect(await recentTabs.ensureMigrated("user-1")).toBe(0);
		expect(await recentTabs.ensureMigrated("user-1")).toBe(0);

		const rows = db.select().from(userRecentTabs).all();
		expect(rows).toHaveLength(35);
		expect(db.select().from(userRecentTabsMeta).get()?.revision).toBe(0);
		const shadow = db.select().from(userPreferences).get();
		expect(JSON.parse(shadow?.recentTabs ?? "[]")).toHaveLength(20);
	});
});

describe("recent-tabs revisions and deltas", () => {
	it("does not advance revision or broadcast for a no-op", async () => {
		seedLegacyTabs([makeTab("n-1")]);
		await recentTabs.ensureMigrated("user-1");

		const first = await recentTabs.upsertRecentTab("user-1", makeTab("n-2"));
		expect(first).toMatchObject({ changed: true, baseRevision: 0, revision: 1 });
		expect(first.operations.length).toBeGreaterThan(0);
		const broadcastCount = broadcasts.length;

		const second = await recentTabs.upsertRecentTab("user-1", makeTab("n-2"));
		expect(second).toEqual({
			changed: false,
			baseRevision: 1,
			revision: 1,
			operations: [],
		});
		expect(broadcasts).toHaveLength(broadcastCount);
	});

	it("keeps an ordinary revisited tab in place while refreshing metadata", async () => {
		seedLegacyTabs([makeTab("n-1"), makeTab("n-2")]);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.upsertRecentTab(
			"user-1",
			makeTab("n-2", { title: "Revisited", lastVisitedAt: 99_999 }),
		);
		expect(storedKeys()).toEqual(["narrator:n-1", "narrator:n-2"]);
	});

	it("anchors metadata deltas within the tab's own section", async () => {
		seedLegacyTabs([
			makeTab("n-1"),
			makeTab("p-1", { type: "project" }),
			makeTab("n-2"),
			makeTab("p-2", { type: "project" }),
			makeTab("n-3"),
		]);
		await recentTabs.ensureMigrated("user-1");

		const result = await recentTabs.upsertRecentTab("user-1", makeTab("n-2", { title: "Renamed" }));

		expect(result.operations).toEqual([
			{
				type: "upsert",
				key: "narrator:n-2",
				tab: makeTab("n-2", { title: "Renamed" }),
				beforeKey: "narrator:n-3",
				afterKey: "narrator:n-1",
			},
		]);
	});

	it("marks the first row of a section with a null predecessor", async () => {
		seedLegacyTabs([makeTab("p-1", { type: "project" }), makeTab("n-1"), makeTab("n-2")]);
		await recentTabs.ensureMigrated("user-1");

		const result = await recentTabs.upsertRecentTab("user-1", makeTab("n-1", { title: "Renamed" }));

		expect(result.operations).toHaveLength(1);
		expect(result.operations[0]).toMatchObject({
			key: "narrator:n-1",
			beforeKey: "narrator:n-2",
			afterKey: null,
		});
	});

	it("includes displaced block members when constructing sequential moves", async () => {
		seedLegacyTabs([makeTab("a"), makeTab("b"), makeTab("c"), makeTab("d")]);
		await recentTabs.ensureMigrated("user-1");

		const result = await recentTabs.restoreRecentTabs("user-1", {
			tabs: [makeTab("c"), makeTab("d"), makeTab("a"), makeTab("b")],
		});

		expect(storedKeys()).toEqual(["narrator:c", "narrator:d", "narrator:a", "narrator:b"]);
		expect(result.operations).toEqual([
			{ type: "move", key: "narrator:c", beforeKey: "narrator:d", afterKey: null },
			{ type: "move", key: "narrator:d", beforeKey: "narrator:a", afterKey: "narrator:c" },
		]);
	});

	it("replays server deltas to the persisted order across mixed-section folder permutations", async () => {
		const blocks = [
			[makeTab("p-1", { type: "project" })],
			[makeTab("n-1")],
			[makeTab("ws-1", { type: "folder" }), makeTab("child-1", { folderId: "ws-1" })],
			[makeTab("ws-2", { type: "folder" }), makeTab("child-2", { folderId: "ws-2" })],
		];
		function permutations<T>(items: T[]): T[][] {
			if (items.length === 0) return [[]];
			return items.flatMap((item, index) =>
				permutations(items.filter((_, otherIndex) => index !== otherIndex)).map((rest) => [
					item,
					...rest,
				]),
			);
		}
		seedLegacyTabs(blocks.flat());
		await recentTabs.ensureMigrated("user-1");

		for (const order of permutations(blocks)) {
			const before = await recentTabs.listAllRecentTabs("user-1");
			const result = await recentTabs.restoreRecentTabs("user-1", { tabs: order.flat() });
			const persisted = await recentTabs.listAllRecentTabs("user-1");
			for (const section of ["projects", "work"] as const) {
				const belongs = (tab: PersistedRecentTab) =>
					(tab.type === "project") === (section === "projects");
				expect(
					reduceRecentTabsOperations(before.filter(belongs), section, result.operations),
				).toEqual(persisted.filter(belongs));
			}
		}
	});

	it("a batch upsert cannot create a folder or a workspace header", async () => {
		seedLegacyTabs([]);
		const result = await recentTabs.upsertRecentTabsBatch("user-1", [
			makeTab("child-1", { folderId: "ws-batch" }),
			makeTab("ws-batch", { type: "folder", title: "Batch" }),
			makeTab("ws-legacy", { type: "workspace", title: "Legacy" }),
		]);

		expect(result).toMatchObject({ changed: true, baseRevision: 0, revision: 1 });
		expect(storedKeys()).toEqual(["narrator:child-1"]);
		expect(
			db
				.select({ folderId: userRecentTabs.folderId })
				.from(userRecentTabs)
				.where(eq(userRecentTabs.tabKey, "narrator:child-1"))
				.get()?.folderId,
		).toBe(null);
	});

	it("splits large deltas into bounded WebSocket batches", async () => {
		seedLegacyTabs(Array.from({ length: 205 }, (_, index) => makeTab(`n-${index}`)));
		await recentTabs.ensureMigrated("user-1");

		const result = await recentTabs.clearRecentTabs("user-1", "all");
		expect(result.operations).toHaveLength(205);
		expect(broadcasts).toHaveLength(3);
		expect(broadcasts.map(({ event }) => event.batchIndex)).toEqual([0, 1, 2]);
		expect(broadcasts.map(({ event }) => event.batchCount)).toEqual([3, 3, 3]);
		expect(broadcasts.every(({ event }) => (event.operations as unknown[]).length <= 100)).toBe(
			true,
		);
	});
});

describe("recent-tabs row-level persistence", () => {
	it("writes only inserted, content-changed, or removed rows", async () => {
		seedLegacyTabs(Array.from({ length: 25 }, (_, index) => makeTab(`n-${index}`)));
		await recentTabs.ensureMigrated("user-1");
		sqlite.run(
			"CREATE TEMP TABLE recent_tab_write_audit (kind TEXT NOT NULL, tab_key TEXT NOT NULL)",
		);
		sqlite.run(`CREATE TEMP TRIGGER recent_tab_insert_audit AFTER INSERT ON user_recent_tabs
			BEGIN INSERT INTO recent_tab_write_audit(kind, tab_key) VALUES ('insert', NEW.tab_key); END`);
		sqlite.run(`CREATE TEMP TRIGGER recent_tab_update_audit AFTER UPDATE ON user_recent_tabs
			BEGIN INSERT INTO recent_tab_write_audit(kind, tab_key) VALUES ('update', NEW.tab_key); END`);
		sqlite.run(`CREATE TEMP TRIGGER recent_tab_delete_audit AFTER DELETE ON user_recent_tabs
			BEGIN INSERT INTO recent_tab_write_audit(kind, tab_key) VALUES ('delete', OLD.tab_key); END`);

		try {
			await recentTabs.upsertRecentTab("user-1", makeTab("n-new"));
			expect(
				sqlite.prepare("SELECT kind, tab_key AS tabKey FROM recent_tab_write_audit").all(),
			).toEqual([{ kind: "insert", tabKey: "narrator:n-new" }]);

			sqlite.run("DELETE FROM recent_tab_write_audit");
			await recentTabs.upsertRecentTab("user-1", makeTab("n-1", { title: "Renamed" }));
			expect(
				sqlite.prepare("SELECT kind, tab_key AS tabKey FROM recent_tab_write_audit").all(),
			).toEqual([{ kind: "update", tabKey: "narrator:n-1" }]);

			sqlite.run("DELETE FROM recent_tab_write_audit");
			await recentTabs.removeRecentTab("user-1", "narrator", "n-2");
			expect(
				sqlite.prepare("SELECT kind, tab_key AS tabKey FROM recent_tab_write_audit").all(),
			).toEqual([{ kind: "delete", tabKey: "narrator:n-2" }]);
		} finally {
			sqlite.run("DROP TRIGGER IF EXISTS recent_tab_insert_audit");
			sqlite.run("DROP TRIGGER IF EXISTS recent_tab_update_audit");
			sqlite.run("DROP TRIGGER IF EXISTS recent_tab_delete_audit");
			sqlite.run("DROP TABLE IF EXISTS recent_tab_write_audit");
		}
	});
});

describe("recent-tabs pagination and folders", () => {
	it("places narrator tabs in work and only project tabs in projects", async () => {
		seedLegacyTabs([
			makeTab("project-1", { type: "project" }),
			makeTab("narrator-1", { type: "narrator" }),
		]);

		const projects = await recentTabs.listPage("user-1", "projects");
		const work = await recentTabs.listPage("user-1", "work");
		expect(projects.items.map((tab) => `${tab.type}:${tab.id}`)).toEqual(["project:project-1"]);
		expect(work.items.map((tab) => `${tab.type}:${tab.id}`)).toEqual(["narrator:narrator-1"]);
	});

	it("drops legacy chat-group tabs (the feature was removed)", async () => {
		seedLegacyTabs([
			makeTab("project-1", { type: "project" }),
			makeTab("group-1", { type: "group" }),
		]);

		const projects = await recentTabs.listPage("user-1", "projects");
		const work = await recentTabs.listPage("user-1", "work");
		expect(projects.items.map((tab) => `${tab.type}:${tab.id}`)).toEqual(["project:project-1"]);
		expect(work.items).toEqual([]);
	});

	it("rejects cursors from another section or stale revision", async () => {
		seedLegacyTabs([makeTab("n-1"), makeTab("n-2"), makeTab("p-1", { type: "project" })]);
		const first = await recentTabs.listPage("user-1", "work", undefined, 1);
		expect(first.nextCursor).toBeString();

		await expect(
			recentTabs.listPage("user-1", "projects", first.nextCursor ?? undefined, 1),
		).rejects.toMatchObject({ statusCode: 409, code: "STALE_CURSOR" });
		await recentTabs.upsertRecentTab("user-1", makeTab("n-new"));
		await expect(
			recentTabs.listPage("user-1", "work", first.nextCursor ?? undefined, 1),
		).rejects.toMatchObject({ statusCode: 409, code: "STALE_CURSOR" });
	});

	it("does not split a folder at a page boundary", async () => {
		const tabs = Array.from({ length: 49 }, (_, index) => makeTab(`n-${index}`));
		tabs.push(makeTab("ws-1", { type: "folder", title: "Folder" }));
		for (let index = 0; index < 5; index++) {
			tabs.push(makeTab(`child-${index}`, { folderId: "ws-1" }));
		}
		tabs.push(makeTab("n-last"));
		seedLegacyTabs(tabs);

		const first = await recentTabs.listPage("user-1", "work", undefined, 50);
		expect(first.items).toHaveLength(55);
		expect(first.items.slice(-6).map((tab) => `${tab.type}:${tab.id}`)).toEqual([
			"folder:ws-1",
			"narrator:child-0",
			"narrator:child-1",
			"narrator:child-2",
			"narrator:child-3",
			"narrator:child-4",
		]);
		expect(first.hasMore).toBe(true);

		const second = await recentTabs.listPage("user-1", "work", first.nextCursor ?? undefined, 50);
		expect(second.items.map((tab) => tab.id)).toEqual(["n-last"]);
	});

	it("evicts a folder atomically at the 500-row boundary", async () => {
		const tabs = Array.from({ length: 498 }, (_, index) => makeTab(`n-${index}`));
		tabs.push(makeTab("ws-old", { type: "folder", title: "Old folder" }));
		tabs.push(makeTab("ws-child", { folderId: "ws-old" }));
		seedLegacyTabs(tabs);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.upsertRecentTab("user-1", makeTab("n-new"));
		const keys = storedKeys();
		expect(keys).toHaveLength(RECENT_TABS_STORAGE_LIMIT - 1);
		expect(keys).toContain("narrator:n-new");
		expect(keys).not.toContain("folder:ws-old");
		expect(keys).not.toContain("narrator:ws-child");
	});
});

describe("recent-tabs capacity and undo", () => {
	it("keeps 500 tabs and preserves the old subagent-first eviction rule", async () => {
		const tabs = Array.from({ length: 499 }, (_, index) => makeTab(`n-${index}`));
		tabs.push(makeTab("old-subagent", { type: "subagent" }));
		seedLegacyTabs(tabs);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.upsertRecentTab("user-1", makeTab("new-subagent", { type: "subagent" }));
		const keys = storedKeys();
		expect(keys).toHaveLength(RECENT_TABS_STORAGE_LIMIT);
		expect(keys).toContain("subagent:new-subagent");
		expect(keys).not.toContain("subagent:old-subagent");
	});

	it("restores a clear from the bounded undo token", async () => {
		seedLegacyTabs([makeTab("n-1"), makeTab("n-2")]);
		await recentTabs.ensureMigrated("user-1");

		const cleared = await recentTabs.clearRecentTabs("user-1", "all");
		expect(cleared).toMatchObject({ changed: true, revision: 1, removedCount: 2 });
		expect(cleared.undoToken).toBeString();
		expect(storedKeys()).toEqual([]);

		const restored = await recentTabs.restoreRecentTabs("user-1", {
			token: cleared.undoToken,
		});
		expect(restored).toMatchObject({ changed: true, baseRevision: 1, revision: 2 });
		expect(storedKeys()).toEqual(["narrator:n-1", "narrator:n-2"]);
	});

	it("restores a single-tab remove from the bounded undo token", async () => {
		seedLegacyTabs([makeTab("n-1"), makeTab("n-2"), makeTab("n-3")]);
		await recentTabs.ensureMigrated("user-1");

		const removed = await recentTabs.removeRecentTab("user-1", "narrator", "n-2", {
			storeUndo: true,
		});
		expect(removed).toMatchObject({ changed: true, revision: 1, removedCount: 1 });
		expect(removed.undoToken).toBeString();
		expect(storedKeys()).toEqual(["narrator:n-1", "narrator:n-3"]);

		const restored = await recentTabs.restoreRecentTabs("user-1", {
			token: removed.undoToken,
		});
		expect(restored).toMatchObject({ changed: true, baseRevision: 1, revision: 2 });
		expect(storedKeys()).toEqual(["narrator:n-1", "narrator:n-2", "narrator:n-3"]);
	});

	it("stores no undo token when removing a missing tab", async () => {
		seedLegacyTabs([makeTab("n-1")]);
		await recentTabs.ensureMigrated("user-1");

		const removed = await recentTabs.removeRecentTab("user-1", "narrator", "ghost", {
			storeUndo: true,
		});
		expect(removed).toMatchObject({ changed: false });
		expect(removed.undoToken).toBeUndefined();
	});

	it("stores no undo token for cascade removes", async () => {
		seedLegacyTabs([makeTab("n-1"), makeTab("n-2")]);
		await recentTabs.ensureMigrated("user-1");

		// Cascade / internal path (no storeUndo): must not mint an undo token.
		const cascaded = await recentTabs.removeRecentTab("user-1", "narrator", "n-1");
		expect(cascaded).toMatchObject({ changed: true, removedCount: 1 });
		expect(cascaded.undoToken).toBeUndefined();
		expect(storedKeys()).toEqual(["narrator:n-2"]);
	});

	it("rejects an undo token after another mutation advances revision", async () => {
		seedLegacyTabs([makeTab("n-1"), makeTab("n-2")]);
		const cleared = await recentTabs.clearRecentTabs("user-1", "all");
		await recentTabs.upsertRecentTab("user-1", makeTab("n-new"));

		await expect(
			recentTabs.restoreRecentTabs("user-1", { token: cleared.undoToken }),
		).rejects.toMatchObject({ statusCode: 409, code: "RECENT_TABS_UNDO_CONFLICT" });
		expect(storedKeys()).toEqual(["narrator:n-new"]);
	});

	it("never clears pinned tabs, in any scope", async () => {
		seedLegacyTabs([
			makeTab("p-pinned", { type: "project", pinned: true }),
			makeTab("p-plain", { type: "project" }),
			makeTab("n-pinned", { pinned: true }),
			makeTab("n-plain"),
		]);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.clearRecentTabs("user-1", "projects");
		expect(storedKeys()).toEqual(["project:p-pinned", "narrator:n-pinned", "narrator:n-plain"]);

		await recentTabs.clearRecentTabs("user-1", "inactive_narrators");
		expect(storedKeys()).toEqual(["project:p-pinned", "narrator:n-pinned"]);

		await recentTabs.clearRecentTabs("user-1", "all");
		expect(storedKeys()).toEqual(["project:p-pinned", "narrator:n-pinned"]);
	});

	it("keeps folders intact and never touches workspaces when clearing", async () => {
		seedLegacyTabs([
			makeTab("ws-1", { type: "folder", title: "Folder" }),
			makeTab("n-child", { folderId: "ws-1" }),
			makeTab("n-loose"),
		]);
		db.insert(narrators)
			.values(
				["n-child", "n-loose"].map((id) => ({
					id,
					type: "primary",
					inheritMode: "fresh",
					status: "idle",
					createdAt: NOW,
					updatedAt: NOW,
				})) as Array<typeof narrators.$inferInsert>,
			)
			.run();
		// Same id as the folder: a converted legacy group whose workspace still exists.
		db.insert(workspaces)
			.values({
				id: "ws-1",
				userId: "user-1",
				title: "Folder",
				tree: "{}",
				createdAt: new Date(NOW),
				updatedAt: new Date(NOW),
			})
			.run();
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.clearRecentTabs("user-1", "inactive_narrators");
		expect(storedKeys()).toEqual(["folder:ws-1", "narrator:n-child"]);
		await recentTabs.clearRecentTabs("user-1", "all");
		expect(storedKeys()).toEqual(["folder:ws-1", "narrator:n-child"]);
		expect(db.select().from(workspaces).where(eq(workspaces.id, "ws-1")).get()).toBeDefined();
	});
});

describe("recent-tabs folder member anchored moves", () => {
	const memberIds = ["child-a", "child-b", "child-c", "child-d"];
	const seedWorkspace = async () => {
		seedLegacyTabs([
			makeTab("project-1", { type: "project", pinned: true }),
			makeTab("n-top"),
			makeTab("ws-1", { type: "folder", title: "Folder" }),
			...memberIds.map((id) => makeTab(id, { folderId: "ws-1" })),
			makeTab("n-tail"),
		]);
		await recentTabs.ensureMigrated("user-1");
	};
	const storedMembership = () =>
		db
			.select({
				key: userRecentTabs.tabKey,
				type: userRecentTabs.type,
				folderId: userRecentTabs.folderId,
			})
			.from(userRecentTabs)
			.where(eq(userRecentTabs.userId, "user-1"))
			.orderBy(userRecentTabs.tabKey)
			.all();

	// Every source/anchor pair covers both directions, including middle positions
	// and moves whose source originally precedes or follows the target sibling.
	for (const position of ["before", "after"] as const) {
		for (const source of memberIds) {
			for (const anchor of memberIds.filter((id) => id !== source)) {
				it(`moves ${source} ${position} ${anchor} without changing membership`, async () => {
					await seedWorkspace();
					const membership = storedMembership();
					const before = await recentTabs.listAllRecentTabs("user-1");
					const expectedMembers = memberIds.filter((id) => id !== source);
					const target = expectedMembers.indexOf(anchor) + (position === "after" ? 1 : 0);
					expectedMembers.splice(target, 0, source);

					const result = await recentTabs.moveRecentTab("user-1", {
						key: `narrator:${source}`,
						...(position === "before"
							? { beforeKey: `narrator:${anchor}` }
							: { afterKey: `narrator:${anchor}` }),
					});

					expect(storedKeys()).toEqual([
						"project:project-1",
						"narrator:n-top",
						"folder:ws-1",
						...expectedMembers.map((id) => `narrator:${id}`),
						"narrator:n-tail",
					]);
					expect(storedMembership()).toEqual(membership);
					expect(
						reduceRecentTabsOperations(
							before.filter((tab) => tab.type !== "project"),
							"work",
							result.operations,
						),
					).toEqual(
						(await recentTabs.listAllRecentTabs("user-1")).filter((tab) => tab.type !== "project"),
					);
					const changed = expectedMembers.some((id, index) => id !== memberIds[index]);
					expect(result.changed).toBe(changed);
				});
			}
		}
	}

	for (const position of ["before", "after"] as const) {
		it(`keeps an external top-level move ${position} a member at the folder edge`, async () => {
			await seedWorkspace();
			const membership = storedMembership();
			await recentTabs.moveRecentTab("user-1", {
				key: position === "before" ? "narrator:n-tail" : "narrator:n-top",
				...(position === "before"
					? { beforeKey: "narrator:child-b" }
					: { afterKey: "narrator:child-b" }),
			});
			const workspaceKeys = ["folder:ws-1", ...memberIds.map((id) => `narrator:${id}`)];
			expect(storedKeys()).toEqual(
				position === "before"
					? ["project:project-1", "narrator:n-top", "narrator:n-tail", ...workspaceKeys]
					: ["project:project-1", ...workspaceKeys, "narrator:n-top", "narrator:n-tail"],
			);
			expect(storedMembership()).toEqual(membership);
		});
	}
});

/**
 * Anchored upsert: create AND position a tab in one revision.
 *
 * This exists so an external drop (a narrator card dragged from the list page into the
 * sidebar) does not need upsert-then-move. Two revisions would render the tab at the
 * default insertion point for one frame before it jumps to where the user aimed.
 */
describe("recent-tabs anchored upsert", () => {
	it("inserts a NEW tab before and after an anchor", async () => {
		seedLegacyTabs([makeTab("n-1"), makeTab("n-2"), makeTab("n-3")]);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.upsertRecentTab("user-1", makeTab("n-before"), {
			beforeKey: "narrator:n-2",
		});
		expect(storedKeys()).toEqual([
			"narrator:n-1",
			"narrator:n-before",
			"narrator:n-2",
			"narrator:n-3",
		]);

		await recentTabs.upsertRecentTab("user-1", makeTab("n-after"), { afterKey: "narrator:n-3" });
		expect(storedKeys().at(-1)).toBe("narrator:n-after");
	});

	it("repositions a tab that is ALREADY in the list", async () => {
		seedLegacyTabs([makeTab("n-1"), makeTab("n-2"), makeTab("n-3")]);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.upsertRecentTab("user-1", makeTab("n-3"), { beforeKey: "narrator:n-1" });
		expect(storedKeys()).toEqual(["narrator:n-3", "narrator:n-1", "narrator:n-2"]);
	});

	// The drop resolver keeps unpinned tabs out of the pinned section, but the anchor is
	// still honoured verbatim here: the server must not silently relocate a tab the client
	// explicitly positioned. What it MUST NOT do is invent a position of its own.
	it("honours an anchor that lands right after the pinned section", async () => {
		seedLegacyTabs([makeTab("p-1", { pinned: true }), makeTab("n-1"), makeTab("n-2")]);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.upsertRecentTab("user-1", makeTab("n-new"), { beforeKey: "narrator:n-1" });
		expect(storedKeys()).toEqual([
			"narrator:p-1",
			"narrator:n-new",
			"narrator:n-1",
			"narrator:n-2",
		]);
	});

	// A folder is contiguous, so an index inside it is not a position a top-level tab can
	// occupy. Anchoring to a MEMBER must therefore resolve to the folder's boundary, or
	// `regroupFolders` would move the tab somewhere the user did not choose.
	it("expands an anchor on a folder member to the whole folder", async () => {
		seedLegacyTabs([
			makeTab("n-top"),
			makeTab("ws-1", { type: "folder", title: "Folder" }),
			makeTab("child-a", { folderId: "ws-1" }),
			makeTab("child-b", { folderId: "ws-1" }),
			makeTab("n-tail"),
		]);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.upsertRecentTab("user-1", makeTab("n-new"), {
			afterKey: "narrator:child-a",
		});
		expect(storedKeys()).toEqual([
			"narrator:n-top",
			"folder:ws-1",
			"narrator:child-a",
			"narrator:child-b",
			"narrator:n-new",
			"narrator:n-tail",
		]);
	});

	// A stale anchor is the client's view lagging a removal. A NEW tab still has to land
	// somewhere, so it takes the default insertion point.
	it("falls back to the default insertion point when the anchor is gone", async () => {
		seedLegacyTabs([makeTab("p-1", { pinned: true }), makeTab("n-1")]);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.upsertRecentTab("user-1", makeTab("n-new"), {
			beforeKey: "narrator:vanished",
		});
		expect(storedKeys()).toEqual(["narrator:p-1", "narrator:n-new", "narrator:n-1"]);
	});

	// An EXISTING tab must not move at all in that case: a plain revisit carrying a stale
	// anchor would otherwise yank the tab out of its place.
	it("leaves an existing tab in place when the anchor is gone", async () => {
		seedLegacyTabs([makeTab("n-1"), makeTab("n-2"), makeTab("n-3")]);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.upsertRecentTab("user-1", makeTab("n-2"), { afterKey: "narrator:vanished" });
		expect(storedKeys()).toEqual(["narrator:n-1", "narrator:n-2", "narrator:n-3"]);
	});

	it("ignores a self-anchor instead of reading it as a move", async () => {
		seedLegacyTabs([makeTab("n-1"), makeTab("n-2")]);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.upsertRecentTab("user-1", makeTab("n-2"), { beforeKey: "narrator:n-2" });
		expect(storedKeys()).toEqual(["narrator:n-1", "narrator:n-2"]);
	});

	// Dropping a folder member (e.g. from the list page) next to a top-level tab is an
	// explicit "put it here": it leaves its folder, and an emptied folder disappears.
	it("an anchor on a folder member takes it out of the folder", async () => {
		seedLegacyTabs([
			makeTab("n-top"),
			makeTab("ws-1", { type: "folder", title: "Folder" }),
			makeTab("child-a", { folderId: "ws-1" }),
		]);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.upsertRecentTab("user-1", makeTab("child-a"), {
			beforeKey: "narrator:n-top",
		});
		expect(storedKeys()).toEqual(["narrator:child-a", "narrator:n-top"]);
	});

	// One revision is the entire reason this endpoint grew anchors.
	it("costs exactly one revision", async () => {
		seedLegacyTabs([makeTab("n-1"), makeTab("n-2")]);
		const baseline = await recentTabs.ensureMigrated("user-1");

		const result = await recentTabs.upsertRecentTab("user-1", makeTab("n-new"), {
			afterKey: "narrator:n-1",
		});
		expect(result.revision).toBe(baseline + 1);
		expect(result.changed).toBe(true);
	});
});

/**
 * Folder operations must replay on the client to exactly the order the server persists:
 * the sidebar applies every mutation's delta through `reduceRecentTabsOperations`.
 */
describe("recent-tabs folder deltas replay on the client", () => {
	async function expectReplay(run: () => Promise<{ operations: unknown[] }>): Promise<void> {
		const before = (await recentTabs.listAllRecentTabs("user-1")).filter(
			(tab) => tab.type !== "project",
		);
		const result = (await run()) as Awaited<ReturnType<typeof recentTabs.moveRecentTab>>;
		const persisted = (await recentTabs.listAllRecentTabs("user-1")).filter(
			(tab) => tab.type !== "project",
		);
		expect(reduceRecentTabsOperations(before, "work", result.operations)).toEqual(persisted);
	}

	it("create, join, reorder, pin, leave, dissolve and close", async () => {
		seedLegacyTabs(["a", "b", "c", "d", "e"].map((id) => makeTab(id)));
		await recentTabs.ensureMigrated("user-1");
		let folderId = "";
		await expectReplay(async () => {
			const result = await recentTabs.createRecentTabFolder("user-1", {
				targetKey: "narrator:b",
				sourceKey: "narrator:d",
				title: "F",
			});
			folderId = result.folderId ?? "";
			return result;
		});
		await expectReplay(() => recentTabs.moveRecentTab("user-1", { key: "narrator:e", folderId }));
		await expectReplay(() =>
			recentTabs.moveRecentTab("user-1", { key: "narrator:e", beforeKey: "narrator:b" }),
		);
		await expectReplay(() => recentTabs.pinRecentTab("user-1", "narrator:d", true));
		await expectReplay(() =>
			recentTabs.moveRecentTab("user-1", { key: `folder:${folderId}`, position: "top" }),
		);
		await expectReplay(() =>
			recentTabs.moveRecentTab("user-1", {
				key: "narrator:b",
				folderId: null,
				afterKey: "narrator:c",
			}),
		);
		await expectReplay(() => recentTabs.dissolveRecentTabFolder("user-1", folderId));
		const second = await recentTabs.createRecentTabFolder("user-1", {
			targetKey: "narrator:a",
			sourceKey: "narrator:c",
			title: "G",
		});
		await expectReplay(() =>
			recentTabs.removeRecentTab("user-1", "folder", second.folderId ?? "", { storeUndo: true }),
		);
	});
});

/**
 * The sidebar renders a drop OPTIMISTICALLY with the client mirror while the server call
 * is in flight. If the mirror lands anywhere else, the list visibly jumps when the
 * response arrives — so each server move is checked against the mirror's prediction.
 */
describe("recent-tabs optimistic moves match the server", () => {
	const work = async () =>
		(await recentTabs.listAllRecentTabs("user-1")).filter((tab) => tab.type !== "project");
	const shape = (tabs: PersistedRecentTab[]) =>
		tabs.map((tab) => [`${tab.type}:${tab.id}`, tab.folderId ?? null, !!tab.pinned]);

	async function expectParity(
		key: string,
		target: Parameters<typeof applyRecentTabMove>[2],
	): Promise<void> {
		const before = await work();
		const predicted = applyRecentTabMove(before, key, target);
		await recentTabs.moveRecentTab("user-1", { key, ...target });
		expect(shape(predicted)).toEqual(shape(await work()));
	}

	async function seedFolder(pinnedFolder = false) {
		seedLegacyTabs([
			makeTab("x"),
			makeTab("f", { type: "folder", title: "F", ...(pinnedFolder ? { pinned: true } : {}) }),
			makeTab("m1", { folderId: "f", pinned: true }),
			makeTab("m2", { folderId: "f" }),
			makeTab("m3", { folderId: "f" }),
			makeTab("y"),
			makeTab("g", { type: "folder", title: "G" }),
			makeTab("g1", { folderId: "g" }),
		]);
		await recentTabs.ensureMigrated("user-1");
	}

	it("joins a folder at its end and next to a pinned member", async () => {
		await seedFolder();
		await expectParity("narrator:x", { folderId: "f" });
		await expectParity("narrator:y", { beforeKey: "narrator:m1", folderId: "f" });
	});

	it("leaves a folder next to a loose tab, and with no anchor", async () => {
		await seedFolder();
		await expectParity("narrator:m2", { afterKey: "narrator:y", folderId: null });
		await expectParity("narrator:m3", { folderId: null });
	});

	it("leaves a pinned folder without an anchor", async () => {
		await seedFolder(true);
		await expectParity("narrator:m2", { folderId: null });
	});

	it("moves the last member out, removing its folder", async () => {
		await seedFolder();
		await expectParity("narrator:g1", { beforeKey: "narrator:x", folderId: null });
	});

	it("moves a member into another folder", async () => {
		await seedFolder();
		await expectParity("narrator:m3", { afterKey: "narrator:g1", folderId: "g" });
	});

	it("moves a folder past another folder and next to a member of it", async () => {
		await seedFolder();
		await expectParity("folder:f", { afterKey: "folder:g" });
		await expectParity("folder:g", { beforeKey: "narrator:m2" });
	});

	it("reorders inside a folder and moves a member to the folder top", async () => {
		await seedFolder();
		await expectParity("narrator:m3", { beforeKey: "narrator:m2" });
		await expectParity("narrator:m2", { position: "top" });
	});
});
