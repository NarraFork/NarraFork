/**
 * Recheck messages queued while a narrator's context was being compacted.
 *
 * A compacting narrator can be perfectly idle — `isNarratorRuntimeBusy` is false and
 * no agent loop exists — yet starting a turn right then would run it against the
 * history the compact is about to replace (a compact resets the upstream session).
 * So user input queues instead, and mailbox wakes for task notices / agent messages
 * are also deferred until the compact lock is released.
 *
 * No live loop owns that idle-during-compaction window. Recheck on every compact exit,
 * not just the successful one: a failed, cancelled or timed-out compact leaves the same
 * queue behind, and skipping those paths would strand work until another wake.
 *
 * Best-effort by construction: existing user input keeps its locale-aware consumer;
 * otherwise the unified mailbox wake rechecks eligibility without bypassing execution
 * ownership, busy/stop guards or principal requirements.
 */

import { getUserLanguage, getUserReplyInLanguage } from "../lib/i18n";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { getBufferedMessages } from "./narrator-buffer";

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
	const createdBy = getBufferedMessages(narratorId)?.[0]?.createdBy;
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
 * Recheck queued work after the compact lock is released, including failure,
 * cancellation and watchdog timeouts. Empty / ineligible mailboxes do not start a turn.
 */
export async function drainQueuedMessagesAfterCompact(narratorId: string): Promise<void> {
	try {
		if ((getBufferedMessages(narratorId)?.length ?? 0) === 0) {
			const { wakeInboxIfEligible } = await import("./agent-runtime/inbox");
			await wakeInboxIfEligible(narratorId);
			return;
		}
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
