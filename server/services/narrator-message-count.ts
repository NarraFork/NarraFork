/**
 * Message counts for narrators: what is displayed, and what `message_count` is.
 *
 * The stored column used to be `+1`-ed once per finished agent loop, so it was a
 * *turn* counter wearing a message counter's name — a conversation with 340
 * messages displayed "2", and subagents (which never run that code path) sat at 0
 * forever. The intended meaning is the number of message refs the narrator owns
 * (`narrator_message_refs`), which is exactly what the transcript renders.
 *
 * **Everything user-visible is counted here, not read from the column.** The
 * detail endpoint counts one narrator; the list endpoint counts its page's ids in
 * one grouped query (0.8ms for a typical page, 11ms for a synthetic page of the
 * 20 largest narrators in a 507k-ref database). Counting the page *after*
 * pagination is what makes this affordable: a correlated `count(*)` in the list
 * query itself measured 37ms, and 40ms when it also drove ORDER BY.
 *
 * **The stored column is an insert-only upper bound**, maintained in
 * `appendMessageRefSync` where it rides along with the `messageVersion` bump that
 * row already receives (72ms → 83ms per 20k refs; recomputing there instead would
 * be O(n²) and measured 8.3s for the same 20k). It is deliberately *not*
 * decremented: refs are deleted from ~30 scattered call sites (rollback, compact,
 * fork cleanup), and a missed decrement is a permanent silent error, whereas an
 * un-decremented counter is a bounded overestimate that no display path reads.
 *
 * Its one remaining job is `sortBy=messageCount`, which must order rows before
 * LIMIT and therefore cannot use the post-pagination exact counts. So ordering is
 * approximate — by high-water mark — while every number shown is exact. Legacy
 * rows written by the old turn-counting code sort low until they receive new
 * messages; that is why no startup backfill exists (startup must never scan the
 * database, and per-row counting over every narrator is exactly such a scan).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorMessageRefs, narratorMessages } from "../db/schema";

/** Exact number of message refs owned by one narrator. */
export async function countNarratorMessageRefs(narratorId: string): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.narratorId, narratorId));
	return row?.count ?? 0;
}

/**
 * Exact message counts for a page of narrators, keyed by narrator id.
 *
 * Narrators with no messages are absent from the map rather than mapped to 0, so
 * callers should default. Bounded by the caller's page size — never hand this the
 * whole table.
 */
export async function countNarratorMessageRefsBatch(
	narratorIds: readonly string[],
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	if (narratorIds.length === 0) return counts;
	const rows = await db
		.select({ narratorId: narratorMessageRefs.narratorId, count: sql<number>`count(*)` })
		.from(narratorMessageRefs)
		.where(inArray(narratorMessageRefs.narratorId, [...narratorIds]))
		.groupBy(narratorMessageRefs.narratorId);
	for (const row of rows) counts.set(row.narratorId, row.count);
	return counts;
}

/**
 * Whether the narrator is still on its very first user turn.
 *
 * Title generation used to ask `messageCount <= 1`, which worked only while the
 * counter meant "finished turns". Against the real message count that test is
 * false as soon as the first turn makes a tool call, so the question is asked
 * directly instead: exactly one user-role message exists.
 *
 * Only messages authored by THIS session count. A fork inherits the parent's
 * prefix as shared refs whose message rows still belong to the parent
 * (`narrator_messages.narrator_id` stays the parent's id — forking copies refs,
 * never message rows, and lazy backfill adds more of the same). Without the
 * ownership filter a forked narrator never looks like it is on its first turn,
 * so its first post-fork message would never trigger title generation.
 *
 * Bounded by `LIMIT 2` — the answer only depends on whether a second user
 * message exists, and stopping there keeps a long conversation cheap (1ms rather
 * than 79ms on a 31k-ref narrator).
 */
export async function isFirstUserTurn(narratorId: string): Promise<boolean> {
	const rows = await db
		.select({ id: narratorMessageRefs.id })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessages.role, "user"),
				eq(narratorMessages.narratorId, narratorId),
			),
		)
		.limit(2);
	return rows.length <= 1;
}
