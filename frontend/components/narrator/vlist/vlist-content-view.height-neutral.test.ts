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

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

	it("the markdown capped branch reports the same height with the field present", () => {
		const src = read("measure/measure-tool-call.ts");
		const branch = src.slice(
			src.indexOf("if (detail.markdown && detail.text != null"),
			src.indexOf("const hasLabel = detail.hasLabel"),
		);
		expect(branch.length).toBeGreaterThan(0);
		// The height still comes straight from measureMarkdownDetail's result.
		expect(branch).toContain("height: md.height");
		expect(branch).toContain("sourceText: detail.text");
	});

	it("a section only copies the string; the y accumulator is untouched", () => {
		const src = read("measure/measure-tool-call.ts");
		const push = src.slice(
			src.indexOf("sections.push({"),
			src.indexOf("if (blocks.length === 0) {", src.indexOf("sections.push({")),
		);
		expect(push).toContain("sourceText: body.sourceText");
		// No arithmetic on the accumulator inside the descriptor literal.
		expect(push).not.toContain("y +=");
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
		const start = src.indexOf("const pretextDocument = usePretextDocument(");
		expect(start).toBeGreaterThan(-1);
		// The whole options object literal, up to the call's closing `});`.
		const end = src.indexOf("\n\t});", start);
		expect(end).toBeGreaterThan(start);
		const options = src.slice(start, end);
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
