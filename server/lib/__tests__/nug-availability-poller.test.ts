import { describe, expect, test } from "bun:test";
import { nugAvailabilityPoller } from "../nug-availability-poller";
import {
	isNugCachedModelAvailable,
	markNugCachedModelUnavailable,
	setNugCachedModels,
} from "../nug-model-cache";

describe("nugAvailabilityPoller", () => {
	test("fast path: resolves immediately when the model is already available in cache", async () => {
		const providerId = "prov-avail-1";
		setNugCachedModels(providerId, [
			{
				model: "claude-sonnet-4.5",
				available: true,
			},
		]);
		const controller = new AbortController();
		const outcome = await nugAvailabilityPoller.waitForModelAvailable({
			providerId,
			signal: controller.signal,
		});
		expect(outcome).toBe("available");
		expect(nugAvailabilityPoller.waiterCount()).toBe(0);
	});

	test("fast path: resolves 'aborted' immediately when the signal is already aborted", async () => {
		const providerId = "prov-avail-2";
		setNugCachedModels(providerId, [
			{
				model: "claude-sonnet-4.5",
				available: false,
			},
		]);
		const controller = new AbortController();
		controller.abort();
		const outcome = await nugAvailabilityPoller.waitForModelAvailable({
			providerId,
			signal: controller.signal,
		});
		expect(outcome).toBe("aborted");
		expect(nugAvailabilityPoller.waiterCount()).toBe(0);
	});

	test("registers a waiter for an unavailable model and resolves 'aborted' on signal abort", async () => {
		const providerId = "prov-avail-3";
		// No matching provider config in settings → poll can't recover it; we only
		// exercise the waiter lifecycle + abort here.
		setNugCachedModels(providerId, [
		]);
		const controller = new AbortController();
		const promise = nugAvailabilityPoller.waitForModelAvailable({
			providerId,
			signal: controller.signal,
		});
		// The waiter is registered while it waits.
		expect(nugAvailabilityPoller.waiterCount()).toBe(1);
		controller.abort();
		const outcome = await promise;
		expect(outcome).toBe("aborted");
		expect(nugAvailabilityPoller.waiterCount()).toBe(0);
	});

	test("treats a model missing the `available` flag as available (legacy gateway)", async () => {
		const providerId = "prov-avail-4";
		setNugCachedModels(providerId, [
			// No `available` field at all.
			{ id: "openai:gpt-5.5", channel: "openai", model: "gpt-5.5" },
		]);
		const controller = new AbortController();
		const outcome = await nugAvailabilityPoller.waitForModelAvailable({
			providerId,
			nugModelId: "openai:gpt-5.5",
			signal: controller.signal,
		});
		expect(outcome).toBe("available");
	});

	test("a recorded refusal prevents a stale cache from faking an instant recovery", async () => {
		// Regression (livelock): a caller suspends *because* the gateway refused
		// this model, so a pre-outage `available: true` snapshot is wrong by
		// construction. It used to resolve instantly, so the turn replayed the
		// full request, failed again, and spun. The loop was tight precisely
		// because no waiter was registered: the poller never ran, so nothing ever
		// refreshed the cache. This reproduces the real call order used by
		// narrator-session / subagent-executor.
		const providerId = "prov-avail-stale";
		setNugCachedModels(
			providerId,
			"sha256:pre-outage",
		);

		// The caller records what it just observed, then waits.

		const controller = new AbortController();
		const promise = nugAvailabilityPoller.waitForModelAvailable({
			providerId,
			signal: controller.signal,
		});
		// It must actually wait for a gateway-confirmed recovery.
		expect(nugAvailabilityPoller.waiterCount()).toBe(1);
		// The refusal is recorded, so no other reader can be misled either.

		controller.abort();
		expect(await promise).toBe("aborted");
		expect(nugAvailabilityPoller.waiterCount()).toBe(0);
	});

	test("a catalog refresh clears a recorded unavailability", async () => {
		// The override must be self-clearing, otherwise a model could never come
		// back without a restart.
		const providerId = "prov-avail-refresh";
		const models = [
		];
		setNugCachedModels(providerId, models, "sha256:before");

		// A real refresh replaces the model list wholesale.
		setNugCachedModels(providerId, models, "sha256:after");

		// ...and the fast path is usable again.
		const controller = new AbortController();
		const outcome = await nugAvailabilityPoller.waitForModelAvailable({
			providerId,
			signal: controller.signal,
		});
		expect(outcome).toBe("available");
		expect(nugAvailabilityPoller.waiterCount()).toBe(0);
	});

	test("marking an uncached model or provider is a no-op", () => {
		const providerId = "prov-avail-partial";
	});
});
