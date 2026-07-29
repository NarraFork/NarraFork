/**
 * ToolTimingArea.test.tsx — DOM tests for the tool-call TIMING POPOVER trigger.
 *
 * Three contracts are pinned here:
 *  1. Desktop hover opens the timeline; a mouse *click* is reserved for `onMouseActivate`
 *     (the timeout editor), so the two popovers never fight for the same gesture.
 *  2. Touch keeps its tap-to-open semantics and must NOT react to synthetic hover.
 *  3. Every timeline row renders the same number of columns — the first row has no delta but
 *     still emits an aria-hidden spacer, which is what keeps the time column x-aligned.
 *
 * i18n returns raw keys so assertions are label-stable. Mantine renders with `env="test"`
 * (no transitions/portal timing) and the popover dropdown is asserted through
 * `document.body` because it is portalled.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const realReactI18nextModule = { ...(await import("react-i18next")) };
const realUseNarratorModule = { ...(await import("@frontend/hooks/useNarrator")) };
const realUsePlatformModule = { ...(await import("@frontend/hooks/usePlatform")) };

mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
// The timing area itself needs no narrator/platform data, but ToolCallCard's module graph
// pulls in these react-query hooks at import time.
mock.module("@frontend/hooks/useNarrator", () => ({
	...realUseNarratorModule,
	useInterruptNarrator: () => ({ mutate: () => {}, isPending: false }),
	useToolCallDetail: () => ({ data: undefined }),
}));
mock.module("@frontend/hooks/usePlatform", () => ({
	...realUsePlatformModule,
	usePlatform: () => "linux",
	useFileSystemCapability: () => ({ supported: false }),
	useNarratorPermissionsCapability: () => ({ supported: false }),
	useShareCapability: () => ({ supported: false }),
}));

const { ToolTimingArea } = await import("./ToolCallCard");
type ToolCallData = import("./ToolCallCard").ToolCallData;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let dom: ReturnType<typeof parseHTML> | undefined;

function installDom() {
	dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const { window } = dom;
	// Report reduced motion: Mantine's transition hook then uses a 0ms duration and applies
	// status changes synchronously instead of chaining rAF + timeout callbacks that would
	// land outside act(). Open/close assertions stay meaningful; only the animation is skipped.
	const matchMedia = (query: string) => ({
		matches: query.includes("prefers-reduced-motion"),
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
	// Mantine's transition hook reads these off `window`, not globalThis, and drives state
	// through them; route them at timers so `flush()` can drain the whole chain inside act().
	Object.defineProperties(window, {
		requestAnimationFrame: { configurable: true, writable: true, value: requestAnimationFrame },
		cancelAnimationFrame: { configurable: true, writable: true, value: cancelAnimationFrame },
		setTimeout: { configurable: true, writable: true, value: setTimeout },
		clearTimeout: { configurable: true, writable: true, value: clearTimeout },
	});
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
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
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) Reflect.set(globalThis, key, value);
			continue;
		}
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}

/** linkedom has no PointerEvent; forge the two fields the handlers read. */
function pointerEvent(type: string, pointerType: string) {
	if (!dom) throw new Error("dom is not installed");
	const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "pointerType", { value: pointerType });
	Object.defineProperty(event, "relatedTarget", { value: null });
	Object.defineProperty(event, "button", { value: 0 });
	return event;
}

const COMPLETED_TOOL: ToolCallData = {
	toolName: "Bash",
	toolUseId: "tool-1",
	inputJson: { command: "ls" },
	status: "success",
	// Deliberately single-digit month/day: the popover must still align its columns.
	createdAt: new Date(2026, 6, 9, 9, 3, 5).toISOString(),
	permissionStartedAt: new Date(2026, 6, 9, 9, 3, 6).toISOString(),
	executionStartedAt: new Date(2026, 6, 9, 9, 3, 8, 100).toISOString(),
	completedAt: new Date(2026, 6, 9, 9, 3, 9).toISOString(),
	durationMs: 4_000,
};

async function render(props: Partial<Parameters<typeof ToolTimingArea>[0]> = {}) {
	if (!root) throw new Error("test harness is not initialized");
	const currentRoot = root;
	await act(async () => {
		currentRoot.render(
			<MantineProvider env="test" theme={{ respectReducedMotion: true }}>
				<ToolTimingArea toolCall={COMPLETED_TOOL} isActive={false} {...props} />
			</MantineProvider>,
		);
	});
}

function trigger(): HTMLElement {
	const button = container?.querySelector("button");
	if (!button) throw new Error("timing trigger not rendered");
	return button as unknown as HTMLElement;
}

function timerGroup(): HTMLElement {
	const group = trigger().parentElement;
	if (!group) throw new Error("timer group not rendered");
	return group;
}

function dropdownText(): string {
	return document.body.textContent ?? "";
}

function isTimelineOpen(): boolean {
	return dropdownText().includes("toolCallInspector.timing.title");
}

/** Comfortably longer than the component's 120ms hover-close delay. */
const TIMING_HOVER_CLOSE_GRACE_MS = 220;

/**
 * Let pending timers settle inside act(). Two passes: the first drains the component's own
 * timer (e.g. the hover-close delay), the second drains the Mantine Transition update that
 * timer schedules — otherwise React reports it as an un-acted update.
 */
async function flush(ms = 0) {
	for (const delay of [ms, 0]) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, delay));
		});
	}
}

async function dispatch(target: HTMLElement, type: string, pointerType: string) {
	await act(async () => {
		target.dispatchEvent(pointerEvent(type, pointerType));
	});
	await flush();
}

/** Mouse click = pointerdown (records pointerType) followed by click. */
async function clickWith(target: HTMLElement, pointerType: string) {
	await dispatch(target, "pointerdown", pointerType);
	await dispatch(target, "click", pointerType);
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	const currentRoot = root;
	// Drain the hover-close timer and Mantine's exit transition before tearing down, otherwise
	// their state updates land after unmount and React reports an un-acted update.
	await flush(TIMING_HOVER_CLOSE_GRACE_MS);
	await act(async () => currentRoot?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

afterAll(() => {
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.module("@frontend/hooks/useNarrator", () => realUseNarratorModule);
	mock.module("@frontend/hooks/usePlatform", () => realUsePlatformModule);
});

describe("ToolTimingArea pointer routing", () => {
	test("mouse hover opens the timeline and leaving closes it after the grace period", async () => {
		await render();
		expect(isTimelineOpen()).toBe(false);

		await dispatch(timerGroup(), "pointerover", "mouse");
		expect(isTimelineOpen()).toBe(true);

		await dispatch(timerGroup(), "pointerout", "mouse");
		// The close is delayed so the cursor can reach the dropdown.
		expect(isTimelineOpen()).toBe(true);
		await flush(TIMING_HOVER_CLOSE_GRACE_MS);
		expect(isTimelineOpen()).toBe(false);
	});

	test("touch hover is ignored, but a tap toggles the timeline", async () => {
		await render();

		await dispatch(timerGroup(), "pointerover", "touch");
		expect(isTimelineOpen()).toBe(false);

		await clickWith(trigger(), "touch");
		expect(isTimelineOpen()).toBe(true);

		await clickWith(trigger(), "touch");
		expect(isTimelineOpen()).toBe(false);
	});

	test("a mouse click hands off to onMouseActivate (timeout editor) and closes the timeline", async () => {
		const onMouseActivate = mock(() => {});
		const openedChanges: boolean[] = [];
		await render({ onMouseActivate, onOpenedChange: (next) => openedChanges.push(next) });

		await dispatch(timerGroup(), "pointerover", "mouse");
		expect(isTimelineOpen()).toBe(true);

		await clickWith(trigger(), "mouse");
		expect(onMouseActivate).toHaveBeenCalledTimes(1);
		expect(isTimelineOpen()).toBe(false);
		expect(openedChanges).toEqual([true, false]);
	});

	test("after handing off, re-entry does not hover the timeline back over the editor", async () => {
		const onMouseActivate = mock(() => {});
		await render({ onMouseActivate });

		await dispatch(timerGroup(), "pointerover", "mouse");
		await clickWith(trigger(), "mouse");
		expect(isTimelineOpen()).toBe(false);

		// Moving between the timer and the timeout text re-fires enter without ever leaving.
		await dispatch(timerGroup(), "pointerover", "mouse");
		expect(isTimelineOpen()).toBe(false);

		// Leaving clears the hand-off, so the next hover behaves normally again.
		await dispatch(timerGroup(), "pointerout", "mouse");
		await flush(TIMING_HOVER_CLOSE_GRACE_MS);
		await dispatch(timerGroup(), "pointerover", "mouse");
		expect(isTimelineOpen()).toBe(true);
	});

	test("without onMouseActivate a mouse click keeps the hovered timeline open", async () => {
		await render();

		await dispatch(timerGroup(), "pointerover", "mouse");
		await clickWith(trigger(), "mouse");
		// Toggling off here would leave a popover that cannot reopen until the pointer leaves.
		expect(isTimelineOpen()).toBe(true);
	});

	test("hovering the dropdown cancels the pending close so timestamps stay selectable", async () => {
		await render();
		await dispatch(timerGroup(), "pointerover", "mouse");
		const dropdown = document.body.querySelector(".mantine-Popover-dropdown") as HTMLElement | null;
		expect(dropdown).not.toBeNull();
		if (!dropdown) return;

		await dispatch(timerGroup(), "pointerout", "mouse");
		await dispatch(dropdown, "pointerover", "mouse");
		await flush(TIMING_HOVER_CLOSE_GRACE_MS);
		expect(isTimelineOpen()).toBe(true);
	});

	test("a controlled opened prop still drives the popover", async () => {
		await render({ opened: true, onOpenedChange: () => {} });
		expect(isTimelineOpen()).toBe(true);
	});
});

describe("ToolTimingArea timeline layout", () => {
	test("every row renders three columns, with an aria-hidden spacer for the first delta", async () => {
		await render();
		await dispatch(timerGroup(), "pointerover", "mouse");
		const dropdown = document.body.querySelector(".mantine-Popover-dropdown");
		expect(dropdown).not.toBeNull();
		if (!dropdown) return;

		// One grid holds every row; each row is a `display: contents` wrapper, so its three
		// cells become grid items of the shared grid and therefore share column widths.
		const grid = dropdown.querySelector("[data-tool-timing-grid]");
		expect(grid).not.toBeNull();
		expect((grid as HTMLElement | null)?.style.gridTemplateColumns).toBe(
			"minmax(0, 1fr) max-content max-content",
		);

		const rows = Array.from(dropdown.querySelectorAll("[data-tool-timing-row]"));
		expect(rows.length).toBeGreaterThanOrEqual(3);
		for (const row of rows) {
			expect(row.children.length).toBe(3);
		}

		const firstDelta = rows[0]?.children[2];
		expect(firstDelta?.getAttribute("aria-hidden")).toBe("true");
		expect(firstDelta?.textContent).toBe("");
		// Later rows carry a visible, non-hidden delta.
		const secondDelta = rows[1]?.children[2];
		expect(secondDelta?.hasAttribute("aria-hidden")).toBe(false);
		expect(secondDelta?.textContent?.startsWith("+")).toBe(true);
	});

	test("keeps only the total footer, dropping the redundant per-phase lines", async () => {
		await render();
		await dispatch(timerGroup(), "pointerover", "mouse");
		const stack = document.body.querySelector(".mantine-Stack-root");
		expect(stack).not.toBeNull();
		if (!stack) return;

		// Non-row children are the title and the footer summaries. Asserted as an exact list
		// because `timing.executionStarted` (a row label) contains `timing.execution` as a prefix,
		// so a substring check on the whole dropdown could never prove the footer line is gone.
		const summaryLines = Array.from(stack.children)
			.filter((child) => !child.hasAttribute("data-tool-timing-grid"))
			.map((child) => child.textContent);
		expect(summaryLines).toEqual([
			"toolCallInspector.timing.title",
			"toolCallInspector.timing.total",
		]);
	});
});
