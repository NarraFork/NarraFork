/**
 * Rules behind editing a queued message's attachments.
 *
 * Two of these pin behaviour that used to be wrong in ways the user could see:
 * a queued message with only images was uneditable because an empty textarea
 * blocked submission, and text files were addressed by name even though a
 * taken-over subagent's queue can hold two files with the same name.
 */

import { describe, expect, test } from "bun:test";
import type { BufferMessageSummary } from "../../lib/api/types";
import {
	buildQueuedEditPayload,
	canSubmitQueuedEdit,
	MAX_QUEUED_IMAGES,
	MAX_QUEUED_TEXT_FILES,
	type QueuedEditAttachmentState,
	queuedEditTouchesAttachments,
	remainingImageRoom,
	remainingTextFileRoom,
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
		...overrides,
	};
}

function fakeFile(name: string): File {
	return new File(["x"], name, { type: "text/plain" });
}

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
