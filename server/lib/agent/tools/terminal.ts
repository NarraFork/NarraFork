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
	| { allowed: true; terminal: { id: string; name: string; status: string | null } }
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

/**
 * Resolve a terminal identifier (ID or name) to a real terminal ID.
 * First tries an exact ID lookup, then falls back to matching by name
 * among terminals accessible to the given narrator.
 */
async function resolveTerminalId(
	idOrName: string,
	narratorId: string,
	cachedChapterId?: string,
): Promise<{ id: string } | { error: string }> {
	// 1. Try exact ID match
	const byId = await db.query.terminals.findFirst({
		where: eq(terminals.id, idOrName),
		columns: { id: true },
	});
	if (byId) return { id: byId.id };

	// 2. Fallback: search by name among accessible terminals
	const narratorTerminals = await db.query.terminals.findMany({
		where: eq(terminals.narratorId, narratorId),
		columns: { id: true, name: true },
	});

	const chapterId =
		cachedChapterId ??
		(
			await db.query.narrators.findFirst({
				where: eq(narrators.id, narratorId),
				columns: { chapterId: true },
			})
		)?.chapterId;

	let chapterTerminals: { id: string; name: string }[] = [];
	if (chapterId) {
		chapterTerminals = await db.query.terminals.findMany({
			where: eq(terminals.chapterId, chapterId),
			columns: { id: true, name: true },
		});
	}

	// Deduplicate
	const seen = new Set<string>();
	const all: { id: string; name: string }[] = [];
	for (const t of [...narratorTerminals, ...chapterTerminals]) {
		if (!seen.has(t.id)) {
			seen.add(t.id);
			all.push(t);
		}
	}

	// Exact name match (case-insensitive)
	const nameLower = idOrName.toLowerCase();
	const match = all.find((t) => t.name.toLowerCase() === nameLower);
	if (match) return { id: match.id };

	return {
		error: `Terminal not found: "${idOrName}". Use action 'list' to see available terminals.`,
	};
}

export const terminalTool: ToolDefinition = {
	name: "Terminal",
	description:
		"Interact with interactive terminals (PTY). " +
		"Use action 'create' to create a new terminal. " +
		"Use action 'rename' to rename an existing terminal. " +
		"Use action 'read' to get new terminal output since the last read (incremental). " +
		"On the first read (or after a buffer reset), the full buffer is returned. " +
		"Pass 'last_n_lines' to override incremental mode and always get the last N lines. " +
		"Pass 'wait_for' to block until a specific string appears in new output (useful for waiting on " +
		"build completion, server ready messages, prompts, etc.; times out after 30s). " +
		"Use action 'write' to send input to the terminal (keystrokes, commands, Ctrl-C, etc.). " +
		"Use action 'list' to list available terminals for the current narrator. " +
		"The 'terminal_id' parameter accepts either a terminal ID or a terminal name. " +
		"This tool is for interacting with persistent interactive terminals (e.g. dev servers, REPLs, TUIs), " +
		"NOT for running one-off commands — use Bash for that.",
	parameters: z.object({
		action: z
			.enum(["read", "write", "list", "create", "rename"])
			.describe(
				"The action to perform: 'read' buffer, 'write' input, 'list' terminals, " +
					"'create' a new terminal, or 'rename' an existing terminal",
			),
		terminal_id: z
			.string()
			.optional()
			.describe(
				"Terminal ID or name to interact with. Required for 'read', 'write', and 'rename' actions.",
			),
		input: z
			.string()
			.optional()
			.describe(
				"Input to send to the terminal (for 'write' action). " +
					"Send '\\n' for Enter, '\\x03' for Ctrl-C, '\\x04' for Ctrl-D, etc.",
			),
		name: z
			.string()
			.optional()
			.describe(
				"For 'create' action: the name for the new terminal (defaults to 'Terminal'). " +
					"For 'rename' action: the new name for the terminal.",
			),
		last_n_lines: z
			.number()
			.int()
			.optional()
			.describe(
				"For 'read' action: only return the last N lines of the buffer (overrides incremental mode). " +
					"Must be >= 1. When omitted, read returns only new output since the last read/write call.",
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
		const { action, terminal_id, input, name, last_n_lines, wait_for } = args as {
			action: "read" | "write" | "list" | "create" | "rename";
			terminal_id?: string;
			input?: string;
			name?: string;
			last_n_lines?: number;
			wait_for?: string;
		};

		switch (action) {
			case "list":
				return await listTerminals(ctx.narratorId);
			case "create":
				return await createTerminal(ctx.narratorId, ctx.chapterId, name);
			case "rename": {
				if (!terminal_id) {
					return {
						output: "terminal_id is required for 'rename' action",
						isError: true,
					};
				}
				if (!name) {
					return { output: "name is required for 'rename' action", isError: true };
				}
				return await renameTerminal(terminal_id, name, ctx.narratorId, ctx.chapterId);
			}
			case "read": {
				if (!terminal_id) {
					return { output: "terminal_id is required for 'read' action", isError: true };
				}
				const resolved = await resolveTerminalId(terminal_id, ctx.narratorId, ctx.chapterId);
				if ("error" in resolved) {
					return { output: resolved.error, isError: true };
				}
				// Treat last_n_lines < 1 as unset (AI models sometimes pass 0)
				const effectiveLastN =
					last_n_lines !== undefined && last_n_lines >= 1 ? last_n_lines : undefined;
				return await readBuffer(
					resolved.id,
					ctx.narratorId,
					ctx.chapterId,
					ctx.signal,
					effectiveLastN,
					wait_for,
				);
			}
			case "write": {
				if (!terminal_id) {
					return { output: "terminal_id is required for 'write' action", isError: true };
				}
				if (input === undefined || input === null) {
					return { output: "input is required for 'write' action", isError: true };
				}
				const resolved = await resolveTerminalId(terminal_id, ctx.narratorId, ctx.chapterId);
				if ("error" in resolved) {
					return { output: resolved.error, isError: true };
				}
				return await writeInput(resolved.id, ctx.narratorId, ctx.chapterId, ctx.signal, input);
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

	// Deduplicate by ID and exclude exited terminals
	const seen = new Set<string>();
	const all = [];
	for (const t of [...narratorTerminals, ...chapterTerminals]) {
		if (!seen.has(t.id) && t.status !== "exited") {
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

async function createTerminal(
	narratorId: string,
	cachedChapterId?: string,
	name?: string,
): Promise<ToolResult> {
	try {
		const terminal = cachedChapterId
			? await terminalService.create({ chapterId: cachedChapterId, narratorId, name })
			: await terminalService.create({ narratorId, name });
		return {
			output:
				`Terminal created successfully.\n` +
				`- ID: ${terminal.id}\n` +
				`- Name: ${terminal.name}\n` +
				`- CWD: ${terminal.cwd ?? "unknown"}`,
			title: terminal.name,
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { output: `Failed to create terminal: ${msg}`, isError: true };
	}
}

async function renameTerminal(
	idOrName: string,
	newName: string,
	narratorId: string,
	cachedChapterId?: string,
): Promise<ToolResult> {
	const resolved = await resolveTerminalId(idOrName, narratorId, cachedChapterId);
	if ("error" in resolved) {
		return { output: resolved.error, isError: true };
	}
	const access = await assertTerminalAccess(resolved.id, narratorId, cachedChapterId);
	if (!access.allowed) {
		return { output: access.error, isError: true };
	}
	try {
		await terminalService.rename(resolved.id, newName);
		return {
			output: `Terminal renamed to "${newName}".`,
			title: newName,
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { output: `Failed to rename terminal: ${msg}`, isError: true };
	}
}

const TERMINAL_ABORTED_MESSAGE = "Terminal operation aborted by user.";

function makeAbortedResult(title?: string | null): ToolResult {
	return {
		output: TERMINAL_ABORTED_MESSAGE,
		isError: true,
		title: title ?? undefined,
	};
}

export async function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) {
		return false;
	}

	return await new Promise<boolean>((resolve) => {
		const onAbort = () => {
			cleanup();
			resolve(false);
		};
		const timer = setTimeout(() => {
			cleanup();
			resolve(true);
		}, ms);
		const cleanup = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (typeof timer === "object" && "unref" in timer) timer.unref();
	});
}

async function readBuffer(
	terminalId: string,
	narratorId: string,
	cachedChapterId: string | undefined,
	signal: AbortSignal,
	lastNLines?: number,
	waitFor?: string,
): Promise<ToolResult> {
	const access = await assertTerminalAccess(terminalId, narratorId, cachedChapterId);
	if (!access.allowed) {
		return { output: access.error, isError: true };
	}
	const { terminal } = access;
	if (signal.aborted) {
		return makeAbortedResult(terminal.name ?? terminalId);
	}

	// --- wait_for polling phase ---
	let waitTimedOut = false;
	if (waitFor) {
		const key = cursorKey(narratorId, terminalId);
		const initialSnap = await terminalService.getScrollback(terminalId);
		if (signal.aborted) {
			return makeAbortedResult(terminal.name ?? terminalId);
		}
		const initialText = initialSnap ? extractPlainText(initialSnap.data) : "";
		const waitStart = readCursors.get(key) ?? initialText.length;

		const deadline = Date.now() + READ_WAIT_FOR_TIMEOUT_MS;
		let found = false;

		while (Date.now() < deadline) {
			if (signal.aborted) {
				return makeAbortedResult(terminal.name ?? terminalId);
			}
			const snap = await terminalService.getScrollback(terminalId);
			if (signal.aborted) {
				return makeAbortedResult(terminal.name ?? terminalId);
			}
			if (snap) {
				const full = extractPlainText(snap.data);
				const newContent = full.slice(waitStart);
				if (newContent.includes(waitFor)) {
					found = true;
					break;
				}
			}
			if (!(await abortableSleep(READ_WAIT_FOR_POLL_MS, signal))) {
				return makeAbortedResult(terminal.name ?? terminalId);
			}
		}

		if (!found) waitTimedOut = true;
	}

	// --- normal read flow ---
	if (signal.aborted) {
		return makeAbortedResult(terminal.name ?? terminalId);
	}
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
	signal: AbortSignal,
	input: string,
): Promise<ToolResult> {
	const access = await assertTerminalAccess(terminalId, narratorId, cachedChapterId);
	if (!access.allowed) {
		return { output: access.error, isError: true };
	}
	const { terminal } = access;

	if (signal.aborted) {
		return makeAbortedResult(terminal.name ?? terminalId);
	}
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
	if (signal.aborted) {
		return makeAbortedResult(terminal.name ?? terminalId);
	}
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
		if (!(await abortableSleep(WRITE_POLL_INTERVAL_MS, signal))) {
			return makeAbortedResult(terminal.name ?? terminalId);
		}
		const snap = await terminalService.getScrollback(terminalId);
		if (signal.aborted) {
			return makeAbortedResult(terminal.name ?? terminalId);
		}
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
	if (signal.aborted) {
		return makeAbortedResult(terminal.name ?? terminalId);
	}
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
