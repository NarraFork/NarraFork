import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";

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
const { setUploadsDirForTests } = await import("../../lib/uploads");
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
	sqlite.run("DELETE FROM narrator_message_refs");
	sqlite.run("DELETE FROM narrator_messages");
	sqlite.run("DELETE FROM narrators");
	db.insert(narrators)
		.values({
			id: "n1",
			chapterId: null,
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
		await editAndRegenerate("n1", "m1", "new", "en", false, opts);
	} catch {
		/* expected: agent loop cannot run without a real provider */
	}
	const msg = await db.query.narratorMessages.findFirst({ where: eq(narratorMessages.id, "m1") });
	return (msg?.contentJson as Block[]) ?? [];
}

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
		const blocks = await runEdit({ userId: null });
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
		const blocks = await runEdit({ keepTextFilePaths: [firstPath], userId: null });
		const files = blocks.filter((b) => b.type === "text_file");
		expect(files).toHaveLength(1);
		expect(files[0].filePath).toBe(firstPath);
	});

	test("preserves legacy fileId on kept blocks", async () => {
		seed(cwd, [
			{ type: "text_file", fileId: "F1", filename: "a.js", size: 3, filePath: "n1/text/F1.js" },
			{ type: "text", text: "old" },
		]);
		const blocks = await runEdit({ keepTextFilePaths: ["n1/text/F1.js"], userId: null });
		const file = blocks.find((b) => b.type === "text_file");
		expect(file?.fileId).toBe("F1");
	});

	test("appends newly uploaded text files (saved into the worktree)", async () => {
		seed(cwd, [{ type: "text", text: "old" }]);
		const newFile = new File(["hello world"], "fresh.md", { type: "text/markdown" });
		const blocks = await runEdit({
			keepTextFilePaths: [],
			newTextFiles: [newFile],
			userId: null,
		});
		const files = blocks.filter((b) => b.type === "text_file");
		expect(files).toHaveLength(1);
		expect(files[0].filename).toBe("fresh.md");
		expect(String(files[0].filePath)).toContain(".narrafork/attached");
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
		const blocks = await runEdit({ keepImageIds: ["existing"], userId: null });
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
			userId: null,
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
		Object.defineProperty(failingText, "arrayBuffer", {
			value: async () => {
				throw new Error("synthetic write failure");
			},
		});

		await expect(
			editAndRegenerate("n1", "m1", "new", "en", false, {
				keepImageIds: [],
				keepTextFilePaths: [],
				newImages: [image],
				newTextFiles: [firstText, failingText],
			}),
		).rejects.toThrow("synthetic write failure");
		const imageDir = join(uploadsRoot, "n1");
		expect(existsSync(imageDir) ? readdirSync(imageDir) : []).toHaveLength(0);
		const attachedDir = join(cwd, ".narrafork", "attached");
		expect(existsSync(attachedDir) ? readdirSync(attachedDir) : []).toHaveLength(0);
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
		Object.defineProperty(firstFile, "arrayBuffer", {
			value: async () => {
				markFirstEntered();
				await firstGate;
				return new TextEncoder().encode("first").buffer;
			},
		});
		const secondFile = new File(["second"], "second.txt", { type: "text/plain" });
		Object.defineProperty(secondFile, "arrayBuffer", {
			value: async () => {
				markSecondEntered();
				return new TextEncoder().encode("second").buffer;
			},
		});

		const firstEdit = editAndRegenerate("n1", "m1", "first edit", "en", false, {
			keepTextFilePaths: [],
			newTextFiles: [firstFile],
		});
		await firstEntered;
		const secondEdit = editAndRegenerate("n1", "m1", "second edit", "en", false, {
			keepTextFilePaths: [],
			newTextFiles: [secondFile],
		});
		const secondStartedBeforeRelease = await Promise.race([
			secondEntered.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
		]);
		releaseFirst();
		await Promise.allSettled([firstEdit, secondEdit]);

		expect(secondStartedBeforeRelease).toBe(false);
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
				chapterId: null,
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

	test("counts copied source bytes against the 128 MiB materialization limit", async () => {
		const parentCwd = mkdtempSync(join(tmpdir(), "nf-edit-large-parent-"));
		const childCwd = mkdtempSync(join(tmpdir(), "nf-edit-large-child-"));
		const sourcePath = join(parentCwd, "large.bin");
		writeFileSync(sourcePath, "");
		truncateSync(sourcePath, 129 * 1024 * 1024);
		seed(childCwd, [
			{ type: "text_file", filename: "large.bin", size: 1, filePath: sourcePath },
			{ type: "text", text: "old" },
		]);
		await expect(
			editAndRegenerate("n1", "m1", "new", "en", false, {
				keepTextFilePaths: [sourcePath],
			}),
		).rejects.toThrow("attachments exceed the 128 MiB limit");
		expect(existsSync(join(childCwd, ".narrafork"))).toBe(false);
	});
});
