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
 * - `failed`    — the terminal exited, detached or reflowed, or the server restarted.
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
/** Bounds the per-watch literal prefix table as well as input/notification work. */
export const MAX_WATCH_PATTERN_CHARS = 16_384;
/** Bounded retries for transient failures of the task-result/outbox transaction. */
export const PUBLISH_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;
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
	/** Observed prefix occurrences are excluded even if cursor edits move them. */
	| { kind: "offset"; offset: number; textBefore?: string };

interface WatchResult {
	status: "completed" | "timeout" | "failed";
	output: string;
	attempts: number;
}

interface Watch {
	taskId: string;
	alias: string;
	narratorId: string;
	terminalId: string;
	terminalName: string;
	pattern: string;
	buffer: BufferManager;
	/** Physical row boundaries are unusable after horizontal reflow, including ABA. */
	layoutRevision: number;
	marker: IMarker;
	observedEndMarker?: IMarker;
	disposeMarkers?: () => void;
	prefixUnknown?: boolean;
	renderedMatcher?: ReturnType<typeof createRenderedPatternMatcher>;
	start: WatchStart;
	/** Resolved start offset; -1 until the echo has been located. */
	skip: number;
	timer: ReturnType<typeof setTimeout>;
	checkTimer?: ReturnType<typeof setTimeout>;
	publishTimer?: ReturnType<typeof setTimeout>;
	/** Frozen once observation ends; retained until publication succeeds or is abandoned. */
	result?: WatchResult;
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

interface RenderedMatchScope {
	/** Matches ending after this boundary include definitely newly appended rows. */
	newRegionStart?: number;
	resetHistory?: boolean;
	prefixUnknown?: boolean;
}

function literalPrefixTable(pattern: string): Uint32Array {
	const table = new Uint32Array(pattern.length);
	let prefix = 0;
	for (let i = 1; i < pattern.length; i++) {
		while (prefix > 0 && pattern[i] !== pattern[prefix]) prefix = table[prefix - 1];
		if (pattern[i] === pattern[prefix]) prefix++;
		table[i] = prefix;
	}
	return table;
}

function scanRenderedMatches(
	text: string,
	pattern: string,
	table: Uint32Array,
	excluded: number,
	newRegionStart = Number.POSITIVE_INFINITY,
	prefixUnknown = false,
): { at: number; prefixMatches: number } {
	let matched = 0;
	let prefixMatches = 0;
	for (let i = 0; i < text.length; i++) {
		while (matched > 0 && text[i] !== pattern[matched]) matched = table[matched - 1];
		if (text[i] === pattern[matched]) matched++;
		if (matched !== pattern.length) continue;
		if (i + 1 > newRegionStart) return { at: i + 1 - matched, prefixMatches };
		prefixMatches++;
		if (!prefixUnknown && prefixMatches > excluded) return { at: i + 1 - matched, prefixMatches };
		matched = table[matched - 1];
	}
	return { at: -1, prefixMatches };
}

/**
 * Existing occurrences moving inside an observed prefix are not new output.
 * Appended rows are a separate region: erasing an old match cannot cancel a
 * genuinely new match there. KMP keeps overlapping literals linear and bounded.
 */
export function createRenderedPatternMatcher(pattern: string, observedPrefix: string) {
	if (!pattern.length) return (_text: string, _scope: RenderedMatchScope = {}) => -1;
	const table = literalPrefixTable(pattern);
	let excluded = scanRenderedMatches(
		observedPrefix,
		pattern,
		table,
		Number.POSITIVE_INFINITY,
	).prefixMatches;
	return (text: string, scope: RenderedMatchScope = {}): number => {
		if (scope.resetHistory) excluded = 0;
		const result = scanRenderedMatches(
			text,
			pattern,
			table,
			excluded,
			scope.newRegionStart,
			scope.prefixUnknown,
		);
		if (result.at === -1 && !scope.prefixUnknown)
			excluded = Math.min(excluded, result.prefixMatches);
		return result.at;
	};
}

export interface StartWatchInput {
	narratorId: string;
	terminalId: string;
	terminalName: string;
	pattern: string;
	timeoutMs: number;
	buffer: BufferManager;
	/** Revision captured with the cursor; legacy callers freeze it before task creation. */
	layoutRevision?: number;
	/** Both markers transfer to the watch, including failure/cancellation cleanup. */
	marker: IMarker;
	observedEndMarker?: IMarker;
	disposeMarkers?: () => void;
	prefixUnknown?: boolean;
	start: WatchStart;
	toolUseId?: string;
}

export type StartWatchResult =
	| { status: "started"; taskId: string; alias: string }
	| { status: "error"; message: string };

function disposeWatchMarkers(
	input: Pick<StartWatchInput, "marker" | "observedEndMarker" | "disposeMarkers">,
): void {
	if (input.disposeMarkers) {
		input.disposeMarkers();
		return;
	}
	input.marker.dispose();
	if (input.observedEndMarker !== input.marker) input.observedEndMarker?.dispose();
}

export async function startTerminalWatch(input: StartWatchInput): Promise<StartWatchResult> {
	const layoutRevision = input.layoutRevision ?? input.buffer.layoutRevision;
	let active = 0;
	for (const w of watches.values()) if (w.narratorId === input.narratorId) active++;
	if (active >= MAX_WATCHES_PER_NARRATOR) {
		disposeWatchMarkers(input);
		return {
			status: "error",
			message: `This session already has ${active} active terminal watches (limit ${MAX_WATCHES_PER_NARRATOR}). Stop one before starting another.`,
		};
	}
	// Bound raw input before normalization or scanning, matching the tool schema.
	const tooLong = input.pattern.length > MAX_WATCH_PATTERN_CHARS;
	const pattern = tooLong ? "" : normalizeWatchPattern(input.pattern);
	if (tooLong || !pattern.trim()) {
		disposeWatchMarkers(input);
		return {
			status: "error",
			message: tooLong
				? `Watch pattern exceeds ${MAX_WATCH_PATTERN_CHARS} characters.`
				: "Watch pattern must contain visible text.",
		};
	}
	const taskId = `bash_${generateShortId()}`;
	const title = `watch ${input.terminalName}: ${pattern.slice(0, 40)}`;
	const { alias } = registerTaskAlias(input.narratorId, taskId, title);
	const service = await tasks().catch((error) => {
		disposeWatchMarkers(input);
		throw error;
	});
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
		disposeWatchMarkers(input);
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
		layoutRevision,
		marker: input.marker,
		observedEndMarker: input.observedEndMarker,
		disposeMarkers: input.disposeMarkers,
		prefixUnknown: input.prefixUnknown,
		renderedMatcher:
			input.start.kind === "offset" && input.start.textBefore !== undefined
				? createRenderedPatternMatcher(
						pattern,
						input.start.textBefore.slice(0, Math.max(0, input.start.offset)),
					)
				: undefined,
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
		if (!watch || watch.buffer !== buffer || watch.result) continue;
		if (shutdownState.suspended) {
			release(id);
			continue;
		}
		watch.dirty = true;
		await check(watch);
		if (watch.settled || watch.result) continue;
		const text = await readText(watch);
		await settle(
			watch,
			"failed",
			`Terminal watch ended: ${reason} before ${JSON.stringify(watch.pattern)} appeared in terminal "${watch.terminalName}". Check the terminal before continuing.\nLast output:\n${tailLines(text)}`,
		);
	}
}

function scheduleCheck(watch: Watch): void {
	if (watch.settled || watch.result) return;
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
	if (watch.settled || watch.result || watch.checking || !watch.dirty) return;
	watch.checking = true;
	watch.dirty = false;
	watch.lastCheck = Date.now();
	try {
		const { text, markerLost, observedPrefixEnd } = await watch.buffer.readFromMarker(
			watch.marker,
			watch.observedEndMarker,
		);
		if (watch.settled || watch.result) return;
		// Check after the awaited snapshot too: a resize may race registration or
		// reading, and returning to the same width cannot revive the old frontier.
		if (watch.buffer.layoutRevision !== watch.layoutRevision) {
			await settle(
				watch,
				"failed",
				"Terminal watch ended: terminal layout changed. Read the terminal and register a new watch; do not resend input automatically. The command may still be running.",
			);
			return;
		}
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
		const at = watch.renderedMatcher
			? watch.renderedMatcher(text, {
					newRegionStart: observedPrefixEnd,
					resetHistory: markerLost && (!watch.observedEndMarker || observedPrefixEnd === 0),
					prefixUnknown:
						watch.prefixUnknown ||
						(markerLost && observedPrefixEnd !== 0 && !!watch.observedEndMarker),
				})
			: text.indexOf(watch.pattern, Math.max(0, watch.skip));
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
	if (!watch || watch.settled || watch.result) return;
	// A check may be in flight; wait for it rather than racing it.
	while (watch.checking) await new Promise((resolve) => setTimeout(resolve, 10));
	watch.dirty = true;
	await check(watch);
	if (watch.settled || watch.result) return;
	const text = await readText(watch).catch(() => "");
	await settle(
		watch,
		"timeout",
		`Terminal watch timed out: ${JSON.stringify(watch.pattern)} did not appear in terminal "${watch.terminalName}". The command may still be running.\nLast output:\n${tailLines(text)}`,
	);
}

async function settle(watch: Watch, status: WatchResult["status"], output: string): Promise<void> {
	if (watch.settled || watch.result) return;
	// Stop observing, but keep cancellation/shutdown ownership until the result
	// and its notification have been committed. A failed transaction is retried
	// with this same result, never by reading or executing the command again.
	watch.result = { status, output, attempts: 0 };
	clearTimeout(watch.timer);
	if (watch.checkTimer) clearTimeout(watch.checkTimer);
	watch.checkTimer = undefined;
	await publishResult(watch);
}

async function publishResult(watch: Watch): Promise<void> {
	if (watch.settled || !watch.result) return;
	const result = watch.result;
	result.attempts++;
	try {
		const service = await tasks();
		if (watch.settled) return;
		if (result.status === "completed") await service.markCompleted(watch.taskId, result.output);
		else if (result.status === "timeout") await service.markTimedOut(watch.taskId, result.output);
		else await service.markFailed(watch.taskId, result.output);
		// false means the task is already terminal (for example Stop won).
		release(watch.taskId);
	} catch (err) {
		if (watch.settled) return;
		const delay = PUBLISH_RETRY_DELAYS_MS[result.attempts - 1];
		const details = {
			taskId: watch.taskId,
			terminalId: watch.terminalId,
			status: result.status,
			attempts: result.attempts,
			error: String(err),
		};
		if (delay === undefined) {
			// Keep the durable running task for restart recovery, but do not retry
			// indefinitely or retain a terminal buffer forever on permanent errors.
			logger.error("Terminal watch result publication retries exhausted", details);
			release(watch.taskId);
			return;
		}
		logger.warn("Terminal watch could not publish its result; retrying", {
			...details,
			retryInMs: delay,
		});
		watch.publishTimer = setTimeout(() => {
			watch.publishTimer = undefined;
			void publishResult(watch);
		}, delay);
		watch.publishTimer.unref?.();
	}
}

/** Drop in-memory state. The task row is settled by the caller (or by Stop). */
function release(taskId: string): void {
	const watch = watches.get(taskId);
	if (!watch) return;
	watch.settled = true;
	clearTimeout(watch.timer);
	if (watch.checkTimer) clearTimeout(watch.checkTimer);
	if (watch.publishTimer) clearTimeout(watch.publishTimer);
	disposeWatchMarkers(watch);
	watches.delete(taskId);
	const set = byTerminal.get(watch.terminalId);
	set?.delete(taskId);
	if (set?.size === 0) byTerminal.delete(watch.terminalId);
}

/** Active watch task ids on a terminal. */
export function activeWatchIds(terminalId: string): string[] {
	return [...(byTerminal.get(terminalId) ?? [])];
}
