/**
 * TraceRowInteraction.test.tsx — DOM tests for the FOLDED TRACE ROW menu.
 *
 * A row inside a collapsed tool-run (L3 ToolRunSummary / L1-L2 ActivityTrace) gets
 * the same menu an expanded card has. These tests pin the gating of the
 * tool-specific items the user explicitly asked for — inspect, copy file path,
 * view file, view subagent session — so each appears only when its data exists.
 *
 * The network invariant is asserted directly: a row must NEVER fall back to a
 * per-row background-task lookup to resolve a child narrator (a trace shows 10+
 * rows). With no embedded id the item is simply absent, and `fetch` is stubbed
 * to fail the test if anything tries.
 *
 * The swipe hook is stubbed with the context menu forced open so the dropdown
 * mounts synchronously; i18n returns raw keys so assertions are label-stable.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolCallDetailRef } from "../../lib/api/narrators";
import { NarratorDockContext, type NarratorDockContextValue } from "./dock/NarratorDockContext";

const realReactI18nextModule = { ...(await import("react-i18next")) };
const realUsePlatformModule = { ...(await import("@frontend/hooks/usePlatform")) };
const realMessageSelectionModule = { ...(await import("./message/MessageSelectionCtx")) };

const closeSwipeMock = mock(() => {});
const clipboardCopyMock = mock((_value: string) => {});
const viewSubagentSessionMock = mock((_narratorId: string) => {});
const detachSubagentMock = mock((_narratorId: string) => {});
const cancelBackgroundTaskMock = mock((_narratorId: string) => {});
let platformMock: "windows" | "macos" | "linux" = "linux";

mock.module("@frontend/hooks/useSwipeMenu", () => ({
	useSwipeMenu: () => ({
		swipeBoxRef: { current: null },
		swipeMenuRef: { current: null },
		swipeOffset: 0,
		swipeRevealed: false,
		swipeClosing: false,
		closeSwipe: closeSwipeMock,
		// Forced open so the dropdown (and thus the menu items) render.
		ctxMenuOpened: true,
		setCtxMenuOpened: () => {},
		ctxMenuPos: { x: 0, y: 0, flipY: false },
		setCtxMenuPos: () => {},
		swipeStyle: {},
		swipeTransition: "",
		swipeMenuTransition: "",
		getSwipeMenuPosition: () => ({ left: 0, top: 0 }),
	}),
}));
mock.module("@frontend/hooks/usePlatform", () => ({
	...realUsePlatformModule,
	usePlatform: () => platformMock,
}));
mock.module("@mantine/hooks", () => ({
	useMediaQuery: () => false,
	useClipboard: () => ({ copy: clipboardCopyMock, copied: false, reset: () => {} }),
	useDisclosure: (initial = false) => [
		initial,
		{ open: () => {}, close: () => {}, toggle: () => {} },
	],
}));
mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
mock.module("./CompactMenuSub", () => ({ CompactMenuSub: () => null }));
mock.module("./message/MessageSelectionCtx", () => ({
	...realMessageSelectionModule,
	shouldIgnoreMessageBlockSelection: () => false,
	useMessageSelection: () => ({
		selectionMode: false,
		selectedBlockIds: new Set<string>(),
		deselectBlock: () => {},
		rangeSelectTo: () => {},
		toggleBlock: () => {},
	}),
}));

const { TraceRowInteraction } = await import("./TraceRowInteraction");
type TraceRowIdentity = import("./trace-row-identity").TraceRowIdentity;
type TraceRowToolMeta = import("./trace-row-identity").TraceRowToolMeta;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

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
	Object.defineProperties(window, {
		requestAnimationFrame: { configurable: true, writable: true, value: requestAnimationFrame },
		cancelAnimationFrame: { configurable: true, writable: true, value: cancelAnimationFrame },
		matchMedia: { configurable: true, writable: true, value: matchMedia },
	});
	class TestResizeObserver {
		observe() {}
		unobserve() {}
		disconnect() {}
	}
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		ResizeObserver: TestResizeObserver,
		matchMedia,
		requestAnimationFrame,
		cancelAnimationFrame,
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

interface RenderOpts {
	dock?: NarratorDockContextValue;
	toolDetailRef?: ToolCallDetailRef;
	tool?: TraceRowToolMeta;
	narratorId?: string;
	copyText?: string;
	blockIndices?: readonly number[];
	/** Omit to render with no message-level actions at all. */
	withMessageActions?: boolean;
	onViewSubagentSession?: (narratorId: string) => void;
	onDetachSubagent?: (narratorId: string) => void;
	onCancelBackgroundTask?: (narratorId: string) => void;
}

async function renderRow(opts: RenderOpts = {}) {
	const identity: TraceRowIdentity = {
		blockId: opts.tool ? `tc-${opts.tool.toolUseId ?? "x"}` : "msg-m1-0",
		messageId: "m1",
		blockIndex: 0,
		...(opts.blockIndices ? { blockIndices: opts.blockIndices } : {}),
		...(opts.tool ? { tool: opts.tool } : {}),
		...(opts.copyText ? { copyText: opts.copyText } : {}),
	};
	await act(async () => {
		root?.render(
			<MantineProvider>
				<NarratorDockContext.Provider value={opts.dock ?? null}>
					<TraceRowInteraction
						identity={identity}
						actions={
							opts.withMessageActions
								? { messageId: "m1", onForkFromMessage: () => {}, onRollbackToBlock: () => {} }
								: { messageId: "m1" }
						}
						narratorId={opts.narratorId}
						toolDetailRef={opts.toolDetailRef}
						onViewSubagentSession={opts.onViewSubagentSession}
						onDetachSubagent={opts.onDetachSubagent}
						onCancelBackgroundTask={opts.onCancelBackgroundTask}
					>
						<div>row title</div>
					</TraceRowInteraction>
				</NarratorDockContext.Provider>
			</MantineProvider>,
		);
	});
}

/** All menu item labels currently rendered (i18n keys, thanks to the stub). */
function menuLabels(): string[] {
	return [...(document.querySelectorAll(".mantine-Menu-item") ?? [])].map((el) =>
		(el.textContent ?? "").trim(),
	);
}

function clickMenuItem(label: string) {
	const item = [...document.querySelectorAll(".mantine-Menu-item")].find(
		(el) => (el.textContent ?? "").trim() === label,
	);
	if (!item) throw new Error(`menu item not found: ${label} (have: ${menuLabels().join(" | ")})`);
	(item as HTMLElement).click();
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	closeSwipeMock.mockClear();
	clipboardCopyMock.mockClear();
	viewSubagentSessionMock.mockClear();
	detachSubagentMock.mockClear();
	cancelBackgroundTaskMock.mockClear();
	platformMock = "linux";
	// Any network call from a folded row is a bug — a trace has 10+ rows.
	globalThis.fetch = (() => {
		throw new Error("a folded trace row must not perform any network request");
	}) as unknown as typeof fetch;
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.module("@frontend/hooks/usePlatform", () => realUsePlatformModule);
	mock.module("./message/MessageSelectionCtx", () => realMessageSelectionModule);
	mock.restore();
});

test("Edit right-click opens its historical resource with the persisted row identity", async () => {
	const openFilePanel = mock((..._args: unknown[]) => {});
	const ref = { toolCallId: "actual-pk", messageId: "actual-message", executionAttempt: 2 };
	await renderRow({
		narratorId: "row-reader",
		tool: { toolName: "Edit", toolUseId: "reused-sdk", filePath: "/work/a.ts", isFileTool: true },
		toolDetailRef: ref,
		dock: { narratorId: "different-host", openFilePanel } as unknown as NarratorDockContextValue,
	});
	expect(menuLabels()).toContain("editPreview.open");
	clickMenuItem("editPreview.open");
	expect(openFilePanel).toHaveBeenCalledWith("/work/a.ts", undefined, {
		toolEdit: { ...ref, narratorId: "row-reader", toolUseId: "reused-sdk" },
	});
	expect(closeSwipeMock).toHaveBeenCalled();
});

describe("TraceRowInteraction — tool-call inspector gating", () => {
	test("offers inspect when both a narratorId and a toolUseId exist", async () => {
		await renderRow({ tool: { toolName: "Read", toolUseId: "tu-1" }, narratorId: "n1" });
		expect(menuLabels()).toContain("toolCallInspector.inspect");
	});

	test("hides inspect without a toolUseId", async () => {
		await renderRow({ tool: { toolName: "Read" }, narratorId: "n1" });
		expect(menuLabels()).not.toContain("toolCallInspector.inspect");
	});

	test("hides inspect without a narratorId", async () => {
		await renderRow({ tool: { toolName: "Read", toolUseId: "tu-1" } });
		expect(menuLabels()).not.toContain("toolCallInspector.inspect");
	});

	test("hides inspect on a reasoning row (no tool at all)", async () => {
		await renderRow({ narratorId: "n1", copyText: "thought" });
		expect(menuLabels()).not.toContain("toolCallInspector.inspect");
	});
});

describe("TraceRowInteraction — file items gating", () => {
	test("offers copy-path and view-file for a Read tool with a path", async () => {
		await renderRow({
			tool: { toolName: "Read", toolUseId: "tu-1", filePath: "/a/b.ts", isReadTool: true },
		});
		const labels = menuLabels();
		expect(labels).toContain("contextMenu_copyFilePath");
		expect(labels).toContain("contextMenu_viewFile");
	});

	test("offers copy-path but NOT view-file for a non-Read file tool", async () => {
		await renderRow({ tool: { toolName: "Write", toolUseId: "tu-1", filePath: "/a/b.ts" } });
		const labels = menuLabels();
		expect(labels).toContain("contextMenu_copyFilePath");
		expect(labels).not.toContain("contextMenu_viewFile");
	});

	test("hides both file items when the tool carries no path", async () => {
		await renderRow({ tool: { toolName: "Bash", toolUseId: "tu-1" } });
		const labels = menuLabels();
		expect(labels).not.toContain("contextMenu_copyFilePath");
		expect(labels).not.toContain("contextMenu_viewFile");
	});

	test("copies a backslash path on Windows", async () => {
		platformMock = "windows";
		await renderRow({ tool: { toolName: "Read", toolUseId: "tu-1", filePath: "/a/b.ts" } });
		clickMenuItem("contextMenu_copyFilePath");
		expect(clipboardCopyMock).toHaveBeenCalledWith("\\a\\b.ts");
	});
});

describe("TraceRowInteraction — subagent session gating (no per-row query)", () => {
	test("offers the item when the narrator id is embedded and a handler exists", async () => {
		await renderRow({
			tool: { toolName: "Await", toolUseId: "tu-1", awaitAgentNarratorId: "sub-7" },
			onViewSubagentSession: viewSubagentSessionMock,
		});
		expect(menuLabels()).toContain("viewSubagentSession");
		clickMenuItem("viewSubagentSession");
		expect(viewSubagentSessionMock).toHaveBeenCalledWith("sub-7");
	});

	test("hides the item when no id is embedded, and issues NO request", async () => {
		// The expanded ToolCallCard would fall back to resolveBackgroundTaskTarget
		// here; a folded row must not, or a 10-row trace would open 10 subscriptions.
		// The fetch stub in beforeEach throws if anything tries.
		await renderRow({
			tool: { toolName: "Await", toolUseId: "tu-1" },
			onViewSubagentSession: viewSubagentSessionMock,
		});
		expect(menuLabels()).not.toContain("viewSubagentSession");
	});

	test("hides the item when the panel supplies no handler", async () => {
		await renderRow({
			tool: { toolName: "Await", toolUseId: "tu-1", awaitAgentNarratorId: "sub-7" },
		});
		expect(menuLabels()).not.toContain("viewSubagentSession");
	});
});

/**
 * Regression suite for the reported bug: at low LOD a subagent card folds into a
 * trace row, and those rows used to resolve a child narrator ONLY from
 * `awaitAgentNarratorId`. Agent / Task / Send subagents therefore lost all three
 * subagent items the expanded SubagentCard offers. Gating below mirrors
 * SubagentCard.tsx's menu exactly.
 */
describe("TraceRowInteraction — subagent card items (Agent / Task / Send rows)", () => {
	const running = {
		toolName: "Agent",
		toolUseId: "tu-1",
		subagentNarratorId: "sub-3",
	} as const;

	test("opens the child session from subagentNarratorId, not just Await metadata", async () => {
		await renderRow({ tool: running, onViewSubagentSession: viewSubagentSessionMock });
		expect(menuLabels()).toContain("viewSubagentSession");
		clickMenuItem("viewSubagentSession");
		expect(viewSubagentSessionMock).toHaveBeenCalledWith("sub-3");
	});

	test("offers detach while the subagent runs in the foreground", async () => {
		await renderRow({ tool: running, onDetachSubagent: detachSubagentMock });
		expect(menuLabels()).toContain("detachToBackground");
		clickMenuItem("detachToBackground");
		expect(detachSubagentMock).toHaveBeenCalledWith("sub-3");
	});

	test("offers cancel instead of detach once it is a background task", async () => {
		await renderRow({
			tool: { ...running, isBackground: true },
			onDetachSubagent: detachSubagentMock,
			onCancelBackgroundTask: cancelBackgroundTaskMock,
		});
		const labels = menuLabels();
		expect(labels).toContain("backgroundTasks.cancel");
		expect(labels).not.toContain("detachToBackground");
		clickMenuItem("backgroundTasks.cancel");
		expect(cancelBackgroundTaskMock).toHaveBeenCalledWith("sub-3");
	});

	test("hides both lifecycle items once the call is terminal", async () => {
		await renderRow({
			tool: { ...running, isTerminal: true },
			onDetachSubagent: detachSubagentMock,
			onCancelBackgroundTask: cancelBackgroundTaskMock,
		});
		const labels = menuLabels();
		expect(labels).not.toContain("detachToBackground");
		expect(labels).not.toContain("backgroundTasks.cancel");
		// A finished subagent can still be inspected by opening its session.
		await renderRow({
			tool: { ...running, isTerminal: true },
			onViewSubagentSession: viewSubagentSessionMock,
		});
		expect(menuLabels()).toContain("viewSubagentSession");
	});

	test("hides lifecycle items when no child narrator resolved yet", async () => {
		await renderRow({
			tool: { toolName: "Agent", toolUseId: "tu-1" },
			onDetachSubagent: detachSubagentMock,
			onCancelBackgroundTask: cancelBackgroundTaskMock,
		});
		const labels = menuLabels();
		expect(labels).not.toContain("detachToBackground");
		expect(labels).not.toContain("backgroundTasks.cancel");
	});

	test("hides each item when the panel supplies no handler (capability gating)", async () => {
		await renderRow({ tool: running });
		const labels = menuLabels();
		expect(labels).not.toContain("viewSubagentSession");
		expect(labels).not.toContain("detachToBackground");

		await renderRow({ tool: { ...running, isBackground: true } });
		expect(menuLabels()).not.toContain("backgroundTasks.cancel");
	});
});

describe("TraceRowInteraction — shared message items", () => {
	test("offers copy only when the row carries copyText", async () => {
		await renderRow({ copyText: "hello" });
		expect(menuLabels()).toContain("copy");

		await renderRow({});
		expect(menuLabels()).not.toContain("copy");
	});

	test("renders the message actions the panel provided", async () => {
		await renderRow({ withMessageActions: true, copyText: "hello" });
		const labels = menuLabels();
		expect(labels).toContain("contextMenu_fork");
		expect(labels).toContain("contextMenu_rollback");
	});

	test("omits message actions entirely when the panel supplied none", async () => {
		await renderRow({ copyText: "hello" });
		const labels = menuLabels();
		expect(labels).not.toContain("contextMenu_fork");
		expect(labels).not.toContain("contextMenu_rollback");
		expect(labels).not.toContain("contextMenu_delete");
	});
});

describe("TraceRowInteraction — DOM selection contract", () => {
	test("emits the block/message/index attributes the selection toolbar reads", async () => {
		await renderRow({ tool: { toolName: "Read", toolUseId: "tu-9" } });
		const block = container?.querySelector("[data-block-id]");
		expect(block?.getAttribute("data-block-id")).toBe("tc-tu-9");
		expect(block?.getAttribute("data-message-id")).toBe("m1");
		expect(block?.getAttribute("data-block-index")).toBe("0");
	});

	test("emits data-block-indices only for a multi-block reasoning run", async () => {
		await renderRow({ blockIndices: [0, 1] });
		expect(
			container?.querySelector("[data-block-indices]")?.getAttribute("data-block-indices"),
		).toBe("0,1");

		await renderRow({ blockIndices: [0] });
		expect(container?.querySelector("[data-block-indices]")).toBeNull();
	});
});
