/**
 * Block addresses, syntax only (resolving one needs the database).
 *
 * Content stores `[[space/sid]]`, so renaming a block or its alias never breaks a link. People
 * and agents may write any of:
 * - `space/sid` — a space key and a short id inside that space;
 * - `sid` — a bare short id (in the current space, or unique across spaces);
 * - an alias such as `Q17` or `D27`, optionally prefixed with a space (`P1/Q17`);
 * - a block title (the first line of its content as plain text).
 * `addressCandidates` lists the readings of a reference in the order a resolver should try them.
 *
 * Links in content are `[[target]]` / `[[target|display]]`, embeds `![[…]]`; inside a GFM table
 * cell the separator is written `\|`.
 */
import { type Inline, isValidMention, parseBlock, refSource } from "./dialect";

/** Space keys and short ids: ASCII letters, digits, `_` and `-`, starting with a letter or digit. */
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_SPACE_KEY = 64;
const MAX_SHORT_ID = 32;
/** Aliases: a letter, then letters, digits, `_`, `.` or `-` (Unicode letters allowed). */
const ALIAS_RE = /^\p{L}[\p{L}\p{N}_.-]*$/u;
const MAX_ALIAS = 64;
/** `Q?` in `alias::` asks for the next free number with that prefix. */
const AUTO_ALIAS_RE = /^(\p{L}[\p{L}\p{N}_.-]*)\?$/u;

export interface BlockAddress {
	space: string;
	sid: string;
}

export function isSpaceKey(s: string): boolean {
	return s.length <= MAX_SPACE_KEY && TOKEN_RE.test(s);
}

export function isShortId(s: string): boolean {
	return s.length <= MAX_SHORT_ID && TOKEN_RE.test(s);
}

export function isAlias(s: string): boolean {
	return s.length <= MAX_ALIAS && ALIAS_RE.test(s);
}

/** Parses exactly `space/sid`; null for anything else. */
export function parseAddress(s: string): BlockAddress | null {
	const t = s.trim();
	const slash = t.indexOf("/");
	if (slash < 0) return null;
	const space = t.slice(0, slash);
	const sid = t.slice(slash + 1);
	return isSpaceKey(space) && isShortId(sid) ? { space, sid } : null;
}

export function formatAddress(a: BlockAddress): string {
	if (!isSpaceKey(a.space) || !isShortId(a.sid))
		throw new Error(`not a block address: ${JSON.stringify(a)}`);
	return `${a.space}/${a.sid}`;
}

/** Value of an `alias::` property: a literal alias, or `Prefix?` for the next free number. */
export type AliasValue = { kind: "alias"; alias: string } | { kind: "auto"; prefix: string };

export function parseAliasValue(s: string): AliasValue | null {
	const t = s.trim();
	if (isAlias(t)) return { kind: "alias", alias: t };
	const m = AUTO_ALIAS_RE.exec(t);
	return m && (m[1] as string).length < MAX_ALIAS ? { kind: "auto", prefix: m[1] as string } : null;
}

export type AddressCandidate =
	| { kind: "address"; space: string; sid: string }
	| { kind: "shortId"; sid: string }
	| { kind: "alias"; alias: string; space: string | null }
	| { kind: "title"; title: string; space: string | null };

/** Titles must fit inside `[[…]]`: no brackets, `|` or line breaks. */
export function isTitleSyntax(s: string): boolean {
	return s.trim() !== "" && !/[[\]|\n]/.test(s);
}

/**
 * The readings of a reference (as written in `[[…]]` or a tool argument), in the order a
 * resolver should try them: exact address, bare short id, alias, then title. A `space/` prefix
 * scopes alias and title lookups to that space; the whole text is also tried as a title,
 * since titles may contain `/`.
 */
export function addressCandidates(ref: string): AddressCandidate[] {
	const t = ref.trim();
	const out: AddressCandidate[] = [];
	if (!t) return out;
	const slash = t.indexOf("/");
	if (slash > 0) {
		const space = t.slice(0, slash);
		const key = t.slice(slash + 1).trim();
		if (isSpaceKey(space) && key) {
			if (isShortId(key)) out.push({ kind: "address", space, sid: key });
			if (isAlias(key)) out.push({ kind: "alias", alias: key, space });
			if (isTitleSyntax(key)) out.push({ kind: "title", title: key, space });
		}
	} else {
		if (isShortId(t)) out.push({ kind: "shortId", sid: t });
		if (isAlias(t)) out.push({ kind: "alias", alias: t, space: null });
	}
	if (isTitleSyntax(t)) out.push({ kind: "title", title: t, space: null });
	return out;
}

// ---------------------------------------------------------------------------
// Links and embeds

export interface LinkTarget {
	/** The target as written: an address, alias or title. */
	target: string;
	/** Display text after `|`, or null. */
	label: string | null;
}

export interface LinkSyntax extends LinkTarget {
	embed: boolean;
}

/**
 * Parses one `[[target]]`, `[[target|display]]` or `![[…]]` (surrounding whitespace allowed).
 * With `table: true` the text is a GFM table cell, where the separator is written `\|`.
 */
export function parseLink(text: string, opts: { table?: boolean } = {}): LinkSyntax | null {
	let s = text.trim();
	if (opts.table) s = s.replace(/\\\|/g, "|");
	const p = parseBlock(s);
	if (p.extra.length) return null;
	if (p.body.type === "embed") return { target: p.body.ref, label: p.body.label, embed: true };
	if (p.body.type !== "paragraph" || p.body.content.length !== 1) return null;
	const m = p.body.content[0];
	return m?.type === "mention" ? { target: m.ref, label: m.label, embed: false } : null;
}

/** Writes a link or embed; `table: true` escapes `|` for a GFM table cell. */
export function formatLink(
	link: LinkTarget & { embed?: boolean },
	opts: { table?: boolean } = {},
): string {
	if (!isValidMention(link.target, link.label))
		throw new Error(`cannot write a link to ${JSON.stringify(link.target)}`);
	const src = refSource(link.target, link.label, opts.table ?? false);
	return link.embed ? `!${src}` : src;
}

/**
 * Parses a list of links such as a `depends::` or `tags::` value: `[[a]], [[b|B]]`. Plain
 * comma-separated words are accepted too and returned in `bare` (each one a target).
 */
export function parseLinkList(value: string): { links: LinkTarget[]; bare: string[] } {
	const links: LinkTarget[] = [];
	const bare: string[] = [];
	const p = parseBlock(value.trim());
	if (p.body.type !== "paragraph") {
		const t = value.trim();
		if (t) bare.push(...splitBare(t));
		return { links, bare };
	}
	let text = "";
	const flush = () => {
		bare.push(...splitBare(text));
		text = "";
	};
	for (const n of p.body.content) {
		if (n.type === "mention") {
			flush();
			links.push({ target: n.ref, label: n.label });
		} else if (n.type === "text") text += n.text;
		else text += ",";
	}
	flush();
	return { links, bare };
}

function splitBare(text: string): string[] {
	return text
		.split(/[,，]/)
		.map((s) => s.trim())
		.filter((s) => s !== "");
}

/** Writes a list of links: `[[a]], [[b|B]]`. */
export function formatLinkList(links: LinkTarget[]): string {
	return links.map((l) => formatLink(l)).join(", ");
}

/** The plain text of a block's first line: what title lookups compare against. */
export function titleOf(content: string): string {
	const body = parseBlock(content).body;
	const firstLine = (inl: Inline[]): string => {
		let out = "";
		for (const n of inl) {
			if (n.type === "br") break;
			out += n.type === "mention" ? (n.label ?? n.ref) : n.text;
		}
		return out;
	};
	let t: string;
	switch (body.type) {
		case "code":
			t = body.text.split("\n")[0] ?? "";
			break;
		case "embed":
			t = body.label ?? body.ref;
			break;
		case "table":
			t = (body.rows[0] ?? []).map(firstLine).join(" | ");
			break;
		default:
			t = firstLine(body.content);
	}
	return t.replace(/\s+/g, " ").trim();
}
