import { describe, expect, test } from "bun:test";
import {
	DEFAULT_SEARCH_SORT,
	normalizeSearchSort,
	normalizeSearchType,
	sortVisibleSearchResults,
	summarizeSearchRuntimeState,
} from "./search-utils";

describe("search sort defaults", () => {
	// The global search page defaults to newest-first. This is the assertion that stops
	// it drifting back to relevance: the page reads the default through this constant,
	// and a silent switch back would only show up as "the ordering feels wrong".
	test("defaults to newest first", () => {
		expect(DEFAULT_SEARCH_SORT).toBe("time");
		expect(normalizeSearchSort(undefined)).toBe("time");
		expect(normalizeSearchSort("nonsense")).toBe("time");
	});

	test("keeps every explicitly chosen sort mode", () => {
		expect(normalizeSearchSort("relevance")).toBe("relevance");
		expect(normalizeSearchSort("type")).toBe("type");
		expect(normalizeSearchSort("title")).toBe("title");
		expect(normalizeSearchSort("time")).toBe("time");
	});
});

describe("normalizeSearchType", () => {
	test("accepts knowledge as a result type", () => {
		expect(normalizeSearchType("knowledge")).toBe("knowledge");
	});

	test("still normalizes the plural entity names and unknown input", () => {
		expect(normalizeSearchType("chapters")).toBe("chapter");
		expect(normalizeSearchType("narrators")).toBe("narrator");
		expect(normalizeSearchType("messages")).toBe("message");
		expect(normalizeSearchType(undefined)).toBe("all");
		expect(normalizeSearchType("nonsense")).toBe("all");
	});
});

describe("summarizeSearchRuntimeState", () => {
	test("summarizes degraded search metadata and deduplicates fallbacks", () => {
		const status = summarizeSearchRuntimeState({
			results: [],
			degraded: true,
			fallbacks: [{ entity: "chapters", from: "fts5", to: "like", reason: "fts_query_failed" }],
			searchMetadata: {
				degraded: true,
				mode: "degraded-like-fallback",
				ftsReady: false,
				shortQuery: false,
				requestedEntities: ["chapters"],
				fallbacks: [
					{ entity: "chapters", from: "fts5", to: "like", reason: "fts_query_failed" },
					{ entity: "messages", from: "fts5", to: "like", message: "message fallback" },
				],
			},
		});

		expect(status).toEqual({
			degraded: true,
			mode: "degraded-like-fallback",
			fallbackMessages: [
				"chapters: fts_query_failed (fts5 → like)",
				"messages: message fallback (fts5 → like)",
			],
		});
	});

	test("does not mark successful FTS search as degraded", () => {
		expect(
			summarizeSearchRuntimeState({
				results: [],
				degraded: false,
				fallbacks: [],
				searchMetadata: { degraded: false, mode: "fts5-with-like-fallback", fallbacks: [] },
			}),
		).toEqual({ degraded: false, mode: "fts5-with-like-fallback", fallbackMessages: [] });
	});

	test("tolerates additive backend metadata on ready Search responses", () => {
		const status = summarizeSearchRuntimeState({
			results: [{ type: "chapter", id: "c1", title: "Ready chapter" }],
			degraded: false,
			fallbacks: [],
			searchMetadata: {
				degraded: false,
				mode: "fts5-with-like-fallback",
				ftsReady: true,
				shortQuery: false,
				requestedEntities: ["chapters", "messages", "narrators"],
				fallbacks: [],
				backendDiagnostic: "safe-to-ignore",
			},
		});

		expect(status).toEqual({
			degraded: false,
			mode: "fts5-with-like-fallback",
			fallbackMessages: [],
		});
	});
});

describe("all results share the selected ordering", () => {
	const hits = [
		{ id: "n-old", type: "narrator", title: "D", updatedAt: "2026-01-01", matchScore: 10 },
		{ id: "n-new", type: "narrator", title: "B", updatedAt: "2026-09-03", matchScore: 30 },
		{ id: "m-new", type: "message", narratorTitle: "A", createdAt: "2026-09-04", matchScore: 40 },
		{ id: "m-mid", type: "message", narratorTitle: "C", createdAt: "2026-09-02", matchScore: 20 },
	];
	const order = (sort: "time" | "relevance" | "title" | "type") =>
		sortVisibleSearchResults(hits, "all", sort, (id) => id).map((r) => r.id);

	for (const sort of ["time", "relevance", "title"] as const) {
		test(`${sort} interleaves messages and narrators rather than grouping types`, () => {
			expect(order(sort)).toEqual(["m-new", "n-new", "m-mid", "n-old"]);
			expect(hits.map((r) => r.id)).toEqual(["n-old", "n-new", "m-new", "m-mid"]);
		});
	}

	test("only an explicit type sort groups the types", () => {
		expect(order("type")).toEqual(["m-new", "m-mid", "n-old", "n-new"]);
	});

	test("a type filter still uses the selected ordering within that type", () => {
		expect(sortVisibleSearchResults(hits, "narrator", "time", (id) => id).map((r) => r.id)).toEqual(
			["n-new", "n-old"],
		);
	});
});
