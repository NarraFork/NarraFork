import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hotSafe } from "../hot-safe";

// === Limits ===

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024; // 50 KB

/** Directory for persisted full outputs when truncation occurs. */
export const OUTPUT_DIR = join(tmpdir(), "narrafork-tool-output");

/** How long to keep truncated output files. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Cleanup interval. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// === Types ===

export interface TruncateResult {
	content: string;
	truncated: boolean;
	/** Path to the full output file (only set when truncated). */
	outputPath?: string;
}

// === Public API ===

/**
 * Truncate tool output using dual limits (line count + byte size).
 * When truncated, the full output is persisted to a temp file so the LLM
 * can retrieve it via Read/Grep.
 */
export function truncateOutput(
	text: string,
	options?: { maxLines?: number; maxBytes?: number },
): TruncateResult {
	const maxLines = options?.maxLines ?? MAX_LINES;
	const maxBytes = options?.maxBytes ?? MAX_BYTES;

	const lines = text.split("\n");
	const totalBytes = Buffer.byteLength(text, "utf-8");

	if (lines.length <= maxLines && totalBytes <= maxBytes) {
		return { content: text, truncated: false };
	}

	// Take lines from the tail (most recent output is usually most relevant).
	const kept: string[] = [];
	let bytes = 0;
	let hitBytes = false;

	for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
		const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (kept.length > 0 ? 1 : 0); // +1 for \n
		if (bytes + lineBytes > maxBytes) {
			// If we haven't kept any lines yet, the last line alone exceeds the byte
			// limit (e.g. minified files). Truncate it at the character level so the
			// LLM still sees *something* instead of an empty preview.
			if (kept.length === 0) {
				const line = lines[i];
				let cutLen = Math.min(line.length, maxBytes);
				while (cutLen > 0 && Buffer.byteLength(line.slice(-cutLen), "utf-8") > maxBytes) {
					cutLen = Math.floor(cutLen * 0.9);
				}
				if (cutLen > 0) {
					kept.push(`[line truncated, ${line.length} chars total]…${line.slice(-cutLen)}`);
					bytes = Buffer.byteLength(kept[0], "utf-8");
				}
			}
			hitBytes = true;
			break;
		}
		kept.push(lines[i]);
		bytes += lineBytes;
	}

	// Reverse to restore original order (we collected from the tail).
	kept.reverse();

	// Persist full output to disk.
	const outputPath = persistOutput(text);

	const omitted = hitBytes ? totalBytes - bytes : lines.length - kept.length;
	const unit = hitBytes ? "bytes" : "lines";
	const preview = kept.join("\n");

	const hint =
		`⚠️ OUTPUT TRUNCATED — only the last ${kept.length} of ${lines.length} lines shown (earlier output omitted). Full output saved to: ${outputPath}\n` +
		"⚠️ You MUST use Read (path: the file above) to retrieve the needed content before proceeding. " +
		"Do NOT re-run the command or pipe to a file — the output is already saved. " +
		"Prefer Grep to locate relevant lines, then use Read with a small offset/limit range to page through them. " +
		"Use limit=-1 (read_all) only when the complete file is explicitly required and its size is manageable.";

	const content = `...${omitted} ${unit} truncated...\n\n${preview}\n\n${hint}`;

	return { content, truncated: true, outputPath };
}

// === Persistence ===

function ensureDir(): void {
	try {
		mkdirSync(OUTPUT_DIR, { recursive: true });
	} catch {
		// already exists
	}
}

export function persistOutput(text: string): string {
	ensureDir();
	const filename = `tool_${Date.now()}_${randomUUID().slice(0, 8)}`;
	const filepath = join(OUTPUT_DIR, filename);
	writeFileSync(filepath, text, "utf-8");
	return filepath;
}

// === Cleanup ===

function cleanup(): void {
	let entries: string[];
	try {
		entries = readdirSync(OUTPUT_DIR);
	} catch {
		return;
	}
	const cutoff = Date.now() - RETENTION_MS;
	for (const entry of entries) {
		if (!entry.startsWith("tool_") && !entry.startsWith("toolcall_")) continue;
		try {
			const filepath = join(OUTPUT_DIR, entry);
			const stat = statSync(filepath);
			if (stat.mtimeMs < cutoff) {
				unlinkSync(filepath);
			}
		} catch {
			// ignore individual file errors
		}
	}
}

/** Start the periodic cleanup timer. Safe to call multiple times. */
export function initTruncateCleanup(): void {
	const existing = hotSafe<{ timer?: ReturnType<typeof setInterval> }>(
		"narrafork.truncateCleanupTimer",
		() => ({}),
	);
	if (existing.timer) return;
	cleanup(); // run once immediately
	const timer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
	// Don't block process exit.
	if (timer && typeof timer === "object" && "unref" in timer) {
		timer.unref();
	}
	existing.timer = timer;
}
