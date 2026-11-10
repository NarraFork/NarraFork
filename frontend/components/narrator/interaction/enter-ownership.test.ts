/**
 * Who owns an Enter press (review round 2): the element under the focus or the window's
 * shortcuts. The composer's "Enter returns to the chat input" and the waiting permission's
 * Enter shortcut ask the same question, so they cannot disagree; the ⏎ hint hides where it
 * would lie.
 */
import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	ENTER_OWNER_SELECTOR,
	enterOwnedByTarget,
	enterTakenFromPermission,
	inActivePermButtonBar,
} from "./enter-ownership";

function page(html: string) {
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	return document as unknown as Document;
}

describe("Enter's owner", () => {
	test("a control or what is inside one owns it; plain text and the page do not", () => {
		const doc = page(`
			<button id="b"><span id="inb">x</span></button>
			<a href="#" id="a">link</a>
			<div role="tab" id="tab">tab</div>
			<div role="dialog"><p id="indialog">x</p></div>
			<div contenteditable="false"><p id="ce">x</p></div>
			<p id="text">text</p>`);
		const at = (id: string) => doc.getElementById(id);
		for (const id of ["b", "inb", "a", "tab", "indialog"])
			expect([id, enterOwnedByTarget(at(id), doc)]).toEqual([id, true]);
		for (const id of ["ce", "text"])
			expect([id, enterOwnedByTarget(at(id), doc)]).toEqual([id, false]);
		expect(enterOwnedByTarget(doc.body, doc)).toBe(false);
		expect(enterOwnedByTarget(null, doc)).toBe(false);
		expect(ENTER_OWNER_SELECTOR).toContain('[role="menu"]');
	});

	test("an open modal dialog owns every Enter", () => {
		const doc = page(`<p id="text">x</p><div aria-modal="true"></div>`);
		expect(enterOwnedByTarget(doc.getElementById("text"), doc)).toBe(true);
	});

	test("the permission's active button row is told apart", () => {
		const doc = page(`
			<div data-perm-button-bar="active"><button id="allow">Allow</button></div>
			<div data-perm-button-bar="idle"><button id="other">Allow</button></div>`);
		expect(inActivePermButtonBar(doc.getElementById("allow"))).toBe(true);
		expect(inActivePermButtonBar(doc.getElementById("other"))).toBe(false);
	});
});

describe("the ⏎ hint", () => {
	const focusOn = (doc: Document, id: string | null) => {
		Object.defineProperty(doc, "activeElement", {
			configurable: true,
			get: () => (id ? doc.getElementById(id) : doc.body),
		});
	};

	test("hides on a control elsewhere and under a modal; stays on the page, the row and a field", () => {
		const doc = page(`
			<a href="#" id="link">sidebar</a>
			<div role="tab" id="tab">tab</div>
			<textarea id="field"></textarea>
			<div data-perm-button-bar="active"><button id="allow">Allow</button></div>`);
		for (const [id, hidden] of [
			[null, false],
			["link", true],
			["tab", true],
			["field", false],
			["allow", false],
		] as const) {
			focusOn(doc, id);
			expect([id, enterTakenFromPermission(doc)]).toEqual([id, hidden]);
		}
		doc.body.insertAdjacentHTML("beforeend", '<div aria-modal="true"></div>');
		focusOn(doc, null);
		expect(enterTakenFromPermission(doc)).toBe(true);
	});
});
