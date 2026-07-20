import { describe, expect, test } from "bun:test";
import { summarizeSearchRuntimeState } from "./search-utils";

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
