// 提交身份入口的显示偏好必须按账号隔离：这是「跟账号走」的唯一意义所在。
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { userGitIdentities, userPreferences, userRecentTabs, users } from "../../db/schema";
import { generateId } from "../../lib/id";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { userPreferencesRoutes } = await import("../user-preferences");
const { buildAppErrorResponse } = await import("../../lib/app-error-response");

/** 每个请求切换当前用户，模拟两个账号各自设置。 */
let actingUserId = "user-a";
const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: actingUserId, role: "user", iat: 0, exp: 0 });
	await next();
});
app.route("/user-preferences", userPreferencesRoutes);
app.onError((err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: String(err) }, 500));

const NOW = "2026-10-29T00:00:00.000Z";

function seedUsers(): void {
	for (const id of ["user-a", "user-b"]) {
		db.insert(users)
			.values({ id, username: id, passwordHash: "hash", role: "user", createdAt: NOW })
			.run();
	}
}

async function getPrefs() {
	const response = await app.request("/user-preferences");
	expect(response.status).toBe(200);
	return (await response.json()) as Record<string, unknown>;
}

async function patchPrefs(body: Record<string, unknown>) {
	const response = await app.request("/user-preferences", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as Record<string, unknown>;
}

describe("git identity visibility preferences", () => {
	beforeEach(() => {
		cleanDb(sqlite);
		seedUsers();
		actingUserId = "user-a";
	});

	afterEach(() => {
		cleanDb(sqlite);
	});

	it("没有偏好行时三个入口默认关闭", async () => {
		const prefs = await getPrefs();
		expect(prefs.gitIdentityContextMenu).toBe(false);
		expect(prefs.gitIdentityCreateModal).toBe(false);
		expect(prefs.gitIdentityFolderContextMenu).toBe(false);
	});

	it("只改一个开关时另外两个保持不变", async () => {
		await patchPrefs({ gitIdentityContextMenu: true });
		expect(await getPrefs()).toMatchObject({
			gitIdentityContextMenu: true,
			gitIdentityCreateModal: false,
			gitIdentityFolderContextMenu: false,
		});

		await patchPrefs({ gitIdentityCreateModal: true });
		expect(await getPrefs()).toMatchObject({
			gitIdentityContextMenu: true,
			gitIdentityCreateModal: true,
			gitIdentityFolderContextMenu: false,
		});

		await patchPrefs({ gitIdentityFolderContextMenu: true });
		expect(await getPrefs()).toMatchObject({
			gitIdentityContextMenu: true,
			gitIdentityCreateModal: true,
			gitIdentityFolderContextMenu: true,
		});

		await patchPrefs({ gitIdentityContextMenu: false });
		expect(await getPrefs()).toMatchObject({
			gitIdentityContextMenu: false,
			gitIdentityCreateModal: true,
			gitIdentityFolderContextMenu: true,
		});
	});

	it("每个账号各存一份，互不影响", async () => {
		await patchPrefs({ gitIdentityContextMenu: true });

		actingUserId = "user-b";
		expect(await getPrefs()).toMatchObject({
			gitIdentityContextMenu: false,
			gitIdentityCreateModal: false,
			gitIdentityFolderContextMenu: false,
		});
		await patchPrefs({ gitIdentityCreateModal: true });

		actingUserId = "user-a";
		expect(await getPrefs()).toMatchObject({
			gitIdentityContextMenu: true,
			gitIdentityCreateModal: false,
			gitIdentityFolderContextMenu: false,
		});

		const rows = db.select().from(userPreferences).all();
		expect(rows).toHaveLength(2);
	});
});

describe("recent tabs directory visibility preferences", () => {
	beforeEach(() => {
		cleanDb(sqlite);
		seedUsers();
		actingUserId = "user-a";
	});

	afterEach(() => {
		cleanDb(sqlite);
	});

	it("没有偏好行及首次写入无关字段时默认关闭", async () => {
		expect((await getPrefs()).recentTabsShowDirectory).toBe(false);
		expect((await patchPrefs({ language: "en" })).recentTabsShowDirectory).toBe(false);
		expect((await getPrefs()).recentTabsShowDirectory).toBe(false);
	});

	it("首次写入 true、无关 PATCH 保留、显式 false 均持久化", async () => {
		expect((await patchPrefs({ recentTabsShowDirectory: true })).recentTabsShowDirectory).toBe(
			true,
		);
		expect((await getPrefs()).recentTabsShowDirectory).toBe(true);
		expect((await patchPrefs({ language: "zh-CN" })).recentTabsShowDirectory).toBe(true);
		expect((await getPrefs()).recentTabsShowDirectory).toBe(true);
		expect((await patchPrefs({ recentTabsShowDirectory: false })).recentTabsShowDirectory).toBe(
			false,
		);
		expect((await getPrefs()).recentTabsShowDirectory).toBe(false);
	});

	it("不同账号的开关互相隔离", async () => {
		await patchPrefs({ recentTabsShowDirectory: true });
		actingUserId = "user-b";
		expect((await getPrefs()).recentTabsShowDirectory).toBe(false);
		await patchPrefs({ recentTabsShowDirectory: false });
		actingUserId = "user-a";
		expect((await getPrefs()).recentTabsShowDirectory).toBe(true);
		expect(db.select().from(userPreferences).all()).toHaveLength(2);
	});

	it.each(
		["true", 1, null, [], {}].map((value) => ({ value })),
	)("拒绝非布尔值 %j 且保留原值", async ({ value }) => {
		await patchPrefs({ recentTabsShowDirectory: true });
		const response = await app.request("/user-preferences", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ recentTabsShowDirectory: value }),
		});
		expect(response.status).toBe(400);
		expect((await getPrefs()).recentTabsShowDirectory).toBe(true);
	});
});

describe("folder git identity endpoints", () => {
	beforeEach(() => {
		cleanDb(sqlite);
		seedUsers();
		actingUserId = "user-a";
	});

	afterEach(() => {
		cleanDb(sqlite);
	});

	function seedIdentity(userId: string, name: string): string {
		const id = generateId();
		db.insert(userGitIdentities)
			.values({ id, userId, name, email: `${name}@e.com`, isDefault: false, createdAt: NOW })
			.run();
		return id;
	}

	function seedFolder(userId: string, folderId: string): string {
		db.insert(userRecentTabs)
			.values({
				id: generateId(),
				userId,
				tabKey: `folder:${folderId}`,
				section: "work",
				type: "folder",
				entityId: folderId,
				title: "Work",
				lastVisitedAt: 0,
				sortOrder: 0,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		return folderId;
	}

	async function putFolderPick(folderId: string, identityId: string | null) {
		return app.request(`/user-preferences/git-identity/folders/${folderId}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ identityId }),
		});
	}

	async function getFolderPick(folderId: string) {
		const response = await app.request(`/user-preferences/git-identity/folders/${folderId}`);
		expect(response.status).toBe(200);
		return (await response.json()) as { identities: unknown[]; selectedId: string | null };
	}

	it("自己的文件夹可以设置自己的身份，并读回同一个值", async () => {
		const identityId = seedIdentity("user-a", "alice");
		const folderId = seedFolder("user-a", "folder-a");

		const put = await putFolderPick(folderId, identityId);
		if (put.status !== 200) throw new Error(`PUT failed: ${put.status} ${await put.text()}`);
		const body = await getFolderPick(folderId);
		expect(body.selectedId).toBe(identityId);
		expect(body.identities).toHaveLength(1);
	});

	it("别人读不到也改不了我的文件夹选择", async () => {
		const identityId = seedIdentity("user-a", "alice");
		const folderId = seedFolder("user-a", "folder-a");
		await putFolderPick(folderId, identityId);

		actingUserId = "user-b";
		expect((await app.request(`/user-preferences/git-identity/folders/${folderId}`)).status).toBe(
			404,
		);
		expect((await putFolderPick(folderId, identityId)).status).toBe(404);
	});

	it("不能把别人的身份绑到自己的文件夹上", async () => {
		const bobsIdentity = seedIdentity("user-b", "bob");
		const folderId = seedFolder("user-a", "folder-a");

		expect((await putFolderPick(folderId, bobsIdentity)).status).toBe(404);
		expect((await getFolderPick(folderId)).selectedId).toBeNull();
	});
});

// Restore the module mock only after every describe has run: restoring it at the end of one
// describe leaves the next one resolving against the real database.
afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});
