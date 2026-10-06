/**
 * RenderSubagent.traceparity.test.tsx — a subagent card's "recent calls" row and a
 * folded TRACE row are the SAME row.
 *
 * WHY THIS EXISTS
 * The recent-call rows used to be tinted 27px buttons showing a bare tool name,
 * while a folded trace row was a slim 18.8px line reading `Tool · summary` with a
 * category chip. So one child tool call looked like two different things depending
 * on the render level, and the subagent card's version carried strictly less
 * information despite being the more prominent surface.
 *
 * They are now one shape. That claim is only worth stating as a test if it compares
 * the two REAL renderers rather than restating today's markup: this file measures and
 * renders `RenderSubagent`'s recent rows and `RenderToolRun`'s rows from equivalent
 * inputs and holds their geometry, their chip and their status marks side by side. A
 * change to either that misses the other fails here.
 *
 * The HEIGHT half of the parity is enforced arithmetically instead
 * (`RECENT_ROW_HEIGHT === TRACE_ROW_HEIGHT`, asserted below and relied on by
 * measure-subagent), because a shared constant is a stronger guarantee than two
 * numbers a test happens to compare.
 *
 * Static markup: both rows are pure functions of their measured payload, so
 * `renderToStaticMarkup` is the cheapest faithful probe. Tabler stamps
 * `tabler-icon-<name>` on every glyph, which identifies a mark without depending on
 * Mantine's generated class names.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import {
	measureSubagentCard,
	RECENT_ROW_HEIGHT,
	type SubagentCardData,
} from "../measure/measure-subagent";
import { HEADER_CELL_GAP } from "../measure/measure-tool-call";
import { measureActivityTrace, TRACE_ROW_HEIGHT } from "../measure/measure-tool-run";
import { installCanvasStub } from "../measure/test-canvas-stub";
import { RenderSubagent } from "./RenderSubagent";
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
const LOD = 5;

/** One child tool call, expressed for each renderer's own input shape. */
interface Call {
	toolName: string;
	summary: string;
	category: string;
	status: string;
	durationMs: number;
}

const CALLS: Call[] = [
	{ toolName: "Read", summary: "loop.ts", category: "read", status: "success", durationMs: 1_000 },
	{ toolName: "Bash", summary: "bun test", category: "bash", status: "fail", durationMs: 4_000 },
	{ toolName: "Grep", summary: "recentCall", category: "search", status: "running", durationMs: 0 },
];

function render(node: React.ReactNode): Element {
	return parse(
		renderToStaticMarkup(<MantineProvider defaultColorScheme="dark">{node}</MantineProvider>),
	);
}

/** The subagent card's recent-call rows. */
function subagentRows(calls: Call[]): Element {
	const data: SubagentCardData = {
		agentType: "explore",
		description: "explore the repo",
		isTerminal: true,
		recentCallCount: calls.length,
		recentCallSummaries: calls.map((c) => c.summary),
		recentCallCategories: calls.map((c) => c.category),
		recentCallTimings: calls.map((c) => ({
			status: c.status,
			createdAt: 0,
			...(c.durationMs > 0 ? { durationMs: c.durationMs } : {}),
		})),
	};
	const measured = measureSubagentCard(data, WIDTH, LOD, { isActive: false });
	return render(
		<RenderSubagent
			measured={measured}
			description={data.description}
			agentType={data.agentType}
			recentCallNames={calls.map((c) => c.toolName)}
			isActive={false}
			status="success"
			onOpenSession={() => {}}
		/>,
	);
}

/** The equivalent folded trace rows. */
function traceRows(calls: Call[]): Element {
	const measured = measureActivityTrace(
		calls.map((c) => ({
			title: `${c.toolName} · ${c.summary}`,
			hasIcon: true,
			category: c.category,
			toolName: c.toolName,
			key: c.toolName,
			status: c.status,
			timing: { createdAt: 0, ...(c.durationMs > 0 ? { durationMs: c.durationMs } : {}) },
		})),
		WIDTH,
	);
	return render(<RenderToolRun measured={measured} />);
}

/** The Tabler glyph name of every icon inside `root`, in document order. */
function glyphNames(root: Element): string[] {
	return Array.from(root.querySelectorAll("svg"))
		.map((svg) => {
			const cls = String((svg as unknown as HTMLElement).getAttribute("class") ?? "");
			return /tabler-icon-([a-z0-9-]+)/.exec(cls)?.[1] ?? "";
		})
		.filter(Boolean);
}

/** The glyph names inside the status slots only (one per row). */
function statusGlyphs(root: Element): string[] {
	return Array.from(root.querySelectorAll('[data-testid="trace-row-status-slot"]')).map(
		(slot) => glyphNames(slot as Element)[0] ?? "",
	);
}

/** Every row's category chip, found by the marker both renderers stamp. */
function chips(root: Element): HTMLElement[] {
	return Array.from(root.querySelectorAll("[data-trace-row-chip]")) as unknown as HTMLElement[];
}

/**
 * The innermost flex line of each row — the element whose direct children are the
 * row's cells (chip, title, status, duration, spacer).
 *
 * Found via the chip rather than a class name, and narrowed to the chip's own PARENT,
 * so it is the one node whose `lastElementChild` is meaningfully "the row's last
 * cell" in both renderers.
 */
function rowsOf(root: Element): HTMLElement[] {
	const seen = new Set<Element>();
	const out: HTMLElement[] = [];
	for (const chip of chips(root)) {
		// The chip sits in a lane (vlist trace) or directly in the line (subagent row);
		// walk up until the parent holds more than one cell.
		let node: Element | null = chip.parentElement;
		while (node && node.children.length < 2) node = node.parentElement;
		if (node && !seen.has(node)) {
			seen.add(node);
			out.push(node as HTMLElement);
		}
	}
	return out;
}

/** Each row's visible title, in document order (the chip's next sibling cell). */
function rowTitles(root: Element): string[] {
	return chips(root).map((chip) => (chip.nextElementSibling?.textContent ?? "").trim());
}

/**
 * The declared appearance of each row's category chip: Mantine's own size/colour
 * declarations plus the glyph identity and inset. Read generically rather than from a
 * hard-coded list of CSS variables, so a Mantine version bump cannot fail this suite
 * for a reason unrelated to the invariant — whatever it writes, both rows must write
 * the same thing.
 */
function chipSignatures(root: Element): string[] {
	return chips(root).map((chip) => {
		const glyph = chip.querySelector("svg");
		const attributes = chip
			.getAttributeNames()
			// `class` carries Mantine's generated module hashes (a build artefact), and
			// the test ids differ by call site by design.
			.filter((name) => name !== "class" && !name.startsWith("data-testid"))
			.sort()
			.map((name) => `${name}=${chip.getAttribute(name) ?? ""}`)
			.join(";");
		return [
			attributes,
			glyph?.getAttribute("width") ?? "",
			/tabler-icon-([a-z0-9-]+)/.exec(String(glyph?.getAttribute("class") ?? ""))?.[1] ?? "",
		].join("|");
	});
}

describe("recent-call rows ARE trace rows", () => {
	it("share one height constant, so the two can never drift apart", async () => {
		// The strongest form of the height claim: not "these two renders agree today"
		// but "there is only one number". measure-subagent takes it from the trace model.
		expect(RECENT_ROW_HEIGHT).toBe(TRACE_ROW_HEIGHT);
		expect(RECENT_ROW_HEIGHT).toBeCloseTo(18.8, 5);
	});

	it("draw the same category chip, in the same lane, per call", async () => {
		// The chip's tint is what lets a reader tell a file edit from a shell run at a
		// glance; its declared size is what keeps the two rows the same height. Compared
		// per row so a single mismatched category cannot hide behind the others.
		const subagent = chipSignatures(subagentRows(CALLS));
		// Not vacuous: three rows really were found on each side, and the three
		// categories really do differ.
		expect(subagent).toHaveLength(CALLS.length);
		expect(new Set(subagent).size).toBe(CALLS.length);
		expect(subagent).toEqual(chipSignatures(traceRows(CALLS)));
	});

	it("draw the same status mark per call — and skip the same ones", async () => {
		// fail → X, running → spinner, success → NOTHING. The unmarked case is the one
		// worth pairing explicitly: if either row reserved a blank slot where the other
		// drew none, the two would no longer line up column-for-column, and the shared
		// `@shared/tool-row-status` rule would have been bypassed on one side.
		const subagent = statusGlyphs(subagentRows(CALLS));
		expect(subagent).toEqual(statusGlyphs(traceRows(CALLS)));
		// Two of the three CALLS deviate (fail, running); the successful one is bare.
		expect(subagent).toEqual(["circle-x", "loader-2"]);
	});

	it("word the label the same way (bold `Tool` then summary, no separator)", async () => {
		// The subagent row used to print the bare tool name. Same shape has to mean the
		// same wording, or the reader still sees two different things.
		//
		// The middle dot is gone on BOTH sides: the tool name is distinguished by WEIGHT,
		// which is what the card header already did. A separator spent a glyph and a gap
		// saying what the weight says, and having it in the row but not the card meant the
		// morph had to make it appear out of nothing.
		// No space character between the two cells either: the name and the summary are
		// separated by a flat `HEADER_CELL_GAP` margin, matching the card header's
		// `Group gap={4}`. A space would be the font's space advance (~7.2px in the mono
		// face at xs, and it scales with the reader's font size), which made the identical
		// label look differently spaced in the two forms. So `textContent` is contiguous —
		// the separation is visual, not textual.
		const subagent = rowTitles(subagentRows(CALLS));
		expect(subagent).toEqual(["Readloop.ts", "Bashbun test", "GreprecentCall"]);
		expect(subagent).toEqual(rowTitles(traceRows(CALLS)));
	});

	it("separate name from summary with a flat gap, not a space glyph", async () => {
		for (const root of [subagentRows(CALLS), traceRows(CALLS)]) {
			const bold = Array.from(root.querySelectorAll("span")).filter((el) =>
				((el as unknown as HTMLElement).getAttribute("style") ?? "")
					.replace(/\s/g, "")
					.includes("font-weight:600"),
			);
			expect(bold.length).toBeGreaterThanOrEqual(CALLS.length);
			for (const el of bold.slice(0, CALLS.length)) {
				const style = ((el as unknown as HTMLElement).getAttribute("style") ?? "").replace(
					/\s/g,
					"",
				);
				expect(style).toContain(`margin-right:${HEADER_CELL_GAP}px`);
			}
		}
	});

	it("bold the tool name in both, so weight is what marks it", async () => {
		for (const root of [subagentRows(CALLS), traceRows(CALLS)]) {
			const bold = Array.from(root.querySelectorAll("span")).filter((el) =>
				// Static markup emits CSS unspaced (`font-weight:600`).
				((el as unknown as HTMLElement).getAttribute("style") ?? "")
					.replace(/\s/g, "")
					.includes("font-weight:600"),
			);
			// One per row: the name, and nothing else in the label.
			expect(bold.length).toBeGreaterThanOrEqual(CALLS.length);
			expect(bold.slice(0, CALLS.length).map((el) => el.textContent)).toEqual([
				"Read",
				"Bash",
				"Grep",
			]);
		}
	});

	it("keep the status + duration ADJACENT to the label, not right-aligned", async () => {
		// A duration pinned to the row's right edge has to be traced back across a wide
		// gap to find its own row, which in a column of rows is easy to misread as the
		// neighbour's. Both rows therefore let the title size to its content
		// (`flex: 0 1 auto`) and park a spacer AFTER the cluster to eat the slack.
		//
		// Asserted structurally because linkedom has no layout engine: a `flex: 1` title
		// would push the cluster right, and a missing trailing spacer would stretch the
		// cluster itself. Both rows must agree, or the "same shape" claim is false.
		for (const root of [subagentRows(CALLS), traceRows(CALLS)]) {
			const titles = Array.from(root.querySelectorAll("[data-trace-row-chip]")).map(
				(chip) => (chip as unknown as HTMLElement).nextElementSibling as HTMLElement | null,
			);
			expect(titles).toHaveLength(CALLS.length);
			for (const title of titles) {
				// May shrink (so it can truncate) but must not GROW into the free width.
				expect(title?.style.flex).toBe("0 1 auto");
			}
			// The row's last cell is the growing spacer, so everything before it stays
			// packed against the label.
			for (const row of rowsOf(root)) {
				const last = row.lastElementChild as HTMLElement | null;
				expect(last?.style.flex).toBe("1");
				expect((last?.textContent ?? "").trim()).toBe("");
			}
		}
	});

	it("both drop the summary to a bare name when none is known", async () => {
		// A recent-call header can arrive with no `inputSummary` at all (the projection
		// found no whitelisted key). Both rows must degrade identically rather than one
		// inventing a separator with nothing after it.
		const bare = CALLS.slice(0, 1).map((c) => ({ ...c, summary: "" }));
		const rows = subagentRows(bare);
		expect(rowTitles(rows)).toEqual(["Read"]);
		expect(rowTitles(rows)[0]).not.toContain("·");
	});
});
