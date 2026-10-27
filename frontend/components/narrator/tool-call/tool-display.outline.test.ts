import { describe, expect, it } from "bun:test";
import { getCategory, getCategoryColor, getSummary } from "./tool-display";

describe("outline tools", () => {
	it("share one category", () => {
		for (const name of ["OutlineRead", "OutlineSearch", "OutlineEdit"]) {
			expect(getCategory(name)).toBe("outline");
		}
		expect(getCategoryColor("outline")).toBe("teal");
	});

	it("summarize a read by its address, time and size", () => {
		expect(getSummary("OutlineRead", {})).toBe("spaces");
		expect(
			getSummary("OutlineRead", { address: "Kx81mPqa/Ab3dEf9Q", asOf: 12 }, { blocks: 7 }),
		).toBe("Kx81mPqa/Ab3dEf9Q · as of 12 · 7 blocks");
	});

	it("summarize a search by its query and hits", () => {
		expect(getSummary("OutlineSearch", { query: "refresh" }, { resultCount: 3 })).toBe(
			"refresh · 3",
		);
	});

	it("summarize an edit by what it did and its commit", () => {
		expect(
			getSummary(
				"OutlineEdit",
				{
					edits: [
						{ add: "/", markdown: "- a" },
						{ add: "x", markdown: "- b" },
						{ delete: "Ab3dEf9Q" },
					],
				},
				{ commit: { id: "c", seq: 9 } },
			),
		).toBe("add ×2 · delete · #9");
		expect(getSummary("OutlineEdit", {})).toBe("Edit");
	});
});
