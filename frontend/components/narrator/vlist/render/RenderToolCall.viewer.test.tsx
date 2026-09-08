/**
 * RenderToolCall.viewer.test.tsx — the fullscreen viewer reaching the ACTUAL
 * tool-card and subagent bodies.
 *
 * The unit tests around `vlist-content-view-target` prove the bodies are found;
 * `VListContentViewHost.test.tsx` proves the bar behaves. This is the chain
 * between them: real measure → real render, asserting that each capped body is
 * wrapped in a viewer host and that flipping wrap / source changes only the box's
 * CONTENT, never the measured geometry.
 *
 * That last part is the whole reason the vlist can offer these toggles at all: a
 * body box has a measure-fixed height and scrolls internally, unlike the chunked
 * ContentViewer where wrap genuinely reflows the row.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { measureToolCall } from "../measure/measure-tool-call";
import { installCanvasStub } from "../measure/test-canvas-stub";
import type { VListViewControls } from "../VListContentViewHost";
import { resolveToolDetailViewTargets, type VListViewTarget } from "../vlist-content-view-target";
import { RenderToolCall } from "./RenderToolCall";

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

const WIDTH = 700;
const KEY = "tool-tu_1";
/** A body taller than the 200px code cap, so the reader really needs fullscreen. */
const LONG_OUTPUT = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");

function makeControls(overrides: Partial<VListViewControls> = {}): VListViewControls {
	return {
		isWrapped: () => true,
		isSourceShown: () => false,
		toggleWrap: () => {},
		toggleSource: () => {},
		openFullscreen: () => {},
		...overrides,
	};
}

/** A bash card with a command + output section pair (the common two-body shape). */
function bashCard() {
	return measureToolCall(
		{
			toolName: "Bash",
			summary: "bun test",
			category: "bash",
			status: "success",
			toolUseId: "tu_1",
			detail: {
				kind: "sections",
				sections: [
					{
						key: "input.command",
						label: "command",
						body: {
							kind: "capped",
							cap: "bash-cmd",
							id: "tu_1:input.command",
							source: "input.command",
							format: "code",
							live: false,
							followTarget: { kind: "end" },
							contentLines: 1,
							text: "$ bun test",
						},
					},
					{
						key: "output.main",
						label: "output",
						body: {
							kind: "capped",
							cap: "term",
							id: "tu_1:output.main",
							source: "output.main",
							format: "text",
							live: false,
							followTarget: { kind: "end" },
							contentLines: 80,
							text: LONG_OUTPUT,
						},
					},
				],
			},
		},
		WIDTH,
		5,
		{ opened: true },
	);
}

function renderCard(opts: {
	measured: ReturnType<typeof measureToolCall>;
	targets?: readonly VListViewTarget[];
	controls?: VListViewControls;
}): Element {
	return parse(
		renderToStaticMarkup(
			<MantineProvider>
				<RenderToolCall
					measured={opts.measured}
					viewTargets={opts.targets}
					viewControls={opts.controls}
				/>
			</MantineProvider>,
		),
	);
}

/** Inline `white-space` values of every scrolling detail box in the card. */
function whiteSpaceValues(root: Element): string[] {
	return [...root.querySelectorAll("div[style*='white-space']")]
		.map((el) => /white-space:\s*([a-z-]+)/.exec(el.getAttribute("style") ?? "")?.[1] ?? "")
		.filter(Boolean);
}

describe("tool card bodies get a viewer host", () => {
	it("wraps every readable section body in a hover-able host", () => {
		const measured = bashCard();
		const targets = resolveToolDetailViewTargets(KEY, measured);
		expect(targets).toHaveLength(2);
		const root = renderCard({ measured, targets, controls: makeControls() });
		// Server-render paints no bar (it needs hover), but the host wrapper is there:
		// one relative box per body, inside the card's absolutely positioned sections.
		expect(root.querySelectorAll("div[style*='position:relative']").length).toBeGreaterThanOrEqual(
			2,
		);
	});

	it("still renders the bodies when no viewer is wired (pre-viewer behaviour)", () => {
		const measured = bashCard();
		const withViewer = renderCard({
			measured,
			targets: resolveToolDetailViewTargets(KEY, measured),
			controls: makeControls(),
		});
		const without = renderCard({ measured });
		// Both paint the same body text; only the host wrapper differs.
		expect(without.textContent).toContain("bun test");
		expect(withViewer.textContent).toContain("bun test");
	});
});

describe("wrap is content-only (the vlist's key difference from ContentViewer)", () => {
	it("flips white-space without touching any measured height", () => {
		const measured = bashCard();
		const targets = resolveToolDetailViewTargets(KEY, measured);

		const wrapped = renderCard({ measured, targets, controls: makeControls() });
		const unwrapped = renderCard({
			measured,
			targets,
			controls: makeControls({ isWrapped: () => false }),
		});

		// The reader-visible change: soft wrap → horizontal scroll.
		expect(whiteSpaceValues(wrapped)).toContain("pre-wrap");
		expect(whiteSpaceValues(unwrapped)).toContain("pre");
		expect(whiteSpaceValues(unwrapped)).not.toContain("pre-wrap");

		// Every explicit height in the markup is identical, so nothing moved.
		const heights = (root: Element) =>
			[...root.querySelectorAll("div[style*='height']")].map(
				(el) => /(?:^|;)height:\s*([^;]+)/.exec(el.getAttribute("style") ?? "")?.[1] ?? "",
			);
		expect(heights(unwrapped)).toEqual(heights(wrapped));
	});
});

describe("markdown bodies can show their source", () => {
	it.each([
		true,
		false,
	])("keeps rendered markdown clipped but lets unwrapped source scroll (wrap=%s)", (wrap) => {
		const plan = `# Plan\n\n- step one\n- ${"long source line ".repeat(100)}`;
		const measured = measureToolCall(
			{
				toolName: "ExitPlanMode",
				summary: "plan",
				category: "plan",
				status: "success",
				toolUseId: "tu_2",
				detail: {
					kind: "sections",
					sections: [
						{
							key: "input.plan",
							body: {
								kind: "capped",
								id: "tu_2:input.plan",
								source: "input.plan",
								live: false,
								followTarget: { kind: "end" },
								cap: "plan",
								contentLines: 4,
								text: plan,
								format: "markdown",
							},
						},
					],
				},
			},
			WIDTH,
			5,
			{ opened: true, viewportHeight: 900 },
		);
		const targets = resolveToolDetailViewTargets("tool-tu_2", measured);
		expect(targets[0]?.kind).toBe("markdown");

		const rendered = renderCard({
			measured,
			targets,
			controls: makeControls({ isWrapped: () => wrap }),
		});
		const source = renderCard({
			measured,
			targets,
			controls: makeControls({ isWrapped: () => wrap, isSourceShown: () => true }),
		});
		const renderedViewport = rendered.querySelector("[data-content-scrollport]");
		const sourceViewport = source.querySelector("[data-content-scrollport]");
		expect(renderedViewport?.getAttribute("style")).toContain("overflow-x:hidden");
		expect(sourceViewport?.getAttribute("style")).toContain(
			`overflow-x:${wrap ? "hidden" : "auto"}`,
		);
		expect(sourceViewport?.firstElementChild?.getAttribute("style")).toMatch(
			new RegExp(`(?:^|;)white-space:${wrap ? "pre-wrap" : "pre"}(?:;|$)`),
		);
		expect(rendered.querySelector("[data-tool-markdown]")).not.toBeNull();
		expect(source.querySelector("[data-tool-markdown]")).toBeNull();

		// The rendered form shows the heading text without its markdown marker; the
		// source form shows the raw `#`.
		expect(source.textContent).toContain("# Plan");
		expect(rendered.textContent).not.toContain("# Plan");
		expect(rendered.textContent).toContain("Plan");
	});
});
