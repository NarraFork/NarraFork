/**
 * RenderToolCall.sectiontargets.test.tsx — a `sections` detail must route each
 * section to its OWN view target, by SLOT and never by array index.
 *
 * ## The bug this locks down
 *
 * `resolveDetailViewTargets` pushes CONDITIONALLY: a section whose body yields no
 * readable target contributes nothing to the array. Error text, a label-only row
 * and a media placeholder all return null from `markdownTarget` / `targetFromBlock`,
 * so the target list is SPARSE relative to the section list:
 *
 *     sections: [ error , capped(truncated) ]     ← 2 sections
 *     targets : [ {slot:"s1", truncated:true} ]   ← 1 target, addressed as s1
 *
 * Reading `viewTargets[sectionIndex]` therefore handed section 0 (the error line)
 * the target that belongs to section 1, and left section 1 — the actual output —
 * with `undefined`. The `sN` slot ids exist precisely to survive this sparseness,
 * so the lookup has to go through `findViewTarget(viewTargets, sectionSlot(i))`.
 *
 * ## Why it is not merely cosmetic
 *
 * The misrouted section loses its hover action bar (wrap / source / fullscreen),
 * and because the "content truncated, click to load" notice row is gone,
 * `viewTarget.truncated` is now the ONLY gate that can fetch the bytes the server
 * withheld. A `{ error, output }` card — a failed tool that still produced output,
 * a denied permission followed by a plan — could never load its real body again.
 *
 * The assertions run the real measure → resolve → render chain and observe which
 * target each section's renderer actually consults, so a future regression to
 * index addressing fails here rather than silently in production.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installCanvasStub } from "../measure/test-canvas-stub";

let measureMod: typeof import("../measure/measure-tool-call");
let targetMod: typeof import("../vlist-content-view-target");
let RenderToolCall: typeof import("./RenderToolCall").RenderToolCall;

beforeAll(async () => {
	// Section bodies are pretext-measured (canvas measureText).
	installCanvasStub();
	measureMod = await import("../measure/measure-tool-call");
	targetMod = await import("../vlist-content-view-target");
	RenderToolCall = (await import("./RenderToolCall")).RenderToolCall;
});

const CONTENT_WIDTH = 600;
const SPEC_KEY = "tool-x";

type ToolDetailSection = import("../measure/measure-tool-call").ToolDetailSection;
type VListViewTarget = import("../vlist-content-view-target").VListViewTarget;
type VListViewControls = import("../VListContentViewHost").VListViewControls;

function measureSectionsCard(sections: ToolDetailSection[]) {
	return measureMod.measureToolCall(
		{
			toolName: "Bash",
			summary: "failed but produced output",
			category: "bash",
			status: "fail",
			detail: { kind: "sections", sections },
		},
		CONTENT_WIDTH,
		6,
	);
}

/**
 * View controls that RECORD every target their renderer asks about.
 *
 * `SectionBody` calls `isWrapped(viewTarget)` while rendering a capped body, so
 * the recorded ids are exactly the targets that reached a section — which is the
 * routing decision under test. A section handed `undefined` records nothing.
 */
function recordingControls(): { controls: VListViewControls; seen: VListViewTarget[] } {
	const seen: VListViewTarget[] = [];
	const controls: VListViewControls = {
		isWrapped: (target) => {
			seen.push(target);
			return true;
		},
		isSourceShown: (target) => {
			seen.push(target);
			return false;
		},
		toggleWrap: () => {},
		toggleSource: () => {},
		openFullscreen: () => {},
	};
	return { controls, seen };
}

function render(node: ReactNode): Element {
	const html = renderToStaticMarkup(
		<MantineProvider forceColorScheme="dark">{node}</MantineProvider>,
	);
	const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
	return document.getElementById("r") as unknown as Element;
}

/** Distinct ids of the targets that reached a section renderer, in first-seen order. */
function seenIds(seen: VListViewTarget[]): string[] {
	return [...new Set(seen.map((t) => t.id))];
}

describe("sections detail — view targets are addressed by slot", () => {
	/** `{ error, output }`: the shape whose target list is sparse. */
	const errorThenOutput: ToolDetailSection[] = [
		{ label: "error", body: { kind: "error", text: "boom" } },
		{
			label: "result",
			body: {
				kind: "capped",
				cap: "code",
				contentLines: 2,
				text: "prefix bytes",
				textTruncated: true,
			},
		},
	];

	it("resolves a sparse target list whose slot does not match its array index", () => {
		// The premise of the whole file: section 1's target sits at array index 0,
		// because the error section produced none.
		const measured = measureSectionsCard(errorThenOutput);
		const targets = targetMod.resolveToolDetailViewTargets(SPEC_KEY, measured);
		expect(targets.map((t) => t.slot)).toEqual([targetMod.sectionSlot(1)]);
		expect(targets[0]?.truncated).toBe(true);
	});

	it("gives the truncated output section its own target, not undefined", () => {
		const measured = measureSectionsCard(errorThenOutput);
		const targets = targetMod.resolveToolDetailViewTargets(SPEC_KEY, measured);
		const { controls, seen } = recordingControls();
		render(<RenderToolCall measured={measured} viewTargets={targets} viewControls={controls} />);
		// Index addressing recorded NOTHING here: the error section (which paints no
		// capped body and so never consults a target) swallowed `targets[0]`, and the
		// output section got `undefined`.
		expect(seenIds(seen)).toEqual([`${SPEC_KEY}:${targetMod.sectionSlot(1)}`]);
		// And that target must be the truncated one — the flag is the only remaining
		// gate for fetching the withheld bytes.
		expect(seen[0]?.truncated).toBe(true);
	});

	it("keeps each section on its own target when several sections have one", () => {
		const measured = measureSectionsCard([
			{ label: "command", body: { kind: "capped", cap: "code", contentLines: 1, text: "ls -la" } },
			{ label: "error", body: { kind: "error", text: "boom" } },
			{
				label: "output",
				body: {
					kind: "capped",
					cap: "term",
					contentLines: 3,
					text: "partial output",
					textTruncated: true,
				},
			},
		]);
		const targets = targetMod.resolveToolDetailViewTargets(SPEC_KEY, measured);
		// s0 and s2: the middle (error) section again contributes nothing.
		expect(targets.map((t) => t.slot)).toEqual([
			targetMod.sectionSlot(0),
			targetMod.sectionSlot(2),
		]);
		const { controls, seen } = recordingControls();
		render(<RenderToolCall measured={measured} viewTargets={targets} viewControls={controls} />);
		expect(seenIds(seen)).toEqual([
			`${SPEC_KEY}:${targetMod.sectionSlot(0)}`,
			`${SPEC_KEY}:${targetMod.sectionSlot(2)}`,
		]);
		// Only the real prefix body claims truncation; the command body must not
		// inherit it (index addressing would have shifted s2's flag onto the error
		// section and left the output body flagless).
		const byId = new Map(seen.map((t) => [t.id, t]));
		expect(byId.get(`${SPEC_KEY}:${targetMod.sectionSlot(0)}`)?.truncated).toBeUndefined();
		expect(byId.get(`${SPEC_KEY}:${targetMod.sectionSlot(2)}`)?.truncated).toBe(true);
	});
});
