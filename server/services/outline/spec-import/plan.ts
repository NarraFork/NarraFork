/**
 * What an import of a session's Dynamic Spec writes (outline P2 PR 12b; PR 12 design §2.3, owner
 * decisions D52 and D54): pure functions from the spec state as read to the blocks to write, each
 * with a short id that follows from its source. No database access.
 *
 * TASKS (`tasks.json`, in array order, into the session's task list: the block `session/tasks`)
 *
 *   | spec                         | live session                 | archived session            |
 *   |------------------------------|------------------------------|-----------------------------|
 *   | todo                         | to do                        | to do                       |
 *   | doing                        | in progress (the session's   | to do, with a note that it  |
 *   |                              | claim, made when it moves)   | was in progress (D54)       |
 *   | done                         | done                         | done                        |
 *   | blocked                      | in progress, a 受阻 note     | to do, a 受阻 note          |
 *   |                              | under it; no question (D52)  |                             |
 *
 * The blocked note is the mark plugins write and read (`pluginBlockedNoteSid`), so a plugin still
 * reads `blocked` for the task through the old commands (12a) and takes the mark away by setting
 * a status.
 *
 * What is in progress in a live session is written TO DO and started only as part of the move
 * (`start`, `importer.ts`): until the session is an outline session nothing it holds is claimed,
 * so an import that fails or is abandoned holds no task, and no lease runs out under it.
 *
 * `protected` ⇔ created by a person (`humanCreated`), whoever protected it. A task a PERSON
 * protected (the revision its lock was made in was the person's: the Spec panel, `/goal`) is
 * locked, by the session's owner (D52), and so is one whose protector is not known (owner
 * decision: treated as a person's, the safe side); one an agent or a plugin protected is not. A
 * session without an owner has nobody to lock for.
 *
 * NOTES (every other file)
 *
 * One top-level block per file, titled with its path, its converted text under it however large
 * (pageless outline, A3: the importer writes it in as many bounded commits as it needs);
 * `index.md` is the block 12a's compatibility layer writes (`specIndexSid`), so a plugin's later
 * `spec_write` replaces it instead of adding a second one. A level of more than
 * {@link SPEC_IMPORT_PLAN_LIMITS.childrenPerBlock} blocks is grouped under blocks of that many
 * (`name (2/3)`), so every level the import writes stays one a person can edit in place.
 *
 * SHORT IDS
 *
 * Tasks follow from (session, `tasks.json` revision, index); a file's block and what is under it from
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
	/**
	 * Children of one block the import writes at most; more are grouped under blocks of this
	 * many (D58: a level of more than 2,000 children is read-only in place).
	 */
	childrenPerBlock: 2000,
} as const;

/** The system actor of the import's commits. */
export const OUTLINE_SPEC_IMPORT_ACTOR = "spec-import";

/**
 * The system actor of an administrator's move back to Dynamic Spec (outline P2 PR 12b2): its
 * marker blocks at the top of the task list and of the behavior boundary. The import counts them
 * as its own content.
 */
export const OUTLINE_SPEC_REVERT_ACTOR = "spec-import-revert";

/**
 * The system actor of the swallowed-content scan's writes (outline P2 PR 12c, `loss-attach.ts`):
 * possibly lost content attached to its file's imported block, by a pass (tables) or because a
 * person asked, and the removal of such a block when its finding is dismissed. The importer
 * counts its commits as the import's own (`IMPORT_ACTORS`): the content is kept in its finding,
 * so a stale imported block it sits under is still the import's to take away.
 */
export const OUTLINE_SPEC_LOSS_ACTOR = "spec-import-check";

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
		summaryTasksBlock: string;
		summaryStart: (n: number) => string;
		summaryGiveBack: (n: number) => string;
		/** 12b2: an administrator's move back to Dynamic Spec, and its markers. */
		summaryRevert: string;
		summaryRevertNotesRemoved: string;
		revertNote: (day: string, where: "tasks" | "behavior") => string;
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
		summaryTasksBlock: "Task list for the import from Dynamic Spec",
		summaryStart: (n) =>
			`Moved from Dynamic Spec: ${n} task${n === 1 ? "" : "s"} in progress, started again by the session`,
		summaryGiveBack: (n) =>
			`The import from Dynamic Spec did not finish: ${n} task${n === 1 ? "" : "s"} back to do`,
		summaryRevert: "An administrator moved this session back to Dynamic Spec",
		summaryRevertNotesRemoved: "The session is in the outline again: the move-back notes removed",
		revertNote: (day, where) =>
			`On ${day} an administrator moved this session back to Dynamic Spec: the session no longer reads its ${where === "tasks" ? "tasks" : "behavior boundary"} here. What is here was kept, nothing was deleted; changes made here from now on do not reach Dynamic Spec.`,
	},
	"zh-CN": {
		blocked: "受阻（导入前在 Dynamic Spec 里的状态）",
		wasDoing: "导入前在 Dynamic Spec 里是进行中；会话已归档，所以回到待办",
		part: (title, n, of) => `${title}（${n}/${of}）`,
		continued: "（续）",
		summaryTasks: (n) => `从 Dynamic Spec 导入：${n} 个任务`,
		summaryNotes: (path) => `从 Dynamic Spec 导入：${path}`,
		summaryStale: "清掉上一次没做完的 Dynamic Spec 导入写下的内容",
		summaryTasksBlock: "Dynamic Spec 导入用的任务清单",
		summaryStart: (n) => `从 Dynamic Spec 切换过来：${n} 个进行中的任务由会话重新开始`,
		summaryGiveBack: (n) => `Dynamic Spec 导入没有完成：${n} 个任务退回待办`,
		summaryRevert: "管理员把这个会话退回了 Dynamic Spec",
		summaryRevertNotesRemoved: "会话又回到大纲：删掉退回时留下的说明",
		revertNote: (day, where) =>
			`${day} 管理员把这个会话退回了 Dynamic Spec：会话不再读这里的${where === "tasks" ? "任务" : "行为边界"}。这里的内容都保留了，没有删除；之后在这里的改动不会回到 Dynamic Spec。`,
	},
};

function tag(parts: readonly string[], length: number): string {
	return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, length);
}

/** Longer than the 8 characters a drawn short id has, so none collides with one. */
const IMPORT_SID_RE = /^s[tpbw][0-9a-f]{10,12}[0-9a-z]*$/;

/** A short id the import gave (a task, a file's block, a block under it, a note under a task). */
export function isImportSid(sid: string): boolean {
	return sid.length >= 12 && IMPORT_SID_RE.test(sid);
}

/** One block the import writes. */
export interface SpecImportNode {
	sid: string;
	/** Its parent's short id; null: the group's root (the task list, or the top level). */
	parentSid: string | null;
	/** A block id chosen by the import (tasks: their blocked note's short id follows from it). */
	id?: string;
	content: string;
	/** Canonical content from the text worker; absent: the write path normalizes (small text). */
	links?: ExtractedLink[];
	task?: OutlineTaskInput;
	/** A task written to do that the move starts: in progress already is not a drift. */
	start?: boolean;
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
	/** The tasks, in order, to go last in the task list. */
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
	/** Its checkbox until the move (a task to start reads to do, or in progress by the session). */
	status: TaskStatus;
	humanCreated: boolean;
	locked: boolean;
	/** Started by the move: in progress and claimed by the session from then on. */
	start: boolean;
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
		// In progress (doing, blocked) in a live session: to do until the move starts it.
		const start = !args.archived && (task.status === "doing" || task.status === "blocked");
		const status: TaskStatus = task.status === "done" ? "done" : "todo";
		const protector = args.protectors[n];
		const byPerson =
			task.protected &&
			(protector === "user" || protector === "unknown" || protector === null) &&
			args.ownerUserId !== null;
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
			...(start ? { start: true } : {}),
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
			start,
			content: canonical?.content ?? null,
			noteSids,
		});
	});
	return plan;
}

/**
 * What every short id of a file's import starts with after its two letters (`sp…` its block and
 * the groups under it, `sb…` the blocks of its text): the import tells its blocks of the current
 * revision from an earlier one's.
 */
export function specFileTag(narratorId: string, path: string, revisionId: string): string {
	return tag([narratorId, path, revisionId], 12);
}

/** The file tag of one of the short ids of a file's import. */
export function fileTagOfSid(sid: string): string {
	return sid.slice(2, 14);
}

/** A converted block (`convertNotes`). */
export interface SpecImportBlock {
	content: string;
	links: ExtractedLink[];
	children: SpecImportBlock[];
}

export interface SpecImportFilePlan {
	path: string;
	/** The file's block first, then what is under it, parents before children. */
	nodes: SpecImportNode[];
	/** The short id of the file's block. */
	rootSid: string;
	/** Blocks of the file's text (the file's block and groups not counted). */
	blocks: number;
}

/**
 * The short id of the group `n` (from 0) of the children of the block at `parentIndex` of the
 * file's text (-1: the file's block): fixed widths, so no two groups, and no group and the
 * file's block, share one.
 */
function groupSid(t: string, parentIndex: number, n: number): string {
	const parent = parentIndex < 0 ? "zzzz" : parentIndex.toString(36).padStart(4, "0");
	return `sp${t}g${parent}${n.toString(36).padStart(3, "0")}`;
}

/**
 * The blocks a file becomes: one block titled with its path and its text under it. `rootSid`
 * overrides the file block's short id (`index.md`: the block the compatibility layer writes). A
 * level of more than `childrenPerBlock` blocks is grouped (see the module header).
 */
export function planSpecFile(args: {
	narratorId: string;
	path: string;
	revisionId: string;
	blocks: readonly SpecImportBlock[];
	locale: Locale;
	rootSid?: string;
	childrenPerBlock?: number;
}): SpecImportFilePlan {
	const t = specFileTag(args.narratorId, args.path, args.revisionId);
	const width = Math.max(2, args.childrenPerBlock ?? SPEC_IMPORT_PLAN_LIMITS.childrenPerBlock);
	const text = SPEC_IMPORT_TEXT[args.locale];
	const rootSid = args.rootSid ?? `sp${t}`;
	const nodes: SpecImportNode[] = [{ sid: rootSid, parentSid: null, content: args.path }];
	let count = 0;
	// Depth first, without recursion (a converted text may be deep): each block numbered in that
	// order, as before pages went (an import cut short goes on with the same short ids), its
	// group, when its level is grouped, written just before the group's first block.
	const stack: Array<{
		blocks: readonly SpecImportBlock[];
		parentSid: string;
		parentIndex: number;
		at: number;
	}> = [{ blocks: args.blocks, parentSid: rootSid, parentIndex: -1, at: 0 }];
	while (stack.length > 0) {
		const frame = stack[stack.length - 1] as (typeof stack)[number];
		const block = frame.blocks[frame.at];
		if (!block) {
			stack.pop();
			continue;
		}
		const groups = frame.blocks.length > width ? Math.ceil(frame.blocks.length / width) : 0;
		let parentSid = frame.parentSid;
		if (groups > 0) {
			const g = Math.floor(frame.at / width);
			parentSid = groupSid(t, frame.parentIndex, g);
			if (frame.at % width === 0)
				nodes.push({
					sid: parentSid,
					parentSid: frame.parentSid,
					content: text.part(args.path, g + 1, groups),
				});
		}
		frame.at++;
		const index = count++;
		const sid = `sb${t}${index.toString(36)}`;
		nodes.push({ sid, parentSid, content: block.content, links: block.links });
		if (block.children.length > 0)
			stack.push({ blocks: block.children, parentSid: sid, parentIndex: index, at: 0 });
	}
	return { path: args.path, nodes, rootSid, blocks: count };
}
/** A file that is not markdown becomes code blocks in this language (its extension). */
export function specFileCodeLang(path: string): string | null {
	if (/\.(md|markdown)$/i.test(path)) return null;
	const ext = /\.([A-Za-z0-9]{1,12})$/.exec(path)?.[1]?.toLowerCase();
	return ext ?? "text";
}
