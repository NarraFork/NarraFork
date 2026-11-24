import { describe, expect, test } from "bun:test";
import type { ProviderBalanceSnapshot } from "../../../../shared/provider-balance";
import type { ProviderQuotaSnapshot } from "../../../../shared/provider-quota";
import { capabilityModelReference } from "../interaction/use-resolved-model";
import {
	customApiBalanceDisplayFor,
	customApiQuotaDisplayFor,
	resolveCustomApiQuotaProviderId,
	usageSourceFor,
} from "./custom-api-usage-source";

const subscriptionSnapshot = {
	generation: "g1",
	status: "supported",
	adapter: "sub2api",
	balance: {
		scope: "subscription",
		unlimited: false,
		amounts: [{ unit: "USD", window: "daily", total: 10, used: 2, remaining: 8 }],
	},
	fetchedAt: 1,
	attemptedAt: 1,
	error: null,
} satisfies ProviderBalanceSnapshot;

describe("customApiBalanceDisplayFor", () => {
	test.each([
		"专用额度 75%",
		"0",
	])("pushed text %s and its details suppress the subscription panel", (quotaBalance) => {
		const pushed = {
			quotaBalance,
			detailedQuotaBalance: "站点套餐\n每日：USD 0.004\n重置：由站点提供",
		};
		const display = customApiBalanceDisplayFor({
			providerId: "p1",
			pushedQuotas: { p1: pushed },
			snapshot: subscriptionSnapshot,
		});
		expect(display.pushedQuota).toBe(pushed);
		expect(display.subscriptionSnapshot).toBeNull();
	});

	test.each([
		undefined,
		null,
		"",
		"   ",
	])("missing or empty pushed balance %s leaves the subscription fallback", (quotaBalance) => {
		const display = customApiBalanceDisplayFor({
			providerId: "p1",
			pushedQuotas: quotaBalance === undefined ? undefined : { p1: { quotaBalance } },
			snapshot: subscriptionSnapshot,
		});
		expect(display.pushedQuota).toBeNull();
		expect(display.subscriptionSnapshot).toBe(subscriptionSnapshot);
	});

	test("pushes for another provider never replace the active provider's subscription", () => {
		const display = customApiBalanceDisplayFor({
			providerId: "p2",
			pushedQuotas: { p1: { quotaBalance: "Old provider" } },
			snapshot: subscriptionSnapshot,
		});
		expect(display.pushedQuota).toBeNull();
		expect(display.subscriptionSnapshot).toBe(subscriptionSnapshot);
	});

	test("polling updates, stale snapshots and failed auto-detection cannot take back a pushed display", () => {
		const pushed = { quotaBalance: "Site plan", detailedQuotaBalance: "Site-specific details" };
		for (const snapshot of [
			subscriptionSnapshot,
			{ ...subscriptionSnapshot, fetchedAt: 2 },
			{ ...subscriptionSnapshot, error: "request_failed" as const },
			null,
		]) {
			const display = customApiBalanceDisplayFor({
				providerId: "p1",
				pushedQuotas: { p1: pushed },
				snapshot,
			});
			expect(display.pushedQuota).toBe(pushed);
			expect(display.subscriptionSnapshot).toBeNull();
		}
	});

	test("clearing the pushed display restores the subscription fallback", () => {
		const input = { providerId: "p1", snapshot: subscriptionSnapshot };
		expect(
			customApiBalanceDisplayFor({ ...input, pushedQuotas: { p1: { quotaBalance: "Site plan" } } })
				.subscriptionSnapshot,
		).toBeNull();
		expect(
			customApiBalanceDisplayFor({
				...input,
				pushedQuotas: { p1: { quotaBalance: null, detailedQuotaBalance: null } },
			}).subscriptionSnapshot,
		).toBe(subscriptionSnapshot);
	});
});

describe("usageSourceFor", () => {
	test("picks the source the provider is currently configured for", () => {
		expect(
			usageSourceFor({ providerId: "p1", opencodeProviderId: "p1", kimiProviderId: null }),
		).toBe("opencode");
		expect(
			usageSourceFor({ providerId: "p1", opencodeProviderId: null, kimiProviderId: "p1" }),
		).toBe("kimi");
		expect(
			usageSourceFor({ providerId: "p1", opencodeProviderId: null, kimiProviderId: null }),
		).toBeNull();
	});

	test("a provider edited from Kimi to Go gets no Kimi fallback", () => {
		// Regression: React Query keeps a disabled query's last data, so after the id stops
		// being a Kimi provider the Kimi cache still holds its old entry and never refetches.
		// Before the guard, that stale entry was read under the Go configuration and the
		// previous account's allowance was displayed.
		expect(
			usageSourceFor({
				providerId: "same-id",
				opencodeProviderId: "same-id",
				kimiProviderId: null,
			}),
		).toBe("opencode");
	});

	test("the reverse edit does not surface a stale Go allowance either", () => {
		expect(
			usageSourceFor({
				providerId: "same-id",
				opencodeProviderId: null,
				kimiProviderId: "same-id",
			}),
		).toBe("kimi");
	});

	test("opencode wins when both ids somehow match", () => {
		// Not reachable through settings (a provider has one baseUrl), but the precedence is
		// stated so the branch order in the panel is not load-bearing by accident.
		expect(
			usageSourceFor({ providerId: "p1", opencodeProviderId: "p1", kimiProviderId: "p1" }),
		).toBe("opencode");
	});
});

function quotaSnapshot(overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot {
	return {
		providerId: "p",
		targetId: "custom-api/p",
		generation: "g1",
		sourceId: "io.narrafork.provider-quota:third-party",
		status: "supported",
		data: { amounts: [{ id: "credit", unit: "USD", remaining: 8 }], windows: [] },
		fetchedAt: 1,
		attemptedAt: 1,
		stale: false,
		error: null,
		version: 1,
		...overrides,
	};
}

describe("normalized quota source identity", () => {
	test("auto sessions use the service actually reported by runtimeModel, not the first candidate", () => {
		const providers = [
			{ id: "first", prefix: "first-service" },
			{ id: "served", prefix: "served-service" },
			{ id: "disabled", prefix: "disabled-service", disabled: true },
		];
		const concrete = capabilityModelReference("auto:gpt-5.5", undefined, {
			model: "served-service:gpt-5.5",
		});
		expect(resolveCustomApiQuotaProviderId(concrete, providers)).toBe("served");
		expect(resolveCustomApiQuotaProviderId("first-service:gpt-5.5", providers)).toBe("first");
		expect(resolveCustomApiQuotaProviderId("disabled-service:gpt-5.5", providers)).toBeNull();
		for (const model of [
			"codex:gpt-5.5",
			"CommandCode:model",
			"tokendance:model",
			"nug:model",
			undefined,
		])
			expect(resolveCustomApiQuotaProviderId(model, providers)).toBeNull();
	});

	test("a Key quota accepts only a push with the current generation and never a legacy cross-Key cache", () => {
		const snapshot = quotaSnapshot({ keyId: "key-1" });
		const legacy = { quotaBalance: "Old unversioned key", detailedQuotaBalance: "Old details" };
		const input = { providerId: "p", generation: "g1", snapshot };
		expect(customApiQuotaDisplayFor({ ...input, pushedQuotas: { p: legacy } })).toEqual({
			pushedQuota: null,
			quotaSnapshot: snapshot,
		});
		const current = { generation: "g1", quotaBalance: "0", detailedQuotaBalance: "Live key" };
		expect(customApiQuotaDisplayFor({ ...input, pushedQuotas: { p: current } }).pushedQuota).toBe(
			current,
		);
		expect(
			customApiQuotaDisplayFor({ ...input, generation: "g2", pushedQuotas: { p: current } })
				.pushedQuota,
		).toBeNull();
		expect(
			customApiQuotaDisplayFor({ ...input, generation: "g2", pushedQuotas: { p: legacy } })
				.pushedQuota,
		).toBeNull();
		expect(snapshot.data?.amounts[0]?.remaining).toBe(8);
	});

	test("explicit site-account snapshots reject inference-key push fallback for every status", () => {
		const pushed = { generation: "g1", quotaBalance: "Inference key amount" };
		for (const status of ["supported", "error", "unavailable", "unsupported"] as const) {
			const snapshot = quotaSnapshot({ status, pushCompatible: false });
			const display = customApiQuotaDisplayFor({
				providerId: "p",
				generation: "g1",
				snapshot,
				pushedQuotas: { p: pushed },
			});
			expect(display.pushedQuota).toBeNull();
			expect(display.quotaSnapshot).toBe(snapshot);
		}
	});

	test("unversioned caches are compatible only before identity exists or within the same non-Key account", () => {
		const pushed = { quotaBalance: "0" };
		const input = { providerId: "p", generation: "g1", pushedQuotas: { p: pushed } };
		expect(customApiQuotaDisplayFor({ ...input, snapshot: null }).pushedQuota).toBe(pushed);
		expect(customApiQuotaDisplayFor({ ...input, snapshot: quotaSnapshot() }).pushedQuota).toBe(
			pushed,
		);
		expect(
			customApiQuotaDisplayFor({ ...input, snapshot: quotaSnapshot({ generation: "old" }) })
				.pushedQuota,
		).toBeNull();
	});
});
