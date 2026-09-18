/**
 * vlist-compact-interaction.test.tsx — the compact marker must be OPERABLE in the
 * virtual list, not just painted.
 *
 * The bug this locks down: in Virtual-list mode a context-compact marker rendered
 * the right icon and the right "Context compacted" / "Compacting context… · N
 * chars" line, but the row carried no click handler at all — clicking it opened no
 * summary, and a compaction in flight offered no cancel affordance. The chunked
 * CompactIndicator has always done both (click → summary modal, click while
 * compacting → cancel confirm). Nothing failed: geometry and text were correct,
 * the marker was simply inert.
 *
 * Two layers are covered:
 *   1. the PURE target resolution (which rows are markers, which affordance each
 *      one gets) — `resolveVListCompactTarget`;
 *   2. the whole chain adapter → measure → render → DOM click, so a dropped prop
 *      in the render dispatch or a handler bound to the wrong branch fails here.
 *
 * Also asserted: the interaction never changes the marker's measured height (the
 * constant-height invariant `applyCompactProgress` relies on to skip anchoring).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { type AdapterSegment, adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { shellSource } from "./guard-source";
import { installCanvasStub } from "./measure/test-canvas-stub";
import { VLIST_REGISTRY } from "./registry";
import { renderElement, resolveRenderExtra } from "./render-registry";
import { resolveVListCompactTarget } from "./vlist-compact-target";

const CONTENT_WIDTH = 800;
const CANCEL_TITLE = "Cancel compaction";

const LABELS = {
	compacting: "Compacting context…",
	compacted: "Context compacted",
	compactFailed: "Compact failed",
	compactOutputChars: "{count} chars",
	segmentCompacting: "Segment compacting…",
	segmentCompacted: "Segment compacted ({count} messages)",
};

/** linkedom's KeyboardEvent constructor (there is no global one under Bun). */
let makeKeyDown: (key: string) => Event;

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
	// linkedom implements no KeyboardEvent, so synthesize one: React reads `key`
	// straight off the native event, and a bubbling Event reaches the delegated
	// root listener the same way.
	const EventCtor = (win as unknown as { Event: typeof Event }).Event;
	makeKeyDown = (key: string) => {
		const event = new EventCtor("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: key, configurable: true });
		return event;
	};
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

/** Adapt one system message carrying a single compact-family block. */
function adaptCompactBlock(block: Record<string, unknown>) {
	const seg: AdapterSegment = {
		kind: "message",
		msg: { id: "compact-msg", role: "system", contentJson: [block as never] },
	};
	const spec = adaptSegment(seg, { lod: 5, labels: LABELS })[0];
	if (!spec) throw new Error("no spec produced");
	return spec;
}

interface RenderedMarker {
	root: Element;
	row: Element;
	unmount: () => void;
	height: number;
}

/**
 * Drive one compact block through adapter → measure → render into a live DOM with
 * the injected callbacks, exactly as the shell's ExactRow does.
 */
function renderMarker(
	block: Record<string, unknown>,
	callbacks: { onOpenCompact?: () => void; onCancelCompact?: () => void } = {},
): RenderedMarker {
	const spec = adaptCompactBlock(block);
	expect(spec.kind).toBe("system-simple");
	const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, CONTENT_WIDTH, 5, spec.opts);
	const extra = resolveRenderExtra(spec);
	if (callbacks.onOpenCompact) extra.onOpenCompact = callbacks.onOpenCompact;
	if (callbacks.onCancelCompact) {
		extra.onCancelCompact = callbacks.onCancelCompact;
		extra.cancelCompactTitle = CANCEL_TITLE;
	}

	const container = document.createElement("div");
	document.body.appendChild(container);
	const reactRoot = createRoot(container);
	act(() => {
		reactRoot.render(
			<MantineProvider>{renderElement(spec.kind, measured, extra)}</MantineProvider>,
		);
	});
	const row = container.querySelector("[data-compact-status]");
	if (!row) throw new Error("compact row not rendered");
	return {
		root: container as unknown as Element,
		row,
		height: measured.height,
		unmount: () => {
			act(() => reactRoot.unmount());
			container.remove();
		},
	};
}

describe("resolveVListCompactTarget — which rows get which affordance", () => {
	it("a finished context compact opens its summary and cannot be cancelled", () => {
		expect(
			resolveVListCompactTarget("system-simple", { kind: "compact", status: "compacted" }, ["m1"]),
		).toEqual({
			kind: "context",
			messageId: "m1",
			status: "compacted",
			canOpen: true,
			canCancel: false,
		});
	});

	it("a RUNNING context compact cancels instead of opening", () => {
		expect(
			resolveVListCompactTarget("system-simple", { kind: "compact", status: "compacting" }, ["m1"]),
		).toEqual({
			kind: "context",
			messageId: "m1",
			status: "compacting",
			canOpen: false,
			canCancel: true,
		});
	});

	it("a failed compact still opens (the modal hosts the retry flow)", () => {
		const target = resolveVListCompactTarget(
			"system-simple",
			{ kind: "compact", status: "failed" },
			["m1"],
		);
		expect(target?.canOpen).toBe(true);
		expect(target?.canCancel).toBe(false);
	});

	it("segment markers open with the segment flavour and never offer cancel", () => {
		expect(
			resolveVListCompactTarget("system-simple", { kind: "segment_compact", status: "compacted" }, [
				"m2",
			]),
		).toMatchObject({ kind: "segment", canOpen: true, canCancel: false });
		// The cancel API is context-compact only (narrator-scoped), so a running
		// segment compaction stays inert rather than firing the wrong endpoint.
		expect(
			resolveVListCompactTarget(
				"system-simple",
				{ kind: "segment_compact", status: "compacting" },
				["m2"],
			),
		).toMatchObject({ canOpen: false, canCancel: false });
	});

	it("an unknown status is treated as compacted (adapter default parity)", () => {
		expect(
			resolveVListCompactTarget("system-simple", { kind: "compact", status: "weird" }, ["m1"]),
		).toMatchObject({ status: "compacted", canOpen: true });
	});

	it("non-compact system-simple cards and other kinds are not markers", () => {
		for (const kind of ["merge_summary", "review_feedback", "spec_continuation"]) {
			expect(resolveVListCompactTarget("system-simple", { kind }, ["m1"])).toBeNull();
		}
		expect(resolveVListCompactTarget("markdown", { kind: "compact" }, ["m1"])).toBeNull();
		expect(resolveVListCompactTarget("system-text", { kind: "compact" }, ["m1"])).toBeNull();
	});

	it("a row with no resolvable owning message is inert", () => {
		expect(resolveVListCompactTarget("system-simple", { kind: "compact" }, [])).toBeNull();
	});
});

describe("compact marker row — the injected callbacks actually fire", () => {
	it("clicking a compacted marker opens the summary", () => {
		let opened = 0;
		const marker = renderMarker(
			{ type: "compact", status: "compacted", summary: "the summary body" },
			{ onOpenCompact: () => opened++ },
		);
		expect(marker.row.getAttribute("data-compact-open")).toBe("1");
		expect(marker.row.getAttribute("data-compact-cancel")).toBeNull();
		act(() => (marker.row as unknown as HTMLElement).click());
		expect(opened).toBe(1);
		marker.unmount();
	});

	it("clicking a compacting marker cancels, and the row shows the cancel title", () => {
		let cancelled = 0;
		const marker = renderMarker(
			{ type: "compact", status: "compacting", outputChars: 42 },
			{ onCancelCompact: () => cancelled++ },
		);
		expect(marker.row.getAttribute("data-compact-cancel")).toBe("1");
		expect(marker.row.getAttribute("title")).toBe(CANCEL_TITLE);
		act(() => (marker.row as unknown as HTMLElement).click());
		expect(cancelled).toBe(1);
		marker.unmount();
	});

	it("a compacting marker never fires the open callback (no summary exists yet)", () => {
		let opened = 0;
		let cancelled = 0;
		const marker = renderMarker(
			{ type: "compact", status: "compacting", outputChars: 7 },
			{ onOpenCompact: () => opened++, onCancelCompact: () => cancelled++ },
		);
		act(() => (marker.row as unknown as HTMLElement).click());
		expect(opened).toBe(0);
		expect(cancelled).toBe(1);
		marker.unmount();
	});

	it("shows the live output char count while compacting", () => {
		const marker = renderMarker({ type: "compact", status: "compacting", outputChars: 128 });
		expect(marker.root.textContent ?? "").toContain("128 chars");
		expect(marker.root.textContent ?? "").toContain("Compacting context…");
		marker.unmount();
	});

	it("a segment marker opens through the same slot", () => {
		let opened = 0;
		const marker = renderMarker(
			{ type: "segment_compact", status: "compacted", messageCount: 12 },
			{ onOpenCompact: () => opened++ },
		);
		act(() => (marker.row as unknown as HTMLElement).click());
		expect(opened).toBe(1);
		marker.unmount();
	});

	it("without callbacks the row stays inert (harness / no provider)", () => {
		const marker = renderMarker({ type: "compact", status: "compacted" });
		expect(marker.row.getAttribute("data-compact-open")).toBeNull();
		expect(marker.row.getAttribute("data-compact-cancel")).toBeNull();
		// An inert marker must not enter the tab order or claim a button role.
		expect(marker.row.getAttribute("role")).toBeNull();
		expect(marker.row.getAttribute("tabindex")).toBeNull();
		// Clicking must not throw when nothing is bound.
		act(() => (marker.row as unknown as HTMLElement).click());
		marker.unmount();
	});

	it("an actionable marker is reachable as a button by keyboard", () => {
		let opened = 0;
		const marker = renderMarker(
			{ type: "compact", status: "compacted" },
			{ onOpenCompact: () => opened++ },
		);
		expect(marker.row.getAttribute("role")).toBe("button");
		expect(marker.row.getAttribute("tabindex")).toBe("0");
		for (const key of ["Enter", " "]) {
			act(() => {
				marker.row.dispatchEvent(makeKeyDown(key));
			});
		}
		expect(opened).toBe(2);
		// An unrelated key must not trigger the action.
		act(() => {
			marker.row.dispatchEvent(makeKeyDown("a"));
		});
		expect(opened).toBe(2);
		marker.unmount();
	});

	it("interaction never changes the marker's measured height", () => {
		// applyCompactProgress skips anchoring precisely because this height is
		// constant across the whole lifecycle — including the cancel ✕ glyph.
		const compacted = renderMarker({ type: "compact", status: "compacted" });
		const compacting = renderMarker(
			{ type: "compact", status: "compacting", outputChars: 999999 },
			{ onCancelCompact: () => {} },
		);
		const failed = renderMarker({ type: "compact", status: "failed" }, { onOpenCompact: () => {} });
		expect(compacting.height).toBe(compacted.height);
		expect(failed.height).toBe(compacted.height);
		compacted.unmount();
		compacting.unmount();
		failed.unmount();
	});
});

describe("shell wiring — the compact callbacks reach the row", () => {
	const SHELL = Promise.resolve(shellSource());
	const DISPATCH = Bun.file(new URL("./render-registry.tsx", import.meta.url).pathname).text();

	it("ExactRow forwards the per-row compact actions into the render extra", async () => {
		const shell = await SHELL;
		expect(shell).toContain("if (compactActions) {");
		expect(shell).toContain("extra.onOpenCompact = compactActions.onOpenCompact");
		expect(shell).toContain("extra.onCancelCompact = compactActions.onCancelCompact");
		// Bound per row from the bridge, and part of the memo signature so a marker
		// transitioning compacting → compacted re-renders with the new affordance.
		expect(shell).toContain("compactActions={compact.byKey.get(item.spec.key)}");
		expect(shell).toContain("prev.compactActions === next.compactActions");
	});

	it("the shell hosts one shared cancel dialog", async () => {
		const shell = await SHELL;
		expect(shell).toContain("useVListCompactActions({ narratorId, renderItems, sourceIdsByKey })");
		expect(shell).toContain("{compact.cancelDialog}");
	});

	it("the render dispatch passes the compact props to RenderSystemSimple", async () => {
		const dispatch = await DISPATCH;
		expect(dispatch).toContain("onOpenCompact={extra.onOpenCompact as (() => void) | undefined}");
		expect(dispatch).toContain(
			"onCancelCompact={extra.onCancelCompact as (() => void) | undefined}",
		);
	});
});
