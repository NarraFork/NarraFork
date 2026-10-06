/**
 * vlist-pointer-drag.test.ts — The drag signal the width-settle rule depends on.
 *
 * A stuck `isDown() === true` defers width rebuilds until the 3s backstop, and a
 * missed release never fires the commit callback, so this tracker's edge cases are
 * load-bearing:
 *   - multi-touch must not report release on the FIRST finger up
 *   - `pointercancel` must count as a release (it replaces `pointerup` when the
 *     browser takes the gesture over, or the pointer leaves the window)
 *   - a host that calls stopPropagation on its sash events must not hide the
 *     gesture (hence capture-phase listeners)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { createVListResizeController } from "./vlist-live-resize";
import { createPointerDragTracker } from "./vlist-pointer-drag";
import { resolveWidthSettle, WIDTH_SETTLE_DELAY_MS } from "./vlist-width-settle";

let restore: (() => void) | undefined;

function installDom(): void {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
	const { window } = parseHTML("<!doctype html><html><body><div id=host></div></body></html>");
	Object.defineProperty(globalThis, "document", {
		value: window.document,
		configurable: true,
		writable: true,
	});
	restore = () => {
		if (previous) Object.defineProperty(globalThis, "document", previous);
		else Reflect.deleteProperty(globalThis as object, "document");
	};
}

/**
 * Dispatch a pointer- or mouse-like event (linkedom has no PointerEvent).
 *
 * `pointerId` is omitted for the MOUSE family on purpose: a real `MouseEvent` has no
 * such property, and the tracker's slot resolution depends on that absence.
 */
function fire(type: string, pointerId?: number, target?: Element): void {
	const event = document.createEvent("Event");
	event.initEvent(type, true, true);
	if (pointerId !== undefined) {
		Object.defineProperty(event, "pointerId", { value: pointerId, configurable: true });
	}
	(target ?? document.body).dispatchEvent(event);
}

beforeEach(() => {
	installDom();
});

afterEach(() => {
	restore?.();
	restore = undefined;
});

describe("createPointerDragTracker", () => {
	it("reports down between pointerdown and pointerup", () => {
		const tracker = createPointerDragTracker(() => {});
		expect(tracker.isDown()).toBe(false);
		fire("pointerdown", 1);
		expect(tracker.isDown()).toBe(true);
		fire("pointerup", 1);
		expect(tracker.isDown()).toBe(false);
		tracker.dispose();
	});

	it("calls onRelease exactly once when the pointer lifts", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => {
			releases++;
		});
		fire("pointerdown", 1);
		fire("pointerup", 1);
		expect(releases).toBe(1);
		tracker.dispose();
	});

	// A boolean flag would report "released" on the first finger up while the drag
	// is still in progress, committing a rebuild mid-gesture.
	it("stays down through a multi-touch partial release", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => {
			releases++;
		});
		fire("pointerdown", 1);
		fire("pointerdown", 2);
		fire("pointerup", 1);
		expect(tracker.isDown()).toBe(true);
		expect(releases).toBe(0);
		fire("pointerup", 2);
		expect(tracker.isDown()).toBe(false);
		expect(releases).toBe(1);
		tracker.dispose();
	});

	// Without this the id would linger and every width change would stay deferred
	// until the backstop.
	it("treats pointercancel as a release", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => {
			releases++;
		});
		fire("pointerdown", 7);
		fire("pointercancel", 7);
		expect(tracker.isDown()).toBe(false);
		expect(releases).toBe(1);
		tracker.dispose();
	});

	// Sees a gesture that originates deep in the tree (a sash inside a panel), which
	// is where every real resize starts.
	//
	// NOTE: this does NOT prove capture-phase behaviour. linkedom has no capture
	// phase — it invokes listeners in registration order and a bubble-phase
	// `stopPropagation` suppresses everything after it — so a
	// "capture beats stopPropagation" assertion here would test the harness, not the
	// code. The capture flag is verified by reading the DOM spec and dockview's
	// source (see the module comment), not by this test.
	it("sees a gesture dispatched from a nested element", () => {
		const host = document.getElementById("host");
		if (!host) throw new Error("fixture missing");
		const tracker = createPointerDragTracker(() => {});
		fire("pointerdown", 3, host);
		expect(tracker.isDown()).toBe(true);
		fire("pointerup", 3, host);
		expect(tracker.isDown()).toBe(false);
		tracker.dispose();
	});

	// Dockview ends a sash drag on `contextmenu`, so a right-click mid-drag can leave
	// the counted button without a matching pointerup. Treating it as a release keeps
	// the deferral from hanging on to the backstop.
	it("treats contextmenu as a release, clearing every counted pointer", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => {
			releases++;
		});
		fire("pointerdown", 1);
		fire("pointerdown", 2);
		fire("contextmenu");
		expect(tracker.isDown()).toBe(false);
		expect(releases).toBe(1);
		tracker.dispose();
	});

	it("ignores contextmenu when no gesture is in progress", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => {
			releases++;
		});
		fire("contextmenu");
		expect(releases).toBe(0);
		tracker.dispose();
	});

	// ── The mouse family ────────────────────────────────────────────────────────
	//
	// The app's own side nav USED to resize through mousedown/mousemove/mouseup
	// (hooks/useResizableNav.ts; pointer events since the touch fix). A pointer-only
	// tracker missed it entirely, so the drag freeze silently did not apply there —
	// reported as "dragging the side nav has no effect". The tracker must stay
	// family-agnostic against whatever the next host emits.
	it("sees a MOUSE-only drag (the mouse-only host case)", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => {
			releases++;
		});
		fire("mousedown");
		expect(tracker.isDown()).toBe(true);
		fire("mouseup");
		expect(tracker.isDown()).toBe(false);
		expect(releases).toBe(1);
		tracker.dispose();
	});

	// A physical mouse in a real browser fires pointerdown THEN mousedown. Both are
	// counted, so the release must clear both or the tracker stays stuck down.
	it("handles the real-browser sequence where both families fire", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => {
			releases++;
		});
		fire("pointerdown", 1);
		fire("mousedown");
		expect(tracker.isDown()).toBe(true);
		// Real order is pointerup then mouseup; either alone must not leave it stuck.
		fire("pointerup", 1);
		// The pointer slot went, but MOUSE_ID is still counted, so no release yet.
		expect(tracker.isDown()).toBe(true);
		expect(releases).toBe(0);
		fire("mouseup");
		expect(tracker.isDown()).toBe(false);
		// EXACTLY one: the mouseup that emptied the set is the only release. An earlier
		// version fired here more than once because the three release paths disagreed
		// about whether an already-empty set should still call back.
		expect(releases).toBe(1);
		tracker.dispose();
	});

	it("native Dockview drop releases frozen width without waiting for the 3s backstop", () => {
		let committedWidth = 900;
		let releases = 0;
		const tracker = createPointerDragTracker(() => {
			releases++;
			const decision = resolveWidthSettle({
				nextWidth: 600,
				committedWidth,
				trigger: "gesture-end",
				pointerDown: tracker.isDown(),
			});
			if (decision.commit) committedWidth = 600;
		});
		try {
			fire("pointerdown", 1);
			fire("mousedown");
			fire("dragstart");
			fire("pointercancel", 1);
			expect(tracker.isDown()).toBe(true);
			expect(releases).toBe(0);
			fire("drop");
			expect(tracker.isDown()).toBe(false);
			expect(committedWidth).toBe(600);
			expect(releases).toBe(1);
			fire("dragend");
			fire("mouseup");
			expect(releases).toBe(1);
			// Dockview's drop handler may resize AFTER capture-phase drop. Its observer
			// must see idle, not an orphaned MOUSE_ID holding this and later toggles.
			expect(
				resolveWidthSettle({
					nextWidth: 1000,
					committedWidth,
					trigger: "observer",
					pointerDown: tracker.isDown(),
				}).deferForMs,
			).toBe(WIDTH_SETTLE_DELAY_MS);
		} finally {
			tracker.dispose();
		}
	});

	it("native drag survives pointercancel even when compatibility mousedown is absent", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => releases++);
		try {
			fire("pointerdown", 4);
			fire("dragstart");
			fire("pointercancel", 4);
			expect(tracker.isDown()).toBe(true);
			expect(releases).toBe(0);
			// Cancelled/rejected native drops only emit dragend, not drop.
			fire("dragend");
			expect(tracker.isDown()).toBe(false);
			expect(releases).toBe(1);
		} finally {
			tracker.dispose();
		}
	});

	it("repeated native drags each release exactly once", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => releases++);
		try {
			for (let i = 0; i < 5; i++) {
				fire("mousedown");
				fire("dragstart");
				fire("drop");
				fire("dragend");
				expect(tracker.isDown()).toBe(false);
				expect(releases).toBe(i + 1);
			}
		} finally {
			tracker.dispose();
		}
	});

	it("window blur clears a lost release without leaking its listener after dispose", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => releases++);
		const blur = () => {
			const event = document.createEvent("Event");
			event.initEvent("blur", false, false);
			document.defaultView?.dispatchEvent(event);
		};
		try {
			fire("pointerdown", 1);
			fire("mousedown");
			blur();
			expect(tracker.isDown()).toBe(false);
			expect(releases).toBe(1);
			fire("dragstart");
			tracker.dispose();
			blur();
			fire("dragstart");
			fire("drop");
			fire("dragend");
			expect(tracker.isDown()).toBe(false);
			expect(releases).toBe(1);
		} finally {
			tracker.dispose();
		}
	});

	// The order above, reversed — some environments deliver mouseup first.
	it("does not get stuck when mouseup arrives before pointerup", () => {
		const tracker = createPointerDragTracker(() => {});
		fire("pointerdown", 1);
		fire("mousedown");
		fire("mouseup");
		// mouseup is the last event of a mouse sequence, so nothing may remain held.
		expect(tracker.isDown()).toBe(false);
		tracker.dispose();
	});

	it("ignores a mouseup with no gesture in progress", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => {
			releases++;
		});
		fire("mouseup");
		expect(releases).toBe(0);
		expect(tracker.isDown()).toBe(false);
		tracker.dispose();
	});

	// A touch drag must not be cancelled by a stray mouse event from elsewhere.
	it("keeps a multi-touch gesture held across its partial releases", () => {
		const tracker = createPointerDragTracker(() => {});
		fire("pointerdown", 2);
		fire("pointerdown", 3);
		fire("pointerup", 2);
		expect(tracker.isDown()).toBe(true);
		fire("pointerup", 3);
		expect(tracker.isDown()).toBe(false);
		tracker.dispose();
	});

	it("stops observing after dispose", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => {
			releases++;
		});
		tracker.dispose();
		fire("pointerdown", 1);
		fire("pointerup", 1);
		expect(tracker.isDown()).toBe(false);
		expect(releases).toBe(0);
	});

	// An unmatched pointerup (the press began before this list mounted) must not
	// drive the count negative or fire a spurious release.
	//
	// The assertion is EXACT on purpose. It used to read `>= 1`, which legalised an
	// inconsistency: `pointerup`/`pointercancel` called back on an already-empty set
	// while `mouseup`/`contextmenu` returned early. Harmless in practice — the commit
	// callback self-guards on `deferred` — but it meant "release" meant two different
	// things depending on which listener fired, and the loose bound hid it.
	it("ignores a pointerup with no matching pointerdown", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => {
			releases++;
		});
		fire("pointerup", 9);
		expect(tracker.isDown()).toBe(false);
		// Nothing was being tracked, so there was no gesture to end.
		expect(releases).toBe(0);
		// ...and a later real gesture still reports exactly one release.
		fire("pointerdown", 9);
		expect(tracker.isDown()).toBe(true);
		fire("pointerup", 9);
		expect(tracker.isDown()).toBe(false);
		expect(releases).toBe(1);
		tracker.dispose();
	});

	// Same rule for the cancel path, which shares the handler.
	it("ignores a pointercancel with no gesture in progress", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => {
			releases++;
		});
		fire("pointercancel", 4);
		expect(releases).toBe(0);
		tracker.dispose();
	});

	// All four release listeners must agree: an empty set means "no gesture to end".
	it("never calls back on an empty set, whichever release path fires", () => {
		let releases = 0;
		const tracker = createPointerDragTracker(() => {
			releases++;
		});
		fire("pointerup", 1);
		fire("pointercancel", 1);
		fire("mouseup");
		fire("contextmenu");
		fire("drop");
		fire("dragend");
		expect(releases).toBe(0);
		tracker.dispose();
	});
});

/**
 * Source guard on the listener set.
 *
 * The behavioural tests above dispatch synthetic events, so they prove the handlers
 * work — but the bug that shipped was a MISSING LISTENER, and the app's own side nav
 * (mouse family) was the only thing exercising it. A source assertion makes dropping
 * a family a red test rather than a silent regression in one host.
 */
describe("listener coverage (source)", () => {
	it("observes both the pointer and the mouse families, in capture phase", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const source = readFileSync(join(import.meta.dir, "vlist-pointer-drag.ts"), "utf8");
		for (const type of [
			"pointerdown",
			"pointerup",
			"pointercancel",
			"mousedown",
			"mouseup",
			"contextmenu",
			"dragstart",
			"drop",
			"dragend",
		]) {
			expect(source).toContain(`addEventListener("${type}"`);
			// Every listener must also be removed, or a remounting list leaks them.
			expect(source).toContain(`removeEventListener("${type}"`);
		}
		// Capture phase + passive: see the module comment for why both matter.
		const registrations = source.match(/target\.addEventListener\([^)]*\)/g) ?? [];
		expect(registrations.length).toBe(9);
		expect(source).toContain('defaultView?.addEventListener("blur", releaseAll)');
		expect(source).toContain('defaultView?.removeEventListener("blur", releaseAll)');
		for (const registration of registrations) {
			expect(registration).toContain("capture: true");
			expect(registration).toContain("passive: true");
		}
	});
});

describe("pointer tracker with frozen production resize controller", () => {
	function frozenHarness() {
		let width = 650;
		let committed = 700;
		let id = 0;
		const frames = new Map<number, () => void>();
		const commits: number[] = [];
		const tracker = createPointerDragTracker(() => controller.release());
		const controller = createVListResizeController({
			previewPolicy: "freeze",
			readSize: () => ({ width, boxWidth: width + 32, height: 700 }),
			getCommittedWidth: () => committed,
			pointerDown: tracker.isDown,
			onInitial: () => {},
			onPreview: () => {
				throw new Error("Frozen rows must never preview");
			},
			onCommit: (size) => {
				committed = size.width;
				commits.push(size.width);
			},
			requestFrame: (callback) => {
				frames.set(++id, callback);
				return id;
			},
			cancelFrame: (frameId) => {
				frames.delete(frameId);
			},
			setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
			clearTimer: () => {},
		});
		return {
			controller,
			commits,
			set width(value: number) {
				width = value;
			},
			frame: () => {
				for (const [frameId, callback] of [...frames]) {
					frames.delete(frameId);
					callback();
				}
			},
			dispose: () => {
				tracker.dispose();
				controller.dispose();
			},
		};
	}

	it("checks host resize after an unobserved release but never rebuilds a plain click", () => {
		const h = frozenHarness();
		try {
			h.width = 700;
			fire("pointerdown", 1);
			fire("pointerup", 1);
			h.frame();
			expect(h.commits).toEqual([]);
			fire("pointerdown", 2);
			fire("pointerup", 2);
			expect(h.controller.isPending()).toBe(false);
			h.width = 620;
			h.frame();
			expect(h.commits).toEqual([620]);
		} finally {
			h.dispose();
		}
	});

	it("waits for every touch, then reads host geometry after the release event", () => {
		const h = frozenHarness();
		try {
			fire("pointerdown", 1);
			fire("pointerdown", 2);
			h.controller.observe();
			fire("pointerup", 1);
			h.frame();
			expect(h.commits).toEqual([]);
			fire("pointerup", 2);
			expect(h.commits).toEqual([]);
			// Simulate host release layout after the tracker callback (not DOM capture).
			h.width = 620;
			h.frame();
			expect(h.commits).toEqual([620]);
		} finally {
			h.dispose();
		}
	});

	it("does not commit a new pointer held before the prior release frame", () => {
		const h = frozenHarness();
		try {
			fire("pointerdown", 1);
			h.controller.observe();
			fire("pointerup", 1);
			fire("pointerdown", 2);
			h.width = 620;
			h.frame();
			expect(h.commits).toEqual([]);
			expect(h.controller.isPending()).toBe(true);
			fire("pointercancel", 2);
			h.frame();
			expect(h.commits).toEqual([620]);
		} finally {
			h.dispose();
		}
	});
});

describe("createPointerDragTracker without a DOM", () => {
	it("is inert when there is no document (SSR / non-DOM test run)", () => {
		restore?.();
		restore = undefined;
		const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
		Reflect.deleteProperty(globalThis as object, "document");
		try {
			const tracker = createPointerDragTracker(() => {});
			expect(tracker.isDown()).toBe(false);
			expect(() => tracker.dispose()).not.toThrow();
		} finally {
			if (previous) Object.defineProperty(globalThis, "document", previous);
		}
	});
});
