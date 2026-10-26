import type { Database } from "bun:sqlite";
import {
	TOKEN_RECALCULATION_BATCH_SIZE,
	TOKEN_RECALCULATION_UPDATE_SQL,
	type TokenRecalculationBatchResult,
	type TokenRecalculationCursor,
	type TokenRecalculationRow,
	type TokenRecalculationScope,
	type TokenRecalculationStore,
	type TokenRecalculationUpdate,
	tokenCountersChanged,
	tokenRecalculationScanSql,
	tokenRecalculationUpdateParams,
} from "./token-recalculation";

/** Production callers use this only on a dedicated worker, never the HTTP thread. */
export function createSqliteTokenRecalculationStore(database: Database): TokenRecalculationStore {
	const update = database.prepare(TOKEN_RECALCULATION_UPDATE_SQL);
	const applyBatch = database.transaction((updates: TokenRecalculationUpdate[]) => {
		const result: TokenRecalculationBatchResult = { processed: 0, changed: 0, fallback: 0 };
		for (const item of updates) {
			if (update.run(...tokenRecalculationUpdateParams(item)).changes === 0) continue;
			result.processed++;
			if (tokenCountersChanged(item.before, item.after)) result.changed++;
			if (item.fallback) result.fallback++;
		}
		return result;
	});
	return {
		async scan(scope: TokenRecalculationScope, cursor?: TokenRecalculationCursor) {
			const query = tokenRecalculationScanSql(scope, cursor);
			return database.query(query.sql).all(...query.params) as TokenRecalculationRow[];
		},
		async apply(updates) {
			if (updates.length > TOKEN_RECALCULATION_BATCH_SIZE)
				throw new Error("Token recalculation batch too large");
			return applyBatch.immediate(updates);
		},
		async close() {
			database.close();
		},
	};
}
