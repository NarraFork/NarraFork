/**
 * RenderMarkdown.streamanim-shell.test.tsx — the streaming fade-in, driven through
 * the REAL shell chain: adaptSegments → measureElementCached → renderElement with
 * the exact `extra` wiring PretextExactMessageList uses.
 *
 * Why this exists on top of RenderMarkdown.streamanim.test.tsx
 * -----------------------------------------------------------
 * The component-level suite pins the store math, but the feature also depends on
 * TWO pieces of shell wiring that a component test cannot see:
 *
 *   1. the streaming-fade `extra` (per-block key base + narrator scope), which the
 *      shell builds via `resolveStreamAnimExtra`. This suite calls that same
 *      function rather than rebuilding the template, because a test that
 *      re-implements the wiring only proves it agrees with itself: if the shell
 *      stops passing it, blocks born mid-stream silently lose their fade while
 *      every component test stays green.
 *   2. `measureElementCached` must route the streaming row to the incremental
 *      prepared-block path without changing block identities.
 *
 * The scenarios are the ones the reader actually watches: a reply whose structure
 * (heading, list) grows token by token, and a fast provider delivering a whole
 * section in one delta.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RenderLodCtx } from "../../RenderLodCtx";
import { installCanvasStub } from "../measure/test-canvas-stub";

const CONTENT_WIDTH = 800;
const ANIM_CLASS = "vlist-anim-token";

beforeAll(() => {
	installCanvasStub();
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

/** The streaming placeholder message with one growing text lane. */
function streamingMsg(text: string) {
	return {
		id: "__streaming__",
		narratorId: "n1",
		parentToolUseId: null,
		role: "assistant",
		contentJson: [{ type: "text", id: "streaming:text:0", text }],
		contentText: null,
		toolCalls: [],
		createdAt: "2026-07-28T00:00:00.000Z",
		children: [],
	} as never;
}

/**
 * Mount the streaming markdown row through the real adapter + registry, reusing
 * the shell's `extra` wiring verbatim (animKeyBase = `${narratorId}:${spec.key}`).
 */
async function mountShellRow() {
	const { adaptSegments } = await import("@shared/pretext-layout/segment-adapter");
	const { measureElementCached } = await import("../registry");
	const { renderElement, resolveRenderExtra } = await import("../render-registry");
	const { resolveStreamAnimExtra } = await import("../vlist-stream-anim-extra");

	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);

	const frame = (text: string) => {
		act(() => {
			const specs = adaptSegments([{ kind: "message", msg: streamingMsg(text) }], {
				lod: 5,
			} as never);
			const md = specs.find((s) => s.kind === "markdown");
			if (!md) throw new Error(`no markdown spec; got ${specs.map((s) => s.kind).join(",")}`);
			const measured = measureElementCached("markdown", md.data, CONTENT_WIDTH, 5, md.opts, md.key);
			// The SHELL's own wiring, not a re-implementation of it: this is the
			// function PretextExactMessageList calls, so a change to the key template
			// or the scope shows up here instead of being agreed with twice.
			const extra = {
				...resolveRenderExtra(md),
				...resolveStreamAnimExtra({
					animateStreaming: true,
					kind: "markdown",
					specKey: md.key,
					narratorId: "n1",
				}),
			};
			reactRoot.render(
				<MantineProvider>
					<RenderLodCtx.Provider value={{ lod: 5, interactive: true }}>
						{renderElement("markdown", measured, extra)}
					</RenderLodCtx.Provider>
				</MantineProvider>,
			);
		});
	};

	return {
		frame,
		animText: () =>
			Array.from(container.querySelectorAll(`span.${ANIM_CLASS}`))
				.map((s) => s.textContent ?? "")
				.join(""),
		text: () =>
			Array.from(container.querySelectorAll("[data-vlist-line]"))
				.map((line) => line.textContent ?? "")
				.join(""),
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

describe("streaming fade-in through the real shell chain", () => {
	it("animates a heading born mid-stream, token by token", async () => {
		const row = await mountShellRow();
		const full = "前文段落。\n\n## 新标题";
		row.frame("前文段落。");
		row.frame("前文段落。\n\n## ");
		// The heading's first content character must fade in, not pop in.
		row.frame("前文段落。\n\n## 新");
		expect(row.animText()).toContain("新");
		row.frame(full);
		expect(row.animText()).toContain("标题");
		expect(row.text()).toContain("前文段落。新标题");

		row.unmount();
	});

	it("animates a list item born mid-stream, token by token", async () => {
		const row = await mountShellRow();
		row.frame("- 第一项");
		row.frame("- 第一项\n- ");
		row.frame("- 第一项\n- 第");
		expect(row.animText()).toContain("第");
		row.frame("- 第一项\n- 第二项");
		expect(row.animText()).toContain("二项");

		row.unmount();
	});

	it("animates every block of a whole section delivered in ONE delta", async () => {
		const row = await mountShellRow();
		row.frame("前文。");
		// A fast provider / catch-up frame can deliver a heading and two list items
		// in a single frame. The scope is already warm, so all of them fade in.
		row.frame("前文。\n\n## 标题\n\n- 项目甲\n- 项目乙");
		const anim = row.animText();
		expect(anim).toContain("标题");
		expect(anim).toContain("项目甲");
		expect(anim).toContain("项目乙");

		row.unmount();
	});

	/**
	 * The reported symptom, end to end: a SECOND turn reuses the first turn's anim
	 * keys (they derive from the constant `__streaming__` id), so every new block
	 * used to be sealed on its first delta and only faded from the second one on.
	 *
	 * The store is module-level and shared by every row, so mounting a second row
	 * here reproduces the real cross-turn condition exactly.
	 */
	it("animates the first delta of a new block on a SECOND turn (recycled keys)", async () => {
		const turnOne = await mountShellRow();
		turnOne.frame("第一轮的回答。");
		turnOne.frame("第一轮的回答。\n\n## 第一轮标题");
		turnOne.unmount();

		// Turn two: same narrator, same spec keys, fresh content.
		const turnTwo = await mountShellRow();
		turnTwo.frame("第二轮的回答。");
		turnTwo.frame("第二轮的回答。\n\n## ");
		// The heading's FIRST content delta must fade in. Before the fix this frame
		// found turn one's heading text under the same key and sealed the block.
		turnTwo.frame("第二轮的回答。\n\n## 新");
		expect(turnTwo.animText()).toContain("新");
		turnTwo.unmount();
	});

	it("still seals the very first frame of a streaming session (mount)", async () => {
		const row = await mountShellRow();
		// A cold scope means a mount (fresh page / narrator switch / reload
		// mid-stream): nothing may flash, not even a small first block.
		row.frame("开场白。");
		expect(row.animText()).toBe("");
		// From the next frame on the stream is live and animates normally.
		row.frame("开场白。继续");
		expect(row.animText()).toContain("继续");

		row.unmount();
	});
});
