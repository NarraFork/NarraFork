/**
 * Operations held for confirmation, as the write path hands them over (`write.ts`, LOCKED PLANS
 * AND PENDING CONFIRMATION), turned into the `outline_pending` row the write puts: a new row, or
 * the proposal merged into the open change the writer's session already has on the same locked
 * tree (one per session and tree, builder decision 5). Reads: the writer's session, its open row
 * on the tree, and (for a new row) the open rows of the page, all indexed and bounded.
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
	/** Existing blocks it touches (targets, parents), with their version when proposed. */
	touched: Array<{ blockId: string; versionSeq: number }>;
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
	/** The tree was unlocked, or locked again by someone else. */
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

/**
 * A second proposal merged into an open change: a rewrite of a block replaces the earlier one
 * (field by field, the later wins), task changes of a block are merged likewise; everything else
 * is appended in order.
 */
export function mergePendingOps(
	existing: readonly OutlineOp[],
	incoming: readonly OutlineOp[],
): OutlineOp[] {
	const out = [...existing];
	for (const op of incoming) {
		if (op.op === "update") {
			const at = out.findIndex(
				(o) =>
					o.op === "update" && "id" in o.block && "id" in op.block && o.block.id === op.block.id,
			);
			if (at >= 0) {
				out[at] = { ...(out[at] as OutlineOp & { op: "update" }), ...op };
				continue;
			}
		}
		if (op.op === "setTask" && op.task !== null) {
			const at = out.findIndex(
				(o) =>
					o.op === "setTask" &&
					o.task !== null &&
					"id" in o.block &&
					"id" in op.block &&
					o.block.id === op.block.id,
			);
			if (at >= 0) {
				const earlier = out[at] as OutlineOp & { op: "setTask" };
				out[at] = { ...earlier, task: { ...earlier.task, ...op.task } };
				continue;
			}
		}
		out.push(op);
	}
	return out;
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

function autoSummary(ops: readonly OutlineOp[]): string {
	const counts = new Map<string, number>();
	for (const op of ops) counts.set(op.op, (counts.get(op.op) ?? 0) + 1);
	return [...counts].map(([kind, n]) => `${kind} ${n}`).join(", ");
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
		const open = await store.listOpenPendingByPage(tree.pageId, OUTLINE_PENDING_LIMITS.openPerPage);
		if (open.length >= OUTLINE_PENDING_LIMITS.openPerPage) {
			throw new OutlineWriteError(
				OUTLINE_TEXT.pendingFull(OUTLINE_PENDING_LIMITS.openPerPage),
				"OUTLINE_PENDING_FULL",
			);
		}
	}
	const incoming = held.flatMap((h) => h.ops);
	const ops = existing ? mergePendingOps(pendingOps(existing), incoming) : incoming;
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
	// The version each block had when first proposed: a merge keeps the first.
	const base: Record<string, number> = {};
	for (const h of held) for (const t of h.touched) base[t.blockId] ??= t.versionSeq;
	Object.assign(base, existing?.baseJson ?? {});
	const blockIds = [
		...new Set([
			...(existing?.blockIdsJson ?? []),
			...held.flatMap((h) => h.touched.map((t) => t.blockId)),
		]),
	];
	const said = input.summary?.trim() || autoSummary(incoming);
	const summary = (existing ? `${existing.summary}; ${said}` : said).slice(
		0,
		OUTLINE_LIMITS.maxSummaryChars,
	);
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
		baseJson: base,
		blockIdsJson: blockIds,
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
