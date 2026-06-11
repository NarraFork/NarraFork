import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	cleanupPartialImageGenerationResults,
	decodeStandardBase64Image,
	imageGenerationArtifactPath,
	readPngImageDimensions,
	sanitizeImageGenerationPathPart,
} from "../image-generation";

const SAMPLE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

describe("image generation artifacts", () => {
	test("sanitizes session and image ids in artifact paths", () => {
		expect(sanitizeImageGenerationPathPart("../ig/..")).toBe("___ig___");
		expect(sanitizeImageGenerationPathPart("")).toBe("generated_image");
		expect(imageGenerationArtifactPath("session/../1", "../ig/..")).toContain(
			"session____1/___ig___.png",
		);
	});

	test("strictly decodes standard base64 payloads", () => {
		expect(decodeStandardBase64Image("Zm9v").toString()).toBe("foo");
		expect(() => decodeStandardBase64Image("data:image/png;base64,Zm9v")).toThrow();
		expect(() => decodeStandardBase64Image("_-8")).toThrow();
		expect(() => decodeStandardBase64Image("Zm9v=")).toThrow();
	});

	test("reads PNG dimensions from IHDR", () => {
		const bytes = Buffer.from(SAMPLE_PNG_BASE64, "base64");
		expect(readPngImageDimensions(bytes)).toEqual({ width: 1, height: 1 });
		expect(readPngImageDimensions(Buffer.from("not a png"))).toBeUndefined();
	});

	test("cleans up only partial artifacts for an image generation", async () => {
		const sessionId = `cleanup-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const imageId = "img_cleanup";
		const finalPath = imageGenerationArtifactPath(sessionId, imageId);
		const partialZeroPath = imageGenerationArtifactPath(sessionId, `${imageId}_partial_0`);
		const partialOnePath = imageGenerationArtifactPath(sessionId, `${imageId}_partial_1`);
		const sessionDir = dirname(finalPath);

		try {
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(finalPath, Buffer.from(SAMPLE_PNG_BASE64, "base64"));
			writeFileSync(partialZeroPath, Buffer.from(SAMPLE_PNG_BASE64, "base64"));
			writeFileSync(partialOnePath, Buffer.from(SAMPLE_PNG_BASE64, "base64"));

			const removed = await cleanupPartialImageGenerationResults(sessionId, imageId);

			expect(removed).toBe(2);
			expect(existsSync(finalPath)).toBe(true);
			expect(existsSync(partialZeroPath)).toBe(false);
			expect(existsSync(partialOnePath)).toBe(false);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});
