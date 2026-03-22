/** Split-tree data structure for VS Code–style recursive panel splitting. */

let _nextId = 1;
function genId(): string {
	return `sp_${_nextId++}`;
}

export type SplitDirection = "horizontal" | "vertical";

export interface SplitLeaf {
	type: "leaf";
	id: string;
	narratorId: string | null;
}

export interface SplitBranch {
	type: "branch";
	id: string;
	direction: SplitDirection;
	children: SplitNode[];
	/** Percentage sizes for each child, must sum to 100. */
	sizes: number[];
}

export type SplitNode = SplitLeaf | SplitBranch;

// ── Constructors ──

export function createLeaf(narratorId: string | null = null): SplitLeaf {
	return { type: "leaf", id: genId(), narratorId };
}

/** Shorthand: create a leaf with a specific narratorId. */
export function createLeafWith(narratorId: string): SplitLeaf {
	return { type: "leaf", id: genId(), narratorId };
}

/** Create a branch with two children. */
export function createBranch(
	direction: SplitDirection,
	children: SplitNode[],
	sizes?: number[],
): SplitBranch {
	return {
		type: "branch",
		id: genId(),
		direction,
		children,
		sizes: sizes ?? children.map(() => 100 / children.length),
	};
}

// ── Tree operations (immutable) ──

/**
 * Split a leaf into a branch with a copy of the original leaf + a new empty leaf.
 * Uses dedicated recursion instead of mapNode to avoid any self-reference issues.
 */
export function splitLeaf(
	tree: SplitNode,
	leafId: string,
	direction: SplitDirection,
	position: "before" | "after" = "after",
): SplitNode {
	return splitLeafImpl(tree, leafId, direction, position);
}

function splitLeafImpl(
	node: SplitNode,
	leafId: string,
	direction: SplitDirection,
	position: "before" | "after",
): SplitNode {
	if (node.type === "leaf") {
		if (node.id !== leafId) return node;
		// Create a fresh copy of the original leaf (new object, same data)
		const kept: SplitLeaf = { type: "leaf", id: node.id, narratorId: node.narratorId };
		const empty = createLeaf();
		const children = position === "after" ? [kept, empty] : [empty, kept];
		return { type: "branch", id: genId(), direction, children, sizes: [50, 50] };
	}
	// Branch: recurse into children, then flatten same-direction nesting
	const newChildren = node.children.map((c) => splitLeafImpl(c, leafId, direction, position));
	const changed = newChildren.some((c, i) => c !== node.children[i]);
	if (!changed) return node;
	return flattenBranch({ ...node, children: newChildren });
}

/** Split a leaf and assign a narratorId to the newly created leaf. */
export function splitAndAssign(
	tree: SplitNode,
	leafId: string,
	direction: SplitDirection,
	position: "before" | "after",
	narratorId: string,
): SplitNode {
	return splitAndAssignImpl(tree, leafId, direction, position, narratorId);
}

function splitAndAssignImpl(
	node: SplitNode,
	leafId: string,
	direction: SplitDirection,
	position: "before" | "after",
	narratorId: string,
): SplitNode {
	if (node.type === "leaf") {
		if (node.id !== leafId) return node;
		const kept: SplitLeaf = { type: "leaf", id: node.id, narratorId: node.narratorId };
		const assigned = createLeaf(narratorId);
		const children = position === "after" ? [kept, assigned] : [assigned, kept];
		return { type: "branch", id: genId(), direction, children, sizes: [50, 50] };
	}
	const newChildren = node.children.map((c) =>
		splitAndAssignImpl(c, leafId, direction, position, narratorId),
	);
	const changed = newChildren.some((c, i) => c !== node.children[i]);
	if (!changed) return node;
	return flattenBranch({ ...node, children: newChildren });
}

/** Remove a leaf from the tree. If its parent branch has only one child left, collapse it. */
export function removeLeaf(tree: SplitNode, leafId: string): SplitNode | null {
	if (tree.type === "leaf") {
		return tree.id === leafId ? null : tree;
	}
	const newChildren: SplitNode[] = [];
	const newSizes: number[] = [];
	for (let i = 0; i < tree.children.length; i++) {
		const child = tree.children[i];
		if (child.type === "leaf" && child.id === leafId) {
			continue;
		}
		const result = removeLeaf(child, leafId);
		if (result) {
			newChildren.push(result);
			newSizes.push(tree.sizes[i]);
		}
	}
	if (newChildren.length === 0) return null;
	if (newChildren.length === 1) return newChildren[0];
	// Re-normalize sizes
	const total = newSizes.reduce((a, b) => a + b, 0);
	const normalized = newSizes.map((s) => (s / total) * 100);
	return { ...tree, children: newChildren, sizes: normalized };
}

/** Set the narratorId of a specific leaf. */
export function setNarrator(tree: SplitNode, leafId: string, narratorId: string | null): SplitNode {
	return mapLeaf(tree, leafId, (leaf) => ({ ...leaf, narratorId }));
}

/** Update sizes of a specific branch. */
export function updateSizes(tree: SplitNode, branchId: string, sizes: number[]): SplitNode {
	return mapBranch(tree, branchId, (branch) => ({ ...branch, sizes }));
}

/** Collect all non-null narratorIds from the tree. */
export function getAllNarratorIds(tree: SplitNode): string[] {
	const ids: string[] = [];
	walkLeaves(tree, (leaf) => {
		if (leaf.narratorId) ids.push(leaf.narratorId);
	});
	return ids;
}

/** Find the first empty leaf (narratorId === null). */
export function findFirstEmptyLeaf(tree: SplitNode): SplitLeaf | null {
	if (tree.type === "leaf") return tree.narratorId === null ? tree : null;
	for (const child of tree.children) {
		const found = findFirstEmptyLeaf(child);
		if (found) return found;
	}
	return null;
}

/** Count total leaves. */
export function countLeaves(tree: SplitNode): number {
	if (tree.type === "leaf") return 1;
	return tree.children.reduce((sum, c) => sum + countLeaves(c), 0);
}

/** Recursively flatten same-direction nesting throughout the tree. */
export function normalizeTree(node: SplitNode): SplitNode {
	if (node.type === "leaf") return node;
	const normalized = {
		...node,
		children: node.children.map(normalizeTree),
	};
	return flattenBranch(normalized);
}

// ── Helpers (targeted map to avoid generic mapNode pitfalls) ──

/**
 * Flatten same-direction child branches into the parent.
 * e.g. branch(H)[A, branch(H)[B, C]] → branch(H)[A, B, C]
 * The inlined child's sizes are scaled proportionally to the slot it occupied.
 */
function flattenBranch(branch: SplitBranch): SplitBranch {
	const flatChildren: SplitNode[] = [];
	const flatSizes: number[] = [];
	let needsFlatten = false;

	for (let i = 0; i < branch.children.length; i++) {
		const child = branch.children[i];
		if (child.type === "branch" && child.direction === branch.direction) {
			needsFlatten = true;
			const parentSlotPct = branch.sizes[i];
			for (let j = 0; j < child.children.length; j++) {
				flatChildren.push(child.children[j]);
				flatSizes.push((child.sizes[j] / 100) * parentSlotPct);
			}
		} else {
			flatChildren.push(child);
			flatSizes.push(branch.sizes[i]);
		}
	}

	if (!needsFlatten) return branch;
	return { ...branch, children: flatChildren, sizes: flatSizes };
}

/** Map a specific leaf by id. Only touches leaves, never changes node types. */
function mapLeaf(node: SplitNode, leafId: string, fn: (leaf: SplitLeaf) => SplitLeaf): SplitNode {
	if (node.type === "leaf") {
		return node.id === leafId ? fn(node) : node;
	}
	const newChildren = node.children.map((c) => mapLeaf(c, leafId, fn));
	const changed = newChildren.some((c, i) => c !== node.children[i]);
	return changed ? { ...node, children: newChildren } : node;
}

/** Map a specific branch by id. Only touches branches, never changes node types. */
function mapBranch(
	node: SplitNode,
	branchId: string,
	fn: (branch: SplitBranch) => SplitBranch,
): SplitNode {
	if (node.type === "leaf") return node;
	const updated = node.id === branchId ? fn(node) : node;
	const newChildren = updated.children.map((c) => mapBranch(c, branchId, fn));
	const changed = newChildren.some((c, i) => c !== updated.children[i]);
	return changed ? { ...updated, children: newChildren } : updated;
}

function walkLeaves(node: SplitNode, fn: (leaf: SplitLeaf) => void): void {
	if (node.type === "leaf") {
		fn(node);
	} else {
		for (const child of node.children) walkLeaves(child, fn);
	}
}
