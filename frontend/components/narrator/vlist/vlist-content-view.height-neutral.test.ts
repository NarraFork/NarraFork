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
import type { ToolCappedDetail } from "@shared/pretext-layout/tool-detail";
import { DETAIL_TOP_MARGIN, measureToolBody, measureToolDetail } from "./measure/measure-tool-call";
import { installCanvasStub } from "./measure/test-canvas-stub";
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
		const src = read("PretextExactMessageList.tsx");
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
		const shell = read("PretextExactMessageList.tsx");
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
	it("pins the source box to the measured height and scrolls the overflow", () => {
		const src = read("render/RenderMarkdown.tsx");
		const start = src.indexOf("function MarkdownSourceBody(");
		expect(start).toBeGreaterThan(-1);
		// Up to the next top-level declaration — the destructured params contain their
		// own `\n}`, so the closing brace alone is not a reliable terminator.
		const body = src.slice(start, src.indexOf("\n/**", start));
		// Height comes from the caller (the measured frame), never from the content.
		expect(body).toContain("height,");
		expect(body).toContain('overflowY: "auto"');
		// The source is pre-wrap, so horizontal overflow is a paint artifact, never
		// content — the wrapped state of every body box is `overflowX: hidden`.
		expect(body).toContain('overflowX: "hidden"');
		// No growth escape hatches: either of these would let the text set the height.
		expect(body).not.toContain("minHeight");
		expect(body).not.toContain("maxHeight");
	});

	it("hands the box the measured content height, not an intrinsic one", () => {
		const src = read("render/RenderMarkdown.tsx");
		expect(src).toMatch(
			/<MarkdownSourceBody[\s\S]{0,160}height=\{frame\.contentHeight\}[\s\S]{0,40}\/>/,
		);
	});

	it("wires the row's source state without touching the layout inputs", () => {
		const shell = read("PretextExactMessageList.tsx");
		// The toggle is read from the viewer controls (pure render state) and handed to
		// the renderer through `extra` — the same channel every other render-only prop
		// uses. `resolveItemViewTargets` decides ELIGIBILITY from the measured form.
		expect(shell).toContain("rowViewTarget?.sourceInline && viewControls?.isSourceShown(");
		expect(shell).toContain("extra.showSource = true");
		expect(shell).toContain("function canShowRowSourceInline(");
	});
});
