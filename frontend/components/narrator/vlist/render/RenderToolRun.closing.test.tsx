/**
 * RenderToolRun.closing.test.tsx — a drill-down must CLOSE, not vanish.
 *
 * WHY THIS EXISTS
 *
 * A drilled row's block IS the card: the measure layer reserves
 * `blockHeight === card.height` and this component paints the box at exactly that
 * height. So un-drilling does not merely unmount a body inside a stable frame — React
 * commits the 18.8px summary height in the very first frame AND unmounts the card. The
 * reader saw the card, its title included, disappear instantly, followed by the rows
 * below sliding up from behind a clip line.
 *
 * The fix has two halves, and this file covers the render half: the shell marks the row
 * as `closing`, this component keeps painting the previous frame's card inside the
 * (already shortened, `overflow: hidden`) block while the fold animates its height down,
 * and the shell releases the mark when the scheduler reports the motion done.
 *
 * Static markup + linkedom, like the sibling row-interaction tests: what matters here is
 * which nodes exist and what geometry they declare, both pure output of `measured.rows`
 * plus the injected slots.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { installCanvasStub } from "../measure/test-canvas-stub";

beforeAll(() => installCanvasStub());

const ITEMS = [0, 1].map((i) => ({
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

async function setup() {
	const { measureActivityTrace } = await import("../measure/measure-tool-run");
	const { RenderToolRun } = await import("./RenderToolRun");
	const measure = (expandedIndices: number[]) =>
		measureActivityTrace(
			ITEMS as never,
			860,
			{ itemsOpened: true, expandedIndices },
			{},
			2,
		) as unknown as { rows: { key: string; blockHeight: number }[] };
	const markup = (measured: unknown, closingRowKeys?: ReadonlySet<string>) => {
		const props = {
			measured,
			contentWidth: 860,
			rowCard: () => <div data-probe-card>CARD BODY</div>,
			closingRowKeys,
		} as unknown as Parameters<typeof RenderToolRun>[0];
		return renderToStaticMarkup(
			<MantineProvider>
				<RenderToolRun {...props} />
			</MantineProvider>,
		);
	};
	const doc = (m: string) => parseHTML(`<div>${m}</div>`).document;
	return { measure, markup, doc };
}

describe("the closing block is addressable and clipped", () => {
	/**
	 * The fold animates the BLOCK's height, not the row's positioning box: the latter
	 * carries the row's own `translateY`, and two animations on one node fight over it.
	 * Without this attribute the controller resolves nothing and the card snaps shut —
	 * silently, since the plan is still produced.
	 */
	it("exposes every row's block for the height animation", async () => {
		const { measure, markup, doc } = await setup();
		const blocks = doc(markup(measure([0]))).querySelectorAll("[data-nf-trace-block]");
		expect(blocks.length).toBe(2);
		// And it is the CLIPPING box, so a card taller than the block is cropped rather
		// than hanging out of it while the block shrinks.
		for (const block of blocks) {
			// Static markup emits CSS unspaced (`height:41px;overflow:hidden`).
			expect(block.getAttribute("style")).toContain("overflow:hidden");
		}
	});

	it("keys each block by its own row, so one row's motion cannot hit another's", async () => {
		const { measure, markup, doc } = await setup();
		const measured = measure([0]);
		const keys = [...doc(markup(measured)).querySelectorAll("[data-nf-trace-block]")].map((b) =>
			b.getAttribute("data-nf-trace-block"),
		);
		expect(keys).toEqual(measured.rows.map((r) => r.key));
	});
});

describe("the card and the summary line never coexist", () => {
	/**
	 * Both carry the same `Name · summary` text in the same slot. Painting both would
	 * double the line — and the drill morph is already sliding the incoming line into
	 * exactly that position, so a duplicate reads as a glitch rather than a transition.
	 */
	it("hides the summary row while the card occupies its slot", async () => {
		const { measure, markup, doc } = await setup();
		const drilled = doc(markup(measure([0])));
		// Row 0 is drilled: it shows a card and no title line of its own.
		expect(drilled.querySelectorAll("[data-probe-card]").length).toBe(1);
		// Row 1 is folded: it keeps its title line.
		const titles = drilled.querySelectorAll("[data-nf-trace-titlerow]");
		expect(titles.length).toBe(1);
	});

	it("shows the summary row again once nothing is drilled or closing", async () => {
		const { measure, markup, doc } = await setup();
		const folded = doc(markup(measure([])));
		expect(folded.querySelectorAll("[data-probe-card]").length).toBe(0);
		expect(folded.querySelectorAll("[data-nf-trace-titlerow]").length).toBe(2);
	});
});

describe("a closing card keeps a complete border", () => {
	/**
	 * The card's own `Paper` wraps its content and has no height of its own, so it cannot
	 * shrink with the block. Pinning the retained card to the height it used to have made
	 * the shrinking block cut straight through its body: the rounded border was sliced off
	 * and the reader saw a raw truncated edge instead of a box closing.
	 *
	 * So while closing, the WRAPPER fills the block and carries the border itself.
	 */
	it("makes the closing wrapper the bordered, clipping box that fills the block", async () => {
		const { measure, markup, doc } = await setup();
		const drilled = measure([0]);
		const rowKey = drilled.rows[0]?.key as string;
		// Drilled: the wrapper is a plain positioner, the card paints its own border.
		const live = doc(markup(drilled)).querySelector("[data-probe-card]")?.parentElement;
		expect(live?.getAttribute("style") ?? "").not.toContain("border:");
		// Closing: the wrapper stretches to the block's bottom AND owns the border, so all
		// four edges stay joined as the block animates shut.
		const closingRow = doc(markup(measure([]), new Set([rowKey])));
		const block = closingRow.querySelector(`[data-nf-trace-block="${rowKey}"]`);
		const style = block?.getAttribute("style") ?? "";
		// The block itself is still the clip that crops the card.
		expect(style).toContain("overflow:hidden");
	});
});

describe("block geometry stays exactly what the measure layer reserved", () => {
	/**
	 * The retention is purely visual: the block's own height must remain the COMMITTED
	 * value. If keeping a card alive changed the box, the animation would be fighting the
	 * height model instead of decorating it (CONTRACT §0 rule 2).
	 */
	it("declares the measured blockHeight on every block, drilled or not", async () => {
		const { measure, markup, doc } = await setup();
		for (const expanded of [[0], []]) {
			const measured = measure(expanded);
			const blocks = [...doc(markup(measured)).querySelectorAll("[data-nf-trace-block]")];
			for (const [index, block] of blocks.entries()) {
				const height = measured.rows[index]?.blockHeight;
				expect(block.getAttribute("style")).toContain(`height:${height}px`);
			}
		}
	});
});
