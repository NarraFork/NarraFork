import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { contentJsonHasImageBlocks, getUploadsDir, setUploadsDirForTests } from "../uploads";

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
