/**
 * A block's text document in a live session (protocol version 2, `outline-live-protocol.ts`).
 *
 * WHY ONE DOCUMENT PER BLOCK
 * --------------------------
 * A block's text must not depend on where the block sits: a block moved to another parent (or,
 * later, to what used to be another page) keeps its document, its unsent keystrokes and its undo
 * history. One Yjs document cannot be synchronized in part, and one `Y.UndoManager` cannot track
 * texts of two documents (both measured, docs/OUTLINE_LIVE-SUBTREE-STUDY.md §8.2), so each block
 * has a document and an undo manager of its own, and the editor keeps one stack over them.
 *
 * WHY DOCUMENTS MADE INDEPENDENTLY ARE THE SAME DOCUMENT
 * ------------------------------------------------------
 * A document costs about 3 KB, so it is made only when someone changes the block's text; until
 * then the text is a plain string on both ends. The server, every client and the crash replay
 * each make the document on their own, from the same plain text, at different moments, and
 * must end up holding the same Yjs items — otherwise an update made on one end names items the
 * other end does not have. So the text goes in as ONE item of a FIXED client id
 * ({@link LIVE_TEXT_SEED_CLIENT}) at clock 0: the same struct everywhere. Only then does the
 * document get the random client id its own changes carry.
 *
 * The text lives in a ROOT type, which no item creates: nothing can race the creation of a
 * block's text (an earlier design kept a `Y.Text` per block inside one map, where two ends
 * creating the same key replaced one another's text and redo then reversed what was typed).
 *
 * The rule every end keeps: a block's seed text never changes while nobody has its document. A
 * change to the text of a block without a document (a write from outside the session) makes the
 * document first, from the old text, and goes in as an update.
 */
import * as Y from "yjs";

/** The client id of the item holding a document's initial text; never a document's own id. */
export const LIVE_TEXT_SEED_CLIENT = 1;

/** The root type holding a block's text. */
export const LIVE_TEXT_NAME = "t";

export interface LiveTextDoc {
	doc: Y.Doc;
	text: Y.Text;
}

/** A block's document, made from its plain text (see the module header). */
export function seededTextDoc(seed: string): LiveTextDoc {
	const doc = new Y.Doc();
	const text = doc.getText(LIVE_TEXT_NAME);
	if (seed.length > 0) {
		let own = doc.clientID;
		while (own === LIVE_TEXT_SEED_CLIENT) own = new Y.Doc().clientID;
		doc.clientID = LIVE_TEXT_SEED_CLIENT;
		text.insert(0, seed);
		doc.clientID = own;
	} else if (doc.clientID === LIVE_TEXT_SEED_CLIENT) {
		doc.clientID = LIVE_TEXT_SEED_CLIENT + 1;
	}
	return { doc, text };
}

/** Whether a document took an update it cannot integrate (it names items the document lacks). */
export function hasPendingStructs(doc: Y.Doc): boolean {
	const store = doc.store as unknown as { pendingStructs: unknown; pendingDs: unknown };
	return !!(store.pendingStructs || store.pendingDs);
}

/** Drop what {@link hasPendingStructs} found, so it does not sit in the document forever. */
export function dropPendingStructs(doc: Y.Doc): void {
	const store = doc.store as unknown as { pendingStructs: unknown; pendingDs: unknown };
	store.pendingStructs = null;
	store.pendingDs = null;
}

/** Merge several updates of one document into one. */
export function mergeTextUpdates(updates: readonly Uint8Array[]): Uint8Array {
	return updates.length === 1
		? (updates[0] as Uint8Array)
		: Y.mergeUpdates(updates as Uint8Array[]);
}
