/**
 * Plugins' task commands on an outline session (outline P2 PR 12a; PR 12 design §2.10): read the
 * session's tasks, add one, set one's status. The old Dynamic Spec commands are converted onto
 * these in `plugin-spec-compat.ts`; a plugin's rules on the behavior page are
 * `task-source/outline-plugin-rules.ts`.
 *
 * WHICH SESSIONS
 * --------------
 * A root session whose tasks live in the outline (`readTaskBackend`). A Dynamic Spec session is
 * refused (`CONFLICT`: the `spec_*` commands still apply until it is imported), and so is a
 * subagent of an outline session: it has no tasks of its own (D27c), its session does.
 *
 * HOW THEY WRITE
 * --------------
 * Every write is a system commit of the session (`narratorId`, so a task put in progress is the
 * session's claim), its actor `plugin:<pluginId>`, its responsible person the session's owner.
 * A task a plugin adds is managed by the plugin (`system:plugin:<id>`) and is not a person's,
 * unless the plugin asks for a protected one: that is created by a person (`humanCreated`, so it
 * drives `protectedOnly` continuation as a protected spec task did) and NOT locked (D52: only a
 * person locks; an agent's or a plugin's protected task is not a person's own commitment).
 *
 * The write path does not hold the system to locks (`write.ts`, "Unconstrained"), so the plugin
 * side is held here: a plugin may not finish, cancel or un-mark a task created by a person (as a
 * plugin could not complete or drop a protected spec task: it wrote on the agent's side). It may
 * still start one or put it back to do. A person's lock holds the plugin as it would hold an
 * agent's change to the plan (review S2): no finishing or cancelling the locked task, no
 * cancelling anything under it, no adding under it.
 *
 * A plugin marks a task blocked (the old `spec_write`) with a note under it whose short id follows
 * from the task ({@link pluginBlockedNoteSid}): while the note is there and the task open, reads
 * say so (`blocked`), and the same mark is not written twice; a status set by the plugin takes it
 * away.
 *
 * A write that puts a task in progress for a session that is not running leaves the claim on the
 * idle lease (D41), as a run's end would: a session the plugin starts later renews it.
 *
 * READING
 * -------
 * The session space's tasks in document order (its behavior page left out: its checkboxes are
 * rules), page by page in sibling order, each page's structure read once without content
 * (`listPageStructure`, off the main thread when large). A cursor names the last task returned
 * and its page, so a read later continues after it (found on its page again, or placed from its
 * ancestors when it is gone), whatever its depth. One call reads at most
 * {@link OUTLINE_PLUGIN_TASK_LIMITS.pagesPerRead} pages and
 * {@link OUTLINE_PLUGIN_TASK_LIMITS.rowsPerRead} structure rows; a call that stops early returns a
 * cursor past the last page it read. Text is the head of each task's content, what waits is
 * derived for the open tasks returned only.
 */
import { createHash } from "node:crypto";
import { AppError, NotFoundError } from "@server/lib/errors";
import { logger } from "@server/lib/logger";
import { getUserLanguage, type Locale } from "@server/lib/prompt-i18n";
import { compareOrderKeys, isOrderKey } from "@shared/outline";
import { readTaskBackend, readTaskSession } from "../task-source/backend";
import { readNarrator } from "./access-reads";
import { OUTLINE_TEXT } from "./messages";
import {
	OUTLINE_BEHAVIOR_ALIAS,
	OUTLINE_LIMITS,
	OUTLINE_TASKS_PAGE_ALIAS,
	type OutlineTaskJson,
} from "./model";
import { bodyFromText, findSameTask, OUTLINE_TASKS_PAGE_TITLE, oneAtATime } from "./person-tasks";
import { outlineStore } from "./store";
import type { OutlineSpaceRow, OutlineStore } from "./store/port";
import type { OutlineStructureRow } from "./store/read-port";
import { deriveOutlineTaskWaits, idleOutlineTaskClaims, isWaiting } from "./tasks";
import {
	type OutlineCanonicalContent,
	type OutlineOp,
	type OutlineWriteResult,
	writeOutline,
} from "./write";

export const OUTLINE_PLUGIN_TASK_LIMITS = {
	/** Tasks one `tasks_read` returns at most (the public API's array limit). */
	readMax: 100,
	/** Tasks one `tasks_read` returns when it does not say. */
	readDefault: 50,
	/** Characters of a task's text a read returns, and of a task a plugin adds. */
	textChars: 1000,
	/**
	 * Pages one read looks at; the next call continues after the last. Each is one indexed read of
	 * the page's structure (off the main thread when large), so the row budget is what bounds the
	 * work; this keeps a space of many one-block pages (a task per page) from costing a read each
	 * past it.
	 */
	pagesPerRead: 200,
	/** Structure rows (blocks of the pages, without content) one read takes. */
	rowsPerRead: 20_000,
	/** Pages one listing of a space's pages takes. */
	pageBatch: 50,
	/** UTF-8 bytes of a read cursor. */
	cursorBytes: 4096,
} as const;

/** The public error a plugin's task command is refused with, and why. */
export type PluginTaskErrorCode = "CONFLICT" | "NOT_FOUND" | "INVALID_PARAMS" | "PAYLOAD_TOO_LARGE";

/**
 * A plugin's task command refused for a reason the plugin can act on. The public API maps it to
 * `publicCode` with this message (`plugin-public-api.ts`).
 */
export class PluginTaskError extends AppError {
	constructor(
		readonly publicCode: PluginTaskErrorCode,
		message: string,
	) {
		super(
			message,
			publicCode === "NOT_FOUND"
				? 404
				: publicCode === "CONFLICT"
					? 409
					: publicCode === "PAYLOAD_TOO_LARGE"
						? 413
						: 400,
			`PLUGIN_TASK_${publicCode}`,
		);
		this.name = "PluginTaskError";
	}
}

export const PLUGIN_TASK_TEXT = {
	specSession:
		"This session still keeps its tasks in Dynamic Spec: use the spec_* commands until it is imported into the outline.",
	subagent: (session: string | null) =>
		`A subagent of an outline session has no tasks of its own: send task commands to its session${session ? ` (${session})` : ""}.`,
	humanCreated: (address: string) =>
		`Task ${address} was created by a person: a plugin may not finish, cancel or un-mark it.`,
	notATask: (blockId: string) => `Block ${blockId} is not a task of this session`,
	parentNotFound: (blockId: string) => `Block ${blockId} is not a live block of this session`,
	parentOnRules: "Tasks cannot be added on the behavior page: its checkboxes are rules.",
	locked: (address: string) =>
		`Task ${address} is locked by a person: a plugin may not finish or cancel it, nor cancel or add tasks under it.`,
	badCursor: "The cursor is invalid",
} as const;

/** The actor (and manager) of a plugin's writes: the system acting for the plugin. */
export function pluginActorId(pluginId: string): string {
	return `plugin:${pluginId}`;
}

/** The session a plugin's task command acts on. */
export interface PluginTaskSession {
	/** The root session. */
	narratorId: string;
	ownerUserId: string | null;
	/** The owner's language: what pages and notes the plugin's writes create are worded in. */
	locale: Locale;
}

/**
 * The outline root session `narratorId` is, for a plugin's task command: not found when it does
 * not exist, refused (`CONFLICT`) for a Dynamic Spec session and for a subagent.
 */
export async function resolvePluginTaskSession(narratorId: string): Promise<PluginTaskSession> {
	const session = await readTaskSession(narratorId);
	if (!session) throw new NotFoundError("Narrator", narratorId);
	if ((await readTaskBackend(narratorId)) !== "outline")
		throw new PluginTaskError("CONFLICT", PLUGIN_TASK_TEXT.specSession);
	if (session.subagent)
		throw new PluginTaskError("CONFLICT", PLUGIN_TASK_TEXT.subagent(session.sessionNarratorId));
	const ownerUserId = (await readNarrator(narratorId))?.ownerUserId ?? null;
	const locale: Locale = ownerUserId
		? await getUserLanguage(ownerUserId).catch(() => "en" as const)
		: "en";
	return { narratorId, ownerUserId, locale };
}

/** `outline:<space key>:<seq>`: what the spec commands call a revision, in an outline session. */
export function outlineRevisionId(space: Pick<OutlineSpaceRow, "key">, seq: number): string {
	return `outline:${space.key}:${seq}`;
}

/** The last commit's seq of a space as read (0 before its first commit). */
export function latestSeq(space: Pick<OutlineSpaceRow, "nextSeq">): number {
	return Math.max(0, space.nextSeq - 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the session's tasks in document order
// ─────────────────────────────────────────────────────────────────────────────

/** One step of a position: a block's order key and id, from its page down. */
export type OutlinePathStep = readonly [orderKey: string, id: string];

/**
 * Where a read stopped: after the task `blockId` on the page `page` (its order key and id), or,
 * without `blockId`, after everything on that page. Compact whatever the depth (review N4): the
 * task's position is found again when its page is read (or from its ancestors when it is gone).
 */
export interface SessionTaskCursor {
	page: OutlinePathStep;
	blockId?: string;
}

/** A task of the session space, as a read finds it. */
export interface SessionTask {
	id: string;
	sid: string;
	parentId: string | null;
	pageId: string;
	taskJson: OutlineTaskJson;
	versionSeq: number;
	path: OutlinePathStep[];
	/** 0 for a page. */
	depth: number;
	/** No task above it. */
	topLevel: boolean;
	/** A direct child of the session's task page. */
	onTasksPage: boolean;
	/** A person locked this task (its plan, design §2.2). */
	lockRoot: boolean;
	/** A person locked this task or a task above it. */
	inLockedTree: boolean;
}

/** A lock a person holds (only people lock; Q5). */
export function isPersonLock(task: OutlineTaskJson | null | undefined): boolean {
	return task?.lock?.by.kind === "human";
}

function compareStep(a: OutlinePathStep, b: OutlinePathStep): number {
	return compareOrderKeys(a[0], b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
}

/** Document order of two positions: sibling order step by step, a block before what is under it. */
export function comparePaths(a: readonly OutlinePathStep[], b: readonly OutlinePathStep[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const c = compareStep(a[i] as OutlinePathStep, b[i] as OutlinePathStep);
		if (c !== 0) return c;
	}
	return a.length - b.length;
}

const CURSOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function encodeTaskCursor(cursor: SessionTaskCursor): string {
	return Buffer.from(
		JSON.stringify({ p: cursor.page, ...(cursor.blockId ? { b: cursor.blockId } : {}) }),
		"utf8",
	).toString("base64url");
}

/** A read cursor; a malformed one is refused (`INVALID_PARAMS`). */
export function decodeTaskCursor(cursor: string): SessionTaskCursor {
	const bad = () => new PluginTaskError("INVALID_PARAMS", PLUGIN_TASK_TEXT.badCursor);
	if (cursor.length > OUTLINE_PLUGIN_TASK_LIMITS.cursorBytes) throw bad();
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw bad();
	}
	if (!parsed || typeof parsed !== "object") throw bad();
	const { p, b } = parsed as { p?: unknown; b?: unknown };
	if (
		!Array.isArray(p) ||
		p.length !== 2 ||
		typeof p[0] !== "string" ||
		typeof p[1] !== "string" ||
		!isOrderKey(p[0]) ||
		!CURSOR_ID.test(p[1])
	)
		throw bad();
	if (b !== undefined && (typeof b !== "string" || !CURSOR_ID.test(b))) throw bad();
	return { page: [p[0], p[1]], ...(typeof b === "string" ? { blockId: b } : {}) };
}

export interface SessionTaskWalk {
	tasks: SessionTask[];
	/** Where the next read continues; null when the space has nothing more. */
	next: SessionTaskCursor | null;
	/** The read stopped at its page or row budget before the end of the space. */
	cut: boolean;
}

/**
 * The position of a block that is not on its page's live structure any more (deleted, or moved
 * since a cursor named it), from its ancestors as stored (a deleted block keeps its parent and
 * order key): one read per level. Null when its chain does not lead to `pageId`.
 */
async function storedPath(
	store: OutlineStore,
	spaceId: string,
	blockId: string,
	pageId: string,
): Promise<OutlinePathStep[] | null> {
	const steps: OutlinePathStep[] = [];
	let id: string | null = blockId;
	for (let depth = 0; id !== null && depth <= OUTLINE_LIMITS.maxDepth; depth++) {
		const [meta] = await store.getBlockMetas(spaceId, { ids: [id] });
		if (!meta) return null;
		steps.unshift([meta.orderKey, meta.id]);
		if (meta.parentId === null) return meta.id === pageId ? steps : null;
		id = meta.parentId;
	}
	return null;
}

/**
 * The session space's tasks `keep` accepts, in document order, after `cursor`, at most `limit`
 * (see the module header for the bounds).
 */
export async function walkSessionTasks(
	space: OutlineSpaceRow,
	options: {
		cursor?: SessionTaskCursor | null;
		limit: number;
		keep?: (task: SessionTask) => boolean;
		store?: OutlineStore;
	},
): Promise<SessionTaskWalk> {
	const store = options.store ?? outlineStore;
	const limits = OUTLINE_PLUGIN_TASK_LIMITS;
	const cursor = options.cursor ?? null;
	const [aliases, rules] = await Promise.all([
		store.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]),
		store.findAliasOwners(space.id, [OUTLINE_BEHAVIOR_ALIAS]),
	]);
	const tasksPageId = aliases[0]?.id ?? null;
	const rulePages = new Set(rules.map((owner) => owner.id));
	const out: SessionTask[] = [];
	let rowsRead = 0;
	let pagesRead = 0;
	let budgetHit = false;
	let lastPage: OutlinePathStep | null = null;
	const full = () => out.length > options.limit || budgetHit;

	/** Read a page's tasks; with `resumeAfter`, only those after that block (the cursor's). */
	const visitPage = async (page: { id: string; orderKey: string }, resumeAfter?: string) => {
		if (rulePages.has(page.id)) return;
		if (pagesRead >= limits.pagesPerRead || rowsRead >= limits.rowsPerRead) {
			budgetHit = true;
			return;
		}
		const structure = await store.listPageStructure(page.id, {
			asOf: null,
			limit: OUTLINE_LIMITS.maxPageBlocks,
		});
		pagesRead++;
		rowsRead += structure.rows.length;
		if (structure.truncated)
			logger.warn("A plugin's task read found a page larger than one read loads", {
				spaceId: space.id,
				pageId: page.id,
			});
		const children = new Map<string, OutlineStructureRow[]>();
		let root: OutlineStructureRow | null = null;
		let resumeLive = false;
		for (const row of structure.rows) {
			if (row.id === resumeAfter) resumeLive = true;
			if (row.parentId === null) {
				if (row.id === page.id) root = row;
				continue;
			}
			const siblings = children.get(row.parentId);
			if (siblings) siblings.push(row);
			else children.set(row.parentId, [row]);
		}
		if (!root) return;
		for (const siblings of children.values())
			siblings.sort((a, b) => compareStep([a.orderKey, a.id], [b.orderKey, b.id]));
		// The cursor's task: skipped up to and including it when it is on the page; else its stored
		// position (or, when it cannot be placed here, nothing) decides.
		let skipping = resumeAfter !== undefined && resumeLive;
		const after =
			resumeAfter !== undefined && !resumeLive
				? await storedPath(store, space.id, resumeAfter, page.id)
				: null;
		// Depth first in document order, without recursion (an outline may be deep).
		const stack: Array<{
			row: OutlineStructureRow;
			path: OutlinePathStep[];
			underTask: boolean;
			locked: boolean;
		}> = [{ row: root, path: [[root.orderKey, root.id]], underTask: false, locked: false }];
		while (stack.length > 0) {
			const { row, path, underTask, locked } = stack.pop() as (typeof stack)[number];
			const lockRoot = isPersonLock(row.taskJson);
			if (skipping) {
				if (row.id === resumeAfter) skipping = false;
			} else if (row.taskJson && (!after || comparePaths(path, after) > 0)) {
				const task: SessionTask = {
					id: row.id,
					sid: row.sid,
					parentId: row.parentId,
					pageId: page.id,
					taskJson: row.taskJson,
					versionSeq: row.versionSeq,
					path,
					depth: path.length - 1,
					topLevel: !underTask,
					onTasksPage: tasksPageId !== null && row.parentId === tasksPageId,
					lockRoot,
					inLockedTree: locked || lockRoot,
				};
				if (options.keep?.(task) ?? true) {
					out.push(task);
					if (out.length > options.limit) return;
				}
			}
			const below = children.get(row.id) ?? [];
			for (let i = below.length - 1; i >= 0; i--) {
				const child = below[i] as OutlineStructureRow;
				stack.push({
					row: child,
					path: [...path, [child.orderKey, child.id]],
					underTask: underTask || row.taskJson !== null,
					locked: locked || lockRoot,
				});
			}
		}
		lastPage = [page.orderKey, page.id];
	};

	// The cursor's page again, when it is still where the cursor left it; then the pages after it.
	let after: { orderKey: string; id: string } | null = null;
	if (cursor) {
		after = { orderKey: cursor.page[0], id: cursor.page[1] };
		if (cursor.blockId) {
			const [meta] = await store.getBlockMetas(space.id, { ids: [cursor.page[1]] });
			if (meta && !meta.deleted && meta.parentId === null && meta.orderKey === cursor.page[0])
				await visitPage(meta, cursor.blockId);
		}
	}
	while (!full()) {
		const pages = await store.listSpacePages(space.id, { after, limit: limits.pageBatch });
		for (const page of pages) {
			after = { orderKey: page.orderKey, id: page.id };
			await visitPage(page);
			if (full()) break;
		}
		if (pages.length < limits.pageBatch) break;
	}
	if (out.length > options.limit) {
		const tasks = out.slice(0, options.limit);
		const last = tasks.at(-1) as SessionTask;
		return {
			tasks,
			next: { page: last.path[0] as OutlinePathStep, blockId: last.id },
			cut: false,
		};
	}
	if (budgetHit) return { tasks: out, next: lastPage ? { page: lastPage } : null, cut: true };
	return { tasks: out, next: null, cut: false };
}

/** Each task's text: the head of its content, at most {@link OUTLINE_PLUGIN_TASK_LIMITS.textChars}. */
export async function readTaskTexts(
	ids: readonly string[],
	store: OutlineStore = outlineStore,
): Promise<Map<string, string>> {
	if (ids.length === 0) return new Map();
	const heads = await store.getContentHeads(ids, OUTLINE_PLUGIN_TASK_LIMITS.textChars);
	const out = new Map<string, string>();
	for (const [id, head] of heads) out.set(id, head.trim());
	return out;
}

/** Of the given open tasks, those that wait (prerequisites, people, a confirmation). */
export async function readWaitingTasks(
	tasks: readonly SessionTask[],
	spaceId: string,
	store: OutlineStore = outlineStore,
): Promise<Set<string>> {
	const open = tasks.filter((t) => t.taskJson.status === "todo" || t.taskJson.status === "doing");
	if (open.length === 0) return new Set();
	const waits = await deriveOutlineTaskWaits(
		open.map((t) => ({ id: t.id, spaceId, taskJson: t.taskJson })),
		{ store },
	);
	const out = new Set<string>();
	for (const [id, wait] of waits) if (isWaiting(wait)) out.add(id);
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// tasks_read
// ─────────────────────────────────────────────────────────────────────────────

export interface PluginTaskRow {
	blockId: string;
	/** `key/sid`. */
	address: string;
	text: string;
	status: OutlineTaskJson["status"];
	/** It cannot go on now: a prerequisite, a person or a confirmation. */
	waiting: boolean;
	/** Open and marked blocked by a plugin (its note under the task; the old `spec_write`). */
	blocked: boolean;
	humanCreated: boolean;
	parentBlockId: string | null;
	depth: number;
	versionSeq: number;
}

export interface PluginTasksRead {
	backend: "outline";
	/** The session (a root narrator). */
	narratorId: string;
	/** The session space's key; null before anything was written to it. */
	spaceKey: string | null;
	/** The session space's latest commit. */
	seq: number;
	tasks: PluginTaskRow[];
	nextCursor: string | null;
}

/** `tasks_read`: the session space's tasks in document order, a page at a time. */
export async function readPluginTasks(args: {
	narratorId: string;
	cursor?: string | null;
	limit?: number;
	store?: OutlineStore;
}): Promise<PluginTasksRead> {
	const store = args.store ?? outlineStore;
	const limit = Math.min(
		OUTLINE_PLUGIN_TASK_LIMITS.readMax,
		Math.max(1, Math.floor(args.limit ?? OUTLINE_PLUGIN_TASK_LIMITS.readDefault)),
	);
	const cursor = args.cursor ? decodeTaskCursor(args.cursor) : null;
	const session = await resolvePluginTaskSession(args.narratorId);
	const space = await store.findSpace({ kind: "session", narratorId: session.narratorId });
	if (!space)
		return {
			backend: "outline",
			narratorId: session.narratorId,
			spaceKey: null,
			seq: 0,
			tasks: [],
			nextCursor: null,
		};
	const walk = await walkSessionTasks(space, { cursor, limit, store });
	const ids = walk.tasks.map((t) => t.id);
	const open = walk.tasks.filter(
		(t) => t.taskJson.status === "todo" || t.taskJson.status === "doing",
	);
	const [texts, waiting, notes] = await Promise.all([
		readTaskTexts(ids, store),
		readWaitingTasks(walk.tasks, space.id, store),
		readPluginBlockedNotes(
			open.map((t) => t.id),
			space.id,
			store,
		),
	]);
	return {
		backend: "outline",
		narratorId: session.narratorId,
		spaceKey: space.key,
		seq: latestSeq(space),
		tasks: walk.tasks.map((t) => ({
			blockId: t.id,
			address: `${space.key}/${t.sid}`,
			text: texts.get(t.id) ?? "",
			status: t.taskJson.status,
			waiting: waiting.has(t.id),
			blocked: notes.get(t.id)?.live === true,
			humanCreated: t.taskJson.humanCreated === true,
			parentBlockId: t.parentId,
			depth: t.depth,
			versionSeq: t.versionSeq,
		})),
		nextCursor: walk.next ? encodeTaskCursor(walk.next) : null,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────────────────────

/** A plugin's commit for a session: the system acting for the plugin, the owner responsible. */
export async function writeForPlugin(
	session: PluginTaskSession,
	space: OutlineSpaceRow,
	pluginId: string,
	ops: readonly OutlineOp[],
	summary: string,
	options: {
		store?: OutlineStore;
		isRunning?: (narratorId: string) => boolean;
		canonical?: ReadonlyArray<OutlineCanonicalContent | null>;
	} = {},
): Promise<OutlineWriteResult> {
	const store = options.store ?? outlineStore;
	const result = await writeOutline(
		{
			spaceId: space.id,
			ops,
			actor: { kind: "system", id: pluginActorId(pluginId) },
			responsibleUserId: session.ownerUserId,
			narratorId: session.narratorId,
			summary: summary.slice(0, OUTLINE_LIMITS.maxSummaryChars),
		},
		{ store, ...(options.canonical ? { canonical: options.canonical } : {}) },
	);
	// A task the commit put in progress is the session's claim on the running lease: a session
	// that is not running keeps it on the idle lease, as the end of a run would (D41).
	const startsTask = ops.some(
		(op) =>
			(op.op === "setTask" && op.task?.status === "doing") ||
			(op.op === "insert" && op.task?.status === "doing"),
	);
	if (result.commit && startsTask && !(options.isRunning?.(session.narratorId) ?? false)) {
		await idleOutlineTaskClaims(session.narratorId, { store }).catch((error: unknown) =>
			logger.warn("Could not put a plugin's started task on the idle lease", {
				narratorId: session.narratorId,
				error: String(error),
			}),
		);
	}
	return result;
}

/** The task holding the nearest person's lock over a block (it, or a task above it), if any. */
export async function personLockOver(
	store: OutlineStore,
	spaceId: string,
	blockId: string,
): Promise<{ id: string; sid: string; self: boolean } | null> {
	let id: string | null = blockId;
	for (let depth = 0; id !== null && depth <= OUTLINE_LIMITS.maxDepth; depth++) {
		const [meta] = await store.getBlockMetas(spaceId, { ids: [id] });
		if (!meta) return null;
		if (isPersonLock(meta.taskJson)) return { id: meta.id, sid: meta.sid, self: depth === 0 };
		id = meta.parentId;
	}
	return null;
}

function lockAddress(space: Pick<OutlineSpaceRow, "key">, lock: { sid: string }): string {
	return `${space.key}/${lock.sid}`;
}

/** The short id of the note a plugin writes under a task it marks blocked: one per task (S5). */
export function pluginBlockedNoteSid(taskId: string): string {
	return `pb${createHash("sha256").update(`plugin-blocked\u0000${taskId}`).digest("hex").slice(0, 12)}`;
}

/** The blocked notes of these tasks, by task id: live, or deleted (a person or agent took it). */
export async function readPluginBlockedNotes(
	taskIds: readonly string[],
	spaceId: string,
	store: OutlineStore = outlineStore,
): Promise<Map<string, { id: string; live: boolean }>> {
	const out = new Map<string, { id: string; live: boolean }>();
	if (taskIds.length === 0) return out;
	const bySid = new Map(taskIds.map((id) => [pluginBlockedNoteSid(id), id]));
	for (const meta of await store.getBlockMetas(spaceId, { sids: [...bySid.keys()] })) {
		const taskId = bySid.get(meta.sid);
		if (taskId && meta.parentId === taskId) out.set(taskId, { id: meta.id, live: !meta.deleted });
	}
	return out;
}

/** The session's task page, made (in `ops`, as temp id `page`) when it does not exist yet. */
async function tasksPageOf(
	space: OutlineSpaceRow,
	locale: Locale,
	store: OutlineStore,
): Promise<{ parent: { id: string } | { tempId: string }; id: string | null; ops: OutlineOp[] }> {
	const [owner] = await store.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
	if (owner) return { parent: { id: owner.id }, id: owner.id, ops: [] };
	return {
		parent: { tempId: "page" },
		id: null,
		ops: [
			{
				op: "insert",
				tempId: "page",
				parent: null,
				content: OUTLINE_TASKS_PAGE_TITLE[locale === "zh-CN" ? "zh-CN" : "en"],
				alias: OUTLINE_TASKS_PAGE_ALIAS,
			},
		],
	};
}

/** A plugin's task text: trimmed, not empty, within the limit. */
export function pluginTaskText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) throw new PluginTaskError("INVALID_PARAMS", "A task needs some text");
	if ([...trimmed].length > OUTLINE_PLUGIN_TASK_LIMITS.textChars)
		throw new PluginTaskError(
			"INVALID_PARAMS",
			`A task's text is limited to ${OUTLINE_PLUGIN_TASK_LIMITS.textChars} characters`,
		);
	return trimmed;
}

export interface PluginTaskAdded {
	blockId: string;
	address: string;
	/** False when a task with this text was there already: nothing was written. */
	added: boolean;
	status: OutlineTaskJson["status"];
	/** Created by a person (a protected one): the task found, or the one added. */
	humanCreated: boolean;
	sessionId: string;
	space: OutlineSpaceRow;
	/** The space's latest commit after the add. */
	seq: number;
}

/**
 * `task_add`: a task last on the session's task page (made on first use), or under the block the
 * plugin names. Deduped by body among the parent's children, as `/goal` is. See the module header
 * for who manages it and what `protected` makes of it.
 */
export async function addPluginTask(args: {
	narratorId: string;
	pluginId: string;
	text: string;
	parentBlockId?: string | null;
	protected?: boolean;
	store?: OutlineStore;
	isRunning?: (narratorId: string) => boolean;
}): Promise<PluginTaskAdded> {
	const store = args.store ?? outlineStore;
	const text = pluginTaskText(args.text);
	const session = await resolvePluginTaskSession(args.narratorId);
	return await oneAtATime(session.narratorId, async () => {
		const space = await store.ensureSpace(
			{ kind: "session", narratorId: session.narratorId },
			new Date().toISOString(),
		);
		let parent: { id: string } | { tempId: string };
		let parentId: string | null;
		const ops: OutlineOp[] = [];
		if (args.parentBlockId) {
			const [meta] = await store.getBlockMetas(space.id, { ids: [args.parentBlockId] });
			if (!meta || meta.deleted)
				throw new PluginTaskError("NOT_FOUND", PLUGIN_TASK_TEXT.parentNotFound(args.parentBlockId));
			const rules = await store.findAliasOwners(space.id, [OUTLINE_BEHAVIOR_ALIAS]);
			if (rules.some((owner) => owner.id === meta.pageId))
				throw new PluginTaskError("INVALID_PARAMS", PLUGIN_TASK_TEXT.parentOnRules);
			parent = { id: meta.id };
			parentId = meta.id;
		} else {
			const page = await tasksPageOf(space, session.locale, store);
			parent = page.parent;
			parentId = page.id;
			ops.push(...page.ops);
		}
		// Nothing is added to a plan a person locked (review S2).
		if (parentId) {
			const lock = await personLockOver(store, space.id, parentId);
			if (lock)
				throw new PluginTaskError("CONFLICT", PLUGIN_TASK_TEXT.locked(lockAddress(space, lock)));
		}
		if (parentId) {
			const existing = await findSameTask(store, space, parentId, bodyFromText(text));
			if (existing)
				return {
					blockId: existing.id,
					address: `${space.key}/${existing.sid}`,
					added: false,
					status: existing.task.status,
					humanCreated: existing.task.humanCreated === true,
					sessionId: session.narratorId,
					space,
					seq: latestSeq(space),
				};
		}
		const protectedTask = args.protected === true;
		ops.push({
			op: "insert",
			parent,
			content: text,
			task: { status: "todo", ...(protectedTask ? { humanCreated: true } : {}) },
		});
		const result = await writeForPlugin(
			session,
			space,
			args.pluginId,
			ops,
			OUTLINE_TEXT.pluginTaskAdded(args.pluginId),
			{ store, isRunning: args.isRunning },
		);
		const added = result.results[ops.length - 1];
		if (!added) throw new Error("the task was not written");
		return {
			blockId: added.blockId,
			address: added.address,
			added: true,
			status: "todo",
			humanCreated: protectedTask,
			sessionId: session.narratorId,
			space,
			seq: result.commit?.seq ?? latestSeq(space),
		};
	});
}

export interface PluginTaskStatusSet {
	blockId: string;
	address: string;
	status: OutlineTaskJson["status"];
	versionSeq: number;
	/** False when the task had that status already: nothing was written. */
	changed: boolean;
}

/**
 * `task_set_status`: a task of the session space to do, in progress, done or cancelled, based on
 * the version the plugin read when it gives one (a change since is refused). Someone else doing
 * it refuses the write as for anyone (`write.ts`); a task a person created is not the plugin's to
 * finish or cancel.
 */
export async function setPluginTaskStatus(args: {
	narratorId: string;
	pluginId: string;
	blockId: string;
	status: OutlineTaskJson["status"];
	baseVersionSeq?: number;
	store?: OutlineStore;
	isRunning?: (narratorId: string) => boolean;
}): Promise<PluginTaskStatusSet> {
	const store = args.store ?? outlineStore;
	const session = await resolvePluginTaskSession(args.narratorId);
	const space = await store.findSpace({ kind: "session", narratorId: session.narratorId });
	const [meta] = space ? await store.getBlockMetas(space.id, { ids: [args.blockId] }) : [];
	if (!space || !meta || meta.deleted || !meta.taskJson)
		throw new PluginTaskError("NOT_FOUND", PLUGIN_TASK_TEXT.notATask(args.blockId));
	const rules = await store.findAliasOwners(space.id, [OUTLINE_BEHAVIOR_ALIAS]);
	if (rules.some((owner) => owner.id === meta.pageId))
		throw new PluginTaskError("NOT_FOUND", PLUGIN_TASK_TEXT.notATask(args.blockId));
	const address = `${space.key}/${meta.sid}`;
	if (
		meta.taskJson.humanCreated === true &&
		(args.status === "done" || args.status === "cancelled") &&
		meta.taskJson.status !== args.status
	)
		throw new PluginTaskError("CONFLICT", PLUGIN_TASK_TEXT.humanCreated(address));
	// A person's lock (review S2): the locked task is not finished or cancelled by a plugin, and
	// nothing under it is cancelled (an agent's such change waits for the person).
	if (
		meta.taskJson.status !== args.status &&
		(args.status === "done" || args.status === "cancelled")
	) {
		const lock = await personLockOver(store, space.id, meta.id);
		if (lock && (lock.self || args.status === "cancelled"))
			throw new PluginTaskError("CONFLICT", PLUGIN_TASK_TEXT.locked(lockAddress(space, lock)));
	}
	if (meta.taskJson.status === args.status) {
		if (args.baseVersionSeq !== undefined && args.baseVersionSeq !== meta.versionSeq)
			throw new PluginTaskError(
				"CONFLICT",
				`Task ${address} changed since it was read (read ${args.baseVersionSeq}, now ${meta.versionSeq})`,
			);
		return {
			blockId: meta.id,
			address,
			status: meta.taskJson.status,
			versionSeq: meta.versionSeq,
			changed: false,
		};
	}
	// A status the plugin sets ends a blocked mark it made.
	const note = (await readPluginBlockedNotes([meta.id], space.id, store)).get(meta.id);
	const result = await writeForPlugin(
		session,
		space,
		args.pluginId,
		[
			{
				op: "setTask",
				block: { id: meta.id },
				task: { status: args.status },
				...(args.baseVersionSeq !== undefined ? { baseVersionSeq: args.baseVersionSeq } : {}),
			},
			...(note?.live ? [{ op: "delete" as const, block: { id: note.id } }] : []),
		],
		OUTLINE_TEXT.pluginTaskStatus(args.pluginId, address, args.status),
		{ store, isRunning: args.isRunning },
	);
	return {
		blockId: meta.id,
		address,
		status: args.status,
		versionSeq: result.commit?.seq ?? meta.versionSeq,
		changed: result.commit !== null,
	};
}
