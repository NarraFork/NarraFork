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
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { narratorBufferedMessages, narrators } from "../../db/schema";

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
	cleanupBufferedTextFiles,
	enqueueBufferedMessage,
	projectMailboxUserMessage,
	releaseBufferedMessage,
	reorderBufferedMessages,
	dbClearAllBuffered,
	deleteBufferedTextFile,
	getBufferedMessages,
	persistAdditionalBufferedTextFiles,
	pushBufferedMessage,
	removeBufferedMessage,
	retryBufferedMessage,
	toBufferSummary,
	updateBufferedMessage,
} = await import("../narrator-buffer");
const { activeNarrators } = await import("../narrator-session-state");
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
for (const id of [NARRATOR_ID, SUBAGENT_ID]) {
	db.insert(narrators)
		.values({ id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
		.run();
}

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

	test("a subagent queue durably preserves same-named attachment contents", async () => {
		await pushSubagentBufferedMessage(SUBAGENT_ID, "queued", {
			textFiles: [textFile("dup.md", "aa"), textFile("dup.md", "bbbb")],
		});

		const [summary] = toBufferSummary(getSubagentBufferedMessages(SUBAGENT_ID));

		// Same filename twice: only the index tells them apart, which is why the
		// keep key is positional rather than name-based.
		expect(summary.textFiles).toEqual([
			{ index: 0, filename: "dup.md", size: 2 },
			{ index: 1, filename: expect.stringMatching(/^dup_.+\.md$/), size: 4 },
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

		const ok = await updateBufferedMessage(NARRATOR_ID, pushed.id, "after", {
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

		await updateBufferedMessage(NARRATOR_ID, pushed.id, "text only", { images: [] });

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
		await updateBufferedMessage(NARRATOR_ID, pushed.id, "after");

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

		await updateBufferedMessage(NARRATOR_ID, pushed.id, "one file", {
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

		expect(await updateBufferedMessage(NARRATOR_ID, "no-such-id", "edited")).toBe(false);
		expect(await updateBufferedMessage("no-such-narrator", "no-such-id", "edited")).toBe(false);
	});
});

describe("updateSubagentBufferedMessage — in-memory attachment overwrite", () => {
	test("replaces images and text files", async () => {
		const queued = await pushSubagentBufferedMessage(SUBAGENT_ID, "before", {
			images: [{ imageId: "old", filename: "old.png", mediaType: "image/png" }],
			textFiles: [textFile("old.md")],
		});

		const ok = await updateSubagentBufferedMessage(SUBAGENT_ID, queued.id, "after", {
			images: [{ imageId: "new", filename: "new.png", mediaType: "image/png" }],
			textFiles: [textFile("new.md")],
		});

		expect(ok).toBe(true);
		const [message] = getSubagentBufferedMessages(SUBAGENT_ID);
		expect(message.text).toBe("after");
		expect(message.images?.map((i) => i.imageId)).toEqual(["new"]);
		expect(message.textFiles?.map((f) => f.name)).toEqual(["new.md"]);
	});

	test("a text-only edit leaves attachments in place", async () => {
		const queued = await pushSubagentBufferedMessage(SUBAGENT_ID, "before", {
			images: [{ imageId: "keep", filename: "keep.png", mediaType: "image/png" }],
		});

		await updateSubagentBufferedMessage(SUBAGENT_ID, queued.id, "after");

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

describe("failed user recovery", () => {
	test("failed payload stays visible, explicit retry preserves identity and materializes once", async () => {
		const { createMailboxStore } = await import("../agent-runtime/mailbox");
		const { narratorMessages, narratorMessageRefs } = await import("../../db/schema");
		const store = createMailboxStore(db);
		const accepted = await enqueueBufferedMessage(NARRATOR_ID, "retry me");
		let oldClaim: Parameters<typeof store.failClaim>[0] | undefined;
		for (let attempt = 0; attempt < 5; attempt++) {
			const [row] = store.claimBatch(NARRATOR_ID, {
				token: `owner-${attempt}`,
				epoch: `epoch-${attempt}`,
			});
			const claim = projectMailboxUserMessage(row)._mailboxClaim;
			if (!claim) throw new Error("missing claim");
			oldClaim = claim;
			store.failClaim(claim, "attachment preparation failed");
		}
		expect(toBufferSummary(getBufferedMessages(NARRATOR_ID))[0]).toMatchObject({
			state: "failed",
			error: "attachment preparation failed",
			text: "retry me",
		});
		expect(store.claimBatch(NARRATOR_ID, { token: "blocked", epoch: "blocked" })).toHaveLength(0);
		expect(await updateBufferedMessage(NARRATOR_ID, accepted.id, "fixed")).toBe(true);
		expect(getBufferedMessages(NARRATOR_ID)[0].state).toBe("failed");
		expect(retryBufferedMessage(NARRATOR_ID, accepted.id)).toBe(true);
		expect(retryBufferedMessage(NARRATOR_ID, accepted.id)).toBe(false);
		const [row] = store.claimBatch(NARRATOR_ID, { token: "new-owner", epoch: "new-epoch" });
		const claim = projectMailboxUserMessage(row)._mailboxClaim;
		if (!claim || !oldClaim) throw new Error("missing claim");
		expect(() => store.failClaim(oldClaim, "stale")).toThrow();
		store.materialize(claim, (tx, current) => {
			const messageId = current.recipientMessageId as string;
			const refId = `failed-test-${messageId}`;
			tx.insert(narratorMessages)
				.values({
					id: messageId,
					narratorId: NARRATOR_ID,
					role: "user",
					contentText: current.text,
					contentJson: [{ type: "text", text: current.text }],
					createdAt: new Date().toISOString(),
				})
				.run();
			tx.insert(narratorMessageRefs)
				.values({ id: refId, narratorId: NARRATOR_ID, messageId, seq: 1 })
				.run();
			return { messageId, refId };
		});
		expect(getBufferedMessages(NARRATOR_ID)).toHaveLength(0);
		expect(store.getByDelivery(row.deliveryId as string)?.state).toBe("materialized");
		expect(store.claimBatch(NARRATOR_ID, { token: "again", epoch: "again" })).toHaveLength(0);
	});

	test("missing failed attachment cannot retry and cancel retains shared uploads", async () => {
		const { createMailboxStore } = await import("../agent-runtime/mailbox");
		const store = createMailboxStore(db);
		const image = await saveUploadedImage(NARRATOR_ID, pngFile("shared.png"));
		const pushed = await enqueueBufferedMessage(NARRATOR_ID, "missing", [image], null, null, null, [
			textFile("gone.md"),
		]);
		const message = getBufferedMessages(NARRATOR_ID)[0];
		for (let attempt = 0; attempt < 5; attempt++) {
			const [row] = store.claimBatch(NARRATOR_ID, { token: "owner", epoch: `missing-${attempt}` });
			const claim = projectMailboxUserMessage(row)._mailboxClaim;
			if (!claim) throw new Error("missing claim");
			store.failClaim(claim, "file missing");
		}
		const saved = message._savedFiles?.[0];
		if (!saved) throw new Error("missing saved file");
		rmSync(saved.path);
		expect(() => retryBufferedMessage(NARRATOR_ID, pushed.id)).toThrow("missing");
		expect(getBufferedMessages(NARRATOR_ID)[0].state).toBe("failed");
		expect(removeBufferedMessage(NARRATOR_ID, pushed.id)).toBe(true);
		expect(existsSync(getImagePath(NARRATOR_ID, image.imageId) as string)).toBe(true);
		expect(existsSync(join(HOME, "buffered-files", message._stagingId as string))).toBe(false);
	});
});

describe("persistent staging ownership", () => {
	test("manual mixed-priority reorder agrees with display, peek and claim", async () => {
		const { createMailboxStore } = await import("../agent-runtime/mailbox");
		const { peekInbox } = await import("../agent-runtime/inbox");
		const store = createMailboxStore(db);
		const normal = await enqueueBufferedMessage(NARRATOR_ID, "normal");
		const priority = await enqueueBufferedMessage(
			NARRATOR_ID,
			"priority",
			undefined,
			null,
			null,
			null,
			undefined,
			"front",
		);
		const later = await enqueueBufferedMessage(NARRATOR_ID, "later");
		expect(getBufferedMessages(NARRATOR_ID).map((row) => row.id)).toEqual([
			priority.id,
			normal.id,
			later.id,
		]);
		expect(peekInbox(NARRATOR_ID)?.id).toBe(priority.id);
		const desired = [normal.id, priority.id, later.id];
		expect(reorderBufferedMessages(NARRATOR_ID, desired)).toBe(true);
		expect(getBufferedMessages(NARRATOR_ID).map((row) => row.id)).toEqual(desired);
		expect(toBufferSummary(getBufferedMessages(NARRATOR_ID)).every((row) => !row.priority)).toBe(
			true,
		);
		for (const id of desired) {
			expect(peekInbox(NARRATOR_ID)?.id).toBe(id);
			const [claimed] = store.claimBatch(
				NARRATOR_ID,
				{ token: "sort", epoch: "sort" },
				{ count: 1 },
			);
			expect(claimed.id).toBe(id);
		}
	});
	test("back inputs retain global arrival order across task notices", async () => {
		const { createMailboxStore } = await import("../agent-runtime/mailbox");
		const store = createMailboxStore(db);
		const old = await enqueueBufferedMessage(NARRATOR_ID, "old");
		removeBufferedMessage(NARRATOR_ID, old.id);
		store.enqueue({
			narratorId: NARRATOR_ID,
			kind: "task_notice",
			noticeKind: "agent",
			sourceKey: "global-order",
			text: "notice",
			projectedByteSize: 6,
		});
		await enqueueBufferedMessage(NARRATOR_ID, "later user");
		const [row] = store.claimBatch(
			NARRATOR_ID,
			{ token: "global-order", epoch: "global-order" },
			{ count: 1 },
		);
		expect(row.kind).toBe("task_notice");
		expect(row.text).toBe("notice");
	});
	test("partial File preparation failure rolls back files and never enqueues", async () => {
		const root = join(HOME, "buffered-files");
		const before = existsSync(root) ? readdirSync(root).sort() : [];
		const tooLarge = textFile("too-large.md");
		Object.defineProperty(tooLarge, "size", { value: 101 * 1024 * 1024 });
		await expect(
			enqueueBufferedMessage(NARRATOR_ID, "failed", undefined, null, null, null, [
				textFile("first.md"),
				tooLarge,
			]),
		).rejects.toThrow("size limit");
		expect(getBufferedMessages(NARRATOR_ID)).toEqual([]);
		expect(readdirSync(root).sort()).toEqual(before);
	});

	test("clear cancels only pending user rows and preserves notice and tombstone", async () => {
		const { createMailboxStore } = await import("../agent-runtime/mailbox");
		const store = createMailboxStore(db);
		const notice = store.enqueue({
			narratorId: NARRATOR_ID,
			kind: "task_notice",
			noticeKind: "agent",
			sourceKey: "notice-clear",
			text: "completed",
			projectedByteSize: 9,
		});
		expect(notice.status).toBe("accepted");
		const removed = await enqueueBufferedMessage(NARRATOR_ID, "removed");
		removeBufferedMessage(NARRATOR_ID, removed.id);
		await enqueueBufferedMessage(NARRATOR_ID, "pending");
		dbClearAllBuffered(NARRATOR_ID);
		const rows = db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.narratorId, NARRATOR_ID))
			.all();
		expect(rows.find((row) => row.kind === "task_notice")?.state).toBe("queued");
		expect(rows.find((row) => row.id === removed.id)?.state).toBe("cancelled");
		expect(
			rows.filter((row) => row.kind === "user_input").every((row) => row.state === "cancelled"),
		).toBe(true);
	});
	test("row ids differ from staging ids and cancel removes the actual directory", async () => {
		const pushed = await enqueueBufferedMessage(NARRATOR_ID, "cold", undefined, null, null, null, [
			textFile("cold.md", "durable"),
		]);
		const [message] = getBufferedMessages(NARRATOR_ID);
		expect(message.id).toBe(pushed.id);
		expect(message._stagingId).not.toBe(message.id);
		const path = message._savedFiles?.[0].path as string;
		expect(await message.textFiles?.[0].text()).toBe("durable");
		cleanupBufferedTextFiles(message._stagingId as string);
		expect(existsSync(path)).toBe(true);
		expect(removeBufferedMessage(NARRATOR_ID, pushed.id)).toBe(true);
		expect(existsSync(path)).toBe(false);
		const row = db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.id, pushed.id))
			.get();
		expect(row?.state).toBe("cancelled");
	});

	test("claim leases survive UI clear and cleanup; failed delivery returns the same files", async () => {
		const { createMailboxStore } = await import("../agent-runtime/mailbox");
		const store = createMailboxStore(db);
		await enqueueBufferedMessage(NARRATOR_ID, "claimed", undefined, null, null, null, [
			textFile("lease.md", "leased"),
		]);
		const [row] = store.claimBatch(NARRATOR_ID, { token: "owner", epoch: "epoch-1" }, { count: 1 });
		const message = projectMailboxUserMessage(row);
		const saved = message._savedFiles?.[0] as NonNullable<typeof message._savedFiles>[number];
		dbClearAllBuffered(NARRATOR_ID);
		cleanupBufferedTextFiles(message._stagingId as string);
		deleteBufferedTextFile(saved);
		expect(existsSync(saved.path)).toBe(true);
		expect(removeBufferedMessage(NARRATOR_ID, row.id)).toBe(false);
		expect(getBufferedMessages(NARRATOR_ID)).toHaveLength(0);
		releaseBufferedMessage(message, "retry preparation");
		expect(getBufferedMessages(NARRATOR_ID)[0].id).toBe(row.id);
		expect(await getBufferedMessages(NARRATOR_ID)[0].textFiles?.[0].text()).toBe("leased");
		expect(removeBufferedMessage(NARRATOR_ID, row.id)).toBe(true);
		expect(existsSync(saved.path)).toBe(false);
	});

	test("large immutable references survive cold projection and async edits", async () => {
		const snapshot = {
			type: "file_reference" as const,
			reference: { id: "ref", deviceId: "local", path: "/saved.ts", label: "saved.ts" },
			snapshotText: "x".repeat(32 * 1024),
			snapshotHash: "hash",
			capturedAt: new Date().toISOString(),
		};
		const pushed = await enqueueBufferedMessage(
			NARRATOR_ID,
			"reference",
			undefined,
			null,
			null,
			null,
			undefined,
			"back",
			null,
			[snapshot],
		);
		const row = db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.id, pushed.id))
			.get();
		expect(row?.fileReferencesJson).toBeNull();
		expect(JSON.parse(row?.metadataJson ?? "{}").fileReferencesPath).toBeString();
		expect(getBufferedMessages(NARRATOR_ID)[0].fileReferences?.[0].snapshotText).toBe(
			snapshot.snapshotText,
		);
		const body = "b".repeat(300 * 1024);
		expect(
			await updateBufferedMessage(NARRATOR_ID, pushed.id, body, { fileReferences: [snapshot] }),
		).toBe(true);
		expect(getBufferedMessages(NARRATOR_ID)[0].text).toBe(body);
		expect(getBufferedMessages(NARRATOR_ID)[0].fileReferences?.[0].snapshotText).toBe(
			snapshot.snapshotText,
		);
		const staging = getBufferedMessages(NARRATOR_ID)[0]._stagingId as string;
		removeBufferedMessage(NARRATOR_ID, pushed.id);
		expect(existsSync(join(HOME, "buffered-files", staging))).toBe(false);
	});

	test("long command and pre-prompt Bash survive the bounded row envelope", async () => {
		const command = `/new ${"x".repeat(100_000)}`;
		const bash = `echo ${"y".repeat(400_000)}`;
		const pushed = await enqueueBufferedMessage(
			NARRATOR_ID,
			"display",
			undefined,
			command,
			null,
			null,
			undefined,
			"back",
			bash,
		);
		const row = db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.id, pushed.id))
			.get();
		expect(row?.commandText).toBeNull();
		expect(row?.bashCommand).toBeNull();
		expect(getBufferedMessages(NARRATOR_ID)[0].commandText).toBe(command);
		expect(getBufferedMessages(NARRATOR_ID)[0].bashCommand).toBe(bash);
		await updateBufferedMessage(NARRATOR_ID, pushed.id, "edited display");
		expect(getBufferedMessages(NARRATOR_ID)[0].commandText).toBe(command);
		expect(getBufferedMessages(NARRATOR_ID)[0].bashCommand).toBe(bash);
		removeBufferedMessage(NARRATOR_ID, pushed.id);
	});

	test("legacy rows initialize on removal and preserve saved files on cold read", async () => {
		const id = "legacy-buffer-row";
		const { persistBufferedTextFiles } = await import("../narrator-buffer");
		const files = await persistBufferedTextFiles(id, [textFile("old.md", "legacy")]);
		db.insert(narratorBufferedMessages)
			.values({
				id,
				narratorId: NARRATOR_ID,
				text: "old",
				seq: 0,
				bufferedAt: new Date().toISOString(),
				textFilePathsJson: JSON.stringify(files),
			})
			.run();
		expect(await getBufferedMessages(NARRATOR_ID)[0].textFiles?.[0].text()).toBe("legacy");
		expect(removeBufferedMessage(NARRATOR_ID, id)).toBe(true);
		expect(existsSync(files[0].path)).toBe(false);
	});

	test("primary front is LIFO while subagent priority remains FIFO", async () => {
		for (const [id, frontOrder] of [
			[NARRATOR_ID, "stack"],
			[SUBAGENT_ID, "fifo"],
		] as const) {
			await enqueueBufferedMessage(id, "ordinary");
			await enqueueBufferedMessage(
				id,
				"first",
				undefined,
				null,
				null,
				null,
				undefined,
				"front",
				null,
				undefined,
				frontOrder,
			);
			await enqueueBufferedMessage(
				id,
				"second",
				undefined,
				null,
				null,
				null,
				undefined,
				"front",
				null,
				undefined,
				frontOrder,
			);
			const expected =
				frontOrder === "fifo" ? ["first", "second", "ordinary"] : ["second", "first", "ordinary"];
			expect(getBufferedMessages(id).map((message) => message.text)).toEqual(expected);
			const { createMailboxStore } = await import("../agent-runtime/mailbox");
			const [claimed] = createMailboxStore(db).claimBatch(
				id,
				{ token: "priority-owner", epoch: "priority-epoch" },
				{ count: 1 },
			);
			expect(claimed.text).toBe(expected[0]);
		}
	});

	test("reorder rejects duplicate identities without changing durable order", async () => {
		const a = await enqueueBufferedMessage(NARRATOR_ID, "a");
		const b = await enqueueBufferedMessage(NARRATOR_ID, "b");
		expect(reorderBufferedMessages(NARRATOR_ID, [a.id, a.id])).toBe(false);
		expect(getBufferedMessages(NARRATOR_ID).map((m) => m.id)).toEqual([a.id, b.id]);
		expect(reorderBufferedMessages(NARRATOR_ID, [b.id, a.id])).toBe(true);
		expect(getBufferedMessages(NARRATOR_ID).map((m) => m.id)).toEqual([b.id, a.id]);
	});
});

describe("unrelated files are untouched", () => {
	test("deleteBufferedTextFile refuses a non-mailbox path", () => {
		const dir = mkdtempSync(join(HOME, "single-"));
		const target = join(dir, "target.md");
		const neighbour = join(dir, "neighbour.md");
		writeFileSync(target, "a");
		writeFileSync(neighbour, "b");

		deleteBufferedTextFile({ filename: "target.md", path: target, size: 1 });

		expect(existsSync(target)).toBe(true);
		expect(existsSync(neighbour)).toBe(true);
	});
});
