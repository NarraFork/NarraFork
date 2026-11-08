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
 * `{ text, status, protected }`: a cancelled task is not listed, a task that waits (a
 * prerequisite, a person, a confirmation) reads `blocked`, `protected` is created by a person.
 * The text is the head of the task's content ({@link OUTLINE_PLUGIN_TASK_LIMITS.textChars}
 * characters, the spec limit). `revisionId` is `outline:<space key>:<seq>`; `compiled` is
 * computed from the list as for a spec file.
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
 * in order), and becomes one commit:
 *   - a new text: a task on the task page, after the item before it on the task page (first when
 *     none is), to do, in progress or done; `blocked` is in progress with a note under it (no
 *     question is asked); `protected` makes it created by a person, not locked;
 *   - a status that changed: set (`blocked` as above); `protected` on a task that was not is set;
 *   - a task no longer listed: cancelled when it is a direct child of the task page (what is under
 *     it stays: cancelling, not deleting); one elsewhere (a plan's) is left alone and logged;
 *   - the task page's own tasks are moved only when their order changed.
 * A write that would finish, drop or un-protect an open task a person created is refused whole,
 * with the error a spec session gives (a plugin writes on the agent's side there). Setting and
 * moving name the version read, so a change made meanwhile refuses the write. The answer is the
 * spec one, `{ path, uri, revisionId }`.
 *
 * NOTES (`spec_write` of index.md)
 * --------------------------------
 * The page `index.md` of the session space (its short id follows from the name; made, moved back
 * or brought back as needed) gets the text as notes (headings hold their sections, nothing is
 * outline syntax), replacing what it held, in one commit within one commit's limits; a text that
 * does not fit is refused (`PAYLOAD_TOO_LARGE`) and nothing is written.
 *
 * THE FENCE (`spec_behavior_fence_update`)
 * ----------------------------------------
 * The plugin's block on the behavior page (`outline-plugin-rules.ts`). A subagent keeps writing
 * its own old fence (see there), so the session layer sends only a root session here.
 */
import { createHash } from "node:crypto";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { DELEGATION_BLOCK_TEXT } from "./outline/delegation-text";
import { processEditText } from "./outline/edit-text-runner";
import { OUTLINE_TEXT } from "./outline/messages";
import { OUTLINE_LIMITS, OUTLINE_TASKS_PAGE_ALIAS } from "./outline/model";
import { OUTLINE_TASKS_PAGE_TITLE, oneAtATime } from "./outline/person-tasks";
import {
	addPluginTask,
	latestSeq,
	OUTLINE_PLUGIN_TASK_LIMITS,
	outlineRevisionId,
	PluginTaskError,
	type PluginTaskSession,
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
	protectedMutationMessage,
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
}

export interface SpecCompatList {
	space: OutlineSpaceRow | null;
	entries: SpecCompatEntry[];
}

/** The text a whitespace run counts as one space for. */
function bodyKey(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** The session's tasks as the spec list (see the module header). */
export async function readSpecCompatList(
	session: PluginTaskSession,
	store: OutlineStore = outlineStore,
): Promise<SpecCompatList> {
	const space = await store.findSpace({ kind: "session", narratorId: session.narratorId });
	if (!space) return { space: null, entries: [] };
	const walk = await walkSessionTasks(space, {
		limit: SPEC_COMPAT_LIMITS.tasks,
		keep: (task) => task.topLevel && task.taskJson.status !== "cancelled",
		store,
	});
	if (walk.cut)
		logger.warn("A plugin's spec task list stopped at its read budget", {
			narratorId: session.narratorId,
			listed: walk.tasks.length,
		});
	const [texts, waiting] = await Promise.all([
		readTaskTexts(
			walk.tasks.map((t) => t.id),
			store,
		),
		readWaitingTasks(walk.tasks, space.id, store),
	]);
	return {
		space,
		entries: walk.tasks.map((task) => {
			const own = task.taskJson.status;
			const status: SpecTaskStatus =
				own === "done"
					? "done"
					: waiting.has(task.id)
						? "blocked"
						: own === "doing"
							? "doing"
							: "todo";
			return {
				task,
				// A spec task's text is never empty: a task without text reads as its address.
				text: texts.get(task.id) || `${space.key}/${task.sid}`,
				status,
				protected: task.taskJson.humanCreated === true,
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
		const { entries } = await readSpecCompatList(session, store);
		const normalized = (
			await processEditText({ kind: "normalize", contents: document.tasks.map((t) => t.text) })
		).map((entry) => entry.content);
		const matches = matchItems(entries, document.tasks, normalized);
		const matched = new Set(matches.filter((at) => at >= 0));

		// A person's open task is not the plugin's to finish, drop or un-protect (as in spec).
		const refused: Array<{ kind: string; text: string; details: string }> = [];
		entries.forEach((entry, j) => {
			if (!entry.protected || entry.status === "done") return;
			if (!matched.has(j))
				refused.push({
					kind: "delete",
					text: entry.text,
					details: "Protected task was removed from tasks.json.",
				});
		});
		document.tasks.forEach((item, i) => {
			const entry = entries[matches[i] as number];
			if (!entry?.protected || entry.status === "done") return;
			if (item.protected !== true)
				refused.push({
					kind: "modify",
					text: entry.text,
					details: "Protected task had its protected flag removed.",
				});
			if (item.status === "done")
				refused.push({
					kind: "complete",
					text: entry.text,
					details: "Protected task was marked done.",
				});
		});
		if (refused.length > 0) throw new Error(protectedMutationMessage(refused));

		const [pageOwner] = await store.findAliasOwners(space.id, [OUTLINE_TASKS_PAGE_ALIAS]);
		const ops: OutlineOp[] = [];
		const canonical: Array<OutlineCanonicalContent | null> = [];
		const push = (op: OutlineOp) => {
			ops.push(op);
			canonical.push(null);
		};
		let pageRef: OutlineBlockRef | null = pageOwner ? { id: pageOwner.id } : null;
		const page = (): OutlineBlockRef => {
			if (pageRef) return pageRef;
			push({
				op: "insert",
				tempId: "page",
				parent: null,
				content: OUTLINE_TASKS_PAGE_TITLE[session.locale === "zh-CN" ? "zh-CN" : "en"],
				alias: OUTLINE_TASKS_PAGE_ALIAS,
			});
			pageRef = { tempId: "page" };
			return pageRef;
		};
		const note = (parent: OutlineBlockRef) =>
			push({
				op: "insert",
				parent,
				position: { first: true },
				content: SPEC_COMPAT_BLOCKED_NOTE[session.locale](args.pluginId),
			});

		// The task page's own tasks in the new order: kept ones (by their entry) and new ones.
		const sequence: Array<{ entry: number } | { item: number }> = [];
		document.tasks.forEach((_, i) => {
			const at = matches[i] as number;
			if (at < 0) sequence.push({ item: i });
			else if ((entries[at] as SpecCompatEntry).task.onTasksPage) sequence.push({ entry: at });
		});
		const kept = sequence.flatMap((s) => ("entry" in s ? [s.entry] : []));
		const reordered = kept.some((at, k) => k > 0 && at < (kept[k - 1] as number));

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
				push({
					op: "setTask",
					block: { id: entry.task.id },
					task: patch,
					baseVersionSeq: entry.task.versionSeq,
				});
			if (item.status === "blocked" && entry.status !== "blocked") note({ id: entry.task.id });
		});

		// The task page's order: new tasks after the one before them, kept ones moved if need be.
		let anchor: OutlineBlockRef | null = null;
		for (const step of sequence) {
			const position: OutlinePosition = anchor ? { after: anchor } : { first: true };
			if ("entry" in step) {
				const entry = entries[step.entry] as SpecCompatEntry;
				if (reordered)
					push({
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
			const tempId = `t${step.item}`;
			push({
				op: "insert",
				tempId,
				parent: page(),
				position,
				content: item.text,
				task: {
					status: checkboxOf(item.status),
					...(item.protected === true ? { humanCreated: true } : {}),
				},
			});
			if (item.status === "blocked") note({ tempId });
			anchor = { tempId };
		}

		// Tasks no longer listed: cancelled on the task page, left alone elsewhere.
		let ignored = 0;
		entries.forEach((entry, j) => {
			if (matched.has(j)) return;
			if (!entry.task.onTasksPage || entry.protected) {
				ignored++;
				return;
			}
			push({
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

/** The short id of a session's `index.md` page (short ids are unique within a space). */
export function specIndexSid(): string {
	return `pi${createHash("sha256").update("spec-index\u0000index.md").digest("hex").slice(0, 12)}`;
}

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
	const tooLarge = () =>
		new PluginTaskError(
			"PAYLOAD_TOO_LARGE",
			`index.md does not fit one outline commit (${OUTLINE_LIMITS.maxOps} blocks, ${OUTLINE_LIMITS.maxTransactionBodyBytes} bytes): nothing was written`,
		);
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
			const children = await store.listChildMetas(space.id, [meta.id], OUTLINE_LIMITS.maxOps + 1);
			for (const child of children) push({ op: "delete", block: { id: child.id } });
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
