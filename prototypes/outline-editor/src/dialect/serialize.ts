/**
 * 方言序列化：块体 AST → 规范 markdown。最小转义（D23），以 marked@18 的解析结果为准。
 *
 * 规范写法：粗体 `**`、斜体 `*`、删除线 `~~`、行内代码按需加长反引号、链接 `[文字](地址)`、
 * 提及 `[[地址]]` / `[[地址|文字]]`、标题 `# `、引用每行 `> `、代码 ``` 围栏、表格 GFM。
 * 块内换行就是换行（硬换行）。连续空行、首尾换行无法在一个块里表示，规范化时去掉。
 */
import { looksLikeEntity } from "./entities";
import { serializeBodySafe } from "./safe";
import type { Body, Inline, Mark, OutlineNode } from "./types";

/** 规范序列化：先按规则写，再用解析器核对；标记写不出来（CommonMark 的左右侧规则）时降级。 */
export function serializeBody(body: Body): string {
	return serializeBodySafe(body);
}

const OBJ = "\ufffc"; // 提及在扁平文本里的占位
/** 标记的规范嵌套顺序：链接在最外层。 */
const MARK_RANK: Record<string, number> = { link: 0, strong: 1, em: 2, strike: 3, code: 4 };
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;

function isWord(ch: string | undefined): boolean {
	return ch !== undefined && WORD.test(ch);
}

/** 去掉首尾和连续的硬换行（一个块里不能有空行）。 */
export function normalizeBreaks(content: Inline[]): Inline[] {
	const out: Inline[] = [];
	for (const n of content) {
		if (n.type === "br") {
			const prev = out[out.length - 1];
			if (!prev || prev.type === "br") continue;
		}
		if (n.type === "text" && n.text === "") continue;
		out.push(n);
	}
	while (out.length && out[out.length - 1].type === "br") out.pop();
	return out;
}

interface Run {
	kind: "text" | "mention" | "br";
	text: string;
	marks: Mark[];
	node: Inline;
	flatStart: number;
}

function markSig(marks: Mark[]): string {
	return marks.map(markKey).sort().join(",");
}

function markKey(m: Mark): string {
	return m.type === "link" ? `link:${m.href}:${m.title ?? ""}` : m.type;
}

function escapeLinkDest(href: string): string {
	if (/[\s()<>]/.test(href)) return `<${href.replace(/[<>]/g, (c) => `\\${c}`)}>`;
	return href.replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\");
}

function linkSuffix(m: Mark): string {
	const title = m.title ? ` "${m.title.replace(/"/g, '\\"')}"` : "";
	return `](${escapeLinkDest(m.href ?? "")}${title})`;
}

function codeSpan(text: string): string {
	let longest = 0;
	for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
	const fence = "`".repeat(longest + 1);
	const pad =
		text.startsWith("`") ||
		text.endsWith("`") ||
		(text.length > 0 && text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "");
	return pad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/** 某个字符在当前位置需不需要转义（flat 是整段的扁平文本，提及为占位符）。 */
function needsEscape(flat: string, i: number, ctx: Ctx): boolean {
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
			// 块里没有引用定义，单独的 `[x]` 是字面文字；只有 `[[`、`[x](…)`、`[x][…]` 要转义
			if (next === "[" || next === OBJ) return true;
			const lineEnd = flat.indexOf("\n", i);
			const rest = flat.slice(i + 1, lineEnd < 0 ? undefined : lineEnd);
			return /\][ \t]*[([]/.test(rest);
		}
		case "!":
			// 行首的 `!` + 提及会被读成嵌入
			return next === OBJ && (i === 0 || flat[i - 1] === "\n");
		case "<": {
			if (next === undefined || !/[A-Za-z/!?]/.test(next)) return false;
			// 行首的 `<div`、`<!--` 会开始 HTML 块，不需要 `>`
			if (ctx.lineRules !== false && (i === 0 || flat[i - 1] === "\n")) return true;
			const lineEnd = flat.indexOf("\n", i);
			return flat.slice(i + 1, lineEnd < 0 ? undefined : lineEnd).includes(">");
		}
		case "&":
			return looksLikeEntity(flat, i);
		case "|":
			return ctx.table;
		default:
			return false;
	}
}

interface Ctx {
	table: boolean;
	/** 是否检查行首的块级构造（段落、引用要；标题、表格单元格不要）。 */
	lineRules?: boolean;
	/** 段落第一行开头 4 个以上空白会变成缩进代码。 */
	firstLineIndentGuard: boolean;
}

/** 行首的块级构造：返回需要转义的字符在行内的下标，-1 表示不用。 */
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
	if (ol) return lead + ol[0].length - ol[2].length - 1;
	if (/^\|?\s*:?-+:?\s*(\|\s*:?-*:?\s*)*\|?\s*$/.test(s) && /[|:]/.test(s)) return lead;
	return -1;
}

function serializeInline(content: Inline[], ctx: Ctx): string {
	const nodes = ctx.table ? content.filter((n) => n.type !== "br") : normalizeBreaks(content);
	// 扁平文本，用于上下文相关的转义判断
	const runs: Run[] = [];
	let flat = "";
	for (let ni = 0; ni < nodes.length; ni++) {
		const n0 = nodes[ni];
		const start = flat.length;
		// 只有空白的一段：标记在这里开始或结束会写成 `** **`，去掉；两边都有的标记保留
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
	// 行首转义位置
	const lineEsc = new Set<number>();
	let ls = ctx.lineRules === false ? flat.length + 1 : 0;
	while (ls <= flat.length) {
		let le = flat.indexOf("\n", ls);
		if (le < 0) le = flat.length;
		const line = flat.slice(ls, le);
		const k = lineStartEscape(line);
		if (k >= 0) lineEsc.add(ls + k);
		ls = le + 1;
		if (le >= flat.length) break;
	}
	const indentEntity = new Set<number>();
	if (ctx.firstLineIndentGuard) {
		const lead = /^[ \t]*/.exec(flat)?.[0] ?? "";
		const width = [...lead].reduce((w, c) => w + (c === "\t" ? 4 : 1), 0);
		if (width >= 4) indentEntity.add(0);
	}
	// 标记、提及、代码的边界：反斜杠后面紧跟这里时，后面是序列化器写的分隔符
	const boundary = new Set<number>();
	for (let k = 1; k < runs.length; k++) {
		const a = runs[k - 1];
		const b = runs[k];
		if (b.kind !== "text" || a.kind !== "text" || markSig(a.marks) !== markSig(b.marks))
			boundary.add(b.flatStart);
	}
	// 代码区内的字符不参与转义
	const inCode = new Uint8Array(flat.length);
	for (const r of runs) {
		if (r.marks.some((m) => m.type === "code"))
			for (let k = 0; k < r.text.length; k++) inCode[r.flatStart + k] = 1;
	}

	let out = "";
	const open: Mark[] = []; // 当前打开的标记（不含 code，code 单独处理）
	const close = (keep: number) => {
		while (open.length > keep) {
			const m = open.pop() as Mark;
			out += m.type === "link" ? linkSuffix(m) : delim(m);
		}
	};
	const delim = (m: Mark) => (m.type === "strong" ? "**" : m.type === "em" ? "*" : "~~");
	const openMark = (m: Mark) => {
		out += m.type === "link" ? "[" : delim(m);
		open.push(m);
	};

	let ri = 0;
	while (ri < runs.length) {
		const r = runs[ri];
		if (r.kind === "br") {
			close(0);
			// 换行前的行尾空白会被吃掉（两个空格 = 硬换行），规范化掉
			out = out.replace(/[ \t]+$/, "");
			// 行尾的反斜杠 + 换行也是硬换行：反斜杠要转义
			if (/(?:^|[^\\])(?:\\\\)*\\$/.test(out)) out += "\\";
			out += "\n";
			ri++;
			continue;
		}
		const want = r.marks
			.filter((m) => m.type !== "code")
			.sort((a, b) => MARK_RANK[a.type] - MARK_RANK[b.type]);
		// 公共前缀
		const wantKeys = new Set(want.map(markKey));
		let keep = 0;
		while (keep < open.length && wantKeys.has(markKey(open[keep]))) keep++;
		const openKeys = new Set(open.slice(0, keep).map(markKey));
		const toOpen = want.filter((m) => !openKeys.has(markKey(m)));
		// 标记里不能以空白开头 / 结尾：把边缘空白挪到外面
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
		if (keep < open.length) {
			// 结束的标记前不能是空白（链接除外：链接文字里的空白就留在里面）
			const trail = /[ \t]+$/.exec(out);
			const closingLink = open.slice(keep).some((m) => m.type === "link");
			if (trail && out.length > trail[0].length && !closingLink) {
				out = out.slice(0, out.length - trail[0].length);
				close(keep);
				out += trail[0];
			} else close(keep);
		}
		out += escapeText(
			leadWs,
			r.flatStart,
			flat,
			lineEsc,
			indentEntity,
			inCode,
			ctx,
			false,
			boundary,
		);
		for (const m of toOpen) openMark(m);
		const inLink = open.some((m) => m.type === "link");
		const offset = r.flatStart + leadWs.length;
		if (r.kind === "mention") {
			const mn = r.node as Extract<Inline, { type: "mention" }>;
			const sep = ctx.table ? "\\|" : "|";
			out += mn.label != null ? `[[${mn.ref}${sep}${mn.label}]]` : `[[${mn.ref}]]`;
		} else if (isCode) {
			// 合并连续的 code 文字（外层标记相同）
			let codeText = text;
			let rj = ri + 1;
			while (
				rj < runs.length &&
				runs[rj].kind === "text" &&
				runs[rj].marks.some((m) => m.type === "code") &&
				runs[rj].marks
					.filter((m) => m.type !== "code")
					.map(markKey)
					.join() === want.map(markKey).join()
			) {
				codeText += runs[rj].text;
				rj++;
			}
			let span = codeSpan(codeText);
			if (ctx.table) span = span.replace(/\|/g, "\\|");
			out += span;
			ri = rj;
			continue;
		} else {
			out += escapeText(text, offset, flat, lineEsc, indentEntity, inCode, ctx, inLink, boundary);
		}
		ri++;
	}
	// 收尾：结束标记前的空白挪到外面
	if (open.length) {
		const trail = /[ \t]+$/.exec(out);
		if (trail && !open.some((m) => m.type === "link")) {
			out = out.slice(0, out.length - trail[0].length);
			close(0);
			out += trail[0];
		} else close(0);
	}
	// 只有空白的行会变成段落分隔：去掉（块里不能有空行）
	if (out.includes("\n") || out.trim() === "") {
		out = out
			.split("\n")
			.filter((l) => l.trim() !== "")
			.join("\n");
	}
	return out;
}

function escapeText(
	text: string,
	flatStart: number,
	flat: string,
	lineEsc: Set<number>,
	indentEntity: Set<number>,
	inCode: Uint8Array,
	ctx: Ctx,
	inLink = false,
	boundary: Set<number> = new Set(),
): string {
	let out = "";
	for (let k = 0; k < text.length; k++) {
		const i = flatStart + k;
		const ch = text[k];
		if (inCode[i]) {
			out += ch;
			continue;
		}
		if (indentEntity.has(i)) {
			out += ch === "\t" ? "&#9;" : "&#32;";
			continue;
		}
		// 反斜杠后面紧跟的是序列化器写的分隔符（`、*、[[…）时也要转义
		const trailingBackslash = ch === "\\" && boundary.has(i + 1);
		if (
			lineEsc.has(i) ||
			needsEscape(flat, i, ctx) ||
			trailingBackslash ||
			(inLink && (ch === "]" || ch === "["))
		)
			out += `\\${ch}`;
		else out += ch;
	}
	return out;
}

/** 去掉首尾空白（标题、表格单元格的首尾空白不保留）。 */
function trimInline(content: Inline[]): Inline[] {
	const out = content.map((n) => ({ ...n })) as Inline[];
	while (out.length) {
		const f = out[0];
		if (f.type !== "text" || f.marks.some((m) => m.type === "code")) break;
		const t = f.text.replace(/^\s+/, "");
		if (t) {
			out[0] = { ...f, text: t };
			break;
		}
		out.shift();
	}
	while (out.length) {
		const l = out[out.length - 1];
		if (l.type !== "text" || l.marks.some((m) => m.type === "code")) break;
		const t = l.text.replace(/\s+$/, "");
		if (t) {
			out[out.length - 1] = { ...l, text: t };
			break;
		}
		out.pop();
	}
	return out;
}

function codeFence(text: string): string {
	let longest = 0;
	for (const m of text.matchAll(/^[ \t]*(`{3,})/gm)) longest = Math.max(longest, m[1].length);
	return "`".repeat(Math.max(3, longest + 1));
}

function tableRow(cells: string[]): string {
	return `| ${cells.join(" | ")} |`;
}

export function serializeBodyRaw(body: Body): string {
	switch (body.type) {
		case "paragraph":
			return serializeInline(body.content, { table: false, firstLineIndentGuard: true });
		case "heading": {
			const text = serializeInline(trimInline(body.content.filter((n) => n.type !== "br")), {
				table: false,
				firstLineIndentGuard: false,
				lineRules: false,
			});
			// 标题里的 `#` 结尾会被当成闭合序列
			const safe = text.replace(/(^|\s)(#+)$/, (_m, a, b) => `${a}\\${b}`);
			return `${"#".repeat(body.level)} ${safe.trim()}`.trimEnd();
		}
		case "code": {
			const fence = codeFence(body.text);
			return `${fence}${body.lang}\n${body.text}\n${fence}`;
		}
		case "quote": {
			const inner = serializeInline(body.content, { table: false, firstLineIndentGuard: true });
			return inner
				.split("\n")
				.map((l) => (l ? `> ${l}` : ">"))
				.join("\n");
		}
		case "table": {
			const cols = Math.max(1, ...body.rows.map((r) => r.length));
			const cell = (c: Inline[] | undefined) =>
				c
					? serializeInline(trimInline(c), {
							table: true,
							firstLineIndentGuard: false,
							lineRules: false,
						})
					: "";
			const lines: string[] = [];
			const rows = body.rows.length ? body.rows : [[[]]];
			const pad = (r: Inline[][]) => Array.from({ length: cols }, (_, i) => cell(r[i]));
			lines.push(tableRow(pad(rows[0])));
			lines.push(
				tableRow(
					Array.from({ length: cols }, (_, i) => {
						const a = body.align[i] ?? null;
						return a === "left"
							? ":---"
							: a === "center"
								? ":---:"
								: a === "right"
									? "---:"
									: "---";
					}),
				),
			);
			for (const r of rows.slice(1)) lines.push(tableRow(pad(r)));
			return lines.join("\n");
		}
		case "embed":
			return body.label != null ? `![[${body.ref}|${body.label}]]` : `![[${body.ref}]]`;
	}
}

/** 块树 → markdown 大纲（复制、给 agent 读）。 */
export function serializeOutline(nodes: OutlineNode[], indent = ""): string {
	const lines: string[] = [];
	for (const n of nodes) {
		const md = serializeBody(n.body);
		const marker = `- ${n.task ? `[${n.task}] ` : ""}`;
		const parts = md.split("\n");
		lines.push(`${indent}${marker}${parts[0]}`.trimEnd());
		for (const p of parts.slice(1)) lines.push(p === "" ? "" : `${indent}  ${p}`);
		if (n.children.length) lines.push(serializeOutline(n.children, `${indent}  `));
	}
	return lines.join("\n");
}

/** 行内片段（复制块内的一段文字时用）。 */
export function serializeInlineFragment(content: Inline[]): string {
	return serializeInline(content, { table: false, firstLineIndentGuard: false });
}
