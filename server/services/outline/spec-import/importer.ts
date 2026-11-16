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
 *      (the import's short ids of another revision; see `plan.ts`; under the behavior boundary,
 *      the blocks of another fence text). Only what nobody but the import ever wrote: when a block
 *      someone added to, moved or edited (at any time) is among them, nothing is taken away or
 *      written, and the session is not moved until a person looks (needs attention).
 *   3. Notes: every file but `tasks.json` and `behavior_fence` becomes a top-level block
 *      (`plan.ts`), its text converted on the background text worker, as it is (nothing is
 *      scanned or repaired), under it however large, in as many bounded commits as it takes.
 *   4. Tasks: `tasks.json` into the session's task list (`session/tasks`), in order, then the
 *      notes under them.
 *      What is in progress is written to do: nothing is claimed before the move. A task of an
 *      earlier attempt that the import itself deleted or left drifted is brought back or set
 *      again; one anyone else deleted or changed is left as they left it (step 5 then fails on
 *      it), so no import version hides their change.
 *   5. Verifies the tasks one by one against the source (count, order, text, checkbox, created
 *      by a person, lock, notes). A mismatch moves nothing (needs attention).
 *   6. The behavior fence, once all of the above holds: its own text under the behavior boundary
 *      (`session/behavior`) with
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
import { createHash } from "node:crypto";
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
	findBehaviorBlock,
	importBehaviorFenceText,
	OUTLINE_BEHAVIOR_IMPORT_ACTOR,
} from "../../task-source/outline-behavior";
import { writeImportedFenceSop } from "../../task-source/outline-plugin-rules";
import { outlineAccessBackend } from "../access-reads";
import { OUTLINE_EDIT_TEXT_LIMITS, processBackgroundText } from "../edit-text-runner";
import { OutlineWriteError } from "../errors";
import { isOutlineEnabled } from "../feature";
import { forgetSpecImportLeftover } from "../lease-keeper";
import { OUTLINE_LIMITS, OUTLINE_TASKS_PAGE_ALIAS } from "../model";
import { OUTLINE_TASKS_PAGE_TITLE } from "../person-tasks";
import { PluginTaskError, pluginBlockedNoteSid } from "../plugin-tasks";
import { yieldToEventLoop } from "../session-scope";
import { outlineStore } from "../store";
import type { OutlineLevelCursor } from "../store/history-port";
import type { OutlineBlockMeta, OutlineCommitRow, OutlineSpaceRow } from "../store/port";
import { OutlineStaleWriteError } from "../store/port";
import { findTasksBlock } from "../well-known";
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
	OUTLINE_SPEC_LOSS_ACTOR,
	OUTLINE_SPEC_REVERT_ACTOR,
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
import {
	cachedSpecImportState,
	readSpecImportState,
	resetSpecImportStateCache,
	type SpecImportState,
	writeSpecImportState,
} from "./state";

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
	/** Stale blocks of an earlier attempt one commit deletes at most (the write path's limit). */
	staleDeletesPerCommit: OUTLINE_LIMITS.maxOps,
	/**
	 * Blocks one commit of the stale removal deletes, with everything under them: a stale file
	 * block larger than this goes in several commits, from the bottom up (the write path takes
	 * 2,000 rows a commit, links included).
	 */
	staleDeleteBlocks: 1000,
	/**
	 * Top-level blocks of the session space looked at for an earlier attempt's file blocks, a
	 * level read at a time; a space holding more needs attention (`stale_limit`), never an import
	 * that leaves old content behind.
	 */
	staleTopLevel: 5000,
	/** Children of the index block looked at likewise (a level of up to 2,000, and groups). */
	staleIndexChildren: 5000,
	/** Rows of one level read at a time by those scans. */
	staleLevelRead: 200,
	/** Children of the task list looked at for an earlier attempt's tasks (the last ones). */
	staleChildren: 1000,
	/** Live blocks of one stale subtree read to plan its removal; more: kept (attention). */
	staleSubtreeBlocks: 20_000,
	/**
	 * Distinct commits that changed anything ever under one stale block (its change marks above
	 * the history floor) looked up; more: kept (attention).
	 */
	staleCommits: 1000,
	/** Versions of a stale block itself read (its own changes are not marks); more: kept. */
	staleRootVersions: 64,
	/** Characters of a failure kept for the Spec panel. */
	errorChars: 300,
} as const;

/** Part pages of a file an attempt before pages went may have left (`sp<tag>p<n>`), looked for. */
const SPEC_IMPORT_LEGACY_PARTS = 256;

/** `admin`: an administrator's re-import (the only trigger that moves a moved-back session). */
export type SpecImportTrigger = "run" | "sweep" | "manual" | "admin";

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
			/** Files imported as notes (one top-level block each). */
			notes: number;
			/** Files whose current revision cannot be read (a fork whose parent is gone). */
			unreadable: number;
			commits: number;
	  }
	/** Nothing to do: `reason` says why the session is not one the import moves. */
	| {
			status: "skipped";
			/** `reverted`: an administrator moved it back to Dynamic Spec; only they import it again. */
			reason: "outline" | "subagent" | "external" | "missing" | "off" | "reverted";
	  }
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

/** The last import of a session, as the Spec panel shows it (from `state.ts`). */
export interface SpecImportRecord {
	/**
	 * `busy`: the session was busy, or the import gave way to it; another attempt will go on.
	 * `reverted`: an administrator moved the session back to Dynamic Spec.
	 */
	status: "running" | "imported" | "failed" | "attention" | "busy" | "reverted";
	trigger: SpecImportTrigger;
	at: string;
	/** Failed attempts since the last success (the automatic triggers give up after a few). */
	failures: number;
	/** Why the last attempt did not move the session (English, as logged). */
	error?: string;
	/** The same, as the Spec panel says it in the reader's language. */
	reason?: OutlineSpecImportReason;
	tasks?: number;
	/** Files imported as notes (one top-level block each). */
	notes?: number;
}

/**
 * The imports running in this process. What they did is persisted (`state.ts`): the result of an
 * import is in the outline itself (the session's column, its blocks), and the table keeps how the
 * last attempt went, so attempt limits, a session that needs attention and a move back survive a
 * restart.
 */
const running = hotSafe(
	"narrafork.outline.specImport.running",
	() => new Map<string, Promise<SpecImportOutcome>>(),
);

/** Whether an import of the session runs in this process now. */
export function isSpecImportRunning(narratorId: string): boolean {
	return running.has(narratorId);
}

function recordOf(state: SpecImportState): SpecImportRecord | null {
	if (state.status === "idle") return null;
	return {
		status: state.status === "running" && !running.has(state.narratorId) ? "busy" : state.status,
		trigger: (state.trigger ?? "manual") as SpecImportTrigger,
		at: state.updatedAt,
		failures: state.attempts,
		...(state.error ? { error: state.error } : {}),
		...(state.reason ? { reason: state.reason } : {}),
		...(state.tasks !== null ? { tasks: state.tasks } : {}),
		...(state.notes !== null ? { notes: state.notes } : {}),
	};
}

/** The last import of a session as cached (sync; the cache holds what this process read or wrote). */
export function specImportRecord(narratorId: string): SpecImportRecord | null {
	const state = cachedSpecImportState(narratorId);
	return state ? recordOf(state) : null;
}

/** The last import of a session (one primary-key read when not cached). */
export async function readSpecImportRecord(narratorId: string): Promise<SpecImportRecord | null> {
	const state = await readSpecImportState(narratorId);
	return state ? recordOf(state) : null;
}

/** Forget what is cached (tests: what a restart does; the table keeps the rows). */
export function resetSpecImportRecords(): void {
	resetSpecImportStateCache();
}

/** Persist a state write, never rejecting: the import's own outcome does not depend on it. */
async function persist(
	narratorId: string,
	update: Parameters<typeof writeSpecImportState>[1],
): Promise<void> {
	try {
		await writeSpecImportState(narratorId, update);
	} catch (error) {
		logger.warn("Could not record the state of a Dynamic Spec import", {
			narratorId,
			error: String(error),
		});
	}
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
	 * `urgent` (a person's message arrived): honoured at the next commit boundary. Otherwise (a
	 * time budget, a team or plugin notice) honoured once the attempt made a commit, so every
	 * attempt gets somewhere even when converting one file takes longer than the budget. A pause
	 * asked for already becomes urgent when a person's message arrives after it.
	 */
	constructor(
		message: string,
		public urgent = false,
	) {
		super(message);
	}
}

function logImportOutcome(
	level: "info" | "warn",
	message: string,
	fields: Record<string, string | number | boolean>,
): void {
	try {
		logger[level](message, fields);
	} catch {
		/* Observational sinks cannot change persisted import outcomes or cleanup. */
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
 * rejects: what happened is the outcome, recorded for the Spec panel (`state.ts`).
 */
export async function importSpecSession(
	narratorId: string,
	options: SpecImportOptions,
): Promise<SpecImportOutcome> {
	if (specImportMode() === "off") return { status: "skipped", reason: "off" };
	const current = running.get(narratorId);
	if (current)
		return options.trigger === "manual" || options.trigger === "admin"
			? await current
			: { status: "busy" };
	const run = attempt(narratorId, options).finally(() => running.delete(narratorId));
	running.set(narratorId, run);
	return await run;
}

async function attempt(narratorId: string, options: SpecImportOptions): Promise<SpecImportOutcome> {
	let release: (() => void) | null = null;
	let unguard: (() => void) | null = null;
	let touched = false;
	const started = performance.now();
	try {
		const previous = await readSpecImportState(narratorId);
		const session = await readSpecImportSession(narratorId);
		const skip = specImportSkipReason(session);
		if (skip || !session) return { status: "skipped", reason: skip ?? "missing" };
		// Moved back by an administrator: only an administrator's re-import moves it again.
		if (previous?.status === "reverted" && options.trigger !== "admin")
			return { status: "skipped", reason: "reverted" };
		const pointers = session.namespaceId ? await readSpecFilePointers(session.namespaceId) : [];
		if (options.smallOnly && tooLargeFor(pointers, options.smallOnly)) return { status: "busy" };
		if (options.admit) {
			try {
				release = await options.admit(narratorId);
			} catch {
				await persistBusy(narratorId, options.trigger, previous);
				return { status: "busy" };
			}
		}
		if (isSpecImporting(narratorId)) return { status: "busy" };
		unguard = beginSpecImport(narratorId);
		// The move claims tasks: the lease keeper looks at the session again (its end, too).
		forgetSpecImportLeftover(narratorId);
		touched = true;
		await persist(narratorId, {
			status: "running",
			trigger: options.trigger,
			reason: null,
			error: null,
			attentionReason: null,
		});
		const outcome = await run(session, pointers, options, previous);
		logImportOutcome("info", "Dynamic Spec session imported into the outline", {
			narratorId,
			trigger: options.trigger,
			tasks: outcome.tasks,
			notes: outcome.notes,
			commits: outcome.commits,
			unreadable: outcome.unreadable,
			movedForward: outcome.movedForward,
			elapsedMs: Math.round(performance.now() - started),
		});
		const { movedForward: _, ...result } = outcome;
		return result;
	} catch (error) {
		if (
			error instanceof SpecImportPaused ||
			(options.signal?.aborted === true && options.signal.reason instanceof SpecImportPaused)
		) {
			const reason = error instanceof SpecImportPaused ? error : options.signal?.reason;
			await persistBusy(narratorId, options.trigger, null);
			logImportOutcome(
				"info",
				"Dynamic Spec import gave way to its session; the next attempt goes on",
				{
					narratorId,
					trigger: options.trigger,
					urgent: reason instanceof SpecImportPaused && reason.urgent,
					elapsedMs: Math.round(performance.now() - started),
				},
			);
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
		await persist(narratorId, (current) => ({
			status: attention ? "attention" : "failed",
			trigger: options.trigger,
			attempts: (current?.attempts ?? 0) + 1,
			error: message,
			reason,
			attentionReason: attention ? reason.code : null,
		}));
		logImportOutcome("warn", "Dynamic Spec import did not move a session", {
			narratorId,
			trigger: options.trigger,
			attention,
			reason: reason.code,
		});
		return { status: "failed", error: message, attention };
	} finally {
		if (touched) forgetSpecImportLeftover(narratorId);
		unguard?.();
		release?.();
	}
}

/**
 * A busy attempt: recorded as such, counting nothing against the session. A session an
 * administrator moved back stays so when its re-import could not even start (the session was
 * busy): the next re-import, not an automatic trigger, picks it up.
 */
async function persistBusy(
	narratorId: string,
	trigger: SpecImportTrigger,
	previous: SpecImportState | null,
): Promise<void> {
	if (previous?.status === "reverted") return;
	await persist(narratorId, { status: "busy", trigger, reason: null, error: null });
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
	/**
	 * The session was moved back to Dynamic Spec since its last switch (12b2 review S3): its
	 * fence's plugin SOP may have changed there, so it replaces the plugin's block.
	 */
	afterRevert: boolean;
}

/** What the steps before the move leave for it. */
interface Written {
	tasks: number;
	notes: number;
	/** Tasks the move starts (block ids): in progress in the source, to do until then. */
	start: string[];
}

/** What {@link run} hands back: the outcome, and whether the session was only moved forward. */
type RunOutcome = Extract<SpecImportOutcome, { status: "imported" }> & { movedForward: boolean };

/**
 * A digest of the session's Dynamic Spec file pointers: equal digests, the same files at the same
 * revisions. Kept when an administrator moves the session back (`revert.ts`).
 */
export function specPointersDigest(pointers: readonly SpecImportFilePointer[]): string {
	return createHash("sha256").update(pointerKey(pointers)).digest("hex");
}

async function run(
	session: SpecImportSession,
	pointers: readonly SpecImportFilePointer[],
	options: SpecImportOptions,
	previous: SpecImportState | null,
): Promise<RunOutcome> {
	const { narratorId } = session;
	const files = importable(pointers);
	const unreadable = pointers.filter((p) => p.revisionId === null).length;
	// Moved back by an administrator and its Dynamic Spec not changed since: the outline still
	// holds what the session had there (and what it did after the first move), so the move is
	// made again without writing anything (12b2).
	const movedForward =
		previous?.revertSourceKey !== null &&
		previous?.revertSourceKey !== undefined &&
		previous.revertSourceKey === specPointersDigest(pointers);
	let written: Written = {
		tasks: movedForward ? (previous?.tasks ?? 0) : 0,
		notes: movedForward ? (previous?.notes ?? 0) : 0,
		start: [],
	};
	let ctx: Context | null = null;
	if (!movedForward) {
		if (pointers.length >= SPEC_IMPORT_READ_LIMITS.files || files.length > SPEC_IMPORT_LIMITS.files)
			throw new SpecImportAttention(
				`The session holds more than ${SPEC_IMPORT_LIMITS.files} Dynamic Spec files`,
				{ code: "too_many_files", count: SPEC_IMPORT_LIMITS.files },
			);
		if (
			tooLargeFor(pointers, {
				files: SPEC_IMPORT_LIMITS.files,
				chars: SPEC_IMPORT_LIMITS.totalChars,
			})
		)
			throw new SpecImportAttention(
				`The session's Dynamic Spec files hold more than ${SPEC_IMPORT_LIMITS.totalChars} characters`,
				{ code: "too_large", count: SPEC_IMPORT_LIMITS.totalChars },
			);
		if (files.length > 0) {
			const locale: Locale = session.ownerUserId
				? await getUserLanguage(session.ownerUserId).catch(() => "en" as const)
				: "en";
			const space = await outlineStore.ensureSpace(
				{ kind: "session", narratorId },
				new Date().toISOString(),
			);
			ctx = {
				session,
				space,
				locale,
				signal: options.signal,
				pause: options.pause,
				commits: 0,
				afterRevert:
					previous?.status === "reverted" || (previous?.revertSourceKey ?? null) !== null,
			};
			written = await writeEverything(ctx, files);
		}
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
	await recordSwitch(session, options.trigger, {
		ctx,
		previous,
		fenceRevisionId: files.find((p) => p.path === "behavior_fence")?.revisionId ?? null,
		tasks: written.tasks,
		notes: written.notes,
		// Nothing to tell a session that never wrote to Dynamic Spec.
		notice: files.length > 0,
	});
	if (previous && previous.revertNoteIds.length > 0)
		await removeRevertNotes(session, previous.revertNoteIds);
	await afterMove(session, options);
	return {
		status: "imported",
		tasks: written.tasks,
		notes: written.notes,
		unreadable,
		commits: ctx?.commits ?? 0,
		movedForward,
	};
}

/**
 * The switch, recorded (12b2): the state row says `imported`, counts one more switch (the model's
 * notice is derived from it; `notice` false records it as told), and keeps where the import
 * landed and the old fence revision it read, for the Spec panel and a move back.
 */
async function recordSwitch(
	session: SpecImportSession,
	trigger: SpecImportTrigger,
	landed: {
		ctx: Context | null;
		previous: SpecImportState | null;
		fenceRevisionId: string | null;
		tasks: number;
		notes: number;
		notice: boolean;
	},
): Promise<void> {
	const { narratorId } = session;
	let spaceId = landed.ctx?.space.id ?? landed.previous?.spaceId ?? null;
	let taskBlockId = landed.previous?.taskBlockId ?? null;
	try {
		const space =
			landed.ctx?.space ?? (await outlineStore.findSpace({ kind: "session", narratorId }));
		if (space) {
			spaceId = space.id;
			taskBlockId = (await findTasksBlock(space.id))?.id ?? null;
		}
	} catch (error) {
		logger.warn("Could not read where an imported session's tasks landed", {
			narratorId,
			error: String(error),
		});
	}
	await persist(narratorId, (current) => {
		const switchCount = (current?.switchCount ?? 0) + 1;
		return {
			status: "imported",
			trigger,
			attempts: 0,
			reason: null,
			error: null,
			attentionReason: null,
			switchCount,
			switchedAt: new Date().toISOString(),
			noticeSwitch: landed.notice ? (current?.noticeSwitch ?? 0) : switchCount,
			spaceId,
			taskBlockId,
			fenceRevisionId: landed.fenceRevisionId,
			tasks: landed.tasks,
			notes: landed.notes,
			revertSourceKey: null,
			revertNoteIds: [],
		};
	});
}

/**
 * Take away the markers a move back wrote (12b2) once the session is in the outline again: each
 * only when nobody but the system wrote it or anything under it (else it stays, as someone's).
 * Never rejects.
 */
async function removeRevertNotes(
	session: SpecImportSession,
	noteIds: readonly string[],
): Promise<void> {
	const { narratorId } = session;
	try {
		const space = await outlineStore.findSpace({ kind: "session", narratorId });
		if (!space) return;
		const metas = (await outlineStore.getBlockMetas(space.id, { ids: [...noteIds] })).filter(
			(meta) => !meta.deleted,
		);
		const removable: OutlineBlockMeta[] = [];
		for (const meta of metas)
			if ((await onlyImportWrote(space, { id: meta.id, versionSeq: meta.versionSeq })) !== null)
				removable.push(meta);
		if (removable.length === 0) return;
		const locale: Locale = session.ownerUserId
			? await getUserLanguage(session.ownerUserId).catch(() => "en" as const)
			: "en";
		await writeOutline({
			spaceId: space.id,
			ops: removable.map((meta) => ({
				op: "delete" as const,
				block: { id: meta.id },
				baseVersionSeq: meta.versionSeq,
			})),
			actor: { kind: "system", id: OUTLINE_SPEC_REVERT_ACTOR },
			responsibleUserId: session.ownerUserId,
			narratorId,
			summary: SPEC_IMPORT_TEXT[locale].summaryRevertNotesRemoved,
		});
	} catch (error) {
		logger.warn("Could not remove the markers of a move back to Dynamic Spec", {
			narratorId,
			error: String(error),
		});
	}
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
	// import finds its text under the behavior boundary and leaves only the SOP; 12a's move finds the plugin's
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
			// Written before tasks.json was validated: kept as notes, the session not moved.
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
	// An empty `index.md` (the built-in file every namespace starts with) is not imported: the
	// block the compatibility layer would write for it holds nothing.
	const notePointers: Array<SpecImportFilePointer & { revisionId: string }> = notes.flatMap((p) =>
		p.revisionId && !(p.path === "index.md" && (p.chars ?? 0) === 0)
			? [{ ...p, revisionId: p.revisionId }]
			: [],
	);
	const keep = new Set(
		[...notePointers, ...(brokenTasks !== null && tasksFile?.revisionId ? [tasksFile] : [])].map(
			(p) => specFileTag(narratorId, p.path, p.revisionId as string),
		),
	);
	await removeStale(ctx, {
		keepFileTags: keep,
		taskSidPrefix: taskPlan?.sidPrefix ?? null,
		fenceTag: fence ? behaviorImportTagOf(fence.own) : null,
		indexMd: notePointers.some((p) => p.path === "index.md"),
	});

	// Notes: a few files' contents read at a time, each converted and written before the next, so
	// the converted blocks of one file are held at a time, never the whole session's.
	let notesWritten = 0;
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
			...(path === "index.md" ? { rootSid: specIndexSid() } : {}),
		});
		notesWritten++;
		await writeNodes(ctx, plan.nodes, null, SPEC_IMPORT_TEXT[locale].summaryNotes(path), {
			relocate: true,
		});
		await tidyLegacyParts(ctx, path, plan.rootSid);
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
		const listId = await ensureTasksBlock(ctx);
		const summary = SPEC_IMPORT_TEXT[locale].summaryTasks(taskPlan.tasks.length);
		await writeNodes(ctx, taskPlan.tasks, { id: listId }, summary, { heal: true });
		await writeNodes(ctx, taskPlan.notes, null, summary);
		start = await verifyTasks(ctx, taskPlan.expected, listId);
	}
	if (brokenTasks !== null)
		throw new SpecImportAttention(
			"tasks.json is not a valid task list: it was imported as notes, the session was not moved",
			{ code: "broken_tasks" },
		);
	// Step 6, once everything above holds: the fence text goes under the behavior boundary last, so an
	// attempt that does not get this far leaves nothing of a fence that may still change.
	if (fence?.own)
		await importBehaviorFenceText(narratorId, locale, fence.own, { signal: ctx.signal });
	if (fence?.sop.trim()) {
		ctx.signal?.throwIfAborted();
		try {
			await writeImportedFenceSop(
				{ narratorId, ownerUserId: session.ownerUserId, locale },
				fence.sop,
				// After a move back the fence's SOP is the current one (a plugin wrote it there
				// meanwhile): it replaces the block, whole, or the import needs attention.
				{ replace: ctx.afterRevert },
			);
		} catch (error) {
			if (error instanceof PluginTaskError && error.publicCode === "PAYLOAD_TOO_LARGE")
				throw new SpecImportAttention(error.message, { code: "sop_too_large" });
			throw error;
		}
	}
	return { tasks: taskPlan?.tasks.length ?? 0, notes: notesWritten, start };
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
	options: { ignoreSignal?: boolean; expectNextSeq?: number } = {},
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
		{
			kind: "import",
			canonical,
			...(options.expectNextSeq !== undefined ? { expectNextSeq: options.expectNextSeq } : {}),
		},
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
 * need. A node with no parent hangs from `root` (null: the top level). What is there already is
 * skipped, and so is everything under a block deleted since (a person's choice), unless `heal`:
 * then a deleted block is brought back and a task that drifted from its plan is set again (the
 * tasks, which must be all there for the session to move), but only when its current version is
 * the import's own (12b review r2 SF2): what anyone else changed is left as they left it, so the
 * verification that follows fails on it (needs attention) instead of an import version hiding
 * it, which a later attempt would then delete as only the import's.
 *
 * `relocate` (a file's blocks): a block that is there already under another parent than the plan
 * says, and that only the import ever wrote, is moved where the plan puts it, in plan order (an
 * attempt cut short before pages went left a file over several pages: its blocks join the file's
 * one block). One someone else wrote stays where it is.
 */
async function writeNodes(
	ctx: Context,
	nodes: readonly SpecImportNode[],
	root: OutlineBlockRef | null,
	summary: string,
	options: { heal?: boolean; relocate?: boolean } = {},
): Promise<void> {
	if (nodes.length === 0) return;
	const existing = await existingBySid(
		ctx.space,
		nodes.map((node) => node.sid),
	);
	const healable = options.heal ? await importVersions(ctx.space, nodes, existing) : new Set();
	const plannedParentId = (node: SpecImportNode): string | null | undefined => {
		if (node.parentSid === null) return undefined;
		const parent = existing.get(node.parentSid);
		return parent && !parent.deleted ? parent.id : null;
	};
	const movable = options.relocate
		? await onlyImportVersions(
				ctx.space,
				nodes.flatMap((node) => {
					const found = existing.get(node.sid);
					const planned = plannedParentId(node);
					return found && !found.deleted && planned !== undefined && found.parentId !== planned
						? [found.id]
						: [];
				}),
			)
		: new Set<string>();
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
			if (!options.heal || !healable.has(found.id)) {
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
		} else if (
			movable.has(found.id) &&
			parent !== null &&
			!("id" in parent && parent.id === found.parentId)
		) {
			op = { op: "move", block: { id: found.id }, parent };
		} else if (options.heal && node.task && drifted(found, node) && healable.has(found.id)) {
			op = {
				op: "setTask",
				block: { id: found.id },
				task: { status: node.task.status, humanCreated: node.task.humanCreated ?? null },
			};
		}
		if (!op) continue;
		const size =
			op.op === "setTask" || op.op === "move" ? 0 : Buffer.byteLength(node.content, "utf8");
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
			op.op !== "setTask" && op.op !== "move" && node.links
				? { content: node.content, links: node.links }
				: null,
		);
		if (op.op === "insert") inCommit.add(node.sid);
		bytes += size;
	}
	await flush();
}

/**
 * Of the given blocks, those every version of which one of the import's own commits wrote
 * (bounded: at most {@link SPEC_IMPORT_LIMITS.staleRootVersions} versions a block, more: not one
 * of them; commits looked up 100 seqs at a time).
 */
async function onlyImportVersions(
	space: OutlineSpaceRow,
	ids: readonly string[],
): Promise<Set<string>> {
	const out = new Set<string>();
	if (ids.length === 0) return out;
	const seqsOf = new Map<string, number[]>();
	for (const [n, id] of ids.entries()) {
		const versions = await outlineStore.listBlockVersions(
			id,
			SPEC_IMPORT_LIMITS.staleRootVersions + 1,
		);
		if (versions.length <= SPEC_IMPORT_LIMITS.staleRootVersions)
			seqsOf.set(
				id,
				versions.map((v) => v.fromSeq),
			);
		if (n % 200 === 199) await yieldToEventLoop();
	}
	const wanted = [...new Set([...seqsOf.values()].flat())];
	const ours = new Set<number>();
	for (let i = 0; i < wanted.length; i += 100)
		for (const row of await outlineStore.getCommitsBySeqs(space.id, wanted.slice(i, i + 100)))
			if (isImportCommit(row)) ours.add(row.seq);
	for (const [id, seqs] of seqsOf) if (seqs.every((seq) => ours.has(seq))) out.add(id);
	return out;
}

/**
 * After a file's blocks are written: what an attempt cut short before pages went left of the
 * file's layout then. Its part pages (`sp<tag>p<n>`, the file over several pages) go once
 * nothing is under them and only the import wrote them; the file's block, titled as the first
 * part (`name (1/2)`), gets the file's path back, when only the import wrote it.
 */
async function tidyLegacyParts(ctx: Context, path: string, rootSid: string): Promise<void> {
	const tag = fileTagOfSid(rootSid);
	if (!rootSid.startsWith("sp") || rootSid !== `sp${tag}`) return;
	const partSids = Array.from(
		{ length: SPEC_IMPORT_LEGACY_PARTS },
		(_, n) => `sp${tag}p${(n + 1).toString(36)}`,
	);
	const parts = (await outlineStore.getBlockMetas(ctx.space.id, { sids: partSids })).filter(
		(meta) => !meta.deleted,
	);
	const empty: OutlineBlockMeta[] = [];
	for (const part of parts)
		if ((await outlineStore.listChildMetas(ctx.space.id, [part.id], 1)).length === 0)
			empty.push(part);
	const [root] = await outlineStore.getBlockMetas(ctx.space.id, { sids: [rootSid] });
	const rootRow = root && !root.deleted ? await outlineStore.getBlock(root.id) : null;
	const retitle = rootRow !== null && rootRow.content !== path;
	const ours = await onlyImportVersions(ctx.space, [
		...empty.map((part) => part.id),
		...(retitle && root ? [root.id] : []),
	]);
	const ops: OutlineOp[] = [];
	for (const part of empty)
		if (ours.has(part.id))
			ops.push({ op: "delete", block: { id: part.id }, baseVersionSeq: part.versionSeq });
	if (retitle && root && ours.has(root.id))
		ops.push({
			op: "update",
			block: { id: root.id },
			content: path,
			baseVersionSeq: root.versionSeq,
		});
	if (ops.length > 0)
		await commit(
			ctx,
			ops,
			ops.map(() => null),
			SPEC_IMPORT_TEXT[ctx.locale].summaryNotes(path),
		);
}

/**
 * Of the blocks `writeNodes` would heal (deleted, or a task that drifted), those whose current
 * version one of the import's own commits wrote. Bounded: the nodes are the tasks of one
 * `tasks.json` (at most 100, with their notes), their commits looked up 100 seqs at a time.
 */
async function importVersions(
	space: OutlineSpaceRow,
	nodes: readonly SpecImportNode[],
	existing: ReadonlyMap<string, OutlineBlockMeta>,
): Promise<Set<string>> {
	const candidates: OutlineBlockMeta[] = [];
	for (const node of nodes) {
		const found = existing.get(node.sid);
		if (found && (found.deleted || (node.task && drifted(found, node)))) candidates.push(found);
	}
	const out = new Set<string>();
	if (candidates.length === 0) return out;
	const seqs = [...new Set(candidates.map((meta) => meta.versionSeq))];
	const ours = new Set<number>();
	for (let i = 0; i < seqs.length; i += 100)
		for (const row of await outlineStore.getCommitsBySeqs(space.id, seqs.slice(i, i + 100)))
			if (isImportCommit(row)) ours.add(row.seq);
	for (const meta of candidates) if (ours.has(meta.versionSeq)) out.add(meta.id);
	return out;
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

/**
 * The session's task list (`session/tasks`, A1's well-known block), made at the top level when
 * there is none. An alias `tasks` held by a block that is not at the top level names no task list
 * (`well-known.ts`), and the alias cannot be given twice: the import then needs a person.
 */
async function ensureTasksBlock(ctx: Context): Promise<string> {
	const list = await findTasksBlock(ctx.space.id);
	if (list) return list.id;
	const [owner] = await outlineStore.findAliasOwners(ctx.space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
	if (owner)
		throw new SpecImportAttention(
			"The block that holds the alias tasks in the session space is not at its top level, so the session has no task list to import into: move it to the top level (or remove its alias), then import again",
			{ code: "other" },
		);
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
		SPEC_IMPORT_TEXT[ctx.locale].summaryTasksBlock,
	);
	const listId = result.results[0]?.blockId;
	if (!listId) throw new Error("the import could not create the task list");
	return listId;
}

/** The actors whose commits are the import's own: this import, and PR 4's fence import it calls. */
const IMPORT_ACTORS: ReadonlySet<string> = new Set([
	OUTLINE_SPEC_IMPORT_ACTOR,
	OUTLINE_BEHAVIOR_IMPORT_ACTOR,
	// The markers a move back to Dynamic Spec left (12b2).
	OUTLINE_SPEC_REVERT_ACTOR,
	// Possibly lost content attached to an imported file block (12c, `loss-attach.ts`): it is
	// kept in its finding and attached anew to the block of the file's new revision, so a stale
	// block it sits under is still the import's to take away.
	OUTLINE_SPEC_LOSS_ACTOR,
]);

interface StaleBlock {
	id: string;
	versionSeq: number;
}

/** A live block under a stale block (or the stale block itself: `parentId` null here). */
interface StaleNode {
	id: string;
	parentId: string | null;
	versionSeq: number;
}

/** A scan that reached its limit with more to look at: the import does not go on blind. */
function staleLimit(count: number): SpecImportAttention {
	return new SpecImportAttention(
		`An earlier, unfinished import may have left more than ${count} blocks to look through: nothing was taken away or written`,
		{ code: "stale_limit", count },
	);
}

/**
 * The children of one parent (null: the top level) a level read at a time, at most `max`; a
 * level that goes on past it needs attention.
 */
async function readLevelWhole(
	space: OutlineSpaceRow,
	parentId: string | null,
	max: number,
): Promise<Array<{ id: string; sid: string; versionSeq: number }>> {
	const out: Array<{ id: string; sid: string; versionSeq: number }> = [];
	let after: OutlineLevelCursor | null = null;
	for (;;) {
		const level = await outlineStore.listLevel(space.id, parentId, {
			asOf: null,
			after,
			limit: SPEC_IMPORT_LIMITS.staleLevelRead,
		});
		out.push(...level.rows);
		if (!level.next) return out;
		if (out.length >= max) throw staleLimit(max);
		after = level.next;
	}
}

/**
 * Take away what an earlier attempt wrote from a source that is not the one read now: the
 * import's tasks of another `tasks.json` revision in the task list (their notes go with them),
 * its top-level file blocks of other file revisions (the `index.md` block when that file is gone),
 * its blocks and groups of another `index.md` revision under the index block, and under the
 * behavior boundary its blocks of another fence text. Only the import's own short ids are looked
 * at, only before the session is moved, and only what nobody else ever touched is taken away
 * ({@link onlyImportWrote}): when any stale block was touched by anyone else, nothing is taken
 * away or written and the attempt needs attention (`kept_blocks`), so the space shows the kept
 * blocks and no new revision beside them. A file block someone moved off the top level is not
 * looked for: moving it made it theirs. Bounded reads (a scan that reaches its limit needs
 * attention, `stale_limit`); the deletes go in bounded commits that re-check before each one
 * ({@link deleteStale}).
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
): Promise<void> {
	const { space } = ctx;
	const limits = SPEC_IMPORT_LIMITS;
	// Everything up to here is what the checks below look at; what lands later is checked again
	// before every delete.
	const checkedUpTo = latestSeqOf(await outlineStore.getSpace(space.id));
	const stale: StaleBlock[] = [];
	const block = (meta: Pick<OutlineBlockMeta, "id" | "versionSeq">): StaleBlock => ({
		id: meta.id,
		versionSeq: meta.versionSeq,
	});
	const ofOtherFile = (sid: string) =>
		(sid.startsWith("sb") || sid.startsWith("sp")) &&
		isImportSid(sid) &&
		!current.keepFileTags.has(fileTagOfSid(sid));
	const [tasksList] = await outlineStore.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
	if (tasksList) {
		for (const meta of await outlineStore.listLastChildMetas(
			space.id,
			tasksList.id,
			limits.staleChildren,
		)) {
			if (!meta.sid.startsWith("st") || !isImportSid(meta.sid)) continue;
			if (current.taskSidPrefix === null || !meta.sid.startsWith(current.taskSidPrefix))
				stale.push(block(meta));
		}
	}
	const [index] = await outlineStore.getBlockMetas(space.id, { sids: [specIndexSid()] });
	if (index && !index.deleted) {
		// The file is gone: its block goes too, rather than staying behind empty.
		if (!current.indexMd) stale.push(block(index));
		else
			for (const row of await readLevelWhole(space, index.id, limits.staleIndexChildren))
				if (ofOtherFile(row.sid)) stale.push(block(row));
	}
	// The import's file blocks of other revisions at the top level.
	for (const row of await readLevelWhole(space, null, limits.staleTopLevel))
		if (row.sid.startsWith("sp") && ofOtherFile(row.sid)) stale.push(block(row));
	const behavior = await findBehaviorBlock(space.id);
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

	const removable: StaleNode[][] = [];
	let kept = 0;
	for (const entry of stale) {
		const nodes = await onlyImportWrote(space, entry);
		if (nodes) removable.push(nodes);
		else kept++;
	}
	// Before anything is written (review r2 NIT 3): an attempt that cannot move the session leaves
	// the space as it found it, rather than the new revision's blocks beside the kept ones.
	if (kept > 0) throw keptBlocks(ctx, kept);
	await deleteStale(ctx, removable, checkedUpTo);
}

function keptBlocks(ctx: Context, kept: number): SpecImportAttention {
	logger.warn("Dynamic Spec import kept blocks of an earlier attempt that others wrote to", {
		narratorId: ctx.session.narratorId,
		kept,
	});
	return new SpecImportAttention(
		`${kept} block(s) an earlier, unfinished import wrote hold what someone added or changed since: they were kept; move what is yours out of them (or delete them), then import again`,
		{ code: "kept_blocks", count: kept },
	);
}

function latestSeqOf(space: OutlineSpaceRow | null): number {
	return space ? Math.max(0, space.nextSeq - 1) : 0;
}

/**
 * The deletes of {@link removeStale}, in bounded commits. A delete writes a row for the block and
 * for every block under it, so each commit deletes at most
 * {@link SPEC_IMPORT_LIMITS.staleDeleteBlocks} blocks in all (and at most
 * {@link SPEC_IMPORT_LIMITS.staleDeletesPerCommit} operations): a stale subtree within that goes
 * whole; a larger one goes from the bottom up, round after round, each round deleting its largest
 * pieces that fit. A commit the write path still finds too large (links count as rows too) is
 * split in two, and a single piece too large is planned again at half the size.
 *
 * NOTHING BUT WHAT WAS CHECKED. Before every commit, every stale block still there is checked
 * again for commits by anyone else that changed anything under it (or it) since the last check
 * (its change marks): one, and the removal stops (`kept_blocks`, what went already stays gone:
 * nobody else had touched it). The commit is then written only while the space is still at the
 * seq that check read (`expectNextSeq`), each delete naming the version it checked: a commit
 * landing in between makes the write refuse, and the check runs again. So a delete never takes
 * a block that was not in the checked subtree.
 */
async function deleteStale(
	ctx: Context,
	subtrees: readonly StaleNode[][],
	checkedUpTo: number,
): Promise<void> {
	const limits = SPEC_IMPORT_LIMITS;
	const summary = SPEC_IMPORT_TEXT[ctx.locale].summaryStale;
	const nodeOf = new Map<string, StaleNode>();
	for (const nodes of subtrees) for (const node of nodes) nodeOf.set(node.id, node);
	const roots = subtrees.flatMap((nodes) => (nodes[0] ? [nodes[0].id] : []));
	const gone = new Set<string>();
	let verified = checkedUpTo;
	let cap: number = limits.staleDeleteBlocks;

	/** Check what landed since the last check; the space's next seq the check read. */
	const recheck = async (): Promise<number> => {
		const space = await outlineStore.getSpace(ctx.space.id);
		if (!space) throw new Error("the session space is gone");
		const latest = latestSeqOf(space);
		if (latest > verified) {
			for (const root of roots) {
				if (gone.has(root)) continue;
				const seqs = new Set(
					await outlineStore.listSubtreeChangeSeqs(space.id, root, {
						after: verified,
						limit: limits.staleCommits + 1,
					}),
				);
				const own = await outlineStore.listBlockVersions(root, limits.staleRootVersions + 1);
				if (seqs.size > limits.staleCommits || own.length > limits.staleRootVersions)
					throw keptBlocks(ctx, 1);
				for (const version of own) if (version.fromSeq > verified) seqs.add(version.fromSeq);
				if (!(await allImportCommits(space, seqs))) throw keptBlocks(ctx, 1);
			}
			verified = latest;
		}
		return space.nextSeq;
	};

	const tooLarge = (error: unknown) =>
		error instanceof OutlineWriteError && error.code === "OUTLINE_TOO_MANY_ROWS";
	/** Write one pack; false: a single piece was too large. */
	const commitPack = async (
		list: ReadonlyArray<{ id: string; size: number }>,
	): Promise<boolean> => {
		for (;;) {
			const expectNextSeq = await recheck();
			try {
				await commit(
					ctx,
					list.map((piece) => ({
						op: "delete" as const,
						block: { id: piece.id },
						baseVersionSeq: (nodeOf.get(piece.id) as StaleNode).versionSeq,
					})),
					list.map(() => null),
					summary,
					{ expectNextSeq },
				);
				for (const piece of list) gone.add(piece.id);
				return true;
			} catch (error) {
				// Someone wrote meanwhile: checked again before trying again.
				if (error instanceof OutlineStaleWriteError) continue;
				if (!tooLarge(error)) throw error;
				if (list.length === 1) return false;
				const half = Math.ceil(list.length / 2);
				return (await commitPack(list.slice(0, half))) && (await commitPack(list.slice(half)));
			}
		}
	};

	for (;;) {
		const pieces = stalePieces(subtrees, gone, cap);
		if (pieces.length === 0) return;
		let packs: Array<Array<{ id: string; size: number }>> = [];
		let pack: Array<{ id: string; size: number }> = [];
		let rows = 0;
		for (const piece of pieces) {
			if (
				pack.length > 0 &&
				(pack.length >= limits.staleDeletesPerCommit || rows + piece.size > cap)
			) {
				packs.push(pack);
				pack = [];
				rows = 0;
			}
			pack.push(piece);
			rows += piece.size;
		}
		if (pack.length > 0) packs.push(pack);
		let fits = true;
		for (const list of packs)
			if (!(await commitPack(list))) {
				fits = false;
				break;
			}
		packs = [];
		if (!fits) {
			if (cap <= 1) throw new Error("the import could not delete a stale block in one commit");
			cap = Math.max(1, Math.floor(cap / 2));
		}
		await yieldToEventLoop();
	}
}

/**
 * The largest pieces of the stale subtrees left (not deleted yet) whose blocks number at most
 * `cap`: walking down from each stale block, a block whose rest fits is a piece, else its
 * children are looked at. Linear in the blocks left: one pass to count, one to choose.
 */
function stalePieces(
	subtrees: readonly StaleNode[][],
	gone: ReadonlySet<string>,
	cap: number,
): Array<{ id: string; size: number }> {
	const pieces: Array<{ id: string; size: number }> = [];
	for (const nodes of subtrees) {
		const root = nodes[0];
		if (!root || gone.has(root.id)) continue;
		const children = new Map<string, string[]>();
		for (const node of nodes) {
			if (node.parentId === null) continue;
			const list = children.get(node.parentId);
			if (list) list.push(node.id);
			else children.set(node.parentId, [node.id]);
		}
		// Sizes after the fact (post order, without recursion), skipping what went.
		const size = new Map<string, number>();
		const order: string[] = [];
		const stack = [root.id];
		while (stack.length > 0) {
			const id = stack.pop() as string;
			if (gone.has(id)) continue;
			order.push(id);
			for (const child of children.get(id) ?? []) stack.push(child);
		}
		for (let i = order.length - 1; i >= 0; i--) {
			const id = order[i] as string;
			let total = 1;
			for (const child of children.get(id) ?? []) total += size.get(child) ?? 0;
			size.set(id, total);
		}
		const down = [root.id];
		while (down.length > 0) {
			const id = down.pop() as string;
			if (gone.has(id)) continue;
			const own = size.get(id) ?? 1;
			if (own <= cap) pieces.push({ id, size: own });
			else for (const child of children.get(id) ?? []) down.push(child);
		}
	}
	return pieces;
}

/**
 * Whether only the import ever touched what is or was under `root`, itself included (outline
 * owner rule, A3 review): no commit but the import's own changed `root` or any block that was
 * under it at the time, live or deleted since: read from the root's change marks (every commit
 * that versioned anything under it marks it) and the root's own versions. A person who added a
 * child and deleted it again, edited a text and put it back, moved a block in or out: kept. What
 * happened at or below the space's history floor left no marks and is not seen (history before
 * the conversion is not kept). The live blocks under it now, the root first, to plan the
 * deletes (null when someone else touched it, or a bound was reached: kept, it cannot tell).
 * Bounded: {@link SPEC_IMPORT_LIMITS.staleSubtreeBlocks} live blocks read without content, a
 * level of {@link SPEC_IMPORT_LIMITS.sidLookup} parents at a time; at most
 * {@link SPEC_IMPORT_LIMITS.staleCommits} commits and
 * {@link SPEC_IMPORT_LIMITS.staleRootVersions} versions of the root.
 */
async function onlyImportWrote(
	space: OutlineSpaceRow,
	root: StaleBlock,
): Promise<StaleNode[] | null> {
	const limits = SPEC_IMPORT_LIMITS;
	const state = (await outlineStore.getHistoryStates([space.id])).get(space.id);
	if (!state?.edgesReady)
		throw new SpecImportRetry(
			"The session space's history is being converted: the import goes on once that is done",
			{ code: "other" },
		);
	const nodes: StaleNode[] = [{ id: root.id, parentId: null, versionSeq: root.versionSeq }];
	let level = [root.id];
	while (level.length > 0) {
		const next: string[] = [];
		for (let i = 0; i < level.length; i += limits.sidLookup) {
			const children = await outlineStore.listChildMetas(
				space.id,
				level.slice(i, i + limits.sidLookup),
				limits.staleSubtreeBlocks - nodes.length + 1,
			);
			if (nodes.length + children.length > limits.staleSubtreeBlocks) return null;
			for (const child of children) {
				nodes.push({ id: child.id, parentId: child.parentId, versionSeq: child.versionSeq });
				next.push(child.id);
			}
		}
		level = next;
		await yieldToEventLoop();
	}
	const seqs = new Set(
		await outlineStore.listSubtreeChangeSeqs(space.id, root.id, {
			limit: limits.staleCommits + 1,
		}),
	);
	if (seqs.size > limits.staleCommits) return null;
	const own = await outlineStore.listBlockVersions(root.id, limits.staleRootVersions + 1);
	if (own.length > limits.staleRootVersions) return null;
	for (const version of own) if (version.fromSeq > state.floorSeq) seqs.add(version.fromSeq);
	if (seqs.size > limits.staleCommits) return null;
	return (await allImportCommits(space, seqs)) ? nodes : null;
}

/** Whether every commit of `seqs` in the space is one of the import's own. */
async function allImportCommits(
	space: OutlineSpaceRow,
	seqs: ReadonlySet<number>,
): Promise<boolean> {
	const wanted = [...seqs];
	let found = 0;
	for (let i = 0; i < wanted.length; i += 100) {
		for (const row of await outlineStore.getCommitsBySeqs(space.id, wanted.slice(i, i + 100))) {
			if (!isImportCommit(row)) return false;
			found++;
		}
	}
	return found === wanted.length;
}

function isImportCommit(row: Pick<OutlineCommitRow, "actorKind" | "actorId">): boolean {
	return row.actorKind === "system" && IMPORT_ACTORS.has(row.actorId);
}

/**
 * The imported tasks against the source, one by one (PR 12 design §2.5, step 1): all there, live,
 * in the task list in the source's order, with the planned text, checkbox, person mark and lock;
 * every note under its task. A task the move starts reads to do, or in progress already (an
 * attempt that started it and stopped before the move; the move checks its claim). Bounded: the
 * tasks (at most 100) by short id, their contents by id. A mismatch rejects (needs attention).
 * Returns the block ids of the tasks the move starts.
 */
async function verifyTasks(
	ctx: Context,
	expected: readonly SpecImportExpectedTask[],
	tasksBlockId: string,
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
		if (meta.parentId !== tasksBlockId) fail(i, "it is not in the task list");
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
