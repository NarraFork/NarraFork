import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { quotaSnapshotText } from "@frontend/components/narrator/model/quota-snapshot-view";
import { buildModelMenuProviderBadges } from "@frontend/components/narrator/model/use-model-menu-provider-badges";
import { selectQuotaEntries } from "@frontend/hooks/useQuotaSnapshots";
import type { ProviderQuotaData, QuotaQueryResult } from "@shared/provider-quota";
import type {
	QuotaSnapshot,
	QuotaSnapshotEntry,
	QuotaSnapshotsResponse,
} from "@shared/quota-snapshot";
import { Hono } from "hono";
import {
	deferred,
	legacyQuotaFixture,
	required,
} from "../../lib/__tests__/provider-quota-legacy-fixture";
import { getCodexManager } from "../../lib/codex-manager";
import * as commandAuth from "../../lib/commandcode-manager";
import * as customQuota from "../../lib/custom-api-quota-cache";
import { updateCustomApiQuotaByPrefix } from "../../lib/custom-api-quota-cache";
import { AppError } from "../../lib/errors";
import { streamQuotaIdentity } from "../../lib/provider-key-subjects";
import { getProviderKeyStore, TOKENDANCE_KEY_OWNER } from "../../lib/provider-keys";
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
let quotaFixture: ReturnType<typeof legacyQuotaFixture>;
const pluginData = (usedRatio = 0.25): ProviderQuotaData => ({
	scope: "subscription",
	amounts: [],
	windows: [
		{
			id: "fiveHour",
			used: null,
			limit: null,
			remaining: null,
			usedPercent: usedRatio * 100,
			resetAt: null,
		},
	],
});
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
	quotaFixture = legacyQuotaFixture([], pluginData());
});
afterEach(() => {
	quotaFixture.dispose();
	mock.restore();
	pluginProviderRegistry.removePlugin(pluginId);
	const manager = getCodexManager();
	if (Object.hasOwn(manager, "quotaCredentialIds"))
		Reflect.deleteProperty(manager, "quotaCredentialIds");
	saveSettings(structuredClone(saved));
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
	test("public balances whitelist field observation times without identity or private payload", () => {
		const raw = {
			...snap(),
			balances: [
				{
					unit: "",
					remaining: 0,
					total: 111,
					remainingObservedAt: 200,
					totalObservedAt: 300,
					identity: "private-identity",
					extra: { secret: "private-balance" },
				},
			],
		};
		expect(publicQuotaSnapshot(raw)?.balances).toEqual([
			{
				unit: "",
				remaining: 0,
				total: 111,
				remainingObservedAt: 200,
				totalObservedAt: 300,
			},
		]);
		const partial = {
			...raw,
			balances: [
				{ unit: "", remaining: null, total: 111, remainingObservedAt: null, totalObservedAt: 300 },
			],
		};
		expect(publicQuotaSnapshot(partial)?.balances[0]?.remainingObservedAt).toBeNull();
		expect(
			publicQuotaSnapshot({
				...raw,
				balances: [{ unit: "", remaining: null, remainingObservedAt: 0, totalObservedAt: null }],
			})?.balances[0],
		).toEqual({ unit: "", remaining: null, remainingObservedAt: 0, totalObservedAt: null });
		const legacy = publicQuotaSnapshot({ ...raw, balances: [{ unit: "", remaining: 11 }] });
		expect(Object.hasOwn(legacy?.balances[0] ?? {}, "remainingObservedAt")).toBe(false);
		expect(Object.hasOwn(legacy?.balances[0] ?? {}, "totalObservedAt")).toBe(false);
		expect(JSON.stringify(publicQuotaSnapshot(raw))).not.toMatch(
			/private-identity|private-balance|identity|extra|detail/,
		);
	});
	test("invalid observation times are omitted, not converted into never-observed null markers", () => {
		for (const value of [NaN, Infinity, -1, "private-token", { identity: "private-identity" }]) {
			const projected = publicQuotaSnapshot({
				...snap(),
				balances: [{ unit: "", remaining: 11, remainingObservedAt: value, totalObservedAt: value }],
			} as unknown as QuotaSnapshot);
			expect(projected?.balances[0]).toEqual({ unit: "", remaining: 11 });
			expect(Object.hasOwn(projected?.balances[0] ?? {}, "remainingObservedAt")).toBe(false);
			expect(Object.hasOwn(projected?.balances[0] ?? {}, "totalObservedAt")).toBe(false);
			expect(JSON.stringify(projected)).not.toMatch(/private-token|private-identity|identity/);
		}
	});
	test("invalid observed times cannot revive authoritative unknown through public projection and selector", () => {
		const base = { groupId: "nug", prefix: "nug", templateId: "nug", credentialId: "key" };
		const stream: QuotaSnapshotEntry = {
			...base,
			source: "quota_balance",
			snapshot: {
				scope: "wallet",
				fetchedAt: 200,
				windows: [],
				balances: [{ unit: "", remaining: 9, remainingObservedAt: 200 }],
			},
		};
		for (const value of [NaN, Infinity, -1, "private-token", { identity: "private-identity" }]) {
			const probe: QuotaSnapshotEntry = {
				...base,
				source: "probe",
				snapshot: publicQuotaSnapshot({
					scope: "wallet",
					fetchedAt: 300,
					windows: [],
					balances: [
						{
							unit: "",
							remaining: null,
							total: 111,
							remainingObservedAt: value,
							totalObservedAt: value,
						},
					],
				} as unknown as QuotaSnapshot),
			};
			for (const entries of [
				[probe, stream],
				[stream, probe],
			]) {
				const selected = selectQuotaEntries(entries)[0];
				expect(selected).toBe(probe);
				expect(selected?.snapshot?.balances[0]?.remaining).toBeNull();
				expect(Object.hasOwn(selected?.snapshot?.balances[0] ?? {}, "remainingObservedAt")).toBe(
					false,
				);
				expect(JSON.stringify(selected)).not.toMatch(/private-token|private-identity|identity/);
			}
		}
	});
	test("anonymous callers cannot read or refresh", async () => {
		expect((await app().request("/api/quota-snapshots")).status).toBe(401);
		expect(
			(await app().request("/api/quota-snapshots/refresh", { method: "POST", body: "{}" })).status,
		).toBe(401);
	});
	test("admin enumerates every credential but ordinary users retain one anonymous allowance per group", async () => {
		saveSettings({ ...settings, customApiProviders: [config()] });
		const keys = getProviderKeyStore();
		const first = keys.list("quota-kimi")[0];
		const second = keys.add("quota-kimi", { apiKey: "second-secret" });
		const provider = settings.customApiProviders?.find((entry) => entry.id === "quota-kimi");
		if (!provider) throw new Error("missing fixture");
		try {
			quotaFixture.query.mockImplementation(async (_source, target) => ({
				status: "supported",
				error: null,
				data: pluginData("keyId" in target && target.keyId === second.id ? 0.9 : 0.25),
			}));
			await Promise.all([
				quotaFixture.service.refreshKey(first.id),
				quotaFixture.service.refreshKey(second.id),
			]);
			const admin = byGroup(readQuotaSnapshots(true, false), "quota-kimi");
			expect(admin.map((entry) => entry.credentialId)).toEqual([first.id, second.id]);
			expect(admin.map((entry) => entry.snapshot?.windows[0]?.usedRatio)).toEqual([0.25, 0.9]);
			expect(admin.map((entry) => entry.primary)).toEqual([true, false]);
			expect(admin.map((entry) => entry.generation)).toEqual([
				quotaFixture.service.peekKey(first.id)?.generation,
				quotaFixture.service.peekKey(second.id)?.generation,
			]);
			expect(admin.every((entry) => entry.snapshot?.scope === "subscription")).toBe(true);
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
		}
	});
	test("probe and stream slots coexist and replaced secrets invalidate both", async () => {
		saveSettings({ ...settings, customApiProviders: [config("quota-stream")] });
		const provider = settings.customApiProviders?.find(
			(provider) => provider.id === "quota-stream",
		);
		if (!provider) throw new Error("missing fixture");
		const key = getProviderKeyStore().list(provider.id)[0];
		const id = key.id;
		const probe = required(await quotaFixture.service.refreshKey(id));
		updateCustomApiQuotaByPrefix(
			provider.prefix,
			"12.5",
			"private-detail",
			streamQuotaIdentity(provider, key.id),
			probe.generation,
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
		expect(quotaFixture.service.peekKey(id)?.generation).not.toBe(probe.generation);
		quotaStore.remove(id, STREAM_QUOTA_SOURCE);
	});
	test("unsupported gateway probing preserves streamed balances through the public API and both displays", async () => {
		quotaFixture.query.mockResolvedValue({ status: "unsupported", data: null, error: null });
		saveSettings({
			...settings,
			customApiProviders: [
				{ ...config("quota-stream-only"), baseUrl: "https://gateway.example/v1" },
			],
		});
		const provider = settings.customApiProviders?.find((entry) => entry.id === "quota-stream-only");
		if (!provider) throw new Error("missing live provider fixture");
		const key = getProviderKeyStore().list(provider.id)[0];
		await quotaFixture.service.refreshKey(key.id);
		expect(quotaFixture.service.peek(provider.id)?.status).toBe("unsupported");
		const discoveryCalls = quotaFixture.query.mock.calls.length;
		const probeBefore = required(quotaFixture.service.peekKey(key.id));
		try {
			for (const amount of [3, 4]) {
				updateCustomApiQuotaByPrefix(
					provider.prefix,
					String(amount),
					"private-detail",
					streamQuotaIdentity(provider, key.id),
					probeBefore.generation,
				);
				for (const role of ["admin", "user"] as const) {
					const response = await app(role).request(
						`/api/quota-snapshots?cachedOnly=true&groupId=${provider.id}`,
					);
					expect(response.status).toBe(200);
					const body = await response.text();
					const entries = (JSON.parse(body) as QuotaSnapshotsResponse).entries;
					expect(entries).toHaveLength(2);
					expect(entries[0]).toMatchObject({ source: "probe", supported: false, snapshot: null });
					expect(entries[1]).toMatchObject({
						source: "quota_balance",
						supported: true,
						snapshot: { balances: [{ remaining: amount }] },
					});
					const before = structuredClone(entries);
					const selected = selectQuotaEntries(entries)[0];
					expect(selected).toBe(entries[1]);
					expect(selected.supported).toBe(true);
					const t = (value: string) => value;
					expect(quotaSnapshotText(selected.snapshot, t).balance).toBe(String(amount));
					expect(
						buildModelMenuProviderBadges(entries, Date.now(), t).providerBalances?.[provider.prefix]
							?.text,
					).toBe(String(amount));
					expect(entries).toEqual(before);
					expect(body).not.toMatch(/private-detail|quota-secret/);
					if (role === "user") {
						expect(entries.every((entry) => entry.credentialId === null)).toBe(true);
					}
				}
			}
			expect(quotaFixture.service.peek(provider.id)?.status).toBe("unsupported");
			expect(quotaFixture.query).toHaveBeenCalledTimes(discoveryCalls);
			expect(quotaFixture.service.peekKey(key.id)).toEqual(probeBefore);
		} finally {
			quotaStore.remove(key.id, STREAM_QUOTA_SOURCE);
		}
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
		quotaFixture.query.mockRejectedValue(
			new Error(
				"key quota-secret rejected for private-account@example.com at https://internal/usage",
			),
		);
		await quotaFixture.service.refreshKey(id);
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
		expect(quotaFixture.query).toHaveBeenCalledTimes(1);
	});
	test("both roles withdraw plugin-disabled quota and its stream without private detail", async () => {
		saveSettings({ ...settings, customApiProviders: [config("quota-plugin-code")] });
		const key = getProviderKeyStore().list("quota-plugin-code")[0];
		const provider = settings.customApiProviders?.find((entry) => entry.id === "quota-plugin-code");
		if (!provider) throw new Error("missing fixture");
		const id = key.id;
		const probe = required(await quotaFixture.service.refreshKey(id));
		updateCustomApiQuotaByPrefix(
			provider.prefix,
			"12",
			"private-detail",
			streamQuotaIdentity(provider, key.id),
			probe.generation,
		);
		expect(byGroup(readQuotaSnapshots(true, false), provider.id)).toHaveLength(2);
		quotaFixture.revoke();
		try {
			for (const role of ["admin", "user"] as const) {
				const response = await app(role).request(
					"/api/quota-snapshots?groupId=quota-plugin-code&cachedOnly=true",
				);
				expect(response.status).toBe(200);
				const text = await response.text();
				const entries = byGroup(JSON.parse(text), "quota-plugin-code");
				expect(entries).toHaveLength(1);
				expect(entries[0]).toMatchObject({ source: "probe", supported: false, snapshot: null });
				expect(text).not.toMatch(/quota-secret|private-account|headers|detail/);
			}
		} finally {
			quotaStore.remove(id, STREAM_QUOTA_SOURCE);
		}
	});

	test("cold GET returns immediately and repeated reads share the original source refresh", async () => {
		saveSettings({ ...settings, customApiProviders: [config("quota-hanging")] });
		const key = required(getProviderKeyStore().list("quota-hanging")[0]);
		const upstream = deferred<QuotaQueryResult>();
		quotaFixture.query.mockImplementation(() => upstream.promise);
		try {
			const cached = await app("user").request(
				"/api/quota-snapshots?cachedOnly=true&groupId=quota-hanging",
			);
			expect(cached.status).toBe(200);
			expect(quotaFixture.query).not.toHaveBeenCalled();
			const first = await app("user").request("/api/quota-snapshots");
			expect(first.status).toBe(200);
			expect(byGroup(await first.json(), "quota-hanging")[0]).toMatchObject({
				snapshot: null,
				refreshing: true,
				credentialId: null,
			});
			expect((await app("user").request("/api/quota-snapshots")).status).toBe(200);
			expect(quotaFixture.query).toHaveBeenCalledTimes(1);
		} finally {
			upstream.resolve({ status: "supported", data: pluginData(), error: null });
			await quotaFixture.service.refreshKey(key.id);
		}
		expect(
			byGroup(readQuotaSnapshots(true, false), "quota-hanging")[0].snapshot?.windows[0]?.usedRatio,
		).toBe(0.25);
		expect(quotaFixture.query).toHaveBeenCalledTimes(1);
	});
	test("admin refresh acknowledges the plugin task before completion and request cancellation leaves its owner running", async () => {
		saveSettings({ ...settings, customApiProviders: [config("quota-manual")] });
		const key = required(getProviderKeyStore().list("quota-manual")[0]);
		const upstream = deferred<QuotaQueryResult>();
		quotaFixture.query.mockImplementation(() => upstream.promise);
		expect((await refresh("user", { groupId: "quota-manual", credentialId: key.id })).status).toBe(
			403,
		);
		expect(quotaFixture.query).not.toHaveBeenCalled();
		const controller = new AbortController();
		try {
			const response = await app("admin").request("/api/quota-snapshots/refresh", {
				method: "POST",
				signal: controller.signal,
				body: JSON.stringify({ groupId: "quota-manual", credentialId: key.id }),
			});
			expect(response.status).toBe(200);
			const entries = byGroup(await response.json(), "quota-manual");
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				credentialId: key.id,
				refreshing: true,
				snapshot: null,
				generation: required(quotaFixture.service.peekKey(key.id)).generation,
			});
			controller.abort();
			expect(quotaFixture.query).toHaveBeenCalledTimes(1);
			expect(quotaFixture.query.mock.calls[0]?.[2].signal.aborted).toBe(false);
		} finally {
			upstream.resolve({ status: "supported", data: pluginData(0.7), error: null });
			await quotaFixture.service.refreshKey(key.id);
		}
		expect(
			byGroup(readQuotaSnapshots(true, false), "quota-manual")[0].snapshot?.windows[0]?.usedRatio,
		).toBe(0.7);
		expect(quotaFixture.query).toHaveBeenCalledTimes(1);
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
