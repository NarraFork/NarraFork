/**
 * RenderToolRun.rowstatus.test.tsx — a folded trace row PAINTS its outcome and its
 * duration.
 *
 * WHY THIS EXISTS
 * A folded row used to say only WHAT ran. Shimmer marked "something is live", but a
 * call that had FAILED and one that had succeeded rendered identically, and no row
 * carried a duration at all — so dropping to a low LOD silently cost the reader two
 * of the three things they read a tool row for. The row now ends with a status glyph
 * and a timing slot, which is what these tests pin.
 *
 * The paired measure test (`measure-tool-run.test.ts` → "row status + timing are
 * height-neutral") proves this costs no height. This file proves it is actually
 * drawn, and drawn per row — the failure mode a geometry test cannot see is a
 * correct height around a slot that renders nothing, or one row's outcome painted
 * onto its neighbour.
 *
 * Static markup, no DOM harness: the glyphs and the duration text are pure output of
 * `measured.rows`, so `renderToStaticMarkup` is the cheapest faithful probe. Tabler
 * stamps `tabler-icon-<name>` on every glyph, which identifies the mark without
 * depending on Mantine's generated class names.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { measureActivityTrace } from "../measure/measure-tool-run";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { RenderToolRun } from "./RenderToolRun";

const disposeCanvasStub = installCanvasStub();
afterAll(() => disposeCanvasStub());

let parse: (html: string) => Element;

beforeAll(() => {
	parse = (html: string) => {
		const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
		const root = document.getElementById("r");
		if (!root) throw new Error("no root");
		return root as unknown as Element;
	};
});

const WIDTH = 700;

function render(node: React.ReactNode): Element {
	return parse(
		renderToStaticMarkup(<MantineProvider defaultColorScheme="dark">{node}</MantineProvider>),
	);
}

interface RowInput {
	status?: string;
	timing?: {
		createdAt?: number;
		executionStartedAt?: number;
		completedAt?: number;
		durationMs?: number;
	};
	/** An earlier same-turn call still owns the execution slot (shimmer/mark input). */
	queuedBehindUpstream?: boolean;
	/** A live reflection gate on this call. */
	reflectionStatus?: string;
	/** The figure the row should paint when it differs from `timing.durationMs`. */
	displayDurationMs?: number;
}

function trace(rows: RowInput[]): Element {
	const measured = measureActivityTrace(
		rows.map((row, i) => ({
			title: `Read · file${i}.ts`,
			hasIcon: true,
			iconColor: "gray",
			key: `t-${i}`,
			...row,
		})),
		WIDTH,
	);
	return render(<RenderToolRun measured={measured} />);
}

/** Every status slot in document order (one per row that carries a status). */
function statusSlots(root: Element): Element[] {
	return Array.from(root.querySelectorAll('[data-testid="trace-row-status-slot"]'));
}

/** The Tabler glyph name inside one slot, or null for an empty slot. */
function glyphName(slot: Element): string | null {
	const svg = slot.querySelector("svg");
	const cls = String((svg as unknown as HTMLElement | null)?.getAttribute("class") ?? "");
	return /tabler-icon-([a-z0-9-]+)/.exec(cls)?.[1] ?? null;
}

describe("a folded trace row paints its outcome", () => {
	it("marks in-flight, failure and cancellation — and leaves success bare", async () => {
		// Three marks for four rows, because SUCCESS is deliberately unmarked: it is the
		// default expectation, so a check on every ordinary row is a column of noise that
		// costs exactly the attention a real failure needs (see @shared/tool-row-status).
		// Distinctness across the marked set is the other half of the invariant —
		// asserting one glyph alone would still pass a row that showed it for everything.
		const root = trace([
			{ status: "running" },
			{ status: "success" },
			{ status: "fail" },
			{ status: "cancelled" },
		]);
		const names = statusSlots(root).map(glyphName);
		expect(names).toHaveLength(3);
		expect(new Set(names).size).toBe(3);
		expect(names).toEqual(["loader-2", "circle-x", "ban"]);
	});

	it("draws NO slot for a successful call (not an empty one)", async () => {
		// The distinction that makes the change worth anything: an empty 12px slot on
		// every successful row would be the same useless column the check was.
		expect(statusSlots(trace([{ status: "success" }]))).toHaveLength(0);
		expect(statusSlots(trace([{ status: "completed" }]))).toHaveLength(0);
	});

	it("spins for `streaming` — the FIRST status a live call has", async () => {
		// `tool_use_chunk` labels a call `streaming` while the model is still writing its
		// arguments. Treating that as unknown is what once made a brand-new row show an
		// empty slot and only start spinning a beat later.
		const root = trace([{ status: "streaming" }]);
		expect(glyphName(statusSlots(root)[0] as Element)).toBe("loader-2");
	});

	it("withholds the mark for an unrecognised status instead of guessing", async () => {
		// A provider can send a status this frontend has never heard of. Neither a check
		// nor a spinner is honest there: a spinner in particular would claim a finished
		// call is still running, FOREVER, since nothing will ever move it on. Drawing
		// nothing merely admits we do not know.
		for (const status of ["", "somethingNew"]) {
			expect(statusSlots(trace([{ status }]))).toHaveLength(0);
		}
	});

	it("draws NO slot for a row with no lifecycle (reasoning steps)", async () => {
		// Reasoning rows have no outcome to report. Omitting the slot entirely — rather
		// than reserving an always-empty one — is what keeps those rows byte-identical
		// to before this change.
		expect(statusSlots(trace([{}]))).toHaveLength(0);
	});
});

describe("a folded trace row paints its duration", () => {
	it("shows the final duration of a finished call", async () => {
		// Formatting belongs to the shared timing component (`formatDurationText`), so
		// this asserts only that the row is no longer SILENT about how long the call
		// took — a specific rendering would pin this test to that component's style
		// choice rather than to the invariant.
		const withTiming = rowText(
			trace([{ status: "success", timing: { createdAt: 0, durationMs: 7_000 } }]),
		);
		const without = rowText(trace([{ status: "success" }]));
		expect(withTiming).not.toBe(without);
		expect(withTiming).toContain("7");
	});

	it("keeps each row's duration on its OWN row", async () => {
		// A positional mis-pairing would confidently attribute one tool's duration to
		// another — worse than showing none. Read per row, not from the whole trace.
		const root = trace([
			{ status: "success", timing: { createdAt: 0, durationMs: 3_000 } },
			{ status: "success", timing: { createdAt: 0, durationMs: 9_000 } },
		]);
		const texts = rowTexts(root);
		expect(texts).toHaveLength(2);
		expect(texts[0]).toContain("3");
		expect(texts[0]).not.toContain("9");
		expect(texts[1]).toContain("9");
		expect(texts[1]).not.toContain("3");
	});

	it("leaves a row with no stamps plain (no placeholder duration)", async () => {
		// A header can legitimately arrive with no timing at all; inventing a "0s" there
		// would read as a real measurement.
		expect(rowText(trace([{ status: "success" }]))).not.toMatch(/\d+\s*(ms|s)\b/);
	});

	it("paints `displayDurationMs` in preference to the full attributed span", async () => {
		// For bash, `timing.durationMs` absorbs permission / reflection / queue waiting,
		// so a 1.2s command that waited 19s on a gate reported 20s. The row must show
		// the same figure the expanded card does — see the duration-parity test.
		const text = rowText(
			trace([
				{
					status: "success",
					timing: { createdAt: 0, completedAt: 20_000, durationMs: 20_000 },
					displayDurationMs: 1_200,
				},
			]),
		);
		// `formatDurationText`'s default style floors to whole seconds, so 1200ms reads
		// as "1s". The assertion that matters is that 20s is GONE.
		expect(text).toContain("1s");
		expect(text).not.toContain("20s");
	});
});

describe("a row that has not executed says nothing about elapsed time", () => {
	// THE BUG: three Bash calls queued behind a danger-reflection gate each showed a
	// ticking counter (17s / 12s / 11s) plus a spinning blue loader. None had run for
	// a millisecond — the counter was measuring from the moment the model began
	// writing their arguments, and the spinner was claiming work was under way.

	it("draws a static clock for a QUEUED row, never a spinner", async () => {
		const root = trace([{ status: "initializing", queuedBehindUpstream: true }]);
		const slot = statusSlots(root)[0] as Element;
		expect(glyphName(slot)).toBe("clock");
		expect(glyphName(slot)).not.toBe("loader-2");
		// The spin class is the actual motion; a static glyph with it would still move.
		expect(String(slot.querySelector("svg")?.getAttribute("class") ?? "")).not.toContain(
			"vlist-spin",
		);
	});

	it("shows NO elapsed counter on a queued row", async () => {
		// `createdAt` 30s ago with no execution stamp: the old code rendered "30s".
		const text = rowText(
			trace([
				{
					status: "initializing",
					queuedBehindUpstream: true,
					timing: { createdAt: Date.now() - 30_000 },
				},
			]),
		);
		expect(text).not.toMatch(/\d+\s*(ms|s)\b/);
	});

	it("draws a static pause glyph for a row awaiting a decision", async () => {
		// `pending` means a person is being waited on at every write site. It used to
		// spin here, while the card beside it drew a YELLOW spinner and the shimmer
		// drew nothing — three surfaces, three answers.
		const slot = statusSlots(trace([{ status: "pending" }]))[0] as Element;
		expect(glyphName(slot)).toBe("player-pause");
		expect(String(slot.querySelector("svg")?.getAttribute("class") ?? "")).not.toContain(
			"vlist-spin",
		);
	});

	it("marks a row whose reflection gate is deliberating as awaiting", async () => {
		const slot = statusSlots(trace([{ status: "running", reflectionStatus: "running" }]))[0];
		expect(glyphName(slot as Element)).toBe("player-pause");
	});

	it("KEEPS the spinner and the counter for a genuinely running row", async () => {
		// The other half of the fix: this is not "stop spinning". A call that really is
		// executing must still say so, or the change has removed the signal instead of
		// correcting it.
		const root = trace([
			{ status: "running", timing: { createdAt: 0, executionStartedAt: Date.now() - 5_000 } },
		]);
		const slot = statusSlots(root)[0] as Element;
		expect(glyphName(slot)).toBe("loader-2");
		expect(String(slot.querySelector("svg")?.getAttribute("class") ?? "")).toContain("vlist-spin");
		expect(rowText(root)).toMatch(/\d+\s*s\b/);
	});

	it("counts a running row's elapsed time from EXECUTION, not from stream start", async () => {
		// A call admitted after a 60s gate wait must start its counter near zero, not
		// jump straight to 60s — that number describes waiting, not the tool's work.
		const now = Date.now();
		const text = rowText(
			trace([
				{
					status: "running",
					timing: { createdAt: now - 60_000, executionStartedAt: now - 2_000 },
				},
			]),
		);
		expect(text).not.toContain("60s");
		// Anchored at the END of the row text: the title itself ends in `.ts`, so a
		// `\b`-delimited pattern matches inside it and passes vacuously.
		expect(text).toMatch(/[12]s$/);
	});
});

/**
 * The text of each ROW, innermost container only.
 *
 * Anchored on the category CHIP rather than the status slot: a successful row has no
 * status slot at all now, so a slot-based selector would silently find zero rows and
 * make the per-row duration assertions pass vacuously.
 */
function rowTexts(root: Element): string[] {
	return Array.from(root.querySelectorAll("div"))
		.filter((el) => el.querySelectorAll("[data-trace-row-chip]").length === 1)
		.filter((el, _i, all) => !all.some((other) => other !== el && el.contains(other)))
		.map((el) => el.textContent ?? "");
}

/** The single row's text (fails loudly if the trace did not render exactly one). */
function rowText(root: Element): string {
	const texts = rowTexts(root);
	expect(texts).toHaveLength(1);
	return texts[0] as string;
}
