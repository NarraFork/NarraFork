import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

const LONG_LINE =
	"Σ 1,234,567 ctx · 987,654 in · 321,098 out · 111,111 cache hit · 222,222 cache write (111,111 5m / 111,111 1h) · 99,999 reasoning · $12.3456";

describe("measureTurnUsage — leading line", () => {
	it("is one xs line plus the gap facing the body", async () => {
		const { measureTurnUsage, TURN_USAGE_LINE_HEIGHT, TURN_USAGE_LINE_MARGIN } = await import(
			"./measure-turn-usage"
		);
		const r = measureTurnUsage({ placement: "leading", text: "↑ 12,345" }, 600);
		expect(r.height).toBe(TURN_USAGE_LINE_HEIGHT + TURN_USAGE_LINE_MARGIN);
		expect(r.height).toBe(19);
		expect(r.lines).toEqual(["↑ 12,345"]);
		expect(r.placement).toBe("leading");
	});

	it("keeps the gap BELOW the text (no block marginTop)", async () => {
		const { measureTurnUsage } = await import("./measure-turn-usage");
		const r = measureTurnUsage({ placement: "leading", text: "↑ 1" }, 600);
		expect(r.blocks).toHaveLength(1);
		expect(r.blocks[0]?.marginTop).toBe(0);
	});
});

describe("measureTurnUsage — trailing lines", () => {
	it("is one xs line plus the gap facing the body", async () => {
		const { measureTurnUsage, TURN_USAGE_LINE_HEIGHT, TURN_USAGE_LINE_MARGIN } = await import(
			"./measure-turn-usage"
		);
		const r = measureTurnUsage({ placement: "trailing", text: "Σ 100 ctx · 100 in · 20 out" }, 600);
		expect(r.height).toBe(TURN_USAGE_LINE_HEIGHT + TURN_USAGE_LINE_MARGIN);
		expect(r.height).toBe(19);
	});

	it("puts the gap ABOVE the text (block marginTop)", async () => {
		const { measureTurnUsage, TURN_USAGE_LINE_MARGIN } = await import("./measure-turn-usage");
		const r = measureTurnUsage({ placement: "trailing", text: "Σ 1" }, 600);
		expect(r.blocks[0]?.marginTop).toBe(TURN_USAGE_LINE_MARGIN);
	});

	it("grows by exactly one line height for the mobile second line", async () => {
		const { measureTurnUsage, TURN_USAGE_LINE_HEIGHT } = await import("./measure-turn-usage");
		const single = measureTurnUsage({ placement: "trailing", text: "Σ 1" }, 600);
		const split = measureTurnUsage(
			{ placement: "trailing", text: "Σ 1", secondaryText: "8 cache hit · $0.5000" },
			600,
		);
		expect(split.height - single.height).toBe(TURN_USAGE_LINE_HEIGHT);
		expect(split.lines).toEqual(["Σ 1", "8 cache hit · $0.5000"]);
	});

	it("treats an empty secondary line as absent", async () => {
		const { measureTurnUsage } = await import("./measure-turn-usage");
		const withEmpty = measureTurnUsage(
			{ placement: "trailing", text: "Σ 1", secondaryText: "" },
			600,
		);
		const withNull = measureTurnUsage(
			{ placement: "trailing", text: "Σ 1", secondaryText: null },
			600,
		);
		expect(withEmpty.lines).toHaveLength(1);
		expect(withEmpty.height).toBe(withNull.height);
	});

	it("stacks the second line flush against the first", async () => {
		const { measureTurnUsage } = await import("./measure-turn-usage");
		const r = measureTurnUsage({ placement: "trailing", text: "Σ 1", secondaryText: "rest" }, 600);
		expect(r.blocks[1]?.marginTop).toBe(0);
	});
});

describe("measureTurnUsage — height determinism", () => {
	it("is independent of the text length (rows are clamped)", async () => {
		const { measureTurnUsage } = await import("./measure-turn-usage");
		const short = measureTurnUsage({ placement: "trailing", text: "Σ 1" }, 600);
		const long = measureTurnUsage({ placement: "trailing", text: LONG_LINE }, 600);
		expect(long.height).toBe(short.height);
	});

	it("is independent of width — even a width narrower than the text", async () => {
		const { measureTurnUsage } = await import("./measure-turn-usage");
		const narrow = measureTurnUsage({ placement: "trailing", text: LONG_LINE }, 80);
		const wide = measureTurnUsage({ placement: "trailing", text: LONG_LINE }, 2000);
		expect(narrow.height).toBe(wide.height);
	});

	it("is independent of LOD", async () => {
		const { measureTurnUsage } = await import("./measure-turn-usage");
		const low = measureTurnUsage({ placement: "trailing", text: "Σ 1" }, 600, 1);
		const high = measureTurnUsage({ placement: "trailing", text: "Σ 1" }, 600, 6);
		expect(low.height).toBe(high.height);
	});

	it("occupies the full content width", async () => {
		const { measureTurnUsage } = await import("./measure-turn-usage");
		const r = measureTurnUsage({ placement: "trailing", text: "Σ 1" }, 640);
		expect(r.contentWidth).toBe(640);
		expect(r.usedWidth).toBe(640);
	});
});
