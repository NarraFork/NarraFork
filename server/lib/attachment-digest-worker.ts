import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { parentPort } from "node:worker_threads";

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
class DigestByteLimitError extends Error {}

// One business request per worker; every read/hash update is at most 1 MiB.
parentPort?.once("message", async (input: { blob?: Blob; path?: string; maxBytes: number }) => {
	try {
		if (!Number.isSafeInteger(input?.maxBytes) || input.maxBytes < 0 || input.maxBytes > MAX_BYTES)
			throw new DigestByteLimitError("Invalid attachment digest byte budget");
		if ((typeof input.path === "string") === input.blob instanceof Blob)
			throw new Error("Attachment digest requires exactly one file or Blob");
		const before = input.path !== undefined ? await stat(input.path) : undefined;
		if (before && !before.isFile()) throw new Error("Attachment digest requires a regular file");
		const blob = input.path !== undefined ? Bun.file(input.path) : input.blob;
		if (!(blob instanceof Blob)) throw new Error("Attachment digest input could not be cloned");
		const expectedBytes = before?.size ?? blob.size;
		if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > input.maxBytes)
			throw new DigestByteLimitError("Attachment exceeds digest byte budget");
		const hash = createHash("sha256");
		let bytes = 0;
		// A missing BunFile must not masquerade as an empty Blob after structured clone.
		const file = blob as Partial<Bun.BunFile>;
		if (typeof file.exists === "function" && !(await file.exists()))
			throw new Error("Attachment digest file does not exist");
		for (let offset = 0; offset < expectedBytes; offset += CHUNK_BYTES) {
			const stream = blob.slice(offset, Math.min(offset + CHUNK_BYTES, expectedBytes)).stream();
			const reader = stream.getReader();
			try {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					bytes += chunk.value.byteLength;
					if (chunk.value.byteLength > CHUNK_BYTES || bytes > input.maxBytes)
						throw new DigestByteLimitError("Attachment exceeds digest byte budget");
					hash.update(chunk.value);
				}
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
		}
		if (bytes !== expectedBytes || blob.size !== expectedBytes)
			throw new Error("Attachment changed while calculating digest");
		if (input.path !== undefined && before) {
			const after = await stat(input.path);
			if (
				before.dev !== after.dev ||
				before.ino !== after.ino ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs
			)
				throw new Error("Attachment changed while calculating digest");
		}
		parentPort?.postMessage({ digest: hash.digest("hex") });
	} catch (error) {
		parentPort?.postMessage({
			error: error instanceof Error ? error.message : "Attachment digest failed",
			tooLarge: error instanceof DigestByteLimitError,
		});
	} finally {
		parentPort?.close();
	}
});
parentPort?.postMessage({ ready: true });
