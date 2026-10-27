/**
 * The text work of an `OutlineEdit` call: parsing what the agent wrote into blocks, and writing
 * links back in their stored form. Pure and free of the database, so it runs on a worker thread
 * when the input is large (`edit-text-runner.ts`): normalizing a block costs tens of
 * milliseconds per 16 KiB, and agent input is untrusted.
 *
 * TWO JOBS
 * --------
 *   - `parse`: a markdown outline (an `add`) or the text of one block (a `replace`) becomes
 *     items with canonical content. Read annotations (`‹…›` lines) are dropped first, and the
 *     labels a read puts after each bullet (`[Ab3dEf9Q]`) are taken off again, but only labels
 *     the caller confirmed name existing blocks, so a line such as `- [CRITICAL] fix` keeps its
 *     text. Each item also comes back with the links and references its content holds and its
 *     title, read from one parse.
 *   - `rewrite`: once the caller has resolved the references, contents get them in stored form:
 *     `[[Q17]]` becomes `[[key/sid]]`, and a display text that only repeats the target's title
 *     (as a read renders it) is dropped, so stored links never carry a title that goes stale.
 *
 * Every content returned is canonical (`normalizeBlock(content).content === content`), with the
 * links `contentLinks` would read from it: what `writeOutline` takes as `canonical` content.
 */
import {
	type Body,
	type BodyRef,
	bodyRefs,
	type Inline,
	type OutlineItem,
	type OutlineNote,
	type OutlineProps,
	type OutlineTask,
	parseBlock,
	parseMarkdownOutline,
	serializeBody,
	titleOfBody,
} from "@shared/outline";
import { bodyLinks, type ExtractedLink } from "./links";
import { stripReadAnnotations } from "./render";

/**
 * A label a read puts after a bullet: a block's sid (8 letters and digits), or `key/sid` where a
 * read spans spaces. The parser only takes off labels the caller lists in `labels`.
 */
export const EDIT_LABEL_RE =
	/^\[((?:[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/)?[A-Za-z0-9]{8})\](?=[ \t]|$)/;

/** An item line's bullet, as the outline parser reads it. */
const BULLET_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

export interface EditTextInput {
	/**
	 * `outline`: a markdown outline, every list item a block. `item`: the text of one block,
	 * written like an outline item without its bullet (a checkbox, `@assignee` and `key:: value`
	 * lines are read as such; indented list items become child blocks).
	 */
	mode: "outline" | "item";
	text: string;
}

export interface EditTextItem {
	/** Canonical dialect markdown. */
	content: string;
	/** What `contentLinks(content)` reads. */
	links: ExtractedLink[];
	/** `[[…]]` and `![[…]]` references in document order, as written. */
	refs: BodyRef[];
	title: string;
	task: OutlineTask | null;
	props: OutlineProps;
	/** The label taken off the item line, if any. */
	label?: string;
	children: EditTextItem[];
}

export interface EditTextParsed {
	items: EditTextItem[];
	notes: OutlineNote[];
}

/** What a reference is written as once stored, and the title its target shows now. */
export interface EditTextTarget {
	ref: string;
	/** A display text equal to this came from a read and is dropped. */
	title: string | null;
}

export interface EditTextRewritten {
	content: string;
	links: ExtractedLink[];
	refs: BodyRef[];
	title: string;
}

export type EditTextJob =
	| {
			kind: "parse";
			inputs: EditTextInput[];
			/** Labels that name existing blocks: only these are taken off item lines. */
			labels: string[];
	  }
	| {
			kind: "rewrite";
			contents: string[];
			/** Stored form of each reference (keyed by the reference as written). */
			targets: Record<string, EditTextTarget>;
	  };

export type EditTextResult<J extends EditTextJob> = J extends { kind: "parse" }
	? EditTextParsed[]
	: EditTextRewritten[];

/** UTF-8 bytes of the text a job carries. */
export function editTextJobBytes(job: EditTextJob): number {
	let bytes = 0;
	if (job.kind === "parse") for (const input of job.inputs) bytes += utf8(input.text);
	else for (const content of job.contents) bytes += utf8(content);
	return bytes;
}

function utf8(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

export function runEditTextJob<J extends EditTextJob>(job: J): EditTextResult<J> {
	if (job.kind === "parse") {
		const labels = new Set(job.labels);
		return job.inputs.map((input) => parseEditText(input, labels)) as EditTextResult<J>;
	}
	return job.contents.map((content) => rewriteContent(content, job.targets)) as EditTextResult<J>;
}

/**
 * The text of one block as an outline: a bullet in front of its first line and its other lines
 * indented under it, so a checkbox, properties and nested items read as they do in an outline.
 * Text that already starts with a bullet is taken as written.
 */
export function itemOutline(text: string): string {
	const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
	if (BULLET_RE.test(lines[0] ?? "")) return lines.join("\n");
	return lines
		.map((line, i) => (i === 0 ? `- ${line}` : line === "" ? "" : `  ${line}`))
		.join("\n");
}

function parseEditText(input: EditTextInput, labels: ReadonlySet<string>): EditTextParsed {
	const source = stripReadAnnotations(input.mode === "item" ? itemOutline(input.text) : input.text);
	const { items, notes } = parseMarkdownOutline(source, {
		readLabel(head) {
			const m = EDIT_LABEL_RE.exec(head);
			const label = m?.[1];
			if (!m || label === undefined || !labels.has(label)) return null;
			return { label, rest: head.slice(m[0].length) };
		},
	});
	return { items: items.map(describeItem), notes };
}

function describeItem(item: OutlineItem): EditTextItem {
	const body = parseBlock(item.content).body;
	const out: EditTextItem = {
		content: item.content,
		links: bodyLinks(body),
		refs: bodyRefs(body),
		title: titleOfBody(body),
		task: item.task,
		props: item.props,
		children: item.children.map(describeItem),
	};
	if (item.label !== undefined) out.label = item.label;
	return out;
}

/** References of a body rewritten to their stored form; null when nothing changes. */
function rewriteBody(body: Body, targets: Record<string, EditTextTarget>): Body | null {
	let changed = false;
	const target = (ref: string, label: string | null): { ref: string; label: string | null } => {
		const t = Object.hasOwn(targets, ref) ? targets[ref] : undefined;
		if (!t) return { ref, label };
		const next = { ref: t.ref, label: label !== null && label === t.title ? null : label };
		if (next.ref !== ref || next.label !== label) changed = true;
		return next;
	};
	const inline = (content: Inline[]): Inline[] =>
		content.map((node) =>
			node.type === "mention" ? { ...node, ...target(node.ref, node.label) } : node,
		);
	let next: Body;
	switch (body.type) {
		case "embed":
			next = { ...body, ...target(body.ref, body.label) };
			break;
		case "table":
			next = { ...body, rows: body.rows.map((row) => row.map(inline)) };
			break;
		case "code":
			return null;
		default:
			next = { ...body, content: inline(body.content) };
	}
	return changed ? next : null;
}

function rewriteContent(
	content: string,
	targets: Record<string, EditTextTarget>,
): EditTextRewritten {
	const parsed = parseBlock(content).body;
	const rewritten = rewriteBody(parsed, targets);
	const text = rewritten ? serializeBody(rewritten) : content;
	const body = rewritten ? parseBlock(text).body : parsed;
	return { content: text, links: bodyLinks(body), refs: bodyRefs(body), title: titleOfBody(body) };
}
