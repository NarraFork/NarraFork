import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpeechSettings } from "@shared/speech";
import { Hono } from "hono";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";

const { settings, reloadSettings, saveSettings, narraforkDir } = await import("../../lib/settings");
const { settingsRoutes, updateSettingsSchema } = await import("../settings");
const { AppError } = await import("../../lib/errors");
const snapshot = structuredClone(settings);
const settingsFile = join(narraforkDir, "settings.json");
const speech: SpeechSettings = {
	enabled: true,
	providers: [
		{
			id: "voice",
			name: "Voice",
			enabled: true,
			baseUrl: "https://speech.invalid/v1",
			apiKey: "never-return-api-key",
			extraHeaders: { Authorization: "never-return-header" },
			proxy: {
				mode: "custom",
				url: "http://alice:never-return-password@proxy.invalid:8080?token=never-return-query",
			},
			asr: { protocol: "openai-transcription", model: "recognizer" },
		},
	],
	defaultAsrProviderId: "voice",
};

function app(role: "admin" | "user" = "admin") {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: `speech-${role}`, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
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
function patch(value: unknown, role: "admin" | "user" = "admin") {
	return app(role).request("/settings", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(value),
	});
}
beforeEach(() => {
	const store: AuthSessionStore = {
		...authSessionStore,
		findSessionState: async (id) => ({
			id,
			role: id === "speech-admin" ? "admin" : "user",
			tokenVersion: 0,
		}),
	};
	setAuthStores({ session: store, mfa: authMfaStore });
	Object.assign(settings, structuredClone(snapshot));
	settings.speech = structuredClone(speech);
	saveSettings(settings);
});
afterEach(() => {
	setAuthStores(undefined);
	saveSettings(structuredClone(snapshot));
});

describe("speech settings API and persistence", () => {
	test("legacy missing speech loads disabled, malformed speech reload is rejected atomically", () => {
		const legacy = structuredClone(snapshot);
		delete legacy.speech;
		writeFileSync(settingsFile, JSON.stringify(legacy));
		expect(reloadSettings().speech).toEqual({ enabled: false, providers: [] });
		writeFileSync(settingsFile, JSON.stringify({ ...legacy, speech: { enabled: true } }));
		expect(reloadSettings().speech).toEqual({ enabled: false, providers: [] });
	});

	test("every authenticated GET and admin PATCH response omits all speech credentials", async () => {
		for (const role of ["admin", "user"] as const) {
			const response = await app(role).request("/settings");
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(JSON.stringify(body.speech)).not.toContain("never-return");
			expect(body.speech.providers[0]).toMatchObject({ hasApiKey: true, hasExtraHeaders: true });
			expect(body.speech.providers[0]).not.toHaveProperty("apiKey");
			expect(body.speech.providers[0]).not.toHaveProperty("extraHeaders");
		}
		const response = await patch({ speech: { enabled: false } });
		expect(response.status).toBe(200);
		expect(JSON.stringify((await response.json()).speech)).not.toContain("never-return");
		expect(settings.speech?.providers[0].apiKey).toBe("never-return-api-key");
	});

	test("GET round-trip preserves secrets, explicit empty secrets clear and providers list deletes", async () => {
		const view = (await (await app().request("/settings")).json()).speech;
		view.providers[0].name = "New name";
		expect((await patch({ speech: view })).status).toBe(200);
		expect(settings.speech?.providers[0]).toMatchObject({
			...speech.providers[0],
			name: "New name",
		});
		expect(JSON.parse(readFileSync(settingsFile, "utf8")).speech.providers[0].apiKey).toBe(
			"never-return-api-key",
		);
		view.providers[0].apiKey = "";
		view.providers[0].extraHeaders = {};
		const clearResponse = await patch({ speech: view });
		expect(clearResponse.status).toBe(200);
		expect((await clearResponse.json()).speech.providers[0]).toMatchObject({
			hasApiKey: false,
			hasExtraHeaders: false,
		});
		expect(settings.speech?.providers[0].apiKey).toBe("");
		expect(settings.speech?.providers[0].extraHeaders).toEqual({});
		expect((await patch({ speech: { providers: [], defaultAsrProviderId: "" } })).status).toBe(200);
		expect(settings.speech?.providers).toEqual([]);
	});

	test("invalid merged defaults/duplicates/headers do not mutate settings or disk", async () => {
		const before = JSON.stringify(settings.speech);
		const disk = readFileSync(settingsFile, "utf8");
		for (const value of [
			{ providers: [] },
			{ providers: [speech.providers[0], speech.providers[0]] },
			{ providers: [{ ...speech.providers[0], enabled: false }] },
			{ providers: [{ ...speech.providers[0], extraHeaders: { Host: "evil" } }] },
			{ providers: [{ ...speech.providers[0], apiKey: "never-return\r\ninvalid" }] },
		]) {
			const response = await patch({ speech: value });
			expect(response.status).toBe(400);
			expect(await response.text()).not.toContain("never-return");
			expect(JSON.stringify(settings.speech)).toBe(before);
			expect(readFileSync(settingsFile, "utf8")).toBe(disk);
		}
	});

	test("admin authorization and no-default partial semantics remain intact", async () => {
		expect(updateSettingsSchema.parse({ speech: {} })).toEqual({ speech: {} });
		expect((await patch({ speech: { enabled: false } }, "user")).status).toBe(403);
		expect(settings.speech).toEqual(speech);
		expect((await patch({ speech: {} })).status).toBe(200);
		expect(settings.speech).toEqual(speech);
	});

	test("concurrent patches preserve the most recently saved secret inside the settings lock", async () => {
		const { apiKey: _key, extraHeaders: _headers, ...publicProvider } = speech.providers[0];
		const responses = await Promise.all([
			patch({ speech: { providers: [{ ...publicProvider, apiKey: "new-secret" }] } }),
			patch({ speech: { providers: [{ ...publicProvider, name: "After secret rotation" }] } }),
		]);
		expect(responses.map((response) => response.status)).toEqual([200, 200]);
		expect(settings.speech?.providers[0]).toMatchObject({
			name: "After secret rotation",
			apiKey: "new-secret",
			extraHeaders: speech.providers[0].extraHeaders,
		});
	});

	test("direct save also strictly validates speech before writing or mutating singleton", () => {
		const before = readFileSync(settingsFile, "utf8");
		const invalid = structuredClone(settings);
		if (!invalid.speech) throw new Error("speech missing");
		invalid.speech.providers = [];
		expect(() => saveSettings(invalid)).toThrow("Invalid speech settings");
		expect(settings.speech).toEqual(speech);
		expect(readFileSync(settingsFile, "utf8")).toBe(before);
	});
});
