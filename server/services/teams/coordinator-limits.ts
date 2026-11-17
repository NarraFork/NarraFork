/**
 * A team coordinator's soft limits (docs/PROJECT_TEAMS-PLAN.md §二.2, decision T4; P2).
 *
 * The coordinator's tool calls run exactly as anyone's: nothing is refused, nothing is lost.
 * When a finished call goes over one of the team's suggested values
 * (`TeamSettings.coordinatorLimits`, defaults in `DEFAULT_COORDINATOR_LIMITS`), its result gets
 * one deterministic reminder line per kind exceeded, and one `team_work_events` row per kind
 * (`coordinator.overrun.<kind>`, detail: tool, size, limit) is written after the call returns.
 *
 * WHAT IS MEASURED
 *   - editLines: an Edit's larger side, `max(lines(old_string), lines(new_string))`, and with
 *     `replace_all` at least its line stats (which count every occurrence); a Write (or an Edit
 *     in overwrite mode) of an existing file counts the lines it wrote.
 *   - newFileLines: a Write / overwrite-mode Edit that created the file (its line stats say no
 *     line was removed and every written line was added) counts the lines it wrote.
 *   - filesPerTurn: distinct files changed in the current run by successful Edit, Write and
 *     applied StructSed (`dry_run: false`) calls; every call that adds a file past the limit is
 *     an overrun. Dynamic Spec files do not count, and neither do files a Bash command changes
 *     (a command line does not say which files it wrote).
 *   - readLines (Read), searchLines (Grep, Glob): lines of the result text.
 *   - bashOutputBytes (Bash): UTF-8 bytes of the result text.
 *
 * LARGE OUTPUTS (plan §二.14 "上下文保护"): an output over its suggested size is saved whole in
 * the coordinator's own saved-output directory (`coordinator-outputs.ts`: under the data
 * directory, per narrator, named by content hash, split into parts that one `limit: -1` Read
 * each returns whole), and the result shows its beginning and end, the omitted size, and the
 * path(s). That is a reminder, not a truncation: Read of the narrator's own saved outputs needs no
 * approval, is never cut to lines of 2,000 characters, and is never shortened or reminded again.
 * When the executor's general truncation already saved the full output (over 50 KB), the result
 * points at that file instead of saving the preview again. Nothing is cut — the full text comes
 * back with the reminder — when the call did not run on this server (a remote device: the
 * model's Read of a local path would go there) or the text could not be saved.
 *
 * Only the coordinator itself (a primary narrator with the `team` trait): the orchestrator
 * builds the annotator for it alone, so subagents and every other session are untouched.
 */

import { resolve } from "node:path";
import { hotSafe } from "@server/lib/hot-safe";
import { countTextLines } from "@shared/pretext-layout/diff-core";
import {
	COORDINATOR_OVERRUN_EVENT_PREFIX,
	type CoordinatorLimits,
	type CoordinatorOverrunKind,
	effectiveCoordinatorLimits,
	type TeamSettings,
} from "@shared/project-teams";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { projectTeams, teamWorkEvents } from "../../db/schema";
import { OUTPUT_DIR } from "../../lib/agent/truncate";
import type { ToolResultAnnotationInput } from "../../lib/agent/types";
import { isOwnCoordinatorOutputPath } from "../../lib/coordinator-outputs-path";
import type { Locale } from "../../lib/i18n";
import { generateId } from "../../lib/id";
import { logger } from "../../lib/logger";
import { isInsidePath } from "../../lib/platform-path";
import {
	getCoordinatorOmittedMarker,
	getCoordinatorReminder,
	type SavedOutputNote,
} from "../../lib/prompts/team-coordinator-notes";
import { COORDINATOR_OUTPUT_LIMITS, saveCoordinatorOutput } from "./coordinator-outputs";

/** Bounds of the per-run bookkeeping. */
export const COORDINATOR_LIMIT_BOUNDS = {
	/** Distinct changed files remembered per run; past it the count goes on without paths. */
	filesPerRun: 500,
	/** Overrun rows written per run; reminders go on past it, rows do not. */
	eventsPerRun: 100,
	/** The smallest head / tail shown of a saved output, in bytes. */
	minPreviewBytes: 256,
} as const;

export interface CoordinatorOverrun {
	kind: CoordinatorOverrunKind;
	size: number;
	limit: number;
}

interface RunState {
	files: Set<string>;
	/** Files past `filesPerRun`, counted without their paths. */
	extraFiles: number;
	events: number;
}

const runs = hotSafe<Map<string, RunState>>("narrafork.teams.coordinatorRuns", () => new Map());

function runState(narratorId: string): RunState {
	let state = runs.get(narratorId);
	if (!state) {
		state = { files: new Set(), extraFiles: 0, events: 0 };
		runs.set(narratorId, state);
	}
	return state;
}

/** A coordinator run starts: the files-per-turn count and the run's event budget reset. */
export function beginCoordinatorRun(narratorId: string): void {
	runs.set(narratorId, { files: new Set(), extraFiles: 0, events: 0 });
}

/** Drop a narrator's run bookkeeping (its loop ended for good, or tests). */
export function forgetCoordinatorRun(narratorId: string): void {
	runs.delete(narratorId);
}

/** The team's effective limits: a primary-key read of the settings column. */
export function readCoordinatorLimits(teamId: string): CoordinatorLimits | null {
	const row = db
		.select({ settings: projectTeams.settingsJson })
		.from(projectTeams)
		.where(eq(projectTeams.narratorId, teamId))
		.get();
	if (!row) return null;
	return effectiveCoordinatorLimits((row.settings ?? {}) as TeamSettings);
}

/** Lines in a text: newlines counted without splitting, a last unterminated line included. */
export function countOutputLines(text: string): number {
	if (!text) return 0;
	let lines = 0;
	let index = text.indexOf("\n");
	while (index !== -1) {
		lines++;
		index = text.indexOf("\n", index + 1);
	}
	return text.endsWith("\n") ? lines : lines + 1;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** A whole-file write's size and whether it created the file (from its line stats). */
function wholeFileWrite(
	content: string,
	metadata: Record<string, unknown> | undefined,
): { lines: number; created: boolean } {
	const lines = countTextLines(content);
	const added = num(metadata?.linesAdded);
	const removed = num(metadata?.linesRemoved);
	return { lines, created: removed === 0 && added === lines && lines > 0 };
}

/** A Read of a saved output: the coordinator's own saved results or the general truncation's. */
function isSavedOutputRead(narratorId: string, call: ToolResultAnnotationInput): boolean {
	const filePath = str(call.input.file_path);
	if (!filePath) return false;
	const path = resolve(call.cwd, filePath);
	return isOwnCoordinatorOutputPath(narratorId, path) || isInsidePath(OUTPUT_DIR, path);
}

/** Tools whose successful call changed the file named by `file_path`. */
function changesItsFile(call: ToolResultAnnotationInput): boolean {
	if (call.isError) return false;
	if (call.toolName === "Edit" || call.toolName === "Write") return true;
	return call.toolName === "StructSed" && call.input.dry_run === false;
}

/** The file a successful change made, or null when it does not count for files per turn. */
function changedFile(call: ToolResultAnnotationInput): string | null {
	if (!changesItsFile(call)) return null;
	const filePath = str(call.input.file_path);
	if (!filePath || filePath.startsWith("spec://")) return null;
	return resolve(call.cwd, filePath);
}

/**
 * The limits one finished call went over, in a fixed order. Pure except for the files-per-turn
 * count, which this call updates in the narrator's run state.
 */
export function measureCoordinatorOverruns(
	narratorId: string,
	call: ToolResultAnnotationInput,
	limits: CoordinatorLimits,
): CoordinatorOverrun[] {
	const overruns: CoordinatorOverrun[] = [];
	const over = (kind: CoordinatorOverrunKind, size: number) => {
		if (size > limits[kind]) overruns.push({ kind, size, limit: limits[kind] });
	};
	switch (call.toolName) {
		case "Edit": {
			if (call.isError) break;
			const oldString = str(call.input.old_string) ?? "";
			const newString = str(call.input.new_string) ?? "";
			if (oldString === "") {
				const write = wholeFileWrite(newString, call.metadata);
				over(write.created ? "newFileLines" : "editLines", write.lines);
			} else {
				const sides = Math.max(countTextLines(oldString), countTextLines(newString));
				// `replace_all` changes every occurrence; its line stats count them all.
				const stats =
					call.input.replace_all === true
						? Math.max(num(call.metadata?.linesAdded) ?? 0, num(call.metadata?.linesRemoved) ?? 0)
						: 0;
				over("editLines", Math.max(sides, stats));
			}
			break;
		}
		case "Write": {
			if (call.isError) break;
			const write = wholeFileWrite(str(call.input.content) ?? "", call.metadata);
			over(write.created ? "newFileLines" : "editLines", write.lines);
			break;
		}
		case "Read":
			if (!isSavedOutputRead(narratorId, call)) over("readLines", countOutputLines(call.output));
			break;
		case "Grep":
		case "Glob":
			over("searchLines", countOutputLines(call.output));
			break;
		case "Bash":
			over("bashOutputBytes", Buffer.byteLength(call.output, "utf8"));
			break;
	}
	const file = changedFile(call);
	if (file) {
		const state = runState(narratorId);
		const before = state.files.size + state.extraFiles;
		if (!state.files.has(file)) {
			if (state.files.size < COORDINATOR_LIMIT_BOUNDS.filesPerRun) state.files.add(file);
			else state.extraFiles++;
		}
		const after = state.files.size + state.extraFiles;
		if (after > before) over("filesPerTurn", after);
	}
	return overruns;
}

const OUTPUT_KINDS: ReadonlySet<CoordinatorOverrunKind> = new Set([
	"readLines",
	"searchLines",
	"bashOutputBytes",
]);

/** Cut a string to at most `maxBytes` UTF-8 bytes, from its start or its end. */
function cutBytes(text: string, maxBytes: number, from: "start" | "end"): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const bytes = Buffer.from(text, "utf8");
	let slice = from === "start" ? bytes.subarray(0, maxBytes) : bytes.subarray(-maxBytes);
	// Never split a character: drop continuation bytes at the cut.
	if (from === "start") {
		let end = slice.length;
		while (end > 0 && (slice[end - 1] & 0xc0) === 0x80) end--;
		if (end > 0 && slice[end - 1] >= 0xc0) end--;
		slice = slice.subarray(0, end);
	} else {
		let start = 0;
		while (start < slice.length && (slice[start] & 0xc0) === 0x80) start++;
		slice = slice.subarray(start);
	}
	return slice.toString("utf8");
}

/**
 * The beginning and the end of a text: at most `maxLines` lines and `maxBytes` bytes each,
 * on line boundaries when a whole line fits (a first line too long for the budget is cut).
 * Scans from both ends without splitting the whole text. Deterministic.
 */
export function headAndTail(
	text: string,
	maxLines: number,
	maxBytes: number,
): { head: string; tail: string } {
	// Head: extend line by line from the start.
	let headEnd = 0;
	let headLines = 0;
	while (headLines < maxLines && headEnd < text.length) {
		const newline = text.indexOf("\n", headEnd);
		const next = newline === -1 ? text.length : newline + 1;
		if (headLines > 0 && Buffer.byteLength(text.slice(0, next), "utf8") > maxBytes) break;
		headEnd = next;
		headLines++;
		if (Buffer.byteLength(text.slice(0, headEnd), "utf8") >= maxBytes) break;
	}
	const head = cutBytes(text.slice(0, headEnd).replace(/\n$/, ""), maxBytes, "start");
	// Tail: extend line by line from the end, never into what the head shows (a head cut
	// inside one long line leaves the rest of that line to the tail).
	const floor = head.length < headEnd - 1 ? head.length : headEnd;
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	let tailStart = body.length;
	let tailLines = 0;
	while (tailLines < maxLines && tailStart > floor) {
		// The line before the current tail ends at the newline just before `tailStart`.
		const searchFrom = tailLines === 0 ? body.length - 1 : tailStart - 2;
		const newline = searchFrom < 0 ? -1 : body.lastIndexOf("\n", searchFrom);
		const lineStart = Math.max(newline + 1, floor);
		const size = Buffer.byteLength(body.slice(lineStart), "utf8");
		if (tailLines > 0 && size > maxBytes) break;
		tailStart = lineStart;
		tailLines++;
		if (size >= maxBytes) break;
	}
	const tail = cutBytes(body.slice(tailStart), maxBytes, "end");
	return { head, tail };
}

type OverrunRecorder = (teamId: string, tool: string, overrun: CoordinatorOverrun) => void;

/** Write one overrun row. Synchronous single insert; callers schedule it off the tool path. */
function insertOverrunEvent(teamId: string, tool: string, overrun: CoordinatorOverrun): void {
	db.insert(teamWorkEvents)
		.values({
			id: generateId(),
			teamId,
			workItemId: null,
			kind: `${COORDINATOR_OVERRUN_EVENT_PREFIX}${overrun.kind}`,
			actorKind: "agent",
			actorId: teamId,
			detailJson: { tool, size: overrun.size, limit: overrun.limit },
			createdAt: new Date().toISOString(),
		})
		.run();
}

let recorderSeam: OverrunRecorder | null = null;

/** Replace the event writer (tests); null restores the real one. Returns the previous. */
export function setCoordinatorOverrunRecorder(
	next: OverrunRecorder | null,
): OverrunRecorder | null {
	const previous = recorderSeam;
	recorderSeam = next;
	return previous;
}

/** Record the overruns after the result is handed back: never blocks or fails the call. */
function recordOverruns(teamId: string, tool: string, overruns: CoordinatorOverrun[]): void {
	const state = runState(teamId);
	const allowed = Math.max(0, COORDINATOR_LIMIT_BOUNDS.eventsPerRun - state.events);
	const recorded = overruns.slice(0, allowed);
	if (recorded.length === 0) return;
	state.events += recorded.length;
	const write = recorderSeam ?? insertOverrunEvent;
	setTimeout(() => {
		for (const overrun of recorded) {
			try {
				write(teamId, tool, overrun);
			} catch (error) {
				logger.warn("Could not record a coordinator limit overrun", {
					teamId,
					kind: overrun.kind,
					error: String(error),
				});
			}
		}
	}, 0);
}

export interface CoordinatorAnnotatorOptions {
	/** The coordinator narrator, which is the team id. */
	narratorId: string;
	locale: Locale;
	limits: CoordinatorLimits;
}

/**
 * The `annotateToolResult` of a coordinator's pass. Returns the text to hand back, or null to
 * keep the tool's own text (no limit exceeded).
 */
export function createCoordinatorToolAnnotator(
	options: CoordinatorAnnotatorOptions,
): (call: ToolResultAnnotationInput) => Promise<string | null> {
	const { narratorId, locale, limits } = options;
	return async (call) => {
		const overruns = measureCoordinatorOverruns(narratorId, call, limits);
		if (overruns.length === 0) return null;
		let body = call.output;
		let saved: SavedOutputNote | undefined;
		const output = overruns.find((overrun) => OUTPUT_KINDS.has(overrun.kind));
		// Only a call that ran here: the model's Read of a local path would go to a remote device.
		if (output && call.local) {
			if (call.fullOutputPath) saved = { kind: "existing", path: call.fullOutputPath };
			else {
				const paths = await saveCoordinatorOutput(narratorId, call.output);
				if (paths)
					saved = {
						kind: "saved",
						paths,
						keptMegabytes: COORDINATOR_OUTPUT_LIMITS.bytesPerNarrator / (1024 * 1024),
					};
			}
			if (saved) {
				const sideBytes = Math.max(
					COORDINATOR_LIMIT_BOUNDS.minPreviewBytes,
					Math.floor(limits.bashOutputBytes / 4),
				);
				const sideLines =
					output.kind === "bashOutputBytes"
						? Number.POSITIVE_INFINITY
						: Math.max(1, Math.floor(output.limit / 4));
				const { head, tail } = headAndTail(call.output, sideLines, sideBytes);
				const shownLines = countOutputLines(head) + countOutputLines(tail);
				const omittedLines = Math.max(0, countOutputLines(call.output) - shownLines);
				const omittedBytes = Math.max(
					0,
					Buffer.byteLength(call.output, "utf8") -
						Buffer.byteLength(head, "utf8") -
						Buffer.byteLength(tail, "utf8"),
				);
				body = `${head}\n${getCoordinatorOmittedMarker(omittedLines, omittedBytes, locale)}\n${tail}`;
			}
		}
		const reminders = overruns.map((overrun) =>
			getCoordinatorReminder(
				{
					...overrun,
					tool: call.toolName,
					saved: overrun === output ? saved : undefined,
				},
				locale,
			),
		);
		recordOverruns(narratorId, call.toolName, overruns);
		return `${body}\n\n${reminders.join("\n")}`;
	};
}

/** The annotator for a coordinator's pass, or undefined when the narrator has no team row. */
export function coordinatorToolAnnotatorFor(
	narratorId: string,
	locale: Locale,
): ((call: ToolResultAnnotationInput) => Promise<string | null>) | undefined {
	try {
		const limits = readCoordinatorLimits(narratorId);
		return limits ? createCoordinatorToolAnnotator({ narratorId, locale, limits }) : undefined;
	} catch (error) {
		logger.warn("Could not read a coordinator's limits; no reminders this pass", {
			narratorId,
			error: String(error),
		});
		return undefined;
	}
}
