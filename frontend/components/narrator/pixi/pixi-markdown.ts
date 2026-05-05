export type MdInlineKind = "text" | "strong" | "em" | "code" | "link" | "delete";

export interface MdInlineToken {
	kind: MdInlineKind;
	text: string;
	href?: string;
	/** Shiki highlight color (hex number) for code sub-tokens */
	color?: number;
}

export type MdBlock =
	| {
			kind: "heading";
			level: 1 | 2 | 3 | 4 | 5 | 6;
			text: string;
			inlineTokens: MdInlineToken[];
	  }
	| { kind: "paragraph"; text: string; inlineTokens: MdInlineToken[] }
	| { kind: "code"; lang?: string; text: string }
	| { kind: "blockquote"; text: string; inlineTokens: MdInlineToken[] }
	| {
			kind: "list-item";
			ordered: boolean;
			index: number;
			depth: number;
			text: string;
			inlineTokens: MdInlineToken[];
			checked?: boolean;
	  }
	| { kind: "table"; headers: string[]; rows: string[][] }
	| { kind: "hr" }
	| { kind: "empty" };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const ORDERED_LIST_RE = /^(\s*)(\d+)\.\s+(.*)$/;
const UNORDERED_LIST_RE = /^(\s*)[-*+]\s+(.*)$/;
const BLOCKQUOTE_RE = /^\s*>\s?(.*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const CODE_FENCE_RE = /^\s*```\s*(.*)$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TASK_RE = /^\[([ xX])\]\s+(.*)$/;

function isBlockStart(line: string): boolean {
	return (
		HEADING_RE.test(line) ||
		CODE_FENCE_RE.test(line) ||
		BLOCKQUOTE_RE.test(line) ||
		ORDERED_LIST_RE.test(line) ||
		UNORDERED_LIST_RE.test(line) ||
		HR_RE.test(line) ||
		TABLE_SEPARATOR_RE.test(line)
	);
}

function isEscaped(text: string, index: number): boolean {
	let slashes = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
	return slashes % 2 === 1;
}

function pushInlineToken(tokens: MdInlineToken[], token: MdInlineToken): void {
	if (!token.text) return;
	const prev = tokens[tokens.length - 1];
	if (prev?.kind === token.kind && prev.href === token.href) {
		prev.text += token.text;
		return;
	}
	tokens.push(token);
}

function unescapeMarkdownText(text: string): string {
	return text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");
}

function findClosing(text: string, delimiter: string, from: number): number {
	let index = text.indexOf(delimiter, from);
	while (index >= 0) {
		if (!isEscaped(text, index)) return index;
		index = text.indexOf(delimiter, index + delimiter.length);
	}
	return -1;
}

function findLinkClose(text: string, from: number): { end: number; href: string } | null {
	const closeLabel = findClosing(text, "]", from);
	if (closeLabel < 0 || text[closeLabel + 1] !== "(") return null;
	const closeHref = findClosing(text, ")", closeLabel + 2);
	if (closeHref < 0) return null;
	const href = text.slice(closeLabel + 2, closeHref).trim();
	if (!href) return null;
	return { end: closeHref, href };
}

export function parseMarkdownInline(input: string): { text: string; tokens: MdInlineToken[] } {
	const tokens: MdInlineToken[] = [];
	let plain = "";
	let buffer = "";
	let i = 0;

	const flushText = () => {
		if (!buffer) return;
		const text = unescapeMarkdownText(buffer);
		plain += text;
		pushInlineToken(tokens, { kind: "text", text });
		buffer = "";
	};

	const pushStyled = (kind: MdInlineKind, raw: string, href?: string) => {
		flushText();
		const text = unescapeMarkdownText(raw);
		plain += text;
		pushInlineToken(tokens, { kind, text, href });
	};

	while (i < input.length) {
		const char = input[i];

		if (char === "`" && !isEscaped(input, i)) {
			const end = findClosing(input, "`", i + 1);
			if (end > i + 1) {
				pushStyled("code", input.slice(i + 1, end));
				i = end + 1;
				continue;
			}
		}

		if (char === "!" && input[i + 1] === "[" && !isEscaped(input, i)) {
			const link = findLinkClose(input, i + 2);
			if (link) {
				const label = input.slice(i + 2, input.indexOf("]", i + 2));
				pushStyled("link", label || "image", link.href);
				i = link.end + 1;
				continue;
			}
		}

		if (char === "[" && !isEscaped(input, i)) {
			const link = findLinkClose(input, i + 1);
			if (link) {
				const labelEnd = input.indexOf("]", i + 1);
				pushStyled("link", input.slice(i + 1, labelEnd), link.href);
				i = link.end + 1;
				continue;
			}
		}

		const two = input.slice(i, i + 2);
		if ((two === "**" || two === "__") && !isEscaped(input, i)) {
			const end = findClosing(input, two, i + 2);
			if (end > i + 2) {
				pushStyled("strong", input.slice(i + 2, end));
				i = end + 2;
				continue;
			}
		}

		if (two === "~~" && !isEscaped(input, i)) {
			const end = findClosing(input, two, i + 2);
			if (end > i + 2) {
				pushStyled("delete", input.slice(i + 2, end));
				i = end + 2;
				continue;
			}
		}

		if ((char === "*" || char === "_") && !isEscaped(input, i)) {
			const prev = input[i - 1] ?? " ";
			const next = input[i + 1] ?? " ";
			if (!/\s/.test(next) && !/[\w\p{Script=Han}]/u.test(prev)) {
				const end = findClosing(input, char, i + 1);
				if (end > i + 1) {
					pushStyled("em", input.slice(i + 1, end));
					i = end + 1;
					continue;
				}
			}
		}

		buffer += char;
		i++;
	}

	flushText();
	return { text: plain, tokens };
}

function normalizeFenceLang(info: string | undefined): string | undefined {
	const first = info?.trim().split(/\s+/)[0];
	return first || undefined;
}

function listDepth(indent: string): number {
	let count = 0;
	for (const ch of indent) count += ch === "\t" ? 4 : 1;
	return Math.max(0, Math.floor(count / 2));
}

function parseTableRow(line: string): string[] {
	let trimmed = line.trim();
	if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
	if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
	return trimmed.split("|").map((cell) => parseMarkdownInline(cell.trim()).text);
}

function parseMaybeTable(
	lines: string[],
	index: number,
): { block: MdBlock; nextIndex: number } | null {
	if (!lines[index]?.includes("|") || !TABLE_SEPARATOR_RE.test(lines[index + 1] ?? "")) {
		return null;
	}
	const headers = parseTableRow(lines[index]);
	if (headers.length < 2) return null;
	const rows: string[][] = [];
	let i = index + 2;
	while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
		const row = parseTableRow(lines[i]);
		rows.push(row.slice(0, headers.length));
		i++;
	}
	return { block: { kind: "table", headers, rows }, nextIndex: i };
}

export function parseMarkdownBlocks(markdown: string): MdBlock[] {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const blocks: MdBlock[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		const codeStart = line.match(CODE_FENCE_RE);
		if (codeStart) {
			const lang = normalizeFenceLang(codeStart[1]);
			const codeLines: string[] = [];
			i++;
			while (i < lines.length && !CODE_FENCE_RE.test(lines[i])) {
				codeLines.push(lines[i]);
				i++;
			}
			if (i < lines.length) i++;
			blocks.push({ kind: "code", lang, text: codeLines.join("\n") });
			continue;
		}

		if (!line.trim()) {
			blocks.push({ kind: "empty" });
			i++;
			continue;
		}

		const table = parseMaybeTable(lines, i);
		if (table) {
			blocks.push(table.block);
			i = table.nextIndex;
			continue;
		}

		const heading = line.match(HEADING_RE);
		if (heading) {
			const inline = parseMarkdownInline(heading[2]);
			blocks.push({
				kind: "heading",
				level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
				text: inline.text,
				inlineTokens: inline.tokens,
			});
			i++;
			continue;
		}

		if (HR_RE.test(line)) {
			blocks.push({ kind: "hr" });
			i++;
			continue;
		}

		const quote = line.match(BLOCKQUOTE_RE);
		if (quote) {
			const quoteLines: string[] = [];
			while (i < lines.length) {
				const current = lines[i].match(BLOCKQUOTE_RE);
				if (!current) break;
				quoteLines.push(current[1]);
				i++;
			}
			const inline = parseMarkdownInline(quoteLines.join("\n"));
			blocks.push({ kind: "blockquote", text: inline.text, inlineTokens: inline.tokens });
			continue;
		}

		const ordered = line.match(ORDERED_LIST_RE);
		if (ordered) {
			const inline = parseMarkdownInline(ordered[3]);
			blocks.push({
				kind: "list-item",
				ordered: true,
				index: Number.parseInt(ordered[2], 10),
				depth: listDepth(ordered[1]),
				text: inline.text,
				inlineTokens: inline.tokens,
			});
			i++;
			continue;
		}

		const unordered = line.match(UNORDERED_LIST_RE);
		if (unordered) {
			const task = unordered[2].match(TASK_RE);
			const rawText = task ? task[2] : unordered[2];
			const inline = parseMarkdownInline(rawText);
			blocks.push({
				kind: "list-item",
				ordered: false,
				index: 0,
				depth: listDepth(unordered[1]),
				text: inline.text,
				inlineTokens: inline.tokens,
				checked: task ? task[1].toLowerCase() === "x" : undefined,
			});
			i++;
			continue;
		}

		const paragraphLines: string[] = [];
		while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
			paragraphLines.push(lines[i]);
			i++;
		}
		const inline = parseMarkdownInline(paragraphLines.join("\n"));
		blocks.push({ kind: "paragraph", text: inline.text, inlineTokens: inline.tokens });
	}

	return blocks;
}
