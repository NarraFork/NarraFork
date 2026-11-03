import { expect, test } from "bun:test";
import {
	type ComposerDocument,
	composerDocumentText,
	parseComposerDocument,
} from "@shared/composer-document";
import {
	composerInputFromDocument,
	importComposerInput,
	missingComposerAssets,
	withComposerAttachments,
} from "./composer-document-adapter";
import { composerOptimizeTarget } from "./composer-optimize-target";
import { joinQuotedComposerInput } from "./composer-quotes";
import { getComposerAssetId } from "./draft-image-attachments";
import { insertFileReference } from "./file-reference-input";
import type { InlineComposerEditorHandle } from "./InlineComposerEditor";

const empty: ComposerDocument = { version: 1, paragraphs: [{ children: [] }], assets: [] };

test("legacy quotes and UTF-16 file occurrences import to atoms with the same projection", () => {
	const body = insertFileReference(
		{ text: "😀 before ", fileReferences: [] },
		{ id: "ref-1", label: "a.ts", path: "/a.ts", deviceId: "local" },
	);
	const input = joinQuotedComposerInput(
		[{ label: "source", text: "quote", anchor: "m:abcd" }],
		body,
	);
	const document = importComposerInput(input);
	expect(document.paragraphs[0].children.map((node) => node.type)).toEqual([
		"quote",
		"text",
		"fileReference",
		"text",
	]);
	expect(composerDocumentText(document)).toEqual(input);
	expect(parseComposerDocument(document)).toBeDefined();
});

test.each([
	["empty quote body", "> [quote] source\n>\n\n"],
	["8001-character quote body", `> [quote] source\n> ${"q".repeat(8001)}\n\n`],
	["81-character label", `> [quote] ${"l".repeat(81)}\n> quote\n\n`],
	["257-character anchor", `> [quote] source @@m:${"a".repeat(255)}\n> quote\n\n`],
	["noncanonical header", "> [quote]  source  \n> quote\n\n"],
	["mixed valid and invalid quotes", "> [quote] source\n> valid\n\n> [quote] empty\n>\n\n"],
])("legacy %s prefixes restore losslessly as text with original file offsets", (_name, prefix) => {
	const inserted = insertFileReference(
		{ text: `${prefix}😀 body before `, fileReferences: [] },
		{ id: "ref-1", label: "a.ts", path: "/a.ts", deviceId: "local" },
	);
	const input = {
		text: `${inserted.text} after\nrest of body`,
		fileReferences: inserted.fileReferences,
	};
	const document = importComposerInput(input);
	expect(document.paragraphs[0].children.map((node) => node.type)).toEqual([
		"text",
		"fileReference",
		"text",
	]);
	expect(document.paragraphs[0].children[0]).toEqual({
		type: "text",
		text: input.text.slice(0, input.fileReferences[0].inputRange?.[0]),
	});
	expect(parseComposerDocument(document)).toEqual(document);
	expect(composerDocumentText(document)).toEqual(input);
});

test.each([
	"> [quote] source\n> quote",
	"> [quote] first\n> quote\n> [quote] second\n> more\n\nbody",
])("noncanonical quote separators preserve the exact original text: %j", (text) => {
	const input = { text, fileReferences: [] };
	const document = importComposerInput(input);
	expect(document.paragraphs[0].children).toEqual([{ type: "text", text }]);
	expect(parseComposerDocument(document)).toEqual(document);
	expect(composerDocumentText(document)).toEqual(input);
});

test("quote limits remain inclusive and legal quotes still import as quote atoms", () => {
	const input = joinQuotedComposerInput(
		[{ label: "l".repeat(80), text: "q".repeat(8000), anchor: `m:${"a".repeat(254)}` }],
		{ text: "😀 body", fileReferences: [] },
	);
	const document = importComposerInput(input);
	expect(document.paragraphs[0].children.map((node) => node.type)).toEqual(["quote", "text"]);
	expect(parseComposerDocument(document)).toEqual(document);
	expect(composerDocumentText(document)).toEqual(input);
});

test("unknown document versions retain the existing legacy-text recovery path", () => {
	const input = {
		text: "> [quote] source\n>\n\nbody",
		fileReferences: [],
		composerDocument: { version: 99, paragraphs: [], assets: [] } as unknown as ComposerDocument,
	};
	const document = importComposerInput(input);
	expect(document.paragraphs[0].children).toEqual([{ type: "text", text: input.text }]);
	expect(parseComposerDocument(document)).toEqual(document);
	expect(composerDocumentText(document)).toEqual({ text: input.text, fileReferences: [] });
});

test("mixed document positions survive projection and reimport without grouping atoms", () => {
	const image = new File(["x"], "same.png", { type: "image/png" });
	const attachment = withComposerAttachments(empty, [image], []);
	const document: ComposerDocument = {
		...attachment,
		paragraphs: [
			{
				children: [
					{ type: "text", text: "A" },
					...attachment.paragraphs[0].children,
					{ type: "quote", id: "q1", label: "source", text: "quote" },
					{ type: "text", text: "B" },
				],
			},
		],
	};
	expect(importComposerInput(composerInputFromDocument(document))).toEqual(document);
	expect(document.assets[0].id).toBe(getComposerAssetId(image));
});

test("missing attachments keep their positions and same-name files never share identity", () => {
	const first = new File(["a"], "same.png", { type: "image/png" });
	const second = new File(["b"], "same.png", { type: "image/png" });
	const document = withComposerAttachments(empty, [first, second], []);
	expect(document.assets[0].id).not.toBe(document.assets[1].id);
	expect(withComposerAttachments(document, [], [])).toBe(document);
	expect(missingComposerAssets(document, new Map([[getComposerAssetId(first), first]]))).toBe(true);
});

function editor(initial: ComposerDocument, start = 0, end = start) {
	let document = initial;
	let preserved = false;
	const handle = {
		getElement: () => ({}) as HTMLDivElement,
		getDocument: () => document,
		getSelection: () => ({ start, end }),
		setDocument: (value: ComposerDocument, history?: boolean) => {
			document = value;
			preserved = !!history;
		},
	} as InlineComposerEditorHandle;
	return {
		handle,
		get: () => document,
		preserved: () => preserved,
		change: (next: ComposerDocument) => {
			document = next;
		},
	};
}

test("optimization replaces only selected text, preserving atoms and a single undo transaction", () => {
	const value: ComposerDocument = {
		...empty,
		paragraphs: [
			{
				children: [
					{ type: "text", text: "hello world" },
					{ type: "quote", id: "q1", label: "source", text: "do not optimize this" },
				],
			},
		],
	};
	const state = editor(value, 6, 11);
	const target = composerOptimizeTarget(state.handle);
	expect(target?.text).toBe("world");
	expect(target?.apply("earth")).toBe(true);
	expect(state.get().paragraphs[0].children[0]).toEqual({ type: "text", text: "hello earth" });
	expect(state.get().paragraphs[0].children[1]).toEqual(value.paragraphs[0].children[1]);
	expect(state.preserved()).toBe(true);
});

test("optimization rejects stale content and malformed multi-segment responses atomically", () => {
	const value: ComposerDocument = {
		...empty,
		paragraphs: [
			{
				children: [
					{ type: "text", text: "A" },
					{ type: "quote", id: "q1", label: "source", text: "quote" },
					{ type: "text", text: "B" },
				],
			},
		],
	};
	const state = editor(value);
	const target = composerOptimizeTarget(state.handle);
	expect(target?.text).not.toContain("quote");
	expect(target?.apply("merged")).toBe(false);
	expect(state.get()).toBe(value);
	state.change(empty);
	expect(target?.apply(target.text)).toBe(false);
	expect(state.get()).toBe(empty);
});

test("optimization validates segment markers and leaves quote/image order intact", () => {
	const value: ComposerDocument = {
		...empty,
		paragraphs: [
			{
				children: [
					{ type: "text", text: "alpha" },
					{ type: "quote", id: "q1", label: "source", text: "quote" },
					{ type: "text", text: "beta" },
				],
			},
		],
	};
	const state = editor(value);
	const target = composerOptimizeTarget(state.handle);
	const response =
		target?.text
			.slice(target.text.indexOf("<<<"))
			.replace("alpha", "ALPHA")
			.replace("beta", "BETA") ?? "";
	expect(target?.apply(response)).toBe(true);
	expect(state.get().paragraphs[0].children).toEqual([
		{ type: "text", text: "ALPHA" },
		value.paragraphs[0].children[1],
		{ type: "text", text: "BETA" },
	]);
});
