import { describe, expect, test } from "bun:test";
import { composerNarratorReferenceText } from "@shared/composer-document";
import type { FileReference } from "@shared/file-reference";
import {
	composerPreviewText,
	joinQuotedComposerInput,
	MAX_COMPOSER_QUOTE_CHARS,
	MAX_COMPOSER_QUOTE_LABEL_CHARS,
	normalizeComposerQuote,
	parseComposerQuotePrefix,
	parseComposerSegments,
	quoteDisplayText,
	quoteJumpForLine,
	quotePreviewLabel,
	serializeComposerQuotes,
	splitQuotedComposerInput,
} from "./composer-quotes";
import {
	copyFileReferences,
	type FileReferenceInput,
	insertFileReference,
	trimFileReferenceInput,
} from "./file-reference-input";

const reference: FileReference = {
	id: "ref-1",
	deviceId: "local",
	path: "/work/src/app.ts",
	label: "app.ts",
	selection: { startLineNumber: 3, startColumn: 1, endLineNumber: 5, endColumn: 1 },
};

describe("normalizeComposerQuote", () => {
	test("trims blank edges and trailing spaces but keeps inner blank lines", () => {
		expect(normalizeComposerQuote(" Assistant\nmessage ", "\n\n a  \r\n\r\nb \n\n")).toEqual({
			label: "Assistant message",
			text: " a\n\nb",
		});
	});

	test("rejects whitespace-only text or label", () => {
		expect(normalizeComposerQuote("Label", " \n\t\n")).toBeNull();
		expect(normalizeComposerQuote("  ", "text")).toBeNull();
	});

	test("clips long text and labels with a visible mark", () => {
		const quote = normalizeComposerQuote(
			"x".repeat(MAX_COMPOSER_QUOTE_LABEL_CHARS + 20),
			"y".repeat(MAX_COMPOSER_QUOTE_CHARS + 50),
		);
		expect(quote?.label.length).toBe(MAX_COMPOSER_QUOTE_LABEL_CHARS);
		expect(quote?.label.endsWith("…")).toBe(true);
		expect(quote?.text.length).toBe(MAX_COMPOSER_QUOTE_CHARS);
		expect(quote?.text.endsWith("…")).toBe(true);
	});
});

describe("quote prefix serialization", () => {
	test("round-trips quotes, including lines that look like headers", () => {
		const quotes = [
			{ label: "Assistant message", text: "first\n\n[quote] not a header\n\\[quote] escaped" },
			{ label: "Bash · bun test", text: "> already quoted\n✗ failed" },
		];
		const text = `${serializeComposerQuotes(quotes)}what does this mean?`;
		expect(text).toStartWith(
			"> [quote] Assistant message\n> first\n>\n> \\[quote] not a header\n> \\\\[quote] escaped\n\n",
		);
		const parsed = parseComposerQuotePrefix(text);
		expect(parsed.quotes).toEqual(quotes);
		expect(text.slice(parsed.prefixLength)).toBe("what does this mean?");
	});

	test("round-trips a jump anchor without showing it in the chip label", () => {
		const quote = normalizeComposerQuote(
			quotePreviewLabel("Selecting text in a message shows a dashed chip", "biome.json"),
			"biome.json\nSelecting text in a message shows a dashed chip",
			"m:msg1234",
		);
		if (!quote) throw new Error("quote");
		expect(quote.label.startsWith("biome.json · Selecting text")).toBe(true);
		expect(quote.anchor).toBe("m:msg1234");
		const text = serializeComposerQuotes([quote]);
		expect(text).toContain("@@m:msg1234");
		expect(parseComposerQuotePrefix(text).quotes).toEqual([quote]);
		const display = quoteDisplayText(`${text}and then?`);
		expect(display.text.includes("@@")).toBe(false);
		expect(display.jumps).toEqual([
			{
				header: `> [quote] ${quote.label}`,
				anchor: "m:msg1234",
				highlight: "Selecting text in a message shows a dashed chip",
				index: 0,
			},
		]);
		expect(display.text.endsWith("and then?")).toBe(true);
	});

	test("jumps to the quote in that position when labels match", () => {
		const text = serializeComposerQuotes([
			{ label: "same words", text: "same words\nfirst body", anchor: "m:aaaa" },
			{ label: "same words", text: "same words" },
			{ label: "same words", text: "same words\nthird body", anchor: "m:cccc" },
		]);
		const lines = quoteDisplayText(text)
			.text.split("\n")
			.map((line) => ({ text: line }));
		const jumps = quoteDisplayText(text).jumps;
		const headers = lines.flatMap((line, index) =>
			line.text.startsWith("> [quote] ") ? [index] : [],
		);
		expect(headers).toHaveLength(3);
		expect(quoteJumpForLine(lines, headers[0] ?? 0, jumps)?.anchor).toBe("m:aaaa");
		expect(quoteJumpForLine(lines, headers[1] ?? 0, jumps)).toBeUndefined();
		expect(quoteJumpForLine(lines, headers[2] ?? 0, jumps)?.anchor).toBe("m:cccc");
		const thirdBody = lines.findIndex((line) => line.text === "> third body");
		expect(quoteJumpForLine(lines, thirdBody, jumps)?.anchor).toBe("m:cccc");
	});

	test("ignores an anchor that is too short to be an id", () => {
		expect(normalizeComposerQuote("Label", "text", "m:ab")?.anchor).toBeUndefined();
	});

	test("accepts a prefix without a body, as left behind by send trimming", () => {
		const text = serializeComposerQuotes([{ label: "User message", text: "hi" }]).trimEnd();
		expect(parseComposerQuotePrefix(text)).toEqual({
			quotes: [{ label: "User message", text: "hi" }],
			prefixLength: text.length,
		});
	});

	test("leaves ordinary text and unterminated blocks in the body", () => {
		expect(parseComposerQuotePrefix("> a normal blockquote\n\nbody").prefixLength).toBe(0);
		expect(parseComposerQuotePrefix("> [quote] Label\nno content").prefixLength).toBe(0);
		expect(parseComposerQuotePrefix("> [quote] Label").prefixLength).toBe(0);
		const glued = "> [quote] A\n> one\n\n> [quote] B\n> two\nbody right after";
		const parsed = parseComposerQuotePrefix(glued);
		expect(parsed.quotes).toEqual([{ label: "A", text: "one" }]);
		expect(glued.slice(parsed.prefixLength)).toBe("> [quote] B\n> two\nbody right after");
	});

	test("accepts back-to-back headers without a blank separator", () => {
		const parsed = parseComposerQuotePrefix("> [quote] A\n> one\n> [quote] B\n> two\n\nbody");
		expect(parsed.quotes).toEqual([
			{ label: "A", text: "one" },
			{ label: "B", text: "two" },
		]);
	});
});

describe("split/join with file references", () => {
	test("body offsets are relative to the text after the prefix", () => {
		const quotes = [{ label: "Assistant message", text: "context" }];
		const body = insertFileReference({ text: "see ", fileReferences: [] }, reference);
		const full = joinQuotedComposerInput(quotes, body);
		// The joined form is a valid composer input: every token sits at its range.
		expect(copyFileReferences(full.fileReferences, full.text)).toHaveLength(1);
		const split = splitQuotedComposerInput(full);
		expect(split.quotes).toEqual(quotes);
		expect(split.body.text).toBe(body.text);
		expect(split.body.fileReferences).toEqual(copyFileReferences(body.fileReferences));
	});

	test("detached references survive unchanged and no quotes is the identity", () => {
		const detached: FileReferenceInput = { text: "hello", fileReferences: [reference] };
		expect(joinQuotedComposerInput([], detached)).toBe(detached);
		expect(splitQuotedComposerInput(detached).body).toBe(detached);
		const full = joinQuotedComposerInput([{ label: "L", text: "q" }], detached);
		expect(full.fileReferences).toEqual([reference]);
		expect(splitQuotedComposerInput(full).body.fileReferences).toEqual([reference]);
	});

	test("send trimming keeps quotes parseable and tokens valid", () => {
		const body = insertFileReference({ text: "", fileReferences: [] }, reference);
		const full = joinQuotedComposerInput([{ label: "L", text: "q" }], body);
		const trimmed = trimFileReferenceInput(full);
		expect(copyFileReferences(trimmed.fileReferences, trimmed.text)).toHaveLength(1);
		expect(splitQuotedComposerInput(trimmed).quotes).toEqual([{ label: "L", text: "q" }]);
	});

	test("quote-only drafts trim to the prefix without its separator", () => {
		const full = joinQuotedComposerInput([{ label: "L", text: "q" }], {
			text: "",
			fileReferences: [],
		});
		expect(trimFileReferenceInput(full).text).toBe("> [quote] L\n> q");
	});
});

describe("parseComposerSegments", () => {
	test("recovers interleaved quotes and named attachments in document order", () => {
		const text =
			"> [quote] A @@m:abcd\n> first\n\n怎样算？\n> [quote] B\n> second\n\n看[image #1: a.png]和[file #1: n.txt]";
		expect(parseComposerSegments(text, { images: ["a.png"], files: ["n.txt"] })).toEqual([
			{ type: "quote", quote: { label: "A", text: "first", anchor: "m:abcd" } },
			{ type: "text", text: "怎样算？\n" },
			{ type: "quote", quote: { label: "B", text: "second" } },
			{ type: "text", text: "看" },
			{ type: "attachment", kind: "image", index: 0 },
			{ type: "text", text: "和" },
			{ type: "attachment", kind: "file", index: 0 },
		]);
	});
	test("leaves look-alike placeholders and mid-line quote headers literal", () => {
		const text =
			"x > [quote] A\n> y\n[image #1: other.png][image #2: a.png][image #1: a.png][image #1: a.png]";
		expect(parseComposerSegments(text, { images: ["a.png"], files: [] })).toEqual([
			{ type: "text", text: "x > [quote] A\n> y\n[image #1: other.png][image #2: a.png]" },
			{ type: "attachment", kind: "image", index: 0 },
			{ type: "text", text: "[image #1: a.png]" },
		]);
	});
	test("treats escaped look-alikes as literal text and removes the escape", () => {
		const text = "see \\[image #1: a.png]";
		expect(parseComposerSegments(text, { images: ["a.png"], files: [] })).toEqual([
			{ type: "text", text: "see [image #1: a.png]" },
		]);
	});
});

describe("composerPreviewText", () => {
	test("queue summaries show authored link labels without exposing canonical URLs or adding semantics", () => {
		const label = "same [label] *literal*";
		const wire = composerNarratorReferenceText({ narratorId: "stable-target", label });
		expect(composerPreviewText(`Ask ${wire} next`)).toBe(`Ask @${label} next`);
		expect(composerPreviewText("[@ordinary](https://example.test)")).toBe(
			"[@ordinary](https://example.test)",
		);
		expect(composerPreviewText("[@invalid](nf-agent://open?id=bad/id)")).toBe(
			"[@invalid](nf-agent://open?id=bad/id)",
		);
	});
	test("reads as one plain line in composed order", () => {
		const text =
			"> [quote] 来源 @@m:abcd\n> 内容\n\n怎样算？\n> [quote] 第二\n> 二\n\n看[image #1: a.png]";
		expect(composerPreviewText(text, { images: ["a.png"], files: [] })).toBe(
			"[❝ 来源] 怎样算？ [❝ 第二] 看[a.png]",
		);
		expect(composerPreviewText("plain\ntext")).toBe("plain\ntext");
	});
});
