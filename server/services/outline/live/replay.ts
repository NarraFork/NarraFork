/**
 * Replaying a live session's log after it ended without committing everything (a crash, a
 * failed final commit): the text people typed is committed, then the log is dropped.
 *
 * An epoch's log is a document snapshot, increments, and sync rows (what the database held for
 * a block when the session changed it, commits the session was about to write, and how far each
 * client's changes reached the log; see `LivePage.persistStep`). Replay rebuilds the final
 * document and, for every live block of the page, merges three ways: from the last synced
 * content (or the snapshot's text), to the final text, onto what the database holds now. So a
 * commit the session never logged (an outside write in the last moments) is kept, and only
 * what people typed and nobody committed is written, as their own commits. A block whose last
 * logged intent was never resolved and whose content equals it was committed by the session
 * just before it ended: it is left as it is (merging it again would repeat the text).
 *
 * Runs at startup as a background job over every epoch left in `outline_live_updates`, and
 * before a session opens on a page that still has one. Bounded: at most
 * {@link OUTLINE_LIVE_REPLAY.maxRows} rows and {@link OUTLINE_LIVE_REPLAY.maxBytes} of log per
 * epoch are read (a session compacts long before that); an epoch over the bound is left for an
 * operator and logged, never truncated.
 */
import { logger } from "@server/lib/logger";
import { merge3 } from "@shared/outline";
import * as Y from "yjs";
import { OUTLINE_LIMITS } from "../model";
import { outlineStore } from "../store";
import type { OutlineLiveUpdateRow } from "../store/port";
import type { OutlineCanonicalContent, OutlineOp } from "../write";
import { asOwnLiveWrite } from "./lane";
import {
	type ContentPlan,
	contentOps,
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

const decoder = new TextDecoder();

async function readEpoch(pageId: string, epoch: number): Promise<OutlineLiveUpdateRow[] | null> {
	const rows: OutlineLiveUpdateRow[] = [];
	let bytes = 0;
	let afterSeq: number | undefined;
	for (;;) {
		const page = await outlineStore.listLiveUpdates(pageId, epoch, {
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
		afterSeq = (page[page.length - 1] as OutlineLiveUpdateRow).seq;
	}
}

/**
 * Replay one epoch: commit what is not committed, then drop the rows. `kept` when the log could
 * not be replayed (too large, unreadable, the commit failed): the rows stay.
 */
export async function replayLiveEpoch(pageId: string, epoch: number): Promise<ReplayOutcome> {
	return (await replayLiveEpochDetailed(pageId, epoch)).outcome;
}

/** {@link replayLiveEpoch}, with what a new session of the page needs from it. */
export async function replayLiveEpochDetailed(
	pageId: string,
	epoch: number,
): Promise<ReplayResult> {
	const keys = new Map<string, number>();
	const rows = await readEpoch(pageId, epoch);
	if (!rows) {
		logger.warn("Outline live log too large to replay; kept", { pageId, epoch });
		return { outcome: "kept", keys };
	}
	if (rows.length === 0) return { outcome: "empty", keys };
	const doc = new Y.Doc();
	const texts = doc.getMap<Y.Text>("texts");
	const base = new Map<string, string>();
	/** Intents not resolved by a later sync row or cancel: block → content to be committed. */
	const intents = new Map<string, string>();
	const lastActor = new Map<string, string>();
	texts.observeDeep((events, txn) => {
		const actor = txn.origin as OutlineLiveUpdateRow | null;
		if (!actor || actor.actorKind !== "human") return;
		for (const ev of events) {
			const target = ev.target as unknown as { _item?: { parentSub?: string | null } };
			const id = ev.target === texts ? null : target._item?.parentSub;
			if (id) lastActor.set(id, actor.actorId);
			if (ev.target === texts)
				for (const key of (ev as Y.YMapEvent<Y.Text>).keysChanged)
					lastActor.set(key, actor.actorId);
		}
	});
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
					intents.delete(id);
				}
				for (const id of parsed.x ?? []) intents.delete(id);
				for (const [id, content] of Object.entries(parsed.i ?? {})) intents.set(id, content);
				for (const [key, tx] of Object.entries(parsed.k ?? {})) {
					if (Number.isSafeInteger(tx) && tx > (keys.get(key) ?? 0)) keys.set(key, tx);
				}
				continue;
			}
			Y.applyUpdate(doc, data, row);
			if (first) {
				// The snapshot: its texts are the base wherever no sync row says otherwise.
				for (const [id, t] of texts)
					if (t instanceof Y.Text && !base.has(id)) base.set(id, t.toString());
				first = false;
			}
		}
	} catch (error) {
		logger.warn("Outline live log unreadable; kept", { pageId, epoch, error: String(error) });
		doc.destroy();
		return { outcome: "kept", keys };
	}

	const page = await outlineStore.getBlock(pageId);
	if (!page || page.deleted) {
		doc.destroy();
		await outlineStore.deleteLiveUpdates(pageId, epoch);
		return { outcome: "empty", keys };
	}
	const { blocks } = await outlineStore.listPageBlocks(pageId, OUTLINE_LIMITS.maxPageBlocks);
	const changes: Array<{ id: string; text: string; actor: string | null }> = [];
	for (const b of blocks) {
		const t = texts.get(b.id);
		if (!(t instanceof Y.Text)) continue;
		const final = t.toString();
		// The session committed this just before it ended, and logged nothing after.
		const intent = intents.get(b.id);
		if (intent !== undefined && intent === b.content) continue;
		const from = base.get(b.id) ?? b.content;
		if (final === from) continue;
		const merged = merge3(from, final, b.content, { lenient: true });
		const text = merged.ok ? merged.result : final;
		if (text !== b.content) changes.push({ id: b.id, text, actor: lastActor.get(b.id) ?? null });
	}
	doc.destroy();
	if (changes.length > 0) {
		const committed = await commitChanges(page.spaceId, changes, blocks);
		if (!committed) return { outcome: "kept", keys, changes };
	}
	await outlineStore.deleteLiveUpdates(pageId, epoch);
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
	isLive: (pageId: string, epoch: number) => boolean,
	replay: (pageId: string, epoch: number) => Promise<ReplayOutcome>,
): Promise<{ committed: number; kept: number }> {
	let after: { pageBlockId: string; epoch: number } | undefined;
	let committed = 0;
	let kept = 0;
	for (;;) {
		const epochs = await outlineStore.listLiveEpochs({
			...(after ? { after } : {}),
			limit: OUTLINE_LIVE_REPLAY.epochsPerPage,
		});
		for (const e of epochs) {
			if (isLive(e.pageBlockId, e.epoch)) continue;
			try {
				const outcome = await replay(e.pageBlockId, e.epoch);
				if (outcome === "committed") committed++;
				if (outcome === "kept") kept++;
			} catch (error) {
				kept++;
				logger.warn("Outline live replay failed", { pageId: e.pageBlockId, error: String(error) });
			}
			await new Promise((resolve) => setTimeout(resolve, OUTLINE_LIVE_REPLAY.pauseMs));
		}
		if (epochs.length < OUTLINE_LIVE_REPLAY.epochsPerPage) break;
		after = epochs[epochs.length - 1];
	}
	return { committed, kept };
}
