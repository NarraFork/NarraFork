/**
 * RenderSubagentRecovery.dismiss.test.tsx — the recovery card's close button must
 * actually do something in the virtual list.
 *
 * Mirrors RenderSystemText.guardcard.test.tsx: the whole chain (adapter → measure →
 * render → DOM click) is driven for real, so a regression anywhere in it — a dropped
 * `onDismiss` in the render dispatch, a control that stops being a button, a handler
 * bound to the wrong control — fails here.
 *
 * The card's two resume buttons restart work; closing it is the third answer
 * ("leave them stopped"). Without the slot the card paints NO close button: a share
 * viewer has nothing to dismiss.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { rowWithElements } from "@shared/narrator-blocks/message-blocks";
import { type AdapterSegment, adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { measureSubagentRecovery } from "../measure/measure-subagent-recovery";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { VLIST_REGISTRY } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";

const CONTENT_WIDTH = 800;

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

const RECOVERY_BLOCKS = [
	{
		type: "subagent_recovery",
		status: "pending",
		subagents: [
			{ id: "sub-1", title: "执行中文文字超分对照", subagentType: "general" },
			{ id: "sub-2", title: "Collect the failing cases", subagentType: "explore" },
		],
	},
];

/** Drive a subagent_recovery block through adapter → measure → render. */
function renderCard(onDismiss?: () => void): {
	buttons: HTMLButtonElement[];
	measured: ReturnType<typeof measureSubagentRecovery>;
	container: HTMLElement;
	unmount: () => void;
} {
	const seg: AdapterSegment = {
		kind: "message",
		msg: rowWithElements({ id: "recovery-msg", role: "disp" }, RECOVERY_BLOCKS as never),
	};
	const spec = adaptSegment(seg, { lod: 5 } as never)[0];
	if (!spec) throw new Error("no spec produced");
	expect(spec.kind).toBe("subagent-recovery");

	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
	// Exactly what the shell does: the callback travels in `opts` and the render
	// registry forwards it, so the round trip through resolveRenderExtra is covered.
	if (onDismiss) spec.opts = { ...(spec.opts ?? {}), onDismiss };
	const extra = resolveRenderExtra(spec);

	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(<MantineProvider>{renderElement(spec.kind, measured, extra)}</MantineProvider>);
	});
	return {
		buttons: Array.from(container.querySelectorAll("button")) as unknown as HTMLButtonElement[],
		measured: measured as ReturnType<typeof measureSubagentRecovery>,
		container: container as unknown as HTMLElement,
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

/** The close control, told apart from the two resume buttons by its aria-label. */
function closeButtonOf(container: HTMLElement): Element | null {
	return container.querySelector("button[aria-label]");
}

describe("subagent recovery card — close button", () => {
	it("paints a third control and routes its click to the injected dismiss", () => {
		const calls: string[] = [];
		const { buttons, container, unmount } = renderCard(() => calls.push("dismiss"));
		// Two resume buttons + the close button.
		expect(buttons).toHaveLength(3);
		const close = closeButtonOf(container);
		expect(close).not.toBeNull();
		act(() => (close as unknown as HTMLButtonElement).click());
		expect(calls).toEqual(["dismiss"]);
		// The resume buttons must stay bound to their own mutations.
		expect(buttons).toHaveLength(3);
		unmount();
	});

	it("labels the close button from the measured payload (no render i18n)", () => {
		const { container, unmount } = renderCard(() => {});
		// The adapter's fallback label; the shell injects the translated one.
		expect(closeButtonOf(container)?.getAttribute("aria-label")).toBe("Dismiss without restarting");
		unmount();
	});

	it("paints no close button when nothing is injected", () => {
		const { buttons, container, unmount } = renderCard();
		expect(buttons).toHaveLength(2);
		expect(closeButtonOf(container)).toBeNull();
		unmount();
	});

	it("keeps the reserved height with and without the close button", () => {
		// The button rides inside the header lane, so wiring it must not move a single
		// row. Asserted through the rendered card: the measure layer never receives the
		// callback, so comparing two measure calls would prove nothing.
		const wired = renderCard(() => {});
		const bare = renderCard();
		expect(wired.measured.height).toBe(bare.measured.height);
		const paper = (root: HTMLElement) =>
			(root.querySelector("[class*=Paper]")?.getAttribute("style") ?? "").replace(/\s+/g, "");
		expect(paper(wired.container)).toContain(`height:${wired.measured.height}px`);
		expect(paper(bare.container)).toContain(`height:${bare.measured.height}px`);
		wired.unmount();
		bare.unmount();
	});

	it("still lists the subagents it offers to restart", () => {
		const { container, unmount } = renderCard(() => {});
		expect(container.textContent).toContain("执行中文文字超分对照");
		expect(container.textContent).toContain("Collect the failing cases");
		unmount();
	});
});
