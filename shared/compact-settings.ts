export const DEFAULT_COMPACT_RETRY_LIMIT = 1;

export function normalizeCompactRetryLimit(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_COMPACT_RETRY_LIMIT;
	}
	if (value === -1) return -1;
	return Math.max(0, Math.floor(value));
}
