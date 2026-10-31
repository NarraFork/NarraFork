/**
 * Reverting a commit: a new, compensating commit (`kind = "revert"`) that puts every block the
 * commit changed back the way it was just before it. History is never rewritten.
 *
 * WHAT IS PUT BACK
 * ----------------
 * For each version the commit wrote, compared with the block's version just before it:
 *   - created by the commit (or restored by it): deleted again;
 *   - deleted by the commit: restored, under its old parent at its old order key, with its old
 *     content, task, alias and tags; its page follows from where it lands;
 *   - otherwise: moved back, and its content, task, alias and tags set back, each only if the
 *     commit changed it.
 * A version that only changed the page (a descendant of a moved block) needs nothing: it follows
 * its ancestor back.
 *
 * WHAT IS LEFT ALONE (reported in `skipped`)
 *   - changed-later: a later commit changed the block (a later change of page alone, from an
 *     ancestor moving, does not count);
 *   - parent-gone: the parent it would go back under is deleted (and is not restored here);
 *   - cycle: going back would put it under its own subtree (later moves rearranged the tree);
 *   - later-children: deleting it would delete blocks that are not the commit's own (added or
 *     moved under it later, or left there by another skip).
 * These are decided together, until no skip causes another. Everything else is written as one
 * commit through the ordinary planner (`writeOutline` in compensating mode), so every write
 * invariant holds. An alias that another block holds now is dropped, and a block whose old order
 * key a sibling holds now is placed right after that sibling; both are reported in `notes`.
 *
 * The analysis reads at one space seq and the write must land on exactly that seq; if another
 * commit lands in between, the revert is analyzed again.
 */
import { NotFoundError } from "@server/lib/errors";
import { OutlineBusyError } from "./errors";
import { withOutlineLiveBarrier } from "./live-barrier";
import { OUTLINE_TEXT, type OutlineRevertSkipReason } from "./messages";
import {
	OUTLINE_CHANGE,
	OUTLINE_LIMITS,
	type OutlineActorKind,
	type OutlineTaskJson,
} from "./model";
import { outlineStore } from "./store";
import {
	type OutlineBlockMeta,
	type OutlineCommitRow,
	type OutlineSpaceRow,
	OutlineStaleWriteError,
	type OutlineStore,
	type OutlineVersionRow,
} from "./store/port";
import { sameTaskJson } from "./task-json";
import {
	type OutlineAdjustment,
	type OutlineBlockAddressed,
	type OutlineOp,
	type OutlineTaskInput,
	type OutlineTaskPatch,
	writeOutline,
} from "./write";

export interface OutlineRevertInput {
	commitId: string;
	actor: { kind: OutlineActorKind; id: string };
	/** The person accountable for the revert (the session's user for an agent). */
	responsibleUserId: string | null;
	narratorId?: string | null;
	messageId?: string | null;
	toolCallId?: string | null;
	/** Default: `revert #seq: <the reverted commit's summary>`. */
	summary?: string;
}

export interface OutlineRevertSkip extends OutlineBlockAddressed {
	reason: OutlineRevertSkipReason;
	message: string;
}

export interface OutlineRevertNote extends OutlineBlockAddressed {
	adjustment: OutlineAdjustment;
	message: string;
}

export interface OutlineRevertResult {
	spaceId: string;
	/** The commit that was reverted. */
	reverted: { id: string; seq: number };
	/** The compensating commit; null when nothing could be (or needed to be) put back. */
	commit: { id: string; seq: number } | null;
	pageIds: string[];
	/** Blocks the compensating commit put back. */
	changed: OutlineBlockAddressed[];
	skipped: OutlineRevertSkip[];
	notes: OutlineRevertNote[];
}

export interface OutlineRevertOptions {
	store?: OutlineStore;
	now?: () => Date;
	/** Analyses tried before giving up on a space that keeps changing. */
	maxAttempts?: number;
}

const DEFAULT_ATTEMPTS = 5;

type Action = "restore" | "update" | "delete";

interface Target {
	id: string;
	action: Action;
	/** The version just before the commit (null: the commit created the block). */
	prev: OutlineVersionRow | null;
	/** The block now. */
	meta: OutlineBlockMeta;
	/** Change flags of the version the commit wrote. */
	flags: number;
}

interface Plan {
	ops: OutlineOp[];
	/** The block each operation is about. */
	opBlocks: string[];
	changed: string[];
	skipped: Map<string, OutlineRevertSkipReason>;
	metas: Map<string, OutlineBlockMeta>;
}

const sameTask = sameTaskJson;

/** A task as it was, every field spelled out, so the write puts back exactly that. */
function taskInput(task: OutlineTaskJson): OutlineTaskInput {
	return {
		status: task.status,
		assignee: task.assignee,
		depends: task.depends ?? [],
		due: task.due ?? null,
		manager: task.manager ?? null,
		humanCreated: task.humanCreated === true,
		lock: task.lock ?? null,
		claimable: task.claimable === true,
	};
}

/**
 * A task put back over the task as it is (`now`): as {@link taskInput}, with the status only when
 * it changed. Putting back the other fields of a task in progress is not starting it, so it
 * claims nothing (a `setTask` naming `doing` would).
 */
function taskPatch(task: OutlineTaskJson, now: OutlineTaskJson | null): OutlineTaskPatch {
	const { status, ...rest } = taskInput(task);
	return now?.status === status ? rest : { status, ...rest };
}

class RevertAnalysis {
	readonly metas = new Map<string, OutlineBlockMeta>();
	readonly targets = new Map<string, Target>();
	readonly skipped = new Map<string, OutlineRevertSkipReason>();

	constructor(
		private readonly store: OutlineStore,
		private readonly space: OutlineSpaceRow,
		private readonly commit: OutlineCommitRow,
	) {}

	/** Load the metas of `ids` and of all their ancestors. */
	private async loadWithAncestors(ids: Iterable<string | null>): Promise<void> {
		let frontier = [...new Set(ids)].filter(
			(id): id is string => id !== null && !this.metas.has(id),
		);
		for (let depth = 0; frontier.length > 0 && depth <= OUTLINE_LIMITS.maxDepth; depth++) {
			const rows = await this.store.getBlockMetas(this.space.id, { ids: frontier });
			for (const row of rows) this.metas.set(row.id, row);
			frontier = [...new Set(rows.map((r) => r.parentId))].filter(
				(id): id is string => id !== null && !this.metas.has(id),
			);
		}
	}

	private active(id: string): Target | null {
		const target = this.targets.get(id);
		return target && !this.skipped.has(id) ? target : null;
	}

	/** Parent of a block once the revert is written (skips taken so far). */
	private finalParent(id: string): string | null {
		const target = this.active(id);
		if (target && target.action !== "delete") return target.prev?.parentId ?? null;
		return this.metas.get(id)?.parentId ?? null;
	}

	/** Whether a block is live once the revert is written, deletions aside. */
	private finalLive(id: string): boolean {
		const target = this.active(id);
		if (target) return target.action !== "delete";
		const meta = this.metas.get(id);
		return meta !== undefined && !meta.deleted;
	}

	/** Final ancestors of a block, nearest first (stops at a loop or the depth limit). */
	private *finalAncestors(id: string): Generator<string> {
		const seen = new Set<string>([id]);
		let current = this.finalParent(id);
		for (let depth = 0; current !== null && depth <= OUTLINE_LIMITS.maxDepth; depth++) {
			if (seen.has(current)) return;
			seen.add(current);
			yield current;
			current = this.finalParent(current);
		}
	}

	private wouldCycle(id: string): boolean {
		let current = this.finalParent(id);
		const seen = new Set<string>();
		for (let depth = 0; current !== null && depth <= OUTLINE_LIMITS.maxDepth; depth++) {
			if (current === id) return true;
			if (seen.has(current)) return false;
			seen.add(current);
			current = this.finalParent(current);
		}
		return false;
	}

	async run(): Promise<Plan> {
		const c = this.commit.seq;
		const written = await this.store.listCommitVersions(
			this.commit.id,
			OUTLINE_LIMITS.maxRowsTouched + 1,
		);
		const ids = written.map((v) => v.blockId);
		for (const meta of await this.store.getBlockMetas(this.space.id, { ids })) {
			this.metas.set(meta.id, meta);
		}
		const prev = new Map((await this.store.listVersionsAt(ids, c - 1)).map((v) => [v.blockId, v]));
		// A version that only changed the page followed an ancestor; it needs nothing of its own.
		const relevant = written.filter((v) => (v.changeFlags & ~OUTLINE_CHANGE.PAGE) !== 0);
		const later = relevant
			.filter((v) => this.metas.get(v.blockId)?.versionSeq !== c)
			.map((v) => v.blockId);
		const changedLater = new Set(
			later.length > 0
				? await this.store.findBlocksChangedAfter(later, c, OUTLINE_CHANGE.PAGE)
				: [],
		);
		for (const version of relevant) {
			const meta = this.metas.get(version.blockId);
			if (!meta) continue;
			const before = prev.get(version.blockId) ?? null;
			const wasLive = before !== null && !before.deleted;
			// Created and deleted by the commit itself: nothing to undo.
			if (!wasLive && version.deleted) continue;
			const action: Action = !wasLive ? "delete" : version.deleted ? "restore" : "update";
			this.targets.set(meta.id, {
				id: meta.id,
				action,
				prev: before,
				meta,
				flags: version.changeFlags,
			});
			if (changedLater.has(meta.id)) this.skipped.set(meta.id, "changed-later");
		}

		// What the decisions depend on: the live subtrees of blocks to delete, and the ancestors
		// of every place a block goes back to.
		const deletes = [...this.targets.values()].filter((t) => t.action === "delete");
		const subtree = new Set<string>();
		let frontier: string[] = deletes.filter((t) => !t.meta.deleted).map((t) => t.id);
		while (frontier.length > 0 && subtree.size <= OUTLINE_LIMITS.maxRowsTouched * 2) {
			const children = await this.store.listChildMetas(
				this.space.id,
				frontier,
				OUTLINE_LIMITS.maxRowsTouched * 2 + 1,
			);
			frontier = [];
			for (const child of children) {
				if (subtree.has(child.id)) continue;
				subtree.add(child.id);
				if (!this.metas.has(child.id)) this.metas.set(child.id, child);
				frontier.push(child.id);
			}
		}
		const tooLarge = subtree.size > OUTLINE_LIMITS.maxRowsTouched * 2;
		await this.loadWithAncestors([
			...[...this.targets.values()].map((t) => t.prev?.parentId ?? null),
			...[...this.targets.values()].map((t) => t.meta.parentId),
		]);
		if (tooLarge) {
			for (const target of deletes) this.skip(target.id, "later-children");
		}

		// Decide the skips together: one skip can make another necessary.
		for (let changed = true; changed; ) {
			changed = false;
			for (const target of this.targets.values()) {
				if (!this.active(target.id) || target.action === "delete") continue;
				const parentId = target.prev?.parentId ?? null;
				if (parentId !== null && !this.finalLive(parentId)) {
					changed = this.skip(target.id, "parent-gone") || changed;
				} else if (this.wouldCycle(target.id)) {
					changed = this.skip(target.id, "cycle") || changed;
				}
			}
			// A block that stays live may not end up under a block being deleted.
			const candidates = new Set<string>([...subtree, ...this.targets.keys()]);
			for (const id of candidates) {
				const own = this.active(id);
				if (own?.action === "delete" || !this.finalLive(id)) continue;
				for (const ancestor of this.finalAncestors(id)) {
					if (this.active(ancestor)?.action === "delete") {
						changed = this.skip(ancestor, "later-children") || changed;
						break;
					}
				}
			}
		}
		return this.operations();
	}

	private skip(id: string, reason: OutlineRevertSkipReason): boolean {
		if (this.skipped.has(id)) return false;
		this.skipped.set(id, reason);
		return true;
	}

	private async operations(): Promise<Plan> {
		const c = this.commit.seq;
		const active = [...this.targets.values()].filter((t) => this.active(t.id));
		const placed = active.filter((t) => t.action !== "delete");
		const tagged = placed.filter(
			(t) => t.action === "restore" || (t.flags & OUTLINE_CHANGE.PROPS) !== 0,
		);
		const tagsAt = async (seq: number) => {
			const out = new Map<string, string[]>();
			const ids = tagged.map((t) => t.id);
			if (ids.length === 0) return out;
			const links = await this.store.listLinksAt(
				ids,
				seq,
				["tag"],
				ids.length * OUTLINE_LIMITS.maxTagsPerBlock,
			);
			for (const link of links) {
				const list = out.get(link.fromBlockId);
				if (list) list.push(link.targetRef);
				else out.set(link.fromBlockId, [link.targetRef]);
			}
			for (const list of out.values()) list.sort();
			return out;
		};
		const tagsBefore = await tagsAt(c - 1);
		const tagsAfter = await tagsAt(c);

		const ops: OutlineOp[] = [];
		const opBlocks: string[] = [];
		const push = (op: OutlineOp, id: string) => {
			ops.push(op);
			opBlocks.push(id);
		};
		// Aliases that move are released first, so they can change hands within the commit.
		for (const t of placed) {
			if (t.action === "update" && t.prev?.alias !== t.meta.alias && t.meta.alias !== null) {
				push({ op: "update", block: { id: t.id }, alias: null }, t.id);
			}
		}
		// Deletions take the subtree with them, so only the topmost are written. Those with
		// nothing to move out of them go first: they free the order keys they took (a block
		// inserted where another one moved away from, say). The others wait for the moves.
		const deletes = active
			.filter((t) => t.action === "delete" && !t.meta.deleted)
			.sort((a, b) => (a.id < b.id ? -1 : 1));
		const holding = new Set<string>();
		for (const t of placed) {
			for (
				let id = t.meta.parentId, depth = 0;
				id !== null && depth <= OUTLINE_LIMITS.maxDepth;
				depth++
			) {
				if (this.active(id)?.action === "delete") holding.add(id);
				id = this.metas.get(id)?.parentId ?? null;
			}
		}
		const topmost = deletes.filter((t) => {
			for (const ancestor of this.finalAncestors(t.id)) {
				if (this.active(ancestor)?.action === "delete") return false;
			}
			return true;
		});
		for (const t of topmost) {
			if (!holding.has(t.id)) push({ op: "delete", block: { id: t.id } }, t.id);
		}
		// Parents before children, in the tree as it will be.
		const pending = new Set(placed.map((t) => t.id));
		const ordered: Target[] = [];
		const visit = (t: Target, depth: number) => {
			if (!pending.has(t.id) || depth > OUTLINE_LIMITS.maxDepth) return;
			const parentId = t.prev?.parentId ?? null;
			const parent = parentId === null ? null : this.active(parentId);
			if (parent && parent.action !== "delete") visit(parent, depth + 1);
			if (!pending.delete(t.id)) return;
			ordered.push(t);
		};
		for (const t of [...placed].sort((a, b) => (a.id < b.id ? -1 : 1))) visit(t, 0);

		for (const t of ordered) {
			const before = t.prev as OutlineVersionRow;
			const parent = before.parentId === null ? null : { id: before.parentId };
			const tags = tagsBefore.get(t.id) ?? [];
			if (t.action === "restore") {
				push(
					{
						op: "restore",
						block: { id: t.id },
						parent,
						position: { orderKey: before.orderKey },
						content: before.content ?? "",
						alias: before.alias,
						task: before.taskJson ? taskInput(before.taskJson) : null,
						tags,
					},
					t.id,
				);
				continue;
			}
			if (before.parentId !== t.meta.parentId || before.orderKey !== t.meta.orderKey) {
				push(
					{ op: "move", block: { id: t.id }, parent, position: { orderKey: before.orderKey } },
					t.id,
				);
			}
			if (before.contentHash !== t.meta.contentHash) {
				push({ op: "update", block: { id: t.id }, content: before.content ?? "" }, t.id);
			}
			if (before.alias !== t.meta.alias && before.alias !== null) {
				push({ op: "update", block: { id: t.id }, alias: before.alias }, t.id);
			}
			if (
				(t.flags & OUTLINE_CHANGE.PROPS) !== 0 &&
				tags.join("\n") !== (tagsAfter.get(t.id) ?? []).join("\n")
			) {
				push({ op: "update", block: { id: t.id }, tags }, t.id);
			}
			if (!sameTask(before.taskJson, t.meta.taskJson)) {
				push(
					{
						op: "setTask",
						block: { id: t.id },
						task: before.taskJson ? taskPatch(before.taskJson, t.meta.taskJson) : null,
					},
					t.id,
				);
			}
		}
		for (const t of topmost) {
			if (holding.has(t.id)) push({ op: "delete", block: { id: t.id } }, t.id);
		}
		const changed = [...new Set([...ordered.map((t) => t.id), ...deletes.map((t) => t.id)])];
		return { ops, opBlocks, changed, skipped: this.skipped, metas: this.metas };
	}
}

/**
 * Revert a commit with a compensating commit. Blocks changed since, or that cannot go back, are
 * left alone and listed; the rest is written as one `revert` commit. Throws `NotFoundError` for
 * an unknown commit and `OutlineBusyError` when the space keeps changing during the analysis.
 */
export async function revertCommit(
	input: OutlineRevertInput,
	options: OutlineRevertOptions = {},
): Promise<OutlineRevertResult> {
	const store = options.store ?? outlineStore;
	const commit = await store.getCommit(input.commitId);
	if (!commit) throw new NotFoundError("Outline commit", input.commitId);
	// Behind the live session barrier: edits still in a page's live session are committed first,
	// so the analysis sees them as "changed later" and leaves those blocks alone.
	return await withOutlineLiveBarrier(commit.spaceId, () =>
		revertAttempts(input, options, store, commit),
	);
}

async function revertAttempts(
	input: OutlineRevertInput,
	options: OutlineRevertOptions,
	store: OutlineStore,
	commit: OutlineCommitRow,
): Promise<OutlineRevertResult> {
	const attempts = options.maxAttempts ?? DEFAULT_ATTEMPTS;
	for (let attempt = 0; attempt < attempts; attempt++) {
		const space = await store.getSpace(commit.spaceId);
		if (!space) throw new NotFoundError("Outline space", commit.spaceId);
		const plan = await new RevertAnalysis(store, space, commit).run();
		const address = (id: string): OutlineBlockAddressed => {
			const sid = plan.metas.get(id)?.sid ?? id;
			return { blockId: id, sid, address: `${space.key}/${sid}` };
		};
		const skipped = [...plan.skipped].map(([id, reason]) => ({
			...address(id),
			reason,
			message: OUTLINE_TEXT.revertSkipped[reason],
		}));
		const base = {
			spaceId: space.id,
			reverted: { id: commit.id, seq: commit.seq },
			skipped,
		};
		if (plan.ops.length === 0) {
			return { ...base, commit: null, pageIds: [], changed: [], notes: [] };
		}
		let written: Awaited<ReturnType<typeof writeOutline>>;
		try {
			written = await writeOutline(
				{
					spaceId: space.id,
					ops: plan.ops,
					actor: input.actor,
					responsibleUserId: input.responsibleUserId,
					narratorId: input.narratorId ?? null,
					messageId: input.messageId ?? null,
					toolCallId: input.toolCallId ?? null,
					summary: input.summary ?? OUTLINE_TEXT.revertSummary(commit.seq, commit.summary),
				},
				{
					store,
					now: options.now,
					compensating: { expectNextSeq: space.nextSeq },
				},
			);
		} catch (error) {
			// Another commit landed after the analysis read the space: analyze again.
			if (error instanceof OutlineStaleWriteError) continue;
			throw error;
		}
		const holders = new Map<string, string>();
		const adjusted = written.results.flatMap((result, i) =>
			(result.adjustments ?? []).map((adjustment) => ({
				id: plan.opBlocks[i] as string,
				adjustment,
			})),
		);
		const heldBy = adjusted
			.map((a) => (a.adjustment.kind === "alias-dropped" ? a.adjustment.heldBy : null))
			.filter((id): id is string => id !== null);
		if (heldBy.length > 0) {
			for (const block of await store.getBlocks(heldBy)) {
				holders.set(block.id, `${space.key}/${block.sid}`);
			}
		}
		const notes = adjusted.map(({ id, adjustment }) => ({
			...address(id),
			adjustment,
			message:
				adjustment.kind === "alias-dropped"
					? OUTLINE_TEXT.aliasDropped(
							adjustment.alias,
							holders.get(adjustment.heldBy) ?? adjustment.heldBy,
						)
					: adjustment.kind === "order-key-moved"
						? OUTLINE_TEXT.orderKeyMoved(adjustment.wanted)
						: OUTLINE_TEXT.taskNotStarted,
		}));
		return {
			...base,
			commit: written.commit,
			pageIds: written.pageIds,
			changed: plan.changed.map(address),
			notes,
		};
	}
	throw new OutlineBusyError(commit.spaceId, attempts);
}
