import { describe, expect, it } from "bun:test";
import { createVListResizeController, type VListResizeSize } from "./vlist-live-resize";
import {
	resolveWidthSettle,
	WIDTH_POINTER_BACKSTOP_MS,
	WIDTH_SETTLE_DELAY_MS,
} from "./vlist-width-settle";

/** A deterministic event loop: no browser, geometry stubs, or production reproduction. */
function createClock() {
	let now = 0;
	let sequence = 0;
	const frames = new Map<number, () => void>();
	const timers = new Map<number, { callback: () => void; at: number }>();
	return {
		frames,
		timers,
		requestFrame: (callback: () => void) => {
			const id = ++sequence;
			frames.set(id, callback);
			return id;
		},
		cancelFrame: (id: number) => {
			frames.delete(id);
		},
		setTimer: (callback: () => void, delay: number) => {
			const id = ++sequence;
			timers.set(id, { callback, at: now + delay });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: (id: ReturnType<typeof setTimeout>) => {
			timers.delete(id as unknown as number);
		},
		frame: () => {
			for (const [id, callback] of [...frames]) {
				if (!frames.delete(id)) continue;
				callback();
			}
		},
		advance: (ms: number) => {
			const end = now + ms;
			for (;;) {
				const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
				if (!next || next[1].at > end) break;
				now = next[1].at;
				timers.delete(next[0]);
				next[1].callback();
			}
			now = end;
		},
	};
}

function createHarness(
	options: {
		initialWidth?: number;
		preview?: () => boolean;
		previewPolicy?: "freeze" | "live-window";
	} = {},
) {
	const clock = createClock();
	let size: VListResizeSize = { width: 700, boxWidth: 732, height: 700 };
	let committedWidth = options.initialWidth ?? 700;
	let down = true;
	let pointerReads = 0;
	const initial: VListResizeSize[] = [];
	const previews: VListResizeSize[] = [];
	const commits: VListResizeSize[] = [];
	const controller = createVListResizeController({
		previewPolicy: options.previewPolicy,
		readSize: () => ({ ...size }),
		getCommittedWidth: () => committedWidth,
		pointerDown: () => {
			pointerReads++;
			return down;
		},
		onInitial: (value) => {
			initial.push(value);
			committedWidth = value.width;
		},
		onPreview: (value) => {
			previews.push(value);
			return options.preview?.() ?? false;
		},
		onCommit: (value) => {
			commits.push(value);
			committedWidth = value.width;
		},
		...clock,
	});
	return {
		clock,
		controller,
		initial,
		previews,
		commits,
		get committedWidth() {
			return committedWidth;
		},
		get pointerReads() {
			return pointerReads;
		},
		set down(value: boolean) {
			down = value;
		},
		resize: (value: Partial<VListResizeSize>, observe = true) => {
			size = { ...size, ...value };
			if (observe) controller.observe();
		},
	};
}

function expectIdle(h: ReturnType<typeof createHarness>) {
	expect(h.controller.isPending()).toBe(false);
	expect(h.clock.frames.size).toBe(0);
	expect(h.clock.timers.size).toBe(0);
}

describe("production vlist resize controller", () => {
	it("initializes the zero-width sentinel synchronously, without previews or timers", () => {
		const h = createHarness({ initialWidth: 0 });
		h.controller.observe();
		expect(h.initial).toEqual([{ width: 700, boxWidth: 732, height: 700 }]);
		expect(h.committedWidth).toBe(700);
		h.controller.observe();
		expect(h.initial).toHaveLength(1);
		expect(h.commits).toEqual([]);
		expect(h.previews).toEqual([]);
		expectIdle(h);
	});

	it("previews an 80-frame width/height drag without publishing global width or full commits", () => {
		let boundedMeasurements = 0;
		const h = createHarness({
			preview: () => {
				// The caller measures its bounded mounted window, not the 4000-row history.
				boundedMeasurements += 12;
				return false;
			},
		});
		for (let i = 1; i <= 80; i++) {
			h.resize({ width: 700 - i, boxWidth: 732 - i, height: 700 + i });
			h.clock.frame();
			h.clock.advance(16);
			expect(h.committedWidth).toBe(700);
			expect(h.commits).toHaveLength(0);
			expect(h.clock.frames.size).toBe(0);
			expect(h.clock.timers.size).toBe(1);
		}
		expect(h.previews).toHaveLength(80);
		expect(boundedMeasurements).toBe(80 * 12);
		h.controller.release();
		expect(h.commits).toEqual([{ width: 620, boxWidth: 652, height: 780 }]);
		expectIdle(h);
		h.clock.advance(WIDTH_POINTER_BACKSTOP_MS);
		h.controller.release();
		expect(h.commits).toHaveLength(1);
	});

	it("retains explicit live-window previews and the legacy synchronous release API", () => {
		const h = createHarness({ previewPolicy: "live-window" });
		h.resize({ width: 650 });
		h.controller.refresh();
		h.clock.frame();
		expect(h.previews.map((size) => size.width)).toEqual([650]);
		h.controller.release();
		expect(h.commits.map((size) => size.width)).toEqual([650]);
		expectIdle(h);
	});

	it("coalesces observer/refresh bursts into one frame and reads the latest live geometry", () => {
		const h = createHarness();
		for (let i = 1; i <= 20; i++) {
			h.resize({ width: 700 - i, height: 700 + i });
			h.controller.refresh();
		}
		expect(h.clock.frames.size).toBe(1);
		h.resize({ width: 650, boxWidth: 682, height: 800 }, false);
		h.clock.frame();
		expect(h.previews).toEqual([{ width: 650, boxWidth: 682, height: 800 }]);
		h.resize({ width: 640, boxWidth: 672, height: 810 }, false);
		h.controller.release();
		expect(h.commits).toEqual([{ width: 640, boxWidth: 672, height: 810 }]);
		expectIdle(h);
	});

	it("continues an unfinished short-window preview on successive frames, without rearming settle", () => {
		let passes = 0;
		const h = createHarness({ preview: () => ++passes < 3 });
		h.down = false;
		h.resize({ width: 600 });
		const deadline = [...h.clock.timers.values()][0]?.at;
		for (let i = 0; i < 3; i++) {
			h.clock.frame();
			h.clock.advance(30);
			expect([...h.clock.timers.values()][0]?.at).toBe(deadline);
			expect(h.clock.frames.size).toBe(i < 2 ? 1 : 0);
		}
		expect(h.previews).toHaveLength(3);
		h.clock.advance(WIDTH_SETTLE_DELAY_MS - 90);
		expect(h.commits).toHaveLength(1);
		expectIdle(h);
	});

	for (const runPreview of [true, false]) {
		for (const finalWidth of [650, 700]) {
			it(`explicitly commits width ${finalWidth}, even when preview ${runPreview ? "already ran" : "never ran"}`, () => {
				const h = createHarness();
				h.resize({ width: 650 });
				if (runPreview) h.clock.frame();
				h.resize({ width: finalWidth, boxWidth: finalWidth + 32, height: 810 });
				if (runPreview) h.clock.frame();
				const reads = h.pointerReads;
				h.controller.release(); // The capture tracker still reports pointerDown=true.
				expect(h.pointerReads).toBe(reads);
				expect(h.commits).toEqual([{ width: finalWidth, boxWidth: finalWidth + 32, height: 810 }]);
				expectIdle(h);
			});
		}
	}

	it("does not start previews or commits for same-width height-only/subpixel traffic", () => {
		const h = createHarness();
		for (let i = 1; i <= 80; i++) h.resize({ width: 700.4, height: 700 + i });
		h.controller.refresh();
		h.controller.release();
		expect(h.previews).toEqual([]);
		expect(h.commits).toEqual([]);
		expectIdle(h);
	});

	it("does not extend quiet time for pending height-only observers or snapshot/scroll refreshes", () => {
		const h = createHarness();
		h.down = false;
		h.resize({ width: 650 });
		const deadline = [...h.clock.timers.values()][0]?.at;
		for (let i = 1; i <= 7; i++) {
			h.clock.advance(19);
			h.resize({ height: 700 + i });
			h.controller.refresh();
			h.clock.frame();
			expect([...h.clock.timers.values()][0]?.at).toBe(deadline);
		}
		h.resize({ width: 650, boxWidth: 690, height: 900 }, false);
		h.clock.advance(7);
		expect(h.commits).toEqual([{ width: 650, boxWidth: 690, height: 900 }]);
		expectIdle(h);
	});

	it("rearms quiet time only when the observed width changes", () => {
		const h = createHarness();
		h.down = false;
		h.resize({ width: 650 });
		h.clock.advance(100);
		h.resize({ width: 640 });
		h.clock.advance(139);
		expect(h.commits).toEqual([]);
		h.clock.advance(1);
		expect(h.commits.map((size) => size.width)).toEqual([640]);
		expectIdle(h);
	});

	for (const down of [false, true]) {
		it(`settles a return to the starting width via ${down ? "backstop" : "quiet timer"}`, () => {
			const h = createHarness();
			h.down = down;
			h.resize({ width: 650 });
			h.clock.frame();
			h.resize({ width: 700 });
			h.clock.advance(down ? WIDTH_POINTER_BACKSTOP_MS : WIDTH_SETTLE_DELAY_MS);
			expect(h.commits.map((size) => size.width)).toEqual([700]);
			expectIdle(h);
		});
	}

	it("uses the long idle backstop for a stuck pointer despite endless same-width observations", () => {
		const h = createHarness();
		h.resize({ width: 650 });
		for (let i = 1; i <= 29; i++) {
			h.clock.advance(100);
			h.resize({ height: 700 + i });
			h.controller.refresh();
		}
		expect(h.commits).toEqual([]);
		h.clock.advance(100);
		expect(h.commits.map((size) => size.width)).toEqual([650]);
		expectIdle(h);
	});

	it("does not cut short active drags longer than the backstop", () => {
		const h = createHarness();
		for (let i = 1; i <= 60; i++) {
			h.resize({ width: 700 - i });
			h.clock.advance(100);
		}
		expect(h.commits).toEqual([]);
		h.controller.release();
		expect(h.commits.map((size) => size.width)).toEqual([640]);
		expectIdle(h);
	});

	it("bounds scrollbar feedback, but lets a distinct width or gesture release the pin", () => {
		const h = createHarness({ initialWidth: 0 });
		h.down = false;
		h.controller.observe();
		for (let i = 0; i < 20; i++) {
			h.resize({ width: h.committedWidth === 700 ? 685 : 700 });
			h.clock.frame();
			h.clock.advance(WIDTH_SETTLE_DELAY_MS);
		}
		expect(h.commits.map((size) => size.width)).toEqual([685, 700, 685]);
		expect(h.previews).toHaveLength(3);
		expectIdle(h);
		h.controller.release();
		h.resize({ width: 700 });
		h.clock.advance(WIDTH_SETTLE_DELAY_MS);
		expect(h.commits.at(-1)?.width).toBe(700);
		h.resize({ width: 600 });
		h.clock.advance(WIDTH_SETTLE_DELAY_MS);
		expect(h.commits.at(-1)?.width).toBe(600);
		expectIdle(h);
	});

	it("a timer commits the latest width/box/height even without a final observer", () => {
		const h = createHarness();
		h.down = false;
		h.resize({ width: 650 });
		h.clock.frame();
		h.resize({ width: 700, boxWidth: 800, height: 900 }, false);
		h.clock.advance(WIDTH_SETTLE_DELAY_MS);
		expect(h.commits).toEqual([{ width: 700, boxWidth: 800, height: 900 }]);
		expectIdle(h);
	});

	it("a host-box resize releases an already pinned feedback width", () => {
		const h = createHarness({ initialWidth: 0 });
		h.down = false;
		h.controller.observe();
		for (const width of [685, 700, 685, 700]) {
			h.resize({ width });
			h.clock.advance(WIDTH_SETTLE_DELAY_MS);
		}
		expect(h.committedWidth).toBe(685);
		expectIdle(h);
		h.resize({ width: 700, boxWidth: 800 });
		h.clock.advance(WIDTH_SETTLE_DELAY_MS);
		expect(h.committedWidth).toBe(700);
		expect(h.commits).toHaveLength(4);
		expectIdle(h);
	});

	it("does not mistake repeated host-box toggles for feedback", () => {
		const h = createHarness({ initialWidth: 0 });
		h.down = false;
		h.controller.observe();
		for (let i = 0; i < 20; i++) {
			const width = i % 2 === 0 ? 600 : 1000;
			h.resize({ width, boxWidth: width + 32 });
			h.clock.advance(WIDTH_SETTLE_DELAY_MS);
			expect(h.committedWidth).toBe(width);
		}
		expect(h.commits).toHaveLength(20);
		expectIdle(h);
	});

	it("pointer cancellation uses release, commits once, and cancels queued work", () => {
		const h = createHarness({ preview: () => true });
		h.resize({ width: 650 });
		h.clock.frame();
		expect(h.clock.frames.size).toBe(1);
		const canceledFrame = [...h.clock.frames.values()][0];
		const canceledTimer = [...h.clock.timers.values()][0]?.callback;
		h.controller.release();
		canceledFrame?.();
		canceledTimer?.();
		h.clock.frame();
		h.clock.advance(WIDTH_POINTER_BACKSTOP_MS);
		expect(h.previews).toHaveLength(1);
		expect(h.commits).toHaveLength(1);
		expectIdle(h);
	});

	it("dispose cancels all work and makes every public method inert", () => {
		const h = createHarness({ preview: () => true });
		h.resize({ width: 650 });
		const canceledFrame = [...h.clock.frames.values()][0];
		const canceledTimer = [...h.clock.timers.values()][0]?.callback;
		h.controller.dispose();
		h.controller.dispose();
		canceledFrame?.();
		canceledTimer?.();
		h.resize({ width: 600 });
		h.controller.refresh();
		h.controller.release();
		h.clock.frame();
		h.clock.advance(WIDTH_POINTER_BACKSTOP_MS);
		expect(h.previews).toEqual([]);
		expect(h.commits).toEqual([]);
		expectIdle(h);
	});

	it("surfaces a preview failure once, stops retries, and still settles", () => {
		const diagnostic = new Error("bounded measurement failed");
		const h = createHarness({
			preview: () => {
				throw diagnostic;
			},
		});
		h.down = false;
		h.resize({ width: 650 });
		expect(() => h.clock.frame()).toThrow(diagnostic);
		for (let i = 0; i < 10; i++) {
			h.controller.refresh();
			h.resize({ height: 710 + i });
			h.clock.frame();
		}
		expect(h.previews).toHaveLength(1);
		h.clock.advance(WIDTH_SETTLE_DELAY_MS);
		expect(h.commits).toHaveLength(1);
		expectIdle(h);
	});

	it("does not continue if a preview disposes its controller", () => {
		const h = createHarness({
			preview: () => {
				h.controller.dispose();
				return true;
			},
		});
		h.resize({ width: 650 });
		h.clock.frame();
		expect(h.previews).toHaveLength(1);
		expectIdle(h);
	});
});

describe("frozen resize policy", () => {
	it("checks final host width next frame even when no observer made resize pending", () => {
		const h = createHarness({ previewPolicy: "freeze" });
		h.controller.observe();
		expectIdle(h);
		h.down = false;
		h.controller.release();
		expect(h.controller.isPending()).toBe(false);
		expect(h.commits).toEqual([]);
		h.resize({ width: 630, boxWidth: 662, height: 810 }, false);
		h.clock.frame();
		expect(h.commits).toEqual([{ width: 630, boxWidth: 662, height: 810 }]);
		expect(h.previews).toEqual([]);
		expectIdle(h);
	});

	it("does not turn ordinary same-width clicks or height-only changes into full commits", () => {
		const h = createHarness({ previewPolicy: "freeze" });
		h.controller.observe();
		h.down = false;
		for (let i = 0; i < 10; i++) {
			h.controller.release();
			expect(h.controller.isPending()).toBe(false);
			h.resize({ width: 700.4, height: 700 + i }, false);
			h.clock.frame();
			expect(h.commits).toEqual([]);
			expect(h.previews).toEqual([]);
			expectIdle(h);
		}
	});

	it("initializes previously hidden zero-width geometry on an idle release check", () => {
		const h = createHarness({ initialWidth: 0, previewPolicy: "freeze" });
		h.resize({ width: 1, boxWidth: 0, height: 0 });
		h.down = false;
		h.controller.release();
		h.resize({ width: 700, boxWidth: 732, height: 700 }, false);
		h.clock.frame();
		expect(h.initial).toEqual([{ width: 700, boxWidth: 732, height: 700 }]);
		expect(h.commits).toEqual([]);
		expectIdle(h);
	});

	it("does not force an unobserved new gesture through an idle release check", () => {
		const h = createHarness({ previewPolicy: "freeze" });
		h.controller.observe();
		h.down = false;
		h.controller.release();
		h.down = true;
		h.resize({ width: 630, boxWidth: 662, height: 810 }, false);
		h.clock.frame();
		expect(h.commits).toEqual([]);
		expect(h.controller.isPending()).toBe(true);
		h.down = false;
		h.controller.release();
		h.clock.frame();
		expect(h.commits.map((size) => size.width)).toEqual([630]);
		expectIdle(h);
	});

	it("initializes synchronously and withholds every preview throughout an 80-frame drag", () => {
		const h = createHarness({ initialWidth: 0, previewPolicy: "freeze", preview: () => true });
		h.controller.observe();
		expect(h.initial).toHaveLength(1);
		for (let i = 1; i <= 80; i++) {
			h.resize({ width: 700 - i, boxWidth: 732 - i, height: 700 + i });
			h.controller.refresh();
			h.clock.frame();
			h.clock.advance(16);
			expect(h.committedWidth).toBe(700);
			expect(h.commits).toEqual([]);
			expect(h.clock.frames.size).toBe(0);
		}
		expect(h.previews).toEqual([]);
		h.down = false;
		h.controller.release();
		expect(h.commits).toEqual([]);
		h.clock.frame();
		expect(h.commits).toEqual([{ width: 620, boxWidth: 652, height: 780 }]);
		expectIdle(h);
	});

	it("coalesces capture releases and reads the host's final geometry next frame", () => {
		const h = createHarness({ previewPolicy: "freeze" });
		h.resize({ width: 650 });
		const staleTimer = [...h.clock.timers.values()][0]?.callback;
		h.down = false;
		h.controller.release();
		const staleFrame = [...h.clock.frames.values()][0];
		h.controller.release();
		expect(h.clock.frames.size).toBe(1);
		h.resize({ width: 630, boxWidth: 662, height: 810 }, false);
		staleTimer?.();
		staleFrame?.();
		h.controller.refresh();
		expect(h.commits).toEqual([]);
		h.clock.frame();
		expect(h.previews).toEqual([]);
		expect(h.commits).toEqual([{ width: 630, boxWidth: 662, height: 810 }]);
		h.controller.release();
		h.clock.frame();
		h.clock.advance(WIDTH_POINTER_BACKSTOP_MS);
		expect(h.commits).toHaveLength(1);
		expectIdle(h);
	});

	it("cannot force a new held gesture through an older release frame", () => {
		const h = createHarness({ previewPolicy: "freeze" });
		h.resize({ width: 650 });
		h.down = false;
		h.controller.release();
		h.down = true;
		h.resize({ width: 620 });
		h.clock.frame();
		expect(h.commits).toEqual([]);
		expect(h.previews).toEqual([]);
		expect(h.controller.isPending()).toBe(true);
		h.clock.advance(WIDTH_POINTER_BACKSTOP_MS - 1);
		expect(h.commits).toEqual([]);
		h.down = false;
		h.controller.release();
		h.clock.frame();
		expect(h.commits.map((size) => size.width)).toEqual([620]);
		expectIdle(h);
	});

	it("commits a return to the original width and presentation, without previewing either", () => {
		const h = createHarness({ previewPolicy: "freeze" });
		h.resize({ presentationKey: "desktop" });
		h.resize({ width: 650, presentationKey: "mobile" });
		h.resize({ width: 700, presentationKey: "desktop" });
		h.clock.frame();
		expect(h.previews).toEqual([]);
		h.down = false;
		h.controller.release();
		h.clock.frame();
		expect(h.commits).toHaveLength(1);
		expect(h.commits[0]?.width).toBe(700);
		expect(h.commits[0]?.presentationKey).toBe("desktop");
		expectIdle(h);
	});

	for (const down of [false, true]) {
		it(`retains ${down ? "abnormal pointer backstop" : "quiet settle"} without any preview`, () => {
			const h = createHarness({ previewPolicy: "freeze" });
			h.down = down;
			h.resize({ width: 650 });
			const delay = down ? WIDTH_POINTER_BACKSTOP_MS : WIDTH_SETTLE_DELAY_MS;
			for (let i = 0; i < 10; i++) {
				h.clock.advance((delay - 10) / 10);
				h.resize({ height: 710 + i });
				h.controller.refresh();
				h.clock.frame();
			}
			expect(h.commits).toEqual([]);
			h.resize({ width: 640, boxWidth: 672, height: 810 }, false);
			h.clock.advance(10);
			expect(h.commits).toEqual([{ width: 640, boxWidth: 672, height: 810 }]);
			expect(h.previews).toEqual([]);
			expectIdle(h);
		});
	}

	for (const wasPending of [false, true]) {
		it(`dispose cancels captured release callbacks, including pending=${wasPending}`, () => {
			const h = createHarness({ previewPolicy: "freeze" });
			if (wasPending) h.resize({ width: 650 });
			h.down = false;
			h.controller.release();
			const staleFrame = [...h.clock.frames.values()][0];
			expect(staleFrame).toBeDefined();
			h.controller.dispose();
			h.resize({ width: 630 }, false);
			staleFrame?.();
			h.controller.refresh();
			h.controller.release();
			h.clock.frame();
			h.clock.advance(WIDTH_POINTER_BACKSTOP_MS);
			expect(h.previews).toEqual([]);
			expect(h.commits).toEqual([]);
			expectIdle(h);
		});
	}

	it("keeps a frozen parked chat pending until visible geometry returns", () => {
		const h = createHarness({ previewPolicy: "freeze" });
		h.resize({ width: 650 });
		h.down = false;
		h.controller.release();
		h.resize({ width: 1, boxWidth: 0, height: 0 }, false);
		h.clock.frame();
		expect(h.commits).toEqual([]);
		h.resize({ width: 640, boxWidth: 672, height: 810 });
		h.clock.advance(WIDTH_SETTLE_DELAY_MS);
		expect(h.commits).toEqual([{ width: 640, boxWidth: 672, height: 810 }]);
		expectIdle(h);
	});
});

describe("resolveWidthSettle pending-preview compatibility", () => {
	for (const pointerDown of [false, true]) {
		it(`defers same-width pending observer with pointerDown=${pointerDown}`, () => {
			expect(
				resolveWidthSettle({
					nextWidth: 700,
					committedWidth: 700,
					pointerDown,
					trigger: "observer",
					hasPendingPreview: true,
				}),
			).toEqual({
				commit: false,
				defer: true,
				deferForMs: pointerDown ? WIDTH_POINTER_BACKSTOP_MS : WIDTH_SETTLE_DELAY_MS,
			});
		});
	}
	for (const trigger of ["timer", "gesture-end"] as const) {
		it(`explicitly commits same-width pending ${trigger}`, () => {
			expect(
				resolveWidthSettle({
					nextWidth: 700,
					committedWidth: 700,
					pointerDown: true,
					trigger,
					hasPendingPreview: true,
				}),
			).toEqual({ commit: true, defer: false, deferForMs: 0 });
		});
	}
});

describe("responsive presentation in the resize controller", () => {
	it("previews same-width breakpoint changes and commits once on release", () => {
		const h = createHarness();
		h.resize({ presentationKey: "desktop" });
		expectIdle(h);
		for (const presentationKey of ["mobile", "desktop", "mobile"]) {
			h.resize({ presentationKey, height: 650 });
			h.clock.frame();
			h.clock.advance(16);
			expect(h.committedWidth).toBe(700);
			expect(h.commits).toHaveLength(0);
			expect(h.controller.isPending()).toBe(true);
		}
		expect(h.previews.map((size) => size.presentationKey)).toEqual(["mobile", "desktop", "mobile"]);
		h.controller.release();
		expect(h.commits).toEqual([
			{ width: 700, boxWidth: 732, height: 650, presentationKey: "mobile" },
		]);
		h.resize({ height: 620 });
		expectIdle(h);
	});

	it("restarts quiet time for a breakpoint change, but not height-only traffic", () => {
		const h = createHarness();
		h.down = false;
		h.resize({ presentationKey: "desktop" });
		h.resize({ presentationKey: "mobile" });
		h.clock.frame();
		h.clock.advance(WIDTH_SETTLE_DELAY_MS - 1);
		h.resize({ presentationKey: "desktop" });
		h.clock.frame();
		h.clock.advance(WIDTH_SETTLE_DELAY_MS - 1);
		h.resize({ height: 600 });
		expect(h.commits).toHaveLength(0);
		h.clock.advance(1);
		expect(h.commits).toHaveLength(1);
		expect(h.commits[0]?.presentationKey).toBe("desktop");
		expectIdle(h);
	});
});

describe("hidden persistent chat slots", () => {
	it("ignores initial zero geometry and initializes only after the host is visible", () => {
		const h = createHarness({ initialWidth: 0 });
		h.resize({ width: 1, boxWidth: 0, height: 0 });
		expect(h.initial).toHaveLength(0);
		expect(h.committedWidth).toBe(0);
		expectIdle(h);
		h.resize({ width: 700, boxWidth: 732, height: 700 });
		expect(h.initial).toHaveLength(1);
		expect(h.committedWidth).toBe(700);
	});

	it("does not measure or settle a queued preview against a hidden parking slot", () => {
		const h = createHarness();
		h.controller.observe();
		h.resize({ width: 600, boxWidth: 632 });
		h.resize({ width: 1, boxWidth: 0, height: 0 });
		h.clock.frame();
		expect(h.previews).toHaveLength(0);
		h.controller.release();
		h.clock.advance(WIDTH_POINTER_BACKSTOP_MS);
		expect(h.commits).toHaveLength(0);
		expect(h.committedWidth).toBe(700);
		h.resize({ width: 600, boxWidth: 632, height: 700 });
		h.clock.frame();
		expect(h.previews).toHaveLength(1);
		h.controller.release();
		expect(h.commits).toHaveLength(1);
		expect(h.commits[0]?.width).toBe(600);
		expectIdle(h);
	});
});
