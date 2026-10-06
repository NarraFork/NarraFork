import { describe, expect, test } from "bun:test";
import {
	canExtendGrant,
	canRelaxRestriction,
	mergeGrantTrait,
	mergeRestrictionTrait,
	mergeToggleMapTrait,
	mergeToggleTrait,
	mergeValueTrait,
	normalizeTraitToggle,
	type ResolvedTraitSet,
	TRAIT_LAYERS,
} from "../trait-layers";

function items(resolved: ResolvedTraitSet): string[] {
	return [...resolved.items].sort();
}

function enforced(resolved: ResolvedTraitSet): string[] {
	return [...resolved.enforced].sort();
}

describe("layer ordering", () => {
	test("layers run user → project → narrator", () => {
		expect(TRAIT_LAYERS).toEqual(["user", "project", "narrator"]);
	});
});

describe("mergeRestrictionTrait", () => {
	test("a single layer resolves to itself (equivalence with today's flat behaviour)", () => {
		const resolved = mergeRestrictionTrait({ narrator: { items: ["Bash", "Write"] } });
		expect(items(resolved)).toEqual(["Bash", "Write"]);
		expect(enforced(resolved)).toEqual([]);
		expect(resolved.sources).toEqual(["narrator"]);
	});

	test("no layer declaring anything resolves to empty", () => {
		const resolved = mergeRestrictionTrait({});
		expect(items(resolved)).toEqual([]);
		expect(resolved.sources).toEqual([]);
	});

	test("omitted layers are inherited, not treated as empty", () => {
		// Only the project layer speaks; the narrator inherits it.
		const resolved = mergeRestrictionTrait({ project: { items: ["Bash"] } });
		expect(items(resolved)).toEqual(["Bash"]);
	});

	test("an enforced lower layer cannot be relaxed by a higher one", () => {
		const resolved = mergeRestrictionTrait({
			project: { items: ["Bash"], enforced: true },
			// The narrator tries to drop Bash by declaring an empty set.
			narrator: { items: [] },
		});
		expect(items(resolved)).toEqual(["Bash"]);
		expect(enforced(resolved)).toEqual(["Bash"]);
	});

	test("a non-enforced lower layer may be relaxed by a higher one", () => {
		const resolved = mergeRestrictionTrait({
			project: { items: ["SomeSkill"], enforced: false },
			narrator: { items: [] },
		});
		expect(items(resolved)).toEqual([]);
	});

	test("a higher layer may always add restrictions", () => {
		const resolved = mergeRestrictionTrait({
			project: { items: ["Bash"], enforced: true },
			narrator: { items: ["Write"] },
		});
		// Its own addition plus the enforced floor it cannot remove.
		expect(items(resolved)).toEqual(["Bash", "Write"]);
	});

	test("enforced entries accumulate across layers", () => {
		const resolved = mergeRestrictionTrait({
			user: { items: ["A"], enforced: true },
			project: { items: ["B"], enforced: true },
			narrator: { items: [] },
		});
		expect(items(resolved)).toEqual(["A", "B"]);
		expect(enforced(resolved)).toEqual(["A", "B"]);
	});

	test("a higher enforced layer tightens without dropping lower items", () => {
		const resolved = mergeRestrictionTrait({
			user: { items: ["A"] },
			narrator: { items: ["B"], enforced: true },
		});
		expect(items(resolved)).toEqual(["A", "B"]);
	});

	test("records which layers contributed", () => {
		const resolved = mergeRestrictionTrait({
			user: { items: ["A"] },
			narrator: { items: ["A", "B"] },
		});
		expect(resolved.sources).toEqual(["user", "narrator"]);
	});
});

describe("mergeGrantTrait", () => {
	test("a single layer resolves to itself", () => {
		const resolved = mergeGrantTrait({ narrator: { items: ["gpt-5", "claude"] } });
		expect(items(resolved)).toEqual(["claude", "gpt-5"]);
	});

	test("a higher layer may narrow the grant", () => {
		const resolved = mergeGrantTrait({
			project: { items: ["a", "b", "c"] },
			narrator: { items: ["b"] },
		});
		expect(items(resolved)).toEqual(["b"]);
	});

	test("a higher layer cannot widen past the layer below", () => {
		const resolved = mergeGrantTrait({
			project: { items: ["a", "b"] },
			// "c" was never granted below, so it must not appear.
			narrator: { items: ["a", "c"] },
		});
		expect(items(resolved)).toEqual(["a"]);
	});

	test("an enforced bound cannot be exceeded by any later layer", () => {
		const resolved = mergeGrantTrait({
			user: { items: ["a", "b"], enforced: true },
			project: { items: ["a"] },
			narrator: { items: ["a", "b"] },
		});
		// The project narrowed to {a}; the narrator cannot climb back to {a,b}.
		expect(items(resolved)).toEqual(["a"]);
	});

	test("narrowing to empty is representable and distinct from inheriting", () => {
		const inherited = mergeGrantTrait({ project: { items: ["a"] } });
		const narrowed = mergeGrantTrait({
			project: { items: ["a"] },
			narrator: { items: [] },
		});
		expect(items(inherited)).toEqual(["a"]);
		expect(items(narrowed)).toEqual([]);
	});

	test("no declaration resolves to empty with no sources", () => {
		const resolved = mergeGrantTrait({});
		expect(items(resolved)).toEqual([]);
		expect(resolved.sources).toEqual([]);
	});
});

describe("restriction vs grant merge directions differ", () => {
	test("the same layer inputs merge in opposite directions", () => {
		const layers = {
			project: { items: ["a", "b"] },
			narrator: { items: ["b", "c"] },
		} as const;
		// Restriction accumulates (a limit must not be lost)…
		expect(items(mergeRestrictionTrait(layers))).toEqual(["b", "c"]);
		// …while a grant may only narrow (an allowlist must not grow).
		expect(items(mergeGrantTrait(layers))).toEqual(["b"]);
	});
});

describe("mergeToggleTrait", () => {
	test("nearest explicit value wins", () => {
		expect(mergeToggleTrait({ user: "on", project: "off" })).toBe("off");
		expect(mergeToggleTrait({ user: "off", narrator: "on" })).toBe("on");
	});

	test("inherit defers to the layer below", () => {
		expect(mergeToggleTrait({ user: "on", narrator: "inherit" })).toBe("on");
		expect(mergeToggleTrait({ user: "on", project: "inherit", narrator: "inherit" })).toBe("on");
	});

	test("nothing decided returns inherit so callers apply their own default", () => {
		expect(mergeToggleTrait({})).toBe("inherit");
		expect(mergeToggleTrait({ project: "inherit" })).toBe("inherit");
	});

	test("malformed values degrade to inherit rather than throwing", () => {
		expect(normalizeTraitToggle("yes")).toBe("inherit");
		expect(normalizeTraitToggle(null)).toBe("inherit");
		expect(normalizeTraitToggle(1)).toBe("inherit");
		// biome-ignore lint/suspicious/noExplicitAny: exercising the runtime guard
		expect(mergeToggleTrait({ narrator: "bogus" as any })).toBe("inherit");
	});
});

describe("mergeValueTrait", () => {
	test("nearest declared value wins and absent layers inherit", () => {
		expect(mergeValueTrait({ user: "private", project: "all" })).toBe("all");
		expect(mergeValueTrait({ user: "private" })).toBe("private");
		expect(mergeValueTrait<string>({})).toBeNull();
	});
});

describe("mergeToggleMapTrait", () => {
	test("each key resolves independently", () => {
		const resolved = mergeToggleMapTrait({
			user: { d1: "on", d2: "off" },
			narrator: { d2: "on" },
		});
		expect(resolved).toEqual({ d1: "on", d2: "on" });
	});

	test("an inherit entry does not clear a lower layer's decision", () => {
		const resolved = mergeToggleMapTrait({
			user: { d1: "on" },
			narrator: { d1: "inherit" },
		});
		expect(resolved).toEqual({ d1: "on" });
	});

	test("keys nobody decided are absent, not defaulted", () => {
		expect(mergeToggleMapTrait({ user: { d1: "inherit" } })).toEqual({});
	});
});

describe("edit-time guards", () => {
	test("canRelaxRestriction refuses enforced items only", () => {
		const resolved = mergeRestrictionTrait({
			project: { items: ["Bash"], enforced: true },
			user: { items: ["Write"] },
		});
		expect(canRelaxRestriction(resolved, "Bash")).toBe(false);
		expect(canRelaxRestriction(resolved, "Write")).toBe(true);
	});

	test("canExtendGrant refuses items outside an enforced bound", () => {
		const bounded = mergeGrantTrait({ user: { items: ["a"], enforced: true } });
		expect(canExtendGrant(bounded, "a")).toBe(true);
		expect(canExtendGrant(bounded, "b")).toBe(false);
		const unbounded = mergeGrantTrait({ user: { items: ["a"] } });
		expect(canExtendGrant(unbounded, "b")).toBe(true);
	});
});
