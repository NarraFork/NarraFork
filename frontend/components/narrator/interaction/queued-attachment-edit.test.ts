/**
 * Rules behind editing a queued message's attachments.
 *
 * Two of these pin behaviour that used to be wrong in ways the user could see:
 * a queued message with only images was uneditable because an empty textarea
 * blocked submission, and text files were addressed by name even though a
 * taken-over subagent's queue can hold two files with the same name.
 */

import { describe, expect, test } from "bun:test";
import type { ComposerDocument } from "@shared/composer-document";
import type { BufferMessageSummary } from "../../../lib/api/types";
import {
	bindComposerEditFiles,
	buildQueuedEditPayload,
	canSubmitQueuedEdit,
	composerEditDetailAttachments,
	type ExistingComposerAttachment,
	MAX_QUEUED_IMAGES,
	MAX_QUEUED_TEXT_FILES,
	projectComposerEdit,
	type QueuedEditAttachmentState,
	queuedEditTouchesAttachments,
	remainingImageRoom,
	remainingTextFileRoom,
	seedComposerEditSession,
	seedQueuedEditAttachments,
} from "./queued-attachment-edit";

function image(imageId: string, filename = `${imageId}.png`) {
	return { imageId, filename, mediaType: "image/png", uploadNarratorId: "narrator-1" };
}

function textFile(index: number, filename: string, size = 10) {
	return { index, filename, size };
}

function summary(overrides: Partial<BufferMessageSummary> = {}): BufferMessageSummary {
	return {
		id: "buf-1",
		text: "hello",
		bufferedAt: "2026-01-01T00:00:00.000Z",
		imageCount: 0,
		images: [],
		textFiles: [],
		...overrides,
	};
}

function state(overrides: Partial<QueuedEditAttachmentState> = {}): QueuedEditAttachmentState {
	return {
		text: "",
		keptImages: [],
		newImages: [],
		keptTextFiles: [],
		newTextFiles: [],
		fileReferences: [],
		...overrides,
	};
}

function fakeFile(name: string): File {
	return new File(["x"], name, { type: "text/plain" });
}

describe("native media queued edits", () => {
	const media = {
		mediaId: "media-a",
		filename: "voice.wav",
		mediaType: "audio/wav",
		size: 20,
		uploadNarratorId: "owner",
	};
	test("media-only edits remain sendable and text edits retain stable references", () => {
		const original = summary({ text: "", media: [media] });
		const seeded = seedQueuedEditAttachments(original);
		expect(seeded.keptMedia).toEqual([media]);
		const draft = state({ keptMedia: seeded.keptMedia, newMedia: [] });
		expect(canSubmitQueuedEdit(draft)).toBe(true);
		expect(buildQueuedEditPayload(draft)).toMatchObject({
			keepMediaIds: ["media-a"],
			newMedia: [],
		});
		expect(queuedEditTouchesAttachments(original, draft)).toBe(false);
	});
	test("explicit removal sends an empty keep list and additions preserve binary files", () => {
		const added = new File(["audio"], "voice.wav", { type: "audio/wav" });
		const draft = state({ keptMedia: [], newMedia: [added] });
		expect(canSubmitQueuedEdit(draft)).toBe(true);
		expect(buildQueuedEditPayload(draft)).toMatchObject({ keepMediaIds: [], newMedia: [added] });
		expect(queuedEditTouchesAttachments(summary({ media: [media] }), draft)).toBe(true);
		expect(canSubmitQueuedEdit(state({ keptMedia: [], newMedia: [] }))).toBe(false);
	});
});

describe("seedQueuedEditAttachments", () => {
	test("separates images and text files from a summary", () => {
		const seeded = seedQueuedEditAttachments(
			summary({
				imageCount: 2,
				images: [image("img-a"), image("img-b")],
				textFiles: [textFile(0, "notes.md", 120)],
			}),
		);

		expect(seeded.keptImages.map((i) => i.imageId)).toEqual(["img-a", "img-b"]);
		expect(seeded.keptTextFiles).toEqual([textFile(0, "notes.md", 120)]);
	});

	test("copies the arrays so editing the draft cannot mutate the queue snapshot", () => {
		const original = summary({ imageCount: 1, images: [image("img-a")] });
		const seeded = seedQueuedEditAttachments(original);

		seeded.keptImages.pop();

		expect(original.images).toHaveLength(1);
	});

	test("treats a pre-attachment-aware summary as carrying no attachments", () => {
		// An older server sends neither array. It also ignores keep lists, so it
		// preserves whatever it holds — reading this as "nothing" is safe.
		const seeded = seedQueuedEditAttachments({
			id: "buf-1",
			text: "hi",
			bufferedAt: "2026-01-01T00:00:00.000Z",
			imageCount: 3,
		});

		expect(seeded.keptImages).toEqual([]);
		expect(seeded.keptTextFiles).toEqual([]);
	});
});

describe("file reference queue attachments", () => {
	const reference = {
		id: "ref-a",
		deviceId: "RemoteCaseID",
		path: "/work/a.ts",
		label: "a.ts",
		selection: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 },
	};

	test("seeding and payloads detach reference metadata from the queue", () => {
		const original = summary({ fileReferences: [reference] });
		const seeded = seedQueuedEditAttachments(original);
		seeded.fileReferences[0].label = "new label";
		if (seeded.fileReferences[0].selection) seeded.fileReferences[0].selection.startLineNumber = 1;
		expect(original.fileReferences?.[0].label).toBe("a.ts");
		expect(original.fileReferences?.[0].selection?.startLineNumber).toBe(2);
		const payload = buildQueuedEditPayload(state({ fileReferences: seeded.fileReferences }));
		payload.fileReferences[0].label = "another label";
		expect(seeded.fileReferences[0].label).toBe("new label");
	});

	test("a pure reference can be submitted and retains its occurrence ID", () => {
		const edit = state({ fileReferences: [reference] });
		expect(canSubmitQueuedEdit(edit)).toBe(true);
		expect(buildQueuedEditPayload(edit).fileReferences).toEqual([reference]);
	});

	test("removal is explicit and changes attachment detection", () => {
		const original = summary({ fileReferences: [reference] });
		const unchanged = state({ text: "changed wording", fileReferences: [reference] });
		expect(queuedEditTouchesAttachments(original, unchanged)).toBe(false);
		const removed = state({ text: "no attachment" });
		expect(queuedEditTouchesAttachments(original, removed)).toBe(true);
		expect(buildQueuedEditPayload(removed).fileReferences).toEqual([]);
		expect(seedQueuedEditAttachments(summary()).fileReferences).toEqual([]);
	});

	test("submission trims prompt and token positions together", () => {
		const plain = { ...reference, selection: undefined, inputRange: [2, 12] as [number, number] };
		const payload = buildQueuedEditPayload(
			state({ text: "  #file:a.ts  ", fileReferences: [plain] }),
		);
		expect(payload.fileReferences[0].inputRange).toEqual([0, 10]);
	});
});

describe("remainingImageRoom", () => {
	test("counts kept and newly added against the same limit", () => {
		expect(remainingImageRoom(0, 0)).toBe(MAX_QUEUED_IMAGES);
		expect(remainingImageRoom(4, 3)).toBe(MAX_QUEUED_IMAGES - 7);
	});

	test("never reports negative room once the limit is reached or exceeded", () => {
		expect(remainingImageRoom(MAX_QUEUED_IMAGES, 0)).toBe(0);
		expect(remainingImageRoom(MAX_QUEUED_IMAGES, 5)).toBe(0);
	});
});

describe("remainingTextFileRoom", () => {
	test("counts kept and newly added against the same limit", () => {
		expect(remainingTextFileRoom(0, 0)).toBe(MAX_QUEUED_TEXT_FILES);
		expect(remainingTextFileRoom(4, 3)).toBe(MAX_QUEUED_TEXT_FILES - 7);
	});

	test("never reports negative room once the limit is reached or exceeded", () => {
		expect(remainingTextFileRoom(MAX_QUEUED_TEXT_FILES, 0)).toBe(0);
		expect(remainingTextFileRoom(MAX_QUEUED_TEXT_FILES, 5)).toBe(0);
	});
});

describe("image and text-file room are independent", () => {
	// The two used to share one constant, so raising the image bound would have
	// silently raised the text-file bound too.
	test("images allow strictly more than text files", () => {
		expect(MAX_QUEUED_IMAGES).toBeGreaterThan(MAX_QUEUED_TEXT_FILES);
	});

	test("a full text-file set leaves image room untouched", () => {
		expect(remainingTextFileRoom(MAX_QUEUED_TEXT_FILES, 0)).toBe(0);
		expect(remainingImageRoom(MAX_QUEUED_TEXT_FILES, 0)).toBeGreaterThan(0);
	});
});

describe("canSubmitQueuedEdit", () => {
	test("text alone is submittable", () => {
		expect(canSubmitQueuedEdit(state({ text: "do the thing" }))).toBe(true);
	});

	test("an attachment alone is submittable, with no text at all", () => {
		// An image carries the message on its own; requiring text here made
		// image-only queued messages impossible to edit.
		expect(canSubmitQueuedEdit(state({ keptImages: [image("img-a")] }))).toBe(true);
		expect(canSubmitQueuedEdit(state({ newImages: [fakeFile("a.png")] }))).toBe(true);
		expect(canSubmitQueuedEdit(state({ keptTextFiles: [textFile(0, "a.md")] }))).toBe(true);
		expect(canSubmitQueuedEdit(state({ newTextFiles: [fakeFile("b.md")] }))).toBe(true);
	});

	test("whitespace-only text with an attachment is still submittable", () => {
		expect(canSubmitQueuedEdit(state({ text: "   ", keptImages: [image("img-a")] }))).toBe(true);
	});

	test("nothing at all is not submittable", () => {
		expect(canSubmitQueuedEdit(state())).toBe(false);
		expect(canSubmitQueuedEdit(state({ text: "  \n " }))).toBe(false);
	});
});

describe("buildQueuedEditPayload", () => {
	test("sends image ids and positional text-file identities", () => {
		const payload = buildQueuedEditPayload(
			state({
				text: "keep going",
				keptImages: [image("img-a"), image("img-c")],
				keptTextFiles: [textFile(0, "dup.md"), textFile(2, "dup.md")],
				newImages: [fakeFile("new.png")],
				newTextFiles: [fakeFile("new.md")],
			}),
		);

		expect(payload.keepImageIds).toEqual(["img-a", "img-c"]);
		// Same filename twice: only the index distinguishes them, which is exactly
		// the case a name-keyed payload got wrong.
		expect(payload.keepTextFiles).toEqual([
			{ index: 0, filename: "dup.md" },
			{ index: 2, filename: "dup.md" },
		]);
		expect(payload.newImages).toHaveLength(1);
		expect(payload.newTextFiles).toHaveLength(1);
	});

	test("an emptied keep list stays an empty array, never omitted", () => {
		// Omission means "keep everything" server-side, so dropping the field after
		// the user removed every attachment would resurrect all of them.
		const payload = buildQueuedEditPayload(state({ text: "text only now" }));

		expect(payload.keepImageIds).toEqual([]);
		expect(payload.keepTextFiles).toEqual([]);
	});
});

describe("queuedEditTouchesAttachments", () => {
	const original = summary({
		imageCount: 2,
		images: [image("img-a"), image("img-b")],
		textFiles: [textFile(0, "a.md")],
	});

	test("false when the edit only changes the text", () => {
		expect(
			queuedEditTouchesAttachments(
				original,
				state({
					text: "new wording",
					keptImages: [image("img-a"), image("img-b")],
					keptTextFiles: [textFile(0, "a.md")],
				}),
			),
		).toBe(false);
	});

	test("true when an attachment was removed", () => {
		expect(
			queuedEditTouchesAttachments(
				original,
				state({ keptImages: [image("img-a")], keptTextFiles: [textFile(0, "a.md")] }),
			),
		).toBe(true);
	});

	test("true when a new file was added", () => {
		expect(
			queuedEditTouchesAttachments(
				original,
				state({
					keptImages: [image("img-a"), image("img-b")],
					keptTextFiles: [textFile(0, "a.md")],
					newImages: [fakeFile("extra.png")],
				}),
			),
		).toBe(true);
	});
});

describe("semantic media composer edits", () => {
	const refs = [
		{
			mediaId: "video-original",
			filename: "same.webm",
			mediaType: "video/webm",
			size: 4,
			uploadNarratorId: "source-owner",
		},
		{
			mediaId: "audio-original",
			filename: "same.webm",
			mediaType: "audio/webm",
			size: 4,
			uploadNarratorId: "source-owner",
		},
	];
	const resources = () =>
		composerEditDetailAttachments({ images: [], textFiles: [], media: refs }, "fork-context") ?? [];
	function doc(): ComposerDocument {
		return {
			version: 1,
			assets: resources().map((resource, index) => ({
				id: `media-${index}`,
				kind: resource.kind,
				name: resource.name,
				size: resource.size,
				mimeType: resource.mimeType,
			})),
			paragraphs: [
				{
					children: [
						{ type: "attachment", id: "audio-first", assetId: "media-1" },
						{ type: "text", text: " middle " },
						{ type: "attachment", id: "video-last", assetId: "media-0" },
					],
				},
			],
		};
	}
	test("detail retains source-owned media and a combined audio/video lane despite visual reorder", () => {
		const existing = resources();
		expect(existing.map((resource) => [resource.mediaId, resource.uploadNarratorId])).toEqual([
			["video-original", "source-owner"],
			["audio-original", "source-owner"],
		]);
		const document = doc();
		const session = seedComposerEditSession(
			{ text: "", fileReferences: [], composerDocument: document },
			existing,
		);
		const snapshot = projectComposerEdit(session, document);
		expect(snapshot.keepMediaIds).toEqual(refs.map((media) => media.mediaId));
		expect(snapshot.newMedia).toEqual([]);
		expect(snapshot.newTextFiles).toEqual([]);
		expect(snapshot.composerDocument).toEqual(document);
	});
	test("legacy media imports into chips, explicit deletion clears keeps, and undo restores IDs", () => {
		const session = seedComposerEditSession({ text: "legacy", fileReferences: [] }, resources());
		expect(session.document.assets.map((asset) => asset.kind)).toEqual(["video", "audio"]);
		const cleared = projectComposerEdit(session, {
			...session.document,
			assets: [],
			paragraphs: [{ children: [{ type: "text", text: "now text" }] }],
		});
		expect(cleared.keepMediaIds).toEqual([]);
		expect(cleared.newMedia).toEqual([]);
		expect(projectComposerEdit(session, session.document).keepMediaIds).toEqual([
			"video-original",
			"audio-original",
		]);
	});
	test("same-name mixed new media stay separate, with manifest upload order independent from nodes", () => {
		const session = seedComposerEditSession(
			{ text: "", fileReferences: [], composerDocument: doc() },
			resources(),
		);
		const audio = new File(["audio"], "same.webm", { type: "audio/webm" });
		const video = new File(["video"], "same.webm", { type: "video/webm" });
		const a = bindComposerEditFiles(session, [audio], "audio");
		const v = bindComposerEditFiles(session, [video], "video");
		const document = {
			...session.document,
			assets: [...v.assets, ...a.assets, ...session.document.assets],
			paragraphs: [
				{ children: [...v.nodes, ...a.nodes, ...session.document.paragraphs[0].children] },
			],
		};
		const snapshot = projectComposerEdit(session, document);
		expect(snapshot.newMedia).toEqual([audio, video]);
		expect(snapshot.newTextFiles).toEqual([]);
		expect(snapshot.composerDocument.assets.map((asset) => asset.id)).toEqual([
			"media-0",
			"media-1",
			a.assets[0].id,
			v.assets[0].id,
		]);
		expect(snapshot.composerDocument.paragraphs).toEqual(document.paragraphs);
	});
	test("rejects missing IDs, stale mixed lane and more than ten active media", () => {
		expect(() =>
			seedComposerEditSession({ text: "", fileReferences: [] }, [
				{ ...resources()[0], mediaId: undefined },
			]),
		).toThrow("identity");
		expect(() =>
			seedComposerEditSession(
				{ text: "", fileReferences: [], composerDocument: doc() },
				[...resources()].reverse(),
			),
		).toThrow("out of date");
		const session = seedComposerEditSession({ text: "", fileReferences: [] }, resources());
		const added = bindComposerEditFiles(
			session,
			Array.from({ length: 9 }, () => new File(["x"], "a.wav", { type: "audio/wav" })),
			"audio",
		);
		const document = {
			...session.document,
			assets: [...session.document.assets, ...added.assets],
			paragraphs: [{ children: [...session.document.paragraphs[0].children, ...added.nodes] }],
		};
		expect(() => projectComposerEdit(session, document)).toThrow("Maximum 10");
		const ten = {
			...document,
			paragraphs: [{ children: document.paragraphs[0].children.slice(0, -1) }],
		};
		const snapshot = projectComposerEdit(session, ten);
		expect(snapshot.keepMediaIds.length + snapshot.newMedia.length).toBe(10);
	});
});

// The same pure projection is consumed by queued and historical user editors.
describe("semantic composer edits", () => {
	const existing: ExistingComposerAttachment[] = [
		{ kind: "image", imageId: "first-image", name: "same.png", size: 3, mimeType: "image/png" },
		{ kind: "image", imageId: "second-image", name: "same.png", size: 3, mimeType: "image/png" },
		{
			kind: "textFile",
			index: 0,
			filePath: "/saved/one",
			name: "same.txt",
			size: 1,
			mimeType: "text/plain",
		},
		{
			kind: "textFile",
			index: 1,
			filePath: "/saved/two",
			name: "same.txt",
			size: 1,
			mimeType: "text/plain",
		},
	];
	function mixed(): ComposerDocument {
		return {
			version: 1,
			assets: existing.map((resource, index) => ({
				id: `asset-${index}`,
				kind: resource.kind,
				name: resource.name,
				size: resource.size,
				mimeType: resource.mimeType,
			})),
			paragraphs: [
				{
					children: [
						{ type: "text", text: " start😀 " },
						{ type: "attachment", id: "node-file-two", assetId: "asset-3" },
						{ type: "quote", id: "quote", label: "Source", text: "quoted text" },
						{ type: "attachment", id: "node-image-two", assetId: "asset-1" },
						{ type: "text", text: " middle " },
						{ type: "attachment", id: "node-file-one", assetId: "asset-2" },
						{ type: "attachment", id: "node-image-one", assetId: "asset-0" },
						{ type: "text", text: " end " },
					],
				},
			],
		};
	}
	test("new record preserves interleaved occurrences but binds assets in server order", () => {
		const document = mixed();
		const session = seedComposerEditSession(
			{ text: "ignored legacy text", fileReferences: [], composerDocument: document },
			existing,
		);
		const snapshot = projectComposerEdit(session, session.document);
		expect(snapshot.composerDocument).toEqual(document);
		expect(snapshot.keepImageIds).toEqual(["first-image", "second-image"]);
		expect(snapshot.keepTextFiles).toEqual([
			{ index: 0, filename: "same.txt" },
			{ index: 1, filename: "same.txt" },
		]);
		expect(snapshot.keepTextFilePaths).toEqual(["/saved/one", "/saved/two"]);
		expect(snapshot.text).toContain(" start😀 ");
		expect(snapshot.text.endsWith(" end ")).toBe(true);
	});
	test("legacy import uses the old grouping, without inventing historical mixed positions", () => {
		const session = seedComposerEditSession({ text: "legacy body", fileReferences: [] }, existing);
		expect(session.document.paragraphs[0].children.map((node) => node.type)).toEqual([
			"attachment",
			"attachment",
			"attachment",
			"attachment",
		]);
		expect(session.document.paragraphs[1].children).toEqual([
			{ type: "text", text: "legacy body" },
		]);
	});
	test("removal emits explicit empty keep arrays; undo restores identities from retained bindings", () => {
		const session = seedComposerEditSession(
			{ text: "", fileReferences: [], composerDocument: mixed() },
			existing,
		);
		const removed: ComposerDocument = {
			...session.document,
			assets: [],
			paragraphs: [{ children: [{ type: "text", text: "still text" }] }],
		};
		const cleared = projectComposerEdit(session, removed);
		expect(cleared.keepImageIds).toEqual([]);
		expect(cleared.keepTextFiles).toEqual([]);
		expect(cleared.keepTextFilePaths).toEqual([]);
		expect(projectComposerEdit(session, session.document).keepImageIds).toEqual([
			"first-image",
			"second-image",
		]);
	});
	test("same-name new Files remain separate and reorder does not swap upload identity", () => {
		const session = seedComposerEditSession(
			{ text: "", fileReferences: [], composerDocument: mixed() },
			existing,
		);
		const files = [fakeFile("same.txt"), fakeFile("same.txt")];
		const added = bindComposerEditFiles(session, files, "textFile");
		expect(added.assets[0].id).not.toBe(added.assets[1].id);
		const edited: ComposerDocument = {
			...session.document,
			assets: [...[...added.assets].reverse(), ...session.document.assets],
			paragraphs: [
				{ children: [...[...added.nodes].reverse(), ...session.document.paragraphs[0].children] },
			],
		};
		const result = projectComposerEdit(session, edited);
		expect(result.newTextFiles).toEqual(files);
		expect(result.composerDocument.assets.map((asset) => asset.id)).toEqual([
			"asset-0",
			"asset-1",
			"asset-2",
			"asset-3",
			...added.assets.map((asset) => asset.id),
		]);
		expect(result.composerDocument.paragraphs).toEqual(edited.paragraphs);
	});
	test("missing resources, unknown versions and stale manifest counts fail closed", () => {
		const session = seedComposerEditSession(
			{ text: "", fileReferences: [], composerDocument: mixed() },
			existing,
		);
		session.bindings.delete("asset-0");
		expect(() => projectComposerEdit(session, session.document)).toThrow("missing");
		expect(() =>
			seedComposerEditSession(
				{ text: "", fileReferences: [], composerDocument: mixed() },
				existing.slice(1),
			),
		).toThrow("out of date");
		expect(() =>
			seedComposerEditSession(
				{
					text: "",
					fileReferences: [],
					composerDocument: { ...mixed(), version: 9 } as unknown as ComposerDocument,
				},
				existing,
			),
		).toThrow();
	});
});
