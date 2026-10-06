/**
 * StructView's own tool-card category.
 *
 * The bug these lock down: StructView was classified as `search`, and the search
 * formatters read `pattern` / `glob` / `path` — none of which StructView has (it uses
 * `file_path` + `mode`). The collapsed row therefore fell through to the bare tool name,
 * so a reader could not tell which file or which mode a call had used.
 */
import { describe, expect, test } from "bun:test";
import { getCategory, getCategoryColor, getSummary } from "./tool-display";

const FILE = "E:/repo/frontend/components/narrator/NarratorPanel.tsx";

describe("category", () => {
	test("StructView is its own category, not search", () => {
		expect(getCategory("StructView")).toBe("structure");
		// Grep and Glob must be unaffected.
		expect(getCategory("Grep")).toBe("search");
		expect(getCategory("Glob")).toBe("search");
	});

	test("the category has a colour rather than falling through to gray", () => {
		expect(getCategoryColor("structure")).not.toBe("gray");
	});
});

describe("collapsed-row summary", () => {
	test("names the file and the mode", () => {
		expect(getSummary("StructView", { file_path: FILE, mode: "report" })).toBe(
			"NarratorPanel.tsx · report",
		);
		expect(getSummary("StructView", { file_path: FILE, mode: "outline" })).toBe(
			"NarratorPanel.tsx · outline",
		);
	});

	test("a missing mode reads as the tool's default, so the row does not change mid-stream", () => {
		// The tool defaults to outline; showing something else before `mode` arrives would
		// make the row flip once the arguments finish streaming.
		expect(getSummary("StructView", { file_path: FILE })).toBe("NarratorPanel.tsx · outline");
	});

	test("extract shows the symbol being pulled out", () => {
		expect(
			getSummary("StructView", {
				file_path: FILE,
				mode: "extract",
				symbol: "PaymentService.charge",
			}),
		).toBe("NarratorPanel.tsx › PaymentService.charge");
	});

	test("enclosing shows the position", () => {
		expect(getSummary("StructView", { file_path: FILE, mode: "enclosing", position: "412" })).toBe(
			"NarratorPanel.tsx:412",
		);
	});

	test("print shows the address", () => {
		expect(getSummary("StructView", { file_path: FILE, mode: "print", address: "10,20" })).toBe(
			"NarratorPanel.tsx · 10,20",
		);
	});

	test("a mode without its companion argument still names the mode", () => {
		expect(getSummary("StructView", { file_path: FILE, mode: "extract" })).toBe(
			"NarratorPanel.tsx · extract",
		);
		expect(getSummary("StructView", { file_path: FILE, mode: "print" })).toBe(
			"NarratorPanel.tsx · print",
		);
	});

	test("no file path falls back to the tool name instead of an empty row", () => {
		expect(getSummary("StructView", { mode: "outline" })).toBe("StructView");
	});

	test("a long symbol is truncated rather than overflowing the row", () => {
		const summary = getSummary("StructView", {
			file_path: FILE,
			mode: "extract",
			symbol: "A".repeat(200),
		});
		expect(summary.length).toBeLessThanOrEqual(64);
	});
});
