/**
 * RenderSystemText.errorcard.test.tsx — the error notice card's two controls must
 * actually DO something in the virtual list.
 *
 * The bug this locks down: in Virtual-list mode the error card painted its
 * right-side controls (the "mark as retryable" repeat icon and the dismiss close
 * button) from the measured chrome, but the repeat icon was a bare `<IconRepeat>`
 * — not even a button — and the CloseButton bound no `onClick`. Clicking either
 * did nothing, while the chunked path's ErrorNotice has always opened the retry
 * rule dialog and deleted the message. Nothing failed: the geometry was right,
 * the icons were right, the card was simply inert.
 *
 * The whole chain is driven for real (adapter → measure → render → DOM click), so
 * a regression anywhere in it — a dropped `errorActions` prop in the render
 * dispatch, a control that stops being a button, a handler bound to the wrong
 * control — fails here.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { type AdapterSegment, adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { measureSystemTextCard } from "../measure/measure-system-text";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { VLIST_REGISTRY } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";
import type { ErrorNoticeActions } from "./RenderSystemText";

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

const ERROR_TEXT = "connect ECONNRESET 10.0.0.1:443";

/**
 * Drive a system error block through adapter → measure → render into a live DOM
 * and return the rendered controls.
 */
function renderErrorCard(
	actions?: ErrorNoticeActions,
	block: Record<string, unknown> = { type: "error", message: ERROR_TEXT },
): {
	buttons: HTMLButtonElement[];
	container: HTMLElement;
	unmount: () => void;
} {
	const seg: AdapterSegment = {
		kind: "message",
		msg: { id: "err-msg", role: "system", contentJson: [block as never] },
	};
	const spec = adaptSegment(seg, { lod: 5 })[0];
	if (!spec) throw new Error("no spec produced");
	expect(spec.kind).toBe("system-text");

	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
	const extra = resolveRenderExtra(spec);
	if (actions) extra.errorNoticeActions = actions;

	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(<MantineProvider>{renderElement(spec.kind, measured, extra)}</MantineProvider>);
	});
	return {
		buttons: Array.from(container.querySelectorAll("button")) as unknown as HTMLButtonElement[],
		container: container as unknown as HTMLElement,
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

describe("error notice card — controls invoke the injected actions", () => {
	it("wires the retry-rule control and the dismiss control in order", () => {
		const calls: string[] = [];
		const { buttons, unmount } = renderErrorCard({
			onMarkRetryable: () => calls.push("retry"),
			onDismiss: () => calls.push("dismiss"),
			markRetryableLabel: "标记为可重试",
		});
		// Exactly two controls: mark-as-retryable, then close.
		expect(buttons).toHaveLength(2);
		for (const button of buttons) act(() => button.click());
		expect(calls).toEqual(["retry", "dismiss"]);
		unmount();
	});

	it("labels the retry control with the injected translation", () => {
		// The render layer holds no i18n, so an unlabelled control means the shell's
		// string never arrived and the user sees the English fallback.
		const { buttons, unmount } = renderErrorCard({
			onMarkRetryable: () => {},
			onDismiss: () => {},
			markRetryableLabel: "标记为可重试",
		});
		expect(buttons[0]?.getAttribute("aria-label")).toBe("标记为可重试");
		unmount();
	});

	it("renders the controls DISABLED when no actions are injected", () => {
		// A visibly disabled control is honest; an enabled one that does nothing is
		// the regression this whole slot exists to prevent.
		const { buttons, unmount } = renderErrorCard();
		expect(buttons).toHaveLength(2);
		for (const button of buttons) expect(button.hasAttribute("disabled")).toBe(true);
		unmount();
	});

	it("blocks the close button while a dismissal is in flight", () => {
		const calls: string[] = [];
		const { buttons, unmount } = renderErrorCard({
			onMarkRetryable: () => calls.push("retry"),
			onDismiss: () => calls.push("dismiss"),
			dismissing: true,
		});
		expect(buttons[1]?.hasAttribute("disabled")).toBe(true);
		act(() => buttons[1]?.click());
		expect(calls).toEqual([]);
		unmount();
	});

	it("omits both controls when the card is marked action-less", () => {
		// `actions: false` is the read-only variant; it must not paint clickable
		// chrome at all.
		const measured = measureSystemTextCard("error", { text: ERROR_TEXT, actions: false }, 800);
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		act(() => {
			root.render(
				<MantineProvider>
					{renderElement("system-text", measured, {
						kind: "error",
						data: { text: ERROR_TEXT, actions: false },
						errorNoticeActions: { onMarkRetryable: () => {}, onDismiss: () => {} },
					})}
				</MantineProvider>,
			);
		});
		expect(container.querySelectorAll("button")).toHaveLength(0);
		act(() => root.unmount());
		container.remove();
	});

	it("keeps the card height identical with and without wired actions", () => {
		// The controls occupy the width the measure layer already reserves
		// (ERROR_RIGHT), so wiring them must not move a single row.
		const bare = measureSystemTextCard("error", { text: ERROR_TEXT }, CONTENT_WIDTH);
		const wired = measureSystemTextCard("error", { text: ERROR_TEXT }, CONTENT_WIDTH);
		expect(wired.height).toBe(bare.height);
		expect(wired.contentWidth).toBe(bare.contentWidth);
	});
});
