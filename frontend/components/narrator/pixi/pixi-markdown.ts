export type MdBlock =
	| { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
	| { kind: "paragraph"; text: string }
	| { kind: "code"; lang?: string; text: string }
	| { kind: "blockquote"; text: string }
	| { kind: "list-item"; ordered: boolean; index: number; text: string }
	| { kind: "hr" }
	| { kind: "empty" };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const ORDERED_LIST_RE = /^\s*(\d+)\.\s+(.*)$/;
const UNORDERED_LIST_RE = /^\s*[-*]\s+(.*)$/;
const BLOCKQUOTE_RE = /^\s*>\s?(.*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const CODE_FENCE_RE = /^\s*```\s*(.*)$/;

function isBlockStart(line: string): boolean {
	return (
		HEADING_RE.test(line) ||
		CODE_FENCE_RE.test(line) ||
		BLOCKQUOTE_RE.test(line) ||
		ORDERED_LIST_RE.test(line) ||
		UNORDERED_LIST_RE.test(line) ||
		HR_RE.test(line)
	);
}

export function parseMarkdownBlocks(markdown: string): MdBlock[] {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const blocks: MdBlock[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		const codeStart = line.match(CODE_FENCE_RE);
		if (codeStart) {
			const lang = codeStart[1]?.trim() || undefined;
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

		const heading = line.match(HEADING_RE);
		if (heading) {
			blocks.push({
				kind: "heading",
				level: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6,
				text: heading[2],
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
			blocks.push({ kind: "blockquote", text: quoteLines.join("\n") });
			continue;
		}

		const ordered = line.match(ORDERED_LIST_RE);
		if (ordered) {
			blocks.push({
				kind: "list-item",
				ordered: true,
				index: Number.parseInt(ordered[1], 10),
				text: ordered[2],
			});
			i++;
			continue;
		}

		const unordered = line.match(UNORDERED_LIST_RE);
		if (unordered) {
			blocks.push({ kind: "list-item", ordered: false, index: 0, text: unordered[1] });
			i++;
			continue;
		}

		const paragraphLines: string[] = [];
		while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
			paragraphLines.push(lines[i]);
			i++;
		}
		blocks.push({ kind: "paragraph", text: paragraphLines.join("\n") });
	}

	return blocks;
}
