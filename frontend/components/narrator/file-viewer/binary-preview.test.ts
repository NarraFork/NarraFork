import { describe, expect, test } from "bun:test";
import { getFilePreviewType, MAX_FILE_PREVIEW_BLOB_BYTES } from "../file-panel/FilePreviewModal";
import { readBinaryPreview } from "./FileViewerContent";

describe("panel binary previews", () => {
	test("recognizes images and PDF without changing text handling", () => {
		for (const ext of ["png", "JPG", "gif", "webp", "svg", "avif", "bmp", "ico"]) {
			expect(getFilePreviewType(`/work/image.${ext}`)).toBe("image");
		}
		expect(getFilePreviewType("C:\\work\\report.PDF")).toBe("pdf");
		expect(getFilePreviewType("/work/code.ts")).toBe("text");
	});

	test("preserves binary bytes and content type", async () => {
		const bytes = new Uint8Array([0, 255, 137, 80, 78, 71]);
		const blob = await readBinaryPreview(
			new Response(bytes, {
				headers: { "content-type": "image/png" },
			}),
		);
		expect(blob.type).toBe("image/png");
		expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
	});

	test("rejects and cancels oversized declared payloads", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				cancel() {
					cancelled = true;
				},
			}),
			{ headers: { "content-length": String(MAX_FILE_PREVIEW_BLOB_BYTES + 1) } },
		);
		await expect(readBinaryPreview(response)).rejects.toThrow("Preview too large");
		expect(cancelled).toBe(true);
	});

	test("caps streams even without a content length", async () => {
		let cancelled = false;
		const response = new Response(
			new ReadableStream({
				pull(controller) {
					controller.enqueue(new Uint8Array(1024 * 1024));
				},
				cancel() {
					cancelled = true;
				},
			}),
		);
		await expect(readBinaryPreview(response)).rejects.toThrow("Preview too large");
		expect(cancelled).toBe(true);
	});
});
