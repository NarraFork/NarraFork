/**
 * The outline write path: one outline transaction (a list of operations on one space) becomes
 * one commit.
 *
 * HOW A TRANSACTION IS WRITTEN
 * ----------------------------
 *   1. Validate and prepare, with no database access: operation shapes and limits, content
 *      normalized to the block dialect (`normalizeBlock`; out-of-dialect structure becomes
 *      child blocks and is reported in the result's notes), content hashes and the links each
 *      content holds. A caller may hand over content it normalized off the main thread
 *      (`OutlineWriteOptions.canonical`); only hashing is left then.
 *   2. Plan against current state: read the space's commit counter, then only the rows the
 *      operations need (referenced blocks, sibling lists, subtrees of deleted or re-paged
 *      blocks, alias owners, open links), apply the operations to an in-memory working copy and
 *      derive what to write: block rows, one version per changed block with its change flags,
 *      link rows to close and open, the commit row. Every check happens here (parents in the
 *      space and live, no cycles, unique aliases, the caller's `baseVersionSeq`, row limits).
 *   3. Write: `OutlineStore.applyCommit` claims the counter value the plan was made against and
 *      writes the rows in one atomic section that does nothing else. If another commit landed in
 *      the meantime the claim fails, nothing is written, and the transaction is planned again
 *      from fresh reads (a few times, then `OutlineBusyError`).
 *   4. After the commit, emit `outline:committed` on the event bus.
 *
 * A write runs behind the live session barrier of its space (`live-barrier.ts`): while a page is
 * edited live, its unflushed edits are committed before this write plans, and this write is
 * pushed into the session afterwards.
 *
 * The invariants this maintains are listed in `model.ts`.
 *
 * A version conflict (`baseVersionSeq` no longer matches) rejects the whole transaction with
 * `OutlineConflictError` naming the blocks; the caller re-reads them.
 *
 * A compensating commit (`revert.ts`) is written through the same planner, so it keeps the same
 * invariants; see `OutlineWriteOptions.compensating` for what differs.
 *
 * TASK CLAIMS
 * -----------
 * Setting a task to in progress claims it, in the same commit (design §2.2, §4.5): an insert of a
 * task in progress, a `setTask` naming the status `doing`, or a split-off task in progress. The
 * claimer is the writer: the session for an agent's write (or a system write made for a
 * session, `narratorId`), the person for a person's write; a compensating commit and a system
 * write for no session claim nothing.
 *
 *   - Nobody holds it (no row, released, or a session's lease ran out): the writer takes it, and
 *     the claim generation (`epoch`) grows by one.
 *   - The writer holds it already: nothing changes (a session's lapsed lease is renewed).
 *   - A session whose lease is running, or a person, holds it: the whole transaction is refused
 *     with `OutlineTaskClaimedError`, naming the holder.
 *
 * A task that leaves in progress in a commit (done, cancelled, back to to-do, no longer a task,
 * deleted) has its claim released in that commit. Rewriting a task that stays in progress (its
 * text, its place) does not claim it.
 *
 * IN PROCESS
 * ----------
 * `outline_blocks.in_process` (a task, under a task, or in a session space) is derived in the
 * commit that changes it: see `planInProcess`. It is not part of a block's versions.
 */
import { createHash } from "node:crypto";
import { NotFoundError } from "@server/lib/errors";
import { eventBus } from "@server/lib/event-bus";
import { generateId } from "@server/lib/id";
import {
	type BlockNode,
	compareOrderKeys,
	type DialectNote,
	isAlias,
	isOrderKey,
	isShortId,
	isValidMention,
	keyBetween,
	keysBetween,
	type LinkTarget,
	normalizeBlock,
	OrderKeyError,
	serializeBody,
	type TaskStatus,
} from "@shared/outline";
import {
	OutlineBusyError,
	OutlineConflictError,
	OutlineLeaseNotExpiredError,
	OutlineTaskClaimedError,
	type OutlineVersionConflict,
	OutlineWriteError,
} from "./errors";
import { newOutlineSid } from "./keys";
import {
	CONTENT_LINK_KINDS,
	contentLinks,
	dependsLinks,
	type ExtractedLink,
	linkKey,
	TAG_LINK_KINDS,
	TASK_LINK_KINDS,
	tagLinks,
} from "./links";
import { withOutlineLiveBarrier } from "./live-barrier";
import {
	OUTLINE_ACTOR_KINDS,
	OUTLINE_CHANGE,
	OUTLINE_LIMITS,
	type OutlineActorKind,
	type OutlineCommitKind,
	type OutlineLinkKind,
	type OutlineTaskActorRef,
	type OutlineTaskJson,
	type OutlineTaskLockJson,
	outlineLeaseEnd,
} from "./model";
import { outlineStore } from "./store";
import {
	type OutlineBlockMeta,
	type OutlineBlockPatch,
	type OutlineBlockRow,
	type OutlineClaimPlan,
	type OutlineCommitPlan,
	type OutlineLinkRow,
	type OutlineSpaceRow,
	OutlineStaleWriteError,
	type OutlineStore,
	type OutlineTaskClaimRow,
	WriteConflictError,
} from "./store/port";
import { canonicalTaskJson, sameTaskJson, sameTaskLock } from "./task-json";

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A block, by id, by sid in the transaction's space, or by the `tempId` an earlier insert of
 * the same transaction gave it.
 */
export type OutlineBlockRef = { id: string } | { sid: string } | { tempId: string };

/**
 * Where among the target parent's live children: after or before a sibling, first, last (the
 * default), or at an explicit order key. A key already used by a sibling places the block
 * right after that sibling.
 */
export type OutlinePosition =
	| { after: OutlineBlockRef }
	| { before: OutlineBlockRef }
	| { first: true }
	| { last: true }
	| { orderKey: string };

/**
 * A lock as a writer gives it: who locks (the writer by default) and the agent that may confirm
 * on the locker's behalf. The version is stamped by the write path (the commit's seq) whenever
 * the lock is new or changes; a compensating commit restores the one it read from history.
 */
export interface OutlineTaskLockInput {
	by?: OutlineTaskActorRef;
	delegate?: string | null;
	/** Honoured only in a compensating commit (`revert.ts`), which restores a lock as it was. */
	versionSeq?: number;
}

/** The fields of a task besides its checkbox (P2): stored only, enforced elsewhere. */
interface OutlineTaskExtraInput {
	/**
	 * Who created the task. Default: the writer, when the block becomes a task (an agent's
	 * session, a person); an existing task keeps its manager.
	 */
	manager?: OutlineTaskActorRef | null;
	/** Created by a person through `/goal` or the interface. */
	humanCreated?: boolean | null;
	/** Lock the task tree (`null` unlocks). */
	lock?: OutlineTaskLockInput | null;
	/** Put the task in the claimable pool. */
	claimable?: boolean | null;
}

export interface OutlineTaskInput extends OutlineTaskExtraInput {
	status: TaskStatus;
	/** `agent:name` or `human:name`, without the `@`. */
	assignee?: string | null;
	depends?: LinkTarget[];
	/** `YYYY-MM-DD` with an optional `THH:MM[:SS]`. */
	due?: string | null;
}

/** Changes to a task; omitted fields keep their value, `null` clears. */
export interface OutlineTaskPatch extends OutlineTaskExtraInput {
	status?: TaskStatus;
	assignee?: string | null;
	depends?: LinkTarget[] | null;
	due?: string | null;
}

interface BaseVersioned {
	/** The block's `version_seq` as the caller read it; a mismatch rejects the transaction. */
	baseVersionSeq?: number;
}

export type OutlineOp =
	| {
			op: "insert";
			/** Name for this block in later operations of the same transaction. */
			tempId?: string;
			/** Caller-chosen id (a live editing client creates ids before the server sees them). */
			id?: string;
			/**
			 * Caller-chosen sid, so content written in the same transaction can link to the block
			 * by its address. Must be free in the space.
			 */
			sid?: string;
			/** `null`: a new page of the space. */
			parent: OutlineBlockRef | null;
			position?: OutlinePosition;
			content: string;
			task?: OutlineTaskInput | null;
			alias?: string | null;
			/** Tag targets (a tag is a link to the tag's page), replacing none. */
			tags?: string[];
	  }
	| ({
			op: "update";
			block: OutlineBlockRef;
			content?: string;
			/** `null` removes the alias. */
			alias?: string | null;
			/** Replaces the block's tags. */
			tags?: string[];
			/**
			 * The update is a three-way merge of the caller's change over changes others made after
			 * the caller read the block: the version records `OUTLINE_CHANGE.MERGE`.
			 */
			merged?: boolean;
	  } & BaseVersioned)
	| ({
			op: "move";
			block: OutlineBlockRef;
			/** `null`: make the block a page. */
			parent: OutlineBlockRef | null;
			position?: OutlinePosition;
	  } & BaseVersioned)
	| ({ op: "delete"; block: OutlineBlockRef } & BaseVersioned)
	| ({
			op: "setTask";
			block: OutlineBlockRef;
			/** `null` makes the block a plain block again. */
			task: OutlineTaskPatch | null;
	  } & BaseVersioned)
	| ({
			/**
			 * Bring a deleted block back (its descendants stay deleted; restore them one by one,
			 * parents first). Every field defaults to what the block had when it was deleted. Its
			 * page follows from its new parent. An alias another live block holds now is dropped
			 * and reported in the result's `adjustments`, never taken over.
			 */
			op: "restore";
			block: OutlineBlockRef;
			/** `null`: as a page. Default: the parent it had, which must be live. */
			parent?: OutlineBlockRef | null;
			/** Default: its old order key (right after the sibling holding it, if taken). */
			position?: OutlinePosition;
			content?: string;
			alias?: string | null;
			task?: OutlineTaskInput | null;
			/** Default: the tags it had. */
			tags?: string[];
	  } & BaseVersioned);

export interface OutlineWriteInput {
	spaceId: string;
	ops: readonly OutlineOp[];
	actor: { kind: OutlineActorKind; id: string };
	/** The person accountable for the commit (the session's user for an agent). */
	responsibleUserId: string | null;
	narratorId?: string | null;
	messageId?: string | null;
	toolCallId?: string | null;
	/** Short description for the timeline; derived from the operations when omitted. */
	summary?: string;
}

export interface OutlineBlockAddressed {
	blockId: string;
	sid: string;
	/** `key/sid`. */
	address: string;
}

/** Something an operation did differently from what it asked, without failing. */
export type OutlineAdjustment =
	/** The alias is held by another live block (`heldBy`); the block was written without one. */
	| { kind: "alias-dropped"; alias: string; heldBy: string }
	/** The order key asked for is used by a sibling; the block was placed right after it. */
	| { kind: "order-key-moved"; wanted: string; got: string };

export interface OutlineOpResult extends OutlineBlockAddressed {
	/** Blocks created from out-of-dialect structure in the content, in document order. */
	split: OutlineBlockAddressed[];
	/** What normalization did to the content. */
	notes: DialectNote[];
	/** Present when the operation was adjusted (see {@link OutlineAdjustment}). */
	adjustments?: OutlineAdjustment[];
}

export interface OutlineWriteResult {
	spaceId: string;
	/** Null when the transaction changed nothing: no commit is written then. */
	commit: { id: string; seq: number } | null;
	/** Pages whose blocks changed, including pages blocks moved out of. */
	pageIds: string[];
	/** One per operation, in order. */
	results: OutlineOpResult[];
}

export interface OutlineWriteOptions {
	/** The store to write to; the configured one by default. */
	store?: OutlineStore;
	/** Clock for the commit's `created_at`. */
	now?: () => Date;
	/** Plans tried before giving up on a space that keeps changing. */
	maxAttempts?: number;
	/**
	 * Internal to `revert.ts`: the operations put blocks back to states read from their history,
	 * so they are not caller input. The commit is recorded as `revert`; content is taken as
	 * stored (canonical already: not normalized, never split); the operation limit becomes four
	 * per row the commit may touch and the per-transaction content limit is lifted, while the
	 * row limit still holds. Aliases that are taken now are dropped (reported) instead of
	 * failing the write. When the space is no longer at `expectNextSeq` (a commit landed after
	 * the history was read) the write rejects with `OutlineStaleWriteError`, writing nothing.
	 */
	compensating?: { expectNextSeq: number };
	/**
	 * Content the caller normalized itself, by operation index: normalization costs tens of
	 * milliseconds per large block, so a caller handling untrusted input runs it off the main
	 * thread (`edit-text.ts`) and hands over the result. Each entry's `content` must equal the
	 * operation's content and be canonical already (`normalizeBlock(content).content ===
	 * content`, so nothing is split off); `links` are what `contentLinks(content)` reads. The
	 * writer hashes it and takes it as is.
	 */
	canonical?: ReadonlyArray<OutlineCanonicalContent | null | undefined>;
	/**
	 * Internal to the lease expiry job (`tasks.ts`): this commit reopens these tasks because their
	 * session's lease ran out. Each must still be in progress before the commit, back to to-do
	 * after it, and held by a session whose lease ended at the commit's time; otherwise the write
	 * rejects with `OutlineLeaseNotExpiredError`, writing nothing. The claims are released only if
	 * they are still exactly as read (a renewal in between makes the write plan again).
	 */
	leaseExpiry?: { blockIds: readonly string[] };
}

/** Content normalized before `writeOutline` was called; see `OutlineWriteOptions.canonical`. */
export interface OutlineCanonicalContent {
	content: string;
	links: ExtractedLink[];
}

const DEFAULT_ATTEMPTS = 5;
/** How each backend names the block primary key in a uniqueness conflict. */
const CALLER_ID_CONSTRAINTS: ReadonlySet<string> = new Set([
	"outline_blocks.id",
	"outline_blocks_pkey",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Validation and preparation (no database access)
// ─────────────────────────────────────────────────────────────────────────────

const ASSIGNEE_RE = /^(?:agent|human):[\p{L}\p{N}_.-]*[\p{L}\p{N}_]$/u;
const DUE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TASK_STATUSES: ReadonlySet<string> = new Set(["todo", "doing", "done", "cancelled"]);
const OP_KINDS: ReadonlySet<string> = new Set([
	"insert",
	"update",
	"move",
	"delete",
	"setTask",
	"restore",
]);

interface PreparedNode {
	content: string;
	contentHash: string;
	links: ExtractedLink[];
	task: OutlineTaskJson | null;
	children: PreparedNode[];
}

interface PreparedContent {
	content: string;
	contentHash: string;
	links: ExtractedLink[];
	notes: DialectNote[];
	/** Child blocks split off the content, in order. */
	split: PreparedNode[];
}

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function invalid(message: string, opIndex: number | null): OutlineWriteError {
	return new OutlineWriteError(message, "OUTLINE_INVALID_OP", opIndex);
}

function checkLinkCount(links: ExtractedLink[], opIndex: number): void {
	if (links.length > OUTLINE_LIMITS.maxLinksPerBlock) {
		throw new OutlineWriteError(
			`a block may hold at most ${OUTLINE_LIMITS.maxLinksPerBlock} distinct links`,
			"OUTLINE_TOO_MANY_LINKS",
			opIndex,
		);
	}
}

function prepareNode(node: BlockNode, opIndex: number): PreparedNode {
	const content = serializeBody(node.body);
	const links = contentLinks(content);
	checkLinkCount(links, opIndex);
	return {
		content,
		contentHash: hashContent(content),
		links,
		task: node.task ? { status: node.task, assignee: null } : null,
		children: node.children.map((child) => prepareNode(child, opIndex)),
	};
}

/** Content read from history: canonical already, so it is hashed and its links read as is. */
function prepareStoredContent(content: string, opIndex: number): PreparedContent {
	const links = contentLinks(content);
	checkLinkCount(links, opIndex);
	return { content, contentHash: hashContent(content), links, notes: [], split: [] };
}

/** Content normalized by the caller (see `OutlineWriteOptions.canonical`). */
function prepareCanonicalContent(
	given: OutlineCanonicalContent,
	content: string,
	opIndex: number,
): PreparedContent {
	if (given.content !== content) {
		throw new Error(`outline operation ${opIndex}: canonical content does not match the operation`);
	}
	checkLinkCount(given.links, opIndex);
	return {
		content,
		contentHash: hashContent(content),
		links: given.links,
		notes: [],
		split: [],
	};
}

function prepareContent(src: string, opIndex: number): PreparedContent {
	const normalized = normalizeBlock(src);
	const links = contentLinks(normalized.content);
	checkLinkCount(links, opIndex);
	return {
		content: normalized.content,
		contentHash: hashContent(normalized.content),
		links,
		notes: normalized.notes,
		split: normalized.children.map((child) => prepareNode(child, opIndex)),
	};
}

function checkRef(ref: unknown, what: string, opIndex: number): void {
	const r = ref as Record<string, unknown> | null;
	const keys = r && typeof r === "object" ? Object.keys(r) : [];
	const key = keys[0];
	if (
		keys.length !== 1 ||
		(key !== "id" && key !== "sid" && key !== "tempId") ||
		typeof r?.[key] !== "string" ||
		r[key] === ""
	) {
		throw invalid(`${what} must be { id }, { sid } or { tempId }`, opIndex);
	}
}

function checkPosition(position: unknown, opIndex: number): void {
	if (position === undefined) return;
	const p = position as Record<string, unknown> | null;
	const keys = p && typeof p === "object" ? Object.keys(p) : [];
	const key = keys[0];
	if (keys.length !== 1) throw invalid("position must name exactly one placement", opIndex);
	if (key === "after" || key === "before") checkRef(p?.[key], `position.${key}`, opIndex);
	else if (key === "first" || key === "last") {
		if (p?.[key] !== true) throw invalid(`position.${key} must be true`, opIndex);
	} else if (key === "orderKey") {
		if (typeof p?.orderKey !== "string" || !isOrderKey(p.orderKey))
			throw invalid("position.orderKey is not a valid order key", opIndex);
	} else throw invalid(`unknown position ${JSON.stringify(key)}`, opIndex);
}

function checkLinkTargets(links: unknown, what: string, opIndex: number): void {
	if (!Array.isArray(links)) throw invalid(`${what} must be a list of links`, opIndex);
	for (const link of links as Array<Partial<LinkTarget>>) {
		if (
			!link ||
			typeof link.target !== "string" ||
			(link.label !== null && link.label !== undefined && typeof link.label !== "string") ||
			!isValidMention(link.target, link.label ?? null)
		) {
			throw invalid(`${what}: ${JSON.stringify(link)} is not a valid link target`, opIndex);
		}
	}
	if (links.length > OUTLINE_LIMITS.maxLinksPerBlock) {
		throw new OutlineWriteError(
			`${what}: at most ${OUTLINE_LIMITS.maxLinksPerBlock} links`,
			"OUTLINE_TOO_MANY_LINKS",
			opIndex,
		);
	}
}

const ACTOR_KINDS: ReadonlySet<string> = new Set(OUTLINE_ACTOR_KINDS);
const MAX_ACTOR_ID = 128;

function checkActorRef(ref: unknown, what: string, opIndex: number): void {
	const r = ref as Partial<OutlineTaskActorRef> | null;
	if (
		!r ||
		typeof r !== "object" ||
		typeof r.kind !== "string" ||
		!ACTOR_KINDS.has(r.kind) ||
		typeof r.id !== "string" ||
		r.id === "" ||
		r.id.length > MAX_ACTOR_ID
	) {
		throw invalid(`${what} must be { kind: human | agent | system, id }`, opIndex);
	}
}

function checkFlag(value: unknown, what: string, opIndex: number): void {
	if (value !== undefined && value !== null && typeof value !== "boolean")
		throw invalid(`task ${what} must be a boolean`, opIndex);
}

function checkTaskFields(task: OutlineTaskPatch, opIndex: number): void {
	if (task.manager !== undefined && task.manager !== null)
		checkActorRef(task.manager, "task manager", opIndex);
	checkFlag(task.humanCreated, "humanCreated", opIndex);
	checkFlag(task.claimable, "claimable", opIndex);
	if (task.lock !== undefined && task.lock !== null) {
		const lock = task.lock as Partial<OutlineTaskLockInput>;
		if (typeof lock !== "object") throw invalid("task lock must be an object", opIndex);
		if (lock.by !== undefined) checkActorRef(lock.by, "task lock.by", opIndex);
		if (
			lock.delegate !== undefined &&
			lock.delegate !== null &&
			(typeof lock.delegate !== "string" ||
				lock.delegate === "" ||
				lock.delegate.length > MAX_ACTOR_ID)
		) {
			throw invalid("task lock.delegate must be a narrator id", opIndex);
		}
		if (
			lock.versionSeq !== undefined &&
			(!Number.isSafeInteger(lock.versionSeq) || lock.versionSeq < 1)
		) {
			throw invalid("task lock.versionSeq must be a positive integer", opIndex);
		}
	}
	if (task.status !== undefined && !TASK_STATUSES.has(task.status))
		throw invalid(`unknown task status ${JSON.stringify(task.status)}`, opIndex);
	if (
		task.assignee !== undefined &&
		task.assignee !== null &&
		(typeof task.assignee !== "string" || !ASSIGNEE_RE.test(task.assignee))
	) {
		throw invalid("task assignee must look like agent:name or human:name", opIndex);
	}
	if (task.depends !== undefined && task.depends !== null)
		checkLinkTargets(task.depends, "task depends", opIndex);
	if (
		task.due !== undefined &&
		task.due !== null &&
		(typeof task.due !== "string" || !DUE_RE.test(task.due) || Number.isNaN(Date.parse(task.due)))
	) {
		throw invalid("task due must be YYYY-MM-DD with an optional time", opIndex);
	}
}

function checkTags(tags: unknown, opIndex: number): void {
	if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || !isValidMention(t, null)))
		throw invalid("tags must be a list of link targets", opIndex);
	if (tags.length > OUTLINE_LIMITS.maxTagsPerBlock)
		throw invalid(`a block may have at most ${OUTLINE_LIMITS.maxTagsPerBlock} tags`, opIndex);
}

function checkAlias(alias: unknown, opIndex: number): void {
	if (alias === undefined || alias === null) return;
	if (typeof alias !== "string" || !isAlias(alias))
		throw invalid(`${JSON.stringify(alias)} is not a valid alias`, opIndex);
}

function checkBase(op: { baseVersionSeq?: number; block: OutlineBlockRef }, opIndex: number) {
	if (op.baseVersionSeq === undefined) return;
	if (!Number.isSafeInteger(op.baseVersionSeq) || op.baseVersionSeq < 1)
		throw invalid("baseVersionSeq must be a positive integer", opIndex);
	if ("tempId" in op.block)
		throw invalid("baseVersionSeq cannot refer to a block created in this transaction", opIndex);
}

/**
 * Check every operation and prepare its content. Throws before any read, so a malformed or
 * oversized transaction never reaches the database. `stored`: a compensating commit's content,
 * read from history (see `OutlineWriteOptions.compensating`).
 */
function prepareOps(
	ops: readonly OutlineOp[],
	stored = false,
	canonical?: OutlineWriteOptions["canonical"],
): Array<PreparedContent | null> {
	if (!Array.isArray(ops) || ops.length === 0)
		throw invalid("a transaction needs at least one operation", null);
	const maxOps = stored ? OUTLINE_LIMITS.maxRowsTouched * 4 : OUTLINE_LIMITS.maxOps;
	if (ops.length > maxOps) {
		throw new OutlineWriteError(
			`a transaction may hold at most ${maxOps} operations (got ${ops.length})`,
			"OUTLINE_TOO_MANY_OPS",
		);
	}
	let totalBytes = 0;
	const tempIds = new Set<string>();
	const sids = new Set<string>();
	const sized: Array<string | null> = ops.map((op, i) => {
		if (!op || typeof op !== "object" || !OP_KINDS.has((op as { op: string }).op))
			throw invalid("unknown operation", i);
		const content =
			op.op === "insert" || op.op === "update" || op.op === "restore" ? op.content : undefined;
		if (content === undefined) {
			if (op.op === "insert") throw invalid("insert needs content", i);
			return null;
		}
		if (typeof content !== "string") throw invalid("content must be a string", i);
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > OUTLINE_LIMITS.maxBodyBytes) {
			throw new OutlineWriteError(
				`block content is ${bytes} bytes; the limit is ${OUTLINE_LIMITS.maxBodyBytes}`,
				"OUTLINE_BODY_TOO_LARGE",
				i,
			);
		}
		totalBytes += bytes;
		return content;
	});
	if (!stored && totalBytes > OUTLINE_LIMITS.maxTransactionBodyBytes) {
		throw new OutlineWriteError(
			`the transaction carries ${totalBytes} bytes of content; the limit is ${OUTLINE_LIMITS.maxTransactionBodyBytes}`,
			"OUTLINE_TRANSACTION_TOO_LARGE",
		);
	}
	ops.forEach((op, i) => {
		switch (op.op) {
			case "insert":
				if (op.parent !== null) checkRef(op.parent, "parent", i);
				checkPosition(op.position, i);
				checkAlias(op.alias, i);
				if (op.tags !== undefined) checkTags(op.tags, i);
				if (op.task !== undefined && op.task !== null) {
					if (op.task.status === undefined) throw invalid("a task needs a status", i);
					checkTaskFields(op.task, i);
				}
				if (op.id !== undefined && (typeof op.id !== "string" || !CLIENT_ID_RE.test(op.id)))
					throw invalid("id must be 8-64 characters of [A-Za-z0-9_-]", i);
				if (op.sid !== undefined) {
					if (typeof op.sid !== "string" || !isShortId(op.sid))
						throw invalid(`${JSON.stringify(op.sid)} is not a valid sid`, i);
					if (sids.has(op.sid)) throw invalid(`sid ${op.sid} is used twice`, i);
					sids.add(op.sid);
				}
				if (op.tempId !== undefined) {
					if (typeof op.tempId !== "string" || op.tempId === "")
						throw invalid("tempId must be a non-empty string", i);
					if (tempIds.has(op.tempId)) throw invalid(`tempId ${op.tempId} is used twice`, i);
					tempIds.add(op.tempId);
				}
				break;
			case "update":
				checkRef(op.block, "block", i);
				checkBase(op, i);
				checkAlias(op.alias, i);
				if (op.tags !== undefined) checkTags(op.tags, i);
				if (op.merged !== undefined && typeof op.merged !== "boolean")
					throw invalid("merged must be a boolean", i);
				break;
			case "move":
				checkRef(op.block, "block", i);
				checkBase(op, i);
				if (op.parent !== null) checkRef(op.parent, "parent", i);
				checkPosition(op.position, i);
				break;
			case "delete":
				checkRef(op.block, "block", i);
				checkBase(op, i);
				break;
			case "setTask":
				checkRef(op.block, "block", i);
				checkBase(op, i);
				if (op.task !== null) {
					if (!op.task || typeof op.task !== "object") throw invalid("task must be an object", i);
					checkTaskFields(op.task, i);
				}
				break;
			case "restore":
				checkRef(op.block, "block", i);
				checkBase(op, i);
				if (op.parent !== undefined && op.parent !== null) checkRef(op.parent, "parent", i);
				checkPosition(op.position, i);
				checkAlias(op.alias, i);
				if (op.tags !== undefined) checkTags(op.tags, i);
				if (op.task !== undefined && op.task !== null) {
					if (op.task.status === undefined) throw invalid("a task needs a status", i);
					checkTaskFields(op.task, i);
				}
				break;
		}
	});
	return sized.map((content, i) => {
		if (content === null) return null;
		if (stored) return prepareStoredContent(content, i);
		const given = canonical?.[i];
		return given ? prepareCanonicalContent(given, content, i) : prepareContent(content, i);
	});
}

const sameTask = sameTaskJson;

function canonicalTags(tags: readonly string[]): string[] {
	return [...new Set(tags.map((t) => t.trim()))];
}

function autoSummary(ops: readonly OutlineOp[]): string {
	const counts = new Map<string, number>();
	for (const op of ops) counts.set(op.op, (counts.get(op.op) ?? 0) + 1);
	return [...counts].map(([kind, n]) => `${kind} ${n}`).join(", ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Planning
// ─────────────────────────────────────────────────────────────────────────────

/** A sid drawn for a new block is already taken in the space: plan again with fresh ones. */
class SidCollision extends Error {}

/** A block as this transaction sees it: its state before (`base`) and after. */
interface WorkingBlock {
	id: string;
	sid: string;
	/** Null for a block created in this transaction. */
	base: OutlineBlockMeta | null;
	/** Whether the id was chosen by the caller. */
	callerId: boolean;
	/** Whether the sid was chosen by the caller. */
	callerSid?: boolean;
	parentId: string | null;
	pageId: string;
	orderKey: string;
	deleted: boolean;
	alias: string | null;
	taskJson: OutlineTaskJson | null;
	contentHash: string;
	/** Set when this transaction wrote the content. */
	content?: string;
	contentLinks?: ExtractedLink[];
	/** Set when this transaction replaced the tags. */
	tags?: string[];
	/** Brought back by a `restore` operation of this transaction. */
	restored?: boolean;
	/** Written by a merged `update` (`OUTLINE_CHANGE.MERGE`). */
	merged?: boolean;
	/** `in_process` after this transaction (the stored value until `planInProcess` runs). */
	inProcess: boolean;
}

/** Who a commit's claims go to; see TASK CLAIMS in the header. */
type OutlineClaimer =
	| { narratorId: string; userId?: undefined }
	| { userId: string; narratorId?: undefined };

function claimerOf(input: OutlineWriteInput, compensating: boolean): OutlineClaimer | null {
	if (compensating) return null;
	if (input.actor.kind === "agent") return { narratorId: input.narratorId ?? input.actor.id };
	if (input.actor.kind === "human") return { userId: input.actor.id };
	return input.narratorId ? { narratorId: input.narratorId } : null;
}

function holdsClaim(row: OutlineTaskClaimRow, claimer: OutlineClaimer): boolean {
	return claimer.narratorId !== undefined
		? row.holderNarratorId === claimer.narratorId
		: row.holderUserId === claimer.userId;
}

/** Someone other than `claimer` holds the claim and it still counts at `now`. */
function heldByOther(row: OutlineTaskClaimRow, claimer: OutlineClaimer, now: string): boolean {
	if (holdsClaim(row, claimer)) return false;
	if (row.holderUserId !== null) return true;
	return row.holderNarratorId !== null && (row.expiresAt === null || row.expiresAt > now);
}

/** Key of the children list of a parent; the space's pages are under `null`. */
const PAGES = "\u0000pages";
const listKey = (parentId: string | null) => parentId ?? PAGES;

interface Planned {
	plan: OutlineCommitPlan;
	pageIds: string[];
}

class OutlinePlanner {
	private readonly blocks = new Map<string, WorkingBlock>();
	private readonly bySid = new Map<string, string>();
	private readonly children = new Map<string, string[]>();
	private readonly aliasOwner = new Map<string, string | null>();
	private readonly temp = new Map<string, string>();
	/** Blocks an operation set to in progress, with the operation's index: claim attempts. */
	private readonly claimIntent = new Map<string, number>();
	readonly results: OutlineOpResult[] = [];

	constructor(
		private readonly store: OutlineStore,
		private readonly space: OutlineSpaceRow,
		private readonly input: OutlineWriteInput,
		private readonly prepared: ReadonlyArray<PreparedContent | null>,
		private readonly now: string,
		private readonly commitKind: OutlineCommitKind = "edit",
		private readonly leaseExpiry: readonly string[] = [],
	) {
		this.claimer = claimerOf(input, commitKind === "revert");
	}

	private readonly claimer: OutlineClaimer | null;

	/** A compensating commit drops taken aliases instead of failing. */
	private get compensating(): boolean {
		return this.commitKind === "revert";
	}

	async plan(): Promise<Planned | null> {
		await this.preload();
		this.checkBaseVersions();
		for (const [i, op] of this.input.ops.entries()) {
			switch (op.op) {
				case "insert":
					await this.insert(op, i);
					break;
				case "update":
					await this.update(op, i);
					break;
				case "move":
					await this.move(op, i);
					break;
				case "delete":
					await this.delete(op, i);
					break;
				case "setTask":
					await this.setTask(op, i);
					break;
				case "restore":
					await this.restore(op, i);
					break;
			}
		}
		return this.assemble();
	}

	// ── working copy ─────────────────────────────────────────────────────────

	private address(sid: string): string {
		return `${this.space.key}/${sid}`;
	}

	private adopt(meta: OutlineBlockMeta): void {
		if (this.blocks.has(meta.id)) return;
		this.blocks.set(meta.id, {
			id: meta.id,
			sid: meta.sid,
			base: meta,
			callerId: false,
			parentId: meta.parentId,
			pageId: meta.pageId,
			orderKey: meta.orderKey,
			deleted: meta.deleted,
			alias: meta.alias,
			taskJson: meta.taskJson,
			contentHash: meta.contentHash,
			inProcess: meta.inProcess,
		});
		this.bySid.set(meta.sid, meta.id);
	}

	// ── tasks ────────────────────────────────────────────────────────────────

	/** The writer as a task field names it. */
	private get writer(): OutlineTaskActorRef {
		return { kind: this.input.actor.kind, id: this.input.actor.id };
	}

	/**
	 * The task a block gets from `given`: over `current` (a `setTask` patch) or in its place
	 * (`whole`: an insert or a restore). A block that becomes a task gets the writer as its
	 * manager unless the input names one; a compensating commit restores exactly what it read.
	 */
	private taskFrom(
		current: OutlineTaskJson | null,
		given: OutlineTaskPatch,
		whole: boolean,
		opIndex: number,
	): OutlineTaskJson {
		const base = whole ? null : current;
		const status = given.status ?? base?.status;
		if (status === undefined) throw invalid("a new task needs a status", opIndex);
		const pick = <T>(value: T | undefined, fallback: T): T =>
			value !== undefined ? value : fallback;
		return canonicalTaskJson({
			status,
			assignee: pick(given.assignee, base?.assignee ?? null),
			depends: pick(given.depends, base?.depends ?? null),
			due: pick(given.due, base?.due ?? null),
			manager: pick(
				given.manager,
				base ? (base.manager ?? null) : this.compensating ? null : this.writer,
			),
			humanCreated: pick(given.humanCreated, base?.humanCreated ?? null),
			lock:
				given.lock !== undefined
					? this.lockFrom(given.lock, base?.lock ?? null)
					: (base?.lock ?? null),
			claimable: pick(given.claimable, base?.claimable ?? null),
		});
	}

	/** A lock as stored: the version is this commit's seq unless the lock is unchanged. */
	private lockFrom(
		given: OutlineTaskLockInput | null,
		current: OutlineTaskLockJson | null,
	): OutlineTaskLockJson | null {
		if (given === null) return null;
		const by = given.by ? { kind: given.by.kind, id: given.by.id } : this.writer;
		const delegate = given.delegate ?? null;
		if (this.compensating && given.versionSeq !== undefined)
			return { by, delegate, versionSeq: given.versionSeq };
		const candidate = { by, delegate, versionSeq: current?.versionSeq ?? 0 };
		return current && sameTaskLock(candidate, current)
			? current
			: { by, delegate, versionSeq: this.space.nextSeq };
	}

	/** Record that operation `opIndex` set `block` to in progress (a claim attempt). */
	private noteClaim(block: WorkingBlock, opIndex: number): void {
		if (block.taskJson?.status === "doing") this.claimIntent.set(block.id, opIndex);
	}

	private async load(by: { ids?: string[]; sids?: string[] }): Promise<void> {
		const ids = (by.ids ?? []).filter((id) => !this.blocks.has(id));
		const sids = (by.sids ?? []).filter((sid) => !this.bySid.has(sid));
		if (ids.length === 0 && sids.length === 0) return;
		for (const meta of await this.store.getBlockMetas(this.space.id, { ids, sids })) {
			this.adopt(meta);
		}
	}

	/** Load every block the operations name, in one round. */
	private async preload(): Promise<void> {
		const ids: string[] = [];
		const sids: string[] = [];
		const add = (ref: OutlineBlockRef | null | undefined) => {
			if (!ref) return;
			if ("id" in ref) ids.push(ref.id);
			else if ("sid" in ref) sids.push(ref.sid);
		};
		for (const op of this.input.ops) {
			if (op.op !== "insert") add(op.block);
			if (op.op === "insert" || op.op === "move" || op.op === "restore") {
				add(op.parent);
				const p = op.position;
				if (p && "after" in p) add(p.after);
				if (p && "before" in p) add(p.before);
			}
		}
		await this.load({ ids: [...new Set(ids)], sids: [...new Set(sids)] });
	}

	/** The block a reference names, if this transaction has seen it; no loading. */
	private known(ref: OutlineBlockRef): WorkingBlock | undefined {
		const id =
			"tempId" in ref ? this.temp.get(ref.tempId) : "sid" in ref ? this.bySid.get(ref.sid) : ref.id;
		return id === undefined ? undefined : this.blocks.get(id);
	}

	private async resolve(ref: OutlineBlockRef, opIndex: number): Promise<WorkingBlock> {
		if ("tempId" in ref) {
			const block = this.known(ref);
			if (!block) throw invalid(`unknown tempId ${ref.tempId}`, opIndex);
			return block;
		}
		if ("id" in ref) await this.load({ ids: [ref.id] });
		else await this.load({ sids: [ref.sid] });
		const block = this.known(ref);
		if (!block) {
			throw new OutlineWriteError(
				`block ${"id" in ref ? ref.id : ref.sid} not found in this space`,
				"OUTLINE_BLOCK_NOT_FOUND",
				opIndex,
			);
		}
		return block;
	}

	private async resolveLive(ref: OutlineBlockRef, opIndex: number): Promise<WorkingBlock> {
		const block = await this.resolve(ref, opIndex);
		if (block.deleted) {
			throw new OutlineWriteError(
				`block ${this.address(block.sid)} is deleted`,
				"OUTLINE_BLOCK_DELETED",
				opIndex,
			);
		}
		return block;
	}

	private block(id: string): WorkingBlock {
		const block = this.blocks.get(id);
		if (!block) throw new Error(`outline planner lost block ${id}`);
		return block;
	}

	private list(parentId: string | null): string[] {
		const list = this.children.get(listKey(parentId));
		if (!list) throw new Error(`outline planner has no children list for ${parentId}`);
		return list;
	}

	private bySiblingOrder = (a: string, b: string): number =>
		compareOrderKeys(this.block(a).orderKey, this.block(b).orderKey) ||
		(a < b ? -1 : a > b ? 1 : 0);

	/**
	 * Load the live children lists of `parentIds` that this transaction has not loaded yet. A
	 * list is loaded before the transaction changes it, and from then on only the working copy
	 * changes it, so the loaded lists and the database agree on everything else.
	 */
	private async ensureChildren(
		parentIds: ReadonlyArray<string | null>,
		purpose: "siblings" | "subtree",
		opIndex: number | null,
	): Promise<void> {
		const missing = [...new Set(parentIds)].filter((p) => !this.children.has(listKey(p)));
		if (missing.length === 0) return;
		const limit =
			purpose === "siblings"
				? OUTLINE_LIMITS.maxSiblings * missing.length
				: OUTLINE_LIMITS.maxRowsTouched;
		const rows = await this.store.listChildMetas(this.space.id, missing, limit + 1);
		if (rows.length > limit) {
			throw purpose === "siblings"
				? new OutlineWriteError(
						`a parent has more than ${OUTLINE_LIMITS.maxSiblings} children`,
						"OUTLINE_TOO_MANY_SIBLINGS",
						opIndex,
					)
				: this.tooManyRows(opIndex);
		}
		const lists = new Map<string, string[]>(missing.map((p) => [listKey(p), []]));
		for (const row of rows) {
			this.adopt(row);
			lists.get(listKey(row.parentId))?.push(row.id);
		}
		for (const [key, list] of lists) {
			list.sort(this.bySiblingOrder);
			this.children.set(key, list);
		}
	}

	private tooManyRows(opIndex: number | null): OutlineWriteError {
		return new OutlineWriteError(
			`the transaction would write more than ${OUTLINE_LIMITS.maxRowsTouched} rows (block versions and links); split it into smaller transactions`,
			"OUTLINE_TOO_MANY_ROWS",
			opIndex,
		);
	}

	/** Every live descendant of `root` (not `root` itself), loading what is needed. */
	private async liveSubtree(root: WorkingBlock, opIndex: number): Promise<WorkingBlock[]> {
		const out: WorkingBlock[] = [];
		let frontier = [root.id];
		while (frontier.length > 0) {
			await this.ensureChildren(frontier, "subtree", opIndex);
			const next = frontier.flatMap((id) => this.list(id));
			for (const id of next) out.push(this.block(id));
			if (out.length > OUTLINE_LIMITS.maxRowsTouched) throw this.tooManyRows(opIndex);
			frontier = next;
		}
		return out;
	}

	/** Whether `candidate` is `root` or one of its live descendants. */
	private async isWithin(
		candidate: WorkingBlock,
		root: WorkingBlock,
		opIndex: number,
	): Promise<boolean> {
		// Live blocks share their page with every ancestor.
		if (candidate.pageId !== root.pageId) return false;
		let current: WorkingBlock | undefined = candidate;
		for (let depth = 0; current; depth++) {
			if (current.id === root.id) return true;
			if (depth >= OUTLINE_LIMITS.maxDepth) {
				throw new OutlineWriteError(
					`the outline is deeper than ${OUTLINE_LIMITS.maxDepth} levels`,
					"OUTLINE_TOO_DEEP",
					opIndex,
				);
			}
			const parentId: string | null = current.parentId;
			if (parentId === null) return false;
			await this.load({ ids: [parentId] });
			current = this.blocks.get(parentId);
		}
		return false;
	}

	/**
	 * Index and order key for a block placed in `list` (which does not contain it). `keep` is
	 * the block's current place when it moves within the same parent: landing there again
	 * keeps its key.
	 */
	private place(
		list: string[],
		position: OutlinePosition | undefined,
		opIndex: number,
		keep?: { index: number; orderKey: string },
	): { index: number; orderKey: string } {
		let index: number;
		if (!position || "last" in position) index = list.length;
		else if ("first" in position) index = 0;
		else if ("orderKey" in position) {
			const wanted = position.orderKey;
			index = 0;
			while (index < list.length && compareOrderKeys(this.key(list, index), wanted) <= 0) index++;
			// A key no sibling uses is taken as is; a used one places the block after its holder.
			if (index === 0 || this.key(list, index - 1) !== wanted) return { index, orderKey: wanted };
		} else {
			const anchorRef = "after" in position ? position.after : position.before;
			const anchor = this.known(anchorRef);
			const at = anchor ? list.indexOf(anchor.id) : -1;
			if (at < 0) throw invalid("the position's anchor is not a live child of the parent", opIndex);
			index = "after" in position ? at + 1 : at;
		}
		if (keep && keep.index === index) return { index, orderKey: keep.orderKey };
		return { index, orderKey: this.keyAt(list, index) };
	}

	private key(list: string[], index: number): string {
		return this.block(list[index] as string).orderKey;
	}

	private keyAt(list: string[], index: number): string {
		const before = index > 0 ? this.key(list, index - 1) : null;
		const after = index < list.length ? this.key(list, index) : null;
		try {
			return keyBetween(before, after);
		} catch (error) {
			if (error instanceof OrderKeyError) {
				throw new Error(`outline siblings out of order (${before} / ${after}): ${error.message}`);
			}
			throw error;
		}
	}

	private newBlock(fields: {
		id: string;
		callerId: boolean;
		/** Caller-chosen sid; drawn when absent. */
		sid?: string;
		opIndex?: number;
		parentId: string | null;
		pageId: string;
		orderKey: string;
		content: string;
		contentHash: string;
		links: ExtractedLink[];
		task: OutlineTaskJson | null;
	}): WorkingBlock {
		let sid = fields.sid ?? newOutlineSid();
		if (fields.sid !== undefined && this.bySid.has(sid)) {
			throw new OutlineWriteError(
				`sid ${sid} is already in use`,
				"OUTLINE_ID_TAKEN",
				fields.opIndex ?? null,
			);
		}
		while (this.bySid.has(sid)) sid = newOutlineSid();
		const block: WorkingBlock = {
			id: fields.id,
			sid,
			base: null,
			callerId: fields.callerId,
			...(fields.sid !== undefined ? { callerSid: true } : {}),
			parentId: fields.parentId,
			pageId: fields.pageId,
			orderKey: fields.orderKey,
			deleted: false,
			alias: null,
			taskJson: fields.task,
			contentHash: fields.contentHash,
			content: fields.content,
			contentLinks: fields.links,
			inProcess: false,
		};
		this.blocks.set(block.id, block);
		this.bySid.set(sid, block.id);
		this.children.set(listKey(block.id), []);
		return block;
	}

	/** Create `nodes` (and their descendants) as the first children of `parent`. */
	private insertSplit(
		parent: WorkingBlock,
		nodes: PreparedNode[],
		opIndex: number,
	): OutlineBlockAddressed[] {
		const created: OutlineBlockAddressed[] = [];
		const walk = (under: WorkingBlock, list: PreparedNode[]) => {
			if (list.length === 0) return;
			const siblings = this.list(under.id);
			const first = siblings.length > 0 ? this.key(siblings, 0) : null;
			const keys = keysBetween(null, first, list.length);
			list.forEach((node, k) => {
				const block = this.newBlock({
					id: generateId(),
					callerId: false,
					parentId: under.id,
					pageId: under.pageId,
					orderKey: keys[k] as string,
					content: node.content,
					contentHash: node.contentHash,
					links: node.links,
					task: node.task ? this.taskFrom(null, node.task, true, opIndex) : null,
				});
				this.noteClaim(block, opIndex);
				siblings.splice(k, 0, block.id);
				created.push({ blockId: block.id, sid: block.sid, address: this.address(block.sid) });
				walk(block, node.children);
			});
		};
		walk(parent, nodes);
		return created;
	}

	private releaseAlias(block: WorkingBlock): void {
		const alias = block.alias;
		if (alias === null) return;
		if (!this.aliasOwner.has(alias) || this.aliasOwner.get(alias) === block.id) {
			this.aliasOwner.set(alias, null);
		}
	}

	/**
	 * Give the block an alias. One held by another live block fails the write, or with `drop`
	 * leaves the block without an alias and returns the adjustment.
	 */
	private async setAlias(
		block: WorkingBlock,
		alias: string | null,
		opIndex: number,
		onTaken: "reject" | "drop" = "reject",
	): Promise<OutlineAdjustment | null> {
		if (alias === block.alias) return null;
		if (alias !== null) {
			if (!this.aliasOwner.has(alias)) {
				const owners = await this.store.findAliasOwners(this.space.id, [alias]);
				this.aliasOwner.set(alias, owners[0]?.id ?? null);
			}
			const owner = this.aliasOwner.get(alias);
			if (owner && owner !== block.id) {
				if (onTaken === "reject") {
					throw new OutlineWriteError(
						`alias ${alias} is already used by ${this.address(this.blocks.get(owner)?.sid ?? owner)}`,
						"OUTLINE_ALIAS_TAKEN",
						opIndex,
					);
				}
				this.releaseAlias(block);
				block.alias = null;
				return { kind: "alias-dropped", alias, heldBy: owner };
			}
		}
		this.releaseAlias(block);
		block.alias = alias;
		if (alias !== null) this.aliasOwner.set(alias, block.id);
		return null;
	}

	/** The adjustment of a placement that could not use the order key it asked for. */
	private keyAdjustment(
		position: OutlinePosition | undefined,
		orderKey: string,
	): OutlineAdjustment | null {
		return position && "orderKey" in position && position.orderKey !== orderKey
			? { kind: "order-key-moved", wanted: position.orderKey, got: orderKey }
			: null;
	}

	private checkBaseVersions(): void {
		const conflicts: OutlineVersionConflict[] = [];
		for (const [i, op] of this.input.ops.entries()) {
			if (op.op === "insert" || op.baseVersionSeq === undefined) continue;
			const block = this.known(op.block);
			// A missing block is reported by the operation itself.
			if (!block?.base) continue;
			if (block.base.versionSeq !== op.baseVersionSeq) {
				conflicts.push({
					opIndex: i,
					blockId: block.id,
					sid: block.sid,
					expectedVersionSeq: op.baseVersionSeq,
					actualVersionSeq: block.base.versionSeq,
				});
			}
		}
		if (conflicts.length > 0) throw new OutlineConflictError(conflicts);
	}

	private result(
		block: WorkingBlock,
		extra?: Partial<OutlineOpResult>,
		adjustments: ReadonlyArray<OutlineAdjustment | null> = [],
	): OutlineOpResult {
		const adjusted = adjustments.filter((a): a is OutlineAdjustment => a !== null);
		return {
			blockId: block.id,
			sid: block.sid,
			address: this.address(block.sid),
			split: [],
			notes: [],
			...extra,
			...(adjusted.length > 0 ? { adjustments: adjusted } : {}),
		};
	}

	private prep(opIndex: number): PreparedContent {
		const prep = this.prepared[opIndex];
		if (!prep) throw new Error(`outline operation ${opIndex} has no prepared content`);
		return prep;
	}

	// ── operations ───────────────────────────────────────────────────────────

	private async insert(op: Extract<OutlineOp, { op: "insert" }>, i: number): Promise<void> {
		const parent = op.parent ? await this.resolveLive(op.parent, i) : null;
		const parentId = parent?.id ?? null;
		await this.ensureChildren([parentId], "siblings", i);
		const list = this.list(parentId);
		const { index, orderKey } = this.place(list, op.position, i);
		const id = op.id ?? generateId();
		if (this.blocks.has(id)) {
			throw new OutlineWriteError(`block id ${id} is already in use`, "OUTLINE_ID_TAKEN", i);
		}
		const prep = this.prep(i);
		const block = this.newBlock({
			id,
			callerId: op.id !== undefined,
			...(op.sid !== undefined ? { sid: op.sid, opIndex: i } : {}),
			parentId,
			pageId: parent ? parent.pageId : id,
			orderKey,
			content: prep.content,
			contentHash: prep.contentHash,
			links: prep.links,
			task: op.task ? this.taskFrom(null, op.task, true, i) : null,
		});
		this.noteClaim(block, i);
		list.splice(index, 0, block.id);
		if (op.tempId !== undefined) this.temp.set(op.tempId, block.id);
		if (op.alias) await this.setAlias(block, op.alias, i);
		if (op.tags !== undefined) block.tags = canonicalTags(op.tags);
		const split = this.insertSplit(block, prep.split, i);
		this.results[i] = this.result(block, { split, notes: prep.notes }, [
			this.keyAdjustment(op.position, orderKey),
		]);
	}

	private async update(op: Extract<OutlineOp, { op: "update" }>, i: number): Promise<void> {
		const block = await this.resolveLive(op.block, i);
		let split: OutlineBlockAddressed[] = [];
		let notes: DialectNote[] = [];
		if (op.content !== undefined) {
			const prep = this.prep(i);
			block.content = prep.content;
			block.contentHash = prep.contentHash;
			block.contentLinks = prep.links;
			notes = prep.notes;
			if (prep.split.length > 0) {
				await this.ensureChildren([block.id], "siblings", i);
				split = this.insertSplit(block, prep.split, i);
			}
		}
		const aliasDropped =
			op.alias !== undefined
				? await this.setAlias(block, op.alias, i, this.compensating ? "drop" : "reject")
				: null;
		if (op.tags !== undefined) block.tags = canonicalTags(op.tags);
		if (op.merged) block.merged = true;
		this.results[i] = this.result(block, { split, notes }, [aliasDropped]);
	}

	private async move(op: Extract<OutlineOp, { op: "move" }>, i: number): Promise<void> {
		const block = await this.resolveLive(op.block, i);
		const parent = op.parent ? await this.resolveLive(op.parent, i) : null;
		if (parent && (await this.isWithin(parent, block, i))) {
			throw new OutlineWriteError(
				`cannot move ${this.address(block.sid)} under itself`,
				"OUTLINE_CYCLE",
				i,
			);
		}
		const parentId = parent?.id ?? null;
		await this.ensureChildren([block.parentId, parentId], "siblings", i);
		const from = this.list(block.parentId);
		const fromIndex = from.indexOf(block.id);
		if (fromIndex < 0) throw new Error(`outline block ${block.id} missing from its parent's list`);
		from.splice(fromIndex, 1);
		const to = this.list(parentId);
		const keep =
			parentId === block.parentId ? { index: fromIndex, orderKey: block.orderKey } : undefined;
		const { index, orderKey } = this.place(to, op.position, i, keep);
		to.splice(index, 0, block.id);
		block.parentId = parentId;
		block.orderKey = orderKey;
		const pageId = parent ? parent.pageId : block.id;
		if (pageId !== block.pageId) {
			// A subtree that changes page takes every live descendant with it.
			for (const descendant of await this.liveSubtree(block, i)) descendant.pageId = pageId;
			block.pageId = pageId;
		}
		this.results[i] = this.result(block, {}, [this.keyAdjustment(op.position, orderKey)]);
	}

	private async delete(op: Extract<OutlineOp, { op: "delete" }>, i: number): Promise<void> {
		const block = await this.resolveLive(op.block, i);
		await this.ensureChildren([block.parentId], "siblings", i);
		const siblings = this.list(block.parentId);
		const at = siblings.indexOf(block.id);
		if (at < 0) throw new Error(`outline block ${block.id} missing from its parent's list`);
		siblings.splice(at, 1);
		for (const target of [block, ...(await this.liveSubtree(block, i))]) {
			this.releaseAlias(target);
			target.deleted = true;
		}
		this.results[i] = this.result(block);
	}

	private async setTask(op: Extract<OutlineOp, { op: "setTask" }>, i: number): Promise<void> {
		const block = await this.resolveLive(op.block, i);
		if (op.task === null) block.taskJson = null;
		else {
			block.taskJson = this.taskFrom(block.taskJson, op.task, false, i);
			// Naming the status `doing` is starting the task, even when it was in progress already.
			if (op.task.status === "doing") this.noteClaim(block, i);
		}
		this.results[i] = this.result(block);
	}

	private async restore(op: Extract<OutlineOp, { op: "restore" }>, i: number): Promise<void> {
		const block = await this.resolve(op.block, i);
		if (!block.deleted) {
			throw invalid(`block ${this.address(block.sid)} is not deleted`, i);
		}
		// A deleted block has no live descendants, so no live parent can be inside it.
		const parentRef: OutlineBlockRef | null =
			op.parent !== undefined ? op.parent : block.parentId === null ? null : { id: block.parentId };
		const parent = parentRef ? await this.resolveLive(parentRef, i) : null;
		const parentId = parent?.id ?? null;
		await this.ensureChildren([parentId], "siblings", i);
		const list = this.list(parentId);
		const position = op.position ?? { orderKey: block.orderKey };
		const { index, orderKey } = this.place(list, position, i);
		list.splice(index, 0, block.id);
		block.deleted = false;
		block.restored = true;
		block.parentId = parentId;
		block.orderKey = orderKey;
		block.pageId = parent ? parent.pageId : block.id;
		// Children deleted with it (earlier in this transaction) stay deleted.
		const own = this.children.get(listKey(block.id));
		if (own)
			this.children.set(
				listKey(block.id),
				own.filter((id) => !this.block(id).deleted),
			);

		let split: OutlineBlockAddressed[] = [];
		let notes: DialectNote[] = [];
		if (op.content !== undefined) {
			const prep = this.prep(i);
			block.content = prep.content;
			block.contentHash = prep.contentHash;
			block.contentLinks = prep.links;
			notes = prep.notes;
			if (prep.split.length > 0) {
				await this.ensureChildren([block.id], "siblings", i);
				split = this.insertSplit(block, prep.split, i);
			}
		} else if (block.contentLinks === undefined) {
			// The row keeps the content a deleted block had; its links are what it produces.
			const row = (await this.store.getBlocks([block.id]))[0];
			block.contentLinks = contentLinks(row?.content ?? "");
		}
		if (op.task !== undefined)
			block.taskJson = op.task ? this.taskFrom(null, op.task, true, i) : null;
		if (op.tags !== undefined) block.tags = canonicalTags(op.tags);
		else if (block.base?.deleted) {
			// The tags it had just before it was deleted.
			const tags = await this.store.listLinksAt(
				[block.id],
				block.base.versionSeq - 1,
				["tag"],
				OUTLINE_LIMITS.maxTagsPerBlock,
			);
			block.tags = tags.map((link) => link.targetRef);
		}
		// A deleted block keeps its alias without holding it (another block may have taken it
		// since): it gets it back only if it is free.
		const alias = op.alias !== undefined ? op.alias : block.alias;
		block.alias = null;
		const aliasDropped = await this.setAlias(block, alias, i, "drop");
		this.results[i] = this.result(block, { split, notes }, [
			aliasDropped,
			this.keyAdjustment(position, orderKey),
		]);
	}

	// ── the commit ───────────────────────────────────────────────────────────

	private async assemble(): Promise<Planned | null> {
		// May load more blocks (ancestors, children whose in-process changes): before `all`.
		await this.planInProcess();
		const all = [...this.blocks.values()];
		const created = all.filter((b) => b.base === null);
		await this.checkNewIdentities(created);

		const existing = all.filter((b) => b.base !== null);
		const versioned = existing.filter((b) => b.tags !== undefined || this.baseFlags(b) !== 0);

		// Open links of existing blocks whose links may change. Tombstoning a subtree closes all
		// of its links, so that load is bounded by the row budget; the others by the per-block cap.
		const budget = OUTLINE_LIMITS.maxRowsTouched - versioned.length - created.length;
		if (budget < 0) throw this.tooManyRows(null);
		const deletedNow = versioned.filter((b) => b.deleted);
		const kept = versioned.filter((b) => !b.deleted && this.linksMayChange(b));
		const openLinks = new Map<string, OutlineLinkRow[]>();
		const deletedLinks = await this.store.listOpenLinks(
			deletedNow.map((b) => b.id),
			budget + 1,
		);
		if (deletedLinks.length > budget) throw this.tooManyRows(null);
		const keptLinks = await this.store.listOpenLinks(
			kept.map((b) => b.id),
			kept.length * OUTLINE_LIMITS.maxLinksPerBlock + 1,
		);
		for (const link of [...deletedLinks, ...keptLinks]) {
			const list = openLinks.get(link.fromBlockId);
			if (list) list.push(link);
			else openLinks.set(link.fromBlockId, [link]);
		}

		const seq = this.space.nextSeq;
		const versions = new Map<number, string[]>();
		const patches = new Map<string, { ids: string[]; patch: OutlineBlockPatch }>();
		const closeVersionIds: string[] = [];
		const insertBlocks: OutlineBlockRow[] = [];
		const closeLinkIds: string[] = [];
		const insertLinks: OutlineLinkRow[] = [];
		const pageIds = new Set<string>();

		for (const block of all) {
			const linkChange = this.linkChanges(block, openLinks.get(block.id) ?? []);
			let flags =
				block.base === null
					? OUTLINE_CHANGE.CREATE | (block.deleted ? OUTLINE_CHANGE.DELETE : 0)
					: this.baseFlags(block);
			if (block.base !== null && linkChange.tagsChanged) flags |= OUTLINE_CHANGE.PROPS;
			if (flags === 0) continue;
			if (block.merged) flags |= OUTLINE_CHANGE.MERGE;

			const ids = versions.get(flags);
			if (ids) ids.push(block.id);
			else versions.set(flags, [block.id]);
			closeLinkIds.push(...linkChange.close);
			for (const link of linkChange.open) {
				insertLinks.push({
					id: generateId(),
					spaceId: this.space.id,
					fromBlockId: block.id,
					...link,
					fromSeq: seq,
					toSeq: null,
				});
			}
			pageIds.add(block.pageId);

			if (block.base === null) {
				insertBlocks.push(this.newRow(block, seq));
				continue;
			}
			pageIds.add(block.base.pageId);
			closeVersionIds.push(block.id);
			const patch = this.patchOf(block, flags);
			const key = JSON.stringify(patch);
			const group = patches.get(key);
			if (group) group.ids.push(block.id);
			else patches.set(key, { ids: [block.id], patch });
		}

		const versionedIds = new Set([...closeVersionIds, ...insertBlocks.map((b) => b.id)]);
		const inProcess = new Map<boolean, string[]>();
		for (const block of existing) {
			if (block.deleted || block.inProcess === (block.base as OutlineBlockMeta).inProcess) continue;
			const list = inProcess.get(block.inProcess);
			if (list) list.push(block.id);
			else inProcess.set(block.inProcess, [block.id]);
		}
		const inProcessOnly = [...inProcess.values()]
			.flat()
			.filter((id) => !versionedIds.has(id)).length;
		const claims = await this.planClaims(versionedIds, seq);
		const claimRows = claims.put.length + claims.release.length + claims.expire.length;

		const touched = closeVersionIds.length + insertBlocks.length;
		// A claim taken over without the task changing (it was in progress already) is a commit
		// of its own: it changes who is doing the task.
		if (touched === 0 && claims.put.length === 0 && claims.expire.length === 0) return null;
		if (
			touched + closeLinkIds.length + insertLinks.length + inProcessOnly + claimRows >
			OUTLINE_LIMITS.maxRowsTouched
		) {
			throw this.tooManyRows(null);
		}

		const { input } = this;
		const summary = (input.summary?.trim() || autoSummary(input.ops)).slice(
			0,
			OUTLINE_LIMITS.maxSummaryChars,
		);
		return {
			plan: {
				spaceId: this.space.id,
				seq,
				commit: {
					id: generateId(),
					spaceId: this.space.id,
					seq,
					kind: this.commitKind,
					actorKind: input.actor.kind,
					actorId: input.actor.id,
					responsibleUserId: input.responsibleUserId,
					narratorId: input.narratorId ?? null,
					messageId: input.messageId ?? null,
					toolCallId: input.toolCallId ?? null,
					createdAt: this.now,
					summary,
				},
				closeVersionIds,
				patchBlocks: [...patches.values()],
				insertBlocks,
				versions: [...versions].map(([flags, ids]) => ({ ids, flags })),
				closeLinkIds,
				insertLinks,
				inProcess: [...inProcess].map(([value, ids]) => ({ ids, value })),
				claims,
			},
			pageIds: [...pageIds],
		};
	}

	/**
	 * Derive `in_process` (design §2.1: a task, under a task, or in a session space) for every
	 * live block whose answer this transaction may change: new and restored blocks, moved
	 * blocks, blocks that became or stopped being tasks, and, under any of them whose answer
	 * changed, the descendants it changes. When an existing block is among them, the answer of
	 * each on the way is computed from the page down (its ancestors loaded level by level), so
	 * another change of the same commit above it, or a stale stored value (before the one-time
	 * rebuild), does not leak in. Walking down stops where the answer does not change; the blocks
	 * it visits count against the commit's row limit.
	 */
	private async planInProcess(): Promise<void> {
		const live = [...this.blocks.values()].filter((b) => !b.deleted);
		if (this.space.kind === "session") {
			for (const block of live) block.inProcess = true;
			return;
		}
		const isTask = (b: WorkingBlock) => b.taskJson !== null;
		const roots = live.filter(
			(b) =>
				b.base === null ||
				b.restored === true ||
				b.base.deleted ||
				b.parentId !== b.base.parentId ||
				(b.base.taskJson !== null) !== isTask(b),
		);
		if (roots.length === 0) return;
		if (roots.every((b) => b.base === null)) {
			// Only new blocks (the common insert): no existing block's answer changes, so a parent
			// that existed already keeps its stored answer. (Before a space's one-time rebuild that
			// answer may be stale; the rebuild rewrites the page afterwards.)
			const known = new Map<string, boolean>();
			const newAnswer = (block: WorkingBlock): boolean => {
				if (block.base !== null) return block.inProcess;
				const memo = known.get(block.id);
				if (memo !== undefined) return memo;
				const parent = block.parentId === null ? undefined : this.blocks.get(block.parentId);
				if (block.parentId !== null && !parent)
					throw new Error(`outline planner lost the parent of ${block.id}`);
				const answer = isTask(block) || (parent ? newAnswer(parent) : false);
				known.set(block.id, answer);
				return answer;
			};
			for (const root of roots) root.inProcess = newAnswer(root);
			return;
		}

		// Every ancestor of every root, loaded level by level.
		const complete = new Set<string>();
		for (let round = 0; ; round++) {
			const missing = new Set<string>();
			for (const root of roots) {
				const path: string[] = [];
				let current: WorkingBlock = root;
				for (;;) {
					if (complete.has(current.id) || current.parentId === null) {
						for (const id of path) complete.add(id);
						complete.add(current.id);
						break;
					}
					path.push(current.id);
					const parent = this.blocks.get(current.parentId);
					if (!parent) {
						missing.add(current.parentId);
						break;
					}
					current = parent;
					if (path.length > OUTLINE_LIMITS.maxDepth) throw this.tooDeep();
				}
			}
			if (missing.size === 0) break;
			if (round > OUTLINE_LIMITS.maxDepth) throw this.tooDeep();
			await this.load({ ids: [...missing] });
			for (const id of missing) {
				if (!this.blocks.has(id))
					throw new Error(`outline block ${id} has a parent outside its space`);
			}
		}

		// The answer along each chain, from the page down.
		const value = new Map<string, boolean>();
		const answerOf = (block: WorkingBlock): boolean => {
			const path: WorkingBlock[] = [];
			let current: WorkingBlock | undefined = block;
			while (current && !value.has(current.id)) {
				path.push(current);
				current = current.parentId === null ? undefined : this.blocks.get(current.parentId);
			}
			let above = current ? (value.get(current.id) as boolean) : false;
			for (let i = path.length - 1; i >= 0; i--) {
				const b = path[i] as WorkingBlock;
				above = isTask(b) || above;
				value.set(b.id, above);
			}
			return value.get(block.id) as boolean;
		};
		for (const root of roots) answerOf(root);

		// Down from every root whose answer changed, while it keeps changing. Only the roots and
		// what this walk reaches are written: an ancestor whose stored answer is merely stale (a
		// space the one-time rebuild has not reached) is left to the rebuild, so stale data never
		// makes a write walk, or refuse, a subtree it did not change.
		const answers = new Map<string, boolean>();
		for (const root of roots) answers.set(root.id, value.get(root.id) as boolean);
		const differs = (b: WorkingBlock) => b.base !== null && b.base.inProcess !== answers.get(b.id);
		const queued = new Set(roots.map((b) => b.id));
		let frontier = roots.filter(differs);
		let visited = 0;
		while (frontier.length > 0) {
			await this.ensureChildren(
				frontier.map((b) => b.id),
				"subtree",
				null,
			);
			const next: WorkingBlock[] = [];
			for (const parent of frontier) {
				const above = answers.get(parent.id) as boolean;
				for (const id of this.list(parent.id)) {
					const child = this.block(id);
					// A root below has its own answer, computed from the page down.
					if (child.deleted || queued.has(id)) continue;
					answers.set(id, isTask(child) || above);
					if (++visited > OUTLINE_LIMITS.maxRowsTouched) throw this.tooManyRows(null);
					if (differs(child)) {
						queued.add(id);
						next.push(child);
					}
				}
			}
			frontier = next;
		}
		for (const [id, v] of answers) this.block(id).inProcess = v;
	}

	private tooDeep(): OutlineWriteError {
		return new OutlineWriteError(
			`the outline is deeper than ${OUTLINE_LIMITS.maxDepth} levels`,
			"OUTLINE_TOO_DEEP",
		);
	}

	/**
	 * What this commit does to task claims (see TASK CLAIMS at the top): release the claims of
	 * tasks that leave in progress, take or refuse the claims operations asked for, and, for a
	 * lease expiry, check the claims are still the expired ones listed.
	 */
	private async planClaims(versioned: ReadonlySet<string>, seq: number): Promise<OutlineClaimPlan> {
		const doingNow = (b: WorkingBlock) => !b.deleted && b.taskJson?.status === "doing";
		const doingBefore = (b: WorkingBlock) =>
			b.base !== null && !b.base.deleted && b.base.taskJson?.status === "doing";
		const claimer = this.claimer;
		const intents = claimer ? [...this.claimIntent].filter(([id]) => doingNow(this.block(id))) : [];
		const expiring = new Set(this.leaseExpiry);
		const ids = [...new Set([...intents.map(([id]) => id), ...expiring])];
		const rows = new Map(
			(ids.length > 0 ? await this.store.getTaskClaims(ids) : []).map((r) => [r.taskBlockId, r]),
		);
		const plan: OutlineClaimPlan = { put: [], release: [], expire: [] };

		const notExpired: string[] = [];
		for (const id of expiring) {
			const block = this.blocks.get(id);
			const row = rows.get(id);
			if (
				!block ||
				!doingBefore(block) ||
				doingNow(block) ||
				!row ||
				row.holderNarratorId === null ||
				row.expiresAt === null ||
				row.expiresAt > this.now
			) {
				notExpired.push(id);
			} else plan.expire.push({ expect: row });
		}
		if (notExpired.length > 0) throw new OutlineLeaseNotExpiredError(notExpired);

		for (const block of this.blocks.values()) {
			if (doingBefore(block) && !doingNow(block) && !expiring.has(block.id))
				plan.release.push(block.id);
		}

		if (!claimer) return plan;
		for (const [id, opIndex] of intents) {
			const block = this.block(id);
			const row = rows.get(id) ?? null;
			const fresh = (epoch: number): OutlineTaskClaimRow => ({
				taskBlockId: id,
				holderNarratorId: claimer.narratorId ?? null,
				holderUserId: claimer.userId ?? null,
				epoch,
				taskVersionAtClaim: versioned.has(id) ? seq : (block.base?.versionSeq ?? seq),
				claimedAt: this.now,
				expiresAt: claimer.narratorId !== undefined ? outlineLeaseEnd(this.now) : null,
			});
			if (!row) {
				plan.put.push({ row: fresh(1), expect: null });
			} else if (holdsClaim(row, claimer)) {
				// Its own claim: only a session's lapsed lease needs anything (a renewal).
				if (row.holderNarratorId !== null && row.expiresAt !== null && row.expiresAt <= this.now)
					plan.put.push({ row: { ...row, expiresAt: outlineLeaseEnd(this.now) }, expect: row });
			} else if (heldByOther(row, claimer, this.now)) {
				throw new OutlineTaskClaimedError(
					id,
					this.address(block.sid),
					row.holderUserId !== null
						? { kind: "human", userId: row.holderUserId }
						: {
								kind: "agent",
								narratorId: row.holderNarratorId as string,
								expiresAt: row.expiresAt,
							},
					opIndex,
				);
			} else {
				plan.put.push({ row: fresh(row.epoch + 1), expect: row });
			}
		}
		return plan;
	}

	/**
	 * Sids of new blocks must be free in the space (a drawn one that is not is drawn again, a
	 * caller-chosen one fails the write); caller-chosen ids must be free anywhere.
	 */
	private async checkNewIdentities(created: WorkingBlock[]): Promise<void> {
		if (created.length === 0) return;
		const taken = await this.store.getBlockMetas(this.space.id, {
			sids: created.map((b) => b.sid),
		});
		const takenSids = new Set(taken.map((b) => b.sid));
		const chosen = created.find((b) => b.callerSid && takenSids.has(b.sid));
		if (chosen) {
			throw new OutlineWriteError(
				`sid ${chosen.sid} is already in use`,
				"OUTLINE_ID_TAKEN",
				this.input.ops.findIndex((op) => op.op === "insert" && op.sid === chosen.sid),
			);
		}
		if (taken.length > 0) throw new SidCollision();
		const callerIds = created.filter((b) => b.callerId).map((b) => b.id);
		if (callerIds.length === 0) return;
		const used = await this.store.findExistingBlockIds(callerIds);
		if (used.length > 0) {
			throw new OutlineWriteError(
				`block id ${used[0]} is already in use`,
				"OUTLINE_ID_TAKEN",
				this.input.ops.findIndex((op) => op.op === "insert" && op.id === used[0]),
			);
		}
	}

	/** Whether a live existing block's state that produces links changed. */
	private linksMayChange(block: WorkingBlock): boolean {
		return (
			block.restored === true ||
			block.tags !== undefined ||
			block.contentHash !== block.base?.contentHash ||
			!sameTask(block.taskJson, block.base?.taskJson ?? null)
		);
	}

	/** Change flags of an existing block from its own columns (tags are links, added later). */
	private baseFlags(block: WorkingBlock): number {
		const base = block.base;
		if (!base) return 0;
		let flags = 0;
		if (block.contentHash !== base.contentHash) flags |= OUTLINE_CHANGE.CONTENT;
		if (block.parentId !== base.parentId || block.orderKey !== base.orderKey)
			flags |= OUTLINE_CHANGE.MOVE;
		if (block.pageId !== base.pageId) flags |= OUTLINE_CHANGE.PAGE;
		if (block.deleted && !base.deleted) flags |= OUTLINE_CHANGE.DELETE;
		if (!block.deleted && base.deleted) flags |= OUTLINE_CHANGE.RESTORE;
		if (!sameTask(block.taskJson, base.taskJson)) flags |= OUTLINE_CHANGE.TASK;
		if (block.alias !== base.alias) flags |= OUTLINE_CHANGE.PROPS;
		return flags;
	}

	/** Link rows to close and open so the block's open links match its new state. */
	private linkChanges(
		block: WorkingBlock,
		open: OutlineLinkRow[],
	): { close: string[]; open: ExtractedLink[]; tagsChanged: boolean } {
		if (block.deleted) {
			// A deleted block links nowhere; a block created and deleted here never linked.
			return { close: open.map((l) => l.id), open: [], tagsChanged: false };
		}
		// A restored block's links are all recomputed: a deleted block has none open.
		const isNew = block.base === null || block.restored === true;
		const groups: Array<{ kinds: ReadonlySet<OutlineLinkKind>; want: ExtractedLink[] }> = [];
		if (isNew || block.contentHash !== block.base?.contentHash) {
			groups.push({ kinds: CONTENT_LINK_KINDS, want: block.contentLinks ?? [] });
		}
		if (isNew || !sameTask(block.taskJson, block.base?.taskJson ?? null)) {
			groups.push({ kinds: TASK_LINK_KINDS, want: dependsLinks(block.taskJson) });
		}
		if (block.tags !== undefined)
			groups.push({ kinds: TAG_LINK_KINDS, want: tagLinks(block.tags) });

		const close: string[] = [];
		const add: ExtractedLink[] = [];
		let tagsChanged = false;
		for (const { kinds, want } of groups) {
			const have = open.filter((l) => kinds.has(l.kind));
			const wanted = new Set(want.map(linkKey));
			const had = new Set(have.map(linkKey));
			const closing = have.filter((l) => !wanted.has(linkKey(l)));
			const adding = want.filter((l) => !had.has(linkKey(l)));
			close.push(...closing.map((l) => l.id));
			add.push(...adding);
			if (kinds === TAG_LINK_KINDS && (closing.length > 0 || adding.length > 0)) tagsChanged = true;
		}
		if (open.length - close.length + add.length > OUTLINE_LIMITS.maxLinksPerBlock) {
			throw new OutlineWriteError(
				`${this.address(block.sid)} would hold more than ${OUTLINE_LIMITS.maxLinksPerBlock} links`,
				"OUTLINE_TOO_MANY_LINKS",
			);
		}
		return { close, open: add, tagsChanged };
	}

	private patchOf(block: WorkingBlock, flags: number): OutlineBlockPatch {
		const base = block.base as OutlineBlockMeta;
		const patch: OutlineBlockPatch = {};
		if (block.parentId !== base.parentId) patch.parentId = block.parentId;
		if (block.orderKey !== base.orderKey) patch.orderKey = block.orderKey;
		if (block.pageId !== base.pageId) patch.pageId = block.pageId;
		if (flags & OUTLINE_CHANGE.CONTENT) {
			patch.content = block.content;
			patch.contentHash = block.contentHash;
			patch.authorKind = this.input.actor.kind;
			patch.authorId = this.input.actor.id;
		}
		if (block.alias !== base.alias) patch.alias = block.alias;
		if (flags & OUTLINE_CHANGE.TASK) patch.taskJson = block.taskJson;
		if (block.deleted !== base.deleted) patch.deleted = block.deleted;
		return patch;
	}

	private newRow(block: WorkingBlock, seq: number): OutlineBlockRow {
		return {
			id: block.id,
			spaceId: this.space.id,
			sid: block.sid,
			parentId: block.parentId,
			pageId: block.pageId,
			orderKey: block.orderKey,
			content: block.content ?? "",
			contentHash: block.contentHash,
			alias: block.alias,
			taskJson: block.taskJson,
			authorKind: this.input.actor.kind,
			authorId: this.input.actor.id,
			versionSeq: seq,
			deleted: block.deleted,
			inProcess: block.inProcess,
		};
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write one outline transaction as one commit. Rejects with `OutlineWriteError` (invalid or too
 * large), `OutlineConflictError` (a `baseVersionSeq` no longer matches), `OutlineBusyError` or a
 * `NotFoundError`-shaped `OutlineWriteError`; nothing is written when it rejects.
 */
export async function writeOutline(
	input: OutlineWriteInput,
	options: OutlineWriteOptions = {},
): Promise<OutlineWriteResult> {
	const prepared = prepareOps(input.ops, options.compensating !== undefined, options.canonical);
	// A page of the space may be open in a live session: its unflushed edits are written first
	// and this write reaches the session as a remote change (`live-barrier.ts`).
	return await withOutlineLiveBarrier(input.spaceId, () => writePrepared(input, options, prepared));
}

async function writePrepared(
	input: OutlineWriteInput,
	options: OutlineWriteOptions,
	prepared: Array<PreparedContent | null>,
): Promise<OutlineWriteResult> {
	const store = options.store ?? outlineStore;
	const compensating = options.compensating;
	const attempts = options.maxAttempts ?? DEFAULT_ATTEMPTS;
	for (let attempt = 0; attempt < attempts; attempt++) {
		const space = await store.getSpace(input.spaceId);
		if (!space) throw new NotFoundError("Outline space", input.spaceId);
		if (compensating && space.nextSeq !== compensating.expectNextSeq) {
			throw new OutlineStaleWriteError(space.id, compensating.expectNextSeq);
		}
		const now = (options.now?.() ?? new Date()).toISOString();
		const planner = new OutlinePlanner(
			store,
			space,
			input,
			prepared,
			now,
			compensating ? "revert" : "edit",
			options.leaseExpiry?.blockIds ?? [],
		);
		let planned: Planned | null;
		try {
			planned = await planner.plan();
		} catch (error) {
			if (error instanceof SidCollision) continue;
			throw error;
		}
		if (!planned) {
			return { spaceId: space.id, commit: null, pageIds: [], results: planner.results };
		}
		try {
			await store.applyCommit(planned.plan);
		} catch (error) {
			if (error instanceof OutlineStaleWriteError) continue;
			if (
				error instanceof WriteConflictError &&
				CALLER_ID_CONSTRAINTS.has(error.constraint ?? "")
			) {
				throw new OutlineWriteError(
					"a caller-chosen block id was taken concurrently",
					"OUTLINE_ID_TAKEN",
				);
			}
			throw error;
		}
		const { commit } = planned.plan;
		eventBus.emit({
			type: "outline:committed",
			spaceId: space.id,
			commitId: commit.id,
			seq: commit.seq,
			pageIds: planned.pageIds,
			actorKind: commit.actorKind,
			actorId: commit.actorId,
		});
		return {
			spaceId: space.id,
			commit: { id: commit.id, seq: commit.seq },
			pageIds: planned.pageIds,
			results: planner.results,
		};
	}
	throw new OutlineBusyError(input.spaceId, attempts);
}
