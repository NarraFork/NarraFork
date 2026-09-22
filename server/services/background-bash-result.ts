import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { OUTPUT_DIR } from "../lib/agent/truncate";
import { logger } from "../lib/logger";

const SPILL_BYTES = 5120;
const PREVIEW_BYTES = 1024;
// Matches MAX_OUTPUT_BYTES in lib/agent/tools/bash.ts (foreground and background).
const CAPTURE_BYTES = 10 * 1024 * 1024;
const WRITE_TIMEOUT_MS = 2000;

/** Convert only a bounded prefix, never encode an arbitrarily large input. */
function capturedPrefix(output: string): { bytes: Buffer; clipped: boolean } {
	const bytes = Buffer.from(output.slice(0, CAPTURE_BYTES + 1), "utf8");
	let end = Math.min(bytes.length, CAPTURE_BYTES);
	if (end < bytes.length) {
		while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	}
	return {
		bytes: bytes.subarray(0, end),
		clipped: output.length > CAPTURE_BYTES || bytes.length > CAPTURE_BYTES,
	};
}

function tailPreview(output: string): string {
	let tail = output.slice(-(PREVIEW_BYTES + 2));
	// A slice can start in the middle of a UTF-16 surrogate pair.
	if (tail.length && tail.charCodeAt(0) >= 0xdc00 && tail.charCodeAt(0) <= 0xdfff) {
		tail = tail.slice(1);
	}
	const bytes = Buffer.from(tail, "utf8");
	let start = Math.max(0, bytes.length - PREVIEW_BYTES);
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

/** Remove only files owned by this module; missing files are already discarded. */
export async function discardBackgroundBashResult(outputPath?: string): Promise<void> {
	if (
		!outputPath ||
		dirname(outputPath) !== OUTPUT_DIR ||
		!/^toolcall_[0-9]+_[a-f0-9-]+$/.test(basename(outputPath))
	) {
		return;
	}
	try {
		await fs.unlink(outputPath);
	} catch {
		// Best effort: the existing seven-day cleanup is the final fallback.
	}
}

export async function prepareBackgroundBashResult(
	taskId: string,
	output: string,
): Promise<{ content: string; outputPath?: string }> {
	if (output.length < SPILL_BYTES && Buffer.byteLength(output, "utf8") < SPILL_BYTES) {
		return { content: output };
	}
	const { bytes, clipped } = capturedPrefix(output);
	const preview = tailPreview(output);
	// Never use caller-controlled task IDs in filenames.
	const outputPath = join(OUTPUT_DIR, `toolcall_${Date.now()}_${randomUUID()}`);
	const controller = new AbortController();
	let failed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const write = (async () => {
		try {
			await fs.mkdir(OUTPUT_DIR, { recursive: true });
			controller.signal.throwIfAborted();
			await fs.writeFile(outputPath, bytes, {
				flag: "wx",
				mode: 0o600,
				signal: controller.signal,
			});
		} finally {
			// A timed-out write can settle later; do not leave its partial file behind.
			if (failed) await discardBackgroundBashResult(outputPath);
		}
	})();
	try {
		await Promise.race([
			write,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					failed = true;
					controller.abort();
					reject(new Error("write timed out"));
				}, WRITE_TIMEOUT_MS);
			}),
		]);
		return {
			outputPath,
			content:
				`Background Bash captured output saved to: ${outputPath}\n` +
				(clipped
					? "Captured output was clipped to a UTF-8 complete prefix of at most 10 MiB; the file is not the complete output.\n"
					: "This file contains captured output, not a guarantee of the command's complete output.\n") +
				'Use Read or Grep with device: "local" and the path above. No Await is needed.\n' +
				`If Read reports that the file was cleaned up, you may try Await with type: "bash", id: ${JSON.stringify(taskId)}; it may retain only a preview and does not guarantee complete output.\n` +
				`Captured output tail preview (at most ${PREVIEW_BYTES} UTF-8 bytes):\n${preview}`,
		};
	} catch {
		logger.warn("Background Bash captured output could not be saved", {
			taskId,
			reason: failed ? "write_timeout" : "write_failed",
		});
		failed = true;
		controller.abort();
		// Do not await filesystem cleanup on the bounded response path.
		void discardBackgroundBashResult(outputPath);
		return {
			content:
				"Failed to save captured output (write failed or timed out); no output file is available.\n" +
				`Use Await with type: "bash", id: ${JSON.stringify(taskId)} to retrieve captured output.\n` +
				(clipped
					? "Captured output exceeds the 10 MiB capture limit; only a bounded preview is shown.\n"
					: "") +
				`Captured output tail preview (at most ${PREVIEW_BYTES} UTF-8 bytes):\n${preview}`,
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}
