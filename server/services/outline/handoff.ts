/**
 * The handoff written under a task of a project space when the session doing it gives it back
 * unfinished (outline P2 PR 10c-2; PR 10 design v2 §C, owner decision D54): the task goes back to
 * do, and the next session opened for it continues from this block.
 *
 * WHO WRITES IT
 * -------------
 * Both ways a session's unfinished project task goes back to do write the same block, in the same
 * commit that reopens the task:
 *   - the end of a run (`release.ts`): a system commit of {@link OUTLINE_HANDOFF_ACTOR};
 *   - the lease expiry job (`tasks.ts`), when a lease runs out (the hour a session keeps a task
 *     after a person's turn, or a server that stopped): reason `lease`.
 * So whichever way a task came back, the next session reads the same shape in the same place.
 *
 * WHAT IT SAYS
 * ------------
 * The model is asked to write its own handoff under the task before it ends (the opening brief
 * and the outline rules say so); no extra request is made for it. The system's block is written
 * every time and holds what the system knows:
 *
 *   - Handoff (generation 3 · session `id` "title" · 2026-11-11 08:12 UTC): not finished; back to do
 *     - The session's notes: [[key/sid|first line]], …   (the newest blocks it wrote under the task
 *       while it held it, tasks and questions aside, at most `notes`)
 *     - Steps: 2 of 5 done
 *     - Working directory: `.worktrees/fix`             (only when it is inside the project's
 *       directory and not that directory itself)
 *     - The session's last reply (excerpt): …           (see below)
 *
 * In the language of the session's owner, like a subagent's report block.
 *
 * ONE PER CLAIM GENERATION
 * The block's id is derived from (task, claim generation) ({@link handoffBlockId}): a release is
 * one atomic commit with the reopening, and a generation is released once, so a retry writes no
 * second block. Releasing does not change the generation; the next claim takes the next one.
 *
 * SEVERAL TASKS OF ONE TREE
 * A session that holds a task and steps under it gives all of them back; the handoff is written
 * once, under the topmost.
 *
 * WHAT IT MAY SHOW (the block is read by everyone who reads the project space)
 *   - the session's id, and its title unless the session is private (the board names a session
 *     only to its readers);
 *   - links to blocks under the task itself, which are in the same space;
 *   - a directory only as a path inside the project's own directory;
 *   - the session's last reply only under the task the run was started for (the caller says
 *     which), with no note written, AND only for a session the readers of THIS project's space
 *     read: a public one, or a `project`-visible one whose own project is this one. A private
 *     session's words, or those of another project's session, are never copied here.
 *
 * COST
 * One page-structure read per task detailed (at most {@link OUTLINE_HANDOFF_LIMITS.detailed} per
 * call; the rest get the head line only), the session's latest writes in the space (one bounded
 * read per session and space), the heads of at most `notes` blocks, and the sessions' rows by
 * primary key. No subprocess, no full content.
 */
import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { logger } from "@server/lib/logger";
import { blockTitle, type Inline, serializeBody } from "@shared/outline";
import { resolveNarratorProjectId } from "../narrator-project";
import { type NarratorHandoffRow, readNarratorHandoffRows, readProjectDir } from "./access-reads";
import { assigneeNamesSession } from "./assignee";
import { type DelegationLocale, delegationLocale } from "./delegation-text";
import { OUTLINE_CHANGE } from "./model";
import { readSubtree } from "./read";
import type {
	OutlineBlockMeta,
	OutlineSpaceRow,
	OutlineStore,
	OutlineTaskClaimRow,
} from "./store/port";
import type { OutlineNarratorWrite } from "./store/read-port";
import { type OutlineNode, subtreeNodes } from "./tree";
import type { OutlineOp } from "./write";

/** The system actor of the commit that gives a session's unfinished task back at a run's end. */
export const OUTLINE_HANDOFF_ACTOR = "outline-handoff";

export const OUTLINE_HANDOFF_LIMITS = {
	/** Notes of the session a handoff links to, newest first. */
	notes: 3,
	/** The session's latest commits and versions in the space read for them. */
	noteCommits: 50,
	noteVersions: 200,
	/** UTF-8 bytes of the excerpt of the session's last reply. */
	replyBytes: 1536,
	/** Characters of a title or a note's first line. */
	titleChars: 80,
	/** Tasks one call writes a detailed handoff for; the rest get the head line only. */
	detailed: 20,
	/** Claim generations of a task whose handoffs are counted (the board's mark, the brief). */
	counted: 20,
} as const;

/** Ids of handoff blocks start with this, then a hash of (task, claim generation). */
const HANDOFF_ID_PREFIX = "hndf";

/** The handoff block of a task's claim generation: the same on every retry. */
export function handoffBlockId(taskBlockId: string, epoch: number): string {
	const hash = createHash("sha256").update(`${taskBlockId}\u0000${epoch}`).digest("base64url");
	return `${HANDOFF_ID_PREFIX}${hash.slice(0, 28)}`;
}

/** Whether a block is a handoff ({@link handoffBlockId}). */
export function isHandoffBlockId(id: string): boolean {
	return id.length === HANDOFF_ID_PREFIX.length + 28 && id.startsWith(HANDOFF_ID_PREFIX);
}

/**
 * The handoff blocks a task may have, newest generation first: one id per claim generation up to
 * `epoch`, at most {@link OUTLINE_HANDOFF_LIMITS.counted} (primary keys to look up; which of them
 * exist is the caller's read).
 */
export function handoffBlockIdsOf(taskBlockId: string, epoch: number): string[] {
	const out: string[] = [];
	for (let e = epoch; e >= 1 && out.length < OUTLINE_HANDOFF_LIMITS.counted; e--)
		out.push(handoffBlockId(taskBlockId, e));
	return out;
}

/** Why a task went back: the run ended with it unfinished, or the session's lease ran out. */
export type OutlineHandoffReason = "unfinished" | "lease";

/** What people read under the task (in the language of the session's owner). */
export const HANDOFF_BLOCK_TEXT: Record<
	DelegationLocale,
	{
		/** Before the session id (written as code). */
		lead: (epoch: number) => string;
		/** After the session id. */
		tail: (title: string | null, at: string, reason: OutlineHandoffReason, bare: boolean) => string;
		notes: string;
		noteSeparator: string;
		steps: (done: number, total: number) => string;
		/** Before the directory (written as code). */
		directory: string;
		reply: string;
	}
> = {
	en: {
		lead: (epoch) => `Handoff (generation ${epoch} · session `,
		tail: (title, at, reason, bare) =>
			`${title ? ` "${title}"` : ""} · ${at}): ${
				reason === "lease"
					? "the session's lease ran out; back to do"
					: bare
						? "no progress recorded; back to do"
						: "not finished; back to do"
			}`,
		notes: "The session's notes: ",
		noteSeparator: ", ",
		steps: (done, total) => `Steps: ${done} of ${total} done`,
		directory: "Working directory: ",
		reply: "The session's last reply (excerpt): ",
	},
	"zh-CN": {
		lead: (epoch) => `交接（第 ${epoch} 代 · 会话 `,
		tail: (title, at, reason, bare) =>
			`${title ? ` 「${title}」` : ""} · ${at}）：${
				reason === "lease"
					? "会话的租约到期，已放回待办"
					: bare
						? "没有进展，已放回待办"
						: "没做完，已放回待办"
			}`,
		notes: "会话的记录：",
		noteSeparator: "、",
		steps: (done, total) => `步骤：${total} 个里完成 ${done} 个`,
		directory: "工作目录：",
		reply: "会话最后的回复（节选）：",
	},
};

/** `2026-11-11 08:12 UTC`. */
export function handoffTime(at: Date): string {
	return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function clipChars(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Text cut to at most `max` UTF-8 bytes, whitespace collapsed, marked when cut. */
function clipBytes(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (Buffer.byteLength(flat, "utf8") <= max) return flat;
	let out = "";
	let bytes = 3;
	for (const ch of flat) {
		const size = Buffer.byteLength(ch, "utf8");
		if (bytes + size > max) break;
		out += ch;
		bytes += size;
	}
	return `${out}…`;
}

const plain = (text: string): Inline => ({ type: "text", text, marks: [] });
const code = (text: string): Inline => ({ type: "text", text, marks: [{ type: "code" }] });
const paragraph = (content: Inline[]) => serializeBody({ type: "paragraph", content });

/** What one handoff says; rendered by {@link handoffOps}. */
export interface OutlineHandoffContent {
	taskBlockId: string;
	epoch: number;
	narratorId: string;
	title: string | null;
	at: Date;
	reason: OutlineHandoffReason;
	locale: DelegationLocale;
	/** The session's notes under the task, newest first: `key/sid` and the first line. */
	notes: Array<{ address: string; title: string }>;
	/** Tasks under the task: how many, and how many of them are done. Null: not counted. */
	steps: { done: number; total: number } | null;
	/** The session's directory inside the project's (a relative path), or null. */
	directory: string | null;
	/** The session's last reply, when it may be shown. */
	reply: string | null;
}

/** The operations that write a handoff under its task: the block and its lines. Pure. */
export function handoffOps(content: OutlineHandoffContent): OutlineOp[] {
	const text = HANDOFF_BLOCK_TEXT[content.locale];
	const id = handoffBlockId(content.taskBlockId, content.epoch);
	const lines: string[] = [];
	if (content.notes.length > 0) {
		const parts: Inline[] = [plain(text.notes)];
		content.notes.forEach((note, index) => {
			if (index > 0) parts.push(plain(text.noteSeparator));
			const label = clipChars(note.title, OUTLINE_HANDOFF_LIMITS.titleChars)
				.replace(/\[/g, "(")
				.replace(/\]/g, ")")
				.replace(/\|/g, "/");
			parts.push({ type: "mention", ref: note.address, label: label || null, marks: [] });
		});
		lines.push(paragraph(parts));
	}
	const reply = content.reply ? clipBytes(content.reply, OUTLINE_HANDOFF_LIMITS.replyBytes) : "";
	const showReply = reply !== "" && content.notes.length === 0;
	// Nothing recorded, no step done, nothing said: the head line says so, and no "0 of N" line.
	const bare = content.notes.length === 0 && !showReply && (content.steps?.done ?? 0) === 0;
	if (!bare && content.steps && content.steps.total > 0)
		lines.push(paragraph([plain(text.steps(content.steps.done, content.steps.total))]));
	if (content.directory) lines.push(paragraph([plain(text.directory), code(content.directory)]));
	if (showReply) lines.push(paragraph([plain(text.reply), plain(reply)]));
	const title = content.title ? clipChars(content.title, OUTLINE_HANDOFF_LIMITS.titleChars) : null;
	return [
		{
			op: "insert",
			id,
			parent: { id: content.taskBlockId },
			position: { last: true },
			content: paragraph([
				plain(text.lead(content.epoch)),
				code(content.narratorId),
				plain(text.tail(title, handoffTime(content.at), content.reason, bare)),
			]),
		},
		...lines.map(
			(line): OutlineOp => ({
				op: "insert",
				parent: { id },
				position: { last: true },
				content: line,
			}),
		),
	];
}

/** A task being given back, as the release and the expiry job name it. */
export interface OutlineHandoffSubject {
	claim: OutlineTaskClaimRow;
	space: OutlineSpaceRow;
}

export interface OutlineHandoffPlan {
	/** The handoff's operations; none for a task under another task given back with it. */
	ops: OutlineOp[];
	/** The task was assigned by name to the session giving it back: the assignment goes too. */
	clearAssignee: boolean;
	/** The session wrote notes under the task (diagnostics: how often the model does). */
	noted: boolean;
}

/**
 * The directory of the session that last held a task, when the next session may be opened in it
 * (the board's "continue in the previous session's directory"): only a directory inside the
 * project's own (and not that directory itself), which is all a handoff ever shows of it. Whether
 * it still exists is the caller's check. Two reads by primary key.
 */
export async function previousSessionDirectory(
	store: OutlineStore,
	claim: OutlineTaskClaimRow | null | undefined,
	projectDir: string | null,
): Promise<{ path: string; relative: string } | null> {
	const holder = claim?.lastHolderNarratorId;
	if (!holder || !projectDir) return null;
	const root = (await store.getNarratorRoots([holder])).get(holder)?.root ?? holder;
	const session = (await readNarratorHandoffRows([root])).get(root);
	const rel = directoryInProject(session?.cwd ?? null, projectDir);
	return rel && session?.cwd ? { path: session.cwd, relative: rel } : null;
}

/** A session's directory as a path inside the project's directory, or null. */
export function directoryInProject(cwd: string | null, projectDir: string | null): string | null {
	if (!cwd || !projectDir || !isAbsolute(cwd) || !isAbsolute(projectDir)) return null;
	const rel = relative(projectDir, cwd).replace(/\\/g, "/");
	if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return null;
	return rel;
}

/**
 * The blocks above the given ones, read by primary key level by level into `known` (at most
 * `depth` levels): what tells which held tasks are above one another.
 */
export async function loadOutlineAncestors(
	store: OutlineStore,
	known: Map<string, OutlineBlockMeta>,
	depth = 64,
): Promise<void> {
	for (let level = 0; level < depth; level++) {
		const missing = new Set<string>();
		for (const block of known.values())
			if (block.parentId !== null && !known.has(block.parentId)) missing.add(block.parentId);
		if (missing.size === 0) return;
		const found = await store.getBlockMetasByIds([...missing]);
		if (found.length === 0) return;
		for (const meta of found) known.set(meta.id, meta);
	}
}

/** The ids above a block, nearest first, as far as `known` holds them. */
export function outlineAncestorIds(
	known: ReadonlyMap<string, OutlineBlockMeta>,
	id: string,
): string[] {
	const out: string[] = [];
	let current = known.get(id);
	current = current?.parentId ? known.get(current.parentId) : undefined;
	while (current && out.length <= 1000) {
		out.push(current.id);
		current = current.parentId === null ? undefined : known.get(current.parentId);
	}
	return out;
}

/**
 * Plan the handoffs of tasks of project spaces being given back (see the module header): for
 * each, the operations to write with its reopening. A task under another one the same session
 * gives back gets none: one handoff per tree, under its top (decided from the blocks above each
 * task, whatever the number of tasks). `reply` is the session's last reply, for the one task the
 * run was started for (`replyTaskId`); it is shown only for a session the readers of that
 * project's space can read. A task that cannot be read gets no plan (the caller reopens it bare).
 */
export async function planOutlineHandoffs(
	store: OutlineStore,
	subjects: readonly OutlineHandoffSubject[],
	options: {
		reason: OutlineHandoffReason;
		at: Date;
		reply?: string | null;
		/** The task the run was started for: the only one the reply is quoted under. */
		replyTaskId?: string | null;
	},
): Promise<Map<string, OutlineHandoffPlan>> {
	const out = new Map<string, OutlineHandoffPlan>();
	const project = subjects.filter(
		(s) => s.space.kind === "project" && s.claim.holderNarratorId !== null,
	);
	if (project.length === 0) return out;
	const holders = [...new Set(project.map((s) => s.claim.holderNarratorId as string))];
	const roots = await store.getNarratorRoots(holders);
	const rootOf = (holder: string) => roots.get(holder)?.root ?? holder;
	const sessions = await readNarratorHandoffRows(holders.map(rootOf)).catch(
		() => new Map<string, NarratorHandoffRow>(),
	);
	const locales = new Map<string, DelegationLocale>();
	const projectDirs = new Map<string, string | null>();
	const mainProjects = new Map<string, string | null>();
	const writes = new Map<string, OutlineNarratorWrite[]>();
	const given = new Map(
		project.map((s) => [s.claim.taskBlockId, rootOf(s.claim.holderNarratorId as string)]),
	);
	// Which tasks are under another one given back: from the blocks above each (primary keys).
	const known = new Map<string, OutlineBlockMeta>();
	for (const meta of await store.getBlockMetasByIds([...given.keys()])) known.set(meta.id, meta);
	await loadOutlineAncestors(store, known);

	let detailed = 0;
	for (const subject of project) {
		const { claim, space } = subject;
		const holder = claim.holderNarratorId as string;
		const root = rootOf(holder);
		const session = sessions.get(root) ?? null;
		try {
			const assignee = known.get(claim.taskBlockId)?.taskJson?.assignee ?? null;
			// By id or by handle (`assignee.ts`): the session giving the task back, or its subagent.
			const clearAssignee =
				assignee?.startsWith("agent:") === true &&
				(await assigneeNamesSession(assignee, holder, store).catch(
					() => assignee === `agent:${holder}` || assignee === `agent:${root}`,
				));
			// Under another task the same session gives back: that one carries the handoff.
			if (outlineAncestorIds(known, claim.taskBlockId).some((id) => given.get(id) === root)) {
				out.set(claim.taskBlockId, { ops: [], clearAssignee, noted: false });
				continue;
			}
			const subtree =
				detailed < OUTLINE_HANDOFF_LIMITS.detailed
					? await readSubtree(claim.taskBlockId, { store })
					: null;
			if (subtree) detailed++;
			let locale = session?.ownerUserId ? locales.get(session.ownerUserId) : undefined;
			if (!locale) {
				locale = "en";
				if (session?.ownerUserId) {
					const { getUserLanguage } = await import("@server/lib/i18n");
					locale = delegationLocale(await getUserLanguage(session.ownerUserId).catch(() => "en"));
					locales.set(session.ownerUserId, locale);
				}
			}
			const under = subtree ? subtreeNodes(subtree.root).slice(1) : [];
			const steps = under.filter((node) => node.task && node.task.status !== "cancelled");
			const notes = subtree
				? await sessionNotes(store, space, [...new Set([holder, root])], claim, under, writes)
				: [];
			let directory: string | null = null;
			if (session?.cwd && space.projectId) {
				if (!projectDirs.has(space.projectId))
					projectDirs.set(space.projectId, await readProjectDir(space.projectId).catch(() => null));
				directory = directoryInProject(session.cwd, projectDirs.get(space.projectId) ?? null);
			}
			// Whose words may be copied into this project's space: a public session's, or those of a
			// session of this very project that the project reads. A session of another project is
			// read by that project's people, not this one's.
			let readable = session?.visibility === "public";
			if (session?.visibility === "project") {
				if (!mainProjects.has(root))
					mainProjects.set(
						root,
						await resolveNarratorProjectId({
							id: root,
							contextProjectId: session.contextProjectId,
						}).catch(() => null),
					);
				readable = space.projectId !== null && mainProjects.get(root) === space.projectId;
			}
			const reply =
				readable && options.replyTaskId === claim.taskBlockId && options.reply?.trim()
					? options.reply
					: null;
			out.set(claim.taskBlockId, {
				clearAssignee,
				noted: notes.length > 0,
				ops: handoffOps({
					taskBlockId: claim.taskBlockId,
					epoch: claim.epoch,
					narratorId: root,
					// A private session's title is its own (the board names it only to its readers).
					title: session && session.visibility !== "private" ? session.title : null,
					at: options.at,
					reason: options.reason,
					locale,
					notes,
					steps: subtree
						? {
								total: steps.length,
								done: steps.filter((node) => node.task?.status === "done").length,
							}
						: null,
					directory,
					reply,
				}),
			});
		} catch (error) {
			// The task is still given back; the caller writes its plain note instead.
			logger.warn("Outline handoff could not be put together", {
				taskBlockId: claim.taskBlockId,
				error: String(error),
			});
		}
	}
	return out;
}

/**
 * The newest blocks the session wrote under the task since it claimed it (tasks, questions,
 * reports and handoffs aside), with their first lines.
 */
async function sessionNotes(
	store: OutlineStore,
	space: OutlineSpaceRow,
	narratorIds: readonly string[],
	claim: OutlineTaskClaimRow,
	under: readonly OutlineNode[],
	cache: Map<string, OutlineNarratorWrite[]>,
): Promise<OutlineHandoffContent["notes"]> {
	const limits = OUTLINE_HANDOFF_LIMITS;
	const all: OutlineNarratorWrite[] = [];
	for (const narratorId of narratorIds) {
		const key = `${space.id}\u0000${narratorId}`;
		let rows = cache.get(key);
		if (!rows) {
			rows = await store.listNarratorWrites(space.id, narratorId, {
				commits: limits.noteCommits,
				limit: limits.noteVersions,
			});
			cache.set(key, rows);
		}
		all.push(...rows);
	}
	const nodes = new Map(under.map((node) => [node.id, node]));
	const since = Date.parse(claim.claimedAt);
	const newest: string[] = [];
	for (const row of [...all].sort(
		(a, b) => b.seq - a.seq || (a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0),
	)) {
		if (newest.length >= limits.notes * 4) break;
		if ((row.changeFlags & (OUTLINE_CHANGE.CREATE | OUTLINE_CHANGE.CONTENT)) === 0) continue;
		if (!Number.isNaN(since) && Date.parse(row.createdAt) < since) continue;
		const node = nodes.get(row.blockId);
		if (!node || node.task || node.ask || isHandoffBlockId(node.id)) continue;
		if (!newest.includes(row.blockId)) newest.push(row.blockId);
	}
	if (newest.length === 0) return [];
	const heads = new Map(
		(await store.getBlockHeads(newest)).map((head) => [head.id, blockTitle(head.contentHead)]),
	);
	const out: OutlineHandoffContent["notes"] = [];
	for (const id of newest) {
		if (out.length >= limits.notes) break;
		const title = (heads.get(id) ?? "").trim();
		if (!title) continue;
		out.push({ address: `${space.key}/${(nodes.get(id) as OutlineNode).sid}`, title });
	}
	return out;
}
