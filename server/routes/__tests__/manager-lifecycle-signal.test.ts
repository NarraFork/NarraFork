import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { users } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { createToken } from "../../lib/auth";
import {
	captureManagerTokenFromEnv,
	MANAGER_TOKEN_ENV,
	resetManagerTokenForTests,
} from "../../lib/manager-token";
import { registerOperatorShutdownHandler } from "../../lib/server-restart";
import { systemLifecycle } from "../../services/system-lifecycle-service";
import { managerLifecycleRoutes } from "../system-lifecycle";

const TOKEN = "manager-lifecycle-token";
const app = new Hono().route("/api/system/lifecycle", managerLifecycleRoutes);
app.onError((error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: String(error) }, 500));

let adminToken: string;
let memberToken: string;
const reasons: string[] = [];

beforeEach(async () => {
	cleanDb(sqlite);
	reasons.length = 0;
	resetManagerTokenForTests();
	process.env[MANAGER_TOKEN_ENV] = TOKEN;
	captureManagerTokenFromEnv();
	registerOperatorShutdownHandler(async ({ reason }) => {
		reasons.push(reason);
		return { success: true, reason, pid: 1, durationMs: 0 };
	});
	for (const role of ["admin", "user"] as const) {
		const id = `manager-lifecycle-${role}`;
		await db.insert(users).values({
			id,
			username: id,
			role,
			passwordHash: "unused",
			createdAt: new Date().toISOString(),
		});
		const session = await createToken(id);
		if (role === "admin") adminToken = session;
		else memberToken = session;
	}
});

afterEach(() => {
	registerOperatorShutdownHandler(null);
	resetManagerTokenForTests();
	delete process.env[MANAGER_TOKEN_ENV];
	cleanDb(sqlite);
});

function post(
	path: string,
	options?: { peerIp?: string; authorization?: string; forwardedFor?: string },
) {
	const headers: Record<string, string> = {};
	if (options?.authorization) headers.authorization = options.authorization;
	if (options?.forwardedFor) headers["x-forwarded-for"] = options.forwardedFor;
	return app.request(
		`/api/system/lifecycle/${path}`,
		{ method: "POST", headers },
		{ peerIp: options?.peerIp },
	);
}

describe("manager lifecycle signal", () => {
	test("回环加令牌走 Ctrl+C 的 signal，不走保留现场的 shutdown", async () => {
		const shutdown = spyOn(systemLifecycle, "shutdown");
		const response = await post("signal", {
			peerIp: "127.0.0.1",
			authorization: `Bearer ${TOKEN}`,
			forwardedFor: "203.0.113.5",
		});

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ success: true });
		// scheduleOperatorShutdown 先等 300ms 再调用处理函数，好让 HTTP 响应先写完。
		await Bun.sleep(500);
		expect(reasons).toEqual(["signal"]);
		expect(shutdown).not.toHaveBeenCalled();
		shutdown.mockRestore();
	});

	test("公网对端即使拿着令牌、并声称自己是回环，也进不了令牌旁路", async () => {
		const response = await post("signal", {
			peerIp: "203.0.113.8",
			authorization: `Bearer ${TOKEN}`,
			forwardedFor: "127.0.0.1",
		});
		expect(response.status).toBe(401);
		expect(reasons).toEqual([]);
	});

	test("没有 peerIp 时回落到管理员会话", async () => {
		expect((await post("signal", { authorization: `Bearer ${memberToken}` })).status).toBe(403);
		const response = await post("signal", { authorization: `Bearer ${adminToken}` });
		expect(response.status).toBe(202);
		await Bun.sleep(500);
		expect(reasons).toEqual(["signal"]);
	});
});
