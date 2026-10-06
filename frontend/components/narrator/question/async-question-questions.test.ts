/**
 * The stored → banner question conversion.
 *
 * Worth pinning because the failure is a crash in a render path: the banner's render
 * maps `options` and reads each option's header/description without guarding, while the
 * stored form legitimately omits both for a free-form question. A missing default here
 * surfaces as a blank inbox rather than a type error.
 */

import { describe, expect, it } from "bun:test";
import type { AsyncQuestion } from "@frontend/types/narrator";
import { toBannerQuestions } from "./async-question-questions";

describe("toBannerQuestions", () => {
	it("fills the defaults the banner's type requires", () => {
		const out = toBannerQuestions([
			{ id: "cache", header: "Which cache?", options: [{ header: "Redis" }] },
		]);
		expect(out).toHaveLength(1);
		expect(out[0]?.header).toBe("Which cache?");
		expect(out[0]?.options).toEqual([{ header: "Redis" }]);
	});

	it("keeps a free-form question (no options) answerable", () => {
		const out = toBannerQuestions([{ id: "notes", header: "Anything else?" }]);
		expect(out[0]?.options).toEqual([]);
	});

	it("preserves multiSelect, description and previews when present", () => {
		const out = toBannerQuestions([
			{
				id: "targets",
				header: "Which targets?",
				description: "Pick all that apply",
				multiSelect: true,
				options: [{ header: "web", description: "the SPA", preview: "vite build" }],
			},
		]);
		expect(out[0]?.multiSelect).toBe(true);
		expect(out[0]?.description).toBe("Pick all that apply");
		expect(out[0]?.options[0]).toEqual({
			header: "web",
			description: "the SPA",
			preview: "vite build",
		});
	});

	it("normalizes legacy stored shapes with question/label", () => {
		const out = toBannerQuestions([
			// Legacy stored shape: option used `label` instead of `header`.
			{
				id: "legacy",
				header: "Which cache?",
				options: [{ label: "Redis" }],
			} as unknown as AsyncQuestion["questions"][number],
		]);
		expect(out[0]?.options[0]?.header).toBe("Redis");
	});

	it("omits multiSelect rather than defaulting it to false", () => {
		// The banner treats absence as single-select already; writing `false` would make a
		// stored question and a converted one compare unequal for no reason.
		expect("multiSelect" in (toBannerQuestions([{ id: "k", header: "h" }])[0] ?? {})).toBe(false);
	});
});
