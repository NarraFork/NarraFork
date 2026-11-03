/**
 * Which version of each block an agent last read, so an edit made against what it read is not
 * applied over someone else's newer change.
 *
 * `OutlineRead` records the version of every block it shows; `OutlineEdit` records the version
 * it wrote (and, for a block it merged, the version its result shows). Before an edit changes an
 * existing block, the version the agent saw is compared with the block's current one: newer, and
 * written by anyone but this agent, means someone changed it since. A `replace` is then merged
 * from that version (`agent-merge.ts`: the version is the merge's base, read back from the
 * block's history); anything else, or a merge that overlaps, is a conflict, reported with the
 * current text and resolved by reading again. A delete checks the blocks under the block the
 * same way. A block the agent never read (or read before a restart: the ledger lives in memory)
 * is the design's "cache gone" case: a replace or delete of it refuses when someone else wrote
 * its latest version, and the refusal shows its current text in full and records that version
 * here, so the edit goes through once the agent has seen it. What the agent wrote itself is
 * never refused for not having been read.
 *
 * Bounded: {@link MAX_BLOCKS_PER_NARRATOR} blocks per narrator and {@link MAX_NARRATORS}
 * narrators, least recently used dropped first.
 */
import { hotSafe } from "@server/lib/hot-safe";

const MAX_NARRATORS = 256;
const MAX_BLOCKS_PER_NARRATOR = 4096;

const ledgers = hotSafe(
	"narrafork.outline.readLedger",
	() => new Map<string, Map<string, number>>(),
);

function ledgerOf(narratorId: string, create: boolean): Map<string, number> | undefined {
	let ledger = ledgers.get(narratorId);
	if (ledger) {
		// Most recently used last.
		ledgers.delete(narratorId);
		ledgers.set(narratorId, ledger);
		return ledger;
	}
	if (!create) return undefined;
	ledger = new Map();
	ledgers.set(narratorId, ledger);
	while (ledgers.size > MAX_NARRATORS) {
		const oldest = ledgers.keys().next().value;
		if (oldest === undefined) break;
		ledgers.delete(oldest);
	}
	return ledger;
}

/** Record that the narrator has seen these blocks at these versions (`version_seq`). */
export function recordOutlineReads(
	narratorId: string,
	versions: Iterable<readonly [blockId: string, versionSeq: number]>,
): void {
	const ledger = ledgerOf(narratorId, true) as Map<string, number>;
	for (const [blockId, versionSeq] of versions) {
		ledger.delete(blockId);
		ledger.set(blockId, versionSeq);
	}
	while (ledger.size > MAX_BLOCKS_PER_NARRATOR) {
		const oldest = ledger.keys().next().value;
		if (oldest === undefined) break;
		ledger.delete(oldest);
	}
}

/** Forget blocks (deleted ones, say). */
export function forgetOutlineReads(narratorId: string, blockIds: Iterable<string>): void {
	const ledger = ledgerOf(narratorId, false);
	if (!ledger) return;
	for (const blockId of blockIds) ledger.delete(blockId);
}

/** The version of a block the narrator last saw, if it is recorded. */
export function seenOutlineVersion(narratorId: string, blockId: string): number | undefined {
	return ledgers.get(narratorId)?.get(blockId);
}

/** Drop every record (tests). */
export function clearOutlineReads(): void {
	ledgers.clear();
}
