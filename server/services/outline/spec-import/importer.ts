/**
 * The import of a session's Dynamic Spec into the outline (outline P2 PR 12b; PR 12 design §2,
 * owner decisions D52 and D54). One importer behind every trigger (before a run, the idle job,
 * the Spec panel's button; `triggers.ts`), and idempotent: run again, it writes nothing twice.
 *
 * WHICH SESSIONS
 * --------------
 * A root session whose `task_backend` is `spec`, archived ones included. Never a subagent (its
 * spec is its own queue; under the outline it has no tasks, D27c), and never a session provisioned
 * through the external API (its client drives Dynamic Spec). A session that never wrote anything
 * to Dynamic Spec is only moved.
 *
 * WHAT IT DOES, IN ORDER
 * ----------------------
 *   1. Reads the session's current files through the dual-dialect port (`read-port.ts`): pointers
 *      and lengths first, contents a few at a time. More than
 *      {@link SPEC_IMPORT_LIMITS.files} files or {@link SPEC_IMPORT_LIMITS.totalChars} characters
 *      is not imported (needs attention). History is not imported: the current state only.
 *   2. Takes away what an earlier, unfinished attempt wrote from a source that changed since
 *      (the import's short ids of another revision; see `plan.ts`; on the behavior page, the
 *      blocks of another fence text). Only what nobody but the import wrote: a block someone
 *      added to, moved or edited stays where it is, and the session is not moved until a person
 *      looks (needs attention).
 *   3. Notes: every file but `tasks.json` and `behavior_fence` becomes a page (`plan.ts`), its
 *      text converted on the background text worker, as it is (nothing is scanned or repaired).
 *   4. Tasks: `tasks.json` onto the session's task page, in order, then the notes under them.
 *      What is in progress is written to do: nothing is claimed before the move. A task of an
 *      earlier attempt that was deleted since is brought back, and one whose checkbox drifted is
 *      set again: until the session is moved, these blocks are the import's.
 *   5. Verifies the tasks one by one against the source (count, order, text, checkbox, created
 *      by a person, lock, notes). A mismatch moves nothing (needs attention).
 *   6. The behavior fence, once all of the above holds: its own text onto the behavior page with
 *      PR 4's short ids, its plugin SOP whole as that plugin's block (`pluginRulesSid`), so the
 *      session's first run as an outline session and the plugin's later updates find them.
 *   7. Reads the file pointers again: a source that changed since step 1 moves nothing (the next
 *      attempt imports the new state). Then the move: one commit starts what was in progress
 *      (the session's claims), and `task_backend` goes from `spec` to `outline`, conditionally;
 *      should that not happen, the claims are given back. Dynamic Spec rows are untouched.
 *
 * Every write is a system commit of the session through the write path, kind `import`, actor
 * {@link OUTLINE_SPEC_IMPORT_ACTOR}, the session's owner responsible: what lands in the session
 * space is readable by exactly who can read the session, as its Dynamic Spec was.
 *
 * LOAD
 * ----
 * Commits within the ordinary limits (at most {@link SPEC_IMPORT_LIMITS.opsPerCommit} operations
 * and {@link SPEC_IMPORT_LIMITS.bytesPerCommit} of content already normalized off the main
 * thread), the event loop yielded between them; existing short ids looked up
 * {@link SPEC_IMPORT_LIMITS.sidLookup} at a time; files converted one at a time. `signal` is
 * checked between commits (a commit is atomic), so an import cut short (a time limit, a crash)
 * leaves whole commits behind, and the next attempt writes the rest. The idle triggers give an
 * import a time budget and stop it when a message for the session arrives
 * ({@link SpecImportPaused}): the session is `busy` then, not failed, and the next round goes on.
 *
 * While it runs, Dynamic Spec writes to the session are refused and plugins' commands wait
 * (`task-source/backend.ts`).
 */
import { hotSafe } from "@server/lib/hot-safe";
import { getUserLanguage } from "@server/lib/i18n";
import { logger } from "@server/lib/logger";
import type { Locale } from "@server/lib/prompt-i18n";
import { DEFAULTS, settings } from "@server/lib/settings";
import { compareOrderKeys } from "@shared/outline";
import type { OutlineSpecImportReason } from "@shared/outline-spec-import";
import { splitBehaviorFence } from "../../behavior-fence-sop";
import { specIndexSid } from "../../plugin-spec-compat";
import { parseSpecTasksDocument, SPEC_TASKS_PATH, taskTextHash } from "../../spec-task-service";
import { beginSpecImport, invalidateTaskBackend, isSpecImporting } from "../../task-source/backend";
import {
	behaviorImportTagOf,
	behaviorImportTagOfSid,
	findBehaviorPage,
	importBehaviorFenceText,
	OUTLINE_BEHAVIOR_IMPORT_ACTOR,
} from "../../task-source/outline-behavior";
import { writeImportedFenceSop } from "../../task-source/outline-plugin-rules";
import { outlineAccessBackend } from "../access-reads";
import { OUTLINE_EDIT_TEXT_LIMITS, processBackgroundText } from "../edit-text-runner";
import { isOutlineEnabled } from "../feature";
import { OUTLINE_TASKS_PAGE_ALIAS } from "../model";
import { OUTLINE_TASKS_PAGE_TITLE } from "../person-tasks";
import { PluginTaskError, pluginBlockedNoteSid } from "../plugin-tasks";
import { yieldToEventLoop } from "../session-scope";
import { outlineStore } from "../store";
import type { OutlineBlockMeta, OutlineSpaceRow } from "../store/port";
import type { OutlineStructureRow } from "../store/read-port";
import {
	type OutlineBlockRef,
	type OutlineCanonicalContent,
	type OutlineOp,
	writeOutline,
} from "../write";
import {
	fileTagOfSid,
	isImportSid,
	type NormalizedTaskText,
	OUTLINE_SPEC_IMPORT_ACTOR,
	planSpecFile,
	planSpecTasks,
	SPEC_IMPORT_TEXT,
	type SpecImportExpectedTask,
	type SpecImportNode,
	type SpecImportTask,
	type SpecImportTaskPlan,
	specFileCodeLang,
	specFileTag,
} from "./plan";
import {
	readSpecFilePointers,
	readSpecImportSession,
	readSpecProtectors,
	readSpecRevisionContents,
	SPEC_IMPORT_READ_LIMITS,
	type SpecImportFilePointer,
	type SpecImportSession,
	switchSessionToOutline,
} from "./read-port";

export const SPEC_IMPORT_LIMITS = {
	/** Current files of one session imported; more is not imported at all. */
	files: 200,
	/** Characters of all current files of one session. */
	totalChars: 8_000_000,
	/** Operations of one commit (the write path takes 200). */
	opsPerCommit: 150,
	/** UTF-8 bytes of content in one commit (the write path takes 128 KiB). */
	bytesPerCommit: 96 * 1024,
	/** Short ids one lookup of what is in the space already asks for. */
	sidLookup: 400,
	/** Stale blocks of an earlier attempt one commit deletes (tasks; a page goes alone). */
	staleDeletesPerCommit: 20,
	/** Pages of the session space looked at for an earlier attempt's pages. */
	stalePages: 500,
	/** Children of the task page (and of the index page) looked at likewise. */
	staleChildren: 1000,
	/** Blocks of one stale subtree read to see who wrote them; more: kept (attention). */
	staleSubtreeBlocks: 1600,
	/** Distinct commits of one stale subtree looked up; more: kept (attention). */
	staleCommits: 200,
	/** Characters of a failure kept for the Spec panel. */
	errorChars: 300,
	/** Sessions whose last import is remembered (least recently touched dropped first). */
	remembered: 4096,
} as const;

export type SpecImportTrigger = "run" | "sweep" | "manual";

type SpecImportMode = "auto" | "manual" | "off";

function isMode(value: unknown): value is SpecImportMode {
	return value === "auto" || value === "manual" || value === "off";
}

/**
 * How Dynamic Spec sessions are imported (`outline.specImport`; the shipped default is the one
 * in `DEFAULTS`); `off` while the outline is.
 */
export function specImportMode(): SpecImportMode {
	if (!isOutlineEnabled()) return "off";
	const mode = settings.outline?.specImport;
	if (isMode(mode)) return mode;
	const fallback = DEFAULTS.outline.specImport;
	return isMode(fallback) ? fallback : "manual";
}

export type SpecImportOutcome =
	/** The session is an outline session now. `commits` is what this attempt wrote. */
	| {
			status: "imported";
			tasks: number;
			pages: number;
			/** Files whose current revision cannot be read (a fork whose parent is gone). */
			unreadable: number;
			commits: number;
	  }
	/** Nothing to do: `reason` says why the session is not one the import moves. */
	| { status: "skipped"; reason: "outline" | "subagent" | "external" | "missing" | "off" }
	/**
	 * The session is running, or another import of it is, or the import gave way to the session
	 * (its time budget, a message for it; {@link SpecImportPaused}): what it wrote stays, and the
	 * next attempt goes on from there.
	 */
	| { status: "busy" }
	/**
	 * Not moved. `attention`: trying again will not help until someone looks (too large, a
	 * `tasks.json` that does not parse, a mismatch); otherwise the next attempt may succeed.
	 */
	| { status: "failed"; error: string; attention: boolean };

/** The last import of a session, as the Spec panel shows it. Kept in memory (see `rememberedOf`). */
export interface SpecImportRecord {
	/** `busy`: the session was busy, or the import gave way to it; another attempt will go on. */
	status: "running" | "imported" | "failed" | "attention" | "busy";
	trigger: SpecImportTrigger;
	at: string;
	/** Attempts in this process that failed (the idle job gives up after a few). */
	failures: number;
	/** Why the last attempt did not move the session (English, as logged). */
	error?: string;
	/** The same, as the Spec panel says it in the reader's language. */
	reason?: OutlineSpecImportReason;
	tasks?: number;
	pages?: number;
}

/**
 * Remembered per process: the result of an import is in the outline itself (the session's
 * column, its blocks), and what failed is found again by the next attempt, so nothing is stored.
 * After a restart a session that needed attention is tried again (a bounded number of times).
 */
const records = hotSafe(
	"narrafork.outline.specImport.records",
	() => new Map<string, SpecImportRecord>(),
);
const running = hotSafe(
	"narrafork.outline.specImport.running",
	() => new Map<string, Promise<SpecImportOutcome>>(),
);

function remember(narratorId: string, record: SpecImportRecord): void {
	records.delete(narratorId);
	records.set(narratorId, record);
	while (records.size > SPEC_IMPORT_LIMITS.remembered) {
		const oldest = records.keys().next().value;
		if (oldest === undefined) break;
		records.delete(oldest);
	}
}

export function specImportRecord(narratorId: string): SpecImportRecord | null {
	return records.get(narratorId) ?? null;
}

/** Forget what is remembered (tests). */
export function resetSpecImportRecords(): void {
	records.clear();
}

/** Why a session is not imported, or null when it is one the import moves. */
export function specImportSkipReason(
	session: SpecImportSession | null,
): Extract<SpecImportOutcome, { status: "skipped" }>["reason"] | null {
	if (!session) return "missing";
	if (session.type === "subagent") return "subagent";
	if (session.taskBackend !== "spec") return "outline";
	if (session.external) return "external";
	return null;
}

/** An import that cannot succeed until someone looks; `reason` is what the Spec panel says. */
class SpecImportAttention extends Error {
	constructor(
		message: string,
		readonly reason: OutlineSpecImportReason,
	) {
		super(message);
	}
}

/** An attempt that did not move the session, which another attempt may (a known reason). */
class SpecImportRetry extends Error {
	constructor(
		message: string,
		readonly reason: OutlineSpecImportReason,
	) {
		super(message);
	}
}

/**
 * The reason an idle trigger aborts an import with: it gave way to the session (its time budget
 * ran out, or a message for the session arrived). Not a failure: the outcome is `busy`, the
 * attempt counts nothing against the session, and the next one writes the rest.
 */
export class SpecImportPaused extends Error {
	/**
	 * `urgent` (a message arrived): honoured at the next commit boundary. Otherwise (a time
	 * budget) honoured once the attempt made a commit, so every attempt gets somewhere even when
	 * converting one file takes longer than the budget.
	 */
	constructor(
		message: string,
		readonly urgent = false,
	) {
		super(message);
	}
}

export interface SpecImportOptions {
	trigger: SpecImportTrigger;
	/**
	 * Checked between commits and passed to the text conversions; an abort leaves what was
	 * committed and moves nothing (with a {@link SpecImportPaused} reason the outcome is `busy`).
	 */
	signal?: AbortSignal;
	/**
	 * Giving way to the session ({@link SpecImportPaused} as the reason): looked at between
	 * commits only, never cutting a conversion short, as that reason says.
	 */
	pause?: AbortSignal;
	/**
	 * Take the session for the import without interrupting it: resolves to a release function, or
	 * rejects when the session (or one of its subagents) is busy. Absent: the caller holds the
	 * session already (the start of its own run).
	 */
	admit?: (narratorId: string) => Promise<() => void>;
	/** Whether the session is running now (its claims then stay on the running lease). */
	isRunning?: (narratorId: string) => boolean;
	/** Called once the session was moved (the caller tells its clients). */
	onMoved?: (narratorId: string) => void;
	/** Only sessions this small are imported (the start of a run); larger ones are left `busy`. */
	smallOnly?: { files: number; chars: number };
}

/**
 * Import a session's Dynamic Spec and move it to the outline (see the module header). Never
 * rejects: what happened is the outcome, remembered for the Spec panel.
 */
export async function importSpecSession(
	narratorId: string,
	options: SpecImportOptions,
): Promise<SpecImportOutcome> {
	if (specImportMode() === "off") return { status: "skipped", reason: "off" };
	const current = running.get(narratorId);
	if (current) return options.trigger === "manual" ? await current : { status: "busy" };
	const run = attempt(narratorId, options).finally(() => running.delete(narratorId));
	running.set(narratorId, run);
	return await run;
}

async function attempt(narratorId: string, options: SpecImportOptions): Promise<SpecImportOutcome> {
	const previous = records.get(narratorId);
	let release: (() => void) | null = null;
	let unguard: (() => void) | null = null;
	const started = performance.now();
	try {
		const session = await readSpecImportSession(narratorId);
		const skip = specImportSkipReason(session);
		if (skip || !session) return { status: "skipped", reason: skip ?? "missing" };
		const pointers = session.namespaceId ? await readSpecFilePointers(session.namespaceId) : [];
		if (options.smallOnly && tooLargeFor(pointers, options.smallOnly)) return { status: "busy" };
		if (options.admit) {
			try {
				release = await options.admit(narratorId);
			} catch {
				rememberBusy(narratorId, options.trigger, previous);
				return { status: "busy" };
			}
		}
		if (isSpecImporting(narratorId)) return { status: "busy" };
		unguard = beginSpecImport(narratorId);
		remember(narratorId, {
			status: "running",
			trigger: options.trigger,
			at: new Date().toISOString(),
			failures: previous?.failures ?? 0,
		});
		const outcome = await run(session, pointers, options);
		remember(narratorId, {
			status: "imported",
			trigger: options.trigger,
			at: new Date().toISOString(),
			failures: 0,
			tasks: outcome.tasks,
			pages: outcome.pages,
		});
		logger.info("Dynamic Spec session imported into the outline", {
			narratorId,
			trigger: options.trigger,
			tasks: outcome.tasks,
			pages: outcome.pages,
			commits: outcome.commits,
			unreadable: outcome.unreadable,
			elapsedMs: Math.round(performance.now() - started),
		});
		return outcome;
	} catch (error) {
		if (
			error instanceof SpecImportPaused ||
			(options.signal?.aborted === true && options.signal.reason instanceof SpecImportPaused)
		) {
			const reason = error instanceof SpecImportPaused ? error : options.signal?.reason;
			rememberBusy(narratorId, options.trigger, previous);
			logger.info("Dynamic Spec import gave way to its session; the next attempt goes on", {
				narratorId,
				trigger: options.trigger,
				reason: String(reason),
				elapsedMs: Math.round(performance.now() - started),
			});
			return { status: "busy" };
		}
		const attention = error instanceof SpecImportAttention;
		const reason: OutlineSpecImportReason =
			error instanceof SpecImportAttention || error instanceof SpecImportRetry
				? error.reason
				: { code: "other" };
		const message = (error instanceof Error ? error.message : String(error)).slice(
			0,
			SPEC_IMPORT_LIMITS.errorChars,
		);
		remember(narratorId, {
			status: attention ? "attention" : "failed",
			trigger: options.trigger,
			at: new Date().toISOString(),
			failures: (previous?.failures ?? 0) + 1,
			error: message,
			reason,
		});
		logger.warn("Dynamic Spec import did not move a session", {
			narratorId,
			trigger: options.trigger,
			attention,
			error: message,
		});
		return { status: "failed", error: message, attention };
	} finally {
		unguard?.();
		release?.();
	}
}

/** A busy attempt: remembered as such, counting nothing against the session. */
function rememberBusy(
	narratorId: string,
	trigger: SpecImportTrigger,
	previous: SpecImportRecord | undefined,
): void {
	remember(narratorId, {
		status: "busy",
		trigger,
		at: new Date().toISOString(),
		failures: previous?.failures ?? 0,
	});
}

/** The files the import reads content of: live, written, readable. */
function importable(pointers: readonly SpecImportFilePointer[]): SpecImportFilePointer[] {
	return pointers.filter((p) => !p.deleted && p.revisionId !== null);
}

function tooLargeFor(
	pointers: readonly SpecImportFilePointer[],
	limit: { files: number; chars: number },
): boolean {
	const files = importable(pointers);
	return (
		files.length > limit.files || files.reduce((sum, p) => sum + (p.chars ?? 0), 0) > limit.chars
	);
}

interface Context {
	session: SpecImportSession;
	space: OutlineSpaceRow;
	locale: Locale;
	signal: AbortSignal | undefined;
	pause: AbortSignal | undefined;
	commits: number;
}

/** What the steps before the move leave for it. */
interface Written {
	tasks: number;
	pages: number;
	/** Tasks the move starts (block ids): in progress in the source, to do until then. */
	start: string[];
}

async function run(
	session: SpecImportSession,
	pointers: readonly SpecImportFilePointer[],
	options: SpecImportOptions,
): Promise<Extract<SpecImportOutcome, { status: "imported" }>> {
	const { narratorId } = session;
	const files = importable(pointers);
	const unreadable = pointers.filter((p) => p.revisionId === null).length;
	if (pointers.length >= SPEC_IMPORT_READ_LIMITS.files || files.length > SPEC_IMPORT_LIMITS.files)
		throw new SpecImportAttention(
			`The session holds more than ${SPEC_IMPORT_LIMITS.files} Dynamic Spec files`,
			{ code: "too_many_files", count: SPEC_IMPORT_LIMITS.files },
		);
	if (
		tooLargeFor(pointers, { files: SPEC_IMPORT_LIMITS.files, chars: SPEC_IMPORT_LIMITS.totalChars })
	)
		throw new SpecImportAttention(
			`The session's Dynamic Spec files hold more than ${SPEC_IMPORT_LIMITS.totalChars} characters`,
			{ code: "too_large", count: SPEC_IMPORT_LIMITS.totalChars },
		);

	let written: Written = { tasks: 0, pages: 0, start: [] };
	let ctx: Context | null = null;
	if (files.length > 0) {
		const locale: Locale = session.ownerUserId
			? await getUserLanguage(session.ownerUserId).catch(() => "en" as const)
			: "en";
		const space = await outlineStore.ensureSpace(
			{ kind: "session", narratorId },
			new Date().toISOString(),
		);
		ctx = { session, space, locale, signal: options.signal, pause: options.pause, commits: 0 };
		written = await writeEverything(ctx, files);
	}

	// Moved only when what was read is still what is there, and the outline still on.
	options.signal?.throwIfAborted();
	if (specImportMode() === "off")
		throw new SpecImportRetry("The outline was switched off during the import", { code: "off" });
	if (session.namespaceId) {
		const now = await readSpecFilePointers(session.namespaceId);
		if (pointerKey(now) !== pointerKey(pointers))
			throw new SpecImportRetry("The session's Dynamic Spec changed during the import", {
				code: "changed",
			});
	}
	await move(ctx, narratorId, written.start);
	invalidateTaskBackend(narratorId);
	await afterMove(session, options);
	return {
		status: "imported",
		tasks: written.tasks,
		pages: written.pages,
		unreadable,
		commits: ctx?.commits ?? 0,
	};
}

/**
 * Step 7: start what was in progress (one commit: the session's claims, by the write path) and
 * move the session. Between the two only the move itself is waited on; should the session not
 * be moved by this attempt, the claims are given back, so an import that does not move a
 * session leaves it holding nothing.
 */
async function move(
	ctx: Context | null,
	narratorId: string,
	start: readonly string[],
): Promise<void> {
	let started: string[] = [];
	if (ctx && start.length > 0) {
		const metas = await outlineStore.getBlockMetas(ctx.space.id, { ids: start });
		const todo = metas
			.filter((meta) => !meta.deleted && meta.taskJson?.status === "todo")
			.map((meta) => meta.id);
		if (todo.length > 0) {
			await commit(
				ctx,
				todo.map((id) => ({ op: "setTask" as const, block: { id }, task: { status: "doing" } })),
				todo.map(() => null),
				SPEC_IMPORT_TEXT[ctx.locale].summaryStart(todo.length),
			);
			started = todo;
		}
		const claims = new Map(
			(await outlineStore.getTaskClaims(start)).map((row) => [row.taskBlockId, row]),
		);
		const unclaimed = start.filter((id) => claims.get(id)?.holderNarratorId !== narratorId);
		if (unclaimed.length > 0) {
			await giveBack(ctx, started);
			throw new SpecImportAttention(
				`${unclaimed.length} task(s) in progress could not be started by the session`,
				{ code: "not_started", count: unclaimed.length },
			);
		}
	}
	let moved: boolean;
	try {
		moved = await switchSessionToOutline(narratorId);
	} catch (error) {
		await giveBack(ctx, started);
		throw error;
	}
	if (moved) return;
	invalidateTaskBackend(narratorId);
	// Moved by someone else meanwhile (another import): the tasks are its in-progress work now.
	const now = await readSpecImportSession(narratorId).catch(() => null);
	if (now?.taskBackend !== "outline") await giveBack(ctx, started);
	throw new SpecImportRetry(
		"The session was no longer a Dynamic Spec session when the import ended",
		{ code: "moved_elsewhere" },
	);
}

/** Put back to do what the move started (its claims released); never rejects. */
async function giveBack(ctx: Context | null, started: readonly string[]): Promise<void> {
	if (!ctx || started.length === 0) return;
	try {
		await commit(
			ctx,
			started.map((id) => ({ op: "setTask" as const, block: { id }, task: { status: "todo" } })),
			started.map(() => null),
			SPEC_IMPORT_TEXT[ctx.locale].summaryGiveBack(started.length),
			{ ignoreSignal: true },
		);
	} catch (error) {
		// Its lease runs out instead (the lease keeper renews no Dynamic Spec session's claims).
		logger.warn("Could not give back the tasks an unfinished Dynamic Spec import started", {
			narratorId: ctx.session.narratorId,
			tasks: started.length,
			error: String(error),
		});
	}
}

function pointerKey(pointers: readonly SpecImportFilePointer[]): string {
	return pointers
		.map((p) => `${p.path}\u0000${p.revisionId ?? ""}\u0000${p.deleted ? 1 : 0}`)
		.sort()
		.join("\n");
}

/** After the move, best effort: nothing here can undo it, and each step is repeated later. */
async function afterMove(session: SpecImportSession, options: SpecImportOptions): Promise<void> {
	const { narratorId } = session;
	try {
		// A session that is not running keeps what it is doing on the idle lease (D41), as the end
		// of a run would leave it; its next run renews it.
		if (!(options.isRunning?.(narratorId) ?? false)) {
			const { idleOutlineTaskClaims } = await import("../tasks");
			await idleOutlineTaskClaims(narratorId);
		}
	} catch (error) {
		logger.warn("Could not put an imported session's tasks on the idle lease", {
			narratorId,
			error: String(error),
		});
	}
	// The old fence still holds what step 5 copied: emptied through the paths that own it (PR 4's
	// import finds its text on the page and leaves only the SOP; 12a's move finds the plugin's
	// block and drops the SOP), so nothing shows twice. They never reject. Dynamic Spec is
	// written through the SQLite handle only: on PostgreSQL the old fence stays as it is.
	if (outlineAccessBackend() === "sqlite") {
		const locale: Locale = session.ownerUserId
			? await getUserLanguage(session.ownerUserId).catch(() => "en" as const)
			: "en";
		const { importOutlineBehaviorFence } = await import("../../task-source/outline-behavior");
		await importOutlineBehaviorFence(narratorId, locale);
		const { moveOutlineFenceSop } = await import("../../task-source/outline-plugin-rules");
		await moveOutlineFenceSop(narratorId);
	}
	try {
		options.onMoved?.(narratorId);
	} catch (error) {
		logger.warn("Could not announce an imported session", { narratorId, error: String(error) });
	}
}

/** Steps 2 to 6 of the module header. */
async function writeEverything(
	ctx: Context,
	files: readonly SpecImportFilePointer[],
): Promise<Written> {
	const { session, locale } = ctx;
	const { narratorId } = session;
	const tasksFile = files.find((p) => p.path === SPEC_TASKS_PATH) ?? null;
	const fenceFile = files.find((p) => p.path === "behavior_fence") ?? null;
	const notes = files.filter((p) => p !== tasksFile && p !== fenceFile);

	// The fence first in memory: its own text is parsed like PR 4's import parses it, and a text
	// past that parse's limit cannot be imported until someone shortens it (needs attention once,
	// before anything is written, rather than failing every attempt after writing the rest).
	let fence: { own: string; sop: string } | null = null;
	if (fenceFile?.revisionId) {
		const content =
			(await readSpecRevisionContents([fenceFile.revisionId])).get(fenceFile.revisionId) ?? "";
		const split = splitBehaviorFence(content);
		fence = { own: split.own, sop: split.sop };
		if (Buffer.byteLength(fence.own, "utf8") > OUTLINE_EDIT_TEXT_LIMITS.maxBytes)
			throw new SpecImportAttention(
				`The behavior fence's own text is larger than the ${OUTLINE_EDIT_TEXT_LIMITS.maxBytes / 1024} KiB its import reads`,
				{ code: "fence_too_large", count: OUTLINE_EDIT_TEXT_LIMITS.maxBytes / 1024 },
			);
	}

	// The tasks next in memory (their plan decides what is stale), written after the notes.
	let taskPlan: SpecImportTaskPlan | null = null;
	let brokenTasks: string | null = null;
	if (tasksFile?.revisionId) {
		const content =
			(await readSpecRevisionContents([tasksFile.revisionId])).get(tasksFile.revisionId) ?? "";
		let tasks: SpecImportTask[] | null = null;
		try {
			tasks = parseSpecTasksDocument(content).tasks.map((task) => ({
				text: task.text,
				status: task.status,
				protected: task.protected === true,
			}));
		} catch {
			// Written before tasks.json was validated: kept as a page, the session not moved.
			brokenTasks = content;
		}
		if (tasks) {
			const protectors = session.namespaceId
				? await readSpecProtectors(session.namespaceId)
				: { byHash: new Map(), truncated: false };
			if (protectors.truncated)
				logger.warn(
					"Dynamic Spec import read only part of a session's protected-task locks; the protected tasks it did not read are taken as a person's (locked)",
					{ narratorId, read: SPEC_IMPORT_READ_LIMITS.locks },
				);
			taskPlan = planSpecTasks({
				narratorId,
				revisionId: tasksFile.revisionId,
				tasks,
				normalized: await normalizeTasks(tasks, ctx.signal),
				// Not read (or not found): "unknown", which locks like a person's protection.
				protectors: tasks.map((task) =>
					task.protected ? (protectors.byHash.get(taskTextHash(task.text)) ?? "unknown") : null,
				),
				ownerUserId: session.ownerUserId,
				archived: session.archived,
				locale,
				blockedNoteSid: pluginBlockedNoteSid,
			});
		}
	}

	// What an earlier attempt wrote from another source goes first (step 2).
	const notePointers: Array<SpecImportFilePointer & { revisionId: string }> = notes.flatMap((p) =>
		p.revisionId ? [{ ...p, revisionId: p.revisionId }] : [],
	);
	const keep = new Set(
		[...notePointers, ...(brokenTasks !== null && tasksFile?.revisionId ? [tasksFile] : [])].map(
			(p) => specFileTag(narratorId, p.path, p.revisionId as string),
		),
	);
	const kept = await removeStale(ctx, {
		keepFileTags: keep,
		taskSidPrefix: taskPlan?.sidPrefix ?? null,
		fenceTag: fence ? behaviorImportTagOf(fence.own) : null,
		indexMd: notePointers.some((p) => p.path === "index.md"),
	});

	// Notes: a few files' contents read at a time, each converted and written before the next, so
	// the converted blocks of one file are held at a time, never the whole session's.
	let pages = 0;
	const writeFile = async (path: string, revisionId: string, text: string) => {
		giveWay(ctx);
		const converted = await processBackgroundText(
			{
				kind: "notes",
				text,
				continued: SPEC_IMPORT_TEXT[locale].continued,
				code: specFileCodeLang(path),
			},
			{ signal: ctx.signal },
		);
		const plan = planSpecFile({
			narratorId,
			path,
			revisionId,
			blocks: converted.blocks,
			locale,
			...(path === "index.md" ? { pageSid: specIndexSid() } : {}),
		});
		pages += plan.pageSids.length;
		await writeNodes(ctx, plan.nodes, null, SPEC_IMPORT_TEXT[locale].summaryNotes(path));
	};
	for (const batch of contentBatches(notePointers)) {
		const contents = await readSpecRevisionContents(batch.map((p) => p.revisionId));
		for (const pointer of batch)
			await writeFile(pointer.path, pointer.revisionId, contents.get(pointer.revisionId) ?? "");
	}
	if (brokenTasks !== null && tasksFile?.revisionId)
		await writeFile(SPEC_TASKS_PATH, tasksFile.revisionId, brokenTasks);

	let start: string[] = [];
	if (taskPlan && taskPlan.tasks.length > 0) {
		const pageId = await ensureTasksPage(ctx);
		const summary = SPEC_IMPORT_TEXT[locale].summaryTasks(taskPlan.tasks.length);
		await writeNodes(ctx, taskPlan.tasks, { id: pageId }, summary, { heal: true });
		await writeNodes(ctx, taskPlan.notes, null, summary);
		start = await verifyTasks(ctx, taskPlan.expected, pageId);
	}
	if (brokenTasks !== null)
		throw new SpecImportAttention(
			"tasks.json is not a valid task list: it was imported as a page, the session was not moved",
			{ code: "broken_tasks" },
		);
	if (kept > 0)
		throw new SpecImportAttention(
			`${kept} block(s) an earlier, unfinished import wrote hold what someone added or changed since: they were kept; move what is yours out of them (or delete them), then import again`,
			{ code: "kept_blocks", count: kept },
		);

	// Step 6, once everything above holds: the fence text goes onto the behavior page last, so an
	// attempt that does not get this far leaves nothing of a fence that may still change.
	if (fence?.own)
		await importBehaviorFenceText(narratorId, locale, fence.own, { signal: ctx.signal });
	if (fence?.sop.trim()) {
		ctx.signal?.throwIfAborted();
		try {
			await writeImportedFenceSop(
				{ narratorId, ownerUserId: session.ownerUserId, locale },
				fence.sop,
			);
		} catch (error) {
			if (error instanceof PluginTaskError && error.publicCode === "PAYLOAD_TOO_LARGE")
				throw new SpecImportAttention(error.message, { code: "sop_too_large" });
			throw error;
		}
	}
	return { tasks: taskPlan?.tasks.length ?? 0, pages, start };
}

function contentBatches<T extends { chars: number | null }>(files: readonly T[]): T[][] {
	const out: T[][] = [];
	let batch: T[] = [];
	let chars = 0;
	for (const file of files) {
		const size = file.chars ?? 0;
		if (
			batch.length > 0 &&
			(batch.length >= SPEC_IMPORT_READ_LIMITS.contentsPerRead ||
				chars + size > SPEC_IMPORT_READ_LIMITS.contentCharsPerRead)
		) {
			out.push(batch);
			batch = [];
			chars = 0;
		}
		batch.push(file);
		chars += size;
	}
	if (batch.length > 0) out.push(batch);
	return out;
}

/**
 * The tasks' texts as the import writes them, worked out off the main thread past the inline
 * size: kept as written (`importTaskText` in `edit-text.ts`), canonical when that is the text
 * itself so `/goal` and the plugin commands dedupe against it. Null: a text of several paragraphs,
 * left to the write path, which splits it the same way a `/goal` of that text is split.
 */
async function normalizeTasks(
	tasks: readonly SpecImportTask[],
	signal: AbortSignal | undefined,
): Promise<Array<NormalizedTaskText | null>> {
	if (tasks.length === 0) return [];
	const texts = await processBackgroundText(
		{ kind: "taskTexts", contents: tasks.map((task) => task.text) },
		{ signal },
	);
	return tasks.map((_, i) => texts[i] ?? null);
}

async function existingBySid(
	space: OutlineSpaceRow,
	sids: readonly string[],
): Promise<Map<string, OutlineBlockMeta>> {
	const out = new Map<string, OutlineBlockMeta>();
	for (let i = 0; i < sids.length; i += SPEC_IMPORT_LIMITS.sidLookup) {
		const chunk = sids.slice(i, i + SPEC_IMPORT_LIMITS.sidLookup);
		for (const meta of await outlineStore.getBlockMetas(space.id, { sids: chunk }))
			out.set(meta.sid, meta);
	}
	return out;
}

async function commit(
	ctx: Context,
	ops: OutlineOp[],
	canonical: Array<OutlineCanonicalContent | null>,
	summary: string,
	options: { ignoreSignal?: boolean } = {},
) {
	if (!options.ignoreSignal) {
		ctx.signal?.throwIfAborted();
		giveWay(ctx);
	}
	const started = performance.now();
	const result = await writeOutline(
		{
			spaceId: ctx.space.id,
			ops,
			actor: { kind: "system", id: OUTLINE_SPEC_IMPORT_ACTOR },
			responsibleUserId: ctx.session.ownerUserId,
			narratorId: ctx.session.narratorId,
			summary,
		},
		{ kind: "import", canonical },
	);
	if (result.commit) ctx.commits++;
	const elapsed = performance.now() - started;
	if (elapsed > 100)
		logger.warn("A Dynamic Spec import commit was slow", {
			narratorId: ctx.session.narratorId,
			ops: ops.length,
			elapsedMs: Math.round(elapsed),
		});
	await yieldToEventLoop();
	return result;
}

/** Give way to the session when asked to (see {@link SpecImportPaused}). */
function giveWay(ctx: Context): void {
	const reason: unknown = ctx.pause?.aborted ? ctx.pause.reason : null;
	if (reason instanceof SpecImportPaused && (reason.urgent || ctx.commits > 0)) throw reason;
}

/**
 * Write the nodes that are not in the space yet, parents first, in as many commits as the limits
 * need. A node with no parent hangs from `root` (null: it is a page). What is there already is
 * skipped, and so is everything under a block deleted since (a person's choice), unless `heal`:
 * then a deleted block is brought back and a task that drifted from its plan is set again (the
 * tasks, which must be all there for the session to move).
 */
async function writeNodes(
	ctx: Context,
	nodes: readonly SpecImportNode[],
	root: OutlineBlockRef | null,
	summary: string,
	options: { heal?: boolean } = {},
): Promise<void> {
	if (nodes.length === 0) return;
	const existing = await existingBySid(
		ctx.space,
		nodes.map((node) => node.sid),
	);
	const skipped = new Set<string>();
	let ops: OutlineOp[] = [];
	let canonical: Array<OutlineCanonicalContent | null> = [];
	let inCommit = new Set<string>();
	let bytes = 0;
	const flush = async () => {
		if (ops.length === 0) return;
		await commit(ctx, ops, canonical, summary);
		ops = [];
		canonical = [];
		inCommit = new Set();
		bytes = 0;
	};
	for (const node of nodes) {
		if (node.parentSid !== null && skipped.has(node.parentSid)) {
			skipped.add(node.sid);
			continue;
		}
		const found = existing.get(node.sid);
		const parent: OutlineBlockRef | null =
			node.parentSid === null
				? root
				: inCommit.has(node.parentSid)
					? { tempId: node.parentSid }
					: { sid: node.parentSid };
		let op: OutlineOp | null = null;
		if (!found) {
			op = {
				op: "insert",
				tempId: node.sid,
				sid: node.sid,
				...(node.id ? { id: node.id } : {}),
				parent,
				content: node.content,
				...(node.task ? { task: node.task } : {}),
			};
		} else if (found.deleted) {
			if (!options.heal) {
				skipped.add(node.sid);
				continue;
			}
			op = {
				op: "restore",
				block: { id: found.id },
				parent,
				content: node.content,
				...(node.task ? { task: node.task } : {}),
			};
		} else if (options.heal && node.task && drifted(found, node)) {
			op = {
				op: "setTask",
				block: { id: found.id },
				task: { status: node.task.status, humanCreated: node.task.humanCreated ?? null },
			};
		}
		if (!op) continue;
		const size = op.op === "setTask" ? 0 : Buffer.byteLength(node.content, "utf8");
		if (
			ops.length >= SPEC_IMPORT_LIMITS.opsPerCommit ||
			(ops.length > 0 && bytes + size > SPEC_IMPORT_LIMITS.bytesPerCommit)
		) {
			await flush();
			// The parent was written by the commit just made: named by its short id now.
			if ("parent" in op && node.parentSid !== null) op.parent = { sid: node.parentSid };
		}
		ops.push(op);
		canonical.push(
			op.op !== "setTask" && node.links ? { content: node.content, links: node.links } : null,
		);
		if (op.op === "insert") inCommit.add(node.sid);
		bytes += size;
	}
	await flush();
}

/**
 * A task of an earlier attempt whose checkbox or person mark is no longer the plan's. A task the
 * move starts may read in progress already (an attempt that started it and stopped before the
 * move): that is not a drift, and setting it back would be a commit on every attempt.
 */
function drifted(found: OutlineBlockMeta, node: SpecImportNode): boolean {
	const now = found.taskJson;
	if (!now || !node.task) return true;
	const status = now.status === node.task.status || (node.start === true && now.status === "doing");
	return !status || (now.humanCreated === true) !== (node.task.humanCreated === true);
}

async function ensureTasksPage(ctx: Context): Promise<string> {
	const [owner] = await outlineStore.findAliasOwners(ctx.space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
	if (owner) return owner.id;
	const result = await commit(
		ctx,
		[
			{
				op: "insert",
				parent: null,
				content: OUTLINE_TASKS_PAGE_TITLE[ctx.locale === "zh-CN" ? "zh-CN" : "en"],
				alias: OUTLINE_TASKS_PAGE_ALIAS,
			},
		],
		[null],
		SPEC_IMPORT_TEXT[ctx.locale].summaryTasksPage,
	);
	const pageId = result.results[0]?.blockId;
	if (!pageId) throw new Error("the import could not create the task page");
	return pageId;
}

/** The actors whose commits are the import's own: this import, and PR 4's fence import it calls. */
const IMPORT_ACTORS: ReadonlySet<string> = new Set([
	OUTLINE_SPEC_IMPORT_ACTOR,
	OUTLINE_BEHAVIOR_IMPORT_ACTOR,
]);

interface StaleBlock {
	id: string;
	versionSeq: number;
	/** A page (deleted in a commit of its own, read whole); else a block and what is under it. */
	page: boolean;
}

/**
 * Take away what an earlier attempt wrote from a source that is not the one read now: the
 * import's tasks of another `tasks.json` revision on the task page (their notes go with them),
 * its pages of other file revisions (the `index.md` page when that file is gone), its blocks of
 * another `index.md` revision on the index page, and on the behavior page its blocks of another
 * fence text. Only the import's own short ids are looked at, only before the session is moved,
 * and only what nobody else wrote is taken away: a stale block someone added to, moved or edited
 * since ({@link onlyImportWrote}) is kept as it is, and counted (the caller does not move the
 * session then). Bounded reads; a page goes in a commit of its own. Returns how many were kept.
 */
async function removeStale(
	ctx: Context,
	current: {
		keepFileTags: ReadonlySet<string>;
		taskSidPrefix: string | null;
		/** The tag of the fence text read now (null: no fence text). */
		fenceTag: string | null;
		/** `index.md` is among the files read now. */
		indexMd: boolean;
	},
): Promise<number> {
	const { space } = ctx;
	const limits = SPEC_IMPORT_LIMITS;
	const stale: StaleBlock[] = [];
	const block = (meta: OutlineBlockMeta, page = false): StaleBlock => ({
		id: meta.id,
		versionSeq: meta.versionSeq,
		page,
	});
	const [tasksPage] = await outlineStore.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
	if (tasksPage) {
		for (const meta of await outlineStore.listLastChildMetas(
			space.id,
			tasksPage.id,
			limits.staleChildren,
		)) {
			if (!meta.sid.startsWith("st") || !isImportSid(meta.sid)) continue;
			if (current.taskSidPrefix === null || !meta.sid.startsWith(current.taskSidPrefix))
				stale.push(block(meta));
		}
	}
	const [index] = await outlineStore.getBlockMetas(space.id, { sids: [specIndexSid()] });
	if (index && !index.deleted) {
		// The file is gone: its page goes too, rather than staying behind empty.
		if (!current.indexMd) stale.push(block(index, true));
		else
			for (const meta of await outlineStore.listLastChildMetas(
				space.id,
				index.id,
				limits.staleChildren,
			)) {
				if (
					meta.sid.startsWith("sb") &&
					isImportSid(meta.sid) &&
					!current.keepFileTags.has(fileTagOfSid(meta.sid))
				)
					stale.push(block(meta));
			}
	}
	const stalePages: string[] = [];
	let after: { orderKey: string; id: string } | null = null;
	for (let read = 0; read < limits.stalePages; ) {
		const page = await outlineStore.listSpacePages(space.id, { after, limit: 100 });
		for (const row of page) {
			if (
				row.sid.startsWith("sp") &&
				isImportSid(row.sid) &&
				!current.keepFileTags.has(fileTagOfSid(row.sid))
			)
				stalePages.push(row.id);
		}
		read += page.length;
		const last = page[page.length - 1];
		if (page.length < 100 || !last) break;
		after = { orderKey: last.orderKey, id: last.id };
	}
	for (let i = 0; i < stalePages.length; i += limits.sidLookup)
		for (const meta of await outlineStore.getBlockMetas(space.id, {
			ids: stalePages.slice(i, i + limits.sidLookup),
		}))
			if (!meta.deleted) stale.push(block(meta, true));
	const behavior = await findBehaviorPage(space.id);
	if (behavior) {
		for (const meta of await outlineStore.listLastChildMetas(
			space.id,
			behavior.id,
			limits.staleChildren,
		)) {
			const tag = behaviorImportTagOfSid(meta.sid);
			if (tag !== null && tag !== current.fenceTag) stale.push(block(meta));
		}
	}

	const removable: StaleBlock[] = [];
	let kept = 0;
	for (const entry of stale) {
		if (await onlyImportWrote(space, entry)) removable.push(entry);
		else kept++;
	}
	if (kept > 0)
		logger.warn("Dynamic Spec import kept blocks of an earlier attempt that others wrote to", {
			narratorId: ctx.session.narratorId,
			kept,
		});
	const summary = SPEC_IMPORT_TEXT[ctx.locale].summaryStale;
	const blocks = removable.filter((entry) => !entry.page).map((entry) => entry.id);
	for (let i = 0; i < blocks.length; i += limits.staleDeletesPerCommit) {
		const ids = blocks.slice(i, i + limits.staleDeletesPerCommit);
		await commit(
			ctx,
			ids.map((id) => ({ op: "delete" as const, block: { id } })),
			ids.map(() => null),
			summary,
		);
	}
	for (const entry of removable)
		if (entry.page) await commit(ctx, [{ op: "delete", block: { id: entry.id } }], [null], summary);
	return kept;
}

/**
 * Whether only the import wrote what is under `root` now, itself included: every live block's
 * current version was opened by one of the import's commits. A block someone added, moved there
 * or edited was not. Bounded: at most {@link SPEC_IMPORT_LIMITS.staleSubtreeBlocks} blocks read
 * without content, and {@link SPEC_IMPORT_LIMITS.staleCommits} commits by seq; past either, false
 * (kept: it cannot tell).
 */
async function onlyImportWrote(space: OutlineSpaceRow, root: StaleBlock): Promise<boolean> {
	const limit = SPEC_IMPORT_LIMITS.staleSubtreeBlocks;
	const seqs = new Set<number>([root.versionSeq]);
	const add = (rows: ReadonlyArray<Pick<OutlineStructureRow, "versionSeq">>) => {
		for (const row of rows) seqs.add(row.versionSeq);
	};
	if (root.page) {
		const { rows, truncated } = await outlineStore.listPageStructure(root.id, {
			asOf: null,
			limit,
		});
		if (truncated) return false;
		add(rows);
	} else {
		let level = [root.id];
		let seen = 0;
		while (level.length > 0) {
			const next: string[] = [];
			for (let i = 0; i < level.length; i += SPEC_IMPORT_LIMITS.sidLookup) {
				const children = await outlineStore.listChildMetas(
					space.id,
					level.slice(i, i + SPEC_IMPORT_LIMITS.sidLookup),
					limit - seen + 1,
				);
				seen += children.length;
				if (seen > limit) return false;
				add(children);
				next.push(...children.map((child) => child.id));
			}
			level = next;
		}
	}
	if (seqs.size > SPEC_IMPORT_LIMITS.staleCommits) return false;
	const wanted = [...seqs];
	let found = 0;
	for (let i = 0; i < wanted.length; i += 100) {
		for (const row of await outlineStore.getCommitsBySeqs(space.id, wanted.slice(i, i + 100))) {
			if (row.actorKind !== "system" || !IMPORT_ACTORS.has(row.actorId)) return false;
			found++;
		}
	}
	return found === wanted.length;
}

/**
 * The imported tasks against the source, one by one (PR 12 design §2.5, step 1): all there, live,
 * on the task page in the source's order, with the planned text, checkbox, person mark and lock;
 * every note under its task. A task the move starts reads to do, or in progress already (an
 * attempt that started it and stopped before the move; the move checks its claim). Bounded: the
 * tasks (at most 100) by short id, their contents by id. A mismatch rejects (needs attention).
 * Returns the block ids of the tasks the move starts.
 */
async function verifyTasks(
	ctx: Context,
	expected: readonly SpecImportExpectedTask[],
	tasksPageId: string,
): Promise<string[]> {
	const { space, session } = ctx;
	const fail = (index: number, what: string): never => {
		throw new SpecImportAttention(`Imported task ${index + 1} does not match its source: ${what}`, {
			code: "task_mismatch",
			count: index + 1,
		});
	};
	const metas = await existingBySid(
		space,
		expected.flatMap((task) => [task.sid, ...task.noteSids]),
	);
	const tasks = expected.map((task, i) => {
		const meta = metas.get(task.sid);
		if (!meta || meta.deleted) return fail(i, "it is missing");
		return meta;
	});
	const contents = new Map(
		(await outlineStore.getBlocks(tasks.map((meta) => meta.id))).map((row) => [
			row.id,
			row.content,
		]),
	);
	for (const [i, task] of expected.entries()) {
		const meta = tasks[i] as OutlineBlockMeta;
		const json = meta.taskJson;
		if (meta.parentId !== tasksPageId) fail(i, "it is not on the task page");
		const before = i > 0 ? (tasks[i - 1] as OutlineBlockMeta) : null;
		if (before && compareOrderKeys(before.orderKey, meta.orderKey) >= 0) fail(i, "its order");
		if (!json) return fail(i, "it is not a task");
		if (json.status !== task.status && !(task.start && json.status === "doing"))
			fail(i, `its checkbox is ${json.status}`);
		if ((json.humanCreated === true) !== task.humanCreated) fail(i, "its protection");
		const lockedByOwner = json.lock?.by.kind === "human" && json.lock.by.id === session.ownerUserId;
		if (lockedByOwner !== task.locked) fail(i, "its lock");
		if (task.content !== null && contents.get(meta.id) !== task.content) fail(i, "its text");
		for (const sid of task.noteSids) {
			const note = metas.get(sid);
			// A note a person deleted since is their choice; one that was never written is not.
			if (!note || (!note.deleted && note.parentId !== meta.id)) fail(i, "a note under it");
		}
	}
	return expected.flatMap((task, i) => (task.start ? [(tasks[i] as OutlineBlockMeta).id] : []));
}
