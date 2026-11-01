/**
 * The text work of an `OutlineEdit` call: parsing what the agent wrote into blocks, and writing
 * links back in their stored form. Pure and free of the database, so it runs on a worker thread
 * when the input is large (`edit-text-runner.ts`): normalizing a block costs tens of
 * milliseconds per 16 KiB, and agent input is untrusted.
 *
 * FOUR JOBS
 * ---------
 *   - `parse`: a markdown outline (an `add`) or the text of one block (a `replace`) becomes
 *     items with canonical content. Read annotations (`‹…›` lines) are dropped first, and the
 *     labels a read puts after each bullet (`[Ab3dEf9Q]`) are taken off again, but only labels
 *     the caller confirmed name existing blocks, so a line such as `- [CRITICAL] fix` keeps its
 *     text. Each item also comes back with the links and references its content holds and its
 *     title, read from one parse.
 *   - `rewrite`: once the caller has resolved the references, contents get them in stored form:
 *     `[[Q17]]` becomes `[[key/sid]]`, and a display text that only repeats the target's title
 *     (as a read renders it) is dropped, so stored links never carry a title that goes stale.
 *   - `normalize`: contents become canonical the way `writeOutline` would make them, with their
 *     links and anything split off: a page's live session commits what people typed this way
 *     (typed text is untrusted too).
 *   - `merge`: an agent's new content of a block, written against the version it read, is
 *     three-way merged onto the block's content now (`agent-merge.ts`). Strict: where the two
 *     changes overlap the merge is refused with the overlapping ranges, and a merged text that
 *     normalization would change (the two changes meet in markup) is refused too, so what is
 *     written is exactly both changes.
 *
 * Every content returned is canonical (`normalizeBlock(content).content === content`), with the
 * links `contentLinks` would read from it: what `writeOutline` takes as `canonical` content.
 */
import {
	type BlockNode,
	type Body,
	type BodyRef,
	bodyRefs,
	type Inline,
	merge3,
	normalizeBlock,
	type OutlineItem,
	type OutlineNote,
	type OutlineProps,
	type OutlineTask,
	parseBlock,
	parseMarkdownOutline,
	serializeBody,
	type TaskStatus,
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

/** A block split off content that did not fit one block (canonical content, see below). */
export interface EditTextSplit {
	content: string;
	links: ExtractedLink[];
	task: TaskStatus | null;
	children: EditTextSplit[];
}

/** One content normalized for writing (a live session's text before it is committed). */
export interface EditTextNormalized {
	/** Canonical dialect markdown. */
	content: string;
	links: ExtractedLink[];
	/** Out-of-dialect structure split off as child blocks, in order. */
	split: EditTextSplit[];
}

/** One block's three-way merge; all three contents are canonical. */
export interface EditTextMergeInput {
	/** The content the writer read. */
	base: string;
	/** The writer's new content, made from `base`. */
	mine: string;
	/** The content now: `base` with what others changed since. */
	theirs: string;
}

/** Where the writer's change and another's overlap: a range of `base` (empty: both insert there). */
export interface EditTextOverlap {
	start: number;
	end: number;
}

export type EditTextMerged =
	/** Both changes, canonical, with the links `contentLinks` would read. */
	| { ok: true; content: string; links: ExtractedLink[] }
	| { ok: false; reason: "overlap"; overlaps: EditTextOverlap[] }
	/** The merged text is not canonical: the two changes meet in markup. */
	| { ok: false; reason: "unstable" };

/** Overlaps one merge reports at most. */
export const EDIT_TEXT_MAX_OVERLAPS = 5;

export type EditTextJob =
	| {
			/** Contents to normalize as `writeOutline` would (`normalizeBlock`). */
			kind: "normalize";
			contents: string[];
	  }
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
	  }
	| {
			kind: "merge";
			merges: EditTextMergeInput[];
	  };

export type EditTextResult<J extends EditTextJob> = J extends { kind: "parse" }
	? EditTextParsed[]
	: J extends { kind: "normalize" }
		? EditTextNormalized[]
		: J extends { kind: "merge" }
			? EditTextMerged[]
			: EditTextRewritten[];

/** UTF-8 bytes of the text a job carries. */
export function editTextJobBytes(job: EditTextJob): number {
	let bytes = 0;
	if (job.kind === "parse") for (const input of job.inputs) bytes += utf8(input.text);
	else if (job.kind === "merge")
		for (const m of job.merges) bytes += utf8(m.base) + utf8(m.mine) + utf8(m.theirs);
	else for (const content of job.contents) bytes += utf8(content);
	return bytes;
}

function utf8(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

export function runEditTextJob<J extends EditTextJob>(job: J): EditTextResult<J> {
	if (job.kind === "normalize") {
		return job.contents.map((content) => normalizeContent(content)) as EditTextResult<J>;
	}
	if (job.kind === "parse") {
		const labels = new Set(job.labels);
		return job.inputs.map((input) => parseEditText(input, labels)) as EditTextResult<J>;
	}
	if (job.kind === "merge") return job.merges.map(mergeContent) as EditTextResult<J>;
	return job.contents.map((content) => rewriteContent(content, job.targets)) as EditTextResult<J>;
}

function splitNode(node: BlockNode): EditTextSplit {
	const content = serializeBody(node.body);
	return {
		content,
		links: bodyLinks(parseBlock(content).body),
		task: node.task,
		children: node.children.map(splitNode),
	};
}

/** `normalizeBlock` with the links of the result, as `writeOutline` takes canonical content. */
function normalizeContent(src: string): EditTextNormalized {
	const normalized = normalizeBlock(src);
	return {
		content: normalized.content,
		links: bodyLinks(parseBlock(normalized.content).body),
		split: normalized.children.map(splitNode),
	};
}

/**
 * `mine` merged onto `theirs` (see {@link EditTextMergeInput}), strictly: overlapping changes
 * refuse the merge (`merge3`'s default), reported as ranges of `base` with touching ranges
 * joined; a result normalization would change is refused as well.
 */
export function mergeContent(input: EditTextMergeInput): EditTextMerged {
	const merged = merge3(input.base, input.mine, input.theirs);
	if (!merged.ok) {
		const ranges = merged.conflicts
			.map((c) => ({
				start: Math.min(c.mine.start, c.theirs.start),
				end: Math.max(c.mine.end, c.theirs.end),
			}))
			.sort((a, b) => a.start - b.start || a.end - b.end);
		const overlaps: EditTextOverlap[] = [];
		for (const range of ranges) {
			const last = overlaps[overlaps.length - 1];
			if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
			else overlaps.push({ ...range });
		}
		return { ok: false, reason: "overlap", overlaps: overlaps.slice(0, EDIT_TEXT_MAX_OVERLAPS) };
	}
	const normalized = normalizeContent(merged.result);
	if (normalized.content !== merged.result || normalized.split.length > 0)
		return { ok: false, reason: "unstable" };
	return { ok: true, content: normalized.content, links: normalized.links };
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
