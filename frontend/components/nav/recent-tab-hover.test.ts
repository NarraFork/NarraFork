import { describe, expect, test } from "bun:test";
import {
	createRecentTabHoverStore,
	RECENT_TAB_HOVER_HIDE_DELAY_MS,
	RECENT_TAB_HOVER_SHOW_DELAY_MS,
	RECENT_TAB_KEYBOARD_CARD_LINGER_MS,
	railCardAnchor,
} from "./recent-tab-hover";

/** Manual clock: timers only fire when `advance` passes their due time. */
function fakeTimers() {
	let now = 0;
	let nextId = 1;
	const pending = new Map<number, { due: number; callback: () => void }>();
	return {
		timers: {
			setTimeout: (callback: () => void, ms: number) => {
				const id = nextId++;
				pending.set(id, { due: now + ms, callback });
				return id;
			},
			clearTimeout: (handle: unknown) => {
				pending.delete(handle as number);
			},
		},
		advance(ms: number) {
			now += ms;
			for (const [id, timer] of [...pending]) {
				if (timer.due <= now) {
					pending.delete(id);
					timer.callback();
				}
			}
		},
	};
}

const rect = { top: 10, bottom: 30, left: 0, right: 200 };

describe("recent tab hover card timing", () => {
	test("waits before the first card, then follows the pointer at once", () => {
		const clock = fakeTimers();
		const store = createRecentTabHoverStore(clock.timers);
		store.enter("narrator:a", () => rect);
		clock.advance(RECENT_TAB_HOVER_SHOW_DELAY_MS - 1);
		expect(store.getSnapshot()).toBeNull();
		clock.advance(1);
		expect(store.getSnapshot()?.key).toBe("narrator:a");

		store.leave();
		store.enter("narrator:b", () => rect);
		expect(store.getSnapshot()?.key).toBe("narrator:b");
	});

	test("passing over a row without stopping shows nothing", () => {
		const clock = fakeTimers();
		const store = createRecentTabHoverStore(clock.timers);
		store.enter("narrator:a", () => rect);
		clock.advance(100);
		store.leave();
		clock.advance(RECENT_TAB_HOVER_SHOW_DELAY_MS);
		expect(store.getSnapshot()).toBeNull();
	});

	test("moving onto the card keeps it; leaving the card closes it after the delay", () => {
		const clock = fakeTimers();
		const store = createRecentTabHoverStore(clock.timers);
		store.enter("narrator:a", () => rect);
		clock.advance(RECENT_TAB_HOVER_SHOW_DELAY_MS);
		store.leave();
		store.holdOpen();
		clock.advance(RECENT_TAB_HOVER_HIDE_DELAY_MS * 2);
		expect(store.getSnapshot()?.key).toBe("narrator:a");

		store.leave();
		clock.advance(RECENT_TAB_HOVER_HIDE_DELAY_MS);
		expect(store.getSnapshot()).toBeNull();
	});

	test("hide closes immediately and cancels a pending show", () => {
		const clock = fakeTimers();
		const store = createRecentTabHoverStore(clock.timers);
		store.enter("narrator:a", () => rect);
		store.hide();
		clock.advance(RECENT_TAB_HOVER_SHOW_DELAY_MS);
		expect(store.getSnapshot()).toBeNull();
	});
});

describe("recent tab keyboard card", () => {
	const railRect = { top: 50, bottom: 70, left: 16, right: 73 };

	test("shows at once and follows the highlight from row to row", () => {
		const clock = fakeTimers();
		const store = createRecentTabHoverStore(clock.timers);
		store.follow("narrator:a", railRect);
		expect(store.getSnapshot()).toEqual({ key: "narrator:a", rect: railRect, source: "keyboard" });
		store.follow("narrator:b", { ...railRect, top: 90, bottom: 110 });
		expect(store.getSnapshot()?.key).toBe("narrator:b");
		expect(store.getSnapshot()?.rect.top).toBe(90);
		expect(store.followedKey()).toBe("narrator:b");
	});

	test("takes the card over from the pointer, and the pointer leaving never closes it", () => {
		const clock = fakeTimers();
		const store = createRecentTabHoverStore(clock.timers);
		store.enter("narrator:a", () => rect);
		clock.advance(RECENT_TAB_HOVER_SHOW_DELAY_MS);
		store.follow("narrator:b", railRect);
		expect(store.getSnapshot()?.source).toBe("keyboard");
		store.leave();
		clock.advance(RECENT_TAB_HOVER_HIDE_DELAY_MS * 2);
		expect(store.getSnapshot()?.key).toBe("narrator:b");
	});

	test("a pending pointer show does not replace the keyboard's card later", () => {
		const clock = fakeTimers();
		const store = createRecentTabHoverStore(clock.timers);
		store.enter("narrator:a", () => rect);
		store.follow("narrator:b", railRect);
		clock.advance(RECENT_TAB_HOVER_SHOW_DELAY_MS);
		expect(store.getSnapshot()?.key).toBe("narrator:b");
	});

	test("the pointer entering a row takes it back, with the usual delay", () => {
		const clock = fakeTimers();
		const store = createRecentTabHoverStore(clock.timers);
		store.follow("narrator:a", railRect);
		store.enter("narrator:c", () => rect);
		// Closed at once: the keyboard's rail anchor is wrong for the opening sidebar.
		expect(store.getSnapshot()).toBeNull();
		expect(store.followedKey()).toBeNull();
		clock.advance(RECENT_TAB_HOVER_SHOW_DELAY_MS);
		expect(store.getSnapshot()).toEqual({ key: "narrator:c", rect, source: "pointer" });
		// Following ended: a later scroll does not bring the keyboard's card back.
		store.reanchor(railRect);
		expect(store.getSnapshot()?.source).toBe("pointer");
	});

	test("lingers after the highlight is gone, then closes", () => {
		const clock = fakeTimers();
		const store = createRecentTabHoverStore(clock.timers);
		store.follow("narrator:a", railRect);
		store.release();
		clock.advance(RECENT_TAB_KEYBOARD_CARD_LINGER_MS - 1);
		expect(store.getSnapshot()?.key).toBe("narrator:a");
		// Still following while it lingers, so it moves with a scroll.
		store.reanchor({ ...railRect, top: 20, bottom: 40 });
		expect(store.getSnapshot()?.rect.top).toBe(20);
		clock.advance(1);
		expect(store.getSnapshot()).toBeNull();
		expect(store.followedKey()).toBeNull();
	});

	test("a row that scrolls in after the switch still shows its card while it lingers", () => {
		const clock = fakeTimers();
		const store = createRecentTabHoverStore(clock.timers);
		store.follow("narrator:far", null);
		store.release();
		store.reanchor(railRect);
		expect(store.getSnapshot()?.key).toBe("narrator:far");
		clock.advance(RECENT_TAB_KEYBOARD_CARD_LINGER_MS);
		expect(store.getSnapshot()).toBeNull();
	});

	test("a key press while it lingers keeps it up", () => {
		const clock = fakeTimers();
		const store = createRecentTabHoverStore(clock.timers);
		store.follow("narrator:a", railRect);
		store.release();
		clock.advance(RECENT_TAB_KEYBOARD_CARD_LINGER_MS / 2);
		store.follow("narrator:b", railRect);
		clock.advance(RECENT_TAB_KEYBOARD_CARD_LINGER_MS);
		expect(store.getSnapshot()?.key).toBe("narrator:b");
	});

	test("a row off screen shows nothing until it scrolls in", () => {
		const clock = fakeTimers();
		const store = createRecentTabHoverStore(clock.timers);
		store.follow("narrator:a", railRect);
		store.follow("narrator:b", null);
		expect(store.getSnapshot()).toBeNull();
		expect(store.followedKey()).toBe("narrator:b");
		store.reanchor(railRect);
		expect(store.getSnapshot()?.key).toBe("narrator:b");
		store.reanchor(null);
		expect(store.getSnapshot()).toBeNull();
	});

	test("an unmoved re-anchor does not notify", () => {
		const store = createRecentTabHoverStore(fakeTimers().timers);
		let notified = 0;
		store.subscribe(() => notified++);
		store.follow("narrator:a", railRect);
		store.reanchor({ ...railRect });
		expect(notified).toBe(1);
	});

	test("unfollow and hide close only what they own", () => {
		const clock = fakeTimers();
		const store = createRecentTabHoverStore(clock.timers);
		store.enter("narrator:a", () => rect);
		clock.advance(RECENT_TAB_HOVER_SHOW_DELAY_MS);
		store.unfollow();
		expect(store.getSnapshot()?.source).toBe("pointer");

		store.follow("narrator:b", railRect);
		store.unfollow();
		expect(store.getSnapshot()).toBeNull();

		store.follow("narrator:b", railRect);
		store.hide();
		expect(store.getSnapshot()).toBeNull();
		expect(store.followedKey()).toBeNull();
	});
});

describe("railCardAnchor", () => {
	const row = { top: 100, bottom: 136, left: 16, right: 233 };
	const rail = { top: 0, bottom: 800, left: 0, right: 73 };
	const list = { top: 60, bottom: 700, left: 16, right: 233 };

	test("cuts a collapsed row to the rail, so the card sits next to the rail", () => {
		expect(railCardAnchor(row, rail, list)).toEqual({ top: 100, bottom: 136, left: 16, right: 73 });
	});

	test("keeps the full row when nothing clips it", () => {
		expect(railCardAnchor(row, null, list)).toEqual(row);
	});

	test("no anchor for a row outside the scrolled list, or one with no box", () => {
		expect(railCardAnchor({ ...row, top: 20, bottom: 56 }, rail, list)).toBeNull();
		expect(railCardAnchor({ ...row, top: 700, bottom: 736 }, rail, list)).toBeNull();
		expect(railCardAnchor({ top: 0, bottom: 0, left: 0, right: 0 }, rail, list)).toBeNull();
		// Partly visible still counts.
		expect(railCardAnchor({ ...row, top: 40, bottom: 76 }, rail, list)?.top).toBe(40);
	});
});
