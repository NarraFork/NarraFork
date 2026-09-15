/**
 * Nested element (JSX) skeleton.
 *
 * The gap this closes: a UI component's `return` is often the majority of the file —
 *851 of NarratorPanel.tsx's 3479 lines — and produced zero outline entries, because
 * JSX is an expression, not a declaration. Yet for a component, "which children does
 * it render, how deep, and where are the conditional branches" is the first question
 * anyone asks.
 *
 * Named `element-tree` rather than `jsx` because the shape generalizes (Vue/Svelte
 * templates are the same question), but only JSX is implemented; other languages get
 * an explicit "not supported" rather than a silent empty result.
 *
 * Attribute VALUES are always dropped, only structural attribute NAMES are kept. A
 * skeleton with props inlined is just the source code again — the whole point is to
 * fit a 851-line tree into something readable.
 */
import type { SyntaxNode } from "./outline";
import type { ElementNode } from "./provider";

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_NODES = 300;

/** Attributes worth naming: they say something about structure, not styling. */
const STRUCTURAL_ATTRIBUTES = new Set(["ref", "key", "id", "name", "as", "component"]);

export interface BuildElementTreeOptions {
	maxDepth?: number;
	maxNodes?: number;
	/** Include lowercase HTML tags. Off by default — components carry the structure. */
	includeHtml?: boolean;
	signal?: AbortSignal;
}

export interface ElementTreeResult {
	roots: ElementNode[];
	truncated: boolean;
	/** Total elements seen, including ones omitted by the caps or the HTML filter. */
	total: number;
}

/** Build the element skeleton for a parsed file. */
export function buildElementTree(
	root: SyntaxNode,
	options: BuildElementTreeOptions = {},
): ElementTreeResult {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
	const includeHtml = options.includeHtml ?? false;

	const state = { emitted: 0, total: 0, truncated: false };
	const roots: ElementNode[] = [];

	// Find outermost JSX nodes, then recurse. Scanning for the top-level ones first
	// keeps `depth` meaningful: it counts element nesting, not AST distance from the
	// file root (which would vary with how the JSX happens to be wrapped).
	const outermost = findOutermostElements(root, options.signal);
	for (const node of outermost) {
		const built = buildNode(node, 0, maxDepth, maxNodes, includeHtml, state, options.signal);
		if (built) roots.push(built);
	}

	return { roots, truncated: state.truncated, total: state.total };
}

function isElementNode(type: string): boolean {
	return type === "jsx_element" || type === "jsx_self_closing_element" || type === "jsx_fragment";
}

function findOutermostElements(root: SyntaxNode, signal?: AbortSignal): SyntaxNode[] {
	const found: SyntaxNode[] = [];
	const stack: SyntaxNode[] = [root];
	while (stack.length > 0) {
		if (signal?.aborted) break;
		const node = stack.pop();
		if (!node) continue;
		if (isElementNode(node.type)) {
			// Do not descend: children are handled by buildNode, which tracks depth.
			found.push(node);
			continue;
		}
		for (let i = 0; i < node.childCount; i++) {
			const child = node.child(i);
			if (child) stack.push(child);
		}
	}
	// Document order; the stack walk yields them reversed.
	return found.sort((a, b) => a.startIndex - b.startIndex);
}

function buildNode(
	node: SyntaxNode,
	depth: number,
	maxDepth: number,
	maxNodes: number,
	includeHtml: boolean,
	state: { emitted: number; total: number; truncated: boolean },
	signal?: AbortSignal,
): ElementNode | null {
	if (signal?.aborted) return null;
	state.total++;

	const name = readElementName(node);
	const html = isHtmlTag(name);

	if (html && !includeHtml) {
		// A skipped host element must not hide its component children — a `<div>` wrapping
		// the real content is exactly the case where dropping the subtree would lose
		// everything worth seeing. Children are lifted to this element's own depth.
		const lifted: ElementNode[] = [];
		for (const child of childElements(node)) {
			const built = buildNode(child, depth, maxDepth, maxNodes, includeHtml, state, signal);
			if (built) lifted.push(built);
		}
		// Only one survivor can take this slot; more than one would need a synthetic
		// parent, and inventing nodes in a structural view is worse than the flattening.
		return lifted.length === 1
			? (lifted[0] ?? null)
			: lifted.length === 0
				? null
				: {
						name: name || "div",
						line: node.startPosition.row + 1,
						endLine: node.endPosition.row + 1,
						html: true,
						children: lifted,
					};
	}

	if (state.emitted >= maxNodes) {
		state.truncated = true;
		return null;
	}
	state.emitted++;

	const element: ElementNode = {
		name: name || "<>",
		line: node.startPosition.row + 1,
		endLine: node.endPosition.row + 1,
		...(html ? { html: true } : {}),
	};

	const attributes = readStructuralAttributes(node);
	if (attributes.length > 0) element.attributes = attributes;

	const condition = readCondition(node);
	if (condition) element.condition = condition;

	if (depth >= maxDepth) {
		if (childElements(node).length > 0) state.truncated = true;
		return element;
	}

	const children: ElementNode[] = [];
	for (const child of childElements(node)) {
		const built = buildNode(child, depth + 1, maxDepth, maxNodes, includeHtml, state, signal);
		if (built) children.push(built);
	}
	if (children.length > 0) element.children = children;
	return element;
}

/** Direct element descendants, looking through expression containers. */
function childElements(node: SyntaxNode): SyntaxNode[] {
	const result: SyntaxNode[] = [];
	const visit = (current: SyntaxNode, isRoot: boolean): void => {
		for (let i = 0; i < current.childCount; i++) {
			const child = current.child(i);
			if (!child) continue;
			if (isElementNode(child.type)) {
				result.push(child);
				continue;
			}
			// `{cond && <X/>}`, `{items.map(i => <Row/>)}` — the element is buried inside an
			// expression, so we look through it rather than treating it as a leaf.
			if (child.type === "jsx_expression" || !isRoot) {
				visit(child, false);
				continue;
			}
			if (child.type === "jsx_opening_element" || child.type === "jsx_closing_element") continue;
			visit(child, false);
		}
	};
	visit(node, true);
	return result;
}

function readElementName(node: SyntaxNode): string {
	if (node.type === "jsx_fragment") return "<>";
	const open = node.type === "jsx_element" ? node.childForFieldName("open_tag") : node;
	const name = open?.childForFieldName("name")?.text;
	return name ? name.trim() : "";
}

function isHtmlTag(name: string): boolean {
	if (name.length === 0 || name === "<>") return false;
	const first = name[0];
	// JSX's own rule: lowercase means a host element, uppercase means a component.
	return first !== undefined && first === first.toLowerCase() && /[a-z]/.test(first);
}

function readStructuralAttributes(node: SyntaxNode): string[] {
	const open = node.type === "jsx_element" ? node.childForFieldName("open_tag") : node;
	if (!open) return [];
	const names: string[] = [];
	for (let i = 0; i < open.childCount; i++) {
		const attr = open.child(i);
		if (attr?.type !== "jsx_attribute") continue;
		const attrName = attr.child(0)?.text?.trim();
		if (attrName && STRUCTURAL_ATTRIBUTES.has(attrName)) names.push(attrName);
	}
	return names;
}

/**
 * How this element is conditionally rendered.
 *
 * Walks up through the expression wrappers, because `{cond && <X/>}` puts the element
 * two levels below the `jsx_expression`. Knowing an element is inside a `.map` or
 * behind a guard is often the actual answer to "why isn't this rendering".
 */
function readCondition(node: SyntaxNode): ElementNode["condition"] | undefined {
	let cursor = node.parent;
	let hops = 0;
	while (cursor && hops < 5) {
		switch (cursor.type) {
			case "binary_expression":
				return cursor.text.includes("&&") ? "and" : undefined;
			case "ternary_expression":
				return "ternary";
			case "arrow_function":
				// An arrow directly inside a call is a render callback: `.map(i => <Row/>)`.
				return cursor.parent?.type === "arguments" ? "map" : undefined;
			case "jsx_expression":
			case "parenthesized_expression":
				break;
			default:
				return undefined;
		}
		cursor = cursor.parent;
		hops++;
	}
	return undefined;
}
