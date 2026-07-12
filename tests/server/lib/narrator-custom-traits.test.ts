import { afterEach, describe, expect, test } from "bun:test";
import {
	BLOCKED_SKILLS_TRAIT_PREFIX,
	getBlockedSkills,
	isBlockedSkillsEmpty,
	isSkillBlocked,
	normalizeBlockedSkills,
	normalizeSubagentModelRestriction,
	parseBlockedSkillsTrait,
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

describe("narrator blocked-skills trait", () => {
	test("normalizes names: trims, dedupes, drops empties, caps length", () => {
		const trait = normalizeBlockedSkills({
			all: false,
			names: ["  pdf  ", "pdf", "", "commit", 42, "commit"],
		});
		expect(trait).toEqual({ version: 1, all: false, names: ["pdf", "commit"] });
	});

	test("coerces missing/invalid input to an empty, non-blocking trait", () => {
		expect(normalizeBlockedSkills(null)).toEqual({ version: 1, all: false, names: [] });
		expect(normalizeBlockedSkills({ all: "yes" })).toEqual({ version: 1, all: false, names: [] });
		expect(isBlockedSkillsEmpty(normalizeBlockedSkills(undefined))).toBe(true);
		expect(isBlockedSkillsEmpty(normalizeBlockedSkills({ all: true, names: [] }))).toBe(false);
		expect(isBlockedSkillsEmpty(normalizeBlockedSkills({ all: false, names: ["x"] }))).toBe(false);
	});

	test("round-trips through encoded trait and resolves enforcement state", () => {
		const trait = normalizeBlockedSkills({ all: false, names: ["pdf", "review-pr"] });
		const traits = upsertEncodedTrait([], BLOCKED_SKILLS_TRAIT_PREFIX, trait);

		const parsed = parseBlockedSkillsTrait(traits);
		expect(parsed).toEqual({ version: 1, all: false, names: ["pdf", "review-pr"] });

		const state = getBlockedSkills(traits);
		expect(state.all).toBe(false);
		expect(isSkillBlocked(state, "pdf")).toBe(true);
		expect(isSkillBlocked(state, "review-pr")).toBe(true);
		expect(isSkillBlocked(state, "commit")).toBe(false);
	});

	test("all=true blocks every skill regardless of names", () => {
		const trait = normalizeBlockedSkills({ all: true, names: ["pdf"] });
		const traits = upsertEncodedTrait([], BLOCKED_SKILLS_TRAIT_PREFIX, trait);
		const state = getBlockedSkills(traits);
		expect(state.all).toBe(true);
		expect(isSkillBlocked(state, "anything-at-all")).toBe(true);
	});

	test("no trait resolves to an empty, non-blocking state", () => {
		const state = getBlockedSkills([]);
		expect(state.all).toBe(false);
		expect(state.names.size).toBe(0);
		expect(isSkillBlocked(state, "pdf")).toBe(false);
	});
});
