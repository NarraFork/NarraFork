import { describe, expect, test } from "bun:test";
import {
	createNugModelRefreshCoordinator,
	NUG_MODEL_REFRESH_COOLDOWN_MS,
} from "../nug-model-refresh-coordinator";
import type { NUGProviderConfig } from "../settings";

function makeConfig(overrides: Partial<NUGProviderConfig> = {}): NUGProviderConfig {
	return {
		id: "prov-1",
		name: "NUG Test",
		prefix: "nug",
		apiKey: "key",
		baseUrl: "https://nug.example",
		...overrides,
	};
}

/**
 * Harness with an injected clock and fetcher so no test touches the network or
 * real time. `fetchCount` is the assertion that matters throughout: the whole
 * point of the coordinator is bounding upstream requests.
 */
function makeHarness(
	options: {
		fetchImpl?: () => Promise<{ models: Array<Record<string, unknown>> }>;
		cooldownMs?: number;
	} = {},
) {
	const state = { now: 1_000_000, fetchCount: 0, appliedCount: 0 };
	const coordinator = createNugModelRefreshCoordinator({
		now: () => state.now,
		cooldownMs: options.cooldownMs ?? NUG_MODEL_REFRESH_COOLDOWN_MS,
		fetchModels: async () => {
			state.fetchCount++;
			if (options.fetchImpl) return options.fetchImpl();
		},
		applyCatalog: (_config, catalog) => {
			state.appliedCount++;
			return catalog.models.length;
		},
	});
	return { coordinator, state, advance: (ms: number) => (state.now += ms) };
}

describe("nugModelRefreshCoordinator", () => {
	test("refreshes on the first call and applies the fetched catalog", async () => {
		const { coordinator, state } = makeHarness();
		const outcome = await coordinator.refreshIfStale(makeConfig());
		expect(outcome.attempted).toBe(true);
		expect(outcome.error).toBeUndefined();
		expect(outcome.modelCount).toBe(1);
		expect(state.fetchCount).toBe(1);
		expect(state.appliedCount).toBe(1);
	});

	test("skips a second call inside the cooldown window without hitting upstream", async () => {
		const { coordinator, state, advance } = makeHarness();
		await coordinator.refreshIfStale(makeConfig());
		advance(NUG_MODEL_REFRESH_COOLDOWN_MS - 1);
		const outcome = await coordinator.refreshIfStale(makeConfig());
		expect(outcome.attempted).toBe(false);
		expect(outcome.skipped).toBe("cooldown");
		expect(outcome.retryAfterMs).toBe(1);
		expect(state.fetchCount).toBe(1);
	});

	test("refreshes again once the cooldown window has elapsed", async () => {
		const { coordinator, state, advance } = makeHarness();
		await coordinator.refreshIfStale(makeConfig());
		advance(NUG_MODEL_REFRESH_COOLDOWN_MS);
		const outcome = await coordinator.refreshIfStale(makeConfig());
		expect(outcome.attempted).toBe(true);
		expect(state.fetchCount).toBe(2);
	});

	test("concurrent callers share one upstream request", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { coordinator, state } = makeHarness({
			fetchImpl: async () => {
				await gate;
			},
		});
		const first = coordinator.refreshIfStale(makeConfig());
		const second = coordinator.refreshIfStale(makeConfig());
		release?.();
		const [a, b] = await Promise.all([first, second]);
		expect(state.fetchCount).toBe(1);
		expect(a.attempted).toBe(true);
		// Both callers observe the same outcome rather than one seeing a skip.
		expect(b).toEqual(a);
	});

	test("a failed refresh still consumes the cooldown", async () => {
		const { coordinator, state, advance } = makeHarness({
			fetchImpl: async () => {
				throw new Error("gateway down");
			},
		});
		const failed = await coordinator.refreshIfStale(makeConfig());
		expect(failed.attempted).toBe(true);
		expect(failed.error).toBe("gateway down");
		expect(state.appliedCount).toBe(0);

		advance(1_000);
		const skipped = await coordinator.refreshIfStale(makeConfig());
		expect(skipped.attempted).toBe(false);
		expect(skipped.skipped).toBe("cooldown");
		// The dead gateway is not retried once per picker open.
		expect(state.fetchCount).toBe(1);
	});

	test("cooldown is tracked per provider", async () => {
		const { coordinator, state } = makeHarness();
		await coordinator.refreshIfStale(makeConfig({ id: "prov-a" }));
		const other = await coordinator.refreshIfStale(makeConfig({ id: "prov-b" }));
		expect(other.attempted).toBe(true);
		expect(state.fetchCount).toBe(2);
	});

	test("skips disabled providers and providers missing credentials", async () => {
		const { coordinator, state } = makeHarness();
		const outcomes = await coordinator.refreshAllIfStale([
			makeConfig({ id: "disabled", disabled: true }),
			makeConfig({ id: "no-key", apiKey: "" }),
			makeConfig({ id: "no-url", baseUrl: "   " }),
			makeConfig({ id: "ok" }),
		]);
		expect(outcomes.map((o) => o.skipped)).toEqual([
			"not-configured",
			"not-configured",
			"not-configured",
			undefined,
		]);
		expect(state.fetchCount).toBe(1);
	});

	test("refreshAllIfStale reports per-provider failures without failing the batch", async () => {
		let call = 0;
		const { coordinator } = makeHarness({
			fetchImpl: async () => {
				call++;
				if (call === 1) throw new Error("first down");
			},
		});
		const outcomes = await coordinator.refreshAllIfStale([
			makeConfig({ id: "prov-a" }),
			makeConfig({ id: "prov-b" }),
		]);
		expect(outcomes).toHaveLength(2);
		expect(outcomes[0]?.error).toBe("first down");
		expect(outcomes[1]?.error).toBeUndefined();
		expect(outcomes[1]?.modelCount).toBe(1);
	});
});
