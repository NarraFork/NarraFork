import { describe, expect, test } from "bun:test";
import { flattenRulerPages, type RulerData } from "./useRuler";

function page(overrides: Partial<RulerData> = {}): RulerData {
	return {
		commits: [],
		segments: [],
		activeChapters: [],
		...overrides,
	};
}

describe("flattenRulerPages", () => {
	test("preserves degraded metadata across merged pages", () => {
		const merged = flattenRulerPages([
			page({
				commits: [{ sha: "a", shortSha: "a", message: "one", author: "A", date: "2026-01-01" }],
				degraded: true,
				fallback: true,
				fallbacks: [{ feature: "ruler.gitLog", reason: "git_log_failed", error: "boom" }],
				capabilities: {
					read: {
						supported: false,
						fallback: true,
						code: "FEATURE_DISABLED",
						reason: "Ruler read degraded",
					},
				},
			}),
			page({
				commits: [{ sha: "b", shortSha: "b", message: "two", author: "B", date: "2026-01-02" }],
				fallbacks: [{ feature: "ruler.gitCount", reason: "git_rev_list_failed", message: "oops" }],
			}),
		]);

		expect(merged.degraded).toBe(true);
		expect(merged.fallback).toBe(true);
		expect(merged.fallbacks).toHaveLength(2);
		expect(merged.fallbacks?.[0]).toMatchObject({
			feature: "ruler.gitLog",
			reason: "git_log_failed",
		});
		expect(merged.fallbacks?.[1]).toMatchObject({
			feature: "ruler.gitCount",
			reason: "git_rev_list_failed",
		});
		expect(merged.capabilities).toMatchObject({
			read: {
				supported: false,
				fallback: true,
				code: "FEATURE_DISABLED",
				reason: "Ruler read degraded",
			},
		});
		expect(merged.commits).toHaveLength(2);
	});

	test("deduplicates identical fallbacks", () => {
		const merged = flattenRulerPages([
			page({ fallbacks: [{ feature: "ruler.gitLog", reason: "git_log_failed", error: "boom" }] }),
			page({ fallbacks: [{ feature: "ruler.gitLog", reason: "git_log_failed", error: "boom" }] }),
		]);

		expect(merged.fallbacks).toHaveLength(1);
		expect(merged.fallbacks?.[0]).toMatchObject({
			feature: "ruler.gitLog",
			reason: "git_log_failed",
		});
	});
});
