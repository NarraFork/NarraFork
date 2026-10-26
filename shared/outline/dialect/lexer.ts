/**
 * Tokenizer: marked@18, the same lexer `shared/pretext-layout/parse-markdown.ts` uses, so the
 * browser and the server tokenize identically. `[[…]]` (mention) and `![[…]]` (embed) are
 * recognized while tokenizing: a code span is consumed first, so `[[` inside inline code stays
 * literal text.
 *
 * Inside `[[…]]` a backslash escapes ASCII punctuation exactly like in ordinary text, so the
 * serializer can write `[[a\*b]]` and every CommonMark parser reads the same characters.
 */
import { Marked, type Token, type TokenizerExtension } from "marked";

const ESCAPABLE = /[!-/:-@[-`{-~]/;

/** Mention target: no brackets, no `|`, no line break; `\x` escapes. */
const REF = String.raw`((?:\\[^\[\]|\n]|[^\\\[\]|\n])+?)`;
/** Display text: no brackets, no line break; `|` allowed after the first one. */
const LABEL = String.raw`(?:\|((?:\\[^\[\]\n]|[^\\\[\]\n])*?))?`;
const MENTION_RE = new RegExp(String.raw`^\[\[${REF}${LABEL}\]\]`);
const EMBED_RE = new RegExp(String.raw`^!\[\[${REF}${LABEL}\]\][ \t]*(?:\n+|$)`);

/** Undoes backslash escapes of ASCII punctuation (other backslashes stay literal). */
export function unescapeRefText(s: string): string {
	if (!s.includes("\\")) return s;
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i] as string;
		const next = s[i + 1];
		if (ch === "\\" && next !== undefined && ESCAPABLE.test(next)) {
			out += next;
			i++;
		} else out += ch;
	}
	return out;
}

export interface RefToken {
	type: "mention" | "embed";
	raw: string;
	ref: string;
	label: string | null;
}

function refToken(type: RefToken["type"], m: RegExpExecArray): RefToken | undefined {
	const ref = unescapeRefText(m[1] as string).trim();
	if (!ref) return undefined;
	const label = m[2] === undefined ? null : unescapeRefText(m[2]);
	return { type, raw: m[0], ref, label };
}

const mention: TokenizerExtension = {
	name: "mention",
	level: "inline",
	start(src: string) {
		const i = src.indexOf("[[");
		return i < 0 ? undefined : i;
	},
	tokenizer(src: string) {
		const m = MENTION_RE.exec(src);
		return m ? refToken("mention", m) : undefined;
	},
};

const embed: TokenizerExtension = {
	name: "embed",
	level: "block",
	// marked calls `start` to cut a paragraph short. Only a `![[` after a newline may start an
	// embed; matching mid-line would split `\![[x]]` apart.
	start(src: string) {
		const m = /\n!\[\[/.exec(src);
		return m ? m.index + 1 : undefined;
	},
	tokenizer(src: string) {
		const m = EMBED_RE.exec(src);
		return m ? refToken("embed", m) : undefined;
	},
};

const marked = new Marked({ gfm: true, breaks: true });
marked.use({
	extensions: [mention, embed],
	// GFM bare URLs swallow whatever follows them up to whitespace (a `[[…]]`, `\*`, `**`), and
	// the editor treats a URL as plain text anyway. In the dialect a URL is text; the serializer
	// keeps the other parsers from autolinking across syntax (see serialize.ts).
	tokenizer: { url: () => undefined },
});

export function lexBlocks(src: string): Token[] {
	return marked.lexer(src);
}
