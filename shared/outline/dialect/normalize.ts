/**
 * Write-time normalization of block content, plus the references a body contains.
 */
import { parseBlock } from "./parse";
import { serializeChecked } from "./safe";
import type { BlockNode, Body, DialectNote, Inline } from "./types";

export interface NormalizedBlock {
	/** Canonical markdown of the block body: `normalizeBlock(content).content === content`. */
	content: string;
	/** Out-of-dialect structure split off as child blocks, in order. */
	children: BlockNode[];
	/** What was split, converted or kept as text. Empty when the input was already canonical. */
	notes: DialectNote[];
}

/**
 * Normalizes the markdown of one block so that "parse → serialize" is the identity on the
 * result. Structure the dialect cannot hold in one block (lists, several paragraphs, ...) is
 * split into child blocks; anything else outside the dialect is kept as literal text. Nothing
 * is dropped except horizontal rules, and that is reported too.
 *
 * Cost: one marked lex for canonical input, two otherwise; lexing dominates. marked takes tens
 * of milliseconds for a 16 KiB block and is quadratic in runs of `**` it cannot match (16 KiB of
 * `**重点：**内容` takes seconds), so large untrusted input belongs off the main thread.
 */
export function normalizeBlock(src: string): NormalizedBlock {
	const p = parseBlock(src);
	const known = p.extra.length ? undefined : { src, parsed: p };
	return { content: serializeChecked(p.body, known), children: p.extra, notes: p.notes };
}

export interface BodyRef {
	kind: "mention" | "embed";
	ref: string;
	label: string | null;
}

function inlineRefs(content: Inline[], out: BodyRef[]): void {
	for (const n of content)
		if (n.type === "mention") out.push({ kind: "mention", ref: n.ref, label: n.label });
}

/** `[[…]]` and `![[…]]` references in a body, in document order (code is never searched). */
export function bodyRefs(body: Body): BodyRef[] {
	const out: BodyRef[] = [];
	switch (body.type) {
		case "embed":
			out.push({ kind: "embed", ref: body.ref, label: body.label });
			break;
		case "table":
			for (const row of body.rows) for (const cell of row) inlineRefs(cell, out);
			break;
		case "code":
			break;
		default:
			inlineRefs(body.content, out);
	}
	return out;
}
