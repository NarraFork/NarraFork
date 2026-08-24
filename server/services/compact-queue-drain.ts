/**
 * Consume messages a user queued while a narrator's context was being compacted.
 *
 * A compacting narrator can be perfectly idle — `isNarratorRuntimeBusy` is false and
 * no agent loop exists — yet starting a turn right then would run it against the
 * history the compact is about to replace (a compact resets the upstream session).
 * So `POST /:id/messages` queues instead, and that queue needs an owner.
 *
 * Every other queue producer is paired with a live loop that drains the buffer at its
 * next safe boundary. Nothing plays that role here, so this sweep is the SOLE consumer
 * for the idle-during-compaction window. It must therefore run on every compact exit,
 * not just the successful one: a failed, cancelled or timed-out compact leaves the same
 * queue behind, and skipping those paths would strand the message until the user
 * happened to send another one.
 *
 * Best-effort by construction: `resumeBufferedMessagesIfIdle` declines whenever another
 * owner exists or the narrator must not be woken (plan mode, subagent, non-idle status),
 * so calling it after a compact can only ever start a turn that was already legal.
 */

import { getUserLanguage, getUserReplyInLanguage } from "../lib/i18n";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { bufferedMessages } from "./narrator-session-state";

/**
 * Resolve the locale/reply-language for the queue owner.
 *
 * The queued message carries its author (`createdBy`), which is the person whose
 * language preference the resumed turn should use. Falling back to `en` matters less
 * than not failing: a system-queued message has no author, and a missing preference
 * must not stop the message from being delivered.
 */
async function resolveQueueOwnerLocale(
	narratorId: string,
): Promise<{ locale: Locale; replyInUserLanguage: boolean }> {
	const createdBy = bufferedMessages.get(narratorId)?.[0]?.createdBy;
	if (!createdBy) return { locale: "en", replyInUserLanguage: false };
	try {
		const [locale, replyInUserLanguage] = await Promise.all([
			getUserLanguage(createdBy),
			getUserReplyInLanguage(createdBy),
		]);
		return { locale, replyInUserLanguage };
	} catch (error) {
		logger.warn("Failed to resolve locale for a message queued during compaction", {
			narratorId,
			error: error instanceof Error ? error.message : String(error),
		});
		return { locale: "en", replyInUserLanguage: false };
	}
}

/**
 * Start a turn for whatever the user queued while this narrator was compacting.
 *
 * Called from the compact lock's release path, so it covers success, failure,
 * cancellation and watchdog timeouts alike. A no-op when the queue is empty, which is
 * the overwhelmingly common case — the check is a map lookup, so it stays free for
 * every compact that nobody typed into.
 */
export async function drainQueuedMessagesAfterCompact(narratorId: string): Promise<void> {
	if ((bufferedMessages.get(narratorId)?.length ?? 0) === 0) return;
	try {
		const { locale, replyInUserLanguage } = await resolveQueueOwnerLocale(narratorId);
		const { resumeBufferedMessagesIfIdle } = await import("./narrator-session");
		await resumeBufferedMessagesIfIdle(narratorId, locale, replyInUserLanguage);
	} catch (error) {
		logger.warn("Failed to resume messages queued during compaction", {
			narratorId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
