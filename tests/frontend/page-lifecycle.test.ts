/**
 * page-lifecycle.test.ts — the lifecycle signals the WS managers depend on.
 *
 * The point of this module is that `visibilitychange` alone misses the two cases
 * that actually drop a WebSocket: entering the back/forward cache and being
 * frozen. Each event is dispatched in isolation here, because in a real browser
 * they genuinely arrive alone (iOS Safari sends `pagehide` with no
 * `visibilitychange`), and a handler that only works when they arrive together
 * would still lose the connection.
 */

import { describe, expect, it } from "bun:test";
import { observePageLifecycle, type PageLifecycleTarget } from "../../frontend/lib/page-lifecycle";

/**
 * A minimal listener registry standing in for `window` / `document`.
 *
 * Deliberately NOT a real `EventTarget`: other suites in this project install a
 * DOM shim that replaces the global `Event` constructor, and
 * `EventTarget.dispatchEvent` then rejects those instances. Dispatching plain
 * objects here keeps this test independent of whichever realm ran first, and the
 * module under test only ever reads `type` and `persisted`.
 */
class FakeEventTarget {
	private listeners = new Map<string, Set<(event: unknown) => void>>();
	visibilityState: DocumentVisibilityState = "visible";

	addEventListener(type: string, listener: (event: unknown) => void): void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}

	removeEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	dispatchEvent(event: { type: string; persisted?: boolean }): void {
		for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
	}
}

interface Harness {
	windowTarget: FakeEventTarget;
	documentTarget: FakeEventTarget;
	hidden: Array<{ persisted: boolean }>;
	restored: number;
	foreground: number;
	dispose: () => void;
}

function harness(): Harness {
	const windowTarget = new FakeEventTarget();
	const documentTarget = new FakeEventTarget();
	const state = {
		hidden: [] as Array<{ persisted: boolean }>,
		restored: 0,
		foreground: 0,
	};
	const dispose = observePageLifecycle(
		{
			onHidden: (info) => state.hidden.push(info),
			onRestoredFromCache: () => {
				state.restored++;
			},
			onForeground: () => {
				state.foreground++;
			},
		},
		{
			window: windowTarget as unknown as PageLifecycleTarget["window"],
			document: documentTarget as unknown as PageLifecycleTarget["document"],
		},
	);
	return {
		windowTarget,
		documentTarget,
		get hidden() {
			return state.hidden;
		},
		get restored() {
			return state.restored;
		},
		get foreground() {
			return state.foreground;
		},
		dispose,
	};
}

function pageTransition(
	type: "pagehide" | "pageshow",
	persisted: boolean,
): { type: string; persisted: boolean } {
	return { type, persisted };
}

describe("observePageLifecycle", () => {
	it("maps visibilitychange to hidden and foreground", () => {
		const h = harness();
		try {
			h.documentTarget.visibilityState = "hidden";
			h.documentTarget.dispatchEvent({ type: "visibilitychange" });
			expect(h.hidden).toEqual([{ persisted: false }]);
			expect(h.foreground).toBe(0);

			h.documentTarget.visibilityState = "visible";
			h.documentTarget.dispatchEvent({ type: "visibilitychange" });
			expect(h.foreground).toBe(1);
		} finally {
			h.dispose();
		}
	});

	it("reports a bfcache-bound pagehide as persisted", () => {
		const h = harness();
		try {
			h.windowTarget.dispatchEvent(pageTransition("pagehide", true));
			expect(h.hidden).toEqual([{ persisted: true }]);
			// A page that can come back is not a foreground transition.
			expect(h.foreground).toBe(0);
		} finally {
			h.dispose();
		}
	});

	it("reports a real unload as not persisted", () => {
		const h = harness();
		try {
			h.windowTarget.dispatchEvent(pageTransition("pagehide", false));
			expect(h.hidden).toEqual([{ persisted: false }]);
		} finally {
			h.dispose();
		}
	});

	it("treats freeze like a bfcache entry", () => {
		const h = harness();
		try {
			h.documentTarget.dispatchEvent({ type: "freeze" });
			expect(h.hidden).toEqual([{ persisted: true }]);
		} finally {
			h.dispose();
		}
	});

	it("reports a persisted pageshow as a discarded connection", () => {
		const h = harness();
		try {
			h.windowTarget.dispatchEvent(pageTransition("pageshow", true));
			expect(h.restored).toBe(1);
			expect(h.foreground).toBe(1);
		} finally {
			h.dispose();
		}
	});

	it("does not claim a discarded connection on a normal pageshow", () => {
		const h = harness();
		try {
			// A first load also fires pageshow (persisted: false). Treating that as a
			// discarded connection would force a reconnect on every page load.
			h.windowTarget.dispatchEvent(pageTransition("pageshow", false));
			expect(h.restored).toBe(0);
			expect(h.foreground).toBe(1);
		} finally {
			h.dispose();
		}
	});

	it("reports resume as a discarded connection", () => {
		const h = harness();
		try {
			h.documentTarget.dispatchEvent({ type: "resume" });
			expect(h.restored).toBe(1);
			expect(h.foreground).toBe(1);
		} finally {
			h.dispose();
		}
	});

	it("maps focus to foreground", () => {
		const h = harness();
		try {
			h.windowTarget.dispatchEvent({ type: "focus" });
			expect(h.foreground).toBe(1);
		} finally {
			h.dispose();
		}
	});

	it("stops delivering after dispose, and dispose is idempotent", () => {
		const h = harness();
		h.dispose();
		h.dispose();
		h.windowTarget.dispatchEvent(pageTransition("pageshow", true));
		h.windowTarget.dispatchEvent(pageTransition("pagehide", true));
		h.documentTarget.dispatchEvent({ type: "freeze" });
		h.documentTarget.dispatchEvent({ type: "resume" });
		h.windowTarget.dispatchEvent({ type: "focus" });
		expect(h.hidden).toEqual([]);
		expect(h.restored).toBe(0);
		expect(h.foreground).toBe(0);
	});

	it("is inert without a browser environment", () => {
		let called = false;
		const dispose = observePageLifecycle({ onForeground: () => (called = true) }, null);
		dispose();
		expect(called).toBe(false);
	});
});
