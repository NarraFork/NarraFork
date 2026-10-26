import { TOKEN_ACCOUNTING_VERSION } from "../../shared/token-accounting";
import type {
	TokenProtocolResolution,
	TokenRecalculationJob,
	TokenRecalculationProtocol,
} from "../../shared/token-recalculation";

export const TOKEN_RECALCULATION_BATCH_SIZE = 500;
export const TOKEN_RECALCULATION_BATCH_TIMEOUT_MS = 30_000;
export const TOKEN_COUNTER_COLUMNS = [
	"input_tokens",
	"cached_input_tokens",
	"cache_creation_input_tokens",
	"cache_creation_5m_tokens",
	"cache_creation_1h_tokens",
] as const;
export type TokenCounters = Record<(typeof TOKEN_COUNTER_COLUMNS)[number], number>;
export interface TokenRecalculationRow extends TokenCounters {
	id: string;
	created_at: string;
	provider: string | null;
	model: string | null;
	credential_id: string | null;
}
export interface TokenRecalculationCursor {
	created_at: string;
	id: string;
}
export interface TokenRecalculationScope {
	start: string;
	end: string;
}
export interface TokenRecalculationUpdate {
	before: TokenRecalculationRow;
	after: TokenCounters;
	fallback: boolean;
}
export interface TokenRecalculationBatchResult {
	processed: number;
	changed: number;
	fallback: number;
}
export interface TokenRecalculationStore {
	scan(
		scope: TokenRecalculationScope,
		cursor?: TokenRecalculationCursor,
	): Promise<TokenRecalculationRow[]>;
	apply(updates: TokenRecalculationUpdate[]): Promise<TokenRecalculationBatchResult>;
	close(): Promise<void>;
}

/** Conversion of the explicitly selected OLD inclusive-input range, not a detector of old bugs. */
export function recalculateTokenCounters(
	before: TokenCounters,
	protocol: TokenRecalculationProtocol,
): TokenCounters | null {
	if (TOKEN_COUNTER_COLUMNS.some((key) => !Number.isSafeInteger(before[key]) || before[key] < 0)) {
		return null;
	}
	const write = Math.max(
		before.cache_creation_input_tokens,
		before.cache_creation_5m_tokens + before.cache_creation_1h_tokens,
	);
	if (!Number.isSafeInteger(write)) return null;
	const deducted =
		protocol === "anthropic" ? 0 : before.cached_input_tokens + (protocol === "openai" ? write : 0);
	return {
		input_tokens: Math.max(before.input_tokens - deducted, 0),
		cached_input_tokens: before.cached_input_tokens,
		cache_creation_input_tokens: write,
		cache_creation_5m_tokens: before.cache_creation_5m_tokens,
		cache_creation_1h_tokens: before.cache_creation_1h_tokens,
	};
}

export function tokenCountersChanged(before: TokenCounters, after: TokenCounters): boolean {
	return TOKEN_COUNTER_COLUMNS.some((key) => before[key] !== after[key]);
}

export function tokenRecalculationScope(job: TokenRecalculationJob): TokenRecalculationScope {
	const requestedEnd = job.endDate
		? new Date(Date.parse(`${job.endDate}T00:00:00.000Z`) + 86_400_000).toISOString()
		: job.startedAt;
	return {
		start: job.startDate ? `${job.startDate}T00:00:00.000Z` : "",
		end: requestedEnd < job.startedAt ? requestedEnd : job.startedAt,
	};
}

/** One bounded seek per batch. The partial index excludes all previously processed rows. */
export function tokenRecalculationScanSql(
	scope: TokenRecalculationScope,
	cursor?: TokenRecalculationCursor,
) {
	const params: (string | number)[] = [scope.start, scope.end];
	let seek = "";
	if (cursor) {
		seek = " AND (created_at, id) > (?, ?)";
		params.push(cursor.created_at, cursor.id);
	}
	params.push(TOKEN_RECALCULATION_BATCH_SIZE);
	return {
		sql: `SELECT id, created_at, provider, model, credential_id, ${TOKEN_COUNTER_COLUMNS.join(", ")}
			FROM api_requests WHERE token_accounting_version IS NULL
			AND created_at >= ? AND created_at < ?${seek} ORDER BY created_at, id LIMIT ?`,
		params,
	};
}

export const TOKEN_RECALCULATION_UPDATE_SQL = `UPDATE api_requests SET
	${TOKEN_COUNTER_COLUMNS.map((key) => `${key} = ?`).join(", ")}, token_accounting_version = ${TOKEN_ACCOUNTING_VERSION}
	WHERE id = ? AND token_accounting_version IS NULL
	AND ${TOKEN_COUNTER_COLUMNS.map((key) => `${key} = ?`).join(" AND ")}
	AND provider IS ? AND model IS ? AND credential_id IS ?`;

export function tokenRecalculationUpdateParams(update: TokenRecalculationUpdate) {
	return [
		...TOKEN_COUNTER_COLUMNS.map((key) => update.after[key]),
		update.before.id,
		...TOKEN_COUNTER_COLUMNS.map((key) => update.before[key]),
		update.before.provider,
		update.before.model,
		update.before.credential_id,
	];
}

export async function runTokenRecalculation(
	job: TokenRecalculationJob,
	store: TokenRecalculationStore,
	resolveProtocol: (row: TokenRecalculationRow) => TokenProtocolResolution,
	signal: AbortSignal,
	onSlowBatch?: (milliseconds: number, rows: number) => void,
): Promise<void> {
	const scope = tokenRecalculationScope(job);
	let cursor: TokenRecalculationCursor | undefined;
	while (!signal.aborted) {
		const started = performance.now();
		const rows = await store.scan(scope, cursor);
		if (signal.aborted || rows.length === 0) break;
		const updates: TokenRecalculationUpdate[] = [];
		for (const before of rows) {
			const resolution = resolveProtocol(before);
			const after = recalculateTokenCounters(before, resolution.protocol);
			if (after) updates.push({ before, after, fallback: resolution.fallback });
		}
		const result = await store.apply(updates);
		// Publish progress only AFTER the transaction commits. Cancellation doesn't erase committed work.
		job.scanned += rows.length;
		job.processed += result.processed;
		job.changed += result.changed;
		job.fallback += result.fallback;
		job.skipped += rows.length - result.processed;
		const last = rows[rows.length - 1];
		if (last) cursor = { created_at: last.created_at, id: last.id };
		const elapsed = performance.now() - started;
		if (elapsed > 250) onSlowBatch?.(elapsed, rows.length);
		// Yield between short transactions, including on the async PostgreSQL path.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}
