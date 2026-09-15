/**
 * StructSed's collapsed row and category.
 *
 * A reader scanning a run has only this row. It must show that the call WROTE something and
 * which command it used — sharing StructView's `structure` category would report every call
 * as "outline", so a delete would read as an inspection.
 */

import { describe, expect, test } from "bun:test";
import { getCategory, getCategoryColor, getSummary } from "./tool-display";

const FILE = "/repo/server/lib/agent/tools/struct-view.ts";

function summary(input: Record<string, unknown>): string {
	return getSummary("StructSed", input);
}

describe("category", () => {
	test("StructSed is not classified as a structure READ", () => {
		expect(getCategory("StructSed")).toBe("structureEdit");
		expect(getCategory("StructView")).toBe("structure");
	});

	test("it takes the file-mutating colour, not search's cyan", () => {
		// Violet groups it with Write and Edit; cyan would read as another inspection.
		expect(getCategoryColor("structureEdit")).toBe("violet");
		expect(getCategoryColor("structureEdit")).toBe(getCategoryColor("file"));
		expect(getCategoryColor("structureEdit")).not.toBe(getCategoryColor("structure"));
	});
});

describe("collapsed row", () => {
	test("shows the file, the command and the address", () => {
		expect(summary({ file_path: FILE, command: "delete", symbol: "runPrint" })).toBe(
			"struct-view.ts · delete runPrint",
		);
	});

	test("a line address appears the same way", () => {
		expect(summary({ file_path: FILE, command: "replace", address: "10,20" })).toBe(
			"struct-view.ts · replace 10,20",
		);
	});

	test("no address still names the command", () => {
		expect(summary({ file_path: FILE, command: "append" })).toBe("struct-view.ts · append");
	});

	test("a command still streaming does not get a fabricated default", () => {
		// StructView substitutes "outline" for an absent mode because that IS its default.
		// `command` is required, so an absent one means the argument is mid-stream, and
		// naming any command here would misreport what the call does.
		const row = summary({ file_path: FILE });
		expect(row).toBe("struct-view.ts");
		for (const command of ["replace", "delete", "insert", "append", "substitute"]) {
			expect(row).not.toContain(command);
		}
	});

	test("no file path falls back to the tool name rather than an empty row", () => {
		expect(summary({ command: "delete" })).toBe("StructSed");
	});

	test("a long symbol is truncated, not left to overflow the row", () => {
		const row = summary({
			file_path: FILE,
			command: "replace",
			symbol: `SomeVeryLongClassName.${"aVeryLongMethodName".repeat(6)}`,
		});
		expect(row.length).toBeLessThanOrEqual(60);
	});
});
