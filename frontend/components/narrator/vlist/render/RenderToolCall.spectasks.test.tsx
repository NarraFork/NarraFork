/**
 * RenderToolCall.spectasks.test.tsx — geometry parity for `spec://tasks.json` cards
 * in the exact virtual list.
 *
 * Two misalignments this locks down (both invisible to the height model, so no
 * existing test caught them):
 *
 *  1. PROTECTED ROWS OVERLAPPED THEIR TEXT. Every task row reserved the same
 *     `SPEC_TASK_INDENT` lane, but a protected task draws a lock glyph after the
 *     status icon. The lock rendered inside a shrink-wrapping Group that spilled
 *     past the lane and painted over the first characters of the task text, while
 *     the measured text lane stayed at 24px.
 *  2. AN EMPTY TASK DOC PAINTED NOTHING. `{ tasks: [] }` reserved a 16px block
 *     that no render branch consumed, so the card showed a blank gap where the
 *     chunked card shows a bordered "task list is empty" row.
 *
 * The assertions go through the real measure → render chain and read the produced
 * DOM, so the measured lane and the painted lane cannot drift apart again.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installCanvasStub } from "../measure/test-canvas-stub";

let measureMod: typeof import("../measure/measure-tool-call");
let RenderToolCall: typeof import("./RenderToolCall").RenderToolCall;

beforeAll(async () => {
	// Task rows are pretext-measured inline blocks (canvas measureText).
	installCanvasStub();
	measureMod = await import("../measure/measure-tool-call");
	RenderToolCall = (await import("./RenderToolCall")).RenderToolCall;
});

const CONTENT_WIDTH = 600;

type SpecTaskLine = import("../measure/measure-tool-call").SpecTaskLine;

function measureTasksCard(tasks: SpecTaskLine[]) {
	return measureMod.measureToolCall(
		{
			toolName: "Write",
			summary: "spec://tasks.json",
			category: "tasks",
			status: "success",
			detail: { kind: "spec-tasks", tasks },
		},
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

/**
 * The absolutely-positioned LINE BOX that owns a fragment — the element whose
 * `left` is the measured text indent.
 *
 * Walked up rather than reached with a fixed number of `.parentElement` hops,
 * because a fragment is NOT a direct child of its line box: `LineFragments`
 * (line-fragments.tsx) inserts one `data-vlist-line-frags` block span around all
 * of a line's fragments. That wrapper is load-bearing — CSS blockifies flex
 * items, so without it the plain-text serializer put a newline before AND after
 * every inline code span / link / bold run when a reader copied a selection.
 * Counting hops here would break again the next time the render layer wraps a
 * line, so we look for the positioning itself instead.
 */
function lineBoxOf(frag: Element): Element | null {
	let el: Element | null = frag.parentElement;
	while (el) {
		const style = el.getAttribute("style") ?? "";
		// A line box is the absolutely-positioned FLEX row: the flex is what
		// vertically centers the fragments inside the reserved line height, and it is
		// what distinguishes the line from the block's own absolute wrapper above it.
		if (style.includes("position:absolute") && style.includes("display:flex")) return el;
		el = el.parentElement;
	}
	return null;
}

/** The painted `left` of each task text line, in row order. */
function textLefts(root: Element): number[] {
	return Array.from(root.querySelectorAll(".vlist-tc-spec-task")).map((frag) => {
		const style = lineBoxOf(frag)?.getAttribute("style") ?? "";
		// `px` optional: React serializes a zero-valued `left` as plain `0`.
		return Number.parseInt(/left:\s*(-?\d+)(?:px)?/.exec(style)?.[1] ?? "-1", 10);
	});
}

/** The painted width of each leading icon lane, in row order. */
function laneWidths(root: Element): number[] {
	return Array.from(root.querySelectorAll(".mantine-ThemeIcon-root")).map((icon) => {
		const style = icon.parentElement?.getAttribute("style") ?? "";
		return Number.parseInt(/width:\s*(\d+)px/.exec(style)?.[1] ?? "-1", 10);
	});
}

describe("spec-tasks rows — icon lane vs text lane", () => {
	it("indents an unprotected row by the plain icon lane", () => {
		const measured = measureTasksCard([{ text: "plain task", status: "todo" }]);
		const root = render(<RenderToolCall measured={measured} />);
		expect(textLefts(root)).toEqual([measureMod.SPEC_TASK_INDENT]);
	});

	it("reserves the lock lane for a protected row so the glyph cannot cover the text", () => {
		const measured = measureTasksCard([
			{ text: "plain task", status: "todo" },
			{ text: "protected task", status: "doing", protected: true },
		]);
		const root = render(<RenderToolCall measured={measured} />);
		const expectedLocked = measureMod.SPEC_TASK_INDENT + measureMod.SPEC_TASK_LOCK_LANE;
		expect(textLefts(root)).toEqual([measureMod.SPEC_TASK_INDENT, expectedLocked]);
	});

	it("paints each icon lane exactly as wide as the measured text indent", () => {
		const measured = measureTasksCard([
			{ text: "a", status: "done" },
			{ text: "b", status: "doing", protected: true },
			{ text: "c", status: "blocked" },
		]);
		const root = render(<RenderToolCall measured={measured} />);
		// A lane wider than the reserved indent is exactly the overlap bug.
		expect(laneWidths(root)).toEqual(textLefts(root));
	});

	it("wraps protected text in the narrower lane (the lock lane costs width)", () => {
		const text = "one two three four five six seven eight nine ten eleven twelve thirteen";
		const plain = measureTasksCard([{ text, status: "todo" }]);
		const locked = measureTasksCard([{ text, status: "todo", protected: true }]);
		// Same text, less room → never shorter than the unprotected row.
		expect(locked.detail?.height).toBeGreaterThanOrEqual(plain.detail?.height ?? 0);
	});
});

/**
 * A task board is a SNAPSHOT: each `spec://tasks.json` write keeps whatever was in
 * progress when it was written, so animating on the recorded `doing` status alone set
 * every historical card spinning. Only the newest board of a running narrator is live
 * (`specTasksLive`), matching the chunked card's `isThinking && isLatestTasksCard`.
 */
describe("spec-tasks rows — the spinner is gated on `specTasksLive`", () => {
	/** Tabler writes its icon name onto the svg class list (`tabler-icon-<name>`). */
	function iconNames(root: Element): string[] {
		return Array.from(root.querySelectorAll("svg")).flatMap((svg) =>
			(svg.getAttribute("class") ?? "")
				.split(/\s+/)
				.filter((cls) => cls.startsWith("tabler-icon-") && cls !== "tabler-icon"),
		);
	}

	function renderBoard(live: boolean): Element {
		const measured = measureTasksCard([
			{ text: "in progress", status: "doing" },
			{ text: "queued", status: "todo" },
		]);
		return render(<RenderToolCall measured={measured} specTasksLive={live} />);
	}

	it("does not animate a historical board", () => {
		const root = renderBoard(false);
		expect(root.querySelectorAll(".vlist-spin")).toHaveLength(0);
		expect(iconNames(root)).toContain("tabler-icon-player-play");
	});

	it("animates the live board's in-progress row, as a loader", () => {
		const root = renderBoard(true);
		expect(root.querySelectorAll(".vlist-spin")).toHaveLength(1);
		const names = iconNames(root);
		expect(names).toContain("tabler-icon-loader-2");
		expect(names).not.toContain("tabler-icon-player-play");
	});

	it("leaves non-`doing` rows still on the live board", () => {
		const measured = measureTasksCard([
			{ text: "a", status: "todo" },
			{ text: "b", status: "done" },
			{ text: "c", status: "blocked" },
		]);
		const root = render(<RenderToolCall measured={measured} specTasksLive />);
		expect(root.querySelectorAll(".vlist-spin")).toHaveLength(0);
	});
});

describe("spec-tasks empty document", () => {
	it("reserves the bordered placeholder row instead of a bare icon", () => {
		const measured = measureTasksCard([]);
		const block = measured.detail?.blocks[0];
		expect(block?.kind).toBe("fixed");
		expect(block?.kind === "fixed" ? block.tag : null).toBe("detail-spec-empty");
		expect(measured.detail?.frame.blocks[0]?.height).toBe(measureMod.SPEC_TASK_EMPTY_HEIGHT);
	});

	it("paints the placeholder at the reserved height", () => {
		const measured = measureTasksCard([]);
		const root = render(
			<RenderToolCall measured={measured} labels={{ tasksEmpty: "Task list is empty" }} />,
		);
		const paper = root.querySelector(".mantine-Paper-root[data-with-border] .mantine-Paper-root");
		expect(paper).not.toBeNull();
		expect(paper?.getAttribute("style") ?? "").toContain(
			`height:${measureMod.SPEC_TASK_EMPTY_HEIGHT}px`,
		);
		expect(paper?.textContent).toContain("Task list is empty");
	});
});
