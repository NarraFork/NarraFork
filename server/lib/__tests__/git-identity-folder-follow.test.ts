// 会话没有自己的 git 身份时跟谁：先看它所在的侧栏文件夹，再回落到全局默认。
// 选择器要显示"跟随文件夹设置"，靠的就是这两步解析的顺序。
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	folderGitIdentityBindings,
	userGitIdentities,
	userRecentTabs,
	users,
} from "../../db/schema";
import { generateId } from "../id";

const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite }));

const { getNarratorFolderIdForUser } = await import("../git-identity");
const { getFolderGitIdentityPick } = await import("../../services/git-identities");

const NOW = "2026-11-10T00:00:00.000Z";
const USER = "user-a";
const FOLDER = "folder-1";
const IDENTITY = "identity-folder";

function seed(): void {
	db.insert(users)
		.values({ id: USER, username: USER, passwordHash: "hash", role: "user", createdAt: NOW })
		.run();
	db.insert(userGitIdentities)
		.values({
			id: IDENTITY,
			userId: USER,
			name: "Folder",
			email: "folder@example.com",
			isDefault: false,
			createdAt: NOW,
		})
		.run();
	// 文件夹自身也要有一条侧栏记录，服务端按"属于本人"校验。
	insertTab({ key: `folder:${FOLDER}`, type: "folder", entityId: FOLDER, sortOrder: 0 });
}

function insertTab(input: {
	key: string;
	type: "folder" | "narrator";
	entityId: string;
	folderId?: string;
	sortOrder: number;
}): void {
	db.insert(userRecentTabs)
		.values({
			id: generateId(),
			userId: USER,
			tabKey: input.key,
			section: "work",
			type: input.type,
			entityId: input.entityId,
			title: input.entityId,
			lastVisitedAt: 1,
			createdAt: NOW,
			updatedAt: NOW,
			...(input.type === "narrator" ? { representedNarratorId: input.entityId } : {}),
			...(input.folderId ? { folderId: input.folderId } : {}),
			sortOrder: input.sortOrder,
		})
		.run();
}

describe("会话的 git 身份跟随文件夹", () => {
	beforeEach(() => {
		cleanDb(sqlite);
		seed();
	});

	afterEach(() => {
		cleanDb(sqlite);
	});

	it("会话在文件夹里且文件夹设过身份：解析到该文件夹与它的身份", async () => {
		insertTab({ key: "narrator:in-folder", type: "narrator", entityId: "in-folder", folderId: FOLDER, sortOrder: 1 });
		db.insert(folderGitIdentityBindings)
			.values({ id: generateId(), folderId: FOLDER, userId: USER, identityId: IDENTITY, updatedAt: NOW })
			.run();

		expect(await getNarratorFolderIdForUser("in-folder", USER)).toBe(FOLDER);
		expect(await getFolderGitIdentityPick(USER, FOLDER)).toBe(IDENTITY);
	});

	it("会话不在任何文件夹：没有可跟随的文件夹", async () => {
		insertTab({ key: "narrator:loose", type: "narrator", entityId: "loose", sortOrder: 1 });

		expect(await getNarratorFolderIdForUser("loose", USER)).toBeNull();
	});

	it("文件夹存在但没设身份：回落到全局默认", async () => {
		insertTab({ key: "narrator:bare", type: "narrator", entityId: "bare", folderId: FOLDER, sortOrder: 1 });

		expect(await getNarratorFolderIdForUser("bare", USER)).toBe(FOLDER);
		expect(await getFolderGitIdentityPick(USER, FOLDER)).toBeNull();
	});
});
