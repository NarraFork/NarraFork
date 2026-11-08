/**
 * 撤销归档时回到原来的侧栏文件夹。
 *
 * 归档会删掉侧栏那一行，`folder_id` 也一起没了；这里验证的是「删之前记住位置、恢复时放回去」
 * 这条路径，以及文件夹已经不在时不再硬塞。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narrators,
	recentTabArchiveMarks,
	userPreferences,
	userRecentTabs,
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

const {
	listAllRecentTabs,
	rememberArchivedTabPlacement,
	removeRecentTab,
	restoreArchivedTabPlacement,
} = await import("../recent-tabs-service");

const USER = "archive-user";
const NOW = "2026-07-19T00:00:00.000Z";

function seedUser(): void {
	db.insert(users)
		.values({ id: USER, username: USER, passwordHash: "x", role: "user", createdAt: NOW })
		.run();
	db.insert(userPreferences)
		.values({ id: "pref", userId: USER, recentTabs: "[]", createdAt: NOW, updatedAt: NOW })
		.run();
}

function seedNarrator(id: string): void {
	db.insert(narrators)
		.values({ id, title: id, status: "idle", createdAt: NOW, updatedAt: NOW })
		.run();
}

function seedFolderRow(folderId: string, order: number): void {
	db.insert(userRecentTabs)
		.values({
			id: `row-${folderId}`,
			userId: USER,
			tabKey: `folder:${folderId}`,
			section: "work",
			type: "folder",
			entityId: folderId,
			title: folderId,
			lastVisitedAt: 1,
			sortOrder: order,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

function seedNarratorRow(narratorId: string, order: number, folderId?: string): void {
	db.insert(userRecentTabs)
		.values({
			id: `row-${narratorId}`,
			userId: USER,
			tabKey: `narrator:${narratorId}`,
			section: "work",
			type: "narrator",
			entityId: narratorId,
			narratorId,
			representedNarratorId: narratorId,
			title: narratorId,
			lastVisitedAt: 1,
			sortOrder: order,
			createdAt: NOW,
			updatedAt: NOW,
			...(folderId ? { folderId } : {}),
		})
		.run();
}

async function folderOfRow(narratorId: string): Promise<string | null> {
	const tabs = await listAllRecentTabs(USER);
	return tabs.find((tab) => tab.type === "narrator" && tab.id === narratorId)?.folderId ?? null;
}

function marks(): Array<{ folderId: string | null }> {
	return db.select({ folderId: recentTabArchiveMarks.folderId }).from(recentTabArchiveMarks).all();
}

beforeEach(() => {
	cleanDb(sqlite);
	seedUser();
});

afterEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

describe("archived tab placement", () => {
	it("restores the session into the folder it was archived from", async () => {
		seedNarrator("child");
		seedNarrator("sibling");
		seedFolderRow("work-folder", 0);
		seedNarratorRow("child", 1, "work-folder");
		// 文件夹里还有别的会话，所以归档其中一个不会把文件夹本身带走。
		seedNarratorRow("sibling", 2, "work-folder");

		await rememberArchivedTabPlacement(USER, "child");
		expect(marks()).toEqual([{ folderId: "work-folder" }]);

		// 归档删掉那一行。
		await removeRecentTab(USER, "narrator", "child");
		expect(await folderOfRow("child")).toBeNull();

		expect(await restoreArchivedTabPlacement(USER, "child", "child")).toBe(true);
		expect(await folderOfRow("child")).toBe("work-folder");
		// 位置只用于这一次恢复。
		expect(marks()).toEqual([]);
	});

	it("leaves the session at the top level when the folder is gone", async () => {
		seedNarrator("child");
		seedFolderRow("work-folder", 0);
		seedNarratorRow("child", 1, "work-folder");
		await rememberArchivedTabPlacement(USER, "child");
		await removeRecentTab(USER, "narrator", "child");
		// 文件夹在会话归档期间被删掉。
		db.delete(userRecentTabs)
			.where(and(eq(userRecentTabs.userId, USER), eq(userRecentTabs.entityId, "work-folder")))
			.run();

		expect(await restoreArchivedTabPlacement(USER, "child", "child")).toBe(false);
		expect(await folderOfRow("child")).toBeNull();
		expect(marks()).toEqual([]);
	});

	it("remembers nothing for a session that sat at the top level", async () => {
		seedNarrator("loose");
		seedNarratorRow("loose", 0);

		await rememberArchivedTabPlacement(USER, "loose");
		expect(marks()).toEqual([]);

		await removeRecentTab(USER, "narrator", "loose");
		expect(await restoreArchivedTabPlacement(USER, "loose", "loose")).toBe(false);
	});

	it("overwrites the remembered folder when the session is archived again from elsewhere", async () => {
		seedNarrator("child");
		seedNarrator("sibling");
		seedNarrator("other");
		seedFolderRow("first-folder", 0);
		seedNarratorRow("sibling", 1, "first-folder");
		seedNarratorRow("child", 2, "first-folder");
		seedFolderRow("second-folder", 4);
		// 两个文件夹都还有别的成员，归档不会把它们带走。
		seedNarratorRow("other", 5, "second-folder");
		await rememberArchivedTabPlacement(USER, "child");

		// 用户把它挪到另一个文件夹后再次归档。
		db.update(userRecentTabs)
			.set({ folderId: "second-folder" })
			.where(and(eq(userRecentTabs.userId, USER), eq(userRecentTabs.entityId, "child")))
			.run();
		await rememberArchivedTabPlacement(USER, "child");
		expect(marks()).toEqual([{ folderId: "second-folder" }]);

		await removeRecentTab(USER, "narrator", "child");
		await restoreArchivedTabPlacement(USER, "child", "child");
		expect(await folderOfRow("child")).toBe("second-folder");
	});
});
