/**
 * Notification dispatcher — triggers PWA and sound notifications
 * based on user preferences. DingTalk/Feishu are handled server-side.
 */

import { brandNotificationIconUrl, getCurrentBranding } from "./branding";
import { clearFaviconAlert, setFaviconAlert } from "./favicon";
import { type NotificationSoundPrefs, playNotificationSound } from "./notification-sound";

export interface NotificationPrefs extends NotificationSoundPrefs {
	notifyOnDone: boolean;
	notifyOnWaiting: boolean;
	notifyPwaEnabled: boolean;
	notifySoundEnabled: boolean;
}

// Tracks the last attention we already notified for, keyed by narrator, as a
// composite of the attention state and the execution generation (turnStartedAt)
// that produced it. The server re-emits an idempotent status snapshot whenever
// the client (re)subscribes to a narrator — e.g. when switching to its page —
// which would otherwise replay the sound/PWA notification for an attention the
// user has already been alerted about. Keying on the generation means a
// resubscribe snapshot for the SAME turn is suppressed, while a NEW turn that
// completed (e.g. a background/continue run finishing during a disconnect) still
// notifies because its generation differs. We also reset via
// clearNotifiedAttention() when the narrator resolves that state.
const lastNotifiedAttention = new Map<string, string>();

/** Build the dedup key: attention state + execution generation (if known). */
function attentionKey(
	status: "unread" | "waiting" | "awaited_question",
	generation?: string,
): string {
	return generation ? `${status}:${generation}` : status;
}

/**
 * Forget the last-notified attention for a narrator so its next entry into an
 * attention state notifies again. Call this when the narrator resolves the
 * attention (e.g. transitions back to working/idle, or the user reads it).
 */
export function clearNotifiedAttention(narratorId?: string): void {
	if (narratorId === undefined) lastNotifiedAttention.clear();
	else lastNotifiedAttention.delete(narratorId);
}

/**
 * Async-question attention is independent of narrator status and of other questions.
 * A decision may arrive without await_ended, and must clear ONLY this question's
 * favicon/dedup entry, never a concurrent permission, unread output or another wait.
 */
export function updateAsyncQuestionAttention(
	narratorId: string,
	questionId: string | undefined,
	awaited: boolean,
	narratorTitle?: string,
	prefs?: NotificationPrefs,
): void {
	if (!questionId) return;
	const attentionId = `async-question:${narratorId}:${questionId}`;
	if (!awaited) {
		clearNotifiedAttention(attentionId);
		clearFaviconAlert(attentionId);
		return;
	}
	setFaviconAlert(attentionId, "waiting");
	if (prefs && narratorTitle) {
		triggerNotification(attentionId, narratorTitle, "awaited_question", prefs, questionId);
	}
}

/**
 * Trigger client-side notifications (PWA + sound) for a narrator status change.
 * Called from RecentTabsWSProvider when a subscribed narrator changes to done/waiting.
 *
 * `generation` is the turnStartedAt of the turn that produced this attention.
 * When present it distinguishes a genuinely new completion from an idempotent
 * resubscribe snapshot of the same turn.
 */
export function triggerNotification(
	narratorId: string,
	narratorTitle: string,
	/**
	 * `awaited_question` is an async question the agent is now BLOCKED on via `Await`.
	 *
	 * It rides the `notifyOnWaiting` preference rather than one of its own: from the
	 * user's side the situation is identical to a permission prompt (the session has
	 * stopped and needs them), so somebody who turned that preference off has already
	 * said they do not want to be alerted about a stalled session.
	 *
	 * It is a distinct value only because the notification BODY differs — "waiting for
	 * permission" would misdescribe it, and the whole point of this channel is telling
	 * the user what is wanted without opening the app.
	 */
	status: "unread" | "waiting" | "awaited_question",
	prefs: NotificationPrefs,
	generation?: string,
): void {
	// Deduplicate: skip when we've already notified for this exact attention
	// (state + generation). Guards against idempotent status re-emits on
	// (re)subscribe, which happen every time the user opens/switches to the page.
	const key = attentionKey(status, generation);
	if (lastNotifiedAttention.get(narratorId) === key) return;

	// Check per-status toggle
	if (status === "unread" && !prefs.notifyOnDone) return;
	if ((status === "waiting" || status === "awaited_question") && !prefs.notifyOnWaiting) return;

	// Record only states we actually notify for, so a disabled toggle doesn't
	// mask a later genuine transition once the toggle is re-enabled.
	lastNotifiedAttention.set(narratorId, key);

	// PWA browser notification — only when page is not focused
	if (
		prefs.notifyPwaEnabled &&
		!document.hasFocus() &&
		"Notification" in window &&
		Notification.permission === "granted"
	) {
		const body =
			status === "unread"
				? `${narratorTitle} has finished`
				: status === "awaited_question"
					? `${narratorTitle} stopped and is waiting for your answer`
					: `${narratorTitle} is waiting for permission`;
		try {
			// Title and icon follow the instance branding. This matters more here than
			// anywhere else in the app: a desktop notification fires precisely when the
			// window is NOT focused, so with a fixed "NarraFork" title the user cannot
			// tell which of several instances is asking for them.
			//
			// The tag stays instance-agnostic on purpose — it deduplicates within one
			// origin, and two instances are two origins.
			new Notification(getCurrentBranding().name, {
				body,
				icon: brandNotificationIconUrl(),
				tag: `narrator-${status}`,
			});
		} catch {
			// Notification constructor can fail in some contexts
		}
	}

	// Sound notification
	if (prefs.notifySoundEnabled) {
		playNotificationSound(prefs);
	}
}
