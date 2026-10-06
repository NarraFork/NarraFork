/**
 * selection-click-guard.test.tsx — a fold/toggle region must not fire on a
 * SELECTION click.
 *
 * The bug this locks down: in the virtual list, Ctrl/Cmd+Click and Shift+Click
 * are the block multi-select gestures (handled by VListRowInteraction /
 * TraceRowInteraction). The vlist fold headers bound their toggle straight to
 * `onClick`, so every multi-select click ALSO expanded or collapsed the card
 * under the cursor — and for the role="button" headers the selection wrapper
 * ignored the click entirely, so the ONLY visible effect was the fold flipping.
 *
 * The fix is two-part, and both halves are pinned here:
 *   1. every fold toggle goes through `swallowSelectionClick`, which swallows
 *      modified clicks (behavioural tests below, through the real measure →
 *      render → DOM chain);
 *   2. headers that carry role="button" (or are a native <button>) also carry
 *      TOOL_HEADER_SELECT_ATTR, so `shouldIgnoreMessageBlockSelection` treats
 *      them as selectable surface instead of an interactive island.
 *
 * A source-level guard at the bottom fails the moment a fold region re-binds a
 * bare `onClick={onToggle}`-style handler, which is how the bug looked.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TOOL_HEADER_SELECT_ATTR } from "../../message/MessageSelectionCtx";
import { measureReasoning } from "../measure/measure-reasoning";
import { measureToolCall } from "../measure/measure-tool-call";
import { measureActivityTrace } from "../measure/measure-tool-run";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { swallowSelectionClick } from "./key-activate";
import { RenderReasoning } from "./RenderReasoning";
import { RenderToolCall } from "./RenderToolCall";
import { RenderToolRun } from "./RenderToolRun";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

const WIDTH = 700;

beforeAll(() => {
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	// linkedom's dispatchEvent writes target/currentTarget onto the event, so the
	// dispatched event MUST be a linkedom one — Bun's global Event has readonly
	// accessors and the dispatch throws "assign to readonly property".
	g.Event = win.Event;
	g.MouseEvent = win.MouseEvent ?? win.Event;
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
});

interface Rendered {
	container: HTMLDivElement;
	unmount: () => void;
}

function renderLive(node: ReactNode): Rendered {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	act(() => {
		root.render(<MantineProvider>{node}</MantineProvider>);
	});
	return {
		container,
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

/**
 * Dispatch a click carrying modifier keys. linkedom's Event does not accept a
 * MouseEventInit, so the flags are assigned onto the event object — React reads
 * them straight off the native event (same trick as CollapsibleTrace.test.tsx).
 */
function clickWith(
	node: Element,
	modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
) {
	act(() => {
		const event = new Event("click", { bubbles: true }) as Event & Record<string, unknown>;
		event.ctrlKey = modifiers.ctrlKey ?? false;
		event.metaKey = modifiers.metaKey ?? false;
		event.shiftKey = modifiers.shiftKey ?? false;
		node.dispatchEvent(event);
	});
}

// ── The guard itself ────────────────────────────────────────────────────────
describe("swallowSelectionClick", () => {
	it("invokes the toggle on a plain click", () => {
		const onToggle = mock(() => {});
		swallowSelectionClick(onToggle)({
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
		} as React.MouseEvent);
		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	it.each([
		["ctrlKey", { ctrlKey: true }],
		["metaKey", { metaKey: true }],
		["shiftKey", { shiftKey: true }],
	])("swallows a %s click (selection gesture)", (_name, modifiers) => {
		const onToggle = mock(() => {});
		swallowSelectionClick(onToggle)({
			metaKey: false,
			ctrlKey: false,
			shiftKey: false,
			...modifiers,
		} as React.MouseEvent);
		expect(onToggle).not.toHaveBeenCalled();
	});
});

// ── Tool card header ────────────────────────────────────────────────────────
describe("RenderToolCall header vs selection clicks", () => {
	function renderCard(onToggle: () => void) {
		const measured = measureToolCall(
			{ toolName: "Bash", summary: "bun test", category: "bash", status: "success" },
			WIDTH,
			5,
		);
		const rendered = renderLive(<RenderToolCall measured={measured} onToggle={onToggle} />);
		const header = rendered.container.querySelector("[data-nf-card-header]");
		if (!header) throw new Error("card header not rendered");
		return { ...rendered, header };
	}

	it("toggles on a plain click", () => {
		const onToggle = mock(() => {});
		const { header, unmount } = renderCard(onToggle);
		clickWith(header);
		expect(onToggle).toHaveBeenCalledTimes(1);
		unmount();
	});

	it("does NOT toggle on Ctrl/Shift+Click (the wrapper selects instead)", () => {
		const onToggle = mock(() => {});
		const { header, unmount } = renderCard(onToggle);
		clickWith(header, { ctrlKey: true });
		clickWith(header, { shiftKey: true });
		clickWith(header, { metaKey: true });
		expect(onToggle).not.toHaveBeenCalled();
		unmount();
	});

	it("carries TOOL_HEADER_SELECT_ATTR so the role=button header stays selectable", () => {
		const { header, unmount } = renderCard(() => {});
		expect(header.getAttribute(TOOL_HEADER_SELECT_ATTR)).not.toBeNull();
		unmount();
	});
});

// ── Reasoning header ────────────────────────────────────────────────────────
describe("RenderReasoning header vs selection clicks", () => {
	function renderCollapsed(onToggle: () => void) {
		const measured = measureReasoning({ text: "some reasoning" }, WIDTH, 5);
		// Loud failure if the form rules ever change what this test renders.
		expect(measured.form).toBe("collapsed");
		const rendered = renderLive(<RenderReasoning measured={measured} onToggle={onToggle} />);
		// The collapsed form is a single header Group — find it by its pointer
		// cursor (Mantine injects <style> siblings, so positional lookups lie;
		// React serializes inline styles without spaces).
		const header = rendered.container.querySelector('div[style*="cursor:pointer"]');
		if (!header) throw new Error("reasoning header not rendered");
		return { ...rendered, header };
	}

	it("toggles on a plain click", () => {
		const onToggle = mock(() => {});
		const { header, unmount } = renderCollapsed(onToggle);
		clickWith(header);
		expect(onToggle).toHaveBeenCalledTimes(1);
		unmount();
	});

	it("does NOT toggle on Ctrl/Shift+Click", () => {
		const onToggle = mock(() => {});
		const { header, unmount } = renderCollapsed(onToggle);
		clickWith(header, { ctrlKey: true });
		clickWith(header, { shiftKey: true });
		expect(onToggle).not.toHaveBeenCalled();
		unmount();
	});
});

// ── Trace header band + "show earlier" ──────────────────────────────────────
describe("RenderToolRun trace chrome vs selection clicks", () => {
	const MANY_ROWS = Array.from({ length: 12 }, (_, i) => ({
		title: `Read · file${i}.ts`,
		hasIcon: true,
		iconColor: "gray",
		key: `t-${i}`,
	}));

	function renderTrace(callbacks: { onToggleItems?: () => void; onToggleEarlier?: () => void }) {
		// collapseItems → the header band is a fold toggle; 12 rows > maxVisible(10)
		// with the list OPEN → the "show earlier" fold row is painted too.
		const measured = measureActivityTrace(
			MANY_ROWS,
			WIDTH,
			{ collapseItems: true, itemsOpened: true },
			{ label: "Tools", count: "12" },
			5,
		);
		expect(measured.header.hasChevron).toBe(true);
		expect(measured.toggle).not.toBeNull();
		const rendered = renderLive(
			<RenderToolRun
				measured={measured}
				onToggleItems={callbacks.onToggleItems}
				onToggleEarlier={callbacks.onToggleEarlier}
			/>,
		);
		const regions = Array.from(rendered.container.querySelectorAll('[role="button"]'));
		if (regions.length < 2) throw new Error("trace header band / toggle row not rendered");
		return { ...rendered, headerBand: regions[0], earlierRow: regions[1] };
	}

	it("toggles on plain clicks", () => {
		const onToggleItems = mock(() => {});
		const onToggleEarlier = mock(() => {});
		const { headerBand, earlierRow, unmount } = renderTrace({ onToggleItems, onToggleEarlier });
		clickWith(headerBand);
		clickWith(earlierRow);
		expect(onToggleItems).toHaveBeenCalledTimes(1);
		expect(onToggleEarlier).toHaveBeenCalledTimes(1);
		unmount();
	});

	it("does NOT toggle on Ctrl/Shift+Click", () => {
		const onToggleItems = mock(() => {});
		const onToggleEarlier = mock(() => {});
		const { headerBand, earlierRow, unmount } = renderTrace({ onToggleItems, onToggleEarlier });
		clickWith(headerBand, { ctrlKey: true });
		clickWith(headerBand, { shiftKey: true });
		clickWith(earlierRow, { ctrlKey: true });
		clickWith(earlierRow, { shiftKey: true });
		expect(onToggleItems).not.toHaveBeenCalled();
		expect(onToggleEarlier).not.toHaveBeenCalled();
		unmount();
	});

	it("marks the role=button chrome as selectable surface", () => {
		const { headerBand, earlierRow, container, unmount } = renderTrace({});
		for (const region of [headerBand, earlierRow]) {
			expect(region.getAttribute(TOOL_HEADER_SELECT_ATTR)).not.toBeNull();
		}
		// The per-row title line too: it is wrapped by TraceRowInteraction, whose
		// selection handler would otherwise skip a role="button" target.
		const titleRow = container.querySelector("[data-nf-trace-titlerow]");
		expect(titleRow?.getAttribute(TOOL_HEADER_SELECT_ATTR)).not.toBeNull();
		unmount();
	});
});

// ── Source guard: no bare fold-toggle bindings may come back ────────────────
describe("source guard — fold toggles stay behind swallowSelectionClick", () => {
	const RENDER_DIR = import.meta.dir;
	// A bare binding is `onClick={name}` (optionally gated) with NO wrapper call —
	// exactly the shape that collapsed cards under multi-select clicks.
	const BARE_BINDINGS = [
		"onClick={onToggle}",
		"onClick={onExpand}",
		"onClick={onToggleItems}",
		"onClick={onToggleEarlier}",
		"onClick={onTogglePrompt}",
	];
	const FILES = [
		"RenderToolCall.tsx",
		"RenderToolRun.tsx",
		"RenderReasoning.tsx",
		"RenderSubagent.tsx",
		"RenderMessageBubble.tsx",
	];

	for (const file of FILES) {
		it(`${file} has no bare fold-toggle onClick bindings`, () => {
			const source = readFileSync(resolve(RENDER_DIR, file), "utf8");
			for (const binding of BARE_BINDINGS) {
				expect(source.includes(binding)).toBe(false);
			}
			// …and the guard really is wired in (not just renamed away).
			expect(source).toContain("swallowSelectionClick");
		});
	}
});
