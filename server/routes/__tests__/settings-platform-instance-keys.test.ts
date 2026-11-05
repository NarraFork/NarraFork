import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";

/**
 * 平台实例的 apiKey 与 API key 类供应商同一套回填规则：GET 只给脱敏值，
 * 前端把看到的值原样带回来时不能把它当成新 key 落库。
 */

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-instance-keys-"));
process.env.NARRAFORK_HOME = testHome;
const { saveSettings, settings } = await import("../../lib/settings");
const { settingsRoutes } = await import("../settings");

const ADMIN_ACTOR_ID = "admin-id";
/** requireAdmin 按 actor id 读实时角色，这里把管理员身份固定下来。 */
const sessionStoreSeam: AuthSessionStore = {
	...authSessionStore,
	findSessionState: async (id) => ({
		id,
		role: id === ADMIN_ACTOR_ID ? "admin" : "user",
		tokenVersion: 0,
	}),
};
setAuthStores({ session: sessionStoreSeam, mfa: authMfaStore });

afterAll(() => {
	setAuthStores(undefined);
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

function adminApp() {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: ADMIN_ACTOR_ID, role: "admin", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		throw error;
	});
	app.route("/settings", settingsRoutes);
	return app;
}

const KEY = "cc_plaintext_key_1234";

function instance(apiKey: string, baseUrl = "https://models.example/provider/v1") {
	return {
		id: "cc-key-test",
		platform: "CommandCode" as const,
		suffix: "9",
		prefix: "CommandCode-9",
		disabled: false,
		config: { apiKey, baseUrl },
	};
}

async function patchPlatformInstances(body: unknown): Promise<Response> {
	return adminApp().request("http://localhost/settings", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ agent: { platformInstances: body } }),
	});
}

describe("平台实例的 apiKey 回填", () => {
	test("GET 只回传脱敏值", async () => {
		const original = structuredClone(settings);
		try {
			settings.agent.platformInstances = [instance(KEY)];
			const response = await adminApp().request("http://localhost/settings");
			expect(response.status).toBe(200);
			const read = (await response.json()) as {
				agent: { platformInstances: Array<{ config: { apiKey?: string } }> };
			};
			const masked = read.agent.platformInstances[0]?.config.apiKey;
			expect(masked).not.toBe(KEY);
			expect(masked?.startsWith("*")).toBe(true);
			// 与其它供应商一致：保留末 4 位，便于用户认出是哪一把。
			expect(masked?.endsWith(KEY.slice(-4))).toBe(true);
		} finally {
			saveSettings(original);
		}
	});

	test("原样回传脱敏值不会覆盖真实 key，其它字段照常保存", async () => {
		const original = structuredClone(settings);
		try {
			settings.agent.platformInstances = [instance(KEY)];
			const response = await patchPlatformInstances([
				instance("********1234", "https://other.example/provider/v1"),
			]);
			expect(response.status).toBe(200);
			const stored = settings.agent.platformInstances?.[0]?.config;
			expect(stored?.apiKey).toBe(KEY);
			expect(stored?.baseUrl).toBe("https://other.example/provider/v1");
		} finally {
			saveSettings(original);
		}
	});

	test("提交新的明文 key 会更新", async () => {
		const original = structuredClone(settings);
		try {
			settings.agent.platformInstances = [instance(KEY)];
			const response = await patchPlatformInstances([instance("cc_replaced_key_5678")]);
			expect(response.status).toBe(200);
			expect(settings.agent.platformInstances?.[0]?.config.apiKey).toBe("cc_replaced_key_5678");
		} finally {
			saveSettings(original);
		}
	});
});
