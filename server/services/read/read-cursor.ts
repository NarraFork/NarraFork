/**
 * Opaque list cursors, shared by both read adapters.
 *
 * A cursor is a keyset position — a sort value plus the row id that breaks its ties —
 * rather than an offset, because every list here is ACL-filtered and rows appear and
 * disappear between pages: an offset would skip or repeat rows exactly when the set is
 * changing. The id tiebreak is not optional: `projects.updatedAt` and
 * `chapters.createdAt` are genuinely shared by many rows (a bulk import gives every row
 * the same timestamp), and a cursor on the timestamp alone would either loop forever on
 * that group or jump over the rest of it.
 *
 * The encoding lives here rather than in each adapter so PostgreSQL and SQLite emit
 * byte-identical cursors for the same position. That is what lets the parity suite
 * compare cursor STRINGS: two backends that resume at different rows are then a visible
 * difference instead of a divergence discovered pages later.
 *
 * ## What makes a cursor portable, and the one condition it rests on
 *
 * Identical ENCODING is not by itself identical MEANING. A cursor says "resume after this
 * (sort, id)", and which rows that excludes depends on how the backend compares text. The
 * two do not agree by default:
 *
 *   - SQLite compares `text` with its BINARY collation — byte order — and offers no locale
 *     alternative;
 *   - PostgreSQL uses the database collation. On the official `postgres:17` image that is
 *     glibc `en_US.utf8`, which orders case-insensitively at the primary level and
 *     interleaves case. `'Zed' < 'abc'` is TRUE in byte order and FALSE under it.
 *
 * Ids come from `nanoid`, whose alphabet mixes upper and lower case, so real data always
 * straddles that divergence. Every sort key and tiebreak in both adapters is therefore
 * pinned to byte order: SQLite has it inherently, and the PostgreSQL adapter states it with
 * `COLLATE "C"` on the ORDER BY and the keyset comparison together (see `byteOrder` in
 * `postgres-project-read-adapter.ts`). Under that condition — and only under it — the same
 * cursor string denotes the same position on both backends, and a truncated read keeps the
 * same rows.
 *
 * Note what would silently break this: the musl-based `postgres:17-alpine` image degenerates
 * `en_US.utf8` to byte order, so a suite that only runs Alpine sees the two backends agree
 * for a reason that does not hold on a glibc deployment. The parity matrix runs both images
 * for exactly that reason.
 *
 * ## The boundary this contract draws
 *
 * Byte order is right for these keys because they are machine identifiers and ISO-8601
 * timestamps: nobody reads a page of them expecting locale-aware sequence, and byte order is
 * the only rule both backends can express. It is NOT right for a human-facing ordering. If a
 * list is ever sorted by something a person reads in order — a project or chapter name — that
 * key must not be forced to `COLLATE "C"` (byte order would file `Zebra` before `apple`);
 * such a list needs a locale-aware order, which SQLite cannot reproduce, and its cursor stops
 * being portable across backends. That is a real trade-off, not an oversight, and it has to
 * be decided per sort key rather than half-applied: a cursor is portable only if EVERY key it
 * carries is.
 *
 * Malformed input decodes to `null`, meaning "start from the beginning". It must never
 * throw: the value arrives from a query string, so a truncated or hand-edited cursor is
 * an ordinary event, and it must not become a 500 or — worse — a silently dropped WHERE
 * clause that widens the result set.
 */

export interface SortCursor {
	/**
	 * The leading sort value (a timestamp string in every current caller).
	 *
	 * Compared in BYTE ORDER by both backends. A caller that introduces a sort key needing
	 * locale-aware comparison cannot reuse this cursor across backends — see the module
	 * docblock.
	 */
	sort: string;
	/** The tiebreak id of the last row already delivered, also compared in byte order. */
	id: string;
}

/**
 * Encode a position. `field` names the sort column in the payload (`updatedAt` for
 * projects, `createdAt` for chapters) so a cursor cannot be replayed against a list
 * ordered by a different column and silently resume in the wrong place.
 */
export function encodeSortCursor(field: string, sort: string, id: string): string {
	return Buffer.from(JSON.stringify({ [field]: sort, id })).toString("base64url");
}

/** Decode a position, or `null` for absent/unreadable/wrong-field input. */
export function decodeSortCursor(field: string, value?: string): SortCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
			string,
			unknown
		>;
		const sort = parsed?.[field];
		const id = parsed?.id;
		if (typeof sort !== "string" || typeof id !== "string") return null;
		return { sort, id };
	} catch {
		return null;
	}
}
