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
 * across the status × timing matrix (8px spread). After: a single 28.594px.
 *
 * WHAT IS ASSERTED HERE, AND WHY IT IS NOT A TAUTOLOGY
 * linkedom has no layout engine — `getBoundingClientRect()` returns all zeros —
 * so real heights cannot be measured in `bun test`. Asserting them here would
 * be a test that passes on any markup. Instead this file pins the STRUCTURAL
 * invariants that are the *cause* of the uniform height, each of which fails if
 * the corresponding fix is reverted:
 *
 *   - the glyph slot is always present, one per row, whatever the status;
 *   - it reserves an explicit 12×12 box and cannot shrink;
 *   - it lays its child out as flex, so no root-font-size line box (the 24.8px
 *     inflation) can form inside it;
 *   - the row reserves a min-height, so the timing area appearing/disappearing
 *     (line-height 1.55 vs the label's 1.4) cannot move it either.
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

const {
	SUBAGENT_CATEGORY_SLOT_SIZE,
	SUBAGENT_STATUS_ROW_MIN_HEIGHT,
	SUBAGENT_STATUS_SLOT_STYLE,
	SubagentActivityRow,
} = await import("./SubagentCard");
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
 * Statuses that render a glyph, and statuses that do not. `streaming` is the
 * first status a live call has (and now spins — SubagentActivityStatusGlyph.test.tsx
 * owns that); `""` is a real value a row can carry, and `unknown` stands in for
 * whatever a future provider sends. Both groups must produce the same row height.
 */
const STATUSES_WITH_GLYPH = [
	"streaming",
	"running",
	"pending",
	"initializing",
	"success",
	"fail",
	"cancelled",
];
const STATUSES_WITHOUT_GLYPH = ["", "unknown"];

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

function statusSlot(): HTMLElement {
	const slots = container?.querySelectorAll('[data-testid="subagent-activity-status-slot"]') ?? [];
	// Exactly one slot per row: a second one would add width, a zeroth would let
	// the row collapse — both are height/layout regressions.
	expect(slots.length).toBe(1);
	return slots[0] as unknown as HTMLElement;
}

function categorySlot(): HTMLElement {
	const slots =
		container?.querySelectorAll('[data-testid="subagent-activity-category-slot"]') ?? [];
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
	test("reserves the same fixed 12x12 slot for every status, glyph or not", async () => {
		const observed: string[] = [];
		for (const status of [...STATUSES_WITH_GLYPH, ...STATUSES_WITHOUT_GLYPH]) {
			await render(toolCall(status, "running"));
			const slot = statusSlot();
			// A reserved box that cannot shrink: this is what makes a missing glyph
			// height-neutral instead of collapsing the slot to 0x0.
			expect(slot.style.width).toBe("12px");
			expect(slot.style.height).toBe("12px");
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
		// Every status yields identical slot geometry — the invariant, stated once
		// over the whole matrix rather than per-case.
		expect(new Set(observed).size).toBe(1);
	});

	test("the slot holds a glyph for known statuses and is empty for the rest", async () => {
		// Both directions of the same invariant, because each alone is satisfiable by a
		// broken row: an always-empty slot passes the second half, and a slot that
		// swallows the icon passes the first.
		for (const status of STATUSES_WITH_GLYPH) {
			await render(toolCall(status, "running"));
			expect(statusSlot().querySelector("svg")).not.toBeNull();
		}
		for (const status of STATUSES_WITHOUT_GLYPH) {
			await render(toolCall(status, "running"));
			// Genuinely empty: no stray placeholder text a screen reader would announce.
			expect(statusSlot().textContent).toBe("");
		}
	});
});

describe("SubagentActivityRow height reservation", () => {
	test("reserves a min-height so the timing area cannot move the row", async () => {
		// The timing text is line-height 1.55 while the sibling label is 1.4, so a
		// row without a reservation grows ~1.8px the moment a timer appears.
		for (const status of [...STATUSES_WITH_GLYPH, ...STATUSES_WITHOUT_GLYPH]) {
			for (const timing of TIMING_SHAPES) {
				await render(toolCall(status, timing));
				expect(rowGroup().style.minHeight).toBe(SUBAGENT_STATUS_ROW_MIN_HEIGHT);
			}
		}
	});

	test("row structure is identical across the status x timing matrix", async () => {
		// Same element shape everywhere: slot + label + timing container, so no
		// combination can introduce or drop a box that changes the row's height.
		const shapes = new Set<string>();
		for (const status of [...STATUSES_WITH_GLYPH, ...STATUSES_WITHOUT_GLYPH]) {
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
		// label box, so it can neither add a box to the row's flex line nor release the
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
			expect(group.style.minHeight).toBe(SUBAGENT_STATUS_ROW_MIN_HEIGHT);
			shapes.add(
				`${group.children.length}|${Array.from(group.children)
					.map((child) => child.tagName.toLowerCase())
					.join(",")}`,
			);
		}
		expect(shapes.size).toBe(1);
	});

	test("label lane stays a single non-shrinking flex line", async () => {
		// `minWidth: 0` is what allows truncation; without it the text sets the box's
		// min-content width and pushes the row wider (then taller once it wraps).
		const observed: string[] = [];
		for (const call of [summaryRow(), summaryRow({ description: LONG_SUMMARY })]) {
			await render(call);
			const box = labelBox();
			expect(box.style.display).toBe("flex");
			// linkedom serializes the unitless zero as "0" (a browser reports "0px").
			expect(box.style.minWidth).toBe("0");
			expect(box.style.alignItems).toBe("center");
			observed.push(`${box.style.display}|${box.style.minWidth}|${box.style.alignItems}`);
		}
		expect(new Set(observed).size).toBe(1);
	});

	test("a long summary truncates instead of wrapping", async () => {
		await render(summaryRow({ description: LONG_SUMMARY }));
		const summary = summaryEl();
		expect(summary).not.toBeNull();
		// `minWidth: 0` is what lets the flex item shrink below its content width, which
		// is the precondition for truncating rather than wrapping to a second line box.
		expect(summary?.style.minWidth).toBe("0");
		// Two independent caps apply before CSS ever clips: the SQL projection caps the
		// stored value at 200 chars, then `getSummary` truncates a bash description to
		// 80. So a 360-char input reaches the DOM already bounded — CSS truncation is
		// the last line of defence, not the only one.
		const text = summary?.textContent ?? "";
		expect(text.length).toBeLessThanOrEqual(80);
		expect(text.length).toBeGreaterThan(0);
	});

	test("degrades to the bare tool name when there is no summary", async () => {
		await render(summaryRow());
		expect(summaryEl()).toBeNull();
		expect(labelBox().textContent).toBe("Bash");
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
	test("is the single source of truth for the reserved glyph box", async () => {
		// The card header reuses this object, so drift between the two call sites
		// cannot happen silently.
		expect(SUBAGENT_STATUS_SLOT_STYLE).toMatchObject({
			width: 12,
			height: 12,
			flexShrink: 0,
			display: "flex",
		});
	});

	test("every row carries a category chip in its own fixed slot", async () => {
		// The chip tells file edits from shell runs from searches at a glance. It gets a
		// reserved box for the same reason the status glyph does — an unknown tool, which
		// still resolves to a fallback icon, must not collapse the slot and shorten the
		// row — but sized for the 16px chip rather than the 12px status glyph, so the
		// chip's tinted tile is not clipped. Row height is unaffected either way: the
		// reservation below is 24.8px, taller than both.
		const expected = `${SUBAGENT_CATEGORY_SLOT_SIZE}px`;
		for (const toolName of ["Bash", "Read", "Write", "Grep", "Await", "TotallyUnknownTool"]) {
			await render({ ...toolCall("success", "completed"), toolName });
			const slot = categorySlot();
			expect(slot.querySelector("svg")).not.toBeNull();
			expect(slot.style.width).toBe(expected);
			expect(slot.style.height).toBe(expected);
			expect(slot.style.flexShrink).toBe("0");
		}
	});

	test("the row reserves the root-font line box, not the smaller xs one", async () => {
		// The other height tests compare against the exported constant, so they pin
		// consistency but would follow the constant anywhere. This pins the value:
		// rows used to be ~6px shorter after the glyph slots removed the inline-svg
		// line box, which read as cramped. `1rem` restores the original 24.8px
		// reservation and must not silently drift back to `--mantine-font-size-xs`.
		expect(SUBAGENT_STATUS_ROW_MIN_HEIGHT).toBe("calc(1rem * var(--mantine-line-height))");
	});
});
