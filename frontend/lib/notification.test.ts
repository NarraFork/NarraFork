import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearFaviconAlert, setFaviconAlert } from "./favicon";
import {
	clearNotifiedAttention,
	type NotificationPrefs,
	triggerNotification,
	updateAsyncQuestionAttention,
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
const favicon = { href: "/favicon.svg" };

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
		value: { Notification: FakeNotification, addEventListener() {} },
		configurable: true,
	});
	Object.defineProperty(g, "document", {
		value: {
			hasFocus: () => false,
			visibilityState: "hidden",
			querySelector: () => favicon,
			addEventListener() {},
		},
		configurable: true,
	});
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
		clearFaviconAlert();
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

	test("ending a question clears its favicon and re-arms its notification dedup", () => {
		updateAsyncQuestionAttention("n1", "q1", true, "Title", prefs);
		updateAsyncQuestionAttention("n1", "q1", true, "Title", prefs);
		expect(constructed).toBe(1);
		expect(decodeURIComponent(favicon.href)).toContain("#fab005");
		updateAsyncQuestionAttention("n1", "q1", false);
		expect(favicon.href.startsWith("data:image/svg+xml")).toBe(false);
		updateAsyncQuestionAttention("n1", "q1", true, "Title", prefs);
		expect(constructed).toBe(2);
	});

	test("a decision preserves a concurrent permission's favicon and notification dedup", () => {
		setFaviconAlert("n1", "waiting");
		triggerNotification("n1", "Title", "waiting", prefs, "turn-1");
		updateAsyncQuestionAttention("n1", "q1", true, "Title", prefs);
		updateAsyncQuestionAttention("n1", "q1", false);
		expect(decodeURIComponent(favicon.href)).toContain("#fab005");
		triggerNotification("n1", "Title", "waiting", prefs, "turn-1");
		expect(constructed).toBe(2);
	});

	test("one question ending cannot clear another question or unread output", () => {
		setFaviconAlert("n1", "unread");
		updateAsyncQuestionAttention("n1", "q1", true);
		updateAsyncQuestionAttention("n1", "q2", true);
		updateAsyncQuestionAttention("n1", "q1", false);
		expect(decodeURIComponent(favicon.href)).toContain("#fab005");
		updateAsyncQuestionAttention("n1", "q2", false);
		expect(decodeURIComponent(favicon.href)).toContain("#40c057");
	});

	test("question favicon cleanup does not depend on notification preferences", () => {
		updateAsyncQuestionAttention("n1", "q1", true, "Title", { ...prefs, notifyOnWaiting: false });
		expect(constructed).toBe(0);
		expect(decodeURIComponent(favicon.href)).toContain("#fab005");
		updateAsyncQuestionAttention("n1", "q1", false);
		expect(favicon.href.startsWith("data:image/svg+xml")).toBe(false);
	});

	test("distinct narrators are tracked independently", () => {
		triggerNotification("a", "A", "unread", prefs, "gen-1");
		triggerNotification("b", "B", "unread", prefs, "gen-1");
		expect(constructed).toBe(2);
	});
});
