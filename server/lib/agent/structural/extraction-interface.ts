/**
 * What it would take to extract a range of lines.
 *
 * `outline` answers "what is in this file"; it cannot answer the question that actually
 * blocks a refactor: "is L2177-2418 a self-contained unit, and if I pull it out, what does
 * its signature have to be?" A report from a real session described the workaround — probe
 * `print 2177,2320`, `print 2317,2425`, `print 2107,2179` and reconstruct the boundary by
 * hand, because the tools gave counts but never distributions.
 *
 * This module turns the position index into that answer by classifying every symbol into
 * one of three groups:
 *
 * - `needsInput`  — defined OUTSIDE, used INSIDE. Becomes a parameter or an import.
 * - `needsExport` — defined INSIDE, used OUTSIDE. Must be exported, or those callers break.
 * - `selfContained` — defined and used only INSIDE. Moves along with the block, invisibly.
 *
 * A range whose `needsExport` is empty and whose `needsInput` is short is a clean seam. A
 * range with 20 entries in each direction is not a unit at all, and that is worth knowing
 * before writing any code.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────────────
 * This is name-based and single-file. Two distinct symbols sharing a name collapse
 * together, shadowed bindings read as one symbol, and a name used only in another file is
 * invisible. It is a map of the seam, not a proof of correctness — the same caveat that
 * applies to every other count in this toolset.
 */

import type { OutlineNode } from "./provider";
import { partitionByRange } from "./references";

export interface RangeSpec {
	/** 1-based inclusive. */
	startLine: number;
	endLine: number;
}

export interface InterfaceSymbol {
	name: string;
	/** What the declaration is, when it is one we can see (`function`, `const`…). */
	kind?: string;
	/** Where it is declared, when declared in this file. */
	declaredAt?: number;
	/** Reference lines inside the range. */
	inside: number[];
	/** Reference lines outside the range. */
	outside: number[];
	/** Already part of the module's public surface, so exporting is a no-op. */
	exported?: boolean;
}

export interface ExtractionInterface {
	range: RangeSpec;
	/** Defined outside, used inside: the parameters/imports the extracted unit needs. */
	needsInput: InterfaceSymbol[];
	/** Defined inside, used outside: what must be exported for callers to keep working. */
	needsExport: InterfaceSymbol[];
	/** Defined and used only inside: moves with the block. */
	selfContained: InterfaceSymbol[];
	/** Declarations wholly contained in the range, for a "what am I moving" summary. */
	declarationsInRange: OutlineNode[];
	/** True when the reference walk hit its cap, so the classification is a lower bound. */
	truncated: boolean;
}

/** Is a declaration wholly inside the range? */
function containedBy(node: OutlineNode, range: RangeSpec): boolean {
	return node.startLine >= range.startLine && node.endLine <= range.endLine;
}

/** Does a declaration straddle the range boundary? */
function straddles(node: OutlineNode, range: RangeSpec): boolean {
	const startsBefore = node.startLine < range.startLine;
	const endsAfter = node.endLine > range.endLine;
	const overlaps = node.startLine <= range.endLine && node.endLine >= range.startLine;
	return overlaps && (startsBefore || endsAfter);
}

/**
 * Names a declaration introduces.
 *
 * A destructuring declaration introduces its bindings, not its collapsed label — the label
 * is display text like `{ a, b, …+24 }` and would never match an identifier.
 */
function declaredNames(node: OutlineNode): string[] {
	if (node.bindings && node.bindings.length > 0) return node.bindings;
	return node.name ? [node.name] : [];
}

export interface AnalyzeOptions {
	/** Cap per group, so one hot range cannot produce an unreadable answer. */
	limit?: number;
	/** Reference walk hit its node cap upstream. */
	truncated?: boolean;
}

/**
 * Classify the symbols crossing a range boundary.
 *
 * `referenceLines` maps identifier → the 1-based lines it appears on (from the position
 * index). `outline` supplies declaration ranges so a symbol can be attributed to the side
 * it is DECLARED on, which is what distinguishes "needs to be passed in" from "needs to be
 * exported" — a distinction reference counts alone cannot make.
 */
export function analyzeExtraction(
	range: RangeSpec,
	outline: readonly OutlineNode[],
	referenceLines: ReadonlyMap<string, number[]>,
	options: AnalyzeOptions = {},
): ExtractionInterface {
	const limit = options.limit ?? 40;

	// Declaration site per name. Built from the outline rather than from first-reference
	// order, because a symbol referenced above its declaration (a hoisted function, a
	// forward reference) would otherwise be attributed to the wrong side.
	const declaredIn = new Map<string, OutlineNode>();
	for (const node of outline) {
		if (node.kind === "call") continue;
		for (const name of declaredNames(node)) {
			const existing = declaredIn.get(name);
			// Prefer the OUTERMOST declaration: an inner shadow is a different entity we
			// cannot distinguish by name, and treating the outer one as canonical keeps the
			// "defined outside" verdict conservative.
			if (!existing || node.depth < existing.depth) declaredIn.set(name, node);
		}
	}

	const needsInput: InterfaceSymbol[] = [];
	const needsExport: InterfaceSymbol[] = [];
	const selfContained: InterfaceSymbol[] = [];

	for (const [name, lines] of referenceLines) {
		const { inside, outside } = partitionByRange(lines, range);
		if (inside.length === 0) continue; // Irrelevant to this range.

		const declaration = declaredIn.get(name);
		const entry: InterfaceSymbol = {
			name,
			inside,
			outside,
			...(declaration ? { kind: declaration.kind, declaredAt: declaration.startLine } : {}),
			...(declaration?.exported ? { exported: true } : {}),
		};

		// Declared inside the range?
		const declaredInside = declaration
			? containedBy(declaration, range)
			: // No declaration in this file: it came from an import or a global, so the
				// extracted unit will need it supplied.
				false;

		if (!declaredInside) {
			needsInput.push(entry);
			continue;
		}
		if (outside.length > 0) needsExport.push(entry);
		else selfContained.push(entry);
	}

	// Most-referenced first within each group: the symbols with the most crossings are the
	// ones that decide whether the seam is viable.
	const byWeight = (a: InterfaceSymbol, b: InterfaceSymbol): number =>
		b.inside.length + b.outside.length - (a.inside.length + a.outside.length) ||
		a.name.localeCompare(b.name);

	const declarationsInRange = outline.filter(
		(node) => node.kind !== "call" && containedBy(node, range),
	);

	return {
		range,
		needsInput: needsInput.sort(byWeight).slice(0, limit),
		needsExport: needsExport.sort(byWeight).slice(0, limit),
		selfContained: selfContained.sort(byWeight).slice(0, limit),
		declarationsInRange,
		truncated: options.truncated === true,
	};
}

/**
 * Declarations cut in half by the range.
 *
 * Reported separately because it usually means the range is wrong: extracting the middle of
 * a function produces something that cannot compile, and no amount of interface analysis
 * makes that work. Better to say so than to describe the seam as if it were viable.
 */
export function straddlingDeclarations(
	range: RangeSpec,
	outline: readonly OutlineNode[],
): OutlineNode[] {
	return outline.filter((node) => node.kind !== "call" && straddles(node, range));
}
