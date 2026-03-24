/** Split-tree data structure for VS Code–style recursive panel splitting. */

let _nextId = 1;
function genId(): string {
	return `sp_${_nextId++}`;
}

export type SplitDirection = "horizontal" | "vertical";

export type PanelType = "narrator" | "terminal";

export interface TerminalLeafConfig {
	/** Bind to a narrator's terminal list */
	narratorId?: string;
	/** Bind to a chapter's terminal list */
	chapterId?: string;
	/** Standalone terminal CWD (when neither narratorId nor chapterId) */
	cwd?: string;
}

export interface SplitLeaf {
	type: "leaf";
	id: string;
	/** Panel type — defaults to "narrator" for backward compat. */
	panelType?: PanelType;
	narratorId: string | null;
	/** Config for terminal panels (only when panelType === "terminal"). */
	terminalConfig?: TerminalLeafConfig | null;
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
	return { type: "leaf", id: genId(), panelType: "narrator", narratorId };
}

/** Shorthand: create a leaf with a specific narratorId. */
export function createLeafWith(narratorId: string): SplitLeaf {
	return { type: "leaf", id: genId(), panelType: "narrator", narratorId };
}

/** Create a terminal-type leaf. */
export function createTerminalLeaf(config: TerminalLeafConfig): SplitLeaf {
	return {
		type: "leaf",
		id: genId(),
		panelType: "terminal",
		narratorId: null,
		terminalConfig: config,
	};
}

/** Resolve panelType for a leaf, defaulting to "narrator" for backward compat. */
export function leafPanelType(leaf: SplitLeaf): PanelType {
	return leaf.panelType ?? "narrator";
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
		const kept: SplitLeaf = { ...node };
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
		const kept: SplitLeaf = { ...node };
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

/** Split a leaf and assign a terminal config to the newly created leaf. */
export function splitAndAssignTerminal(
	tree: SplitNode,
	leafId: string,
	direction: SplitDirection,
	position: "before" | "after",
	config: TerminalLeafConfig,
): SplitNode {
	return splitAndAssignTerminalImpl(tree, leafId, direction, position, config);
}

function splitAndAssignTerminalImpl(
	node: SplitNode,
	leafId: string,
	direction: SplitDirection,
	position: "before" | "after",
	config: TerminalLeafConfig,
): SplitNode {
	if (node.type === "leaf") {
		if (node.id !== leafId) return node;
		const kept: SplitLeaf = { ...node };
		const terminal = createTerminalLeaf(config);
		const children = position === "after" ? [kept, terminal] : [terminal, kept];
		return { type: "branch", id: genId(), direction, children, sizes: [50, 50] };
	}
	const newChildren = node.children.map((c) =>
		splitAndAssignTerminalImpl(c, leafId, direction, position, config),
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
	return mapLeaf(tree, leafId, (leaf) => ({
		...leaf,
		panelType: "narrator",
		narratorId,
		terminalConfig: undefined,
	}));
}

/** Convert a leaf to a terminal panel. */
export function setTerminalConfig(
	tree: SplitNode,
	leafId: string,
	config: TerminalLeafConfig,
): SplitNode {
	return mapLeaf(tree, leafId, (leaf) => ({
		...leaf,
		panelType: "terminal",
		narratorId: null,
		terminalConfig: config,
	}));
}

/** Update sizes of a specific branch. */
export function updateSizes(tree: SplitNode, branchId: string, sizes: number[]): SplitNode {
	return mapBranch(tree, branchId, (branch) => ({ ...branch, sizes }));
}

/**
 * Distribute all branch children sizes evenly.
 * Applied recursively to every branch in the tree.
 */
export function distributeSizes(tree: SplitNode): SplitNode {
	if (tree.type === "leaf") return tree;
	const evenSizes = tree.children.map(() => 100 / tree.children.length);
	const updated: SplitBranch = { ...tree, sizes: evenSizes };
	return {
		...updated,
		children: updated.children.map((child) => distributeSizes(child)),
	};
}

/** Collect all non-null narratorIds from narrator-type leaves. */
export function getAllNarratorIds(tree: SplitNode): string[] {
	const ids: string[] = [];
	walkLeaves(tree, (leaf) => {
		if (leafPanelType(leaf) === "narrator" && leaf.narratorId) ids.push(leaf.narratorId);
	});
	return ids;
}

/** Find the first empty narrator-type leaf (narratorId === null). */
export function findFirstEmptyLeaf(tree: SplitNode): SplitLeaf | null {
	if (tree.type === "leaf")
		return leafPanelType(tree) === "narrator" && tree.narratorId === null ? tree : null;
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

/**
 * Move a leaf from one position to another in a single atomic operation.
 * The source leaf is removed and its narratorId is placed in a new leaf
 * adjacent to the target leaf (split in the given direction/position).
 *
 * This is safer than removeLeaf + splitAndAssign because it handles the case
 * where removing the source leaf collapses a branch that contains the target.
 */
export function moveLeaf(
	tree: SplitNode,
	sourceLeafId: string,
	targetLeafId: string,
	direction: SplitDirection,
	position: "before" | "after",
): SplitNode {
	if (sourceLeafId === targetLeafId) return tree;

	// 1. Find the source leaf data
	let found: SplitLeaf | null = null;
	walkLeaves(tree, (leaf) => {
		if (leaf.id === sourceLeafId) found = { ...leaf };
	});
	if (!found) return tree;
	const sourceLeaf: SplitLeaf = found;

	// For narrator leaves, require a narratorId to move
	const srcType = leafPanelType(sourceLeaf);
	if (srcType === "narrator" && !sourceLeaf.narratorId) return tree;

	// 2. Clear the source leaf content
	let result: SplitNode = mapLeaf(tree, sourceLeafId, (l) => ({
		...l,
		narratorId: null,
		panelType: "narrator" as PanelType,
		terminalConfig: undefined,
	}));

	// 3. Split the target leaf and place the source content
	if (srcType === "terminal" && sourceLeaf.terminalConfig) {
		result = splitAndAssignTerminal(
			result,
			targetLeafId,
			direction,
			position,
			sourceLeaf.terminalConfig,
		);
	} else if (sourceLeaf.narratorId) {
		result = splitAndAssign(result, targetLeafId, direction, position, sourceLeaf.narratorId);
	}

	// 4. Remove the now-empty source leaf
	const cleaned = removeLeaf(result, sourceLeafId);
	return cleaned ?? result;
}

/** Swap the full content of two leaves identified by their leaf ids. */
export function swapLeaves(tree: SplitNode, leafIdA: string, leafIdB: string): SplitNode {
	if (leafIdA === leafIdB) return tree;
	let leafA: SplitLeaf | undefined;
	let leafB: SplitLeaf | undefined;
	walkLeaves(tree, (leaf) => {
		if (leaf.id === leafIdA) leafA = leaf;
		if (leaf.id === leafIdB) leafB = leaf;
	});
	if (!leafA || !leafB) return tree;
	// Capture into const to satisfy closure narrowing
	const dataA = leafA;
	const dataB = leafB;
	// Swap all content fields
	let result = mapLeaf(tree, leafIdA, () => ({
		...dataB,
		id: leafIdA,
	}));
	result = mapLeaf(result, leafIdB, () => ({
		...dataA,
		id: leafIdB,
	}));
	return result;
}

/** Find the leaf id that holds a given narratorId. */
export function findLeafByNarrator(tree: SplitNode, narratorId: string): string | null {
	let found: string | null = null;
	walkLeaves(tree, (leaf) => {
		if (leaf.narratorId === narratorId) found = leaf.id;
	});
	return found;
}

function walkLeaves(node: SplitNode, fn: (leaf: SplitLeaf) => void): void {
	if (node.type === "leaf") {
		fn(node);
	} else {
		for (const child of node.children) walkLeaves(child, fn);
	}
}

/**
 * Add a narrator to the tree.
 * If an empty leaf exists, fill it; otherwise split the last leaf horizontally.
 */
export function addLeaf(tree: SplitNode, narratorId: string): SplitNode {
	const empty = findFirstEmptyLeaf(tree);
	if (empty) return setNarrator(tree, empty.id, narratorId);
	// Find the last leaf and split it
	const lastLeaf = findLastLeaf(tree);
	if (!lastLeaf) return tree;
	return splitAndAssign(tree, lastLeaf.id, "horizontal", "after", narratorId);
}

/** Find the last narrator-type leaf with a narratorId. */
export function findLastNarratorLeaf(node: SplitNode): SplitLeaf | null {
	if (node.type === "leaf") {
		return leafPanelType(node) === "narrator" && node.narratorId ? node : null;
	}
	for (let i = node.children.length - 1; i >= 0; i--) {
		const found = findLastNarratorLeaf(node.children[i]);
		if (found) return found;
	}
	return null;
}

function findLastLeaf(node: SplitNode): SplitLeaf | null {
	if (node.type === "leaf") return node;
	for (let i = node.children.length - 1; i >= 0; i--) {
		const found = findLastLeaf(node.children[i]);
		if (found) return found;
	}
	return null;
}
