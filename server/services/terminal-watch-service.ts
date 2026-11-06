/**
 * Terminal watches: wait for a text pattern in a terminal without blocking the
 * agent loop.
 *
 * A watch is registered as a background `bash` task owned by the narrator, so
 * it reuses what that machinery already provides: the durable task row,
 * TeamStatus listing, Stop cancellation, and the completion notice that wakes an
 * idle narrator (or waits in its inbox while it is busy). The model starts a
 * watch, ends its turn, and is notified exactly once:
 *
 * - `completed` — the pattern appeared; the notice carries the lines around it.
 * - `timeout`   — the time limit passed; the notice carries the last lines.
 * - `failed`    — the terminal exited, was closed or detached, or the server restarted.
 * - `cancelled` — Stop; like any cancelled task this does not start a turn.
 *
 * Matching runs on the rendered terminal text, not on raw PTY bytes, so ANSI
 * sequences and chunk boundaries cannot split a pattern. The start point is an
 * xterm marker, which follows its row as output scrolls, instead of a character
 * offset that drifts once the scrollback is full. Output only marks a watch
 * dirty; its text is read at most once per {@link CHECK_INTERVAL_MS}, and a
 * terminal without watches pays nothing.
 */

import type { IMarker } from "@xterm/headless";
import { hotSafe } from "../lib/hot-safe";
import { generateShortId } from "../lib/id";
import { logger } from "../lib/logger";
import type { BufferManager } from "../terminal/buffer-manager";
import { registerTaskAlias } from "./subagent-alias";
import { TERMINAL_WATCH_COMMAND_PREFIX } from "./terminal-watch-constants";

/**
 * Loaded on first use: terminal-service imports this module, and the task
 * service pulls in the runtime publication stack, which a terminal that never
 * has a watch does not need.
 */
async function tasks() {
	return (await import("./background-task-service")).backgroundTaskService;
}
/** Minimum gap between two checks of the same watch while output keeps arriving. */
export const CHECK_INTERVAL_MS = 250;
export const DEFAULT_WATCH_TIMEOUT_MS = 10 * 60_000;
export const MIN_WATCH_TIMEOUT_MS = 1_000;
export const MAX_WATCH_TIMEOUT_MS = 60 * 60_000;
/** Watches one narrator may hold at a time. */
export const MAX_WATCHES_PER_NARRATOR = 20;
/** Lines of context sent with a match, before and after the matching line. */
const CONTEXT_LINES_BEFORE = 20;
const CONTEXT_LINES_AFTER = 5;
/** Lines of output sent with a timeout or exit notice. */
const TAIL_LINES = 30;
const MAX_NOTICE_CHARS = 4_000;

/** Where matching starts, relative to the text read from the marker row. */
export type WatchStart =
	/** Skip the terminal's echo of this input (the command line just written). */
	| { kind: "echo"; input: string }
	/** Skip this many characters (text that was already on screen). */
	| { kind: "offset"; offset: number };

interface Watch {
	taskId: string;
	alias: string;
	narratorId: string;
	terminalId: string;
	terminalName: string;
	pattern: string;
	buffer: BufferManager;
	marker: IMarker;
	start: WatchStart;
	/** Resolved start offset; -1 until the echo has been located. */
	skip: number;
	timer: ReturnType<typeof setTimeout>;
	checkTimer?: ReturnType<typeof setTimeout>;
	dirty: boolean;
	checking: boolean;
	lastCheck: number;
	settled: boolean;
}

const watches = hotSafe("narrafork:terminal-watches", () => new Map<string, Watch>());
const byTerminal = hotSafe(
	"narrafork:terminal-watches-by-terminal",
	() => new Map<string, Set<string>>(),
);

const shutdownState = hotSafe("narrafork:terminal-watch-shutdown", () => ({ suspended: false }));

/**
 * Stop settling watches: the server is shutting down. Their task rows stay
 * `running`, and restart recovery tells each session its watch ended, which
 * avoids starting agent turns in a process that is going away.
 */
export function suspendTerminalWatchesForShutdown(): void {
	shutdownState.suspended = true;
	for (const id of [...watches.keys()]) release(id);
}

export function resumeTerminalWatchesForTests(): void {
	shutdownState.suspended = false;
}

/** The rendered text uses "\n" only; treat "\r\n" and a lone "\r" in a pattern as line breaks. */
export function normalizeWatchPattern(pattern: string): string {
	return pattern.replace(/\r\n?/g, "\n");
}

/**
 * Offset just after the terminal's echo of the last command line in `input`,
 * in text read from the row where the input was typed. The echo is skipped so a
 * marker inside the command itself (`cmd; echo __DONE__`) cannot match before
 * the command ran. Returns undefined while the echo has not appeared.
 */
export function echoEnd(text: string, input: string): number | undefined {
	const lines = input
		.split(/\r\n|\r|\n/)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control keys are not echoed verbatim
		.map((line) => line.replace(/[\x00-\x1f\x7f]/g, "").trim())
		.filter((line) => line.length > 0);
	const last = lines.at(-1);
	if (!last) return 0;
	const idx = text.indexOf(last);
	return idx === -1 ? undefined : idx + last.length;
}

/** Lines around the match at `at`, bounded for a notice. */
export function contextAround(text: string, at: number, length: number): string {
	const lineStart = text.lastIndexOf("\n", at - 1) + 1;
	const before = text.slice(0, lineStart).split("\n").slice(0, -1).slice(-CONTEXT_LINES_BEFORE);
	const rest = text.slice(lineStart).split("\n");
	const matchLines = text.slice(lineStart, at + length).split("\n").length;
	const shown = [...before, ...rest.slice(0, matchLines + CONTEXT_LINES_AFTER)];
	return clip(shown.join("\n"));
}

function tailLines(text: string): string {
	return clip(text.split("\n").slice(-TAIL_LINES).join("\n")) || "(empty)";
}

function clip(text: string): string {
	return text.length > MAX_NOTICE_CHARS ? `…${text.slice(-MAX_NOTICE_CHARS)}` : text;
}

export interface StartWatchInput {
	narratorId: string;
	terminalId: string;
	terminalName: string;
	pattern: string;
	timeoutMs: number;
	buffer: BufferManager;
	/** Row the watch reads from; ownership passes to the watch (it disposes it). */
	marker: IMarker;
	start: WatchStart;
	toolUseId?: string;
}

export type StartWatchResult =
	| { status: "started"; taskId: string; alias: string }
	| { status: "error"; message: string };

export async function startTerminalWatch(input: StartWatchInput): Promise<StartWatchResult> {
	let active = 0;
	for (const w of watches.values()) if (w.narratorId === input.narratorId) active++;
	if (active >= MAX_WATCHES_PER_NARRATOR) {
		input.marker.dispose();
		return {
			status: "error",
			message: `This session already has ${active} active terminal watches (limit ${MAX_WATCHES_PER_NARRATOR}). Stop one before starting another.`,
		};
	}
	const pattern = normalizeWatchPattern(input.pattern);
	const taskId = `bash_${generateShortId()}`;
	const title = `watch ${input.terminalName}: ${pattern.slice(0, 40)}`;
	const { alias } = registerTaskAlias(input.narratorId, taskId, title);
	const service = await tasks();
	try {
		await service.createBashTask({
			id: taskId,
			parentNarratorId: input.narratorId,
			command: `${TERMINAL_WATCH_COMMAND_PREFIX} terminal "${input.terminalName}" (${input.terminalId}) for ${JSON.stringify(pattern)}`,
			toolUseId: input.toolUseId,
			alias,
			title,
		});
	} catch (err) {
		input.marker.dispose();
		throw err;
	}

	const watch: Watch = {
		taskId,
		alias,
		narratorId: input.narratorId,
		terminalId: input.terminalId,
		terminalName: input.terminalName,
		pattern,
		buffer: input.buffer,
		marker: input.marker,
		start: input.start,
		skip: input.start.kind === "offset" ? input.start.offset : -1,
		timer: setTimeout(() => void timeOut(taskId), input.timeoutMs),
		dirty: true,
		checking: false,
		lastCheck: 0,
		settled: false,
	};
	watch.timer.unref?.();
	watches.set(taskId, watch);
	let set = byTerminal.get(input.terminalId);
	if (!set) {
		set = new Set();
		byTerminal.set(input.terminalId, set);
	}
	set.add(taskId);
	// Stop aborts the controller, runs the kill handler, then marks the row cancelled.
	const abort = new AbortController();
	service.registerAbortController(taskId, abort);
	service.registerKillHandler(taskId, () => release(taskId));
	abort.signal.addEventListener("abort", () => release(taskId), { once: true });

	// Output that arrived between the marker and now is checked right away.
	scheduleCheck(watch);
	return { status: "started", taskId, alias };
}

/** Called by the terminal service for every output chunk of `terminalId`. */
export function notifyTerminalOutput(terminalId: string): void {
	const ids = byTerminal.get(terminalId);
	if (!ids) return;
	for (const id of ids) {
		const watch = watches.get(id);
		if (watch) scheduleCheck(watch);
	}
}

/**
 * End every watch reading `buffer`, which is about to stop receiving output.
 * Each gets one last match on the final text first, so output that arrived just
 * before the end is not lost. Called before a buffer is disposed (shell exited,
 * terminal closed) and when a terminal is detached from this server process.
 */
export async function endWatchesForBuffer(
	terminalId: string,
	buffer: BufferManager,
	reason: string,
): Promise<void> {
	for (const id of [...(byTerminal.get(terminalId) ?? [])]) {
		const watch = watches.get(id);
		if (!watch || watch.buffer !== buffer) continue;
		if (shutdownState.suspended) {
			release(id);
			continue;
		}
		watch.dirty = true;
		await check(watch);
		if (watch.settled) continue;
		const text = await readText(watch);
		await settle(
			watch,
			"failed",
			`Terminal watch ended: ${reason} before ${JSON.stringify(watch.pattern)} appeared in terminal "${watch.terminalName}". Check the terminal before continuing.\nLast output:\n${tailLines(text)}`,
		);
	}
}

function scheduleCheck(watch: Watch): void {
	watch.dirty = true;
	if (watch.checkTimer || watch.checking || watch.settled) return;
	const wait = Math.max(0, watch.lastCheck + CHECK_INTERVAL_MS - Date.now());
	watch.checkTimer = setTimeout(() => {
		watch.checkTimer = undefined;
		void check(watch);
	}, wait);
	watch.checkTimer.unref?.();
}

async function readText(watch: Watch): Promise<string> {
	return (await watch.buffer.readFromMarker(watch.marker)).text;
}

async function check(watch: Watch): Promise<void> {
	if (watch.settled || watch.checking || !watch.dirty) return;
	watch.checking = true;
	watch.dirty = false;
	watch.lastCheck = Date.now();
	try {
		const { text, markerLost } = await watch.buffer.readFromMarker(watch.marker);
		if (watch.settled) return;
		// The start row scrolled out of the scrollback: everything left is newer.
		if (markerLost) watch.skip = 0;
		if (watch.skip < 0 && watch.start.kind === "echo") {
			const end = echoEnd(text, watch.start.input);
			if (end !== undefined) watch.skip = end;
			// No echo but output has moved on to another line: the input was not
			// echoed (password prompt, `stty -echo`), so match from the start.
			else if (text.includes("\n")) watch.skip = 0;
			else return;
		}
		const at = text.indexOf(watch.pattern, Math.max(0, watch.skip));
		if (at === -1) return;
		await settle(
			watch,
			"completed",
			`${JSON.stringify(watch.pattern)} appeared in terminal "${watch.terminalName}":\n${contextAround(text, at, watch.pattern.length)}`,
		);
	} catch (err) {
		logger.warn("Terminal watch check failed", { taskId: watch.taskId, error: String(err) });
	} finally {
		watch.checking = false;
		if (watch.dirty && !watch.settled) scheduleCheck(watch);
	}
}

async function timeOut(taskId: string): Promise<void> {
	const watch = watches.get(taskId);
	if (!watch || watch.settled) return;
	// A check may be in flight; wait for it rather than racing it.
	while (watch.checking) await new Promise((resolve) => setTimeout(resolve, 10));
	watch.dirty = true;
	await check(watch);
	if (watch.settled) return;
	const text = await readText(watch).catch(() => "");
	await settle(
		watch,
		"timeout",
		`Terminal watch timed out: ${JSON.stringify(watch.pattern)} did not appear in terminal "${watch.terminalName}". The command may still be running.\nLast output:\n${tailLines(text)}`,
	);
}

async function settle(
	watch: Watch,
	status: "completed" | "timeout" | "failed",
	output: string,
): Promise<void> {
	if (watch.settled) return;
	release(watch.taskId);
	try {
		const service = await tasks();
		if (status === "completed") await service.markCompleted(watch.taskId, output);
		else if (status === "timeout") await service.markTimedOut(watch.taskId, output);
		else await service.markFailed(watch.taskId, output);
	} catch (err) {
		logger.error("Terminal watch could not publish its result", {
			taskId: watch.taskId,
			status,
			error: String(err),
		});
	}
}

/** Drop in-memory state. The task row is settled by the caller (or by Stop). */
function release(taskId: string): void {
	const watch = watches.get(taskId);
	if (!watch) return;
	watch.settled = true;
	clearTimeout(watch.timer);
	if (watch.checkTimer) clearTimeout(watch.checkTimer);
	watch.marker.dispose();
	watches.delete(taskId);
	const set = byTerminal.get(watch.terminalId);
	set?.delete(taskId);
	if (set?.size === 0) byTerminal.delete(watch.terminalId);
}

/** Active watch task ids on a terminal. */
export function activeWatchIds(terminalId: string): string[] {
	return [...(byTerminal.get(terminalId) ?? [])];
}
