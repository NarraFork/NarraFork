/**
 * chat-attachments tests — the disk layer's safety properties.
 *
 * Four things are load-bearing here, and each is a distinct failure if it breaks:
 *
 *  1. **Images fail closed.** A file declaring a supported image type whose bytes
 *     disagree must be rejected, because a stored one is later served back to other
 *     room members under an image content type.
 *  2. **An `image/*` type the pipeline cannot parse is stored as a FILE, not
 *     rejected.** A prefix-based image test would make an SVG unattachable.
 *  3. **Nothing escapes the room directory.** Room ids and stored names both reach
 *     path construction, so traversal is refused rather than normalized away.
 *  4. **The worktree copy does not overwrite.** Forwarding a `README.md` must not
 *     clobber one the narrator was already given.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	copyChatAttachmentToWorktree,
	deleteChatRoomAttachments,
	getChatAttachmentFileInfo,
	getChatAttachmentPath,
	isChatImageUpload,
	listStoredChatAttachmentNames,
	saveChatAttachment,
	setChatAttachmentsDirForTests,
} from "../chat-attachments";

let root: string;
let worktree: string;

/**
 * Smallest byte sequence that passes PNG magic-byte + IHDR dimension parsing.
 *
 * Synthesized rather than using a fixed base64 blob so the DIMENSIONS can vary:
 * these tests assert that the parsed width/height reach the stored row, which a
 * single 1×1 fixture could not distinguish from a hardcoded default.
 *
 * Built over an explicit `ArrayBuffer` because that is what `BlobPart` requires —
 * `Buffer.alloc` types its backing store as `ArrayBufferLike`, which includes
 * `SharedArrayBuffer` and so is not assignable to a `File` constructor argument.
 */
function pngBytes(width = 4, height = 3): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(new ArrayBuffer(24));
	bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
	const view = new DataView(bytes.buffer);
	view.setUint32(16, width, false);
	view.setUint32(20, height, false);
	return bytes;
}

/** `BlobPart`-safe byte literal (see the note on `pngBytes`). */
function bytes(values: number[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(new ArrayBuffer(values.length));
	out.set(values);
	return out;
}

const pngFile = (name = "shot.png", w = 4, h = 3) =>
	new File([pngBytes(w, h)], name, { type: "image/png" });

beforeEach(() => {
	root = mkdtempSync(resolve(tmpdir(), "nf-chat-att-"));
	worktree = mkdtempSync(resolve(tmpdir(), "nf-chat-wt-"));
	setChatAttachmentsDirForTests(root);
});

afterEach(() => {
	setChatAttachmentsDirForTests(null);
	rmSync(root, { recursive: true, force: true });
	rmSync(worktree, { recursive: true, force: true });
});

describe("image handling", () => {
	test("a real PNG is stored with parsed dimensions and a sniffed media type", async () => {
		const saved = await saveChatAttachment("room1", pngFile("a.png", 16, 9));
		expect(saved.kind).toBe("image");
		expect(saved.width).toBe(16);
		expect(saved.height).toBe(9);
		expect(saved.mediaType).toBe("image/png");
		expect(existsSync(saved.filePath)).toBe(true);
	});

	test("a declared PNG whose bytes are not a PNG is refused and leaves nothing behind", async () => {
		await expect(
			saveChatAttachment(
				"room1",
				new File([bytes([9, 8, 7, 6, 5, 4, 3, 2])], "lie.png", { type: "image/png" }),
			),
		).rejects.toThrow();
		// Validation runs before any write, so a rejected upload cannot consume storage.
		expect(listStoredChatAttachmentNames("room1")).toEqual([]);
	});

	test("an image/* type the pipeline cannot parse becomes an opaque file", async () => {
		// A prefix-based test would send this into image validation and reject it,
		// leaving the user unable to attach an SVG at all.
		expect(isChatImageUpload(new File([""], "x.svg", { type: "image/svg+xml" }))).toBe(false);
		const saved = await saveChatAttachment(
			"room1",
			new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }),
		);
		expect(saved.kind).toBe("file");
		// Must not keep the image media type: serving it as one would let it execute in
		// the app's origin.
		expect(saved.mediaType).not.toStartWith("image/");
	});

	test("the supported set is recognised by media type, not by extension", () => {
		expect(isChatImageUpload(pngFile())).toBe(true);
		expect(isChatImageUpload(new File([""], "a.png", { type: "text/plain" }))).toBe(false);
	});
});

describe("file handling", () => {
	test("a text file is stored as an opaque download", async () => {
		const saved = await saveChatAttachment(
			"room1",
			new File(["hi"], "n.md", { type: "text/plain" }),
		);
		expect(saved.kind).toBe("file");
		expect(saved.width).toBeUndefined();
		expect(await Bun.file(saved.filePath).text()).toBe("hi");
	});

	test("a declared image type on a non-image is neutralized", async () => {
		// The stored label is what gets served back, so a lingering `image/` type would
		// invite the browser to render the file.
		const saved = await saveChatAttachment(
			"room1",
			new File(["not an image"], "weird.txt", { type: "image/tiff" }),
		);
		expect(saved.mediaType).toBe("application/octet-stream");
	});

	test("an absurd declared type is replaced rather than stored", async () => {
		const saved = await saveChatAttachment(
			"room1",
			new File(["x"], "a.txt", { type: "z".repeat(500) }),
		);
		expect(saved.mediaType).toBe("application/octet-stream");
	});
});

describe("path safety", () => {
	test("two uploads of the same filename get distinct stored names", async () => {
		const first = await saveChatAttachment("room1", new File(["1"], "same.md"));
		const second = await saveChatAttachment("room1", new File(["2"], "same.md"));
		// The stored name is generated, never derived from user input, so collisions are
		// impossible by construction.
		expect(first.storedName).not.toBe(second.storedName);
		expect(await Bun.file(first.filePath).text()).toBe("1");
		expect(await Bun.file(second.filePath).text()).toBe("2");
	});

	test("a traversal room id is refused", async () => {
		await expect(saveChatAttachment("../escape", pngFile())).rejects.toThrow();
		expect(getChatAttachmentPath("../escape", "x.png")).toBeNull();
	});

	test("an empty room id is refused", async () => {
		await expect(saveChatAttachment("", pngFile())).rejects.toThrow();
	});

	test("a traversal stored name resolves to null instead of escaping", async () => {
		const outside = resolve(root, "..", "secret.txt");
		writeFileSync(outside, "secret");
		try {
			// `storedName` comes from the DB, but a corrupted row must not be able to
			// reach outside the room directory.
			expect(getChatAttachmentPath("room1", "../secret.txt")).toBeNull();
		} finally {
			rmSync(outside, { force: true });
		}
	});

	test("a missing file reports null rather than a broken path", () => {
		expect(getChatAttachmentPath("room1", "nope.png")).toBeNull();
		expect(getChatAttachmentFileInfo("room1", "nope.png")).toBeNull();
	});

	test("a directory is not mistaken for an attachment", () => {
		mkdirSync(resolve(root, "room1", "adir"), { recursive: true });
		expect(getChatAttachmentPath("room1", "adir")).toBeNull();
	});
});

describe("room cleanup", () => {
	test("deleting a room removes its whole directory", async () => {
		const saved = await saveChatAttachment("room1", pngFile());
		deleteChatRoomAttachments("room1");
		expect(existsSync(saved.filePath)).toBe(false);
		expect(listStoredChatAttachmentNames("room1")).toEqual([]);
	});

	test("listing an unknown room is empty, not an error", () => {
		expect(listStoredChatAttachmentNames("never-existed")).toEqual([]);
	});
});

describe("worktree copy", () => {
	test("copies into .narrafork/attached with the original filename", async () => {
		const saved = await saveChatAttachment("room1", new File(["body"], "notes.md"));
		const ref = await copyChatAttachmentToWorktree(worktree, {
			roomId: "room1",
			storedName: saved.storedName,
			filename: "notes.md",
			sizeBytes: saved.sizeBytes,
		});
		expect(ref.filePath).toBe(resolve(worktree, ".narrafork", "attached", "notes.md"));
		expect(await Bun.file(ref.filePath).text()).toBe("body");
		// The source stays put: the chat copy is what history refers to.
		expect(existsSync(saved.filePath)).toBe(true);
	});

	test("a name already present is suffixed, never overwritten", async () => {
		const dir = resolve(worktree, ".narrafork", "attached");
		mkdirSync(dir, { recursive: true });
		writeFileSync(resolve(dir, "README.md"), "the narrator's own file");

		const saved = await saveChatAttachment("room1", new File(["from chat"], "README.md"));
		const ref = await copyChatAttachmentToWorktree(worktree, {
			roomId: "room1",
			storedName: saved.storedName,
			filename: "README.md",
			sizeBytes: saved.sizeBytes,
		});
		expect(ref.filePath).not.toBe(resolve(dir, "README.md"));
		expect(await Bun.file(resolve(dir, "README.md")).text()).toBe("the narrator's own file");
		expect(await Bun.file(ref.filePath).text()).toBe("from chat");
	});

	test("a missing source file is a clear failure, not an empty copy", async () => {
		await expect(
			copyChatAttachmentToWorktree(worktree, {
				roomId: "room1",
				storedName: "gone.png",
				filename: "gone.png",
				sizeBytes: 10,
			}),
		).rejects.toThrow();
	});

	test("a path-like filename cannot escape the attachment directory", async () => {
		const saved = await saveChatAttachment("room1", new File(["x"], "ok.txt"));
		const ref = await copyChatAttachmentToWorktree(worktree, {
			roomId: "room1",
			storedName: saved.storedName,
			// The filename is user-controlled, so it must be sanitized on the way out.
			filename: "../../escaped.txt",
			sizeBytes: saved.sizeBytes,
		});
		const attachedDir = resolve(worktree, ".narrafork", "attached");
		expect(ref.filePath.startsWith(attachedDir)).toBe(true);
		expect(existsSync(resolve(worktree, "..", "escaped.txt"))).toBe(false);
	});
});
