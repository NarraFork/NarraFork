import { describe, expect, spyOn, test } from "bun:test";
import { type ComposerDocument, composerDocumentText } from "@shared/composer-document";
import {
	bindComposerMediaProjection,
	parseOptionalComposerDocument,
	validateComposerAssets,
	validateComposerProjection,
	validatePersistedComposerDocument,
} from "./composer-document";

function imageDocument(): ComposerDocument {
	return {
		version: 1,
		paragraphs: [{ children: [{ type: "attachment", id: "node", assetId: "asset" }] }],
		assets: [{ id: "asset", kind: "image", name: "image.png", size: 9, mimeType: "image/png" }],
	};
}
test("media normalization preserves validated text and rebases file reference ranges", () => {
	const document: ComposerDocument = {
		version: 1,
		paragraphs: [
			{
				children: [
					{ type: "text", text: "listen " },
					{ type: "attachment", id: "node", assetId: "asset" },
					{
						type: "fileReference",
						id: "ref-node",
						reference: { id: "ref", deviceId: "local", path: "/file", label: "file" },
					},
				],
			},
		],
		assets: [{ id: "asset", kind: "video", name: "audio.webm", size: 5, mimeType: "video/webm" }],
	};
	const original = composerDocumentText(document);
	const media = [{ filename: "audio.webm", size: 5, mediaType: "audio/webm" }];
	const result = bindComposerMediaProjection(
		document,
		original.text,
		original.fileReferences,
		media,
	);
	expect(result.document!.assets[0].kind).toBe("audio");
	expect(result.text).not.toBe(original.text);
	expect(result.references).toEqual(original.fileReferences);
	validateComposerProjection(result.document, result.text, result.references);
	validateComposerAssets(result.document, [], [], media);
	expect(() =>
		bindComposerMediaProjection(
			document,
			original.text + "tampered",
			original.fileReferences,
			media,
		),
	).toThrow();
	expect(() =>
		bindComposerMediaProjection(document, original.text, original.fileReferences, [
			{ ...media[0], size: 6 },
		]),
	).toThrow();
});
test("persisted pre-media projection keeps image escaping and exact reference offsets", () => {
	const document: ComposerDocument = {
		version: 1,
		assets: [{ id: "a", kind: "image", name: "image.png", size: 9, mimeType: "image/png" }],
		paragraphs: [
			{
				children: [
					{ type: "text", text: "[audio #1: x] [video #2: y] [image #1: fake] " },
					{ type: "attachment", id: "an", assetId: "a" },
					{
						type: "fileReference",
						id: "rn",
						reference: { id: "r", deviceId: "local", path: "/file", label: "file" },
					},
				],
			},
		],
	};
	const text = "[audio #1: x] [video #2: y] \\[image #1: fake] [image #1: image.png]#file:file";
	const start = text.indexOf("#file");
	const reference = {
		id: "r",
		deviceId: "local",
		path: "/file",
		label: "file",
		inputRange: [start, text.length] as [number, number],
	};
	const blocks = [
		{ type: "text", text },
		{ type: "image", name: "image.png", size: 9 },
		{ type: "file_reference", reference },
	];
	expect(validatePersistedComposerDocument(document, blocks)).toEqual(document);
	expect(() => validateComposerProjection(document, text, [reference])).toThrow();
	expect(() =>
		validatePersistedComposerDocument(document, [
			blocks[0],
			blocks[1],
			{ type: "file_reference", reference: { ...reference, inputRange: [start + 1, text.length] } },
		]),
	).toThrow();
	expect(() =>
		validatePersistedComposerDocument(document, [
			{ type: "text", text: text.replace("\\[image #1: fake]", "[image #1: fake]") },
			blocks[1],
			blocks[2],
		]),
	).toThrow();
	expect(() =>
		validatePersistedComposerDocument(document, [
			blocks[0],
			{ type: "image", name: "other.png", size: 9 },
			blocks[2],
		]),
	).toThrow();
});

test("pre-media compatibility never applies to persisted native media", () => {
	const document: ComposerDocument = {
		version: 1,
		assets: [{ id: "a", kind: "audio", name: "a.wav", size: 1, mimeType: "audio/wav" }],
		paragraphs: [
			{
				children: [
					{ type: "text", text: "literal [video #1: fake] " },
					{ type: "attachment", id: "an", assetId: "a" },
				],
			},
		],
	};
	expect(() =>
		validatePersistedComposerDocument(document, [
			{ type: "text", text: "literal [video #1: fake] [audio #1: a.wav]" },
			{ type: "audio", filename: "a.wav", size: 1, mediaType: "audio/wav" },
		]),
	).toThrow("does not match");
});

describe("server composer acceptance", () => {
	test("raw UTF8 and character budgets reject before JSON.parse, including unknown fields", () => {
		const parse = spyOn(JSON, "parse");
		try {
			for (const raw of [
				"x".repeat(2 * 1024 * 1024 + 1),
				`{"unknown":"${"x".repeat(2 * 1024 * 1024)}"}`,
				`{"unknown":"${"中".repeat(750_000)}"}`,
			])
				expect(() => parseOptionalComposerDocument(raw)).toThrow("2 MiB");
			expect(parse).not.toHaveBeenCalled();
		} finally {
			parse.mockRestore();
		}
	});
	test("unknown object fields and oversized child arrays fail before full serialization", () => {
		const stringify = spyOn(JSON, "stringify");
		try {
			expect(() =>
				parseOptionalComposerDocument({ ...imageDocument(), unknown: "x".repeat(2 * 1024 * 1024) }),
			).toThrow();
			expect(() =>
				parseOptionalComposerDocument({
					version: 1,
					paragraphs: [{ children: Array.from({ length: 4097 }, () => ({ type: "break" })) }],
					assets: [],
				}),
			).toThrow();
			expect(stringify).not.toHaveBeenCalled();
		} finally {
			stringify.mockRestore();
		}
	});
	test("accepts omitted legacy layout but rejects malformed structured input", () => {
		expect(parseOptionalComposerDocument(null)).toBeUndefined();
		expect(parseOptionalComposerDocument(JSON.stringify(imageDocument()))).toEqual(imageDocument());
		expect(() => parseOptionalComposerDocument("{bad-json")).toThrow("Invalid composer document");
	});
	test("requires exact legacy projection and attachment binding", () => {
		const document = imageDocument();
		validateComposerProjection(document, "", []);
		validateComposerAssets(
			document,
			[{ filename: "image.png", size: 9, mediaType: "image/png" }],
			[],
		);
		for (const images of [
			[],
			[{ filename: "other.png", size: 9, mediaType: "image/png" }],
			[{ filename: "image.png", size: 10, mediaType: "image/png" }],
		])
			expect(() => validateComposerAssets(document, images, [])).toThrow();
		expect(() => validateComposerProjection(document, "extra", [])).toThrow();
		expect(() =>
			validateComposerAssets(document, [], [{ name: "image.png", size: 9, type: "image/png" }]),
		).toThrow();
	});
	test("block discriminators and advisory MIME values do not participate in attachment identity", () => {
		const document: ComposerDocument = {
			version: 1,
			paragraphs: [{ children: [{ type: "attachment", id: "node", assetId: "asset" }] }],
			assets: [
				{ id: "asset", kind: "textFile", name: "note.txt", size: 5, mimeType: "text/plain" },
			],
		};
		for (const metadata of [
			{ name: "note.txt", size: 5, type: "text/plain" },
			{ filename: "note.txt", size: 5, type: "text_file" },
			{ filename: "note.txt", size: 5, type: "text_file", mimeType: "text/plain" },
		])
			validateComposerAssets(document, [], [metadata]);
		for (const mime of ["application/json", "text/html"])
			for (const metadata of [
				{ type: mime },
				{ type: "text_file", mimeType: mime },
				{ type: "text_file", sourceMimeType: mime },
			])
				validateComposerAssets(document, [], [{ filename: "note.txt", size: 5, ...metadata }]);
		validateComposerAssets(
			imageDocument(),
			[{ type: "image", filename: "image.png", size: 9, mediaType: "image/png" }],
			[],
		);
	});
	test("uses original upload MIME while keeping sniffed transport metadata separate", () => {
		const document = imageDocument();
		document.assets[0].mimeType = "";
		validateComposerAssets(
			document,
			[{ filename: "image.png", size: 9, sourceMimeType: "", mediaType: "image/png" }],
			[],
		);
	});
});

async function multipartFiles(files: File[]): Promise<File[]> {
	const data = new FormData();
	for (const file of files) data.append("files", file);
	const parsed = await new Request("http://localhost", { method: "POST", body: data }).formData();
	return parsed.getAll("files") as File[];
}

function filesDocument(files: File[], kind: "image" | "textFile"): ComposerDocument {
	return {
		version: 1,
		paragraphs: [
			{
				children: files.map((_, index) => ({
					type: "attachment",
					id: `node-${index}`,
					assetId: `asset-${index}`,
				})),
			},
		],
		assets: files.map((file, index) => ({
			id: `asset-${index}`,
			kind,
			name: file.name,
			size: file.size,
			mimeType: file.type,
		})),
	};
}

describe("composer MIME is advisory across upload and persistence", () => {
	test("accepts ZIP MIME aliases after a real multipart round trip", async () => {
		const original = new File(["PK archive bytes"], "附件.zip", {
			type: "application/x-zip-compressed",
		});
		const document = filesDocument([original], "textFile");
		const uploads = await multipartFiles([original]);
		expect(uploads[0].type).toBe("application/zip");
		expect(uploads[0].name).toBe(original.name);
		expect(uploads[0].size).toBe(original.size);
		validateComposerAssets(document, [], uploads);
		validatePersistedComposerDocument(document, [
			{
				type: "text_file",
				filename: original.name,
				size: original.size,
				sourceMimeType: uploads[0].type,
			},
		]);
	});

	test("accepts empty, source-code and image MIME changes without rewriting documents", async () => {
		for (const [name, mimeType, kind] of [
			["unknown.custom", "", "textFile"],
			["note.txt", "", "textFile"],
			["main.ts", "text/plain", "textFile"],
			["image.png", "image/jpeg", "image"],
			["image.png", "", "image"],
		] as const) {
			const original = new File(["bytes"], name, { type: mimeType });
			const document = filesDocument([original], kind);
			const uploads = await multipartFiles([original]);
			validateComposerAssets(
				document,
				kind === "image" ? uploads : [],
				kind === "textFile" ? uploads : [],
			);
			expect(document.assets[0].mimeType).toBe(original.type);
			if (kind === "image") {
				validatePersistedComposerDocument(document, [
					{
						type: "image",
						filename: original.name,
						size: original.size,
						sourceMimeType: uploads[0].type,
						mediaType: "image/jpeg",
					},
				]);
			}
		}
	});

	test("still binds duplicate names by count, size and ordinal position", async () => {
		const files = [
			new File(["first"], "same.zip", { type: "application/x-zip-compressed" }),
			new File(["second"], "same.zip", { type: "application/zip" }),
		];
		const document = filesDocument(files, "textFile");
		const uploads = await multipartFiles(files);
		validateComposerAssets(document, [], uploads);
		expect(() => validateComposerAssets(document, [], uploads.toReversed())).toThrow("metadata");
		expect(() => validateComposerAssets(document, [], uploads.slice(1))).toThrow("count");
	});
});

describe("composer native media asset identity", () => {
	const files = [
		{ filename: "clip.webm", size: 32, mediaType: "video/webm" },
		{ filename: "voice.wav", size: 60, mediaType: "audio/wav" },
	];
	const document: ComposerDocument = {
		version: 1,
		paragraphs: [
			{
				children: [
					{ type: "attachment", id: "clip-node", assetId: "clip" },
					{ type: "attachment", id: "voice-node", assetId: "voice" },
				],
			},
		],
		assets: [
			{ id: "clip", kind: "video", name: "clip.webm", size: 32, mimeType: "video/webm" },
			{ id: "voice", kind: "audio", name: "voice.wav", size: 60, mimeType: "audio/wav" },
		],
	};
	test("accepts a media-only manifest and preserves mixed-modality upload order", () => {
		expect(parseOptionalComposerDocument(document)).toEqual(document);
		validateComposerAssets(document, [], [], files);
		expect(() => validateComposerAssets(document, [], [], files.toReversed())).toThrow("metadata");
	});
	test("media count, size and known modality bind the manifest to real uploads", () => {
		expect(() => validateComposerAssets(document, [], [])).toThrow("count");
		expect(() => validateComposerAssets(document, [], [], files.slice(1))).toThrow("count");
		expect(() =>
			validateComposerAssets(document, [], [], [{ ...files[0], size: 33 }, files[1]]),
		).toThrow("metadata");
		expect(() =>
			validateComposerAssets(
				document,
				[],
				[],
				[{ ...files[0], mediaType: "audio/webm" }, files[1]],
			),
		).toThrow("metadata");
	});
	test("persisted audio/video blocks retain the rich document without modifying the refs", () => {
		const blocks = [
			{ type: "video", mediaId: "clip-id", uploadNarratorId: "owner", ...files[0] },
			{ type: "audio", mediaId: "voice-id", uploadNarratorId: "owner", ...files[1] },
			{ type: "text", text: composerDocumentText(document).text },
		];
		const before = JSON.stringify(blocks);
		expect(validatePersistedComposerDocument(document, blocks)).toEqual(document);
		expect(JSON.stringify(blocks)).toBe(before);
	});
	test("multipart MIME aliases or absent advisory MIME keep filename/size identity", () => {
		validateComposerAssets(
			document,
			[],
			[],
			[
				{ name: "clip.webm", size: 32, type: "" },
				{ name: "voice.wav", size: 60, type: "audio/x-wav" },
			],
		);
	});
});
