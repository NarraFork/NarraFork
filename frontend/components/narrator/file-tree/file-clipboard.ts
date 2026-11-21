/**
 * file-clipboard.ts — the file tree's clipboard: one entry, remembered in the page.
 *
 * ## Why this is not the OS clipboard
 *
 * The system clipboard holds an opaque reference a browser cannot create (see
 * `/api/fs/copy-file-to-clipboard`, which needs the server's desktop to do it). Cut has no
 * OS equivalent at all. So copy/cut/paste inside the tree is a page-level intention — "this
 * file, then paste it here" — and the actual byte movement is one server call at paste
 * time. That also makes the operation honest about what it can do: nothing moves until
 * paste, and a cut entry that is never pasted leaves the file untouched.
 *
 * ## Why one slot, not a selection
 *
 * The tree's `Tree` is single-select (`multiple: false`) and every row is one concern; a
 * multi-file clipboard would promise a batch operation the server route deliberately does
 * not offer. One entry, replaced by the next copy or cut, is what the menu can truthfully
 * offer.
 *
 * The store is module-level and `useSyncExternalStore`-compatible: the menu and the rows
 * that enable "paste" can be in different parts of the tree, and a pane torn into its own
 * window keeps the entry it copied earlier in the same page.
 */

import { useSyncExternalStore } from "react";

export interface FileClipboardEntry {
	/** `copy` keeps the source, `move` removes it after a successful paste. */
	mode: "copy" | "move";
	/** Absolute path of the copied file. */
	path: string;
	/** Its display name, for the menu's "paste <name>" line. */
	name: string;
	/** The narrator whose tree the entry came from; pastes must stay inside it. */
	narratorId: string;
	/** Tree-relative folder it was taken from, re-read after a move empties that row. */
	sourceDirectory?: string;
}

let entry: FileClipboardEntry | null = null;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

/** Remember one file for the next paste. Copy or cut is decided by the caller. */
export function setFileClipboard(next: FileClipboardEntry): void {
	entry = next;
	emit();
}

/** Forget the clipboard, e.g. once a cut has been pasted. */
export function clearFileClipboard(): void {
	if (entry === null) return;
	entry = null;
	emit();
}

export function getFileClipboard(): FileClipboardEntry | null {
	return entry;
}

export function subscribeFileClipboard(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Subscribe from a component; the snapshot is the entry itself (identity-stable). */
export function useFileClipboard(): FileClipboardEntry | null {
	return useSyncExternalStore(subscribeFileClipboard, getFileClipboard, getFileClipboard);
}
