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
 *  - REPLY RELATIONSHIPS are stated explicitly. A flat list of utterances loses who
 *    was answering whom, which is precisely the information that decides whether two
 *    lines agree or contradict. Taken from the stored snapshot, so a quoted message
 *    outside the selection still names its author and content without a second fetch.
 *  - Deleted messages are dropped, not rendered as empty quotes.
 *  - Attachments are named by PATH (appended as an `<attached_files>` hint produced
 *    server-side), not inlined: the model reads them with the Read tool, which is the
 *    same contract a natively attached file has.
 *  - A total cap, because a selection is unbounded while a useful forward is not.
 */

import type { ChatMessage } from "../../lib/api/chat";
import { formatLocaleDateTime } from "../../lib/intl-format";

/** Ceiling on the assembled forward text. */
export const CHAT_FORWARD_MAX_CHARS = 12_000;
/** Ceiling per message, so one huge message cannot consume the whole budget. */
export const CHAT_FORWARD_PER_MESSAGE_MAX_CHARS = 2_000;
/**
 * Ceiling on the quoted-context line.
 *
 * Much smaller than the message budget: the reply line exists to identify WHICH
 * message is being answered, not to reproduce it. The snapshot is already truncated
 * server-side, so this only bites on legacy rows resolved locally.
 */
export const CHAT_FORWARD_REPLY_MAX_CHARS = 160;

/** Joins two message blocks. Its length is charged against the budget. */
const BLOCK_SEPARATOR = "\n\n";

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
 * The "in reply to …" line for one message, or "" when it is not a reply.
 *
 * Reads the stored snapshot only. Resolving against the selection instead would give
 * a different transcript depending on what the user happened to select, and would say
 * nothing at all for the normal case of replying to something further back.
 */
function replyContextLine(message: ChatMessage): string {
	if (!message.replyToMessageId) return "";
	const author = message.replyToSender?.username ?? "unknown";
	if (message.replyToPreview == null) {
		// Legacy row: the relationship is known, the content is not. Saying so is more
		// useful than omitting the line, because it still tells the model this message
		// is an answer rather than a fresh point.
		return `> ↪ in reply to **${author}**\n`;
	}
	if (!message.replyToPreview) {
		return `> ↪ in reply to **${author}** (message deleted)\n`;
	}
	const flat = message.replyToPreview.replace(/\s+/g, " ").trim();
	const clipped =
		flat.length > CHAT_FORWARD_REPLY_MAX_CHARS
			? `${flat.slice(0, CHAT_FORWARD_REPLY_MAX_CHARS)}…`
			: flat;
	return `> ↪ in reply to **${author}**: "${clipped}"\n`;
}

export interface BuildForwardTextOptions {
	/**
	 * `<attached_files>` block appended after the transcript.
	 *
	 * Produced server-side by `buildAttachedFilesHint` (via
	 * `POST /chat/rooms/:id/materialize-attachments`), so the wording is identical to
	 * a natively attached file's and the paths are real files in the narrator's
	 * worktree. Appended AFTER the quotes and outside the per-message budget: it is
	 * instruction-carrying content, so truncating it would leave the model with a
	 * partial path list it might try to read.
	 */
	attachmentHint?: string;
}

/**
 * Assemble the forward text for a selection (already in conversation order).
 *
 * Returns "" when nothing quotable remains AND there is no attachment hint, so the
 * caller can skip sending instead of posting an empty message. An
 * attachment-only forward is legitimate: the files are the content.
 */
export function buildForwardText(
	messages: readonly ChatMessage[],
	options: BuildForwardTextOptions = {},
): string {
	const blocks: string[] = [];
	let budget = CHAT_FORWARD_MAX_CHARS;

	for (const message of messages) {
		if (budget <= 0) break;
		// The separator that will join this block to the previous one is charged too.
		// Without it the budget tracks only block lengths while the returned string also
		// contains `2 × (blocks - 1)` separator characters, so a long selection overruns
		// CHAT_FORWARD_MAX_CHARS by an amount that grows with the message COUNT — the
		// cap silently stops being a cap exactly when it matters.
		if (blocks.length > 0) budget -= BLOCK_SEPARATOR.length;
		if (budget <= 0) break;
		if (message.deletedAt) continue;
		const body = message.contentText.trim();
		// An attachment-only message has no body but is not nothing: naming its files
		// keeps the transcript aligned with the hint block below, which would otherwise
		// list paths no quoted line accounts for.
		const attachmentNames = message.attachments.map((attachment) => attachment.filename);
		if (!body && attachmentNames.length === 0) continue;

		const clipped =
			body.length > CHAT_FORWARD_PER_MESSAGE_MAX_CHARS
				? `${body.slice(0, CHAT_FORWARD_PER_MESSAGE_MAX_CHARS)}…`
				: body;
		const author = message.sender?.username ?? "unknown";
		const timestamp = formatTimestamp(message.createdAt);
		const header = timestamp ? `**${author}** · ${timestamp}` : `**${author}**`;
		const attachmentLine = attachmentNames.length > 0 ? `> 📎 ${attachmentNames.join(", ")}\n` : "";
		const bodyPart = clipped ? quoteLines(clipped) : ">";
		const block = `> ${header}\n${replyContextLine(message)}${attachmentLine}${bodyPart}`;

		if (block.length > budget) {
			blocks.push(block.slice(0, budget));
			budget = 0;
			break;
		}
		blocks.push(block);
		budget -= block.length;
	}

	const transcript = blocks.join(BLOCK_SEPARATOR);
	const hint = options.attachmentHint?.trim();
	if (!hint) return transcript;
	return transcript ? `${transcript}\n${hint}` : hint;
}
