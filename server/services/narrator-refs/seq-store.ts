import { and, eq, gte, sql } from "drizzle-orm";
import type { db } from "../../db";
import { narratorMessageRefs, narrators } from "../../db/schema";

/** SQLite transactions must remain synchronous. PG uses its own Promise primitives. */
export type NarratorRefsTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const NARRATOR_REF_SEQ_BASE = 0;
export const NARRATOR_REF_SEQ_EMPTY_TOP = -1;

/** Read-only watermark, never an allocation authority. */
export function readTopRefSeq(tx: NarratorRefsTx, narratorId: string): number | null {
	return (
		tx
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, narratorId))
			.orderBy(sql`${narratorMessageRefs.seq} DESC`)
			.limit(1)
			.get()?.seq ?? null
	);
}

/** Atomic monotone counter claim; rolled-back claims roll back with the message/ref. */
export function claimNextRefSeq(tx: NarratorRefsTx, narratorId: string): number {
	const row = tx
		.update(narrators)
		.set({ nextSeq: sql`${narrators.nextSeq} + 1` })
		.where(eq(narrators.id, narratorId))
		.returning({ nextSeq: narrators.nextSeq })
		.get();
	if (!row) throw new Error(`Narrator not found: ${narratorId}`);
	return row.nextSeq - 1;
}

/** Reserve before shifting, including sparse histories and a removed former tail. */
export function claimShiftInsertSlot(
	tx: NarratorRefsTx,
	narratorId: string,
	fromSeq: number,
): void {
	if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) throw new Error("Invalid ref seq");
	// A caller may insert above the current high watermark; never leave its slot unreserved.
	tx.update(narrators)
		.set({ nextSeq: sql`max(${narrators.nextSeq}, ${fromSeq})` })
		.where(eq(narrators.id, narratorId))
		.run();
	claimNextRefSeq(tx, narratorId);
	tx.update(narratorMessageRefs)
		.set({ seq: sql`${narratorMessageRefs.seq} + 1` })
		.where(
			and(eq(narratorMessageRefs.narratorId, narratorId), gte(narratorMessageRefs.seq, fromSeq)),
		)
		.run();
}

/** Called in the same transaction as every inherited/fork ref copy. Never lowers the counter. */
export function initializeRefSeqFloor(tx: NarratorRefsTx, narratorId: string): number {
	const floor = (readTopRefSeq(tx, narratorId) ?? NARRATOR_REF_SEQ_EMPTY_TOP) + 1;
	const row = tx
		.update(narrators)
		.set({ nextSeq: sql`max(${narrators.nextSeq}, ${floor})` })
		.where(eq(narrators.id, narratorId))
		.returning({ nextSeq: narrators.nextSeq })
		.get();
	if (!row) throw new Error(`Narrator not found: ${narratorId}`);
	return row.nextSeq;
}
