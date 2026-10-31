import type { PromptOptimizeSnapshot } from "@frontend/lib/prompt-optimize-tasks";
import type { ComposerDocument } from "@shared/composer-document";
import { fileReferenceToken } from "./file-reference-input";
import type { InlineComposerEditorHandle, InlineComposerSelection } from "./InlineComposerEditor";

export function composerOptimizeTarget(
	editor: InlineComposerEditorHandle | null,
	snapshot?: PromptOptimizeSnapshot,
) {
	if (!editor?.getElement()) return null;
	const original = snapshot?.document ?? editor.getDocument();
	const signature = JSON.stringify(original);
	const selection: InlineComposerSelection = snapshot?.selection ?? editor.getSelection();
	if (selection.type === "node") return null;
	const selected = selection.empty === false || selection.start !== selection.end;
	const fragments: { p: number; n: number; text: string; from: number; to: number }[] = [];
	let offset = 0;
	for (const [p, paragraph] of original.paragraphs.entries()) {
		if (p) offset++;
		for (const [n, node] of paragraph.children.entries()) {
			if (node.type === "text") {
				const from = selected ? Math.max(0, selection.start - offset) : 0;
				const to = selected ? Math.min(node.text.length, selection.end - offset) : node.text.length;
				if (to > from && node.text.slice(from, to).trim())
					fragments.push({ p, n, text: node.text.slice(from, to), from, to });
				offset += node.text.length;
			} else if (node.type === "break") offset++;
			else if (node.type === "fileReference") offset += fileReferenceToken(node.reference).length;
		}
	}
	if (!fragments.length) return null;
	const plain = fragments.length === 1;
	const token = snapshot?.token ?? globalThis.crypto?.randomUUID?.() ?? String(Date.now());
	const marker = (index: number, end = false) => `<<<NF_${token}_${index}${end ? "_END" : ""}>>>`;
	const text = plain
		? fragments[0].text
		: `Optimize each text segment below separately. Preserve every marker exactly, in order, with no introduction or conclusion. Do not merge segments.\n${fragments.map((fragment, i) => `${marker(i)}\n${fragment.text}\n${marker(i, true)}`).join("\n")}`;
	return {
		text,
		snapshot: {
			document: original,
			selection: { start: selection.start, end: selection.end },
			token,
		},
		apply(result: string) {
			if (JSON.stringify(editor.getDocument()) !== signature) return false;
			const replacements: string[] = [];
			if (plain) replacements.push(result);
			else {
				// Tolerate stray text/fences around the markers and stripped angle brackets,
				// but still require every marker pair once, in order.
				const body = result.replace(/^\s*```[^\n]*\n|\n```\s*$/g, "");
				let cursor = 0;
				for (let i = 0; i < fragments.length; i++) {
					const start = new RegExp(`(?:<<<)?NF_${token}_${i}(?:>>>)?`).exec(body.slice(cursor));
					if (!start) return false;
					const from = cursor + start.index + start[0].length;
					const end = new RegExp(`(?:<<<)?NF_${token}_${i}_END(?:>>>)?`).exec(body.slice(from));
					if (!end) return false;
					replacements.push(body.slice(from, from + end.index).replace(/^\n|\n$/g, ""));
					cursor = from + end.index + end[0].length;
				}
			}
			const next: ComposerDocument = {
				...original,
				paragraphs: original.paragraphs.map((paragraph) => ({
					children: paragraph.children.map((node) => ({ ...node })),
				})),
			};
			for (const [index, fragment] of fragments.entries()) {
				const node = next.paragraphs[fragment.p].children[fragment.n];
				if (node.type !== "text") return false;
				next.paragraphs[fragment.p].children[fragment.n] = {
					type: "text",
					text:
						node.text.slice(0, fragment.from) + replacements[index] + node.text.slice(fragment.to),
				};
			}
			try {
				editor.setDocument(next, true);
			} catch {
				return false;
			}
			return true;
		},
	};
}
