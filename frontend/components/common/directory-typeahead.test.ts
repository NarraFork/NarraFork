/**
 * The typing rule for directory lists, tested without rendering a browser.
 *
 * The cases that matter are the ones a user actually hits: a first letter jumping to
 * the first match, the same letter cycling to the next one, a longer prefix narrowing
 * the search, and a prefix that matches nothing leaving the cursor alone.
 */

import { describe, expect, test } from "bun:test";
import {
	accumulateTypeahead,
	findTypeaheadMatch,
	isEditableTarget,
	isTypeaheadCharacter,
	typeaheadStep,
} from "./directory-typeahead";

const names = ["Documents", "Downloads", "drafts", "Music", "projects"];

/** A node stub: the predicate only reads `tagName` / `isContentEditable`. */
function node(shape: { tagName: string; isContentEditable?: boolean }): EventTarget {
	return shape as unknown as EventTarget;
}

describe("which keys belong to the list", () => {
	test("printable characters type ahead", () => {
		expect(isTypeaheadCharacter({ key: "d" })).toBe(true);
		expect(isTypeaheadCharacter({ key: "D" })).toBe(true);
		expect(isTypeaheadCharacter({ key: "ä" })).toBe(true);
	});

	test("navigation, modifiers, space and IME frames do not", () => {
		expect(isTypeaheadCharacter({ key: "ArrowDown" })).toBe(false);
		expect(isTypeaheadCharacter({ key: "Enter" })).toBe(false);
		expect(isTypeaheadCharacter({ key: " " })).toBe(false);
		expect(isTypeaheadCharacter({ key: "d", ctrlKey: true })).toBe(false);
		expect(isTypeaheadCharacter({ key: "d", metaKey: true })).toBe(false);
		expect(isTypeaheadCharacter({ key: "d", altKey: true })).toBe(false);
		expect(isTypeaheadCharacter({ key: "d", isComposing: true })).toBe(false);
	});

	test("typing inside an editable control is that control's business", () => {
		expect(isEditableTarget(node({ tagName: "INPUT" }))).toBe(true);
		expect(isEditableTarget(node({ tagName: "textarea" }))).toBe(true);
		expect(isEditableTarget(node({ tagName: "SELECT" }))).toBe(true);
		expect(isEditableTarget(node({ tagName: "DIV", isContentEditable: true }))).toBe(true);
		expect(isEditableTarget(node({ tagName: "DIV" }))).toBe(false);
		expect(isEditableTarget(null)).toBe(false);
	});
});

describe("prefix buffer", () => {
	test("appends a different character and keeps the first one meaningful", () => {
		expect(accumulateTypeahead("", "d")).toBe("d");
		expect(accumulateTypeahead("d", "o")).toBe("do");
		expect(accumulateTypeahead("do", "c")).toBe("doc");
	});

	test("repeating the single buffered character keeps it for cycling", () => {
		expect(accumulateTypeahead("d", "d")).toBe("d");
		expect(accumulateTypeahead("D", "d")).toBe("D");
	});
});

describe("finding the directory", () => {
	test("ignores case and takes the first match from the top", () => {
		expect(findTypeaheadMatch(names, "d")).toBe(0);
		expect(findTypeaheadMatch(names, "DO")).toBe(0);
		expect(findTypeaheadMatch(names, "dr")).toBe(2);
		expect(findTypeaheadMatch(names, "dow")).toBe(1);
	});

	test("searches after the cursor and wraps once", () => {
		expect(findTypeaheadMatch(names, "d", 0)).toBe(1);
		expect(findTypeaheadMatch(names, "d", 1)).toBe(2);
		expect(findTypeaheadMatch(names, "d", 2)).toBe(0);
	});

	test("reports nothing to select instead of guessing", () => {
		expect(findTypeaheadMatch(names, "zz")).toBe(-1);
		expect(findTypeaheadMatch(names, "")).toBe(-1);
		expect(findTypeaheadMatch([], "d")).toBe(-1);
	});
});

describe("one keystroke of type-ahead", () => {
	test("the first letter jumps to the first match", () => {
		expect(typeaheadStep({ names, buffer: "", char: "d", cursor: -1 })).toEqual({
			buffer: "d",
			index: 0,
		});
	});

	test("the same letter again cycles forward, wrapping at the end", () => {
		expect(typeaheadStep({ names, buffer: "d", char: "d", cursor: 0 }).index).toBe(1);
		expect(typeaheadStep({ names, buffer: "d", char: "d", cursor: 2 }).index).toBe(0);
	});

	test("a longer prefix searches from the top again", () => {
		const step = typeaheadStep({ names, buffer: "d", char: "o", cursor: 2 });
		expect(step).toEqual({ buffer: "do", index: 0 });
	});

	test("an unmatched buffer restarts from the newest character", () => {
		// "doc" then "d": "docd" matches nothing, but the user clearly wants a "d" name.
		expect(typeaheadStep({ names, buffer: "doc", char: "d", cursor: 0 })).toEqual({
			buffer: "d",
			index: 0,
		});
	});

	test("no match leaves the cursor where it was", () => {
		expect(typeaheadStep({ names, buffer: "", char: "z", cursor: 3 })).toEqual({
			buffer: "z",
			index: -1,
		});
	});
});
