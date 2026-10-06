/**
 * vlist-closing-card-retention.test.tsx — a closing drill-down must still be PAINTED.
 *
 * ## The bug, and why it survived three attempted fixes
 *
 * A drilled row's block IS the card (`blockHeight === card.height`), so un-drilling both
 * shrinks the block AND unmounts the card in the same commit. The reader saw the card,
 * title included, vanish instantly, then the rows below slide up from behind a clip line.
 *
 * The fix needs TWO halves — animate the block's height down, and keep the card mounted
 * while that runs. The height half was implemented first and changed nothing, because it
 * was animating an EMPTY box. The retention half was then implemented in `RenderToolRun`
 * and STILL changed nothing, because `render-registry` dispatches an explicit prop
 * whitelist and `closingRowKeys` was not on it — so the prop was silently dropped one
 * layer above the component that needed it.
 *
 * Every one of those failures was invisible to the existing tests: the planner produced a
 * correct plan, the scheduler started a real animation, and the release callback fired on
 * time. Only the pixels were wrong. So this test goes through the REGISTRY and asserts on
 * a mounted DOM across a real re-render — the two things a static or unit-level probe
 * cannot see.
 *
 * Sequence: drilled → un-drilled but marked closing → released.
 * The middle frame is the one that used to lose the card.
 */

import { beforeAll, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { installCanvasStub } from "./measure/test-canvas-stub";

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
	g.IS_REACT_ACT_ENVIRONMENT = true;
});

it("card is RETAINED across the un-drill re-render, then dropped on release", async () => {
	const { measureActivityTrace } = await import("./measure/measure-tool-run");
	const { renderElement } = await import("./render-registry");

	const items = [0, 1].map((i) => ({
		kind: "tool" as const,
		title: `Read file${i}.ts`,
		toolUseId: `tu-${i}`,
		hasIcon: true,
		canDrillDown: true,
		card: {
			toolName: "Read",
			summary: `file${i}.ts`,
			category: "read" as const,
			status: "success" as const,
		},
	}));
	const measure = (idx: number[]) =>
		measureActivityTrace(items as never, 860, { itemsOpened: true, expandedIndices: idx }, {}, 2);
	const drilled = measure([0]);
	const rowKey = (drilled as unknown as { rows: { key: string }[] }).rows[0]?.key as string;

	const tree = (measured: unknown, closing?: ReadonlySet<string>) => {
		const extra: Record<string, unknown> = {
			rowCard: () => <div data-probe-card>CARD</div>,
		};
		if (closing) extra.closingRowKeys = closing;
		return (
			<MantineProvider>
				{
					(
						renderElement as unknown as (
							k: string,
							m: unknown,
							e: Record<string, unknown>,
						) => React.ReactNode
					)("activity-trace", measured, extra) as never
				}
			</MantineProvider>
		);
	};

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const cards = () => host.querySelectorAll("[data-probe-card]").length;

	// 1. drilled
	await act(async () => root.render(tree(drilled)));
	const whileDrilled = cards();
	// 2. un-drilled but CLOSING — this is the frame that used to lose the card
	await act(async () => root.render(tree(measure([]), new Set([rowKey]))));
	const whileClosing = cards();
	// 3. released
	await act(async () => root.render(tree(measure([]))));
	const afterRelease = cards();

	console.log(`drilled=${whileDrilled} closing=${whileClosing} released=${afterRelease}`);
	expect(whileDrilled).toBe(1);
	expect(whileClosing).toBe(1);
	expect(afterRelease).toBe(0);

	root.unmount();
	host.remove();
});

/**
 * The closing card must keep a COMPLETE border.
 *
 * The card's own `Paper` wraps its content and has no height, so it cannot shrink with the
 * block. Pinning the retained card to its old height made the shrinking block cut through
 * its body — the rounded border was sliced off and the reader saw a raw truncated edge.
 * While closing, the wrapper therefore fills the block and carries the border itself.
 *
 * Asserted on a MOUNTED tree because retention only exists across a re-render.
 */
it("closing wrapper fills the block and owns the border", async () => {
	const { measureActivityTrace } = await import("./measure/measure-tool-run");
	const { renderElement } = await import("./render-registry");

	const items = [0, 1].map((i) => ({
		kind: "tool" as const,
		title: `Read file${i}.ts`,
		toolUseId: `tu-${i}`,
		hasIcon: true,
		canDrillDown: true,
		card: {
			toolName: "Read",
			summary: `file${i}.ts`,
			category: "read" as const,
			status: "success" as const,
		},
	}));
	const measure = (idx: number[]) =>
		measureActivityTrace(items as never, 860, { itemsOpened: true, expandedIndices: idx }, {}, 2);
	const drilled = measure([0]);
	const rowKey = (drilled as unknown as { rows: { key: string }[] }).rows[0]?.key as string;
	const tree = (measured: unknown, closing?: ReadonlySet<string>) => {
		const extra: Record<string, unknown> = { rowCard: () => <div data-probe-card>CARD</div> };
		if (closing) extra.closingRowKeys = closing;
		return (
			<MantineProvider>
				{
					(
						renderElement as unknown as (
							k: string,
							m: unknown,
							e: Record<string, unknown>,
						) => React.ReactNode
					)("activity-trace", measured, extra) as never
				}
			</MantineProvider>
		);
	};

	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const wrapperStyle = () =>
		host.querySelector("[data-probe-card]")?.parentElement?.getAttribute("style") ?? "";

	await act(async () => root.render(tree(drilled)));
	// Drilled: the wrapper is a plain positioner; the card paints its own border.
	expect(wrapperStyle()).not.toContain("border:");

	await act(async () => root.render(tree(measure([]), new Set([rowKey]))));
	const closing = wrapperStyle();
	// Stretched to the block's bottom and clipping, so the CARD's own bordered `Paper`
	// (stretched to fill this box) is what shrinks.
	expect(closing).toContain("bottom:0");
	expect(closing).toContain("overflow:hidden");
	// ⚠️ And it must NOT paint a border itself. It did briefly, to carry the shrinking
	// outline, which gave every close TWO visible outlines — the retained card still
	// renders its own `Paper withBorder`.
	expect(closing).not.toContain("border:1px solid");

	root.unmount();
	host.remove();
});
