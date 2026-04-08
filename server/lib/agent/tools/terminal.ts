import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../../db";
import { narrators, terminals } from "../../../db/schema";
import { terminalService } from "../../../services/terminal-service";
import { truncateOutput } from "../truncate";
import type { ToolDefinition, ToolResult } from "../types";

/**
 * Per-narrator per-terminal read cursor.
 * Tracks the plain-text character length at the end of the last read/write
 * so that subsequent reads without `last_n_lines` return only new output,
 * preventing stale content from polluting the LLM context.
 *
 * Key: `${narratorId}:${terminalId}`, Value: character offset after last read.
 * Pure in-memory — resets naturally when the server restarts.
 */
const readCursors = new Map<string, number>();

function cursorKey(narratorId: string, terminalId: string): string {
	return `${narratorId}:${terminalId}`;
}

/**
 * Reset all read cursors for a given terminal.
 * Called when a terminal is re-attached after server restart or dtach detach,
 * so that the next read returns the full buffer instead of potentially stale
 * incremental content.
 */
export function resetCursorForTerminal(terminalId: string): void {
	const suffix = `:${terminalId}`;
	for (const key of readCursors.keys()) {
		if (key.endsWith(suffix)) {
			readCursors.delete(key);
		}
	}
}

/**
 * Strip ANSI escape sequences from terminal output to produce plain text
 * that is easier for the LLM to read.
 */
function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI stripping
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

/**
 * Extract visible text lines from serialized xterm buffer.
 * The serialize addon output contains ANSI sequences for styling and cursor
 * positioning. We strip those and collapse blank trailing lines.
 */
function extractPlainText(serialized: string): string {
	const plain = stripAnsi(serialized);
	// Trim trailing blank lines
	const lines = plain.split("\n");
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim() === "") end--;
	return lines.slice(0, end).join("\n");
}

/**
 * Verify that the given narrator is allowed to access the terminal.
 * A narrator can access a terminal if:
 *   1. The terminal's narratorId matches, OR
 *   2. The terminal's chapterId matches the narrator's chapterId.
 */
async function assertTerminalAccess(
	terminalId: string,
	narratorId: string,
	cachedChapterId?: string,
): Promise<
	| { allowed: true; terminal: { id: string; name: string | null; status: string | null } }
	| { allowed: false; error: string }
> {
	const terminal = await db.query.terminals.findFirst({
		where: eq(terminals.id, terminalId),
		columns: { id: true, name: true, status: true, narratorId: true, chapterId: true },
	});
	if (!terminal) {
		return { allowed: false, error: `Terminal not found: ${terminalId}` };
	}

	// Direct narrator ownership
	if (terminal.narratorId === narratorId) {
		return { allowed: true, terminal };
	}

	// Chapter-level access: terminal belongs to the same chapter as the narrator
	if (terminal.chapterId) {
		// Use cached chapterId from ToolContext when available to avoid a DB lookup
		const narratorChapterId =
			cachedChapterId ??
			(
				await db.query.narrators.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { chapterId: true },
				})
			)?.chapterId;
		if (narratorChapterId && narratorChapterId === terminal.chapterId) {
			return { allowed: true, terminal };
		}
	}

	return {
		allowed: false,
		error: `Access denied: terminal ${terminalId} does not belong to this narrator or its chapter.`,
	};
}

export const terminalTool: ToolDefinition = {
	name: "Terminal",
	description:
		"Interact with a running interactive terminal (PTY). " +
		"Use action 'read' to get new terminal output since the last read (incremental). " +
		"On the first read (or after a buffer reset), the full buffer is returned. " +
		"Pass 'last_n_lines' to override incremental mode and always get the last N lines. " +
		"Pass 'wait_for' to block until a specific string appears in new output (useful for waiting on " +
		"build completion, server ready messages, prompts, etc.; times out after 30s). " +
		"Use action 'write' to send input to the terminal (keystrokes, commands, Ctrl-C, etc.). " +
		"Use action 'list' to list available terminals for the current narrator. " +
		"This tool is for interacting with persistent interactive terminals (e.g. dev servers, REPLs, TUIs), " +
		"NOT for running one-off commands — use Bash for that.",
	parameters: z.object({
		action: z
			.enum(["read", "write", "list"])
			.describe("The action to perform: 'read' buffer, 'write' input, or 'list' terminals"),
		terminal_id: z
			.string()
			.optional()
			.describe("Terminal ID to interact with. Required for 'read' and 'write' actions."),
		input: z
			.string()
			.optional()
			.describe(
				"Input to send to the terminal (for 'write' action). " +
					"Send '\\n' for Enter, '\\x03' for Ctrl-C, '\\x04' for Ctrl-D, etc.",
			),
		last_n_lines: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe(
				"For 'read' action: only return the last N lines of the buffer (overrides incremental mode). " +
					"When omitted, read returns only new output since the last read/write call.",
			),
		wait_for: z
			.string()
			.optional()
			.describe(
				"For 'read' action: block until this string appears in new terminal output, or until timeout (30s). " +
					"Useful for waiting on build completion, server ready messages, prompts, etc. " +
					"Case-sensitive substring match. Can be combined with last_n_lines.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { action, terminal_id, input, last_n_lines, wait_for } = args as {
			action: "read" | "write" | "list";
			terminal_id?: string;
			input?: string;
			last_n_lines?: number;
			wait_for?: string;
		};

		switch (action) {
			case "list":
				return await listTerminals(ctx.narratorId);
			case "read": {
				if (!terminal_id) {
					return { output: "terminal_id is required for 'read' action", isError: true };
				}
				return await readBuffer(terminal_id, ctx.narratorId, ctx.chapterId, last_n_lines, wait_for);
			}
			case "write": {
				if (!terminal_id) {
					return { output: "terminal_id is required for 'write' action", isError: true };
				}
				if (input === undefined || input === null) {
					return { output: "input is required for 'write' action", isError: true };
				}
				return await writeInput(terminal_id, ctx.narratorId, ctx.chapterId, input);
			}
			default:
				return { output: `Unknown action: ${action}`, isError: true };
		}
	},
};

async function listTerminals(narratorId: string): Promise<ToolResult> {
	// Find terminals associated with this narrator
	const narratorTerminals = await db.query.terminals.findMany({
		where: eq(terminals.narratorId, narratorId),
		columns: { id: true, name: true, status: true, cwd: true, createdAt: true },
	});

	// Also find terminals associated with the narrator's chapter
	const narrator = await db.query.narrators.findFirst({
		where: (n, { eq }) => eq(n.id, narratorId),
		columns: { chapterId: true },
	});

	let chapterTerminals: typeof narratorTerminals = [];
	if (narrator?.chapterId) {
		chapterTerminals = await db.query.terminals.findMany({
			where: eq(terminals.chapterId, narrator.chapterId),
			columns: { id: true, name: true, status: true, cwd: true, createdAt: true },
		});
	}

	// Deduplicate by ID
	const seen = new Set<string>();
	const all = [];
	for (const t of [...narratorTerminals, ...chapterTerminals]) {
		if (!seen.has(t.id)) {
			seen.add(t.id);
			all.push(t);
		}
	}

	if (all.length === 0) {
		return { output: "No terminals found for this narrator or its chapter." };
	}

	const lines = all.map(
		(t) =>
			`- ${t.id} | ${t.name} | ${t.status} | cwd: ${t.cwd ?? "unknown"} | created: ${t.createdAt}`,
	);
	return {
		output: `Found ${all.length} terminal(s):\n${lines.join("\n")}`,
		title: `${all.length} terminal(s)`,
	};
}

async function readBuffer(
	terminalId: string,
	narratorId: string,
	cachedChapterId?: string,
	lastNLines?: number,
	waitFor?: string,
): Promise<ToolResult> {
	const access = await assertTerminalAccess(terminalId, narratorId, cachedChapterId);
	if (!access.allowed) {
		return { output: access.error, isError: true };
	}
	const { terminal } = access;

	// --- wait_for polling phase ---
	let waitTimedOut = false;
	if (waitFor) {
		const key = cursorKey(narratorId, terminalId);
		const initialSnap = await terminalService.getScrollback(terminalId);
		const initialText = initialSnap ? extractPlainText(initialSnap.data) : "";
		const waitStart = readCursors.get(key) ?? initialText.length;

		const deadline = Date.now() + READ_WAIT_FOR_TIMEOUT_MS;
		let found = false;

		while (Date.now() < deadline) {
			const snap = await terminalService.getScrollback(terminalId);
			if (snap) {
				const full = extractPlainText(snap.data);
				const newContent = full.slice(waitStart);
				if (newContent.includes(waitFor)) {
					found = true;
					break;
				}
			}
			await new Promise((r) => setTimeout(r, READ_WAIT_FOR_POLL_MS));
		}

		if (!found) waitTimedOut = true;
	}

	// --- normal read flow ---
	const scrollback = await terminalService.getScrollback(terminalId);
	if (!scrollback) {
		return {
			output:
				terminal.status === "exited"
					? "Terminal has exited and no buffer is available."
					: "No buffer content available (terminal may be initializing).",
			title: terminal.name ?? terminalId,
		};
	}

	const fullText = extractPlainText(scrollback.data);
	let text: string;

	if (lastNLines !== undefined) {
		// Explicit last_n_lines — bypass incremental mode
		text = tailSlice(fullText, lastNLines, WRITE_TAIL_CHARS);
	} else {
		// Incremental mode: return only content after the cursor
		const key = cursorKey(narratorId, terminalId);
		const cursor = readCursors.get(key);

		if (cursor !== undefined && cursor <= fullText.length) {
			// Have a valid cursor — extract only new content
			text = fullText.slice(cursor);
		} else {
			// No cursor (first read) or buffer was reset (cursor > length) — return full
			text = fullText;
		}

		// Note: stale-cursor-after-reattach is handled by resetCursorForTerminal()
		// called in terminal-service during re-attach / recovery, so no guard needed here.

		// Cap incremental output to avoid flooding context
		text = tailSlice(text, READ_INCREMENTAL_MAX_LINES, READ_INCREMENTAL_MAX_CHARS);
	}

	// Update cursor to current end regardless of mode
	readCursors.set(cursorKey(narratorId, terminalId), fullText.length);

	if (!text.trim()) {
		return {
			output: waitTimedOut
				? `(wait_for timed out after ${READ_WAIT_FOR_TIMEOUT_MS / 1000}s — "${waitFor}" not found, no new output)`
				: "(no new output since last read)",
			title: terminal.name ?? terminalId,
		};
	}

	const header = waitTimedOut
		? `(wait_for timed out after ${READ_WAIT_FOR_TIMEOUT_MS / 1000}s — "${waitFor}" not found)\n\n`
		: "";

	const truncated = truncateOutput(header + text);
	return {
		output: truncated.content,
		truncated: truncated.truncated,
		title: terminal.name ?? terminalId,
	};
}

/** How long to wait for new terminal output after writing (ms) */
const WRITE_SETTLE_TIMEOUT_MS = 5_000;
/** Polling interval when waiting for buffer changes (ms) */
const WRITE_POLL_INTERVAL_MS = 200;
/** How long the buffer must be stable before we consider it settled (ms) */
const WRITE_SETTLE_QUIET_MS = 500;
/** Max lines to return from the buffer tail after a write */
const WRITE_TAIL_LINES = 80;
/** Max characters to return from the buffer tail after a write */
const WRITE_TAIL_CHARS = 20_000;
/** Max lines for incremental read (no last_n_lines) */
const READ_INCREMENTAL_MAX_LINES = 200;
/** Max characters for incremental read (no last_n_lines) */
const READ_INCREMENTAL_MAX_CHARS = 40_000;
/** How long to wait for `wait_for` pattern to appear (ms) */
const READ_WAIT_FOR_TIMEOUT_MS = 30_000;
/** Polling interval when waiting for `wait_for` pattern (ms) */
const READ_WAIT_FOR_POLL_MS = 500;

/**
 * Take the last N lines from text, also capping total character count.
 * Returns the trimmed text.
 */
function tailSlice(text: string, maxLines: number, maxChars: number): string {
	let lines = text.split("\n");
	lines = lines.slice(-maxLines);
	let result = lines.join("\n");
	if (result.length > maxChars) {
		result = result.slice(-maxChars);
		// Drop the first (likely partial) line for cleanliness
		const nl = result.indexOf("\n");
		if (nl !== -1) result = result.slice(nl + 1);
	}
	return result;
}

async function writeInput(
	terminalId: string,
	narratorId: string,
	cachedChapterId: string | undefined,
	input: string,
): Promise<ToolResult> {
	const access = await assertTerminalAccess(terminalId, narratorId, cachedChapterId);
	if (!access.allowed) {
		return { output: access.error, isError: true };
	}
	const { terminal } = access;

	if (terminal.status === "exited") {
		return { output: "Terminal has exited. Cannot send input.", isError: true };
	}

	if (!terminalService.isAttached(terminalId)) {
		// Try to reattach if it's a dtach terminal
		const reattached = await terminalService.reattach(terminalId);
		if (!reattached) {
			return {
				output: "Terminal is not attached (no active PTY connection). Cannot send input.",
				isError: true,
			};
		}
	}

	// Snapshot buffer length before writing so we can detect new output
	const beforeSnapshot = await terminalService.getScrollback(terminalId);
	const beforeLen = beforeSnapshot ? extractPlainText(beforeSnapshot.data).length : 0;

	// Process escape sequences in the input string
	const processed = processEscapes(input);
	terminalService.write(terminalId, processed);

	// Wait for the terminal to produce new output and settle
	const deadline = Date.now() + WRITE_SETTLE_TIMEOUT_MS;
	let lastChangeTime = Date.now();
	let lastLen = beforeLen;
	let settled = false;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, WRITE_POLL_INTERVAL_MS));
		const snap = await terminalService.getScrollback(terminalId);
		const curLen = snap ? extractPlainText(snap.data).length : 0;

		if (curLen !== lastLen) {
			// Buffer changed — reset the quiet timer
			lastLen = curLen;
			lastChangeTime = Date.now();
		} else if (curLen > beforeLen && Date.now() - lastChangeTime >= WRITE_SETTLE_QUIET_MS) {
			// Buffer has new content and has been quiet long enough
			settled = true;
			break;
		}
	}

	// Read the final buffer and return the tail
	const afterSnapshot = await terminalService.getScrollback(terminalId);
	if (!afterSnapshot) {
		return {
			output: `Sent ${processed.length} byte(s) to terminal. No buffer available.`,
			title: terminal.name ?? terminalId,
		};
	}

	const fullText = extractPlainText(afterSnapshot.data);

	// Extract only new output generated by this write command (exclude stale content).
	// If beforeLen > fullText.length, buffer was truncated/reset — fall back to full output.
	let text = beforeLen < fullText.length ? fullText.slice(beforeLen) : fullText;

	// Update cursor so subsequent reads skip what we already returned
	readCursors.set(cursorKey(narratorId, terminalId), fullText.length);

	text = tailSlice(text, WRITE_TAIL_LINES, WRITE_TAIL_CHARS);

	if (!text.trim()) {
		return {
			output: `Sent ${processed.length} byte(s) to terminal. (no new output)`,
			title: terminal.name ?? terminalId,
		};
	}

	const header = settled ? "" : "(output may still be in progress)\n\n";

	const truncated = truncateOutput(header + text);
	return {
		output: truncated.content,
		truncated: truncated.truncated,
		title: terminal.name ?? terminalId,
	};
}

/**
 * Process common escape sequences in user-provided input strings.
 * Converts literal backslash-escaped sequences to their actual byte values.
 */
function processEscapes(input: string): string {
	return input
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}
