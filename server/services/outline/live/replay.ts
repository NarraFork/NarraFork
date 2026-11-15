/**
 * Replaying a live session's log after it ended without committing everything (a crash, a
 * failed final commit): the text people typed is committed, then the log is dropped.
 *
 * An epoch's log is a snapshot of the session's text documents (one per block someone typed
 * in), increments (a document's seed text before its first update), and sync rows (what the
 * database held for a block when the session changed it, commits the session was about to
 * write, and how far each client's changes reached the log; see `LiveSpace.persistStep`). Replay
 * rebuilds each block's final document and, for every live block of the space that has one,
 * merges three ways: from the last synced content (or the document's seed, or its text in the
 * snapshot), to the final text, onto what the database holds now. So a
 * commit the session never logged (an outside write in the last moments) is kept, and only
 * what people typed and nobody committed is written, as their own commits. A block whose last
 * logged intent was never resolved and whose content equals it was committed by the session
 * just before it ended: it is left as it is (merging it again would repeat the text).
 *
 * Runs at startup as a background job over every epoch left in `outline_live_log`, and
 * before a session opens on a space that still has one. A dropped document (`drop` rows: its
 * text was committed, or its block left the session) is forgotten; a later document of the
 * block starts from its own seed. Bounded: at most
 * {@link OUTLINE_LIVE_REPLAY.maxRows} rows and {@link OUTLINE_LIVE_REPLAY.maxBytes} of log per
 * epoch are read (a session compacts long before that); an epoch over the bound is left for an
 * operator and logged, never truncated.
 *
 * A row that is neither a text row of this format nor a sync row (`decodeLogTexts`) makes its
 * epoch unreadable: kept and logged, never misread, and the space stays editable. (The log of
 * the format before this one lives in another table, `outline_live_updates`, which nothing
 * reads any more: a clean shutdown leaves none, so only a crash right before the upgrade does.)
 */
import { logger } from "@server/lib/logger";
import { merge3 } from "@shared/outline";
import { decodeLiveSeed, LIVE_TEXT_KIND } from "@shared/outline-live-protocol";
import { hasPendingStructs, type LiveTextDoc, seededTextDoc } from "@shared/outline-live-text";
import * as Y from "yjs";
import { outlineStore } from "../store";
import type { OutlineLiveLogRow } from "../store/port";
import type { OutlineCanonicalContent, OutlineOp } from "../write";
import { asOwnLiveWrite } from "./lane";
import {
	type ContentPlan,
	contentOps,
	decodeLogTexts,
	fitBody,
	LIVE_SYNC_ACTOR,
	OUTLINE_LIVE_HOOKS,
	planChunks,
} from "./session";

export const OUTLINE_LIVE_REPLAY = {
	/** Rows read per query. */
	pageRows: 200,
	/** Rows of one epoch replayed at most. */
	maxRows: 5_000,
	/** Base64 bytes of one epoch replayed at most. */
	maxBytes: 64 * 1024 * 1024,
	/** Epochs listed per query by the startup job. */
	epochsPerPage: 50,
	/** Pause between two epochs of the startup job, so it yields to requests. */
	pauseMs: 20,
} as const;

export type ReplayOutcome = "committed" | "empty" | "kept";

/** Text a replay found uncommitted: the block, the text it should have, who typed it last. */
export interface RecoveredChange {
	id: string;
	text: string;
	actor: string | null;
}

export interface ReplayResult {
	outcome: ReplayOutcome;
	/** Per client key of the ended session: its highest transaction now in the page. */
	keys: Map<string, number>;
	/**
	 * When the log was read but its text could not be committed (`kept`): what it holds, for a
	 * new session to take over. Absent when the log could not be read at all.
	 */
	changes?: RecoveredChange[];
}

/** Sync rows are JSON as written: malformed UTF-8 makes the log unreadable (kept). */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

async function readEpoch(spaceId: string, epoch: number): Promise<OutlineLiveLogRow[] | null> {
	const rows: OutlineLiveLogRow[] = [];
	let bytes = 0;
	let afterSeq: number | undefined;
	for (;;) {
		const page = await outlineStore.listLiveLog(spaceId, epoch, {
			...(afterSeq !== undefined ? { afterSeq } : {}),
			limit: OUTLINE_LIVE_REPLAY.pageRows,
		});
		for (const row of page) {
			rows.push(row);
			bytes += row.updateB64.length;
		}
		if (rows.length > OUTLINE_LIVE_REPLAY.maxRows || bytes > OUTLINE_LIVE_REPLAY.maxBytes)
			return null;
		if (page.length < OUTLINE_LIVE_REPLAY.pageRows) return rows;
		afterSeq = (page[page.length - 1] as OutlineLiveLogRow).seq;
	}
}

/**
 * Replay one epoch: commit what is not committed, then drop the rows. `kept` when the log could
 * not be replayed (too large, unreadable, the commit failed): the rows stay.
 */
export async function replayLiveEpoch(spaceId: string, epoch: number): Promise<ReplayOutcome> {
	return (await replayLiveEpochDetailed(spaceId, epoch)).outcome;
}

/** {@link replayLiveEpoch}, with what a new session of the page needs from it. */
export async function replayLiveEpochDetailed(
	spaceId: string,
	epoch: number,
): Promise<ReplayResult> {
	const keys = new Map<string, number>();
	const rows = await readEpoch(spaceId, epoch);
	if (!rows) {
		logger.warn("Outline live log too large to replay; kept", { spaceId, epoch });
		return { outcome: "kept", keys };
	}
	if (rows.length === 0) return { outcome: "empty", keys };
	const docs = new Map<string, LiveTextDoc>();
	const base = new Map<string, string>();
	/** Intents not resolved by a later sync row or cancel: block → content to be committed. */
	const intents = new Map<string, string>();
	const lastActor = new Map<string, string>();
	/** A block's document: made from its seed text, or empty (a snapshot's state, a new block). */
	const docOf = (id: string, seed = ""): LiveTextDoc => {
		let t = docs.get(id);
		if (!t) {
			t = seededTextDoc(seed);
			docs.set(id, t);
			t.text.observe((_event, txn) => {
				const actor = txn.origin as OutlineLiveLogRow | null;
				if (actor?.actorKind === "human") lastActor.set(id, actor.actorId);
			});
		}
		return t;
	};
	const destroy = () => {
		for (const t of docs.values()) t.doc.destroy();
	};
	/** Blocks whose base is only assumed empty: no seed row for their document was read yet. */
	const assumed = new Set<string>();
	/** Updates waiting in a document for items it lacks: the row of the person who made them. */
	const waiting = new Map<string, OutlineLiveLogRow>();
	let first = true;
	try {
		for (const row of rows) {
			const data = Buffer.from(row.updateB64, "base64");
			if (row.actorId === LIVE_SYNC_ACTOR) {
				const parsed = JSON.parse(decoder.decode(data)) as {
					b?: Record<string, string>;
					i?: Record<string, string>;
					x?: string[];
					k?: Record<string, number>;
				};
				// Within one row, what the database held (`b`) and cancels (`x`) are older than the
				// intents (`i`) written with them: an intent is resolved only by a later row.
				for (const [id, content] of Object.entries(parsed.b ?? {})) {
					base.set(id, content);
					assumed.delete(id);
					intents.delete(id);
				}
				for (const id of parsed.x ?? []) intents.delete(id);
				for (const [id, content] of Object.entries(parsed.i ?? {})) intents.set(id, content);
				for (const [key, tx] of Object.entries(parsed.k ?? {})) {
					if (Number.isSafeInteger(tx) && tx > (keys.get(key) ?? 0)) keys.set(key, tx);
				}
				continue;
			}
			const entries = decodeLogTexts(data);
			if (!entries) throw new Error("not a per-block text row");
			for (const e of entries) {
				if (e.kind === LIVE_TEXT_KIND.drop) {
					// The session dropped the block's document (its text was committed, or the
					// block left the session): nothing of it is uncommitted, and a document the
					// block gets later starts from its own seed.
					docs.get(e.id)?.doc.destroy();
					docs.delete(e.id);
					base.delete(e.id);
					assumed.delete(e.id);
					intents.delete(e.id);
					waiting.delete(e.id);
					lastActor.delete(e.id);
				} else if (e.kind === LIVE_TEXT_KIND.seed) {
					// What the database held when the document was made.
					const seed = decodeLiveSeed(e.data);
					if (seed === null) throw new Error("a seed text is not UTF-8");
					const existing = docs.get(e.id);
					if (!existing) docOf(e.id, seed);
					else {
						// The seed after an update of its document (a session writes it before; a
						// log is still read whatever order its rows come in): the document takes
						// the seed's item now, and the updates that waited for it go in, as their
						// author's.
						const made = seededTextDoc(seed);
						Y.applyUpdate(existing.doc, Y.encodeStateAsUpdate(made.doc), waiting.get(e.id) ?? row);
						made.doc.destroy();
					}
					if (!base.has(e.id) || assumed.delete(e.id)) base.set(e.id, seed);
				} else {
					// A document the log has no seed for started from the empty text (an empty
					// block, or one made in the session); in the snapshot it comes whole.
					if (!first && !docs.has(e.id) && !base.has(e.id)) {
						base.set(e.id, "");
						assumed.add(e.id);
					}
					const t = docOf(e.id);
					Y.applyUpdate(t.doc, e.data, row);
					if (!hasPendingStructs(t.doc)) waiting.delete(e.id);
					else if (row.actorKind === "human") waiting.set(e.id, row);
				}
			}
			if (first) {
				// The snapshot: its texts are the base wherever no sync row says otherwise.
				for (const [id, t] of docs) if (!base.has(id)) base.set(id, t.text.toString());
				first = false;
			}
		}
	} catch (error) {
		logger.warn("Outline live log unreadable; kept", { spaceId, epoch, error: String(error) });
		destroy();
		return { outcome: "kept", keys };
	}
	// An update still waiting for items no row brought: the document's text is not what was
	// typed. Nothing is committed from such a log, and it is not dropped.
	const stuck = [...docs].filter(([, t]) => hasPendingStructs(t.doc)).map(([id]) => id);
	if (stuck.length > 0) {
		logger.warn("Outline live log incomplete (updates without the items they name); kept", {
			spaceId,
			epoch,
			blocks: stuck.slice(0, 20),
		});
		destroy();
		return { outcome: "kept", keys };
	}

	// What the blocks table holds now for every block the log has a document of: read by
	// primary key, a few at a time (a log holds at most a few thousand documents).
	const blocks: Array<{ id: string; content: string; parentId: string | null }> = [];
	const changes: Array<{ id: string; text: string; actor: string | null }> = [];
	let read = 0;
	for (const [id, t] of docs) {
		if (++read % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
		const b = await outlineStore.getBlock(id);
		if (!b || b.deleted || b.spaceId !== spaceId) continue;
		blocks.push(b);
		const final = t.text.toString();
		// The session committed this just before it ended, and logged nothing after.
		const intent = intents.get(b.id);
		if (intent !== undefined && intent === b.content) continue;
		const from = base.get(b.id) ?? b.content;
		if (final === from) continue;
		const merged = merge3(from, final, b.content, { lenient: true });
		const text = merged.ok ? merged.result : final;
		if (text !== b.content) changes.push({ id: b.id, text, actor: lastActor.get(b.id) ?? null });
	}
	destroy();
	if (changes.length > 0) {
		const committed = await commitChanges(spaceId, changes, blocks);
		if (!committed) return { outcome: "kept", keys, changes };
	}
	await outlineStore.deleteLiveLog(spaceId, epoch);
	return { outcome: changes.length > 0 ? "committed" : "empty", keys };
}

async function commitChanges(
	spaceId: string,
	changes: Array<{ id: string; text: string; actor: string | null }>,
	blocks: ReadonlyArray<{ id: string; content: string; parentId: string | null }>,
): Promise<boolean> {
	const current = new Map(blocks.map((b) => [b.id, b]));
	// A text past the per-block limit keeps what fits; the log is the only other copy of the
	// rest, so it becomes the block's next siblings rather than being dropped.
	const cut = changes.map((c) => fitBody(c.text));
	let normalized: Awaited<ReturnType<typeof OUTLINE_LIVE_HOOKS.normalize>>;
	try {
		normalized = await OUTLINE_LIVE_HOOKS.normalize(cut.flat());
	} catch (error) {
		logger.warn("Outline live replay could not normalize", { error: String(error) });
		return false;
	}
	const plans: ContentPlan[] = [];
	let at = 0;
	changes.forEach((c, i) => {
		const parts = normalized.slice(at, at + (cut[i] as string[]).length);
		at += (cut[i] as string[]).length;
		plans.push({ id: c.id, text: c.text, parts });
	});
	const byActor = new Map<string | null, ContentPlan[]>();
	changes.forEach((c, i) => {
		const list = byActor.get(c.actor);
		if (list) list.push(plans[i] as ContentPlan);
		else byActor.set(c.actor, [plans[i] as ContentPlan]);
	});
	for (const [actor, list] of byActor) {
		const ops: OutlineOp[] = [];
		const canonical: Array<OutlineCanonicalContent | undefined> = [];
		const groups: Array<[number, number]> = [];
		for (const plan of list) {
			const b = current.get(plan.id);
			const start = ops.length;
			if (b) contentOps(plan, b.content, b.parentId, ops, canonical);
			groups.push([start, ops.length]);
		}
		if (ops.length === 0) continue;
		try {
			// One block's operations stay in one transaction when they fit (the limits on
			// operations and content bytes per transaction).
			for (const [start, end] of planChunks(ops, groups)) {
				await asOwnLiveWrite(() =>
					OUTLINE_LIVE_HOOKS.write(
						{
							spaceId,
							ops: ops.slice(start, end),
							actor: actor ? { kind: "human", id: actor } : { kind: "system", id: "outline-live" },
							responsibleUserId: actor,
							summary: "live edit (recovered)",
						},
						{ canonical: canonical.slice(start, end) },
					),
				);
			}
		} catch (error) {
			logger.warn("Outline live replay commit failed; log kept", { spaceId, error: String(error) });
			return false;
		}
	}
	return true;
}

/**
 * The startup job: replay every epoch left in the log, one at a time with a pause between, skipping
 * epochs of sessions open in this process (`isLive`). Resolves when the log was walked once.
 */
export async function replayAllLiveEpochs(
	isLive: (spaceId: string, epoch: number) => boolean,
	replay: (spaceId: string, epoch: number) => Promise<ReplayOutcome>,
): Promise<{ committed: number; kept: number }> {
	let after: { spaceId: string; epoch: number } | undefined;
	let committed = 0;
	let kept = 0;
	for (;;) {
		const epochs = await outlineStore.listLiveLogEpochs({
			...(after ? { after } : {}),
			limit: OUTLINE_LIVE_REPLAY.epochsPerPage,
		});
		for (const e of epochs) {
			if (isLive(e.spaceId, e.epoch)) continue;
			try {
				const outcome = await replay(e.spaceId, e.epoch);
				if (outcome === "committed") committed++;
				if (outcome === "kept") kept++;
			} catch (error) {
				kept++;
				logger.warn("Outline live replay failed", { spaceId: e.spaceId, error: String(error) });
			}
			await new Promise((resolve) => setTimeout(resolve, OUTLINE_LIVE_REPLAY.pauseMs));
		}
		if (epochs.length < OUTLINE_LIVE_REPLAY.epochsPerPage) break;
		after = epochs[epochs.length - 1];
	}
	return { committed, kept };
}
