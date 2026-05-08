import { afterEach, describe, expect, test } from "bun:test";
import {
	normalizeSubagentModelRestriction,
	resolveEffectiveSubagentModelPolicy,
	SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX,
	upsertEncodedTrait,
} from "../../../server/lib/narrator-custom-traits";
import { settings } from "../../../server/lib/settings";

const originalPools = {
	explore: [...settings.agent.subagentAllowedModels.explore],
	plan: [...settings.agent.subagentAllowedModels.plan],
	general: [...settings.agent.subagentAllowedModels.general],
};

afterEach(() => {
	settings.agent.subagentAllowedModels = {
		explore: [...originalPools.explore],
		plan: [...originalPools.plan],
		general: [...originalPools.general],
	};
});

describe("narrator custom subagent model traits", () => {
	test("falls back to global pools when a custom trait omits a subagent type", () => {
		settings.agent.subagentAllowedModels = {
			explore: ["openai:global-explore"],
			plan: ["openai:global-plan"],
			general: ["openai:global-general"],
		};
		const restriction = normalizeSubagentModelRestriction({
			pools: { explore: [{ model: "openai:custom-explore" }] },
		});
		const traits = upsertEncodedTrait([], SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, restriction);

		const explorePolicy = resolveEffectiveSubagentModelPolicy(traits, "explore");
		const planPolicy = resolveEffectiveSubagentModelPolicy(traits, "plan");

		expect(explorePolicy).toMatchObject({ source: "custom", poolKey: "explore" });
		expect(explorePolicy.models.map((entry) => entry.model)).toEqual(["openai:custom-explore"]);
		expect(planPolicy).toMatchObject({ source: "settings", poolKey: "plan" });
		expect(planPolicy.models.map((entry) => entry.model)).toEqual(["openai:global-plan"]);
	});

	test("empty custom restrictions do not disable global pools", () => {
		settings.agent.subagentAllowedModels = {
			explore: [],
			plan: ["openai:global-plan"],
			general: [],
		};
		const restriction = normalizeSubagentModelRestriction({ pools: {} });
		const traits = upsertEncodedTrait([], SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, restriction);

		const policy = resolveEffectiveSubagentModelPolicy(traits, "plan");

		expect(policy).toMatchObject({ source: "settings", poolKey: "plan" });
		expect(policy.models.map((entry) => entry.model)).toEqual(["openai:global-plan"]);
	});
});
