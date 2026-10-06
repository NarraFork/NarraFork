import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// The resolved card measures its question via pretext rich-inline, so install the
// deterministic canvas stub BEFORE importing the pretext-backed measure module.
// The pending card is fully fixed and needs no measurement, but a single stub
// keeps every dynamic import in this file safe.
beforeAll(() => {
	installCanvasStub();
});

describe("measureAskInPassing — pending (fixed 79px including borders)", () => {
	it("pending height includes py×2, hint 21, input 36 and borders 2", async () => {
		const { measureAskInPassing, PENDING_CARD_HEIGHT } = await import("./measure-ask-in-passing");
		expect(PENDING_CARD_HEIGHT).toBe(79);
		const r = measureAskInPassing("pending", {}, 800);
		expect(r.height).toBe(79);
	});

	it("pending height ignores contentWidth", async () => {
		const { measureAskInPassing } = await import("./measure-ask-in-passing");
		const wide = measureAskInPassing("pending", {}, 2000);
		const narrow = measureAskInPassing("pending", {}, 120);
		expect(wide.height).toBe(79);
		expect(narrow.height).toBe(79);
	});

	it("pending height ignores LOD", async () => {
		const { measureAskInPassing } = await import("./measure-ask-in-passing");
		const heights = ([1, 2, 3, 4, 5] as const).map(
			(lod) => measureAskInPassing("pending", {}, 800, lod).height,
		);
		expect(new Set(heights).size).toBe(1);
		expect(heights[0]).toBe(79);
	});

	it("pending produces exactly one fixed block tagged ask_in_passing_pending", async () => {
		const { measureAskInPassing } = await import("./measure-ask-in-passing");
		const r = measureAskInPassing("pending", { messageId: "m1", narratorId: "n1" }, 800);
		expect(r.blocks).toHaveLength(1);
		const [block] = r.blocks;
		expect(block?.kind).toBe("fixed");
		if (block?.kind === "fixed") {
			expect(block.tag).toBe("ask_in_passing_pending");
			expect(block.height).toBe(79);
			expect(block.data).toMatchObject({ messageId: "m1", narratorId: "n1" });
		}
	});
});

describe("measureAskInPassing — resolved (57~77px, lineClamp=2)", () => {
	it("short question fits one line → 57px (min height)", async () => {
		const { measureAskInPassing, RESOLVED_MIN_HEIGHT } = await import("./measure-ask-in-passing");
		expect(RESOLVED_MIN_HEIGHT).toBe(57);
		// "Hi?" at a wide width is a single line.
		const r = measureAskInPassing("resolved", { question: "Hi?" }, 800);
		expect(r.height).toBe(57);
	});

	it("wrapping question caps at two lines → 77px (max height)", async () => {
		const { measureAskInPassing, RESOLVED_MAX_HEIGHT } = await import("./measure-ask-in-passing");
		expect(RESOLVED_MAX_HEIGHT).toBe(77);
		// A multi-word question at a narrow width wraps to ≥2 lines.
		const question = "one two three four five six seven eight nine ten";
		const r = measureAskInPassing("resolved", { question }, 200);
		expect(r.height).toBe(77);
	});

	it("lineClamp=2 is an upper bound: a huge question at a tiny width is still 77px", async () => {
		const { measureAskInPassing, RESOLVED_MAX_HEIGHT } = await import("./measure-ask-in-passing");
		// Even a very long question that would wrap to many lines is clamped to 2.
		const question = "word ".repeat(40).trim();
		const r = measureAskInPassing("resolved", { question }, 100);
		expect(r.height).toBe(RESOLVED_MAX_HEIGHT);
		expect(r.height).toBe(77);
	});

	it("resolved height always lies within [57, 77]", async () => {
		const { measureAskInPassing, RESOLVED_MIN_HEIGHT, RESOLVED_MAX_HEIGHT } = await import(
			"./measure-ask-in-passing"
		);
		const cases: Array<{ q: string; w: number }> = [
			{ q: "", w: 800 },
			{ q: "short", w: 800 },
			{ q: "a slightly longer question that might wrap once", w: 400 },
			{ q: "word ".repeat(40).trim(), w: 120 },
		];
		for (const { q, w } of cases) {
			const r = measureAskInPassing("resolved", { question: q }, w);
			expect(r.height).toBeGreaterThanOrEqual(RESOLVED_MIN_HEIGHT);
			expect(r.height).toBeLessThanOrEqual(RESOLVED_MAX_HEIGHT);
		}
	});

	it("wider width reduces (or keeps) the wrapped question height", async () => {
		const { measureAskInPassing } = await import("./measure-ask-in-passing");
		const question = "one two three four five six seven eight nine ten";
		const narrow = measureAskInPassing("resolved", { question }, 200);
		const wide = measureAskInPassing("resolved", { question }, 2000);
		expect(wide.height).toBeLessThanOrEqual(narrow.height);
		// At a very wide width this short-ish question collapses to one line (57px).
		expect(wide.height).toBe(57);
	});

	it("height does NOT change across LOD levels", async () => {
		const { measureAskInPassing } = await import("./measure-ask-in-passing");
		const heights = ([1, 2, 3, 4, 5] as const).map(
			(lod) => measureAskInPassing("resolved", { question: "Hi?" }, 800, lod).height,
		);
		expect(new Set(heights).size).toBe(1);
		expect(heights[0]).toBe(57);
	});

	it("produces exactly one inline block carrying the question flow", async () => {
		const { measureAskInPassing } = await import("./measure-ask-in-passing");
		const r = measureAskInPassing("resolved", { question: "What now?" }, 800);
		expect(r.blocks).toHaveLength(1);
		const [block] = r.blocks;
		expect(block?.kind).toBe("inline");
	});
});

describe("truncateQuestion — mirrors AskInPassingResolvedCard slice(0,60)", () => {
	it("keeps short questions verbatim", async () => {
		const { truncateQuestion } = await import("./measure-ask-in-passing");
		expect(truncateQuestion("short question")).toBe("short question");
	});

	it("slices at 60 chars and appends an ellipsis for long questions", async () => {
		const { truncateQuestion, QUESTION_SLICE_LEN } = await import("./measure-ask-in-passing");
		const long = "x".repeat(120);
		const out = truncateQuestion(long);
		expect(QUESTION_SLICE_LEN).toBe(60);
		expect(out).toBe(`${"x".repeat(60)}...`);
		expect(out.length).toBe(63);
	});

	it("does not truncate a question exactly 60 chars long", async () => {
		const { truncateQuestion } = await import("./measure-ask-in-passing");
		const exactly = "y".repeat(60);
		expect(truncateQuestion(exactly)).toBe(exactly);
	});
});

describe("measureAskInPassing — chrome constants", () => {
	it("resolved horizontal chrome = px×2 + border + icon×2 + gap×2 = 67", async () => {
		const { RESOLVED_CHROME_X } = await import("./measure-ask-in-passing");
		expect(RESOLVED_CHROME_X).toBe(67);
	});

	it("frame contentHeight + fixed chrome equals the element height", async () => {
		const { measureAskInPassing, RESOLVED_PADDING_Y, RESOLVED_LABEL_HEIGHT } = await import(
			"./measure-ask-in-passing"
		);
		const r = measureAskInPassing("resolved", { question: "Hi?" }, 800);
		expect(r.frame.contentHeight + RESOLVED_PADDING_Y * 2 + RESOLVED_LABEL_HEIGHT).toBe(r.height);
	});
});
