/**
 * SQLite choke-point helper: raise narrator seq floors inside the write transaction
 * and mark them healed ONLY after that transaction successfully returns (commit).
 *
 * `claimNextRefSeq` stays a pure counter increment. Callers that open a write tx
 * and may claim must run through this wrapper (or `withSeqFloorRaiseScope` around
 * an equivalent transaction) so a rollback never leaves a false healed mark.
 */
import { db } from "../../db";
import { type NarratorRefsTx, raiseUnhealedSeqFloors, withSeqFloorRaiseScope } from "./seq-store";

export function dbTransactionWithSeqFloor<T>(
	narratorIds: string | readonly string[],
	fn: (tx: NarratorRefsTx) => T,
): T {
	const ids = [...new Set(typeof narratorIds === "string" ? [narratorIds] : narratorIds)];
	return withSeqFloorRaiseScope(() =>
		db.transaction((tx) => {
			if (ids.length) raiseUnhealedSeqFloors(tx, ids);
			return fn(tx);
		}),
	);
}
