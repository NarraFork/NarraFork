import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ProviderQuotaData } from "@shared/provider-quota";
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import { legacyQuotaFixture, required } from "../__tests__/provider-quota-legacy-fixture";
import { autoSourceFacts, autoSourcePreview } from "../agent/auto-route-signals";
import { customApiStreamQuotaIdentity } from "../custom-api-quota-cache";
import { getProviderKeyStore, withProviderKey } from "../provider-keys";
import { type CustomApiProviderConfig, saveSettings, settings } from "../settings";
import { quotaStore, STREAM_QUOTA_SOURCE } from "./quota-store";
import { STREAM_BALANCE_MAX_AGE_MS } from "./routing";
import { getSourceGroupByPrefix } from "./source-groups";

const saved = structuredClone(settings);
const store = getProviderKeyStore();
const touched = new Set<string>();
const now = Date.now();
let fixture: ReturnType<typeof legacyQuotaFixture> | undefined;
function pluginQuota(config: CustomApiProviderConfig, data: ProviderQuotaData) {
	fixture = legacyQuotaFixture([config], data);
	fixture.advance(now - 1_000_000);
	return fixture;
}
const provider = (id: string, baseUrl: string): CustomApiProviderConfig => ({
	id,
	prefix: id,
	name: id,
	apiKey: `sk-${id}`,
	baseUrl,
	defaultModel: "m",
	protocol: "completions-compatible",
});
const quota = (extra: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
	fetchedAt: now,
	scope: "key",
	windows: [],
	balances: [],
	...extra,
});
function keyFor(config: CustomApiProviderConfig) {
	const key = store.listGroup(config.id)[0];
	if (!key) throw new Error("missing fixture credential");
	touched.add(key.id);
	const current =
		settings.customApiProviders?.find((provider) => provider.id === config.id) ?? config;
	return { key, config: withProviderKey(current, key) };
}

afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
	mock.restore();
	for (const id of touched) {
		quotaStore.forget(id, STREAM_QUOTA_SOURCE);
	}
	touched.clear();
	saveSettings(structuredClone(saved));
});

describe("template routing review regressions", () => {
	test("OpenCode's empty fallback wallet does not block unused subscription allowance", async () => {
		const config = provider("review-go", "https://opencode.ai/zen/go/v1");
		saveSettings({ ...settings, customApiProviders: [config] });
		const credential = keyFor(config);
		const data: ProviderQuotaData = {
			format: "opencode",
			scope: "subscription",
			windows: [
				{
					id: "rolling",
					used: null,
					limit: null,
					remaining: null,
					usedPercent: 37,
					resetAt: new Date(now + 120_000).toISOString(),
				},
			],
			amounts: [{ id: "balance:USD", unit: "USD", remaining: 0, quota: "none" }],
		};
		const f = pluginQuota(credential.config, data);
		await f.service.refreshKey(credential.key.id);
		expect(autoSourceFacts(config.prefix, now)).toEqual({ available: true, subscription: true });
		// The source declares this wallet informational, not an alternative subscription allowance.
		for (const remaining of [0, 10]) {
			f.advance(10_000);
			f.query.mockResolvedValue({
				status: "supported",
				error: null,
				data: {
					...data,
					windows: [{ ...data.windows[0], usedPercent: 100 }],
					amounts: [{ ...data.amounts[0], remaining }],
				},
			});
			await f.service.refreshKey(credential.key.id);
			expect(autoSourceFacts(config.prefix, now).available).toBe(false);
		}
		expect(f.query).toHaveBeenCalledTimes(3);
	});

	test("an old stream zero expires without merging slots or clearing a separate per-key cap", async () => {
		const config = provider("review-relay", "https://relay.example/v1");
		saveSettings({ ...settings, customApiProviders: [config] });
		const credential = keyFor(config);
		const data: ProviderQuotaData = {
			scope: "key",
			windows: [],
			amounts: [{ id: "balance:USD", unit: "USD", remaining: 10 }],
		};
		const f = pluginQuota(credential.config, data);
		f.advance(1000);
		const probe = required(await f.service.refreshKey(credential.key.id));
		const streamIdentity = customApiStreamQuotaIdentity(credential.config);
		const stream = quota({
			balances: [{ unit: "USD", remaining: 0 }],
			detail: { generation: probe.generation },
		});
		quotaStore.set(credential.key.id, streamIdentity, stream, false, STREAM_QUOTA_SOURCE);
		expect(autoSourceFacts(config.prefix, now + 1000).available).toBe(false);
		expect(autoSourceFacts(config.prefix, now + STREAM_BALANCE_MAX_AGE_MS).available).toBe(true);
		expect(quotaStore.peekForIdentity(credential.key.id, streamIdentity, STREAM_QUOTA_SOURCE)).toBe(
			stream,
		);
		expect(f.service.peekKey(credential.key.id)?.data?.amounts[0]?.remaining).toBe(10);
		f.advance(10_000);
		f.query.mockResolvedValue({
			status: "supported",
			error: null,
			data: {
				...data,
				windows: [
					{
						id: "weekly",
						used: 10,
						limit: 10,
						remaining: 0,
						resetAt: new Date(now + 180_000).toISOString(),
					},
				],
			},
		});
		await f.service.refreshKey(credential.key.id);
		expect(autoSourceFacts(config.prefix, now + STREAM_BALANCE_MAX_AGE_MS).available).toBe(false);
		expect(autoSourcePreview(config.prefix, now + STREAM_BALANCE_MAX_AGE_MS)?.resetsAt).toBe(
			now + 180_000,
		);
		expect(f.query).toHaveBeenCalledTimes(2);
	});

	test("expired stream records are ignored while a live probe's subscription expiry still blocks", async () => {
		const config = provider("review-expiry", "https://relay.example/v1");
		saveSettings({ ...settings, customApiProviders: [config] });
		const credential = keyFor(config);
		const data: ProviderQuotaData = {
			scope: "subscription",
			windows: [],
			amounts: [{ id: "wallet", unit: "USD", remaining: 10 }],
		};
		const f = pluginQuota(credential.config, data);
		const probe = required(await f.service.refreshKey(credential.key.id));
		quotaStore.set(
			credential.key.id,
			customApiStreamQuotaIdentity(credential.config),
			quota({
				balances: [{ unit: "USD", remaining: 0 }],
				expiresAt: now + 100,
				detail: { generation: probe.generation },
			}),
			false,
			STREAM_QUOTA_SOURCE,
		);
		expect(autoSourceFacts(config.prefix, now).available).toBe(false);
		expect(autoSourceFacts(config.prefix, now + 100).available).toBe(true);
		f.advance(10_000);
		f.query.mockResolvedValue({
			status: "supported",
			error: null,
			data: { ...data, expiresAt: new Date(now - 1).toISOString() },
		});
		await f.service.refreshKey(credential.key.id);
		expect(autoSourceFacts(config.prefix, now + 100).available).toBe(false);
	});

	for (const kind of ["custom", "nug"] as const) {
		test(`disconnected TokenDance yields its legacy prefix to ${kind} for facts and preview`, () => {
			const config = {
				...provider(`review-legacy-${kind}`, "https://relay.example/v1"),
				prefix: "tokendance",
			};
			saveSettings({
				...settings,
				tokendance: { apiKey: "", generation: 0, disabled: false },
				customApiProviders: kind === "custom" ? [config] : [],
				nugProviders: kind === "nug" ? [config] : [],
			});
			const { key } = keyFor(config);
			store.update(key.id, { label: "legacy key" });
			expect(getSourceGroupByPrefix("tokendance")?.id).toBe(config.id);
			expect(autoSourceFacts("tokendance", now)).toEqual({ available: true, subscription: false });
			expect(autoSourcePreview("tokendance", now)?.label).toBe("legacy key");
			store.update(key.id, { disabled: true });
			expect(autoSourceFacts("tokendance", now).available).toBe(false);
			saveSettings({
				...settings,
				tokendance: { apiKey: "platform", generation: 1, disabled: true },
			});
			expect(getSourceGroupByPrefix("tokendance")?.templateId).toBe("tokendance");
			expect(autoSourceFacts("tokendance", now).available).toBe(false);
		});
	}
});
