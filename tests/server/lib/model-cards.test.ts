import { afterEach, describe, expect, test } from "bun:test";
import {
	buildModelCardIndex,
	cardEffortLevels,
	lookupModelCard,
	type ModelCard,
	resolveModelCardField,
} from "@shared/model-card";
import {
	BUILTIN_MODEL_CARDS,
	diffModelCards,
	getEffectiveModelCards,
	invalidateModelCardCache,
	isUserSetField,
	mergeModelCards,
	modelCardEffortLevels,
	modelCardPricing,
} from "../../../server/lib/model-cards";

afterEach(() => {
	invalidateModelCardCache();
});

function builtinCard(key: string): ModelCard {
	const card = BUILTIN_MODEL_CARDS.find((c) => c.modelKey === key);
	if (!card) throw new Error(`no builtin card for ${key}`);
	return card;
}

describe("card matching", () => {
	const cards: ModelCard[] = [
		{ modelKey: "base-model", contextWindow: 100, aliases: ["base-alias"] },
		{ modelKey: "base-model-mini", contextWindow: 200 },
		{ modelKey: "prefixed", contextWindow: 300, matchPrefixes: ["prefixed"] },
	];

	test("exact key, alias and date-suffix stripping each match", () => {
		expect(lookupModelCard("base-model", cards)?.matchedVia).toBe("exact");
		expect(lookupModelCard("base-alias", cards)?.matchedVia).toBe("alias");
		const stripped = lookupModelCard("base-model-2026-06-01", cards);
		expect(stripped?.matchedVia).toBe("suffix-stripped");
		expect(stripped?.card.modelKey).toBe("base-model");
	});

	test("a semantic suffix is never stripped onto the base card", () => {
		// The whole point of restricting stripping to date/channel suffixes: a
		// variant must keep its own numbers rather than inheriting the base's.
		expect(lookupModelCard("base-model-mini", cards)?.card.modelKey).toBe("base-model-mini");
	});

	test("an unlisted id matches nothing unless a card declares a prefix", () => {
		expect(lookupModelCard("base-model-thinking", cards)).toBeNull();
		expect(lookupModelCard("prefixed-anything", cards)?.matchedVia).toBe("prefix");
	});

	test("a trailing version-like number is not treated as a date", () => {
		// `-5000` is not a plausible month, so stripping must not happen; otherwise
		// an unrelated card could answer for this id.
		expect(lookupModelCard("base-model-5000", cards)).toBeNull();
	});

	test("longest declared prefix wins", () => {
		const overlapping: ModelCard[] = [
			{ modelKey: "short", contextWindow: 1, matchPrefixes: ["cl-opus-4"] },
			{ modelKey: "long", contextWindow: 2, matchPrefixes: ["cl-opus-4-8"] },
		];
		expect(lookupModelCard("cl-opus-4-8-thinking", overlapping)?.card.modelKey).toBe("long");
		expect(lookupModelCard("cl-opus-4-5-thinking", overlapping)?.card.modelKey).toBe("short");
	});

	test("a card key is never shadowed by another card's alias", () => {
		const conflicting: ModelCard[] = [
			{ modelKey: "real", contextWindow: 1 },
			{ modelKey: "other", contextWindow: 2, aliases: ["real"] },
		];
		expect(lookupModelCard("real", conflicting)?.card.modelKey).toBe("real");
	});
});

describe("per-field resolution walks past cards that do not assert the field", () => {
	// The concrete shape this exists for: a price-only card matches an id earlier
	// in the chain than the card carrying the window.
	const cards: ModelCard[] = [
		{ modelKey: "m-4-5", officialPricing: { input: 3, output: 15 } },
		{ modelKey: "m-4", contextWindow: 200_000, matchPrefixes: ["m-4"] },
	];
	const index = buildModelCardIndex(cards);

	test("a sparse earlier match does not shadow a later card that has the value", () => {
		// Exact-matches the price-only card, which carries no window at all.
		expect(lookupModelCard("m-4-5", index)?.card.modelKey).toBe("m-4-5");
		const window = resolveModelCardField("m-4-5-20260101", index, (card) => card.contextWindow);
		expect(window?.value).toBe(200_000);
		expect(window?.card.modelKey).toBe("m-4");
	});

	test("the field-bearing card is still the one whose value is returned", () => {
		const price = resolveModelCardField("m-4-5", index, (card) => card.officialPricing);
		expect(price?.card.modelKey).toBe("m-4-5");
	});
});

describe("effort levels never carry none", () => {
	test("a hand-written none is filtered out of a card's tiers", () => {
		// Reachable through a hand-edited settings.json. As a clamp target, `none`
		// could turn a requested `low` into reasoning being switched off.
		const card: ModelCard = {
			modelKey: "x",
			effortLevels: ["none", "medium", "high"] as ModelCard["effortLevels"],
		};
		expect(cardEffortLevels(card)).toEqual(["medium", "high"]);
	});

	test("a card whose only tier was none asserts nothing", () => {
		const card: ModelCard = {
			modelKey: "x",
			effortLevels: ["none"] as ModelCard["effortLevels"],
		};
		expect(cardEffortLevels(card)).toBeUndefined();
	});

	test("no builtin card declares none", () => {
		for (const card of BUILTIN_MODEL_CARDS) {
			expect(card.effortLevels ?? []).not.toContain("none");
		}
	});

	test("builtin codex tiers are reachable through the resolver", () => {
		expect(modelCardEffortLevels("gpt-5.6-sol", [])).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(modelCardEffortLevels("gpt-6-astra", [])).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});
});

describe("merge overlays user deltas field by field", () => {
	test("a delta carrying one field keeps the rest of the builtin card", () => {
		const builtin = builtinCard("gpt-5.5");
		const { cards } = mergeModelCards([{ modelKey: "gpt-5.5", contextWindow: 123_456 }]);
		const merged = cards.find((c) => c.modelKey === "gpt-5.5");
		expect(merged?.contextWindow).toBe(123_456);
		// Untouched fields must survive: a delta is not a replacement.
		expect(merged?.maxCompletionTokens).toBe(builtin.maxCompletionTokens);
		expect(merged?.officialPricing).toEqual(builtin.officialPricing);
		expect(merged?.effortLevels).toEqual(builtin.effortLevels);
	});

	test("provenance distinguishes a user-set field from inherited ones", () => {
		const { cards, provenance } = mergeModelCards([{ modelKey: "gpt-5.5", contextWindow: 1 }]);
		expect(provenance.get("gpt-5.5")?.overriddenFields).toEqual(["contextWindow"]);
		const merged = cards.find((c) => c.modelKey === "gpt-5.5");
		expect(isUserSetField(merged, "contextWindow")).toBe(true);
		expect(isUserSetField(merged, "maxCompletionTokens")).toBe(false);
	});

	test("the provenance marker is not serialized", () => {
		// It must not reach settings.json or an API response — it is derived state,
		// and persisting it would create data needing migration later.
		const { cards } = mergeModelCards([{ modelKey: "gpt-5.5", contextWindow: 1 }]);
		const merged = cards.find((c) => c.modelKey === "gpt-5.5");
		expect(JSON.stringify(merged)).not.toContain("userFields");
	});

	test("a user-created key is added and marked as not builtin", () => {
		const { cards, provenance } = mergeModelCards([
			{ modelKey: "brand-new-model", contextWindow: 42 },
		]);
		const created = cards.find((c) => c.modelKey === "brand-new-model");
		expect(created?.contextWindow).toBe(42);
		expect(created?.builtin).toBe(false);
		expect(provenance.get("brand-new-model")?.userCreated).toBe(true);
	});

	test("a tombstone removes a builtin card", () => {
		const { cards } = mergeModelCards([{ modelKey: "gpt-5.5", deleted: true }]);
		expect(cards.find((c) => c.modelKey === "gpt-5.5")).toBeUndefined();
	});
});

describe("diff stores only what changed", () => {
	test("an untouched effective set produces no deltas", () => {
		const effective = getEffectiveModelCards([]);
		expect(diffModelCards(effective)).toEqual([]);
	});

	test("one edited field yields a delta with only that field", () => {
		const effective = getEffectiveModelCards([]).map((card) =>
			card.modelKey === "gpt-5.5" ? { ...card, contextWindow: 999 } : card,
		);
		const deltas = diffModelCards(effective);
		expect(deltas).toEqual([{ modelKey: "gpt-5.5", contextWindow: 999 }]);
	});

	test("editing a field back to the builtin value clears the delta", () => {
		const builtin = builtinCard("gpt-5.5");
		const edited = getEffectiveModelCards([]).map((card) =>
			card.modelKey === "gpt-5.5" ? { ...card, contextWindow: 999 } : card,
		);
		const restored = edited.map((card) =>
			card.modelKey === "gpt-5.5" ? { ...card, contextWindow: builtin.contextWindow } : card,
		);
		expect(diffModelCards(restored)).toEqual([]);
	});

	test("a round trip through diff and merge is lossless", () => {
		const effective = getEffectiveModelCards([]).map((card) =>
			card.modelKey === "gpt-5.5" ? { ...card, contextWindow: 555, notes: "hand tuned" } : card,
		);
		const { cards: reMerged } = mergeModelCards(diffModelCards(effective));
		const target = reMerged.find((c) => c.modelKey === "gpt-5.5");
		expect(target?.contextWindow).toBe(555);
		expect(target?.notes).toBe("hand tuned");
		expect(target?.officialPricing).toEqual(builtinCard("gpt-5.5").officialPricing);
	});

	test("a removed builtin card becomes a tombstone", () => {
		const effective = getEffectiveModelCards([]).filter((c) => c.modelKey !== "gpt-5.5");
		expect(diffModelCards(effective)).toContainEqual({ modelKey: "gpt-5.5", deleted: true });
	});

	test("a cleared list is not stored as a change", () => {
		// The editor sends `[]` for a list the user never filled in. Treating that
		// as different from "absent" would persist a no-op delta and then pin the
		// field against future builtin updates.
		const effective = getEffectiveModelCards([]).map((card) =>
			card.modelKey === "gpt-5.5" ? { ...card, aliases: [] } : card,
		);
		expect(diffModelCards(effective)).toEqual([]);
	});

	test("a user-created card is stored whole", () => {
		const effective = [
			...getEffectiveModelCards([]),
			{ modelKey: "my-model", contextWindow: 7, builtin: false },
		];
		const deltas = diffModelCards(effective);
		expect(deltas).toEqual([{ modelKey: "my-model", contextWindow: 7 }]);
	});
});

describe("pricing resolution", () => {
	test("a card with no non-zero price does not price the model", () => {
		// Otherwise a capability-only card would report real usage as free rather
		// than as unpriced.
		expect(modelCardPricing("deepseek-chat", [])).toBeNull();
	});

	test("builtin prices resolve, including Astra", () => {
		expect(modelCardPricing("gpt-6-astra", [])).toMatchObject({
			input: 10.0,
			output: 50.0,
			cacheRead: 1.0,
			cacheWrite: 12.5,
		});
		expect(modelCardPricing("gpt-5.6-sol", [])).toMatchObject({ input: 5.0, output: 30.0 });
		expect(modelCardPricing("gpt-5.6", [])).toMatchObject({ input: 5.0, output: 30.0 });
	});

	test("a user delta overrides the builtin price", () => {
		const cards: ModelCard[] = [
			{ modelKey: "gpt-5.6-sol", officialPricing: { input: 1.5, output: 9 } },
		];
		expect(modelCardPricing("gpt-5.6-sol", cards)).toMatchObject({ input: 1.5, output: 9 });
	});
});

describe("builtin card data integrity", () => {
	test("does not seed GPT/Codex models older than GPT-5.5", () => {
		const keys = new Set(BUILTIN_MODEL_CARDS.map((card) => card.modelKey));
		for (const retired of [
			"gpt-5-codex",
			"gpt-5.1-codex",
			"gpt-5.1-codex-max",
			"gpt-5.1-codex-mini",
			"gpt-5.2",
			"gpt-5.2-codex",
			"gpt-5.3-codex",
			"gpt-5.3-codex-spark",
			"gpt-5.4",
			"gpt-5.4-mini",
		]) {
			expect(keys.has(retired)).toBe(false);
		}
	});

	test("model keys are unique and already normalized", () => {
		const seen = new Set<string>();
		for (const card of BUILTIN_MODEL_CARDS) {
			expect(card.modelKey).toBe(card.modelKey.trim().toLowerCase());
			expect(seen.has(card.modelKey)).toBe(false);
			seen.add(card.modelKey);
		}
	});

	test("no alias collides with a real model key", () => {
		const keys = new Set(BUILTIN_MODEL_CARDS.map((c) => c.modelKey));
		for (const card of BUILTIN_MODEL_CARDS) {
			for (const alias of card.aliases ?? []) {
				expect(keys.has(alias)).toBe(false);
			}
		}
	});

	test("every priced card charges at least as much for output as for input", () => {
		for (const card of BUILTIN_MODEL_CARDS) {
			const pricing = card.officialPricing;
			if (!pricing?.input || !pricing.output) continue;
			expect(pricing.output).toBeGreaterThanOrEqual(pricing.input);
		}
	});
});
