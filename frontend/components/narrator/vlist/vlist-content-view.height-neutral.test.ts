/**
 * vlist-content-view.height-neutral.test.ts — the fullscreen viewer must be
 * invisible to the height model.
 *
 * Two ways it could leak into geometry, both pinned here:
 *
 *  1. The RAW SOURCE the viewer needs for a markdown body (plan / skill /
 *     knowledge) is carried as a plain output field (`sourceText`). Had it been
 *     added as a zero-height block instead, it would have broken the
 *     `blocks[i] ↔ frame.blocks[i]` invariant, shifted `blockStart/blockCount`
 *     slices and moved the `detail-plan-source` lookups. This asserts the block
 *     list and every frame offset are untouched.
 *  2. The per-body wrap / source toggles live in the SHELL's render state, never
 *     in `VListInteractionState` (which feeds `computeLayout`). A source-level
 *     guard keeps them out of the layout options, because a unit test on the pure
 *     functions could not notice them being wired in.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MantineProvider } from "@mantine/core";
import type { ToolCappedDetail } from "@shared/pretext-layout/tool-detail";
import { parseHTML } from "linkedom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { shellSource } from "./guard-source";
import { measureMarkdown } from "./measure/measure-markdown";
import { DETAIL_TOP_MARGIN, measureToolBody, measureToolDetail } from "./measure/measure-tool-call";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { RenderMarkdown } from "./render/RenderMarkdown";
import { sliceBracketedRegion } from "./source-slice";
import { resolveToolDetailViewTargets } from "./vlist-content-view-target";

const disposeCanvas = installCanvasStub();
afterAll(disposeCanvas);
const MODEL: ToolCappedDetail = {
	kind: "capped",
	id: "call:input.plan",
	source: "input.plan",
	cap: "plan",
	format: "markdown",
	live: false,
	followTarget: { kind: "end" },
	text: "# Plan\n\n- do work",
};

const VLIST_DIR = import.meta.dir;

function read(relativePath: string): string {
	return readFileSync(join(VLIST_DIR, relativePath), "utf8");
}

describe("sourceText is a pure output field", () => {
	it("is never emitted as a block or a frame entry", () => {
		const src = read("measure/measure-tool-call.ts");
		// Every `sourceText` mention must be a type declaration, a plain object
		// field, or a comment — never a makeFixed / frameBlocks.push argument.
		for (const line of src.split("\n")) {
			if (!line.includes("sourceText")) continue;
			expect(line).not.toContain("makeFixed");
			expect(line).not.toContain("frameBlocks.push");
			expect(line).not.toContain("blocks.push");
		}
	});

	it("target extraction preserves the exact measured height and frame", () => {
		const detail = measureToolDetail(
			{ kind: "sections", sections: [{ key: MODEL.source, body: MODEL }] },
			600,
		);
		const section = detail.sections[0];
		if (!section) throw new Error("missing measured section");
		const geometry = JSON.stringify([
			detail.height,
			section.bodyHeight,
			section.measuredBody.frame,
		]);
		const [target] = resolveToolDetailViewTargets("owner", { detail });
		expect(target?.model).toBe(MODEL);
		expect(target?.text).toBe(MODEL.text ?? "");
		expect(JSON.stringify([detail.height, section.bodyHeight, section.measuredBody.frame])).toBe(
			geometry,
		);
	});

	it("sections keep body-local frames and add their own chrome only once", () => {
		const body = measureToolBody(MODEL, 600);
		const detail = measureToolDetail(
			{ kind: "sections", sections: [{ key: MODEL.source, body: MODEL }] },
			600,
		);
		const section = detail.sections[0];
		expect(section?.bodyTop).toBe(DETAIL_TOP_MARGIN);
		expect(section?.measuredBody.frame).toEqual(body.frame);
		expect(section?.bodyHeight).toBe(body.height);
		expect(detail.height).toBe(DETAIL_TOP_MARGIN + body.height);
		expect(section?.measuredBody.blocks.length).toBe(body.frame.blocks.length);
	});
});

describe("wrap / source toggles stay out of the measure path", () => {
	it("are not part of VListInteractionState", () => {
		const src = read("vlist-interaction-state.ts");
		expect(src).not.toContain("viewWrap");
		expect(src).not.toContain("viewShowSource");
	});

	it("never reach the layout options the document is built from", () => {
		const src = shellSource();
		// Brace-matched: a hardcoded `"\n\t});"` end sentinel assumed one tab of
		// indentation and broke when the shell was re-indented (see source-slice.ts).
		const options = sliceBracketedRegion(src, "usePretextDocument(narratorId, {");
		if (options === null) throw new Error("usePretextDocument(narratorId, { … }) not found");
		expect(options).not.toContain("viewWrap");
		expect(options).not.toContain("viewShowSource");
	});

	it("only feed the row memo signature", () => {
		// The state lives in the hook; `viewStateSig` is its ONLY reader there.
		const hook = read("useVListContentView.ts");
		expect(hook).toContain("viewStateSig(");
		// And the shell consumes it in exactly one place: the row's interaction sig.
		const shell = shellSource();
		const consumers = shell.split("\n").filter((line) => line.includes("contentView.rowSig("));
		expect(consumers).toHaveLength(1);
		expect(consumers[0]).toContain("interactionSig");
	});
});

/**
 * A plain content row's source view is the one place a source toggle reaches a
 * body whose height was measured from the RENDERED markdown. The two forms wrap to
 * different line counts, so the raw text must go into a box pinned to the measured
 * height — otherwise flipping the toggle resizes a committed row, which is exactly
 * the invariant the whole exact path is built on.
 */
describe("a plain row's source view cannot resize the row", () => {
	function sourceBody(markdown: string, sourceText: string) {
		const measured = measureMarkdown(markdown, 600);
		const html = renderToStaticMarkup(
			createElement(
				MantineProvider,
				null,
				createElement(RenderMarkdown, { measured, showSource: true, sourceText }),
			),
		);
		const document = parseHTML(`<html><body>${html}</body></html>`).document;
		const body = document.querySelector("[data-vlist-markdown-source]");
		if (!body) throw new Error("source body was not rendered");
		return { measured, body, style: body.getAttribute("style") ?? "" };
	}

	it("pins the source box to the measured height and scrolls the overflow", () => {
		const text = "a long source line\n".repeat(1000);
		const { measured, body, style } = sourceBody("# Short heading", text);
		expect(style).toContain(`height:${measured.frame.contentHeight}px`);
		expect(style).toContain("overflow-y:auto");
		expect(style).toContain("overflow-x:hidden");
		expect(style).not.toContain("min-height");
		expect(style).not.toContain("max-height");
		expect(body.textContent).toBe(text);
	});

	it("uses measured height even when rendered Markdown hosts an unpredictable diagram", () => {
		const { measured, style } = sourceBody(
			"```mermaid\ngraph TD; A-->B;\n```",
			"diagram source\n".repeat(1000),
		);
		expect(measured.blocks.some((block) => block.kind === "unknown")).toBe(true);
		expect(style).toContain(`height:${measured.frame.contentHeight}px`);
		expect(style).toContain("overflow-y:auto");
		expect(style).not.toContain("min-height");
	});

	it("wires the row's source state without touching the layout inputs", () => {
		const shell = shellSource();
		// The toggle is read from the viewer controls (pure render state) and handed to
		// the renderer through `extra` — the same channel every other render-only prop
		// uses. `resolveItemViewTargets` decides ELIGIBILITY from the measured form.
		expect(shell).toContain("rowViewTarget?.sourceInline && viewControls?.isSourceShown(");
		expect(shell).toContain("extra.showSource = true");
		expect(shell).toContain("function canShowRowSourceInline(");
	});
});
