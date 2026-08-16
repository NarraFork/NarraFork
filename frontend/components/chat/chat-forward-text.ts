/**
 * chat-forward-text.ts — Turn selected chat messages into the text a narrator
 * receives.
 *
 * Pure, and separate from the view, because the exact shape matters: this string
 * becomes a real user message in the narrator's context, so it has to say WHO
 * said WHAT without looking like the operator's own instruction.
 *
 * Format decisions:
 *  - Markdown blockquote per message, so the narrator reads it as quoted material
 *    rather than as a directive addressed to it.
 *  - Author and timestamp on the quote's first line — a transcript without
 *    attribution is worse than useless when several people disagree in it.
 *  - Deleted messages are dropped, not rendered as empty quotes.
 *  - A total cap, because a selection is unbounded while a useful forward is not.
 */

import type { ChatMessage } from "../../lib/api/chat";
import { formatLocaleDateTime } from "../../lib/intl-format";

/** Ceiling on the assembled forward text. */
export const CHAT_FORWARD_MAX_CHARS = 12_000;
/** Ceiling per message, so one huge message cannot consume the whole budget. */
export const CHAT_FORWARD_PER_MESSAGE_MAX_CHARS = 2_000;

function formatTimestamp(iso: string): string {
	// Via intl-format so the transcript's timestamps read in the app's language, which
	// is also the language the narrator is being addressed in.
	return formatLocaleDateTime(iso);
}

/** Prefix every line so a multi-line body stays inside the blockquote. */
function quoteLines(text: string): string {
	return text
		.split("\n")
		.map((line) => (line.trim() ? `> ${line}` : ">"))
		.join("\n");
}

/**
 * Assemble the forward text for a selection (already in conversation order).
 *
 * Returns "" when nothing quotable remains, so the caller can skip sending
 * instead of posting an empty message.
 */
export function buildForwardText(messages: readonly ChatMessage[]): string {
	const blocks: string[] = [];
	let budget = CHAT_FORWARD_MAX_CHARS;

	for (const message of messages) {
		if (budget <= 0) break;
		if (message.deletedAt) continue;
		const body = message.contentText.trim();
		if (!body) continue;

		const clipped =
			body.length > CHAT_FORWARD_PER_MESSAGE_MAX_CHARS
				? `${body.slice(0, CHAT_FORWARD_PER_MESSAGE_MAX_CHARS)}…`
				: body;
		const author = message.sender?.username ?? "unknown";
		const timestamp = formatTimestamp(message.createdAt);
		const header = timestamp ? `**${author}** · ${timestamp}` : `**${author}**`;
		const block = `> ${header}\n${quoteLines(clipped)}`;

		if (block.length > budget) {
			blocks.push(block.slice(0, budget));
			budget = 0;
			break;
		}
		blocks.push(block);
		budget -= block.length;
	}

	return blocks.join("\n\n");
}
