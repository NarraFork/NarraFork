/**
 * RenderMarkdown.streamanim.test.tsx — the streaming fade-in must SURVIVE the next
 * delta, as a live DOM node.
 *
 * ── Why this file exists on top of stream-token-anim.test.ts ──────────────────
 *
 * The pure suite proves the seal offset lags the append boundary. It cannot prove
 * the thing that was actually broken: whether the DOM element carrying the CSS
 * animation is still the SAME element one frame later. A CSS animation is bound to
 * an element instance, so unmounting the span kills the animation no matter how
 * correct the offsets are — and unmounting is invisible to any assertion about
 * offsets, class names, or text content, all of which look identical afterwards.
 *
 * That is precisely how the original defect hid. The split point was the append
 * boundary, which advances on every delta, so each grapheme's span was folded into
 * the static string on the very next frame. React removed the element, the fade
 * died at roughly 5% progress, and continuous plain-text output looked almost
 * unanimated — only the final delta before a pause ever completed, because nothing
 * came after it to evict it.
 *
 * So these tests hold a reference to a specific DOM node across renders and assert
 * on the node's IDENTITY (`isConnected`, plus reference equality against a fresh
 * query). A regression that reintroduces per-frame sealing fails here even though
 * the rendered text stays correct.
 *
 * The scenario is deliberately the most ordinary one there is: a single line of
 * plain prose, no newline, no markdown structure, no code — the shape the reader
 * reported as broken, and the one no existing test covered.
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

/**
 * A streaming row driven frame by frame, mirroring how the shell re-renders the
 * live tail: one stable `animKeyBase`, growing text, a fresh measure each frame.
 */
async function mountStreamingRow(animKeyBase: string, animScope?: string) {
	const { measureMarkdown } = await import("../measure/measure-markdown");
	const { RenderMarkdown } = await import("./RenderMarkdown");

	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);

	const frame = (text: string) => {
		act(() => {
			reactRoot.render(
				<MantineProvider>
					<RenderLodCtx.Provider value={{ lod: 5, interactive: true }}>
						<RenderMarkdown
							measured={measureMarkdown(text, CONTENT_WIDTH)}
							animateStreaming
							animKeyBase={animKeyBase}
							// The shell derives this from the panel narrator; default it to the
							// key base's own narrator segment so a caller that omits it still
							// gets ONE scope per row rather than one per block.
							animScope={animScope ?? animKeyBase.split(":")[0]}
						/>
					</RenderLodCtx.Provider>
				</MantineProvider>,
			);
		});
	};

	return {
		frame,
		/** Every grapheme span currently carrying the animation class. */
		animSpans: () => Array.from(container.querySelectorAll(`span.${ANIM_CLASS}`)),
		animText: () =>
			Array.from(container.querySelectorAll(`span.${ANIM_CLASS}`))
				.map((s) => s.textContent ?? "")
				.join(""),
		/**
		 * Visible text of the LINE hosts only.
		 *
		 * Not `container.textContent`: MantineProvider injects its responsive
		 * `<style>` rules into the same tree, and their CSS source is text content
		 * too — it would be prepended to every assertion.
		 */
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

describe("streaming fade-in survives subsequent deltas", () => {
	it("keeps the SAME span element alive after more text arrives", async () => {
		const row = await mountStreamingRow("k-identity");
		// Frame 1 seeds the key (a cold-scope first sighting is a mount: no fade).
		row.frame("连续输出的");
		expect(row.animSpans()).toHaveLength(0);

		// Frame 2 appends: these graphemes are born and must animate.
		row.frame("连续输出的一行");
		const born = row.animSpans();
		expect(born.length).toBeGreaterThan(0);
		const tracked = born[born.length - 1];
		expect(tracked).toBeDefined();
		if (!tracked) throw new Error("no animated span was mounted");
		const trackedText = tracked.textContent;

		// Frame 3 appends more. THIS is the frame that used to kill the animation.
		row.frame("连续输出的一行普通文字");

		// The very same element object must still be in the document, still animated.
		expect(tracked.isConnected).toBe(true);
		expect(tracked.className).toContain(ANIM_CLASS);
		expect(tracked.textContent).toBe(trackedText);
		// And it must be the same node a fresh query finds — not a look-alike
		// remounted at the same position (which would have restarted the animation).
		const stillThere = row.animSpans().some((span) => span === tracked);
		expect(stillThere).toBe(true);

		row.unmount();
	});

	it("animates the whole run typed across several frames, not just the last delta", async () => {
		const row = await mountStreamingRow("k-window");
		row.frame("开头");
		row.frame("开头一");
		row.frame("开头一二");
		row.frame("开头一二三");

		// All three deltas are inside one animation window, so all three animate.
		// The old implementation left only "三" (the newest delta) animated.
		expect(row.animText()).toBe("一二三");
		// The seeded prefix is plain text, and no character is lost or duplicated.
		expect(row.text()).toBe("开头一二三");

		row.unmount();
	});

	it("carries a negative animation-delay so a remount resumes mid-fade", async () => {
		const row = await mountStreamingRow("k-delay");
		row.frame("前缀");
		row.frame("前缀新增");
		// A later frame re-reads the age of the still-live graphemes. Some real time
		// has passed inside act(), so at least the oldest live span should be resumed
		// rather than restarted — but the quantum may floor a very fast frame to 0,
		// which is correct (no delay needed when no time has passed).
		row.frame("前缀新增更多");
		const delays = row
			.animSpans()
			.map(
				(span) => (span as unknown as { style: { animationDelay: string } }).style.animationDelay,
			);
		// Every delay is either empty (born now / floored to zero) or negative; a
		// POSITIVE delay would stall the fade and leave the character invisible.
		for (const delay of delays) {
			if (delay && delay !== "0ms" && delay !== "0s") {
				expect(delay.startsWith("-")).toBe(true);
			}
		}

		row.unmount();
	});

	it("animates the opening chunk of a paragraph born mid-stream", async () => {
		const row = await mountStreamingRow("k-newpara");
		// The first block's first frame seeds cold (mount semantics: no fade)…
		row.frame("第一段话。");
		expect(row.animSpans()).toHaveLength(0);
		// …but once any block has committed, the scope is warm: the stream is live.
		row.frame("第一段话。\n\n");
		row.frame("第一段话。\n\n第二段");
		// The new paragraph's opening chunk must fade in, not pop in. Before the
		// scope split, a first sighting sealed unconditionally and this was "".
		expect(row.animText()).toContain("第二段");
		// The next delta onto the new paragraph animates as an ordinary append.
		row.frame("第一段话。\n\n第二段话");
		expect(row.animText()).toContain("话");
		expect(row.text()).toBe("第一段话。第二段话");

		row.unmount();
	});

	it("does not animate anything when animateStreaming is off", async () => {
		const { measureMarkdown } = await import("../measure/measure-markdown");
		const { RenderMarkdown } = await import("./RenderMarkdown");
		const container = document.createElement("div");
		document.body.appendChild(container);
		const reactRoot = createRoot(container);
		act(() => {
			reactRoot.render(
				<MantineProvider>
					<RenderLodCtx.Provider value={{ lod: 5, interactive: true }}>
						<RenderMarkdown measured={measureMarkdown("普通的committed行", CONTENT_WIDTH)} />
					</RenderLodCtx.Provider>
				</MantineProvider>,
			);
		});
		// A committed row must never fade: it would re-animate every time it scrolls
		// back into the mounted window.
		expect(container.querySelectorAll(`span.${ANIM_CLASS}`)).toHaveLength(0);
		act(() => reactRoot.unmount());
		container.remove();
	});
});
