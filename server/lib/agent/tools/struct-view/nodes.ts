/**
 * Outline-node helpers: flattening, reference annotation, depth/kind/export filtering, and
 * the failed-extract symbol suggestion.
 *
 * All operate on `OutlineNode` trees the provider returns, independent of rendering, so the
 * analysis and outline modes share them without going through the tool shell.
 */

import type {
	ElementNode,
	LocatedNode,
	OutlineNode,
	StructDocument,
	StructKind,
} from "../../structural";
import type { Resolved } from "./render";

export function countElements(nodes: readonly ElementNode[]): number {
	let total = 0;
	for (const node of nodes) {
		total += 1;
		if (node.children) total += countElements(node.children);
	}
	return total;
}

/** Flatten an outline into document order, for the analysis modes. */
export function flattenPublic(nodes: readonly OutlineNode[]): OutlineNode[] {
	const out: OutlineNode[] = [];
	const walk = (list: readonly OutlineNode[]): void => {
		for (const node of list) {
			out.push(node);
			if (node.children) walk(node.children);
		}
	};
	walk(nodes);
	return out;
}

/**
 * Reference count for one outline entry.
 *
 * A destructuring declaration takes the MAXIMUM over its bindings, not the sum: the
 * question at the declaration level is "is any of this used", and summing 27 bound
 * names would manufacture usage that does not exist.
 *
 * The cost of that choice is that a partially-dead destructure looks alive, which for
 * `const [value, setValue] = useState()` is the common case rather than an edge one —
 * an unused `value` beside a used `setValue` is invisible here. `unusedBindings` covers
 * it separately instead of distorting this number.
 */
export function refsForNode(
	node: OutlineNode,
	counts: ReadonlyMap<string, number>,
): number | undefined {
	if (node.bindings && node.bindings.length > 0) {
		let max = 0;
		for (const binding of node.bindings) max = Math.max(max, counts.get(binding) ?? 0);
		return max > 0 ? max : undefined;
	}
	return counts.get(node.name);
}

/**
 * Whether a name carries the "kept on purpose" convention.
 *
 * A single leading underscore is the widespread signal for a deliberately unused binding.
 * Dunder names (`__proto__`) and the bare `_` placeholder are covered by the same rule.
 */
export function isIntentionallyKept(name: string): boolean {
	return name.startsWith("_");
}

/**
 * Reference lines for one outline row.
 *
 * Unlike `refsForNode`, a destructuring declaration UNIONS its bindings' lines rather than
 * taking a maximum: the question is "where is this touched", and every binding's position
 * belongs in that answer.
 */
export function refLinesForNode(
	node: OutlineNode,
	lines: ReadonlyMap<string, number[]> | null,
): number[] | undefined {
	if (!lines) return undefined;
	if (node.bindings && node.bindings.length > 0) {
		const union = new Set<number>();
		for (const binding of node.bindings) {
			for (const line of lines.get(binding) ?? []) union.add(line);
		}
		return union.size > 0 ? [...union].sort((a, b) => a - b) : undefined;
	}
	return lines.get(node.name);
}

/**
 * Individually unused names inside otherwise-live destructures.
 *
 * `const [_phase, setPhase] = useState()` where only the setter is used is a real and
 * frequent shape; the declaration is alive, one of its bindings is not. Rest elements
 * are excluded because `...rest` being unreferenced says nothing useful.
 */
export function unusedBindings(
	nodes: readonly OutlineNode[],
	counts: ReadonlyMap<string, number>,
): Array<{ name: string; line: number }> {
	const found: Array<{ name: string; line: number }> = [];
	for (const node of nodes) {
		if (!node.bindings || node.bindings.length < 2) continue;
		for (const binding of node.bindings) {
			if (binding.startsWith("...")) continue;
			if ((counts.get(binding) ?? 0) <= 1) found.push({ name: binding, line: node.startLine });
		}
	}
	return found.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

export function annotateRefs(
	nodes: readonly OutlineNode[],
	counts: ReadonlyMap<string, number>,
): OutlineNode[] {
	return nodes.map((node) => {
		const refs = node.kind === "call" ? undefined : refsForNode(node, counts);
		return {
			...node,
			...(refs != null ? { refs } : {}),
			...(node.children ? { children: annotateRefs(node.children, counts) } : {}),
		};
	});
}

export function limitDepth(nodes: readonly OutlineNode[], maxDepth: number): OutlineNode[] {
	if (maxDepth <= 1) return nodes.map((node) => stripChildren(node));
	return nodes.map((node) =>
		node.children?.length
			? { ...node, children: limitDepth(node.children, maxDepth - 1) }
			: { ...node },
	);
}

function stripChildren(node: OutlineNode): OutlineNode {
	const { children: _children, ...rest } = node;
	return rest;
}

/**
 * Keep exported declarations, retaining a non-exported parent that contains one.
 *
 * A class does not have to be exported for its public methods to matter (a default
 * export, a class returned from a factory), and dropping the parent would leave
 * methods floating with no indication of what they belong to.
 */
export function keepExported(nodes: readonly OutlineNode[]): OutlineNode[] {
	const out: OutlineNode[] = [];
	for (const node of nodes) {
		const children = node.children ? keepExported(node.children) : [];
		if (node.exported) {
			out.push(children.length > 0 ? { ...node, children } : stripChildren(node));
		} else if (children.length > 0) {
			out.push({ ...node, children });
		}
	}
	return out;
}

/** Keep nodes of the requested kinds, plus ancestors needed to reach them. */
export function filterKinds(nodes: readonly OutlineNode[], kinds: StructKind[]): OutlineNode[] {
	const wanted = new Set(kinds);
	const out: OutlineNode[] = [];
	for (const node of nodes) {
		const children = node.children ? filterKinds(node.children, kinds) : [];
		if (wanted.has(node.kind)) {
			out.push(children.length > 0 ? { ...node, children } : stripChildren(node));
		} else if (children.length > 0) {
			out.push({ ...node, children });
		}
	}
	return out;
}

export function countNodes(nodes: readonly OutlineNode[]): number {
	let total = 0;
	for (const node of nodes) {
		total += 1;
		if (node.children) total += countNodes(node.children);
	}
	return total;
}

const KNOWN_KINDS = new Set<string>([
	"function",
	"method",
	"class",
	"interface",
	"struct",
	"enum",
	"trait",
	"impl",
	"type",
	"constant",
	"variable",
	"property",
	"field",
	"module",
	"namespace",
	"constructor",
	"getter",
	"setter",
	"test",
	"unknown",
]);

export function parseKinds(raw: string | undefined): StructKind[] | null {
	if (!raw) return null;
	const kinds = raw
		.split(",")
		.map((part) => part.trim().toLowerCase())
		.filter((part) => KNOWN_KINDS.has(part)) as StructKind[];
	return kinds.length > 0 ? kinds : null;
}

/** Compact symbol list for a failed `extract`, so the retry is informed. */
export async function suggestSymbols(
	doc: StructDocument,
	resolved: Resolved,
): Promise<string | null> {
	const nodes = await resolved.provider.outline(doc);
	const flat: LocatedNode[] = [];
	const walk = (list: readonly OutlineNode[], prefix: string): void => {
		for (const node of list) {
			const path = prefix ? `${prefix}.${node.name}` : node.name;
			flat.push({
				kind: node.kind,
				name: node.name,
				symbolPath: path,
				startIndex: 0,
				endIndex: 0,
				startLine: node.startLine,
				endLine: node.endLine,
				exported: node.exported,
			});
			if (node.children) walk(node.children, path);
		}
	};
	walk(nodes, "");
	if (flat.length === 0) return null;
	const shown = flat.slice(0, 60);
	const lines = shown.map((n) => `  L${n.startLine}  ${n.kind} ${n.symbolPath}`);
	if (flat.length > shown.length) lines.push(`  … ${flat.length - shown.length} more`);
	return lines.join("\n");
}
