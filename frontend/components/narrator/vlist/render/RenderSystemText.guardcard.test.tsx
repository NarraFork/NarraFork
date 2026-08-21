/**
 * RenderSystemText.guardcard.test.tsx — the interrupt task-guard reminder card's
 * close button must actually DO something in the virtual list.
 *
 * Mirrors RenderSystemText.errorcard.test.tsx: the whole chain (adapter →
 * measure → render → DOM click) is driven for real, so a regression anywhere in
 * it — a dropped `injectionGuardActions` prop in the render dispatch, a control
 * that stops being a button, a handler bound to the wrong control — fails here.
 *
 * Unlike the error card (whose controls always paint, disabled when unwired),
 * the guard card paints NO close button without the slot: other origin notices
 * have no dismiss affordance at all.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { type AdapterSegment, adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MEASURE_SYSTEM_TEXT_CONSTANTS } from "../measure/measure-system-text";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { VLIST_REGISTRY } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";
import type { InjectionGuardActions } from "./RenderSystemText";

const CONTENT_WIDTH = 800;

beforeAll(() => {
	// The card body is measured with pretext (canvas measureText).
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
	// linkedom ships no rAF pair; Mantine's transition cleanup calls the cancel
	// side on unmount, which would otherwise throw inside act().
	if (typeof g.requestAnimationFrame !== "function") {
		g.requestAnimationFrame = (cb: (t: number) => void) =>
			setTimeout(() => cb(Date.now()), 0) as unknown as number;
	}
	if (typeof g.cancelAnimationFrame !== "function") {
		g.cancelAnimationFrame = (handle: number) => clearTimeout(handle as unknown as Timer);
	}
});

const GUARD_TEXT = "刚才的运行被用户中断，当前 spec://tasks.json 中仍有开放任务。";

/**
 * Drive a system_injection block with source interrupt_task_guard through
 * adapter → measure → render into a live DOM and return the rendered controls.
 */
function renderGuardCard(actions?: InjectionGuardActions): {
	buttons: HTMLButtonElement[];
	measured: ReturnType<(typeof VLIST_REGISTRY)["system-text"]["measure"]>;
	container: HTMLElement;
	unmount: () => void;
} {
	const seg: AdapterSegment = {
		kind: "message",
		msg: {
			id: "guard-msg",
			role: "system",
			contentJson: [
				{ type: "text", text: GUARD_TEXT },
				{ type: "system_injection", source: "interrupt_task_guard" },
			] as never,
		},
	};
	const spec = adaptSegment(seg, { lod: 5 } as never)[0];
	if (!spec) throw new Error("no spec produced");
	expect(spec.kind).toBe("system-text");
	expect((spec.data as { kind?: unknown }).kind).toBe("origin_notice");

	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
	const extra = resolveRenderExtra(spec);
	if (actions) extra.injectionGuardActions = actions;

	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(<MantineProvider>{renderElement(spec.kind, measured, extra)}</MantineProvider>);
	});
	return {
		buttons: Array.from(container.querySelectorAll("button")) as unknown as HTMLButtonElement[],
		measured,
		container: container as unknown as HTMLElement,
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

describe("interrupt guard card — the close button invokes the injected action", () => {
	it("routes the click to the injected dismiss handler", () => {
		const calls: string[] = [];
		const { buttons, unmount } = renderGuardCard({
			onDismiss: () => calls.push("dismiss"),
			dismissLabel: "删除此提醒",
		});
		expect(buttons).toHaveLength(1);
		act(() => buttons[0]?.click());
		expect(calls).toEqual(["dismiss"]);
		unmount();
	});

	it("labels the close button with the injected translation", () => {
		// The render layer holds no i18n, so an unlabelled control means the shell's
		// string never arrived and the tooltip would read in English / be empty.
		const { buttons, unmount } = renderGuardCard({
			onDismiss: () => {},
			dismissLabel: "删除此提醒",
		});
		expect(buttons[0]?.getAttribute("aria-label")).toBe("删除此提醒");
		unmount();
	});

	it("blocks the close button while a dismissal is in flight", () => {
		const calls: string[] = [];
		const { buttons, unmount } = renderGuardCard({
			onDismiss: () => calls.push("dismiss"),
			dismissing: true,
		});
		expect(buttons[0]?.hasAttribute("disabled")).toBe(true);
		act(() => buttons[0]?.click());
		expect(calls).toEqual([]);
		unmount();
	});

	it("paints NO button when no actions are injected", () => {
		// Other origin notices (progress reminders, knowledge hints…) have no
		// dismiss affordance; the slot's absence must not paint inert chrome.
		const { buttons, unmount } = renderGuardCard();
		expect(buttons).toHaveLength(0);
		unmount();
	});

	it("keeps the card height identical with and without wired actions", () => {
		// The button lives inside the already-measured heading row, so wiring it must
		// not move a single row (CONTRACT.md §0: committed rows never jump).
		//
		// Asserted through the RENDERED card. Calling `measureSystemTextCard` twice
		// with the same data proves nothing — the measure layer never receives
		// `actions`, so both calls are identical by construction and the test stays
		// green however the button is sized. What can actually regress is the painted
		// button outgrowing the heading row it sits in, so the check is that the
		// button is capped to the measured line box and the card still claims exactly
		// its reserved height.
		const wired = renderGuardCard({ onDismiss: () => {}, dismissLabel: "删除此提醒" });
		const bare = renderGuardCard();
		expect(wired.measured.height).toBe(bare.measured.height);
		expect(wired.measured.contentWidth).toBe(bare.measured.contentWidth);

		// Whitespace-normalized: linkedom omits the space after the colon.
		const style = (node: Element | null) => (node?.getAttribute("style") ?? "").replace(/\s+/g, "");
		const lineBox = MEASURE_SYSTEM_TEXT_CONSTANTS.BODY_LINE_HEIGHT;
		const button = wired.container.querySelector("button");
		// Both, because either one alone lets the button grow the row: `height` without
		// `min-height` collapses under flex, and Mantine's own xs size (18px) exceeds
		// the 17px line box the heading row reserves.
		expect(style(button)).toContain(`height:${lineBox}px`);
		expect(style(button)).toContain(`min-height:${lineBox}px`);

		const paper = (root: HTMLElement) => style(root.querySelector("[class*=Paper]"));
		expect(paper(wired.container)).toContain(`height:${wired.measured.height}px`);
		expect(paper(bare.container)).toContain(`height:${bare.measured.height}px`);
		wired.unmount();
		bare.unmount();
	});
});
