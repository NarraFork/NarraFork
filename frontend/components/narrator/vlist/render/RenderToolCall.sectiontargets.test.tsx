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
		5,
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

describe("sections detail — targets use semantic sources through sparse sections", () => {
	/** `{ error, output }`: the shape whose target list is sparse. */
	const errorThenOutput: ToolDetailSection[] = [
		{ key: "error", label: "error", body: { kind: "error", text: "boom" } },
		{
			key: "output.main",
			label: "result",
			body: {
				kind: "capped",
				id: "tool-x:output.main",
				source: "output.main",
				format: "text",
				live: false,
				followTarget: { kind: "end" },
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
		expect(targets.map((t) => t.slot)).toEqual(["output.main"]);
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
		expect(seenIds(seen)).toEqual([`${SPEC_KEY}:${"output.main"}`]);
		// And that target must be the truncated one — the flag is the only remaining
		// gate for fetching the withheld bytes.
		expect(seen[0]?.truncated).toBe(true);
	});

	it("keeps each section on its own target when several sections have one", () => {
		const measured = measureSectionsCard([
			{
				key: "input.command",
				label: "command",
				body: {
					kind: "capped",
					id: "tool-x:input.command",
					source: "input.command",
					format: "code",
					live: false,
					followTarget: { kind: "end" },
					cap: "code",
					contentLines: 1,
					text: "ls -la",
				},
			},
			{ key: "error", label: "error", body: { kind: "error", text: "boom" } },
			{
				key: "output.main",
				label: "output",
				body: {
					kind: "capped",
					id: "tool-x:output.main",
					source: "output.main",
					format: "text",
					live: false,
					followTarget: { kind: "end" },
					cap: "term",
					contentLines: 3,
					text: "partial output",
					textTruncated: true,
				},
			},
		]);
		const targets = targetMod.resolveToolDetailViewTargets(SPEC_KEY, measured);
		// s0 and s2: the middle (error) section again contributes nothing.
		expect(targets.map((t) => t.slot)).toEqual(["input.command", "output.main"]);
		const { controls, seen } = recordingControls();
		render(<RenderToolCall measured={measured} viewTargets={targets} viewControls={controls} />);
		expect(seenIds(seen)).toEqual([
			`${SPEC_KEY}:${"input.command"}`,
			`${SPEC_KEY}:${"output.main"}`,
		]);
		// Only the real prefix body claims truncation; the command body must not
		// inherit it (index addressing would have shifted s2's flag onto the error
		// section and left the output body flagless).
		const byId = new Map(seen.map((t) => [t.id, t]));
		expect(byId.get(`${SPEC_KEY}:${"input.command"}`)?.truncated).toBeUndefined();
		expect(byId.get(`${SPEC_KEY}:${"output.main"}`)?.truncated).toBe(true);
	});
});
