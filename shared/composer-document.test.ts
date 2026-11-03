import { describe, expect, test } from "bun:test";
import {
	type ComposerDocument,
	composerDocumentProjection,
	composerDocumentText,
	composerDocumentTextCandidates,
	escapeComposerText,
	legacyComposerDocumentText,
	parseComposerDocument,
	readComposerDocument,
	unescapeComposerText,
} from "./composer-document";
import { fileReferenceMessageForDisplay } from "./file-reference";

const empty = (): ComposerDocument => ({ version: 1, paragraphs: [{ children: [] }], assets: [] });
describe("semantic composer document", () => {
	test("projects quotes, unicode token offsets and independent attachment order", () => {
		const doc: ComposerDocument = {
			version: 1,
			assets: [{ id: "asset", kind: "image", name: "x.png", size: 9, mimeType: "image/png" }],
			paragraphs: [
				{
					children: [
						{ type: "text", text: "😀 " },
						{
							type: "fileReference",
							id: "file-node",
							reference: {
								id: "ref",
								deviceId: "local",
								path: "/a.ts",
								label: "a.ts",
								selection: { startLineNumber: 2, startColumn: 1, endLineNumber: 5, endColumn: 1 },
							},
						},
						{ type: "attachment", id: "image-node", assetId: "asset" },
						{ type: "quote", id: "quote", label: "来源", text: "[quote] hi\n", anchor: "m:abcd" },
						{ type: "break" },
						{ type: "text", text: "end" },
					],
				},
			],
		};
		const accepted = parseComposerDocument(doc);
		const { text, fileReferences } = composerDocumentText(accepted);
		// The quote and the image follow typed content, so both stay where they stand.
		expect(text).toBe(
			"😀 #file:a.ts:2-4[image #1: x.png]\n> [quote] 来源 @@m:abcd\n> \\[quote] hi\n>\n\n\nend",
		);
		expect(legacyComposerDocumentText(accepted).text).toBe(
			"> [quote] 来源 @@m:abcd\n> \\[quote] hi\n>\n\n😀 #file:a.ts:2-4\nend",
		);
		const range = fileReferences[0].inputRange;
		if (!range) throw new Error("Expected token offsets");
		const [start, end] = range;
		expect(text.slice(start, end)).toBe("#file:a.ts:2-4");
		expect(start).toBe(text.indexOf("#file"));
		expect(accepted).toEqual(doc);
	});
	test("keeps the historical projection while quotes and attachments lead", () => {
		const doc = parseComposerDocument({
			version: 1,
			assets: [
				{ id: "a", kind: "image", name: "a.png", size: 1, mimeType: "image/png" },
				{ id: "f", kind: "textFile", name: "n.txt", size: 1, mimeType: "text/plain" },
			],
			paragraphs: [
				{
					children: [
						{ type: "attachment", id: "an", assetId: "a" },
						{ type: "quote", id: "q", label: "Q", text: "quoted" },
						{ type: "text", text: " " },
						{ type: "attachment", id: "fn", assetId: "f" },
					],
				},
				{ children: [{ type: "text", text: "body" }] },
			],
		});
		const current = composerDocumentText(doc);
		const legacy = legacyComposerDocumentText(doc);
		expect(current).toEqual({ text: legacy.text, fileReferences: legacy.fileReferences });
		expect(current.text).toBe("> [quote] Q\n> quoted\n\n \nbody");
		expect(composerDocumentTextCandidates(doc)).toHaveLength(1);
	});
	test("numbers attachments per kind in upload order once one follows text", () => {
		const doc = parseComposerDocument({
			version: 1,
			assets: [
				{ id: "b", kind: "image", name: "b[1].png", size: 1, mimeType: "image/png" },
				{ id: "f", kind: "textFile", name: "n.txt", size: 1, mimeType: "text/plain" },
				{ id: "a", kind: "image", name: "a.png", size: 1, mimeType: "image/png" },
			],
			paragraphs: [
				{
					children: [
						{ type: "attachment", id: "an", assetId: "a" },
						{ type: "text", text: "看" },
						{ type: "attachment", id: "bn", assetId: "b" },
						{ type: "quote", id: "q", label: "Q", text: "x" },
						{ type: "text", text: "和" },
						{ type: "attachment", id: "fn", assetId: "f" },
					],
				},
			],
		});
		const { text, spans } = composerDocumentProjection(doc);
		expect(text).toBe(
			"[image #2: a.png]看[image #1: b_1_.png]\n> [quote] Q\n> x\n\n和[file #1: n.txt]",
		);
		const textSpan = spans.find((span) => span.node === 4);
		expect(textSpan && text.slice(textSpan.start, textSpan.end)).toBe("和");
		expect(composerDocumentTextCandidates(doc).map((candidate) => candidate.text)).toEqual([
			text,
			"> [quote] Q\n> x\n\n看和",
		]);
	});
	test("escapes typed placeholder look-alikes once the document has attachments", () => {
		const typed = "> [quote] mine\nsee [image #1: a.png] and \\[file #2: b]";
		const textOnly = parseComposerDocument({
			version: 1,
			assets: [],
			paragraphs: [{ children: [{ type: "text", text: typed }] }],
		});
		expect(composerDocumentText(textOnly).text).toBe(typed);
		const withImage = parseComposerDocument({
			version: 1,
			assets: [{ id: "a", kind: "image", name: "a.png", size: 1, mimeType: "image/png" }],
			paragraphs: [
				{
					children: [
						{ type: "text", text: typed },
						{ type: "attachment", id: "an", assetId: "a" },
					],
				},
			],
		});
		const { text } = composerDocumentText(withImage);
		expect(text).toBe(
			"> [quote] mine\nsee \\[image #1: a.png] and \\\\[file #2: b][image #1: a.png]",
		);
		expect(unescapeComposerText(escapeComposerText(typed))).toBe(typed);
	});
	test("rejects arbitrary editor/html/path fields and unknown versions", () => {
		for (const value of [
			{ ...empty(), html: "<img>" },
			{ ...empty(), version: 2 },
			{ ...empty(), paragraphs: [{ children: [{ type: "html", text: "x" }] }] },
			{
				...empty(),
				assets: [
					{
						id: "x",
						kind: "image",
						name: "x",
						size: 1,
						mimeType: "image/png",
						path: "/etc/passwd",
					},
				],
			},
		])
			expect(readComposerDocument(value)).toBeUndefined();
	});
	test("rejects duplicate ids and dangling or unused asset identities", () => {
		const quote = { type: "quote", id: "q", label: "Q", text: "x" };
		expect(() =>
			parseComposerDocument({ ...empty(), paragraphs: [{ children: [quote, quote] }] }),
		).toThrow();
		expect(() =>
			parseComposerDocument({
				...empty(),
				paragraphs: [{ children: [{ type: "attachment", id: "a", assetId: "missing" }] }],
			}),
		).toThrow();
		expect(() =>
			parseComposerDocument({
				...empty(),
				assets: [{ id: "a", kind: "image", name: "x", size: 1, mimeType: "image/png" }],
			}),
		).toThrow();
	});
	test("enforces text, quote, node, reference and UTF8 budgets", () => {
		expect(() =>
			parseComposerDocument({
				...empty(),
				paragraphs: [{ children: [{ type: "text", text: "x".repeat(200001) }] }],
			}),
		).toThrow();
		expect(() =>
			parseComposerDocument({
				...empty(),
				paragraphs: [
					{
						children: Array.from({ length: 9 }, (_, i) => ({
							type: "quote",
							id: `q${i}`,
							label: "Q",
							text: "x",
						})),
					},
				],
			}),
		).toThrow();
		expect(() =>
			parseComposerDocument({
				...empty(),
				paragraphs: [
					{ children: [{ type: "quote", id: "q", label: "Q", text: "x".repeat(8001) }] },
				],
			}),
		).toThrow();
		expect(() =>
			parseComposerDocument({
				...empty(),
				paragraphs: Array.from({ length: 4097 }, () => ({ children: [] })),
			}),
		).toThrow();
		expect(() =>
			parseComposerDocument({
				...empty(),
				paragraphs: [
					{
						children: Array.from({ length: 17 }, (_, i) => ({
							type: "fileReference",
							id: `n${i}`,
							reference: { id: `r${i}`, deviceId: "local", path: "/x", label: "x" },
						})),
					},
				],
			}),
		).toThrow();
		expect(() => parseComposerDocument({ ...empty(), extra: "中".repeat(750000) })).toThrow();
	});
	test("safe reader rejects cyclic input and accepts empty tombstones", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(readComposerDocument(cyclic)).toBeUndefined();
		expect(readComposerDocument(null)).toBeUndefined();
		expect(composerDocumentText(parseComposerDocument(empty()))).toEqual({
			text: "",
			fileReferences: [],
		});
	});
	test("message display never broadcasts the full layout", () => {
		const displayed = fileReferenceMessageForDisplay({
			id: "m",
			contentJson: [],
			composerDocument: empty(),
		});
		expect(displayed).toEqual({ id: "m", contentJson: [], hasComposerDocument: true });
		expect("composerDocument" in displayed).toBe(false);
	});
});

describe("native media composer documents", () => {
	const assets: ComposerDocument["assets"] = [
		{ id: "v", kind: "video", name: "clip.mp4", size: 8, mimeType: "video/mp4" },
		{ id: "a", kind: "audio", name: "voice.wav", size: 9, mimeType: "audio/wav" },
	];
	test("media-only manifests roundtrip while keeping the historical empty text projection", () => {
		const doc: ComposerDocument = {
			version: 1,
			assets,
			paragraphs: [
				{
					children: [
						{ type: "attachment", id: "audio-node", assetId: "a" },
						{ type: "attachment", id: "video-node", assetId: "v" },
					],
				},
			],
		};
		expect(parseComposerDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
		expect(composerDocumentText(doc)).toEqual({ text: "", fileReferences: [] });
		expect(composerDocumentTextCandidates(doc)).toHaveLength(1);
	});
	test("audio/video placeholders share upload ordinals but retain document position and unicode spans", () => {
		const doc: ComposerDocument = {
			version: 1,
			assets,
			paragraphs: [
				{
					children: [
						{ type: "attachment", id: "audio-node", assetId: "a" },
						{ type: "text", text: "看😀" },
						{ type: "attachment", id: "video-node", assetId: "v" },
					],
				},
			],
		};
		const projection = composerDocumentProjection(parseComposerDocument(doc));
		expect(projection.text).toBe("[audio #2: voice.wav]看😀[video #1: clip.mp4]");
		expect(projection.spans.map((span) => projection.text.slice(span.start, span.end))).toEqual([
			"[audio #2: voice.wav]",
			"看😀",
			"[video #1: clip.mp4]",
		]);
		expect(composerDocumentTextCandidates(doc).map((item) => item.text)).toEqual([
			projection.text,
			"看😀",
		]);
	});
	test("typed audio/video look-alikes escape once without changing text-only legacy documents", () => {
		const typed = "[audio #1: voice.wav] \\[video #2: clip.mp4]";
		expect(unescapeComposerText(escapeComposerText(typed))).toBe(typed);
		const textOnly: ComposerDocument = {
			...empty(),
			paragraphs: [{ children: [{ type: "text", text: typed }] }],
		};
		expect(composerDocumentText(textOnly).text).toBe(typed);
		const withMedia: ComposerDocument = {
			version: 1,
			assets: [assets[1]],
			paragraphs: [
				{
					children: [
						{ type: "text", text: typed },
						{ type: "attachment", id: "audio-node", assetId: "a" },
					],
				},
			],
		};
		expect(composerDocumentText(withMedia).text).toBe(
			`${escapeComposerText(typed)}[audio #1: voice.wav]`,
		);
	});
	test("native assets still reject non-manifest fields, invalid kinds and dangling identities", () => {
		const doc: ComposerDocument = {
			version: 1,
			assets: [assets[1]],
			paragraphs: [{ children: [{ type: "attachment", id: "node", assetId: "a" }] }],
		};
		for (const extra of [
			{ base64: "private" },
			{ path: "/private/voice.wav" },
			{ kind: "sound" },
			{ id: "unknown" },
		]) {
			expect(() =>
				parseComposerDocument({ ...doc, assets: [{ ...assets[1], ...extra }] }),
			).toThrow();
		}
	});
});
