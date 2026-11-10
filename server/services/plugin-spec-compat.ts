/**
 * The four Dynamic Spec plugin commands in an outline session (outline P2 PR 12a; PR 12 design
 * §2.10): converted onto the session's outline tasks, answering in the shape a spec session
 * answers in, so a plugin written for Dynamic Spec keeps working until the commands retire (one
 * release after outline plan PR 13; plan §8.5). Telemetry (the audit mark, the hourly warning) is
 * `plugin-spec-compat-telemetry.ts`.
 *
 * THE TASK LIST (`spec_tasks_get`)
 * --------------------------------
 * The session space's top-level tasks (no task above them; the behavior page left out), in
 * document order, at most {@link SPEC_COMPAT_LIMITS.tasks} (the spec limit), as
 * `{ text, status, protected }`: a cancelled task is not listed; an open task that waits (a
 * prerequisite, a person, a confirmation) or that a plugin marked blocked (its note under it,
 * `pluginBlockedNoteSid`) reads `blocked`; `protected` is created by a person. With more than the
 * limit, every open task is listed and the most recently changed done ones fill the rest (review
 * S4: done tasks stay in the outline, and the first ones in document order would push the newest
 * work out). The text is the head of the task's content
 * ({@link OUTLINE_PLUGIN_TASK_LIMITS.textChars} characters, the spec limit). `revisionId` is
 * `outline:<space key>:<seq>`; `compiled` is computed from the list as for a spec file.
 *
 * ADDING (`spec_task_add`)
 * ------------------------
 * `task_add` on the task page: deduped by body, `added` false when the text is there already;
 * `protected` is the task found's, or the one asked for (D52: not locked).
 *
 * THE OVERWRITE (`spec_write` of tasks.json)
 * ------------------------------------------
 * The document is validated as a spec write validates it, then compared with the list above by
 * text (the text as listed, or the text normalized as the write path would store it; duplicates
 * in order); a text the list does not hold is looked for among the task page's own tasks too
 * (one bounded read: a done task the list left out is that task, not a new one). One commit:
 *   - a new text: a task on the task page, after the item before it on the task page (first when
 *     none is), to do, in progress or done; `blocked` is in progress with the plugin's note under
 *     it (no question is asked); `protected` makes it created by a person, not locked;
 *   - a status that changed: set; `blocked` writes the note once (a note taken away is brought
 *     back), any other status takes it away; `protected` on a task that was not is set;
 *   - an open task no longer listed: cancelled when it is a direct child of the task page (what is
 *     under it stays: cancelling, not deleting); a done one, and one elsewhere (a plan's), are left
 *     alone and logged (review S3: a done task dropped from the file is still finished work);
 *   - the task page's own tasks are moved only when their order changed.
 * A write that would finish, drop or un-protect an open task a person created, or finish or cancel
 * a task a person locked (or cancel one under it, review S2), is refused whole with the error a
 * spec session gives, `SpecProtectedTaskError` (`CONFLICT` with the list of what it touched,
 * owner decision 4), its lines task by task as a spec write orders them. Setting and moving name
 * the version read, so a change made meanwhile refuses the write. Writing what the list already
 * says writes nothing. The answer is the spec one, `{ path, uri, revisionId }`.
 *
 * NOTES (`spec_write` of index.md)
 * --------------------------------
 * The page `index.md` of the session space (its short id follows from the name; made, moved back
 * or brought back as needed) gets the text as notes (headings hold their sections, nothing is
 * outline syntax), replacing the notes it held (a task on the page is kept; a person's task under
 * a note refuses the rewrite, review N1), in one commit within one commit's limits; a text that
 * does not fit is refused (`PAYLOAD_TOO_LARGE`) and nothing is written.
 *
 * THE FENCE (`spec_behavior_fence_update`)
 * ----------------------------------------
 * The plugin's block on the behavior page (`outline-plugin-rules.ts`). A subagent keeps writing
 * its own old fence (see there), so the session layer sends only a root session here.
 */
import { createHash } from "node:crypto";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { DELEGATION_BLOCK_TEXT } from "./outline/delegation-text";
import { OUTLINE_EDIT_TEXT_LIMITS, processEditText } from "./outline/edit-text-runner";
import { OUTLINE_TEXT } from "./outline/messages";
import { OUTLINE_LIMITS, OUTLINE_TASKS_PAGE_ALIAS, type OutlineTaskJson } from "./outline/model";
import { OUTLINE_TASKS_PAGE_TITLE, oneAtATime } from "./outline/person-tasks";
import {
	addPluginTask,
	isPersonLock,
	latestSeq,
	OUTLINE_PLUGIN_TASK_LIMITS,
	outlineRevisionId,
	PLUGIN_TASK_TEXT,
	type PluginBlockedNote,
	PluginTaskError,
	type PluginTaskSession,
	pluginBlockedNoteSid,
	readPluginBlockedNotes,
	readTaskTexts,
	readWaitingTasks,
	resolvePluginTaskSession,
	type SessionTask,
	walkSessionTasks,
	writeForPlugin,
} from "./outline/plugin-tasks";
import { outlineStore } from "./outline/store";
import type { OutlineSpaceRow, OutlineStore } from "./outline/store/port";
import type {
	OutlineBlockRef,
	OutlineCanonicalContent,
	OutlineOp,
	OutlinePosition,
	OutlineTaskPatch,
} from "./outline/write";
import {
	type CompiledSpecTasks,
	compileSpecTasks,
	parseSpecTasksDocument,
	SpecProtectedTaskError,
	type SpecTaskItem,
	type SpecTaskStatus,
	type SpecTasksDocument,
	serializeSpecTasksDocument,
} from "./spec-task-service";
import { MAX_SPEC_FILE_CHARS } from "./spec-vfs-service";
import { setOutlinePluginRules } from "./task-source/outline-plugin-rules";

export const SPEC_COMPAT_LIMITS = {
	/** Tasks the list holds (the spec limit). */
	tasks: 100,
	/** Top-level tasks read to choose them from (within the read's page and row budget). */
	scan: 1000,
	/** Children of the task page the overwrite looks at for a text it does not list (S4). */
	pageScan: 500,
} as const;

/** A note written under a task a plugin marked blocked, in the session owner's language. */
export const SPEC_COMPAT_BLOCKED_NOTE: Record<Locale, (pluginId: string) => string> = {
	en: (pluginId) => `Blocked (marked by plugin ${pluginId})`,
	"zh-CN": (pluginId) => `受阻（插件 ${pluginId} 标记）`,
};

/** The title of a session's `index.md` page. */
export const SPEC_COMPAT_INDEX_TITLE = "index.md";

/** One listed task and where it is. */
export interface SpecCompatEntry {
	task: SessionTask;
	text: string;
	status: SpecTaskStatus;
	protected: boolean;
	/** The blocked mark a plugin wrote under it (its note), when there is one, live or not. */
	blockedNote: PluginBlockedNote | null;
}

export interface SpecCompatList {
	space: OutlineSpaceRow | null;
	entries: SpecCompatEntry[];
}

/** The text a whitespace run counts as one space for. */
function bodyKey(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The spec status of an open or done task (see the module header). */
function specStatusOf(
	task: Pick<SessionTask, "taskJson">,
	waiting: boolean,
	blockedNote: boolean,
): SpecTaskStatus {
	const own = task.taskJson.status;
	if (own === "done") return "done";
	if (waiting || blockedNote) return "blocked";
	return own === "doing" ? "doing" : "todo";
}

/**
 * Of more top-level tasks than the list holds, which it lists (review S4): every open one (the
 * first {@link SPEC_COMPAT_LIMITS.tasks} in document order), then the most recently changed done
 * ones in the room left, in document order. Done tasks pile up in the outline (a spec plugin
 * dropped them from its file), so the first ones in document order would push the newest work out.
 */
export function pickListed(tasks: readonly SessionTask[], max: number): SessionTask[] {
	if (tasks.length <= max) return [...tasks];
	const open = tasks.filter((t) => t.taskJson.status !== "done").slice(0, max);
	const done = tasks
		.filter((t) => t.taskJson.status === "done")
		.sort((a, b) => b.versionSeq - a.versionSeq || (a.id < b.id ? -1 : 1))
		.slice(0, max - open.length);
	const keep = new Set([...open, ...done].map((t) => t.id));
	return tasks.filter((t) => keep.has(t.id));
}

/** The session's tasks as the spec list (see the module header). */
export async function readSpecCompatList(
	session: PluginTaskSession,
	store: OutlineStore = outlineStore,
): Promise<SpecCompatList> {
	const space = await store.findSpace({ kind: "session", narratorId: session.narratorId });
	if (!space) return { space: null, entries: [] };
	const walk = await walkSessionTasks(space, {
		limit: SPEC_COMPAT_LIMITS.scan,
		keep: (task) => task.topLevel && task.taskJson.status !== "cancelled",
		store,
	});
	if (walk.cut || walk.next)
		logger.warn("A plugin's spec task list stopped at its read budget", {
			narratorId: session.narratorId,
			read: walk.tasks.length,
		});
	const listed = pickListed(walk.tasks, SPEC_COMPAT_LIMITS.tasks);
	// A done task's mark is read too: it reads done, but marking it blocked again must find it.
	const [texts, waiting, notes] = await Promise.all([
		readTaskTexts(
			listed.map((t) => t.id),
			store,
		),
		readWaitingTasks(listed, space.id, store),
		readPluginBlockedNotes(
			listed.map((t) => t.id),
			space.id,
			store,
		),
	]);
	return {
		space,
		entries: listed.map((task) => {
			const blockedNote = notes.get(task.id) ?? null;
			return {
				task,
				// A spec task's text is never empty: a task without text reads as its address.
				text: texts.get(task.id) || `${space.key}/${task.sid}`,
				status: specStatusOf(task, waiting.has(task.id), blockedNote?.live === true),
				protected: task.taskJson.humanCreated === true,
				blockedNote,
			};
		}),
	};
}

function documentOf(entries: readonly SpecCompatEntry[]): SpecTasksDocument {
	return {
		tasks: entries.map(
			(entry): SpecTaskItem => ({
				text: entry.text,
				status: entry.status,
				...(entry.protected ? { protected: true as const } : {}),
			}),
		),
	};
}

/** What `readSpecTasksForPlugin` answers, read from an outline session. */
export interface SpecCompatTasks {
	content: string;
	revisionId: string | null;
	document: SpecTasksDocument;
	compiled: CompiledSpecTasks;
}

/** `spec_tasks_get` in an outline session. */
export async function readSpecTasksCompat(
	narratorId: string,
	options: { store?: OutlineStore } = {},
): Promise<SpecCompatTasks> {
	const store = options.store ?? outlineStore;
	const session = await resolvePluginTaskSession(narratorId);
	const list = await readSpecCompatList(session, store);
	const document = documentOf(list.entries);
	return {
		content: serializeSpecTasksDocument(document),
		revisionId: list.space ? outlineRevisionId(list.space, latestSeq(list.space)) : null,
		document,
		compiled: compileSpecTasks(document),
	};
}

/** `spec_task_add` in an outline session. */
export async function addSpecTaskCompat(args: {
	narratorId: string;
	pluginId: string;
	text: string;
	protected: boolean;
	store?: OutlineStore;
	isRunning?: (narratorId: string) => boolean;
}): Promise<{ added: boolean; protected: boolean; revisionId: string }> {
	const added = await addPluginTask({
		narratorId: args.narratorId,
		pluginId: args.pluginId,
		text: args.text,
		protected: args.protected,
		...(args.store ? { store: args.store } : {}),
		...(args.isRunning ? { isRunning: args.isRunning } : {}),
	});
	return {
		added: added.added,
		protected: added.humanCreated,
		revisionId: outlineRevisionId(added.space, added.seq),
	};
}

/** What `writeSpecForPlugin` answers. */
export interface SpecCompatWritten {
	path: string;
	uri: string;
	revisionId: string | null;
}

/** A spec status as a task's checkbox: `blocked` is in progress (with a note). */
function checkboxOf(status: SpecTaskStatus): "todo" | "doing" | "done" {
	return status === "blocked" ? "doing" : status;
}

/**
 * The old list's entry each new item continues, by text (see the module header), or -1: the first
 * entry in order not taken yet whose listed text, or whose text as stored, the item's text is.
 */
function matchItems(
	entries: readonly SpecCompatEntry[],
	items: readonly SpecTaskItem[],
	normalized: readonly string[],
): number[] {
	const keys = entries.map((entry) => bodyKey(entry.text));
	const taken = new Set<number>();
	return items.map((item, i) => {
		const wanted = new Set([bodyKey(item.text), bodyKey(normalized[i] ?? item.text)]);
		const at = keys.findIndex((key, j) => !taken.has(j) && wanted.has(key));
		if (at >= 0) taken.add(at);
		return at;
	});
}

/**
 * The texts as the write path would store them: normalized off the main thread when large, in
 * jobs within half of what one job may carry (100 tasks of 1000 characters can exceed one).
 */
async function normalizedTexts(texts: readonly string[]): Promise<string[]> {
	const out: string[] = [];
	for (let i = 0; i < texts.length; ) {
		const job: string[] = [];
		let bytes = 0;
		for (; i < texts.length; i++) {
			const size = Buffer.byteLength(texts[i] as string, "utf8");
			if (job.length > 0 && bytes + size > OUTLINE_EDIT_TEXT_LIMITS.maxBytes / 2) break;
			job.push(texts[i] as string);
			bytes += size;
		}
		const normalized = await processEditText({ kind: "normalize", contents: job });
		for (const entry of normalized) out.push(entry.content);
	}
	return out;
}

/** `spec_write` of tasks.json in an outline session. */
export async function writeSpecTasksCompat(args: {
	narratorId: string;
	pluginId: string;
	content: string;
	store?: OutlineStore;
	isRunning?: (narratorId: string) => boolean;
}): Promise<SpecCompatWritten> {
	const store = args.store ?? outlineStore;
	// Validated as a spec write validates it, with its errors.
	if (args.content.length > MAX_SPEC_FILE_CHARS)
		throw new Error(`Spec file content must be at most ${MAX_SPEC_FILE_CHARS} characters`);
	const document = parseSpecTasksDocument(args.content);
	const session = await resolvePluginTaskSession(args.narratorId);
	return await oneAtATime(session.narratorId, async () => {
		const space = await store.ensureSpace(
			{ kind: "session", narratorId: session.narratorId },
			new Date().toISOString(),
		);
		const listed = (await readSpecCompatList(session, store)).entries;
		const normalized = await normalizedTexts(document.tasks.map((t) => t.text));
		const matches = matchItems(listed, document.tasks, normalized);
		const [pageOwner] = await store.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
		// A text the list does not hold may still be a task of the task page (a done one the list
		// left out): it is that task, not a new one (review S4).
		const entries = [...listed];
		const unmatched = matches.flatMap((at, i) => (at < 0 ? [i] : []));
		if (unmatched.length > 0 && pageOwner) {
			const extra = await taskPageEntries(store, space, pageOwner.id, listed);
			const extraMatches = matchItems(
				extra,
				unmatched.map((i) => document.tasks[i] as SpecTaskItem),
				unmatched.map((i) => normalized[i] as string),
			);
			unmatched.forEach((i, k) => {
				const at = extraMatches[k] as number;
				if (at < 0) return;
				entries.push(extra[at] as SpecCompatEntry);
				matches[i] = entries.length - 1;
			});
		}
		const matched = new Set(matches.filter((at) => at >= 0));
		const itemOf = new Map(matches.flatMap((at, i) => (at >= 0 ? [[at, i] as const] : [])));

		// What the plugin may not do, in the order a spec write lists it (task by task): finish,
		// drop or un-protect a person's open task; finish or cancel a task a person locked, or
		// cancel one under it (review S2).
		const refused: Array<{ kind: string; text: string; details: string }> = [];
		entries.forEach((entry, j) => {
			if (entry.status === "done") return;
			const i = itemOf.get(j);
			const item = i === undefined ? undefined : document.tasks[i];
			if (!item) {
				// Dropped: only the task page's own are cancelled (the rest are left alone).
				if (j >= listed.length) return;
				if (entry.protected)
					refused.push({
						kind: "delete",
						text: entry.text,
						details: "Protected task was removed from tasks.json.",
					});
				else if (entry.task.onTasksPage && entry.task.inLockedTree)
					refused.push({ kind: "delete", text: entry.text, details: LOCKED_DETAILS });
				return;
			}
			if (entry.protected && item.protected !== true)
				refused.push({
					kind: "modify",
					text: entry.text,
					details: "Protected task had its protected flag removed.",
				});
			if (item.status === "done") {
				if (entry.protected)
					refused.push({
						kind: "complete",
						text: entry.text,
						details: "Protected task was marked done.",
					});
				else if (entry.task.lockRoot)
					refused.push({ kind: "complete", text: entry.text, details: LOCKED_DETAILS });
			}
		});
		if (refused.length > 0) throw new SpecProtectedTaskError(refused);

		const ops: OutlineOp[] = [];
		let pageRef: OutlineBlockRef | null = pageOwner ? { id: pageOwner.id } : null;
		const page = (): OutlineBlockRef => {
			if (pageRef) return pageRef;
			ops.push({
				op: "insert",
				tempId: "page",
				parent: null,
				content: OUTLINE_TASKS_PAGE_TITLE[session.locale === "zh-CN" ? "zh-CN" : "en"],
				alias: OUTLINE_TASKS_PAGE_ALIAS,
			});
			pageRef = { tempId: "page" };
			return pageRef;
		};
		// The blocked mark: written once, brought back when someone took it, taken by another status.
		const markBlocked = (taskId: string, note: SpecCompatEntry["blockedNote"]) => {
			if (note?.live) return;
			if (note?.deleted)
				ops.push({ op: "restore", block: { id: note.id }, parent: { id: taskId } });
			else if (note)
				// Moved away by someone: back under its task, first (its short id is taken).
				ops.push({
					op: "move",
					block: { id: note.id },
					parent: { id: taskId },
					position: { first: true },
				});
			else
				ops.push({
					op: "insert",
					sid: pluginBlockedNoteSid(taskId),
					parent: { id: taskId },
					position: { first: true },
					content: SPEC_COMPAT_BLOCKED_NOTE[session.locale](args.pluginId),
				});
		};

		// The task page's own tasks in the new order: kept ones (by their entry) and new ones.
		const sequence: Array<{ entry: number } | { item: number }> = [];
		document.tasks.forEach((_, i) => {
			const at = matches[i] as number;
			if (at < 0) sequence.push({ item: i });
			else if (at < listed.length && (entries[at] as SpecCompatEntry).task.onTasksPage)
				sequence.push({ entry: at });
		});
		const kept = sequence.flatMap((s) => ("entry" in s ? [s.entry] : []));
		const reordered = kept.some((at, k) => k > 0 && at < (kept[k - 1] as number));
		if (sequence.some((step) => "item" in step) && pageOwner) {
			// Nothing is added to a task page a person locked.
			const [pageMeta] = await store.getBlockMetas(space.id, { ids: [pageOwner.id] });
			if (isPersonLock(pageMeta?.taskJson))
				throw new PluginTaskError(
					"CONFLICT",
					PLUGIN_TASK_TEXT.locked(`${space.key}/${pageMeta?.sid}`),
				);
		}

		// Changes of the tasks that stay.
		document.tasks.forEach((item, i) => {
			const at = matches[i] as number;
			if (at < 0) return;
			const entry = entries[at] as SpecCompatEntry;
			const patch: OutlineTaskPatch = {};
			const box = checkboxOf(item.status);
			if (entry.status !== item.status && entry.task.taskJson.status !== box) patch.status = box;
			if (item.protected === true && !entry.protected) patch.humanCreated = true;
			if (Object.keys(patch).length > 0)
				ops.push({
					op: "setTask",
					block: { id: entry.task.id },
					task: patch,
					baseVersionSeq: entry.task.versionSeq,
				});
			if (item.status === "blocked") {
				if (entry.status !== "blocked") markBlocked(entry.task.id, entry.blockedNote);
			} else if (entry.blockedNote?.live) {
				ops.push({ op: "delete", block: { id: entry.blockedNote.id } });
			}
		});

		// The task page's order: new tasks after the one before them, kept ones moved if need be.
		let anchor: OutlineBlockRef | null = null;
		for (const step of sequence) {
			const position: OutlinePosition = anchor ? { after: anchor } : { first: true };
			if ("entry" in step) {
				const entry = entries[step.entry] as SpecCompatEntry;
				if (reordered)
					ops.push({
						op: "move",
						block: { id: entry.task.id },
						parent: page(),
						position,
						baseVersionSeq: entry.task.versionSeq,
					});
				anchor = { id: entry.task.id };
				continue;
			}
			const item = document.tasks[step.item] as SpecTaskItem;
			// Its id is chosen here, so its blocked mark's short id follows from it in this commit.
			const id = generateId();
			ops.push({
				op: "insert",
				id,
				parent: page(),
				position,
				content: item.text,
				task: {
					status: checkboxOf(item.status),
					...(item.protected === true ? { humanCreated: true } : {}),
				},
			});
			if (item.status === "blocked") markBlocked(id, null);
			anchor = { id };
		}

		// Listed tasks no longer listed: open ones on the task page are cancelled; done ones, and
		// tasks elsewhere, are left alone (review S3: a done task dropped from the file is still
		// done work).
		let ignored = 0;
		listed.forEach((entry, j) => {
			if (matched.has(j)) return;
			if (!entry.task.onTasksPage || entry.status === "done") {
				ignored++;
				return;
			}
			ops.push({
				op: "setTask",
				block: { id: entry.task.id },
				task: { status: "cancelled" },
				baseVersionSeq: entry.task.versionSeq,
			});
		});
		if (ignored > 0)
			logger.info("A plugin's spec task list left tasks it no longer lists alone", {
				narratorId: session.narratorId,
				pluginId: args.pluginId,
				ignored,
			});
		if (ops.length === 0)
			return {
				path: "tasks.json",
				uri: "spec://tasks.json",
				revisionId: outlineRevisionId(space, latestSeq(space)),
			};
		const result = await writeForPlugin(
			session,
			space,
			args.pluginId,
			ops,
			OUTLINE_TEXT.pluginTasksWritten(args.pluginId),
			{ store, ...(args.isRunning ? { isRunning: args.isRunning } : {}) },
		);
		return {
			path: "tasks.json",
			uri: "spec://tasks.json",
			revisionId: outlineRevisionId(space, result.commit?.seq ?? latestSeq(space)),
		};
	});
}

/** Why a plugin may not finish or cancel a task a person locked (the spec refusal's form). */
const LOCKED_DETAILS = "Task is locked by a person (its plan waits for them).";

/**
 * The task page's own tasks (not cancelled) the list does not hold, as entries an item may
 * continue: one bounded read of the page's last children and the heads of those found.
 */
async function taskPageEntries(
	store: OutlineStore,
	space: OutlineSpaceRow,
	pageId: string,
	listed: readonly SpecCompatEntry[],
): Promise<SpecCompatEntry[]> {
	const held = new Set(listed.map((entry) => entry.task.id));
	const children = (
		await store.listLastChildMetas(space.id, pageId, SPEC_COMPAT_LIMITS.pageScan)
	).filter((meta) => meta.taskJson && meta.taskJson.status !== "cancelled" && !held.has(meta.id));
	if (children.length === 0) return [];
	const ids = children.map((meta) => meta.id);
	const [texts, notes] = await Promise.all([
		readTaskTexts(ids, store),
		readPluginBlockedNotes(ids, space.id, store),
	]);
	return children.reverse().map((meta) => {
		const taskJson = meta.taskJson as OutlineTaskJson;
		const lockRoot = isPersonLock(taskJson);
		const task: SessionTask = {
			id: meta.id,
			sid: meta.sid,
			parentId: meta.parentId,
			pageId: meta.pageId,
			taskJson,
			versionSeq: meta.versionSeq,
			path: [],
			depth: 1,
			topLevel: true,
			onTasksPage: true,
			lockRoot,
			inLockedTree: lockRoot,
		};
		return {
			task,
			text: texts.get(meta.id) || `${space.key}/${meta.sid}`,
			status: specStatusOf(task, false, notes.get(meta.id)?.live === true),
			protected: taskJson.humanCreated === true,
			blockedNote: notes.get(meta.id) ?? null,
		};
	});
}

/**
 * The short id of a session's `index.md` page (short ids are unique within a space). The import of
 * old sessions (outline plan PR 12b) must write a session's `index.md` under `specIndexSid()`, so
 * a plugin's later `spec_write` of index.md replaces that page instead of making a second one
 * (review N2).
 */
export function specIndexSid(): string {
	return `pi${createHash("sha256").update("spec-index\u0000index.md").digest("hex").slice(0, 12)}`;
}

/**
 * What a rewrite of the `index.md` page deletes (review N1): its notes; a task on it is kept (a
 * person or the session may have added it there), and a person's task (created or locked by them)
 * under a note refuses the rewrite instead of going with the note.
 */
async function replacedUnder(
	store: OutlineStore,
	space: OutlineSpaceRow,
	page: { id: string; pageId: string },
): Promise<string[]> {
	const structure = await store.listPageStructure(page.pageId, {
		asOf: null,
		limit: OUTLINE_LIMITS.maxPageBlocks,
	});
	const children = new Map<string, typeof structure.rows>();
	for (const row of structure.rows) {
		if (row.parentId === null) continue;
		const list = children.get(row.parentId);
		if (list) list.push(row);
		else children.set(row.parentId, [row]);
	}
	const out: string[] = [];
	for (const child of children.get(page.id) ?? []) {
		if (child.taskJson) continue;
		const stack = [...(children.get(child.id) ?? [])];
		while (stack.length > 0) {
			const row = stack.pop() as (typeof structure.rows)[number];
			if (row.taskJson && (row.taskJson.humanCreated === true || isPersonLock(row.taskJson)))
				throw new PluginTaskError(
					"CONFLICT",
					`index.md holds a person's task (${space.key}/${row.sid}) under a note it would replace: nothing was written`,
				);
			stack.push(...(children.get(row.id) ?? []));
		}
		out.push(child.id);
	}
	if (out.length > OUTLINE_LIMITS.maxOps)
		throw new PluginTaskError("PAYLOAD_TOO_LARGE", INDEX_TOO_LARGE);
	return out;
}

const INDEX_TOO_LARGE = `index.md does not fit one outline commit (${OUTLINE_LIMITS.maxOps} blocks, ${OUTLINE_LIMITS.maxTransactionBodyBytes} bytes): nothing was written`;

/** `spec_write` of index.md in an outline session. */
export async function writeSpecIndexCompat(args: {
	narratorId: string;
	pluginId: string;
	content: string;
	store?: OutlineStore;
}): Promise<SpecCompatWritten> {
	const store = args.store ?? outlineStore;
	// Validated as a spec write validates it, with its errors.
	if (args.content.length > MAX_SPEC_FILE_CHARS)
		throw new Error(`Spec file content must be at most ${MAX_SPEC_FILE_CHARS} characters`);
	if (!args.content.trim()) throw new Error("spec://index.md must not be empty");
	const session = await resolvePluginTaskSession(args.narratorId);
	const converted = await processEditText({
		kind: "report",
		text: args.content,
		continued: DELEGATION_BLOCK_TEXT[session.locale].continued,
	});
	const tooLarge = () => new PluginTaskError("PAYLOAD_TOO_LARGE", INDEX_TOO_LARGE);
	if (converted.omittedBytes > 0) throw tooLarge();
	return await oneAtATime(`index:${session.narratorId}`, async () => {
		const space = await store.ensureSpace(
			{ kind: "session", narratorId: session.narratorId },
			new Date().toISOString(),
		);
		const sid = specIndexSid();
		const [meta] = await store.getBlockMetas(space.id, { sids: [sid] });
		const ops: OutlineOp[] = [];
		const canonical: Array<OutlineCanonicalContent | null> = [];
		const push = (op: OutlineOp, content: OutlineCanonicalContent | null = null) => {
			ops.push(op);
			canonical.push(content);
		};
		let pageRef: OutlineBlockRef;
		if (!meta) {
			push({ op: "insert", tempId: "index", sid, parent: null, content: SPEC_COMPAT_INDEX_TITLE });
			pageRef = { tempId: "index" };
		} else if (meta.deleted) {
			push({ op: "restore", block: { id: meta.id }, parent: null });
			pageRef = { id: meta.id };
		} else {
			if (meta.parentId !== null) push({ op: "move", block: { id: meta.id }, parent: null });
			for (const id of await replacedUnder(store, space, meta))
				push({ op: "delete", block: { id } });
			pageRef = { id: meta.id };
		}
		const walk = (nodes: typeof converted.blocks, parent: OutlineBlockRef): void => {
			for (const node of nodes) {
				const tempId = `n${ops.length}`;
				push(
					{ op: "insert", tempId, parent, content: node.content },
					{ content: node.content, links: node.links },
				);
				walk(node.children, { tempId });
			}
		};
		walk(converted.blocks, pageRef);
		if (ops.length > OUTLINE_LIMITS.maxOps) throw tooLarge();
		const result = await writeForPlugin(
			session,
			space,
			args.pluginId,
			ops,
			OUTLINE_TEXT.pluginIndexWritten(args.pluginId),
			{ store, canonical },
		);
		return {
			path: "index.md",
			uri: "spec://index.md",
			revisionId: outlineRevisionId(space, result.commit?.seq ?? latestSeq(space)),
		};
	});
}

/** `spec_behavior_fence_update` in an outline root session. */
export async function setSpecFenceCompat(args: {
	narratorId: string;
	pluginId: string;
	mode: "upsert" | "clear";
	text: string;
	store?: OutlineStore;
}): Promise<{ updated: boolean; revisionId: string | null }> {
	const written = await setOutlinePluginRules({
		narratorId: args.narratorId,
		pluginId: args.pluginId,
		mode: args.mode,
		text: args.text,
		compat: true,
		...(args.store ? { store: args.store } : {}),
	});
	return {
		updated: true,
		revisionId: written.space ? outlineRevisionId(written.space, written.seq) : null,
	};
}

export { OUTLINE_PLUGIN_TASK_LIMITS };
