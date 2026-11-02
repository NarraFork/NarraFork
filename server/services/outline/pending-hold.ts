/**
 * Operations held for confirmation, as the write path hands them over (`write.ts`, LOCKED PLANS
 * AND PENDING CONFIRMATION), turned into the `outline_pending` row the write puts: a new row, or
 * the proposal merged into the open change the writer's session already has on the same locked
 * tree (one per session and tree, builder decision 5). Reads: the writer's session, its open row
 * on the tree (whole: it is merged into), and for a new row how many the page has open (a
 * bounded count), all indexed.
 */
import { OutlineWriteError } from "./errors";
import { newOutlinePendingId } from "./keys";
import { OUTLINE_TEXT } from "./messages";
import {
	OUTLINE_LIMITS,
	OUTLINE_PENDING_LIMITS,
	type OutlinePendingDeciderJson,
	type OutlineTaskLockJson,
	outlinePendingLabel,
} from "./model";
import type { OutlinePendingRow, OutlineSpaceRow, OutlineStore } from "./store/port";
import type { OutlineOp, OutlineOpResult, OutlinePendingOutcome, OutlineWriteInput } from "./write";

/** One operation the write path held back, as the pending change stores it. */
export interface OutlineHeldOp {
	/** Its index in the call. */
	index: number;
	/** The locked task whose tree it changes. */
	rootId: string;
	/** As stored: every block by id (new ones with their ids and sids), content canonical. */
	ops: OutlineOp[];
	/** The existing blocks it targets, with the versions its change was computed against. */
	touched: Array<{ blockId: string; versionSeq: number }>;
	/** The blocks it adds (sid and parent). */
	adds: Array<{ sid: string; parentId: string | null }>;
	/** For a delete: the live blocks under the deleted block and their versions. */
	subtree: Record<string, Record<string, number>>;
	/** What the writer's result says for it. */
	result: OutlineOpResult;
}

/** The locked tree held operations change. */
export interface OutlineHeldTree {
	rootId: string;
	rootSid: string;
	pageId: string;
	lock: OutlineTaskLockJson;
}

/** Why open changes were withdrawn (the `reason` of a `withdrawn` row). */
export const PENDING_WITHDRAW = {
	/** The tree was unlocked. */
	unlocked: "unlocked",
	/** The locked task was deleted. */
	deleted: "lock-deleted",
	/** The proposer took it back. */
	proposer: "withdrawn",
} as const;

/** The operations of a pending change, typed. */
export function pendingOps(row: Pick<OutlinePendingRow, "opsJson">): OutlineOp[] {
	return row.opsJson as unknown as OutlineOp[];
}

function targetId(op: OutlineOp): string | undefined {
	return op.op !== "insert" && "id" in op.block ? op.block.id : undefined;
}

/**
 * A second proposal merged into an open change, so the change says what the proposer means now:
 *
 *   - a rewrite of a block replaces the earlier one field by field (the later wins);
 *   - task changes of a block merge field by field, but taking the checkbox away, or giving it
 *     back after that, replaces what was proposed for the task before (the later intent wins:
 *     `[setTask null]` then `[setTask {due}]` is a task with that due date, not both);
 *   - everything else is appended in order.
 *
 * Returns the merged operations and the blocks whose rewritten text now comes from `incoming`
 * (their base moves to the version that text was computed against).
 */
export function mergePendingOps(
	existing: readonly OutlineOp[],
	incoming: readonly OutlineOp[],
): { ops: OutlineOp[]; rebased: Set<string> } {
	const out = [...existing];
	const rebased = new Set<string>();
	for (const op of incoming) {
		const id = targetId(op);
		if (op.op === "update" && id !== undefined) {
			const at = out.findIndex((o) => o.op === "update" && targetId(o) === id);
			if (op.content !== undefined) rebased.add(id);
			if (at >= 0) {
				out[at] = { ...(out[at] as OutlineOp & { op: "update" }), ...op };
				continue;
			}
		}
		if (op.op === "setTask" && id !== undefined) {
			const at = out.findIndex((o) => o.op === "setTask" && targetId(o) === id);
			if (at >= 0) {
				const earlier = out[at] as OutlineOp & { op: "setTask" };
				out[at] =
					op.task === null || earlier.task === null
						? op
						: { ...earlier, task: { ...earlier.task, ...op.task } };
				continue;
			}
		}
		out.push(op);
	}
	return { ops: out, rebased };
}

function contentBytes(ops: readonly OutlineOp[]): number {
	let total = 0;
	for (const op of ops) {
		if (
			(op.op === "insert" || op.op === "update" || op.op === "restore") &&
			op.content !== undefined
		)
			total += Buffer.byteLength(op.content, "utf8");
	}
	return total;
}

/**
 * The pending row a write puts for its held operations (new, or merged into the writer's
 * session's open change on the tree), and what its result says. Throws `OutlineWriteError` when
 * the change would pass the pending limits.
 */
export async function buildPendingPut(args: {
	store: OutlineStore;
	space: OutlineSpaceRow;
	input: OutlineWriteInput;
	tree: OutlineHeldTree;
	held: readonly OutlineHeldOp[];
	now: string;
}): Promise<{
	put: { row: OutlinePendingRow; expectRev: number | null };
	outcome: OutlinePendingOutcome;
}> {
	const { store, space, input, tree, held, now } = args;
	const narratorId = input.narratorId ?? (input.actor.kind === "agent" ? input.actor.id : null);
	const session = narratorId
		? ((await store.getNarratorRoots([narratorId])).get(narratorId)?.root ?? narratorId)
		: null;
	const existing = session ? await store.findOpenPending(session, tree.rootId) : null;
	if (!existing) {
		const open = await store.countOpenPendingByPage(
			tree.pageId,
			OUTLINE_PENDING_LIMITS.openPerPage,
		);
		if (open >= OUTLINE_PENDING_LIMITS.openPerPage) {
			throw new OutlineWriteError(
				OUTLINE_TEXT.pendingFull(OUTLINE_PENDING_LIMITS.openPerPage),
				"OUTLINE_PENDING_FULL",
			);
		}
	}
	const incoming = held.flatMap((h) => h.ops);
	const merged = existing
		? mergePendingOps(pendingOps(existing), incoming)
		: { ops: incoming, rebased: new Set<string>() };
	const ops = merged.ops;
	const opsBytes = Buffer.byteLength(JSON.stringify(ops), "utf8");
	if (
		ops.length > OUTLINE_PENDING_LIMITS.maxOps ||
		contentBytes(ops) > OUTLINE_PENDING_LIMITS.maxContentBytes ||
		opsBytes > OUTLINE_PENDING_LIMITS.maxOpsBytes
	) {
		throw new OutlineWriteError(
			OUTLINE_TEXT.pendingTooLarge(
				OUTLINE_PENDING_LIMITS.maxOps,
				OUTLINE_PENDING_LIMITS.maxContentBytes,
			),
			"OUTLINE_PENDING_TOO_LARGE",
		);
	}
	// The version each block's proposed change was computed against: the first proposal's,
	// unless a later one rewrote the block's text (then that text's, review S-3).
	const base: Record<string, number> = { ...(existing?.baseJson ?? {}) };
	for (const h of held) {
		for (const t of h.touched) {
			if (base[t.blockId] === undefined || merged.rebased.has(t.blockId))
				base[t.blockId] = t.versionSeq;
		}
	}
	const subtree = { ...(existing?.subtreeJson ?? {}) };
	for (const h of held) Object.assign(subtree, h.subtree);
	const blockIds = [
		...new Set([
			...(existing?.blockIdsJson ?? []),
			...held.flatMap((h) => h.touched.map((t) => t.blockId)),
		]),
	];
	const adds = [...(existing?.addsJson ?? []), ...held.flatMap((h) => h.adds)];
	// What the proposer said; nothing when it said nothing (readers show the count instead).
	const said = input.summary?.trim() ?? "";
	const summary = [existing?.summary ?? "", said]
		.filter((part) => part !== "")
		.join("; ")
		.slice(0, OUTLINE_LIMITS.maxSummaryChars);
	const decider: OutlinePendingDeciderJson = {
		by: { kind: tree.lock.by.kind, id: tree.lock.by.id },
		delegate: tree.lock.delegate ?? null,
	};
	// Short ids of letters and digits: a change is named `P` and its id (builder decision 11); a
	// collision is a uniqueness conflict the write plans again from.
	const id = existing?.id ?? newOutlinePendingId();
	const row: OutlinePendingRow = {
		id,
		spaceId: space.id,
		kind: "locked_plan",
		status: "open",
		pageId: tree.pageId,
		rootBlockId: tree.rootId,
		opsJson: ops as unknown as Array<Record<string, unknown>>,
		opCount: ops.length,
		baseJson: base,
		subtreeJson: subtree,
		blockIdsJson: blockIds,
		addsJson: adds,
		summary,
		requestedByJson: {
			kind: input.actor.kind,
			id: input.actor.id,
			narratorId,
			responsibleUserId: input.responsibleUserId,
			messageId: input.messageId ?? null,
			toolCallId: input.toolCallId ?? null,
		},
		requesterSession: session,
		deciderJson: decider,
		deciderUserId: decider.by.kind === "human" ? decider.by.id : null,
		rev: (existing?.rev ?? 0) + 1,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		decidedAt: null,
		decidedByJson: null,
		decisionCommitId: null,
		reason: null,
		reportedAt: null,
	};
	return {
		put: { row, expectRev: existing ? existing.rev : null },
		outcome: {
			id,
			label: outlinePendingLabel(id),
			rootBlockId: tree.rootId,
			rootAddress: `${space.key}/${tree.rootSid}`,
			pageId: tree.pageId,
			decider,
			opIndexes: held.map((h) => h.index),
			blockIds,
			merged: existing !== null,
		},
	};
}
