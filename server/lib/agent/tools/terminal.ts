import type { IMarker } from "@xterm/headless";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../../db";
import { terminals } from "../../../db/schema";
import { terminalService } from "../../../services/terminal-service";
import {
	DEFAULT_WATCH_TIMEOUT_MS,
	echoEnd,
	MAX_WATCH_TIMEOUT_MS,
	MIN_WATCH_TIMEOUT_MS,
	normalizeWatchPattern,
	startTerminalWatch,
	type WatchStart,
} from "../../../services/terminal-watch-service";
import { truncateOutput } from "../truncate";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

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
export function extractPlainText(serialized: string): string {
	// The serialize addon separates rows with CRLF; normalise so the model sees
	// plain "\n" line breaks and cursor offsets count one char per line break.
	const plain = stripAnsi(serialized).replace(/\r\n/g, "\n");
	// Trim trailing blank lines
	const lines = plain.split("\n");
	let end = lines.length;
	while (end > 0 && lines[end - 1].trim() === "") end--;
	return lines.slice(0, end).join("\n");
}

/**
 * Verify that the given narrator is allowed to access the terminal.
 * A narrator can access a terminal it owns.
 */
async function assertTerminalAccess(
	terminalId: string,
	narratorId: string,
): Promise<
	| { allowed: true; terminal: { id: string; name: string; status: string | null } }
	| { allowed: false; error: string }
> {
	const terminal = await db.query.terminals.findFirst({
		where: eq(terminals.id, terminalId),
		columns: { id: true, name: true, status: true, narratorId: true },
	});
	if (!terminal) {
		return { allowed: false, error: `Terminal not found: ${terminalId}` };
	}

	// Direct narrator ownership
	if (terminal.narratorId === narratorId) {
		return { allowed: true, terminal };
	}

	return {
		allowed: false,
		error: `Access denied: terminal ${terminalId} does not belong to this narrator.`,
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

	const all = narratorTerminals;

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
		"Use action 'write' to send input to the terminal (keystrokes, commands, Ctrl-C, etc.). " +
		"To wait for something to appear, do not poll with 'read': " +
		"pass 'notify_on' with 'write' (wait for the command you are sending), or use action 'watch' " +
		"(wait for output of something already running, e.g. a server's ready message). " +
		"Both start a background watch and return at once; end your turn and you will be notified " +
		"with the matching output when the text appears, or when the watch times out or the " +
		"terminal exits. Stop({ type: 'bash', id }) cancels a watch. " +
		"Use action 'list' to list available terminals for the current narrator. " +
		"The 'terminal_id' parameter accepts either a terminal ID or a terminal name. " +
		"This tool is for interacting with persistent interactive terminals (e.g. dev servers, REPLs, TUIs), " +
		"NOT for running one-off commands — use Bash for that: it returns when the command exits, " +
		"with its exit code, and needs no completion marker.",
	parameters: z.object({
		action: z
			.enum(["read", "write", "watch", "list", "create", "rename"])
			.describe(
				"The action to perform: 'read' buffer, 'write' input, 'watch' for a pattern, " +
					"'list' terminals, 'create' a new terminal, or 'rename' an existing terminal",
			),
		terminal_id: z
			.string()
			.optional()
			.describe(
				"Terminal ID or name to interact with. Required for 'read', 'write', 'watch' and 'rename'.",
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
			.optional()
			.describe(
				"For 'read' action: only return the last N lines of the buffer (overrides incremental mode). " +
					"Must be >= 1. When omitted, read returns only new output since the last read/write call.",
			),
		notify_on: z
			.string()
			.optional()
			.describe(
				"For 'write' action: text that marks the command as finished. Matching starts after the " +
					"echo of the command line you send, so a marker inside the command " +
					"(`cmd; echo __DONE__`) only matches once the command printed it. If it already " +
					"appears within the few seconds 'write' waits for output, the result says so and no " +
					"watch is started. Case-sensitive substring of the rendered screen text.",
			),
		pattern: z
			.string()
			.optional()
			.describe(
				"For 'watch' action: text to wait for. Only output from now on is matched. " +
					"Case-sensitive substring of the rendered screen text.",
			),
		timeout: looseNumber(
			`For 'watch', and for 'write' with 'notify_on': seconds before the watch gives up and ` +
				`notifies you (default ${DEFAULT_WATCH_TIMEOUT_MS / 1000}, max ${MAX_WATCH_TIMEOUT_MS / 1000}).`,
		),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { action, terminal_id, input, name, last_n_lines, notify_on, pattern, timeout } =
			args as {
				action: "read" | "write" | "watch" | "list" | "create" | "rename";
				terminal_id?: string;
				input?: string;
				name?: string;
				last_n_lines?: number;
				notify_on?: string;
				pattern?: string;
				timeout?: number;
			};
		const timeoutMs =
			(normalizeNumber(timeout, {
				min: MIN_WATCH_TIMEOUT_MS / 1000,
				max: MAX_WATCH_TIMEOUT_MS / 1000,
			}) ?? DEFAULT_WATCH_TIMEOUT_MS / 1000) * 1000;

		switch (action) {
			case "list":
				return await listTerminals(ctx.narratorId);
			case "create":
				return await createTerminal(ctx.narratorId, name);
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
				return await renameTerminal(terminal_id, name, ctx.narratorId);
			}
			case "read": {
				if (!terminal_id) {
					return { output: "terminal_id is required for 'read' action", isError: true };
				}
				const resolved = await resolveTerminalId(terminal_id, ctx.narratorId);
				if ("error" in resolved) {
					return { output: resolved.error, isError: true };
				}
				// Treat last_n_lines < 1 as unset (AI models sometimes pass 0 or floats)
				const effectiveLastN =
					last_n_lines !== undefined && last_n_lines >= 1 ? Math.round(last_n_lines) : undefined;
				return await readBuffer(resolved.id, ctx.narratorId, ctx.signal, effectiveLastN);
			}
			case "write": {
				if (!terminal_id) {
					return { output: "terminal_id is required for 'write' action", isError: true };
				}
				if (input === undefined || input === null) {
					return { output: "input is required for 'write' action", isError: true };
				}
				if (notify_on !== undefined && normalizeWatchPattern(notify_on).trim() === "") {
					return { output: "notify_on must contain visible text", isError: true };
				}
				const resolved = await resolveTerminalId(terminal_id, ctx.narratorId);
				if ("error" in resolved) {
					return { output: resolved.error, isError: true };
				}
				return await writeInput(resolved.id, ctx, input, notify_on, timeoutMs);
			}
			case "watch": {
				if (!terminal_id) {
					return { output: "terminal_id is required for 'watch' action", isError: true };
				}
				if (!pattern || normalizeWatchPattern(pattern).trim() === "") {
					return { output: "pattern is required for 'watch' action", isError: true };
				}
				const resolved = await resolveTerminalId(terminal_id, ctx.narratorId);
				if ("error" in resolved) {
					return { output: resolved.error, isError: true };
				}
				return await watchTerminal(resolved.id, ctx, pattern, timeoutMs);
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

	// Exclude exited terminals
	const all = narratorTerminals.filter((t) => t.status !== "exited");

	if (all.length === 0) {
		return { output: "No terminals found for this narrator." };
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

async function createTerminal(narratorId: string, name?: string): Promise<ToolResult> {
	try {
		const terminal = await terminalService.create({ narratorId, name });
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
): Promise<ToolResult> {
	const resolved = await resolveTerminalId(idOrName, narratorId);
	if ("error" in resolved) {
		return { output: resolved.error, isError: true };
	}
	const access = await assertTerminalAccess(resolved.id, narratorId);
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
	signal: AbortSignal,
	lastNLines?: number,
): Promise<ToolResult> {
	const access = await assertTerminalAccess(terminalId, narratorId);
	if (!access.allowed) {
		return { output: access.error, isError: true };
	}
	const { terminal } = access;
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

	const key = cursorKey(narratorId, terminalId);
	const fullText = extractPlainText(scrollback.data);
	let text: string;

	if (lastNLines !== undefined) {
		// Explicit last_n_lines — bypass incremental mode
		text = tailSlice(fullText, lastNLines, WRITE_TAIL_CHARS);
	} else {
		// Incremental mode: return only content after the cursor
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
	readCursors.set(key, fullText.length);

	if (!text.trim()) {
		return {
			output: "(no new output since last read)",
			title: terminal.name ?? terminalId,
		};
	}

	const truncated = truncateOutput(text);
	return {
		output: truncated.content,
		truncated: truncated.truncated,
		title: terminal.name ?? terminalId,
	};
}

/**
 * Start a watch on `terminalId` and describe it for the model. `marker` is the
 * row matching starts from; ownership passes to the watch.
 */
async function startWatch(
	terminalId: string,
	terminalName: string,
	ctx: ToolContext,
	pattern: string,
	timeoutMs: number,
	marker: IMarker,
	start: WatchStart,
): Promise<ToolResult> {
	const buffer = terminalService.getActiveBuffer(terminalId);
	if (!buffer) {
		marker.dispose();
		return {
			output: "Terminal is not attached; cannot watch it. Read it to re-attach, then retry.",
			isError: true,
		};
	}
	const started = await startTerminalWatch({
		narratorId: ctx.narratorId,
		terminalId,
		terminalName,
		pattern,
		timeoutMs,
		buffer,
		marker,
		start,
		toolUseId: ctx.currentToolUseId,
	});
	if (started.status === "error") return { output: started.message, isError: true };
	return {
		output:
			`Watching terminal "${terminalName}" for ${JSON.stringify(normalizeWatchPattern(pattern))} ` +
			`(background task "${started.alias}", times out in ${Math.round(timeoutMs / 1000)}s). ` +
			"End your turn or continue other work; you will be notified with the matching output, or " +
			`when the watch times out or the terminal exits. Stop({ type: "bash", id: "${started.alias}" }) cancels it.`,
		title: terminalName,
	};
}

async function watchTerminal(
	terminalId: string,
	ctx: ToolContext,
	pattern: string,
	timeoutMs: number,
): Promise<ToolResult> {
	const access = await assertTerminalAccess(terminalId, ctx.narratorId);
	if (!access.allowed) return { output: access.error, isError: true };
	const { terminal } = access;
	if (terminal.status === "exited") {
		return { output: "Terminal has exited. Cannot watch it.", isError: true };
	}
	if (!terminalService.isAttached(terminalId) && !(await terminalService.reattach(terminalId))) {
		return { output: "Terminal is not attached (no active PTY connection).", isError: true };
	}
	const buffer = terminalService.getActiveBuffer(terminalId);
	const marker = await buffer?.markCursorRow();
	if (!buffer || !marker) {
		return {
			output:
				"Cannot watch this terminal right now: a full-screen program (alternate screen) is active.",
			isError: true,
		};
	}
	// Only output from now on: skip what the cursor row already shows.
	const { text } = await buffer.readFromMarker(marker);
	return startWatch(terminalId, terminal.name, ctx, pattern, timeoutMs, marker, {
		kind: "offset",
		offset: text.length,
	});
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
	ctx: ToolContext,
	input: string,
	notifyOn?: string,
	timeoutMs = DEFAULT_WATCH_TIMEOUT_MS,
): Promise<ToolResult> {
	const { narratorId, signal } = ctx;
	const access = await assertTerminalAccess(terminalId, narratorId);
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

	// With notify_on, mark the row the input is typed on before writing, so the
	// watch covers all of the command's output however fast it arrives.
	let marker: IMarker | undefined;
	if (notifyOn !== undefined) {
		marker = await terminalService.getActiveBuffer(terminalId)?.markCursorRow();
		if (!marker) {
			return {
				output:
					"Cannot use notify_on right now: a full-screen program (alternate screen) is active. " +
					"Nothing was sent.",
				isError: true,
			};
		}
	}
	let markerOwned = false;
	try {
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
		const body = text.trim() ? text : "(no new output)";

		if (notifyOn !== undefined && marker) {
			const pattern = normalizeWatchPattern(notifyOn);
			const buffer = terminalService.getActiveBuffer(terminalId);
			const fromMarker = buffer ? (await buffer.readFromMarker(marker)).text : "";
			const start = echoEnd(fromMarker, processed);
			if (start !== undefined && fromMarker.indexOf(pattern, start) !== -1) {
				const truncated = truncateOutput(
					`(${JSON.stringify(pattern)} already appeared; no watch was started)\n\n${body}`,
				);
				return {
					output: truncated.content,
					truncated: truncated.truncated,
					title: terminal.name ?? terminalId,
				};
			}
			markerOwned = true;
			const watch = await startWatch(terminalId, terminal.name, ctx, notifyOn, timeoutMs, marker, {
				kind: "echo",
				input: processed,
			});
			const truncated = truncateOutput(`${watch.output}\n\n${body}`);
			return {
				output: truncated.content,
				truncated: truncated.truncated,
				isError: watch.isError,
				title: terminal.name ?? terminalId,
			};
		}

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
	} finally {
		if (!markerOwned) marker?.dispose();
	}
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
