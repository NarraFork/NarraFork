// 提交身份入口的显示偏好必须按账号隔离：这是「跟账号走」的唯一意义所在。
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { userPreferences, users } from "../../db/schema";

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

	afterAll(() => {
		mock.module("../../db", () => realDbModule);
		mock.restore();
	});

	it("没有偏好行时两个入口默认关闭", async () => {
		const prefs = await getPrefs();
		expect(prefs.gitIdentityContextMenu).toBe(false);
		expect(prefs.gitIdentityCreateModal).toBe(false);
	});

	it("只改一个开关时另一个保持不变", async () => {
		await patchPrefs({ gitIdentityContextMenu: true });
		expect(await getPrefs()).toMatchObject({
			gitIdentityContextMenu: true,
			gitIdentityCreateModal: false,
		});

		await patchPrefs({ gitIdentityCreateModal: true });
		expect(await getPrefs()).toMatchObject({
			gitIdentityContextMenu: true,
			gitIdentityCreateModal: true,
		});

		await patchPrefs({ gitIdentityContextMenu: false });
		expect(await getPrefs()).toMatchObject({
			gitIdentityContextMenu: false,
			gitIdentityCreateModal: true,
		});
	});

	it("每个账号各存一份，互不影响", async () => {
		await patchPrefs({ gitIdentityContextMenu: true });

		actingUserId = "user-b";
		expect(await getPrefs()).toMatchObject({
			gitIdentityContextMenu: false,
			gitIdentityCreateModal: false,
		});
		await patchPrefs({ gitIdentityCreateModal: true });

		actingUserId = "user-a";
		expect(await getPrefs()).toMatchObject({
			gitIdentityContextMenu: true,
			gitIdentityCreateModal: false,
		});

		const rows = db.select().from(userPreferences).all();
		expect(rows).toHaveLength(2);
	});
});
