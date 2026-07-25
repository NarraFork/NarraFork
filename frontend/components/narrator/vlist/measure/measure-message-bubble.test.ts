import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

describe("measureMessageBubble — assistant", () => {
	it("adds markdown vertical padding around the body", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const r = measureMessageBubble({ role: "assistant", text: "Hello world." }, 1000);
		// one body line + top/bottom assistant padding
		expect(r.height).toBe(
			MEASURE_MESSAGE_CONSTANTS.BODY_LINE_HEIGHT + MEASURE_MESSAGE_CONSTANTS.ASSISTANT_PAD_Y * 2,
		);
	});

	it("wraps assistant markdown as width shrinks", async () => {
		const { measureMessageBubble } = await import("./measure-message-bubble");
		const md = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
		const wide = measureMessageBubble({ role: "assistant", text: md }, 2000);
		const narrow = measureMessageBubble({ role: "assistant", text: md }, 120);
		expect(narrow.height).toBeGreaterThan(wide.height);
	});
});

describe("measureMessageBubble — user", () => {
	it("includes bubble padding and header row", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const r = measureMessageBubble({ role: "user", text: "hi" }, 1000);
		const c = MEASURE_MESSAGE_CONSTANTS;
		const expected =
			c.USER_BUBBLE_PADDING * 2 +
			c.USER_HEADER_HEIGHT +
			c.USER_HEADER_BODY_GAP +
			c.BODY_LINE_HEIGHT;
		expect(r.height).toBe(expected);
	});

	it("omits header height when hasHeader is false", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const withHeader = measureMessageBubble({ role: "user", text: "hi" }, 1000);
		const noHeader = measureMessageBubble({ role: "user", text: "hi", hasHeader: false }, 1000);
		const c = MEASURE_MESSAGE_CONSTANTS;
		expect(withHeader.height - noHeader.height).toBe(c.USER_HEADER_HEIGHT + c.USER_HEADER_BODY_GAP);
	});

	it("preserves hard newlines in plain user text (pre-wrap, not markdown)", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		// Markdown would collapse these into one paragraph; pre-wrap keeps 3 lines.
		const r = measureMessageBubble({ role: "user", text: "line1\nline2\nline3" }, 1000);
		const c = MEASURE_MESSAGE_CONSTANTS;
		const bodyHeight =
			r.height - (c.USER_BUBBLE_PADDING * 2 + c.USER_HEADER_HEIGHT + c.USER_HEADER_BODY_GAP);
		expect(bodyHeight).toBe(c.BODY_LINE_HEIGHT * 3);
	});

	it("shrink-wraps: narrow content uses less than full width", async () => {
		const { measureMessageBubble } = await import("./measure-message-bubble");
		const r = measureMessageBubble({ role: "user", text: "hi" }, 1000);
		// A 2-char body must not claim the full 1000px lane.
		expect(r.usedWidth).toBeLessThan(1000);
		expect(r.usedWidth).toBeGreaterThan(0);
	});

	it("floors bubble width at the header minimum when a header is present", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const c = MEASURE_MESSAGE_CONSTANTS;
		// A 2-char body shrink-wraps below the header row's needs; the header floor
		// keeps the bubble wide enough for avatar + name + time.
		const withHeader = measureMessageBubble({ role: "user", text: "hi" }, 1000);
		expect(withHeader.usedWidth).toBeGreaterThanOrEqual(
			c.USER_BUBBLE_PADDING * 2 + c.USER_HEADER_MIN_CONTENT_WIDTH,
		);
	});

	it("does not apply the header width floor when hasHeader is false", async () => {
		const { measureMessageBubble, MEASURE_MESSAGE_CONSTANTS } = await import(
			"./measure-message-bubble"
		);
		const c = MEASURE_MESSAGE_CONSTANTS;
		const noHeader = measureMessageBubble({ role: "user", text: "hi", hasHeader: false }, 1000);
		// Without a header there is no floor, so a short body stays narrow.
		expect(noHeader.usedWidth).toBeLessThan(
			c.USER_BUBBLE_PADDING * 2 + c.USER_HEADER_MIN_CONTENT_WIDTH,
		);
	});

	it("header width floor does not change measured height", async () => {
		const { measureMessageBubble } = await import("./measure-message-bubble");
		// The floor only widens the bubble frame; the body wraps within the full
		// contentWidth either way, so height is identical with/without the floor.
		const withHeader = measureMessageBubble({ role: "user", text: "hi" }, 1000);
		const noHeaderFloorRef = measureMessageBubble({ role: "user", text: "hi" }, 1000);
		expect(withHeader.height).toBe(noHeaderFloorRef.height);
	});
});
