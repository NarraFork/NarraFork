import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// === Limits ===

export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024; // 50 KB

/** Directory for persisted full outputs when truncation occurs. */
export const OUTPUT_DIR = join(tmpdir(), "narrafork-tool-output");

/** How long to keep truncated output files. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Cleanup interval. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let cleanupTimer: ReturnType<typeof setInterval> | undefined;

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

	// Take lines from the head until we hit either limit.
	const kept: string[] = [];
	let bytes = 0;
	let hitBytes = false;

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0); // +1 for \n
		if (bytes + lineBytes > maxBytes) {
			hitBytes = true;
			break;
		}
		kept.push(lines[i]);
		bytes += lineBytes;
	}

	// Persist full output to disk.
	const outputPath = persistOutput(text);

	const omitted = hitBytes ? totalBytes - bytes : lines.length - kept.length;
	const unit = hitBytes ? "bytes" : "lines";
	const preview = kept.join("\n");

	const hint =
		`The output was truncated. Full output saved to: ${outputPath}\n` +
		"Use Read with offset/limit to view specific sections, or Grep to search the full content.";

	const content = `${preview}\n\n...${omitted} ${unit} truncated...\n\n${hint}`;

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

function persistOutput(text: string): string {
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
		if (!entry.startsWith("tool_")) continue;
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
	if (cleanupTimer) return;
	cleanup(); // run once immediately
	cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
	// Don't block process exit.
	if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
		cleanupTimer.unref();
	}
}
