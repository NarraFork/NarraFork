import { describe, expect, test } from "bun:test";
import {
	hasDraftTrait,
	isDraftTrait,
	NARRATOR_DRAFT_TRAIT_PREFIX,
	parseDraftTrait,
	redactDraftTraits,
	upsertDraftTrait,
} from "../narrator-utils";

describe("narrator draft traits", () => {
	test("redacts encoded draft traits from public trait arrays", () => {
		const traits = upsertDraftTrait(["standalone", "plan"], {
			text: "secret draft body",
			updatedAt: "2026-01-01T00:00:00.000Z",
			updatedBy: "user_1",
			sourceId: "source_1",
		});

		expect(traits.some((trait) => trait.startsWith(NARRATOR_DRAFT_TRAIT_PREFIX))).toBe(true);
		expect(traits.some(isDraftTrait)).toBe(true);
		expect(hasDraftTrait(traits)).toBe(true);
		expect(parseDraftTrait(traits)?.text).toBe("secret draft body");
		expect(redactDraftTraits(traits)).toEqual(["standalone", "plan"]);
	});
});
