/**
 * SubagentActivityStatusGlyph.test.tsx — pins that a subagent "recent calls" row
 * shows a SPINNER from its very first frame.
 *
 * THE BUG THIS CLOSES
 * A tool call's first status is not `running`. `tool_use_chunk` fires while the
 * model is still writing the call's arguments, and the chunked path labels that
 * header `"streaming"` (useNarratorChunksWS.ts). `StatusIcon` knew only
 * `running | pending | initializing | success | fail | cancelled` and returned
 * `null` for everything else — so a brand-new row rendered an EMPTY status slot
 * and the spinner appeared only once `tool_started` promoted it to `running`,
 * which is what the report described as "blank at first, spins a while later".
 *
 * WHY THIS DRIVES A SEQUENCE RATHER THAN ONE STATUS EACH
 * The defect was a TIMING defect: every individual status rendered "correctly"
 * under the old code if you only ever asked about `running`. What was broken was
 * the FIRST frame. A per-status table test therefore reproduces nothing — the
 * regression only appears when the row is advanced in the order the WebSocket
 * actually delivers, so the tests below push
 * `tool_use_chunk → tool_started → tool_completed` through the real frontend
 * helpers (`subagentToolEventMeta` → `subagentHeaderFromEvent` →
 * `upsertSubagentToolCallHeader` → `subagentHeaderToToolCallData` → the row) and
 * assert after each hop.
 *
 * WHAT IS ASSERTED, AND WHY NOT CLASS NAMES
 * Mantine/Tabler class names are implementation detail and change with a version
 * bump. What actually makes the glyph read as "working" is its CSS animation, and
 * what distinguishes it from a check mark is the icon's own identity. Both are
 * observable without a layout engine: Tabler writes `tabler-icon-<name>` onto the
 * `<svg>`, and `StatusIcon` sets `animation` inline. linkedom is enough.
 *
 * i18n returns raw keys so assertions are label-stable; `SubagentActivityRow` and
 * `StatusIcon` are the REAL components under test.
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

const { SubagentActivityRow, subagentHeaderToToolCallData } = await import("./SubagentCard");
const { StatusIcon } = await import("./ToolCallCard");
const { subagentToolEventMeta } = await import("../../hooks/useNarratorWS");
const { subagentHeaderFromEvent } = await import("./useNarratorChunksWS");
const { upsertSubagentToolCallHeader } = await import("./message-tree-utils");

type SubagentToolCallHeader = import("../../lib/api").SubagentToolCallHeader;
type SubagentActivitySummary = import("../../lib/api").SubagentActivitySummary;

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

// ─────────────────────────────────────────────────────────────────────────────
// The wire frames, exactly as the parent page receives them for a CHILD tool.
// ─────────────────────────────────────────────────────────────────────────────

const PARENT_TOOL_USE_ID = "parent-tool";
const CHILD_TOOL_USE_ID = "child-tool";

/**
 * `tool_use_chunk`: the earliest frame. The tool has no result, no duration and
 * has not begun executing — the model is still emitting its arguments.
 */
function toolUseChunkFrame() {
	return {
		type: "tool_use_chunk",
		toolUseId: CHILD_TOOL_USE_ID,
		toolCallId: "row-1",
		toolName: "Read",
		inputCharsTotal: 48,
		parentToolUseId: PARENT_TOOL_USE_ID,
	} as Record<string, unknown>;
}

/** `tool_started`: execution begins; the chunked path labels this `running`. */
function toolStartedFrame() {
	return {
		type: "tool_started",
		toolUseId: CHILD_TOOL_USE_ID,
		toolCallId: "row-1",
		toolName: "Read",
		parentToolUseId: PARENT_TOOL_USE_ID,
		timing: { streamStartedAt: 1_000, executionStartedAt: 1_050 },
	} as Record<string, unknown>;
}

/** `tool_completed`: the terminal frame carrying the outcome. */
function toolCompletedFrame(status: string) {
	return {
		type: "tool_completed",
		toolUseId: CHILD_TOOL_USE_ID,
		toolCallId: "row-1",
		toolName: "Read",
		status,
		parentToolUseId: PARENT_TOOL_USE_ID,
		durationMs: 400,
		timing: { streamStartedAt: 1_000, executionStartedAt: 1_050, completedAt: 1_450 },
	} as Record<string, unknown>;
}

/**
 * The status each frame carries into `subagentHeaderFromEvent`, mirroring the call
 * sites in useNarratorChunksWS.ts: the chunk frame is `"streaming"`, the start
 * frame `"running"`, and the completion frame passes the server's own status through.
 */
function headerFor(frame: Record<string, unknown>): SubagentToolCallHeader {
	const status =
		frame.type === "tool_use_chunk"
			? "streaming"
			: frame.type === "tool_started"
				? "running"
				: (frame.status as string);
	return subagentHeaderFromEvent(
		frame.toolUseId as string,
		frame.toolName as string,
		status,
		subagentToolEventMeta(frame),
	);
}

/**
 * Live activity state for one parent card, advanced frame by frame through the
 * SAME reducer the WS path uses — so status precedence (including the
 * terminal-regression guard) is the real one, not a test-local reimplementation.
 */
function createActivity(): {
	apply: (frame: Record<string, unknown>) => SubagentToolCallHeader;
} {
	let summary: SubagentActivitySummary | undefined;
	return {
		apply(frame) {
			summary = upsertSubagentToolCallHeader(summary, headerFor(frame));
			const row = summary.latestToolCalls.at(-1);
			if (!row) throw new Error("activity summary produced no row");
			return row;
		},
	};
}

async function renderHeader(header: SubagentToolCallHeader) {
	if (!root) throw new Error("test harness is not initialized");
	const currentRoot = root;
	await act(async () => {
		currentRoot.render(
			<MantineProvider env="test">
				<SubagentActivityRow call={subagentHeaderToToolCallData(header)} />
			</MantineProvider>,
		);
	});
}

async function renderStatusIcon(status: string) {
	if (!root) throw new Error("test harness is not initialized");
	const currentRoot = root;
	await act(async () => {
		currentRoot.render(
			<MantineProvider env="test">
				<StatusIcon status={status} />
			</MantineProvider>,
		);
	});
}

function statusSlot(): HTMLElement {
	// The row is a TRACE row, so its status slot is the shared `TraceStatusSlot`
	// (same testid a folded trace row uses) rather than a subagent-specific box.
	const slot = container?.querySelector('[data-testid="trace-row-status-slot"]');
	if (!slot) throw new Error("activity status slot not rendered");
	return slot as unknown as HTMLElement;
}

/**
 * True when the row drew NO status slot.
 *
 * Distinct from an empty slot on purpose: an unmarked row must reserve no width at
 * all, or the blank gap is the same useless column the check was.
 */
function noStatusSlot(): boolean {
	return (container?.querySelectorAll('[data-testid="trace-row-status-slot"]') ?? []).length === 0;
}

/** The glyph inside the status slot, or null when the slot is empty. */
function statusGlyph(): SVGElement | null {
	return (statusSlot().querySelector("svg") ?? null) as unknown as SVGElement | null;
}

/**
 * Tabler stamps `tabler-icon-<name>` on every icon's `<svg>`, which identifies the
 * COMPONENT (loader / check / x) without touching Mantine's generated class names.
 */
function glyphName(el: SVGElement | null): string | null {
	const cls = el?.getAttribute("class") ?? "";
	return /tabler-icon-([a-z0-9-]+)/.exec(cls)?.[1] ?? null;
}

/** True when the glyph is animated — the actual "work in progress" signal. */
function isSpinning(el: SVGElement | null): boolean {
	const animation =
		(el as unknown as { style?: { animation?: string } } | null)?.style?.animation ?? "";
	return /\bspin\b/.test(animation);
}

function expectSpinner(): void {
	const glyph = statusGlyph();
	// Not null and not an empty slot: this is the assertion the bug failed.
	expect(glyph).not.toBeNull();
	expect(glyphName(glyph)).toBe("loader-2");
	expect(isSpinning(glyph)).toBe(true);
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
	// Bun's `mock.restore()` does NOT undo `mock.module`, so each module has to be
	// handed back explicitly or every later file in the run inherits these stubs.
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.module("../../hooks/useNarrator", () => realUseNarratorModule);
	mock.module("../../hooks/usePlatform", () => realUsePlatformModule);
	mock.module("@tanstack/react-router", () => realRouterModule);
	mock.restore();
	restoreGlobals();
});

describe("activity row status glyph across the real event sequence", () => {
	test("spins from the first tool_use_chunk, through tool_started, until completion", async () => {
		const activity = createActivity();

		// FRAME 1 — tool_use_chunk. The row appears here, before execution starts.
		// Under the bug this slot was empty; the spinner is the whole point.
		await renderHeader(activity.apply(toolUseChunkFrame()));
		expectSpinner();

		// FRAME 2 — tool_started. Same glyph: the reader must not see a flicker or a
		// change of mark just because the status string moved streaming → running.
		await renderHeader(activity.apply(toolStartedFrame()));
		expectSpinner();

		// FRAME 3 — tool_completed, successfully. The spinner does not become a check:
		// it goes AWAY. Success is the default expectation, so a column of green checks
		// is noise that costs the reader the attention a real failure needs — only
		// deviation is marked (see @shared/tool-row-status). The failing case below is
		// what proves this is "unmarked on success", not "never marks a terminal".
		await renderHeader(activity.apply(toolCompletedFrame("success")));
		expect(noStatusSlot()).toBe(true);
	});

	test("a failed call ends on an X rather than a check", async () => {
		// The success path alone would pass with a glyph that ignores the status
		// entirely, so the failing terminal is driven through the same sequence.
		const activity = createActivity();
		await renderHeader(activity.apply(toolUseChunkFrame()));
		expectSpinner();
		await renderHeader(activity.apply(toolStartedFrame()));
		await renderHeader(activity.apply(toolCompletedFrame("fail")));
		expect(glyphName(statusGlyph())).toBe("x");
	});

	test("a call that never streams still spins on its first frame", async () => {
		// Not every tool announces itself with a chunk (a zero-argument call can go
		// straight to tool_started), so the first-frame guarantee must hold for that
		// entry point too — the row's first paint is a spinner either way.
		const activity = createActivity();
		await renderHeader(activity.apply(toolStartedFrame()));
		expectSpinner();
	});
});

describe("StatusIcon in-flight branch", () => {
	test("every in-flight status yields the same spinning loader", async () => {
		// `streaming` sits alongside the others rather than in the fallback: they are
		// one state as far as the reader is concerned. Asserted on the shared
		// component so the two SubagentCard call sites and the tool card header cannot
		// diverge.
		for (const status of ["streaming", "running", "pending", "initializing"]) {
			await renderStatusIcon(status);
			const glyph = container?.querySelector("svg") as unknown as SVGElement | null;
			expect(glyphName(glyph)).toBe("loader-2");
			expect(isSpinning(glyph)).toBe(true);
		}
	});

	test("still renders nothing for a status it has never heard of", async () => {
		// The fallback stays empty rather than guessing a mark. This is why the fixed
		// 12x12 slot in SubagentCard must remain height-neutral
		// (SubagentActivityRowHeight.test.tsx owns that geometry).
		for (const status of ["", "unknown"]) {
			await renderStatusIcon(status);
			expect(container?.querySelector("svg")).toBeNull();
		}
	});
});
