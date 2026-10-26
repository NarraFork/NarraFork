import type { SQL } from "bun";
import { TOKEN_ACCOUNTING_VERSION } from "../../shared/token-accounting";
import {
	TOKEN_COUNTER_COLUMNS,
	TOKEN_RECALCULATION_BATCH_SIZE,
	type TokenRecalculationRow,
	type TokenRecalculationStore,
	tokenCountersChanged,
	tokenRecalculationScanSql,
} from "./token-recalculation";

/** One bounded UPDATE per batch; the version and counters change atomically. */
export const POSTGRES_TOKEN_RECALCULATION_UPDATE = `WITH changes AS (
	SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
		id text, provider text, model text, credential_id text,
		${TOKEN_COUNTER_COLUMNS.flatMap((key) => [`old_${key} bigint`, `${key} bigint`]).join(", ")}
	)
)
UPDATE api_requests AS a SET
	${TOKEN_COUNTER_COLUMNS.map((key) => `${key} = x.${key}`).join(", ")},
	token_accounting_version = ${TOKEN_ACCOUNTING_VERSION}
FROM changes AS x WHERE a.id = x.id AND a.token_accounting_version IS NULL
	AND ${TOKEN_COUNTER_COLUMNS.map((key) => `a.${key} = x.old_${key}`).join(" AND ")}
	AND a.provider IS NOT DISTINCT FROM x.provider
	AND a.model IS NOT DISTINCT FROM x.model
	AND a.credential_id IS NOT DISTINCT FROM x.credential_id
RETURNING a.id`;

export function createPostgresTokenRecalculationStore(client: SQL): TokenRecalculationStore {
	// Use transaction-local settings, not SET on a shared pool connection.
	async function query(text: string, params: unknown[]): Promise<Record<string, unknown>[]> {
		return (await client.begin(async (tx) => {
			await tx.unsafe("SET LOCAL statement_timeout = '5s'");
			await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
			return Array.from(await tx.unsafe(text, params));
		})) as Record<string, unknown>[];
	}
	return {
		async scan(scope, cursor) {
			const scan = tokenRecalculationScanSql(scope, cursor);
			let i = 0;
			return (await query(
				scan.sql.replace(/\?/g, () => `$${++i}`),
				scan.params,
			)) as unknown as TokenRecalculationRow[];
		},
		async apply(updates) {
			if (updates.length > TOKEN_RECALCULATION_BATCH_SIZE)
				throw new Error("Token recalculation batch too large");
			if (!updates.length) return { processed: 0, changed: 0, fallback: 0 };
			const payload = updates.map(({ before, after }) => ({
				id: before.id,
				provider: before.provider,
				model: before.model,
				credential_id: before.credential_id,
				...Object.fromEntries(TOKEN_COUNTER_COLUMNS.map((key) => [`old_${key}`, before[key]])),
				...after,
			}));
			const applied = new Set(
				(await query(POSTGRES_TOKEN_RECALCULATION_UPDATE, [JSON.stringify(payload)])).map(
					(row) => row.id,
				),
			);
			const result = { processed: applied.size, changed: 0, fallback: 0 };
			for (const update of updates) {
				if (!applied.has(update.before.id)) continue;
				if (tokenCountersChanged(update.before, update.after)) result.changed++;
				if (update.fallback) result.fallback++;
			}
			return result;
		},
		async close() {
			// The application's PostgreSQL runtime owns this pool.
		},
	};
}
