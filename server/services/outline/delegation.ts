/**
 * Delegation as a task (outline P2 PR 9a; design §2.5, §4.4, §4.5): `Agent({ task })` hands an
 * outline task to a subagent, the subagent's instructions are written from the task's tree, and
 * every result it hands back is attached under the task as a report, marked late when the task
 * is no longer the one it was sent with.
 *
 * ONLY OUTLINE ROOT SESSIONS
 * --------------------------
 * `task` is taken only from a root session whose tasks live in the outline, while the outline is
 * switched on; anything else is refused before a subagent is created. A delegation without `task`
 * is what it always was: no task is created and nothing is attached (owner decision Q2).
 *
 * SENDING (`prepareOutlineDelegation`, then `delegateOutlineTask`)
 *   1. Checks, all before anything is created (the first that fails is the answer): a root outline
 *      session not in plan mode; not with `takeover_by_user`; the task found among what the
 *      session may read, a live task to do or in progress; its space writable by this turn; not in
 *      a plan that is not approved yet; not waiting (prerequisites, an unanswered question, a
 *      change waiting for confirmation); not assigned to a person; nobody else doing it (another
 *      session or a person) and no subagent of this session still running with it.
 *   2. The instructions (`renderDelegationBrief`): plain markdown, no addresses and no outline
 *      syntax, within {@link OUTLINE_DELEGATION_LIMITS.briefBytes}: the task, the goals above it,
 *      the notes, steps and questions under it (breadth first, within the budget; an earlier
 *      report shows as its title only), its prerequisites, the caller's own prompt, a closing line.
 *      The subagent needs nothing of the outline to read them.
 *   3. Once the subagent exists: its runtime registration records the task (`delegatedTask`: space,
 *      block, the claim generation, the delegating session, the Agent call, the language), then one
 *      system commit (`outline-delegate`, for the delegating session, the Agent call's provenance)
 *      sets the task in progress and hands its claim to the subagent with the next generation
 *      (`OutlineWriteOptions.delegateClaim`), written against the task's version as checked. A
 *      task changed meanwhile (finished, reopened, edited, claimed) refuses it, and the refusal
 *      says who has the task now when someone does; the subagent, which never ran, is archived by
 *      the caller. When the Agent call fails after the commit (or the run never starts),
 *      `undoOutlineDelegation` sets a task that was to do back to do, or gives it back to the
 *      session, before the subagent is archived.
 *
 * While it runs the subagent's lease keeper renews that claim; when a run ends the claim passes
 * to the root on the idle lease, generation unchanged (`lease-keeper.ts`). Archiving a delegated
 * subagent (Agent `archive`, a history rollback) gives the task back the same way first
 * (`subagent-lifecycle.ts`), so the task stays with the session (design §2.9). A subagent of the
 * session that holds the task but is not running (a server stopped before it started) does not
 * block delegating it again; one whose delegation is between its commit and the start of its run
 * counts as running (`startingDelegations`), so two agents never get the same task.
 * Continuation leaves the task, and the tasks under it, to the subagent meanwhile (`tasks.ts`).
 *
 * ATTACHING (`attachDelegatedReport`, from the run service when a result is delivered)
 * -----------------------------------------------------------------------------------
 * Each result a delegated subagent hands back (its first run, every Send continuation, a result
 * released after a takeover, a recovered run) is converted (`report-text.ts`, on the edit-text
 * worker when large) and attached as one container block under the task, last, with the report's
 * blocks under it: one system commit (`outline-report`) written for the subagent (`narratorId`),
 * its last reply (`messageId`) and the Agent call (`toolCallId`), the run's principal responsible.
 * The container's id follows from (subagent, logical run): a retry finds it and attaches nothing
 * twice. The task's status is never changed: the delegating session reads the report and decides
 * (owner decision Q1).
 *
 * LATE RESULTS (`classifyDelegatedResult`; owner decision Q4)
 * The claim is read once (and, for a finished task, the commit that finished it): the result is
 * current while the claim's generation is still the delegation's and the claim is held within the
 * delegating session (or the subagent itself ticked the task done); anything else is late: taken
 * over, delegated again, ended by someone, back to do, or gone (deleted, no longer a task: then
 * nothing is attached). A late report is attached all the same, marked late; only the delegating
 * session is told, with who holds the task and that it must not tick the task done on it. The
 * commit rests on the claim as read (`expectClaims`): a claim that moves meanwhile makes it decide
 * again (at most {@link OUTLINE_DELEGATION_LIMITS.attachAttempts} times).
 *
 * The note added to the result (`<outline_report …>`, at most about a KiB) is what the delegating
 * session reads; a failure to attach never holds the result back (the note says it was not
 * attached).
 *
 * Every read is indexed and bounded (see the limits); outline writes go through `writeOutline`,
 * behind the live-edit barrier of their space.
 */
import { createHash } from "node:crypto";
import { db } from "@server/db";
import { narrators, narratorToolCalls } from "@server/db/schema";
import { AppError, ValidationError } from "@server/lib/errors";
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import { isPlanModeTrait } from "@server/lib/narrator-utils";
import type { DelegatedTaskRegistration } from "@server/lib/validators/runtime-registration";
import { blockTitle, parseAddress, TASK_BOX, type TaskStatus } from "@shared/outline";
import {
	OUTLINE_REPORT_NOTE_HEAD_RE,
	OUTLINE_REPORT_NOTE_WINDOW,
	type OutlineReportNote,
	readOutlineReportNote,
} from "@shared/outline-report-note";
import { eq } from "drizzle-orm";
import { readDisplayNames } from "./access-reads";
import { OutlineAgentScope, type OutlineWriteRefusal } from "./agent-scope";
import {
	DELEGATION_BLOCK_TEXT,
	DELEGATION_TEXT,
	type DelegationLateReason,
	type DelegationLocale,
	type DelegationRunEnding,
} from "./delegation-text";
import { processEditText } from "./edit-text-runner";
import {
	OutlineBusyError,
	OutlineClaimChangedError,
	type OutlineClaimHolder,
	OutlineConflictError,
	OutlineTaskClaimedError,
	OutlineWriteError,
} from "./errors";
import { isOutlineEnabled } from "./feature";
import { linkTitles } from "./link-display";
import { OUTLINE_TOOL_TEXT } from "./messages";
import type { OutlineAskJson, OutlineTaskJson } from "./model";
import { loadBodies, loadBodiesWithin, readSubtree } from "./read";
import { OUTLINE_REPORT_LIMITS, type ReportBlock, type ReportConversion } from "./report-text";
import { outlineStore } from "./store";
import type { OutlineBlockRow, OutlineStore, OutlineTaskClaimRow } from "./store/port";
import { isPlanningRoot, outlineTaskStartBlocker } from "./task-json";
import {
	deriveOutlineTaskWaits,
	getOutlineTaskClaims,
	idleOutlineTaskClaims,
	isClaimLive,
} from "./tasks";
import type { OutlineNode } from "./tree";
import { type OutlineOp, writeOutline } from "./write";

/** The system actor of the commit that hands a task to a subagent. */
export const OUTLINE_DELEGATION_ACTOR = "outline-delegate";
/** The system actor of the commit that attaches a subagent's report under its task. */
export const OUTLINE_REPORT_ACTOR = "outline-report";

export const OUTLINE_DELEGATION_LIMITS = {
	/** UTF-8 bytes of the instructions written from the task tree (the caller's prompt aside). */
	briefBytes: 16 * 1024,
	/** Blocks of the task's subtree the instructions consider. */
	subtreeBlocks: 2000,
	/** Titles of the goals above the task, nearest last. */
	goals: 8,
	/** Prerequisites listed (and resolved). */
	prerequisites: 20,
	/** Characters of a title or a name in the note. */
	titleChars: 80,
	/** Decisions an attachment makes before giving up (a claim moving each time). */
	attachAttempts: 3,
	/** Blocks of an existing report counted for the note. */
	reportBlocksCounted: OUTLINE_REPORT_LIMITS.maxBlocks + 1,
} as const;

/** Ids of report containers start with this, then a hash of (subagent, logical run). */
const REPORT_ID_PREFIX = "dlrp";

/** The container block of a subagent's report for one logical run: the same on every retry. */
export function reportBlockId(subagentId: string, logicalRunId: string): string {
	const hash = createHash("sha256")
		.update(`${subagentId}\u0000${logicalRunId}`)
		.digest("base64url");
	return `${REPORT_ID_PREFIX}${hash.slice(0, 28)}`;
}

/** Whether a block is a report container (`reportBlockId`). */
export function isReportBlockId(id: string): boolean {
	return id.length === REPORT_ID_PREFIX.length + 28 && id.startsWith(REPORT_ID_PREFIX);
}

/** A refusal of `Agent({ task })`, or of the delegation's commit: the message is the agent's. */
export class OutlineDelegationError extends ValidationError {
	constructor(reason: string) {
		super(DELEGATION_TEXT.refused(reason), "OUTLINE_DELEGATION_REFUSED");
		this.name = "OutlineDelegationError";
	}
}

export function clip(text: string, max: number = OUTLINE_DELEGATION_LIMITS.titleChars): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const chars = Array.from(flat);
	return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

/** A link to a block as the note writes it: `[[key/sid|Title]]`. */
function linkTo(address: string, title: string): string {
	const text = clip(title).replace(/\[/g, "(").replace(/\]/g, ")").replace(/\|/g, "/");
	return text ? `[[${address}|${text}]]` : `[[${address}]]`;
}

export function statusWord(status: TaskStatus): string {
	switch (status) {
		case "todo":
			return "to do";
		case "doing":
			return "in progress";
		case "done":
			return "done";
		case "cancelled":
			return "cancelled";
	}
}

/** Who holds a claim, named as the refusals and notes name them. */
async function holderName(holder: OutlineClaimHolder | null): Promise<string> {
	if (!holder) return DELEGATION_TEXT.note.someone;
	const names = await readDisplayNames(
		holder.kind === "agent" ? { narratorIds: [holder.narratorId] } : { userIds: [holder.userId] },
	).catch(() => null);
	return holder.kind === "agent"
		? DELEGATION_TEXT.note.session(
				clip(names?.narrators.get(holder.narratorId) ?? "") || null,
				holder.narratorId,
			)
		: DELEGATION_TEXT.note.person(
				clip(names?.users.get(holder.userId) ?? "") || null,
				holder.userId,
			);
}

function holderOf(row: OutlineTaskClaimRow): OutlineClaimHolder | null {
	if (row.holderUserId !== null) return { kind: "human", userId: row.holderUserId };
	if (row.holderNarratorId !== null)
		return { kind: "agent", narratorId: row.holderNarratorId, expiresAt: row.expiresAt };
	return null;
}

function writeRefusalText(refusal: OutlineWriteRefusal, spaceKey: string): string {
	switch (refusal) {
		case "no-person":
			return OUTLINE_TOOL_TEXT.edit.noPerson;
		case "plan-or-read-only":
			return OUTLINE_TOOL_TEXT.edit.sessionOnly;
		case "no-permission":
			return OUTLINE_TOOL_TEXT.edit.noPermission(spaceKey);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The instructions
// ─────────────────────────────────────────────────────────────────────────────

/** One block of the task's subtree as the instructions show it. */
export interface DelegationBriefNode {
	/** The block's text: links shown as their titles, questions as decided or open. */
	text: string;
	/** A task's checkbox. */
	box: TaskStatus | null;
	/** An earlier report: its title only, nothing under it. */
	collapsed?: boolean;
	/** Its content was not read (past the budget): the expansion ends here. */
	unread?: boolean;
	children: DelegationBriefNode[];
}

export interface DelegationBriefInput {
	title: string;
	/** The task's own text after its first line, if any. */
	body: string | null;
	/** Titles of the blocks above the task, the page first. */
	goals: string[];
	/** What is under the task. */
	children: DelegationBriefNode[];
	prerequisites: Array<{ title: string; status: TaskStatus }>;
	/** The caller's own prompt, added as it is (not counted against the budget). */
	prompt?: string | null;
}

export function utf8(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Text cut to at most `max` UTF-8 bytes, marked when cut. */
export function cutText(text: string, max: number): string {
	if (utf8(text) <= max) return text;
	let out = "";
	let bytes = utf8(DELEGATION_TEXT.brief.truncated);
	for (const ch of text) {
		const size = utf8(ch);
		if (bytes + size > max) break;
		out += ch;
		bytes += size;
	}
	return out + DELEGATION_TEXT.brief.truncated;
}

/** The lines of a list item: its first line after the bullet, the rest indented under it. */
function itemLines(node: DelegationBriefNode, depth: number): string[] {
	const pad = "  ".repeat(depth);
	const [first = "", ...rest] = node.text.split("\n");
	const box = node.box ? `[${TASK_BOX[node.box]}] ` : "";
	return [`${pad}- ${box}${first}`, ...rest.map((line) => (line ? `${pad}  ${line}` : ""))];
}

function subtreeSize(node: DelegationBriefNode): number {
	let n = 1;
	for (const child of node.children) n += subtreeSize(child);
	return n;
}

/**
 * What another brief written from a task tree adds to the delegation's (the opening brief of a
 * session opened for a task, `task-session.ts`). A delegation passes none of it, and its
 * instructions are then byte for byte what they were.
 */
export interface DelegationBriefOptions {
	/** Lines of the head, after the goals. */
	head?: readonly string[];
	/** UTF-8 bytes the task's own text takes at most (default: half the budget). */
	bodyBytes?: number;
	/** Lines between the task's own text and the notes under it (charged to the budget). */
	before?: readonly string[];
	/** Bytes of the budget kept back from the notes, for `after`. */
	reserve?: number;
	/**
	 * Sections after the prerequisites, given the bytes of the budget still unused (the reserve and
	 * whatever the task's text and notes left): what earlier sections do not use, later ones may.
	 */
	after?: (left: number) => string[];
	/** The last lines, in place of the delegation's request for a report. */
	closing?: readonly string[];
}

/**
 * The subagent's instructions (see the module header): plain markdown within `budget` bytes,
 * the caller's prompt aside. Pure. What is under the task is taken breadth first while it fits; a
 * line `… N more` stands for what did not.
 */
export function renderDelegationBrief(
	input: DelegationBriefInput,
	budget: number = OUTLINE_DELEGATION_LIMITS.briefBytes,
	options: DelegationBriefOptions = {},
): string {
	const text = DELEGATION_TEXT.brief;
	const head: string[] = [text.title(clip(input.title, 200))];
	if (input.goals.length > 0) head.push(text.goals(input.goals.map((g) => clip(g))));
	if (options.head) head.push(...options.head);
	const tail: string[] = [];
	if (input.prerequisites.length > 0) {
		tail.push("", text.prerequisites);
		for (const p of input.prerequisites)
			tail.push(text.prerequisite(clip(p.title), statusWord(p.status)));
	}
	const closing = ["", "---", ...(options.closing ?? [text.closing])];
	const fixed = utf8([...head, ...tail, ...closing].join("\n")) + 64;
	// The task's own text is always given, within half the budget (or the caller's share of it).
	const bodyMax = Math.max(256, Math.floor(budget / 2) - fixed);
	const body = input.body?.trim()
		? [
				"",
				text.body,
				cutText(
					input.body.trim(),
					options.bodyBytes === undefined
						? bodyMax
						: Math.max(256, Math.min(bodyMax, options.bodyBytes)),
				),
			]
		: [];
	const reserve = Math.max(0, options.reserve ?? 0);
	const before = options.before ?? [];
	let left =
		budget -
		fixed -
		utf8(body.join("\n")) -
		utf8(text.notes) -
		2 -
		reserve -
		(before.length > 0 ? utf8(before.join("\n")) + 1 : 0);

	// Breadth first over what is under the task, while it fits; a block that may need a
	// `… N more` line under it is charged for one.
	const shown = new Set<DelegationBriefNode>();
	const depthOf = new Map<DelegationBriefNode, number>();
	const queue: DelegationBriefNode[] = [];
	for (const child of input.children) {
		depthOf.set(child, 0);
		queue.push(child);
	}
	const moreCost = (depth: number) => utf8(`${"  ".repeat(depth)}${text.more(99999)}`) + 1;
	left -= moreCost(0);
	for (let i = 0; i < queue.length; i++) {
		const node = queue[i] as DelegationBriefNode;
		if (node.unread) break;
		const depth = depthOf.get(node) ?? 0;
		const lines = itemLines(node, depth);
		const cost =
			utf8(lines.join("\n")) +
			1 +
			(!node.collapsed && node.children.length > 0 ? moreCost(depth + 1) : 0);
		if (cost > left) break;
		left -= cost;
		shown.add(node);
		if (node.collapsed) continue;
		for (const child of node.children) {
			depthOf.set(child, depth + 1);
			queue.push(child);
		}
	}
	const notes: string[] = [];
	const walk = (nodes: readonly DelegationBriefNode[], depth: number) => {
		let hidden = 0;
		for (const node of nodes) {
			if (!shown.has(node)) {
				hidden += subtreeSize(node);
				continue;
			}
			notes.push(...itemLines(node, depth));
			if (!node.collapsed) walk(node.children, depth + 1);
		}
		if (hidden > 0) notes.push(`${"  ".repeat(depth)}${text.more(hidden)}`);
	};
	walk(input.children, 0);

	const out = [...head, ...body, ...before];
	if (notes.length > 0) out.push("", text.notes, ...notes);
	out.push(...tail);
	if (options.after) out.push(...options.after(Math.max(0, left) + reserve));
	if (input.prompt?.trim()) out.push("", text.instructions, input.prompt.trim());
	out.push(...closing);
	return out.join("\n");
}

/** Mentions and embeds in canonical content: `[[ref]]`, `[[ref|label]]`, `![[…]]`. */
const MENTION_RE = /(!?)\[\[((?:\\[^\n]|[^\\[\]|\n])+?)(?:\|((?:\\[^\n]|[^\\[\]\n])*?))?\]\]/g;

function unescapeRef(text: string): string {
	return text.replace(/\\([!-/:-@[-`{-~])/g, "$1").trim();
}

/** Link targets (`key/sid`) a content names. */
export function contentTargets(content: string): string[] {
	if (/^(?:`{3,}|~{3,})/.test(content)) return [];
	const out: string[] = [];
	for (const m of content.matchAll(MENTION_RE)) {
		if (m.index > 0 && content[m.index - 1] === "\\") continue;
		const ref = unescapeRef(m[2] as string);
		if (parseAddress(ref)) out.push(ref);
	}
	return out;
}

/** A content with its links shown as text: the label, the target's title, or a placeholder. */
export function linksAsText(content: string, titles: ReadonlyMap<string, string>): string {
	if (/^(?:`{3,}|~{3,})/.test(content)) return content;
	return content.replace(MENTION_RE, (...m: unknown[]) => {
		const [whole, , rawRef, rawLabel, at] = m as [
			string,
			string,
			string,
			string | undefined,
			number,
		];
		if (at > 0 && content[at - 1] === "\\") return whole;
		const ref = unescapeRef(rawRef);
		const label = rawLabel === undefined ? "" : unescapeRef(rawLabel);
		if (label) return label;
		if (!parseAddress(ref)) return ref;
		return titles.get(ref) ?? DELEGATION_TEXT.brief.unreadable;
	});
}

/** A question as the instructions show it. */
function questionText(question: string, ask: OutlineAskJson): string {
	const text = DELEGATION_TEXT.brief;
	const option = (n: number | undefined) =>
		n !== undefined && ask.options ? (ask.options[n - 1] ?? null) : null;
	if (ask.withdrawn) return text.withdrawn(question);
	if (ask.answer) {
		const answer = ask.answer.text ?? option(ask.answer.option) ?? "";
		return text.decided(question, answer);
	}
	return text.open(question, ask.recommend.text ?? option(ask.recommend.option));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sending
// ─────────────────────────────────────────────────────────────────────────────

export interface PreparedOutlineDelegation {
	spaceId: string;
	blockId: string;
	/** `key/sid`. */
	address: string;
	title: string;
	/** The generation the delegation's claim will have: the claim's as read, plus one. */
	epoch: number;
	/**
	 * The task's `version_seq` and checkbox as checked: the delegation's commit is written against
	 * that version, so a task finished, reopened or reassigned since is not set in progress again.
	 */
	versionSeq: number;
	status: "todo" | "doing";
	delegatorNarratorId: string;
	/** The subagent's first message. */
	brief: string;
}

/**
 * Check `Agent({ task })` and write the subagent's instructions (module header, steps 1–2).
 * Reads only; refuses with {@link OutlineDelegationError}.
 */
export async function prepareOutlineDelegation(args: {
	narratorId: string;
	/** The person this turn runs for. */
	userId: string | null;
	task: string;
	prompt?: string | null;
	takeoverByUser?: boolean;
	/** The session's capability ceiling is read-only (its writes stay in its own space). */
	readOnlyCeiling?: boolean;
	store?: OutlineStore;
	now?: Date;
}): Promise<PreparedOutlineDelegation> {
	const text = DELEGATION_TEXT;
	const refuse = (reason: string): never => {
		throw new OutlineDelegationError(reason);
	};
	const store = args.store ?? outlineStore;
	const { readTaskSession } = await import("../task-source/backend");
	const session = isOutlineEnabled()
		? await readTaskSession(args.narratorId).catch(() => null)
		: null;
	if (
		!session ||
		session.backend !== "outline" ||
		session.subagent ||
		session.sessionNarratorId !== args.narratorId
	)
		refuse(text.notOutlineSession);
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, args.narratorId),
		columns: { traits: true, permissionMode: true },
	});
	if (!row) refuse(text.notOutlineSession);
	if (isPlanModeTrait(row?.traits)) refuse(text.planMode);
	if (args.takeoverByUser) refuse(text.withTakeover);

	const scope = await OutlineAgentScope.open({
		narratorId: args.narratorId,
		userId: args.userId,
		sessionSpaceOnly: args.readOnlyCeiling === true || row?.permissionMode === "readOnly",
	});
	const resolution = await scope.resolve(args.task);
	if (resolution.status === "ambiguous")
		refuse(
			text.ambiguous(
				args.task,
				resolution.candidates.slice(0, 5).map((c) => c.address),
			),
		);
	if (resolution.status !== "found") return refuse(text.notFound(args.task));
	const found = resolution.block;
	const address = found.address;
	if (found.deleted) refuse(text.deleted(address));
	const block = await store.getBlock(found.id);
	if (!block || block.deleted) return refuse(text.deleted(address));
	const task = block.taskJson;
	if (!task) return refuse(text.notATask(address));
	if (task.status === "done" || task.status === "cancelled")
		refuse(text.finished(address, statusWord(task.status)));
	const space = await store.getSpace(block.spaceId);
	if (!space) return refuse(text.notFound(args.task));
	const refusal = await scope.writeRefusal(space);
	if (refusal) refuse(text.notWritable(address, writeRefusalText(refusal, space.key)));

	const subtree = await readSubtree(block.id, { store });
	if (!subtree) return refuse(text.deleted(address));
	// The conditions shared with the board's "open a new session for this" (`task-json.ts`).
	const planning = [subtree.root, ...subtree.path].some((node) => isPlanningRoot(node.task));
	if (planning) refuse(text.planning(address));

	const wait = (
		await deriveOutlineTaskWaits([{ id: block.id, spaceId: block.spaceId, taskJson: task }], {
			store,
		})
	).get(block.id);
	switch (outlineTaskStartBlocker({ task, planning, wait })) {
		case "prerequisites": {
			const metas = await store.getBlockMetasByIds(
				(wait?.prerequisites ?? []).slice(0, OUTLINE_DELEGATION_LIMITS.prerequisites),
			);
			const keys = new Map<string, string>();
			for (const spaceId of new Set(metas.map((m) => m.spaceId)))
				keys.set(spaceId, (await store.getSpace(spaceId))?.key ?? "?");
			return refuse(
				text.waitsPrerequisites(
					address,
					metas.map((m) => `${keys.get(m.spaceId)}/${m.sid}`),
				),
			);
		}
		case "people":
			return refuse(text.waitsPeople(address));
		case "confirmation":
			return refuse(text.waitsConfirmation(address));
		case "assigned_to_person":
			return refuse(text.assignedToPerson(address, task.assignee as string));
		default:
	}

	const now = (args.now ?? new Date()).toISOString();
	const claim = (await getOutlineTaskClaims([block.id], { store })).get(block.id) ?? null;
	if (claim && isClaimLive(claim, now)) {
		const holder = holderOf(claim);
		if (claim.holderUserId !== null) refuse(text.claimed(address, await holderName(holder)));
		const holderId = claim.holderNarratorId as string;
		if (holderId !== args.narratorId) {
			const roots = await store.getNarratorRoots([holderId]);
			if (roots.get(holderId)?.root !== args.narratorId)
				refuse(text.claimed(address, await holderName(holder)));
			// A subagent of this session holds it: refused while it runs. One that is not running
			// (it never started, or the server stopped before it did) holds it for the session:
			// delegating again takes it over.
			else if (await isRunning(holderId))
				refuse(text.runningSubagent(address, await holderName(holder)));
		}
	}

	const brief = renderDelegationBrief({
		...(await readBriefInput(block, subtree, scope, store)),
		prompt: args.prompt ?? null,
	});
	return {
		spaceId: block.spaceId,
		blockId: block.id,
		address,
		title: blockTitle(block.content) || address,
		epoch: (claim?.epoch ?? 0) + 1,
		versionSeq: block.versionSeq,
		status: task.status as "todo" | "doing",
		delegatorNarratorId: args.narratorId,
		brief,
	};
}

/**
 * Subagents a delegation of this process handed a task to whose run has not started yet: from
 * just before the delegation's commit until their run starts, or the delegation is undone. A
 * sibling `Agent({ task })` checking in that window must see them as running.
 */
const startingDelegations = hotSafe(
	"narrafork.outline.startingDelegations",
	() => new Set<string>(),
);

/** The subagent's run has started (or its delegation was undone): it is running, or nothing. */
export function delegationStarted(subagentId: string): void {
	startingDelegations.delete(subagentId);
}

/** How many delegations are between their commit and the start of their run (tests). */
export function startingDelegationCount(): number {
	return startingDelegations.size;
}

/**
 * Whether a narrator is running in this process (executing, held, finishing, or a delegation
 * about to start it). A subagent holding a task without any of these was left by a server that
 * stopped before it ran: it does not block delegating the task again.
 */
async function isRunning(narratorId: string): Promise<boolean> {
	if (startingDelegations.has(narratorId)) return true;
	const { getExecutionOwner, getRunControl } = await import("../agent-runtime/ownership");
	return !!getRunControl(narratorId) || !!getExecutionOwner(narratorId);
}

/**
 * What the instructions show, read from the task's subtree (bounded; see the limits). Shared with
 * the opening brief of a session opened for a task (`task-session.ts`), which also takes the link
 * targets found on the way (`found.targets`: the task's own first, then those of the blocks under
 * it whose content was read, in that order).
 */
export async function readBriefInput(
	block: OutlineBlockRow,
	subtree: NonNullable<Awaited<ReturnType<typeof readSubtree>>>,
	scope: OutlineAgentScope,
	store: OutlineStore,
	found?: {
		targets: string[];
		/** Blocks directly under the task that are left out (shown elsewhere by the caller). */
		omit?: (node: OutlineNode) => boolean;
	},
): Promise<Omit<DelegationBriefInput, "prompt">> {
	const limits = OUTLINE_DELEGATION_LIMITS;
	const goals = subtree.path.slice(-limits.goals);
	await loadBodies(subtree.state, goals, { store });
	// What is under the task, breadth first, at most `subtreeBlocks`; content loaded while it may
	// still fit the budget.
	const order: OutlineNode[] = [];
	const omit = found?.omit;
	const queue = omit
		? subtree.root.children.filter((child) => !omit(child))
		: [...subtree.root.children];
	while (queue.length > 0 && order.length < limits.subtreeBlocks) {
		const node = queue.shift() as OutlineNode;
		order.push(node);
		if (!isReportBlockId(node.id)) queue.push(...node.children);
	}
	await loadBodiesWithin(subtree.state, order, limits.briefBytes, { store });
	const loaded = order.filter((node) => node.content !== null);
	const targets = new Set<string>();
	for (const node of loaded) for (const t of contentTargets(node.content as string)) targets.add(t);
	for (const t of contentTargets(block.content)) targets.add(t);
	if (found) {
		const ordered = new Set(contentTargets(block.content));
		for (const node of loaded) {
			// A report's links are the subagent's findings, not what the task was linked to.
			if (isReportBlockId(node.id)) continue;
			for (const t of contentTargets(node.content as string)) ordered.add(t);
		}
		found.targets.push(...ordered);
	}
	const titles = await linkTitles(targets, {
		store,
		canRead: (space) => scope.canRead(space),
		spaceByKey: (key) => scope.spaceByKey(key),
	});
	const inOrder = new Set(order);
	const toNode = (node: OutlineNode): DelegationBriefNode | null => {
		if (!inOrder.has(node)) return null;
		if (node.content === null)
			return {
				text: "",
				box: null,
				unread: true,
				children: node.children.flatMap((child) => toNode(child) ?? []),
			};
		const content = linksAsText(node.content, titles);
		if (isReportBlockId(node.id)) {
			return {
				text: DELEGATION_TEXT.brief.earlierReport(blockTitle(node.content ?? "")),
				box: null,
				collapsed: true,
				children: [],
			};
		}
		return {
			text: node.ask ? questionText(content, node.ask) : content,
			box: node.task?.status ?? null,
			children: node.children.flatMap((child) => toNode(child) ?? []),
		};
	};
	const [, ...bodyLines] = linksAsText(block.content, titles).split("\n");
	const prerequisites: DelegationBriefInput["prerequisites"] = [];
	const space = await store.getSpace(block.spaceId);
	for (const dep of (block.taskJson?.depends ?? []).slice(0, limits.prerequisites)) {
		const resolved = await scope.resolve(dep.target, space).catch(() => null);
		if (resolved?.status !== "found" || resolved.block.deleted) continue;
		const target = await store.getBlock(resolved.block.id);
		if (target?.taskJson)
			prerequisites.push({ title: blockTitle(target.content), status: target.taskJson.status });
	}
	return {
		title: blockTitle(block.content),
		body: bodyLines.length > 0 ? bodyLines.join("\n") : null,
		goals: goals.map((node) => blockTitle(node.content ?? "")).filter(Boolean),
		children: subtree.root.children.flatMap((child) => toNode(child) ?? []),
		prerequisites,
	};
}

/** A task handed to a subagent: what the registration records, and the task's version after it. */
export interface DelegatedOutlineTask {
	registration: DelegatedTaskRegistration;
	/** The task's `version_seq` right after the delegation's commit. */
	versionSeq: number;
}

/**
 * Hand the task to the subagent just created (module header, step 3): its registration records
 * the delegation, then the delegation's commit claims the task for it, written against the version
 * the checks read. Throws {@link OutlineDelegationError} when the task changed since it was
 * checked (finished, reopened, edited, claimed meanwhile); the registration is cleared again and
 * the caller archives the subagent, which never ran.
 */
export async function delegateOutlineTask(args: {
	delegation: PreparedOutlineDelegation;
	subagentId: string;
	/** The Agent call's tool-call row. */
	toolCallId: string;
	userId: string | null;
	locale: DelegationLocale;
	store?: OutlineStore;
}): Promise<DelegatedOutlineTask> {
	const { delegation, subagentId } = args;
	const store = args.store ?? outlineStore;
	const registered: DelegatedTaskRegistration = {
		spaceId: delegation.spaceId,
		blockId: delegation.blockId,
		epoch: delegation.epoch,
		delegatorNarratorId: delegation.delegatorNarratorId,
		toolCallId: args.toolCallId,
		locale: args.locale,
	};
	const { getRuntimeRegistration, setRuntimeRegistration } = await import(
		"../narrator-runtime-registration"
	);
	const current = await getRuntimeRegistration(subagentId);
	await setRuntimeRegistration(subagentId, {
		...(current ?? { version: 1 as const }),
		delegatedTask: registered,
	});
	const call = await db.query.narratorToolCalls
		.findFirst({ where: eq(narratorToolCalls.id, args.toolCallId), columns: { messageId: true } })
		.catch(() => undefined);
	// Running, as far as a sibling delegation can tell, from before the commit lands until the
	// caller has started its run (`delegationStarted`).
	startingDelegations.add(subagentId);
	let written: Awaited<ReturnType<typeof writeOutline>>;
	try {
		written = await writeOutline(
			{
				spaceId: delegation.spaceId,
				ops: [
					{
						op: "setTask",
						block: { id: delegation.blockId },
						task: { status: "doing" },
						baseVersionSeq: delegation.versionSeq,
					},
				],
				actor: { kind: "system", id: OUTLINE_DELEGATION_ACTOR },
				responsibleUserId: args.userId,
				narratorId: delegation.delegatorNarratorId,
				messageId: call?.messageId ?? null,
				toolCallId: args.toolCallId,
				summary: DELEGATION_TEXT.summary.delegated(
					delegation.address,
					subagentId,
					delegation.epoch,
				),
			},
			{
				store,
				delegateClaim: {
					blockId: delegation.blockId,
					holderNarratorId: subagentId,
					epoch: delegation.epoch,
				},
			},
		);
	} catch (error) {
		// Not delegated after all: the registration names no task (the subagent never runs).
		startingDelegations.delete(subagentId);
		await setRuntimeRegistration(subagentId, current).catch(() => {});
		throw await delegationRefusal(error, delegation, subagentId, store);
	}
	// The version the delegation itself left: a task to do was versioned by its commit; one in
	// progress already kept the version it was checked at (only its claim changed).
	const versionSeq =
		delegation.status === "todo" && written.commit ? written.commit.seq : delegation.versionSeq;
	return { registration: registered, versionSeq };
}

/** Why the delegation's commit was refused, as the agent is told. */
async function delegationRefusal(
	error: unknown,
	delegation: PreparedOutlineDelegation,
	subagentId: string,
	store: OutlineStore,
): Promise<unknown> {
	const text = DELEGATION_TEXT;
	if (error instanceof OutlineTaskClaimedError)
		return new OutlineDelegationError(
			text.claimed(delegation.address, await holderName(error.holder)),
		);
	if (error instanceof OutlineClaimChangedError || error instanceof OutlineConflictError) {
		// The task changed since it was checked: say who has it now, when someone does.
		const claim = (await store.getTaskClaims([delegation.blockId]).catch(() => []))[0] ?? null;
		const root = delegation.delegatorNarratorId;
		if (claim && isClaimLive(claim, new Date().toISOString())) {
			const holder = claim.holderNarratorId;
			if (claim.holderUserId !== null)
				return new OutlineDelegationError(
					text.claimed(delegation.address, await holderName(holderOf(claim))),
				);
			if (holder && holder !== subagentId && holder !== root) {
				const roots = await store.getNarratorRoots([holder]).catch(() => new Map());
				const name = await holderName(holderOf(claim));
				// Another Agent call of this session (in the same message, say) took it first.
				return new OutlineDelegationError(
					roots.get(holder)?.root === root
						? text.takenBySibling(delegation.address, name)
						: text.claimed(delegation.address, name),
				);
			}
		}
		return new OutlineDelegationError(text.changedMeanwhile(delegation.address));
	}
	if (error instanceof AppError && error.statusCode < 500)
		return new OutlineDelegationError(error.message);
	return error;
}

/**
 * Undo a delegation whose subagent never ran (its Agent call failed after the delegation's
 * commit): a task that was to do goes back to do, written against the version the delegation's
 * commit left. Changed since, it goes back to do all the same while it is still exactly the
 * delegation's (in progress, held by the subagent at its generation: its text was edited, say);
 * finished, reset or taken by someone since, it is theirs and left alone. Otherwise (a task that
 * was in progress already, or one that cannot be written) whatever the subagent still holds goes
 * back to the session as a run's end would hand it back. The caller archives the subagent then.
 */
export async function undoOutlineDelegation(args: {
	delegation: PreparedOutlineDelegation;
	delegated: DelegatedOutlineTask;
	subagentId: string;
	userId: string | null;
	store?: OutlineStore;
}): Promise<void> {
	const { delegation } = args;
	const store = args.store ?? outlineStore;
	try {
		if (delegation.status === "todo") {
			const back = (versionSeq: number) =>
				writeOutline(
					{
						spaceId: delegation.spaceId,
						ops: [
							{
								op: "setTask",
								block: { id: delegation.blockId },
								task: { status: "todo" },
								baseVersionSeq: versionSeq,
							},
						],
						actor: { kind: "system", id: OUTLINE_DELEGATION_ACTOR },
						responsibleUserId: args.userId,
						narratorId: delegation.delegatorNarratorId,
						toolCallId: args.delegated.registration.toolCallId,
						summary: DELEGATION_TEXT.summary.undone(delegation.address, args.subagentId),
					},
					{ store },
				);
			try {
				await back(args.delegated.versionSeq);
				return;
			} catch (error) {
				if (!(error instanceof OutlineConflictError)) throw error;
				// Changed since the delegation (its text, say): set back to do all the same, once,
				// while it is still exactly the delegation's (in progress, the subagent's claim of that
				// generation). Finished, reset or taken by someone since: theirs, left alone.
				const [block, claim] = await Promise.all([
					store.getBlock(delegation.blockId),
					store.getTaskClaims([delegation.blockId]).then((rows) => rows[0] ?? null),
				]);
				if (
					block &&
					!block.deleted &&
					block.taskJson?.status === "doing" &&
					claim?.holderNarratorId === args.subagentId &&
					claim.epoch === delegation.epoch
				) {
					await back(block.versionSeq);
					return;
				}
			}
		}
	} catch (error) {
		logger.warn("Delegated task could not be set back to do", {
			subagentId: args.subagentId,
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		delegationStarted(args.subagentId);
	}
	// Whatever the subagent still holds goes back to the session (nothing, when someone else has
	// the task now).
	await idleOutlineTaskClaims(args.subagentId, { store });
}

/** The line added after `<background_task_id>` when an agent was sent with a task. */
export function delegationStartedNote(delegation: PreparedOutlineDelegation): string {
	return DELEGATION_TEXT.started(linkTo(delegation.address, delegation.title), delegation.epoch);
}

// ─────────────────────────────────────────────────────────────────────────────
// Late results
// ─────────────────────────────────────────────────────────────────────────────

/** What decides whether a delegated result is current (see the module header). */
export interface DelegatedResultFacts {
	/** The delegation's claim generation. */
	epoch: number;
	subagentId: string;
	/** The task block now (null: gone). */
	task: { deleted: boolean; taskJson: OutlineTaskJson | null } | null;
	/** Its claim row now (null: none). */
	claim: OutlineTaskClaimRow | null;
	/** Whether a narrator belongs to the delegating session (it, its subagents). */
	inSession: (narratorId: string) => boolean;
	/** The delegating session itself (its root). */
	delegatorNarratorId: string;
	/** Who wrote the task's current version (read for a finished task whose claim is released). */
	finishedBy?: { actorKind: string; actorId: string; narratorId: string | null } | null;
}

export type DelegatedResultClass =
	| { kind: "current"; doneBySubagent: boolean }
	| {
			kind: "late";
			reason: DelegationLateReason;
			/** The claim generation now. */
			epoch?: number;
			/** Who holds (or last held) the task, for `taken_over`. */
			holder?: OutlineClaimHolder | null;
			/** How it ended, for `ended`. */
			status?: "done" | "cancelled";
			finishedBy?: DelegatedResultFacts["finishedBy"];
	  };

/** Whether a delegated result is current, or why it is late. Pure (design §2.5's table). */
export function classifyDelegatedResult(facts: DelegatedResultFacts): DelegatedResultClass {
	const { task, claim } = facts;
	if (!task || task.deleted || !task.taskJson) return { kind: "late", reason: "gone" };
	const status = task.taskJson.status;
	if (claim && claim.epoch !== facts.epoch) {
		// Claimed again since: by someone else, or again within the session.
		const session =
			claim.holderNarratorId ?? (claim.holderUserId === null ? claim.lastHolderNarratorId : null);
		if (claim.holderUserId === null && session !== null && facts.inSession(session)) {
			// Another of its agents has (or had) it: delegated again. The session itself: it took
			// the task up again (after it went back to do, say), whoever did the work since.
			const reason = session === facts.delegatorNarratorId ? "reclaimed" : "redelegated";
			return { kind: "late", reason, epoch: claim.epoch };
		}
		const holder =
			holderOf(claim) ??
			(claim.lastHolderUserId !== null
				? { kind: "human" as const, userId: claim.lastHolderUserId }
				: claim.lastHolderNarratorId !== null
					? { kind: "agent" as const, narratorId: claim.lastHolderNarratorId, expiresAt: null }
					: null);
		return { kind: "late", reason: "taken_over", epoch: claim.epoch, holder };
	}
	if (claim && (claim.holderNarratorId !== null || claim.holderUserId !== null)) {
		if (claim.holderNarratorId !== null && facts.inSession(claim.holderNarratorId))
			return { kind: "current", doneBySubagent: false };
		return { kind: "late", reason: "taken_over", epoch: claim.epoch, holder: holderOf(claim) };
	}
	// Released (or never claimed): finished by someone, or back to do.
	if (status === "done" || status === "cancelled") {
		if (facts.finishedBy?.narratorId === facts.subagentId)
			return { kind: "current", doneBySubagent: true };
		return { kind: "late", reason: "ended", status, finishedBy: facts.finishedBy ?? null };
	}
	return { kind: "late", reason: "reopened" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Attaching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The head line of a note exactly as `noteText` writes it: defined once, beside its reader (the
 * Agent tool card, `@shared/outline-report-note`).
 */
const NOTE_HEAD_RE = OUTLINE_REPORT_NOTE_HEAD_RE;
const NOTE_CLOSE = "</outline_report>";
/** The note is at most about a KiB: only this much of a text's end is looked at. */
const NOTE_WINDOW = OUTLINE_REPORT_NOTE_WINDOW;

/**
 * The text without the delegation note a delivery added at its end (recovery delivers it again).
 * Only the end is looked at, in one pass over at most {@link NOTE_WINDOW} characters: the note is
 * exactly three lines (its head as `noteText` writes it, one line of text, the closing tag) and
 * the last thing in the text. Anything else (a report quoting a note, a tag left open) is left
 * as it is.
 */
export function stripDelegationNote(text: string): string {
	let end = text.length;
	while (end > 0 && /\s/.test(text.charAt(end - 1))) end--;
	if (end < NOTE_CLOSE.length || text.slice(end - NOTE_CLOSE.length, end) !== NOTE_CLOSE)
		return text;
	const lines = text.slice(Math.max(0, end - NOTE_WINDOW), end).split("\n");
	if (lines.length < 3) return text;
	const head = lines[lines.length - 3] as string;
	const body = lines[lines.length - 2] as string;
	if (!NOTE_HEAD_RE.test(head) || body.includes("<outline_report") || body.includes(NOTE_CLOSE))
		return text;
	const start = end - NOTE_CLOSE.length - body.length - head.length - 2;
	// The head starts a line of the text (not a line the window cut into).
	if (start > 0 && text.charAt(start - 1) !== "\n") return text;
	let cut = start;
	while (cut > 0 && text.charAt(cut - 1) === "\n") cut--;
	return text.slice(0, cut);
}

/** `text` with the note at its end, replacing one already there. */
export function withDelegationNote(text: string, note: string): string {
	const base = stripDelegationNote(text);
	return note ? `${base}\n\n${note}` : base;
}

function minuteUtc(date: Date): string {
	return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The container block's text. */
function containerText(
	locale: DelegationLocale,
	epoch: number,
	at: Date,
	verdict: DelegatedResultClass,
	ending: DelegationRunEnding,
	empty: boolean,
): string {
	const t = DELEGATION_BLOCK_TEXT[locale];
	let out =
		verdict.kind === "late" && verdict.reason !== "gone"
			? t.late(
					epoch,
					minuteUtc(at),
					verdict.reason === "ended"
						? "ended"
						: verdict.reason === "reopened"
							? "reopened"
							: "taken_over",
				)
			: t.report(epoch, minuteUtc(at));
	if (ending !== "completed") out += t.unfinished(ending);
	if (empty) out += t.empty;
	return out;
}

/** Report blocks as insert operations under `parent` (a temp id), in document order. */
function reportOps(
	blocks: readonly ReportBlock[],
	parent: string,
	ops: OutlineOp[],
	canonical: Array<{ content: string; links: ReportBlock["links"] } | null>,
): void {
	for (const block of blocks) {
		const tempId = `r${ops.length}`;
		ops.push({ op: "insert", tempId, parent: { tempId: parent }, content: block.content });
		canonical.push({ content: block.content, links: block.links });
		reportOps(block.children, tempId, ops, canonical);
	}
}

/** The report's text, cut to what the conversion parses at most (the rest is counted only). */
function reportInput(text: string): string {
	const max = OUTLINE_REPORT_LIMITS.maxInputBytes;
	if (text.length <= max / 3 || utf8(text) <= max) return text;
	// One spare byte so the conversion sees there is more than it parses.
	let cut = Buffer.from(text, "utf8")
		.subarray(0, max + 1)
		.toString("utf8");
	if (cut.endsWith("�")) cut = cut.slice(0, -1);
	return cut;
}

/**
 * Attach a delegated subagent's result under its task and return the note for the delegating
 * session (module header). Never throws: a failure is logged and noted. Empty when the outline is
 * switched off (nothing is attached then).
 */
export async function attachDelegatedReport(args: {
	subagentId: string;
	delegated: DelegatedTaskRegistration;
	logicalRunId: string;
	/** The result as the subagent wrote it. */
	text: string;
	ending: DelegationRunEnding;
	/** The run's principal: the person accountable for the commit. */
	principal: string | null;
	store?: OutlineStore;
	now?: () => Date;
}): Promise<string> {
	if (!isOutlineEnabled()) return "";
	const store = args.store ?? outlineStore;
	const { delegated, subagentId } = args;
	const containerId = reportBlockId(subagentId, args.logicalRunId);
	const report = stripDelegationNote(args.text).trim();
	const task = { address: delegated.blockId, link: `[[${delegated.blockId}]]` };
	let conversion: ReportConversion | null = null;
	for (let attempt = 1; ; attempt++) {
		try {
			const [block, space] = await Promise.all([
				store.getBlock(delegated.blockId),
				store.getSpace(delegated.spaceId),
			]);
			if (block && space) {
				task.address = `${space.key}/${block.sid}`;
				task.link = linkTo(task.address, blockTitle(block.content));
			}
			const claim = (await store.getTaskClaims([delegated.blockId]))[0] ?? null;
			const verdict = classifyDelegatedResult({
				epoch: delegated.epoch,
				subagentId,
				task: block && space ? block : null,
				claim,
				inSession: await sessionOf(store, delegated, claim),
				delegatorNarratorId: delegated.delegatorNarratorId,
				finishedBy: await finishedBy(store, block, claim),
			});
			if (verdict.kind === "late" && verdict.reason === "gone") {
				return await noteFor(verdict, delegated, task, null);
			}
			const existing = await store.getBlock(containerId);
			if (existing && space) {
				return await noteFor(verdict, delegated, task, {
					address: `${space.key}/${existing.sid}`,
					title: blockTitle(existing.content),
					blocks: await reportSize(store, space.id, existing.id),
				});
			}
			if (!conversion) {
				const input = reportInput(report);
				const converted = await processEditText({
					kind: "report",
					text: input,
					continued: DELEGATION_BLOCK_TEXT[delegated.locale].continued,
				});
				// What was cut before the conversion is left out too.
				const cut = input === report ? 0 : utf8(report) - utf8(input);
				conversion = { ...converted, omittedBytes: converted.omittedBytes + cut };
			}
			const at = args.now?.() ?? new Date();
			const title = containerText(
				delegated.locale,
				delegated.epoch,
				at,
				verdict,
				args.ending,
				report === "" || report === "(no output)",
			);
			const ops: OutlineOp[] = [
				{
					op: "insert",
					tempId: "report",
					id: containerId,
					parent: { id: delegated.blockId },
					content: title,
				},
			];
			const canonical: Array<{ content: string; links: ReportBlock["links"] } | null> = [null];
			reportOps(conversion.blocks, "report", ops, canonical);
			if (conversion.omittedBytes > 0) {
				const line = DELEGATION_BLOCK_TEXT[delegated.locale].omitted(
					Math.max(1, Math.round(conversion.omittedBytes / 1024)),
				);
				ops.push({ op: "insert", parent: { tempId: "report" }, content: line });
				canonical.push(null);
			}
			const { getSubagentResultMessageId } = await import("../narrator-session");
			const messageId = await getSubagentResultMessageId(subagentId).catch(() => undefined);
			const written = await writeOutline(
				{
					spaceId: delegated.spaceId,
					ops,
					actor: { kind: "system", id: OUTLINE_REPORT_ACTOR },
					responsibleUserId: args.principal,
					narratorId: subagentId,
					messageId: messageId ?? null,
					toolCallId: delegated.toolCallId,
					summary: DELEGATION_TEXT.summary.report(subagentId, verdict.kind === "late"),
				},
				{
					store,
					...(args.now ? { now: args.now } : {}),
					canonical,
					expectClaims: [{ taskBlockId: delegated.blockId, expect: claim }],
				},
			);
			const container = written.results[0];
			return await noteFor(verdict, delegated, task, {
				address: container?.address ?? containerId,
				title,
				blocks: ops.length,
			});
		} catch (error) {
			const retry =
				error instanceof OutlineClaimChangedError ||
				error instanceof OutlineBusyError ||
				(error instanceof OutlineWriteError && error.code === "OUTLINE_ID_TAKEN");
			if (retry && attempt < OUTLINE_DELEGATION_LIMITS.attachAttempts) continue;
			logger.warn("Delegated report could not be attached", {
				subagentId,
				task: delegated.blockId,
				logicalRunId: args.logicalRunId,
				error: error instanceof Error ? error.message : String(error),
			});
			return noteText(
				{ task: task.address, generation: delegated.epoch, status: "not_attached" },
				DELEGATION_TEXT.note.failed(task.link),
			);
		}
	}
}

/**
 * Blocks of a report attached already (its container and everything under it): one indexed read
 * per level, at most {@link OUTLINE_DELEGATION_LIMITS.reportBlocksCounted} blocks.
 */
async function reportSize(store: OutlineStore, spaceId: string, id: string): Promise<number> {
	const max = OUTLINE_DELEGATION_LIMITS.reportBlocksCounted;
	let count = 1;
	for (let level = [id]; level.length > 0 && count < max; ) {
		const below = await store.listChildMetas(spaceId, level, max - count);
		count += below.length;
		level = below.map((block) => block.id);
	}
	return Math.min(count, max);
}

/**
 * Whether a narrator belongs to the delegating session: one indexed read of the ones the claim
 * names.
 */
async function sessionOf(
	store: OutlineStore,
	delegated: DelegatedTaskRegistration,
	claim: OutlineTaskClaimRow | null,
): Promise<(narratorId: string) => boolean> {
	const root = delegated.delegatorNarratorId;
	const named = [claim?.holderNarratorId, claim?.lastHolderNarratorId].filter(
		(id): id is string => !!id && id !== root,
	);
	const roots = named.length > 0 ? await store.getNarratorRoots(named) : new Map();
	return (id) => id === root || roots.get(id)?.root === root;
}

/** Who wrote the task's current version, when that may have finished it: one commit read. */
async function finishedBy(
	store: OutlineStore,
	task: OutlineBlockRow | null,
	claim: OutlineTaskClaimRow | null,
): Promise<DelegatedResultFacts["finishedBy"]> {
	const status = task?.taskJson?.status;
	if (!task || (status !== "done" && status !== "cancelled")) return null;
	if (claim && (claim.holderNarratorId !== null || claim.holderUserId !== null)) return null;
	const [commit] = await store.getCommitsBySeqs(task.spaceId, [task.versionSeq]);
	return commit
		? { actorKind: commit.actorKind, actorId: commit.actorId, narratorId: commit.narratorId }
		: null;
}

function noteText(fields: Record<string, string | number>, body: string): string {
	const note = DELEGATION_TEXT.note;
	return [note.head(fields), body, note.tail].join("\n");
}

/** The note for the delegating session. */
async function noteFor(
	verdict: DelegatedResultClass,
	delegated: DelegatedTaskRegistration,
	task: { address: string; link: string },
	report: { address: string; title: string; blocks: number } | null,
): Promise<string> {
	const note = DELEGATION_TEXT.note;
	const taskLink = task.link;
	const reportLink = report ? linkTo(report.address, report.title) : "";
	const blocks = report ? note.blocks(report.blocks) : "";
	const fields: Record<string, string | number> = {
		task: task.address,
		...(report ? { report: report.address } : {}),
		generation: delegated.epoch,
		status: verdict.kind,
		...(verdict.kind === "late" ? { reason: verdict.reason } : {}),
	};
	if (verdict.kind === "current") {
		return noteText(
			fields,
			verdict.doneBySubagent
				? note.doneBySubagent(taskLink, reportLink, blocks)
				: note.current(taskLink, reportLink, blocks),
		);
	}
	let lead: string;
	switch (verdict.reason) {
		case "taken_over":
			lead = note.late.taken_over(await holderName(verdict.holder ?? null), verdict.epoch ?? 0);
			break;
		case "redelegated":
			lead = note.late.redelegated(verdict.epoch ?? 0);
			break;
		case "reclaimed":
			lead = note.late.reclaimed(verdict.epoch ?? 0);
			break;
		case "ended": {
			const by = verdict.finishedBy;
			const name =
				by?.actorKind === "system"
					? note.theSystem
					: by?.actorKind === "human"
						? await holderName({ kind: "human", userId: by.actorId })
						: by
							? await holderName({
									kind: "agent",
									narratorId: by.narratorId ?? by.actorId,
									expiresAt: null,
								})
							: note.someone;
			lead = note.late.ended(name, verdict.status ?? "done");
			break;
		}
		case "reopened":
			lead = note.late.reopened;
			break;
		case "gone":
			return noteText(fields, `${note.late.gone} ${note.notAttachedGone}`);
	}
	const tail =
		verdict.reason === "reopened"
			? note.lateReopened(reportLink, blocks)
			: note.lateAttached(reportLink, blocks);
	return noteText(fields, `${lead} ${tail}`);
}

/**
 * What a delivery of a delegated subagent's result hands on: the result with the note at its end
 * (one already there replaced), and the note's head as data (null when no note was written) for
 * the Agent call's card (outline P2 PR 9b). The run service calls this where it delivers
 * (`run.ts`).
 */
export async function deliverDelegatedResult(args: {
	subagentId: string;
	delegated: DelegatedTaskRegistration;
	logicalRunId: string;
	/** The text being delivered. */
	delivered: string;
	/** The result as the subagent wrote it (what is attached). */
	report: string;
	ending: DelegationRunEnding;
	principal: string | null;
}): Promise<{ text: string; note: OutlineReportNote | null }> {
	const note = await attachDelegatedReport({
		subagentId: args.subagentId,
		delegated: args.delegated,
		logicalRunId: args.logicalRunId,
		text: args.report,
		ending: args.ending,
		principal: args.principal,
	}).catch((error) => {
		logger.warn("Delegated report attachment failed", {
			subagentId: args.subagentId,
			error: error instanceof Error ? error.message : String(error),
		});
		return "";
	});
	return { text: withDelegationNote(args.delivered, note), note: readOutlineReportNote(note) };
}
