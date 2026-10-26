/**
 * 分词：marked@18（与 shared/pretext-layout/parse-markdown.ts 同一个分词器），
 * `[[…]]` 和 `![[…]]` 在分词阶段识别（D23）；行内代码里的 `[[` 由 codespan 先吃掉，是字面文字。
 */
import { Marked, type Token, type TokenizerExtension } from "marked";

const REF = "([^\\[\\]\\n|]+?)(?:\\|([^\\[\\]\\n]*?))?";
const MENTION_RE = new RegExp(`^\\[\\[${REF}\\]\\]`);
const EMBED_RE = new RegExp(`^!\\[\\[${REF}\\]\\][ \\t]*(?:\\n+|$)`);

export interface MentionToken {
	type: "mention";
	raw: string;
	ref: string;
	label?: string;
}

export interface EmbedToken {
	type: "embed";
	raw: string;
	ref: string;
	label?: string;
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
		if (!m) return undefined;
		return { type: "mention", raw: m[0], ref: m[1].trim(), label: m[2] };
	},
};

const embed: TokenizerExtension = {
	name: "embed",
	level: "block",
	// marked 用 src.slice(1) 调 start 来截断段落：只认换行之后的 `![[`，否则会把 `\![[x]]` 切开。
	start(src: string) {
		const m = /\n!\[\[/.exec(src);
		return m ? m.index + 1 : undefined;
	},
	tokenizer(src: string) {
		const m = EMBED_RE.exec(src);
		if (!m) return undefined;
		return { type: "embed", raw: m[0], ref: m[1].trim(), label: m[2] };
	},
};

const marked = new Marked({ gfm: true, breaks: true });
marked.use({
	extensions: [mention, embed],
	// GFM 裸链接会把紧跟的 `[[…]]`、`\*` 等吞进网址里（remark-gfm 也一样），而编辑器本来就把网址当文字。
	// 方言里不认裸链接：网址就是文字。跨解析器的差异见 RESULTS.md。
	tokenizer: { url: () => undefined },
});

export function lexBlocks(src: string): Token[] {
	return marked.lexer(src);
}

export function lexInline(src: string): Token[] {
	return marked.Lexer.lexInline(src, marked.defaults);
}
