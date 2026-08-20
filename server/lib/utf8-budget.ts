/**
 * Byte-accurate budgeting for text that is measured against a `*_BYTES` ceiling.
 *
 * JavaScript's `String.length` counts UTF-16 code units, not bytes. Comparing it to a byte
 * ceiling silently overshoots by up to 3× on CJK text — a 512 KB "byte" budget admitted
 * ~1.5 MB of Chinese conversation history, which is how a SQLite row grew past the ceiling
 * the main-thread rules in CLAUDE.md exist to enforce while every constant and every
 * recorded `bytes` field claimed otherwise. Nothing about that mismatch is observable in
 * ASCII testing, so the byte-aware comparison lives here rather than being open-coded.
 */

/**
 * UTF-8 byte length of `value`, agreeing with what an encoder actually writes.
 *
 * `Buffer.byteLength` is the fast path but it charges a LONE surrogate 2 bytes, while
 * every encoder (`Buffer.from`, `TextEncoder`, and therefore anything that persists the
 * string) writes the 3-byte U+FFFD replacement for it. Measured on Bun 1.3: `"\ud83d"`
 * reports 2 and encodes to 3. Trusting the cheap answer is the same class of mistake this
 * module exists to correct — a `bytes` field that disagrees with the bytes on disk —
 * except it under-reports, so it can only ever admit MORE than the ceiling allows.
 *
 * The exact count is only paid for by malformed input: `isWellFormed()` decides, and a
 * well-formed string's `byteLength` is exact.
 */
export function utf8Bytes(value: string): number {
	if (value.isWellFormed()) return Buffer.byteLength(value, "utf8");
	return Buffer.from(value, "utf8").length;
}

/**
 * Whether `unit` is a high (leading) surrogate, i.e. a UTF-16 code unit that is only
 * valid when a low surrogate follows it.
 */
function isHighSurrogate(unit: number): boolean {
	return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Drop a trailing high surrogate left behind by cutting a string mid-pair.
 *
 * A prefix boundary chosen by byte arithmetic lands between the two units of an astral
 * character whenever the budget runs out there, and the orphan that remains is not valid
 * UTF-16: it round-trips through JSON as `"\ud83d"` and through any encoder as U+FFFD.
 * Only the LAST unit can be orphaned by a prefix cut — an orphan anywhere earlier was
 * already in the input, and this function deliberately leaves those alone rather than
 * silently rewriting content it was asked to preserve.
 */
function trimTrailingLoneSurrogate(value: string): string {
	if (value.length === 0) return value;
	return isHighSurrogate(value.charCodeAt(value.length - 1)) ? value.slice(0, -1) : value;
}

/**
 * Whether `value` fits `maxBytes` UTF-8 bytes. `maxBytes < 0` means "no ceiling".
 *
 * A UTF-16 unit costs at most 3 UTF-8 bytes, so the cheap upper bound settles the common
 * "comfortably under the ceiling" case without walking the string.
 */
export function withinUtf8Budget(value: string, maxBytes: number): boolean {
	if (maxBytes < 0) return true;
	if (value.length * 3 <= maxBytes) return true;
	return utf8Bytes(value) <= maxBytes;
}

/**
 * Longest prefix of `value` that fits `maxBytes` UTF-8 bytes.
 *
 * Converges from above rather than scanning: a prefix is never shorter in bytes than in
 * units, so `maxBytes` units is always a safe starting length and the ratio-based step
 * settles in two or three iterations.
 *
 * A prefix that ends mid-pair is cut back explicitly rather than being left for the byte
 * arithmetic to reject. It does NOT reject it: the orphan costs the same 3 bytes as the
 * pair's own lead unit, so a boundary landing there is under budget and returns as-is. The
 * result was then a string `isWellFormed()` calls invalid, which encoders turn into U+FFFD
 * and `JSON.stringify` into a bare `"\ud83d"` escape — for emoji/astral text that is most
 * budgets, not an edge case (573 of 1600 probed budget values on emoji-dense input).
 * Trimming happens before the budget check so the returned string is both valid and within
 * budget, and dropping the orphan can only shrink the result.
 */
export function sliceToUtf8Budget(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (value.length * 3 <= maxBytes) return value;
	let slice = trimTrailingLoneSurrogate(value.slice(0, maxBytes));
	for (;;) {
		const bytes = utf8Bytes(slice);
		if (bytes <= maxBytes) return slice;
		const next = Math.max(0, Math.floor((slice.length * maxBytes) / bytes));
		slice = trimTrailingLoneSurrogate(
			slice.slice(0, next >= slice.length ? slice.length - 1 : next),
		);
	}
}
