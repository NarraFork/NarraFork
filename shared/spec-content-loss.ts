/**
 * What a save from the old Spec panel may have swallowed (outline P2 PR 12c; PR 12 design §2.9).
 *
 * Before its fix (D24, 2026-10-26) the panel's WYSIWYG editor dropped every GFM table of a file
 * it loaded, and rewrote raw HTML, images, task items, footnotes and a leading front matter, so
 * the first save from the panel wrote the file back without them. Every save is a new
 * `spec_file_revisions` row pointing at the one before it, so what was lost can still be read.
 *
 * This module is the detection only, pure and free of any I/O: the structures of one text
 * ({@link extractSpecLossItems}), and which of a revision's structures a save lost
 * ({@link lostSpecItems}). The offline script (`scripts/find-spec-table-loss.ts`) and the
 * server's scan (`server/services/outline/spec-import/loss-scan.ts`, which runs the extraction
 * on a worker) share it. Nothing here repairs anything: it only says what to show a person.
 *
 * WHAT COUNTS AS LOST
 *
 * Of the structures of the revision before a save, one is lost when
 *   - the save holds FEWER structures of its kind than the revision before it (a save that only
 *     edits a table, or checks a task item, loses nothing), and
 *   - the save does not hold that structure, and
 *   - the file's CURRENT revision does not hold it either (what was put back since is not lost).
 * Structures are compared by a key that ignores what a rewrite changes harmlessly: a table by its
 * cells (whitespace collapsed, alignment ignored), an image by its address, a task item by its
 * text (not its checkbox), a footnote by its label, HTML and front matter by their text with
 * whitespace collapsed. A structure a person removed on purpose reads as lost too: that cannot be
 * told apart, which is why a finding is shown and never acted on.
 */

export const SPEC_LOSS_KINDS = [
	"table",
	"html",
	"image",
	"taskItem",
	"footnote",
	"frontMatter",
] as const;

export type SpecLossKind = (typeof SPEC_LOSS_KINDS)[number];

export function isSpecLossKind(value: unknown): value is SpecLossKind {
	return (SPEC_LOSS_KINDS as readonly unknown[]).includes(value);
}

/** One structure of a text. */
export interface SpecLossItem {
	kind: SpecLossKind;
	/** What it is compared by (see the module header). */
	key: string;
	/** Its source lines, as written. */
	raw: string;
}

/** Files the scan never looks at by name: written by the task board, never by the editor. */
export const SPEC_LOSS_TASKS_PATH = "tasks.json";

/** The behavior fence has no extension and is markdown the panel edited. */
export const SPEC_LOSS_FENCE_PATH = "behavior_fence";

/** Whether a spec file is one the old editor could have damaged: markdown, or the fence. */
export function isSpecLossPath(path: string): boolean {
	if (path === SPEC_LOSS_TASKS_PATH) return false;
	return path === SPEC_LOSS_FENCE_PATH || /\.(md|markdown)$/i.test(path);
}

const DELIMITER_CELL = /^[ \t]*:?-+:?[ \t]*$/;

/**
 * A GFM table delimiter row such as `| --- | :-: |` or `--|--`, also when indented (lists) or
 * quoted. It must contain a pipe: a dash line without one is a thematic break or a setext
 * underline, not a table.
 */
export function isGfmTableDelimiterRow(line: string): boolean {
	let row = line.replace(/^[ \t>]*/, "").trimEnd();
	if (!row.includes("|")) return false;
	if (row.startsWith("|")) row = row.slice(1);
	if (row.endsWith("|")) row = row.slice(0, -1);
	return row.split("|").every((cell) => DELIMITER_CELL.test(cell));
}

export function hasGfmTableDelimiterRow(text: string): boolean {
	return text.split(/\r?\n/).some(isGfmTableDelimiterRow);
}

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/** A table row's cells, trimmed; the container prefix (indent, quote marks) is dropped. */
function cellsOf(line: string): string[] {
	let row = line.replace(/^[ \t>]*/, "").trim();
	if (row.startsWith("|")) row = row.slice(1);
	if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
	const cells: string[] = [];
	let cell = "";
	for (let i = 0; i < row.length; i++) {
		const ch = row[i] as string;
		if (ch === "\\" && row[i + 1] === "|") {
			cell += "|";
			i++;
		} else if (ch === "|") {
			cells.push(collapse(cell));
			cell = "";
		} else cell += ch;
	}
	cells.push(collapse(cell));
	return cells;
}

const FENCE_RE = /^[ \t>]*(`{3,}|~{3,})/;
const HTML_TAG_RE = /<\/?[A-Za-z][A-Za-z0-9-]*(\s[^<>]*)?\/?>|<!--/;
const HTML_BLOCK_START_RE = /^[ \t>]*(<\/?[A-Za-z][A-Za-z0-9-]*(\s|\/?>|$)|<!--)/;
const IMAGE_RE = /!\[[^\]]*\](?:\(\s*<?([^)\s>]+)>?[^)]*\)|\[([^\]]*)\])/g;
const TASK_ITEM_RE = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]+(.*)$/;
const FOOTNOTE_DEF_RE = /^[ \t>]*\[\^([^\]\s]+)\]:/;
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\](?!:)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;

/** Lines of a leading front matter looked through for its closing line. */
const FRONT_MATTER_MAX_LINES = 400;

/**
 * The structures of a markdown text the old editor could lose, in document order. One pass over
 * its lines; fenced code is skipped. Linear in the text.
 */
export function extractSpecLossItems(text: string): SpecLossItem[] {
	const lines = text.split(/\r?\n/);
	const items: SpecLossItem[] = [];
	let i = 0;
	// A leading front matter: `---` on the first line, closed by `---` or `...`.
	if (lines[0]?.trimEnd() === "---") {
		const end = Math.min(lines.length, FRONT_MATTER_MAX_LINES);
		for (let j = 1; j < end; j++) {
			const line = (lines[j] as string).trimEnd();
			if (line === "---" || line === "...") {
				const raw = lines.slice(0, j + 1).join("\n");
				items.push({
					kind: "frontMatter",
					key: collapse(lines.slice(1, j).join("\n")),
					raw,
				});
				i = j + 1;
				break;
			}
		}
	}
	let fence: { char: string; length: number } | null = null;
	while (i < lines.length) {
		const line = lines[i] as string;
		const fenced = FENCE_RE.exec(line)?.[1];
		if (fence) {
			if (fenced && fenced[0] === fence.char && fenced.length >= fence.length) fence = null;
			i++;
			continue;
		}
		if (fenced) {
			fence = { char: fenced[0] as string, length: fenced.length };
			i++;
			continue;
		}
		if (line.trim() === "") {
			i++;
			continue;
		}
		// A table: a row with a pipe, a delimiter row under it, then the rows that follow.
		const next = lines[i + 1];
		if (line.includes("|") && next !== undefined && isGfmTableDelimiterRow(next)) {
			let end = i + 2;
			while (end < lines.length) {
				const row = lines[end] as string;
				if (row.trim() === "" || !row.includes("|")) break;
				end++;
			}
			const rows = [line, ...lines.slice(i + 2, end)];
			items.push({
				kind: "table",
				key: rows.map((row) => cellsOf(row).join("\u001f")).join("\n"),
				raw: lines.slice(i, end).join("\n"),
			});
			i = end;
			continue;
		}
		const bare = line.replace(INLINE_CODE_RE, "");
		if (HTML_BLOCK_START_RE.test(bare)) {
			// An HTML block: up to the next blank line.
			let end = i + 1;
			while (end < lines.length && (lines[end] as string).trim() !== "") end++;
			const raw = lines.slice(i, end).join("\n");
			items.push({ kind: "html", key: collapse(raw), raw });
			i = end;
			continue;
		}
		if (HTML_TAG_RE.test(bare)) items.push({ kind: "html", key: collapse(line), raw: line });
		const task = TASK_ITEM_RE.exec(line);
		if (task) items.push({ kind: "taskItem", key: collapse(task[1] ?? ""), raw: line });
		for (const match of bare.matchAll(IMAGE_RE))
			items.push({
				kind: "image",
				key: match[1] ?? `[${collapse(match[2] ?? "")}]`,
				raw: line,
			});
		const definition = FOOTNOTE_DEF_RE.exec(bare);
		if (definition) items.push({ kind: "footnote", key: `def:${definition[1]}`, raw: line });
		for (const match of bare.matchAll(FOOTNOTE_REF_RE))
			items.push({ kind: "footnote", key: `ref:${match[1]}`, raw: line });
		i++;
	}
	return items;
}

function countBy<T>(items: readonly SpecLossItem[], of: (item: SpecLossItem) => T): Map<T, number> {
	const out = new Map<T, number>();
	for (const item of items) out.set(of(item), (out.get(of(item)) ?? 0) + 1);
	return out;
}

const idOf = (item: SpecLossItem) => `${item.kind}\u0000${item.key}`;

/**
 * Which structures of `before` the save `after` lost and `current` does not hold (see the module
 * header), in the order they stood in `before`.
 */
export function lostSpecItems(
	before: readonly SpecLossItem[],
	after: readonly SpecLossItem[],
	current: readonly SpecLossItem[],
): SpecLossItem[] {
	if (before.length === 0) return [];
	const kindsBefore = countBy(before, (item) => item.kind);
	const kindsAfter = countBy(after, (item) => item.kind);
	const inBefore = countBy(before, idOf);
	const inAfter = countBy(after, idOf);
	const inCurrent = countBy(current, idOf);
	// Per structure: how many of its occurrences are gone, the last ones first to go.
	const lostLeft = new Map<string, number>();
	for (const [id, n] of inBefore)
		lostLeft.set(id, Math.max(0, n - Math.max(inAfter.get(id) ?? 0, inCurrent.get(id) ?? 0)));
	const kept = new Map<string, number>();
	const lost: SpecLossItem[] = [];
	for (const item of before) {
		if ((kindsAfter.get(item.kind) ?? 0) >= (kindsBefore.get(item.kind) ?? 0)) continue;
		const id = idOf(item);
		const total = inBefore.get(id) ?? 0;
		const seen = kept.get(id) ?? 0;
		kept.set(id, seen + 1);
		// The first `total - lost` occurrences are the ones still held.
		if (seen >= total - (lostLeft.get(id) ?? 0)) lost.push(item);
	}
	return lost;
}

/** How many structures of each kind are in `items`. */
export function specLossKindCounts(
	items: readonly SpecLossItem[],
): Partial<Record<SpecLossKind, number>> {
	const out: Partial<Record<SpecLossKind, number>> = {};
	for (const item of items) out[item.kind] = (out[item.kind] ?? 0) + 1;
	return out;
}

/** One piece of a finding's excerpt: source text of one kind, as it stood before the save. */
export interface SpecLossExcerptPart {
	kind: SpecLossKind;
	text: string;
}

function utf8Length(text: string): number {
	let bytes = 0;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			bytes += 4;
			i++;
		} else bytes += 3;
	}
	return bytes;
}

/**
 * The lost structures as an excerpt of at most `maxBytes` UTF-8 bytes: each structure's source
 * once (several images of one line are one line), in order. What does not fit is cut at a line
 * and `truncated` set.
 */
export function buildSpecLossExcerpt(
	lost: readonly SpecLossItem[],
	maxBytes: number,
): { parts: SpecLossExcerptPart[]; truncated: boolean } {
	const parts: SpecLossExcerptPart[] = [];
	const seen = new Set<string>();
	let left = maxBytes;
	let truncated = false;
	for (const item of lost) {
		const id = `${item.kind}\u0000${item.raw}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const size = utf8Length(item.raw);
		if (size <= left) {
			parts.push({ kind: item.kind, text: item.raw });
			left -= size;
			continue;
		}
		truncated = true;
		// Whole lines of it that still fit.
		const lines: string[] = [];
		for (const line of item.raw.split("\n")) {
			const lineSize = utf8Length(line) + 1;
			if (lineSize > left) break;
			lines.push(line);
			left -= lineSize;
		}
		if (lines.length > 0) parts.push({ kind: item.kind, text: lines.join("\n") });
		break;
	}
	return { parts, truncated };
}
