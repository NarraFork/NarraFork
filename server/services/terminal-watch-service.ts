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
 * - `completed` — the pattern appeared, or a lifecycle-only watch saw exit/close.
 * - `timeout`   — the time limit passed; text watches carry the last observed lines.
 * - `failed`    — the terminal detached, exited before a pattern, or observation was interrupted.
 * - `cancelled` — Stop; like any cancelled task this does not start a turn.
 *
 * Matching runs on the rendered terminal text, not on raw PTY bytes, so ANSI
 * sequences and chunk boundaries cannot split a pattern. The start point is an
 * xterm marker, which follows its row as output scrolls, instead of a character
 * offset that drifts once the scrollback is full. Output only marks a watch
 * dirty; its text is read at most once per {@link CHECK_INTERVAL_MS}, and a
 * terminal without watches pays nothing.
 */

import { formatWatchTarget, TERMINAL_WATCH_DEADLINE_OUTPUT_PREFIX } from "@shared/watch-command";
import type { IMarker } from "@xterm/headless";
import { eventBus } from "../lib/event-bus";
import { hotOnce, hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import type { BufferManager, BufferReadCursor, BufferReadFrame } from "../terminal/buffer-manager";
import {
	type AdoptedWatchRow,
	cancelWatchRegistration,
	createWatchObservation,
	registerWatchObservation,
	resumeWatchObservationsForTests,
	suspendWatchObservationsForShutdown,
	type WatchObservation,
} from "./watch-observation";

/** Minimum gap between two checks of the same watch while output keeps arriving. */
export const CHECK_INTERVAL_MS = 250;
export { DEFAULT_WATCH_TIMEOUT_MS } from "./watch-observation";
export const MIN_WATCH_TIMEOUT_MS = 1_000;
export { MAX_WATCH_TIMEOUT_MS, MAX_WATCHES_PER_NARRATOR } from "./watch-observation";
/** Bounds the per-watch literal prefix table as well as input/notification work. */
export const MAX_WATCH_PATTERN_CHARS = 16_384;
export { PUBLISH_RETRY_DELAYS_MS } from "./watch-observation";

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
	coalesceKey?: string;
}

interface Watch {
	taskId: string;
	alias: string;
	narratorId: string;
	terminalId: string;
	terminalName: string;
	pattern: string;
	observation: WatchObservation;
	/** Lifecycle-only watches need neither a readable normal buffer nor markers. */
	buffer?: BufferManager;
	/** Physical row boundaries are unusable after horizontal reflow, including ABA. */
	layoutRevision?: number;
	marker?: IMarker;
	observedEndMarker?: IMarker;
	disposeMarkers?: () => void;
	prefixUnknown?: boolean;
	cursor?: BufferReadCursor;
	matchFrame?: ReturnType<typeof createWatchFrameMatcher>;
	checkTimer?: ReturnType<typeof setTimeout>;
	/** Frozen once observation ends; delivery ownership then lives in the shared observation. */
	result?: WatchResult;
	dirty: boolean;
	checking: boolean;
	lastCheck: number;
	lastText?: string;
	settled: boolean;
}

const watches = hotSafe("narrafork:terminal-watches", () => new Map<string, Watch>());
const byTerminal = hotSafe(
	"narrafork:terminal-watches-by-terminal",
	() => new Map<string, Set<string>>(),
);

// Disposal may happen while the durable watch task is being created. Retaining the
// reason on the buffer identity closes that registration gap without reading text.
const endedBuffers = hotSafe(
	"narrafork:terminal-watch-ended-buffers",
	() => new WeakMap<BufferManager, string>(),
);
const shutdownState = hotSafe("narrafork:terminal-watch-shutdown", () => ({ suspended: false }));

if (hotOnce("narrafork:terminal-watch-exit")) {
	eventBus.on("terminal:exited", ({ terminalId }) => {
		for (const id of [...(byTerminal.get(terminalId) ?? [])]) {
			const watch = watches.get(id);
			if (watch && !watch.pattern) void settleLifecycle(watch, "the terminal exited or was closed");
		}
	});
}

/**
 * Stop settling watches: the server is shutting down. Their task rows stay
 * `running`, and restart recovery tells each session its watch ended, which
 * avoids starting agent turns in a process that is going away.
 */
export function suspendTerminalWatchesForShutdown(): void {
	shutdownState.suspended = true;
	suspendWatchObservationsForShutdown();
	for (const id of [...watches.keys()]) release(id);
}

export function resumeTerminalWatchesForTests(): void {
	shutdownState.suspended = false;
	resumeWatchObservationsForTests();
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
function lastEchoLine(input: string): string | undefined {
	const lines = input
		.split(/\r\n|\r|\n/)
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control keys are not echoed verbatim
		.map((line) => line.replace(/[\x00-\x1f\x7f]/g, "").trim())
		.filter((line) => line.length > 0);
	return lines.at(-1);
}

export function echoEnd(text: string, input: string): number | undefined {
	const last = lastEchoLine(input);
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
	/** A command echo cannot contribute the beginning of a match. */
	minimumStart?: number;
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
	minimumStart = 0,
): { at: number; prefixMatches: number } {
	let matched = 0;
	let prefixMatches = 0;
	for (let i = 0; i < text.length; i++) {
		while (matched > 0 && text[i] !== pattern[matched]) matched = table[matched - 1];
		if (text[i] === pattern[matched]) matched++;
		if (matched !== pattern.length) continue;
		const eligible = i + 1 - matched >= minimumStart;
		if (eligible && i + 1 > newRegionStart) return { at: i + 1 - matched, prefixMatches };
		prefixMatches++;
		if (eligible && !prefixUnknown && prefixMatches > excluded)
			return { at: i + 1 - matched, prefixMatches };
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
			scope.minimumStart,
		);
		if (result.at === -1 && !scope.prefixUnknown)
			excluded = Math.min(excluded, result.prefixMatches);
		return result.at;
	};
}

export function createWatchFrameMatcher(pattern: string, start: WatchStart) {
	let skip = start.kind === "offset" ? start.offset : -1;
	let clippedEcho = false;
	let partialEcho = false;
	let echoBaseline: string | undefined;
	let allowedEchoTail = "";
	const echoLine = start.kind === "echo" ? lastEchoLine(start.input) : undefined;
	const echoTable = echoLine ? literalPrefixTable(echoLine) : undefined;
	let matcher =
		start.kind === "offset" && start.textBefore !== undefined
			? createRenderedPatternMatcher(pattern, start.textBefore.slice(0, Math.max(0, skip)))
			: undefined;
	return (frame: Exclude<BufferReadFrame, { kind: "error" }>): number => {
		if (frame.kind === "baseline") {
			// The parser produces no output between the old snapshot and this baseline.
			matcher = createRenderedPatternMatcher(pattern, frame.text);
			if (skip >= 0) {
				if (start.kind === "echo") {
					// Reflow can prepend older rows and dispose the original marker.
					// Only retain the unchanged suffix already known to follow the echo;
					// the relocated command itself must stay behind the start boundary.
					let common = 0;
					while (
						common < allowedEchoTail.length &&
						common < frame.text.length &&
						allowedEchoTail[allowedEchoTail.length - common - 1] ===
							frame.text[frame.text.length - common - 1]
					)
						common++;
					skip = frame.text.length - common;
					allowedEchoTail = frame.text.slice(skip);
				} else skip = 0;
			} else {
				clippedEcho ||= partialEcho;
				echoBaseline = frame.text;
			}
			return -1;
		}
		const { text, markerLost, observedPrefixEnd } = frame;
		if (markerLost && skip >= 0) skip = 0;
		if (skip < 0 && start.kind === "echo") {
			// After migration the view includes retained history before the cursor.
			// Never interpret an old command/newline there as this input's echo.
			let changedAt = 0;
			if (echoBaseline !== undefined) {
				while (
					changedAt < text.length &&
					changedAt < echoBaseline.length &&
					text[changedAt] === echoBaseline[changedAt]
				)
					changedAt++;
				if (changedAt === text.length && text.length === echoBaseline.length) return -1;
			}
			const searchAt = Math.max(0, changedAt - (echoLine?.length ?? 0));
			const localEnd = echoEnd(text.slice(searchAt), start.input);
			const end = localEnd === undefined ? undefined : localEnd + searchAt;
			if (end !== undefined) {
				// Wait for the command's line terminator too: READY followed later by
				// a newline must not turn the command echo into a READY\\n result.
				if (
					echoLine &&
					/[\r\n]/.test(start.input) &&
					text.indexOf("\n", Math.max(end, changedAt)) === -1
				) {
					partialEcho = true;
					return -1;
				}
				skip = end;
			} else {
				const newline = text.indexOf("\n", changedAt);
				if (newline !== -1) {
					// Only a known partial echo can justify dropping this line. Without
					// one it may be the first real result in a password/no-echo terminal.
					skip = clippedEcho ? newline + 1 : 0;
				} else {
					let matched = 0;
					if (echoLine && echoTable) {
						for (let i = 0; i < text.length; i++) {
							while (matched > 0 && text[i] !== echoLine[matched]) matched = echoTable[matched - 1];
							if (text[i] === echoLine[matched]) matched++;
							if (matched === echoLine.length) matched = echoTable[matched - 1];
						}
					}
					partialEcho = matched > 0;
					return -1;
				}
			}
			matcher ??= createRenderedPatternMatcher(pattern, text.slice(0, skip));
		}
		if (start.kind === "echo") allowedEchoTail = text.slice(Math.max(0, skip));
		return matcher
			? matcher(text, {
					newRegionStart: observedPrefixEnd,
					resetHistory: markerLost && (observedPrefixEnd === undefined || observedPrefixEnd === 0),
					prefixUnknown:
						frame.prefixUnknown ||
						(markerLost && observedPrefixEnd !== 0 && observedPrefixEnd !== undefined),
					minimumStart: start.kind === "echo" ? skip : 0,
				})
			: text.indexOf(pattern, Math.max(0, skip));
	};
}

export interface StartWatchInput {
	narratorId: string;
	terminalId: string;
	terminalName: string;
	pattern?: string;
	timeoutMs: number;
	buffer?: BufferManager;
	/** Recheck process/connection state around asynchronous lifecycle registration, not terminal text. */
	readLifecycleState?: () => Promise<"running" | "exited" | "disconnected">;
	/** Owns the relocatable markers and queued layout checkpoints. */
	cursor?: BufferReadCursor;
	/** A write may already have consumed frames while waiting for its immediate result. */
	matchFrame?: ReturnType<typeof createWatchFrameMatcher>;
	/** Revision captured with the cursor; legacy callers freeze it before task creation. */
	layoutRevision?: number;
	/** Both markers transfer to the watch, including failure/cancellation cleanup. */
	marker?: IMarker;
	observedEndMarker?: IMarker;
	disposeMarkers?: () => void;
	prefixUnknown?: boolean;
	start?: WatchStart;
	toolUseId?: string;
	/** Only cancels asynchronous registration; an accepted watch outlives its tool call. */
	registrationSignal?: AbortSignal;
	/** Re-attach a lifecycle watch row left by the previous server process. */
	adopt?: AdoptedWatchRow;
	/** Who registers the watch; restart re-attachment re-authorizes as this identity. */
	principal?: { userId: string | null };
}

type TerminalLifecycleService = Pick<
	typeof import("./terminal-service")["terminalService"],
	"isAttached" | "getActiveBuffer"
>;

/**
 * Lifecycle probe shared by the Terminal tool and restart re-attachment: exited is read
 * from the terminal row; a missing row, a detached PTY or a replaced buffer is reported
 * as disconnected, never as an exit.
 */
export function terminalLifecycleReader(
	terminalId: string,
	buffer: BufferManager | undefined,
	service: TerminalLifecycleService,
	readStatus: () => Promise<string | null | undefined>,
): () => Promise<"running" | "exited" | "disconnected"> {
	return async () => {
		const status = await readStatus();
		if (status === "exited") return "exited";
		if (
			status === undefined ||
			!service.isAttached(terminalId) ||
			(buffer && service.getActiveBuffer(terminalId) !== buffer)
		)
			return "disconnected";
		return "running";
	};
}

export type StartWatchResult =
	| {
			status: "started";
			taskId: string;
			alias: string;
			observation: WatchObservation;
			/** This watcher already had the same lifecycle watch; its deadline was extended. */
			reused?: boolean;
			remainingMs: number;
	  }
	| { status: "error"; message: string };

function disposeWatchMarkers(
	input: Pick<StartWatchInput, "marker" | "observedEndMarker" | "disposeMarkers">,
): void {
	if (input.disposeMarkers) {
		input.disposeMarkers();
		return;
	}
	input.marker?.dispose();
	if (input.observedEndMarker !== input.marker) input.observedEndMarker?.dispose();
}

export async function startTerminalWatch(input: StartWatchInput): Promise<StartWatchResult> {
	const layoutRevision = input.pattern
		? (input.layoutRevision ?? input.buffer?.layoutRevision)
		: undefined;
	const tooLong = (input.pattern?.length ?? 0) > MAX_WATCH_PATTERN_CHARS;
	const pattern = tooLong ? "" : normalizeWatchPattern(input.pattern ?? "");
	if (tooLong || (input.pattern !== undefined && !pattern.trim())) {
		disposeWatchMarkers(input);
		return {
			status: "error",
			message: tooLong
				? `Watch pattern exceeds ${MAX_WATCH_PATTERN_CHARS} characters.`
				: "Watch pattern must contain visible text.",
		};
	}
	if (pattern && (!input.buffer || !input.marker || !input.start)) {
		disposeWatchMarkers(input);
		return { status: "error", message: "A text watch requires a live terminal observation." };
	}
	let lifecycleState: "running" | "exited" | "disconnected" | undefined;
	let observation: WatchObservation;
	try {
		if (!pattern) lifecycleState = await input.readLifecycleState?.();
		if (input.registrationSignal?.aborted) {
			disposeWatchMarkers(input);
			return {
				status: "error",
				message: "Watch registration was interrupted; no terminal input was sent.",
			};
		}
		const observationInput = {
			narratorId: input.narratorId,
			title: `watch ${input.terminalName}${pattern ? `: ${pattern.slice(0, 40)}` : ""}`,
			command: formatWatchTarget({
				type: "terminal",
				id: input.terminalId,
				pattern: pattern || undefined,
				timeoutMs: input.timeoutMs,
			}),
			toolUseId: input.toolUseId,
			timeoutMs: input.timeoutMs,
			principal: input.principal,
			onDeadline: () => {
				if (observation) void timeOut(observation.taskId);
			},
			onObservationEnd: () => {
				if (observation) release(observation.taskId);
			},
		};
		if (pattern) {
			// Text watches keep their own read cursors, so only their ending notices merge.
			observation = await createWatchObservation(observationInput);
		} else {
			const registered = await registerWatchObservation({
				...observationInput,
				...(input.adopt ? { adopt: input.adopt } : {}),
				dedupKey: `terminal ${JSON.stringify(input.terminalId)} lifecycle`,
			});
			if (registered.reused) {
				disposeWatchMarkers(input);
				const { taskId, alias } = registered.observation;
				return {
					status: "started",
					taskId,
					alias,
					observation: registered.observation,
					reused: true,
					remainingMs: registered.remainingMs,
				};
			}
			observation = registered.observation;
		}
		if (input.registrationSignal?.aborted) {
			// No source subscription exists yet. Cancel only this new task (and its deadline),
			// before a buffered exit or pattern can publish after registration aborts.
			await cancelWatchRegistration(observation);
			disposeWatchMarkers(input);
			return {
				status: "error",
				message: "Watch registration was interrupted; no terminal input was sent.",
			};
		}
	} catch (error) {
		disposeWatchMarkers(input);
		return { status: "error", message: error instanceof Error ? error.message : String(error) };
	}
	if (observation.signal.aborted) {
		disposeWatchMarkers(input);
		return {
			status: "error",
			message: "Watch registration was interrupted; no terminal input was sent.",
		};
	}
	const { taskId, alias } = observation;
	const watch: Watch = {
		taskId,
		alias,
		narratorId: input.narratorId,
		terminalId: input.terminalId,
		terminalName: input.terminalName,
		pattern,
		observation,
		buffer: input.buffer,
		layoutRevision,
		marker: input.marker,
		observedEndMarker: input.observedEndMarker,
		disposeMarkers: input.disposeMarkers,
		prefixUnknown: input.prefixUnknown,
		cursor: input.cursor,
		matchFrame:
			pattern && input.start
				? (input.matchFrame ?? createWatchFrameMatcher(pattern, input.start))
				: undefined,
		dirty: true,
		checking: false,
		lastCheck: 0,
		settled: false,
	};
	watches.set(taskId, watch);
	let set = byTerminal.get(input.terminalId);
	if (!set) {
		set = new Set();
		byTerminal.set(input.terminalId, set);
	}
	set.add(taskId);
	if (pattern) scheduleCheck(watch);
	else {
		const ended = input.buffer && endedBuffers.get(input.buffer);
		if (ended) await settleLifecycle(watch, ended);
		else {
			try {
				// Subscribe first (above), then recheck: neither an exit during durable
				// task creation nor one racing this read can be missed or published twice.
				if (lifecycleState === undefined || lifecycleState === "running") {
					lifecycleState = await input.readLifecycleState?.();
				}
				if (lifecycleState === "exited") {
					await settleLifecycle(watch, "the terminal exited or was closed");
				} else if (lifecycleState === "disconnected") {
					await settleLifecycle(watch, "the terminal was disconnected from the server");
				}
			} catch (error) {
				await settle(
					watch,
					"failed",
					`Terminal watch ended: lifecycle state could not be verified: ${String(error)}. Check the terminal before continuing.`,
				);
			}
		}
	}
	const remainingMs = input.adopt
		? Math.max(0, input.adopt.deadlineAt - Date.now())
		: input.timeoutMs;
	return { status: "started", taskId, alias, observation, remainingMs };
}

const bufferIds = hotSafe("narrafork:terminal-watch-buffer-ids", () => ({
	ids: new WeakMap<BufferManager, number>(),
	next: 0,
}));

/** A watcher's ending notices for one terminal buffer describe one event: publish it once. */
function endedKey(watch: Watch): string | undefined {
	if (!watch.buffer) return undefined;
	let id = bufferIds.ids.get(watch.buffer);
	if (id === undefined) {
		id = ++bufferIds.next;
		bufferIds.ids.set(watch.buffer, id);
	}
	return `terminal ${JSON.stringify(watch.terminalId)} buffer ${id} ended`;
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
 * End every watch bound to `buffer`, which is about to stop receiving output.
 * Lifecycle watches freeze immediately; text watches get one last match on the
 * final text so output just before the end is not lost. Called before disposal
 * (shell exited, terminal closed) and when detached from this server process.
 */
export async function endWatchesForBuffer(
	terminalId: string,
	buffer: BufferManager,
	reason: string,
): Promise<void> {
	endedBuffers.set(buffer, reason);
	const current = [...(byTerminal.get(terminalId) ?? [])]
		.map((id) => watches.get(id))
		.filter((watch): watch is Watch => !!watch && (!watch.buffer || watch.buffer === buffer));
	// A text read may be stalled. Freeze every lifecycle result before awaiting
	// any of those reads (or publishing), so exit wins over its later deadline.
	for (const watch of current) {
		if (shutdownState.suspended) release(watch.taskId);
		else if (!watch.pattern) void settleLifecycle(watch, reason);
	}
	for (const watch of current) {
		if (watch.settled || watch.result || shutdownState.suspended) continue;
		watch.dirty = true;
		await check(watch);
		if (watch.settled || watch.result) continue;
		const text = await readText(watch);
		await settle(
			watch,
			"failed",
			`Terminal watch ended: ${reason} before ${JSON.stringify(watch.pattern)} appeared in terminal "${watch.terminalName}". Check the terminal before continuing.\nLast output:\n${tailLines(text)}`,
			endedKey(watch),
		);
	}
}

function settleLifecycle(watch: Watch, reason: string): Promise<void> {
	const completed = /exited|closed/.test(reason);
	return settle(
		watch,
		completed ? "completed" : "failed",
		`Terminal watch ended: ${reason} in terminal "${watch.terminalName}". ${completed ? "This observes the terminal lifecycle, not an individual command's success." : "The command may still be running; check the terminal connection before continuing."}`,
		endedKey(watch),
	);
}

function scheduleCheck(watch: Watch): void {
	if (!watch.pattern || watch.settled || watch.result) return;
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
	if (!watch.buffer || !watch.marker) return "";
	return (await watch.buffer.readFromMarker(watch.cursor?.marker ?? watch.marker)).text;
}

async function check(watch: Watch): Promise<void> {
	if (!watch.pattern || !watch.buffer || !watch.marker || !watch.matchFrame) return;
	if (watch.settled || watch.result || watch.checking || !watch.dirty) return;
	watch.checking = true;
	watch.dirty = false;
	watch.lastCheck = Date.now();
	try {
		const frames: BufferReadFrame[] = watch.cursor
			? await watch.buffer.readCursor(watch.cursor)
			: [
					{
						kind: "snapshot",
						...(await watch.buffer.readFromMarker(watch.marker, watch.observedEndMarker)),
						prefixUnknown: watch.prefixUnknown,
					},
				];
		if (watch.settled || watch.result) return;
		// Legacy marker-only clients cannot migrate; all Terminal tool paths use cursors.
		if (!watch.cursor && watch.buffer.layoutRevision !== watch.layoutRevision) {
			await settle(
				watch,
				"failed",
				"Terminal watch ended: its legacy observation expired after a terminal layout change. Read the terminal before continuing; do not resend input automatically.",
			);
			return;
		}
		for (const frame of frames) {
			if (frame.kind === "error") {
				await settle(
					watch,
					"failed",
					`Terminal watch ended: ${frame.message}. Read the terminal before continuing; do not resend input automatically. The command may still be running.`,
				);
				return;
			}
			watch.lastText = tailLines(frame.text);
			const at = watch.matchFrame(frame);
			if (at === -1) continue;
			await settle(
				watch,
				"completed",
				`${JSON.stringify(watch.pattern)} appeared in terminal "${watch.terminalName}":\n${contextAround(frame.text, at, watch.pattern.length)}`,
			);
			return;
		}
	} catch (err) {
		if (!watch.settled && !watch.result) {
			logger.warn("Terminal watch check failed", { taskId: watch.taskId, error: String(err) });
		}
	} finally {
		watch.checking = false;
		if (watch.dirty && !watch.settled) scheduleCheck(watch);
	}
}

async function timeOut(taskId: string): Promise<void> {
	const watch = watches.get(taskId);
	if (!watch || watch.settled || watch.result) return;
	// The deadline must not wait for an in-flight buffer read. Its eventual result
	// cannot replace the frozen timeout; use only the last completed snapshot.
	await settle(
		watch,
		"timeout",
		`${TERMINAL_WATCH_DEADLINE_OUTPUT_PREFIX}: ${watch.pattern ? `${JSON.stringify(watch.pattern)} did not appear in` : "observation reached its deadline for"} terminal "${watch.terminalName}". The command may still be running.${watch.pattern ? `\nLast observed output:\n${watch.lastText ?? "(no completed output snapshot)"}` : ""}`,
	);
}

async function settle(
	watch: Watch,
	status: WatchResult["status"],
	output: string,
	coalesceKey?: string,
): Promise<void> {
	if (watch.settled || watch.result) return;
	// Stop observing, but keep cancellation/shutdown ownership until the result
	// and its notification have been committed. A failed transaction is retried
	// with this same result, never by reading or executing the command again.
	watch.result = { status, output, ...(coalesceKey ? { coalesceKey } : {}) };
	if (watch.checkTimer) clearTimeout(watch.checkTimer);
	watch.checkTimer = undefined;
	await publishResult(watch);
}

async function publishResult(watch: Watch): Promise<void> {
	if (watch.settled || !watch.result) return;
	await watch.observation.finish(watch.result);
}

/** Drop in-memory state. The task row is settled by the caller (or by Stop). */
function release(taskId: string): void {
	const watch = watches.get(taskId);
	if (!watch) return;
	watch.settled = true;
	if (watch.checkTimer) clearTimeout(watch.checkTimer);
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
