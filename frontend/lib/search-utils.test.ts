import { describe, expect, test } from "bun:test";
import {
	DEFAULT_SEARCH_SORT,
	formatSearchTotal,
	highlightSearchText,
	normalizeSearchInclude,
	normalizeSearchPage,
	normalizeSearchRange,
	normalizeSearchSort,
	normalizeSearchTab,
	searchHighlightTerms,
	searchPageCount,
	searchRangeStart,
} from "./search-utils";

describe("search sort", () => {
	// Relevance is the default again: sections rank within themselves and session relevance
	// already folds in recency. This stops the default drifting silently.
	test("defaults to relevance", () => {
		expect(DEFAULT_SEARCH_SORT).toBe("relevance");
		expect(normalizeSearchSort(undefined)).toBe("relevance");
		expect(normalizeSearchSort("nonsense")).toBe("relevance");
	});

	test("keeps time, and reads the retired client-side sorts as the default", () => {
		expect(normalizeSearchSort("time")).toBe("time");
		expect(normalizeSearchSort("type")).toBe("relevance");
		expect(normalizeSearchSort("title")).toBe("relevance");
	});
});

describe("normalizeSearchTab", () => {
	test("accepts the section names", () => {
		expect(normalizeSearchTab("sessions")).toBe("sessions");
		expect(normalizeSearchTab("knowledge")).toBe("knowledge");
	});

	test("maps the old result types so bookmarked links open the right tab", () => {
		for (const old of ["message", "messages", "narrator", "narrators"]) {
			expect(normalizeSearchTab(old)).toBe("sessions");
		}
		// Chapters are retired; their old links open the overview.
		expect(normalizeSearchTab("chapter")).toBe("all");
		expect(normalizeSearchTab(undefined)).toBe("all");
		expect(normalizeSearchTab("nonsense")).toBe("all");
	});
});

describe("normalizeSearchInclude", () => {
	test("keeps known names in canonical order and drops the rest", () => {
		expect(normalizeSearchInclude("tools,nonsense, subagents")).toEqual(["subagents", "tools"]);
		expect(normalizeSearchInclude(["archived", "system", "system"])).toEqual([
			"system",
			"archived",
		]);
	});

	test("treats a missing value as the default scope", () => {
		expect(normalizeSearchInclude(undefined)).toEqual([]);
		expect(normalizeSearchInclude("")).toEqual([]);
	});
});

describe("time ranges", () => {
	test("accept only the presets", () => {
		expect(normalizeSearchRange("30d")).toBe("30d");
		expect(normalizeSearchRange("2d")).toBeUndefined();
		expect(normalizeSearchRange(undefined)).toBeUndefined();
	});

	test("start at a UTC day boundary, stable through the day", () => {
		const morning = Date.parse("2026-10-23T01:00:00.000Z");
		const evening = Date.parse("2026-10-23T23:00:00.000Z");
		expect(searchRangeStart("7d", morning)).toBe("2026-10-16T00:00:00.000Z");
		expect(searchRangeStart("7d", evening)).toBe(searchRangeStart("7d", morning));
	});
});

describe("formatSearchTotal", () => {
	test("marks a filled candidate window as a lower bound", () => {
		expect(formatSearchTotal({ total: 12, totalIsLowerBound: false })).toBe("12");
		expect(formatSearchTotal({ total: 1000, totalIsLowerBound: true })).toBe("1000+");
		expect(formatSearchTotal(undefined)).toBe("0");
	});
});

describe("pages", () => {
	test("read a page number from the URL, the first page as undefined", () => {
		expect(normalizeSearchPage("3")).toBe(3);
		expect(normalizeSearchPage(7)).toBe(7);
		for (const value of [undefined, "", "1", "0", "-2", "2.5", "x"]) {
			expect(normalizeSearchPage(value)).toBeUndefined();
		}
		expect(normalizeSearchPage("99999999")).toBe(10_000);
	});

	test("count the pages a total fills", () => {
		expect(searchPageCount(undefined, 20)).toBe(1);
		expect(searchPageCount({ total: 0 }, 20)).toBe(1);
		expect(searchPageCount({ total: 20 }, 20)).toBe(1);
		expect(searchPageCount({ total: 1021 }, 20)).toBe(52);
	});
});

describe("highlighting", () => {
	test("highlights each term on its own, longest first, case-insensitively", () => {
		expect(searchHighlightTerms("  token  Refresh token ")).toEqual(["Refresh", "token"]);
		const parts = highlightSearchText("Token refreshed: refresh TOKEN", "refresh token");
		expect(Array.isArray(parts)).toBe(true);
		const marked = (parts as Array<string | { props: { children: string } }>)
			.filter((part): part is { props: { children: string } } => typeof part !== "string")
			.map((part) => part.props.children);
		expect(marked).toEqual(["Token", "refresh", "refresh", "TOKEN"]);
	});

	test("treats regex characters in a term literally", () => {
		expect(highlightSearchText("a.b axb", "a.b")).not.toBe("a.b axb");
		const parts = highlightSearchText("axb", "a.b");
		expect(parts).toBe("axb");
	});

	test("returns the text untouched without terms", () => {
		expect(highlightSearchText("text", "   ")).toBe("text");
	});
});
