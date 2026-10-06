import { and, eq, gte, sql } from "drizzle-orm";
import type { db } from "../../db";
import { narratorMessageRefs, narrators } from "../../db/schema";

/** SQLite transactions must remain synchronous. PG uses its own Promise primitives. */
export type NarratorRefsTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const NARRATOR_REF_SEQ_BASE = 0;
export const NARRATOR_REF_SEQ_EMPTY_TOP = -1;

/**
 * Process-lifetime set of narrator ids whose seq floor has been raised this boot.
 *
 * Lives on globalThis so hot-reload does not drop the in-memory mark. Marking is
 * COMMIT-THEN-MARK only: never add an id before the transaction that called
 * `initializeRefSeqFloor` for it has successfully returned/committed. A rollback
 * undoes the floor raise, so a premature mark would make the next claim skip
 * repair and hand out colliding seqs.
 *
 * While a write transaction is open, ids raised inside it live in
 * `activeRaiseScopes` (a stack), NOT in the healed set — so a rolled-back
 * section never looks healed, and in-transaction helpers can skip a second
 * top-seek for an id already raised in that same open section.
 */
const NARRATOR_SEQ_FLOOR_HEALED = Symbol.for("narrafork.narratorSeqFloorHealed");

function narratorSeqFloorHealedSet(): Set<string> {
	const bag = globalThis as typeof globalThis & {
		[NARRATOR_SEQ_FLOOR_HEALED]?: Set<string>;
	};
	bag[NARRATOR_SEQ_FLOOR_HEALED] ??= new Set<string>();
	return bag[NARRATOR_SEQ_FLOOR_HEALED];
}

const activeRaiseScopes: Set<string>[] = [];

export function isNarratorSeqFloorHealed(narratorId: string): boolean {
	return narratorSeqFloorHealedSet().has(narratorId);
}

/** Call only AFTER the transaction that raised this narrator's floor has committed. */
export function markNarratorSeqFloorHealed(narratorId: string): void {
	narratorSeqFloorHealedSet().add(narratorId);
}

export function markNarratorSeqFloorHealedMany(narratorIds: Iterable<string>): void {
	const set = narratorSeqFloorHealedSet();
	for (const id of narratorIds) set.add(id);
}

/** Test/import helper: forget process marks (all, or only the given ids). */
export function clearNarratorSeqFloorHealed(narratorIds?: Iterable<string>): void {
	const set = narratorSeqFloorHealedSet();
	if (!narratorIds) {
		set.clear();
		return;
	}
	for (const id of narratorIds) set.delete(id);
}

/**
 * Run `fn` (usually a whole `db.transaction`) and mark any seq floors raised
 * inside it as healed only if `fn` returns normally. Rollback/throw → no mark.
 */
export function withSeqFloorRaiseScope<T>(fn: () => T): T {
	const raised = new Set<string>();
	activeRaiseScopes.push(raised);
	let ok = false;
	try {
		const result = fn();
		ok = true;
		return result;
	} finally {
		activeRaiseScopes.pop();
		if (ok && raised.size) markNarratorSeqFloorHealedMany(raised);
	}
}

/**
 * Sync-only raise scope stack. Do NOT wrap concurrent async work here: interleaved
 * awaits would let another section steal `currentRaiseScope()`. SQLite transactions
 * are synchronous; PG marks healed via explicit `needsSeqFloorMark` after commit.
 */

function currentRaiseScope(): Set<string> | undefined {
	return activeRaiseScopes[activeRaiseScopes.length - 1];
}

/** Record that the open raise scope already raised this narrator's floor. */
export function noteSeqFloorRaiseInCurrentScope(narratorId: string): void {
	currentRaiseScope()?.add(narratorId);
}

/**
 * Raise the seq floor for `narratorId` inside an open write tx if this process
 * has not yet healed it (and this open section has not already raised it).
 * No-op in steady state (healed) — claim then stays a pure counter increment.
 */
export function raiseSeqFloorForClaim(tx: NarratorRefsTx, narratorId: string): void {
	if (isNarratorSeqFloorHealed(narratorId)) return;
	const scope = currentRaiseScope();
	if (scope?.has(narratorId)) return;
	initializeRefSeqFloor(tx, narratorId);
	scope?.add(narratorId);
}

/**
 * Raise floors for narrators not yet healed (and not already raised in this open
 * section). Prefer wrapping the outer transaction with
 * `withSeqFloorRaiseScope` / `dbTransactionWithSeqFloor` so marks commit correctly.
 */
export function raiseUnhealedSeqFloors(
	tx: NarratorRefsTx,
	narratorIds: Iterable<string>,
): string[] {
	const raised: string[] = [];
	const scope = currentRaiseScope();
	for (const id of narratorIds) {
		if (isNarratorSeqFloorHealed(id)) continue;
		if (scope?.has(id)) continue;
		initializeRefSeqFloor(tx, id);
		scope?.add(id);
		raised.push(id);
	}
	return raised;
}

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

/**
 * Atomic monotone counter claim; rolled-back claims roll back with the message/ref.
 *
 * STEADY-STATE PERFORMANCE CONTRACT: this is a pure `next_seq + 1` and must never
 * read `MAX(refs.seq)`. Floor repair is the choke point's job — either
 * `dbTransactionWithSeqFloor` / `withSeqFloorRaiseScope` around the write tx, or
 * `raiseSeqFloorForClaim(tx, id)` immediately before claim/shift inside an
 * already-open section (e.g. `runAtomicWrite`). Commit-then-mark only.
 */
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
	// Floor first: shift+claim alone does not guarantee next_seq > historical max.
	raiseSeqFloorForClaim(tx, narratorId);
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
	// If this runs inside withSeqFloorRaiseScope / dbTransactionWithSeqFloor, remember the
	// raise so the outer wrapper can mark healed after commit (fork inserts the row first,
	// then initializes — pre-raising a missing id would throw).
	currentRaiseScope()?.add(narratorId);
	return row.nextSeq;
}
