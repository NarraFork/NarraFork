/**
 * "Open a new session for this" (outline P2 PR 10c-1; PR 10 design v2 §B and §F, owner decision
 * D54): a task of a project's space is done by a NEW session a person opens from the task board.
 * Old sessions are never woken to take a pool task.
 *
 * WHAT `openTaskSession` DOES, IN ORDER
 * -------------------------------------
 *   1. One request per task at a time (`oneAtATime`).
 *   2. Checks, before anything is created (the first that fails is the answer): the task is read
 *      by the person (404 otherwise); it is a task of a project space; the person may create
 *      sessions in the project (the project's write access, as `POST /api/narrators` asks) and
 *      write the task's space (403); the session runtime runs here (not on PostgreSQL); a second
 *      click of the same person within a minute gets the session the first one opened; the task
 *      is to do, nobody holds it, it is not in a plan that is not approved yet, it does not wait
 *      (prerequisites, an unanswered question, a change waiting for confirmation) and is not
 *      assigned to a person (`outlineTaskStartBlocker`, shared with delegation); it is still at
 *      the version the board read; the project has a working directory (or one was given).
 *      Asked to continue in the previous session's directory (`previousDirectory`), that is the
 *      directory of the session that last held the task, only when it is inside the project's
 *      own and still exists; otherwise `no_directory`.
 *   3. The session: a root session in the project, owned by the person, its tasks in the outline,
 *      titled after the task, with the defaults of any session created there (audiences,
 *      permission mode, continuation).
 *   4. The claim: one system commit (`outline-task-open`, for the new session, the person
 *      responsible) sets the task in progress against the version checked, so the write path
 *      claims it atomically for the session with the next claim generation. An assignment to an
 *      agent by name is cleared in the same commit. Refused (someone claimed or changed the task
 *      meanwhile): the empty session is archived and the answer names who is doing it, by title
 *      only to a person who may read that session.
 *   5. The opening brief: one `sys` row, the first of the session's history (`outline_task_brief`;
 *      see below).
 *   6. The start: `startSpecContinuationIfPossible` with the task preferred, as the board's "Add
 *      and start": the first turn runs for the person, whatever the continuation setting.
 *   A failure in 5 or 6 (or a start that did not happen) gives the claim back (a system commit
 *   sets the task back to do, nothing is attached under it) and archives the session. A process
 *   that stops between 3 and 6 leaves the claim on the running lease: the expiry job puts the
 *   task back to do; the empty session stays (it is the person's to delete).
 *
 * THE OPENING BRIEF (§F)
 * ----------------------
 * Written once, as history, never into the system prompt or a named context part: sessions of a
 * project keep a byte-identical system prompt and tool definitions (the prompt cache's shared
 * prefix), and the brief itself is in the cached prefix after the first request. It is a
 * snapshot: what changes later reaches the session through its current-tasks view and the team
 * activity. Its text does not depend on the time: the same outline renders the same bytes.
 * Within {@link OUTLINE_TASK_BRIEF_LIMITS.bytes} (the person's own note aside), in this order:
 * the head (title, goals above, address, the claim generation); the task's own text; the handoff
 * of the sessions that had the task before, when there is one (outline P2 PR 10c-2, `handoff.ts`:
 * the newest whole with the notes it links to, earlier ones by their first line; they are left
 * out of the notes that follow); the notes,
 * steps and questions under it and its prerequisites (the delegation brief's rendering,
 * `renderDelegationBrief`); the background (the nearest tasks above with their first paragraph,
 * and the nearest one's tasks, to place this one); the facts the task links to; a map of the
 * project space's pages; how to work and how to end (§B.4); the person's note. What an earlier
 * section leaves unused of its share, later ones may use.
 *
 * WHICH FACTS, WITHOUT RETRIEVAL (§F.2; D54: no retrieval now)
 * Only structure the outline already has, in three tiers: (1) the link targets of the task's own
 * text and of the blocks under it that were read; (2) those of the titles and first paragraphs of
 * the tasks above it; together at most {@link OUTLINE_TASK_BRIEF_LIMITS.facts}, each read in the
 * facts view within {@link OUTLINE_TASK_BRIEF_LIMITS.factBytes}; (3) the pages of the project
 * space, each with the first lines of its facts, the linked ones first. No full-text match, no
 * search by the task's title.
 *
 * WHOSE READ ACCESS (§F.3)
 * The NEW SESSION's own read scope (`OutlineAgentScope`, with no person behind it: nothing
 * personal), never the clicking person's: the brief is history, read by everyone who can read
 * the session. A target the session may not read shows as a placeholder, without title or address.
 *
 * COST
 * ----
 * Every read is indexed and bounded: the task's page structure (one read), bodies within the
 * budget, at most `facts` targets each one bounded read of its page, at most `pages` pages'
 * structure in one read (`pageBlocks` rows) and their first lines as content heads. One claim
 * commit and one injection per click.
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { AppError, ForbiddenError, NotFoundError } from "@server/lib/errors";
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import { blockTitle, parseAddress, type TaskStatus } from "@shared/outline";
import type { OutlineBoardOpenSessionRefusal } from "@shared/outline-task-board";
import type { SideCarBody } from "@shared/sidecar-body";
import { getNarratorMessageRefsPort } from "../narrator-refs/store";
import { canReadSpace, canWriteSpace, narratorVisibility, projectUsersWith } from "./access";
import { readDisplayNames, readProject } from "./access-reads";
import { OutlineAgentScope } from "./agent-scope";
import {
	clip,
	contentTargets,
	cutText,
	type DelegationBriefInput,
	linksAsText,
	readBriefInput,
	renderDelegationBrief,
	statusWord,
	utf8,
} from "./delegation";
import { TASK_BRIEF_TEXT } from "./delegation-text";
import {
	OutlineBusyError,
	OutlineConflictError,
	OutlineTaskClaimedError,
	OutlineWriteError,
} from "./errors";
import { isHandoffBlockId, OUTLINE_HANDOFF_LIMITS, previousSessionDirectory } from "./handoff";
import { linkDisplayTitle, linkTitles } from "./link-display";
import { oneAtATime } from "./person-tasks";
import { loadBodies, readOutline, readSubtree } from "./read";
import { outlineStore } from "./store";
import type { OutlineBlockRow, OutlineSpaceRow, OutlineStore } from "./store/port";
import { OutlineStaleWriteError } from "./store/port";
import { isPlanningRoot, type OutlineTaskStartBlocker, outlineTaskStartBlocker } from "./task-json";
import { deriveOutlineTaskWaits, isClaimLive } from "./tasks";
import { buildTree, type OutlineNode, viewChildren } from "./tree";
import { writeOutline } from "./write";

/** The system actor of the commit that claims a task for the session opened to do it. */
export const OUTLINE_TASK_OPEN_ACTOR = "outline-task-open";
/** The injection source of the opening brief (`docs/INJECTION.md`). */
export const OUTLINE_TASK_BRIEF_SOURCE = "outline_task_brief";

export const OUTLINE_TASK_BRIEF_LIMITS = {
	/** UTF-8 bytes of the whole brief, the person's own note aside. */
	bytes: 16 * 1024,
	/** Of them, at most this many for the task's own text. */
	bodyBytes: 3 * 1024,
	/** At most this many for the handoffs of the sessions before (the newest whole). */
	handoffBytes: 2560,
	/** UTF-8 bytes of one line of a handoff, and of one note it points to. */
	handoffLineBytes: 400,
	handoffNoteBytes: 800,
	/** The share of the background, the linked facts and the map of pages. */
	backgroundBytes: 1800,
	factsBytes: 3 * 1024,
	pagesBytes: 1536,
	/** Tasks above the task the background names, nearest first. */
	ancestors: 3,
	/** Characters of a background paragraph (the plan format's context paragraph). */
	contextChars: 400,
	/** Tasks of the nearest task above that are listed. */
	siblings: 10,
	/** Link targets read as facts (the task's own first, then those of the tasks above). */
	facts: 8,
	/** UTF-8 bytes and blocks of one fact as read. */
	factBytes: 600,
	factBlocks: 12,
	/** Pages of the project space the map lists, and first lines of each. */
	pages: 20,
	pageLines: 5,
	/** Pages read (their heads only) to count those the map does not list. */
	pagesCounted: 200,
	/** Structure rows read for the map's pages in all. */
	pageBlocks: 2000,
	/** Characters of a line of the map. */
	lineChars: 120,
	/** Characters of the session's title (the task's). */
	titleChars: 80,
} as const;

export const OUTLINE_TASK_SESSION_LIMITS = {
	/** A second click of the same person within this gets the session the first opened. */
	repeatMs: 60_000,
	/** Tasks whose opened session is remembered for that (in memory). */
	remembered: 1000,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Refusals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a session was not opened for a task: one of the shared start conditions
 * (`OutlineTaskStartBlocker`), or `unavailable` (the session runtime does not run on this store:
 * PostgreSQL), `not_project_task`, `no_directory` (the project has no working directory, or the
 * one given is not a directory), `in_progress` (in progress already: someone was doing it until
 * their lease ran out), `claimed` (someone holds it: `holder` says who), `changed` (since the
 * board read it), `unreadable` (the session created could not read the task's space: it was
 * archived before anything was claimed or written), `start_failed` (the session could not be
 * started; the claim was given back).
 */
export type OutlineTaskSessionRefusal = OutlineBoardOpenSessionRefusal;
// The shared conditions are all refusals (a new one must be told to the client too).
const _startBlockersAreRefusals: OutlineTaskSessionRefusal = "finished" as OutlineTaskStartBlocker;
void _startBlockersAreRefusals;

/** Who is doing a task, as a refusal names them (a session's title only to its readers). */
export interface OutlineTaskSessionHolder {
	kind: "session" | "human";
	narratorId?: string;
	name: string | null;
}

const REFUSAL_TEXT: Record<OutlineTaskSessionRefusal, string> = {
	finished: "The task is finished already",
	planning: "The task is part of a plan that is not approved yet",
	prerequisites: "The task waits for its prerequisites",
	people: "The task waits for an answer to a question under it",
	confirmation: "The task waits for a change to be confirmed",
	assigned_to_person: "The task is assigned to a person",
	unavailable:
		"Sessions cannot be opened for tasks on this deployment (the session runtime does not run on PostgreSQL)",
	not_project_task: "Only a task of a project's space can be given a new session",
	no_directory: "The project has no working directory to open a session in",
	in_progress: "The task is in progress already",
	claimed: "Someone is doing the task already",
	unreadable: "The new session could not read the task's space, so it was not given the task",
	changed: "The task changed since it was read",
	start_failed: "The session could not be started; the task is back to do",
};

/** A refusal of `openTaskSession`: nothing is left behind (no session, no claim). */
export class OutlineTaskSessionError extends AppError {
	constructor(
		readonly reason: OutlineTaskSessionRefusal,
		readonly holder: OutlineTaskSessionHolder | null = null,
	) {
		super(
			holder?.name ? `${REFUSAL_TEXT[reason]}: ${holder.name}` : REFUSAL_TEXT[reason],
			reason === "start_failed" ? 500 : 409,
			`OUTLINE_TASK_SESSION_${reason.toUpperCase()}`,
			undefined,
			{ reason, ...(holder ? { holder } : {}) },
		);
		this.name = "OutlineTaskSessionError";
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The session layer (a seam tests replace)
// ─────────────────────────────────────────────────────────────────────────────

/** What opening a session needs of the session layer. */
export interface OutlineTaskSessionRuntime {
	/** Whether the session runtime runs on this store (it does not on PostgreSQL). */
	available(): boolean;
	/** The project's working directory (`gitPath`), or null. */
	projectDir(projectId: string): Promise<string | null>;
	/** Create the root session; returns its id. */
	createSession(input: {
		projectId: string;
		cwd: string;
		model?: string;
		ownerUserId: string;
		title: string;
	}): Promise<string>;
	/** Write the opening brief as the session's first row. False when nothing was written. */
	deliverBrief(narratorId: string, userId: string, content: string): Promise<boolean>;
	/** Start the session's first turn on the task, for the person. */
	start(narratorId: string, userId: string, taskId: string): Promise<boolean>;
	/** Archive a session that never ran. */
	archive(narratorId: string): Promise<void>;
}

const realRuntime: OutlineTaskSessionRuntime = {
	// Resolved by the composition root; the port exists only on PostgreSQL.
	available: () => !getNarratorMessageRefsPort(),
	async projectDir(projectId) {
		const [{ db }, { projects }, { eq }] = await Promise.all([
			import("@server/db"),
			import("@server/db/schema"),
			import("drizzle-orm"),
		]);
		const project = await db.query.projects.findFirst({
			where: eq(projects.id, projectId),
			columns: { gitPath: true },
		});
		return project?.gitPath?.trim() || null;
	},
	async createSession(input) {
		const [
			{ narratorService },
			{ normalizeDefaultNarratorVisibility, resolveNarratorAudiences },
			{ settings },
			{ normalizeAutoModelValueForSave },
		] = await Promise.all([
			import("../narrator-service"),
			import("@server/lib/narrator-audiences"),
			import("@server/lib/settings"),
			import("@server/lib/settings/provider"),
		]);
		// The defaults of a session created on the project's page (`routes/narrators.ts`), except
		// that a task session is never public by default: a public session cannot read a private
		// project's space, and its brief and title are the task's content. The narrowest audience
		// whose readers all read the project space: the owner alone when the instance default is
		// private, the project's readers otherwise.
		const audiences = resolveNarratorAudiences(
			normalizeDefaultNarratorVisibility(settings.agent.defaultNarratorVisibility) === "private"
				? "private"
				: "project",
			undefined,
			input.projectId,
			settings.agent.defaultNarratorVisibility,
			settings.agent.defaultNarratorWriteAudience,
		);
		const narrator = await narratorService.create({
			...audiences,
			contextProjectId: input.projectId,
			cwd: input.cwd,
			model: normalizeAutoModelValueForSave(input.model),
			ownerUserId: input.ownerUserId,
			title: input.title,
			taskBackend: "outline",
			// Whatever the instance default: a session in plan mode would not start on the task.
			startInPlanMode: false,
		});
		return narrator.id;
	},
	async deliverBrief(narratorId, userId, content) {
		const [{ deliverInjection }, { getUserLanguage }] = await Promise.all([
			import("../narrator-injection"),
			import("@server/lib/i18n"),
		]);
		const body: SideCarBody = { kind: "prose", text: content };
		const result = await deliverInjection(narratorId, {
			content,
			body,
			source: OUTLINE_TASK_BRIEF_SOURCE,
			role: "sys",
			schedule: "none",
			locale: await getUserLanguage(userId).catch(() => "en" as const),
		});
		return result.messageId !== null;
	},
	async start(narratorId, userId, taskId) {
		const [{ startSpecContinuationIfPossible }, { getUserLanguage, getUserReplyInLanguage }] =
			await Promise.all([import("../narrator-session"), import("@server/lib/i18n")]);
		const [locale, reply] = await Promise.all([
			getUserLanguage(userId),
			getUserReplyInLanguage(userId),
		]);
		// The session exists for this task alone: its run is the system's, so a run that ends with
		// the task unfinished gives it back at once (`release.ts`).
		const { started } = await startSpecContinuationIfPossible(narratorId, locale, reply, userId, {
			preferTaskId: taskId,
			initiatedBy: "system",
		});
		return started;
	},
	async archive(narratorId) {
		const { interruptAndArchiveSubagent } = await import("../subagent-lifecycle");
		const result = await interruptAndArchiveSubagent(narratorId);
		if (!result.ok) throw new Error(result.error ?? "the session was not archived");
	},
};

let runtimeSeam: Partial<OutlineTaskSessionRuntime> | null = null;

/** Replace parts of the session layer (tests); null restores the real one. Returns the previous. */
export function setOutlineTaskSessionRuntime(
	next: Partial<OutlineTaskSessionRuntime> | null,
): Partial<OutlineTaskSessionRuntime> | null {
	const previous = runtimeSeam;
	runtimeSeam = next;
	return previous;
}

function runtime(): OutlineTaskSessionRuntime {
	return runtimeSeam ? { ...realRuntime, ...runtimeSeam } : realRuntime;
}

/**
 * Whether sessions can be opened for tasks on this deployment (the board hides the button). A
 * store binding that cannot be resolved counts as "no": a board must not fail on it.
 */
export function outlineTaskSessionsAvailable(): boolean {
	try {
		return runtime().available();
	} catch {
		return false;
	}
}

/** A project's working directory, for the board (null: no button). */
export async function outlineTaskSessionProjectDir(projectId: string): Promise<string | null> {
	return await runtime()
		.projectDir(projectId)
		.catch(() => null);
}

// ─────────────────────────────────────────────────────────────────────────────
// A hook for the automatic switch (design §B.8): not built yet
// ─────────────────────────────────────────────────────────────────────────────

type TaskStartableListener = (taskId: string) => void;
const startableListeners = hotSafe(
	"narrafork.outline.taskStartableListeners",
	() => new Set<TaskStartableListener>(),
);

/**
 * Listen for "this project task became startable" (created, its last prerequisite finished, let
 * go). Nothing announces it yet and nothing listens: the commit listener of the team events
 * (PR 10a′) will call {@link announceTaskStartable}, and the project's automatic switch
 * (`chapterSettings.outline.autoOpen`, a later PR) will listen and call `openTaskSession` with
 * `by: { kind: "auto" }`. Returns the function that stops listening.
 */
export function onTaskStartable(listener: TaskStartableListener): () => void {
	startableListeners.add(listener);
	return () => startableListeners.delete(listener);
}

/** Tell the listeners a project task became startable (see {@link onTaskStartable}). */
export function announceTaskStartable(taskId: string): void {
	for (const listener of startableListeners) {
		try {
			listener(taskId);
		} catch (error) {
			logger.warn("A task-startable listener failed", { taskId, error: String(error) });
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The opening brief
// ─────────────────────────────────────────────────────────────────────────────

/** A fact the task (or a task above it) links to, as the brief shows it. */
export type TaskBriefFact =
	| {
			address: string;
			title: string;
			/** The target read in the facts view, within the limits. */
			text: string;
	  }
	/** A target the session may not read (or that is gone): no title, no address. */
	| { unreadable: true };

export interface TaskBriefInput extends DelegationBriefInput {
	/** `key/sid`. */
	address: string;
	/** The claim generation the session holds the task at. */
	epoch: number;
	/** The tasks above, nearest first: title, first paragraph, and the nearest one's tasks. */
	background: Array<{
		title: string;
		context: string | null;
		siblings?: Array<{ title: string; status: TaskStatus; self: boolean }>;
	}>;
	/**
	 * The handoffs of the sessions that gave the task back (`handoff.ts`), when there are any: the
	 * newest whole, with the notes it points to in full; the earlier ones by their first line.
	 */
	handoff?: TaskBriefHandoff | null;
	facts: TaskBriefFact[];
	/** The project space's pages, those linked first. */
	pages: Array<{ address: string; title: string; linked: boolean; lines: string[] }>;
	/** Pages past the ones listed. */
	morePages: number;
}

export interface TaskBriefHandoff {
	/** How many handoffs are under the task. */
	times: number;
	/** The newest handoff's first line and the lines under it. */
	head: string;
	lines: string[];
	/** The notes it links to, as written. */
	notes: Array<{ address: string; text: string }>;
	/** First lines of the earlier handoffs, newest first. */
	earlier: string[];
}

/** The handoff section within `max` bytes: the newest handoff first, whole before anything else. */
function handoffSection(handoff: TaskBriefHandoff, max: number): string[] {
	const limits = OUTLINE_TASK_BRIEF_LIMITS;
	const text = TASK_BRIEF_TEXT;
	const out = ["", text.handoff, text.handoffNote(handoff.times)];
	out.push(`- ${cutText(handoff.head, limits.handoffLineBytes)}`);
	for (const line of handoff.lines) out.push(`  - ${cutText(line, limits.handoffLineBytes)}`);
	let left = max - cost(out);
	const add = (lines: string[]): boolean => {
		if (cost(lines) > left) return false;
		out.push(...lines);
		left -= cost(lines);
		return true;
	};
	if (handoff.notes.length > 0 && add([text.handoffNotes])) {
		for (const note of handoff.notes) {
			const [first = "", ...rest] = cutText(note.text.trim(), limits.handoffNoteBytes).split("\n");
			const lines = [text.handoffNoteAt(note.address), `  ${first}`, ...rest.map((l) => `  ${l}`)];
			if (!add(lines)) break;
		}
	}
	if (handoff.earlier.length > 0 && add([text.handoffEarlier])) {
		for (const line of handoff.earlier)
			if (!add([`- ${cutText(line, limits.handoffLineBytes)}`])) break;
	}
	return out;
}

const cost = (lines: readonly string[]) => (lines.length === 0 ? 0 : utf8(lines.join("\n")) + 1);

/**
 * A section within `max` bytes: its heading, then the `groups` in order. Every group is first
 * given its short form (`fallback`: a target's title and address, say), as many as fit; then, in
 * order, each is shown whole while that still fits. So what does not fit whole is still named,
 * and a line counts what is not even named. Nothing at all when not even the first fits.
 */
function takeGroups(
	heading: readonly string[],
	groups: ReadonlyArray<{ lines: string[]; fallback?: string[] }>,
	max: number,
	/** Entries past `groups` that were not read: counted with those that did not fit. */
	unread = 0,
): string[] {
	const out: string[] = ["", ...heading];
	const budget = max - cost(out) - utf8(TASK_BRIEF_TEXT.more(99999)) - 1;
	const short = groups.map((group) => group.fallback ?? group.lines);
	let used = 0;
	let named = 0;
	while (named < groups.length && used + cost(short[named] as string[]) <= budget) {
		used += cost(short[named] as string[]);
		named++;
	}
	if (named === 0) return [];
	let whole = 0;
	for (; whole < named; whole++) {
		const extra =
			cost((groups[whole] as { lines: string[] }).lines) - cost(short[whole] as string[]);
		if (used + extra > budget) break;
		used += extra;
	}
	for (let index = 0; index < named; index++)
		out.push(
			...(index < whole
				? (groups[index] as { lines: string[] }).lines
				: (short[index] as string[])),
		);
	const hidden = groups.length - named + unread;
	if (hidden > 0) out.push(TASK_BRIEF_TEXT.more(hidden));
	return out;
}

/**
 * The opening brief (see the module header): plain markdown within `budget` bytes, the person's
 * note aside. Pure, and the same input renders the same bytes.
 */
export function renderTaskBrief(
	input: TaskBriefInput,
	budget: number = OUTLINE_TASK_BRIEF_LIMITS.bytes,
): string {
	const limits = OUTLINE_TASK_BRIEF_LIMITS;
	const text = TASK_BRIEF_TEXT;
	// Each later section's share is kept back from the earlier ones; a small budget scales them.
	const scale = Math.min(1, budget / limits.bytes);
	const share = {
		background: Math.floor(limits.backgroundBytes * scale),
		facts: Math.floor(limits.factsBytes * scale),
		pages: Math.floor(limits.pagesBytes * scale),
	};
	const background = input.background.map((above, index) => {
		const lines = [text.ancestor(clip(above.title))];
		if (above.context) lines.push(`  ${clip(above.context, limits.contextChars)}`);
		if (index === 0 && above.siblings && above.siblings.length > 0) {
			lines.push(text.siblings);
			for (const s of above.siblings)
				lines.push(text.sibling(clip(s.title), statusWord(s.status), s.self));
		}
		return { lines, fallback: [lines[0] as string] };
	});
	const facts = input.facts.map((fact) =>
		"unreadable" in fact
			? { lines: [text.factUnreadable] }
			: {
					lines: [text.fact(fact.address), cutText(fact.text.trim(), limits.factBytes)],
					fallback: [text.factLine(clip(fact.title), fact.address)],
				},
	);
	const pages = input.pages.map((page) => {
		const head = text.page(clip(page.title), page.address, page.linked);
		return {
			lines: [head, ...page.lines.map((line) => text.pageLine(clip(line, limits.lineChars)))],
			fallback: [head],
		};
	});
	return renderDelegationBrief(input, budget, {
		head: text.head(input.address, input.epoch),
		bodyBytes: Math.floor(limits.bodyBytes * scale),
		reserve: share.background + share.facts + share.pages,
		closing: text.rules,
		...(input.handoff
			? { before: handoffSection(input.handoff, Math.floor(limits.handoffBytes * scale)) }
			: {}),
		after: (left) => {
			const out: string[] = [];
			let rest = left;
			const section = (lines: string[]) => {
				out.push(...lines);
				rest -= cost(lines);
			};
			section(
				takeGroups([text.background], background, Math.max(0, rest - share.facts - share.pages)),
			);
			section(takeGroups([text.facts], facts, Math.max(0, rest - share.pages)));
			section(takeGroups([text.pages, text.pagesNote], pages, Math.max(0, rest), input.morePages));
			return out;
		},
	});
}

/** A link target (`key/sid` or `key/alias`) as a live block the session may read, or null. */
async function resolveTarget(
	target: string,
	scope: OutlineAgentScope,
	store: OutlineStore,
): Promise<{ block: OutlineBlockRow; space: OutlineSpaceRow } | null> {
	const slash = target.indexOf("/");
	if (slash <= 0) return null;
	const space = await scope.spaceByKey(target.slice(0, slash));
	if (!space) return null;
	const name = target.slice(slash + 1);
	const [meta] = await store.getBlockMetas(space.id, { sids: [name] });
	let id = meta && !meta.deleted ? meta.id : null;
	if (!id && !meta) {
		const [found, second] = await store.findLiveBlocks([space.id], { alias: name }, 2);
		if (found && !second) id = found.id;
	}
	const block = id ? await store.getBlock(id) : null;
	return block && !block.deleted ? { block, space } : null;
}

/**
 * What the opening brief shows, read with the session's own read scope (bounded; see the module
 * header and the limits).
 */
export async function readTaskBrief(args: {
	block: OutlineBlockRow;
	space: OutlineSpaceRow;
	scope: OutlineAgentScope;
	epoch: number;
	store?: OutlineStore;
}): Promise<TaskBriefInput | null> {
	const { block, space, scope } = args;
	const store = args.store ?? outlineStore;
	const limits = OUTLINE_TASK_BRIEF_LIMITS;
	// Nothing of a space the session may not read is ever put into its history.
	if (!(await scope.canRead(space))) return null;
	const subtree = await readSubtree(block.id, { store });
	if (!subtree) return null;
	// The handoffs are shown in their own section, before the notes, so earlier siblings cannot
	// crowd the newest one out.
	const handoffs = subtree.root.children.filter((child) => isHandoffBlockId(child.id));
	const found = {
		targets: [] as string[],
		omit: (node: OutlineNode) => isHandoffBlockId(node.id),
	};
	const core = await readBriefInput(block, subtree, scope, store, found);
	const handoff = await readHandoffs(subtree, handoffs, space, store);

	// The tasks above, nearest first; their first paragraph is their first block that is a fact.
	const above = subtree.path
		.filter((node) => node.task !== null)
		.reverse()
		.slice(0, limits.ancestors);
	const nearest = above[0];
	const contexts = new Map<OutlineNode, OutlineNode>();
	for (const node of above) {
		const first = viewChildren(node, "facts")[0];
		if (first) contexts.set(node, first);
	}
	const siblings = nearest
		? nearest.children.filter((child) => child.task !== null).slice(0, limits.siblings)
		: [];
	await loadBodies(subtree.state, [...above, ...contexts.values(), ...siblings], { store });
	const aboveTexts = above.flatMap((node) => [
		node.content ?? "",
		contexts.get(node)?.content ?? "",
	]);

	// Tier 1 (the task and what is under it), then tier 2 (the tasks above), in order.
	const targets: string[] = [];
	for (const target of [...found.targets, ...aboveTexts.flatMap(contentTargets)]) {
		if (targets.length >= limits.facts) break;
		if (parseAddress(target) && !targets.includes(target)) targets.push(target);
	}
	const titles = await linkTitles(aboveTexts.flatMap(contentTargets), {
		store,
		canRead: (s) => scope.canRead(s),
		spaceByKey: (key) => scope.spaceByKey(key),
	});
	const shown = (content: string | null | undefined) => linksAsText(content ?? "", titles).trim();

	const inTask = new Set<string>([block.id]);
	for (const stack = [...subtree.root.children]; stack.length > 0; ) {
		const node = stack.pop() as OutlineNode;
		inTask.add(node.id);
		stack.push(...node.children);
	}
	const facts: TaskBriefFact[] = [];
	const linkedPages = new Set<string>();
	for (const target of targets) {
		const resolved = await resolveTarget(target, scope, store);
		if (!resolved) {
			facts.push({ unreadable: true });
			continue;
		}
		linkedPages.add(resolved.block.pageId);
		// What is under the task is shown with it already.
		if (inTask.has(resolved.block.id)) continue;
		const read = await readOutline({
			blockId: resolved.block.id,
			view: "facts",
			budget: { blocks: limits.factBlocks, bytes: limits.factBytes },
			store,
		});
		if (!read) {
			facts.push({ unreadable: true });
			continue;
		}
		facts.push({
			address: `${resolved.space.key}/${resolved.block.sid}`,
			title: linkDisplayTitle(blockTitle(resolved.block.content)) ?? resolved.block.sid,
			text: read.markdown,
		});
	}

	// The map: the project space's pages (the task's own page is process, not facts).
	const listed = await store.listSpacePages(space.id, { limit: limits.pagesCounted });
	const candidates = listed.filter((page) => page.id !== block.pageId && !page.isTask);
	const mapped = candidates.slice(0, limits.pages);
	const lines = new Map<string, string[]>();
	if (mapped.length > 0) {
		const { rows } = await store.listPagesStructure(
			mapped.map((page) => page.id),
			limits.pageBlocks,
		);
		const nodes = buildTree(rows);
		const firsts = new Map<string, OutlineNode[]>();
		for (const page of mapped) {
			const node = nodes.get(page.id);
			firsts.set(page.id, node ? viewChildren(node, "facts").slice(0, limits.pageLines) : []);
		}
		const heads = new Map(
			(await store.getBlockHeads([...firsts.values()].flat().map((node) => node.id))).map(
				(head) => [head.id, blockTitle(head.contentHead)],
			),
		);
		for (const [pageId, list] of firsts)
			lines.set(
				pageId,
				list.map((node) => heads.get(node.id) ?? "").filter((line) => line.trim() !== ""),
			);
	}
	const pages = mapped
		.map((page) => ({
			address: `${space.key}/${page.sid}`,
			title: blockTitle(page.contentHead) || page.sid,
			linked: linkedPages.has(page.id),
			lines: lines.get(page.id) ?? [],
		}))
		// Linked pages first; the others keep the space's page order.
		.sort((a, b) => Number(b.linked) - Number(a.linked));

	return {
		...core,
		address: `${space.key}/${block.sid}`,
		epoch: args.epoch,
		background: above.map((node, index) => ({
			title: blockTitle(shown(node.content)) || node.sid,
			context: contexts.has(node) ? shown(contexts.get(node)?.content) || null : null,
			...(index === 0 && siblings.length > 0
				? {
						siblings: siblings.map((child) => ({
							title: blockTitle(shown(child.content)) || child.sid,
							status: (child.task?.status ?? "todo") as TaskStatus,
							self: child.id === block.id,
						})),
					}
				: {}),
		})),
		handoff,
		facts,
		pages,
		morePages: Math.max(0, candidates.length - mapped.length),
	};
}

/**
 * The handoffs under the task as the brief shows them: the newest with its lines and the notes it
 * links to (blocks under the task itself, so of the space the session reads), the earlier ones by
 * their first line (at most the newest {@link OUTLINE_HANDOFF_LIMITS.counted}).
 */
async function readHandoffs(
	subtree: NonNullable<Awaited<ReturnType<typeof readSubtree>>>,
	handoffs: readonly OutlineNode[],
	space: OutlineSpaceRow,
	store: OutlineStore,
): Promise<TaskBriefHandoff | null> {
	const newest = handoffs[handoffs.length - 1];
	if (!newest) return null;
	const earlier = handoffs.slice(0, -1).reverse().slice(0, OUTLINE_HANDOFF_LIMITS.counted);
	await loadBodies(subtree.state, [newest, ...newest.children, ...earlier], { store });
	const shown = (node: OutlineNode) => linksAsText(node.content ?? "", new Map()).trim();
	// The notes it links to: blocks under this task, by their address in this space.
	const bySid = new Map<string, OutlineNode>();
	for (const stack = [...subtree.root.children]; stack.length > 0; ) {
		const node = stack.pop() as OutlineNode;
		bySid.set(node.sid, node);
		stack.push(...node.children);
	}
	const linked: OutlineNode[] = [];
	for (const line of newest.children)
		for (const target of contentTargets(line.content ?? "")) {
			const address = parseAddress(target);
			const node = address?.space === space.key ? bySid.get(address.sid) : undefined;
			if (node && !linked.includes(node) && linked.length < OUTLINE_HANDOFF_LIMITS.notes)
				linked.push(node);
		}
	await loadBodies(subtree.state, linked, { store });
	return {
		times: handoffs.length,
		head: shown(newest),
		lines: newest.children.map(shown).filter((line) => line !== ""),
		notes: linked.flatMap((node) =>
			node.content?.trim()
				? [{ address: `${space.key}/${node.sid}`, text: linksAsText(node.content, new Map()) }]
				: [],
		),
		earlier: earlier.map((node) => blockTitle(shown(node))).filter((line) => line !== ""),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening a session
// ─────────────────────────────────────────────────────────────────────────────

/** Who asks for the session: a person now; the project's automatic switch later (§B.8). */
export type OutlineTaskSessionOpener =
	| { kind: "human"; userId: string; isAdmin: boolean }
	| { kind: "auto"; projectId: string };

export interface OutlineTaskSessionOpened {
	narratorId: string;
	/** The first turn was started. */
	started: boolean;
	/** The claim generation the session holds the task at. */
	epoch: number;
	/** The session a click just before this one opened: nothing new was created. */
	already?: true;
}

interface Remembered {
	narratorId: string;
	userId: string;
	at: number;
	epoch: number;
}

/** Sessions just opened, by task: a repeated click finds them (in memory; a restart forgets). */
const opened = hotSafe("narrafork.outline.taskSessionsOpened", () => new Map<string, Remembered>());

function remember(taskId: string, entry: Remembered): void {
	opened.delete(taskId);
	opened.set(taskId, entry);
	while (opened.size > OUTLINE_TASK_SESSION_LIMITS.remembered) {
		const oldest = opened.keys().next().value;
		if (oldest === undefined) break;
		opened.delete(oldest);
	}
}

/** Forget the sessions just opened (tests). */
export function resetOutlineTaskSessionsForTests(): void {
	opened.clear();
}

/** Who holds a claim, named as far as the person may know. */
async function holderFor(
	holder: { narratorId: string | null; userId: string | null },
	canSee: (narratorId: string) => Promise<boolean>,
	store: OutlineStore,
): Promise<OutlineTaskSessionHolder | null> {
	if (holder.userId) {
		const names = await readDisplayNames({ userIds: [holder.userId] }).catch(() => null);
		return { kind: "human", name: names?.users.get(holder.userId) ?? null };
	}
	if (!holder.narratorId) return null;
	// A subagent's claim is its session's work.
	const roots = await store.getNarratorRoots([holder.narratorId]).catch(() => new Map());
	const root = roots.get(holder.narratorId)?.root ?? holder.narratorId;
	if (!(await canSee(root))) return { kind: "session", name: null };
	const names = await readDisplayNames({ narratorIds: [root] }).catch(() => null);
	return { kind: "session", narratorId: root, name: names?.narrators.get(root) ?? null };
}

/** Errors that mean the write path refused the claim (the task was taken or changed meanwhile). */
function isRefusedClaim(error: unknown): boolean {
	return (
		error instanceof OutlineTaskClaimedError ||
		error instanceof OutlineConflictError ||
		error instanceof OutlineBusyError ||
		error instanceof OutlineStaleWriteError ||
		error instanceof OutlineWriteError
	);
}

/**
 * Whether a session can be opened for the task now, as far as the task itself says: the checks
 * of step 2 that need no person. Null when it can. `claimLive`: someone holds the task, or a
 * task above it (its steps are then theirs).
 */
export async function taskSessionBlocker(
	block: Pick<OutlineBlockRow, "id" | "spaceId" | "taskJson">,
	facts: { planning: boolean; claimLive: boolean },
	options: { store?: OutlineStore } = {},
): Promise<OutlineTaskSessionRefusal | null> {
	const task = block.taskJson;
	if (!task) return "finished";
	if (task.status === "done" || task.status === "cancelled") return "finished";
	if (facts.claimLive) return "claimed";
	if (task.status !== "todo") return "in_progress";
	if (facts.planning) return "planning";
	const wait = (
		await deriveOutlineTaskWaits([{ id: block.id, spaceId: block.spaceId, taskJson: task }], {
			store: options.store,
		})
	).get(block.id);
	return outlineTaskStartBlocker({ task, planning: false, wait });
}

/**
 * Open a new session for a project task and start it (the module header's steps). Throws
 * `NotFoundError` (404), `ForbiddenError` (403) or {@link OutlineTaskSessionError} (409; 500 for
 * `start_failed`); after any of them no session and no claim is left behind.
 */
export async function openTaskSession(args: {
	taskId: string;
	/** The task's `version_seq` as the board read it. */
	baseVersionSeq: number;
	by: OutlineTaskSessionOpener;
	options?: {
		model?: string;
		/** A working directory other than the project's. */
		cwd?: string;
		/**
		 * The directory of the session that last held the task (`previousSessionDirectory`): the
		 * person continues where its uncommitted work is. Refused when there is none any more.
		 */
		previousDirectory?: boolean;
		/** The person's own note, added to the brief as it is. */
		note?: string;
	};
	store?: OutlineStore;
	now?: () => Date;
}): Promise<OutlineTaskSessionOpened> {
	return await oneAtATime(`open:${args.taskId}`, () => openOne(args));
}

async function openOne(
	args: Parameters<typeof openTaskSession>[0],
): Promise<OutlineTaskSessionOpened> {
	const store = args.store ?? outlineStore;
	const { taskId, by } = args;
	const run = runtime();
	// The automatic switch is not built: only a person opens sessions (D54).
	if (by.kind !== "human") throw new OutlineTaskSessionError("unavailable");
	const principal = { userId: by.userId, isAdmin: by.isAdmin };

	// ── 2. Checks: nothing is created before they pass. ──
	const block = await store.getBlock(taskId);
	const space = block ? await store.getSpace(block.spaceId) : null;
	if (!block || block.deleted || !space || !block.taskJson)
		throw new NotFoundError("Outline task", taskId);
	if (!(await canReadSpace(principal, space))) throw new NotFoundError("Outline task", taskId);
	if (space.kind !== "project" || !space.projectId)
		throw new OutlineTaskSessionError("not_project_task");
	const project = await readProject(space.projectId);
	if (!project) throw new NotFoundError("Outline task", taskId);
	const mayCreate =
		principal.isAdmin ||
		(await projectUsersWith(project, [principal.userId], "write")).has(principal.userId);
	if (!mayCreate || !(await canWriteSpace(principal, space)))
		throw new ForbiddenError("You cannot open a session for this task");
	if (!outlineTaskSessionsAvailable()) throw new OutlineTaskSessionError("unavailable");

	const now = (args.now?.() ?? new Date()).toISOString();
	const claim = (await store.getTaskClaims([taskId]))[0] ?? null;
	const live = !!claim && isClaimLive(claim, now);
	// The same person clicking again right after: the session the first click opened.
	const before = opened.get(taskId);
	if (
		before &&
		before.userId === principal.userId &&
		Date.parse(now) - before.at < OUTLINE_TASK_SESSION_LIMITS.repeatMs &&
		live &&
		claim?.holderNarratorId === before.narratorId &&
		block.taskJson.status === "doing"
	)
		return { narratorId: before.narratorId, started: true, epoch: before.epoch, already: true };

	const subtree = await readSubtree(taskId, { store });
	if (!subtree) throw new NotFoundError("Outline task", taskId);
	// A task above it that someone is doing: its steps are theirs (nearest first).
	const above = subtree.path.filter((node) => node.task !== null).reverse();
	const aboveClaims =
		above.length > 0
			? new Map((await store.getTaskClaims(above.map((n) => n.id))).map((c) => [c.taskBlockId, c]))
			: new Map();
	const heldAbove =
		above.map((node) => aboveClaims.get(node.id)).find((c) => c && isClaimLive(c, now)) ?? null;
	const blocking = live ? claim : heldAbove;
	const refusal = await taskSessionBlocker(
		block,
		{
			planning: [subtree.root, ...subtree.path].some((node) => isPlanningRoot(node.task)),
			claimLive: live || heldAbove !== null,
		},
		{ store },
	);
	if (refusal) {
		const holder =
			refusal === "claimed" && blocking
				? await holderFor(
						{ narratorId: blocking.holderNarratorId, userId: blocking.holderUserId },
						narratorVisibility(principal),
						store,
					)
				: null;
		throw new OutlineTaskSessionError(refusal, holder);
	}
	if (block.versionSeq !== args.baseVersionSeq) throw new OutlineTaskSessionError("changed");
	const projectDir = await run.projectDir(space.projectId);
	const cwd = args.options?.previousDirectory
		? ((await previousSessionDirectory(store, claim, projectDir).catch(() => null))?.path ?? null)
		: args.options?.cwd?.trim() || projectDir;
	if (!cwd || !isAbsolute(cwd) || !isDirectory(cwd))
		throw new OutlineTaskSessionError("no_directory");

	// ── 3. The session. ──
	const title = clip(blockTitle(block.content) || block.sid, OUTLINE_TASK_BRIEF_LIMITS.titleChars);
	const narratorId = await run.createSession({
		projectId: space.projectId,
		cwd,
		...(args.options?.model?.trim() ? { model: args.options.model.trim() } : {}),
		ownerUserId: principal.userId,
		title,
	});
	const address = `${space.key}/${block.sid}`;
	// The session's own read scope, with no person behind it (see the module header). A session
	// that cannot read the task's space is given nothing: no claim, no brief.
	const scope = await OutlineAgentScope.open({ narratorId, userId: null }).catch(() => null);
	if (!scope || !(await scope.canRead(space).catch(() => false))) {
		await archiveQuietly(run, narratorId);
		throw new OutlineTaskSessionError("unreadable");
	}

	// ── 4. The claim. ──
	let claimedSeq: number;
	try {
		const written = await writeOutline(
			{
				spaceId: space.id,
				ops: [
					{
						op: "setTask",
						block: { id: taskId },
						// An assignment to an agent by name is not this session: cleared with the claim.
						task: {
							status: "doing",
							...(block.taskJson.assignee?.startsWith("agent:") ? { assignee: null } : {}),
						},
						baseVersionSeq: args.baseVersionSeq,
					},
				],
				actor: { kind: "system", id: OUTLINE_TASK_OPEN_ACTOR },
				responsibleUserId: principal.userId,
				narratorId,
				summary: `opened session ${narratorId} for ${address}`,
			},
			{ store },
		);
		if (!written.commit) throw new OutlineTaskSessionError("changed");
		claimedSeq = written.commit.seq;
	} catch (error) {
		// Never ran, holds nothing: archived, so no empty session is left for the person.
		await archiveQuietly(run, narratorId);
		if (error instanceof OutlineTaskSessionError) throw error;
		if (!isRefusedClaim(error)) throw error;
		const current = (await store.getTaskClaims([taskId]).catch(() => []))[0] ?? null;
		const taken = !!current && isClaimLive(current, new Date().toISOString());
		throw new OutlineTaskSessionError(
			taken ? "claimed" : "changed",
			taken && current
				? await holderFor(
						{ narratorId: current.holderNarratorId, userId: current.holderUserId },
						narratorVisibility(principal),
						store,
					)
				: null,
		);
	}
	const held = (await store.getTaskClaims([taskId]))[0] ?? null;
	const epoch = held?.epoch ?? (claim?.epoch ?? 0) + 1;

	// ── 5 and 6. The brief, then the first turn; a failure gives the claim back. ──
	try {
		const claimed = (await store.getBlock(taskId)) ?? block;
		const input = await readTaskBrief({ block: claimed, space, scope, epoch, store });
		if (!input) throw new Error("the task is gone");
		const brief = renderTaskBrief({ ...input, prompt: args.options?.note ?? null });
		if (!(await run.deliverBrief(narratorId, principal.userId, brief)))
			throw new Error("the opening brief was not written");
		if (!(await run.start(narratorId, principal.userId, taskId)))
			throw new Error("the session did not start");
	} catch (error) {
		logger.warn("A session opened for a task could not be started", {
			narratorId,
			task: address,
			error: error instanceof Error ? error.message : String(error),
		});
		await giveBack({
			store,
			spaceId: space.id,
			taskId,
			narratorId,
			userId: principal.userId,
			epoch,
			claimedSeq,
			address,
		});
		await archiveQuietly(run, narratorId);
		throw new OutlineTaskSessionError("start_failed");
	}
	remember(taskId, { narratorId, userId: principal.userId, at: Date.parse(now), epoch });
	return { narratorId, started: true, epoch };
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

async function archiveQuietly(run: OutlineTaskSessionRuntime, narratorId: string): Promise<void> {
	await run.archive(narratorId).catch((error: unknown) =>
		logger.warn("A session opened for a task could not be archived", {
			narratorId,
			error: String(error),
		}),
	);
}

/**
 * Give back a task claimed for a session that did not start: a system commit sets it back to do
 * (which releases the claim), written against the version the claim left; changed since (its
 * text, say), once more while it is still exactly this session's (in progress, its claim of this
 * generation). Finished, reset or taken by someone since: theirs, left alone. Nothing is attached
 * under the task. A failure is logged: the running lease then runs out and the expiry job puts
 * the task back.
 */
async function giveBack(args: {
	store: OutlineStore;
	spaceId: string;
	taskId: string;
	narratorId: string;
	userId: string;
	epoch: number;
	claimedSeq: number;
	address: string;
}): Promise<void> {
	const { store, taskId, narratorId } = args;
	const back = (versionSeq: number) =>
		writeOutline(
			{
				spaceId: args.spaceId,
				ops: [
					{
						op: "setTask",
						block: { id: taskId },
						task: { status: "todo" },
						baseVersionSeq: versionSeq,
					},
				],
				actor: { kind: "system", id: OUTLINE_TASK_OPEN_ACTOR },
				responsibleUserId: args.userId,
				narratorId,
				summary: `${args.address} back to do: session ${narratorId} opened for it never ran`,
			},
			{ store },
		);
	try {
		try {
			await back(args.claimedSeq);
		} catch (error) {
			if (!(error instanceof OutlineConflictError)) throw error;
			const [block, claim] = await Promise.all([
				store.getBlock(taskId),
				store.getTaskClaims([taskId]).then((rows) => rows[0] ?? null),
			]);
			if (
				block &&
				!block.deleted &&
				block.taskJson?.status === "doing" &&
				claim?.holderNarratorId === narratorId &&
				claim.epoch === args.epoch
			)
				await back(block.versionSeq);
		}
	} catch (error) {
		logger.warn("A task claimed for a session that never ran could not be given back", {
			narratorId,
			task: args.address,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
