/**
 * SubagentActivityRowHeight.test.tsx — pins the "row height does not depend on
 * tool-call status" contract for the SubagentCard "recent calls" rows.
 *
 * WHY THIS EXISTS
 * A tool call walks `streaming → running → success` while it executes. The row
 * used to change height on those transitions, which read as flicker, for two
 * independent reasons:
 *
 *  1. `StatusIcon` returns `null` for any status outside its known set (`""` and
 *     whatever a provider sends next), so an auto-sized wrapper collapsed to 0×0.
 *     `streaming` used to fall in that hole as well; it is now a spinner (see
 *     SubagentActivityStatusGlyph.test.tsx), but the reservation still has to hold
 *     for the genuinely-unknown statuses that remain.
 *  2. When it DID render, the wrapper was a block box containing an inline
 *     `<svg>`, so its line box came from the ROOT font size (16 × 1.55 =
 *     24.8px) rather than the 12px glyph — the icon INFLATED the row instead of
 *     fitting inside it.
 *
 * Measured in headless Chromium before the fix: 26.797 / 28.594 / 34.797px
 * across the status × timing matrix (8px spread).
 *
 * THE ROW IS NOW A TRACE ROW
 * It used to be a tinted `5px 7px` button, so the same child tool call looked like
 * a chunky card row inside a subagent card and like a slim trace line once the
 * reader dropped to a low LOD. The row is now assembled from `CollapsibleTrace`'s
 * exported slots and its `TRACE_ROW_MIN_HEIGHT`, which is what the assertions
 * below compare against: the height contract did not weaken, it moved onto the
 * shared definition. Cross-render parity itself is owned by
 * SubagentActivityTraceParity.test.tsx.
 *
 * WHAT IS ASSERTED HERE, AND WHY IT IS NOT A TAUTOLOGY
 * linkedom has no layout engine — `getBoundingClientRect()` returns all zeros —
 * so real heights cannot be measured in `bun test`. Asserting them here would
 * be a test that passes on any markup. Instead this file pins the STRUCTURAL
 * invariants that are the *cause* of the uniform height, each of which fails if
 * the corresponding fix is reverted:
 *
 *   - the glyph slot reserves an explicit 12×12 box and cannot shrink;
 *   - it lays its child out as flex, so no root-font-size line box (the 24.8px
 *     inflation) can form inside it;
 *   - the row reserves a min-height, so the timing area appearing/disappearing
 *     (line-height 1.55 vs the label's 1.4) cannot move it either;
 *   - the title is ONE truncating line, so summary length cannot wrap it.
 *
 * The real pixel heights are verified out-of-band with a Chromium probe; this
 * file is the cheap guard that keeps the structure from regressing.
 *
 * i18n returns raw keys so assertions are label-stable. `ToolTimingArea` and
 * `StatusIcon` are the REAL components — they are what is under test.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const realReactI18nextModule = { ...(await import("react-i18next")) };
const realUseNarratorModule = { ...(await import("../../hooks/useNarrator")) };
const realUsePlatformModule = { ...(await import("../../hooks/usePlatform")) };
const realRouterModule = { ...(await import("@tanstack/react-router")) };

mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
// The row needs no narrator/router data, but SubagentCard's module graph pulls
// these in at import time.
mock.module("../../hooks/useNarrator", () => ({
	...realUseNarratorModule,
	useNarrator: () => ({ data: undefined }),
	useToolCallDetail: () => ({ data: undefined }),
	useInterruptNarrator: () => ({ mutate: () => {}, isPending: false }),
	useAskInPassing: () => ({ isPending: false }),
	useCancelAskInPassing: () => ({ isPending: false }),
}));
mock.module("../../hooks/usePlatform", () => ({
	...realUsePlatformModule,
	usePlatform: () => "linux",
	useFileSystemCapability: () => ({ supported: false }),
	useNarratorPermissionsCapability: () => ({ supported: false }),
	useShareCapability: () => ({ supported: false }),
	useNarratorSubagentsCapability: () => ({
		supported: true,
		detachAttach: true,
		background: true,
		staleRecovery: true,
	}),
}));
mock.module("@tanstack/react-router", () => ({
	...realRouterModule,
	useNavigate: () => () => {},
	useSearch: () => ({}),
}));

const { SUBAGENT_STATUS_ROW_MIN_HEIGHT, SUBAGENT_STATUS_SLOT_STYLE, SubagentActivityRow } =
	await import("./SubagentCard");
const {
	TRACE_ICON_SLOT_SIZE,
	TRACE_ROW_MIN_HEIGHT,
	TRACE_STATUS_SLOT_SIZE,
	TRACE_STATUS_SLOT_STYLE,
} = await import("./CollapsibleTrace");
type ToolCallData = import("./ToolCallCard").ToolCallData;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

/**
 * Keys this file publishes on `globalThis`, and their pre-existing descriptors.
 *
 * The realm must not outlive the file: `parseHTML()` mints a fresh `Event` class
 * per call, and a leaked one fails a later file's `dispatchEvent(new Event(…))`
 * instance check. Bun runs every file in one process, so restoring is this file's
 * own responsibility.
 */
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(callback, 0);
	const cancelAnimationFrame = (id: number) => clearTimeout(id);
	// linkedom's window is a Proxy over the real globalThis, so `writable: true` is
	// what keeps these from stranding there as readonly and breaking a later file's
	// `Object.assign(window, …)`.
	Object.defineProperties(window, {
		requestAnimationFrame: { configurable: true, writable: true, value: requestAnimationFrame },
		cancelAnimationFrame: { configurable: true, writable: true, value: cancelAnimationFrame },
		matchMedia: { configurable: true, writable: true, value: matchMedia },
	});
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		getComputedStyle: window.getComputedStyle?.bind(window) ?? (() => ({})),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
		if (!savedGlobals.has(key)) savedGlobals.set(key, descriptor);
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) Reflect.set(globalThis, key, value);
			continue;
		}
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}

function restoreGlobals() {
	for (const [key, descriptor] of savedGlobals) {
		const current = Object.getOwnPropertyDescriptor(globalThis, key);
		if (current && !current.configurable) continue;
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	savedGlobals.clear();
}

/**
 * Statuses that render a glyph, and statuses that do not.
 *
 * `streaming` is the first status a live call has (and spins —
 * SubagentActivityStatusGlyph.test.tsx owns that). `unknown` stands in for whatever
 * a future provider sends, and `""` is a real value a row can carry: neither is
 * guessed at.
 *
 * SUCCESS is in the second group DELIBERATELY. Success is the default expectation,
 * so a column of green checks is noise rather than information; only deviation is
 * marked (see `@shared/tool-row-status`). This is the group's whole point — an
 * unmarked row must reserve NO width, or the blank gap replaces the check with an
 * equally useless column.
 */
const STATUSES_WITH_GLYPH = [
	"streaming",
	"running",
	"pending",
	"initializing",
	"fail",
	"cancelled",
];
const STATUSES_WITHOUT_GLYPH = ["", "unknown", "success", "completed"];

/** Timing shapes: live ElapsedTimer / static duration / no timing at all. */
type TimingShape = "running" | "completed" | "none";
const TIMING_SHAPES: TimingShape[] = ["running", "completed", "none"];

const NOW = Date.UTC(2026, 3, 1, 12, 0, 0);

function toolCall(
	status: string,
	timing: TimingShape,
	extra?: Partial<ToolCallData>,
): ToolCallData {
	const base: ToolCallData = {
		toolName: "Read",
		toolUseId: `tool-${status || "empty"}-${timing}`,
		inputJson: {},
		status,
		...extra,
	};
	if (timing === "running") return { ...base, createdAt: new Date(NOW - 3_000).toISOString() };
	if (timing === "completed") {
		return {
			...base,
			createdAt: new Date(NOW - 5_000).toISOString(),
			completedAt: new Date(NOW - 1_000).toISOString(),
			durationMs: 4_000,
		};
	}
	return base;
}

async function render(call: ToolCallData) {
	if (!root) throw new Error("test harness is not initialized");
	const currentRoot = root;
	await act(async () => {
		currentRoot.render(
			<MantineProvider env="test">
				<SubagentActivityRow call={call} />
			</MantineProvider>,
		);
	});
}

/**
 * The row's status slot. Queried by the SHARED trace testid, because the row is a
 * trace row now — a subagent-specific selector here would pass while the row and a
 * folded trace row drifted apart, which is the drift this change removed.
 */
function statusSlot(): HTMLElement {
	const slots = container?.querySelectorAll('[data-testid="trace-row-status-slot"]') ?? [];
	// Exactly one slot on a row that HAS a mark: a second would add width.
	expect(slots.length).toBe(1);
	return slots[0] as unknown as HTMLElement;
}

/** True when the row drew no status slot at all (an unmarked status). */
function noStatusSlot(): boolean {
	return (container?.querySelectorAll('[data-testid="trace-row-status-slot"]') ?? []).length === 0;
}

/** The 14px trace icon lane holding the category chip. */
function categorySlot(): HTMLElement {
	const slots = container?.querySelectorAll("[data-trace-icon-slot]") ?? [];
	// Same one-per-row rule as the status slot, for the same reason.
	expect(slots.length).toBe(1);
	return slots[0] as unknown as HTMLElement;
}

function rowGroup(): HTMLElement {
	const group = container?.querySelector('[data-testid="subagent-activity-row"]');
	if (!group) throw new Error("activity row not rendered");
	return group as unknown as HTMLElement;
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	const currentRoot = root;
	await act(async () => currentRoot?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

afterAll(() => {
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.module("../../hooks/useNarrator", () => realUseNarratorModule);
	mock.module("../../hooks/usePlatform", () => realUsePlatformModule);
	mock.module("@tanstack/react-router", () => realRouterModule);
	mock.restore();
	restoreGlobals();
});

describe("SubagentActivityRow status slot", () => {
	test("reserves the same fixed 12x12 slot for every MARKED status", async () => {
		const observed: string[] = [];
		for (const status of STATUSES_WITH_GLYPH) {
			await render(toolCall(status, "running"));
			const slot = statusSlot();
			// A reserved box that cannot shrink: this is what keeps a 12px glyph from
			// setting the row's height from its own line box.
			expect(slot.style.width).toBe(`${TRACE_STATUS_SLOT_SIZE}px`);
			expect(slot.style.height).toBe(`${TRACE_STATUS_SLOT_SIZE}px`);
			expect(slot.style.flexShrink).toBe("0");
			// Flex layout means the inline <svg> never establishes a line box sized by
			// the ROOT font (16 x 1.55 = 24.8px), which is what INFLATED the row.
			expect(slot.style.display).toBe("flex");
			expect(slot.style.alignItems).toBe("center");
			// Compare only the LAYOUT declarations. Mantine's `c` prop also writes a
			// per-status colour variable into the same style attribute, and colour is
			// exactly what is *supposed* to vary between statuses — folding it in
			// would make this assert the opposite of the intended contract.
			observed.push(
				(["width", "height", "flex-shrink", "display", "align-items", "justify-content"] as const)
					.map((property) => `${property}:${slot.style.getPropertyValue(property)}`)
					.join(";"),
			);
		}
		// Every marked status yields identical slot geometry — the invariant, stated
		// once over the whole set rather than per-case.
		expect(new Set(observed).size).toBe(1);
	});

	test("an UNMARKED status reserves no width at all", async () => {
		// The point of dropping the success check: a blank 12px gap on every successful
		// row would be the same useless column the check was. So the slot must be
		// ABSENT, not empty — asserted for success as well as for the statuses this
		// frontend cannot interpret.
		for (const status of STATUSES_WITHOUT_GLYPH) {
			await render(toolCall(status, "running"));
			expect(noStatusSlot()).toBe(true);
		}
	});

	test("marked statuses really do draw their glyph", async () => {
		// The other direction of the same invariant: an always-absent slot would pass
		// the test above while telling the reader nothing about a failure.
		for (const status of STATUSES_WITH_GLYPH) {
			await render(toolCall(status, "running"));
			expect(statusSlot().querySelector("svg")).not.toBeNull();
		}
	});

	test("the slot style is the shared trace definition, not a local copy", async () => {
		// The whole point of routing this row through CollapsibleTrace's slot: one
		// definition, so a change to the trace row's reservation cannot leave the
		// subagent row behind (which is how the two drifted before).
		expect(TRACE_STATUS_SLOT_STYLE).toMatchObject({
			width: TRACE_STATUS_SLOT_SIZE,
			height: TRACE_STATUS_SLOT_SIZE,
			flexShrink: 0,
			display: "flex",
		});
	});
});

describe("SubagentActivityRow height reservation", () => {
	test("reserves the TRACE row min-height so the timing area cannot move the row", async () => {
		// The timing text is line-height 1.55 while the sibling label is 1.4, so a
		// row without a reservation grows ~1.8px the moment a timer appears. The
		// reservation is now the trace row's, which is what makes this row and a folded
		// trace row the same height by construction rather than by coincidence.
		for (const status of [...STATUSES_WITH_GLYPH, ...STATUSES_WITHOUT_GLYPH]) {
			for (const timing of TIMING_SHAPES) {
				await render(toolCall(status, timing));
				expect(rowGroup().style.minHeight).toBe(`${TRACE_ROW_MIN_HEIGHT}px`);
			}
		}
	});

	test("row structure is identical across the timing shapes, per status group", async () => {
		// Same element shape within a group, so a timer appearing or a status advancing
		// WITHIN that group cannot introduce or drop a box that changes the height.
		//
		// The two groups differ by exactly one cell — the status slot, which an unmarked
		// status omits by design — so they are asserted separately rather than folded
		// together. Height is unaffected either way: the row's `minHeight` above is what
		// sets it, and the omitted cell was never the tallest.
		for (const statuses of [STATUSES_WITH_GLYPH, STATUSES_WITHOUT_GLYPH]) {
			const shapes = new Set<string>();
			for (const status of statuses) {
				for (const timing of TIMING_SHAPES) {
					await render(toolCall(status, timing));
					const group = rowGroup();
					shapes.add(
						`${group.children.length}|${Array.from(group.children)
							.map((child) => child.tagName.toLowerCase())
							.join(",")}`,
					);
				}
			}
			expect(shapes.size).toBe(1);
		}
	});
});

/**
 * The row also carries an optional SUMMARY (Bash's description, a file tool's
 * basename). It is the second thing after status that varies per row, so it gets
 * the same treatment: present or absent, 3 chars or 200, the row must not move.
 *
 * As above, linkedom cannot measure pixels, so these pin the structural causes:
 * the summary shares ONE flex line with the tool name, both truncate, and neither
 * can force the line to wrap or the row to grow.
 */
const LONG_SUMMARY = "refactor ".repeat(40); // ~360 chars, far past the row width

function summaryRow(summary?: Record<string, string>): ToolCallData {
	return toolCall("success", "completed", {
		toolName: "Bash",
		...(summary ? { _inputSummary: summary } : {}),
	} as Partial<ToolCallData>);
}

function labelBox(): HTMLElement {
	const box = container?.querySelector('[data-testid="subagent-activity-label"]');
	if (!box) throw new Error("activity label box not rendered");
	return box as unknown as HTMLElement;
}

function summaryEl(): HTMLElement | null {
	return (container?.querySelector('[data-testid="subagent-activity-summary"]') ??
		null) as unknown as HTMLElement | null;
}

describe("SubagentActivityRow summary", () => {
	test("row shape and height reservation survive any summary length", async () => {
		// One case, two facts, because they fail together: the summary lives INSIDE the
		// title line, so it can neither add a box to the row's flex line nor release the
		// row's min-height. Asserted over the same set of inputs rather than twice over
		// two near-identical sets.
		const shapes = new Set<string>();
		for (const call of [
			summaryRow(),
			summaryRow({ description: "List files" }),
			summaryRow({ description: LONG_SUMMARY }),
			summaryRow({ file_path: `/very/deep/${"nested/".repeat(30)}file.tsx` }),
		]) {
			await render(call);
			const group = rowGroup();
			expect(group.style.minHeight).toBe(`${TRACE_ROW_MIN_HEIGHT}px`);
			shapes.add(
				`${group.children.length}|${Array.from(group.children)
					.map((child) => child.tagName.toLowerCase())
					.join(",")}`,
			);
		}
		expect(shapes.size).toBe(1);
	});

	test("the title is ONE truncating flex line whatever the summary length", async () => {
		// `minWidth: 0` is what allows truncation; without it the text sets the box's
		// min-content width and pushes the row wider (then taller once it wraps). Both
		// the name and the summary live in this single <Text truncate>, so there is one
		// line box to keep — not two cells that could wrap independently.
		const observed: string[] = [];
		for (const call of [summaryRow(), summaryRow({ description: LONG_SUMMARY })]) {
			await render(call);
			const box = labelBox();
			// linkedom serializes the unitless zero as "0" (a browser reports "0px").
			expect(box.style.minWidth).toBe("0");
			// `0 1 auto`, NOT `1`: the title must not grow into the row's free width, or
			// the status + duration that follow it get flung to the far right edge — the
			// layout that made a reader trace a number back across the gap to find its
			// row. It may still SHRINK (the `1`), which is what lets it truncate.
			expect(box.style.flex).toBe("0 1 auto");
			// Mantine's `truncate` prop, which is what actually clips the overflow.
			expect(box.getAttribute("data-truncate")).toBe("end");
			observed.push(`${box.style.minWidth}|${box.style.flex}|${box.getAttribute("data-truncate")}`);
		}
		expect(new Set(observed).size).toBe(1);
	});

	test("a long summary is capped before it ever reaches the DOM", async () => {
		await render(summaryRow({ description: LONG_SUMMARY }));
		const summary = summaryEl();
		expect(summary).not.toBeNull();
		// Three independent caps apply before CSS ever clips: the SQL projection caps
		// the stored value at 200 chars, `getSummary` truncates a bash description to
		// 80, and the row title itself caps at 80. So a 360-char input reaches the DOM
		// already bounded — CSS truncation is the last line of defence, not the only one.
		const text = summary?.textContent ?? "";
		expect(text.length).toBeLessThanOrEqual(80);
		expect(text.length).toBeGreaterThan(0);
	});

	test("degrades to the bare tool name when there is no summary", async () => {
		await render(summaryRow());
		expect(summaryEl()).toBeNull();
		expect(labelBox().textContent).toBe("Bash");
	});

	test("renders the trace row's `Tool · summary` wording", async () => {
		// The row used to print the name and the summary as two adjacent cells with no
		// separator; a folded trace row printed `Tool · summary`. Same shape now means
		// the same wording, or the two still read differently at different LODs.
		await render(summaryRow({ description: "List files" }));
		expect(labelBox().textContent).toBe("Bash · List files");
	});

	test("does not echo the tool name as its own summary", async () => {
		// getSummary answers "Bash" for a Bash call with no description/command, and
		// "task: unknown" for an Await with no id. Rendering those would produce
		// "Bash · Bash" — the row must suppress them.
		await render(summaryRow({ mode: "" }));
		expect(summaryEl()).toBeNull();

		await render(
			toolCall("success", "completed", {
				toolName: "Await",
				_inputSummary: { type: "task" },
			} as Partial<ToolCallData>),
		);
		expect(summaryEl()?.textContent ?? null).toBeNull();
	});

	// Which TEXT the formatter produces per tool (Read → basename, Await → "type: id",
	// Bash → description over command) is asserted in
	// SubagentActivityLiveSummary.test.tsx, which drives the same rows through the whole
	// wire→pixel chain. This file owns geometry, so it does not restate those values.
});

describe("exported slot style", () => {
	test("the card HEADER keeps its own reserved glyph box", async () => {
		// The header still has a status lane of its own (the card's overall state, plus a
		// live Loader), so its 12x12 reservation survives the rows moving onto the
		// shared trace slot. Same contract, same size — pinned so the two cannot drift.
		expect(SUBAGENT_STATUS_SLOT_STYLE).toMatchObject({
			width: 12,
			height: 12,
			flexShrink: 0,
			display: "flex",
		});
	});

	test("every row carries a category chip in the trace icon lane", async () => {
		// The chip tells file edits from shell runs from searches at a glance. It gets a
		// reserved box for the same reason the status glyph does: an unknown tool, which
		// still resolves to a fallback icon, must not collapse the slot and shorten the
		// row. The lane is the TRACE lane (14px), not the tool header's 16px tile —
		// which is what makes this row and a folded trace row the same mark.
		const expected = `${TRACE_ICON_SLOT_SIZE}px`;
		for (const toolName of ["Bash", "Read", "Write", "Grep", "Await", "TotallyUnknownTool"]) {
			await render({ ...toolCall("success", "completed"), toolName });
			const slot = categorySlot();
			expect(slot.querySelector("svg")).not.toBeNull();
			expect(slot.style.width).toBe(expected);
			expect(slot.style.height).toBe(expected);
		}
	});

	test("the header lane reserves the root-font line box, not the smaller xs one", async () => {
		// Pins the VALUE rather than just consistency: the header's lane used to move by
		// ~8px depending on whether a glyph rendered, and `1rem` is the 24.8px
		// reservation that keeps it still. Must not silently drift to
		// `--mantine-font-size-xs`, which would shorten the header by ~6px.
		expect(SUBAGENT_STATUS_ROW_MIN_HEIGHT).toBe("calc(1rem * var(--mantine-line-height))");
	});
});
