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
 * Collapsed header animation is deliberately NOT covered: its fixed truncating
 * line and left-clipped `liveTail` have no stable grapheme start/end position.
 * Collapse/expand transitions ARE covered: mounting a body inside an already warm
 * scope must seal old content, including text generated while that body was hidden.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RenderLodCtx } from "../../lod/RenderLodCtx";
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
let fixtureEpoch = 0;

async function mountLiveStepRow(options?: {
	shimmer?: boolean;
	warmSibling?: boolean;
	kind?: "reasoning" | "reasoning-steps";
}) {
	const kind = options?.kind ?? "reasoning-steps";
	const { measureReasoning } = await import("../measure/measure-reasoning");
	const { measureReasoningStepsTrace } = await import("../measure/measure-tool-run");
	const { measureMarkdown } = await import("../measure/measure-markdown");
	const { RenderMarkdown } = await import("./RenderMarkdown");
	const { renderElement } = await import("../render-registry");
	const { resolveStreamAnimExtra } = await import("../vlist-stream-anim-extra");

	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);

	// The shell's own wiring, not a re-implementation: if the shell stops passing the
	// fade to this kind, the extra becomes null here and the assertions fail.
	const extra = resolveStreamAnimExtra({
		animateStreaming: true,
		kind,
		specKey: "__streaming__-b0",
		narratorId: "n1",
		mountEpoch: ++fixtureEpoch,
	});
	if (!extra) throw new Error("the shell must supply the fade for a live reasoning-steps row");

	const frame = (body: string, expanded = true) => {
		act(() => {
			const measured =
				kind === "reasoning"
					? measureReasoning({ text: body, isStreaming: options?.shimmer ?? true }, WIDTH, 5, {
							expanded,
						})
					: measureReasoningStepsTrace(
							[
								{
									title: "分析现状",
									body,
									shimmer: options?.shimmer ?? true,
									key: "seg0",
								},
							] as never,
							WIDTH,
							{ expandedIndices: expanded ? [0] : [] } as never,
						);
			reactRoot.render(
				<MantineProvider>
					<RenderLodCtx.Provider value={{ lod: 5, interactive: true }}>
						{options?.warmSibling && (
							<div data-warm-sibling>
								<RenderMarkdown
									measured={measureMarkdown("同一会话已经显示的正文", WIDTH)}
									{...extra}
									animKeyBase={`${extra.animKeyBase}:sibling`}
								/>
							</div>
						)}
						<div data-step-row>
							{/* Plain live reasoning is always expanded; hiding it models leaving
							    the virtual window. Steps instead fold their body in-place. */}
							{kind === "reasoning" && !expanded
								? null
								: renderElement(kind, measured as never, { ...extra } as never)}
						</div>
					</RenderLodCtx.Provider>
				</MantineProvider>,
			);
		});
	};

	const stepBody = () => container.querySelector("[data-step-row] [data-md-body]");

	return {
		frame,
		// Caret fillers are zero-width layout helpers, not authored reasoning text.
		bodyText: () => (stepBody()?.textContent ?? "").replaceAll("\u200b", ""),
		bodyNodeCount: () => stepBody()?.querySelectorAll("*").length ?? 0,
		animText: () =>
			Array.from(container.querySelectorAll(`[data-step-row] span.${ANIM_CLASS}`))
				.map((span) => span.textContent ?? "")
				.join(""),
		animSpans: () => Array.from(container.querySelectorAll(`[data-step-row] span.${ANIM_CLASS}`)),
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

describe("live reasoning step body fades in per grapheme", () => {
	it.each([
		"reasoning",
		"reasoning-steps",
	] as const)("seals a long collapsed %s body in a warm scope, then animates only live additions", async (kind) => {
		const row = await mountLiveStepRow({ warmSibling: true, kind });
		const paragraphs = Array.from(
			{ length: 360 },
			(_, index) => `第${index}段记录已经生成的分析内容，需要完整保留而不是重新播放逐字动画。`,
		);
		const body = paragraphs.join("\n\n");
		const visibleBody = paragraphs.join("");
		expect(body.length).toBeGreaterThan(10_000);

		try {
			// The real markdown sibling commits first and warms the SAME scope while
			// this step has no mounted body. A cold-scope fixture cannot catch this bug.
			row.frame(body, false);
			expect(row.bodyText()).toBe("");
			expect(row.bodyNodeCount()).toBe(0);

			row.frame(body, true);
			expect(row.bodyText()).toBe(visibleBody);
			expect(row.animSpans()).toHaveLength(0);
			const settledNodeCount = row.bodyNodeCount();
			expect(settledNodeCount).toBeGreaterThan(0);

			// A second commit must not resurrect births invented by the first render.
			row.frame(body, true);
			expect(row.bodyText()).toBe(visibleBody);
			expect(row.animSpans()).toHaveLength(0);
			expect(row.bodyNodeCount()).toBe(settledNodeCount);

			const appended = "现在追加的新字";
			row.frame(body + appended, true);
			expect(row.bodyText()).toBe(visibleBody + appended);
			expect(row.animText()).toBe(appended);

			const newParagraph = "新产生的段落也应该正常逐字出现";
			row.frame(`${body}${appended}\n\n${newParagraph}`, true);
			expect(row.bodyText()).toBe(visibleBody + appended + newParagraph);
			expect(row.animText()).toContain(newParagraph);
			expect(row.animText().replace(appended, "")).toBe(newParagraph);

			row.frame(`${body}${appended}\n\n${newParagraph}`, false);
			expect(row.bodyNodeCount()).toBe(0);
			const hiddenGrowth = "折叠期间追加的内容";
			const hiddenParagraph = "折叠期间生成的全新段落";
			const grownBody = `${body}${appended}\n\n${newParagraph}${hiddenGrowth}\n\n${hiddenParagraph}`;
			row.frame(grownBody, false);
			expect(row.bodyNodeCount()).toBe(0);
			row.frame(grownBody, true);
			expect(row.bodyText()).toBe(
				visibleBody + appended + newParagraph + hiddenGrowth + hiddenParagraph,
			);
			expect(row.animSpans()).toHaveLength(0);
			row.frame(grownBody, true);
			expect(row.animSpans()).toHaveLength(0);
		} finally {
			row.unmount();
		}
	});

	it("does not replay mounted paragraphs after their shared animation entries are evicted", async () => {
		const { STREAM_ANIM_MAX_KEYS } = await import("./stream-token-anim");
		const row = await mountLiveStepRow({ warmSibling: true });
		const body = Array.from(
			{ length: STREAM_ANIM_MAX_KEYS + 100 },
			(_, index) => `第${index}段已有内容不应该因为缓存淘汰而重新出现动画。`,
		).join("\n\n");
		try {
			row.frame(body, false);
			row.frame(body);
			expect(row.animSpans()).toHaveLength(0);
			row.frame(body);
			expect(row.animSpans()).toHaveLength(0);
			row.frame(`${body}新字`);
			expect(row.animText()).toBe("新字");
			// An unpredictable block switches the body to flowing layout and remounts
			// all inline blocks. Empty Mermaid avoids loading a diagram in this test.
			const flowingBody = `${body}新字\n\n\`\`\`mermaid\n\`\`\``;
			row.frame(flowingBody);
			expect(row.animSpans()).toHaveLength(0);
			row.frame(flowingBody);
			expect(row.animSpans()).toHaveLength(0);
			row.frame(`${flowingBody}\n\n图表后新增`);
			expect(row.animText()).toBe("图表后新增");
			row.frame(body);
			expect(row.animSpans()).toHaveLength(0);
			row.frame(body);
			expect(row.animSpans()).toHaveLength(0);
		} finally {
			row.unmount();
		}
	});

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
