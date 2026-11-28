import { expect, test } from "bun:test";
import {
	composeReasoningTranslation,
	getValidReasoningTranslationParts,
	MAX_REASONING_TRANSLATION_OUTPUT_BYTES,
	MAX_REASONING_TRANSLATION_SOURCE_BYTES,
} from "./reasoning-translation";

function part(start: number, sourceText: string, translatedText: string, id = String(start)) {
	return {
		id,
		generation: "current",
		start,
		end: start + sourceText.length,
		sourceText,
		translatedText,
	};
}

test("renders translated ranges without removing gaps, boundary whitespace, or the live tail", () => {
	const source = "  one\n\n original gap\n\ntwo\n\n unfinished";
	expect(
		composeReasoningTranslation(source, "current", [
			part(source.indexOf("two"), "two", "第二部分"),
			part(0, "  one\n\n", " 第一部分 "),
		]),
	).toBe("  第一部分\n\n original gap\n\n第二部分\n\n unfinished");
});

test("checks generation, exact source, unique IDs, and UTF-16 boundaries", () => {
	const first = part(1, "😀", "表情");
	const last = part(4, "cd", "末尾");
	expect(
		getValidReasoningTranslationParts("A😀bcd", "current", [
			last,
			first,
			part(1, "\ud83d", "split high surrogate"),
			part(2, "\ude00", "split low surrogate"),
			part(3, "bc", "overlapping", first.id),
			part(3, "wrong", "rewritten"),
			{ ...part(3, "b", "old"), generation: "old" },
		]),
	).toEqual([first, last]);
	expect(composeReasoningTranslation("A😎bcd", "current", [first])).toBeNull();
	expect(composeReasoningTranslation("A😀bcd", "old", [first])).toBeNull();
});

test("bounds translation identities and UTF-8 payloads, not just string length", () => {
	const longSource = "界".repeat(Math.ceil(MAX_REASONING_TRANSLATION_SOURCE_BYTES / 3));
	const longOutput = "界".repeat(Math.ceil(MAX_REASONING_TRANSLATION_OUTPUT_BYTES / 3));
	expect(
		composeReasoningTranslation(longSource, "current", [part(0, longSource, "short")]),
	).toBeNull();
	expect(composeReasoningTranslation("a", "current", [part(0, "a", longOutput)])).toBeNull();
	expect(
		composeReasoningTranslation("a", "current", [part(0, "a", "译", "a".repeat(257))]),
	).toBeNull();
});
