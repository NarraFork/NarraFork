import type { IMarker } from "@xterm/headless";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "../../../db";
import { terminals } from "../../../db/schema";
import { terminalService } from "../../../services/terminal-service";
import {
	DEFAULT_WATCH_TIMEOUT_MS,
	echoEnd,
	MAX_WATCH_PATTERN_CHARS,
	MAX_WATCH_TIMEOUT_MS,
	MIN_WATCH_TIMEOUT_MS,
	normalizeWatchPattern,
	startTerminalWatch,
	type WatchStart,
} from "../../../services/terminal-watch-service";
import type { BufferManager, BufferReadCursor } from "../../../terminal/buffer-manager";
import { truncateOutput } from "../truncate";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

/** Successful tool snapshots are the only authority for the next read/watch frontier. */
interface ReadCursorState {
	length?: number;
	buffer?: BufferManager;
	sequence?: number;
	observation?: BufferReadCursor;
}

/** Bounded, process-local cache; expiry has the same first-read/now fallback as reset. */
export const MAX_TERMINAL_READ_CURSORS = 256;
const readCursors = new Map<string, ReadCursorState>();

function cursorKey(narratorId: string, terminalId: string): string {
	return `${narratorId}:${terminalId}`;
}

function discardReadCursor(key: string): void {
	readCursors.get(key)?.observation?.dispose();
	readCursors.delete(key);
}

/** An entry identity is also its generation: deleted/evicted entries cannot be resurrected. */
function beginReadObservation(narratorId: string, terminalId: string) {
	const key = cursorKey(narratorId, terminalId);
	const state: ReadCursorState = readCursors.get(key) ?? {};
	readCursors.delete(key);
	readCursors.set(key, state);
	while (readCursors.size > MAX_TERMINAL_READ_CURSORS) {
		const oldest = readCursors.keys().next().value;
		if (oldest !== undefined) discardReadCursor(oldest);
	}
	let candidate:
		| { buffer: BufferManager; cursor: BufferReadCursor | undefined; sequence: number }
		| undefined;
	return {
		observe(buffer: BufferManager, cursor: BufferReadCursor | undefined, sequence: number) {
			candidate?.cursor?.dispose();
			candidate = { buffer, cursor, sequence };
		},
		previousLength(): number | undefined {
			if (readCursors.get(key) !== state || state.buffer !== candidate?.buffer) return undefined;
			if (!!state.observation !== !!candidate?.cursor) return undefined;
			if (state.observation?.layoutRevision !== candidate?.cursor?.layoutRevision) return undefined;
			return state.length;
		},
		commit(length: number) {
			if (readCursors.get(key) !== state) return;
			const active = terminalService.getActiveBuffer(terminalId);
			if (candidate) {
				if (candidate.buffer !== active) return;
				if (state.buffer === candidate.buffer && (state.sequence ?? -1) > candidate.sequence)
					return;
			} else if (active) {
				// A detached/disk snapshot cannot supersede a live-buffer observation.
				return;
			}
			state.observation?.dispose();
			state.length = length;
			state.buffer = candidate?.buffer;
			state.sequence = candidate?.sequence;
			state.observation = candidate?.cursor;
			candidate = undefined;
		},
		dispose() {
			candidate?.cursor?.dispose();
			candidate = undefined;
		},
	};
}

/** Reattach/reset clears both cursor kinds and invalidates all pending candidates for the key. */
export function resetCursorForTerminal(terminalId: string): void {
	const suffix = `:${terminalId}`;
	for (const key of readCursors.keys()) if (key.endsWith(suffix)) discardReadCursor(key);
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
		"(watch output since this session's last successful read/write, or from now if no cached observation exists). " +
		"Use start_at: 'now' for only the next occurrence. A watch matches text, not a command's exit status; " +
		"unobserved output may include commands typed by a human. Only successful read/write snapshots advance the observation. " +
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
			.max(MAX_WATCH_PATTERN_CHARS)
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
			.max(MAX_WATCH_PATTERN_CHARS)
			.optional()
			.describe(
				"For 'watch': case-sensitive substring of rendered output since this session's last " +
					"successful read/write snapshot. Older observed text is excluded, including occurrences merely moving " +
					"inside its prefix; new appended rows are matched independently. Indistinguishable same-prefix redraws " +
					"are not proof of a new occurrence. With no cached observation, starts now. A horizontal resize " +
					"ends an active watch: read and register a new one without resending input.",
			),
		start_at: z
			.enum(["last_observation", "now"])
			.optional()
			.describe(
				"For 'watch': last_observation (default) includes output that arrived after the last " +
					"successful read/write but before registration. now waits only for the next occurrence. " +
					"Observations expire on reset, reattach, column resize or cache eviction. This is not a command boundary.",
			),
		timeout: looseNumber(
			`For 'watch', and for 'write' with 'notify_on': seconds before the watch gives up and ` +
				`notifies you (default ${DEFAULT_WATCH_TIMEOUT_MS / 1000}, max ${MAX_WATCH_TIMEOUT_MS / 1000}).`,
		),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const {
			action,
			terminal_id,
			input,
			name,
			last_n_lines,
			notify_on,
			pattern,
			timeout,
			start_at,
		} = args as {
			action: "read" | "write" | "watch" | "list" | "create" | "rename";
			terminal_id?: string;
			input?: string;
			name?: string;
			last_n_lines?: number;
			notify_on?: string;
			pattern?: string;
			timeout?: number;
			start_at?: "last_observation" | "now";
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
				if (notify_on !== undefined && notify_on.length > MAX_WATCH_PATTERN_CHARS) {
					return {
						output: `notify_on exceeds ${MAX_WATCH_PATTERN_CHARS} characters. Nothing was sent.`,
						isError: true,
					};
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
				if (pattern && pattern.length > MAX_WATCH_PATTERN_CHARS) {
					return {
						output: `Watch pattern exceeds ${MAX_WATCH_PATTERN_CHARS} characters.`,
						isError: true,
					};
				}
				if (!pattern || normalizeWatchPattern(pattern).trim() === "") {
					return { output: "pattern is required for 'watch' action", isError: true };
				}
				const resolved = await resolveTerminalId(terminal_id, ctx.narratorId);
				if ("error" in resolved) {
					return { output: resolved.error, isError: true };
				}
				return await watchTerminal(resolved.id, ctx, pattern, timeoutMs, start_at);
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
	if (!access.allowed) return { output: access.error, isError: true };
	const { terminal } = access;
	if (signal.aborted) return makeAbortedResult(terminal.name ?? terminalId);
	const observation = beginReadObservation(narratorId, terminalId);
	try {
		const scrollback = await terminalService.getScrollback(terminalId, observation.observe);
		if (signal.aborted) return makeAbortedResult(terminal.name ?? terminalId);
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
			text = tailSlice(fullText, lastNLines, WRITE_TAIL_CHARS);
		} else {
			const cursor = observation.previousLength();
			text = cursor !== undefined && cursor <= fullText.length ? fullText.slice(cursor) : fullText;
			text = tailSlice(text, READ_INCREMENTAL_MAX_LINES, READ_INCREMENTAL_MAX_CHARS);
		}
		let result: ToolResult;
		if (!text.trim()) {
			result = { output: "(no new output since last read)", title: terminal.name ?? terminalId };
		} else {
			const truncated = truncateOutput(text);
			result = {
				output: truncated.content,
				truncated: truncated.truncated,
				title: terminal.name ?? terminalId,
			};
		}
		// Even a tail-only response consumes the complete serialized snapshot, as
		// incremental read did before; a marker cannot describe omitted middle holes.
		observation.commit(fullText.length);
		return result;
	} finally {
		observation.dispose();
	}
}

async function startWatch(
	terminalId: string,
	terminalName: string,
	ctx: ToolContext,
	pattern: string,
	timeoutMs: number,
	buffer: BufferManager,
	marker: IMarker,
	start: WatchStart,
	point?: BufferReadCursor,
): Promise<ToolResult> {
	if (terminalService.getActiveBuffer(terminalId) !== buffer) {
		if (point) point.dispose();
		else marker.dispose();
		return {
			output:
				"Terminal connection changed; no watch was registered. Read the terminal before continuing; do not resend input automatically.",
			isError: true,
		};
	}
	if (point && point.layoutRevision !== buffer.layoutRevision) {
		point.dispose();
		return {
			output:
				"Terminal layout changed; no watch was registered. Read the terminal and register a new watch; do not resend input automatically.",
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
		layoutRevision: point?.layoutRevision,
		marker,
		observedEndMarker: point?.observedEndMarker,
		disposeMarkers: point?.dispose,
		prefixUnknown: point?.prefixUnknown,
		start,
		toolUseId: ctx.currentToolUseId,
	});
	if (started.status === "error") return { output: started.message, isError: true };
	return {
		output:
			`Watching terminal "${terminalName}" for ${JSON.stringify(normalizeWatchPattern(pattern))} ` +
			`(background task "${started.alias}", times out in ${Math.round(timeoutMs / 1000)}s). ` +
			"End your turn or continue other work; you will be notified with the matching output, or " +
			`when the watch times out or the terminal exits or changes layout. Stop({ type: "bash", id: "${started.alias}" }) cancels it.`,
		title: terminalName,
	};
}

async function watchTerminal(
	terminalId: string,
	ctx: ToolContext,
	pattern: string,
	timeoutMs: number,
	startAt: "last_observation" | "now" = "last_observation",
): Promise<ToolResult> {
	const access = await assertTerminalAccess(terminalId, ctx.narratorId);
	if (!access.allowed) return { output: access.error, isError: true };
	const { terminal } = access;
	if (ctx.signal.aborted) return makeAbortedResult(terminal.name);
	if (terminal.status === "exited") {
		return { output: "Terminal has exited. Cannot watch it.", isError: true };
	}
	if (!terminalService.isAttached(terminalId) && !(await terminalService.reattach(terminalId))) {
		return { output: "Terminal is not attached (no active PTY connection).", isError: true };
	}
	const buffer = terminalService.getActiveBuffer(terminalId);
	const key = cursorKey(ctx.narratorId, terminalId);
	const previous = readCursors.get(key);
	if (previous?.buffer && previous.buffer !== buffer) discardReadCursor(key);
	let source = startAt === "now" ? undefined : readCursors.get(key)?.observation;
	if (source && source.layoutRevision !== buffer?.layoutRevision) {
		// A marker tracks rows, not a column inside a reflowed row. Reusing its
		// prefix after horizontal resize could mistake already-observed text for new.
		discardReadCursor(key);
		source = undefined;
	}
	const trimmed = !!source?.marker.isDisposed;
	// Cloning is synchronous and preserves the old prefix. Reading a new baseline
	// here would consume exactly the output in the tool-to-tool registration gap.
	const point = buffer && (source ? buffer.cloneReadCursor(source) : await buffer.markReadCursor());
	if (!buffer || !point) {
		return {
			output:
				"Cannot watch this terminal right now: no live normal buffer is available (a full-screen program may be active).",
			isError: true,
		};
	}
	if (ctx.signal.aborted) {
		point.dispose();
		return makeAbortedResult(terminal.name);
	}
	const result = await startWatch(
		terminalId,
		terminal.name,
		ctx,
		pattern,
		timeoutMs,
		buffer,
		point.marker,
		{
			kind: "offset",
			offset: point.offset,
			textBefore: point.textBefore,
		},
		point,
	);
	if (result.isError) return result;
	const scope = source ? "since the last successful read/write snapshot" : "new output from now";
	return {
		...result,
		output: `${result.output}\nMatching scope: ${scope}.${trimmed ? " Older history was trimmed; only retained output can be matched." : ""}`,
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
	if (!access.allowed) return { output: access.error, isError: true };
	const { terminal } = access;
	if (signal.aborted) return makeAbortedResult(terminal.name ?? terminalId);
	if (terminal.status === "exited") {
		return { output: "Terminal has exited. Cannot send input.", isError: true };
	}
	if (!terminalService.isAttached(terminalId) && !(await terminalService.reattach(terminalId))) {
		return {
			output: "Terminal is not attached (no active PTY connection). Cannot send input.",
			isError: true,
		};
	}
	const echoBuffer =
		notifyOn === undefined ? undefined : terminalService.getActiveBuffer(terminalId);
	const marker = notifyOn === undefined ? undefined : await echoBuffer?.markCursorRow();
	if (notifyOn !== undefined && !marker) {
		return {
			output:
				"Cannot use notify_on right now: a full-screen program (alternate screen) is active. Nothing was sent.",
			isError: true,
		};
	}
	let markerOwned = false;
	let observation: ReturnType<typeof beginReadObservation> | undefined;
	try {
		const beforeSnapshot = await terminalService.getScrollback(terminalId);
		if (signal.aborted) return makeAbortedResult(terminal.name ?? terminalId);
		const beforeLen = beforeSnapshot ? extractPlainText(beforeSnapshot.data).length : 0;
		if (notifyOn !== undefined && terminalService.getActiveBuffer(terminalId) !== echoBuffer) {
			return {
				output: "Terminal connection changed before input. Nothing was sent.",
				isError: true,
			};
		}
		const processed = processEscapes(input);
		terminalService.write(terminalId, processed);
		const deadline = Date.now() + WRITE_SETTLE_TIMEOUT_MS;
		let lastChangeTime = Date.now();
		let lastLen = beforeLen;
		let settled = false;
		while (Date.now() < deadline) {
			if (!(await abortableSleep(WRITE_POLL_INTERVAL_MS, signal))) {
				return makeAbortedResult(terminal.name ?? terminalId);
			}
			const snap = await terminalService.getScrollback(terminalId);
			if (signal.aborted) return makeAbortedResult(terminal.name ?? terminalId);
			const curLen = snap ? extractPlainText(snap.data).length : 0;
			if (curLen !== lastLen) {
				lastLen = curLen;
				lastChangeTime = Date.now();
			} else if (curLen > beforeLen && Date.now() - lastChangeTime >= WRITE_SETTLE_QUIET_MS) {
				settled = true;
				break;
			}
		}
		if (signal.aborted) return makeAbortedResult(terminal.name ?? terminalId);
		// Only this final returned snapshot is an observation, never settling polls.
		observation = beginReadObservation(narratorId, terminalId);
		const afterSnapshot = await terminalService.getScrollback(terminalId, observation.observe);
		if (signal.aborted) return makeAbortedResult(terminal.name ?? terminalId);
		if (!afterSnapshot) {
			return {
				output: `Sent ${processed.length} byte(s) to terminal. No buffer available.`,
				title: terminal.name ?? terminalId,
			};
		}
		const fullText = extractPlainText(afterSnapshot.data);
		let text = beforeLen < fullText.length ? fullText.slice(beforeLen) : fullText;
		text = tailSlice(text, WRITE_TAIL_LINES, WRITE_TAIL_CHARS);
		const body = text.trim() ? text : "(no new output)";
		const finish = (result: ToolResult): ToolResult => {
			if (signal.aborted) return makeAbortedResult(terminal.name ?? terminalId);
			if (!result.isError) observation?.commit(fullText.length);
			return result;
		};
		if (notifyOn !== undefined && marker) {
			if (!echoBuffer || terminalService.getActiveBuffer(terminalId) !== echoBuffer) {
				return {
					output:
						"Input was sent, but the terminal connection changed; no watch was registered. Read the terminal before continuing and do not resend input automatically.",
					isError: true,
					title: terminal.name ?? terminalId,
				};
			}
			const pattern = normalizeWatchPattern(notifyOn);
			const { text: fromMarker } = await echoBuffer.readFromMarker(marker);
			if (signal.aborted) return makeAbortedResult(terminal.name ?? terminalId);
			if (terminalService.getActiveBuffer(terminalId) !== echoBuffer) {
				return {
					output:
						"Input was sent, but the terminal connection changed; no watch was registered. Read the terminal before continuing and do not resend input automatically.",
					isError: true,
					title: terminal.name ?? terminalId,
				};
			}
			const start = echoEnd(fromMarker, processed);
			if (start !== undefined && fromMarker.indexOf(pattern, start) !== -1) {
				const truncated = truncateOutput(
					`(${JSON.stringify(pattern)} already appeared; no watch was started)\n\n${body}`,
				);
				return finish({
					output: truncated.content,
					truncated: truncated.truncated,
					title: terminal.name ?? terminalId,
				});
			}
			markerOwned = true;
			const watch = await startWatch(
				terminalId,
				terminal.name,
				ctx,
				notifyOn,
				timeoutMs,
				echoBuffer,
				marker,
				{
					kind: "echo",
					input: processed,
				},
			);
			const truncated = truncateOutput(`${watch.output}\n\n${body}`);
			return finish({
				output: truncated.content,
				truncated: truncated.truncated,
				isError: watch.isError,
				title: terminal.name ?? terminalId,
			});
		}
		if (!text.trim()) {
			return finish({
				output: `Sent ${processed.length} byte(s) to terminal. (no new output)`,
				title: terminal.name ?? terminalId,
			});
		}
		const header = settled ? "" : "(output may still be in progress)\n\n";
		const truncated = truncateOutput(header + text);
		return finish({
			output: truncated.content,
			truncated: truncated.truncated,
			title: terminal.name ?? terminalId,
		});
	} finally {
		observation?.dispose();
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
