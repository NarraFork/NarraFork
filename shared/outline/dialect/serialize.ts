/**
 * Dialect serializer: body AST → canonical markdown, with minimal escaping. The result must
 * parse back to the same AST under marked@18 (the reference) and to the same semantics under
 * marked@17 and micromark (see `__tests__/parser-consistency.test.ts`).
 *
 * Canonical spelling: bold `**`, italic `*`, strike `~~`, inline code with as many backticks as
 * needed, links `[text](href "title")`, mentions `[[ref]]` / `[[ref|label]]`, ATX headings,
 * quotes with `> ` on every line, ``` fences, GFM tables. Every newline inside a block is a hard
 * break; blank lines, leading/trailing breaks and trailing spaces cannot be represented in one
 * block and are normalized away.
 *
 * This module only applies the rules. `serializeBody` in safe.ts additionally reads the output
 * back and degrades marks that CommonMark cannot express; use that one.
 */
import { looksLikeEntity } from "./entities";
import type { Body, Inline, Mark, MentionNode } from "./types";

/** Placeholder for a mention in the flattened text. */
const OBJ = "\ufffc";
const MARK_RANK: Record<Mark["type"], number> = { link: 0, strong: 1, em: 2, strike: 3, code: 4 };
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;

function isWord(ch: string | undefined): boolean {
	return ch !== undefined && WORD.test(ch);
}

// ---------------------------------------------------------------------------
// Canonical form of inline content (applied before writing and before comparing)

const BAD_REF = /[[\]|\n]/;
const BAD_LABEL = /[[\]\n]/;

/** Whether a mention can be written as `[[…]]` at all. */
export function isValidMention(ref: string, label: string | null): boolean {
	return ref.trim() !== "" && !BAD_REF.test(ref) && (label === null || !BAD_LABEL.test(label));
}

function mentionLiteral(n: MentionNode): string {
	return n.label === null ? `[[${n.ref}]]` : `[[${n.ref}|${n.label}]]`;
}

/**
 * A GFM bare URL (`http://`, `https://`, `ftp://`, `www.`) runs until whitespace. When the run
 * would reach a `[[…]]`, marked and micromark put the mention into the URL. The dialect separates
 * them with one space.
 */
const URL_START_ANY = /(?:https?|ftp):\/\/|www\./i;

/** Tracks whether the current whitespace-free run of text contains a bare-URL start. */
class UrlRun {
	inUrl = false;
	/** The last few characters of the run, for a URL start split across text nodes. */
	private carry = "";

	push(text: string): void {
		let k = text.length - 1;
		while (k >= 0 && !/\s/.test(text[k] as string)) k--;
		const run = k >= 0 ? text.slice(k + 1) : this.carry + text;
		this.inUrl = (k < 0 && this.inUrl) || URL_START_ANY.test(run);
		this.carry = run.slice(-8);
	}

	reset(): void {
		this.inUrl = false;
		this.carry = "";
	}
}

/** Link targets and titles cannot hold line breaks inside a block. */
function oneLineLink(m: Mark): Mark {
	if (m.type !== "link") return m;
	const flat = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ");
	const href = flat(m.href ?? "");
	const title = m.title == null ? null : flat(m.title);
	return href === m.href && title === (m.title ?? null) ? m : { type: "link", href, title };
}

const isCodeText = (n: Inline | undefined): boolean =>
	n?.type === "text" && n.marks.some((m) => m.type === "code");

/** Strips whitespace at one end of a line (code text keeps its whitespace). */
function stripEdge(line: Inline[], end: "start" | "end"): void {
	while (line.length) {
		const i = end === "end" ? line.length - 1 : 0;
		const n = line[i] as Inline;
		if (n.type !== "text" || isCodeText(n)) return;
		const text = end === "end" ? n.text.replace(/[ \t]+$/, "") : n.text.replace(/^[ \t]+/, "");
		if (text) {
			line[i] = { ...n, text };
			return;
		}
		line.splice(i, 1);
	}
}

/**
 * Normalizes inline content to exactly what the serializer writes, so that the read-back check
 * can compare like with like:
 * - empty text goes; mention refs are trimmed; a mention that cannot be written as `[[…]]`
 *   becomes its literal text; mentions lose `code` and `link` marks;
 * - trailing whitespace of every line goes, and so do empty lines (a block has no blank lines);
 * - `breaks: false` (headings, table cells) turns a line break into a space, `trim: true` also
 *   strips leading whitespace;
 * - a space separates a bare URL from a mention that directly follows it.
 */
export function canonicalInline(
	content: Inline[],
	opts: { breaks?: boolean; trim?: boolean } = {},
): Inline[] {
	const breaks = opts.breaks ?? true;
	const lines: Inline[][] = [[]];
	for (const n0 of content) {
		let n = n0;
		if (n.type === "br") {
			if (breaks) lines.push([]);
			else (lines[lines.length - 1] as Inline[]).push({ type: "text", text: " ", marks: [] });
			continue;
		}
		if (n.type === "mention") {
			const ref = n.ref.trim();
			n = isValidMention(ref, n.label)
				? {
						type: "mention",
						ref,
						label: n.label,
						marks: n.marks.filter((m) => m.type !== "code" && m.type !== "link"),
					}
				: { type: "text", text: mentionLiteral(n), marks: n.marks.map(oneLineLink) };
		} else if (n.marks.some((m) => m.type === "link"))
			n = { ...n, marks: n.marks.map(oneLineLink) };
		if (n.type === "text" && n.text === "") continue;
		(lines[lines.length - 1] as Inline[]).push(n);
	}
	const out: Inline[] = [];
	for (const line of lines) {
		stripEdge(line, "end");
		if (opts.trim) stripEdge(line, "start");
		if (!line.length) continue;
		if (out.length) out.push({ type: "br" });
		const url = new UrlRun();
		for (const n of line) {
			if (n.type === "mention") {
				if (url.inUrl) {
					const prev = out[out.length - 1];
					const marks =
						prev?.type === "text"
							? n.marks.filter((m) => prev.marks.some((p) => p.type === m.type))
							: [];
					out.push({ type: "text", text: " ", marks });
				}
				url.reset();
			} else if (n.type === "text") url.push(n.text);
			out.push(n);
		}
	}
	return mergeText(out);
}

function mergeText(content: Inline[]): Inline[] {
	const out: Inline[] = [];
	for (const n of content) {
		const last = out[out.length - 1];
		if (n.type === "text" && last?.type === "text" && markSig(last.marks) === markSig(n.marks)) {
			out[out.length - 1] = { ...last, text: last.text + n.text };
		} else out.push(n);
	}
	return out;
}

/** The body exactly as the serializer will write it (see `canonicalInline`). */
export function canonicalBody(body: Body): Body {
	switch (body.type) {
		case "paragraph":
		case "quote":
			return { ...body, content: canonicalInline(body.content) };
		case "heading":
			return { ...body, content: canonicalInline(body.content, { breaks: false, trim: true }) };
		case "table":
			return {
				...body,
				rows: body.rows.map((r) => r.map((c) => canonicalInline(c, { breaks: false, trim: true }))),
			};
		case "embed":
			return { ...body, ref: body.ref.trim() };
		case "code": {
			// The info string of a backtick fence cannot hold a backtick or a line break.
			const lang = body.lang.replace(/[`\r\n]+/g, " ").trim();
			return lang === body.lang ? body : { ...body, lang };
		}
	}
}

// ---------------------------------------------------------------------------
// Inline writer

interface Run {
	kind: "text" | "mention" | "br";
	text: string;
	marks: Mark[];
	node: Inline;
	flatStart: number;
}

function markKey(m: Mark): string {
	return m.type === "link" ? `link:${m.href ?? ""}:${m.title ?? ""}` : m.type;
}

function markSig(marks: Mark[]): string {
	return marks.map(markKey).sort().join(",");
}

function escapeLinkDest(href: string): string {
	const backslashes = href.replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\");
	if (/[\s()<>]/.test(href)) return `<${backslashes.replace(/[<>]/g, (c) => `\\${c}`)}>`;
	return backslashes;
}

function linkSuffix(m: Mark): string {
	const title = m.title ? ` "${m.title.replace(/["\\]/g, (c) => `\\${c}`)}"` : "";
	return `](${escapeLinkDest(m.href ?? "")}${title})`;
}

function codeSpan(text: string): string {
	let longest = 0;
	for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
	const fence = "`".repeat(longest + 1);
	// CommonMark strips one space on each side when both are present, unless the content is
	// nothing but spaces (U+0020; a tab counts as content).
	const pad =
		text.startsWith("`") ||
		text.endsWith("`") ||
		(text.startsWith(" ") && text.endsWith(" ") && /[^ ]/.test(text));
	return pad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

interface Ctx {
	/** Inside a GFM table cell: `|` must be escaped. */
	table: boolean;
	/** Check line-start block constructs (paragraphs and quotes do; headings and cells do not). */
	lineRules: boolean;
	/** Write leading whitespace of a line as a character reference (paragraphs and quotes). */
	indentGuard: boolean;
}

/** Facts about the flattened text that the escape rules look up (precomputed, linear). */
interface Lookahead {
	/** The content has a link mark: the serializer may write a `>` of its own. */
	hasLink: boolean;
	/** Index of the last `>` in the text, or -1. */
	lastGt: number;
	/** `bracketPair[i]`: whether a `](`, `][` or `] (` starts after `i` on the same line. */
	bracketPair: Uint8Array;
}

function lookahead(flat: string, hasLink: boolean): Lookahead {
	const bracketPair = new Uint8Array(flat.length + 1);
	let seen = 0;
	for (let i = flat.length - 1; i >= 0; i--) {
		bracketPair[i] = seen;
		if (flat[i] === "\n") seen = 0;
		else if (flat[i] === "]") {
			let j = i + 1;
			while (flat[j] === " " || flat[j] === "\t") j++;
			if (flat[j] === "(" || flat[j] === "[") seen = 1;
		}
	}
	return { hasLink, lastGt: flat.lastIndexOf(">"), bracketPair };
}

/**
 * Escapes text inside `[[…]]` so that every parser reads the same characters: the dialect
 * lexer undoes these escapes, CommonMark parsers see ordinary backslash escapes.
 */
function escapeRefText(s: string, table: boolean): string {
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i] as string;
		const next = s[i + 1];
		let esc = false;
		switch (ch) {
			case "\\":
				esc = next === undefined || ASCII_PUNCT.test(next);
				break;
			case "*":
			case "`":
			case "~":
			case "$":
				esc = true;
				break;
			case "_":
				esc = !(isWord(s[i - 1]) && isWord(next));
				break;
			case "<":
				esc = next !== undefined && /[A-Za-z/!?]/.test(next) && s.slice(i + 1).includes(">");
				break;
			case "&":
				esc = looksLikeEntity(s, i);
				break;
			case "|":
				esc = table;
				break;
		}
		out += esc ? `\\${ch}` : ch;
	}
	return out;
}

/** `[[ref]]` / `[[ref|label]]` (also used for embeds with a leading `!`). */
export function refSource(ref: string, label: string | null, table = false): string {
	const r = escapeRefText(ref.trim(), table);
	if (label === null) return `[[${r}]]`;
	return `[[${r}${table ? "\\|" : "|"}${escapeRefText(label, table)}]]`;
}

/** Whether the character at `flat[i]` must be escaped in this context. */
function needsEscape(flat: string, i: number, ctx: Ctx, look: Lookahead): boolean {
	const ch = flat[i];
	const next = flat[i + 1];
	switch (ch) {
		case "\\":
			return next === undefined || next === "\n" || ASCII_PUNCT.test(next) || next === OBJ;
		case "*":
		case "`":
		case "~":
		case "$":
			return true;
		case "_":
			return !(isWord(flat[i - 1]) && isWord(next));
		case "[": {
			// A block has no link reference definitions, so a lone `[x]` is literal; only `[[`,
			// `[x](…)` and `[x][…]` need escaping.
			return next === "[" || next === OBJ || look.bracketPair[i] === 1;
		}
		case "!":
			// `!` + mention at the start of a line would read as an embed.
			return next === OBJ && (i === 0 || flat[i - 1] === "\n");
		case "<":
			if (next === undefined || !/[A-Za-z/!?]/.test(next)) return false;
			// `<div` / `<!--` at the start of a line opens an HTML block even without `>`.
			if (ctx.lineRules && (i === 0 || flat[i - 1] === "\n")) return true;
			// Inline HTML may span lines, and the `>` may be one the serializer writes itself
			// (a `<…>` link destination).
			return look.hasLink || look.lastGt > i;
		case "(":
			// `[[x]](y)` is an inline link to parsers that do not know mentions.
			return flat[i - 1] === OBJ;
		case "&":
			return looksLikeEntity(flat, i);
		case "|":
			return ctx.table;
		default:
			return false;
	}
}

/** Line-start block constructs: index (within the line) of the character to escape, or -1. */
function lineStartEscape(line: string): number {
	const lead = /^[ \t]*/.exec(line)?.[0].length ?? 0;
	const s = line.slice(lead);
	if (/^#{1,6}(\s|$)/.test(s)) return lead;
	if (/^>/.test(s)) return lead;
	if (/^\[[^\]]*\]:/.test(s)) return lead;
	if (/^[-+](\s|$)/.test(s)) return lead;
	if (/^-+\s*$/.test(s) || /^=+\s*$/.test(s)) return lead;
	if (/^(?:[-_]\s*){3,}$/.test(s)) return lead;
	const ol = /^\d{1,9}([.)])(\s|$)/.exec(s);
	if (ol) return lead + ol[0].length - (ol[2] as string).length - 1;
	if (/^\|?\s*:?-+:?\s*(\|\s*:?-*:?\s*)*\|?\s*$/.test(s) && /[|:]/.test(s)) return lead;
	return -1;
}

/** How many runs from `from` on carry mark `m` without interruption (a line break ends all). */
function extent(runs: Run[], from: number, m: Mark): number {
	const key = markKey(m);
	let k = from;
	while (k < runs.length) {
		const r = runs[k] as Run;
		if (r.kind === "br" || !r.marks.some((x) => markKey(x) === key)) break;
		k++;
	}
	return k - from;
}

function delimiterFor(m: Mark): string {
	return m.type === "strong" ? "**" : m.type === "em" ? "*" : "~~";
}

const CM_PUNCT = /[\p{P}\p{S}]/u;

/**
 * Closing `*` delimiters directly followed by opening ones form a single delimiter run, which
 * marked reads more leniently than CommonMark: micromark rejects the run unless it is both
 * left- and right-flanking (`*b***\`c\`**`), and disagrees on `***a****b*`. In those cases the
 * openers are spelled with `_` / `__`, which starts a separate run.
 */
function respellOpeners(
	out: string,
	closedHere: string,
	openers: Array<{ m: Mark; d: string }>,
	content: string,
): boolean {
	const closing = /\*+$/.exec(closedHere)?.[0];
	if (!closing) return false;
	const opening = openers.map((o) => (o.m.type === "link" ? "[" : o.d)).join("");
	const lead = /^\*+/.exec(opening)?.[0];
	if (!lead) return false;
	const prev = out[out.length - closing.length - 1];
	const next = (opening.slice(lead.length) + content)[0];
	const ws = (c: string | undefined) => c === undefined || /\s/.test(c);
	const bothFlanking =
		!ws(prev) && !ws(next) && CM_PUNCT.test(prev as string) === CM_PUNCT.test(next as string);
	return !bothFlanking || closing.length >= 3;
}

/** Length of the run of spaces and tabs at the end of `s` (no regex: `s` keeps growing). */
function trailingBlanks(s: string): number {
	let n = 0;
	while (n < s.length && (s[s.length - 1 - n] === " " || s[s.length - 1 - n] === "\t")) n++;
	return n;
}

/** Whether `s` ends with an odd number of backslashes (the last one escapes what follows). */
function endsWithEscape(s: string): boolean {
	let n = 0;
	while (n < s.length && s[s.length - 1 - n] === "\\") n++;
	return n % 2 === 1;
}

/** Writes canonical inline content (see `canonicalInline`). */
function serializeInline(nodes: Inline[], ctx: Ctx): string {
	// Flattened text (mentions as a placeholder) for context-sensitive escaping.
	const runs: Run[] = [];
	let flat = "";
	for (let ni = 0; ni < nodes.length; ni++) {
		const n0 = nodes[ni] as Inline;
		const start = flat.length;
		// Whitespace-only text cannot open or close a mark (`** **`); keep only marks that span it.
		let n = n0;
		if (n0.type === "text" && /^[ \t]+$/.test(n0.text)) {
			const prev = nodes[ni - 1];
			const next = nodes[ni + 1];
			const has = (x: Inline | undefined, m: Mark) =>
				!!x && x.type !== "br" && x.marks.some((y) => markKey(y) === markKey(m));
			n = {
				...n0,
				marks: n0.marks.filter(
					(m) => m.type === "link" || m.type === "code" || (has(prev, m) && has(next, m)),
				),
			};
		}
		if (n.type === "text") {
			flat += n.text;
			runs.push({ kind: "text", text: n.text, marks: n.marks, node: n, flatStart: start });
		} else if (n.type === "mention") {
			flat += OBJ;
			runs.push({ kind: "mention", text: OBJ, marks: n.marks, node: n, flatStart: start });
		} else {
			flat += "\n";
			runs.push({ kind: "br", text: "\n", marks: [], node: n, flatStart: start });
		}
	}
	const plan = escapePlan(flat, runs, ctx);
	const esc = (text: string, at: number) => escapeText(text, at, plan);

	let out = "";
	// Currently open marks with the delimiter each was opened with (code spans are atomic).
	const open: Array<{ m: Mark; d: string }> = [];
	/** Closes marks down to `keep` open ones; returns the delimiters it wrote. */
	const close = (keep: number): string => {
		let written = "";
		while (open.length > keep) {
			const o = open.pop() as { m: Mark; d: string };
			written += o.m.type === "link" ? linkSuffix(o.m) : o.d;
		}
		out += written;
		return written;
	};
	let ri = 0;
	while (ri < runs.length) {
		const r = runs[ri] as Run;
		if (r.kind === "br") {
			close(0);
			// Trailing spaces before a newline would make a hard break of their own: drop them.
			const blanks = trailingBlanks(out);
			if (blanks) out = out.slice(0, out.length - blanks);
			// So would a trailing backslash: escape it.
			if (endsWithEscape(out)) out += "\\";
			out += "\n";
			ri++;
			continue;
		}
		if (r.kind === "text" && !r.marks.length && !open.length) {
			// Plain text with nothing open: the common case, no mark bookkeeping.
			out += esc(r.text, r.flatStart);
			ri++;
			continue;
		}
		const want = r.marks
			.filter((m) => m.type !== "code")
			.sort((a, b) => MARK_RANK[a.type] - MARK_RANK[b.type]);
		const wantKeys = new Set(want.map(markKey));
		let keep = 0;
		while (keep < open.length && wantKeys.has(markKey((open[keep] as { m: Mark }).m))) keep++;
		const openKeys = new Set(open.slice(0, keep).map((o) => markKey(o.m)));
		// Marks that last longer open first (outermost), so fewer marks are closed and reopened:
		// `***a****b*` (close two, reopen one) is exactly where the parsers disagree.
		const toOpen = want
			.filter((m) => !openKeys.has(markKey(m)))
			.sort(
				(a, b) =>
					extent(runs, ri, b) - extent(runs, ri, a) || MARK_RANK[a.type] - MARK_RANK[b.type],
			);
		// A mark cannot start with whitespace: move leading whitespace in front of it.
		let text = r.text;
		const isCode = r.marks.some((m) => m.type === "code");
		let leadWs = "";
		if (
			r.kind === "text" &&
			!isCode &&
			toOpen.length > 0 &&
			!toOpen.some((m) => m.type === "link")
		) {
			const m = /^[ \t]+/.exec(text);
			if (m) {
				leadWs = m[0];
				text = text.slice(m[0].length);
			}
		}
		// Delimiters closed right before this run, with nothing written after them yet.
		let closedHere = "";
		if (keep < open.length) {
			// Nor end with whitespace (link text may): move trailing whitespace behind it.
			const trail = trailingBlanks(out);
			const closingLink = open.slice(keep).some((o) => o.m.type === "link");
			if (trail > 0 && out.length > trail && !closingLink) {
				const ws = out.slice(out.length - trail);
				out = out.slice(0, out.length - trail);
				close(keep);
				out += ws;
			} else closedHere = close(keep);
		}
		out += esc(leadWs, r.flatStart);
		const offset = r.flatStart + leadWs.length;
		let content: string;
		let nextRun = ri + 1;
		if (r.kind === "mention") {
			const mn = r.node as MentionNode;
			content = refSource(mn.ref, mn.label, ctx.table);
		} else if (isCode) {
			// Merge consecutive code text with the same outer marks into one span.
			let codeText = text;
			let rj = ri + 1;
			const wantSig = want.map(markKey).join();
			while (rj < runs.length) {
				const next = runs[rj] as Run;
				if (next.kind !== "text" || !next.marks.some((m) => m.type === "code")) break;
				const sig = next.marks
					.filter((m) => m.type !== "code")
					.sort((a, b) => MARK_RANK[a.type] - MARK_RANK[b.type])
					.map(markKey)
					.join();
				if (sig !== wantSig) break;
				codeText += next.text;
				rj++;
			}
			content = codeSpan(codeText);
			if (ctx.table) content = content.replace(/\|/g, "\\|");
			nextRun = rj;
		} else {
			content = esc(text, offset);
		}
		const openers = toOpen.map((m) => ({ m, d: delimiterFor(m) }));
		if (!leadWs && respellOpeners(out, closedHere, openers, content))
			for (const o of openers)
				if (o.m.type === "strong" || o.m.type === "em") o.d = o.m.type === "strong" ? "__" : "_";
		for (const o of openers) {
			out += o.m.type === "link" ? "[" : o.d;
			open.push(o);
		}
		out += content;
		ri = nextRun;
	}
	// Close what is still open, moving trailing whitespace out of the marks.
	if (open.length) {
		const trail = trailingBlanks(out);
		if (trail > 0 && !open.some((o) => o.m.type === "link")) {
			const ws = out.slice(out.length - trail);
			out = out.slice(0, out.length - trail);
			close(0);
			out += ws;
		} else close(0);
	}
	return out;
}

/** Per flattened-text index: how to write that character. */
const Esc = { None: 0, Backslash: 1, Entity: 2, Code: 3 } as const;

/**
 * Decides, for every character of the flattened line(s), whether it is written as is, with a
 * backslash, or as a character reference.
 */
function escapePlan(flat: string, runs: Run[], ctx: Ctx): Uint8Array {
	const look = lookahead(
		flat,
		runs.some((r) => r.marks.some((m) => m.type === "link")),
	);
	const plan = new Uint8Array(flat.length);
	const inLink = new Uint8Array(flat.length);
	for (const r of runs) {
		const code = r.marks.some((m) => m.type === "code");
		const link = r.marks.some((m) => m.type === "link");
		for (let k = 0; k < r.text.length; k++) {
			if (code) plan[r.flatStart + k] = Esc.Code;
			if (link) inLink[r.flatStart + k] = 1;
		}
	}
	// Boundaries of marks, mentions and code: a backslash right before one would escape the
	// delimiter the serializer writes there.
	const boundary = new Uint8Array(flat.length + 1);
	for (let k = 1; k < runs.length; k++) {
		const a = runs[k - 1] as Run;
		const b = runs[k] as Run;
		if (b.kind !== "text" || a.kind !== "text" || markSig(a.marks) !== markSig(b.marks))
			boundary[b.flatStart] = 1;
	}
	const lineEsc = new Set<number>();
	let ls = 0;
	while (ls <= flat.length) {
		let le = flat.indexOf("\n", ls);
		if (le < 0) le = flat.length;
		if (ctx.lineRules) {
			const k = lineStartEscape(flat.slice(ls, le));
			if (k >= 0) lineEsc.add(ls + k);
		}
		// Leading whitespace is written as a character reference: CommonMark parsers strip it
		// while marked keeps it.
		if (ctx.indentGuard && (flat[ls] === " " || flat[ls] === "\t") && plan[ls] !== Esc.Code)
			plan[ls] = Esc.Entity;
		ls = le + 1;
		if (le >= flat.length) break;
	}
	for (let i = 0; i < flat.length; i++) {
		if (plan[i] !== Esc.None) continue;
		const ch = flat[i];
		if (
			lineEsc.has(i) ||
			needsEscape(flat, i, ctx, look) ||
			(ch === "\\" && boundary[i + 1]) ||
			(inLink[i] && (ch === "]" || ch === "["))
		)
			plan[i] = Esc.Backslash;
	}
	breakBareLinks(flat, plan, runs);
	return plan;
}

const URL_START = /(?:https?|ftp):\/\/|www\./gi;

/** Marks that change at `flat[i]`: what closes and what opens there. */
function marksAcross(runs: Run[], runAt: Int32Array, i: number): { closes: Mark[]; opens: Mark[] } {
	const before = i > 0 ? (runs[runAt[i - 1] as number] as Run).marks : [];
	const after = i < runAt.length ? (runs[runAt[i] as number] as Run).marks : [];
	const has = (ms: Mark[], m: Mark) => ms.some((x) => markKey(x) === markKey(m));
	return {
		closes: before.filter((m) => !has(after, m)),
		opens: after.filter((m) => !has(before, m)),
	};
}

/**
 * GFM bare URLs: marked@17 and micromark take everything up to the next whitespace (or `<`)
 * as the URL, raw, so an escape, a delimiter or a mark boundary inside that run is read
 * differently from the dialect, where a URL is plain text. When the run is not plain, its start
 * is broken with an escape (`http\://`, `www\.`): the text is unchanged and display still
 * linkifies the URL, because remark-gfm also finds URLs in decoded text. Closing `*`/`~`
 * delimiters right at the end of a run are fine: GFM drops them as trailing punctuation.
 */
function breakBareLinks(flat: string, plan: Uint8Array, runs: Run[]): void {
	const urls = flat.includes("://") || /www\./i.test(flat);
	if (!urls && !flat.includes("@")) return;
	const runAt = new Int32Array(flat.length);
	for (let k = 0; k < runs.length; k++) {
		const r = runs[k] as Run;
		runAt.fill(k, r.flatStart, r.flatStart + r.text.length);
	}
	// Emails first: an escape they add makes a URL run that contains them non-plain.
	breakBareEmails(flat, plan, runAt);
	if (!urls) return;
	// Right to left: where each run ends, and the next character inside it that is escaped or
	// starts a new mark run.
	const runEnd = new Int32Array(flat.length + 1).fill(flat.length);
	const nextBad = new Int32Array(flat.length + 1).fill(flat.length);
	for (let i = flat.length - 1; i >= 0; i--) {
		const ch = flat[i] as string;
		const stop = /\s/.test(ch) || ch === "<" || ch === OBJ;
		runEnd[i] = stop ? i : (runEnd[i + 1] as number);
		const bad = plan[i] !== Esc.None || (i > 0 && runAt[i] !== runAt[i - 1]);
		nextBad[i] = stop ? i : bad ? i : (nextBad[i + 1] as number);
	}
	for (const m of flat.matchAll(URL_START)) {
		const s = m.index;
		if (plan[s] === Esc.Code) continue;
		const e = runEnd[s] as number;
		let plain = plan[s] === Esc.None && (nextBad[s + 1] as number) >= e;
		if (plain && e < flat.length && plan[e] === Esc.Backslash) plain = false;
		if (plain && (e === flat.length || runAt[e] !== runAt[e - 1])) {
			const { closes, opens } = marksAcross(runs, runAt, e);
			if (opens.length || closes.some((x) => x.type === "link" || x.type === "code")) plain = false;
		}
		if (plain) continue;
		const at = m[0].toLowerCase() === "www." ? s + 3 : s + m[0].indexOf(":");
		plan[at] = Esc.Backslash;
	}
}

const EMAIL_LOCAL = /[A-Za-z0-9.+_-]/;
const EMAIL_DOMAIN = /[A-Za-z0-9._-]/;

/**
 * GFM email autolinks (`me@example.com`) are read raw like bare URLs, and their character set
 * includes `_`, so a `_` delimiter or an escape next to one ends up inside the address. When the
 * address is not plain text with no mark boundary inside or at its edges, `\@` breaks it.
 */
function breakBareEmails(flat: string, plan: Uint8Array, runAt: Int32Array): void {
	if (!flat.includes("@")) return;
	for (let a = flat.indexOf("@"); a >= 0; a = flat.indexOf("@", a + 1)) {
		if (plan[a] !== Esc.None) continue;
		let s = a;
		while (s > 0 && EMAIL_LOCAL.test(flat[s - 1] as string)) s--;
		let e = a + 1;
		while (e < flat.length && EMAIL_DOMAIN.test(flat[e] as string)) e++;
		if (s === a || e === a + 1) continue;
		let plain =
			(s === 0 || runAt[s] === runAt[s - 1]) && (e === flat.length || runAt[e] === runAt[e - 1]);
		for (let i = s; plain && i < e; i++)
			if (plan[i] !== Esc.None || (i > s && runAt[i] !== runAt[i - 1])) plain = false;
		// A mark that ends at the end of the text writes its closing delimiter right after.
		if (plain && e === flat.length && s < flat.length) plain = false;
		if (!plain) plan[a] = Esc.Backslash;
	}
}

function escapeText(text: string, flatStart: number, plan: Uint8Array): string {
	let out = "";
	for (let k = 0; k < text.length; k++) {
		const ch = text[k] as string;
		const how = plan[flatStart + k];
		if (how === Esc.Backslash) out += `\\${ch}`;
		else if (how === Esc.Entity) out += ch === "\t" ? "&#9;" : "&#32;";
		else out += ch;
	}
	return out;
}

function codeFence(text: string): string {
	let longest = 0;
	for (const m of text.matchAll(/^[ \t]*(`{3,})/gm))
		longest = Math.max(longest, (m[1] as string).length);
	return "`".repeat(Math.max(3, longest + 1));
}

function tableRow(cells: string[]): string {
	return `| ${cells.join(" | ")} |`;
}

const ALIGN_CELL = { left: ":---", center: ":---:", right: "---:" } as const;
const BLOCK_CTX: Ctx = { table: false, lineRules: true, indentGuard: true };
const HEADING_CTX: Ctx = { table: false, lineRules: false, indentGuard: false };
const CELL_CTX: Ctx = { table: true, lineRules: false, indentGuard: false };
const FRAGMENT_CTX: Ctx = { table: false, lineRules: true, indentGuard: false };

/** Writes a body without the read-back check. Prefer `serializeBody` from safe.ts. */
export function serializeBodyRaw(input: Body): string {
	const body = canonicalBody(input);
	switch (body.type) {
		case "paragraph":
			return serializeInline(body.content, BLOCK_CTX);
		case "heading": {
			const text = serializeInline(body.content, HEADING_CTX);
			// A trailing run of `#` would read as the closing sequence.
			const safe = text.replace(/(^|\s)(#+)$/, (_m, a, b) => `${a}\\${b}`);
			return `${"#".repeat(body.level)} ${safe.trim()}`.trimEnd();
		}
		case "code": {
			const fence = codeFence(body.text);
			return `${fence}${body.lang}\n${body.text}\n${fence}`;
		}
		case "quote": {
			const inner = serializeInline(body.content, BLOCK_CTX);
			return inner
				.split("\n")
				.map((l) => (l ? `> ${l}` : ">"))
				.join("\n");
		}
		case "table": {
			const cols = Math.max(1, ...body.rows.map((r) => r.length));
			const cell = (c: Inline[] | undefined) => (c ? serializeInline(c, CELL_CTX) : "");
			const rows = body.rows.length ? body.rows : [[[]]];
			const pad = (r: Inline[][]) => Array.from({ length: cols }, (_, i) => cell(r[i]));
			const lines = [tableRow(pad(rows[0] as Inline[][]))];
			lines.push(
				tableRow(
					Array.from({ length: cols }, (_, i) => {
						const a = body.align[i] ?? null;
						return a ? ALIGN_CELL[a] : "---";
					}),
				),
			);
			for (const r of rows.slice(1)) lines.push(tableRow(pad(r)));
			return lines.join("\n");
		}
		case "embed":
			return `!${refSource(body.ref, body.label)}`;
	}
}

/** Inline fragment (copying part of a block). */
export function serializeInlineFragment(content: Inline[]): string {
	return serializeInline(canonicalInline(content), FRAGMENT_CTX);
}
