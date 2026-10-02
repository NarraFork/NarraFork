/**
 * Regression: global width/height writes used to re-render every mounted row on
 * every drag frame. Drive the production scheduler, not a copy of its state machine.
 * Local bounded-window previews are allowed; only initial/commit publish global state.
 */
import { describe, expect, it } from "bun:test";
import { createVListResizeController, type VListResizeSize } from "./vlist-live-resize";

function createCallbackHarness() {
	let size: VListResizeSize = { width: 700, boxWidth: 732, height: 700 };
	let committedWidth = 0;
	let nextFrame = 0;
	let timer: (() => void) | null = null;
	const frames = new Map<number, () => void>();
	const widthWrites: number[] = [];
	const heightWrites: number[] = [];
	const previewHeights: number[] = [];
	const publish = (value: VListResizeSize) => {
		committedWidth = value.width;
		widthWrites.push(value.width);
		heightWrites.push(value.height);
	};
	const controller = createVListResizeController({
		readSize: () => ({ ...size }),
		getCommittedWidth: () => committedWidth,
		pointerDown: () => true,
		onInitial: publish,
		onPreview: (value) => {
			previewHeights.push(value.height);
			return false;
		},
		onCommit: publish,
		requestFrame: (callback) => {
			const id = ++nextFrame;
			frames.set(id, callback);
			return id;
		},
		cancelFrame: (id) => {
			frames.delete(id);
		},
		setTimer: (callback) => {
			timer = callback;
			return 1 as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: () => {
			timer = null;
		},
	});
	controller.observe();
	widthWrites.length = 0;
	heightWrites.length = 0;
	return {
		controller,
		widthWrites,
		heightWrites,
		previewHeights,
		get committedWidth() {
			return committedWidth;
		},
		observe: (width: number, height: number) => {
			size = { width, boxWidth: width + 32, height };
			controller.observe();
		},
		frame: () => {
			for (const [id, callback] of [...frames]) {
				frames.delete(id);
				callback();
			}
		},
		timer: () => {
			const callback = timer;
			timer = null;
			callback?.();
		},
	};
}

describe("production resize controller: bounded previews, no full-layout state writes", () => {
	it("does not publish either global width or height during a drag, even while previewing", () => {
		const h = createCallbackHarness();
		for (let i = 1; i <= 80; i++) {
			h.observe(700 - i, 700 + i);
			h.frame();
			expect(h.committedWidth).toBe(700);
		}
		expect(h.widthWrites).toEqual([]);
		expect(h.heightWrites).toEqual([]);
		expect(h.previewHeights).toHaveLength(80);
		expect(h.previewHeights.at(-1)).toBe(780);
		h.controller.release();
		expect(h.widthWrites).toEqual([620]);
		expect(h.heightWrites).toEqual([780]);
		h.controller.dispose();
	});

	it("releases withheld global height on the backstop, not just pointer release", () => {
		const h = createCallbackHarness();
		h.observe(650, 800);
		h.frame();
		expect(h.heightWrites).toEqual([]);
		h.timer();
		expect(h.widthWrites).toEqual([650]);
		expect(h.heightWrites).toEqual([800]);
		expect(h.controller.isPending()).toBe(false);
		h.controller.dispose();
	});

	it("height-only observers leave height handling to the caller, without preview or full commit", () => {
		const h = createCallbackHarness();
		const callerHeightWrites: number[] = [];
		for (let height = 701; height <= 780; height++) {
			h.observe(700, height);
			if (!h.controller.isPending()) callerHeightWrites.push(height);
			h.frame();
		}
		expect(callerHeightWrites).toHaveLength(80);
		expect(callerHeightWrites.at(-1)).toBe(780);
		expect(h.widthWrites).toEqual([]);
		expect(h.heightWrites).toEqual([]);
		expect(h.previewHeights).toEqual([]);
		h.controller.dispose();
	});
});
