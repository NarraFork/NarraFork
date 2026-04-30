import { describe, expect, test } from "bun:test";
import {
	decodeStandardBase64Image,
	imageGenerationArtifactPath,
	sanitizeImageGenerationPathPart,
} from "../image-generation";

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
});
