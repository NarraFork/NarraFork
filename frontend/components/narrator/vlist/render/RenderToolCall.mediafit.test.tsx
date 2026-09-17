/**
 * RenderToolCall.mediafit.test.tsx — MEASURE ↔ PAINT parity for a tool card's
 * media detail (screenshots, image Reads): real classifier → real measure → real
 * render, asserting the box the `<img>` lands in is EXACTLY the box the measure
 * layer reserved.
 *
 * ## The bug this locks down
 *
 * `mediaContentPx` reserves `fitImageBox(...).displayHeight` — the aspect fit of
 * the intrinsic dimensions into (availableWidth × 400 cap). But the measured
 * block only carried `media`, never the fit's two dimensions, and `VListImage`
 * requires BOTH to be positive before it paints in "exact" mode. So every media
 * detail fell into the LEGACY branch: a `width: 100%` box with the image
 * centred, whose painted height the browser derives from the box WIDTH.
 *
 * For a landscape screenshot that is accidentally identical (width is the binding
 * constraint either way). For a TALL one it is not: the fit clamps the height at
 * the 400px cap and narrows the width to keep the ratio, while the legacy box
 * spans the full column and paints `boxWidth × h/w` — a 720×1280 capture in a
 * 578px column paints ~1027px into a 400px reservation, and the excess is
 * silently clipped by the box's `overflow: hidden`. That is CONTRACT §0 铁律 2
 * ("measured height must equal painted height") failing with no error anywhere.
 *
 * Both orientations are covered, because a fix that only handles the tall case
 * would pass a portrait-only test while regressing landscape.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageViewerProvider } from "../../../common/ImageViewerProvider";
import { segmentMessages } from "../../message/message-segments";
import type { NarratorMsg } from "../../narrator-panel-types";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { VLIST_REGISTRY } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";
import { type AdapterContext, type AdapterSegment, adaptSegments } from "../segment-adapter";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

let parse: (html: string) => Element;

beforeAll(() => {
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

const CONTENT_WIDTH = 800;
/** LOD 5 expands every card, so the detail region (and its image) is painted. */
const CTX: AdapterContext = { lod: 5, resolveToolCategory: () => "browser" };

/** A completed Browser screenshot call, in the shape the backend really sends. */
function screenshotMessage(width: number, height: number): NarratorMsg {
	const inputJson = { action: "screenshot", session_id: "s1" };
	const outputJson = {
		_text: `Screenshot captured (${width}x${height})`,
		_metadata: {
			sessionId: "s1",
			screenshotPreview: true,
			// A data-url resolves synchronously, so no blob fetch is needed here.
			previewUrl: "data:image/png;base64,iVBORw0KGgo=",
			width,
			height,
		},
	};
	return {
		id: "a-shot",
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [
			{
				type: "tool_use",
				id: "tu-shot",
				name: "Browser",
				input: inputJson,
				inputJson,
				outputJson,
				status: "completed",
			},
		],
		contentText: null,
		toolCalls: [
			{
				toolUseId: "tu-shot",
				toolName: "Browser",
				inputJson,
				outputJson,
				status: "completed",
			},
		],
		createdAt: "2026-01-01T00:00:00Z",
		children: [],
	} as unknown as NarratorMsg;
}

interface MediaPaint {
	/** The fitted box the measure layer reserved (from the measured block data). */
	reserved: { displayWidth: unknown; displayHeight: unknown };
	/** The inline style of the box the `<img>` actually landed in. */
	boxStyle: string;
	/** The detail region's own available (inner) width. */
	innerWidth: number;
}

/** Drive classifier → measure → render and report both sides of the contract. */
function paintScreenshot(width: number, height: number): MediaPaint {
	const segments = segmentMessages([
		screenshotMessage(width, height),
	]) as unknown as AdapterSegment[];
	const specs = adaptSegments(segments, CTX);
	const spec = specs.find((s) => s.kind === "tool-call" || s.kind === "tool-call-group");
	if (!spec) throw new Error(`no tool-call spec, got: ${specs.map((s) => s.kind).join(",")}`);
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
	const detail = (measured as import("../measure/measure-tool-call").MeasuredToolCall).detail;
	if (!detail) throw new Error("no measured detail region");
	const body = detail.sections.find(
		(section) =>
			section.measuredBody.model.kind === "capped" && section.measuredBody.model.format === "media",
	)?.measuredBody;
	const block = body?.blocks[0];
	const mediaBlock = block?.kind === "fixed" ? block : undefined;
	if (!mediaBlock?.data) throw new Error("no media block in the measured detail");

	const extra = resolveRenderExtra(spec);
	extra.narratorId = "n1";
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	const root = parse(
		renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<MantineProvider forceColorScheme="dark">
					<ImageViewerProvider>{renderElement(spec.kind, measured, extra)}</ImageViewerProvider>
				</MantineProvider>
			</QueryClientProvider>,
		),
	);
	const img = root.querySelector("img");
	if (!img?.parentElement) throw new Error("no <img> reached the DOM");
	return {
		reserved: {
			displayWidth: mediaBlock.data.displayWidth,
			displayHeight: mediaBlock.data.displayHeight,
		},
		boxStyle: img.parentElement.getAttribute("style") ?? "",
		innerWidth: detail.contentWidth,
	};
}

describe("tool-card media: painted box equals reserved box", () => {
	it("a HEIGHT-CAPPED tall screenshot paints the narrowed fitted box, not full width", () => {
		// 720×1280 portrait. Width-limited height would be innerWidth*1280/720 (well
		// past the 400 cap), so the cap binds and the WIDTH is what shrinks.
		const { reserved, boxStyle, innerWidth } = paintScreenshot(720, 1280);
		const expectedHeight = 400; // DETAIL_CAPS.media
		const expectedWidth = Math.floor((expectedHeight * 720) / 1280); // 225
		expect(reserved.displayHeight).toBe(expectedHeight);
		expect(reserved.displayWidth).toBe(expectedWidth);
		// The premise of the whole test: the fitted width is narrower than the
		// column, so a full-width legacy box CANNOT paint the reserved height.
		expect(expectedWidth).toBeLessThan(innerWidth);

		// (linkedom serializes styles without a space after the colon.)
		expect(boxStyle).toContain(`width:${expectedWidth}px`);
		expect(boxStyle).toContain(`height:${expectedHeight}px`);
		// The exact regression: the legacy branch's box is `width: 100%`, letting the
		// browser derive a height of innerWidth*1280/720 ≈ 2.5× the reservation.
		// Anchored so the legitimate `max-width:100%` does not satisfy it.
		expect(boxStyle).not.toMatch(/(^|;)width:100%/);
	});

	it("a WIDTH-DOMINATED wide screenshot paints the same fitted box", () => {
		// 1200×400 (3:1): at this column the width is the binding constraint, so the
		// fitted height lands UNDER the cap and the box spans the full inner width.
		// This orientation was accidentally correct before the fix (a full-width
		// legacy box paints the same height); pin it so a future change cannot trade
		// one orientation for the other.
		const { reserved, boxStyle, innerWidth } = paintScreenshot(1200, 400);
		const expectedHeight = Math.floor((innerWidth * 400) / 1200);
		expect(reserved.displayWidth).toBe(innerWidth);
		expect(reserved.displayHeight).toBe(expectedHeight);
		// The premise: this really is the width-dominated branch.
		expect(expectedHeight).toBeLessThan(400);

		expect(boxStyle).toContain(`width:${innerWidth}px`);
		expect(boxStyle).toContain(`height:${expectedHeight}px`);
	});

	it("a DIMENSIONLESS screenshot keeps the legacy full-width placeholder box", () => {
		// No intrinsic dimensions → nothing to fit, so the fixed fallback height and
		// the centred full-width box remain correct (and are what measure reserved).
		const inputJson = { action: "screenshot", session_id: "s1" };
		const outputJson = {
			_text: "Screenshot captured",
			_metadata: {
				sessionId: "s1",
				screenshotPreview: true,
				previewUrl: "data:image/png;base64,iVBORw0KGgo=",
			},
		};
		const msg = {
			...screenshotMessage(1, 1),
			contentJson: [
				{
					type: "tool_use",
					id: "tu-shot",
					name: "Browser",
					input: inputJson,
					inputJson,
					outputJson,
					status: "completed",
				},
			],
			toolCalls: [
				{ toolUseId: "tu-shot", toolName: "Browser", inputJson, outputJson, status: "completed" },
			],
		} as unknown as NarratorMsg;
		const segments = segmentMessages([msg]) as unknown as AdapterSegment[];
		const specs = adaptSegments(segments, CTX);
		const spec = specs.find((s) => s.kind === "tool-call" || s.kind === "tool-call-group");
		if (!spec) throw new Error("no tool-call spec");
		const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
		const extra = resolveRenderExtra(spec);
		extra.narratorId = "n1";
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: 0 } },
		});
		const root = parse(
			renderToStaticMarkup(
				<QueryClientProvider client={queryClient}>
					<MantineProvider forceColorScheme="dark">
						<ImageViewerProvider>{renderElement(spec.kind, measured, extra)}</ImageViewerProvider>
					</MantineProvider>
				</QueryClientProvider>,
			),
		);
		const box = root.querySelector("img")?.parentElement;
		expect(box?.getAttribute("style")).toContain("width:100%");
		expect(box?.getAttribute("style")).toContain("height:200px");
	});
});
