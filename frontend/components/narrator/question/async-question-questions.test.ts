/**
 * The stored → banner question conversion.
 *
 * Worth pinning because the failure is a crash in a render path: the banner's render
 * maps `options` and reads each option's `description` without guarding, while the
 * stored form legitimately omits both for a free-form question. A missing default here
 * surfaces as a blank inbox rather than a type error.
 */

import { describe, expect, it } from "bun:test";
import { toBannerQuestions } from "./async-question-questions";

describe("toBannerQuestions", () => {
	it("fills the defaults the banner's type requires", () => {
		const out = toBannerQuestions([
			{ question: "cache", header: "Which cache?", options: [{ label: "Redis" }] },
		]);
		expect(out).toEqual([
			{
				question: "cache",
				header: "Which cache?",
				options: [{ label: "Redis", description: "" }],
			},
		]);
	});

	it("keeps a free-form question (no options) answerable", () => {
		const out = toBannerQuestions([{ question: "notes", header: "Anything else?" }]);
		expect(out[0]?.options).toEqual([]);
	});

	it("preserves multiSelect and previews when present", () => {
		const out = toBannerQuestions([
			{
				question: "targets",
				header: "Which targets?",
				multiSelect: true,
				options: [{ label: "web", description: "the SPA", preview: "vite build" }],
			},
		]);
		expect(out[0]?.multiSelect).toBe(true);
		expect(out[0]?.options[0]).toEqual({
			label: "web",
			description: "the SPA",
			preview: "vite build",
		});
	});

	it("omits multiSelect rather than defaulting it to false", () => {
		// The banner treats absence as single-select already; writing `false` would make a
		// stored question and a converted one compare unequal for no reason.
		expect("multiSelect" in (toBannerQuestions([{ question: "k", header: "h" }])[0] ?? {})).toBe(
			false,
		);
	});
});
