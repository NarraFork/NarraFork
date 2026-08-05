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
import {
	MEASURE_SYSTEM_TEXT_CONSTANTS,
	measureSystemTextCard,
} from "../measure/measure-system-text";
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
 *
 * `ctx` extras (notably `canOfferProviderFix` / `labels`) go into the REAL adapter
 * call, so the provider-fix button is decided the same way the shell decides it —
 * during adaptation, which is what lets its row be measured.
 */
function renderErrorCard(
	actions?: ErrorNoticeActions,
	block: Record<string, unknown> = { type: "error", message: ERROR_TEXT },
	ctx: Record<string, unknown> = {},
): {
	buttons: HTMLButtonElement[];
	measured: ReturnType<(typeof VLIST_REGISTRY)["system-text"]["measure"]>;
	container: HTMLElement;
	unmount: () => void;
} {
	const seg: AdapterSegment = {
		kind: "message",
		msg: { id: "err-msg", role: "system", contentJson: [block as never] },
	};
	const spec = adaptSegment(seg, { lod: 5, ...ctx } as never)[0];
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
		measured,
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

/**
 * The provider fix must be a control the user can READ, not a bare icon.
 *
 * The regression these lock down: the fix shipped as a third icon in the card's
 * action strip, with its meaning only in a hover tooltip. Touch users never open a
 * tooltip, so the one action that actually resolves the failure was unlabelled and
 * undiscoverable — which is why it now gets a labelled button on its own row, and
 * why that row has to be MEASURED (a taller card, not overlaid chrome).
 */
describe("error notice card — the provider fix is a labelled, measured button", () => {
	const FIX_LABEL = "关闭图像生成并重试";
	const fixCtx = { canOfferProviderFix: () => true, labels: { disableImageGen: FIX_LABEL } };

	it("paints the localized label as visible text, not only a tooltip", () => {
		const { buttons, container, unmount } = renderErrorCard(
			{ onDisableImageGen: () => {}, onMarkRetryable: () => {}, onDismiss: () => {} },
			undefined,
			fixCtx,
		);
		// The label must be in the DOM unconditionally — a `title`/`aria-label` alone
		// is exactly the tooltip-only failure this replaced.
		expect(container.textContent).toContain(FIX_LABEL);
		const fix = buttons.find((b) => b.textContent?.includes(FIX_LABEL));
		expect(fix).toBeDefined();
		unmount();
	});

	it("routes the click to the injected handler", () => {
		const calls: string[] = [];
		const { buttons, unmount } = renderErrorCard(
			{
				onDisableImageGen: () => calls.push("fix"),
				onMarkRetryable: () => calls.push("retry"),
				onDismiss: () => calls.push("dismiss"),
			},
			undefined,
			fixCtx,
		);
		const fix = buttons.find((b) => b.textContent?.includes(FIX_LABEL));
		act(() => fix?.click());
		expect(calls).toEqual(["fix"]);
		unmount();
	});

	it("falls back to the adapter's English label when no translation is injected", () => {
		// The render layer holds no i18n, so the wording must arrive through the
		// adapter; an unlabelled button would mean that plumbing broke.
		const { container, unmount } = renderErrorCard(
			{ onDisableImageGen: () => {}, onMarkRetryable: () => {}, onDismiss: () => {} },
			undefined,
			{ canOfferProviderFix: () => true },
		);
		expect(container.textContent).toContain("Turn off image generation and retry");
		unmount();
	});

	it("paints no fix button when the shell says the error is not eligible", () => {
		const { buttons, container, unmount } = renderErrorCard({
			onDisableImageGen: () => {},
			onMarkRetryable: () => {},
			onDismiss: () => {},
		});
		// Only the two always-present icon controls.
		expect(buttons).toHaveLength(2);
		expect(container.textContent).not.toContain("image generation");
		unmount();
	});

	it("reserves the button's row in the MEASURED height", () => {
		// The button sits below the message, so it makes the card taller. If measure
		// ignored it the button would be painted outside the row's reserved box and
		// overlap whatever follows.
		const eligible = renderErrorCard(
			{ onDisableImageGen: () => {}, onMarkRetryable: () => {}, onDismiss: () => {} },
			undefined,
			fixCtx,
		);
		const plain = renderErrorCard({ onMarkRetryable: () => {}, onDismiss: () => {} });
		const c = MEASURE_SYSTEM_TEXT_CONSTANTS;
		expect(eligible.measured.height - plain.measured.height).toBe(
			c.STACK_GAP + c.BUTTON_COMPACT_XS,
		);
		eligible.unmount();
		plain.unmount();
	});

	it("keeps the body's wrap width unchanged (the row is vertical, not side chrome)", () => {
		// The fix does not eat horizontal space, so an eligible card must wrap its
		// message exactly like an ineligible one — otherwise the same error text would
		// reflow the moment eligibility resolved.
		const eligible = renderErrorCard(undefined, undefined, fixCtx);
		const plain = renderErrorCard();
		expect(eligible.measured.contentWidth).toBe(plain.measured.contentWidth);
		expect(eligible.measured.contentWidth).toBe(
			CONTENT_WIDTH -
				MEASURE_SYSTEM_TEXT_CONSTANTS.CARD_PADDING * 2 -
				MEASURE_SYSTEM_TEXT_CONSTANTS.ERROR_LEFT -
				MEASURE_SYSTEM_TEXT_CONSTANTS.ERROR_RIGHT,
		);
		eligible.unmount();
		plain.unmount();
	});

	it("paints nothing clickable on an action-less card", () => {
		const measured = measureSystemTextCard(
			"error",
			{ text: ERROR_TEXT, actions: false, buttons: [FIX_LABEL] },
			800,
		);
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		act(() => {
			root.render(
				<MantineProvider>
					{renderElement("system-text", measured, {
						kind: "error",
						data: { text: ERROR_TEXT, actions: false, buttons: [FIX_LABEL] },
						errorNoticeActions: {
							onDisableImageGen: () => {},
							onMarkRetryable: () => {},
							onDismiss: () => {},
						},
					})}
				</MantineProvider>,
			);
		});
		expect(container.querySelectorAll("button")).toHaveLength(0);
		act(() => root.unmount());
		container.remove();
	});
});
