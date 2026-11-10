import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { PersistedRecentTab } from "@shared/recent-tabs";
import { RECENT_TABS_STORAGE_LIMIT } from "@shared/recent-tabs";
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

const service = await import("../recent-tabs-service");
const {
	clearRecentTabs,
	createRecentTabFolder,
	dissolveRecentTabFolder,
	listAllRecentTabs,
	moveRecentTab,
	pinRecentTab,
	removeRecentTab,
	restoreRecentTabs,
	updateRecentTabFolder,
	upsertRecentTab,
} = service;

const USER = "folder-user";
const NOW = "2026-07-19T00:00:00.000Z";

function seedUser(): void {
	db.insert(users)
		.values({ id: USER, username: USER, passwordHash: "x", role: "user", createdAt: NOW })
		.run();
	db.insert(userPreferences)
		.values({ id: "pref", userId: USER, recentTabs: "[]", createdAt: NOW, updatedAt: NOW })
		.run();
}

function seedNarrator(id: string, status = "idle"): void {
	db.insert(narrators)
		.values({
			id,
			title: id,
			status,
			createdAt: NOW,
			updatedAt: NOW,
		} as typeof narrators.$inferInsert)
		.run();
}

async function addNarratorTabs(...ids: string[]): Promise<void> {
	// Each new tab lands at the top of the unpinned section, so add in reverse to read
	// top-down in argument order.
	for (const id of [...ids].reverse()) {
		await upsertRecentTab(USER, { type: "narrator", id, title: id, lastVisitedAt: 1 });
	}
}

/** Compact view: "id", "id>folder", "*id" for pinned, "[folder:title]" for a folder. */
async function layout(): Promise<string[]> {
	const tabs = await listAllRecentTabs(USER);
	return tabs.map((tab: PersistedRecentTab) => {
		const pin = tab.pinned ? "*" : "";
		if (tab.type === "folder") return `${pin}[${tab.id}:${tab.title}]`;
		return `${pin}${tab.id}${tab.folderId ? `>${tab.folderId}` : ""}`;
	});
}

async function makeFolder(target: string, source: string, title = "F"): Promise<string> {
	const result = await createRecentTabFolder(USER, {
		targetKey: `narrator:${target}`,
		sourceKey: `narrator:${source}`,
		title,
	});
	if (!result.folderId) throw new Error("folder not created");
	return result.folderId;
}

beforeEach(() => {
	seedUser();
});

afterEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

describe("creating a folder", () => {
	it("takes the target's slot with members [target, source]", async () => {
		await addNarratorTabs("a", "b", "c", "d");
		const folder = await makeFolder("b", "d", "Work");
		expect(await layout()).toEqual(["a", `[${folder}:Work]`, `b>${folder}`, `d>${folder}`, "c"]);
	});

	it("inherits the target's pinned state and clears the members' pins", async () => {
		await addNarratorTabs("a", "b");
		await pinRecentTab(USER, "narrator:a", true);
		await pinRecentTab(USER, "narrator:b", true);
		const folder = await makeFolder("a", "b");
		expect(await layout()).toEqual([`*[${folder}:F]`, `a>${folder}`, `b>${folder}`]);
	});

	it("refuses a target that is already in a folder", async () => {
		await addNarratorTabs("a", "b", "c");
		await makeFolder("a", "b");
		await expect(
			createRecentTabFolder(USER, { targetKey: "narrator:a", sourceKey: "narrator:c", title: "X" }),
		).rejects.toThrow();
	});

	it("a generic upsert can neither create a folder nor change membership", async () => {
		await addNarratorTabs("a", "b");
		await upsertRecentTab(USER, { type: "folder", id: "fake", title: "Fake", lastVisitedAt: 1 });
		const folder = await makeFolder("a", "b");
		// Revisit with a foreign folderId: membership must stay as stored.
		await upsertRecentTab(USER, {
			type: "narrator",
			id: "a",
			title: "a2",
			lastVisitedAt: 2,
			folderId: "elsewhere",
		});
		expect(await layout()).toEqual([`[${folder}:F]`, `a>${folder}`, `b>${folder}`]);
	});
});

describe("moving into, within and out of a folder", () => {
	it("joins a folder at its end, or next to a member anchor", async () => {
		await addNarratorTabs("a", "b", "c", "d");
		const folder = await makeFolder("a", "b");
		await moveRecentTab(USER, { key: "narrator:c", folderId: folder });
		expect(await layout()).toEqual([
			`[${folder}:F]`,
			`a>${folder}`,
			`b>${folder}`,
			`c>${folder}`,
			"d",
		]);
		await moveRecentTab(USER, { key: "narrator:d", folderId: folder, beforeKey: "narrator:b" });
		expect(await layout()).toEqual([
			`[${folder}:F]`,
			`a>${folder}`,
			`d>${folder}`,
			`b>${folder}`,
			`c>${folder}`,
		]);
	});

	it("reorders members without leaving the folder", async () => {
		await addNarratorTabs("a", "b", "c");
		const folder = await makeFolder("a", "b");
		await moveRecentTab(USER, { key: "narrator:c", folderId: folder });
		await moveRecentTab(USER, { key: "narrator:c", beforeKey: "narrator:a" });
		expect(await layout()).toEqual([`[${folder}:F]`, `c>${folder}`, `a>${folder}`, `b>${folder}`]);
	});

	it("leaves to the top level next to an anchor, and an emptied folder disappears", async () => {
		await addNarratorTabs("a", "b", "x");
		const folder = await makeFolder("a", "b");
		await moveRecentTab(USER, { key: "narrator:a", folderId: null, afterKey: "narrator:x" });
		expect(await layout()).toEqual([`[${folder}:F]`, `b>${folder}`, "x", "a"]);
		await moveRecentTab(USER, { key: "narrator:b", folderId: null, beforeKey: "narrator:x" });
		expect(await layout()).toEqual(["b", "x", "a"]);
	});

	it("a top-level anchor next to a folder member lands outside the folder", async () => {
		await addNarratorTabs("a", "b", "x");
		const folder = await makeFolder("a", "b");
		await moveRecentTab(USER, { key: "narrator:x", beforeKey: "narrator:b" });
		expect(await layout()).toEqual(["x", `[${folder}:F]`, `a>${folder}`, `b>${folder}`]);
	});

	it("moves a folder as one unit", async () => {
		await addNarratorTabs("a", "b", "x");
		const folder = await makeFolder("a", "b");
		await moveRecentTab(USER, { key: `folder:${folder}`, afterKey: "narrator:x" });
		expect(await layout()).toEqual(["x", `[${folder}:F]`, `a>${folder}`, `b>${folder}`]);
	});
});

describe("pinning inside a folder", () => {
	it("pins a member to the top of its folder, separately from top-level pins", async () => {
		await addNarratorTabs("a", "b", "c");
		const folder = await makeFolder("a", "b");
		await moveRecentTab(USER, { key: "narrator:c", folderId: folder });
		await pinRecentTab(USER, "narrator:c", true);
		expect(await layout()).toEqual([`[${folder}:F]`, `*c>${folder}`, `a>${folder}`, `b>${folder}`]);
		await pinRecentTab(USER, "narrator:c", false);
		expect(await layout()).toEqual([`[${folder}:F]`, `c>${folder}`, `a>${folder}`, `b>${folder}`]);
	});

	it("leaving the folder drops an in-folder pin", async () => {
		await addNarratorTabs("a", "b");
		const folder = await makeFolder("a", "b");
		await pinRecentTab(USER, "narrator:b", true);
		await moveRecentTab(USER, { key: "narrator:b", folderId: null, position: "top" });
		expect(await layout()).toEqual(["b", `[${folder}:F]`, `a>${folder}`]);
	});
});

describe("above_idle promotion", () => {
	it("moves the member first among unpinned members and the folder above idle units", async () => {
		for (const id of ["idle1", "a", "b", "c"]) seedNarrator(id);
		await addNarratorTabs("idle1", "a", "b", "c");
		const folder = await makeFolder("a", "b");
		await moveRecentTab(USER, { key: "narrator:c", folderId: folder });
		await pinRecentTab(USER, "narrator:a", true);
		// a is pinned in the folder; c starts working.
		db.update(narrators).set({ status: "working" }).where(eq(narrators.id, "c")).run();
		await moveRecentTab(USER, { key: "narrator:c", position: "above_idle" });
		expect(await layout()).toEqual([
			`[${folder}:F]`,
			`*a>${folder}`,
			`c>${folder}`,
			`b>${folder}`,
			"idle1",
		]);
	});
});

describe("folder metadata and dissolving", () => {
	it("updates title, icon, colour and preview count; null clears", async () => {
		await addNarratorTabs("a", "b");
		const folder = await makeFolder("a", "b");
		await updateRecentTabFolder(USER, folder, {
			title: "  Renamed  ",
			icon: "rocket",
			color: "teal",
			previewCount: 1,
		});
		let [header] = await listAllRecentTabs(USER);
		expect(header).toMatchObject({
			title: "Renamed",
			folderIcon: "rocket",
			folderColor: "teal",
			folderPreviewCount: 1,
		});
		await updateRecentTabFolder(USER, folder, { icon: null, previewCount: null });
		[header] = await listAllRecentTabs(USER);
		expect(header.folderIcon).toBeUndefined();
		expect(header.folderPreviewCount).toBeUndefined();
		expect(header.folderColor).toBe("teal");
	});

	it("dissolve keeps the members in order at the folder's position", async () => {
		await addNarratorTabs("x", "a", "b", "y");
		const folder = await makeFolder("a", "b");
		await pinRecentTab(USER, "narrator:b", true);
		await dissolveRecentTabFolder(USER, folder);
		expect(await layout()).toEqual(["x", "b", "a", "y"]);
	});

	it("closing a folder closes its members, and undo brings both back", async () => {
		await addNarratorTabs("a", "b", "x");
		const folder = await makeFolder("a", "b");
		const removed = await removeRecentTab(USER, "folder", folder, { storeUndo: true });
		expect(removed.removedCount).toBe(3);
		expect(await layout()).toEqual(["x"]);
		await restoreRecentTabs(USER, { token: removed.undoToken });
		expect(await layout()).toEqual([`[${folder}:F]`, `a>${folder}`, `b>${folder}`, "x"]);
	});

	it("closing the last member removes the folder, and undo restores it", async () => {
		await addNarratorTabs("a", "b");
		const folder = await makeFolder("a", "b");
		await removeRecentTab(USER, "narrator", "a");
		const removed = await removeRecentTab(USER, "narrator", "b", { storeUndo: true });
		expect(await layout()).toEqual([]);
		await restoreRecentTabs(USER, { token: removed.undoToken });
		expect(await layout()).toEqual([`[${folder}:F]`, `b>${folder}`]);
	});
	it("keepEmptyFolder leaves the folder behind when its last member goes", async () => {
		// 归档走这条路径：会话还能撤销归档回来，文件夹不该跟着最后一条记录消失。
		await addNarratorTabs("a", "b");
		const folder = await makeFolder("a", "b");
		await removeRecentTab(USER, "narrator", "a", { keepEmptyFolder: true });
		await removeRecentTab(USER, "narrator", "b", { keepEmptyFolder: true });
		expect(await layout()).toEqual([`[${folder}:F]`]);
	});
});

describe("bulk clear and the storage limit", () => {
	it("clearing inactive tabs keeps folders whole", async () => {
		for (const id of ["a", "b", "loose"]) seedNarrator(id);
		await addNarratorTabs("a", "b", "loose");
		const folder = await makeFolder("a", "b");
		await clearRecentTabs(USER, "inactive_narrators");
		expect(await layout()).toEqual([`[${folder}:F]`, `a>${folder}`, `b>${folder}`]);
	});

	it("trimming at the storage limit takes the folder's oldest member, keeping the folder", async () => {
		await addNarratorTabs("a", "b");
		const folder = await makeFolder("a", "b");
		// Folder at the bottom, then fill the list to the limit with new tabs on top.
		const filler = Array.from({ length: RECENT_TABS_STORAGE_LIMIT - 3 }, (_, index) => `n${index}`);
		await service.upsertRecentTabsBatch(
			USER,
			filler
				.slice(0, 100)
				.map((id) => ({ type: "narrator" as const, id, title: id, lastVisitedAt: 1 })),
		);
		for (let start = 100; start < filler.length; start += 100) {
			await service.upsertRecentTabsBatch(
				USER,
				filler
					.slice(start, start + 100)
					.map((id) => ({ type: "narrator" as const, id, title: id, lastVisitedAt: 1 })),
			);
		}
		expect((await listAllRecentTabs(USER)).length).toBe(RECENT_TABS_STORAGE_LIMIT);
		await upsertRecentTab(USER, { type: "narrator", id: "overflow", title: "o", lastVisitedAt: 1 });
		const tabs = await listAllRecentTabs(USER);
		expect(tabs.length).toBeLessThanOrEqual(RECENT_TABS_STORAGE_LIMIT);
		const folderRows = tabs.filter((tab) => tab.id === folder || tab.folderId === folder);
		// Both members were visited at the same time; the lower one goes.
		expect(folderRows.map((tab) => tab.id)).toEqual([folder, "a"]);
	});
});

describe("one-time conversion of legacy workspace groups", () => {
	function seedLegacy(): void {
		db.insert(userRecentTabsMeta)
			.values({ userId: USER, revision: 3, migratedAt: NOW, createdAt: NOW, updatedAt: NOW })
			.run();
		const row = (
			tabKey: string,
			type: "workspace" | "narrator",
			entityId: string,
			sortOrder: number,
			workspaceId?: string,
		) => ({
			id: `row-${entityId}`,
			userId: USER,
			tabKey,
			section: "work" as const,
			type,
			entityId,
			representedNarratorId: type === "narrator" ? entityId : null,
			workspaceId: workspaceId ?? null,
			title: entityId,
			lastVisitedAt: 1,
			sortOrder,
			createdAt: NOW,
			updatedAt: NOW,
		});
		db.insert(userRecentTabs)
			.values([
				row("narrator:top", "narrator", "top", 0),
				row("workspace:ws", "workspace", "ws", 1),
				row("narrator:m1", "narrator", "m1", 2, "ws"),
				row("narrator:m2", "narrator", "m2", 3, "ws"),
				// A child whose header is gone goes back to the top level.
				row("narrator:orphan", "narrator", "orphan", 4, "gone"),
			])
			.run();
	}

	it("turns the header into a same-id folder and the children into members, once", async () => {
		seedLegacy();
		expect(await layout()).toEqual(["top", "[ws:ws]", "m1>ws", "m2>ws", "orphan"]);
		const meta = db
			.select()
			.from(userRecentTabsMeta)
			.where(eq(userRecentTabsMeta.userId, USER))
			.get();
		expect(meta?.foldersMigrated).toBe(true);
		expect(meta?.revision).toBe(4);
		// Dissolving afterwards must not be undone by a re-run of the conversion.
		await dissolveRecentTabFolder(USER, "ws");
		expect(await layout()).toEqual(["top", "m1", "m2", "orphan"]);
	});

	it("a user with nothing to convert is still marked as converted", async () => {
		db.insert(userRecentTabsMeta)
			.values({ userId: USER, revision: 3, migratedAt: NOW, createdAt: NOW, updatedAt: NOW })
			.run();
		expect(await layout()).toEqual([]);
		const meta = db
			.select()
			.from(userRecentTabsMeta)
			.where(eq(userRecentTabsMeta.userId, USER))
			.get();
		expect(meta?.foldersMigrated).toBe(true);
		expect(meta?.revision).toBe(3);
	});

	it("converts workspace groups found in the legacy JSON array", async () => {
		db.update(userPreferences)
			.set({
				recentTabs: JSON.stringify([
					{ type: "workspace", id: "ws", title: "Legacy", lastVisitedAt: 1 },
					{ type: "narrator", id: "m1", title: "m1", lastVisitedAt: 1, workspaceId: "ws" },
				]),
			})
			.run();
		expect(await layout()).toEqual(["[ws:Legacy]", "m1>ws"]);
	});
});

describe("review regressions", () => {
	it("an upsert whose anchor vanished keeps its metadata update", async () => {
		await addNarratorTabs("a", "b");
		await upsertRecentTab(
			USER,
			{ type: "narrator", id: "b", title: "renamed", lastVisitedAt: 2 },
			{ beforeKey: "narrator:gone" },
		);
		const tabs = await listAllRecentTabs(USER);
		expect(tabs.map((tab) => [tab.id, tab.title])).toEqual([
			["a", "a"],
			["b", "renamed"],
		]);
	});

	it("a member starting work does not move its pinned folder", async () => {
		for (const id of ["x", "a", "b"]) seedNarrator(id);
		await addNarratorTabs("x", "a", "b");
		const folder = await makeFolder("a", "b");
		await pinRecentTab(USER, `folder:${folder}`, true);
		await pinRecentTab(USER, "narrator:x", true);
		// x is pinned after the folder; b starts working.
		db.update(narrators).set({ status: "working" }).where(eq(narrators.id, "b")).run();
		await moveRecentTab(USER, { key: "narrator:b", position: "above_idle" });
		expect(await layout()).toEqual([`*[${folder}:F]`, `b>${folder}`, `a>${folder}`, "*x"]);
	});

	it("a blank legacy workspace title converts to a usable folder title", async () => {
		db.update(userPreferences)
			.set({
				recentTabs: JSON.stringify([
					{ type: "workspace", id: "ws", title: "  ", lastVisitedAt: 1 },
					{ type: "narrator", id: "m1", title: "m1", lastVisitedAt: 1, workspaceId: "ws" },
				]),
			})
			.run();
		expect(await layout()).toEqual(["[ws:Workspace]", "m1>ws"]);
	});
});
