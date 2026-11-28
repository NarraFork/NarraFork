/**
 * The team page's chip and divider rows paint exactly their measured box, show the action, the
 * count and an error mark, and the chip's click is the shell's ordinary fold toggle.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installCanvasStub } from "../measure/test-canvas-stub";

const dispose = installCanvasStub();
afterAll(dispose);
const { measureTeamChip, measureTeamEvent } = await import("../measure/measure-team-row");
const { RenderTeamChip, RenderTeamEvent } = await import("./RenderTeamRow");
const { renderElement } = await import("../render-registry");
const { measureElementCached } = await import("../registry");
const { traceMetrics } = await import("../measure/measure-tool-run");
const { resolveRowOpenState, TOGGLEABLE_CARD_KINDS } = await import("../vlist-exact-row-state");
const { createVListInteractionState } = await import("../vlist-interaction-state");

const chipData = (failed = 0) => ({
	label: "创建工作项",
	count: 7,
	countLabel: " ×7",
	failed,
	failedLabel: failed ? `${failed} 次失败` : "",
	cancelled: 0,
	cancelledLabel: "",
	status: failed ? ("fail" as const) : ("success" as const),
	text: `创建工作项| ×7|${failed}`,
});

function doc(markup: string) {
	return parseHTML(`<html><body>${markup}</body></html>`).document;
}

describe("team chip", () => {
	test("a fixed one-line row at the trace header band, whatever the width", () => {
		const narrow = measureTeamChip(chipData(), 200);
		const wide = measureTeamChip(chipData(), 900, { expanded: true });
		expect(narrow.height).toBe(traceMetrics().headerBandHeight);
		expect(wide.height).toBe(narrow.height);
		expect(wide.expanded).toBe(true);
	});

	test("paints the label, count and box height; an error mark only with failures", () => {
		const measured = measureTeamChip(chipData(), 600);
		const page = doc(
			renderToStaticMarkup(
				<MantineProvider>
					<RenderTeamChip measured={measured} onToggle={() => {}} />
				</MantineProvider>,
			),
		);
		const button = page.querySelector('[data-testid="team-chip"]');
		expect(button?.textContent).toContain("创建工作项 ×7");
		expect(button?.getAttribute("aria-expanded")).toBe("false");
		expect(page.querySelector('[data-testid="team-chip-error"]')).toBeNull();
		expect(page.querySelector("div")?.getAttribute("style")).toContain(
			`height:${measured.height}px`,
		);
		const failed = doc(
			renderToStaticMarkup(
				<MantineProvider>
					<RenderTeamChip measured={measureTeamChip(chipData(2), 600)} />
				</MantineProvider>,
			),
		);
		expect(failed.querySelector('[data-testid="team-chip-error"]')?.getAttribute("title")).toBe(
			"2 次失败",
		);
		// Cancelled calls get a grey mark, never the green check.
		const cancelled = doc(
			renderToStaticMarkup(
				<MantineProvider>
					<RenderTeamChip
						measured={measureTeamChip(
							{ ...chipData(), cancelled: 1, cancelledLabel: "1 次取消", status: "cancelled" },
							600,
						)}
					/>
				</MantineProvider>,
			),
		);
		expect(
			cancelled.querySelector('[data-testid="team-chip-cancelled"]')?.getAttribute("title"),
		).toBe("1 次取消");
		expect(cancelled.querySelector('[data-testid="team-chip-error"]')).toBeNull();
		// Without a toggle (no interaction host) the chip is inert.
		expect(failed.querySelector("button")?.hasAttribute("disabled")).toBe(true);
	});

	test("the registry routes it, wires the shell's fold toggle, and reads its open state", () => {
		const onToggle = () => {};
		const measured = measureTeamChip(chipData(), 600, { expanded: true });
		const node = renderElement("team-chip", measured, { onToggle });
		expect(isValidElement(node)).toBe(true);
		expect((node as ReactElement<{ onToggle?: () => void }>).props.onToggle).toBe(onToggle);
		expect(TOGGLEABLE_CARD_KINDS.has("team-chip")).toBe(true);
		const state = createVListInteractionState(4);
		expect(resolveRowOpenState(measured, state, "team-chip-a")).toBe(true);
		expect(resolveRowOpenState(measureTeamChip(chipData(), 600), state, "team-chip-a")).toBe(false);
	});

	test("the measure cache keys the painted text and the open state", () => {
		const first = measureElementCached(
			"team-chip",
			chipData(),
			600,
			4,
			{ expanded: false },
			"k",
			1,
		);
		const same = measureElementCached("team-chip", chipData(), 600, 4, { expanded: false }, "k", 1);
		const open = measureElementCached("team-chip", chipData(), 600, 4, { expanded: true }, "k", 1);
		const failed = measureElementCached(
			"team-chip",
			chipData(1),
			600,
			4,
			{ expanded: false },
			"k",
			1,
		);
		expect(same).toBe(first);
		expect(open).not.toBe(first);
		expect(failed).not.toBe(first);
	});
});

describe("team event divider", () => {
	test("a fixed one-line row at the count-line height; the text is painted whole", () => {
		const measured = measureTeamEvent(
			{ text: "10:31 · 「修复导出 CSV 时区错误」评审通过", tone: "ok" },
			600,
		);
		expect(measured.height).toBe(traceMetrics().countLineHeight);
		expect(measureTeamEvent({ text: "x".repeat(800), tone: "warn" }, 120).height).toBe(
			measured.height,
		);
		const page = doc(
			renderToStaticMarkup(
				<MantineProvider>
					<RenderTeamEvent measured={measured} />
				</MantineProvider>,
			),
		);
		const row = page.querySelector('[data-testid="team-event"]');
		expect(row?.textContent).toBe("10:31 · 「修复导出 CSV 时区错误」评审通过");
		expect(row?.getAttribute("style")).toContain(`height:${measured.height}px`);
		expect(isValidElement(renderElement("team-event", measured))).toBe(true);
	});
});
