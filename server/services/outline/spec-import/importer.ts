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
 *      (the import's short ids of another revision; see `plan.ts`).
 *   3. Notes: every file but `tasks.json` and `behavior_fence` becomes a page (`plan.ts`), its
 *      text converted on the background text worker, as it is (nothing is scanned or repaired).
 *   4. Tasks: `tasks.json` onto the session's task page, in order, then the notes under them.
 *      A task of an earlier attempt that was deleted since is brought back, and one whose
 *      checkbox drifted (a lease that ran out between attempts) is set again: until the session
 *      is moved, these blocks are the import's.
 *   5. The behavior fence: its own text onto the behavior page with PR 4's short ids, its plugin
 *      SOP as that plugin's block (`pluginRulesSid`), so the session's first run as an outline
 *      session and the plugin's later updates find them.
 *   6. Verifies the tasks one by one against the source (count, order, text, checkbox, created
 *      by a person, lock, claim, notes). A mismatch moves nothing (needs attention).
 *   7. Reads the file pointers again: a source that changed since step 1 moves nothing (the next
 *      attempt imports the new state). Then moves the session: `task_backend` from `spec` to
 *      `outline`, conditionally, and forgets the cached backend. Dynamic Spec rows are untouched.
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
 * leaves whole commits behind, and the next attempt writes the rest.
 *
 * While it runs, Dynamic Spec writes to the session are refused and plugins' commands wait
 * (`task-source/backend.ts`).
 */
import { hotSafe } from "@server/lib/hot-safe";
import { getUserLanguage } from "@server/lib/i18n";
import { logger } from "@server/lib/logger";
import type { Locale } from "@server/lib/prompt-i18n";
import { settings } from "@server/lib/settings";
import { compareOrderKeys } from "@shared/outline";
import { splitBehaviorFence } from "../../behavior-fence-sop";
import { specIndexSid } from "../../plugin-spec-compat";
import { parseSpecTasksDocument, SPEC_TASKS_PATH, taskTextHash } from "../../spec-task-service";
import { beginSpecImport, invalidateTaskBackend, isSpecImporting } from "../../task-source/backend";
import { importBehaviorFenceText } from "../../task-source/outline-behavior";
import { writeImportedFenceSop } from "../../task-source/outline-plugin-rules";
import { outlineAccessBackend } from "../access-reads";
import { processBackgroundText } from "../edit-text-runner";
import { isOutlineEnabled } from "../feature";
import { OUTLINE_TASKS_PAGE_ALIAS } from "../model";
import { OUTLINE_TASKS_PAGE_TITLE } from "../person-tasks";
import { pluginBlockedNoteSid } from "../plugin-tasks";
import { yieldToEventLoop } from "../session-scope";
import { outlineStore } from "../store";
import type { OutlineBlockMeta, OutlineSpaceRow } from "../store/port";
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
	/** Characters of a failure kept for the Spec panel. */
	errorChars: 300,
	/** Sessions whose last import is remembered (least recently touched dropped first). */
	remembered: 4096,
} as const;

export type SpecImportTrigger = "run" | "sweep" | "manual";

/** How Dynamic Spec sessions are imported (`outline.specImport`); `off` while the outline is. */
export function specImportMode(): "auto" | "manual" | "off" {
	if (!isOutlineEnabled()) return "off";
	const mode = settings.outline?.specImport;
	return mode === "manual" || mode === "off" ? mode : "auto";
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
	/** The session is running, or another import of it is: nothing was done. */
	| { status: "busy" }
	/**
	 * Not moved. `attention`: trying again will not help until someone looks (too large, a
	 * `tasks.json` that does not parse, a mismatch); otherwise the next attempt may succeed.
	 */
	| { status: "failed"; error: string; attention: boolean };

/** The last import of a session, as the Spec panel shows it. Kept in memory (see `rememberedOf`). */
export interface SpecImportRecord {
	status: "running" | "imported" | "failed" | "attention";
	trigger: SpecImportTrigger;
	at: string;
	/** Attempts in this process that failed (the idle job gives up after a few). */
	failures: number;
	error?: string;
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

/** An import that cannot succeed until someone looks. */
class SpecImportAttention extends Error {}

export interface SpecImportOptions {
	trigger: SpecImportTrigger;
	/** Checked between commits; an abort leaves what was committed and moves nothing. */
	signal?: AbortSignal;
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
		const attention = error instanceof SpecImportAttention;
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
	commits: number;
}

async function run(
	session: SpecImportSession,
	pointers: readonly SpecImportFilePointer[],
	options: SpecImportOptions,
): Promise<Extract<SpecImportOutcome, { status: "imported" }>> {
	const { narratorId } = session;
	const files = importable(pointers);
	const unreadable = pointers.filter((p) => !p.deleted && p.revisionId === null).length;
	if (pointers.length >= SPEC_IMPORT_READ_LIMITS.files || files.length > SPEC_IMPORT_LIMITS.files)
		throw new SpecImportAttention(
			`The session holds more than ${SPEC_IMPORT_LIMITS.files} Dynamic Spec files`,
		);
	if (
		tooLargeFor(pointers, { files: SPEC_IMPORT_LIMITS.files, chars: SPEC_IMPORT_LIMITS.totalChars })
	)
		throw new SpecImportAttention(
			`The session's Dynamic Spec files hold more than ${SPEC_IMPORT_LIMITS.totalChars} characters`,
		);

	let tasks = 0;
	let pages = 0;
	let commits = 0;
	if (files.length > 0) {
		const locale: Locale = session.ownerUserId
			? await getUserLanguage(session.ownerUserId).catch(() => "en" as const)
			: "en";
		const space = await outlineStore.ensureSpace(
			{ kind: "session", narratorId },
			new Date().toISOString(),
		);
		const ctx: Context = { session, space, locale, signal: options.signal, commits: 0 };
		const written = await writeEverything(ctx, files);
		tasks = written.tasks;
		pages = written.pages;
		commits = ctx.commits;
	}

	// Moved only when what was read is still what is there, and the outline still on.
	options.signal?.throwIfAborted();
	if (specImportMode() === "off") throw new Error("The outline was switched off during the import");
	if (session.namespaceId) {
		const now = await readSpecFilePointers(session.namespaceId);
		if (pointerKey(now) !== pointerKey(pointers))
			throw new Error("The session's Dynamic Spec changed during the import");
	}
	if (!(await switchSessionToOutline(narratorId))) {
		// Someone else moved it (or it is gone): what is there is right either way.
		invalidateTaskBackend(narratorId);
		throw new Error("The session was no longer a Dynamic Spec session when the import ended");
	}
	invalidateTaskBackend(narratorId);
	await afterMove(session, options);
	return { status: "imported", tasks, pages, unreadable, commits };
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
): Promise<{ tasks: number; pages: number }> {
	const { session, locale } = ctx;
	const { narratorId } = session;
	const tasksFile = files.find((p) => p.path === SPEC_TASKS_PATH) ?? null;
	const fenceFile = files.find((p) => p.path === "behavior_fence") ?? null;
	const notes = files.filter((p) => p !== tasksFile && p !== fenceFile);

	// The tasks first in memory (their plan decides what is stale), written after the notes.
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
			taskPlan = planSpecTasks({
				narratorId,
				revisionId: tasksFile.revisionId,
				tasks,
				normalized: await normalizeTasks(tasks, ctx.signal),
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

	// What an earlier attempt wrote from another revision goes first (step 2).
	const notePointers: Array<SpecImportFilePointer & { revisionId: string }> = notes.flatMap((p) =>
		p.revisionId ? [{ ...p, revisionId: p.revisionId }] : [],
	);
	const keep = new Set(
		[...notePointers, ...(brokenTasks !== null && tasksFile?.revisionId ? [tasksFile] : [])].map(
			(p) => specFileTag(narratorId, p.path, p.revisionId as string),
		),
	);
	await removeStale(ctx, keep, taskPlan?.sidPrefix ?? null);

	// Notes: a few files' contents read at a time, each converted and written before the next, so
	// the converted blocks of one file are held at a time, never the whole session's.
	let pages = 0;
	const writeFile = async (path: string, revisionId: string, text: string) => {
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

	if (taskPlan && taskPlan.tasks.length > 0) {
		const pageId = await ensureTasksPage(ctx);
		const summary = SPEC_IMPORT_TEXT[locale].summaryTasks(taskPlan.tasks.length);
		await writeNodes(ctx, taskPlan.tasks, { id: pageId }, summary, { heal: true });
		await writeNodes(ctx, taskPlan.notes, null, summary);
		await verifyTasks(ctx, taskPlan.expected, pageId);
	}

	if (fenceFile?.revisionId) {
		const content =
			(await readSpecRevisionContents([fenceFile.revisionId])).get(fenceFile.revisionId) ?? "";
		const fence = splitBehaviorFence(content);
		if (fence.own) await importBehaviorFenceText(narratorId, locale, fence.own);
		if (fence.sop)
			await writeImportedFenceSop(
				{ narratorId, ownerUserId: session.ownerUserId, locale },
				fence.sop,
			);
	}
	if (brokenTasks !== null)
		throw new SpecImportAttention(
			"tasks.json is not a valid task list: it was imported as a page, the session was not moved",
		);
	return { tasks: taskPlan?.tasks.length ?? 0, pages };
}

/** Files grouped so one read stays within the port's limits. */
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
 * The tasks' texts as the write path would store them, normalized off the main thread. A text
 * the dialect splits (several paragraphs, a list) is left to the write path, which splits it the
 * same way a `/goal` of that text is split: the first block is the task, the rest go under it.
 */
async function normalizeTasks(
	tasks: readonly SpecImportTask[],
	signal: AbortSignal | undefined,
): Promise<Array<NormalizedTaskText | null>> {
	if (tasks.length === 0) return [];
	const normalized = await processBackgroundText(
		{ kind: "normalize", contents: tasks.map((task) => task.text) },
		{ signal },
	);
	return tasks.map((_, i) => {
		const entry = normalized[i];
		return entry && entry.split.length === 0
			? { content: entry.content, links: entry.links }
			: null;
	});
}

/** What of `sids` is in the space already: its id and whether it is deleted. */
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
) {
	ctx.signal?.throwIfAborted();
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

/** A task of an earlier attempt whose checkbox or person mark is no longer the plan's. */
function drifted(found: OutlineBlockMeta, node: SpecImportNode): boolean {
	const now = found.taskJson;
	if (!now || !node.task) return true;
	return (
		now.status !== node.task.status ||
		(now.humanCreated === true) !== (node.task.humanCreated === true)
	);
}

/** The session's task page (alias `tasks`), made when it has none. */
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

/**
 * Take away what an earlier attempt wrote from a source that is not the one read now: the
 * import's tasks of another `tasks.json` revision on the task page (their notes go with them),
 * its pages of other file revisions, and its blocks of another `index.md` revision on the index
 * page. Only the import's own short ids are touched (`isImportSid`), and only before the session
 * is moved, while these blocks are nobody's work yet. Bounded reads; a page goes in a commit of
 * its own.
 */
async function removeStale(
	ctx: Context,
	keepFileTags: ReadonlySet<string>,
	taskSidPrefix: string | null,
): Promise<void> {
	const { space } = ctx;
	const limits = SPEC_IMPORT_LIMITS;
	const stale: string[] = [];
	const stalePages: string[] = [];
	const [tasksPage] = await outlineStore.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
	if (tasksPage) {
		for (const meta of await outlineStore.listLastChildMetas(
			space.id,
			tasksPage.id,
			limits.staleChildren,
		)) {
			if (!meta.sid.startsWith("st") || !isImportSid(meta.sid)) continue;
			if (taskSidPrefix === null || !meta.sid.startsWith(taskSidPrefix)) stale.push(meta.id);
		}
	}
	const [index] = await outlineStore.getBlockMetas(space.id, { sids: [specIndexSid()] });
	if (index && !index.deleted) {
		for (const meta of await outlineStore.listLastChildMetas(
			space.id,
			index.id,
			limits.staleChildren,
		)) {
			if (
				meta.sid.startsWith("sb") &&
				isImportSid(meta.sid) &&
				!keepFileTags.has(fileTagOfSid(meta.sid))
			)
				stale.push(meta.id);
		}
	}
	let after: { orderKey: string; id: string } | null = null;
	for (let read = 0; read < limits.stalePages; ) {
		const page = await outlineStore.listSpacePages(space.id, { after, limit: 100 });
		for (const row of page) {
			if (
				row.sid.startsWith("sp") &&
				isImportSid(row.sid) &&
				!keepFileTags.has(fileTagOfSid(row.sid))
			)
				stalePages.push(row.id);
		}
		read += page.length;
		const last = page[page.length - 1];
		if (page.length < 100 || !last) break;
		after = { orderKey: last.orderKey, id: last.id };
	}
	const summary = SPEC_IMPORT_TEXT[ctx.locale].summaryStale;
	for (let i = 0; i < stale.length; i += limits.staleDeletesPerCommit) {
		const ids = stale.slice(i, i + limits.staleDeletesPerCommit);
		await commit(
			ctx,
			ids.map((id) => ({ op: "delete" as const, block: { id } })),
			ids.map(() => null),
			summary,
		);
	}
	for (const id of stalePages)
		await commit(ctx, [{ op: "delete", block: { id } }], [null], summary);
}

/**
 * The imported tasks against the source, one by one (PR 12 design §2.5, step 1): all there, live,
 * on the task page in the source's order, with the planned text, checkbox, person mark and lock;
 * what is in progress claimed by the session; every note under its task. Bounded: the tasks (at
 * most 100) by short id, their contents and claims by id. A mismatch rejects (needs attention).
 */
async function verifyTasks(
	ctx: Context,
	expected: readonly SpecImportExpectedTask[],
	tasksPageId: string,
): Promise<void> {
	const { space, session } = ctx;
	const fail = (index: number, what: string): never => {
		throw new SpecImportAttention(`Imported task ${index + 1} does not match its source: ${what}`);
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
	const claimed = expected.flatMap((task, i) =>
		task.claimed ? [(tasks[i] as OutlineBlockMeta).id] : [],
	);
	const claims = new Map(
		(claimed.length > 0 ? await outlineStore.getTaskClaims(claimed) : []).map((row) => [
			row.taskBlockId,
			row,
		]),
	);
	for (const [i, task] of expected.entries()) {
		const meta = tasks[i] as OutlineBlockMeta;
		const json = meta.taskJson;
		if (meta.parentId !== tasksPageId) fail(i, "it is not on the task page");
		const before = i > 0 ? (tasks[i - 1] as OutlineBlockMeta) : null;
		if (before && compareOrderKeys(before.orderKey, meta.orderKey) >= 0) fail(i, "its order");
		if (!json) return fail(i, "it is not a task");
		if (json.status !== task.status) fail(i, `its checkbox is ${json.status}`);
		if ((json.humanCreated === true) !== task.humanCreated) fail(i, "its protection");
		const lockedByOwner = json.lock?.by.kind === "human" && json.lock.by.id === session.ownerUserId;
		if (lockedByOwner !== task.locked) fail(i, "its lock");
		if (task.content !== null && contents.get(meta.id) !== task.content) fail(i, "its text");
		if (task.claimed && claims.get(meta.id)?.holderNarratorId !== session.narratorId)
			fail(i, "it is not claimed by the session");
		for (const sid of task.noteSids) {
			const note = metas.get(sid);
			// A note a person deleted since is their choice; one that was never written is not.
			if (!note || (!note.deleted && note.parentId !== meta.id)) fail(i, "a note under it");
		}
	}
}
