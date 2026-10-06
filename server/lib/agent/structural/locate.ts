/**
 * Selector resolution — the read/write shared address.
 *
 * StructView slices the file with what this returns; StructSed will turn the same
 * result into an edit range. Keeping one implementation is what makes "you can
 * change exactly what you just looked at" a property of the system rather than a
 * coincidence, so it deliberately works off the outline tree instead of re-querying
 * the AST with a write-specific matcher.
 */
import { flattenOutline, type RichOutlineNode } from "./outline";
import type { LocatedNode, StructPosition, StructSelector } from "./provider";

/** Turn an outline node into the flat shape callers act on. */
export function toLocatedNode(node: RichOutlineNode): LocatedNode {
	return {
		kind: node.kind,
		name: node.name,
		symbolPath: node.symbolPath,
		...(node.signature ? { signature: node.signature } : {}),
		startIndex: node.startIndex,
		endIndex: node.endIndex,
		startLine: node.startLine,
		endLine: node.endLine,
		exported: node.exported,
		...(node.modifiers ? { modifiers: node.modifiers } : {}),
	};
}

/**
 * Resolve a selector against an outline.
 *
 * Returns ALL matches rather than just the best one, so the caller can report the
 * ambiguity instead of silently picking. Guessing between two same-named methods is
 * how a tool edits the wrong function; `nth` exists precisely so the model can
 * choose after seeing the candidates.
 *
 * Matching order for `symbol`:
 *   1. exact `symbolPath` (`PaymentService.charge`)
 *   2. suffix on a path boundary (`charge` → `PaymentService.charge`)
 *   3. bare name equality
 * Earlier tiers win outright — once an exact path matches, looser interpretations
 * are not candidates at all.
 */
export function locateInOutline(
	nodes: readonly RichOutlineNode[],
	selector: StructSelector,
): LocatedNode[] {
	const flat = flattenOutline(nodes);
	const kindFilter = selector.kinds && selector.kinds.length > 0 ? new Set(selector.kinds) : null;

	let candidates = flat;
	if (selector.symbol) {
		const target = selector.symbol;
		const exact = flat.filter((n) => n.symbolPath === target);
		const suffix = flat.filter((n) => n.symbolPath.endsWith(`.${target}`));
		const bare = flat.filter((n) => n.name === target);
		// Last tier: a name bound by a destructuring declaration. Its `name` is a
		// collapsed label (`{ a, b, …+24 }`), so without this the only way to reach the
		// line that binds `viewers` would be to already know the whole pattern.
		// Deliberately the weakest tier — a real declaration named `viewers` wins.
		const bound = flat.filter((n) => n.bindings?.includes(target));
		candidates =
			exact.length > 0 ? exact : suffix.length > 0 ? suffix : bare.length > 0 ? bare : bound;
	}

	if (kindFilter) {
		candidates = candidates.filter((n) => kindFilter.has(n.kind));
	}

	const located = candidates.map(toLocatedNode);
	if (selector.nth != null) {
		const index = selector.nth - 1;
		const picked = located[index];
		return picked ? [picked] : [];
	}
	return located;
}

/**
 * Innermost-first chain of declarations containing a position.
 *
 * This is what turns a Grep line number into "it lives in
 * `PaymentService.charge`" without a follow-up Read. Positions are 1-based to match
 * editors and Grep output; a column narrows ties on a single line (`a(); b();`).
 */
export function enclosingInOutline(
	nodes: readonly RichOutlineNode[],
	position: StructPosition,
): LocatedNode[] {
	const chain: LocatedNode[] = [];
	let level: readonly RichOutlineNode[] = nodes;

	while (level.length > 0) {
		const containing = level.find((node) => containsLine(node, position.line));
		if (!containing) break;
		chain.push(toLocatedNode(containing));
		level = containing.children ?? [];
	}

	// Innermost first: a caller usually wants the function, and can walk outward
	// through the rest of the chain for the class.
	return chain.reverse();
}

function containsLine(node: RichOutlineNode, line: number): boolean {
	return node.startLine <= line && line <= node.endLine;
}

/** Parse `"42"` or `"42:8"` into a position. Returns null for anything else. */
export function parsePosition(raw: string): StructPosition | null {
	const trimmed = raw.trim();
	const match = /^(\d+)(?::(\d+))?$/.exec(trimmed);
	if (!match) return null;
	const line = Number(match[1]);
	if (!Number.isFinite(line) || line < 1) return null;
	const column = match[2] ? Number(match[2]) : undefined;
	return column != null && Number.isFinite(column) && column >= 1 ? { line, column } : { line };
}

/**
 * Parse a symbol selector string.
 *
 * `Class.method` addresses a member; a trailing `#2` disambiguates among same-named
 * matches, so a model that saw two `charge` candidates can name the second one
 * without a new parameter.
 */
export function parseSymbolSelector(raw: string): { symbol: string; nth?: number } {
	const trimmed = raw.trim();
	const hashMatch = /^(.*?)#(\d+)$/.exec(trimmed);
	if (hashMatch?.[1] && hashMatch[2]) {
		const nth = Number(hashMatch[2]);
		return Number.isFinite(nth) && nth >= 1
			? { symbol: hashMatch[1].trim(), nth }
			: { symbol: hashMatch[1].trim() };
	}
	return { symbol: trimmed };
}
