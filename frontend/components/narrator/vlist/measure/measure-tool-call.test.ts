import { beforeAll, describe, expect, it } from "bun:test";
import { BARE_ROW_CHEVRON, BARE_ROW_GAP, BARE_ROW_ICON } from "@shared/pretext-layout/row-metrics";
import { installCanvasStub } from "./test-canvas-stub";

// Install the deterministic canvas stub BEFORE importing any pretext-backed
// module (measure-tool-call builds inline blocks for the pretext-measured detail
// kinds + reuses measure-permission, all of which call pretext at prepare time).
beforeAll(() => {
	installCanvasStub();
});

// ── Shared builders ──────────────────────────────────────────────────────────
async function mod() {
	return import("./measure-tool-call");
}

function baseCard(overrides: Partial<import("./measure-tool-call").ToolCallData> = {}) {
	return {
		toolName: "Read",
		summary: "src/index.ts",
		category: "read" as const,
		status: "success" as const,
		...overrides,
	};
}

/** Build spec-task lines from plain strings (default status todo, unprotected). */
function specTasks(...texts: string[]): import("./measure-tool-call").SpecTaskLine[] {
	return texts.map((text) => ({ text, status: "todo", protected: false }));
}

// ── Fixed chrome constants ────────────────────────────────────────────────────
describe("measure-tool-call — fixed chrome (CONTRACT §4 ToolCallCard)", () => {
	it("header text line uses base line-height 1.55 → 19px; header row = 19", async () => {
		const m = await mod();
		expect(m.HEADER_TEXT_LINE_HEIGHT).toBe(19);
		// The SAME tile a folded trace row uses (was 16, which resized the chip mid-morph).
		expect(m.HEADER_CATEGORY_ICON).toBe(BARE_ROW_ICON);
		expect(m.HEADER_CATEGORY_ICON).toBe(14);
		// …and the swap is height-neutral, because the 19px text line dominates the `max`
		// at both sizes. This is what let the icon be unified without touching any
		// measured height.
		expect(m.HEADER_ROW_HEIGHT).toBe(19);
	});

	/**
	 * THE MORPH INVARIANT: the whole header line is moved by ONE `translate`, so every cell
	 * in it must need the same displacement. That requires the two forms to agree on the
	 * total width preceding the text — i.e. `icon + gap` must equal the row's.
	 *
	 * This held by ACCIDENT for a long time (card 16 + 4 = row 14 + 6 = 20) even though
	 * neither number matched the row. Unifying the ICON alone broke the accident: the text
	 * then needed 9px where the icon needed 7, and a single translate could not serve both,
	 * so the text jumped 2px mid-morph. Asserted as a RELATIONSHIP rather than two
	 * literals, because that is the property the morph actually depends on.
	 */
	it("keeps `icon + gap` identical to a folded row's, so one translate serves the line", async () => {
		const m = await mod();
		expect(m.HEADER_CATEGORY_ICON + m.HEADER_CELL_GAP).toBe(BARE_ROW_ICON + BARE_ROW_GAP);
	});

	it("needs the SAME shift for the icon and for the text", async () => {
		const m = await mod();
		const rowTextLeft = BARE_ROW_CHEVRON + BARE_ROW_GAP + BARE_ROW_ICON + BARE_ROW_GAP;
		const cardTextLeft =
			m.CARD_BORDER + m.CARD_PADDING + m.HEADER_CATEGORY_ICON + m.HEADER_CELL_GAP;
		const iconShift = BARE_ROW_CHEVRON + BARE_ROW_GAP - (m.CARD_BORDER + m.CARD_PADDING);
		expect(rowTextLeft - cardTextLeft).toBe(iconShift);
		// The 19px text line is taller than the 16px icon lane.
		expect(m.HEADER_ROW_HEIGHT).toBe(19);
	});

	it("standalone collapsed card ≈ 41px (10*2 padding + 1*2 border + 19 header)", async () => {
		const m = await mod();
		const expected = m.CARD_PADDING * 2 + m.CARD_BORDER * 2 + m.HEADER_ROW_HEIGHT;
		expect(expected).toBe(41);
		// Within the 40-42px target from CONTRACT §4.
		expect(expected).toBeGreaterThanOrEqual(40);
		expect(expected).toBeLessThanOrEqual(42);
	});

	// The measure layer counts INTEGER line boxes, so the render layer has to
	// declare that same integer. Declaring the ratio `1.4` instead gives the
	// browser 15.4px per line: every wrapped line drifts 0.4px and a 15-line body
	// overflows its height-fixed box by 6px, clipped without a scrollbar.
	it("pins the capped-body line box so render cannot drift from measure", async () => {
		const m = await mod();
		expect(m.DETAIL_BODY_FONT_SIZE).toBe(11);
		expect(m.DETAIL_CONTENT_LINE_HEIGHT).toBe(15);
		// The measured font string must use the same size the render box declares.
		expect(m.DETAIL_BODY_FONT).toContain(`${m.DETAIL_BODY_FONT_SIZE}px`);

		// Guard the render side by source inspection: a ratio-valued lineHeight in a
		// capped body is exactly the regression this constant exists to prevent.
		//
		// The render side now reads `detailContentLineHeight()` rather than the frozen
		// constant, because the line box follows the reader's line-spacing setting — but
		// the invariant is unchanged: it must take the px line box from THIS module, so
		// measure and render cannot disagree. A ratio would reintroduce the drift.
		const source = await Bun.file(
			new URL("../render/RenderToolCall.tsx", import.meta.url).pathname,
		).text();
		expect(source).not.toMatch(/lineHeight:\s*1\.4\b/);
		expect(source).toContain("lineHeight: `${detailContentLineHeight()}px`");
		// And the accessor must agree with the pinned baseline at neutral typography.
		expect(m.detailContentLineHeight()).toBe(m.DETAIL_CONTENT_LINE_HEIGHT);
	});

	it("exposes the maxHeight cap table (code/term/diff=200, bash=60, media=400, streaming-bash=120)", async () => {
		const { DETAIL_CAPS } = await mod();
		expect(DETAIL_CAPS.code).toBe(200);
		expect(DETAIL_CAPS.term).toBe(200);
		expect(DETAIL_CAPS.diff).toBe(200);
		expect(DETAIL_CAPS["bash-cmd"]).toBe(60);
		expect(DETAIL_CAPS.media).toBe(400);
		expect(DETAIL_CAPS.skill).toBe(400);
		expect(DETAIL_CAPS.knowledge).toBe(400);
		expect(DETAIL_CAPS["streaming-bash"]).toBe(120);
	});
});

// ── Collapsed vs expanded ─────────────────────────────────────────────────────
describe("measureToolCall — collapsed = header only", () => {
	it("a folded card (L3) is exactly the collapsed height, with no detail", async () => {
		const { measureToolCall } = await mod();
		const r = measureToolCall(
			baseCard({
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							label: "output",
							body: bodyFixture({ kind: "capped", cap: "code", contentLines: 50 }),
						},
					],
				},
			}),
			600,
			3,
		);
		expect(r.effectiveOpened).toBe(false);
		expect(r.detail).toBeNull();
		expect(r.height).toBe(r.collapsedHeight);
	});

	it("collapsed height is independent of summary length (header truncates)", async () => {
		const { measureToolCall } = await mod();
		const short = measureToolCall(baseCard({ summary: "a" }), 600, 3);
		const long = measureToolCall(baseCard({ summary: "x".repeat(500) }), 600, 3);
		expect(long.height).toBe(short.height);
	});

	it("in-run card drops the border but adds a 1px divider unless last", async () => {
		const { measureToolCall, CARD_PADDING, HEADER_ROW_HEIGHT, CARD_DIVIDER } = await mod();
		const notLast = measureToolCall(baseCard({ inRun: true, isLast: false }), 600, 3);
		const last = measureToolCall(baseCard({ inRun: true, isLast: true }), 600, 3);
		expect(notLast.hasBorder).toBe(false);
		// in-run chrome = padding only (no border) + divider when not last.
		expect(last.height).toBe(CARD_PADDING * 2 + HEADER_ROW_HEIGHT);
		expect(notLast.height).toBe(last.height + CARD_DIVIDER);
	});
});

describe("measureToolCall — expanded capped detail = min(content, cap)", () => {
	it("short code content is not capped (height grows with content)", async () => {
		const { measureToolCall, DETAIL_CONTENT_LINE_HEIGHT } = await mod();
		const few = measureToolCall(
			baseCard({
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							label: "output",
							body: bodyFixture({ kind: "capped", cap: "code", contentLines: 3 }),
						},
					],
				},
			}),
			600,
			5,
		);
		const more = measureToolCall(
			baseCard({
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							label: "output",
							body: bodyFixture({ kind: "capped", cap: "code", contentLines: 6 }),
						},
					],
				},
			}),
			600,
			5,
		);
		expect(few.detail).not.toBeNull();
		expect(more.detail!.height).toBe(few.detail!.height + 3 * DETAIL_CONTENT_LINE_HEIGHT);
	});

	it("long code content is clamped at the 200px cap", async () => {
		const {
			measureToolCall,
			DETAIL_CAPS,
			DETAIL_LABEL_LINE_HEIGHT,
			DETAIL_LABEL_MARGIN_BOTTOM,
			DETAIL_TOP_MARGIN,
		} = await mod();
		const r = measureToolCall(
			baseCard({
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							label: "output",
							body: bodyFixture({ kind: "capped", cap: "code", contentLines: 500 }),
						},
					],
				},
			}),
			600,
			5,
		);
		// The region = mt="xs" gap + label chrome + body clamped to the cap.
		const labelH = DETAIL_LABEL_LINE_HEIGHT + DETAIL_LABEL_MARGIN_BOTTOM;
		expect(r.detail!.sections[0]!.measuredBody.appliedCap).toBe(DETAIL_CAPS.code);
		expect(r.detail!.height).toBe(DETAIL_TOP_MARGIN + labelH + DETAIL_CAPS.code);
	});

	it("bash command cap is 60 (no label)", async () => {
		const { measureToolCall, DETAIL_CAPS, DETAIL_TOP_MARGIN } = await mod();
		const r = measureToolCall(
			baseCard({
				category: "bash",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							body: bodyFixture({ kind: "capped", cap: "bash-cmd", contentLines: 999 }),
						},
					],
				},
			}),
			600,
			5,
		);
		expect(r.detail!.sections[0]!.measuredBody.appliedCap).toBe(DETAIL_CAPS["bash-cmd"]);
		// bash-cmd has no leading label → region = mt="xs" gap + clamped body.
		expect(r.detail!.height).toBe(DETAIL_TOP_MARGIN + DETAIL_CAPS["bash-cmd"]);
	});

	it("media detail uses a direct pixel estimate clamped at 400", async () => {
		const { measureToolCall, DETAIL_CAPS, DETAIL_TOP_MARGIN } = await mod();
		const small = measureToolCall(
			baseCard({
				category: "browser",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							body: bodyFixture({ kind: "capped", cap: "media", contentPx: 150 }),
						},
					],
				},
			}),
			600,
			5,
		);
		const huge = measureToolCall(
			baseCard({
				category: "browser",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							body: bodyFixture({ kind: "capped", cap: "media", contentPx: 5000 }),
						},
					],
				},
			}),
			600,
			5,
		);
		expect(small.detail!.height).toBe(DETAIL_TOP_MARGIN + 150);
		expect(huge.detail!.height).toBe(DETAIL_TOP_MARGIN + DETAIL_CAPS.media);
	});

	it("media detail with intrinsic dimensions reserves the aspect-fitted height", async () => {
		const { measureToolCall, DETAIL_CAPS, DETAIL_TOP_MARGIN, CARD_PADDING, CARD_BORDER } =
			await mod();
		const innerWidth = 600 - CARD_PADDING * 2 - CARD_BORDER * 2; // 578
		// 1280×720 landscape: width-limited → 578 × floor(578*720/1280)=325.
		const landscape = measureToolCall(
			baseCard({
				category: "browser",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							body: bodyFixture({
								kind: "capped",
								cap: "media",
								contentPx: 200,
								media: { previewUrl: "/p/x", width: 1280, height: 720 },
							}),
						},
					],
				},
			}),
			600,
			5,
		);
		expect(landscape.detail!.height).toBe(
			DETAIL_TOP_MARGIN + Math.floor((innerWidth * 720) / 1280),
		);
		// 720×1280 portrait: height-capped at the media cap.
		const portrait = measureToolCall(
			baseCard({
				category: "browser",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							body: bodyFixture({
								kind: "capped",
								cap: "media",
								contentPx: 200,
								media: { previewUrl: "/p/x", width: 720, height: 1280 },
							}),
						},
					],
				},
			}),
			600,
			5,
		);
		expect(portrait.detail!.height).toBe(DETAIL_TOP_MARGIN + DETAIL_CAPS.media);
		// One-sided / invalid dims keep the fixed fallback.
		const noDims = measureToolCall(
			baseCard({
				category: "browser",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							body: bodyFixture({
								kind: "capped",
								cap: "media",
								contentPx: 200,
								media: { previewUrl: "/p/x", width: 1280 },
							}),
						},
					],
				},
			}),
			600,
			5,
		);
		expect(noDims.detail!.height).toBe(DETAIL_TOP_MARGIN + 200);
	});

	/**
	 * The fitted reservation is only half a contract: the render layer paints the
	 * numbers it finds in `block.data`, and with none there it falls back to a
	 * `width: 100%` box (see VListImage's legacy branch). That fallback paints
	 * `boxWidth × h/w`, which for a HEIGHT-CAPPED portrait is far taller than the
	 * 400px reserved here — clipped by the box's `overflow: hidden`, violating §0
	 * 铁律 2. So the measured block must carry BOTH dimensions of the fit.
	 */
	it("media detail stashes the EXACT fitted box, not just its height", async () => {
		const { measureToolCall, DETAIL_CAPS, CARD_PADDING, CARD_BORDER } = await mod();
		const innerWidth = 600 - CARD_PADDING * 2 - CARD_BORDER * 2; // 578
		const mediaBlock = (m: Awaited<ReturnType<typeof measureToolCall>>) => {
			const block = m.detail?.sections[0]?.measuredBody.blocks[0];
			expect(block?.kind).toBe("fixed");
			return (block as { data?: Record<string, unknown> }).data ?? {};
		};
		const card = (width: number, height: number) =>
			measureToolCall(
				baseCard({
					category: "browser",
					detail: {
						kind: "sections",
						sections: [
							{
								key: "output.main",
								body: bodyFixture({
									kind: "capped",
									cap: "media",
									contentPx: 200,
									media: { previewUrl: "/p/x", width, height },
								}),
							},
						],
					},
				}),
				600,
				5,
			);

		// HEIGHT-CAP DOMINATED (a tall screenshot): the fit clamps the height at the
		// cap and NARROWS the width to keep the ratio. This is the case that broke —
		// a full-width legacy box would paint 578 × 578*1280/720 ≈ 1027px tall.
		const portrait = card(720, 1280);
		const portraitData = mediaBlock(portrait);
		expect(portraitData.displayHeight).toBe(DETAIL_CAPS.media);
		expect(portraitData.displayWidth).toBe(Math.floor((DETAIL_CAPS.media * 720) / 1280)); // 225
		// The premise: the reserved width really is narrower than the column, which is
		// exactly why the legacy full-width paint could not match it.
		expect(portraitData.displayWidth as number).toBeLessThan(innerWidth);

		// WIDTH DOMINATED (a landscape screenshot): the fitted height already equals
		// what a full-width box would paint, so this case was accidentally correct.
		// Asserted anyway so both branches stay pinned.
		const landscape = card(1280, 720);
		const landscapeData = mediaBlock(landscape);
		expect(landscapeData.displayWidth).toBe(innerWidth);
		expect(landscapeData.displayHeight).toBe(Math.floor((innerWidth * 720) / 1280)); // 325

		// No intrinsic dimensions → no fitted box at all, so the render layer keeps
		// its legacy centred-in-fixed-box behaviour (the box height IS the fallback).
		const noDims = measureToolCall(
			baseCard({
				category: "browser",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							body: bodyFixture({
								kind: "capped",
								cap: "media",
								contentPx: 200,
								media: { previewUrl: "/p/x" },
							}),
						},
					],
				},
			}),
			600,
			5,
		);
		const noDimsData = mediaBlock(noDims);
		expect(noDimsData.displayWidth).toBeUndefined();
		expect(noDimsData.displayHeight).toBeUndefined();
	});

	it("plan cap = round(0.85 × viewportHeight), falling back to 400", async () => {
		const { measureToolCall, DETAIL_CAPS, DETAIL_TOP_MARGIN } = await mod();
		const withVp = measureToolCall(
			baseCard({
				category: "plan",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							body: bodyFixture({ kind: "capped", cap: "plan", contentLines: 999 }),
						},
					],
				},
			}),
			600,
			5,
			{ viewportHeight: 1000 },
		);
		// 0.85 × 1000 = 850.
		expect(withVp.detail!.sections[0]!.measuredBody.appliedCap).toBe(850);
		expect(withVp.detail!.height).toBe(DETAIL_TOP_MARGIN + 850);
		const noVp = measureToolCall(
			baseCard({
				category: "plan",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							body: bodyFixture({ kind: "capped", cap: "plan", contentLines: 999 }),
						},
					],
				},
			}),
			600,
			5,
		);
		expect(noVp.detail!.sections[0]!.measuredBody.appliedCap).toBe(DETAIL_CAPS.plan);
	});

	it("a server-truncated MARKDOWN body reserves the full cap, like a plain one", async () => {
		const { measureToolCall, DETAIL_TOP_MARGIN } = await mod();
		// The markdown branch used to size the box to whatever prefix the projection
		// budget happened to include, so the height depended on the server's cut and a
		// wider layout shrank the box while the rest of the (scrollable) body had
		// nowhere to go. `textTruncated` pins it to the cap instead, matching
		// `cappedBodyHeight`.
		const short = "# Plan\n\n- one";
		const card = (textTruncated?: boolean) =>
			measureToolCall(
				baseCard({
					category: "plan",
					detail: {
						kind: "sections",
						sections: [
							{
								key: "output.main",
								body: bodyFixture({
									kind: "capped",
									cap: "plan",
									contentLines: 3,
									text: short,
									format: "markdown",
									...(textTruncated ? { textTruncated: true } : {}),
								}),
							},
						],
					},
				}),
				600,
				5,
				{ viewportHeight: 1000 },
			);
		const prefix = card(true);
		const whole = card();
		// 0.85 × 1000 = 850, reserved in full despite the tiny prefix.
		expect(prefix.detail!.height).toBe(DETAIL_TOP_MARGIN + 850);
		// A complete body of the same text is measured exactly, so it stays far shorter.
		expect(whole.detail!.height).toBeLessThan(prefix.detail!.height);
		// And the flag travels out as a height-neutral output field, which is what
		// lets the viewer host request the missing bytes.
		expect(prefix.detail!.sections[0]!.measuredBody.textTruncated).toBe(true);
		expect(whole.detail!.sections[0]!.measuredBody.textTruncated).toBeUndefined();
	});

	it("does not reserve any row for a truncated payload (there is no notice line)", async () => {
		const { measureToolCall } = await mod();
		// Truncation is announced by nothing at all now: the reader reaches the real
		// payload by scrolling into the body. Two cards differing ONLY in their
		// truncation counters must therefore measure identically.
		const card = (truncated: boolean) =>
			measureToolCall(
				baseCard({
					category: "read",
					detail: {
						kind: "sections",
						sections: [
							{
								key: "output.main",
								label: "output",
								body: bodyFixture({
									kind: "capped",
									cap: "code",
									contentLines: 4,
									text: "a\nb\nc\nd",
								}),
							},
						],
					},
					...(truncated ? { truncatedLeafCount: 1, truncatedTotalBytes: 17 * 1024 } : {}),
				}),
				600,
				5,
			);
		expect(card(true).height).toBe(card(false).height);
		// The counters still travel through as the payload-completeness signal the
		// shell and the measure cache read.
		expect(card(true).truncatedLeafCount).toBe(1);
		expect(card(true).truncatedTotalBytes).toBe(17 * 1024);
	});

	it("generic detail sums an input + optional output section (each capped 200)", async () => {
		const { measureToolCall } = await mod();
		const inputOnly = measureToolCall(
			baseCard({
				category: "generic",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "input.arguments",
							label: "input",
							body: bodyFixture({
								cap: "code",
								source: "input.arguments",
								contentLines: 3,
								text: undefined,
							}),
						},
					],
				},
			}),
			600,
			5,
		);
		const both = measureToolCall(
			baseCard({
				category: "generic",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "input.arguments",
							label: "input",
							body: bodyFixture({
								cap: "code",
								source: "input.arguments",
								contentLines: 3,
								text: undefined,
							}),
						},
						{
							key: "output.main",
							label: "output",
							body: bodyFixture({ cap: "code", contentLines: 3, text: undefined }),
						},
					],
				},
			}),
			600,
			5,
		);
		expect(inputOnly.detail!.sections[0]!.measuredBody.blocks).toHaveLength(1);
		expect(both.detail!.sections).toHaveLength(2);
		expect(both.detail!.height).toBeGreaterThan(inputOnly.detail!.height);
	});
});

// ── Soft-wrap measurement of capped bodies (regression: single-line clipping) ──
describe("measureToolCall — capped body text wraps (not just hard newlines)", () => {
	/** The exact string that shipped clipped inside a 15px box. */
	const REFERENCE_LINE =
		"The plan was approved. Its full content is saved in the plan file: " +
		".narrafork/plan-shiki-static-edge--M5vvbT5A4myB7IPR.md. " +
		"Re-read that file with the Read tool if you need the plan details.";

	it("a long SINGLE-LINE body occupies more than one line box", async () => {
		const { measureToolCall, DETAIL_CONTENT_LINE_HEIGHT, DETAIL_BOX_CHROME_Y } = await mod();
		const measured = measureToolCall(
			baseCard({
				category: "generic",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							label: "output",
							body: bodyFixture({
								kind: "capped",
								cap: "code",
								contentLines: 1,
								text: REFERENCE_LINE,
							}),
						},
					],
				},
			}),
			400,
			5,
		);
		const block = measured.detail!.sections[0]!.measuredBody.blocks[0];
		const capped = block?.kind === "fixed" ? (block.data?.capped as number) : 0;
		// Before the fix this was exactly one 15px line (countLines only counts \n).
		const oneLine = DETAIL_CONTENT_LINE_HEIGHT + DETAIL_BOX_CHROME_Y;
		expect(capped).toBeGreaterThan(oneLine);
	});

	it("the same body needs more lines as the card narrows", async () => {
		const { measureToolCall } = await mod();
		const cappedAt = (width: number) => {
			const measured = measureToolCall(
				baseCard({
					category: "generic",
					detail: {
						kind: "sections",
						sections: [
							{
								key: "output.main",
								label: "output",
								body: bodyFixture({
									kind: "capped",
									cap: "code",
									contentLines: 1,
									text: REFERENCE_LINE,
								}),
							},
						],
					},
				}),
				width,
				5,
			);
			const block = measured.detail!.sections[0]!.measuredBody.blocks[0];
			return block?.kind === "fixed" ? (block.data?.capped as number) : 0;
		};
		expect(cappedAt(300)).toBeGreaterThan(cappedAt(900));
	});

	it("wrap width excludes the scroll box's horizontal padding", async () => {
		const m = await mod();
		expect(m.DETAIL_BOX_CHROME_X).toBe(m.DETAIL_BOX_PADDING_X * 2);
		expect(m.DETAIL_BOX_CHROME_Y).toBe(m.DETAIL_BOX_PADDING_Y * 2);
		// A body that fits on one line still pays the box's vertical padding.
		const measured = m.measureToolCall(
			baseCard({
				category: "generic",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							label: "output",
							body: bodyFixture({ kind: "capped", cap: "code", contentLines: 1, text: "short" }),
						},
					],
				},
			}),
			600,
			5,
		);
		const block = measured.detail!.sections[0]!.measuredBody.blocks[0];
		const capped = block?.kind === "fixed" ? (block.data?.capped as number) : 0;
		expect(capped).toBe(m.DETAIL_CONTENT_LINE_HEIGHT + m.DETAIL_BOX_CHROME_Y);
	});

	it("hasLabel adds the label row OUTSIDE the capped box", async () => {
		const m = await mod();
		const withLabel = m.measureToolCall(
			baseCard({
				category: "read",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							label: "output",
							body: bodyFixture({ kind: "capped", cap: "code", contentLines: 1, text: "short" }),
						},
					],
				},
			}),
			600,
			5,
		);
		const withoutLabel = m.measureToolCall(
			baseCard({
				category: "read",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							body: bodyFixture({ kind: "capped", cap: "code", contentLines: 1, text: "short" }),
						},
					],
				},
			}),
			600,
			5,
		);
		const labelChrome = m.DETAIL_LABEL_LINE_HEIGHT + m.DETAIL_LABEL_MARGIN_BOTTOM;
		expect(withLabel.detail!.height - withoutLabel.detail!.height).toBe(labelChrome);
	});

	it("huge bodies stop at the cap and only measure a bounded prefix", async () => {
		const m = await mod();
		// ~120KB, the scale of a real large tool output.
		const huge = "lorem ipsum dolor sit amet ".repeat(4600);
		expect(huge.length).toBeGreaterThan(100_000);
		const measured = m.measureToolCall(
			baseCard({
				category: "generic",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							label: "output",
							body: bodyFixture({ kind: "capped", cap: "code", contentLines: 1, text: huge }),
						},
					],
				},
			}),
			600,
			5,
		);
		const block = measured.detail!.sections[0]!.measuredBody.blocks[0];
		expect(block?.kind === "fixed" ? block.data?.capped : null).toBe(m.DETAIL_CAPS.code);
		// The prefix handed to pretext is bounded, never the whole body.
		const prefix = m.cappedMeasurePrefix(huge, m.cappedUsefulLines(m.DETAIL_CAPS.code), 588);
		expect(prefix.length).toBeLessThanOrEqual(m.DETAIL_MEASURE_PREFIX_MAX_CHARS);
		expect(prefix.length).toBeLessThan(huge.length);
	});

	it("bodies with many hard newlines cut the prefix at a newline boundary", async () => {
		const m = await mod();
		const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
		const useful = m.cappedUsefulLines(m.DETAIL_CAPS.code);
		const prefix = m.cappedMeasurePrefix(lines, useful, 588);
		expect(prefix.length).toBeLessThan(lines.length);
		// Enough newline-delimited segments to prove the cap is exceeded.
		expect((prefix.match(/\n/g) ?? []).length).toBeGreaterThanOrEqual(useful);
	});

	it("details without text still use the contentLines estimate", async () => {
		const m = await mod();
		const measured = m.measureToolCall(
			baseCard({
				category: "generic",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							label: "output",
							body: bodyFixture({ kind: "capped", cap: "code", contentLines: 4 }),
						},
					],
				},
			}),
			600,
			5,
		);
		const block = measured.detail!.sections[0]!.measuredBody.blocks[0];
		const capped = block?.kind === "fixed" ? (block.data?.capped as number) : 0;
		expect(capped).toBe(4 * m.DETAIL_CONTENT_LINE_HEIGHT);
	});

	it("generic input/output sections measure their own text", async () => {
		const m = await mod();
		const shortBoth = m.measureToolCall(
			baseCard({
				category: "generic",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "input.arguments",
							label: "input",
							body: bodyFixture({
								cap: "code",
								source: "input.arguments",
								contentLines: 1,
								text: "a",
							}),
						},
						{
							key: "output.main",
							label: "output",
							body: bodyFixture({ cap: "code", contentLines: 1, text: "b" }),
						},
					],
				},
			}),
			400,
			5,
		);
		const longOutput = m.measureToolCall(
			baseCard({
				category: "generic",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "input.arguments",
							label: "input",
							body: bodyFixture({
								cap: "code",
								source: "input.arguments",
								contentLines: 1,
								text: "a",
							}),
						},
						{
							key: "output.main",
							label: "output",
							body: bodyFixture({ cap: "code", contentLines: 1, text: "x".repeat(600) }),
						},
					],
				},
			}),
			400,
			5,
		);
		expect(longOutput.detail!.height).toBeGreaterThan(shortBoth.detail!.height);
	});
});

// ── Markdown-bodied capped detail (ExitPlanMode plans) ────────────────────────
describe("measureToolCall — plan detail renders as markdown", () => {
	const PLAN = "# Title\n\nSome prose paragraph.\n\n- one\n- two\n\n```ts\nconst a = 1;\n```";

	function planCard(detail: Partial<import("./measure-tool-call").ToolCappedDetail> = {}) {
		return baseCard({
			toolName: "ExitPlanMode",
			category: "plan",
			detail: {
				kind: "sections",
				sections: [
					{
						key: "output.main",
						body: bodyFixture({
							kind: "capped",
							cap: "plan",
							contentLines: 9,
							text: PLAN,
							format: "markdown",
							...detail,
						}),
					},
				],
			},
		});
	}

	it("flags the region as markdown and carries real prepared blocks", async () => {
		const { measureToolCall } = await mod();
		const measured = measureToolCall(planCard(), 600, 5, { viewportHeight: 1000 });
		const detail = measured.detail!.sections[0]!.measuredBody;
		expect(detail.markdown).toBe(true);
		// Not one opaque fixed block: headings/paragraph/list/code all appear.
		expect(detail.blocks.length).toBeGreaterThan(1);
		expect(detail.blocks.some((b) => b.kind === "code")).toBe(true);
	});

	it("keeps blocks and frame.blocks in lockstep (render indexes by position)", async () => {
		const { measureToolCall } = await mod();
		for (const sourcePath of [undefined, ".narrafork/plan-abc.md"]) {
			const measured = measureToolCall(planCard({ sourcePath }), 600, 5, { viewportHeight: 1000 });
			const detail = measured.detail!.sections[0]!.measuredBody;
			expect(detail.frame.blocks).toHaveLength(detail.blocks.length);
			for (const [index, frame] of detail.frame.blocks.entries()) {
				expect(frame.index).toBe(index);
			}
		}
	});

	it("a source path adds exactly one leading provenance row", async () => {
		const { measureToolCall, XS_LINE_HEIGHT } = await mod();
		const without = measureToolCall(planCard(), 600, 5, { viewportHeight: 1000 });
		const withSource = measureToolCall(planCard({ sourcePath: ".narrafork/plan-abc.md" }), 600, 5, {
			viewportHeight: 1000,
		});
		expect(withSource.detail!.sections[0]!.measuredBody.blocks).toHaveLength(
			without.detail!.sections[0]!.measuredBody.blocks.length + 1,
		);
		const first = withSource.detail!.sections[0]!.measuredBody.blocks[0];
		expect(first?.kind).toBe("fixed");
		expect(first?.kind === "fixed" ? first.tag : null).toBe("detail-plan-source");
		expect(first?.kind === "fixed" ? first.data?.sourcePath : null).toBe(".narrafork/plan-abc.md");
		expect(withSource.detail!.height).toBeGreaterThanOrEqual(
			without.detail!.height + XS_LINE_HEIGHT,
		);
	});

	it("still respects the 0.85 × viewport cap", async () => {
		const { measureToolCall, DETAIL_TOP_MARGIN } = await mod();
		const longPlan = Array.from({ length: 400 }, (_, i) => `## Section ${i}\n\nbody text`).join(
			"\n\n",
		);
		const measured = measureToolCall(planCard({ text: longPlan, contentLines: 1200 }), 600, 5, {
			viewportHeight: 1000,
		});
		expect(measured.detail!.sections[0]!.measuredBody.appliedCap).toBe(850);
		// Region = the outer mt gap + the clamped scroll box (cap never eats the gap).
		expect(measured.detail!.height).toBe(DETAIL_TOP_MARGIN + 850);
	});

	it("oversized plans parse a bounded prefix cut on a block boundary", async () => {
		const m = await mod();
		const block = "## Section\n\nSome body text that is reasonably long.\n\n";
		const huge = block.repeat(2000);
		expect(huge.length).toBeGreaterThan(m.DETAIL_MARKDOWN_PREFIX_MAX_CHARS);
		const prefix = m.markdownMeasurePrefix(huge);
		expect(prefix.length).toBeLessThanOrEqual(m.DETAIL_MARKDOWN_PREFIX_MAX_CHARS);
		// Cut on a blank-line boundary → never a half-open fence / split table.
		expect(prefix.endsWith("\n")).toBe(false);
		expect(huge.startsWith(prefix)).toBe(true);
		// Real plans (observed max ~18K chars) parse in full.
		const realistic = block.repeat(300);
		expect(realistic.length).toBeLessThan(m.DETAIL_MARKDOWN_PREFIX_MAX_CHARS);
		expect(m.markdownMeasurePrefix(realistic)).toBe(realistic);
	});

	/**
	 * The regression this file previously asserted the WRONG WAY ROUND.
	 *
	 * An escalating budget stopped parsing as soon as the measured content passed
	 * the cap, on the theory that the cap hides the rest. It does not: the box is
	 * `overflow: auto` and scrolls internally, so the un-parsed remainder was
	 * content with no blocks to scroll to. A real 15.7K-char plan ended at char
	 * 8154 — the reader scrolled to the bottom and the document just stopped.
	 *
	 * Scrollable content height is therefore the invariant, not parse count.
	 */
	it("parses PAST the cap: a body 2× longer has 2× the scrollable content", async () => {
		const m = await mod();
		const block = "## Section\n\nSome body text that is reasonably long enough to wrap.\n\n";
		const measure = (text: string) =>
			m.measureToolBody(
				bodyFixture({ kind: "capped", cap: "plan", contentLines: 1, text, format: "markdown" }),
				600,
				1000,
			);
		// Sized to STRADDLE the old first budget (8K chars): both bodies are far past
		// the cap, and the longer one reaches past 8K where the early break used to
		// stop. Two bodies that both fit under 8K prove nothing — the old algorithm
		// parsed those whole too.
		const shorter = block.repeat(150); // ~10K chars
		const longer = block.repeat(300); // ~20K chars
		expect(shorter.length).toBeGreaterThan(8 * 1024);
		expect(longer.length).toBeLessThan(m.DETAIL_MARKDOWN_PREFIX_MAX_CHARS);
		const shortDetail = measure(shorter);
		const longDetail = measure(longer);
		// The OUTER height is identical (both clamp at the cap)...
		expect(shortDetail.height).toBe(longDetail.height);
		expect(shortDetail.height).toBe(850);
		// ...while the scrollable content really does double. Under the old early
		// break both collapsed to the same 8K prefix and these were equal.
		const contentOf = (d: { frame: { contentHeight: number } }) => d.frame.contentHeight;
		expect(contentOf(longDetail)).toBeGreaterThan(contentOf(shortDetail) * 1.8);
		// Every block of the longer body is present, not just the pre-cap ones.
		expect(longDetail.blocks.length).toBeGreaterThan(shortDetail.blocks.length * 1.8);
	});

	it("a long real-world plan is painted to its LAST block", async () => {
		const m = await mod();
		// Mirrors the shape that regressed: ~16K chars of headings + prose, well
		// over the cap but under the parse ceiling, with a unique final marker.
		const body = Array.from(
			{ length: 60 },
			(_, i) => `### Section ${i}\n\nSome prose for section ${i} that wraps at this width.`,
		).join("\n\n");
		const plan = `# Plan\n\n${body}\n\n## END-OF-PLAN-MARKER\n\nThe closing line.`;
		expect(plan.length).toBeLessThan(m.DETAIL_MARKDOWN_PREFIX_MAX_CHARS);
		const detail = m.measureToolBody(
			bodyFixture({ kind: "capped", cap: "plan", contentLines: 1, text: plan, format: "markdown" }),
			600,
			1000,
		);
		// The whole text was parsed: nothing was dropped at a budget boundary.
		expect(detail.bodyIsPrefix).toBeUndefined();
		expect(detail.sourceText).toBe(plan);
		// Content is taller than the box, i.e. the tail is reachable by scrolling
		// rather than absent.
		expect(detail.frame.contentHeight).toBeGreaterThan(detail.height);
		// And the block count matches a full parse of the same text.
		const full = m.measureMarkdownDetail(plan, 10 ** 9, 600, undefined);
		expect(detail.blocks.length).toBe(full.blocks.length);
	});

	it("reports bodyIsPrefix ONLY when the parse ceiling actually cut the body", async () => {
		const m = await mod();
		const block = "## Section\n\nSome body text that is reasonably long.\n\n";
		const measure = (text: string) =>
			m.measureToolBody(
				bodyFixture({ kind: "capped", cap: "plan", contentLines: 1, text, format: "markdown" }),
				600,
				1000,
			);
		// Over the cap but under the ceiling → complete, so no prefix claim.
		expect(measure(block.repeat(100)).bodyIsPrefix).toBeUndefined();
		// Over the ceiling → genuinely cut, and the flag says so. The full text is
		// still carried for the viewer.
		const over = measure(block.repeat(2000));
		expect(over.bodyIsPrefix).toBe(true);
		expect(over.sourceText?.length).toBeGreaterThan(m.DETAIL_MARKDOWN_PREFIX_MAX_CHARS);
	});

	it("keeps the 1MB worst case bounded by the parse ceiling", async () => {
		const m = await mod();
		const block = "## Section\n\nSome body text that is reasonably long enough to wrap.\n\n";
		const measureMs = (text: string) => {
			const started = performance.now();
			m.measureToolBody(
				bodyFixture({ kind: "capped", cap: "plan", contentLines: 1, text, format: "markdown" }),
				600,
				1000,
			);
			return performance.now() - started;
		};
		// Warm the module/canvas paths so the first call is not charged for setup.
		measureMs(block.repeat(20));
		const atCeiling = measureMs(`${block.repeat(600)}\n\nunique-a`); // ~40KB > ceiling
		const enormous = measureMs(`${block.repeat(16000)}\n\nunique-b`); // ~1MB
		// 25× the input costs no more: both are cut at the ceiling, so the ceiling —
		// not the payload — bounds the synchronous work.
		expect(enormous).toBeLessThan(Math.max(atCeiling, 1) * 4);
	});

	it("a plan that fits under the cap keeps its exact measured height", async () => {
		const { measureToolBody, DETAIL_TOP_MARGIN } = await mod();
		const small = "# Title\n\nbody\n\n- a\n- b\n";
		const measured = measureToolBody(
			bodyFixture({
				kind: "capped",
				cap: "plan",
				contentLines: 1,
				text: small,
				format: "markdown",
			}),
			600,
			1000,
		);
		// Well under the 850px cap → the escalation must not truncate or clamp it.
		expect(measured.height).toBeLessThan(measured.appliedCap!);
		expect(measured.height).toBeGreaterThan(DETAIL_TOP_MARGIN);
	});

	it("a non-markdown plan detail keeps the plain capped shape", async () => {
		const { measureToolCall } = await mod();
		const measured = measureToolCall(
			baseCard({
				toolName: "ExitPlanMode",
				category: "plan",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							body: bodyFixture({ kind: "capped", cap: "plan", contentLines: 3, text: PLAN }),
						},
					],
				},
			}),
			600,
			5,
			{ viewportHeight: 1000 },
		);
		expect(measured.detail!.sections[0]!.measuredBody.markdown).toBeUndefined();
		expect(measured.detail!.sections[0]!.measuredBody.blocks).toHaveLength(1);
	});
});

// ── Pretext-measured detail kinds (🔴) ────────────────────────────────────────
describe("measureToolCall — pretext-measured detail (spec-tasks / structured / error)", () => {
	it("spec-tasks height grows with the number of tasks", async () => {
		const { measureToolCall } = await mod();
		const two = measureToolCall(
			baseCard({
				category: "tasks",
				detail: {
					kind: "sections",
					sections: [
						{ key: "meta.spec-tasks", body: { kind: "spec-tasks", tasks: specTasks("a", "b") } },
					],
				},
			}),
			600,
			5,
		);
		const four = measureToolCall(
			baseCard({
				category: "tasks",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "meta.spec-tasks",
							body: { kind: "spec-tasks", tasks: specTasks("a", "b", "c", "d") },
						},
					],
				},
			}),
			600,
			5,
		);
		expect(four.detail!.height).toBeGreaterThan(two.detail!.height);
	});

	it("spec-tasks long task text wraps into more lines as width shrinks", async () => {
		const { measureToolCall } = await mod();
		const task = "one two three four five six seven eight nine ten eleven twelve thirteen";
		const wide = measureToolCall(
			baseCard({
				category: "tasks",
				detail: {
					kind: "sections",
					sections: [
						{ key: "meta.spec-tasks", body: { kind: "spec-tasks", tasks: specTasks(task) } },
					],
				},
			}),
			2000,
			5,
		);
		const narrow = measureToolCall(
			baseCard({
				category: "tasks",
				detail: {
					kind: "sections",
					sections: [
						{ key: "meta.spec-tasks", body: { kind: "spec-tasks", tasks: specTasks(task) } },
					],
				},
			}),
			160,
			5,
		);
		expect(narrow.detail!.height).toBeGreaterThan(wide.detail!.height);
	});

	it("structured detail adds a badge row + a body line above the plain-body case", async () => {
		const { measureToolCall, STRUCT_BADGE_ROW, STRUCT_BADGE_GAP, DETAIL_TOP_MARGIN } = await mod();
		const noBadge = measureToolCall(
			baseCard({
				category: "recall",
				detail: {
					kind: "sections",
					sections: [{ key: "meta.structured", body: { kind: "structured", bodyLines: ["one"] } }],
				},
			}),
			600,
			5,
		);
		const withBadge = measureToolCall(
			baseCard({
				category: "recall",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "meta.structured",
							body: { kind: "structured", badgeRows: 1, bodyLines: ["one"] },
						},
					],
				},
			}),
			600,
			5,
		);
		// With a badge: mt gap(10) → badge row(16) → badge-gap(4) → body line.
		// Without:      mt gap(10) → body line. The mt="xs" gap simply moves onto
		// the badge block, so the delta is the badge row + the badge-gap.
		expect(DETAIL_TOP_MARGIN).toBeGreaterThan(0); // (documents the cancelled term)
		expect(withBadge.detail!.height).toBe(
			noBadge.detail!.height + STRUCT_BADGE_ROW + STRUCT_BADGE_GAP,
		);
		expect(withBadge.detail!.height).toBeGreaterThan(noBadge.detail!.height);
	});

	it("error detail wraps into more lines as width shrinks", async () => {
		const { measureToolCall } = await mod();
		const text =
			"Command failed with a fairly long multi word error message that must wrap somewhere";
		const wide = measureToolCall(
			baseCard({
				status: "fail",
				detail: {
					kind: "sections",
					sections: [{ key: "meta.error", body: { kind: "error", text } }],
				},
			}),
			2000,
			5,
		);
		const narrow = measureToolCall(
			baseCard({
				status: "fail",
				detail: {
					kind: "sections",
					sections: [{ key: "meta.error", body: { kind: "error", text } }],
				},
			}),
			160,
			5,
		);
		expect(narrow.detail!.height).toBeGreaterThan(wide.detail!.height);
	});
});

// ── LOD / effectiveOpened combinations ────────────────────────────────────────
describe("resolveToolCallOpened — LOD gate mirrors ToolCallCard :5594", () => {
	it("L5 expands an untouched card; L3 always collapses", async () => {
		const { resolveToolCallOpened } = await mod();
		const base = { lodExempt: false, isRecent: true, opened: true };
		expect(resolveToolCallOpened(5, base)).toBe(true);
		expect(resolveToolCallOpened(3, base)).toBe(false);
	});

	// L5 used to return a bare `true`, which made the header chevron DEAD there: the
	// shell's toggle writes `!effectiveOpened` into the `expanded` map, so the click
	// stored `false` into a channel this function never read and the card kept its
	// height with no feedback at all. Worst on the cards that most need folding — a
	// denied ExitPlanMode measures ~1200px (a 0.85×viewport plan body plus its
	// reflection notice), i.e. more than a screenful the reader could not put away.
	it("L5 honours an EXPLICIT fold", async () => {
		const { resolveToolCallOpened } = await mod();
		expect(
			resolveToolCallOpened(5, {
				lodExempt: false,
				isRecent: true,
				opened: false,
				userCollapsed: true,
			}),
		).toBe(false);
	});

	// The distinction that keeps every other L5 card unchanged: `opened === false`
	// derived from `computeDefaultOpen` is NOT a decision the reader made, so it must
	// not collapse an L5 card. Only a stored preference (`userCollapsed`) may.
	it("L5 ignores a merely-derived `opened: false`", async () => {
		const { resolveToolCallOpened } = await mod();
		expect(resolveToolCallOpened(5, { lodExempt: false, isRecent: true, opened: false })).toBe(
			true,
		);
	});

	// A folded approval form has nowhere to live, so the exemption must outrank an
	// explicit fold rather than merely preceding it by luck of ordering.
	it("lodExempt outranks an explicit fold at L5", async () => {
		const { resolveToolCallOpened } = await mod();
		expect(
			resolveToolCallOpened(5, {
				lodExempt: true,
				isRecent: true,
				opened: false,
				userCollapsed: true,
			}),
		).toBe(true);
	});

	it("L4 follows `opened` for recent cards, collapses older cards", async () => {
		const { resolveToolCallOpened } = await mod();
		expect(resolveToolCallOpened(4, { lodExempt: false, isRecent: true, opened: true })).toBe(true);
		expect(resolveToolCallOpened(4, { lodExempt: false, isRecent: true, opened: false })).toBe(
			false,
		);
		// Older card at L4 collapses regardless of `opened`.
		expect(resolveToolCallOpened(4, { lodExempt: false, isRecent: false, opened: true })).toBe(
			false,
		);
	});

	it("lodExempt (running / streaming / pending) always expands, even at L1", async () => {
		const { resolveToolCallOpened } = await mod();
		expect(resolveToolCallOpened(1, { lodExempt: true, isRecent: false, opened: false })).toBe(
			true,
		);
		expect(resolveToolCallOpened(3, { lodExempt: true, isRecent: false, opened: false })).toBe(
			true,
		);
	});

	it("L1/L2 collapse (upstream tool-run gate owns these levels)", async () => {
		const { resolveToolCallOpened } = await mod();
		const base = { lodExempt: false, isRecent: true, opened: true };
		expect(resolveToolCallOpened(1, base)).toBe(false);
		expect(resolveToolCallOpened(2, base)).toBe(false);
	});

	it("explicit LOD override expands L3 and older L4 cards", async () => {
		const { resolveToolCallOpened } = await mod();
		expect(
			resolveToolCallOpened(3, {
				lodExempt: false,
				isRecent: true,
				opened: false,
				lodUserOverride: true,
			}),
		).toBe(true);
		expect(
			resolveToolCallOpened(4, {
				lodExempt: false,
				isRecent: false,
				opened: false,
				lodUserOverride: true,
			}),
		).toBe(true);
	});
});

// ── L5 folding, asserted through the MEASURE (what the reader actually sees) ───
//
// The unit assertions above pin `resolveToolCallOpened`, but this bug shipped
// while a function-level test for L5 was passing: it asserted `true` for the
// then-intended behaviour. What the reader experiences is a HEIGHT, and the way
// they change it is the shell's toggle — which writes `!effectiveOpened` into the
// stored preference. So this walks that exact loop and asserts the card's measured
// height really moves, the one statement a dead chevron cannot satisfy.
describe("measureToolCall — a card can be folded at L5", () => {
	/** One click of the shell's header toggle, in shell semantics. */
	function clickHeights(
		measureToolCall: Awaited<ReturnType<typeof mod>>["measureToolCall"],
		lod: 3 | 4 | 5,
		isRecent: boolean,
		clicks: number,
	) {
		const data = baseCard({
			category: "plan",
			status: "fail",
			detail: {
				kind: "sections",
				sections: [
					{
						key: "output.main",
						body: bodyFixture({
							kind: "capped",
							cap: "plan",
							contentLines: 40,
							format: "markdown",
							text: "# Plan\n\n- one\n- two\n\n## Detail\n\nbody text\n",
						}),
					},
				],
			},
		});
		// The shell routes to the override channel at exactly the levels where a card
		// collapses by LOD; elsewhere it writes the `expanded` preference.
		const collapsesByLod = lod === 3 || (lod === 4 && !isRecent);
		const heights: number[] = [];
		let opened: boolean | undefined;
		let override = false;
		for (let i = 0; i < clicks; i++) {
			const m = measureToolCall(data, 600, lod, {
				viewportHeight: 900,
				isRecent,
				...(opened === undefined ? {} : { opened }),
				...(collapsesByLod ? { lodUserOverride: override } : {}),
			});
			heights.push(Math.round(m.height));
			if (collapsesByLod) override = !override;
			else opened = !m.effectiveOpened;
		}
		return heights;
	}

	it("folds and unfolds at L5, for a recent and an older card alike", async () => {
		const { measureToolCall } = await mod();
		for (const isRecent of [true, false]) {
			const [first, second, third] = clickHeights(measureToolCall, 5, isRecent, 3);
			// Starts expanded (L5 is the most detailed level), folds on the first click,
			// and comes back on the second.
			expect(second).toBeLessThan(first as number);
			expect(third).toBe(first);
		}
	});

	it("still opens expanded at L5 before any click", async () => {
		const { measureToolCall } = await mod();
		const [initial] = clickHeights(measureToolCall, 5, true, 1);
		// A collapsed standalone card is 41px (CONTRACT §4); this must be the full card.
		expect(initial).toBeGreaterThan(100);
	});

	it("leaves the L3 / older-L4 override channel working", async () => {
		const { measureToolCall } = await mod();
		for (const [lod, isRecent] of [
			[3, true],
			[4, false],
		] as const) {
			const [collapsed, expanded] = clickHeights(measureToolCall, lod, isRecent, 2);
			expect(expanded).toBeGreaterThan(collapsed as number);
		}
	});
});

describe("measureToolCall — running/pending cards are lodExempt", () => {
	it("a running card stays expanded at L3 (would otherwise collapse)", async () => {
		const { measureToolCall } = await mod();
		const r = measureToolCall(
			baseCard({
				status: "running",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							label: "output",
							body: bodyFixture({ kind: "capped", cap: "term", contentLines: 5 }),
						},
					],
				},
			}),
			600,
			3,
		);
		expect(r.lodExempt).toBe(true);
		expect(r.effectiveOpened).toBe(true);
		expect(r.detail).not.toBeNull();
		expect(r.height).toBeGreaterThan(r.collapsedHeight);
	});

	it("computeDefaultOpen auto-opens tasks/recall/plan and failed cards", async () => {
		const { computeDefaultOpen } = await mod();
		expect(computeDefaultOpen(baseCard({ category: "tasks" }), false)).toBe(true);
		expect(computeDefaultOpen(baseCard({ category: "recall" }), false)).toBe(true);
		expect(computeDefaultOpen(baseCard({ category: "plan" }), false)).toBe(true);
		expect(computeDefaultOpen(baseCard({ status: "fail" }), false)).toBe(true);
		// A plain successful read is collapsed by default.
		expect(computeDefaultOpen(baseCard(), false)).toBe(false);
		// Pending permission forces open regardless of category.
		expect(computeDefaultOpen(baseCard(), true)).toBe(true);
	});
});

describe("measureToolCall — the pinned latest-tasks card is forceExpanded", () => {
	it("a completed tasks card stays expanded at L3 (a level that collapses all)", async () => {
		const { measureToolCall } = await mod();
		const r = measureToolCall(
			baseCard({
				category: "tasks",
				toolName: "Write",
				status: "success",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "meta.spec-tasks",
							body: {
								kind: "spec-tasks",
								tasks: [{ text: "do the thing", status: "doing", protected: false }],
							},
						},
					],
				},
			}),
			600,
			3,
			{ forceExpanded: true },
		);
		expect(r.lodExempt).toBe(true);
		expect(r.effectiveOpened).toBe(true);
		expect(r.detail).not.toBeNull();
		expect(r.height).toBeGreaterThan(r.collapsedHeight);
	});

	it("…and at L1, where the run gate would normally own the card", async () => {
		const { measureToolCall } = await mod();
		const r = measureToolCall(baseCard({ category: "tasks", toolName: "Write" }), 600, 1, {
			forceExpanded: true,
		});
		expect(r.effectiveOpened).toBe(true);
	});

	it("an unpinned completed card is untouched by the flag's absence", async () => {
		const { measureToolCall } = await mod();
		const r = measureToolCall(baseCard({ status: "success" }), 600, 3);
		expect(r.lodExempt).toBe(false);
		expect(r.effectiveOpened).toBe(false);
	});
});

// ── Pending permission ────────────────────────────────────────────────────────
describe("measureToolCall — pendingPermission adds the InlinePermission UI", () => {
	it("pending card is lodExempt, expanded, and includes the permission region", async () => {
		const { measureToolCall } = await mod();
		const r = measureToolCall(baseCard({ category: "file", toolName: "Write" }), 600, 3, {
			pendingPermission: { hasExecutionTarget: true, feedbackRows: 1, buttonCount: 2 },
		});
		expect(r.lodExempt).toBe(true);
		expect(r.effectiveOpened).toBe(true);
		expect(r.permission).not.toBeNull();
		// Permission region (+ its own top margin) is added on top of the header.
		expect(r.height).toBeGreaterThan(r.collapsedHeight);
	});

	it("permission height matches measureInlinePermission at the inner width", async () => {
		const { measureToolCall, toolCardInnerWidth } = await mod();
		const { measureInlinePermission } = await import("./measure-permission");
		const perm = { hasExecutionTarget: true, feedbackRows: 2, buttonCount: 2 } as const;
		const r = measureToolCall(baseCard({ category: "file", toolName: "Write" }), 600, 5, {
			pendingPermission: perm,
		});
		const inner = toolCardInnerWidth(600, false);
		const direct = measureInlinePermission(perm, inner, 5);
		expect(r.permission!.height).toBe(direct.height);
		// The card height includes the permission top margin + its height.
		expect(r.height).toBe(
			r.chromeY + r.headerHeight + r.permission!.topMargin + r.permission!.height,
		);
	});

	it("detail + permission stack: permissionTop sits below the detail region", async () => {
		const { measureToolCall } = await mod();
		const r = measureToolCall(
			baseCard({
				category: "file",
				toolName: "Write",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "output.main",
							body: bodyFixture({ kind: "capped", cap: "diff", contentLines: 4 }),
						},
					],
				},
			}),
			600,
			5,
			{ pendingPermission: { hasExecutionTarget: true, buttonCount: 2 } },
		);
		expect(r.detail).not.toBeNull();
		expect(r.permission).not.toBeNull();
		expect(r.permissionTop).toBe(r.headerHeight + r.detail!.height);
	});
});

// ── Grouped card ──────────────────────────────────────────────────────────────
describe("measureToolCallGroup — header + accumulated child cards", () => {
	it("collapsed group is header only (default)", async () => {
		const { measureToolCallGroup } = await mod();
		const g = measureToolCallGroup(
			[baseCard({ toolName: "Read" }), baseCard({ toolName: "Read" })],
			600,
		);
		expect(g.expanded).toBe(false);
		expect(g.children).toHaveLength(0);
		expect(g.height).toBe(g.collapsedHeight);
		expect(g.childCount).toBe(2);
	});

	it("expanded group height = header + margin + Σ child card heights", async () => {
		const {
			measureToolCallGroup,
			toolGroupBodyInnerWidth,
			measureToolCall,
			GROUP_BODY_MARGIN_TOP,
		} = await mod();
		const cards = [baseCard({ toolName: "Read" }), baseCard({ toolName: "Read" })];
		const g = measureToolCallGroup(cards, 600, 4, { expanded: true });
		expect(g.children).toHaveLength(2);

		const inner = toolGroupBodyInnerWidth(600);
		const childSum = cards
			.map((c) => measureToolCall({ ...c, inRun: false }, inner, 4, { isRecent: true }).height)
			.reduce((a, b) => a + b, 0);
		expect(g.height).toBe(g.chromeY + g.headerHeight + GROUP_BODY_MARGIN_TOP + childSum);
	});

	it("more children → taller expanded group", async () => {
		const { measureToolCallGroup } = await mod();
		const two = measureToolCallGroup([baseCard(), baseCard()], 600, 4, { expanded: true });
		const three = measureToolCallGroup([baseCard(), baseCard(), baseCard()], 600, 4, {
			expanded: true,
		});
		expect(three.height).toBeGreaterThan(two.height);
	});

	it("sums the child durations and finds the earliest start", async () => {
		// The chunked group header shows Σ duration + a tooltip on the earliest start
		// (ToolCallCard.tsx:5917/:5936); the vlist header had neither.
		const { measureToolCallGroup } = await mod();
		const g = measureToolCallGroup(
			[
				baseCard({ durationMs: 400, startedAt: 3_000 }),
				baseCard({ durationMs: 600, createdAt: 1_000 }),
			],
			600,
		);
		expect(g.totalDurationMs).toBe(1_000);
		expect(g.earliestStartMs).toBe(1_000);
		expect(g.earliestActiveStartMs).toBeNull();
	});

	it("reports the earliest ACTIVE start while a child is still running", async () => {
		const { measureToolCallGroup } = await mod();
		const g = measureToolCallGroup(
			[
				baseCard({ status: "success", durationMs: 400, startedAt: 1_000 }),
				baseCard({ status: "running", startedAt: 5_000 }),
				baseCard({ status: "pending", startedAt: 4_000 }),
			],
			600,
		);
		// Finished children do not lower the live timer's origin.
		expect(g.earliestActiveStartMs).toBe(4_000);
		expect(g.earliestStartMs).toBe(1_000);
	});

	it("aggregates on a COLLAPSED group too (children are not measured then)", async () => {
		const { measureToolCallGroup } = await mod();
		const g = measureToolCallGroup([baseCard({ durationMs: 250, startedAt: 9 })], 600);
		expect(g.children).toHaveLength(0);
		expect(g.totalDurationMs).toBe(250);
		expect(g.earliestStartMs).toBe(9);
	});

	it("the aggregates never change the group's height", async () => {
		const { measureToolCallGroup } = await mod();
		const bare = measureToolCallGroup([baseCard(), baseCard()], 600, 4, { expanded: true });
		const timed = measureToolCallGroup(
			[
				baseCard({ durationMs: 9_999, startedAt: 1, completedAt: 10_000 }),
				baseCard({ durationMs: 8_888, startedAt: 2, completedAt: 20_000 }),
			],
			600,
			4,
			{ expanded: true },
		);
		expect(timed.height).toBe(bare.height);
		expect(timed.headerHeight).toBe(bare.headerHeight);
	});
});

// ── Header timing passthrough (all height-neutral) ────────────────────────────
describe("measureToolCall — lifecycle stamps reach the renderer", () => {
	const STAMPS = {
		startedAt: 1_000,
		streamStartedAt: 900,
		permissionStartedAt: 1_100,
		executionStartedAt: 1_500,
		completedAt: 4_000,
		createdAt: 800,
		durationMs: 3_000,
	};

	it("passes every stamp through onto `timing`", async () => {
		const { measureToolCall } = await mod();
		expect(measureToolCall(baseCard(STAMPS), 600, 4).timing).toEqual(STAMPS);
	});

	it("nulls the stamps a card does not carry (never undefined)", async () => {
		const { measureToolCall } = await mod();
		expect(measureToolCall(baseCard(), 600, 4).timing).toEqual({
			startedAt: null,
			streamStartedAt: null,
			permissionStartedAt: null,
			executionStartedAt: null,
			completedAt: null,
			createdAt: null,
			durationMs: null,
		});
	});

	it("resolves the earliest start across all stamps", async () => {
		const { earliestToolStartMs, measureToolCall } = await mod();
		expect(earliestToolStartMs(measureToolCall(baseCard(STAMPS), 600, 4).timing)).toBe(800);
		expect(earliestToolStartMs(measureToolCall(baseCard(), 600, 4).timing)).toBeNull();
	});

	it("the stamps are HEIGHT-NEUTRAL on a collapsed AND an expanded card", async () => {
		// The breakdown lives in a portal, so carrying the stamps must not move a
		// single pixel — the invariant CONTRACT §0 rule 2 depends on here.
		const { measureToolCall } = await mod();
		const detail: import("./measure-tool-call").ToolDetailData = {
			kind: "sections",
			sections: [{ key: "output.main", body: bodyFixture({ cap: "term", text: "a\nb\nc\nd" }) }],
		};
		for (const opts of [{}, { opened: true }] as const) {
			const bare = measureToolCall(baseCard({ detail }), 600, 4, opts);
			const timed = measureToolCall(baseCard({ detail, ...STAMPS }), 600, 4, opts);
			expect(timed.height).toBe(bare.height);
			expect(timed.headerHeight).toBe(bare.headerHeight);
			expect(timed.collapsedHeight).toBe(bare.collapsedHeight);
		}
	});
});

// ── `+N -N` line counts (height-neutral header passthrough) ───────────────────
describe("measureToolCall — Write/Edit line counts", () => {
	it("passes the counts through onto `diffStats`, defaulting to null", async () => {
		// The renderer reads this off the measured payload, so it must arrive intact.
		// Null (not `{0,0}`) is the "unknown" encoding — see `resolveFileDiffStats`.
		const { measureToolCall } = await mod();
		expect(
			measureToolCall(baseCard({ diffStats: { added: 12, removed: 3 } }), 600, 4).diffStats,
		).toEqual({ added: 12, removed: 3 });
		expect(measureToolCall(baseCard(), 600, 4).diffStats).toBeNull();
	});

	it("is HEIGHT-NEUTRAL on a collapsed AND an expanded card", async () => {
		// The figure rides the card's already-fixed header row as one nowrap span. If it
		// ever reached the height math, a Write/Edit card would be a different height
		// from every other card in the same run.
		const { measureToolCall } = await mod();
		const detail: import("./measure-tool-call").ToolDetailData = {
			kind: "sections",
			sections: [{ key: "output.main", body: bodyFixture({ cap: "term", text: "a\nb\nc\nd" }) }],
		};
		for (const opts of [{}, { opened: true }] as const) {
			const bare = measureToolCall(baseCard({ detail }), 600, 4, opts);
			for (const diffStats of [
				{ added: 0, removed: 0 },
				{ added: 1, removed: 1 },
				// The widest realistic pair; it must not wrap the header.
				{ added: 4820, removed: 3910 },
			]) {
				const counted = measureToolCall(baseCard({ detail, diffStats }), 600, 4, opts);
				expect(counted.height).toBe(bare.height);
				expect(counted.headerHeight).toBe(bare.headerHeight);
				expect(counted.collapsedHeight).toBe(bare.collapsedHeight);
			}
		}
	});

	it("stays height-neutral at a narrow width, where the header is tightest", async () => {
		// A phone-width card is where a non-shrinking figure could plausibly push the
		// header into a second line; it must not.
		const { measureToolCall } = await mod();
		for (const width of [280, 360, 512]) {
			const bare = measureToolCall(baseCard({ summary: "a".repeat(120) }), width, 4);
			const counted = measureToolCall(
				baseCard({ summary: "a".repeat(120), diffStats: { added: 4820, removed: 3910 } }),
				width,
				4,
			);
			expect(counted.height).toBe(bare.height);
			expect(counted.headerHeight).toBe(bare.headerHeight);
		}
	});
});

// ── Structural MeasuredElement contract ───────────────────────────────────────
describe("measureToolCall — MeasuredElement shape", () => {
	it("returns a well-formed MeasuredElement (blocks/frame/contentWidth/usedWidth)", async () => {
		const { measureToolCall } = await mod();
		const r = measureToolCall(baseCard(), 600, 5);
		expect(r.blocks.length).toBeGreaterThan(0);
		expect(r.blocks[0]?.kind).toBe("fixed");
		expect(r.frame.blocks.length).toBe(r.blocks.length);
		expect(r.usedWidth).toBe(600);
		expect(r.contentWidth).toBeLessThan(600); // inner width < outer
	});

	it("re-measures the same tool data across widths/LODs", async () => {
		const { measureToolCall } = await mod();
		const data = baseCard({
			category: "tasks",
			detail: {
				kind: "sections",
				sections: [
					{
						key: "meta.spec-tasks",
						body: { kind: "spec-tasks", tasks: specTasks("x".repeat(80)) },
					},
				],
			},
		});
		const collapsed = measureToolCall(data, 600, 3);
		const wide = measureToolCall(data, 2000, 5);
		const narrow = measureToolCall(data, 160, 5);
		expect(collapsed.effectiveOpened).toBe(false);
		expect(narrow.height).toBeGreaterThan(wide.height);
	});
});

function bodyFixture(
	options: Partial<import("@shared/pretext-layout/tool-detail").ToolCappedDetail> &
		Pick<import("@shared/pretext-layout/tool-detail").ToolCappedDetail, "cap">,
): import("@shared/pretext-layout/tool-detail").ToolCappedDetail {
	return {
		kind: "capped",
		id: "test-body",
		source: "output.main",
		format: "text",
		live: false,
		followTarget: { kind: "end" },
		...options,
	};
}
