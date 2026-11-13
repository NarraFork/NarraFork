import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";

/**
 * 改模型前缀等于换模型命名空间：逐模型设置的键（隐藏、协议覆盖、自定义模型）
 * 必须跟着换，否则改名的一瞬间这些设置全部失效。
 */

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-instance-rename-"));
process.env.NARRAFORK_HOME = testHome;
const { saveSettings, settings } = await import("../../lib/settings");
const { settingsRoutes } = await import("../settings");

const ADMIN_ACTOR_ID = "admin-id";
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

const OLD = "CommandCode-9";
const NEW = "CommandCode-10";

function instance(prefix: string) {
	return {
		id: "cc-rename-test",
		platform: "CommandCode" as const,
		suffix: prefix.slice("CommandCode-".length),
		prefix,
		disabled: false,
		config: { apiKey: "cc_rename_key" },
	};
}

describe("平台实例改名", () => {
	test("改前缀时逐模型设置的键跟着迁移", async () => {
		const original = structuredClone(settings);
		try {
			settings.agent.platformInstances = [instance(OLD)];
			settings.agent.hiddenModels = [`${OLD}:hidden-model`, "codex:gpt-5.4"];
			settings.agent.modelProtocols = { [`${OLD}:proto-model`]: "anthropic-messages" };
			settings.agent.modelProtocolOverrides = { [`${OLD}:override-model`]: "gemini-compatible" };
			settings.agent.customModels = [
				{ value: `${OLD}:custom-model`, label: "custom-model", provider: OLD },
			];

			const response = await adminApp().request("http://localhost/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ agent: { platformInstances: [instance(NEW)] } }),
			});
			expect(response.status).toBe(200);

			expect(settings.agent.hiddenModels).toEqual([`${NEW}:hidden-model`, "codex:gpt-5.4"]);
			expect(settings.agent.modelProtocols).toEqual({
				[`${NEW}:proto-model`]: "anthropic-messages",
			});
			expect(settings.agent.modelProtocolOverrides).toEqual({
				[`${NEW}:override-model`]: "gemini-compatible",
			});
			expect(settings.agent.customModels).toEqual([
				{ value: `${NEW}:custom-model`, label: "custom-model", provider: NEW },
			]);
		} finally {
			saveSettings(original);
		}
	});

	test("只改后缀时前缀不动，其它键也不动", async () => {
		const original = structuredClone(settings);
		try {
			settings.agent.platformInstances = [instance(OLD)];
			settings.agent.hiddenModels = [`${OLD}:hidden-model`];

			const response = await adminApp().request("http://localhost/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					agent: { platformInstances: [{ ...instance(OLD), suffix: "renamed" }] },
				}),
			});
			expect(response.status).toBe(200);

			expect(settings.agent.platformInstances?.[0]?.suffix).toBe("renamed");
			expect(settings.agent.platformInstances?.[0]?.prefix).toBe(OLD);
			expect(settings.agent.hiddenModels).toEqual([`${OLD}:hidden-model`]);
		} finally {
			saveSettings(original);
		}
	});
});
