/**
 * @mention parsing for named narrators.
 *
 * A mention is `@handle` where handle matches the named-narrator handle rules
 * (Unicode letters incl. CJK / digits / _ / -, starting with a letter or digit,
 * length 2-32). Matching is case-insensitive.
 *
 * CJK has no word separators, so `@小明帮我看看` cannot be tokenized from the
 * text alone. The authoritative parse therefore resolves against the set of
 * REGISTERED handles using longest-match — see
 * `extractMentionsWithCandidates` in `@shared/narrator-handle`, which the chat
 * group service calls with the current named-narrator handle set.
 *
 * `hasMention` here is only a CHEAP existence gate (does the text plausibly
 * contain a mention?) used to short-circuit before loading the candidate set.
 * It must stay Unicode-aware so `@小明` / `@Bob` are not dropped before the real
 * parse runs.
 */

import { hasMentionLike } from "@shared/narrator-handle";

/**
 * Cheap, candidate-free check: does the text plausibly contain an @mention?
 * Unicode-aware (accepts CJK + mixed-case handles). Over-accepts on purpose;
 * the candidate-based parser decides which mentions actually resolve.
 */
export function hasMention(text: string): boolean {
	return hasMentionLike(text);
}
