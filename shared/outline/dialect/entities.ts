/**
 * Character references without the DOM. Numeric references and a few common named ones are
 * decoded; unknown names stay literal text. The serializer escapes every `&` that looks like a
 * reference, so the only references it ever writes are its own `&#32;` / `&#9;`.
 */
const NAMED: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: "\u00A0",
	copy: "©",
	reg: "®",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	laquo: "«",
	raquo: "»",
	middot: "·",
	times: "×",
};

const ENTITY_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/y;

/** Decodes a reference starting at `s[i]`; returns `[decoded, sourceLength]` or null. */
export function decodeEntityAt(s: string, i: number): [string, number] | null {
	if (s.charCodeAt(i) !== 38 /* & */) return null;
	ENTITY_RE.lastIndex = i;
	const m = ENTITY_RE.exec(s);
	if (!m) return null;
	const body = m[1] as string;
	let out: string | undefined;
	if (body[0] === "#") {
		const cp =
			body[1] === "x" || body[1] === "X"
				? Number.parseInt(body.slice(2), 16)
				: Number.parseInt(body.slice(1), 10);
		out =
			cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)
				? "\uFFFD"
				: String.fromCodePoint(cp);
	} else {
		out = NAMED[body];
	}
	if (out === undefined) return null;
	return [out, m[0].length];
}

/** Whether the `&` at `s[i]` starts something any parser could read as a reference. */
export function looksLikeEntity(s: string, i: number): boolean {
	ENTITY_RE.lastIndex = i;
	return ENTITY_RE.test(s);
}

/** Decodes every reference in `s` (used for text coming from other parsers in tests too). */
export function decodeEntities(s: string): string {
	if (!s.includes("&")) return s;
	let out = "";
	let i = 0;
	while (i < s.length) {
		const ent = decodeEntityAt(s, i);
		if (ent) {
			out += ent[0];
			i += ent[1];
		} else {
			out += s[i];
			i++;
		}
	}
	return out;
}
