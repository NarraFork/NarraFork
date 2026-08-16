import { describe, expect, test } from "bun:test";
import {
	BLOCKED_SKILLS_TRAIT_PREFIX,
	DISABLED_TOOLS_TRAIT_PREFIX,
	getBlockedSkills,
	getDisabledToolSet,
	resolveEffectiveSubagentModelPolicy,
	SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX,
	upsertEncodedTrait,
} from "../narrator-custom-traits";
import {
	ENFORCED_TRAIT_PREFIX,
	parseEnforcedKeys,
	resolveLayeredTraits,
	withEnforcedKeys,
} from "../trait-resolution";

function disabledTools(tools: string[], base: unknown = []): string[] {
	return upsertEncodedTrait(base, DISABLED_TOOLS_TRAIT_PREFIX, { version: 1, tools });
}

function blockedSkills(value: { all?: boolean; names?: string[] }, base: unknown = []): string[] {
	return upsertEncodedTrait(base, BLOCKED_SKILLS_TRAIT_PREFIX, {
		version: 1,
		all: value.all ?? false,
		names: value.names ?? [],
	});
}

function subagentModels(
	pools: Record<string, Array<string | { model: string; purpose?: string }>>,
	base: unknown = [],
): string[] {
	return upsertEncodedTrait(base, SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, {
		version: 1,
		pools: Object.fromEntries(
			Object.entries(pools).map(([k, v]) => [
				k,
				v.map((item) => (typeof item === "string" ? { model: item } : item)),
			]),
		),
	});
}

// "Bash" and "Write" are real configurable tool names; normalizeDisabledTools
// drops anything not in the tool registry, so fabricated names would vanish.
const TOOL_A = "Bash";
const TOOL_B = "Write";

describe("equivalence with today's single-layer behaviour", () => {
	test("with no upper layers the traits array is returned byte-identically", () => {
		const narratorTraits = ["plan", "named", ...disabledTools([TOOL_A])];
		const resolved = resolveLayeredTraits({ narrator: { traits: narratorTraits } });
		expect(resolved.traits).toEqual(narratorTraits);
		expect(resolved.sources).toEqual(["narrator"]);
	});

	test("empty upper layers are treated as absent", () => {
		const narratorTraits = disabledTools([TOOL_A]);
		for (const upper of [undefined, null, { traits: [] }, { traits: null }]) {
			const resolved = resolveLayeredTraits({
				user: upper as never,
				project: upper as never,
				narrator: { traits: narratorTraits },
			});
			expect(resolved.traits).toEqual(narratorTraits);
		}
	});

	test("existing getters produce identical results through the resolver", () => {
		const narratorTraits = [
			...disabledTools([TOOL_A, TOOL_B]),
			...blockedSkills({ names: ["s1"] }, []),
		];
		// Combine both payloads into one array the way a real narrator row would.
		const combined = blockedSkills({ names: ["s1"] }, disabledTools([TOOL_A, TOOL_B]));
		const resolved = resolveLayeredTraits({ narrator: { traits: combined } });
		expect([...getDisabledToolSet(resolved.traits)].sort()).toEqual(
			[...getDisabledToolSet(combined)].sort(),
		);
		expect(getBlockedSkills(resolved.traits)).toEqual(getBlockedSkills(combined));
		void narratorTraits;
	});

	test("bare tags and unrelated encoded traits survive merging", () => {
		const resolved = resolveLayeredTraits({
			project: { traits: disabledTools([TOOL_A]) },
			narrator: { traits: ["plan", "named", "custom-unrelated:xyz"] },
		});
		expect(resolved.traits).toContain("plan");
		expect(resolved.traits).toContain("named");
		expect(resolved.traits).toContain("custom-unrelated:xyz");
		expect(getDisabledToolSet(resolved.traits).has(TOOL_A)).toBe(true);
	});
});

describe("disabled tools (restriction)", () => {
	test("a project restriction is inherited by a narrator that declares nothing", () => {
		const resolved = resolveLayeredTraits({
			project: { traits: disabledTools([TOOL_A]) },
			narrator: { traits: [] },
		});
		expect(getDisabledToolSet(resolved.traits).has(TOOL_A)).toBe(true);
	});

	test("a narrator declaring its own set replaces a non-enforced lower default", () => {
		const resolved = resolveLayeredTraits({
			user: { traits: disabledTools([TOOL_A]) },
			narrator: { traits: disabledTools([TOOL_B]) },
		});
		// The narrator states the full set it wants. TOOL_A was only a user-level
		// default (not enforced), so it is dropped rather than silently accumulated —
		// this is what makes `enforced` the meaningful distinction.
		expect([...getDisabledToolSet(resolved.traits)].sort()).toEqual([TOOL_B]);
	});

	test("an enforced lower entry accumulates on top of the narrator's own set", () => {
		const resolved = resolveLayeredTraits({
			user: { traits: withEnforcedKeys(disabledTools([TOOL_A]), { disabledTools: true }) },
			narrator: { traits: disabledTools([TOOL_B]) },
		});
		expect([...getDisabledToolSet(resolved.traits)].sort()).toEqual([TOOL_A, TOOL_B].sort());
	});

	test("a non-enforced project restriction can be relaxed by the narrator", () => {
		const resolved = resolveLayeredTraits({
			project: { traits: disabledTools([TOOL_A]) },
			narrator: { traits: disabledTools([]) },
		});
		expect(getDisabledToolSet(resolved.traits).has(TOOL_A)).toBe(false);
	});

	test("an enforced project restriction cannot be relaxed by the narrator", () => {
		const projectTraits = withEnforcedKeys(disabledTools([TOOL_A]), { disabledTools: true });
		const resolved = resolveLayeredTraits({
			project: { traits: projectTraits },
			narrator: { traits: disabledTools([]) },
		});
		expect(getDisabledToolSet(resolved.traits).has(TOOL_A)).toBe(true);
		expect(resolved.enforced.disabledTools.has(TOOL_A)).toBe(true);
	});

	test("the enforced marker never leaks into the flattened output", () => {
		const projectTraits = withEnforcedKeys(disabledTools([TOOL_A]), { disabledTools: true });
		const resolved = resolveLayeredTraits({
			project: { traits: projectTraits },
			narrator: { traits: [] },
		});
		expect(resolved.traits.some((t) => t.startsWith(ENFORCED_TRAIT_PREFIX))).toBe(false);
	});
});

describe("blocked skills (restriction with an all flag)", () => {
	test("names inherit and accumulate", () => {
		const resolved = resolveLayeredTraits({
			project: { traits: blockedSkills({ names: ["a"] }) },
			narrator: { traits: [] },
		});
		expect(getBlockedSkills(resolved.traits).names.has("a")).toBe(true);
	});

	test("all:true from any layer escalates", () => {
		const resolved = resolveLayeredTraits({
			project: { traits: blockedSkills({ all: true }) },
			narrator: { traits: [] },
		});
		expect(getBlockedSkills(resolved.traits).all).toBe(true);
	});

	test("a narrator may relax a non-enforced all:true", () => {
		const resolved = resolveLayeredTraits({
			project: { traits: blockedSkills({ all: true }) },
			narrator: { traits: blockedSkills({ all: false }) },
		});
		expect(getBlockedSkills(resolved.traits).all).toBe(false);
	});

	test("a narrator may not relax an enforced all:true", () => {
		const projectTraits = withEnforcedKeys(blockedSkills({ all: true }), {
			blockedSkills: true,
		});
		const resolved = resolveLayeredTraits({
			project: { traits: projectTraits },
			narrator: { traits: blockedSkills({ all: false }) },
		});
		expect(getBlockedSkills(resolved.traits).all).toBe(true);
		expect(resolved.enforced.blockedSkills.all).toBe(true);
	});

	test("an enforced name survives a narrator that omits it", () => {
		const projectTraits = withEnforcedKeys(blockedSkills({ names: ["keep"] }), {
			blockedSkills: true,
		});
		const resolved = resolveLayeredTraits({
			project: { traits: projectTraits },
			narrator: { traits: blockedSkills({ names: [] }) },
		});
		expect(getBlockedSkills(resolved.traits).names.has("keep")).toBe(true);
	});
});

describe("subagent models (grant)", () => {
	test("a narrator may narrow an inherited pool", () => {
		const resolved = resolveLayeredTraits({
			project: { traits: subagentModels({ explore: ["m1", "m2"] }) },
			narrator: { traits: subagentModels({ explore: ["m1"] }) },
		});
		const policy = resolveEffectiveSubagentModelPolicy(resolved.traits, "explore");
		expect(policy.models.map((m) => m.model)).toEqual(["m1"]);
	});

	test("a narrator cannot widen a pool beyond the project grant", () => {
		const resolved = resolveLayeredTraits({
			project: { traits: subagentModels({ explore: ["m1"] }) },
			narrator: { traits: subagentModels({ explore: ["m1", "m2"] }) },
		});
		const policy = resolveEffectiveSubagentModelPolicy(resolved.traits, "explore");
		// m2 was never granted below, so it must not appear.
		expect(policy.models.map((m) => m.model)).toEqual(["m1"]);
	});

	test("a pool absent from the narrator is inherited", () => {
		const resolved = resolveLayeredTraits({
			project: { traits: subagentModels({ plan: ["mp"] }) },
			narrator: { traits: subagentModels({ explore: ["me"] }) },
		});
		expect(
			resolveEffectiveSubagentModelPolicy(resolved.traits, "plan").models.map((m) => m.model),
		).toEqual(["mp"]);
	});

	test("model purpose metadata is preserved through merging", () => {
		const resolved = resolveLayeredTraits({
			project: { traits: subagentModels({ explore: [{ model: "m1", purpose: "cheap" }] }) },
			narrator: { traits: subagentModels({ explore: ["m1"] }) },
		});
		const policy = resolveEffectiveSubagentModelPolicy(resolved.traits, "explore");
		expect(policy.models[0]).toEqual({ model: "m1", purpose: "cheap" });
	});

	test("an explicit empty pool stays distinguishable from inheriting", () => {
		const resolved = resolveLayeredTraits({
			project: { traits: subagentModels({ explore: ["m1"] }) },
			narrator: { traits: subagentModels({ explore: [] }) },
		});
		const policy = resolveEffectiveSubagentModelPolicy(resolved.traits, "explore");
		expect(policy.models).toEqual([]);
		expect(policy.isExplicitEmpty).toBe(true);
	});
});

describe("enforced key marker encoding", () => {
	test("round-trips", () => {
		const traits = withEnforcedKeys([], { disabledTools: true, blockedSkills: true });
		const keys = parseEnforcedKeys(traits);
		expect(keys.disabledTools).toBe(true);
		expect(keys.blockedSkills).toBe(true);
		expect(keys.subagentModels).toBe(false);
	});

	test("clearing all keys removes the marker entirely", () => {
		const withMarker = withEnforcedKeys([], { disabledTools: true });
		expect(withMarker.some((t) => t.startsWith(ENFORCED_TRAIT_PREFIX))).toBe(true);
		const cleared = withEnforcedKeys(withMarker, {});
		expect(cleared.some((t) => t.startsWith(ENFORCED_TRAIT_PREFIX))).toBe(false);
	});

	test("a malformed marker degrades to no enforcement rather than throwing", () => {
		expect(parseEnforcedKeys([`${ENFORCED_TRAIT_PREFIX}not-base64!!`])).toEqual({});
		expect(parseEnforcedKeys(null)).toEqual({});
	});
});

describe("layer source reporting", () => {
	test("reports only layers that declared a layered trait", () => {
		const resolved = resolveLayeredTraits({
			user: { traits: disabledTools([TOOL_A]) },
			// Bare tags only: not a layered declaration.
			project: { traits: ["something-else"] },
			narrator: { traits: [] },
		});
		expect(resolved.sources).toEqual(["user"]);
	});
});
