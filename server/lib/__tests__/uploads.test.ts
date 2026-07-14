import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	contentJsonHasImageBlocks,
	getUploadedImageInfo,
	getUploadsDir,
	saveUploadedImage,
	setUploadsDirForTests,
} from "../uploads";

afterEach(() => {
	setUploadsDirForTests(null);
});

describe("uploads helpers", () => {
	test("getUploadsDir uses the default path without a test override", () => {
		expect(getUploadsDir()).toBe(resolve(homedir(), ".narrafork", "uploads"));
	});

	test("getUploadsDir uses the test override when provided", () => {
		const testDir = resolve("/tmp", "narrafork-uploads-test");
		setUploadsDirForTests(testDir);
		expect(getUploadsDir()).toBe(testDir);
	});

	test("saveUploadedImage records the narrator that owns the file", async () => {
		const testDir = mkdtempSync(resolve(tmpdir(), "narrafork-uploads-owner-"));
		try {
			setUploadsDirForTests(testDir);
			const file = new File([new Uint8Array([1, 2, 3, 4])], "shot.png", {
				type: "image/png",
			});
			const ref = await saveUploadedImage("source-narrator", file);
			expect(ref.uploadNarratorId).toBe("source-narrator");
			expect(getUploadedImageInfo("source-narrator", ref.imageId)?.size).toBe(4);
			expect(getUploadedImageInfo("other-narrator", ref.imageId)).toBeNull();
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("contentJsonHasImageBlocks detects persisted image blocks", () => {
		expect(
			contentJsonHasImageBlocks([
				{ type: "text", text: "hello" },
				{ type: "image", imageId: "img_123", filename: "shot.png", mediaType: "image/png" },
			]),
		).toBe(true);
		expect(contentJsonHasImageBlocks([{ type: "text", text: "hello" }])).toBe(false);
		expect(contentJsonHasImageBlocks(null)).toBe(false);
	});
});
