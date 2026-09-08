/**
 * RenderToolCall.sectionwidth.test.tsx — a section's MARKDOWN body must be painted
 * at the width its line breaking used, not at the section's available width.
 *
 * ## The bug this locks down
 *
 * A markdown section body is measured by `measureMarkdownDetail`, which wraps the
 * text at `availableWidth - DETAIL_BOX_CHROME_X` because the body lives inside a
 * scroll box with `padding: 2px 6px`. Every OTHER body kind is measured at the
 * full `availableWidth`. `SectionBody` used to rebuild the inner measured object
 * with `contentWidth: availableWidth` for all of them, so a markdown body was
 * painted 12px WIDER than the box that contains it:
 *
 *     box content area : availableWidth - 12
 *     painted host     : availableWidth        ← 12px of horizontal overflow
 *
 * `overflow: auto` then produced a horizontal scrollbar on every markdown section
 * body, scrolling 12px of nothing. On a SHORT body the damage is total rather than
 * cosmetic: a one-line output reserves a 24px box, and a ~12px scrollbar covers
 * essentially all of it — the reader sees a scrollbar where the text should be.
 * That is what a failed `WebSearch` card looked like ("output" → one error line).
 *
 * It was also a height-model violation independent of the scrollbar: painting at a
 * wider width lets `RenderMarkdown` re-wrap the text into FEWER lines than the
 * height was predicted from (CONTRACT §0 iron law 2 — the rendered geometry must
 * be the predicted geometry).
 *
 * The assertions run the real measure → render chain and read the painted host's
 * inline width, so a regression to `availableWidth` fails here.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installCanvasStub } from "../measure/test-canvas-stub";

let measureMod: typeof import("../measure/measure-tool-call");
let RenderToolCall: typeof import("./RenderToolCall").RenderToolCall;

beforeAll(async () => {
	installCanvasStub();
	measureMod = await import("../measure/measure-tool-call");
	RenderToolCall = (await import("./RenderToolCall")).RenderToolCall;
});

const CONTENT_WIDTH = 600;

function textBody(
	text: string,
	markdown = false,
): import("@shared/pretext-layout/tool-detail").ToolCappedDetail {
	return {
		kind: "capped",
		cap: "code",
		id: "call:output.main",
		source: "output.main",
		format: markdown ? "markdown" : "code",
		live: false,
		followTarget: { kind: "end" },
		text,
	};
}

type ToolDetailSection = import("../measure/measure-tool-call").ToolDetailSection;

/** A failed WebSearch's real shape: a query meta row + a markdown output section. */
function markdownOutputSections(text: string): ToolDetailSection[] {
	return [
		{ key: "meta.query", body: { kind: "meta-rows", rows: [{ text: "some query", mono: true }] } },
		{
			key: "output.main",
			label: "output",
			body: textBody(text, true),
		},
	];
}

function measureCard(sections: ToolDetailSection[]) {
	return measureMod.measureToolCall(
		{
			toolName: "WebSearch",
			summary: "web search",
			category: "webSearch",
			status: "fail",
			detail: { kind: "sections", sections },
		},
		CONTENT_WIDTH,
		5,
	);
}

function render(node: ReactNode): Element {
	const html = renderToStaticMarkup(
		<MantineProvider forceColorScheme="dark">{node}</MantineProvider>,
	);
	const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
	return document.getElementById("r") as unknown as Element;
}

/** Every `overflow` scroll box paired with the width of its painted child. */
function scrollBoxes(root: Element): Array<{ style: string; childWidth: number | null }> {
	const out: Array<{ style: string; childWidth: number | null }> = [];
	for (const el of Array.from(root.querySelectorAll("[data-content-scrollport]"))) {
		const style = el.getAttribute("style") ?? "";
		if (!/overflow(-[xy])?:\s*(auto|hidden)/.test(style) || !/overflow-y:\s*auto/.test(style))
			continue;
		const child = el.querySelector("[data-tool-markdown]");
		const childStyle = child?.getAttribute("style") ?? "";
		const match = /(?:^|;)\s*width:\s*([\d.]+)px/.exec(childStyle);
		out.push({ style, childWidth: match ? Number(match[1]) : null });
	}
	return out;
}

/** Wrap controls pinned to one state, so a body's axis policy is observable. */
function wrapControls(isWrapped: boolean): import("../VListContentViewHost").VListViewControls {
	return {
		isWrapped: () => isWrapped,
		isSourceShown: () => false,
		toggleWrap: () => {},
		toggleSource: () => {},
		openFullscreen: () => {},
	};
}

describe("a section's markdown body is painted at its wrap width", () => {
	it("never paints the host wider than the scroll box's content area", () => {
		const measured = measureCard(markdownOutputSections("Search error: Tool returned no results"));
		const boxes = scrollBoxes(render(<RenderToolCall measured={measured} />));
		// The card has exactly one markdown scroll box (the output section).
		const withChild = boxes.filter((b) => b.childWidth != null);
		expect(withChild).toHaveLength(1);

		const detailWidth = measured.detail?.contentWidth ?? 0;
		expect(detailWidth).toBeGreaterThan(0);
		// The box is `box-sizing: border-box` with `DETAIL_BOX_PADDING_X` per side, so
		// this is the width available to its content.
		const boxContentWidth = detailWidth - measureMod.DETAIL_BOX_CHROME_X;
		expect(withChild[0]?.childWidth).toBe(boxContentWidth);
		// The exact regression: the old code used the section's available width.
		expect(withChild[0]?.childWidth).not.toBe(detailWidth);
	});

	it("keeps the measured wrap width and the painted width identical", () => {
		// Two bodies whose wrapped line counts differ, so a width mismatch would show
		// up as a height mismatch too.
		for (const text of [
			"Search error: Tool returned no results",
			`Search error: no results for ${"a-long-token ".repeat(14)}end`,
		]) {
			const measured = measureCard(markdownOutputSections(text));
			const section = measured.detail?.sections?.at(-1);
			expect(section?.measuredBody.markdown).toBe(true);
			// What the measure layer wrapped at IS what the render layer paints at.
			const boxes = scrollBoxes(render(<RenderToolCall measured={measured} />));
			const painted = boxes.find((b) => b.childWidth != null)?.childWidth;
			expect(painted).toBe(section?.measuredBody.contentWidth);
		}
	});

	it("reports a markdown section's wrap width as narrower than the section width", () => {
		// The premise of the whole file. If these ever became equal, the fix above
		// would be a no-op and the test would silently stop protecting anything.
		const measured = measureCard(markdownOutputSections("one line"));
		const section = measured.detail?.sections?.at(-1);
		expect(section?.measuredBody.contentWidth).toBe(
			(measured.detail?.contentWidth ?? 0) - measureMod.DETAIL_BOX_CHROME_X,
		);
	});

	it("leaves a NON-markdown section body at the full section width", () => {
		// A plain capped body is measured at `availableWidth` (its own scroll box adds
		// the padding around already-wrapped text), so narrowing every section would
		// have been the mirror-image bug.
		const measured = measureCard([
			{ key: "output.main", label: "output", body: textBody("plain") },
		]);
		const section = measured.detail?.sections?.at(-1);
		expect(section?.measuredBody.markdown).toBeUndefined();
		expect(section?.measuredBody.contentWidth).toBe(measured.detail?.contentWidth);
	});
});

/**
 * The second half of the fix: a WRAPPED body never needs horizontal scrolling, so
 * its box must not offer it. With both axes on `overflow: auto`, ANY horizontal
 * overflow summons a scrollbar — and a short body has real overflow sources that
 * are NOT content: a wrap point keeps its trailing space, and the fragments paint
 * with `white-space: pre`, so the line's max-content is a few px wider than the
 * reserved width. The result was a ~12px bar covering almost all of a ~24px box —
 * the failed WebSearch card from the bug report.
 *
 * The policy is the chunked ContentViewer's own (`wrapStyle`): wrapped →
 * `overflowX: hidden`, unwrapped → `overflowX: auto`.
 */
describe("a wrapped body box never offers horizontal scrolling", () => {
	it("the markdown output box scrolls vertically only", () => {
		const measured = measureCard(markdownOutputSections("Search error: Tool returned no results"));
		const boxes = scrollBoxes(render(<RenderToolCall measured={measured} />));
		expect(boxes).toHaveLength(1);
		expect(boxes[0]?.style).toContain("overflow-y:auto");
		expect(boxes[0]?.style).toContain("overflow-x:hidden");
	});

	it("a WRAPPED plain capped body hides the horizontal axis", () => {
		const measured = measureCard([
			{ key: "output.main", label: "output", body: textBody("plain") },
		]);
		const targets = [
			{
				id: "call:output.main",
				slot: "output.main",
				owner: { specKey: "tool-x" },
				kind: "code" as const,
				text: "plain",
			},
		];
		const boxes = scrollBoxes(
			render(
				<RenderToolCall
					measured={measured}
					viewTargets={targets}
					viewControls={wrapControls(true)}
				/>,
			),
		);
		expect(boxes).toHaveLength(1);
		expect(boxes[0]?.style).toContain("overflow-y:auto");
		expect(boxes[0]?.style).toContain("overflow-x:hidden");
	});

	it("an UNWRAPPED plain capped body keeps its horizontal scrollbar", () => {
		// The policy must not overshoot: with wrap off the reader scrolled
		// horizontally ON PURPOSE, and the whole point of `pre` is long lines.
		const measured = measureCard([
			{ key: "output.main", label: "output", body: textBody("plain") },
		]);
		const targets = [
			{
				id: "call:output.main",
				slot: "output.main",
				owner: { specKey: "tool-x" },
				kind: "code" as const,
				text: "plain",
			},
		];
		const boxes = scrollBoxes(
			render(
				<RenderToolCall
					measured={measured}
					viewTargets={targets}
					viewControls={wrapControls(false)}
				/>,
			),
		);
		expect(boxes).toHaveLength(1);
		expect(boxes[0]?.style).toContain("overflow-y:auto");
		expect(boxes[0]?.style).toContain("overflow-x:auto");
	});
});
