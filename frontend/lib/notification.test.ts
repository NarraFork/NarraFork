import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	clearNotifiedAttention,
	type NotificationPrefs,
	triggerNotification,
} from "./notification";

// Exercises the generation-aware notification dedup. We drive notifications
// through the PWA path (sound off) and count Notification constructions, which
// is the observable side effect of a notification actually firing.

const g = globalThis as typeof globalThis & {
	document?: { hasFocus: () => boolean };
	window?: unknown;
	Notification?: unknown;
};

let constructed = 0;

const prefs: NotificationPrefs = {
	notifyOnDone: true,
	notifyOnWaiting: true,
	notifyPwaEnabled: true,
	notifySoundEnabled: false,
	// notification-sound fields are unused when sound is disabled
} as NotificationPrefs;

function installBrowserGlobals() {
	class FakeNotification {
		static permission = "granted";
		constructor() {
			constructed += 1;
		}
	}
	Object.defineProperty(g, "Notification", { value: FakeNotification, configurable: true });
	// `"Notification" in window` must be true, and hasFocus() false so PWA fires.
	Object.defineProperty(g, "window", {
		value: { Notification: FakeNotification },
		configurable: true,
	});
	Object.defineProperty(g, "document", { value: { hasFocus: () => false }, configurable: true });
}

describe("triggerNotification dedup", () => {
	const originalDocument = g.document;
	const originalWindow = g.window;
	const originalNotification = g.Notification;

	beforeEach(() => {
		constructed = 0;
		clearNotifiedAttention();
		installBrowserGlobals();
	});

	afterEach(() => {
		clearNotifiedAttention();
		if (originalDocument === undefined) Reflect.deleteProperty(g, "document");
		else Object.defineProperty(g, "document", { value: originalDocument, configurable: true });
		if (originalWindow === undefined) Reflect.deleteProperty(g, "window");
		else Object.defineProperty(g, "window", { value: originalWindow, configurable: true });
		if (originalNotification === undefined) Reflect.deleteProperty(g, "Notification");
		else
			Object.defineProperty(g, "Notification", {
				value: originalNotification,
				configurable: true,
			});
	});

	test("suppresses a repeated snapshot of the same generation", () => {
		triggerNotification("n1", "Title", "unread", prefs, "gen-1");
		triggerNotification("n1", "Title", "unread", prefs, "gen-1");
		expect(constructed).toBe(1);
	});

	test("notifies again when a new generation completes (e.g. after a disconnect)", () => {
		triggerNotification("n1", "Title", "unread", prefs, "gen-1");
		triggerNotification("n1", "Title", "unread", prefs, "gen-2");
		expect(constructed).toBe(2);
	});

	test("clearNotifiedAttention lets the same generation notify again", () => {
		triggerNotification("n1", "Title", "unread", prefs, "gen-1");
		clearNotifiedAttention("n1");
		triggerNotification("n1", "Title", "unread", prefs, "gen-1");
		expect(constructed).toBe(2);
	});

	test("without a generation, falls back to per-state dedup", () => {
		triggerNotification("n2", "Title", "unread", prefs);
		triggerNotification("n2", "Title", "unread", prefs);
		expect(constructed).toBe(1);
	});

	test("distinct narrators are tracked independently", () => {
		triggerNotification("a", "A", "unread", prefs, "gen-1");
		triggerNotification("b", "B", "unread", prefs, "gen-1");
		expect(constructed).toBe(2);
	});
});
