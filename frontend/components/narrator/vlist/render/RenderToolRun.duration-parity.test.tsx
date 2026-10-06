/**
 * RenderToolRun.duration-parity.test.tsx — ONE tool call reports ONE duration,
 * whichever LOD the reader is at.
 *
 * THE BUG THIS PINS. A bash call's `durationMs` is the whole span the loop
 * attributes to it: for a tool with a `streamStartedAt` that is
 * `now - streamStartedAt` minus preceding tools' execution time, so it INCLUDES
 * time spent waiting on a permission gate, a reflection gate, or queued behind a
 * sibling. The tool's own `execute()` span goes to `_metadata.execDurationMs`.
 *
 * The expanded CARD applied that preference (`displayDurationMs`). The folded trace
 * row did not — it painted raw `timing.durationMs`. So a `git diff` that ran in
 * 1.2s behind a 19s danger-reflection gate showed "1s" as a card and "20s" as a
 * row, and dropping the LOD silently changed the answer.
 *
 * WHY THIS TEST SHAPE. Asserting the row's figure alone would pass while the card
 * drifted the other way; asserting a literal string would pin both to
 * `formatDurationText`'s current style choice. So it runs the SAME tool payload
 * through both real chains — adapter → measure → render, twice — and compares the
 * rendered text against each other, then checks the waiting time is not what either
 * shows.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type AdapterContext,
	type AdapterSegment,
	adaptActivityUnit,
	adaptSegment,
} from "../segment-adapter";

let installCanvasStub: typeof import("../measure/test-canvas-stub").installCanvasStub;
let dispose: (() => void) | undefined;
let measureToolCall: typeof import("../measure/measure-tool-call").measureToolCall;
let measureActivityTrace: typeof import("../measure/measure-tool-run").measureActivityTrace;
let RenderToolCall: typeof import("./RenderToolCall").RenderToolCall;
let RenderToolRun: typeof import("./RenderToolRun").RenderToolRun;

beforeAll(async () => {
	({ installCanvasStub } = await import("../measure/test-canvas-stub"));
	dispose = installCanvasStub();
	({ measureToolCall } = await import("../measure/measure-tool-call"));
	({ measureActivityTrace } = await import("../measure/measure-tool-run"));
	({ RenderToolCall } = await import("./RenderToolCall"));
	({ RenderToolRun } = await import("./RenderToolRun"));
});
afterAll(() => dispose?.());

const WIDTH = 700;

/**
 * A bash call that RAN for 1.2s but was attributed 20s.
 *
 * The exact shape the reported case had: a `git diff` admitted only after a danger
 * reflection released it, so ~19s of the attributed span is waiting.
 */
const BASH_TC = {
	toolName: "Bash",
	toolUseId: "tu-parity",
	status: "success",
	inputJson: { command: "git diff --stat", description: "Diff frontend changes" },
	createdAt: 1_000,
	permissionStartedAt: 1_100,
	executionStartedAt: 19_800,
	completedAt: 21_000,
	durationMs: 20_000,
	outputJson: { _text: "1 file changed", _metadata: { execDurationMs: 1_200 } },
};

const CTX: AdapterContext = { lod: 5, resolveToolCategory: () => "bash" };

function render(node: React.ReactNode): Element {
	const html = renderToStaticMarkup(
		<MantineProvider defaultColorScheme="dark">{node}</MantineProvider>,
	);
	const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
	return document.getElementById("r") as unknown as Element;
}

/**
 * The DURATION a rendered surface painted, or null when it painted none.
 *
 * Selects the timing cell by its own marker rather than matching the tail of the
 * container's `textContent`: a chevron (card) and a flex spacer (row) follow the
 * timing in the DOM, so an end-anchored pattern matches nothing and the assertion
 * would pass vacuously.
 *
 * The `/ 2m` timeout suffix is stripped, because only the CARD carries one: a row's
 * timing payload (`cardTiming`) has no `timeoutMs` and a row hosts no timeout
 * editor. That difference is deliberate and out of scope here — this test is about
 * the two surfaces reporting the same DURATION for one call, not about making the
 * row grow a card affordance.
 */
function durationText(root: Element): string | null {
	const cells = Array.from(root.querySelectorAll("[data-nf-tool-timing]"));
	expect(cells.length).toBeLessThanOrEqual(1);
	const text = cells[0]?.textContent;
	if (text == null) return null;
	const [duration] = text.split("/");
	return (duration ?? "").trim();
}

/** The card's header, via the real adapter → measure → render chain. */
function cardHeader(): Element {
	const seg: AdapterSegment = {
		kind: "tool-run",
		sourceMessages: [],
		items: [{ blockIndex: 0, isSubagent: false, tc: BASH_TC }],
	};
	const spec = adaptSegment(seg, CTX).find((s) => s.key === "tool-tu-parity");
	if (!spec) throw new Error("adapter produced no tool card spec");
	const measured = measureToolCall(
		spec.data as Parameters<typeof measureToolCall>[0],
		WIDTH,
		5,
		// Folded: the header is the only thing under test, and an expanded body would
		// pull the command text (which contains no duration) into `textContent`.
		{ opened: false },
	);
	const root = render(<RenderToolCall measured={measured} />);
	const header = root.querySelector("[data-nf-card-header]");
	if (!header) throw new Error("card rendered no header");
	return header;
}

/** The folded row element, via the real adapter → measure → render chain. */
function traceRow(): Element {
	const unit = adaptActivityUnit(
		[
			{
				kind: "tool",
				msg: { id: "m1", role: "assistant", contentJson: [] },
				blockIndex: 0,
				isSubagent: false,
				tc: BASH_TC,
			},
		],
		"act-parity",
		// L2: the level at which a completed call folds into a named trace row.
		{ ...CTX, lod: 2 },
	);
	const items = (unit.data as { items: Parameters<typeof measureActivityTrace>[0] }).items;
	const measured = measureActivityTrace(items, WIDTH);
	const root = render(<RenderToolRun measured={measured} />);
	// The innermost container holding exactly one category chip IS one row.
	const rows = Array.from(root.querySelectorAll("div"))
		.filter((el) => el.querySelectorAll("[data-trace-row-chip]").length === 1)
		.filter((el, _i, all) => !all.some((other) => other !== el && el.contains(other)));
	expect(rows).toHaveLength(1);
	return rows[0] as Element;
}

describe("a bash call's duration does not change with the LOD", () => {
	it("paints the SAME figure as a card and as a folded row", async () => {
		const card = durationText(cardHeader());
		const row = durationText(traceRow());
		// Not vacuous: both surfaces really did paint a timing cell.
		expect(card).not.toBeNull();
		expect(row).not.toBeNull();
		expect(row).toBe(card);
	});

	it("really is painting the preferred figure, not just echoing durationMs", async () => {
		// Non-vacuity, asserted rather than assumed: the row's own payload still carries
		// the full 20s span (the popover's "Total" depends on it), so a surface that
		// simply echoed `timing.durationMs` would print 20s. Printing 1s therefore proves
		// the shared preference rule ran — without this, both assertions below would also
		// pass if `execDurationMs` had silently become the only value in play.
		const unit = adaptActivityUnit(
			[
				{
					kind: "tool",
					msg: { id: "m1", role: "assistant", contentJson: [] },
					blockIndex: 0,
					isSubagent: false,
					tc: BASH_TC,
				},
			],
			"act-nonvacuous",
			{ ...CTX, lod: 2 },
		);
		const items = (unit.data as { items: Array<Record<string, unknown>> }).items;
		const row = items[0] as { timing?: Record<string, number>; displayDurationMs?: number };
		expect(row.timing?.durationMs).toBe(20_000);
		expect(row.displayDurationMs).toBe(1_200);
		expect(durationText(traceRow())).toBe("1s");
	});

	it("shows the EXECUTION time, not the 20s that includes the gate wait", async () => {
		// The figure that made this a bug rather than a cosmetic difference: "20s" beside
		// `git diff --stat` reads as a slow command and sends the reader hunting for a
		// performance problem that does not exist. The waiting is still reported — in the
		// timing popover's phase breakdown, labelled as waiting.
		//
		// `1s` rather than `1.2s`: `formatDurationText`'s default style floors to whole
		// seconds. What matters is that 20s is gone from both.
		for (const surface of [cardHeader(), traceRow()]) {
			expect(durationText(surface)).toBe("1s");
		}
	});
});
