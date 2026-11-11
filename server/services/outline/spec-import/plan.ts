/**
 * What an import of a session's Dynamic Spec writes (outline P2 PR 12b; PR 12 design §2.3, owner
 * decisions D52 and D54): pure functions from the spec state as read to the blocks to write, each
 * with a short id that follows from its source. No database access.
 *
 * TASKS (`tasks.json`, in array order, onto the session's task page)
 *
 *   | spec                         | live session                 | archived session            |
 *   |------------------------------|------------------------------|-----------------------------|
 *   | todo                         | to do                        | to do                       |
 *   | doing                        | in progress (the session's   | to do, with a note that it  |
 *   |                              | claim, by the write path)    | was in progress (D54)       |
 *   | done                         | done                         | done                        |
 *   | blocked                      | in progress, a 受阻 note     | to do, a 受阻 note          |
 *   |                              | under it; no question (D52)  |                             |
 *
 * The blocked note is the mark plugins write and read (`pluginBlockedNoteSid`), so a plugin still
 * reads `blocked` for the task through the old commands (12a) and takes the mark away by setting
 * a status.
 *
 * `protected` ⇔ created by a person (`humanCreated`), whoever protected it. Only a task a PERSON
 * protected (the revision its lock was made in was the person's: the Spec panel, `/goal`) is
 * locked, by the session's owner (D52); one an agent or a plugin protected, or whose protector is
 * not known, is not. A session without an owner has nobody to lock for.
 *
 * NOTES (every other file)
 *
 * One page per file, titled with its path; `index.md` is the page 12a's compatibility layer
 * writes (`specIndexSid`), so a plugin's later `spec_write` replaces it instead of adding a second
 * one. A file of more blocks than a page should hold becomes several pages (`name (2/3)`): a block
 * whose parent stayed on an earlier part hangs from the part's page.
 *
 * SHORT IDS
 *
 * Tasks follow from (session, `tasks.json` revision, index); a file's page and blocks from
 * (session, path, revision). The same source gives the same ids, so an import cut short writes
 * only what is missing, and nothing twice; a source that changed gives new ids, and what an
 * earlier attempt wrote from the old one is recognizably the import's ({@link isImportSid}) and
 * taken away first (`importer.ts`).
 */
import { createHash } from "node:crypto";
import type { Locale } from "@server/lib/prompt-i18n";
import type { TaskStatus } from "@shared/outline";
import type { ExtractedLink } from "../links";
import type { OutlineTaskInput } from "../write";
import type { SpecProtector } from "./read-port";

export const SPEC_IMPORT_PLAN_LIMITS = {
	/** Blocks of one imported page: a page deleted whole stays within one commit's rows. */
	pageBlocks: 1500,
} as const;

/** The system actor of the import's commits. */
export const OUTLINE_SPEC_IMPORT_ACTOR = "spec-import";

export const SPEC_IMPORT_TEXT: Record<
	Locale,
	{
		blocked: string;
		wasDoing: string;
		part: (title: string, n: number, of: number) => string;
		continued: string;
		summaryTasks: (n: number) => string;
		summaryNotes: (path: string) => string;
		summaryStale: string;
		summaryTasksPage: string;
	}
> = {
	en: {
		blocked: "Blocked (its state before the import from Dynamic Spec)",
		wasDoing:
			"In progress before the import from Dynamic Spec; its session was archived, so it is to do again",
		part: (title, n, of) => `${title} (${n}/${of})`,
		continued: "(cont.)",
		summaryTasks: (n) => `Imported from Dynamic Spec: ${n} task${n === 1 ? "" : "s"}`,
		summaryNotes: (path) => `Imported from Dynamic Spec: ${path}`,
		summaryStale: "Removed what an earlier, unfinished import from Dynamic Spec wrote",
		summaryTasksPage: "Task page for the import from Dynamic Spec",
	},
	"zh-CN": {
		blocked: "受阻（导入前在 Dynamic Spec 里的状态）",
		wasDoing: "导入前在 Dynamic Spec 里是进行中；会话已归档，所以回到待办",
		part: (title, n, of) => `${title}（${n}/${of}）`,
		continued: "（续）",
		summaryTasks: (n) => `从 Dynamic Spec 导入：${n} 个任务`,
		summaryNotes: (path) => `从 Dynamic Spec 导入：${path}`,
		summaryStale: "清掉上一次没做完的 Dynamic Spec 导入写下的内容",
		summaryTasksPage: "Dynamic Spec 导入用的任务页",
	},
};

function tag(parts: readonly string[], length: number): string {
	return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, length);
}

/** Longer than the 8 characters a drawn short id has, so none collides with one. */
const IMPORT_SID_RE = /^s[tpbw][0-9a-f]{10,12}[0-9a-z]*$/;

/** A short id the import gave (a task, a page, a page's block, a note under a task). */
export function isImportSid(sid: string): boolean {
	return sid.length >= 12 && IMPORT_SID_RE.test(sid);
}

/** One block the import writes. */
export interface SpecImportNode {
	sid: string;
	/** Its parent's short id; null: the group's root (the task page, or a new page). */
	parentSid: string | null;
	/** A block id chosen by the import (tasks: their blocked note's short id follows from it). */
	id?: string;
	content: string;
	/** Canonical content from the text worker; absent: the write path normalizes (small text). */
	links?: ExtractedLink[];
	task?: OutlineTaskInput;
}

export interface SpecImportTask {
	text: string;
	status: "todo" | "doing" | "done" | "blocked";
	protected: boolean;
}

/** A task's text as the text worker normalized it (null: the write path does). */
export interface NormalizedTaskText {
	content: string;
	links: ExtractedLink[];
}

export interface SpecImportTaskPlan {
	/** The tasks, in order, to go last on the task page. */
	tasks: SpecImportNode[];
	/** Notes under them (blocked, was in progress), written after every task. */
	notes: SpecImportNode[];
	/** What each task must read after the import, by index. */
	expected: SpecImportExpectedTask[];
	/** Every task short id of this source starts with this. */
	sidPrefix: string;
}

export interface SpecImportExpectedTask {
	sid: string;
	status: TaskStatus;
	humanCreated: boolean;
	locked: boolean;
	/** Claimed by the session after the import. */
	claimed: boolean;
	/** Canonical content, when the worker gave one. */
	content: string | null;
	noteSids: string[];
}

/** `pluginBlockedNoteSid` of `plugin-tasks.ts`, restated so this module stays free of the store. */
export type BlockedNoteSid = (taskBlockId: string) => string;

export function planSpecTasks(args: {
	narratorId: string;
	revisionId: string;
	tasks: readonly SpecImportTask[];
	/** Canonical text by index (null: left to the write path). */
	normalized: ReadonlyArray<NormalizedTaskText | null>;
	/** Who first protected a task, by index. */
	protectors: ReadonlyArray<SpecProtector | null>;
	ownerUserId: string | null;
	archived: boolean;
	locale: Locale;
	blockedNoteSid: BlockedNoteSid;
}): SpecImportTaskPlan {
	const t = tag([args.narratorId, args.revisionId], 10);
	const text = SPEC_IMPORT_TEXT[args.locale];
	const plan: SpecImportTaskPlan = { tasks: [], notes: [], expected: [], sidPrefix: `st${t}` };
	args.tasks.forEach((task, n) => {
		const sid = `st${t}${n.toString(36)}`;
		const id = `si${tag([args.narratorId, args.revisionId, String(n)], 30)}`;
		const open = task.status !== "done";
		const status: TaskStatus =
			task.status === "done" ? "done" : task.status === "todo" || args.archived ? "todo" : "doing";
		const byPerson = task.protected && args.protectors[n] === "user" && args.ownerUserId !== null;
		const owner = args.ownerUserId;
		const input: OutlineTaskInput = {
			status,
			manager:
				byPerson && owner ? { kind: "human", id: owner } : { kind: "agent", id: args.narratorId },
			...(task.protected ? { humanCreated: true } : {}),
			...(byPerson && owner ? { lock: { by: { kind: "human", id: owner }, delegate: null } } : {}),
		};
		const canonical = args.normalized[n] ?? null;
		plan.tasks.push({
			sid,
			parentSid: null,
			id,
			content: canonical?.content ?? task.text,
			...(canonical ? { links: canonical.links } : {}),
			task: input,
		});
		const noteSids: string[] = [];
		if (task.status === "blocked") {
			const noteSid = args.blockedNoteSid(id);
			plan.notes.push({ sid: noteSid, parentSid: sid, content: text.blocked });
			noteSids.push(noteSid);
		}
		if (task.status === "doing" && args.archived) {
			const noteSid = `sw${t}${n.toString(36)}`;
			plan.notes.push({ sid: noteSid, parentSid: sid, content: text.wasDoing });
			noteSids.push(noteSid);
		}
		plan.expected.push({
			sid,
			status,
			humanCreated: task.protected,
			locked: byPerson,
			claimed: open && status === "doing",
			content: canonical?.content ?? null,
			noteSids,
		});
	});
	return plan;
}

/**
 * What every short id of a file's import starts with after its two letters (`sp…` its pages,
 * `sb…` their blocks): the import tells its blocks of the current revision from an earlier one's.
 */
export function specFileTag(narratorId: string, path: string, revisionId: string): string {
	return tag([narratorId, path, revisionId], 12);
}

/** The file tag of one of the import's page or block short ids. */
export function fileTagOfSid(sid: string): string {
	return sid.slice(2, 14);
}

/** A converted block (`convertNotes`). */
export interface SpecImportBlock {
	content: string;
	links: ExtractedLink[];
	children: SpecImportBlock[];
}

export interface SpecImportPagePlan {
	path: string;
	/** Pages first, each followed by its blocks, parents before children. */
	nodes: SpecImportNode[];
	pageSids: string[];
	blocks: number;
}

/**
 * The pages a file becomes. `pageSid` overrides the first page's short id (`index.md`: the page
 * the compatibility layer writes).
 */
export function planSpecFile(args: {
	narratorId: string;
	path: string;
	revisionId: string;
	blocks: readonly SpecImportBlock[];
	locale: Locale;
	pageSid?: string;
	pageBlocks?: number;
}): SpecImportPagePlan {
	const t = specFileTag(args.narratorId, args.path, args.revisionId);
	const limit = args.pageBlocks ?? SPEC_IMPORT_PLAN_LIMITS.pageBlocks;
	// Depth first, each block with its ancestors' short ids.
	const flat: Array<{ sid: string; ancestors: string[]; block: SpecImportBlock }> = [];
	const walk = (blocks: readonly SpecImportBlock[], ancestors: string[]) => {
		for (const block of blocks) {
			const sid = `sb${t}${flat.length.toString(36)}`;
			flat.push({ sid, ancestors, block });
			walk(block.children, [...ancestors, sid]);
		}
	};
	walk(args.blocks, []);
	const parts = Math.max(1, Math.ceil(flat.length / limit));
	const text = SPEC_IMPORT_TEXT[args.locale];
	const nodes: SpecImportNode[] = [];
	const pageSids: string[] = [];
	for (let part = 0; part < parts; part++) {
		const pageSid = part === 0 ? (args.pageSid ?? `sp${t}`) : `sp${t}p${part.toString(36)}`;
		pageSids.push(pageSid);
		nodes.push({
			sid: pageSid,
			parentSid: null,
			content: parts === 1 ? args.path : text.part(args.path, part + 1, parts),
		});
		const slice = flat.slice(part * limit, (part + 1) * limit);
		const here = new Set(slice.map((entry) => entry.sid));
		for (const entry of slice) {
			// The nearest ancestor on this part; the page when they all stayed on an earlier one.
			const parent = [...entry.ancestors].reverse().find((sid) => here.has(sid)) ?? pageSid;
			nodes.push({
				sid: entry.sid,
				parentSid: parent,
				content: entry.block.content,
				links: entry.block.links,
			});
		}
	}
	return { path: args.path, nodes, pageSids, blocks: flat.length };
}

/** A file that is not markdown becomes code blocks in this language (its extension). */
export function specFileCodeLang(path: string): string | null {
	if (/\.(md|markdown)$/i.test(path)) return null;
	const ext = /\.([A-Za-z0-9]{1,12})$/.exec(path)?.[1]?.toLowerCase();
	return ext ?? "text";
}
