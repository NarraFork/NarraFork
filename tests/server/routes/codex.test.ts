import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError } from "../../../server/lib/errors";

const settingsState: {
	codex: {
		useWebSocket?: boolean;
		defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
	};
} = {
	codex: {
		useWebSocket: undefined,
		defaultReasoningEffort: undefined,
	},
};

let saveSettingsCalls = 0;

const actualSettingsModule = await import("../../../server/lib/settings");

mock.module("../../../server/lib/settings", () => ({
	...actualSettingsModule,
	settings: settingsState,
	saveSettings: () => {
		saveSettingsCalls++;
	},
}));

mock.module("../../../server/lib/codex-manager", () => ({
	getCodexManager: () => ({
		snapshot: () => ({
			available: 0,
			total: 0,
			entries: [],
			availableEntries: [],
			unavailableEntries: [],
			availableTotal: 0,
			unavailableTotal: 0,
			stickySessionCount: 0,
			usageCache: {},
			loadBalancingMode: "priority",
		}),
		setLoadBalancingMode: () => {},
		importCredentials: () => ({ added: 0, duplicates: 0, total: 0 }),
	}),
}));

mock.module("../../../server/lib/codex-usage-queue", () => ({
	codexUsageQueue: {
		clearCompleted: () => {},
	},
}));

mock.module("../../../server/lib/logger", () => ({
	logger: {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
	},
}));

mock.module("../../../server/middleware/auth", () => ({
	requireAuth: async (
		c: { set: (key: string, value: unknown) => void },
		next: () => Promise<void>,
	) => {
		c.set("user", { sub: "admin-1", role: "admin" });
		await next();
	},
	requireAdmin: async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
}));

const { codexRoutes } = await import("../../../server/routes/codex");

const app = new Hono();
app.route("/", codexRoutes);
app.onError((err, c) => {
	if (err instanceof AppError) {
		return c.json({ error: err.message, code: err.code }, err.statusCode as ContentfulStatusCode);
	}
	return c.json({ error: String(err) }, 500);
});

beforeEach(() => {
	settingsState.codex.useWebSocket = undefined;
	settingsState.codex.defaultReasoningEffort = undefined;
	saveSettingsCalls = 0;
});

describe("codex routes validation", () => {
	it("defaults websocket mode to enabled when unset", async () => {
		const res = await app.request("/status");

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ useWebSocket: true });
	});

	it("accepts boolean websocket settings and persists them", async () => {
		const res = await app.request("/use-websocket", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ useWebSocket: true }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, useWebSocket: true });
		expect(settingsState.codex.useWebSocket).toBe(true);
		expect(saveSettingsCalls).toBe(1);
	});

	it("rejects non-boolean websocket settings", async () => {
		const res = await app.request("/use-websocket", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ useWebSocket: "false" }),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
		expect(settingsState.codex.useWebSocket).toBeUndefined();
		expect(saveSettingsCalls).toBe(0);
	});

	it("rejects unsupported default reasoning effort values", async () => {
		const res = await app.request("/default-reasoning-effort", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reasoningEffort: "turbo" }),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
		expect(settingsState.codex.defaultReasoningEffort).toBeUndefined();
		expect(saveSettingsCalls).toBe(0);
	});
});
