import { describe, expect, test } from "bun:test";
import {
	createRecentTabHoverStore,
	RECENT_TAB_HOVER_HIDE_DELAY_MS,
	RECENT_TAB_HOVER_SHOW_DELAY_MS,
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
