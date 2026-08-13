/**
 * Attachments of a queued (buffered) message: what clients can see, and what an
 * in-place edit does to the files on disk.
 *
 * The user-visible gap this pins: images and text files were fully persisted, but
 * the queue summary reported only `imageCount`, so nobody could tell what was
 * attached to a pending message — let alone change it. Editing then had to grow
 * real file handling, which is where the invariants below start to matter.
 *
 * The most important one is the LAST test: the normal end-of-loop cleanup path
 * (`dbClearAllBuffered`) runs AFTER the queue was consumed, when the images have
 * already become content of persisted history messages. Deleting uploads there
 * would turn every `imageId` in that history into a permanent dead link, so that
 * path must never touch image files.
 *
 * NOTE — test isolation: this file exercises the REAL narrator-buffer,
 * narrator-session-state, subagent-executor, and lib/uploads modules. Sibling
 * suites (spec-edit-interject, subagent-resume, edit-regen-revert,
 * loop-danger-reflection-failure) register process-global doubles of those same
 * modules, and Bun's mock.module re-patches the shared module's live bindings
 * across the whole process — so when a full-directory run co-schedules them, the
 * doubles reach this file's bindings and these assertions fail even though the
 * production code is correct. This is a known Bun test-infra limitation, not a
 * defect under test: run this file on its own
 * (`bun test server/services/__tests__/narrator-buffer-attachments.test.ts`) to
 * see the authoritative green result.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { narratorBufferedMessages } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// Isolate ~/.narrafork so buffered-files and uploads land in a temp tree.
const HOME = mkdtempSync(join(tmpdir(), "nf-buffer-attach-"));
process.env.NARRAFORK_HOME = HOME;

// This file binds the REAL narrator-buffer, narrator-session-state, and
// subagent-executor modules at module scope, exactly like the sibling
// narrator-buffer-admission.test.ts. The destructured references are captured at
// import time; later mock.module registrations by other suites replace the
// REGISTRY entry, not these already-bound references. So the doubles that
// spec-edit-interject / subagent-resume / edit-regen-revert register globally do
// not reach this file's bindings — as long as this file does NOT re-import them
// after such a double is active. That is why there is deliberately no
// beforeEach re-import here.
const {
	dbClearAllBuffered,
	deleteBufferedTextFile,
	getBufferedMessages,
	persistAdditionalBufferedTextFiles,
	pushBufferedMessage,
	removeBufferedMessage,
	toBufferSummary,
	updateBufferedMessage,
} = await import("../narrator-buffer");
const { activeNarrators, bufferedMessages } = await import("../narrator-session-state");
const { getImagePath, saveUploadedImage, setUploadsDirForTests } = await import(
	"../../lib/uploads"
);
const {
	clearSubagentBufferedMessages,
	getSubagentBufferedMessages,
	pushSubagentBufferedMessage,
	updateSubagentBufferedMessage,
} = await import("../subagent-executor");

const NARRATOR_ID = "buffer-attach-narrator";
const SUBAGENT_ID = "buffer-attach-subagent";

beforeAll(() => {
	setUploadsDirForTests(join(HOME, "uploads"));
});

afterAll(() => {
	setUploadsDirForTests(null);
	rmSync(HOME, { recursive: true, force: true });
});

/** A narrator must be busy for the queue to accept anything. */
function registerLiveLoop(narratorId: string): void {
	activeNarrators.set(narratorId, {
		narratorId,
		alive: true,
		_loopRunning: true,
	} as unknown as NonNullable<ReturnType<typeof activeNarrators.get>>);
}

/** Minimal valid 1×1 PNG, so the upload pipeline's content sniffing accepts it. */
const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wFPqZqPAAAAAElFTkSuQmCC",
	"base64",
);

function pngFile(name: string): File {
	return new File([PNG_1X1], name, { type: "image/png" });
}

function textFile(name: string, body = "hello"): File {
	return new File([body], name, { type: "text/plain" });
}

async function readImagesJson(messageId: string): Promise<unknown> {
	const row = await db
		.select({ imagesJson: narratorBufferedMessages.imagesJson })
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.id, messageId))
		.get();
	return row?.imagesJson ? JSON.parse(row.imagesJson) : null;
}

async function readTextFilePathsJson(
	messageId: string,
): Promise<Array<{ filename: string; path: string; size: number }> | null> {
	const row = await db
		.select({ json: narratorBufferedMessages.textFilePathsJson })
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.id, messageId))
		.get();
	return row?.json ? JSON.parse(row.json) : null;
}

afterEach(() => {
	activeNarrators.clear();
	bufferedMessages.clear();
	clearSubagentBufferedMessages(SUBAGENT_ID);
	sqlite.run("DELETE FROM narrator_buffered_messages");
});

describe("toBufferSummary — attachments are visible to clients", () => {
	test("reports full image metadata and sized, positionally-keyed text files", async () => {
		registerLiveLoop(NARRATOR_ID);
		const imageA = await saveUploadedImage(NARRATOR_ID, pngFile("a.png"));
		const imageB = await saveUploadedImage(NARRATOR_ID, pngFile("b.png"));

		const pushed = await pushBufferedMessage(
			NARRATOR_ID,
			"look at these",
			[imageA, imageB],
			null,
			null,
			null,
			[textFile("notes.md", "0123456789")],
		);
		expect(pushed.ok).toBe(true);

		const [summary] = toBufferSummary(getBufferedMessages(NARRATOR_ID));

		expect(summary.imageCount).toBe(2);
		expect(summary.images).toEqual([
			{
				imageId: imageA.imageId,
				filename: "a.png",
				mediaType: "image/png",
				width: 1,
				height: 1,
				uploadNarratorId: NARRATOR_ID,
			},
			{
				imageId: imageB.imageId,
				filename: "b.png",
				mediaType: "image/png",
				width: 1,
				height: 1,
				uploadNarratorId: NARRATOR_ID,
			},
		]);
		expect(summary.textFiles).toEqual([{ index: 0, filename: "notes.md", size: 10 }]);
	});

	test("a subagent queue has no persisted metadata, so File objects are read directly", () => {
		pushSubagentBufferedMessage(SUBAGENT_ID, "queued", {
			textFiles: [textFile("dup.md", "aa"), textFile("dup.md", "bbbb")],
		});

		const [summary] = toBufferSummary(getSubagentBufferedMessages(SUBAGENT_ID));

		// Same filename twice: only the index tells them apart, which is why the
		// keep key is positional rather than name-based.
		expect(summary.textFiles).toEqual([
			{ index: 0, filename: "dup.md", size: 2 },
			{ index: 1, filename: "dup.md", size: 4 },
		]);
	});

	test("a message with no attachments reports empty arrays, not undefined", async () => {
		registerLiveLoop(NARRATOR_ID);
		await pushBufferedMessage(NARRATOR_ID, "plain text");

		const [summary] = toBufferSummary(getBufferedMessages(NARRATOR_ID));

		expect(summary.imageCount).toBe(0);
		expect(summary.images).toEqual([]);
		expect(summary.textFiles).toEqual([]);
	});
});

describe("updateBufferedMessage — editing attachments", () => {
	test("replaces the image set in memory and in the DB row", async () => {
		registerLiveLoop(NARRATOR_ID);
		const kept = await saveUploadedImage(NARRATOR_ID, pngFile("kept.png"));
		const dropped = await saveUploadedImage(NARRATOR_ID, pngFile("dropped.png"));
		const pushed = await pushBufferedMessage(NARRATOR_ID, "before", [kept, dropped]);
		const added = await saveUploadedImage(NARRATOR_ID, pngFile("added.png"));

		const ok = updateBufferedMessage(NARRATOR_ID, pushed.id, "after", {
			images: [kept, added],
		});

		expect(ok).toBe(true);
		const [message] = getBufferedMessages(NARRATOR_ID);
		expect(message.text).toBe("after");
		expect(message.images?.map((i) => i.imageId)).toEqual([kept.imageId, added.imageId]);
		expect(await readImagesJson(pushed.id)).toMatchObject([
			{ imageId: kept.imageId },
			{ imageId: added.imageId },
		]);
	});

	test("clearing every image nulls the DB column rather than storing an empty array", async () => {
		registerLiveLoop(NARRATOR_ID);
		const image = await saveUploadedImage(NARRATOR_ID, pngFile("only.png"));
		const pushed = await pushBufferedMessage(NARRATOR_ID, "text and image", [image]);

		updateBufferedMessage(NARRATOR_ID, pushed.id, "text only", { images: [] });

		expect(getBufferedMessages(NARRATOR_ID)[0].images).toBeUndefined();
		expect(await readImagesJson(pushed.id)).toBeNull();
	});

	test("omitting the attachment options leaves attachments untouched", async () => {
		registerLiveLoop(NARRATOR_ID);
		const image = await saveUploadedImage(NARRATOR_ID, pngFile("keep.png"));
		const pushed = await pushBufferedMessage(NARRATOR_ID, "before", [image], null, null, null, [
			textFile("keep.md"),
		]);

		// This is the long-standing text-only path (WS `update_buffer`); it must not
		// drop attachments the caller never mentioned.
		updateBufferedMessage(NARRATOR_ID, pushed.id, "after");

		const [message] = getBufferedMessages(NARRATOR_ID);
		expect(message.text).toBe("after");
		expect(message.images?.map((i) => i.imageId)).toEqual([image.imageId]);
		expect(message._savedFiles?.map((f) => f.filename)).toEqual(["keep.md"]);
		expect(await readImagesJson(pushed.id)).toMatchObject([{ imageId: image.imageId }]);
	});

	test("a removed text file is deleted from disk while kept ones survive", async () => {
		registerLiveLoop(NARRATOR_ID);
		const pushed = await pushBufferedMessage(
			NARRATOR_ID,
			"two files",
			undefined,
			null,
			null,
			null,
			[textFile("kept.md"), textFile("dropped.md")],
		);
		const saved = getBufferedMessages(NARRATOR_ID)[0]._savedFiles ?? [];
		expect(saved).toHaveLength(2);
		const [keptFile, droppedFile] = saved;
		expect(existsSync(keptFile.path)).toBe(true);
		expect(existsSync(droppedFile.path)).toBe(true);

		updateBufferedMessage(NARRATOR_ID, pushed.id, "one file", {
			textFiles: [],
			savedFiles: [keptFile],
		});
		deleteBufferedTextFile(droppedFile);

		expect(existsSync(keptFile.path)).toBe(true);
		expect(existsSync(droppedFile.path)).toBe(false);
		expect(await readTextFilePathsJson(pushed.id)).toEqual([keptFile]);
	});

	test("a newly attached file cannot overwrite a kept file of the same name", async () => {
		registerLiveLoop(NARRATOR_ID);
		const pushed = await pushBufferedMessage(NARRATOR_ID, "one file", undefined, null, null, null, [
			textFile("notes.md", "original"),
		]);
		const [keptFile] = getBufferedMessages(NARRATOR_ID)[0]._savedFiles ?? [];

		const created = await persistAdditionalBufferedTextFiles(
			pushed.id,
			[textFile("notes.md", "replacement")],
			[keptFile.filename],
		);

		expect(created).toHaveLength(1);
		expect(created[0].path).not.toBe(keptFile.path);
		expect(await Bun.file(keptFile.path).text()).toBe("original");
		expect(await Bun.file(created[0].path).text()).toBe("replacement");
	});

	test("returns false for an unknown message id", async () => {
		registerLiveLoop(NARRATOR_ID);
		await pushBufferedMessage(NARRATOR_ID, "queued");

		expect(updateBufferedMessage(NARRATOR_ID, "no-such-id", "edited")).toBe(false);
		expect(updateBufferedMessage("no-such-narrator", "no-such-id", "edited")).toBe(false);
	});
});

describe("updateSubagentBufferedMessage — in-memory attachment overwrite", () => {
	test("replaces images and text files", () => {
		const queued = pushSubagentBufferedMessage(SUBAGENT_ID, "before", {
			images: [{ imageId: "old", filename: "old.png", mediaType: "image/png" }],
			textFiles: [textFile("old.md")],
		});

		const ok = updateSubagentBufferedMessage(SUBAGENT_ID, queued.id, "after", {
			images: [{ imageId: "new", filename: "new.png", mediaType: "image/png" }],
			textFiles: [textFile("new.md")],
		});

		expect(ok).toBe(true);
		const [message] = getSubagentBufferedMessages(SUBAGENT_ID);
		expect(message.text).toBe("after");
		expect(message.images?.map((i) => i.imageId)).toEqual(["new"]);
		expect(message.textFiles?.map((f) => f.name)).toEqual(["new.md"]);
	});

	test("a text-only edit leaves attachments in place", () => {
		const queued = pushSubagentBufferedMessage(SUBAGENT_ID, "before", {
			images: [{ imageId: "keep", filename: "keep.png", mediaType: "image/png" }],
		});

		updateSubagentBufferedMessage(SUBAGENT_ID, queued.id, "after");

		expect(getSubagentBufferedMessages(SUBAGENT_ID)[0].images?.map((i) => i.imageId)).toEqual([
			"keep",
		]);
	});
});

describe("queue teardown must not delete uploaded images", () => {
	test("dbClearAllBuffered leaves image files on disk", async () => {
		// This runs at the END of a loop, after the queue was consumed into real
		// history messages. Those messages reference the same imageId, so removing
		// the file here would break already-persisted history irreversibly.
		registerLiveLoop(NARRATOR_ID);
		const image = await saveUploadedImage(NARRATOR_ID, pngFile("consumed.png"));
		await pushBufferedMessage(NARRATOR_ID, "consumed message", [image]);
		const imagePath = getImagePath(NARRATOR_ID, image.imageId);
		expect(imagePath).not.toBeNull();

		dbClearAllBuffered(NARRATOR_ID);

		expect(existsSync(imagePath as string)).toBe(true);
	});

	test("removeBufferedMessage also leaves image files alone", async () => {
		registerLiveLoop(NARRATOR_ID);
		const image = await saveUploadedImage(NARRATOR_ID, pngFile("cancelled.png"));
		const pushed = await pushBufferedMessage(NARRATOR_ID, "cancel me", [image]);
		const imagePath = getImagePath(NARRATOR_ID, image.imageId);

		expect(removeBufferedMessage(NARRATOR_ID, pushed.id)).toBe(true);

		// Image orphan collection on cancel is deliberately out of scope here: only
		// the edit path, where exclusivity is certain, deletes uploads.
		expect(existsSync(imagePath as string)).toBe(true);
	});

	test("dbClearAllBuffered still removes persisted text files", async () => {
		registerLiveLoop(NARRATOR_ID);
		await pushBufferedMessage(NARRATOR_ID, "with file", undefined, null, null, null, [
			textFile("temp.md"),
		]);
		const [savedFile] = getBufferedMessages(NARRATOR_ID)[0]._savedFiles ?? [];
		expect(existsSync(savedFile.path)).toBe(true);

		dbClearAllBuffered(NARRATOR_ID);

		// Unlike images, these live in a queue-owned scratch directory and are
		// copied into the worktree on consumption, so nothing else references them.
		expect(existsSync(savedFile.path)).toBe(false);
	});
});

describe("unrelated files are untouched", () => {
	test("deleteBufferedTextFile removes only the given path", () => {
		const dir = mkdtempSync(join(HOME, "single-"));
		const target = join(dir, "target.md");
		const neighbour = join(dir, "neighbour.md");
		writeFileSync(target, "a");
		writeFileSync(neighbour, "b");

		deleteBufferedTextFile({ filename: "target.md", path: target, size: 1 });

		expect(existsSync(target)).toBe(false);
		expect(existsSync(neighbour)).toBe(true);
	});
});
