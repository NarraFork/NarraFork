import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./test-canvas-stub";

// Install the deterministic canvas stub BEFORE importing any pretext-backed
// module (measure-media builds rich-inline flows for the image_generation
// header at prepare time).
beforeAll(() => {
	installCanvasStub();
});

describe("measureImage", () => {
	it("is a fixed 200px block regardless of width", async () => {
		const { measureImage, MEASURE_MEDIA_CONSTANTS } = await import("./measure-media");
		const wide = measureImage({ imageId: "img1", filename: "a.png" }, 1000);
		const narrow = measureImage({ imageId: "img1", filename: "a.png" }, 120);
		expect(wide.height).toBe(MEASURE_MEDIA_CONSTANTS.IMAGE_FIXED_HEIGHT);
		expect(narrow.height).toBe(MEASURE_MEDIA_CONSTANTS.IMAGE_FIXED_HEIGHT);
		expect(wide.blocks).toHaveLength(1);
		expect(wide.blocks[0]!.kind).toBe("fixed");
	});

	it("carries the image tag + data for the renderer", async () => {
		const { measureImage } = await import("./measure-media");
		const r = measureImage({ imageId: "x", previewUrl: "/p", uploadNarratorId: "n1" }, 800);
		const block = r.blocks[0]!;
		expect(block.kind).toBe("fixed");
		if (block.kind === "fixed") {
			expect(block.tag).toBe("image");
			expect(block.data?.imageId).toBe("x");
			expect(block.data?.uploadNarratorId).toBe("n1");
		}
	});
});

describe("measureTextFile", () => {
	it("is a fixed single-row height (icon dominates), width-independent", async () => {
		const { measureTextFile, MEASURE_MEDIA_CONSTANTS } = await import("./measure-media");
		const c = MEASURE_MEDIA_CONSTANTS;
		const expected = c.TEXT_FILE_ICON_SIZE + c.TEXT_FILE_PADDING_Y * 2;
		const wide = measureTextFile({ filename: "notes.txt", size: 2048 }, 1000);
		const narrow = measureTextFile({ filename: "notes.txt", size: 2048 }, 100);
		expect(wide.height).toBe(expected);
		expect(narrow.height).toBe(expected);
		expect(wide.height).toBe(c.TEXT_FILE_HEIGHT);
	});

	it("carries filename + size for the renderer", async () => {
		const { measureTextFile } = await import("./measure-media");
		const r = measureTextFile({ filename: "a.md", size: 512 }, 600);
		const block = r.blocks[0]!;
		if (block.kind === "fixed") {
			expect(block.tag).toBe("text_file");
			expect(block.data?.filename).toBe("a.md");
			expect(block.data?.size).toBe(512);
		}
	});
});

describe("measureImageGeneration", () => {
	it("reserves image height via aspect ratio when width/height are known (zero measure)", async () => {
		const { measureImageGeneration, MEASURE_MEDIA_CONSTANTS } = await import("./measure-media");
		const c = MEASURE_MEDIA_CONSTANTS;
		// 1024x512 → aspect 2:1. contentWidth 800 → inner = 800 - 2*paperPad.
		const r = measureImageGeneration(
			{ status: "completed", statusText: "Generated", width: 1024, height: 512, result: "data:x" },
			800,
		);
		const innerWidth = 800 - c.IMGGEN_PAPER_PADDING * 2;
		const displayWidth = Math.min(innerWidth, Math.min(1024, c.IMGGEN_MAX_DISPLAY_WIDTH));
		const imageHeight = Math.round((displayWidth * 512) / 1024);
		const headerHeight = c.IMGGEN_ICON_SIZE; // one short status line, icon dominates
		const expected =
			c.IMGGEN_PAPER_PADDING * 2 +
			c.IMGGEN_BORDER * 2 +
			headerHeight +
			c.IMGGEN_IMAGE_GAP +
			imageHeight;
		expect(r.height).toBe(expected);
		// header inline block + fixed image block
		expect(r.blocks).toHaveLength(2);
		expect(r.blocks[1]!.kind).toBe("fixed");
	});

	it("caps display width at GENERATED_IMAGE_MAX_DISPLAY_WIDTH", async () => {
		const { measureImageGeneration, MEASURE_MEDIA_CONSTANTS } = await import("./measure-media");
		const c = MEASURE_MEDIA_CONSTANTS;
		// Huge intrinsic size, very wide lane → display width clamps to 512.
		const r = measureImageGeneration(
			{ status: "completed", statusText: "Generated", width: 4000, height: 4000, result: "d" },
			5000,
		);
		const imageBlock = r.blocks[1]!;
		if (imageBlock.kind === "fixed") {
			expect(imageBlock.data?.displayWidth).toBe(c.IMGGEN_MAX_DISPLAY_WIDTH);
			// square image → height == displayWidth
			expect(imageBlock.height).toBe(c.IMGGEN_MAX_DISPLAY_WIDTH);
		}
	});

	it("uses a conservative unknown placeholder when metrics are missing but a source exists", async () => {
		const { measureImageGeneration, MEASURE_MEDIA_CONSTANTS } = await import("./measure-media");
		const c = MEASURE_MEDIA_CONSTANTS;
		const r = measureImageGeneration(
			{ status: "completed", statusText: "Generated", result: "data:image/png;base64,zzz" },
			800,
		);
		expect(r.blocks).toHaveLength(2);
		expect(r.blocks[1]!.kind).toBe("unknown");
		const expected =
			c.IMGGEN_PAPER_PADDING * 2 +
			c.IMGGEN_BORDER * 2 +
			c.IMGGEN_ICON_SIZE +
			c.IMGGEN_IMAGE_GAP +
			c.IMGGEN_UNKNOWN_IMAGE_HEIGHT;
		expect(r.height).toBe(expected);
	});

	it("is header-only (no image area) while generating with no source yet", async () => {
		const { measureImageGeneration, MEASURE_MEDIA_CONSTANTS } = await import("./measure-media");
		const c = MEASURE_MEDIA_CONSTANTS;
		const r = measureImageGeneration({ status: "generating", statusText: "Generating…" }, 800);
		expect(r.blocks).toHaveLength(1);
		expect(r.blocks[0]!.kind).toBe("inline");
		// Paper chrome + single header line (icon dominates the short text).
		const expected =
			c.IMGGEN_PAPER_PADDING * 2 +
			c.IMGGEN_BORDER * 2 +
			Math.max(c.IMGGEN_ICON_SIZE, c.IMGGEN_HEADER_LINE_HEIGHT);
		expect(r.height).toBe(expected);
	});

	it("grows taller as a long revisedPrompt wraps at narrow width", async () => {
		const { measureImageGeneration } = await import("./measure-media");
		const longPrompt =
			"a serene mountain lake at dawn with mist rising over calm water reflecting pink clouds and distant snow peaks";
		const wide = measureImageGeneration(
			{ status: "completed", statusText: "Generated", revisedPrompt: longPrompt },
			2000,
		);
		const narrow = measureImageGeneration(
			{ status: "completed", statusText: "Generated", revisedPrompt: longPrompt },
			200,
		);
		expect(narrow.height).toBeGreaterThan(wide.height);
	});
});

describe("measureMedia dispatcher", () => {
	it("routes by block.type", async () => {
		const { measureMedia, MEASURE_MEDIA_CONSTANTS } = await import("./measure-media");
		const c = MEASURE_MEDIA_CONSTANTS;
		expect(measureMedia({ type: "image", imageId: "x" }, 800).height).toBe(c.IMAGE_FIXED_HEIGHT);
		expect(measureMedia({ type: "text_file", filename: "f", size: 10 }, 800).height).toBe(
			c.TEXT_FILE_HEIGHT,
		);
		const gen = measureMedia(
			{ type: "image_generation", status: "completed", statusText: "Generated" },
			800,
		);
		expect(gen.blocks[0]!.kind).toBe("inline");
	});

	it("returns an empty zero-height element for unknown types", async () => {
		const { measureMedia } = await import("./measure-media");
		const r = measureMedia({ type: "video" }, 800);
		expect(r.height).toBe(0);
		expect(r.blocks).toHaveLength(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// A tool card's media image (Browser/WebFetch screenshot, image Read, shared
// image preview) must reserve the SAME height as a chat message's image block.
// The classifier's constant lives in shared/ (it cannot import frontend code),
// so nothing but a test keeps the two copies from drifting — and a drift is what
// made screenshot rows reserve a 400px box around a much shorter picture.
// ─────────────────────────────────────────────────────────────────────────────
describe("media image reserved height", () => {
	it("the shared classifier constant equals the chat image block height", async () => {
		const { IMAGE_FIXED_HEIGHT } = await import("./measure-media");
		const { MEDIA_IMAGE_CONTENT_PX } = await import("@shared/pretext-layout/tool-detail");
		expect(MEDIA_IMAGE_CONTENT_PX).toBe(IMAGE_FIXED_HEIGHT);
	});

	it("the measure layer re-exports the same value", async () => {
		const { IMAGE_FIXED_HEIGHT } = await import("./measure-media");
		const { MEDIA_IMAGE_CONTENT_PX } = await import("./measure-tool-call");
		expect(MEDIA_IMAGE_CONTENT_PX).toBe(IMAGE_FIXED_HEIGHT);
	});

	it("stays under the media cap so it is never clamped", async () => {
		const { MEDIA_IMAGE_CONTENT_PX, DETAIL_CAPS } = await import("./measure-tool-call");
		expect(MEDIA_IMAGE_CONTENT_PX).toBeLessThanOrEqual(DETAIL_CAPS.media);
	});
});

/**
 * The DELIBERATE monotonicity exception, pinned so it stays deliberate.
 *
 * Nearly every measure in this directory gets taller as its column narrows (text wraps
 * into more lines). `image_generation` with intrinsic dimensions does the opposite: the
 * image is scaled to fit the column, so a narrower column yields a SHORTER block. That
 * matches the renderer (`width: min(100%, displayWidth)` + `objectFit: contain`), so it
 * is correct — but it also means the vlist's width feedback loop cannot rely on
 * measure-layer monotonicity for termination, which is why
 * `vlist-width-settle.ts` carries a structural cycle guard.
 *
 * These assertions exist so that (a) nobody "fixes" the growth into a width-independent
 * reservation without noticing it would letterbox narrow columns, and (b) nobody
 * reinstates a global monotonicity invariant elsewhere while this exception stands.
 */
describe("image_generation height vs column width (monotonicity exception)", () => {
	const block = {
		type: "image_generation",
		status: "completed",
		width: 1024,
		height: 512,
		result: "x",
	} as const;

	it("GROWS with the column while the image is being scaled to fit", async () => {
		const { measureMedia } = await import("./measure-media");
		const heightAt = (w: number) => measureMedia({ ...block }, w).height;
		// 1px steps: the growth is ~0.5px per px of column, so a coarse stride can land
		// on equal values and read as flat.
		let increases = 0;
		let previous = heightAt(320);
		for (let width = 321; width <= 532; width++) {
			const height = heightAt(width);
			if (height > previous) increases++;
			expect(height).toBeGreaterThanOrEqual(previous);
			previous = height;
		}
		expect(increases).toBeGreaterThan(50);
		expect(heightAt(532)).toBeGreaterThan(heightAt(320));
	});

	it("saturates once the column exceeds the display cap, so growth is bounded", async () => {
		const { measureMedia, MEASURE_MEDIA_CONSTANTS } = await import("./measure-media");
		const cap = MEASURE_MEDIA_CONSTANTS.IMGGEN_MAX_DISPLAY_WIDTH;
		const heightAt = (w: number) => measureMedia({ ...block }, w).height;
		const atCap = heightAt(cap + MEASURE_MEDIA_CONSTANTS.IMGGEN_PAPER_PADDING * 2);
		for (const width of [700, 900, 1200, 1600]) {
			expect(heightAt(width)).toBe(atCap);
		}
	});

	// Without intrinsic dimensions there is nothing to scale, so the placeholder is
	// width-independent and the exception does not apply.
	it("does not apply to the unknown-size placeholder", async () => {
		const { measureMedia } = await import("./measure-media");
		const unknown = { type: "image_generation", status: "completed", result: "x" } as const;
		const narrow = measureMedia({ ...unknown }, 320).height;
		const wide = measureMedia({ ...unknown }, 900).height;
		expect(narrow).toBe(wide);
	});
});
