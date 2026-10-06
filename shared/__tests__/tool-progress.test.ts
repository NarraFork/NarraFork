import { describe, expect, it } from "bun:test";
import {
	deriveToolProgress,
	formatProgressBytes,
	formatProgressDuration,
	hasRenderableProgress,
	readToolProgressPayload,
} from "../tool-progress";

describe("the single byte/duration formatter every surface shares", () => {
	// These previously existed as four byte-identical copies (tool, transfer runner,
	// detail classifier, task drawer). Pinning the boundaries here is what makes a
	// future divergence a failing test rather than one surface quietly reporting a
	// different size than another for the same transfer.
	it("scales through the byte units at their exact boundaries", () => {
		expect(formatProgressBytes(0)).toBe("0 B");
		expect(formatProgressBytes(1023)).toBe("1023 B");
		expect(formatProgressBytes(1024)).toBe("1.0 KB");
		expect(formatProgressBytes(1024 * 1024)).toBe("1.0 MB");
		expect(formatProgressBytes(1024 * 1024 * 1024)).toBe("1.00 GB");
	});

	it("never renders a negative or non-finite size as a measurement", () => {
		expect(formatProgressBytes(-1)).toBe("0 B");
		expect(formatProgressBytes(Number.NaN)).toBe("0 B");
		expect(formatProgressBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
	});

	it("distinguishes an unmeasurable duration from an instantaneous one", () => {
		// "—" and "<1s" are different facts and the reader acts on the difference.
		expect(formatProgressDuration(Number.NaN)).toBe("—");
		expect(formatProgressDuration(-5)).toBe("—");
		expect(formatProgressDuration(0.4)).toBe("<1s");
		expect(formatProgressDuration(45)).toBe("45s");
		expect(formatProgressDuration(120)).toBe("2m");
		expect(formatProgressDuration(125)).toBe("2m5s");
		expect(formatProgressDuration(3700)).toBe("1h1m");
	});
});

describe("deriveToolProgress", () => {
	it("derives ratio, percent, rate and ETA", () => {
		const v = deriveToolProgress({ completed: 400, total: 1000, elapsedMs: 2000 });
		expect(v.ratio).toBeCloseTo(0.4, 5);
		expect(v.percent).toBe(40);
		expect(v.ratePerSecond).toBe(200);
		// 600 left at 200/s.
		expect(v.etaSeconds).toBe(3);
	});

	it("reports INDETERMINATE (null) rather than 0% when the total is unknown", () => {
		// The difference matters at the pixel level: a null ratio animates, a 0 ratio
		// paints a bar frozen at zero, which reads as a stalled operation.
		const v = deriveToolProgress({ completed: 400, elapsedMs: 2000 });
		expect(v.ratio).toBeNull();
		expect(v.percent).toBeNull();
		// A rate is still measurable without a total.
		expect(v.ratePerSecond).toBe(200);
		expect(v.etaSeconds).toBeNull();
	});

	it("treats total 0 as unknown, not as complete", () => {
		// 0/0 would otherwise be NaN or, worse, get special-cased into 100%.
		const v = deriveToolProgress({ completed: 0, total: 0, elapsedMs: 1000 });
		expect(v.ratio).toBeNull();
		expect(v.percent).toBeNull();
	});

	it("clamps a total that a growing source has already overrun", () => {
		// A directory total comes from a manifest taken before the walk; a file that
		// grew in between pushes the sum past it. Unclamped that is a 104% bar wider
		// than its own track.
		const v = deriveToolProgress({ completed: 1400, total: 1000, elapsedMs: 1000 });
		expect(v.ratio).toBe(1);
		expect(v.percent).toBe(100);
		expect(v.etaSeconds).toBe(0);
	});

	it("omits the rate before any elapsed time is reported", () => {
		const v = deriveToolProgress({ completed: 400, total: 1000 });
		expect(v.ratePerSecond).toBeNull();
		expect(v.etaSeconds).toBeNull();
		// The bar itself is still determinate.
		expect(v.percent).toBe(40);
	});
});

describe("hasRenderableProgress", () => {
	it("accepts a payload with work done or a known total", () => {
		expect(hasRenderableProgress({ completed: 1 })).toBe(true);
		expect(hasRenderableProgress({ completed: 0, total: 100 })).toBe(true);
	});

	it("rejects a payload that describes nothing", () => {
		// An empty bar that never moves is worse than no bar: it looks like a stall.
		expect(hasRenderableProgress({ completed: 0 })).toBe(false);
		expect(hasRenderableProgress({ completed: 0, total: 0 })).toBe(false);
		expect(hasRenderableProgress(null)).toBe(false);
		expect(hasRenderableProgress(undefined)).toBe(false);
	});
});

describe("readToolProgressPayload", () => {
	it("reads a well-formed payload", () => {
		expect(
			readToolProgressPayload({
				completed: 10,
				total: 100,
				itemsDone: 1,
				itemsTotal: 4,
				currentItem: "a/b.so",
				elapsedMs: 500,
				phase: "upload",
			}),
		).toEqual({
			completed: 10,
			total: 100,
			itemsDone: 1,
			itemsTotal: 4,
			currentItem: "a/b.so",
			elapsedMs: 500,
			phase: "upload",
		});
	});

	it("rejects anything without a finite completed count", () => {
		// `completed` is the one field every consumer dereferences; without it the
		// alternative to rejecting is a bar reading NaN%.
		expect(readToolProgressPayload({ total: 100 })).toBeNull();
		expect(readToolProgressPayload({ completed: "10" })).toBeNull();
		expect(readToolProgressPayload({ completed: Number.NaN })).toBeNull();
		expect(readToolProgressPayload(null)).toBeNull();
		expect(readToolProgressPayload("nope")).toBeNull();
	});

	it("drops individual fields of the wrong type instead of failing the payload", () => {
		// A malformed optional field should cost that field, not the whole bar.
		const p = readToolProgressPayload({
			completed: 10,
			total: "100",
			currentItem: 42,
			phase: null,
		});
		expect(p).toEqual({ completed: 10 });
	});
});
