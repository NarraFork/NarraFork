import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const GENERATED_IMAGE_ARTIFACTS_DIR = "generated_images";
const STANDARD_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function sanitizeImageGenerationPathPart(value: string): string {
	const sanitized = Array.from(value)
		.map((ch) => (/[A-Za-z0-9_-]/.test(ch) ? ch : "_"))
		.join("");
	return sanitized || "generated_image";
}

export function imageGenerationArtifactsRoot(): string {
	return join(homedir(), ".narrafork", GENERATED_IMAGE_ARTIFACTS_DIR);
}

export function imageGenerationArtifactPath(sessionId: string, imageId: string): string {
	return join(
		imageGenerationArtifactsRoot(),
		sanitizeImageGenerationPathPart(sessionId),
		`${sanitizeImageGenerationPathPart(imageId)}.png`,
	);
}

export function decodeStandardBase64Image(result: string): Buffer {
	const trimmed = result.trim();
	if (!trimmed) {
		throw new Error("empty image generation payload");
	}
	if (trimmed.startsWith("data:")) {
		throw new Error("image generation payload must be raw base64, not a data URL");
	}
	if (trimmed.length % 4 !== 0 || !STANDARD_BASE64_RE.test(trimmed)) {
		throw new Error("invalid standard base64 image generation payload");
	}

	const bytes = Buffer.from(trimmed, "base64");
	// Buffer.from(..., "base64") is permissive. Re-encoding catches accepted but
	// non-canonical payloads so we match Codex's strict standard-base64 behavior.
	if (bytes.toString("base64") !== trimmed) {
		throw new Error("non-canonical base64 image generation payload");
	}
	return bytes;
}

export async function saveImageGenerationResult(
	sessionId: string,
	imageId: string,
	result: string,
): Promise<string> {
	const bytes = decodeStandardBase64Image(result);
	const filePath = imageGenerationArtifactPath(sessionId, imageId);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, bytes);
	return filePath;
}

export function buildImageGenerationSavedPathInstruction(savedPath: string): string {
	const dir = dirname(savedPath);
	return (
		`Generated images are saved to ${dir} by default.\n` +
		`The most recent generated image is saved as ${savedPath}.\n` +
		"If you need to use a generated image at another path, copy it and leave " +
		"the original in place unless the user explicitly asks you to delete it."
	);
}
