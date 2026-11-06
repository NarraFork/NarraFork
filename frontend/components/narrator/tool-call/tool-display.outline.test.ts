import { describe, expect, it } from "bun:test";
import { getCategory, getCategoryColor, getSummary } from "./tool-display";

const K = "Kx81mPqa";
const TASK = { address: `${K}/Ab3dEf9Q`, title: "Fix the retry button" };

describe("outline tools", () => {
	it("share one category", () => {
		for (const name of ["OutlineRead", "OutlineSearch", "OutlineEdit", "Ask"]) {
			expect(getCategory(name)).toBe("outline");
		}
		expect(getCategoryColor("outline")).toBe("teal");
	});

	it("summarize a read by its block's title, else its address, with time and size", () => {
		expect(getSummary("OutlineRead", {})).toBe("spaces");
		expect(getSummary("OutlineRead", { address: "*" })).toBe("every space");
		expect(getSummary("OutlineRead", { address: `${K}/Ab3dEf9Q`, asOf: 12 }, { blocks: 7 })).toBe(
			`${K}/Ab3dEf9Q · as of #12 · 7 blocks`,
		);
		expect(
			getSummary("OutlineRead", { address: "Ab3dEf9Q" }, { title: TASK.title, blocks: 4 }),
		).toBe("Fix the retry button · 4 blocks");
	});

	it("summarize a search by its query and hits", () => {
		expect(getSummary("OutlineSearch", { query: "refresh" }, { resultCount: 3 })).toBe(
			"“refresh” · 3 results",
		);
		expect(getSummary("OutlineSearch", {}, { resultCount: 0 })).toBe("0 results");
	});

	it("summarize an edit by what it did: a task's new status first, titles from its display", () => {
		const display = {
			v: 1,
			space: { key: K, kind: "session", own: true },
			ops: [
				{ op: "add", parent: TASK, created: [{ address: `${K}/N1`, title: "a", depth: 0 }] },
				{ op: "set", target: TASK, status: { from: "doing", to: "done" } },
			],
		};
		expect(
			getSummary("OutlineEdit", {}, { commit: { id: "c", seq: 6 }, space: { key: K }, display }),
		).toBe("Ticked Fix the retry button done · added 1");
		// In the reader's language.
		expect(
			getSummary(
				"OutlineEdit",
				{},
				{ display },
				{ outlineSumDone: "勾成完成 {title}", outlineSumAdded: "记下 {n} 条" },
			),
		).toBe("勾成完成 Fix the retry button · 记下 1 条");
	});

	it("summarize an older edit (no display) from its input, the references as written", () => {
		expect(
			getSummary(
				"OutlineEdit",
				{
					edits: [
						{ add: "/", markdown: "- a" },
						{ add: "x", markdown: "- b\n- c" },
						{ delete: "Ab3dEf9Q" },
					],
				},
				{ commit: { id: "c", seq: 9 } },
			),
		).toBe("1 new page(s) · added 2 · +1");
		expect(getSummary("OutlineEdit", { edits: [{ set: "Ab3dEf9Q", checkbox: "x" }] })).toBe(
			"Ticked Ab3dEf9Q done",
		);
		expect(getSummary("OutlineEdit", {})).toBe("Edit");
	});

	it("summarize a decision as what was decided, never a bare Edit", () => {
		expect(
			getSummary(
				"OutlineEdit",
				{ edits: [{ confirm: "P1a2B3c4D" }] },
				{ decided: [{ confirm: "P1a2B3c4D", commit: { id: "c", seq: 9 } }] },
			),
		).toBe("Confirmed P1a2B3c4D → #9");
		expect(
			getSummary(
				"OutlineEdit",
				{ edits: [{ reject: "P1a2B3c4D" }] },
				{ decided: [{ reject: "P1a2B3c4D", status: "withdrawn" }] },
			),
		).toBe("Withdrew P1a2B3c4D");
		// A decision that failed (no `decided`) still names what it tried.
		expect(getSummary("OutlineEdit", { edits: [{ reject: "P1a2B3c4D" }] })).toBe(
			"Rejected P1a2B3c4D",
		);
	});

	it("summarize an Ask by its first question, a withdraw and an answer written down", () => {
		expect(
			getSummary("Ask", {
				questions: [{ question: "Where?", items: [{ question: "Also Codex?" }] }],
			}),
		).toBe("Where? · +1");
		expect(getSummary("Ask", { withdraw: ["Q3"] })).toBe("withdrew 1 question(s)");
		expect(getSummary("Ask", { answered: [{ question: "Q4", option: 1 }] })).toBe(
			"wrote down 1 answer(s)",
		);
	});
});
