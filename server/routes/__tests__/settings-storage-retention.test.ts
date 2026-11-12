import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";

const { settings, getDefaults, reloadSettings, saveSettings, narraforkDir } = await import(
	"../../lib/settings"
);
const { settingsRoutes, updateSettingsSchema } = await import("../settings");
const { AppError } = await import("../../lib/errors");
const snapshot = structuredClone(settings);
const settingsFile = join(narraforkDir, "settings.json");

function app(role: "admin" | "user" = "admin") {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: `retention-${role}`, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.onError((error) =>
		error instanceof AppError
			? Response.json({ error: error.message }, { status: error.statusCode })
			: Response.json({ error: error.message }, { status: 500 }),
	);
	instance.route("/settings", settingsRoutes);
	return instance;
}

function patch(storageRetention: unknown, role: "admin" | "user" = "admin") {
	return app(role).request("/settings", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ storageRetention }),
	});
}

beforeEach(() => {
	const store: AuthSessionStore = {
		...authSessionStore,
		findSessionState: async (id) => ({
			id,
			role: id === "retention-admin" ? "admin" : "user",
			tokenVersion: 0,
		}),
	};
	setAuthStores({ session: store, mfa: authMfaStore });
	saveSettings({ ...structuredClone(snapshot), storageRetention: getDefaults().storageRetention });
});
afterEach(() => {
	setAuthStores(undefined);
	saveSettings(structuredClone(snapshot));
});

describe("independent storage retention settings", () => {
	test("defaults and legacy missing/partial settings retain everything without automatic cleanup", async () => {
		const defaults = {
			toolCallPayloads: { retentionDays: null, autoCleanup: false },
			messageHistory: { retentionDays: null, autoCleanup: false },
		};
		expect(getDefaults().storageRetention).toEqual(defaults);
		const legacy: Partial<typeof settings> = structuredClone(settings);
		delete legacy.storageRetention;
		writeFileSync(settingsFile, JSON.stringify(legacy));
		expect(reloadSettings().storageRetention).toEqual(defaults);
		writeFileSync(
			settingsFile,
			JSON.stringify({ ...legacy, storageRetention: { toolCallPayloads: { retentionDays: 30 } } }),
		);
		expect(reloadSettings().storageRetention).toEqual({
			...defaults,
			toolCallPayloads: { retentionDays: 30, autoCleanup: false },
		});
		const response = await app("user").request("/settings");
		expect(response.status).toBe(200);
		expect((await response.json()).storageRetention).toEqual(settings.storageRetention);
	});

	test("leaf patches preserve the other field, the other target, and persist across reload", async () => {
		expect(
			(await patch({ toolCallPayloads: { retentionDays: 30, autoCleanup: true } })).status,
		).toBe(200);
		expect((await patch({ messageHistory: { retentionDays: 365 } })).status).toBe(200);
		const response = await patch({ toolCallPayloads: { retentionDays: null } });
		expect(response.status).toBe(200);
		const expected = {
			toolCallPayloads: { retentionDays: null, autoCleanup: true },
			messageHistory: { retentionDays: 365, autoCleanup: false },
		};
		expect((await response.json()).storageRetention).toEqual(expected);
		expect(JSON.parse(readFileSync(settingsFile, "utf8")).storageRetention).toEqual(expected);
		expect(reloadSettings().storageRetention).toEqual(expected);
		expect((await patch({})).status).toBe(200);
		expect((await patch({ messageHistory: {} })).status).toBe(200);
		expect(settings.storageRetention).toEqual(expected);
	});

	test("strict partial validation accepts boundary days and rejects malformed targets/rules atomically", async () => {
		expect(updateSettingsSchema.parse({ storageRetention: {} })).toEqual({ storageRetention: {} });
		for (const retentionDays of [1, 36_500, null]) {
			expect((await patch({ messageHistory: { retentionDays } })).status).toBe(200);
		}
		const before = structuredClone(settings.storageRetention);
		const disk = readFileSync(settingsFile, "utf8");
		for (const invalid of [
			null,
			[],
			{ unknown: {} },
			{ messageHistory: null },
			{ messageHistory: { unknown: true } },
			{ messageHistory: { retentionDays: 0 } },
			{ messageHistory: { retentionDays: -1 } },
			{ messageHistory: { retentionDays: 36_501 } },
			{ messageHistory: { retentionDays: 1.5 } },
			{ messageHistory: { retentionDays: "30" } },
			{ toolCallPayloads: { autoCleanup: "false" } },
		]) {
			expect((await patch(invalid)).status).toBe(400);
			expect(settings.storageRetention).toEqual(before);
			expect(readFileSync(settingsFile, "utf8")).toBe(disk);
		}
	});

	test("concurrent independent target and same-rule leaf patches merge inside the settings lock", async () => {
		const responses = await Promise.all([
			patch({ toolCallPayloads: { retentionDays: 7 } }),
			patch({ messageHistory: { retentionDays: 90 } }),
			patch({ toolCallPayloads: { autoCleanup: true } }),
			patch({ messageHistory: { autoCleanup: true } }),
		]);
		expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
		const expected = {
			toolCallPayloads: { retentionDays: 7, autoCleanup: true },
			messageHistory: { retentionDays: 90, autoCleanup: true },
		};
		expect(settings.storageRetention).toEqual(expected);
		expect(reloadSettings().storageRetention).toEqual(expected);
	});

	test("non-admin patches are forbidden and malformed direct saves/reloads cannot alter live settings", async () => {
		expect((await patch({ messageHistory: { retentionDays: 1 } }, "user")).status).toBe(403);
		const before = structuredClone(settings.storageRetention);
		const disk = readFileSync(settingsFile, "utf8");
		const invalid = structuredClone(settings);
		invalid.storageRetention.messageHistory.retentionDays = 0;
		expect(() => saveSettings(invalid)).toThrow("Invalid storage retention settings");
		expect(readFileSync(settingsFile, "utf8")).toBe(disk);
		expect(settings.storageRetention).toEqual(before);
		writeFileSync(settingsFile, JSON.stringify(invalid));
		expect(reloadSettings().storageRetention).toEqual(before);
	});
});
