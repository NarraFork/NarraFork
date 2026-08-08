/**
 * plugin-text-citation-schema.test.ts — `text.citation` is how a plugin reports
 * source citations. The schema is the ONLY thing standing between an untrusted
 * plugin and the citation metadata the host persists and renders, so its bounds
 * are asserted here rather than trusted.
 *
 * Also pins backward compatibility: the event is additive, and the existing
 * `text.delta` shape must be unchanged, so plugins built before citations
 * existed keep validating.
 */

import { describe, expect, test } from "bun:test";
import { providerStreamEventSchema } from "@server/lib/plugins/protocol";
import { CITATION_LIMITS } from "@shared/citations";

function parse(event: unknown) {
	return providerStreamEventSchema.safeParse(event);
}

function citationEvent(citations: unknown) {
	return { type: "text.citation", citations };
}

describe("text.citation acceptance", () => {
	test("accepts a resolved URL citation", () => {
		const result = parse(
			citationEvent([
				{ startIndex: 0, endIndex: 5, url: "https://a.test", title: "A", outputIndex: 1 },
			]),
		);
		expect(result.success).toBe(true);
	});

	test("accepts an internal-ref-only citation without startIndex", () => {
		expect(parse(citationEvent([{ endIndex: 3, sourceRef: "ref-1" }])).success).toBe(true);
	});

	test("accepts several citations in one event", () => {
		const result = parse(
			citationEvent([
				{ endIndex: 1, url: "https://a.test" },
				{ endIndex: 2, url: "https://b.test" },
			]),
		);
		expect(result.success).toBe(true);
	});
});

describe("text.citation rejection", () => {
	test("rejects a missing endIndex", () => {
		expect(parse(citationEvent([{ url: "https://a.test" }])).success).toBe(false);
	});

	test("rejects a negative or fractional index", () => {
		expect(parse(citationEvent([{ endIndex: -1, url: "https://a.test" }])).success).toBe(false);
		expect(parse(citationEvent([{ endIndex: 1.5, url: "https://a.test" }])).success).toBe(false);
	});

	test("rejects an empty citation list", () => {
		expect(parse(citationEvent([])).success).toBe(false);
	});

	test("rejects more citations than the hard limit", () => {
		const many = Array.from({ length: CITATION_LIMITS.maxCitations + 1 }, (_, i) => ({
			endIndex: i,
			url: "https://a.test",
		}));
		expect(parse(citationEvent(many)).success).toBe(false);
	});

	test("rejects an over-long URL, title, or ref", () => {
		expect(
			parse(
				citationEvent([
					{ endIndex: 1, url: `https://a.test/${"x".repeat(CITATION_LIMITS.maxUrlLength)}` },
				]),
			).success,
		).toBe(false);
		expect(
			parse(citationEvent([{ endIndex: 1, title: "t".repeat(CITATION_LIMITS.maxTitleLength + 1) }]))
				.success,
		).toBe(false);
		expect(
			parse(
				citationEvent([
					{ endIndex: 1, sourceRef: "r".repeat(CITATION_LIMITS.maxSourceRefLength + 1) },
				]),
			).success,
		).toBe(false);
	});

	test("rejects unknown fields (schema is strict)", () => {
		expect(parse(citationEvent([{ endIndex: 1, url: "https://a.test", extra: 1 }])).success).toBe(
			false,
		);
	});
});

describe("existing events keep validating unchanged", () => {
	test("text.delta with and without outputIndex", () => {
		expect(parse({ type: "text.delta", text: "hi" }).success).toBe(true);
		expect(parse({ type: "text.delta", text: "hi", outputIndex: 0 }).success).toBe(true);
	});

	test("text.delta still rejects a citations field", () => {
		expect(parse({ type: "text.delta", text: "hi", citations: [] }).success).toBe(false);
	});
});
