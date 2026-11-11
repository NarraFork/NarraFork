import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parentPort } from "node:worker_threads";
import { diskSpaceMonitor } from "../disk-safety";
import { generateId } from "../id";
import { redactDiagnosticText } from "../net/diagnostic-redaction";
import { isWithinDir, parseImageDimensions, sanitizeParsedDimensions } from "../uploads";
import type {
	ImageGenerationWorkerReply,
	ImageGenerationWorkerRequest,
	StoredImageWorkerResult,
} from "./image-generation-response-protocol";

const IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,100}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const KNOWN_EXTENSIONS = [".png", ".jpg", ".gif", ".webp"] as const;

function reply(message: ImageGenerationWorkerReply): void {
	parentPort?.postMessage(message);
}

function decodeStandardBase64(value: string): Buffer {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length % 4 !== 0)
		throw new Error("invalid standard base64 image payload");
	const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
	const end = trimmed.length - padding;
	// Do not use a repeated-group regexp: JavaScript engines stop matching large valid payloads.
	for (let index = 0; index < end; index++) {
		const char = trimmed.charCodeAt(index);
		if (
			!(
				(char >= 65 && char <= 90) ||
				(char >= 97 && char <= 122) ||
				(char >= 48 && char <= 57) ||
				char === 43 ||
				char === 47
			)
		)
			throw new Error("invalid standard base64 image payload");
	}
	const last = BASE64_ALPHABET.indexOf(trimmed[end - 1]);
	if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0))
		throw new Error("non-canonical base64 image payload");
	return Buffer.from(trimmed, "base64");
}

function detectImage(bytes: Buffer): { mediaType: string; extension: string } | undefined {
	if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
		return { mediaType: "image/png", extension: ".png" };
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		return { mediaType: "image/jpeg", extension: ".jpg" };
	if (
		bytes.length >= 6 &&
		(bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a")
	)
		return { mediaType: "image/gif", extension: ".gif" };
	if (
		bytes.length >= 12 &&
		bytes.toString("ascii", 0, 4) === "RIFF" &&
		bytes.toString("ascii", 8, 12) === "WEBP"
	)
		return { mediaType: "image/webp", extension: ".webp" };
	return undefined;
}

function assertSafePathPart(value: string, label: string): void {
	if (!IDENTIFIER_RE.test(value)) throw new Error(`invalid ${label}`);
}

async function existingImagePath(
	dir: string,
	imageId: string,
	expected: Buffer,
): Promise<string | undefined> {
	for (const extension of KNOWN_EXTENSIONS) {
		const filePath = join(dir, `${imageId}${extension}`);
		if (!existsSync(filePath)) continue;
		const info = await lstat(filePath);
		if (!info.isFile() || info.isSymbolicLink())
			throw new Error("generated image path is not a regular private file");
		const bytes = await readFile(filePath);
		if (bytes.equals(expected)) return filePath;
		throw new Error(
			"stored generated image bytes changed; refusing to overwrite a successful result",
		);
	}
	return undefined;
}

async function processResponse(
	request: ImageGenerationWorkerRequest,
): Promise<StoredImageWorkerResult[]> {
	if (
		request.action !== "process" ||
		!request.responseId ||
		!request.narratorId ||
		!request.responsePath ||
		!request.uploadsRoot ||
		!request.diskSafety
	)
		throw new Error("invalid image response worker request");
	assertSafePathPart(request.responseId, "response ID");
	assertSafePathPart(request.narratorId, "narrator ID");

	const raw = await readFile(request.responsePath, "utf8");
	const httpFailure =
		request.httpStatus !== undefined && (request.httpStatus < 200 || request.httpStatus >= 300);
	const genericHttpError = `Image generation request failed with HTTP ${request.httpStatus}`;
	let parsed: { data?: unknown; error?: unknown };
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(
			httpFailure ? genericHttpError : "Image generation response contains invalid JSON",
		);
	}
	if (httpFailure || (parsed && typeof parsed === "object" && parsed.error)) {
		const upstream = parsed && typeof parsed === "object" ? parsed.error : undefined;
		const fields =
			upstream && typeof upstream === "object"
				? (upstream as { message?: unknown; code?: unknown })
				: undefined;
		const message =
			typeof upstream === "string"
				? upstream
				: typeof fields?.message === "string"
					? fields.message
					: undefined;
		const code =
			typeof fields?.code === "string" || typeof fields?.code === "number"
				? redactDiagnosticText(String(fields.code))
				: undefined;
		const detail = message ? redactDiagnosticText(message) : undefined;
		const error = new Error(
			`${httpFailure ? genericHttpError : "Image generation failed"}${code ? ` (${code})` : ""}${detail ? `: ${detail}` : ""}`,
		) as Error & { code?: string };
		error.code = code;
		throw error;
	}
	if (!parsed || !Array.isArray(parsed.data) || parsed.data.length === 0)
		throw new Error("image generation response contains no images");

	const uploadsRoot = resolve(request.uploadsRoot);
	const uploadDir = resolve(uploadsRoot, request.narratorId);
	if (!isWithinDir(uploadsRoot, uploadDir)) throw new Error("invalid image upload directory");
	await diskSpaceMonitor.guardWrite(uploadDir, 0, request.diskSafety);
	await mkdir(uploadDir, { recursive: true, mode: 0o700 });
	if (!isWithinDir(await realpath(uploadsRoot), await realpath(uploadDir)))
		throw new Error("image upload directory escapes the private upload root");

	const results: StoredImageWorkerResult[] = [];
	for (let index = 0; index < parsed.data.length; index++) {
		const item = parsed.data[index];
		if (
			!item ||
			typeof item !== "object" ||
			typeof (item as { b64_json?: unknown }).b64_json !== "string"
		)
			throw new Error(`image ${index + 1} has no b64_json payload`);
		const bytes = decodeStandardBase64((item as { b64_json: string }).b64_json);
		const detected = detectImage(bytes);
		if (!detected) throw new Error(`image ${index + 1} has an unrecognized image signature`);

		const imageId = `${request.responseId}_${index + 1}`;
		const existing = await existingImagePath(uploadDir, imageId, bytes);
		const filePath = existing ?? join(uploadDir, `${imageId}${detected.extension}`);
		if (!existing) {
			await diskSpaceMonitor.guardWrite(filePath, bytes.length, request.diskSafety);
			const temporaryPath = join(uploadDir, `.imagegen-${generateId()}.partial`);
			try {
				await writeFile(temporaryPath, bytes, { mode: 0o600, flag: "wx" });
				await rename(temporaryPath, filePath);
			} finally {
				await unlink(temporaryPath).catch(() => {});
			}
		}
		const dimensions = sanitizeParsedDimensions(parseImageDimensions(bytes));
		results.push({
			imageId,
			mediaType: detected.mediaType,
			uploadNarratorId: request.narratorId,
			filePath,
			...(dimensions ?? {}),
		});
	}
	return results;
}

parentPort?.on("message", (message: ImageGenerationWorkerRequest) => {
	if (message?.action === "ping") {
		reply({ ready: true });
		return;
	}
	if (message?.action !== "process") {
		reply({ ok: false, error: "unknown image response worker action" });
		return;
	}
	void processResponse(message).then(
		(images) => reply({ ok: true, images }),
		(error: unknown) => {
			const code = (error as { code?: unknown } | null)?.code;
			reply({
				ok: false,
				error: redactDiagnosticText(error instanceof Error ? error.message : String(error)),
				...(typeof code === "string" ? { code: redactDiagnosticText(code) } : {}),
			});
		},
	);
});

reply({ ready: true });
