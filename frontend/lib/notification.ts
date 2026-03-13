/**
 * Notification dispatcher — triggers PWA and sound notifications
 * based on user preferences. DingTalk/Feishu are handled server-side.
 */

import { type NotificationSoundPrefs, playNotificationSound } from "./notification-sound";

export interface NotificationPrefs extends NotificationSoundPrefs {
	notifyOnDone: boolean;
	notifyOnWaiting: boolean;
	notifyPwaEnabled: boolean;
	notifySoundEnabled: boolean;
}

/**
 * Trigger client-side notifications (PWA + sound) for a narrator status change.
 * Called from RecentTabsWSProvider when a subscribed narrator changes to done/waiting.
 */
export function triggerNotification(
	_narratorId: string,
	narratorTitle: string,
	status: "done" | "waiting",
	prefs: NotificationPrefs,
): void {
	// Check per-status toggle
	if (status === "done" && !prefs.notifyOnDone) return;
	if (status === "waiting" && !prefs.notifyOnWaiting) return;

	// PWA browser notification — only when page is not focused
	if (
		prefs.notifyPwaEnabled &&
		!document.hasFocus() &&
		"Notification" in window &&
		Notification.permission === "granted"
	) {
		const body =
			status === "done"
				? `${narratorTitle} has finished`
				: `${narratorTitle} is waiting for permission`;
		try {
			new Notification("NarraFork", {
				body,
				icon: "/pwa-192x192.png",
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
