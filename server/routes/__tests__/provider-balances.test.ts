import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { QuotaQueryResult } from "@shared/provider-quota";
import type { QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import { parseSub2ApiBalance, relayQuotaData } from "../../../plugins/provider-quota/src/relay";
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
import { streamQuotaIdentityForRequest } from "../../lib/provider-key-subjects";
import { getProviderKeyStore } from "../../lib/provider-keys";
import { type CustomApiProviderConfig, saveSettings, settings } from "../../lib/settings";
import { quotaKeyOwner } from "../../lib/settings/provider-keys-projection";
import { quotaStore, STREAM_QUOTA_SOURCE } from "../../lib/sourcing/quota-store";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";
import { providerBalanceRoutes } from "../provider-balances";
import { quotaSnapshotRoutes } from "../quota-snapshots";

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
	app.use("*", async (c, next) => {
		c.set("user", { sub: `balance-${role}`, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		c.set("auth", { type: "session", user: c.get("user") });
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
	app.route("/api/quota-snapshots", quotaSnapshotRoutes);
	app.route("/api/provider-balances", providerBalanceRoutes);
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
		const request = spyOn(fixture.service, "refresh");
		const response = await appForRole("admin").request(
			`/api/provider-balances/${config().id}/probe`,
			{ method: "POST" },
		);
		expect(response.status).toBe(200);
		expect(request).toHaveBeenCalledWith(config().id, { mode: "probe", manual: true });
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
	for (const expiry of ["past", "future", "unknown"] as const) {
		test(`public subscription periods preserve ${expiry} expiry without unlabelled USD balances`, async () => {
			const expiresAt =
				expiry === "unknown" ? undefined : Date.now() + (expiry === "past" ? -60_000 : 60_000);
			const balance = parseSub2ApiBalance({
				mode: "unrestricted",
				isValid: true,
				unit: "USD",
				planName: "Period plan",
				subscription: {
					daily_limit_usd: 10,
					daily_usage_usd: 2,
					weekly_limit_usd: 50,
					weekly_usage_usd: 50,
					monthly_limit_usd: 0,
					monthly_usage_usd: 0,
					weekly_window_start: "2026-10-19T00:00:00Z",
					...(expiresAt !== undefined ? { expires_at: new Date(expiresAt).toISOString() } : {}),
				},
			});
			if (!balance) throw new Error("missing subscription fixture");
			fixture.query.mockResolvedValue({
				status: "supported",
				data: relayQuotaData(balance, "sub2api"),
				error: null,
			});
			await providerBalanceCache.request(config().id);
			for (const role of ["admin", "user"] as const) {
				const text = await (await appForRole(role).request("/api/quota-snapshots")).text();
				const snapshot = findRelay(JSON.parse(text))?.snapshot;
				expect(snapshot).toMatchObject({
					plan: "Period plan",
					windows: [
						{
							kind: "other",
							label: "Daily limit",
							usedRatio: 0.2,
							resetsAt: null,
							used: 2,
							total: 10,
							remaining: 8,
							unit: "USD",
						},
						{
							kind: "weekly",
							label: "Weekly limit",
							usedRatio: 1,
							resetsAt: null,
							used: 50,
							total: 50,
							remaining: 0,
							unit: "USD",
						},
					],
				});
				expect(snapshot?.windows.some((window) => window.kind === "monthly")).toBe(false);
				if (expiresAt !== undefined) {
					expect(snapshot?.expiresAt).toBe(expiresAt);
					expect((snapshot?.expiresAt ?? Infinity) <= Date.now()).toBe(expiry === "past");
				} else expect(snapshot).not.toHaveProperty("expiresAt");
				expect(snapshot).not.toHaveProperty("detail");
				expect(
					snapshot?.balances.every(
						(amount) => amount.display === "detail" && amount.quota === "none",
					),
				).toBe(true);
				expect(text).not.toMatch(/weekly_window_start|key-current|relay\.invalid/);
			}
		});
	}
	test("primary follows the selected second credential, not the disabled first key", async () => {
		const store = getProviderKeyStore();
		const first = store.list(config().id)[0] ?? store.add(config().id, { apiKey: config().apiKey });
		const second = store.add(config().id, { apiKey: "second-relay-secret" });
		try {
			const provider = settings.customApiProviders?.find((p) => p.id === config().id);
			if (!provider) throw new Error("missing provider");
			updateCustomApiQuotaByPrefix(
				provider.prefix,
				"3",
				null,
				streamQuotaIdentityForRequest(provider.prefix, { credentialId: first.id }),
				fixture.service.peekKey(first.id)?.generation,
			);
			store.update(first.id, { disabled: true });
			updateCustomApiQuotaByPrefix(
				provider.prefix,
				"7",
				null,
				streamQuotaIdentityForRequest(provider.prefix, { credentialId: second.id }),
				fixture.service.peekKey(second.id)?.generation,
			);
			await providerBalanceCache.request(provider.id);
			const admin = (await (
				await appForRole("admin").request("/api/quota-snapshots")
			).json()) as QuotaSnapshotsResponse;
			const entries = admin.entries.filter((entry) => entry.groupId === provider.id);
			expect(
				entries.find((entry) => entry.credentialId === first.id && entry.source === "probe")
					?.primary,
			).toBe(false);
			expect(
				entries
					.filter((entry) => entry.credentialId === first.id)
					.every((entry) => entry.primary === false),
			).toBe(true);
			expect(
				entries.find((entry) => entry.credentialId === second.id && entry.source === "probe"),
			).toMatchObject({ primary: true, snapshot: { balances: [{ unit: "USD", remaining: 12 }] } });
			const user = (await (
				await appForRole("user").request("/api/quota-snapshots")
			).json()) as QuotaSnapshotsResponse;
			const anonymous = user.entries.filter((entry) => entry.groupId === provider.id);
			expect(anonymous.find((entry) => entry.source === "probe")).toMatchObject({
				credentialId: null,
				primary: true,
			});
			expect(anonymous.find((entry) => entry.source === "quota_balance")).toMatchObject({
				credentialId: null,
				primary: true,
				snapshot: { balances: [{ unit: "", remaining: 7 }] },
			});
			expect(anonymous).toHaveLength(2);
			expect(anonymous.every((entry) => entry.credentialId === null)).toBe(true);
			expect(JSON.stringify(anonymous)).not.toContain(second.id);
			expect(JSON.stringify(anonymous)).not.toMatch(/second-relay-secret|key-current|detail/);
			store.update(second.id, { apiKey: "replaced-second-secret" });
			const replaced = (await (
				await appForRole("user").request("/api/quota-snapshots")
			).json()) as QuotaSnapshotsResponse;
			expect(
				replaced.entries.filter(
					(entry) => entry.groupId === provider.id && entry.source === "quota_balance",
				),
			).toEqual([]);
		} finally {
			store.update(first.id, { disabled: false });
			store.remove(second.id);
			quotaStore.remove(first.id, STREAM_QUOTA_SOURCE);
			quotaStore.remove(second.id, STREAM_QUOTA_SOURCE);
		}
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
		expect((await app.request("/api/quota-snapshots")).status).toBe(200);
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
	test("settings generation and unified endpoint represent the identical selected subject", async () => {
		const { settingsRoutes } = await import("../settings");
		await fixture.service.refresh(config().id);
		const setting = await (
			await appForRole("admin").route("/api/settings", settingsRoutes).request("/api/settings")
		).json();
		const route = findRelay(
			await (await appForRole("user").request("/api/quota-snapshots")).json(),
		);
		expect(setting.providerBalanceGenerations[config().id]).toBe(route?.generation);
		expect(setting.providerQuotaGenerations[config().id]).toBe(route?.generation);
		expect(route?.supported).toBe(true);
	}, 30000);
	test("disabled quota capability reports plugin_not_enabled at every legacy entry point", async () => {
		await fixture.service.refresh(config().id);
		fixture.revoke();
		const count = fixture.query.mock.calls.length;
		const response = await appForRole("user").request("/api/quota-snapshots");
		expect(response.status).toBe(200);
		expect(findRelay(await response.json())).toMatchObject({ supported: false, snapshot: null });
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
		updateCustomApiQuotaByPrefix(
			config().prefix,
			"42",
			"stream-only details",
			streamQuotaIdentityForRequest(config().prefix),
			fixture.service.peek(config().id)?.generation,
		);
		expect(getCustomApiCachedQuota(config().id)).toMatchObject({ quotaBalance: "42" });
		await fixture.service.refresh(config().id);
		fixture.revoke();
		expect(getCustomApiCachedQuota(config().id)).toBeUndefined();
		const app = appForRole("admin").route("/api/settings", settingsRoutes);
		const current = await (await app.request("/api/settings")).json();
		expect(current).not.toHaveProperty("customApiQuotas");
		expect(findRelay(await (await app.request("/api/quota-snapshots")).json())).toMatchObject({
			supported: false,
			snapshot: null,
		});
		const changed = await app.request("/api/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ customApiProviders: [config("key-replaced")] }),
		});
		expect(changed.status).toBe(200);
		expect(await changed.json()).not.toHaveProperty("customApiQuotas");
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
