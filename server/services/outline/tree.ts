/**
 * Outline trees in memory: built from the structure rows of one page, siblings in the order the
 * editor shows them, walked breadth first for budgeted expansion. Pure; no database.
 *
 * FACTS AND PROCESS
 * -----------------
 * A task (a block with a checkbox, whatever its state) and everything under it is process;
 * every other block is a fact. Nothing is stored for it: it follows from the tree. Content of a
 * session space is process too when it is read from another space (`isProcessBlock`). The
 * facts view of a tree leaves process out: it never descends into a task.
 */
import { compareOrderKeys } from "@shared/outline";
import type { OutlineTaskJson } from "./model";
import type { OutlineStructureRow } from "./store/read-port";

export interface OutlineNode {
	id: string;
	sid: string;
	parentId: string | null;
	orderKey: string;
	alias: string | null;
	task: OutlineTaskJson | null;
	/** Seq of the commit that produced this state of the block. */
	versionSeq: number;
	parent: OutlineNode | null;
	/** Live children in sibling order. */
	children: OutlineNode[];
	/** The block's content; null until loaded. */
	content: string | null;
	/** Tag targets, sorted; null until loaded. */
	tags: string[] | null;
}

/** `facts` leaves process (tasks and what is under them) out; `all` shows everything. */
export type OutlineView = "facts" | "all";

function bySiblingOrder(a: OutlineNode, b: OutlineNode): number {
	return compareOrderKeys(a.orderKey, b.orderKey) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Nodes for the rows, linked to their parents and ordered among siblings. A row whose parent is
 * not among the rows (a read cut short) stays unlinked: it is not reachable from the page.
 */
export function buildTree(rows: readonly OutlineStructureRow[]): Map<string, OutlineNode> {
	const byId = new Map<string, OutlineNode>();
	for (const row of rows) {
		byId.set(row.id, {
			id: row.id,
			sid: row.sid,
			parentId: row.parentId,
			orderKey: row.orderKey,
			alias: row.alias,
			task: row.taskJson,
			versionSeq: row.versionSeq,
			parent: null,
			children: [],
			content: null,
			tags: null,
		});
	}
	for (const node of byId.values()) {
		const parent = node.parentId === null ? undefined : byId.get(node.parentId);
		if (!parent) continue;
		node.parent = parent;
		parent.children.push(node);
	}
	for (const node of byId.values()) {
		if (node.children.length > 1) node.children.sort(bySiblingOrder);
	}
	return byId;
}

/** Ancestors of a node, nearest last (the page first). */
export function ancestorsOf(node: OutlineNode): OutlineNode[] {
	const out: OutlineNode[] = [];
	for (let p = node.parent; p; p = p.parent) out.push(p);
	return out.reverse();
}

/** Whether the node is a task or under one. */
export function isUnderTask(node: OutlineNode): boolean {
	for (let n: OutlineNode | null = node; n; n = n.parent) if (n.task) return true;
	return false;
}

/**
 * Whether a block is process: it is a task or under one, or it is in a session space and is
 * read from anywhere but that space.
 */
export function isProcessBlock(block: {
	underTask: boolean;
	spaceKind: string;
	spaceId: string;
	contextSpaceId?: string | null;
}): boolean {
	return (
		block.underTask || (block.spaceKind === "session" && block.spaceId !== block.contextSpaceId)
	);
}

/**
 * The view a read of `root` gets: a task, or anything under one, is shown whole whatever was
 * asked, since a facts view of process would be empty.
 */
export function effectiveView(root: OutlineNode, view: OutlineView): OutlineView {
	return view === "facts" && isUnderTask(root) ? "all" : view;
}

/** Children shown in a view: the facts view leaves tasks out, and with them their subtrees. */
export function viewChildren(node: OutlineNode, view: OutlineView): OutlineNode[] {
	return view === "all" ? node.children : node.children.filter((c) => c.task === null);
}

/** Every node of the subtree, root first, breadth first. */
export function subtreeNodes(root: OutlineNode): OutlineNode[] {
	const out = [root];
	for (let i = 0; i < out.length; i++) out.push(...(out[i] as OutlineNode).children);
	return out;
}

/** The nodes a view shows of the subtree, root first, breadth first, at most `limit`. */
export function breadthFirst(root: OutlineNode, view: OutlineView, limit: number): OutlineNode[] {
	const out = [root];
	for (let i = 0; i < out.length && out.length < limit; i++) {
		for (const child of viewChildren(out[i] as OutlineNode, view)) {
			if (out.length >= limit) break;
			out.push(child);
		}
	}
	return out.slice(0, Math.max(0, limit));
}
