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
 * whitespace collapsed. A table whose every row still stands in a table of the save (two tables
 * made one) is not lost. Code is not looked into: fenced blocks, and indented blocks outside
 * lists. HTML is markup with a real element name (`<file>` in prose is a placeholder), and a
 * front matter is `key: value` lines, not whatever follows a leading `---` rule. A structure a person removed on purpose reads as lost too: that cannot be
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

/** A fence line: its marker, and what follows it (a closing fence has nothing after it). */
const FENCE_RE = /^[ \t>]*(`{3,}|~{3,})(.*)$/;
const HTML_TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9-]{0,40})((?:\s[^<>]*)?)>/g;
const HTML_BLOCK_START_RE = /^[ \t>]*(<\/?[A-Za-z][A-Za-z0-9-]*(\s|\/?>|$)|<!--)/;
const TASK_ITEM_RE = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]+(.*)$/;
const LIST_ITEM_RE = /^[ \t>]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
// A label holds no bracket and is short, so a line of `[^a[^a…` is read once, not once per `[`.
const FOOTNOTE_DEF_RE = /^[ \t>]*\[\^([^\][\s]{1,200})\]:/;
const FOOTNOTE_REF_RE = /\[\^([^\][\s]{1,200})\](?!:)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const BRACKET_RE = /[[\]]/g;
const FRONT_MATTER_KEY_RE = /^[A-Za-z_][\w .-]{0,80}:(\s|$)/;

/** Lines of a leading front matter looked through for its closing line. */
const FRONT_MATTER_MAX_LINES = 400;

/**
 * Characters of one line the tag, task and footnote patterns look at. A longer line (an inlined
 * image) is still read whole for its images, by a scan that is linear in it.
 */
const LINE_SCAN_MAX = 100_000;

/** Elements that are HTML wherever they stand: nobody writes `<br>` as a placeholder. */
const HTML_VOID = new Set(["br", "hr", "img", "wbr"]);

/**
 * Element names read as HTML. A name outside the list (`<file>`, `<name>`, `<T>`) is a placeholder
 * in prose, not markup; one with a hyphen is a custom element.
 */
const HTML_NAMES = new Set(
	(
		"a abbr address article aside audio b blockquote br button caption center cite code col " +
		"colgroup dd del details dfn dialog div dl dt em fieldset figcaption figure font footer form " +
		"h1 h2 h3 h4 h5 h6 header hr i iframe img input ins kbd label legend li main mark nav ol " +
		"optgroup option p picture pre q rp rt ruby s samp script section select small source span " +
		"strike strong style sub summary sup svg table tbody td textarea tfoot th thead tr tt u ul " +
		"var video wbr"
	).split(" "),
);

/**
 * Whether `text` (inline code removed) holds markup that is really HTML: a comment, or a tag with
 * a known element name that also looks like markup — a closing tag, a void element, one with an
 * attribute or self-closed, or an opening tag whose closing tag is in `around` (its line or
 * block). `<word>` alone, `List<T>` and `a < b > c` are not.
 */
function hasRealHtml(text: string, around: string): boolean {
	if (text.includes("<!--")) return true;
	let lower: string | null = null;
	for (const match of text.matchAll(HTML_TAG_RE)) {
		const at = match.index ?? 0;
		// `\<br>` is an escaped bracket, not a tag.
		if (at > 0 && text[at - 1] === "\\") continue;
		const name = (match[2] as string).toLowerCase();
		if (!HTML_NAMES.has(name) && !name.includes("-")) continue;
		const attrs = match[3] ?? "";
		if (match[1] === "/") {
			if (attrs.trim() === "") return true;
			continue;
		}
		if (HTML_VOID.has(name)) return true;
		if (attrs.trimEnd().endsWith("/") || /[A-Za-z_:][\w:.-]*\s*=/.test(attrs)) return true;
		lower ??= around.toLowerCase();
		if (lower.includes(`</${name}`)) return true;
	}
	return false;
}

/**
 * The addresses of the images of one line (`![alt](address …)`, or `[label]` for the reference
 * form), in order. Linear in the line: every character is passed a bounded number of times, also
 * for `![![![…` or a line with no closing bracket at all.
 */
function imageKeys(text: string): string[] {
	const keys: string[] = [];
	let from = 0;
	let parens = true;
	for (;;) {
		const at = text.indexOf("![", from);
		if (at < 0) break;
		BRACKET_RE.lastIndex = at + 2;
		const close = BRACKET_RE.exec(text);
		if (!close) break;
		// A bracket inside the alt text: not read as an image (the next `![` may be one).
		if (close[0] === "[") {
			from = at + 2;
			continue;
		}
		const after = close.index + 1;
		if (text[after] === "(" && parens) {
			const end = text.indexOf(")", after + 1);
			if (end < 0) {
				parens = false;
				from = after;
				continue;
			}
			const address = /^\s*<?([^\s>]+)/.exec(text.slice(after + 1, end))?.[1];
			if (address) keys.push(address);
			from = end + 1;
		} else if (text[after] === "[") {
			BRACKET_RE.lastIndex = after + 1;
			const end = BRACKET_RE.exec(text);
			if (end && end[0] === "]") {
				keys.push(`[${collapse(text.slice(after + 1, end.index))}]`);
				from = end.index + 1;
			} else from = after;
		} else from = after;
	}
	return keys;
}

/** Leading whitespace as columns (a tab is four). */
function indentOf(line: string): number {
	let columns = 0;
	for (let i = 0; i < line.length; i++) {
		if (line[i] === " ") columns++;
		else if (line[i] === "\t") columns += 4;
		else break;
	}
	return columns;
}

/**
 * Whether the lines between a leading `---` and its closing line read as front matter: `key:
 * value` lines (with their continuation lines, list items and comments), at least one key. A
 * document that merely opens with a `---` rule has prose, a heading alone or a table there.
 */
function isFrontMatterBody(lines: readonly string[]): boolean {
	let keys = 0;
	for (const raw of lines) {
		const line = raw.trimEnd();
		if (line === "" || /^\s*#/.test(line)) continue;
		if (FRONT_MATTER_KEY_RE.test(line)) keys++;
		else if (keys === 0 || !/^(\s+\S|-(\s|$))/.test(line)) return false;
	}
	return keys > 0;
}

/**
 * The structures of a markdown text the old editor could lose, in document order. One pass over
 * its lines; code is skipped (fenced, and indented blocks outside lists). Linear in the text.
 */
export function extractSpecLossItems(source: string): SpecLossItem[] {
	// A byte order mark is not part of the first line.
	const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
	const lines = text.split(/\r?\n/);
	const items: SpecLossItem[] = [];
	let i = 0;
	// A leading front matter: `---` on the first line, closed by `---` or `...`, key lines between.
	if (lines[0]?.trimEnd() === "---") {
		const end = Math.min(lines.length, FRONT_MATTER_MAX_LINES);
		for (let j = 1; j < end; j++) {
			const line = (lines[j] as string).trimEnd();
			if (line === "---" || line === "...") {
				if (!isFrontMatterBody(lines.slice(1, j))) break;
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
	// Indented code: a line four columns in, after a blank line, while no list item is open.
	let blankBefore = true;
	let inList = false;
	let indented = false;
	while (i < lines.length) {
		const line = lines[i] as string;
		const fenceMatch = FENCE_RE.exec(line);
		const fenced = fenceMatch?.[1];
		if (fence) {
			// Only a bare fence closes one: ` ```js ` inside an open fence is content.
			if (
				fenced &&
				fenced[0] === fence.char &&
				fenced.length >= fence.length &&
				(fenceMatch?.[2] ?? "").trim() === ""
			)
				fence = null;
			i++;
			continue;
		}
		if (line.trim() === "") {
			blankBefore = true;
			i++;
			continue;
		}
		if (!inList && indentOf(line) >= 4 && (blankBefore || indented)) {
			indented = true;
			blankBefore = false;
			i++;
			continue;
		}
		indented = false;
		if (LIST_ITEM_RE.test(line)) inList = true;
		else if (blankBefore && indentOf(line) === 0) inList = false;
		blankBefore = false;
		if (fenced) {
			fence = { char: fenced[0] as string, length: fenced.length };
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
		const scan = bare.length > LINE_SCAN_MAX ? bare.slice(0, LINE_SCAN_MAX) : bare;
		if (HTML_BLOCK_START_RE.test(scan)) {
			// An HTML block: up to the next blank line.
			let end = i + 1;
			while (end < lines.length && (lines[end] as string).trim() !== "") end++;
			const raw = lines.slice(i, end).join("\n");
			const block = end === i + 1 ? scan : raw.replace(INLINE_CODE_RE, "").replace(/\n/g, " ");
			if (hasRealHtml(block.slice(0, LINE_SCAN_MAX), block)) {
				items.push({ kind: "html", key: collapse(raw), raw });
				i = end;
				continue;
			}
		}
		if (hasRealHtml(scan, scan)) items.push({ kind: "html", key: collapse(line), raw: line });
		const task = TASK_ITEM_RE.exec(scan === bare ? line : line.slice(0, LINE_SCAN_MAX));
		if (task) items.push({ kind: "taskItem", key: collapse(task[1] ?? ""), raw: line });
		for (const key of imageKeys(bare)) items.push({ kind: "image", key, raw: line });
		const definition = FOOTNOTE_DEF_RE.exec(scan);
		if (definition) items.push({ kind: "footnote", key: `def:${definition[1]}`, raw: line });
		for (const match of scan.matchAll(FOOTNOTE_REF_RE))
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
	let rowsAfter: Set<string> | null = null;
	let rowsCurrent: Set<string> | null = null;
	for (const item of before) {
		if ((kindsAfter.get(item.kind) ?? 0) >= (kindsBefore.get(item.kind) ?? 0)) continue;
		const id = idOf(item);
		const total = inBefore.get(id) ?? 0;
		const seen = kept.get(id) ?? 0;
		kept.set(id, seen + 1);
		// The first `total - lost` occurrences are the ones still held.
		if (seen < total - (lostLeft.get(id) ?? 0)) continue;
		if (item.kind === "table") {
			// Two tables made one (or rows moved into another table): every row is still in a
			// table of the save, or of the file as it is now, so nothing of it was lost.
			const rows = item.key.split("\n");
			rowsAfter ??= tableRows(after);
			if (rows.every((row) => rowsAfter?.has(row))) continue;
			rowsCurrent ??= tableRows(current);
			if (rows.every((row) => rowsCurrent?.has(row))) continue;
		}
		lost.push(item);
	}
	return lost;
}

/** Every row (its cells) of every table of `items`. */
function tableRows(items: readonly SpecLossItem[]): Set<string> {
	const rows = new Set<string>();
	for (const item of items)
		if (item.kind === "table") for (const row of item.key.split("\n")) rows.add(row);
	return rows;
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

/** What ends a line of an excerpt that was cut inside. */
export const SPEC_LOSS_CUT_MARK = " … [cut]";

/** The start of `text` within `maxBytes` UTF-8 bytes, never half a character. */
function cutUtf8(text: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	while (end < text.length) {
		const code = text.charCodeAt(end);
		const pair = code >= 0xd800 && code <= 0xdbff;
		const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += pair ? 2 : 1;
	}
	return text.slice(0, end);
}

/**
 * The lost structures as an excerpt of at most `maxBytes` UTF-8 bytes: each structure's source
 * once (several images of one line are one line), in order. What does not fit is cut at a line
 * and `truncated` set; a first line that does not fit by itself (an inlined image) is cut inside
 * and ends with {@link SPEC_LOSS_CUT_MARK}, so an excerpt of something lost is never empty.
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
		const rawLines = item.raw.split("\n");
		for (const line of rawLines) {
			const lineSize = utf8Length(line) + 1;
			if (lineSize > left) break;
			lines.push(line);
			left -= lineSize;
		}
		const room = left - utf8Length(SPEC_LOSS_CUT_MARK);
		if (lines.length === 0 && parts.length === 0 && room > 0)
			lines.push(cutUtf8(rawLines[0] ?? "", room) + SPEC_LOSS_CUT_MARK);
		if (lines.length > 0) parts.push({ kind: item.kind, text: lines.join("\n") });
		break;
	}
	return { parts, truncated };
}
