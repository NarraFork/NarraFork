export const DEFAULT_COMPACT_RETRY_LIMIT = 1;
export const MAX_COMPACT_RETRY_LIMIT = 10;

export function normalizeCompactRetryLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_COMPACT_RETRY_LIMIT;
	}
	return Math.max(0, Math.min(MAX_COMPACT_RETRY_LIMIT, Math.floor(value)));
}
