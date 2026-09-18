/**
 * Caller-side query rules: the part of search that is product behaviour, not dialect.
 *
 * These two decisions are made BEFORE a query reaches a backend, and they must be made the
 * same way for every backend:
 *
 *   - what counts as the query text (sanitizing);
 *   - whether the query can use the full-text index at all (strategy).
 *
 * They live here rather than in a store because a backend that decided for itself could
 * change which rows come back — and which score band they land in — with no caller aware of
 * it. Nothing in this file knows any SQL.
 */

/**
 * Strip characters that carry meaning inside a full-text query expression.
 *
 * Historically framed as injection prevention, and it is that, but the reason it belongs on
 * the caller side is narrower: the surviving text is what the product treats AS the query. It
 * is what "did the title match?" is tested against, what the score bands are measured
 * against, and what an empty result is reported for. A backend applying its own cleaning
 * would answer those questions about a different string than the one the caller reported.
 */
export function sanitizeQuery(query: string): string {
	return query.replace(/['"*(){}[\]^~@:;!&|,<>\\]/g, "").trim();
}

/**
 * Below this many characters the full-text index cannot tokenize the query.
 *
 * Three, because the trigram tokenizer needs three characters to form a token. This holds for
 * CJK as well — verified, and worth stating because it is counter-intuitive: two Han
 * characters carry plenty of meaning but still never match a trigram index, so a 2-character
 * Chinese query MUST take the substring path or it silently finds nothing.
 */
export const INDEX_MIN_QUERY_CHARS = 3;

/** Whether a sanitized query can use the index, or needs the unindexed substring path. */
export function canUseIndex(safeQuery: string): boolean {
	return safeQuery.length >= INDEX_MIN_QUERY_CHARS;
}
