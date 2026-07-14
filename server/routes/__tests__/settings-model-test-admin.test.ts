import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-model-test-admin-"));
process.env.NARRAFORK_HOME = testHome;
const { db } = await import("../../db");
const { narrators } = await import("../../db/schema");
const { saveSettings, settings } = await import("../../lib/settings");
const { settingsRoutes } = await import("../settings");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

function appForRole(role: "admin" | "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: `${role}-id`, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
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

describe("settings conditional admin guards", () => {
	test("rejects a non-admin before attempting provider resolution", async () => {
		const response = await appForRole("user").request("/settings/test-model", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "does-not-matter", prompt: "hello" }),
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Admin access required",
			code: "FORBIDDEN",
		});
	});

	test("rejects explicit trustedProxyCidrs patches from non-admins without mutation", async () => {
		const before = structuredClone(settings.auth);
		const response = await appForRole("user").request("/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				auth: { trustedProxyCidrs: ["10.0.0.0/8"] },
				agent: { maxTurns: settings.agent.maxTurns + 1 },
			}),
		});

		expect(response.status).toBe(403);
		expect(settings.auth).toEqual(before);
	});

	test("allows ordinary settings patches for non-admins", async () => {
		const original = settings.auth.registrationOpen;
		const response = await appForRole("user").request("/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ auth: { registrationOpen: !original } }),
		});

		expect(response.status).toBe(200);
		expect(settings.auth.registrationOpen).toBe(!original);
		settings.auth.registrationOpen = original;
	});

	test("allows admins to update trustedProxyCidrs", async () => {
		const original = structuredClone(settings.auth.trustedProxyCidrs);
		const response = await appForRole("admin").request("/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ auth: { trustedProxyCidrs: ["10.0.0.0/8"] } }),
		});

		expect(response.status).toBe(200);
		expect(settings.auth.trustedProxyCidrs).toEqual(["10.0.0.0/8"]);
		settings.auth.trustedProxyCidrs = original;
	});

	test("old split-array patches preserve Gemini providers and real keys", async () => {
		const original = structuredClone(settings);
		try {
			const geminiProvider = {
				id: "gemini-legacy",
				name: "Gemini Legacy",
				prefix: "gemini-legacy",
				apiKey: "real-secret-key",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				defaultModel: "gemini-2.5-flash",
				disabled: false,
			};
			saveSettings({
				...settings,
				customApiProviders: [{ ...geminiProvider, protocol: "gemini-compatible" }],
				openaiProviders: [],
				anthropicProviders: [],
				geminiProviders: [geminiProvider],
			});

			const response = await appForRole("admin").request("/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ openaiProviders: [], anthropicProviders: [] }),
			});

			expect(response.status).toBe(200);
			expect(settings.geminiProviders).toEqual([
				expect.objectContaining({
					id: "gemini-legacy",
					apiKey: "real-secret-key",
					geminiTransport: "generate-content",
				}),
			]);
			expect(settings.customApiProviders).toEqual([
				expect.objectContaining({
					id: "gemini-legacy",
					apiKey: "real-secret-key",
					protocol: "gemini-compatible",
				}),
			]);
		} finally {
			saveSettings(original);
		}
	});

	test("masked unified Gemini patches round-trip explicit transport without losing the key", async () => {
		const original = structuredClone(settings);
		try {
			const provider = {
				id: "gemini-interactions",
				name: "Gemini Interactions",
				prefix: "gemini-interactions",
				apiKey: "real-interactions-key",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				defaultModel: "gemini-3-flash-preview",
				protocol: "gemini-compatible" as const,
				geminiTransport: "interactions" as const,
			};
			saveSettings({
				...settings,
				customApiProviders: [provider],
				openaiProviders: [],
				anthropicProviders: [],
				geminiProviders: [provider],
			});

			const getResponse = await appForRole("admin").request("/settings");
			const masked = (await getResponse.json()) as {
				customApiProviders: Array<Record<string, unknown>>;
			};
			expect(masked.customApiProviders[0]?.geminiTransport).toBe("interactions");
			expect(String(masked.customApiProviders[0]?.apiKey).startsWith("*")).toBe(true);
			expect(String(masked.customApiProviders[0]?.apiKey).endsWith("-key")).toBe(true);

			const patchResponse = await appForRole("admin").request("/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ customApiProviders: masked.customApiProviders }),
			});
			expect(patchResponse.status).toBe(200);
			expect(settings.customApiProviders?.[0]).toMatchObject({
				geminiTransport: "interactions",
				apiKey: "real-interactions-key",
			});
			expect(settings.geminiProviders?.[0]).toMatchObject({
				geminiTransport: "interactions",
				apiKey: "real-interactions-key",
			});
		} finally {
			saveSettings(original);
		}
	});

	test("provider prefix changes migrate narrator model references atomically", async () => {
		const original = structuredClone(settings);
		const narratorId = "prefix-migration-narrator";
		const now = new Date().toISOString();
		try {
			const provider = {
				id: "prefix-provider",
				name: "Prefix Provider",
				prefix: "old-prefix",
				apiKey: "secret",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "model-a",
				protocol: "responses-compatible" as const,
			};
			saveSettings({
				...settings,
				customApiProviders: [provider],
				openaiProviders: [],
				anthropicProviders: [],
				geminiProviders: [],
			});
			await db.insert(narrators).values({
				id: narratorId,
				model: "old-prefix:model-a",
				pendingModelRestore: "old-prefix:model-b",
				createdAt: now,
				updatedAt: now,
			});

			const response = await appForRole("admin").request("/settings", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					customApiProviders: [{ ...provider, prefix: "new-prefix" }],
				}),
			});
			expect(response.status).toBe(200);
			const row = await db
				.select({ model: narrators.model, pendingModelRestore: narrators.pendingModelRestore })
				.from(narrators)
				.where(eq(narrators.id, narratorId))
				.get();
			expect(row).toEqual({
				model: "new-prefix:model-a",
				pendingModelRestore: "new-prefix:model-b",
			});
			expect(settings.customApiProviders?.[0]?.prefix).toBe("new-prefix");
		} finally {
			await db.delete(narrators).where(eq(narrators.id, narratorId));
			saveSettings(original);
		}
	});
});
