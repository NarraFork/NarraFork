/**
 * What a read shows of pending changes (design §2.6; owner decision Q1 = a): the session that
 * proposed a change reads its own version, everyone else reads the outline as it is with the
 * blocks a change touches marked.
 *
 *   - THE PROPOSER (its session, subagents included): its open changes on the page are laid over
 *     the tree in memory: a rewritten block shows the proposed text, an added block appears with
 *     the id it will get, a deleted one is gone, a moved one is in its new place, a task change
 *     shows. Each such spot gets a `‹pending P…›` line naming who decides. A rewritten block
 *     someone changed since the proposal shows what confirming would write: the proposal merged
 *     over their change (the three-way merge confirmation uses, `mergeProposal` in `pending.ts`),
 *     marked as changed since; where they no longer merge, the block as it is now, marked with
 *     the conflict (review S-2). The read ledger still records the blocks' stored versions, and
 *     an added block is not in it: it exists only once confirmed, so nothing can be written
 *     under it before (an edit naming it says so).
 *   - EVERYONE ELSE: the stored outline, a `‹pending P…›` line under each block a change targets
 *     and each block it adds under (from the row's head: its operations are not read).
 *
 * The marks are annotations (`render.ts`): an edit copying a read back drops them. Pure, over the
 * tree a read built; no database access.
 */
import { compareOrderKeys } from "@shared/outline";
import type { OutlineTaskJson } from "./model";
import type { OutlineProposalMerge } from "./pending";
import { pendingOps } from "./pending-hold";
import type { OutlinePageState } from "./read";
import type { OutlinePendingHead, OutlinePendingRow } from "./store/port";
import { canonicalTaskJson } from "./task-json";
import type { OutlineNode } from "./tree";
import type { OutlineOp, OutlinePosition } from "./write";

/** How a pending change is named in its marks. */
export interface OutlinePendingMarkText {
	/** Under a block the reader's own change touches. Each text starts with `pending `. */
	own: (label: string, decider: string) => string;
	/** Under a block the reader's own change deletes blocks under. */
	ownDeleted: (label: string, decider: string, n: number) => string;
	/** Under a block someone else's change touches. */
	other: (label: string, decider: string) => string;
	/** Under a block of the reader's own change that someone changed since; merged over it. */
	ownMerged: (label: string, decider: string) => string;
	/** Under a block of the reader's own change that no longer applies (shown as it is now). */
	ownConflict: (label: string, decider: string, detail: string) => string;
}

export interface OutlinePendingOverlay {
	/** Rewrites the page state the read built (the reader's own changes). */
	prepare(state: OutlinePageState): void;
	/** After the content of the blocks the read shows is loaded: proposed texts replace them. */
	finish(nodes: readonly OutlineNode[]): void;
	/** The `‹pending …›` line under a block, if any. */
	annotate(node: OutlineNode): string | null;
	/** Blocks the overlay added (not stored yet): left out of the read ledger. */
	readonly added: ReadonlySet<string>;
}

interface Labeled<Row> {
	row: Row;
	/** `P…`. */
	label: string;
	/** Who decides, as the marks name them. */
	decider: string;
}

/** One of the reader's own changes: whole, with its rewrites laid over the blocks as they are. */
export interface OutlineOwnPending extends Labeled<OutlinePendingRow> {
	/** `mergeProposal` of the row: by rewritten block, as proposed, merged or in conflict. */
	merges: ReadonlyMap<string, OutlineProposalMerge>;
}

/**
 * The overlay of a read: `own` are the reader's session's open changes on the page (laid over),
 * `others` everyone else's (marked, from their heads). `label` names a change as the marks show
 * it (`P…` and who decides).
 */
export function pendingOverlay(args: {
	own: readonly OutlineOwnPending[];
	others: readonly Labeled<OutlinePendingHead>[];
	text: OutlinePendingMarkText;
}): OutlinePendingOverlay {
	const marks = new Map<string, string>();
	const deletedUnder = new Map<string, { label: string; decider: string; n: number }>();
	const overrides = new Map<string, { content?: string; alias?: string | null; tags?: string[] }>();
	const added = new Set<string>();
	for (const { row, label, decider } of args.others) {
		const ids = [
			...row.blockIdsJson,
			...row.addsJson.flatMap((add) => (add.parentId ? [add.parentId] : [])),
		];
		for (const id of ids) if (!marks.has(id)) marks.set(id, args.text.other(label, decider));
	}

	const prepare = (state: OutlinePageState) => {
		const nodes = state.nodes;
		const detach = (node: OutlineNode) => {
			const parent = node.parent;
			if (!parent) return;
			parent.children = parent.children.filter((c) => c !== node);
			node.parent = null;
		};
		const attach = (
			node: OutlineNode,
			parent: OutlineNode,
			position: OutlinePosition | undefined,
		) => {
			const list = parent.children;
			let index = list.length;
			if (position && "first" in position) index = 0;
			else if (position && ("after" in position || "before" in position)) {
				const ref = "after" in position ? position.after : position.before;
				const at = "id" in ref ? list.findIndex((c) => c.id === ref.id) : -1;
				if (at >= 0) index = "after" in position ? at + 1 : at;
			} else if (position && "orderKey" in position) {
				index = list.findIndex((c) => compareOrderKeys(c.orderKey, position.orderKey) > 0);
				if (index < 0) index = list.length;
				node.orderKey = position.orderKey;
			}
			list.splice(index, 0, node);
			node.parent = parent;
			node.parentId = parent.id;
		};
		const idOf = (ref: { id: string } | { sid: string } | { tempId: string } | null | undefined) =>
			ref && "id" in ref ? ref.id : undefined;
		for (const { row, label, decider, merges } of args.own) {
			const mark = args.text.own(label, decider);
			// A rewritten block someone changed since: merged over their change, or left as it is.
			const rewrite = (id: string): OutlineProposalMerge | undefined => {
				const m = merges.get(id);
				if (m?.state === "merged") marks.set(id, args.text.ownMerged(label, decider));
				else if (m?.state === "conflict")
					marks.set(id, args.text.ownConflict(label, decider, m.detail));
				else marks.set(id, mark);
				return m;
			};
			for (const op of pendingOps(row) as OutlineOp[]) {
				switch (op.op) {
					case "insert": {
						const parent = nodes.get(idOf(op.parent) ?? "");
						if (!parent || !op.id) break;
						const node: OutlineNode = {
							id: op.id,
							sid: op.sid ?? "",
							parentId: parent.id,
							orderKey: "",
							alias: op.alias ?? null,
							task: op.task
								? canonicalTaskJson({
										status: op.task.status,
										assignee: op.task.assignee ?? null,
										depends: op.task.depends ?? null,
										due: op.task.due ?? null,
									})
								: null,
							versionSeq: 0,
							parent: null,
							children: [],
							content: op.content,
							tags: op.tags ? [...op.tags].sort() : [],
						};
						nodes.set(node.id, node);
						attach(node, parent, op.position);
						added.add(node.id);
						marks.set(node.id, mark);
						break;
					}
					case "update": {
						const id = idOf(op.block);
						if (!id || !nodes.has(id)) break;
						const node = nodes.get(id) as OutlineNode;
						const m = rewrite(id);
						if (m?.state === "conflict") break;
						const fields =
							m?.state === "merged"
								? { content: m.content, alias: m.alias, tags: m.tags }
								: { content: op.content, alias: op.alias, tags: op.tags };
						const o = overrides.get(id) ?? {};
						if (fields.content !== undefined) o.content = fields.content;
						if (fields.alias !== undefined) {
							o.alias = fields.alias;
							node.alias = fields.alias;
						}
						if (fields.tags !== undefined) o.tags = [...fields.tags].sort();
						overrides.set(id, o);
						break;
					}
					case "setTask": {
						const node = nodes.get(idOf(op.block) ?? "");
						if (!node) break;
						const m = rewrite(node.id);
						if (m?.state === "conflict") break;
						const before: OutlineTaskJson = node.task ?? { status: "todo", assignee: null };
						const patch = m?.state === "merged" && op.task !== null ? (m.task ?? {}) : op.task;
						node.task =
							patch === null
								? null
								: canonicalTaskJson({
										...before,
										status: patch.status ?? before.status,
										...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
										...(patch.depends !== undefined ? { depends: patch.depends } : {}),
										...(patch.due !== undefined ? { due: patch.due } : {}),
									});
						break;
					}
					case "move": {
						const node = nodes.get(idOf(op.block) ?? "");
						const parent = op.parent ? nodes.get(idOf(op.parent) ?? "") : undefined;
						if (!node || !parent) break;
						detach(node);
						attach(node, parent, op.position);
						marks.set(node.id, mark);
						break;
					}
					case "delete": {
						const node = nodes.get(idOf(op.block) ?? "");
						if (!node?.parent) break;
						let n = 0;
						const stack = [node];
						while (stack.length > 0) {
							const x = stack.pop() as OutlineNode;
							n++;
							stack.push(...x.children);
						}
						const parent = node.parent;
						detach(node);
						const before = deletedUnder.get(parent.id);
						deletedUnder.set(parent.id, { label, decider, n: (before?.n ?? 0) + n });
						break;
					}
					case "restore":
						break;
				}
			}
		}
	};

	return {
		prepare,
		finish(nodes) {
			for (const node of nodes) {
				const o = overrides.get(node.id);
				if (!o || node.content === null) continue;
				if (o.content !== undefined) node.content = o.content;
				if (o.tags !== undefined) node.tags = o.tags;
			}
		},
		annotate(node) {
			const deleted = deletedUnder.get(node.id);
			const gone = deleted ? args.text.ownDeleted(deleted.label, deleted.decider, deleted.n) : null;
			const own = marks.get(node.id);
			if (gone && own) return `${own}; ${gone.replace(/^pending /, "")}`;
			return gone ?? own ?? null;
		},
		added,
	};
}
