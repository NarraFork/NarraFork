/**
 * A block's text document (`shared/outline-live-text.ts`): made on each end from the block's
 * plain text, at different moments, and still one document.
 *
 * What must hold:
 *  - two documents made from the same text are the same document, item for item;
 *  - ends that make a block's document lazily (only when they first change the text, or first
 *    receive a change) converge under concurrent edits, undo and redo of each end's own changes,
 *    whatever order the updates arrive in: the same text, the same items, nothing stuck
 *    (property-style: seeded, bounded);
 *  - redo after concurrent edits puts typed text back in the order typed, never reversed;
 *  - a document made from a different text is a different document (the reason a block's seed
 *    text must never change while nobody has its document).
 */
import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
	dropPendingStructs,
	hasPendingStructs,
	LIVE_TEXT_NAME,
	LIVE_TEXT_SEED_CLIENT,
	type LiveTextDoc,
	mergeTextUpdates,
	seededTextDoc,
} from "../outline-live-text";

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
	let t = seed >>> 0;
	return () => {
		t = (t + 0x6d2b79f5) >>> 0;
		let x = Math.imul(t ^ (t >>> 15), 1 | t);
		x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}

const state = (t: LiveTextDoc) => Buffer.from(Y.encodeStateAsUpdate(t.doc)).toString("hex");

/**
 * What two ends must agree on: the text, every item's id and which items are deleted. (The whole
 * state also holds the content of deleted items, which an end with an undo manager keeps and
 * the others drop.)
 */
const shape = (t: LiveTextDoc) =>
	`${t.text.toString()}\u0000${Buffer.from(Y.encodeSnapshot(Y.snapshot(t.doc))).toString("hex")}`;

describe("a document made from plain text", () => {
	test("is the same document wherever it is made: one item of the fixed client id", () => {
		for (const seed of [
			"",
			"a",
			"plain text",
			"大纲 **粗体** `code`",
			"😀 astral 𝒳",
			"x".repeat(5000),
		]) {
			const a = seededTextDoc(seed);
			const b = seededTextDoc(seed);
			expect(a.text.toString()).toBe(seed);
			expect(state(a)).toBe(state(b));
			expect(a.doc.clientID).not.toBe(LIVE_TEXT_SEED_CLIENT);
			expect(a.doc.clientID).not.toBe(b.doc.clientID);
			const vector = [...Y.decodeStateVector(Y.encodeStateVector(a.doc))];
			expect(vector).toEqual(seed.length > 0 ? [[LIVE_TEXT_SEED_CLIENT, seed.length]] : []);
			expect(a.doc.getText(LIVE_TEXT_NAME)).toBe(a.text);
			// A position in the seed is known without the document: client id and offset.
			if (seed.length > 2) {
				const rel = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(a.text, 2)) as {
					item: { client: number; clock: number };
				};
				expect(rel.item).toEqual({ client: LIVE_TEXT_SEED_CLIENT, clock: 2 });
			}
		}
	});

	test("an end's own changes carry its own client id, and apply to a document made elsewhere", () => {
		const a = seededTextDoc("shared seed");
		const b = seededTextDoc("shared seed");
		const updates: Uint8Array[] = [];
		a.doc.on("update", (u: Uint8Array) => updates.push(u));
		a.text.insert(7, "typed ");
		a.text.delete(0, 2);
		Y.applyUpdate(b.doc, mergeTextUpdates(updates));
		expect(b.text.toString()).toBe("ared typed seed");
		expect(hasPendingStructs(b.doc)).toBe(false);
		expect(state(a)).toBe(state(b));
		// A whole state applied to a document made from the same text changes nothing…
		const c = seededTextDoc("shared seed");
		Y.applyUpdate(c.doc, Y.encodeStateAsUpdate(a.doc));
		expect(state(c)).toBe(state(a));
		// …and to an empty one gives the same document.
		const d = seededTextDoc("");
		Y.applyUpdate(d.doc, Y.encodeStateAsUpdate(a.doc));
		expect(state(d)).toBe(state(a));
	});

	test("a document made from another text is another document: what fits one does not fit the other", () => {
		// The same item ids, another content: a whole state of one changes nothing in the other,
		// silently. The two ends would go on showing different texts.
		const a = seededTextDoc("abc");
		const other = seededTextDoc("abd");
		expect(state(a)).not.toBe(state(other));
		Y.applyUpdate(other.doc, Y.encodeStateAsUpdate(a.doc));
		expect(other.text.toString()).toBe("abd");
		expect(hasPendingStructs(other.doc)).toBe(false);
		// A change next to an item the other document does not have waits in it forever.
		const long = seededTextDoc("the old text");
		const updates: Uint8Array[] = [];
		long.doc.on("update", (u: Uint8Array) => updates.push(u));
		long.text.insert(long.text.length, "!");
		const short = seededTextDoc("x");
		Y.applyUpdate(short.doc, updates[0] as Uint8Array);
		expect(hasPendingStructs(short.doc)).toBe(true);
		dropPendingStructs(short.doc);
		expect(hasPendingStructs(short.doc)).toBe(false);
		expect(short.text.toString()).toBe("x");
	});
});

describe("documents made lazily on every end converge (seeded, bounded)", () => {
	interface End {
		made: LiveTextDoc | null;
		um: Y.UndoManager | null;
		/** Updates received before this end made its document. */
		inbox: Uint8Array[];
	}

	const LOCAL = { origin: "local" };
	const REMOTE = { origin: "remote" };
	const ALPHABET = "abcdefghij 大纲块";

	for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
		test(`seed ${seed}: 40 blocks' worth of rounds, three ends, random delivery, undo and redo`, () => {
			const r = rng(seed);
			for (let round = 0; round < 40; round++) {
				const text = Array.from(
					{ length: Math.floor(r() * 12) },
					() => ALPHABET[Math.floor(r() * ALPHABET.length)],
				).join("");
				const ends: End[] = [0, 1, 2].map(() => ({ made: null, um: null, inbox: [] }));
				/** Updates on their way: to whom, what. Delivered in any order. */
				const wire: Array<{ to: number; update: Uint8Array }> = [];
				const make = (i: number): LiveTextDoc => {
					const end = ends[i] as End;
					if (end.made) return end.made;
					// Made only now, from the plain text, long after the others may have made theirs.
					const made = seededTextDoc(text);
					end.made = made;
					made.doc.on("update", (update: Uint8Array, origin: unknown) => {
						if (origin === REMOTE) return;
						for (let to = 0; to < ends.length; to++) if (to !== i) wire.push({ to, update });
					});
					return made;
				};
				const deliver = (k: number) => {
					const [msg] = wire.splice(k, 1);
					if (!msg) return;
					Y.applyUpdate(make(msg.to).doc, msg.update, REMOTE);
				};
				for (let n = 0; n < 60; n++) {
					const i = Math.floor(r() * ends.length);
					const roll = r();
					if (roll < 0.45) {
						const t = make(i);
						const end = ends[i] as End;
						end.um ??= new Y.UndoManager(t.text, {
							trackedOrigins: new Set([LOCAL]),
							captureTimeout: r() < 0.5 ? 0 : 1e12,
						});
						const pos = Math.floor(r() * (t.text.length + 1));
						const ch = ALPHABET[Math.floor(r() * ALPHABET.length)] as string;
						t.doc.transact(() => t.text.insert(pos, ch), LOCAL);
					} else if (roll < 0.58) {
						const t = make(i);
						const end = ends[i] as End;
						end.um ??= new Y.UndoManager(t.text, {
							trackedOrigins: new Set([LOCAL]),
							captureTimeout: 0,
						});
						if (t.text.length > 0) {
							const pos = Math.floor(r() * t.text.length);
							t.doc.transact(() => t.text.delete(pos, 1), LOCAL);
						}
					} else if (roll < 0.7) {
						(ends[i] as End).um?.undo();
					} else if (roll < 0.8) {
						(ends[i] as End).um?.redo();
					} else if (wire.length > 0) {
						// Deliver a few, in any order (an update that names items not there yet waits
						// inside the document until they arrive).
						for (let d = 0; d < 1 + Math.floor(r() * 4) && wire.length > 0; d++)
							deliver(Math.floor(r() * wire.length));
					}
				}
				while (wire.length > 0) deliver(Math.floor(r() * wire.length));
				// Everyone undoes everything, then redoes everything, updates still in any order.
				for (const phase of ["undo", "redo"] as const) {
					for (const end of ends) {
						for (let guard = 0; guard < 500; guard++) {
							const stack = phase === "undo" ? end.um?.undoStack : end.um?.redoStack;
							if (!stack || stack.length === 0) break;
							if (phase === "undo") end.um?.undo();
							else end.um?.redo();
						}
					}
					while (wire.length > 0) deliver(Math.floor(r() * wire.length));
					const made = ends.map((_, i) => make(i));
					const first = made[0] as LiveTextDoc;
					for (const t of made) {
						expect(hasPendingStructs(t.doc)).toBe(false);
						expect(t.text.toString()).toBe(first.text.toString());
						expect(shape(t)).toBe(shape(first));
					}
				}
				for (const end of ends) {
					end.um?.destroy();
					end.made?.doc.destroy();
				}
			}
		});
	}

	test("redo after concurrent edits returns typed text in the order typed", () => {
		const a = seededTextDoc("hello world");
		const b = seededTextDoc("hello world");
		const toB: Uint8Array[] = [];
		const toA: Uint8Array[] = [];
		a.doc.on("update", (u: Uint8Array, origin: unknown) => {
			if (origin !== REMOTE) toB.push(u);
		});
		b.doc.on("update", (u: Uint8Array, origin: unknown) => {
			if (origin !== REMOTE) toA.push(u);
		});
		const sync = () => {
			for (const u of toB.splice(0)) Y.applyUpdate(b.doc, u, REMOTE);
			for (const u of toA.splice(0)) Y.applyUpdate(a.doc, u, REMOTE);
		};
		const um = new Y.UndoManager(a.text, {
			trackedOrigins: new Set([LOCAL]),
			captureTimeout: 1e12,
		});
		// Typed one key at a time, each its own update, as an editor does.
		[..." brave"].forEach((ch, i) => {
			a.doc.transact(() => a.text.insert(5 + i, ch), LOCAL);
		});
		sync();
		um.undo();
		// The other end, which made its document on its own, types around it before the redo.
		b.text.insert(0, "Oh, ");
		b.text.insert(b.text.length, "!!");
		b.text.insert(9, "~");
		sync();
		um.redo();
		sync();
		// (The other end's "~" went in at the very place the undone text had been: it stays
		// before it. The typed word itself is whole and in order.)
		expect(a.text.toString()).toBe("Oh, hello~ brave world!!");
		expect(b.text.toString()).toBe(a.text.toString());
		um.undo();
		um.redo();
		um.undo();
		um.redo();
		sync();
		expect(b.text.toString()).toBe("Oh, hello~ brave world!!");
		expect(shape(a)).toBe(shape(b));
	});
});
