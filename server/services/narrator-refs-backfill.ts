/**
 * Lazy backfill of inherited narrator message refs.
 *
 * A fork only materializes the refs the model actually needs — those after the
 * parent's last history compact (see `forkNarrator`). Everything older stays in
 * the parent, recorded by `narrators.refsInheritedFrom` +
 * `narrators.refsBackfillCursor`. This module copies those older windows in when
 * something needs to *show* them: scrolling up, or jumping to an old message.
 *
 * Why this is safe: every model-facing history path is already bounded by the
 * last compact (`getModelHistorySinceLastCompact` and friends), so the refs left
 * behind are display-only. Backfilling therefore never changes what the model
 * sees — it only makes older transcript visible again.
 *
 * Inherited refs keep the parent's original `seq`, so a backfill is a plain
 * ranged insert with no renumbering, and the child's seq space stays aligned
 * with its ancestors'.
 */
import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorMessageRefs, narrators } from "../db/schema";
import { narratorRefsBackfillLock } from "../lib/async-mutex";
import { logger } from "../lib/logger";

/**
 * Refs pulled in per backfill step. The exact-layout page asks for up to 100
 * rows (`getPretextDocumentPage`), so one step covers several screens: enough
 * that scrolling doesn't crawl backwards one page at a time, small enough to
 * stay a sub-10ms ranged insert.
 */
const BACKFILL_WINDOW_REFS = 400;

/** Guard against a pathological ancestor chain (or a cycle that slipped through). */
const MAX_LINEAGE_DEPTH = 32;

/** Bounds the per-call window loop so a violated invariant cannot spin forever. */
const MAX_BACKFILL_STEPS = 1000;

type LazyRefsState = {
	refsInheritedFrom: string | null;
	refsBackfillCursor: number | null;
};

/** Non-null only while the narrator still borrows older refs from a parent. */
type ActiveLazyState = { parentNarratorId: string; cursor: number };

function toActive(state: LazyRefsState | null | undefined): ActiveLazyState | null {
	if (!state?.refsInheritedFrom || state.refsBackfillCursor == null) return null;
	return { parentNarratorId: state.refsInheritedFrom, cursor: state.refsBackfillCursor };
}

async function readLazyState(narratorId: string): Promise<ActiveLazyState | null> {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { refsInheritedFrom: true, refsBackfillCursor: true },
	});
	return toActive(row);
}

/**
 * One narrator's inheritance step, or nothing when it owns all of its refs.
 * `upperBoundSeq` is exclusive: the ancestor's refs at or above it are either
 * already local to the descendant or belong to history it forked away from.
 */
export type LineageStep = {
	narratorId: string;
	parentNarratorId: string;
	upperBoundSeq: number;
};

/**
 * Walk the lazy-fork ancestry from `narratorId` upwards.
 *
 * Each step narrows the visible window: a grandchild can never see more of its
 * grandparent than its parent inherited, so the bound is monotonically
 * non-increasing. Stops at the first narrator that owns all of its refs.
 *
 * Used by search to widen its scope across the chain without materializing it.
 */
export async function resolveLazyLineage(narratorId: string): Promise<LineageStep[]> {
	const steps: LineageStep[] = [];
	const seen = new Set<string>([narratorId]);
	let currentId = narratorId;
	let bound = Number.POSITIVE_INFINITY;

	for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth++) {
		const state = await readLazyState(currentId);
		if (!state) break;
		if (seen.has(state.parentNarratorId)) {
			logger.warn("Lazy refs lineage contains a cycle; stopping walk", {
				narratorId,
				repeatedAncestorId: state.parentNarratorId,
			});
			break;
		}
		bound = Math.min(bound, state.cursor);
		steps.push({
			narratorId: currentId,
			parentNarratorId: state.parentNarratorId,
			upperBoundSeq: bound,
		});
		seen.add(state.parentNarratorId);
		currentId = state.parentNarratorId;
	}
	return steps;
}

/**
 * True when `narratorId` still has un-materialized history below `seq`.
 *
 * The manifest needs this to report `hasOlderChunks` honestly: without it, a user
 * who scrolled to the top of the materialized window would be told there is
 * nothing older. Walks the chain, because the immediate parent may itself be a
 * lazy fork holding nothing at that depth while a grandparent does.
 */
export async function hasUnmaterializedRefsBelow(
	narratorId: string,
	seq: number,
): Promise<boolean> {
	const lineage = await resolveLazyLineage(narratorId);
	for (const step of lineage) {
		const ceiling = Math.min(step.upperBoundSeq, seq);
		if (ceiling <= 0) continue;
		const older = await db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, step.parentNarratorId),
					lt(narratorMessageRefs.seq, ceiling),
				),
			)
			.limit(1);
		if (older.length > 0) return true;
	}
	return false;
}

/**
 * Copy one window of older refs from the parent into `narratorId`, then advance
 * (or clear) the cursor. Returns the number of refs the child gained.
 *
 * Runs as a single synchronous transaction so a concurrent writer can never see
 * a half-copied window or a cursor that disagrees with the rows present.
 */
function copyWindow(
	narratorId: string,
	parentNarratorId: string,
	fromSeq: number,
	plannedUntilSeq: number,
): number {
	return db.transaction((tx) => {
		// Re-read the cursor inside the write transaction: another backfill may have
		// advanced it since we planned this window.
		const state = toActive(
			tx.query.narrators
				.findFirst({
					where: eq(narrators.id, narratorId),
					columns: { refsInheritedFrom: true, refsBackfillCursor: true },
				})
				.sync(),
		);
		if (!state || state.parentNarratorId !== parentNarratorId) return 0;
		const untilSeq = Math.min(plannedUntilSeq, state.cursor);
		if (fromSeq >= untilSeq) return 0;

		const before = countRefsInRange(tx, narratorId, fromSeq, untilSeq);

		// ON CONFLICT on (narrator_id, message_id) makes this idempotent: a message the
		// child already holds (e.g. one an edit COW'd into its own row) is never
		// duplicated. Segment-compacted refs are excluded to match forkNarrator.
		tx.run(sql`
			INSERT INTO narrator_message_refs
				(id, narrator_id, message_id, seq, is_compact, segment_compact_id,
				 delivery_id, delivery_kind, delivery_state)
			SELECT
				lower(hex(randomblob(16))),
				${narratorId},
				refs.message_id,
				refs.seq,
				refs.is_compact,
				refs.segment_compact_id,
				refs.delivery_id,
				refs.delivery_kind,
				refs.delivery_state
			FROM narrator_message_refs AS refs
			WHERE refs.narrator_id = ${parentNarratorId}
				AND refs.seq >= ${fromSeq}
				AND refs.seq < ${untilSeq}
				AND refs.segment_compact_id IS NULL
				AND (refs.delivery_state IS NULL OR refs.delivery_state = 'materialized')
			ORDER BY refs.seq
			ON CONFLICT (narrator_id, message_id) DO NOTHING
		`);

		const inserted = countRefsInRange(tx, narratorId, fromSeq, untilSeq) - before;

		// Is there anything left below the window we just consumed?
		const parentHasOlder = tx
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, parentNarratorId),
					lt(narratorMessageRefs.seq, fromSeq),
					or(
						isNull(narratorMessageRefs.deliveryState),
						eq(narratorMessageRefs.deliveryState, "materialized"),
					),
				),
			)
			.limit(1)
			.all();

		tx.update(narrators)
			.set({
				refsBackfillCursor: parentHasOlder.length > 0 ? fromSeq : null,
				// Fully caught up with this parent: drop the link so later reads skip the
				// lineage walk. If the parent itself inherits from a grandparent, the
				// caller re-links us to it (see relinkToGrandparent).
				refsInheritedFrom: parentHasOlder.length > 0 ? parentNarratorId : null,
				// A structural change: let open clients invalidate their manifest.
				messageVersion: sql`${narrators.messageVersion} + 1`,
				messageStructureVersion: sql`${narrators.messageStructureVersion} + 1`,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(narrators.id, narratorId))
			.run();

		return inserted;
	});
}

function countRefsInRange(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	narratorId: string,
	fromSeq: number,
	untilSeq: number,
): number {
	return (
		tx
			.select({ n: sql<number>`COUNT(*)` })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, narratorId),
					gte(narratorMessageRefs.seq, fromSeq),
					lt(narratorMessageRefs.seq, untilSeq),
				),
			)
			.all()[0]?.n ?? 0
	);
}

/**
 * After exhausting a parent, inherit that parent's own source so the chain stays
 * walkable. Returns true when a new link was adopted.
 *
 * Bounded by the parent's cursor: we can never see more of the grandparent than
 * our parent was itself entitled to.
 */
async function relinkToGrandparent(
	narratorId: string,
	exhaustedParentId: string,
): Promise<boolean> {
	const parentState = await readLazyState(exhaustedParentId);
	if (!parentState) return false;
	const floor = await db
		.select({ seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.narratorId, narratorId))
		.orderBy(narratorMessageRefs.seq)
		.limit(1);
	const cursor = Math.min(floor[0]?.seq ?? parentState.cursor, parentState.cursor);
	await db
		.update(narrators)
		.set({
			refsInheritedFrom: parentState.parentNarratorId,
			refsBackfillCursor: cursor,
		})
		.where(eq(narrators.id, narratorId));
	return true;
}

/**
 * Ensure `narratorId` has materialized every ref it can show down to `targetSeq`.
 *
 * Idempotent and safe to call concurrently: serialized per narrator, with the
 * insert conflicts ignored. A no-op (one indexed lookup) for narrators that are
 * not lazy forks — the overwhelmingly common case.
 *
 * Pass `targetSeq = 0` to materialize the whole inherited history.
 */
export async function ensureRefsCoverSeq(narratorId: string, targetSeq: number): Promise<void> {
	// Cheap pre-check outside the lock: most narrators return here.
	const initial = await readLazyState(narratorId);
	if (!initial || targetSeq >= initial.cursor) return;

	await narratorRefsBackfillLock.acquire(narratorId, async () => {
		for (let step = 0; step < MAX_BACKFILL_STEPS; step++) {
			const current = await readLazyState(narratorId);
			if (!current || targetSeq >= current.cursor) return;
			const parentId = current.parentNarratorId;

			// The parent may itself be a lazy fork that does not yet hold the range we
			// need. Materialize it first, so the copy below has rows to read. Safe
			// against deadlock: locks are per-narrator and the lineage walk rejects
			// cycles; a self-reference would have been filtered by readLazyState.
			if (parentId !== narratorId) {
				const lineage = await resolveLazyLineage(parentId);
				if (lineage.length > 0 && lineage[0].narratorId !== narratorId) {
					await ensureRefsCoverSeq(parentId, targetSeq);
				}
			}

			// Size the window in *refs*, not in seq distance: seq is sparse after a
			// lazy fork, so a fixed seq stride would copy wildly varying amounts.
			const windowRows = await db
				.select({ seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, parentId),
						lt(narratorMessageRefs.seq, current.cursor),
						gte(narratorMessageRefs.seq, targetSeq),
					),
				)
				.orderBy(sql`${narratorMessageRefs.seq} DESC`)
				.limit(BACKFILL_WINDOW_REFS);

			if (windowRows.length === 0) {
				// This parent has nothing more to give in range. If it holds nothing older
				// at all, we are done with it — try to continue up the chain.
				const anyOlder = await db
					.select({ seq: narratorMessageRefs.seq })
					.from(narratorMessageRefs)
					.where(
						and(
							eq(narratorMessageRefs.narratorId, parentId),
							lt(narratorMessageRefs.seq, current.cursor),
						),
					)
					.limit(1);
				if (anyOlder.length > 0) return; // older than targetSeq: nothing requested
				await db
					.update(narrators)
					.set({ refsInheritedFrom: null, refsBackfillCursor: null })
					.where(eq(narrators.id, narratorId));
				if (await relinkToGrandparent(narratorId, parentId)) continue;
				return;
			}

			const fromSeq = windowRows[windowRows.length - 1].seq;
			const inserted = copyWindow(narratorId, parentId, fromSeq, current.cursor);
			logger.debug("Backfilled inherited narrator refs", {
				narratorId,
				parentNarratorId: parentId,
				fromSeq,
				untilSeq: current.cursor,
				inserted,
			});

			const after = await readLazyState(narratorId);
			if (!after) {
				if (await relinkToGrandparent(narratorId, parentId)) continue;
				return;
			}
			// No forward progress means an invariant broke; stop instead of spinning.
			if (after.cursor >= current.cursor) {
				logger.warn("Lazy refs backfill made no progress; stopping", {
					narratorId,
					parentNarratorId: parentId,
					cursor: after.cursor,
				});
				return;
			}
		}
		logger.warn("Lazy refs backfill hit its step cap", { narratorId, targetSeq });
	});
}

/**
 * Materialize whatever is needed for `messageId` to be locally visible.
 *
 * The message's seq is unknown to the child until its refs exist, so resolve it
 * from the ancestor that does hold it. A no-op when the child already has the
 * ref, when the narrator is not a lazy fork, or when no ancestor holds the
 * message (a genuinely unrelated id).
 */
export async function ensureRefsCoverMessage(narratorId: string, messageId: string): Promise<void> {
	const lineage = await resolveLazyLineage(narratorId);
	if (lineage.length === 0) return;

	const local = await db
		.select({ seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		)
		.limit(1);
	if (local.length > 0) return;

	for (const step of lineage) {
		const row = await db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, step.parentNarratorId),
					eq(narratorMessageRefs.messageId, messageId),
				),
			)
			.limit(1);
		const seq = row[0]?.seq;
		// Only history strictly below the inherited bound is missing locally; a hit at
		// or above it belongs to a divergent branch of that ancestor, not to us.
		if (seq != null && seq < step.upperBoundSeq) {
			await ensureRefsCoverSeq(narratorId, seq);
			return;
		}
	}
}

/**
 * Materialize the narrator's entire inherited history.
 *
 * For paths where a partial view would be wrong rather than merely incomplete —
 * e.g. exporting the narrator into a project database.
 */
export async function ensureAllRefsMaterialized(narratorId: string): Promise<void> {
	await ensureRefsCoverSeq(narratorId, 0);
}

/**
 * Detach children that still borrow refs from `parentNarratorId`, materializing
 * what they can keep first.
 *
 * Deleting a narrator that children inherit from would otherwise strand them with
 * a dangling link and silently unreachable history.
 */
export async function materializeChildrenOf(parentNarratorId: string): Promise<string[]> {
	const children = await db
		.select({ id: narrators.id })
		.from(narrators)
		.where(eq(narrators.refsInheritedFrom, parentNarratorId));
	const ids = children.map((row) => row.id);
	for (const childId of ids) {
		await ensureAllRefsMaterialized(childId).catch((err) => {
			logger.warn("Failed to materialize inherited refs before parent removal", {
				childNarratorId: childId,
				parentNarratorId,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}
	// Any child that could not be fully resolved must still lose the dangling link.
	if (ids.length > 0) {
		await db
			.update(narrators)
			.set({ refsInheritedFrom: null, refsBackfillCursor: null })
			.where(inArray(narrators.id, ids));
	}
	return ids;
}
