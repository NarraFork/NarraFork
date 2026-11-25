import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { QuotaSnapshot, QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import { Hono } from "hono";
import { getCodexManager } from "../../lib/codex-manager";
import * as commandAuth from "../../lib/commandcode-manager";
import * as customQuota from "../../lib/custom-api-quota-cache";
import { updateCustomApiQuotaByPrefix } from "../../lib/custom-api-quota-cache";
import { AppError } from "../../lib/errors";
import { kimiQuotaIdentity } from "../../lib/kimi-usage-cache";
import * as outbound from "../../lib/net/outbound-fetch";
import { providerBalanceCache } from "../../lib/provider-balance-cache";
import { streamQuotaIdentity } from "../../lib/provider-key-subjects";
import {
	getProviderKeyStore,
	TOKENDANCE_KEY_OWNER,
	withProviderKey,
} from "../../lib/provider-keys";
import { type CustomApiProviderConfig, saveSettings, settings } from "../../lib/settings";
import {
	publicQuotaSnapshot,
	readQuotaSnapshots,
	refreshCommandCodeCliQuota,
	waitForTokenDanceQuotaRefresh,
} from "../../lib/sourcing/quota-snapshots";
import { quotaStore, STREAM_QUOTA_SOURCE } from "../../lib/sourcing/quota-store";
import * as templates from "../../lib/sourcing/templates";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";
import { pluginProviderRegistry } from "../../services/plugin-provider-registry";
import * as tokenDance from "../../services/tokendance-service";
import { quotaSnapshotRoutes } from "../quota-snapshots";

const saved = structuredClone(settings);
const pluginId = "com.example.quota-test";
const config = (id = "quota-kimi", apiKey = "quota-secret"): CustomApiProviderConfig => ({
	id,
	name: id,
	prefix: id,
	apiKey,
	baseUrl: "https://api.kimi.com/coding/v1",
	protocol: "completions-compatible",
	defaultModel: "test-model",
});
const snap = (usedRatio = 0.25): QuotaSnapshot => ({
	fetchedAt: Date.now(),
	scope: "subscription",
	windows: [{ kind: "5h", usedRatio, resetsAt: null }],
	balances: [],
	detail: { secret: "private-account@example.com", headers: "Bearer quota-secret" },
});
function app(role?: "admin" | "user") {
	const result = new Hono();
	if (role)
		result.use("*", async (c, next) => {
			c.set("user", { sub: `quota-${role}`, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
			c.set("auth", { type: "session", user: c.get("user") });
			await next();
		});
	result.onError((error) => {
		if (error instanceof AppError)
			return Response.json({ error: error.code }, { status: error.statusCode });
		throw error;
	});
	result.route("/api/quota-snapshots", quotaSnapshotRoutes);
	return result;
}
const byGroup = (response: QuotaSnapshotsResponse, groupId: string) =>
	response.entries.filter((entry) => entry.groupId === groupId);
const refresh = (role: "admin" | "user", body: unknown) =>
	app(role).request("/api/quota-snapshots/refresh", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
	const store: AuthSessionStore = {
		...authSessionStore,
		findSessionState: async (id) => ({
			id,
			role: id === "quota-admin" ? "admin" : "user",
			tokenVersion: 0,
		}),
	};
	setAuthStores({ session: store, mfa: authMfaStore });
	saveSettings({
		...settings,
		customApiProviders: [],
		nugProviders: [],
		commandCode: { apiKey: "", disabled: true },
		tokendance: { apiKey: "", generation: 0, disabled: true },
	});
	providerBalanceCache.sync();
});
afterEach(() => {
	mock.restore();
	pluginProviderRegistry.removePlugin(pluginId);
	const manager = getCodexManager();
	if (Object.hasOwn(manager, "quotaCredentialIds"))
		Reflect.deleteProperty(manager, "quotaCredentialIds");
	saveSettings(structuredClone(saved));
	providerBalanceCache.sync();
	setAuthStores(undefined);
});

describe("unified quota API", () => {
	test("public period amounts retain finite values and currency without private data", () => {
		const window = {
			kind: "other" as const,
			label: "daily",
			usedRatio: 1,
			resetsAt: null,
			used: 12,
			total: 10,
			remaining: -2,
			unit: "USD",
		};
		const raw = {
			...snap(),
			windows: [
				{
					...window,
					detail: { secret: "private-window" },
					headers: { Authorization: "secret-token" },
				},
			],
		};
		expect(publicQuotaSnapshot(raw)?.windows).toEqual([window]);
		const invalid = {
			...raw,
			windows: [
				{
					...window,
					used: NaN,
					total: Infinity,
					remaining: -Infinity,
					unit: { secret: "private-unit" },
				},
			],
		} as unknown as QuotaSnapshot;
		const projected = publicQuotaSnapshot(invalid);
		expect(projected?.windows).toEqual([
			{ kind: "other", label: "daily", usedRatio: 1, resetsAt: null },
		]);
		expect(JSON.stringify(publicQuotaSnapshot(raw))).not.toMatch(
			/private-window|secret-token|detail|headers|Authorization/,
		);
	});
	test("anonymous callers cannot read or refresh", async () => {
		expect((await app().request("/api/quota-snapshots")).status).toBe(401);
		expect(
			(await app().request("/api/quota-snapshots/refresh", { method: "POST", body: "{}" })).status,
		).toBe(401);
	});
	test("admin enumerates every credential but ordinary users retain one anonymous allowance per group", () => {
		saveSettings({ ...settings, customApiProviders: [config()] });
		const keys = getProviderKeyStore();
		const first = keys.list("quota-kimi")[0];
		const second = keys.add("quota-kimi", { apiKey: "second-secret" });
		const provider = settings.customApiProviders?.find((entry) => entry.id === "quota-kimi");
		if (!provider) throw new Error("missing fixture");
		try {
			quotaStore.set(
				first.id,
				kimiQuotaIdentity(withProviderKey(provider, first)),
				snap(0.25),
				false,
			);
			quotaStore.set(
				second.id,
				kimiQuotaIdentity(withProviderKey(provider, second)),
				snap(0.9),
				false,
			);
			const admin = byGroup(readQuotaSnapshots(true, false), "quota-kimi");
			expect(admin.map((entry) => entry.credentialId)).toEqual([first.id, second.id]);
			expect(admin.map((entry) => entry.snapshot?.windows[0]?.usedRatio)).toEqual([0.25, 0.9]);
			const user = byGroup(readQuotaSnapshots(false, false), "quota-kimi");
			expect(user).toHaveLength(1);
			expect(user[0]).toMatchObject({
				credentialId: null,
				snapshot: { windows: [{ usedRatio: 0.25 }] },
			});
			expect(JSON.stringify({ admin, user })).not.toMatch(
				/quota-secret|second-secret|private-account|headers|detail/,
			);
		} finally {
			keys.remove(second.id);
			quotaStore.remove(first.id);
			quotaStore.remove(second.id);
		}
	});
	test("probe and stream slots coexist and replaced secrets invalidate both", () => {
		saveSettings({ ...settings, customApiProviders: [config("quota-stream")] });
		const provider = settings.customApiProviders?.find(
			(provider) => provider.id === "quota-stream",
		);
		if (!provider) throw new Error("missing fixture");
		const key = getProviderKeyStore().list(provider.id)[0];
		const id = key.id;
		quotaStore.set(id, kimiQuotaIdentity(withProviderKey(provider, key)), snap(), false);
		updateCustomApiQuotaByPrefix(
			provider.prefix,
			"12.5",
			"private-detail",
			streamQuotaIdentity(provider),
		);
		const entries = byGroup(readQuotaSnapshots(true, false), provider.id);
		expect(entries.map((entry) => entry.source)).toEqual(["probe", "quota_balance"]);
		expect(entries[0].snapshot?.windows[0]?.usedRatio).toBe(0.25);
		expect(entries[1].snapshot?.balances[0]?.remaining).toBe(12.5);
		expect(JSON.stringify(entries)).not.toContain("private-detail");
		saveSettings({ ...settings, customApiProviders: [config(provider.id, "replacement-secret")] });
		expect(byGroup(readQuotaSnapshots(true, false), provider.id)).toMatchObject([
			{ snapshot: null },
		]);
		quotaStore.remove(id);
		quotaStore.remove(id, STREAM_QUOTA_SOURCE);
	});
	test("plugin unsupported and unprobed allowance stay null, never synthetic zero", () => {
		pluginProviderRegistry.register({
			kind: "executable-plugin",
			pluginId,
			localId: "demo",
			providerInstanceId: `${pluginId}/demo`,
			providerPrefix: "quota-plugin",
			displayName: "Plugin",
		});
		saveSettings({ ...settings, customApiProviders: [config("quota-cold")] });
		expect(byGroup(readQuotaSnapshots(true, false), `${pluginId}/demo`)).toMatchObject([
			{ supported: false, snapshot: null },
		]);
		expect(byGroup(readQuotaSnapshots(true, false), "quota-cold")).toMatchObject([
			{ snapshot: null },
		]);
	});
	test("all roles receive safe fixed errors and no upstream payload", async () => {
		saveSettings({ ...settings, customApiProviders: [config("quota-error")] });
		const key = getProviderKeyStore().list("quota-error")[0];
		const provider = settings.customApiProviders?.find((entry) => entry.id === "quota-error");
		if (!provider) throw new Error("missing fixture");
		const id = key.id;
		quotaStore.set(
			id,
			kimiQuotaIdentity(withProviderKey(provider, key)),
			{
				...snap(),
				error:
					"key quota-secret rejected for private-account@example.com at https://internal/usage",
			},
			false,
		);
		for (const role of ["admin", "user"] as const) {
			const response = await app(role).request("/api/quota-snapshots");
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			const text = await response.text();
			expect(text).not.toMatch(/quota-secret|private-account|internal\/usage|headers|detail/);
			expect(byGroup(JSON.parse(text), "quota-error")[0].snapshot).toMatchObject({
				hasError: true,
				error: "quota_unavailable",
			});
		}
		quotaStore.remove(id);
	});
	test("both roles receive the fixed plugin-disabled code without private quota detail", async () => {
		saveSettings({ ...settings, customApiProviders: [config("quota-plugin-code")] });
		const key = getProviderKeyStore().list("quota-plugin-code")[0];
		const provider = settings.customApiProviders?.find((entry) => entry.id === "quota-plugin-code");
		if (!provider) throw new Error("missing fixture");
		const id = key.id;
		quotaStore.set(
			id,
			kimiQuotaIdentity(withProviderKey(provider, key)),
			{ ...snap(), error: "plugin_not_enabled" },
			false,
		);
		try {
			for (const role of ["admin", "user"] as const) {
				const response = await app(role).request(
					"/api/quota-snapshots?groupId=quota-plugin-code&cachedOnly=true",
				);
				expect(response.status).toBe(200);
				const text = await response.text();
				expect(byGroup(JSON.parse(text), "quota-plugin-code")[0].snapshot).toMatchObject({
					hasError: true,
					error: "plugin_not_enabled",
				});
				expect(text).not.toMatch(/quota-secret|private-account|headers|detail/);
			}
		} finally {
			quotaStore.remove(id);
		}
	});

	test("cold GET returns immediately and repeated reads share the original source refresh", async () => {
		saveSettings({ ...settings, customApiProviders: [config("quota-hanging")] });
		let finish!: (response: Response) => void;
		const upstream = new Promise<Response>((resolve) => {
			finish = resolve;
		});
		const transport = spyOn(outbound, "outboundFetch").mockImplementation(() => upstream);
		try {
			const first = await app("user").request("/api/quota-snapshots");
			expect(first.status).toBe(200);
			expect(byGroup(await first.json(), "quota-hanging")[0].snapshot).toBeNull();
			expect((await app("user").request("/api/quota-snapshots")).status).toBe(200);
			expect(transport).toHaveBeenCalledTimes(1);
		} finally {
			finish(Response.json({ fiveHour: { used: 1, limit: 4, remaining: 3, resetTime: null } }));
			const { refreshAllKimiUsages } = await import("../../lib/kimi-usage-cache");
			await refreshAllKimiUsages();
		}
	});
	test("normal refresh is administrator-only; filters are validated and cannot become URLs", async () => {
		expect((await refresh("user", {})).status).toBe(403);
		expect((await refresh("admin", { groupId: "https://evil.invalid" })).status).toBe(404);
		expect((await refresh("admin", { credentialId: "missing" })).status).toBe(404);
		expect((await refresh("admin", { apiKey: "secret" })).status).toBe(400);
		expect((await refresh("admin", { groupId: "x".repeat(2048) })).status).toBe(413);
	});
	test("TokenDance overview and both primary slots stay with the portal login after pool reorder", () => {
		saveSettings({
			...settings,
			tokendance: { apiKey: "portal-login", generation: 0, disabled: false },
		});
		const store = getProviderKeyStore();
		const login = store.list(TOKENDANCE_KEY_OWNER)[0];
		if (!login) throw new Error("Missing portal login key");
		const backup = store.add(TOKENDANCE_KEY_OWNER, { apiKey: "inference-backup" });
		store.reorder(TOKENDANCE_KEY_OWNER, [backup.id, login.id]);
		spyOn(tokenDance, "getTokenDanceQuotaSnapshot").mockReturnValue({
			credentialId: login.id,
			snapshot: { ...snap(), balances: [{ unit: "CNY", remaining: 7 }] },
		});
		spyOn(customQuota, "getCustomApiQuotaSnapshot").mockImplementation((groupId, credentialId) =>
			groupId === "tokendance" && credentialId === login.id
				? { ...snap(), balances: [{ unit: "CNY", remaining: 6 }] }
				: undefined,
		);
		const overview = byGroup(readQuotaSnapshots(false, false), "tokendance");
		expect(overview.map((entry) => entry.source)).toEqual(["probe", "quota_balance"]);
		expect(overview.map((entry) => entry.snapshot?.balances[0]?.remaining)).toEqual([7, 6]);
		expect(overview.every((entry) => entry.primary === true && entry.credentialId === null)).toBe(
			true,
		);
		const entries = byGroup(readQuotaSnapshots(true, false), "tokendance");
		expect(
			entries.filter((entry) => entry.primary).every((entry) => entry.credentialId === login.id),
		).toBe(true);
		expect(entries.find((entry) => entry.credentialId === backup.id)?.primary).toBe(false);
	});

	test("explicit TokenDance refresh waits for the new balance instead of returning a stale failure", async () => {
		saveSettings({
			...settings,
			tokendance: { apiKey: "td-private", generation: 0, disabled: false },
		});
		const id = getProviderKeyStore().list(TOKENDANCE_KEY_OWNER)[0].id;
		let snapshot = { ...snap(), error: "old failure", balances: [] };
		spyOn(tokenDance, "getTokenDanceQuotaSnapshot").mockImplementation(() => ({
			credentialId: id,
			snapshot,
		}));
		let finish!: () => void;
		let started!: () => void;
		const began = new Promise<void>((resolve) => {
			started = resolve;
		});
		spyOn(tokenDance, "refreshTokenDanceBalance").mockImplementation(() => {
			started();
			return new Promise((resolve) => {
				finish = () => {
					snapshot = { ...snap(), error: "", balances: [] };
					resolve({
						generation: 0,
						credits: 2_000_000,
						creditsUsed: 1_000_000,
						balance: 1_000_000,
						updatedAt: Date.now(),
						loading: false,
						hasError: false,
					});
				};
			});
		});
		let settled = false;
		const request = Promise.resolve(refresh("admin", { groupId: "tokendance" })).then(
			(response) => {
				settled = true;
				return response;
			},
		);
		await began;
		expect(settled).toBe(false);
		finish();
		const response = await request;
		expect(response.status).toBe(200);
		expect(byGroup(await response.json(), "tokendance")[0].snapshot?.hasError).toBe(false);
	});
	test("explicit TokenDance refresh propagates a source failure instead of succeeding with stale balance", async () => {
		saveSettings({
			...settings,
			tokendance: { apiKey: "td-private", generation: 0, disabled: false },
		});
		spyOn(tokenDance, "refreshTokenDanceBalance").mockRejectedValue(
			new AppError("Balance unavailable", 502, "BALANCE_UNAVAILABLE"),
		);
		const response = await refresh("admin", { groupId: "tokendance" });
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "BALANCE_UNAVAILABLE" });
	});
	test("TokenDance waiting can be cancelled without waiting for a stalled source", async () => {
		const controller = new AbortController();
		const waiting = waitForTokenDanceQuotaRefresh(new Promise(() => {}), controller.signal);
		controller.abort();
		await expect(waiting).rejects.toHaveProperty("code", "QUOTA_REFRESH_CANCELLED");
	});
	test("TokenDance waiting has a controlled deadline even when the source never settles", async () => {
		let expire: (() => void) | undefined;
		const nativeTimeout = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: () => void,
			ms: number,
		) => {
			if (ms === 15_000) expire = callback;
			return nativeTimeout(callback, ms);
		}) as typeof setTimeout);
		try {
			const waiting = waitForTokenDanceQuotaRefresh(new Promise(() => {}));
			expire?.();
			await expect(waiting).rejects.toHaveProperty("code", "QUOTA_REFRESH_TIMEOUT");
		} finally {
			timer.mockRestore();
		}
	});
	test("ordinary Codex API aggregates Plus five-hour and Team monthly plans by applicable window", async () => {
		const manager = getCodexManager();
		Object.defineProperty(manager, "quotaCredentialIds", {
			configurable: true,
			value: ["private-plus", "private-team"],
		});
		spyOn(manager, "usageOf").mockImplementation((id) => ({
			plan_type: id === "private-plus" ? "plus" : "team",
			queriedAt: new Date().toISOString(),
			primary_window:
				id === "private-plus"
					? {
							window_type: "5h",
							limit_window_seconds: 18000,
							used_percent: 20,
							remaining_percent: 80,
							reset_at: 1800000000,
							reset_after_seconds: 100,
						}
					: {
							window_type: "monthly",
							limit_window_seconds: 30 * 86400,
							used_percent: 70,
							remaining_percent: 30,
							reset_at: 1800000000,
							reset_after_seconds: 100,
						},
		}));
		const response = await app("user").request("/api/quota-snapshots");
		expect(response.status).toBe(200);
		const text = await response.text();
		const entry = byGroup(JSON.parse(text), "codex")[0];
		expect(entry).toMatchObject({
			credentialId: null,
			snapshot: {
				balances: [],
				windows: [
					{ kind: "5h", usedRatio: 0.2, resetsAt: 1800000000000 },
					{ kind: "monthly", usedRatio: 0.7, resetsAt: 1800000000000 },
				],
			},
		});
		expect(text).not.toMatch(/private-plus|private-team|"plan"|detail|accountId/);
	});
	test.each([
		false,
		true,
	])("unclassified Codex duration leaves known five-hour coverage unknown (also monthly: %s)", async (hasMonthly) => {
		const manager = getCodexManager();
		Object.defineProperty(manager, "quotaCredentialIds", {
			configurable: true,
			value: ["known-five-hour", "unknown-duration"],
		});
		spyOn(manager, "usageOf").mockImplementation((id) => ({
			plan_type: "team",
			queriedAt: new Date().toISOString(),
			primary_window:
				id === "known-five-hour"
					? {
							window_type: "5h",
							limit_window_seconds: 18000,
							used_percent: 20,
							remaining_percent: 80,
							reset_at: 1800000000,
							reset_after_seconds: 100,
						}
					: {
							window_type: "unknown",
							limit_window_seconds: 12345,
							used_percent: 60,
							remaining_percent: 40,
							reset_at: 1800000000,
							reset_after_seconds: 100,
						},
			...(id === "unknown-duration" && hasMonthly
				? {
						secondary_window: {
							window_type: "monthly" as const,
							limit_window_seconds: 30 * 86400,
							used_percent: 70,
							remaining_percent: 30,
							reset_at: 1800000000,
							reset_after_seconds: 100,
						},
					}
				: {}),
		}));
		const response = await app("user").request("/api/quota-snapshots");
		expect(response.status).toBe(200);
		const entry = byGroup(await response.json(), "codex")[0];
		expect(entry.snapshot?.windows.find((window) => window.kind === "5h")?.usedRatio).toBeNull();
		expect(entry.snapshot?.windows.find((window) => window.kind === "other")?.usedRatio).toBeNull();
		if (hasMonthly)
			expect(entry.snapshot?.windows.find((window) => window.kind === "monthly")?.usedRatio).toBe(
				0.7,
			);
	});
	test("Codex custom windows aggregate by label, with unnamed and null-ratio coverage kept unknown", () => {
		const manager = getCodexManager();
		Object.defineProperty(manager, "quotaCredentialIds", { configurable: true, value: ["a", "b"] });
		const data: Record<string, QuotaSnapshot> = {
			a: {
				...snap(),
				windows: [
					{ kind: "5h", usedRatio: 0.2, resetsAt: null },
					{ kind: "other", label: "review", usedRatio: 0.1, resetsAt: null },
					{ kind: "other", label: "special", usedRatio: null, resetsAt: null },
					{ kind: "other", usedRatio: 0.2, resetsAt: null },
				],
			},
			b: {
				...snap(),
				windows: [
					{ kind: "monthly", usedRatio: 0.7, resetsAt: null },
					{ kind: "other", label: "review", usedRatio: 0.3, resetsAt: null },
					{ kind: "other", label: "special", usedRatio: 0.5, resetsAt: null },
					{ kind: "other", usedRatio: 0.8, resetsAt: null },
				],
			},
		};
		const original = templates.getServiceTemplate;
		const codex = original("codex");
		spyOn(templates, "getServiceTemplate").mockImplementation((id) =>
			id === "codex"
				? { ...codex, projectQuota: (credentialId) => data[credentialId] }
				: original(id),
		);
		const entry = byGroup(readQuotaSnapshots(false, false), "codex")[0];
		expect(entry.snapshot?.windows).toEqual([
			{ kind: "5h", usedRatio: null, resetsAt: null },
			{ kind: "other", label: "review", usedRatio: 0.2, resetsAt: null },
			{ kind: "other", label: "special", usedRatio: null, resetsAt: null },
			{ kind: "other", usedRatio: null, resetsAt: null },
			{ kind: "monthly", usedRatio: null, resetsAt: null },
		]);
	});
	test.each([
		"missing",
		"empty",
	] as const)("anonymous Codex projection keeps %s account coverage unknown without exposing accounts", (coverage) => {
		const manager = getCodexManager();
		Object.defineProperty(manager, "quotaCredentialIds", {
			configurable: true,
			value: ["codex-private-a", "codex-private-b"],
		});
		spyOn(manager, "usageOf").mockImplementation((id) =>
			id === "codex-private-a"
				? {
						plan_type: "pro",
						queriedAt: new Date().toISOString(),
						primary_window: {
							window_type: "5h",
							limit_window_seconds: 18000,
							used_percent: 30,
							remaining_percent: 70,
							reset_at: 1800000000,
							reset_after_seconds: 100,
						},
					}
				: coverage === "missing"
					? undefined
					: { plan_type: "team", queriedAt: new Date().toISOString() },
		);
		const status = spyOn(manager, "snapshot");
		const getUsage = spyOn(manager, "getUsage");
		const user = byGroup(readQuotaSnapshots(false, false), "codex");
		expect(user).toHaveLength(1);
		expect(user[0]).toMatchObject({
			credentialId: null,
			snapshot: { balances: [], windows: [{ usedRatio: null }] },
		});
		expect(JSON.stringify(user)).not.toMatch(/codex-private|"plan"|account|email/);
		expect(status).not.toHaveBeenCalled();
		expect(getUsage).not.toHaveBeenCalled();
		expect(
			byGroup(readQuotaSnapshots(true, false), "codex").map((entry) => entry.credentialId),
		).toEqual(["codex-private-a", "codex-private-b"]);
	});
});

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
	return spyOn(globalThis, "fetch").mockImplementation(handler as typeof fetch);
}

function mockCli() {
	saveSettings({ ...settings, commandCode: { apiKey: "", disabled: false } });
	return spyOn(commandAuth, "resolveCommandCodeToken").mockReturnValue({
		credential: { token: "cli-private-token", source: "cli", userName: "Private CLI account" },
	});
}
const cliBody = (input: RequestInfo | URL) =>
	String(input).endsWith("/alpha/usage/summary")
		? { totalCount: 2, totalTokens: 10 }
		: {
				credits: {
					monthlyCredits: 10,
					purchasedCredits: 5,
					freeCredits: 0,
					creditThreshold: 0,
					belowThreshold: false,
				},
				windowLimits: { fiveHour: { used: 1, cap: 5, exceeded: false }, limited: false },
			};

describe("uncached Command Code CLI quota", () => {
	for (const change of ["settings-key", "cli-token", "base-url", "disabled"] as const) {
		test(`late CLI allowance is discarded after changing ${change}`, async () => {
			const auth = mockCli();
			let started!: () => void;
			let finish!: () => void;
			const began = new Promise<void>((resolve) => {
				started = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				finish = resolve;
			});
			stubFetch(async (input) => {
				if (String(input).endsWith("/alpha/billing/credits")) {
					started();
					await gate;
				}
				return Response.json(cliBody(input));
			});
			const initial = byGroup(readQuotaSnapshots(true, false), "CommandCode")[0];
			expect(initial.refreshOnRead).toBe(true);
			expect(initial.generation).toMatch(/^[a-f0-9]{64}$/);
			expect(initial.generation).not.toContain("cli-private-token");
			const request = refresh("admin", { groupId: "CommandCode" });
			await began;
			if (change === "cli-token")
				auth.mockReturnValue({ credential: { token: "new-private-token", source: "cli" } });
			else
				saveSettings({
					...settings,
					commandCode: {
						...settings.commandCode,
						...(change === "settings-key"
							? { apiKey: "new-settings-key" }
							: change === "base-url"
								? { baseUrl: "https://new-cli.invalid/v1" }
								: { disabled: true }),
					},
				});
			finish();
			const response = await request;
			expect(response.status).toBe(200);
			const entry = byGroup(await response.json(), "CommandCode")[0];
			expect(entry.snapshot).toBeNull();
			if (change === "settings-key") {
				expect(entry.credentialId).not.toBeNull();
				expect(entry.refreshOnRead).toBeUndefined();
			}
			if (change === "cli-token" || change === "base-url")
				expect(entry.generation).not.toBe(initial.generation);
		});
	}
	test("GET starts no useless CLI task; explicit session refresh returns a one-shot allowance", async () => {
		mockCli();
		const transport = stubFetch(async (input) => Response.json(cliBody(input)));
		const read = await app("user").request("/api/quota-snapshots");
		expect(byGroup(await read.json(), "CommandCode")[0].snapshot).toBeNull();
		expect(transport).not.toHaveBeenCalled();
		const response = await refresh("user", { groupId: "CommandCode" });
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toMatch(/cli-private-token|Private CLI|summary|detail|headers/);
		expect(byGroup(JSON.parse(text), "CommandCode")[0].snapshot?.balances[0]?.remaining).toBe(10);
		expect(transport).toHaveBeenCalledTimes(2);
		expect(byGroup(readQuotaSnapshots(true, false), "CommandCode")[0].snapshot).toBeNull();
		expect(quotaStore.peek("CommandCode")).toBeUndefined();
	});
	test("concurrent callers deduplicate; one abort cannot cancel the other reader", async () => {
		mockCli();
		let complete!: () => void;
		let underlying: AbortSignal | null | undefined;
		const transport = stubFetch(async (input, init) => {
			underlying = init?.signal;
			if (String(input).endsWith("/alpha/billing/credits"))
				await new Promise<void>((resolve) => {
					complete = resolve;
				});
			return Response.json(cliBody(input));
		});
		const a = new AbortController();
		const b = new AbortController();
		const first = refreshCommandCodeCliQuota(a.signal);
		const second = refreshCommandCodeCliQuota(b.signal);
		a.abort();
		expect(await first).toBeUndefined();
		expect(underlying?.aborted).toBe(false);
		complete();
		expect((await second)?.windows[0]?.usedRatio).toBe(0.2);
		expect(transport).toHaveBeenCalledTimes(2);
	});
	test("last reader cancellation aborts transport and releases the in-flight slot", async () => {
		mockCli();
		let underlying: AbortSignal | null | undefined;
		stubFetch(async (_input, init) => {
			underlying = init?.signal;
			return new Promise<Response>(() => {});
		});
		const reader = new AbortController();
		const task = refreshCommandCodeCliQuota(reader.signal);
		reader.abort();
		expect(await task).toBeUndefined();
		expect(underlying?.aborted).toBe(true);
	});
	test("the entire CLI refresh has a hard budget even if transport ignores cancellation", async () => {
		mockCli();
		const originalTimeout = globalThis.setTimeout;
		spyOn(globalThis, "setTimeout").mockImplementation(((
			handler: TimerHandler,
			delay?: number,
			...args: unknown[]
		) => originalTimeout(handler, delay === 15000 ? 1 : delay, ...args)) as typeof setTimeout);
		stubFetch(async () => new Promise<Response>(() => {}));
		const snapshot = await refreshCommandCodeCliQuota();
		expect(snapshot).toMatchObject({ error: "quota_unavailable", balances: [] });
	});
});

test("admin GET automatically fills both usable Command Code keys through the source owner", async () => {
	const { COMMAND_CODE_KEY_OWNER } = await import("../../lib/provider-keys");
	const { getCommandCodeUsageForCredential } = await import("../../lib/commandcode-usage");
	const keys = getProviderKeyStore();
	saveSettings({
		...settings,
		commandCode: {
			apiKey: "cc-auto-first",
			baseUrl: "https://cc-auto.example/v1",
			disabled: false,
		},
	});
	const first = keys.list(COMMAND_CODE_KEY_OWNER)[0];
	if (!first) throw new Error("missing Command Code fixture");
	const second = keys.add(COMMAND_CODE_KEY_OWNER, { apiKey: "cc-auto-second" });
	const disabled = keys.add(COMMAND_CODE_KEY_OWNER, { apiKey: "cc-auto-disabled" });
	keys.update(disabled.id, { disabled: true });
	const firstGate = Promise.withResolvers<void>();
	const secondGate = Promise.withResolvers<void>();
	const auth: Array<string | null> = [];
	stubFetch(async (input, init) => {
		const header = new Headers(init?.headers).get("Authorization");
		auth.push(header);
		if (header === "Bearer cc-auto-first") await firstGate.promise;
		else if (header === "Bearer cc-auto-second") await secondGate.promise;
		else throw new Error("disabled or foreign Command Code key was probed");
		return Response.json(
			String(input).endsWith("/credits")
				? { credits: { monthlyCredits: header === "Bearer cc-auto-first" ? 3 : 7 } }
				: {},
		);
	});
	let completions: Promise<unknown>[] = [];
	try {
		const cached = await app("admin").request("/api/quota-snapshots?cachedOnly=true");
		expect(cached.status).toBe(200);
		expect(auth).toEqual([]);
		const ordinary = await app("user").request("/api/quota-snapshots");
		expect(ordinary.status).toBe(200);
		expect(auth.length).toBeGreaterThan(0);
		expect(auth.every((header) => header === "Bearer cc-auto-first")).toBe(true);
		const response = await app("admin").request("/api/quota-snapshots");
		expect(response.status).toBe(200);
		const pending = byGroup(await response.json(), "CommandCode");
		expect(pending.find((entry) => entry.credentialId === first.id)?.refreshing).toBe(true);
		expect(pending.find((entry) => entry.credentialId === second.id)?.refreshing).toBe(true);
		expect(pending.find((entry) => entry.credentialId === disabled.id)?.refreshing).toBe(false);
		expect(auth).toContain("Bearer cc-auto-second");
		// Join, rather than create a second scheduler or force a cache-bypassing refresh.
		completions = [
			getCommandCodeUsageForCredential(first.id),
			getCommandCodeUsageForCredential(second.id),
		];
		firstGate.resolve();
		secondGate.resolve();
		await Promise.all(completions);
		const requests = auth.length;
		const settled = await app("admin").request("/api/quota-snapshots");
		const rows = byGroup(await settled.json(), "CommandCode");
		expect(
			rows.find((entry) => entry.credentialId === first.id)?.snapshot?.balances[0]?.remaining,
		).toBe(3);
		expect(
			rows.find((entry) => entry.credentialId === second.id)?.snapshot?.balances[0]?.remaining,
		).toBe(7);
		expect(rows.find((entry) => entry.credentialId === disabled.id)?.snapshot).toBeNull();
		expect(auth.length).toBe(requests);
		expect(auth).not.toContain("Bearer cc-auto-disabled");
	} finally {
		firstGate.resolve();
		secondGate.resolve();
		await Promise.allSettled(completions);
		keys.removeProvider(COMMAND_CODE_KEY_OWNER);
		for (const key of [first, second, disabled]) quotaStore.remove(key.id);
	}
});

test("refreshing the second Command Code key exposes its own standard snapshot without querying the first", async () => {
	const { COMMAND_CODE_KEY_OWNER } = await import("../../lib/provider-keys");
	const { getCommandCodeUsageForCredential } = await import("../../lib/commandcode-usage");
	const keys = getProviderKeyStore();
	saveSettings({
		...settings,
		commandCode: {
			apiKey: "cc-first-secret",
			baseUrl: "https://cc-quota.example/provider/v1",
			disabled: false,
		},
	});
	const first = keys.list(COMMAND_CODE_KEY_OWNER)[0];
	if (!first) throw new Error("missing Command Code fixture");
	const second = keys.add(COMMAND_CODE_KEY_OWNER, { apiKey: "cc-second-secret" });
	const auth: Array<string | null> = [];
	let release!: () => void;
	const upstream = new Promise<void>((resolve) => {
		release = resolve;
	});
	stubFetch(async (input, init) => {
		auth.push(new Headers(init?.headers).get("Authorization"));
		await upstream;
		return Response.json(
			String(input).endsWith("/credits")
				? {
						credits: { monthlyCredits: 7 },
						windowLimits: {
							limited: true,
							fiveHour: { used: 2, cap: 10, exceeded: false, resetAt: Date.now() + 60_000 },
						},
					}
				: {},
		);
	});
	try {
		const response = await refresh("admin", { groupId: "CommandCode", credentialId: second.id });
		expect(response.status).toBe(200);
		const pending = byGroup((await response.json()) as QuotaSnapshotsResponse, "CommandCode");
		expect(pending.find((row) => row.credentialId === second.id)?.refreshing).toBe(true);
		expect(pending.find((row) => row.credentialId === first.id)?.refreshing).toBe(false);
		expect(auth).toContain("Bearer cc-second-secret");
		// Join the existing source-owned task; the API deliberately acknowledges non-TD probes early.
		const completion = getCommandCodeUsageForCredential(second.id);
		release();
		await completion;
		const data = readQuotaSnapshots(true, false);
		const rows = byGroup(data, "CommandCode");
		expect(
			rows.find((row) => row.credentialId === second.id)?.snapshot?.balances[0]?.remaining,
		).toBe(7);
		expect(rows.find((row) => row.credentialId === first.id)?.snapshot).toBeNull();
		expect(auth.every((header) => header === "Bearer cc-second-secret")).toBe(true);
		expect(JSON.stringify(data)).not.toMatch(/cc-first-secret|cc-second-secret/);
	} finally {
		release();
		keys.removeProvider(COMMAND_CODE_KEY_OWNER);
		quotaStore.remove(first.id);
		quotaStore.remove(second.id);
	}
});
