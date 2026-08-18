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

function seedLegacyTabs(tabs: PersistedRecentTab[], userId = "user-1"): void {
	seedUser(userId);
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

	it("supports updateOnly workspace membership release with workspaceId null", async () => {
		seedLegacyTabs([
			makeTab("ws-1", { type: "workspace" }),
			makeTab("child-1", { workspaceId: "ws-1" }),
		]);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.upsertRecentTab("user-1", makeTab("child-1", { workspaceId: null }), {
			updateOnly: true,
		});
		const child = db
			.select({ workspaceId: userRecentTabs.workspaceId })
			.from(userRecentTabs)
			.where(eq(userRecentTabs.tabKey, "narrator:child-1"))
			.get();
		expect(child?.workspaceId).toBeNull();
	});

	it("uses narrator/entity membership indexes for title sync and all-user removal", async () => {
		seedLegacyTabs([
			makeTab("n-title", { title: "Old title" }),
			makeTab("project-1", { type: "project" }),
		]);
		seedLegacyTabs(
			[
				makeTab("chapter-1", {
					type: "chapter",
					narratorId: "n-title",
					title: "Old chapter title",
				}),
				makeTab("project-1", { type: "project" }),
			],
			"user-2",
		);
		expect((await recentTabs.getRecentTabUserIdsForNarrator("n-title")).sort()).toEqual([
			"user-1",
			"user-2",
		]);
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

	it("atomically batch-upserts a workspace header and children with one revision", async () => {
		seedLegacyTabs([]);
		const result = await recentTabs.upsertRecentTabsBatch("user-1", [
			makeTab("child-1", { workspaceId: "ws-batch" }),
			makeTab("ws-batch", { type: "workspace", title: "Batch workspace" }),
		]);

		expect(result).toMatchObject({ changed: true, baseRevision: 0, revision: 1 });
		expect(storedKeys()).toEqual(["workspace:ws-batch", "narrator:child-1"]);
		expect(
			db
				.select({ workspaceId: userRecentTabs.workspaceId })
				.from(userRecentTabs)
				.where(eq(userRecentTabs.tabKey, "narrator:child-1"))
				.get()?.workspaceId,
		).toBe("ws-batch");
		expect(db.select().from(userRecentTabsMeta).get()?.revision).toBe(1);
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

describe("recent-tabs pagination and workspace groups", () => {
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

	it("does not split a workspace group at a page boundary", async () => {
		const tabs = Array.from({ length: 49 }, (_, index) => makeTab(`n-${index}`));
		tabs.push(makeTab("ws-1", { type: "workspace", title: "Workspace" }));
		for (let index = 0; index < 5; index++) {
			tabs.push(makeTab(`child-${index}`, { workspaceId: "ws-1" }));
		}
		tabs.push(makeTab("n-last"));
		seedLegacyTabs(tabs);

		const first = await recentTabs.listPage("user-1", "work", undefined, 50);
		expect(first.items).toHaveLength(55);
		expect(first.items.slice(-6).map((tab) => `${tab.type}:${tab.id}`)).toEqual([
			"workspace:ws-1",
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

	it("evicts a workspace atomically at the 500-row boundary", async () => {
		const tabs = Array.from({ length: 498 }, (_, index) => makeTab(`n-${index}`));
		tabs.push(makeTab("ws-old", { type: "workspace", title: "Old workspace" }));
		tabs.push(makeTab("ws-child", { workspaceId: "ws-old" }));
		seedLegacyTabs(tabs);
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.upsertRecentTab("user-1", makeTab("n-new"));
		const keys = storedKeys();
		expect(keys).toHaveLength(RECENT_TABS_STORAGE_LIMIT - 1);
		expect(keys).toContain("narrator:n-new");
		expect(keys).not.toContain("workspace:ws-old");
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

	it("rejects an undo token after another mutation advances revision", async () => {
		seedLegacyTabs([makeTab("n-1"), makeTab("n-2")]);
		const cleared = await recentTabs.clearRecentTabs("user-1", "all");
		await recentTabs.upsertRecentTab("user-1", makeTab("n-new"));

		await expect(
			recentTabs.restoreRecentTabs("user-1", { token: cleared.undoToken }),
		).rejects.toMatchObject({ statusCode: 409, code: "RECENT_TABS_UNDO_CONFLICT" });
		expect(storedKeys()).toEqual(["narrator:n-new"]);
	});

	it("defers inactive workspace deletion until undo expiry and cancels it on restore", async () => {
		seedLegacyTabs([
			makeTab("ws-undo", { type: "workspace", title: "Undo workspace" }),
			makeTab("n-idle", { workspaceId: "ws-undo" }),
		]);
		db.insert(narrators)
			.values({
				id: "n-idle",
				type: "primary",
				inheritMode: "fresh",
				status: "idle",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.insert(workspaces)
			.values({
				id: "ws-undo",
				userId: "user-1",
				title: "Undo workspace",
				tree: "{}",
				createdAt: new Date(NOW),
				updatedAt: new Date(NOW),
			})
			.run();

		const cleared = await recentTabs.clearRecentTabs("user-1", "inactive_narrators");
		expect(db.select().from(workspaces).where(eq(workspaces.id, "ws-undo")).get()).toBeDefined();
		await recentTabs.restoreRecentTabs("user-1", { token: cleared.undoToken });
		await recentTabs.runExpiredRecentTabsWorkspaceCleanup(Date.now() + 31_000);
		expect(db.select().from(workspaces).where(eq(workspaces.id, "ws-undo")).get()).toBeDefined();
		expect(storedKeys()).toEqual(["workspace:ws-undo", "narrator:n-idle"]);
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

	it("keeps a pinned workspace group intact when clearing inactive narrators", async () => {
		seedLegacyTabs([
			makeTab("ws-pinned", { type: "workspace", title: "Pinned workspace", pinned: true }),
			makeTab("n-child", { workspaceId: "ws-pinned" }),
			makeTab("n-loose"),
		]);
		db.insert(narrators)
			.values({
				id: "n-child",
				type: "primary",
				inheritMode: "fresh",
				status: "idle",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.insert(workspaces)
			.values({
				id: "ws-pinned",
				userId: "user-1",
				title: "Pinned workspace",
				tree: "{}",
				createdAt: new Date(NOW),
				updatedAt: new Date(NOW),
			})
			.run();
		await recentTabs.ensureMigrated("user-1");

		await recentTabs.clearRecentTabs("user-1", "inactive_narrators");
		expect(storedKeys()).toEqual(["workspace:ws-pinned", "narrator:n-child"]);
		await recentTabs.runExpiredRecentTabsWorkspaceCleanup(Date.now() + 31_000);
		expect(db.select().from(workspaces).where(eq(workspaces.id, "ws-pinned")).get()).toBeDefined();
	});

	it("deletes an inactive workspace only after the undo TTL expires", async () => {
		seedLegacyTabs([
			makeTab("ws-expire", { type: "workspace", title: "Expire workspace" }),
			makeTab("n-expire", { workspaceId: "ws-expire" }),
		]);
		db.insert(narrators)
			.values({
				id: "n-expire",
				type: "primary",
				inheritMode: "fresh",
				status: "idle",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.insert(workspaces)
			.values({
				id: "ws-expire",
				userId: "user-1",
				title: "Expire workspace",
				tree: "{}",
				createdAt: new Date(NOW),
				updatedAt: new Date(NOW),
			})
			.run();

		await recentTabs.clearRecentTabs("user-1", "inactive_narrators");
		expect(db.select().from(workspaces).where(eq(workspaces.id, "ws-expire")).get()).toBeDefined();
		await recentTabs.runExpiredRecentTabsWorkspaceCleanup(Date.now() + 31_000);
		expect(
			db.select().from(workspaces).where(eq(workspaces.id, "ws-expire")).get(),
		).toBeUndefined();
	});
});
