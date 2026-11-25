import { afterEach, describe, expect, test } from "bun:test";
import type { QuotaSnapshot } from "@shared/quota-snapshot";
import { autoSourceFacts, autoSourcePreview } from "../agent/auto-route-signals";
import { customApiStreamQuotaIdentity } from "../custom-api-quota-cache";
import { opencodeQuotaIdentity } from "../opencode-usage-cache";
import { providerBalanceQuotaIdentity } from "../provider-balance-cache";
import { getProviderKeyStore, withProviderKey } from "../provider-keys";
import { type CustomApiProviderConfig, saveSettings, settings } from "../settings";
import { quotaStore, STREAM_QUOTA_SOURCE } from "./quota-store";
import { STREAM_BALANCE_MAX_AGE_MS } from "./routing";
import { getSourceGroupByPrefix } from "./source-groups";

const saved = structuredClone(settings);
const store = getProviderKeyStore();
const touched = new Set<string>();
const now = Date.now();
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
	for (const id of touched) {
		quotaStore.forget(id);
		quotaStore.forget(id, STREAM_QUOTA_SOURCE);
	}
	touched.clear();
	saveSettings(structuredClone(saved));
});

describe("template routing review regressions", () => {
	test("OpenCode's empty fallback wallet does not block unused subscription allowance", () => {
		const config = provider("review-go", "https://opencode.ai/zen/go/v1");
		saveSettings({ ...settings, customApiProviders: [config] });
		const credential = keyFor(config);
		const identity = opencodeQuotaIdentity(credential.config);
		const snapshot = quota({
			scope: "subscription",
			windows: [{ kind: "5h", usedRatio: 0.37, resetsAt: now + 120_000 }],
			balances: [{ unit: "USD", remaining: 0 }],
		});
		quotaStore.set(credential.key.id, identity, snapshot, false);
		expect(autoSourceFacts(config.prefix, now)).toEqual({ available: true, subscription: true });
		// A positive wallet is not proof the upstream's optional balance-spending switch is on.
		for (const remaining of [0, 10]) {
			quotaStore.set(
				credential.key.id,
				identity,
				{
					...snapshot,
					windows: [{ kind: "5h", usedRatio: 1, resetsAt: now + 120_000 }],
					balances: [{ unit: "USD", remaining }],
				},
				false,
			);
			expect(autoSourceFacts(config.prefix, now).available).toBe(false);
		}
	});

	test("an old stream zero expires without merging slots or clearing a separate per-key cap", () => {
		const config = provider("review-relay", "https://relay.example/v1");
		saveSettings({ ...settings, customApiProviders: [config] });
		const credential = keyFor(config);
		const probeIdentity = providerBalanceQuotaIdentity(credential.config, settings.proxy);
		const streamIdentity = customApiStreamQuotaIdentity(credential.config);
		const stream = quota({ balances: [{ unit: "USD", remaining: 0 }] });
		quotaStore.set(credential.key.id, streamIdentity, stream, false, STREAM_QUOTA_SOURCE);
		quotaStore.set(
			credential.key.id,
			probeIdentity,
			quota({
				fetchedAt: now + 1000,
				balances: [{ unit: "USD", remaining: 10 }],
			}),
			false,
		);
		expect(autoSourceFacts(config.prefix, now + 1000).available).toBe(false);
		expect(autoSourceFacts(config.prefix, now + STREAM_BALANCE_MAX_AGE_MS).available).toBe(true);
		expect(quotaStore.peekForIdentity(credential.key.id, streamIdentity, STREAM_QUOTA_SOURCE)).toBe(
			stream,
		);
		quotaStore.set(
			credential.key.id,
			probeIdentity,
			quota({
				windows: [{ kind: "weekly", usedRatio: 1, resetsAt: now + 180_000 }],
				balances: [{ unit: "USD", remaining: 10 }],
			}),
			false,
		);
		expect(autoSourceFacts(config.prefix, now + STREAM_BALANCE_MAX_AGE_MS).available).toBe(false);
		expect(autoSourcePreview(config.prefix, now + STREAM_BALANCE_MAX_AGE_MS)?.resetsAt).toBe(
			now + 180_000,
		);
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
