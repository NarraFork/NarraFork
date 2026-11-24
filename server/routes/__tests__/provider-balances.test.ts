import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";
import { getNarraforkPath } from "../../lib/narrafork-home";
import * as outbound from "../../lib/net/outbound-fetch";
import { providerBalanceCache } from "../../lib/provider-balance-cache";
import { getProviderKeyStore } from "../../lib/provider-keys";
import { type CustomApiProviderConfig, saveSettings, settings } from "../../lib/settings";
import { quotaKeyOwner } from "../../lib/settings/provider-keys-projection";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";
import { providerBalanceRoutes } from "../provider-balances";
import { quotaSnapshotRoutes } from "../quota-snapshots";
import { settingsRoutes } from "../settings";

const original = structuredClone(settings);
const config = (apiKey = "key-current"): CustomApiProviderConfig => ({
	id: "relay-balance-test",
	name: "Relay balance test",
	prefix: "relay-balance-test",
	baseUrl: "https://relay.invalid/v1",
	protocol: "completions-compatible",
	apiKey,
	defaultModel: "test-model",
});
function appForRole(role: "admin" | "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: `balance-${role}`, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		c.set("auth", { type: "session", user: c.get("user") });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError)
			return new Response(JSON.stringify({ error: error.code }), { status: error.statusCode });
		throw error;
	});
	app.route("/api/quota-snapshots", quotaSnapshotRoutes);
	app.route("/api/provider-balances", providerBalanceRoutes);
	app.route("/api/settings", settingsRoutes);
	return app;
}
const refresh = (app: Hono, groupId = config().id) =>
	app.request("/api/quota-snapshots/refresh", {
		method: "POST",
		body: JSON.stringify({ groupId }),
		headers: { "Content-Type": "application/json" },
	});
const findRelay = (body: QuotaSnapshotsResponse) =>
	body.entries.find((entry) => entry.groupId === config().id);

beforeEach(() => {
	const store: AuthSessionStore = {
		...authSessionStore,
		findSessionState: async (id) => ({
			id,
			role: id === "balance-admin" ? "admin" : "user",
			tokenVersion: 0,
		}),
	};
	setAuthStores({ session: store, mfa: authMfaStore });
	saveSettings({ ...settings, customApiProviders: [] });
	providerBalanceCache.sync();
	saveSettings({ ...settings, customApiProviders: [config()] });
	spyOn(outbound, "outboundFetch").mockImplementation(async () =>
		Response.json({ mode: "unrestricted", isValid: true, balance: 12, unit: "USD" }),
	);
});
afterEach(() => {
	setAuthStores(undefined);
	saveSettings({ ...settings, customApiProviders: [] });
	providerBalanceCache.sync();
	mock.restore();
});
afterAll(() => saveSettings(original));

describe("relay balance through the unified quota API", () => {
	test("explicit capability probe remains admin-only while old reads/refresh are retired", async () => {
		const path = `/api/provider-balances/${config().id}/probe`;
		expect((await appForRole("user").request(path, { method: "POST" })).status).toBe(403);
		const admin = appForRole("admin");
		expect((await admin.request("/api/provider-balances")).status).toBe(404);
		expect(
			(await admin.request(`/api/provider-balances/${config().id}/refresh`, { method: "POST" }))
				.status,
		).toBe(404);
		expect((await admin.request(path, { method: "POST" })).status).toBe(200);
		await providerBalanceCache.request(config().id);
		expect((await admin.request(path, { method: "POST" })).status).toBe(429);
	});
	test("explicit probe rediscoveries do not degrade to cached refreshes", async () => {
		const request = spyOn(providerBalanceCache, "request");
		const response = await appForRole("admin").request(
			`/api/provider-balances/${config().id}/probe`,
			{ method: "POST" },
		);
		expect(response.status).toBe(200);
		expect(request).toHaveBeenCalledWith(config().id, "probe");
		await providerBalanceCache.request(config().id);
	});
	test("ordinary readers receive safe anonymous snapshots and no-store", async () => {
		await providerBalanceCache.request(config().id);
		const response = await appForRole("user").request("/api/quota-snapshots");
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const text = await response.text();
		expect(text).not.toMatch(/key-current|relay\.invalid|Authorization|identity|detail/);
		expect(findRelay(JSON.parse(text))).toMatchObject({
			credentialId: null,
			supported: true,
			snapshot: { balances: [{ unit: "USD", remaining: 12 }] },
		});
	});
	test("only administrators may explicitly refresh saved relay configurations", async () => {
		expect((await refresh(appForRole("user"))).status).toBe(403);
		expect(outbound.outboundFetch).not.toHaveBeenCalled();
		expect((await refresh(appForRole("admin"), "https://evil.invalid")).status).toBe(404);
		expect(outbound.outboundFetch).not.toHaveBeenCalled();
		const rejected = await appForRole("admin").request("/api/quota-snapshots/refresh", {
			method: "POST",
			body: JSON.stringify({ baseUrl: "https://evil.invalid", apiKey: "private" }),
		});
		expect(rejected.status).toBe(400);
	});
	test("manual relay cooldown is preserved", async () => {
		await providerBalanceCache.request(config().id);
		const response = await refresh(appForRole("admin"));
		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({ error: "PROVIDER_BALANCE_THROTTLED" });
		expect(outbound.outboundFetch).toHaveBeenCalledTimes(1);
	});
	test("GET and explicit refresh never await a hanging relay", async () => {
		spyOn(outbound, "outboundFetch").mockImplementation(
			async () => new Promise<Response>(() => {}),
		);
		const app = appForRole("admin");
		expect((await refresh(app)).status).toBe(200);
		const read = await app.request("/api/quota-snapshots");
		expect(read.status).toBe(200);
		expect(findRelay(await read.json())).toMatchObject({ refreshing: true });
		expect(outbound.outboundFetch).toHaveBeenCalledTimes(1);
	});
	test("saving changed credentials still discovers once and changes the opaque generation", async () => {
		const app = appForRole("admin");
		const patch = async (value: CustomApiProviderConfig) => {
			const response = await app.request("/api/settings", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ customApiProviders: [value] }),
			});
			expect(response.status).toBe(200);
			return (await response.json()).providerBalanceGenerations[config().id] as string;
		};
		const generation = await patch(config());
		expect(generation).toMatch(/^[\da-f-]{36}$/);
		expect(await patch({ ...config(), name: "Renamed" })).toBe(generation);
		const next = await patch(config("key-replaced"));
		expect(next).not.toBe(generation);
	});
	test("settings masks site tokens and a masked PATCH preserves the separate secret", async () => {
		const app = appForRole("admin");
		const store = getProviderKeyStore();
		const owner = quotaKeyOwner(config().id);
		const patch = async (value: CustomApiProviderConfig) => {
			const response = await app.request("/api/settings", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ customApiProviders: [value] }),
			});
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(JSON.stringify(body)).not.toContain("site-route-secret");
			return body.customApiProviders[0] as CustomApiProviderConfig;
		};
		try {
			const masked = await patch({
				...config(),
				quotaAccessToken: "site-route-secret",
				quotaUserId: "42",
			});
			expect(store.firstKey(owner)).toBe("site-route-secret");
			for (const role of ["admin", "user"] as const) {
				const body = await (await appForRole(role).request("/api/settings")).json();
				expect(JSON.stringify(body)).not.toContain("site-route-secret");
				expect(body).not.toHaveProperty("customApiQuotas");
				expect(body).not.toHaveProperty("kimiUsages");
			}
			await patch({ ...masked, name: "Renamed" });
			expect(store.firstKey(owner)).toBe("site-route-secret");
			for (const file of ["settings.json", "provider-keys.json"])
				expect(readFileSync(getNarraforkPath(file), "utf8")).not.toContain("site-route-secret");
			await patch({ ...masked, quotaAccessToken: "" });
			expect(store.list(owner)).toEqual([]);
		} finally {
			store.removeProvider(owner);
		}
	});
	test("failed settings validation cannot start discovery", async () => {
		const response = await appForRole("admin").request("/api/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ customApiProviders: [{ ...config(), protocol: "invalid-protocol" }] }),
		});
		expect(response.status).toBe(400);
		expect(outbound.outboundFetch).not.toHaveBeenCalled();
	});
	test("a disabled quota plugin remains an error, not a zero allowance", async () => {
		const { createApikeyQuotaEngine } = await import("../../services/apikey-quota-plugin-engine");
		const { setProviderBalanceEngine, resetProviderBalanceEngine } = await import(
			"../../lib/provider-balance-engine"
		);
		const engine = createApikeyQuotaEngine({
			commands: {
				invoke: async () => {
					throw Object.assign(new Error("Plugin disabled"), { code: "PLUGIN_DISABLED" });
				},
			},
			activator: { activate: async () => undefined },
		});
		setProviderBalanceEngine(engine);
		try {
			await providerBalanceCache.request(config().id);
			const body = await (await appForRole("user").request("/api/quota-snapshots")).json();
			expect(findRelay(body)?.snapshot).toMatchObject({
				error: "quota_unavailable",
				hasError: true,
				balances: [],
			});
			expect(outbound.outboundFetch).not.toHaveBeenCalled();
		} finally {
			await engine.dispose();
			resetProviderBalanceEngine();
			providerBalanceCache.sync();
		}
	});
});
