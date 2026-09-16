/**
 * Text and outline rendering shared by every StructView mode: the header line, the footer,
 * the outline/element printers, and output clamping — plus the `Resolved` provider type and
 * its display precision.
 *
 * These are pure string builders with no IO, so a mode file can import them without pulling
 * in the tool shell.
 */

import type { ElementNode, OutlineNode, resolveProvider, StructDocument } from "../../structural";
import { DOMINANT_SYMBOL_RATIO, MAX_OUTPUT_CHARS } from "./constants";

export type Resolved = NonNullable<Awaited<ReturnType<typeof resolveProvider>>>;

/**
 * The display-facing precision of a result: whether the structure is exact or a heuristic
 * approximation.
 *
 * Kept separate from `provider.id` on purpose. The id ("tree-sitter", "heuristic") is an
 * internal fact used by tests and diagnostics; the card and the model only need to know how
 * far to trust the answer. Emitting the precision as its own metadata field lets the card
 * show "exact" without exposing — or losing — the parser identity behind it.
 */
export function precisionOf(resolved: Resolved): "exact" | "approximate" {
	return resolved.support === "full" ? "exact" : "approximate";
}

const MAX_LINE_CHARS = 2000;

function truncateLine(line: string): string {
	if (line.length <= MAX_LINE_CHARS) return line;
	return `${line.slice(0, MAX_LINE_CHARS)}… [line truncated, ${line.length} chars total]`;
}

/**
 * Header line, including the quantitative facts a reader needs up front.
 *
 * The totals are here rather than in a separate mode because every one of them was
 * previously obtained with a separate `wc -l` / `grep -c` call.
 */
export function header(filePath: string, doc: StructDocument, resolved: Resolved): string {
	const lang = doc.languageId ?? "unknown";
	// Provider labels already state precision ("exact", "text heuristics"), so a degraded
	// exact provider is reported as "approximate" outright rather than "exact, approximate".
	const via = resolved.support === "full" ? resolved.provider.label : "approximate";
	const lineCount = doc.text.split("\n").length;
	const kb = Math.round(Buffer.byteLength(doc.text, "utf8") / 1024);
	return `${filePath}  [${lang}, via ${via}]  ${lineCount} lines · ${kb} KB`;
}

/**
 * A "this file is really one giant thing" warning, when true.
 *
 * Only shown past the ratio threshold: on a normal file the largest symbol occupying
 * 15% of it is unremarkable, and printing that every time would train the reader to
 * skip the line that matters when it says 92%.
 */
export function dominantSymbolLine(
	nodes: readonly OutlineNode[],
	totalLines: number,
): string | null {
	if (totalLines <= 0) return null;
	let best: { node: OutlineNode; span: number } | null = null;
	for (const node of nodes) {
		const span = node.endLine - node.startLine + 1;
		if (!best || span > best.span) best = { node, span };
	}
	if (!best) return null;
	const ratio = best.span / totalLines;
	if (ratio < DOMINANT_SYMBOL_RATIO) return null;
	return `largest: ${best.node.kind} ${best.node.name} L${best.node.startLine}-${best.node.endLine} (${Math.round(ratio * 100)}% of file)`;
}

/** Header plus the dominant-symbol callout, when there is one. */
export function headerWithDominant(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	nodes: readonly OutlineNode[],
): string {
	const base = header(filePath, doc, resolved);
	const dominant = dominantSymbolLine(nodes, doc.text.split("\n").length);
	return dominant ? `${base}\n${dominant}` : base;
}

export function unsupportedModeMessage(
	mode: string,
	doc: StructDocument,
	resolved: Resolved,
): string {
	const lang = doc.languageId ?? "this file type";
	return (
		`mode=${mode} needs parsed structure, which is unavailable for ${lang} ` +
		`(currently using ${resolved.provider.label}). ` +
		`Install the parser under Settings → Structural Parsing, or use mode=outline / mode=print, which work without one.`
	);
}

export function renderElementTree(
	nodes: readonly ElementNode[],
	out: string[],
	indent: number,
	maxDepth?: number,
): void {
	if (maxDepth != null && indent >= maxDepth) return;
	for (const node of nodes) {
		const pad = "  ".repeat(indent);
		const attrs = node.attributes?.length ? ` ${node.attributes.join(" ")}` : "";
		const cond = node.condition ? `{${node.condition}} ` : "";
		const range = node.line === node.endLine ? `L${node.line}` : `L${node.line}-${node.endLine}`;
		out.push(`${range.padEnd(12)} ${pad}${cond}<${node.name}${attrs}>`);
		if (node.children?.length) renderElementTree(node.children, out, indent + 1, maxDepth);
	}
}

export function withFooter(head: string, body: string, notes: string[]): string {
	const parts = [head, "", body];
	const real = notes.filter((n) => n.trim().length > 0);
	if (real.length > 0) {
		parts.push("", ...real.map((note) => `note: ${note}`));
	}
	return parts.join("\n");
}

export function renderEmpty(
	filePath: string,
	doc: StructDocument,
	resolved: Resolved,
	notes: string[],
	message: string,
): string {
	return withFooter(header(filePath, doc, resolved), message, notes);
}

export function renderOutline(nodes: readonly OutlineNode[], out: string[], indent = 0): void {
	for (const node of nodes) {
		const pad = "  ".repeat(indent);
		const range =
			node.startLine === node.endLine ? `L${node.startLine}` : `L${node.startLine}-${node.endLine}`;
		const attrs: string[] = [];
		if (node.exported) attrs.push("exported");
		if (node.modifiers?.length) attrs.push(...node.modifiers);
		if (node.initializer) attrs.push(`= ${node.initializer}`);
		// refs:1 is the dead-code signal, so it is worth its own emphasis rather than
		// being just another number in the attribute list.
		if (node.refs != null) attrs.push(node.refs === 1 ? "refs:1 ⚠" : `refs:${node.refs}`);
		const suffix = attrs.length > 0 ? `  · ${attrs.join(" ")}` : "";
		out.push(
			`${pad}${range.padEnd(12)} ${node.kind} ${node.name}${node.signature ? ` ${node.signature}` : ""}${suffix}`,
		);
		if (node.children?.length) renderOutline(node.children, out, indent + 1);
	}
}

export function numberLines(lines: readonly string[], startLine: number): string {
	return lines
		.map((line, i) => `${String(startLine + i).padStart(6)}│${truncateLine(line)}`)
		.join("\n");
}

export function clampOutput(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [output capped at ${MAX_OUTPUT_CHARS} chars — narrow the request]`;
}
