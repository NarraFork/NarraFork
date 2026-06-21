/**
 * @mention parsing for named narrators.
 *
 * A mention is `@handle` where handle matches the named-narrator handle rules
 * (starts with a letter/digit, then letters/digits/_/-, length 2-32). Matching
 * is case-insensitive; extracted handles are normalized to lowercase and
 * de-duplicated while preserving first-seen order.
 *
 * To avoid false positives we require the `@` to be at the start of the string
 * or preceded by whitespace or a common boundary char — so email addresses
 * (`user@example.com`) and decorators do not trigger mentions.
 */

const MENTION_RE = /(^|[\s(,:;!?])@([a-z0-9][a-z0-9_-]{1,31})\b/gi;

export function extractMentions(text: string): string[] {
	if (!text || text.indexOf("@") === -1) return [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const match of text.matchAll(MENTION_RE)) {
		const handle = match[2]?.toLowerCase();
		if (handle && !seen.has(handle)) {
			seen.add(handle);
			result.push(handle);
		}
	}
	return result;
}

export function hasMention(text: string): boolean {
	return extractMentions(text).length > 0;
}
