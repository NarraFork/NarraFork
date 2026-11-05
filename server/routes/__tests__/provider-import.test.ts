import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-provider-import-"));
process.env.NARRAFORK_HOME = testHome;
const { saveSettings, settings } = await import("../../lib/settings");
const { getCustomApiCachedQuota, updateCustomApiQuotaByPrefix } = await import(
	"../../lib/custom-api-quota-cache"
);
const { gatewayProviderImportRoutes } = await import("../provider-gateway-import");
const { updateSettingsSchema } = await import("../settings");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	try {
		rmSync(testHome, { recursive: true, force: true });
	} catch {
		// Windows may still hold the test database open.
	}
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
	app.route("/import", gatewayProviderImportRoutes);
	return app;
}

function post(app: Hono, path: string, body: unknown) {
	return app.request(`http://localhost/import${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const EXISTING = {
	id: "existing1",
	name: "Geek2API",
	prefix: "geek2api",
	apiKey: "sk-old",
	baseUrl: "https://api.geek2api.com",
	defaultModel: "",
	protocol: "anthropic-messages" as const,
};

const PAYLOAD = {
	v: 1,
	providers: [
		{
			name: "Geek2API Claude",
			protocol: "anthropic-messages",
			baseUrl: "https://api.geek2api.com/",
			baseUrls: ["https://hk.geek2api.com"],
			prefix: "geek2api",
			apiKey: "sk-new",
			tlsRejectUnauthorized: false,
		},
	],
};

beforeEach(() => {
	saveSettings({
		...settings,
		customApiProviders: [EXISTING],
		openaiProviders: [],
		anthropicProviders: [],
		geminiProviders: [],
		nugProviders: [],
	});
});

describe("provider import routes", () => {
	test("are admin-only", async () => {
		const response = await post(appForRole("user"), "/preview", { payload: PAYLOAD });
		expect(response.status).toBe(403);
	});

	test("preview reports conflicts without leaking stored keys", async () => {
		const response = await post(appForRole("admin"), "/preview", { payload: PAYLOAD });
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ignoredFields).toEqual(["providers[0].tlsRejectUnauthorized"]);
		expect(body.entries[0].suggestedPrefix).toBe("geek2api-2");
		expect(body.entries[0].duplicates).toEqual([
			{
				id: "existing1",
				name: "Geek2API",
				prefix: "geek2api",
				sameKey: false,
			},
		]);
		expect(JSON.stringify(body)).not.toContain("sk-old");
	});

	test("commit adds a provider with mirrors and a unique prefix", async () => {
		const response = await post(appForRole("admin"), "/commit", {
			payload: PAYLOAD,
			entries: [{ action: "add", name: "Geek2API · work" }],
		});
		expect(response.status).toBe(200);
		const { results, refresh } = await response.json();
		expect(results[0]).toMatchObject({ status: "added", prefix: "geek2api-2" });
		expect(refresh).toEqual([{ providerId: results[0].providerId }]);
		expect(settings.customApiProviders).toHaveLength(2);
		expect(settings.customApiProviders?.[0]?.apiKey).toBe("sk-old");
		const added = settings.customApiProviders?.find((p) => p.id === results[0].providerId);
		expect(added).toMatchObject({
			name: "Geek2API · work",
			apiKey: "sk-new",
			baseUrls: ["https://hk.geek2api.com"],
			tlsRejectUnauthorized: true,
		});
		// Legacy arrays stay in sync with the unified list.
		expect(settings.anthropicProviders?.some((p) => p.id === added?.id)).toBe(true);
	});

	test("commit can replace the key of an existing provider only", async () => {
		updateCustomApiQuotaByPrefix("geek2api", "7");
		expect(getCustomApiCachedQuota("existing1")).toBeDefined();
		const response = await post(appForRole("admin"), "/commit", {
			payload: PAYLOAD,
			entries: [{ action: "replace-key", targetId: "existing1" }],
		});
		expect(response.status).toBe(200);
		expect(settings.customApiProviders).toHaveLength(1);
		expect(settings.customApiProviders?.[0]).toMatchObject({
			id: "existing1",
			apiKey: "sk-new",
			baseUrl: "https://api.geek2api.com",
		});
		expect(getCustomApiCachedQuota("existing1")).toBeUndefined();
	});

	test("matching keys can be skipped without changing existing providers", async () => {
		const payload = { ...PAYLOAD, providers: [{ ...PAYLOAD.providers[0], apiKey: "sk-old" }] };
		const app = appForRole("admin");
		const preview = await (await post(app, "/preview", { payload })).json();
		expect(preview.entries[0].duplicates[0].sameKey).toBe(true);
		const before = JSON.stringify(settings.customApiProviders);
		const response = await post(app, "/commit", {
			payload,
			entries: [{ action: "skip" }],
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ results: [{ status: "skipped" }], refresh: [] });
		expect(JSON.stringify(settings.customApiProviders)).toBe(before);
	});

	test("commit rejects the removed merge action", async () => {
		const response = await post(appForRole("admin"), "/commit", {
			payload: PAYLOAD,
			entries: [{ action: "merge", targetId: EXISTING.id }],
		});
		expect(response.status).toBe(400);
		expect(settings.customApiProviders).toHaveLength(1);
	});

	test("commit rejects mismatched decisions and invalid payloads", async () => {
		const app = appForRole("admin");
		expect((await post(app, "/commit", { payload: PAYLOAD, entries: [] })).status).toBe(400);
		const invalid = { v: 1, providers: [{ ...PAYLOAD.providers[0], baseUrl: "ftp://x" }] };
		expect(
			(await post(app, "/commit", { payload: invalid, entries: [{ action: "add" }] })).status,
		).toBe(400);
		expect(settings.customApiProviders).toHaveLength(1);
	});

	test("fetch rejects unusable input without any request", async () => {
		const response = await post(appForRole("admin"), "/fetch", { input: "127.0.0.1" });
		expect(await response.json()).toEqual({ ok: false, error: "bad-domain", attempts: [] });
	});
});

describe("settings PATCH mirror validation", () => {
	const provider = { ...EXISTING, apiKey: "sk", defaultModel: "m" };
	test("rejects mirrors that are not credential-free http(s) URLs", () => {
		for (const mirror of ["ftp://mirror.example.com", "https://u:p@mirror.example.com", "nope"]) {
			const parsed = updateSettingsSchema.safeParse({
				customApiProviders: [{ ...provider, baseUrls: [mirror] }],
			});
			expect(parsed.success).toBe(false);
		}
		const ok = updateSettingsSchema.safeParse({
			customApiProviders: [{ ...provider, baseUrls: ["https://mirror.example.com/v1"] }],
		});
		expect(ok.success).toBe(true);
	});
});

describe("checking keys before import", () => {
	test("lists models per key without saving anything", async () => {
		const realFetch = globalThis.fetch;
		const seen: string[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			seen.push(url);
			const auth = new Headers(init?.headers).get("authorization") ?? "";
			if (auth === "Bearer sk-good") {
				return new Response(
					JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }], has_more: false }),
					{
						headers: { "content-type": "application/json" },
					},
				);
			}
			return new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 });
		}) as typeof fetch;
		try {
			const before = JSON.stringify(settings.customApiProviders);
			const response = await post(appForRole("admin"), "/check", {
				payload: {
					v: 1,
					providers: [
						{
							name: "Check",
							protocol: "anthropic-messages",
							baseUrl: "https://check.example.com",
							apiKey: "sk-good",
						},
					],
				},
			});
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.truncated).toBe(false);
			expect(body.results).toEqual([{ entry: 0, ok: true, count: 2 }]);
			expect(seen.every((url) => url.startsWith("https://check.example.com"))).toBe(true);
			expect(JSON.stringify(settings.customApiProviders)).toBe(before);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("is admin-only", async () => {
		const response = await post(appForRole("user"), "/check", { payload: PAYLOAD });
		expect(response.status).toBe(403);
	});
});
