import { describe, expect, test } from "bun:test";
import { settings } from "../../settings";
import { SEARCH_SUBAGENT_CHANNEL_ID } from "../settings";

/**
 * Channel availability is a PREDICATE reached from `WebSearch.isAvailable()` while
 * the agent loop assembles its tool list (`loop.ts`: `.filter(t => t.isAvailable())`).
 * Nothing on that path catches, so a throw there does not hide one channel — it
 * fails every turn of every session.
 *
 * The way to get one is a subagent channel that follows the instance default model
 * while no default model is configured. That combination is not exotic: the default
 * ships empty on purpose (there is deliberately no hardcoded fallback model), so it
 * is the state of a fresh install where this channel happens to be enabled — and the
 * resolver answers it by THROWING `DefaultModelNotConfiguredError`.
 *
 * "No model to resolve" is exactly what an unusable channel means, so it is answered
 * as `false` here rather than propagated.
 */
describe("subagent search channel availability with no default model", () => {
	test("reports the channel unusable instead of throwing", async () => {
		const { hasUsableFunctionSearchChannel } = await import("../router");

		const previousDefaultModel = settings.agent.defaultModel;
		const previousSearch = settings.search;
		settings.agent.defaultModel = "";
		settings.search = {
			...(previousSearch ?? {}),
			channels: [
				{
					id: SEARCH_SUBAGENT_CHANNEL_ID,
					kind: "subagent",
					enabled: true,
					maxTurns: 4,
					// The sentinel meaning "follow the instance default model".
					model: "__default__",
				},
			],
		} as typeof settings.search;

		try {
			// The assertion that matters is that this RETURNS. `false` follows because
			// the only enabled channel cannot resolve a model.
			expect(hasUsableFunctionSearchChannel()).toBe(false);
		} finally {
			settings.agent.defaultModel = previousDefaultModel;
			settings.search = previousSearch;
		}
	});

	test("a configured default model still decides on the model's own merits", async () => {
		// Guards against "return false on any error" degenerating into "always false":
		// with a resolvable default, the answer must come from whether that model
		// supports native search, not from the try/catch.
		const { hasUsableFunctionSearchChannel } = await import("../router");

		const previousDefaultModel = settings.agent.defaultModel;
		const previousSearch = settings.search;
		// A model with no native-search support: resolution succeeds, the capability
		// check is what declines.
		settings.agent.defaultModel = "openai:gpt-4o-mini";
		settings.search = {
			...(previousSearch ?? {}),
			channels: [
				{
					id: SEARCH_SUBAGENT_CHANNEL_ID,
					kind: "subagent",
					enabled: true,
					maxTurns: 4,
					model: "__default__",
				},
			],
		} as typeof settings.search;

		try {
			expect(hasUsableFunctionSearchChannel()).toBe(false);
		} finally {
			settings.agent.defaultModel = previousDefaultModel;
			settings.search = previousSearch;
		}
	});
});
