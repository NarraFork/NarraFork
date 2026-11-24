import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { QuotaQueryResult } from "@shared/provider-quota";
import { Hono } from "hono";
import { ZodError } from "zod";
import {
	deferred,
	legacyQuotaFixture,
	quotaConfig,
	walletQuota,
} from "../../lib/__tests__/provider-quota-legacy-fixture";
import {
	getCustomApiCachedQuota,
	purgeCustomApiQuotaCache,
	updateCustomApiQuotaByPrefix,
} from "../../lib/custom-api-quota-cache";
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

const original = structuredClone(settings);
const config = (apiKey = "key-current") =>
	quotaConfig({
		id: "relay-balance-test",
		prefix: "relay-balance-test",
		name: "Relay balance test",
		apiKey,
	});
let fixture: ReturnType<typeof legacyQuotaFixture>;

function appForRole(role: "admin" | "user") {
	const app = new Hono();
	const sub = role === "admin" ? "balance-admin" : "balance-user";
	app.use("*", async (c, next) => {
		c.set("user", { sub, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error, c) => {
		if (error instanceof AppError)
			return new Response(JSON.stringify({ error: error.code }), {
				status: error.statusCode,
				headers: c.res.headers,
			});
		if (error instanceof ZodError)
			return new Response(JSON.stringify({ error: "VALIDATION_ERROR" }), { status: 400 });
		throw error;
	});
	app.route("/api/provider-balances", providerBalanceRoutes);
	return app;
}

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
	fixture = legacyQuotaFixture([config()]);
	// Model discovery performed by settings must never reach a real network in this suite.
	spyOn(outbound, "outboundFetch").mockImplementation(async () => Response.json({ data: [] }));
});
afterEach(() => {
	purgeCustomApiQuotaCache([config().id]);
	fixture.dispose();
	setAuthStores(undefined);
	getProviderKeyStore().removeProvider(config().id);
	getProviderKeyStore().removeProvider(quotaKeyOwner(config().id));
	mock.restore();
});
afterAll(() => saveSettings(original));

describe("legacy provider balance API", () => {
	test("authenticated readers get only credential-free snapshots and no-store", async () => {
		await providerBalanceCache.request(config().id);
		const response = await appForRole("user").request("/api/provider-balances");
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const text = await response.text();
		expect(text).not.toMatch(/key-current|relay\.invalid|Authorization|identity/);
		expect(JSON.parse(text)[config().id]).toMatchObject({
			status: "supported",
			adapter: "sub2api",
		});
	});

	test("provider queries select saved IDs, never arbitrary outbound URLs", async () => {
		settings.customApiProviders = [config(), config("second-key")].map((value, i) =>
			i ? { ...value, id: "second", prefix: "second" } : value,
		);
		const response = await appForRole("user").request(
			`/api/provider-balances?providerId=${config().id}`,
		);
		expect(Object.keys(await response.json())).toEqual([config().id]);
		const unknown = await appForRole("user").request(
			"/api/provider-balances?providerId=https://evil.invalid",
		);
		expect(await unknown.json()).toEqual({});
	});

	for (const action of ["probe", "refresh"]) {
		test(`only administrators may ${action} a saved configuration`, async () => {
			const response = await appForRole("user").request(
				`/api/provider-balances/${config().id}/${action}`,
				{ method: "POST" },
			);
			expect(response.status).toBe(403);
			expect(fixture.query).not.toHaveBeenCalled();
			const missing = await appForRole("admin").request(
				`/api/provider-balances/not-saved/${action}`,
				{
					method: "POST",
					body: JSON.stringify({ baseUrl: "https://evil.invalid", apiKey: "private" }),
				},
			);
			expect(missing.status).toBe(404);
			expect(fixture.query).not.toHaveBeenCalled();
		});
	}

	test("admin receives the original cooldown code rather than an ignored probe", async () => {
		await providerBalanceCache.request(config().id);
		const response = await appForRole("admin").request(
			`/api/provider-balances/${config().id}/probe`,
			{ method: "POST" },
		);
		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({ error: "PROVIDER_BALANCE_THROTTLED" });
		expect(fixture.query).toHaveBeenCalledTimes(1);
	});

	test("GET and admin probe never wait for a hanging source", async () => {
		fixture.query.mockImplementation(() => new Promise(() => {}));
		const app = appForRole("admin");
		const response = await app.request(`/api/provider-balances/${config().id}/probe`, {
			method: "POST",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "probing" });
		expect((await app.request("/api/provider-balances")).status).toBe(200);
		expect(fixture.query).toHaveBeenCalledTimes(1);
	});
});

describe("settings quota integration", () => {
	test("site token masks for both roles, masked PATCH preserves its distinct encrypted key owner", async () => {
		const { settingsRoutes } = await import("../settings");
		const app = appForRole("admin").route("/api/settings", settingsRoutes);
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
		await patch({ ...config(), quotaAccessToken: "site-route-secret", quotaUserId: "42" });
		expect(settings.customApiProviders?.[0]?.quotaAccessToken).toBe("site-route-secret");
		expect(store.firstKey(owner)).toBe("site-route-secret");
		expect(store.firstKey(config().id)).toBe("key-current");
		for (const role of ["admin", "user"] as const) {
			const response = await appForRole(role)
				.route("/api/settings", settingsRoutes)
				.request("/api/settings");
			expect(response.status).toBe(200);
			const body = await response.json();
			expect(JSON.stringify(body)).not.toContain("site-route-secret");
			expect(body.customApiProviders[0].quotaAccessToken).toMatch(/^\*/);
		}
		const masked = (await (await app.request("/api/settings")).json())
			.customApiProviders[0] as CustomApiProviderConfig;
		await patch({ ...masked, name: "Renamed without new credentials" });
		expect(settings.customApiProviders?.[0]?.quotaAccessToken).toBe("site-route-secret");
		expect(store.firstKey(owner)).toBe("site-route-secret");
		expect(store.firstKey(config().id)).toBe("key-current");
		for (const file of ["settings.json", "provider-keys.json"])
			expect(readFileSync(getNarraforkPath(file), "utf8")).not.toContain("site-route-secret");
		await patch({ ...masked, quotaAccessToken: "" });
		expect(store.list(owner)).toEqual([]);
		expect(settings.customApiProviders?.[0]).not.toHaveProperty("quotaAccessToken");
		expect(store.firstKey(config().id)).toBe("key-current");
	}, 30000);
	test.each([
		"explicit",
		"derived",
	] as const)("legacy split PATCH preserves %s quota credentials on rename but not on reassignment or deletion", async (site) => {
		const { settingsRoutes } = await import("../settings");
		const app = appForRole("admin").route("/api/settings", settingsRoutes);
		const store = getProviderKeyStore();
		const provider = {
			...config(),
			baseUrl: "https://relay.invalid/tenant-a/v1",
			...(site === "explicit" ? { quotaSiteUrl: "https://quota.invalid/account-a" } : {}),
			quotaUserId: "42",
			quotaAccessToken: "legacy-site-fixture-secret",
		};
		const owner = quotaKeyOwner(provider.id);
		const patch = async (body: Record<string, unknown>) => {
			const response = await app.request("/api/settings", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(200);
			const view = await response.json();
			expect(JSON.stringify(view)).not.toContain(provider.quotaAccessToken);
			return view;
		};
		await patch({ customApiProviders: [provider] });
		const get = await app.request("/api/settings");
		expect(get.status).toBe(200);
		const [legacy] = (await get.json()).openaiProviders;
		expect(legacy).not.toHaveProperty("quotaAccessToken");
		expect(legacy).not.toHaveProperty("quotaSiteUrl");
		expect(legacy).not.toHaveProperty("quotaUserId");
		const renamed = await patch({ openaiProviders: [{ ...legacy, name: "Renamed" }] });
		expect(renamed.customApiProviders[0]).toMatchObject({ name: "Renamed", quotaUserId: "42" });
		expect(renamed.customApiProviders[0].quotaSiteUrl).toBe(provider.quotaSiteUrl);
		expect(renamed.customApiProviders[0].quotaAccessToken).toMatch(/^\*/);
		expect(store.firstKey(owner)).toBe(provider.quotaAccessToken);
		expect(store.firstKey(provider.id)).toBe(provider.apiKey);
		// A changed tenant on the same origin must not inherit the previous site account.
		const moved = await patch({
			openaiProviders: [{ ...legacy, baseUrl: "https://relay.invalid/tenant-b/v1" }],
		});
		expect(moved.customApiProviders[0].quotaAccessToken).toBe("");
		expect(moved.customApiProviders[0].quotaSiteUrl).toBeUndefined();
		expect(moved.customApiProviders[0].quotaUserId).toBeUndefined();
		expect(store.list(owner)).toEqual([]);
		await patch({ customApiProviders: [provider] });
		await patch({ openaiProviders: [] });
		expect(settings.customApiProviders?.some((p) => p.id === provider.id)).toBe(false);
		expect(store.list(owner)).toEqual([]);
	}, 30_000);

	test.each([
		"site",
		"tenant",
		"account",
		"invalid",
	] as const)("a masked site token is not reused after changing the %s in a unified PATCH", async (change) => {
		const { settingsRoutes } = await import("../settings");
		const app = appForRole("admin").route("/api/settings", settingsRoutes);
		const provider = {
			...config(),
			quotaSiteUrl: "https://quota.invalid/tenant-a",
			quotaUserId: "42",
			quotaAccessToken: "unified-fixture-secret",
		};
		const patch = async (value: CustomApiProviderConfig) => {
			const response = await app.request("/api/settings", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ customApiProviders: [value] }),
			});
			expect(response.status).toBe(200);
			const view = await response.json();
			expect(JSON.stringify(view)).not.toContain(provider.quotaAccessToken);
			return view.customApiProviders[0] as CustomApiProviderConfig;
		};
		const masked = await patch(provider);
		expect(masked.quotaAccessToken).toMatch(/^\*/);
		const moved = { ...masked };
		if (change === "site") moved.quotaSiteUrl = "https://other.invalid/tenant-a";
		if (change === "tenant") moved.quotaSiteUrl = "https://quota.invalid/tenant-b";
		if (change === "account") moved.quotaUserId = "43";
		if (change === "invalid") moved.quotaSiteUrl = "not an HTTP URL";
		expect((await patch(moved)).quotaAccessToken).toBe("");
		expect(getProviderKeyStore().list(quotaKeyOwner(provider.id))).toEqual([]);
		expect(getProviderKeyStore().firstKey(provider.id)).toBe(provider.apiKey);
	}, 30_000);
	test("settings generation and legacy endpoint represent the identical selected subject", async () => {
		const { settingsRoutes } = await import("../settings");
		await fixture.service.refresh(config().id);
		const setting = await (
			await appForRole("admin").route("/api/settings", settingsRoutes).request("/api/settings")
		).json();
		const route = await (await appForRole("user").request("/api/provider-balances")).json();
		expect(setting.providerBalanceGenerations[config().id]).toBe(route[config().id].generation);
		expect(setting.providerQuotaGenerations[config().id]).toBe(route[config().id].generation);
		expect(route[config().id].status).toBe("supported");
	}, 30000);
	test("disabled quota capability reports plugin_not_enabled at every legacy entry point", async () => {
		await fixture.service.refresh(config().id);
		fixture.revoke();
		const count = fixture.query.mock.calls.length;
		const response = await appForRole("user").request("/api/provider-balances");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			[config().id]: { status: "error", error: "plugin_not_enabled", balance: null },
		});
		expect(providerBalanceCache.peek(config().id)).toMatchObject({
			status: "error",
			error: "plugin_not_enabled",
			balance: null,
		});
		expect(fixture.query).toHaveBeenCalledTimes(count);
		expect(outbound.outboundFetch).not.toHaveBeenCalled();
	});
	test("saving new or replaced credentials reconciles once, never waits, and projects the same generations", async () => {
		const { settingsRoutes } = await import("../settings");
		settings.customApiProviders = [];
		fixture.service.sync();
		fixture.query.mockImplementation(() => new Promise(() => {}));
		const app = appForRole("admin");
		app.route("/api/settings", settingsRoutes);
		const patch = async (value: CustomApiProviderConfig) => {
			const response = await app.request("/api/settings", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ customApiProviders: [value] }),
			});
			expect(response.status).toBe(200);
			const result = await response.json();
			expect(result.providerQuotaGenerations[config().id]).toBe(
				result.providerBalanceGenerations[config().id],
			);
			return result.providerQuotaGenerations[config().id] as string;
		};
		const generation = await patch(config());
		expect(generation).toMatch(/^[\da-f-]{36}$/);
		expect(fixture.query).toHaveBeenCalledTimes(1);
		expect(await patch({ ...config(), name: "Renamed" })).toBe(generation);
		expect(fixture.query).toHaveBeenCalledTimes(1);
		expect(await patch(config("key-replaced"))).not.toBe(generation);
		expect(fixture.query).toHaveBeenCalledTimes(2);
		expect(fixture.query.mock.calls[1]?.[1]).toMatchObject({ providerId: config().id });
		expect(JSON.stringify(fixture.query.mock.calls)).not.toMatch(/key-current|key-replaced/);
	}, 30_000);

	test("a saved account switch drops old data and rejects a late reply from the previous generation", async () => {
		const { settingsRoutes } = await import("../settings");
		await fixture.service.refresh(config().id);
		const generation = fixture.service.generations()[config().id];
		fixture.advance(10_000);
		const oldReply = deferred<QuotaQueryResult>();
		const newReply = deferred<QuotaQueryResult>();
		fixture.query
			.mockImplementationOnce(() => oldReply.promise)
			.mockImplementation(() => newReply.promise);
		const oldRefresh = fixture.service.refresh(config().id);
		const app = appForRole("admin").route("/api/settings", settingsRoutes);
		const response = await app.request("/api/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ customApiProviders: [config("key-replaced")] }),
		});
		expect(response.status).toBe(200);
		const changed = (await response.json()).providerQuotaGenerations[config().id];
		expect(changed).not.toBe(generation);
		expect(fixture.service.peek(config().id)).toMatchObject({ generation: changed, data: null });
		expect(fixture.query).toHaveBeenCalledTimes(3);
		oldReply.resolve({ status: "supported", data: walletQuota, error: null });
		expect(await oldRefresh).toBeNull();
		expect(fixture.service.peek(config().id)).toMatchObject({ generation: changed, data: null });
		newReply.resolve({
			status: "supported",
			data: {
				...walletQuota,
				amounts: [{ id: "amount:0", unit: "USD", remaining: 77 }],
			},
			error: null,
		});
		await fixture.service.refresh(config().id);
		expect(providerBalanceCache.peek(config().id)).toMatchObject({
			generation: changed,
			balance: { amounts: [{ remaining: 77 }] },
		});
	}, 30_000);

	test("saving disabled or removed providers cancels shared source work and hides their quotas", async () => {
		const { settingsRoutes } = await import("../settings");
		fixture.query.mockImplementation(() => new Promise(() => {}));
		const pending = fixture.service.refresh(config().id);
		const app = appForRole("admin").route("/api/settings", settingsRoutes);
		for (const customApiProviders of [[{ ...config(), disabled: true }], []]) {
			const response = await app.request("/api/settings", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ customApiProviders }),
			});
			expect(response.status).toBe(200);
			expect((await response.json()).providerQuotaGenerations).toEqual({});
			expect(fixture.service.peek(config().id)).toBeNull();
		}
		expect(await pending).toBeNull();
		expect(fixture.query).toHaveBeenCalledTimes(1);
	}, 30_000);

	test("stream-pushed Custom API quotas remain independent and still purge on identity changes", async () => {
		const { settingsRoutes } = await import("../settings");
		updateCustomApiQuotaByPrefix(config().prefix, "42 credits", "stream-only details");
		const pushed = getCustomApiCachedQuota(config().id);
		await fixture.service.refresh(config().id);
		fixture.revoke();
		expect(getCustomApiCachedQuota(config().id)).toEqual(pushed);
		const app = appForRole("admin").route("/api/settings", settingsRoutes);
		const current = await (await app.request("/api/settings")).json();
		expect(current.customApiQuotas[config().id]).toMatchObject({
			quotaBalance: "42 credits",
			detailedQuotaBalance: "stream-only details",
		});
		const changed = await app.request("/api/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ customApiProviders: [config("key-replaced")] }),
		});
		expect(changed.status).toBe(200);
		expect((await changed.json()).customApiQuotas[config().id]).toBeUndefined();
		expect(getCustomApiCachedQuota(config().id)).toBeUndefined();
		expect(fixture.query).toHaveBeenCalledTimes(1);
	}, 30_000);

	test("the one-click base URL repair reconciles and warms the real quota service", async () => {
		const { settingsRoutes } = await import("../settings");
		settings.customApiProviders = [{ ...config(), baseUrl: "https://relay.invalid" }];
		await fixture.service.refresh(config().id);
		const generation = fixture.service.generations()[config().id];
		fixture.query.mockImplementation(() => new Promise(() => {}));
		const app = appForRole("admin").route("/api/settings", settingsRoutes);
		const repair = () =>
			app.request("/api/settings/fix-provider-baseurl", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ providerId: config().id }),
			});
		const response = await repair();
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, baseUrl: "https://relay.invalid/v1" });
		expect(fixture.service.generations()[config().id]).not.toBe(generation);
		expect(fixture.service.peek(config().id)?.data).toBeNull();
		expect(fixture.query).toHaveBeenCalledTimes(2);
		expect(fixture.query.mock.calls[1]?.[1]).toMatchObject({
			providerId: config().id,
			baseUrl: "https://relay.invalid/v1",
		});
		expect((await repair()).status).toBe(200);
		expect(fixture.query).toHaveBeenCalledTimes(2);
	}, 30_000);

	test("settings gives users and admins matching opaque tokens without persisting them", async () => {
		const { settingsRoutes } = await import("../settings");
		const admin = appForRole("admin").route("/api/settings", settingsRoutes);
		const user = appForRole("user").route("/api/settings", settingsRoutes);
		const a = await (await admin.request("/api/settings")).json();
		const u = await (await user.request("/api/settings")).json();
		expect(u.providerQuotaGenerations).toEqual(a.providerQuotaGenerations);
		expect(a.providerBalanceGenerations).toEqual(a.providerQuotaGenerations);
		expect(settings).not.toHaveProperty("providerQuotaGenerations");
		expect(JSON.stringify(a.providerQuotaGenerations)).not.toMatch(/key-current|relay\.invalid/);
	}, 30_000);

	test("a rejected settings save cannot start quota discovery", async () => {
		const { settingsRoutes } = await import("../settings");
		const app = appForRole("admin").route("/api/settings", settingsRoutes);
		const response = await app.request("/api/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ customApiProviders: [{ ...config(), protocol: "invalid-protocol" }] }),
		});
		expect(response.status).toBe(400);
		expect(fixture.query).not.toHaveBeenCalled();
	}, 30_000);
});
