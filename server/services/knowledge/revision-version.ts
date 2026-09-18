/**
 * knowledge/revision-version.ts — the single seam for `knowledge_revisions.version` allocation.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Every writer that appends a revision to a knowledge entry must go through this
 * primitive. Before it, `knowledge-service.addRevision` and
 * `knowledge-branch-service.commitMergedRevision` each open-coded their own
 * `MAX(version) + 1` inside the transaction. Under SQLite's single writer that shape
 * is safe; under a concurrent backend two writers on different connections can read
 * the same MAX and insert the same version — the unique index on (entry_id, version)
 * turns the race into an error, but only AFTER one writer's work is lost. This is the
 * same disease `narrator_message_refs.seq` had (see `narrator-refs/seq-store.ts`),
 * and it gets the same cure.
 *
 * THE FROZEN TARGET DESIGN (counter claim — blocked on schema)
 * ------------------------------------------------------------
 * The target implementation follows the narrator-refs design: a per-entry counter
 * column `knowledge_entries.next_version`, claimed inside the writer's transaction:
 *
 *   UPDATE knowledge_entries SET next_version = next_version + 1 WHERE id = ?
 *   RETURNING next_version
 *   -- claimed version = returned value - 1
 *
 * That UPDATE doubles as the per-entry mutex: two writers on different connections
 * serialize on the entry row, so a concurrent append can never observe the same MAX
 * and claim the same version.
 *
 * THE CURRENT IMPLEMENTATIONS (this batch)
 * ----------------------------------------
 * `knowledge_entries.next_version` does not exist yet (schema changes are a separate,
 * manager-owned step; the proposal is at the bottom of this file). Until it lands:
 *
 *   SQLite    claims `MAX(version) + 1` INSIDE the writer's transaction
 *             ({@link claimNextRevisionVersion} below). Under the single-writer
 *             transaction this is value-for-value equivalent to the counter claim:
 *             same transaction boundary, same serialization point (the write
 *             transaction itself), same result. The call site has been moved behind
 *             this function so the schema landing is a one-body change.
 *
 *   PostgreSQL takes the ENTRY ROW LOCK first (`SELECT id … FOR UPDATE`) and only
 *             then reads MAX(version) — the "row-lock form" of the same claim. The
 *             lock serializes concurrent allocators on the entry row, which is exactly
 *             the mutual-exclusion point the counter UPDATE will provide later. This
 *             form needs no schema change and is verified against a real PostgreSQL 17
 *             (tests/server/services/knowledge/pg-knowledge-write.test.ts): concurrent
 *             appenders produce unique, contiguous versions, and the unlocked MAX+1
 *             negative control produces the duplicate the lock exists to prevent.
 *
 * Known semantic deltas when the bodies are swapped for the counter (recorded so the
 * swap is a conscious review, not a surprise):
 *
 *   1. A rolled-back claim is reused in BOTH designs (the counter bump rolls back with
 *      the transaction), so no test may treat a burned version as permanent.
 *   2. MAX+1 reuses version numbers freed by top-of-history DELETES; the counter does
 *      not. Revisions are append-only in every current writer (nothing deletes them),
 *      and all consumers treat (entry_id, version) as ordering/identity semantics, so
 *      monotonic-with-gaps is a strictly stronger guarantee, not a behavior change.
 *   3. The counter claim updates the entries row, so a claim against a deleted entry
 *      fails loudly instead of allocating into the void. The FK on
 *      knowledge_revisions.entry_id already rejects the insert today; the counter just
 *      fails one statement earlier.
 *
 * SCHEMA PROPOSAL (for the schema owner — do NOT apply from here)
 * ---------------------------------------------------------------
 *   -- SQLite (drizzle/schema.ts): nextVersion: integer("next_version").notNull().default(1)
 *   ALTER TABLE knowledge_entries ADD COLUMN next_version INTEGER NOT NULL DEFAULT 1;
 *   UPDATE knowledge_entries SET next_version = COALESCE((
 *     SELECT MAX(version) + 1 FROM knowledge_revisions WHERE entry_id = knowledge_entries.id
 *   ), 1);
 *   -- PostgreSQL (postgres-schema.ts): identical column + backfill.
 * After the column lands: swap the body below, delete the "current implementations"
 * wording, and extend the PG suite to run the production code path.
 */
import { desc, eq } from "drizzle-orm";
import type { db } from "../../db";
import { knowledgeRevisions } from "../../db/schema";

/**
 * Transaction handle shared by the knowledge SQLite writers.
 *
 * SYNC CONTRACT: this primitive runs INSIDE `db.transaction((tx) => …)` callbacks,
 * which under bun:sqlite must be strictly synchronous (see
 * server/db/transaction-atomicity-contract.test.ts). Never add an awaitable step here;
 * the PostgreSQL backend gets its own adapter instead of reshaping this call signature.
 */
export type KnowledgeWriteTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** First version allocated to a new entry. */
export const KNOWLEDGE_REVISION_VERSION_BASE = 1;

/**
 * Claim the next version for an append to `entryId`.
 *
 * Current body: `MAX(version) + 1` inside the caller's write transaction. Under
 * SQLite's single writer this is exactly the counter claim above — same value, same
 * atomicity. The claim is intentionally decoupled from the revision INSERT so every
 * allocation authority lives in one place.
 *
 * Target body once `knowledge_entries.next_version` exists (also the per-entry row
 * lock that serializes concurrent writers on a multi-connection backend):
 *
 *   tx.update(knowledgeEntries)
 *     .set({ nextVersion: sql`${knowledgeEntries.nextVersion} + 1` })
 *     .where(eq(knowledgeEntries.id, entryId))
 *     .returning({ nextVersion: knowledgeEntries.nextVersion })  // claimed = returned - 1
 */
export function claimNextRevisionVersion(tx: KnowledgeWriteTx, entryId: string): number {
	const row = tx
		.select({ v: knowledgeRevisions.version })
		.from(knowledgeRevisions)
		.where(eq(knowledgeRevisions.entryId, entryId))
		.orderBy(desc(knowledgeRevisions.version))
		.limit(1)
		.get();
	return (row?.v ?? KNOWLEDGE_REVISION_VERSION_BASE - 1) + 1;
}
