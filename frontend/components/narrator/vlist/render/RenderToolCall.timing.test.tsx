/**
 * RenderToolCall.timing.test.tsx — the header's timing affordances in the exact
 * virtual list.
 *
 * The gap this locks down: the vlist header painted a bare `<span>` with the
 * duration, while the chunked ToolCallCard wraps the same text in a clickable
 * region that opens a lifecycle BREAKDOWN (streaming → permission wait →
 * execution → completion, plus three summary lines) and, for a running call with
 * a deadline, a timeout editor. None of that existed here, and none of it is
 * visible to the height model — so no measure test could have caught it.
 *
 * Two things are asserted through the real measure → render chain:
 *   1. the breakdown's CONTENT (phase rows + deltas + summaries), and
 *   2. the header's TRIGGER: present with an accessible label when there is
 *      something to show, absent when the card carries no stamps at all.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installCanvasStub } from "../measure/test-canvas-stub";

let measureMod: typeof import("../measure/measure-tool-call");
let renderMod: typeof import("./RenderToolCall");

beforeAll(async () => {
	installCanvasStub();
	measureMod = await import("../measure/measure-tool-call");
	renderMod = await import("./RenderToolCall");
});

it("shows a live question slot even when the measured card is folded", () => {
	const unique = "UNIQUE_FOLDED_BODY_SHOULD_STAY_HIDDEN";
	const measured = {
		...card({
			toolName: "Bash",
			status: "success",
			detail: {
				kind: "sections",
				sections: [
					{
						key: "command",
						body: {
							kind: "capped",
							id: "command-body",
							source: "input.command",
							format: "code",
							live: false,
							followTarget: { kind: "end" },
							cap: "bash-cmd",
							text: unique,
						},
					},
				],
			},
		}),
		effectiveOpened: false,
	};
	const root = render(
		<renderMod.RenderToolCall
			measured={measured}
			permissionSlot={<form data-question="q1">Answer here</form>}
		/>,
	);
	expect(root.querySelectorAll('form[data-question="q1"]').length).toBe(1);
	expect(root.textContent).not.toContain(unique);
	const opened = render(
		<renderMod.RenderToolCall
			measured={{ ...measured, effectiveOpened: true }}
			permissionSlot={<form data-question="q1">Answer here</form>}
		/>,
	);
	expect(opened.querySelectorAll('form[data-question="q1"]').length).toBe(1);
	expect(opened.textContent).toContain(unique);
	const settled = render(<renderMod.RenderToolCall measured={measured} />);
	expect(settled.querySelectorAll("form").length).toBe(0);
});

const CONTENT_WIDTH = 600;

/** Recognizable label bundle: every phase row is identifiable by its own token. */
const LABELS = {
	title: "TIMING",
	started: "STARTED",
	streamStarted: "STREAM",
	permissionStarted: "PERM",
	executionStarted: "EXEC",
	completed: "DONE",
	total: "TOTAL {duration}",
	permissionWait: "WAIT {duration}",
	execution: "RUN {duration}",
	startedAt: "AT {time}",
	timeoutSeconds: "SECONDS",
	timeoutUpdate: "UPDATE",
};

type ToolCallData = import("../measure/measure-tool-call").ToolCallData;

function card(overrides: Partial<ToolCallData> = {}) {
	return measureMod.measureToolCall(
		{
			toolName: "Bash",
			summary: "bun test",
			category: "bash",
			status: "success",
			...overrides,
		} as ToolCallData,
		CONTENT_WIDTH,
		5,
	);
}

function render(node: ReactNode): Element {
	const html = renderToStaticMarkup(
		<MantineProvider forceColorScheme="dark">{node}</MantineProvider>,
	);
	const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body>`);
	return document.getElementById("r") as unknown as Element;
}

/** Every `aria-label` in the tree (the timing trigger publishes its start here). */
function ariaLabels(root: Element): string[] {
	return Array.from(root.querySelectorAll("[aria-label]")).map(
		(node) => node.getAttribute("aria-label") ?? "",
	);
}

// ── Breakdown body ────────────────────────────────────────────────────────────
describe("timing breakdown — phase rows and summaries", () => {
	const FULL = {
		createdAt: 1_000,
		startedAt: 1_000,
		streamStartedAt: 1_200,
		permissionStartedAt: 1_500,
		executionStartedAt: 3_000,
		completedAt: 8_000,
		durationMs: 7_000,
	};

	function breakdown(timing: Partial<typeof FULL>, displayDurationMs?: number) {
		return render(
			<renderMod.__TEST__ToolTimingBreakdown
				timing={measureMod.resolveToolTimingStamps(timing)}
				displayDurationMs={displayDurationMs}
				labels={LABELS}
			/>,
		).textContent;
	}

	it("lists every phase the card recorded", () => {
		const text = breakdown(FULL) ?? "";
		expect(text).toContain("TIMING");
		expect(text).toContain("STREAM");
		expect(text).toContain("PERM");
		expect(text).toContain("EXEC");
		expect(text).toContain("DONE");
	});

	it("shows the three duration summaries with substituted values", () => {
		const text = breakdown(FULL) ?? "";
		// total = completed - earliest start (8000 - 1000)
		expect(text).toContain("TOTAL 7.0s");
		// permission wait = execution - permission (3000 - 1500)
		expect(text).toContain("WAIT 1.5s");
		// execution = completed - execution start (8000 - 3000)
		expect(text).toContain("RUN 5.0s");
		// No unsubstituted placeholder may survive into the DOM.
		expect(text).not.toContain("{duration}");
	});

	it("suppresses the generic Started row when it coincides with a named phase", () => {
		// Chunk parity (ToolTimingPopoverLabel's genericStarted): otherwise the same
		// timestamp is listed twice on every card whose start IS its stream start.
		const coincident = breakdown({ startedAt: 1_200, streamStartedAt: 1_200 }) ?? "";
		expect(coincident).toContain("STREAM");
		expect(coincident).not.toContain("STARTED");
		// A genuinely distinct start still gets its own row.
		const distinct = breakdown({ startedAt: 1_000, streamStartedAt: 1_200 }) ?? "";
		expect(distinct).toContain("STARTED");
	});

	it("derives the completion row from execution start + displayed duration", () => {
		// A card whose completedAt never persisted still closes out its timeline.
		const text = breakdown({ executionStartedAt: 2_000 }, 4_000) ?? "";
		expect(text).toContain("DONE");
		expect(text).toContain("RUN 4.0s");
	});

	it("falls back to earliest start + final duration when execution is unknown", () => {
		const text = breakdown({ createdAt: 1_000, durationMs: 2_500 }) ?? "";
		expect(text).toContain("DONE");
		expect(text).toContain("TOTAL 2.5s");
	});

	it("renders nothing when the card has no stamps at all", () => {
		// `textContent` also carries MantineProvider's injected stylesheet, so assert
		// on the breakdown's own tokens rather than an empty string.
		const text = breakdown({}) ?? "";
		expect(text).not.toContain("TIMING");
		expect(text).not.toContain("DONE");
		expect(text).not.toContain("TOTAL");
	});
});

// ── Header trigger ────────────────────────────────────────────────────────────
describe("tool header — timing trigger", () => {
	it("exposes the earliest start as the trigger's accessible label", () => {
		const root = render(
			<renderMod.RenderToolCall
				measured={card({ createdAt: 1_000, executionStartedAt: 2_000, durationMs: 500 })}
				labels={{ timing: LABELS }}
			/>,
		);
		// `{time}` is substituted with the locale-formatted earliest start.
		const label = ariaLabels(root).find((value) => value.startsWith("AT "));
		expect(label).toBeDefined();
		expect(label).not.toContain("{time}");
	});

	it("paints a plain duration with NO trigger when the card carries no stamps", () => {
		// A history card that only ever recorded `durationMs` must not gain an
		// interactive affordance that would open an empty popover.
		const root = render(
			<renderMod.RenderToolCall
				measured={card({ durationMs: 1_500 })}
				labels={{ timing: LABELS }}
			/>,
		);
		expect(root.textContent).toContain("1s");
		expect(ariaLabels(root).some((value) => value.startsWith("AT "))).toBe(false);
	});

	it("keeps the trigger for a RUNNING card with an editable timeout", () => {
		const root = render(
			<renderMod.RenderToolCall
				measured={card({ status: "running", startedAt: Date.now(), timeoutMs: 120_000 })}
				labels={{ timing: LABELS }}
				onUpdateTimeout={() => {}}
			/>,
		);
		expect(ariaLabels(root).some((value) => value.startsWith("AT "))).toBe(true);
		// The `/ timeout` suffix rides the same fixed row.
		expect(root.textContent).toContain("/ 2m");
	});

	it("still renders the timeout suffix without an update sender (read-only)", () => {
		const root = render(
			<renderMod.RenderToolCall
				measured={card({ status: "running", startedAt: Date.now(), timeoutMs: 30_000 })}
				labels={{ timing: LABELS }}
			/>,
		);
		expect(root.textContent).toContain("/ 30s");
	});
});

// ── Grouped header ────────────────────────────────────────────────────────────
describe("grouped tool header — aggregate timing", () => {
	function group(cards: Array<Partial<ToolCallData>>) {
		return measureMod.measureToolCallGroup(
			cards.map(
				(overrides) =>
					({
						toolName: "Read",
						summary: "src/index.ts",
						category: "read",
						status: "success",
						...overrides,
					}) as ToolCallData,
			),
			CONTENT_WIDTH,
		);
	}

	it("shows the summed duration tooltipped with the earliest start", () => {
		const root = render(
			<renderMod.RenderToolCallGroup
				measured={group([
					{ durationMs: 400, startedAt: 3_000 },
					{ durationMs: 600, createdAt: 1_000 },
				])}
				label="Read"
				timingLabels={LABELS}
			/>,
		);
		expect(root.textContent).toContain("1.0s");
	});

	it("draws no timing at all when the children carry none", () => {
		// Previously the grouped header had no timing slot whatsoever; the empty case
		// must stay empty rather than showing a bare "0ms".
		const root = render(
			<renderMod.RenderToolCallGroup
				measured={group([{}, {}])}
				label="Read"
				timingLabels={LABELS}
			/>,
		);
		expect(root.textContent).not.toContain("0ms");
	});
});
