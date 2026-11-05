import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMediaContentBlock, mediaRefToContentBlock } from "@shared/media-attachments";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { wavBytes, wavFile, webmBytes } from "../../../tests/fixtures/native-media";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";
import { getMediaPath, saveUploadedMedia } from "../../lib/media-uploads";

// In-memory DB from real migrations (mirrors tests/setup.ts).
const DRIZZLE_DIR = join(import.meta.dir, "..", "..", "..", "drizzle");
const sqlite = new Database(":memory:");
sqlite.run("PRAGMA foreign_keys = OFF");
for (const file of readdirSync(DRIZZLE_DIR)
	.filter((f) => f.endsWith(".sql"))
	.sort()) {
	const sql = readFileSync(join(DRIZZLE_DIR, file), "utf-8");
	for (const stmt of sql
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter(Boolean)) {
		try {
			sqlite.run(stmt);
		} catch (err) {
			if (!String(err).includes("already exists")) throw err;
		}
	}
}
sqlite.run("PRAGMA foreign_keys = ON");
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const {
	closeNarrator,
	editAndRegenerate,
	imageRefToContentBlock,
	resolveRequestedAttachmentKeys,
	interruptAndWaitForIdle,
} = await import("../narrator-session");
const { getImagePath, saveUploadedImage, setUploadsDirForTests } = await import(
	"../../lib/uploads"
);
const { narratorMessages, narratorMessageRefs, narrators } = schema;
afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});
afterEach(async () => {
	closeNarrator("n1");
	closeNarrator("n2");
	// Reseeding these IDs must wait for their complete admitted finalizers.
	expect(await interruptAndWaitForIdle("n1", { timeoutMs: 5_000 })).toBe(true);
	expect(await interruptAndWaitForIdle("n2", { timeoutMs: 5_000 })).toBe(true);
	setUploadsDirForTests(null);
});
const now = new Date().toISOString();

type Block = Record<string, unknown>;

function seed(cwd: string, blocks: Block[]) {
	db.insert(schema.users)
		.values({
			id: "attachment-user",
			username: "attachment-user",
			role: "user",
			passwordHash: "test",
			createdAt: now,
		})
		.onConflictDoNothing()
		.run();
	sqlite.run("DELETE FROM narrator_message_refs");
	sqlite.run("DELETE FROM narrator_messages");
	sqlite.run("DELETE FROM narrators");
	db.insert(narrators)
		.values({
			id: "n1",
			type: "primary",
			variant: "primary",
			inheritMode: "fresh",
			cwd,
			status: "idle",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narratorMessages)
		.values({
			id: "m1",
			narratorId: "n1",
			role: "user",
			contentJson: blocks,
			contentText: "old",
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: "ref-m1", narratorId: "n1", messageId: "m1", seq: 0, isCompact: 0 })
		.run();
}

function createPngFile(name: string, width: number, height: number): File {
	const bytes = new Uint8Array(24);
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12);
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width);
	view.setUint32(20, height);
	return new File([bytes], name, { type: "image/png" });
}

async function runEdit(opts: Parameters<typeof editAndRegenerate>[5]) {
	// editAndRegenerate persists the rebuilt contentJson before the (failing in
	// this bare harness) agent loop runs, so we can inspect the persisted result.
	try {
		await editAndRegenerate("n1", "m1", "new", "en", false, {
			userId: "attachment-user",
			revertFiles: false,
			...opts,
		});
	} catch {
		/* expected: agent loop cannot run without a real provider */
	}
	const msg = await db.query.narratorMessages.findFirst({ where: eq(narratorMessages.id, "m1") });
	return (msg?.contentJson as Block[]) ?? [];
}

test("history editing persists semantic layout and legacy editing clears stale layout", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "nf-rich-edit-"));
	seed(cwd, [{ type: "text", text: "old" }]);
	const document = {
		version: 1 as const,
		paragraphs: [{ children: [{ type: "text" as const, text: "new" }] }],
		assets: [],
	};
	await editAndRegenerate("n1", "m1", "new", "en", false, {
		userId: "attachment-user",
		revertFiles: false,
		composerDocument: document,
		deferContinuation: true,
	});
	const read = () => db.query.narratorMessages.findFirst({ where: eq(narratorMessages.id, "m1") });
	expect((await read())?.composerDocument).toEqual(document);
	await editAndRegenerate("n1", "m1", "legacy", "en", false, {
		revertFiles: false,
		deferContinuation: true,
	});
	expect((await read())?.composerDocument).toBeNull();
	await expect(
		editAndRegenerate("n1", "m1", "mismatch", "en", false, {
			composerDocument: document,
			deferContinuation: true,
		}),
	).rejects.toThrow("does not match");
});

describe("resolveRequestedAttachmentKeys", () => {
	test("returns the unique intersection in target attachment order", () => {
		expect(resolveRequestedAttachmentKeys(["a", "b", "a"], ["ghost", "a", "a"])).toEqual(["a"]);
	});
});

describe("user image metadata", () => {
	test("converts uploads ImageRef dimensions into the canonical content block", () => {
		expect(
			imageRefToContentBlock({
				imageId: "img-1",
				filename: "photo.png",
				mediaType: "image/png",
				width: 640,
				height: 480,
				uploadNarratorId: "owner-1",
			}),
		).toEqual({
			type: "image",
			imageId: "img-1",
			filename: "photo.png",
			mediaType: "image/png",
			width: 640,
			height: 480,
			uploadNarratorId: "owner-1",
		});
	});
});

describe("editAndRegenerate native media history", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "nf-edit-media-"));
		setUploadsDirForTests(join(cwd, "uploads"));
	});
	afterEach(() => rmSync(cwd, { recursive: true, force: true }));
	// These attachment edits intentionally leave workspace files untouched, just
	// like the existing text-file harness. Real restores still require a confirmed
	// plan and authenticated requester in the product service.
	const editOptions = {
		userId: "attachment-user",
		revertFiles: false,
		deferContinuation: true,
	} as const;
	async function blocks(): Promise<unknown[]> {
		const content = (
			await db.query.narratorMessages.findFirst({ where: eq(narratorMessages.id, "m1") })
		)?.contentJson;
		return Array.isArray(content) ? content : [];
	}
	test("wording-only edits preserve native media ownership and explicit [] removes only refs", async () => {
		const ref = await saveUploadedMedia("n1", wavFile());
		seed(cwd, [{ ...mediaRefToContentBlock(ref) }, { type: "text", text: "before" }]);
		expect(await editAndRegenerate("n1", "m1", "after", "en", false, editOptions)).toMatchObject({
			ok: true,
		});
		expect((await blocks()).filter(isMediaContentBlock)).toEqual([mediaRefToContentBlock(ref)]);
		expect(
			await editAndRegenerate("n1", "m1", "without", "en", false, {
				...editOptions,
				keepMediaIds: [],
			}),
		).toMatchObject({ ok: true });
		expect((await blocks()).filter(isMediaContentBlock)).toEqual([]);
		expect(getMediaPath("n1", ref.mediaId)).not.toBeNull();
	});
	test("media-only appended edit persists canonical content without starting a model", async () => {
		seed(cwd, [{ type: "text", text: "before" }]);
		expect(
			await editAndRegenerate("n1", "m1", "", "en", false, {
				...editOptions,
				newMedia: [wavFile()],
			}),
		).toMatchObject({ ok: true });
		const media = (await blocks()).filter(isMediaContentBlock);
		expect(media).toHaveLength(1);
		expect(media[0]).toMatchObject({
			type: "audio",
			mediaType: "audio/wav",
			uploadNarratorId: "n1",
			size: 60,
		});
	});
	test("history edits allow ten retained plus new media and reject eleven without touching shared bytes", async () => {
		const original = await saveUploadedMedia("n1", wavFile("original.wav"));
		seed(cwd, [{ ...mediaRefToContentBlock(original) }]);
		await editAndRegenerate("n1", "m1", "", "en", false, {
			...editOptions,
			newMedia: Array.from({ length: 9 }, (_, index) => wavFile(`added-${index}.wav`)),
		});
		const before = await blocks();
		expect(before.filter(isMediaContentBlock)).toHaveLength(10);
		const saved = readdirSync(join(cwd, "uploads", "n1", "media"));
		await expect(
			editAndRegenerate("n1", "m1", "", "en", false, {
				...editOptions,
				newMedia: [wavFile("eleventh.wav")],
			}),
		).rejects.toThrow("Maximum 10");
		expect(await blocks()).toEqual(before);
		expect(readdirSync(join(cwd, "uploads", "n1", "media"))).toEqual(saved);
		expect(getMediaPath("n1", original.mediaId)).not.toBeNull();
	});
	test.each([
		["audio", () => wavFile()],
		[
			"video",
			() => new File([new Uint8Array(webmBytes([1]))], "clip.webm", { type: "video/webm" }),
		],
	] as const)("retained %s bytes count toward the final limit and removed media frees the budget", async (_, file) => {
		const original = await saveUploadedMedia("n1", file());
		const originalPath = getMediaPath("n1", original.mediaId);
		if (!originalPath) throw new Error("Missing original media");
		// Sparse retained bytes deliberately disagree with the persisted size.
		truncateSync(originalPath, 100 * 1024 * 1024);
		seed(cwd, [{ ...mediaRefToContentBlock(original) }, { type: "text", text: "before" }]);
		const before = await blocks();
		const mediaDir = join(cwd, "uploads", "n1", "media");
		const saved = readdirSync(mediaDir);
		const bytes = Buffer.alloc(29 * 1024 * 1024);
		wavBytes().copy(bytes);
		bytes.writeUInt32LE(bytes.length - 8, 4);
		bytes.writeUInt32LE(bytes.length - 44, 40);
		const added = new File([bytes], "added.wav", { type: "audio/wav" });
		await expect(
			editAndRegenerate("n1", "m1", "after", "en", false, {
				...editOptions,
				newMedia: [added],
			}),
		).rejects.toThrow("Combined attachments exceed the 128 MiB limit");
		expect(await blocks()).toEqual(before);
		expect(readdirSync(mediaDir)).toEqual(saved);
		expect(
			await editAndRegenerate("n1", "m1", "after", "en", false, {
				...editOptions,
				keepMediaIds: [],
				newMedia: [added],
			}),
		).toMatchObject({ ok: true });
		expect((await blocks()).filter(isMediaContentBlock)).toMatchObject([
			{ filename: "added.wav", size: added.size, uploadNarratorId: "n1" },
		]);
		expect(Bun.file(originalPath).size).toBe(100 * 1024 * 1024);
	});
	test("shared history counts each source owner and media ID once, not once per reference", async () => {
		const original = await saveUploadedMedia("n1", wavFile());
		const originalPath = getMediaPath("n1", original.mediaId);
		if (!originalPath) throw new Error("Missing original media");
		truncateSync(originalPath, 64 * 1024 * 1024);
		const block = mediaRefToContentBlock(original);
		const { uploadNarratorId: _, ...legacyBlock } = block;
		seed(cwd, [{ ...legacyBlock }, { ...block }]);
		db.insert(narrators)
			.values({ id: "n2", cwd, status: "idle", createdAt: now, updatedAt: now })
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: "ref-n2-m1", narratorId: "n2", messageId: "m1", seq: 0, isCompact: 0 })
			.run();
		expect(
			await editAndRegenerate("n2", "m1", "after", "en", false, {
				...editOptions,
				newMedia: [wavFile("added.wav")],
			}),
		).toMatchObject({ ok: true });
		const childRef = await db.query.narratorMessageRefs.findFirst({
			where: eq(narratorMessageRefs.narratorId, "n2"),
		});
		const childMessage = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, childRef?.messageId ?? ""),
		});
		expect((childMessage?.contentJson as unknown[]).filter(isMediaContentBlock)).toMatchObject([
			{ mediaId: original.mediaId, uploadNarratorId: "n1" },
			{ filename: "added.wav", uploadNarratorId: "n2" },
		]);

		// Identical IDs in different owners are different stored attachments.
		const otherPath = join(cwd, "uploads", "n2", "media", `${original.mediaId}.wav`);
		writeFileSync(otherPath, wavBytes());
		truncateSync(otherPath, 65 * 1024 * 1024);
		seed(cwd, [{ ...block }, { ...block, uploadNarratorId: "n2" }]);
		await expect(editAndRegenerate("n1", "m1", "after", "en", false, editOptions)).rejects.toThrow(
			"Combined attachments exceed the 128 MiB limit",
		);
	});
	test("a large retained text file does not consume the inline media budget", async () => {
		// Text files reach the model as paths, media as inline base64. A retained
		// 200 MiB text attachment must not push a small new media file over the
		// 128 MiB inline budget, though both still count toward the 2 GiB total.
		const textPath = join(cwd, "big.log");
		writeFileSync(textPath, "");
		truncateSync(textPath, 200 * 1024 * 1024);
		seed(cwd, [
			{
				type: "text_file",
				fileId: "big",
				filename: "big.log",
				size: 200 * 1024 * 1024,
				filePath: textPath,
			},
			{ type: "text", text: "before" },
		]);
		expect(
			await editAndRegenerate("n1", "m1", "after", "en", false, {
				...editOptions,
				keepTextFilePaths: [textPath],
				newMedia: [wavFile("added.wav")],
			}),
		).toMatchObject({ ok: true });
		expect((await blocks()).filter(isMediaContentBlock)).toMatchObject([{ filename: "added.wav" }]);
	});
	test("retained images and media still share the 128 MiB inline budget", async () => {
		// The counterpart of the test above: splitting the budgets must not let
		// inline attachments escape the 128 MiB limit. Both are sparse-truncated to
		// stay cheap; the check reads stat sizes before anything is copied.
		const media = await saveUploadedMedia("n1", wavFile());
		const mediaPath = getMediaPath("n1", media.mediaId);
		if (!mediaPath) throw new Error("Missing media");
		truncateSync(mediaPath, 70 * 1024 * 1024);
		const image = await saveUploadedImage("n1", createPngFile("kept.png", 1, 1));
		const imagePath = getImagePath("n1", image.imageId);
		if (!imagePath) throw new Error("Missing image");
		truncateSync(imagePath, 70 * 1024 * 1024);
		seed(cwd, [
			{ ...mediaRefToContentBlock(media) },
			{ type: "image", imageId: image.imageId, filename: "kept.png", mediaType: "image/png" },
			{ type: "text", text: "before" },
		]);
		const before = await blocks();
		await expect(editAndRegenerate("n1", "m1", "after", "en", false, editOptions)).rejects.toThrow(
			"Combined attachments exceed the 128 MiB limit",
		);
		expect(await blocks()).toEqual(before);
	});
	test("a later attachment write failure rolls back newly uploaded media and keeps old history", async () => {
		seed(cwd, [{ type: "text", text: "before" }]);
		const failing = new File(["text"], "fail.txt", { type: "text/plain" });
		// Text attachments are written with `Bun.write(path, file)` (streamed, never
		// `arrayBuffer()`), so the failure is injected at that write.
		const realWrite = Bun.write;
		const write = spyOn(Bun, "write").mockImplementation(async (...args) => {
			if (args[1] === failing) throw new Error("media rollback");
			return Reflect.apply(realWrite, Bun, args) as ReturnType<typeof Bun.write>;
		});
		try {
			await expect(
				editAndRegenerate("n1", "m1", "after", "en", false, {
					...editOptions,
					newMedia: [wavFile()],
					newTextFiles: [failing],
				}),
			).rejects.toThrow("media rollback");
		} finally {
			write.mockRestore();
		}
		expect(readdirSync(join(cwd, "uploads", "n1", "media"))).toEqual([]);
		expect(await blocks()).toEqual([{ type: "text", text: "before" }]);
	});
});

describe("editAndRegenerate text_file management", () => {
	let cwd: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "nf-edit-"));
	});

	test("keeps all text files when keepTextFilePaths is undefined (backward compatible)", async () => {
		seed(cwd, [
			{ type: "text_file", filename: "a.md", size: 1, filePath: "/x/.narrafork/attached/a.md" },
			{ type: "text", text: "old" },
		]);
		const blocks = await runEdit({ userId: "attachment-user" });
		expect(blocks.filter((b) => b.type === "text_file")).toHaveLength(1);
	});

	test("drops text files not in keepTextFilePaths", async () => {
		const firstPath = join(cwd, "a.md");
		const secondPath = join(cwd, "b.md");
		writeFileSync(firstPath, "a");
		writeFileSync(secondPath, "bb");
		seed(cwd, [
			{ type: "text_file", filename: "a.md", size: 1, filePath: firstPath },
			{ type: "text_file", filename: "b.md", size: 2, filePath: secondPath },
			{ type: "text", text: "old" },
		]);
		const blocks = await runEdit({ keepTextFilePaths: [firstPath], userId: "attachment-user" });
		const files = blocks.filter((b) => b.type === "text_file");
		expect(files).toHaveLength(1);
		expect(files[0].filePath).toBe(firstPath);
	});

	test("preserves legacy fileId on kept blocks", async () => {
		seed(cwd, [
			{ type: "text_file", fileId: "F1", filename: "a.js", size: 3, filePath: "n1/text/F1.js" },
			{ type: "text", text: "old" },
		]);
		const blocks = await runEdit({
			keepTextFilePaths: ["n1/text/F1.js"],
			userId: "attachment-user",
			revertFiles: false,
		});
		const file = blocks.find((b) => b.type === "text_file");
		expect(file?.fileId).toBe("F1");
	});

	test("appends newly uploaded text files (saved into the worktree)", async () => {
		seed(cwd, [{ type: "text", text: "old" }]);
		const newFile = new File(["hello world"], "fresh.md", { type: "text/markdown" });
		const blocks = await runEdit({
			keepTextFilePaths: [],
			newTextFiles: [newFile],
			userId: "attachment-user",
			revertFiles: false,
		});
		const files = blocks.filter((b) => b.type === "text_file");
		expect(files).toHaveLength(1);
		expect(files[0].filename).toBe("fresh.md");
		expect(String(files[0].filePath).replaceAll("\\", "/")).toContain(".narrafork/attached");
		expect(readFileSync(String(files[0].filePath), "utf-8")).toBe("hello world");
	});

	test("preserves dimensions on retained image blocks", async () => {
		const uploadsRoot = mkdtempSync(join(tmpdir(), "nf-edit-retained-image-"));
		const imageDir = join(uploadsRoot, "n1");
		mkdirSync(imageDir, { recursive: true });
		writeFileSync(join(imageDir, "existing.png"), new Uint8Array([1]));
		setUploadsDirForTests(uploadsRoot);
		seed(cwd, [
			{
				type: "image",
				imageId: "existing",
				filename: "existing.png",
				mediaType: "image/png",
				width: 320,
				height: 240,
				uploadNarratorId: "n1",
			},
			{ type: "text", text: "old" },
		]);
		const blocks = await runEdit({ keepImageIds: ["existing"], userId: "attachment-user" });
		expect(blocks.find((block) => block.type === "image")).toMatchObject({
			imageId: "existing",
			width: 320,
			height: 240,
			uploadNarratorId: "n1",
		});
	});

	test("stores uploaded image dimensions in edited contentJson", async () => {
		const uploadsRoot = mkdtempSync(join(tmpdir(), "nf-edit-image-dimensions-"));
		setUploadsDirForTests(uploadsRoot);
		seed(cwd, [{ type: "text", text: "old" }]);
		const blocks = await runEdit({
			keepImageIds: [],
			newImages: [createPngFile("fresh.png", 640, 480)],
			userId: "attachment-user",
			revertFiles: false,
		});
		const image = blocks.find((block) => block.type === "image");
		expect(image).toMatchObject({
			filename: "fresh.png",
			mediaType: "image/png",
			width: 640,
			height: 480,
			uploadNarratorId: "n1",
		});
	});

	test("rejects the final attachment count before writing files", async () => {
		seed(cwd, [
			{ type: "text_file", fileId: "A", filename: "a.md", size: 1, filePath: "legacy/a" },
			{ type: "text_file", fileId: "B", filename: "b.md", size: 1, filePath: "legacy/b" },
			{ type: "text", text: "old" },
		]);
		const newTextFiles = Array.from(
			{ length: 9 },
			(_, index) => new File([String(index)], `new-${index}.txt`, { type: "text/plain" }),
		);
		await expect(
			editAndRegenerate("n1", "m1", "new", "en", false, {
				userId: "attachment-user",
				revertFiles: false,
				keepTextFilePaths: ["legacy/a", "legacy/b"],
				newTextFiles,
			}),
		).rejects.toThrow("Maximum 10 text files");
		expect(existsSync(join(cwd, ".narrafork"))).toBe(false);
	});

	test("cleans images and earlier text files when a later write fails", async () => {
		const uploadsRoot = mkdtempSync(join(tmpdir(), "nf-edit-uploads-"));
		setUploadsDirForTests(uploadsRoot);
		seed(cwd, [{ type: "text", text: "old" }]);
		const image = createPngFile("new.png", 1, 1);
		const firstText = new File(["created"], "created.txt", { type: "text/plain" });
		const failingText = new File(["fail"], "fail.txt", { type: "text/plain" });
		const realWrite = Bun.write;
		let earlierWriteCompleted = false;
		let failingWriteEntered = false;
		const write = spyOn(Bun, "write").mockImplementation(async (...args) => {
			if (args[1] === failingText) {
				failingWriteEntered = true;
				expect(earlierWriteCompleted).toBe(true);
				throw new Error("synthetic write failure");
			}
			const result = await (Reflect.apply(realWrite, Bun, args) as ReturnType<typeof Bun.write>);
			if (args[1] === firstText) {
				if (typeof args[0] !== "string") throw new Error("Expected attachment path");
				expect(readFileSync(args[0], "utf8")).toBe("created");
				earlierWriteCompleted = true;
			}
			return result;
		});
		try {
			await expect(
				editAndRegenerate("n1", "m1", "new", "en", false, {
					userId: "attachment-user",
					revertFiles: false,
					keepImageIds: [],
					keepTextFilePaths: [],
					newImages: [image],
					newTextFiles: [firstText, failingText],
				}),
			).rejects.toThrow("synthetic write failure");
			expect(failingWriteEntered).toBe(true);
			const imageDir = join(uploadsRoot, "n1");
			expect(existsSync(imageDir) ? readdirSync(imageDir) : []).toHaveLength(0);
			const attachedDir = join(cwd, ".narrafork", "attached");
			expect(existsSync(attachedDir) ? readdirSync(attachedDir) : []).toHaveLength(0);
		} finally {
			write.mockRestore();
		}
	});

	test("serializes concurrent edits before materializing the second upload", async () => {
		seed(cwd, [{ type: "text", text: "old" }]);
		let releaseFirst!: () => void;
		let markFirstEntered!: () => void;
		let markSecondEntered!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const firstEntered = new Promise<void>((resolve) => {
			markFirstEntered = resolve;
		});
		const secondEntered = new Promise<void>((resolve) => {
			markSecondEntered = resolve;
		});
		const firstFile = new File(["first"], "first.txt", { type: "text/plain" });
		const secondFile = new File(["second"], "second.txt", { type: "text/plain" });
		const realWrite = Bun.write;
		const writes: string[] = [];
		const write = spyOn(Bun, "write").mockImplementation(async (...args) => {
			if (args[1] === firstFile) {
				writes.push("first entered");
				markFirstEntered();
				await firstGate;
			}
			if (args[1] === secondFile) {
				writes.push("second entered");
				markSecondEntered();
			}
			const result = await (Reflect.apply(realWrite, Bun, args) as ReturnType<typeof Bun.write>);
			if (args[1] === firstFile || args[1] === secondFile) {
				const text = args[1] === firstFile ? "first" : "second";
				if (typeof args[0] !== "string") throw new Error("Expected attachment path");
				expect(readFileSync(args[0], "utf8")).toBe(text);
				writes.push(`${text} written`);
			}
			return result;
		});
		const pending: Promise<unknown>[] = [];
		try {
			// Keep regeneration out of this lock test: a running first turn would
			// reject the second edit before it ever reaches attachment materialization.
			const firstEdit = editAndRegenerate("n1", "m1", "first edit", "en", false, {
				userId: "attachment-user",
				deferContinuation: true,
				revertFiles: false,
				keepTextFilePaths: [],
				newTextFiles: [firstFile],
			});
			pending.push(firstEdit);
			await firstEntered;
			const secondEdit = editAndRegenerate("n1", "m1", "second edit", "en", false, {
				userId: "attachment-user",
				deferContinuation: true,
				revertFiles: false,
				keepTextFilePaths: [],
				newTextFiles: [secondFile],
			});
			pending.push(secondEdit);
			const secondStartedBeforeRelease = await Promise.race([
				secondEntered.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
			]);
			expect(secondStartedBeforeRelease).toBe(false);
			expect(writes).toEqual(["first entered"]);
			releaseFirst();
			const results = await Promise.allSettled(pending);
			expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
			expect(writes).toEqual([
				"first entered",
				"first written",
				"second entered",
				"second written",
			]);
		} finally {
			releaseFirst();
			await Promise.allSettled(pending);
			write.mockRestore();
		}
	});

	test("copies a shared modern text attachment into the editing narrator cwd", async () => {
		const parentCwd = mkdtempSync(join(tmpdir(), "nf-edit-parent-"));
		const childCwd = mkdtempSync(join(tmpdir(), "nf-edit-child-"));
		const sourcePath = join(parentCwd, "shared.txt");
		writeFileSync(sourcePath, "shared content");
		seed(parentCwd, [
			{ type: "text_file", filename: "shared.txt", size: 14, filePath: sourcePath },
			{ type: "text", text: "old" },
		]);
		db.insert(narrators)
			.values({
				id: "n2",
				type: "primary",
				variant: "primary",
				inheritMode: "full",
				cwd: childCwd,
				status: "idle",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: "ref-n2-m1", narratorId: "n2", messageId: "m1", seq: 0, isCompact: 0 })
			.run();

		const result = await editAndRegenerate("n2", "m1", "new", "en", false, {
			userId: "attachment-user",
			revertFiles: false,
			keepTextFilePaths: [sourcePath],
		});
		expect(result.ok).toBe(true);
		const childRef = await db.query.narratorMessageRefs.findFirst({
			where: eq(narratorMessageRefs.narratorId, "n2"),
		});
		const childMessage = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, childRef?.messageId ?? ""),
		});
		const copied = (childMessage?.contentJson as Block[]).find(
			(block) => block.type === "text_file",
		);
		expect(String(copied?.filePath)).toContain(join(childCwd, ".narrafork", "attached"));
		expect(readFileSync(String(copied?.filePath), "utf8")).toBe("shared content");
	});

	test("counts copied source bytes against the 2 GiB materialization limit", async () => {
		const parentCwd = mkdtempSync(join(tmpdir(), "nf-edit-large-parent-"));
		const childCwd = mkdtempSync(join(tmpdir(), "nf-edit-large-child-"));
		const sourcePath = join(parentCwd, "large.bin");
		writeFileSync(sourcePath, "");
		// Sparse on purpose: the ceiling is checked from the recorded sizes BEFORE
		// anything is copied, so the test must not pay 2 GiB of real writes.
		truncateSync(sourcePath, 2 * 1024 * 1024 * 1024 + 1);
		seed(childCwd, [
			{
				type: "text_file",
				filename: "large.bin",
				size: 2 * 1024 * 1024 * 1024 + 1,
				filePath: sourcePath,
			},
			{ type: "text", text: "old" },
		]);
		await expect(
			editAndRegenerate("n1", "m1", "new", "en", false, {
				userId: "attachment-user",
				revertFiles: false,
				keepTextFilePaths: [sourcePath],
			}),
		).rejects.toThrow("attachments exceed the 2 GiB limit");
		expect(existsSync(join(childCwd, ".narrafork"))).toBe(false);
	});
});
