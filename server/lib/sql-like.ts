/**
 * Free-text needle → safe `LIKE` operand.
 *
 * Every caller pairs the result with `ESCAPE '\'`. Without the escaping a `%`
 * typed into a search box silently widens the match beyond what was asked for
 * (and `_` matches any character, which reads as a false positive); without the
 * length cap a pathological needle makes the per-row comparison expensive on a
 * filter that is already known to scan.
 */
export function escapeLikeNeedle(
	value: string | null | undefined,
	maxLength = 200,
): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return trimmed.slice(0, maxLength).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
