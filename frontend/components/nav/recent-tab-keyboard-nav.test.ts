import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	activeNavRowKey,
	type NavRowStop,
	navRowElement,
	navRowUrl,
	nextNavRow,
	readNavRows,
	stripKey,
} from "./recent-tab-keyboard-nav";

const rows: NavRowStop[] = [
	{ key: "narrator:a", kind: "tab" },
	{ key: "folder:f", kind: "folder" },
	{ key: "narrator:m1", kind: "tab" },
	{ key: stripKey("f"), kind: "strip" },
	{ key: "narrator:b", kind: "tab" },
];

describe("Ctrl+Up / Ctrl+Down stops", () => {
	test("steps through every row on screen, folder headers and 'N more' included", () => {
		expect(nextNavRow(rows, "narrator:a", "down")?.key).toBe("folder:f");
		expect(nextNavRow(rows, "narrator:m1", "down")?.key).toBe("strip:f");
		expect(nextNavRow(rows, "strip:f", "down")?.key).toBe("narrator:b");
		expect(nextNavRow(rows, "folder:f", "up")?.key).toBe("narrator:a");
	});

	test("wraps around both ends", () => {
		expect(nextNavRow(rows, "narrator:b", "down")?.key).toBe("narrator:a");
		expect(nextNavRow(rows, "narrator:a", "up")?.key).toBe("narrator:b");
	});

	test("with no current row (or one no longer shown) starts at an end", () => {
		expect(nextNavRow(rows, null, "down")?.key).toBe("narrator:a");
		expect(nextNavRow(rows, null, "up")?.key).toBe("narrator:b");
		expect(nextNavRow(rows, "narrator:gone", "down")?.key).toBe("narrator:a");
		expect(nextNavRow([], null, "down")).toBeNull();
	});

	test("reads the rows from the rendered list, top to bottom", () => {
		const { document } = parseHTML(`<div id="list">
			<div data-tab-sort-id="narrator:a"></div>
			<div data-folder-unit="f">
				<div data-tab-sort-id="folder:f"></div>
				<div data-tab-sort-id="narrator:m1"></div>
				<div><button data-folder-strip="f"></button></div>
			</div>
			<div data-folder-unit="g"><div data-tab-sort-id="folder:g"></div></div>
			<div data-tab-sort-id="project:p"></div>
		</div>`);
		const list = document.getElementById("list") as unknown as ParentNode;
		expect(readNavRows(list)).toEqual([
			{ key: "narrator:a", kind: "tab" },
			{ key: "folder:f", kind: "folder" },
			{ key: "narrator:m1", kind: "tab" },
			{ key: "strip:f", kind: "strip" },
			{ key: "folder:g", kind: "folder" },
			{ key: "project:p", kind: "tab" },
		]);
		expect(navRowElement(list, "strip:f")?.getAttribute("data-folder-strip")).toBe("f");
		expect(navRowElement(list, "folder:g")?.getAttribute("data-tab-sort-id")).toBe("folder:g");
		expect(navRowElement(list, "narrator:nope")).toBeNull();
	});

	test("starts from the row showing as active", () => {
		const { document } = parseHTML(`<div id="list">
			<div data-tab-sort-id="narrator:a"><a></a></div>
			<div data-tab-sort-id="folder:f"><button data-active="true"></button></div>
		</div>`);
		const list = document.getElementById("list") as unknown as ParentNode;
		expect(activeNavRowKey(list)).toBe("folder:f");
		const { document: none } = parseHTML(
			`<div id="list"><div data-tab-sort-id="narrator:a"></div></div>`,
		);
		expect(activeNavRowKey(none.getElementById("list") as unknown as ParentNode)).toBeNull();
	});

	test("sessions and projects lead to their page; folders and 'N more' to none", () => {
		expect(navRowUrl("narrator:abc")).toBe("/narrators/abc");
		expect(navRowUrl("project:p1")).toBe("/projects/p1");
		expect(navRowUrl("folder:f")).toBeNull();
		expect(navRowUrl("strip:f")).toBeNull();
		expect(navRowUrl("narrator:")).toBeNull();
	});
});
