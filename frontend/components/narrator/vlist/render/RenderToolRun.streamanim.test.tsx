/**
 * RenderToolRun.streamanim.test.tsx — a LIVE reasoning STEP's expanded body fades in
 * per grapheme, like every other streaming body.
 *
 * ── Why this shape needed its own wiring ──────────────────────────────────────
 *
 * A reasoning run has two renderings, chosen by the adapter from the prose itself:
 * without a `**title**` it is a `reasoning` card (RenderReasoning → RenderMarkdown,
 * which already faded); with one it is `reasoning-steps`, rendered by THIS component.
 * Models normally emit a title, so the shape that faded was the rarer of the two and
 * "does reasoning fade in?" answered differently for one turn depending on how the
 * model happened to write.
 *
 * The gate is `row.shimmer` — the adapter's own live marker — so a run that answer
 * text or a tool call already followed stops fading at the same moment it stops
 * shimmering, rather than when the turn eventually persists.
 *
 * Collapsed rows are deliberately NOT covered: a collapsed row is one fixed
 * truncating line showing a settled title, and its live end is painted by the
 * left-clipped `liveTail` window, where a per-grapheme fade has no stable start or
 * end position.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RenderLodCtx } from "../../RenderLodCtx";
import { installCanvasStub } from "../measure/test-canvas-stub";

const WIDTH = 700;
const ANIM_CLASS = "vlist-anim-token";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

beforeAll(() => {
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.getComputedStyle = win.getComputedStyle;
	g.IS_REACT_ACT_ENVIRONMENT = true;
	if (typeof g.matchMedia !== "function") {
		g.matchMedia = () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		});
	}
	if (typeof g.ResizeObserver !== "function") {
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
	if (typeof g.requestAnimationFrame !== "function") {
		g.requestAnimationFrame = (cb: (t: number) => void) =>
			setTimeout(() => cb(Date.now()), 0) as unknown as number;
	}
	if (typeof g.cancelAnimationFrame !== "function") {
		g.cancelAnimationFrame = (handle: number) => clearTimeout(handle as unknown as Timer);
	}
});

/**
 * One live reasoning step, expanded, driven frame by frame through the REAL measure
 * layer and the REAL shell `extra` wiring.
 *
 * The step is expanded via `expandedIndices`, which is what the adapter emits when
 * the reader has opened that row — the only state in which a step has a body to fade.
 */
async function mountLiveStepRow(options?: { shimmer?: boolean }) {
	const { measureReasoningStepsTrace } = await import("../measure/measure-tool-run");
	const { renderElement } = await import("../render-registry");
	const { resolveStreamAnimExtra } = await import("../vlist-stream-anim-extra");

	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);

	// The shell's own wiring, not a re-implementation: if the shell stops passing the
	// fade to this kind, the extra becomes null here and the assertions fail.
	const extra = resolveStreamAnimExtra({
		animateStreaming: true,
		kind: "reasoning-steps",
		specKey: "__streaming__-b0",
		narratorId: "n1",
		mountEpoch: 7,
	});
	if (!extra) throw new Error("the shell must supply the fade for a live reasoning-steps row");

	const frame = (body: string) => {
		act(() => {
			const measured = measureReasoningStepsTrace(
				[
					{
						title: "分析现状",
						body,
						shimmer: options?.shimmer ?? true,
						key: "seg0",
					},
				] as never,
				WIDTH,
				{ expandedIndices: [0] } as never,
			);
			reactRoot.render(
				<MantineProvider>
					<RenderLodCtx.Provider value={{ lod: 5, interactive: true }}>
						{renderElement("reasoning-steps", measured as never, { ...extra } as never)}
					</RenderLodCtx.Provider>
				</MantineProvider>,
			);
		});
	};

	return {
		frame,
		animText: () =>
			Array.from(container.querySelectorAll(`span.${ANIM_CLASS}`))
				.map((span) => span.textContent ?? "")
				.join(""),
		animSpans: () => Array.from(container.querySelectorAll(`span.${ANIM_CLASS}`)),
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

describe("live reasoning step body fades in per grapheme", () => {
	it("animates text appended to the step the model is still writing", async () => {
		const row = await mountLiveStepRow();
		// Frame 1 seeds the key: a cold-scope first sighting is a mount, so it seals.
		row.frame("先读取相关文件");
		expect(row.animSpans()).toHaveLength(0);

		// Frame 2 appends — these graphemes are born now and must fade.
		row.frame("先读取相关文件确认现状");
		expect(row.animText()).toContain("确认现状");

		row.unmount();
	});

	it("keeps the SAME span element alive across the next delta", async () => {
		// A CSS animation is bound to an element instance, so a span unmounted on the
		// following frame dies at ~5% progress with nothing in the markup to show it.
		const row = await mountLiveStepRow();
		row.frame("开头");
		row.frame("开头新增");
		const born = row.animSpans();
		expect(born.length).toBeGreaterThan(0);
		const tracked = born[born.length - 1];
		if (!tracked) throw new Error("no animated span was mounted");

		row.frame("开头新增更多");
		expect(tracked.isConnected).toBe(true);
		expect(tracked.className).toContain(ANIM_CLASS);

		row.unmount();
	});

	it("does not animate a step that has already settled", async () => {
		// `shimmer: false` is the adapter saying the model moved on (answer text or a
		// tool call followed). A settled body must not fade, or every scroll back into
		// the mounted window would replay it.
		const row = await mountLiveStepRow({ shimmer: false });
		row.frame("已经写完的一步");
		row.frame("已经写完的一步再加内容");
		expect(row.animSpans()).toHaveLength(0);

		row.unmount();
	});
});
