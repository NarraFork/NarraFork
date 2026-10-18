import type { editor } from "monaco-editor/editor/editor.api";
import {
	type EditorEolTag,
	type EolRoot,
	eolBlocks,
	eolBytes,
	joinEols,
	spliceEols,
	tagBlock,
	uniformEols,
} from "./editor-format-rope";

export type { EditorEolTag } from "./editor-format-rope";
export type EditorFormat = EolRoot;
export class EditorFormatBuilder {
	private root: EolRoot = uniformEols(1, 0);
	push(tags: Uint8Array) {
		if (this.root.count + tags.length > 1_000_000) throw new Error("EDITOR_FORMAT_LIMIT");
		this.root = joinEols(this.root, tagBlock(tags));
	}
	finish(newlines: number) {
		if (newlines !== this.root.count) throw new Error("EDITOR_FORMAT_MISMATCH");
		return this.root;
	}
}
export const editorEolTag = (eol: "LF" | "CRLF" | "CR"): EditorEolTag =>
	eol === "CRLF" ? 2 : eol === "CR" ? 3 : 1;
export const editorEolText = (tag: EditorEolTag) => (tag === 2 ? "\r\n" : tag === 3 ? "\r" : "\n");

/** One model lifetime. Content-event ranges are in the OLD model and applied descending. */
export class EditorFormatHistory {
	private roots = new Map<number, EolRoot>();
	private order: number[] = [];
	private cursor = 0;
	private seen = new Set<EolRoot>();
	bytes = 0;
	protected = false;
	constructor(
		public root: EolRoot,
		alternative: number,
		readonly preferred: EditorEolTag,
		readonly limits = { bytes: 8 * 1024 * 1024, roots: 50_000 },
	) {
		this.retain(alternative);
	}
	private retain(alternative: number) {
		this.bytes += eolBytes(this.root, this.seen) + 48;
		this.roots.set(alternative, this.root);
		this.order.push(alternative);
		this.cursor = this.order.length - 1;
	}
	change(event: editor.IModelContentChangedEvent, alternative: number, newlines: number) {
		if (event.isUndoing || event.isRedoing) {
			const root = this.roots.get(alternative);
			if (!root || this.protected) throw new Error("EDITOR_FORMAT_UNDO_UNAVAILABLE");
			this.root = root;
			this.cursor = this.order.indexOf(alternative);
		} else {
			for (const change of [...event.changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
				let inserted = 0;
				for (let i = 0; i < change.text.length; i++)
					if (change.text.charCodeAt(i) === 10) inserted++;
				this.root = spliceEols(
					this.root,
					change.range.startLineNumber - 1,
					change.range.endLineNumber - change.range.startLineNumber,
					inserted,
					this.preferred,
				);
			}
			for (const old of this.order.splice(this.cursor + 1)) this.roots.delete(old);
			this.retain(alternative);
		}
		if (this.root.count !== newlines) throw new Error("EDITOR_FORMAT_MISMATCH");
		// The edit has already happened. Retain its COMPLETE root before protecting the view.
		if (this.bytes > this.limits.bytes || this.roots.size > this.limits.roots) {
			this.protected = true;
			this.roots.clear();
			this.order = [];
			this.seen.clear();
			if (eolBytes(this.root) > this.limits.bytes && this.root.count <= 1_000_000)
				this.root = tagBlock(serializeEditorFormat(this.root));
			this.bytes = eolBytes(this.root, this.seen);
		}
		return this.root;
	}
}
/** Stable binary sidecar: tags only, not the pointer-rich undo tree. */
export function serializeEditorFormat(root: EolRoot): Uint8Array {
	const bytes = new Uint8Array(root.count);
	let offset = 0;
	for (const block of eolBlocks(root)) {
		if (block.kind === "uniform") bytes.fill(block.tag, offset, offset + block.count);
		else bytes.set(block.tags, offset);
		offset += block.count;
	}
	return bytes;
}
export function restoreEditorFormat(bytes: Uint8Array, newlines: number): EolRoot {
	if (bytes.length !== newlines || bytes.length > 1_000_000)
		throw new Error("EDITOR_FORMAT_MISMATCH");
	return tagBlock(bytes);
}
