import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { ZodError } from "zod";
import { AppError } from "../../lib/errors";
import { getNarraforkPath } from "../../lib/narrafork-home";
import {
	SOURCE_PLUGIN_ID,
	sourceServiceFixture,
	sourceWebsite,
} from "../../services/__tests__/plugin-source-fixtures";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";
import { createPluginUpdateRoutes } from "../plugin-updates";

let root: string;
let fixture: ReturnType<typeof sourceServiceFixture>;
beforeEach(async () => {
	const parent = getNarraforkPath("plugin-update-route-tests");
	await mkdir(parent, { recursive: true });
	root = await mkdtemp(join(parent, "run-"));
	fixture = sourceServiceFixture(root);
	const store: AuthSessionStore = {
		...authSessionStore,
		findSessionState: async (id) => ({
			id,
			role: id === "plugin-source-admin" ? "admin" : "user",
			tokenVersion: 0,
		}),
	};
	setAuthStores({ session: store, mfa: authMfaStore });
});
afterEach(async () => {
	await fixture.service.stop();
	setAuthStores(undefined);
	await rm(root, { recursive: true, force: true });
});
function app(role: "admin" | "user" = "admin") {
	const routes = new Hono();
	routes.use("*", async (c, next) => {
		c.set("user", {
			sub: role === "admin" ? "plugin-source-admin" : "plugin-source-user",
			role,
			iat: 0,
			exp: Number.MAX_SAFE_INTEGER,
		});
		await next();
	});
	routes.onError((error, c) => {
		if (error instanceof AppError) return c.json({ error: error.code }, error.statusCode as 400);
		if (error instanceof ZodError) return c.json({ error: "VALIDATION_ERROR" }, 400);
		throw error;
	});
	routes.route("/api/plugins", createPluginUpdateRoutes({ service: fixture.service }));
	return routes;
}
const requestBody = (value: unknown, method = "PUT") => ({
	method,
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(value),
});

describe("administrator plugin source and update HTTP control plane", () => {
	test("source, update and trusted-builtin listings return cached DTOs and no-store", async () => {
		const route = app();
		const source = await route.request(`/api/plugins/${SOURCE_PLUGIN_ID}/source`);
		expect(source.status).toBe(200);
		expect(source.headers.get("cache-control")).toBe("no-store");
		expect(await source.json()).toMatchObject({
			pluginId: SOURCE_PLUGIN_ID,
			binding: { source: sourceWebsite, autoUpdate: false },
		});
		const updates = await route.request(`/api/plugins/${SOURCE_PLUGIN_ID}/updates`);
		expect(await updates.json()).toMatchObject({
			status: "idle",
			latest: null,
			installedVersion: "1.0.0",
		});
		const builtin = await route.request("/api/plugins/builtins");
		expect(await builtin.json()).toMatchObject({
			builtins: [
				{
					pluginId: "io.narrafork.provider-quota",
					version: "1.0.3",
					installed: false,
					canInstall: true,
				},
			],
		});
		expect(fixture.fetch).not.toHaveBeenCalled();
	});

	test("every source/update/builtin endpoint requires the live administrator role", async () => {
		const route = app("user");
		for (const [path, method] of [
			[`/${SOURCE_PLUGIN_ID}/source`, "GET"],
			[`/${SOURCE_PLUGIN_ID}/source`, "PUT"],
			[`/${SOURCE_PLUGIN_ID}/updates`, "GET"],
			[`/${SOURCE_PLUGIN_ID}/updates/check`, "POST"],
			[`/${SOURCE_PLUGIN_ID}/updates/apply`, "POST"],
			[`/${SOURCE_PLUGIN_ID}/updates/preferences`, "PUT"],
			["/builtins", "GET"],
			["/builtins/io.narrafork.provider-quota/install", "POST"],
			[`/update-jobs/${crypto.randomUUID()}`, "GET"],
			[`/update-jobs/${crypto.randomUUID()}/cancel`, "POST"],
		])
			expect((await route.request(`/api/plugins${path}`, { method })).status).toBe(403);
		expect(fixture.fetch).not.toHaveBeenCalled();
		expect(fixture.manager.updateFromSource).not.toHaveBeenCalled();
	});

	test("mounting before the legacy router does not change legacy read permissions or upload limits", async () => {
		const route = app("user");
		const legacy = new Hono();
		legacy.get("/", (c) => c.json({ legacy: "list" }));
		legacy.get("/:pluginId", (c) => c.json({ pluginId: c.req.param("pluginId") }));
		legacy.post("/install", async (c) => c.json({ bytes: (await c.req.text()).length }));
		route.route("/api/plugins", legacy);
		expect(await (await route.request("/api/plugins")).json()).toEqual({ legacy: "list" });
		expect((await route.request(`/api/plugins/${SOURCE_PLUGIN_ID}`)).status).toBe(200);
		const upload = await route.request("/api/plugins/install", {
			method: "POST",
			body: "x".repeat(32 * 1024),
		});
		expect(upload.status).toBe(200);
		expect(await upload.json()).toEqual({ bytes: 32 * 1024 });
		expect((await route.request(`/api/plugins/${SOURCE_PLUGIN_ID}/source`)).status).toBe(403);
	});

	test("source PUT uses expected revision and null explicitly clears the binding", async () => {
		const route = app();
		const response = await route.request(
			`/api/plugins/${SOURCE_PLUGIN_ID}/source`,
			requestBody({ source: null, expectedRevision: 0 }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			binding: { mode: "none", source: null, revision: 1, autoUpdate: false },
		});
		const conflict = await route.request(
			`/api/plugins/${SOURCE_PLUGIN_ID}/source`,
			requestBody({ source: sourceWebsite, expectedRevision: 0 }),
		);
		expect(conflict.status).toBe(409);
	});

	test("source body, URL and revision validation rejects unknown credential/configuration fields", async () => {
		const route = app();
		for (const value of [
			{ source: sourceWebsite, expectedRevision: -1 },
			{ source: sourceWebsite, expectedRevision: "0" },
			{ source: sourceWebsite, expectedRevision: 0, apiKey: "nf-secret" },
			{ source: { ...sourceWebsite, updateApi: "javascript:alert(1)" }, expectedRevision: 0 },
		])
			expect(
				(await route.request(`/api/plugins/${SOURCE_PLUGIN_ID}/source`, requestBody(value))).status,
			).toBe(400);
		expect(
			(await route.request(`/api/plugins/${SOURCE_PLUGIN_ID}/source`, { method: "PUT", body: "{" }))
				.status,
		).toBe(400);
		expect(
			(
				await route.request(`/api/plugins/${SOURCE_PLUGIN_ID}/source`, {
					method: "PUT",
					body: "x".repeat(16 * 1024 + 1),
				})
			).status,
		).toBe(413);
		expect(fixture.fetch).not.toHaveBeenCalled();
	});

	test("check returns a job ID immediately and job GET exposes bounded progress only", async () => {
		fixture.fetch.mockImplementation(() => new Promise(() => {}));
		const route = app();
		const response = await route.request(
			`/api/plugins/${SOURCE_PLUGIN_ID}/updates/check`,
			requestBody({}, "POST"),
		);
		expect(response.status).toBe(202);
		const { jobId } = await response.json();
		const job = await (await route.request(`/api/plugins/update-jobs/${jobId}`)).json();
		expect(job).toMatchObject({
			id: jobId,
			pluginId: SOURCE_PLUGIN_ID,
			kind: "check",
			downloadedBytes: 0,
			cancellable: true,
		});
		expect(JSON.stringify(job)).not.toMatch(/https:|Authorization|identity|nf-secret/);
		const cancelled = await route.request(
			`/api/plugins/update-jobs/${jobId}/cancel`,
			requestBody({}, "POST"),
		);
		expect(cancelled.status).toBe(200);
		expect((await fixture.service.waitForJob(jobId))?.status).toBe("cancelled");
	});

	test("checks respect ten-second manual throttling and Retry-After", async () => {
		const route = app();
		const first = await (
			await route.request(`/api/plugins/${SOURCE_PLUGIN_ID}/updates/check`, requestBody({}, "POST"))
		).json();
		await fixture.service.waitForJob(first.jobId);
		const throttled = await route.request(
			`/api/plugins/${SOURCE_PLUGIN_ID}/updates/check`,
			requestBody({}, "POST"),
		);
		expect(throttled.status).toBe(429);
		expect(throttled.headers.get("retry-after")).toBe("10");
	});

	test("apply accepts only a current candidate, revision and optional one-time trust confirmation", async () => {
		const route = app();
		const check = await fixture.service.check(SOURCE_PLUGIN_ID);
		await fixture.service.waitForJob(check.jobId);
		const view = await fixture.service.getUpdates(SOURCE_PLUGIN_ID);
		const bad = await route.request(
			`/api/plugins/${SOURCE_PLUGIN_ID}/updates/apply`,
			requestBody(
				{
					candidateId: view.candidateId,
					expectedRevision: 0,
					url: "https://evil.example/plugin.nfplugin",
				},
				"POST",
			),
		);
		expect(bad.status).toBe(400);
		const unknown = await route.request(
			`/api/plugins/${SOURCE_PLUGIN_ID}/updates/apply`,
			requestBody({ candidateId: crypto.randomUUID(), expectedRevision: 0 }, "POST"),
		);
		expect(unknown.status).toBe(409);
		const response = await route.request(
			`/api/plugins/${SOURCE_PLUGIN_ID}/updates/apply`,
			requestBody(
				{ candidateId: view.candidateId, expectedRevision: 0, allowTrustChange: true },
				"POST",
			),
		);
		expect(response.status).toBe(202);
		const { jobId } = await response.json();
		expect((await fixture.service.waitForJob(jobId))?.status).toBe("succeeded");
		expect(fixture.manager.updateFromSource.mock.calls[0]?.[1]).toMatchObject({
			allowTrustChange: true,
			automatic: false,
			expectedVersion: "1.2.3",
		});
	});

	test("preferences use the shared source DTO and explicit opt-in, never an implicit default", async () => {
		const route = app();
		const response = await route.request(
			`/api/plugins/${SOURCE_PLUGIN_ID}/updates/preferences`,
			requestBody({ autoUpdate: true, expectedRevision: 0 }),
		);
		expect(await response.json()).toMatchObject({
			pluginId: SOURCE_PLUGIN_ID,
			binding: { autoUpdate: true, revision: 1 },
		});
		expect(fixture.fetch).not.toHaveBeenCalled();
	});

	test("global disable leaves cache reads available but blocks source/update/install mutation", async () => {
		fixture.manager.enabled = false;
		const route = app();
		expect((await route.request(`/api/plugins/${SOURCE_PLUGIN_ID}/updates`)).status).toBe(200);
		const { builtins } = await (await route.request("/api/plugins/builtins")).json();
		expect(builtins[0].canInstall).toBe(false);
		for (const path of [
			`/${SOURCE_PLUGIN_ID}/updates/check`,
			`/builtins/${fixture.local.pluginId}/install`,
		]) {
			const response = await route.request(`/api/plugins${path}`, requestBody({}, "POST"));
			expect(response.status).toBe(503);
			expect(await response.json()).toMatchObject({ error: "PLUGINS_DISABLED" });
		}
		expect(fixture.fetch).not.toHaveBeenCalled();
	});

	test("explicit builtin reinstall uses an install_builtin job and never network discovery", async () => {
		const route = app();
		const response = await route.request(
			`/api/plugins/builtins/${fixture.local.pluginId}/install`,
			requestBody({}, "POST"),
		);
		expect(response.status).toBe(202);
		const { jobId } = await response.json();
		expect(await fixture.service.waitForJob(jobId)).toMatchObject({
			kind: "install_builtin",
			status: "succeeded",
		});
		expect((await (await route.request("/api/plugins/builtins")).json()).builtins[0]).toMatchObject(
			{ installed: true, installedVersion: "1.0.3", canInstall: false },
		);
		expect(fixture.fetch).not.toHaveBeenCalled();
	});

	test("unknown jobs and builtin IDs return explicit not-found errors", async () => {
		const route = app();
		expect((await route.request(`/api/plugins/update-jobs/${crypto.randomUUID()}`)).status).toBe(
			404,
		);
		expect(
			(
				await route.request(
					"/api/plugins/builtins/io.unregistered.plugin/install",
					requestBody({}, "POST"),
				)
			).status,
		).toBe(404);
	});

	test("new routes and startup/shutdown do not alter runtime Host API declarations", () => {
		const source = readFileSync(new URL("../plugin-updates.ts", import.meta.url), "utf8");
		expect(source).toContain("options.adminMiddleware ?? requireAdmin");
		const appSource = readFileSync(new URL("../../app.ts", import.meta.url), "utf8");
		const mount = appSource.indexOf('app.route("/api/plugins", pluginUpdateRoutes)');
		expect(mount).toBeGreaterThan(appSource.indexOf('app.use("/api/*", requireSessionAuth)'));
		expect(mount).toBeLessThan(appSource.indexOf('app.route("/api/plugins", pluginRoutes)'));
		const main = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");
		expect(main).toContain("pluginSourceService.start()");
		expect(main).toContain("pluginSourceService.beginShutdown()");
		expect(main).toContain('"pluginSourceService.stop"');
		expect(source).not.toContain("HOST_API_VERSION");
	});
});
