/**
 * A plan against its previous version (outline P2 PR 8, D48; design §4.3: "人看到计划和上一版的
 * diff"): the plan root's subtree as of two seqs, block by block.
 *
 * HOW IT IS COMPUTED
 * ------------------
 * Two reads of the root's subtree (`readSubtree`, the page's structure at each seq: ids, parents,
 * order keys, task fields, the version each block was at), matched by block id:
 *
 *   - `added`: in the subtree now, not before; `removed`: before, not now (deleted or moved out);
 *   - `moved`: another parent, or another place among its siblings (its order key changed);
 *   - `task`: its checkbox, assignee, due date or prerequisites changed (a plan's own state is
 *     not a change of the plan);
 *   - `text`: its content changed. A block whose version did not change changed in nothing; for
 *     one that did, the two contents are loaded (by exact version, a point read each) and
 *     compared.
 *
 * Commit ranges are not used: a subtree gains and loses blocks by moves, which only the two trees
 * show directly. Each read is one page structure (as `OutlineRead`'s); the subtree is cut at
 * {@link OUTLINE_PLAN_LIMITS.maxBlocks} blocks, and contents are loaded only for the first
 * {@link OUTLINE_PLAN_LIMITS.diffEntries} changed blocks (a block past them that changed its
 * version and nothing else the structure shows is counted as a text change, and the diff is
 * marked truncated).
 */

import { blockTitle } from "@shared/outline";
import type {
	OutlinePlanChange,
	OutlinePlanDiffCounts,
	OutlinePlanDiffEntry,
	OutlinePlanTaskView,
} from "@shared/outline-api";
import type { OutlineTaskJson } from "./model";
import { loadBodies, type OutlinePageState, readSubtree } from "./read";
import { outlineStore } from "./store";
import type { OutlineStore } from "./store/port";
import type { OutlineNode } from "./tree";

export const OUTLINE_PLAN_LIMITS = {
	/** Blocks of a plan one submission or diff reads; a larger plan is refused at submission. */
	maxBlocks: 2000,
	/** UTF-8 bytes of the plan's rendering an approval shows (as one `OutlineRead`). */
	renderBytes: 256 * 1024,
	/** Changed blocks a diff lists (and loads the contents of). */
	diffEntries: 200,
	/** UTF-8 bytes of each text a diff shows. */
	diffTextBytes: 16 * 1024,
	/** UTF-8 bytes of the changes the agent is told the person made while deciding. */
	promptDiffBytes: 4096,
	/** Characters of a person's feedback on a returned plan. */
	feedbackChars: 4000,
	/** Characters of a plan root's title when plan mode creates it. */
	titleChars: 200,
	/** Commits after the seen version one decision looks through for others' changes. */
	commitScan: 200,
	/** UTF-8 bytes of the summary the agent gives a submission. */
	summaryBytes: 2000,
} as const;

export interface OutlinePlanDiff {
	root: OutlineNode;
	state: OutlinePageState;
	fromSeq: number;
	toSeq: number;
	counts: OutlinePlanDiffCounts;
	entries: OutlinePlanDiffEntry[];
	truncated: boolean;
}

function clip(text: string | null): string | null {
	if (text === null) return null;
	const max = OUTLINE_PLAN_LIMITS.diffTextBytes;
	if (Buffer.byteLength(text, "utf8") <= max) return text;
	return `${Buffer.from(text, "utf8").subarray(0, max).toString("utf8").replace(/�$/, "")}…`;
}

/** The task fields a plan diff compares (a plan's own state and its claims are not the plan). */
export function planTaskView(task: OutlineTaskJson | null): OutlinePlanTaskView | null {
	if (!task) return null;
	return {
		status: task.status,
		assignee: task.assignee ?? null,
		due: task.due ?? null,
		depends: (task.depends ?? []).map((d) => d.target),
	};
}

function sameTaskView(a: OutlinePlanTaskView | null, b: OutlinePlanTaskView | null): boolean {
	if (!a || !b) return !a && !b;
	return (
		a.status === b.status &&
		a.assignee === b.assignee &&
		a.due === b.due &&
		a.depends.length === b.depends.length &&
		a.depends.every((d, i) => d === b.depends[i])
	);
}

/** The subtree of `root` in document order with depths, at most `max` blocks. */
function preorder(
	root: OutlineNode,
	max: number,
): { nodes: OutlineNode[]; depth: Map<string, number> } {
	const nodes: OutlineNode[] = [];
	const depth = new Map<string, number>();
	const stack: Array<[OutlineNode, number]> = [[root, 0]];
	while (stack.length > 0 && nodes.length < max) {
		const [node, d] = stack.pop() as [OutlineNode, number];
		nodes.push(node);
		depth.set(node.id, d);
		for (let i = node.children.length - 1; i >= 0; i--)
			stack.push([node.children[i] as OutlineNode, d + 1]);
	}
	return { nodes, depth };
}

/** Whether the subtree of `root` has more than `max` blocks. */
export function subtreeLargerThan(root: OutlineNode, max: number): boolean {
	let count = 0;
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop() as OutlineNode;
		if (++count > max) return true;
		for (const child of node.children) stack.push(child);
	}
	return false;
}

const titleOfNode = (node: OutlineNode | null | undefined): string | null =>
	node ? blockTitle(node.content ?? "").slice(0, 200) : null;

/**
 * The plan rooted at `rootId` as of `toSeq` (null: now) against `fromSeq` (0 or a seq when the
 * root did not exist yet: everything is new). Null when the root is not live at `toSeq`.
 */
export async function readPlanDiff(args: {
	rootId: string;
	fromSeq: number;
	toSeq: number | null;
	store?: OutlineStore;
}): Promise<OutlinePlanDiff | null> {
	const store = args.store ?? outlineStore;
	const after = await readSubtree(args.rootId, {
		...(args.toSeq !== null ? { asOf: args.toSeq } : {}),
		store,
	});
	if (!after) return null;
	const before =
		args.fromSeq >= 1 ? await readSubtree(args.rootId, { asOf: args.fromSeq, store }) : null;
	const max = OUTLINE_PLAN_LIMITS.maxBlocks;
	const now = preorder(after.root, max);
	const then = before ? preorder(before.root, max) : { nodes: [], depth: new Map() };
	let truncated =
		subtreeLargerThan(after.root, max) || (!!before && subtreeLargerThan(before.root, max));
	const beforeById = new Map(then.nodes.map((n) => [n.id, n]));
	const afterIds = new Set(now.nodes.map((n) => n.id));

	// Changes the structure shows; content is compared below for the blocks listed.
	interface Pending {
		node: OutlineNode;
		prev: OutlineNode | null;
		changes: OutlinePlanChange[];
		depth: number;
		/** The version changed but nothing the structure shows: the text may have. */
		maybeText: boolean;
	}
	const pending: Pending[] = [];
	for (const node of now.nodes) {
		const prev = beforeById.get(node.id) ?? null;
		if (!prev) {
			pending.push({
				node,
				prev,
				changes: ["added"],
				depth: now.depth.get(node.id) ?? 0,
				maybeText: false,
			});
			continue;
		}
		if (prev.versionSeq === node.versionSeq) continue;
		const changes: OutlinePlanChange[] = [];
		// The root's place outside the plan is not a change of the plan.
		if (
			node.id !== after.root.id &&
			(prev.parentId !== node.parentId || prev.orderKey !== node.orderKey)
		)
			changes.push("moved");
		if (!sameTaskView(planTaskView(prev.task), planTaskView(node.task))) changes.push("task");
		pending.push({ node, prev, changes, depth: now.depth.get(node.id) ?? 0, maybeText: true });
	}
	const removed = then.nodes.filter((n) => !afterIds.has(n.id));

	// Contents of the listed blocks only, both versions.
	const listed = pending.slice(0, OUTLINE_PLAN_LIMITS.diffEntries);
	const listedRemoved = removed.slice(
		0,
		Math.max(0, OUTLINE_PLAN_LIMITS.diffEntries - listed.length),
	);
	await loadBodies(
		after.state,
		listed.map((p) => p.node),
		{ store },
	);
	if (before) {
		await loadBodies(
			before.state,
			[...listed.flatMap((p) => (p.prev ? [p.prev] : [])), ...listedRemoved],
			{ store },
		);
	}
	// Parents' titles for added and moved blocks (now) and removed ones (before).
	const parentsNow = listed.flatMap((p) =>
		p.changes.includes("added") || p.changes.includes("moved") ? [p.node.parent] : [],
	);
	await loadBodies(
		after.state,
		parentsNow.filter((n): n is OutlineNode => !!n),
		{ store },
	);
	if (before) {
		await loadBodies(
			before.state,
			listedRemoved.map((n) => n.parent).filter((n): n is OutlineNode => !!n),
			{ store },
		);
	}

	const counts: OutlinePlanDiffCounts = {
		added: 0,
		removed: removed.length,
		text: 0,
		task: 0,
		moved: 0,
	};
	const entries: OutlinePlanDiffEntry[] = [];
	for (const [index, p] of pending.entries()) {
		const shown = index < listed.length;
		if (p.maybeText) {
			if (shown) {
				if ((p.prev?.content ?? "") !== (p.node.content ?? "")) p.changes.push("text");
			} else if (p.changes.length === 0) {
				// Not loaded: the version changed and nothing else did; count it as text.
				p.changes.push("text");
				truncated = true;
			}
		}
		for (const change of p.changes) {
			if (change === "added") counts.added++;
			else if (change === "text") counts.text++;
			else if (change === "task") counts.task++;
			else if (change === "moved") counts.moved++;
		}
		if (!shown || p.changes.length === 0) continue;
		const added = p.changes.includes("added");
		entries.push({
			blockId: p.node.id,
			sid: p.node.sid,
			changes: p.changes,
			depth: p.depth,
			before: added ? null : clip(p.prev?.content ?? null),
			after: clip(p.node.content),
			taskBefore: added ? null : planTaskView(p.prev?.task ?? null),
			taskAfter: planTaskView(p.node.task),
			...(added || p.changes.includes("moved")
				? { parentTitle: p.node.id === after.root.id ? null : titleOfNode(p.node.parent) }
				: {}),
		});
	}
	for (const node of listedRemoved) {
		entries.push({
			blockId: node.id,
			sid: node.sid,
			changes: ["removed"],
			depth: then.depth.get(node.id) ?? 0,
			before: clip(node.content),
			after: null,
			taskBefore: planTaskView(node.task),
			taskAfter: null,
			parentTitle: titleOfNode(node.parent),
		});
	}
	if (pending.length > listed.length || removed.length > listedRemoved.length) truncated = true;
	return {
		root: after.root,
		state: after.state,
		fromSeq: args.fromSeq,
		toSeq: after.state.seq,
		counts,
		entries,
		truncated,
	};
}

/** Whether a diff has any change at all. */
export function planDiffIsEmpty(counts: OutlinePlanDiffCounts): boolean {
	return counts.added + counts.removed + counts.text + counts.task + counts.moved === 0;
}

/**
 * A diff as the lines an agent reads (the changes a person made while deciding), within
 * {@link OUTLINE_PLAN_LIMITS.promptDiffBytes}: `+` added, `-` removed, `~` changed, with the
 * block's address.
 */
export function planDiffLines(
	diff: Pick<OutlinePlanDiff, "entries" | "truncated">,
	key: string,
): string {
	const lines: string[] = [];
	let bytes = 0;
	const short = (text: string | null) => {
		const title = blockTitle(text ?? "")
			.replace(/\s+/g, " ")
			.trim();
		return title.length > 160 ? `${title.slice(0, 159)}…` : title;
	};
	let cut = diff.truncated;
	for (const entry of diff.entries) {
		const address = `${key}/${entry.sid}`;
		let line: string;
		if (entry.changes.includes("added")) line = `+ [${address}] ${short(entry.after)}`;
		else if (entry.changes.includes("removed")) line = `- [${address}] ${short(entry.before)}`;
		else {
			const parts: string[] = [];
			if (entry.changes.includes("text"))
				parts.push(`"${short(entry.before)}" → "${short(entry.after)}"`);
			if (entry.changes.includes("task")) {
				const b = entry.taskBefore;
				const a = entry.taskAfter;
				parts.push(
					`task ${b ? b.status : "none"} → ${a ? a.status : "none"}${
						a && b && a.assignee !== b.assignee ? ` (assignee ${a.assignee ?? "none"})` : ""
					}`,
				);
			}
			if (entry.changes.includes("moved")) parts.push("moved");
			line = `~ [${address}] ${parts.length > 0 ? parts.join("; ") : short(entry.after)}`;
		}
		const size = Buffer.byteLength(line, "utf8") + 1;
		if (bytes + size > OUTLINE_PLAN_LIMITS.promptDiffBytes) {
			cut = true;
			break;
		}
		lines.push(line);
		bytes += size;
	}
	if (cut) lines.push("…");
	return lines.join("\n");
}
