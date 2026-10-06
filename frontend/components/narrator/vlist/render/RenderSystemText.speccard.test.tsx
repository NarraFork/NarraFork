/**
 * RenderSystemText.speccard.test.tsx — the Dynamic Spec notice cards' buttons must
 * actually DO something in the virtual list.
 *
 * The bug this locks down: in Virtual-list mode the fork-carryover /
 * context-cleared / goal-added cards painted their buttons ("View tasks",
 * "Clear", "Reset Spec") from the adapter's label list, but the render copy bound
 * no `onClick` at all — clicking them did nothing, while the chunked path's
 * SpecForkCarryoverCard has always driven the real mutations. Nothing failed: the
 * geometry was right, the labels were right, the cards were simply inert.
 *
 * The whole chain is driven for real (adapter → measure → render → DOM click), so
 * a regression anywhere in it — a dropped `actions` prop in the render dispatch, a
 * reordered button list, a handler bound to the wrong index — fails here.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { type AdapterSegment, adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { VLIST_REGISTRY } from "../registry";
import { renderElement, resolveRenderExtra } from "../render-registry";
import type { SpecCarryoverActions } from "./RenderSystemText";

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

/**
 * Drive one `disp`/system spec block through adapter → measure → render into a
 * live DOM, and return the rendered buttons.
 */
function renderSpecCard(
	block: Record<string, unknown>,
	actions?: SpecCarryoverActions,
): { buttons: HTMLButtonElement[]; unmount: () => void } {
	const seg: AdapterSegment = {
		kind: "message",
		msg: { id: "spec-msg", role: "system", contentJson: [block as never] },
	};
	const spec = adaptSegment(seg, { lod: 5 })[0];
	if (!spec) throw new Error("no spec produced");
	expect(spec.kind).toBe("system-text");

	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
	const extra = resolveRenderExtra(spec);
	if (actions) extra.specCarryoverActions = actions;

	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(<MantineProvider>{renderElement(spec.kind, measured, extra)}</MantineProvider>);
	});
	const buttons = Array.from(
		container.querySelectorAll("button"),
	) as unknown as HTMLButtonElement[];
	return {
		buttons,
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

const CARRYOVER = {
	type: "spec_fork_carryover",
	total: 3,
	open: 2,
	protectedOpen: 1,
} as const;

describe("spec carryover card — buttons invoke the injected actions", () => {
	it("wires view / clear / reset in the adapter's button order", () => {
		const calls: string[] = [];
		const { buttons, unmount } = renderSpecCard(CARRYOVER, {
			onViewTasks: () => calls.push("view"),
			onClearTasks: () => calls.push("clear"),
			onResetSpec: () => calls.push("reset"),
		});
		// The adapter emits exactly three buttons for this card kind.
		expect(buttons).toHaveLength(3);
		for (const button of buttons) act(() => button.click());
		expect(calls).toEqual(["view", "clear", "reset"]);
		unmount();
	});

	it("context-cleared variant gets the same three working buttons", () => {
		const calls: string[] = [];
		const { buttons, unmount } = renderSpecCard(
			{ type: "spec_context_cleared", total: 1, open: 1, protectedOpen: 0 },
			{
				onViewTasks: () => calls.push("view"),
				onClearTasks: () => calls.push("clear"),
				onResetSpec: () => calls.push("reset"),
			},
		);
		expect(buttons).toHaveLength(3);
		for (const button of buttons) act(() => button.click());
		expect(calls).toEqual(["view", "clear", "reset"]);
		unmount();
	});

	it("spec_goal_added's single button opens the task board", () => {
		const calls: string[] = [];
		const { buttons, unmount } = renderSpecCard(
			{ type: "spec_goal_added", task: "Wire the buttons", added: true },
			{ onViewTasks: () => calls.push("view") },
		);
		expect(buttons).toHaveLength(1);
		act(() => buttons[0]?.click());
		expect(calls).toEqual(["view"]);
		unmount();
	});

	it("renders the buttons DISABLED when no actions are injected", () => {
		// A visibly disabled button is honest; an enabled one that does nothing is
		// the regression. This also keeps a read-only surface from looking clickable.
		const { buttons, unmount } = renderSpecCard(CARRYOVER);
		expect(buttons).toHaveLength(3);
		for (const button of buttons) expect(button.hasAttribute("disabled")).toBe(true);
		unmount();
	});

	it("shows the in-flight action as loading and blocks the other buttons", () => {
		const calls: string[] = [];
		const { buttons, unmount } = renderSpecCard(CARRYOVER, {
			onViewTasks: () => calls.push("view"),
			onClearTasks: () => calls.push("clear"),
			onResetSpec: () => calls.push("reset"),
			busy: "clear",
		});
		// While clearing, the other two must not be clickable (a second mutation
		// mid-flight would race the dismissal).
		expect(buttons[0]?.hasAttribute("disabled")).toBe(true);
		expect(buttons[2]?.hasAttribute("disabled")).toBe(true);
		for (const button of buttons) act(() => button.click());
		expect(calls).toEqual([]);
		unmount();
	});
});
