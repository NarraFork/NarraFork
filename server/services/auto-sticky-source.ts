/**
 * The service an `auto:<model>` session last got a reply from, since its last compact
 * (docs/PROVIDER-SOURCING-DESIGN.md §4.3).
 *
 * The channel lock lives in the messages themselves: every assistant row records the provider
 * that produced it. A session activated again (after a restart or an idle eviction) resolves
 * with that provider as the sticky source, so it keeps the source whose cache it has. Before
 * the first reply of an epoch, and right after a compact, there is nothing to keep and routing
 * picks afresh.
 */
import { and, desc, eq, gt, isNotNull } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { narratorMessageRefs, narratorMessages } from "../db/schema";
import { getNarratorMessageRefsPort } from "./narrator-refs/store";

/** Two bounded projection reads. Read failures must not silently discard the channel lock. */
export async function lastServedProvider(
	narratorId: string,
	db = defaultDb,
): Promise<string | undefined> {
	const port = getNarratorMessageRefsPort();
	if (port) return port.lastServedProvider(narratorId);

	const compact = db
		.select({ seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.where(
			and(eq(narratorMessageRefs.narratorId, narratorId), eq(narratorMessageRefs.isCompact, 1)),
		)
		.orderBy(desc(narratorMessageRefs.seq))
		.limit(1)
		.all()[0];
	const row = db
		.select({ provider: narratorMessages.provider })
		.from(narratorMessageRefs)
		.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				// A forked prefix is shared; only this session's own replies say where it went.
				eq(narratorMessages.narratorId, narratorId),
				eq(narratorMessages.role, "assistant"),
				isNotNull(narratorMessages.provider),
				...(compact ? [gt(narratorMessageRefs.seq, compact.seq)] : []),
			),
		)
		.orderBy(desc(narratorMessageRefs.seq))
		.limit(1)
		.all()[0];
	return row?.provider ?? undefined;
}
