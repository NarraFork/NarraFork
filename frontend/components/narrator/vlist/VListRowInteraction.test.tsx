/**
 * VListRowInteraction.test.tsx — DOM tests for the vlist row menu.
 *
 * Focus: the CARD-SPECIFIC command items this layer adds on top of the shared
 * message menu (open child session, detach to background, cancel background
 * task, inspect tool call, copy file path, view file) — that each appears only
 * under the same conditions the chunked ToolCallCard / SubagentCard use, and
 * that clicking one invokes the bound action.
 *
 * The swipe hook is stubbed with the context menu forced open so the dropdown is
 * mounted synchronously; i18n returns raw keys so assertions are label-stable.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const realReactI18nextModule = { ...(await import("react-i18next")) };
const realUsePlatformModule = { ...(await import("@frontend/hooks/usePlatform")) };
const realMessageSelectionModule = { ...(await import("../MessageSelectionCtx")) };

const closeSwipeMock = mock(() => {});
const clipboardCopyMock = mock((_value: string) => {});
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
mock.module("../CompactMenuSub", () => ({ CompactMenuSub: () => null }));
mock.module("../MessageSelectionCtx", () => ({
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

const { VListRowInteraction } = await import("./VListRowInteraction");
const { buildRowToolActions } = await import("./vlist-row-actions");
type VListToolMeta = import("./vlist-tool-meta").VListToolMeta;
type VListRowHandlers = import("./vlist-row-actions").VListRowHandlers;

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
	toolMeta?: VListToolMeta;
	handlers?: VListRowHandlers;
	narratorId?: string;
	toolUseId?: string;
	copyText?: string;
}

async function renderRow(opts: RenderOpts = {}) {
	const toolActions = opts.toolMeta
		? buildRowToolActions(opts.toolMeta, opts.handlers ?? {})
		: undefined;
	await act(async () => {
		root?.render(
			<MantineProvider>
				<VListRowInteraction
					blockId="sa-tu_1"
					messageId="m1"
					blockIndex={0}
					copyText={opts.copyText}
					actions={{ messageId: "m1" }}
					narratorId={opts.narratorId}
					toolUseId={opts.toolUseId}
					toolMeta={opts.toolMeta}
					toolActions={toolActions}
				>
					<div>row body</div>
				</VListRowInteraction>
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

const ALL_HANDLERS: VListRowHandlers = {
	onViewSubagentSession: () => {},
	onDetachSubagent: () => {},
	onCancelBackgroundTask: () => {},
};

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	closeSwipeMock.mockClear();
	clipboardCopyMock.mockClear();
	platformMock = "linux";
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

afterAll(() => {
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.module("@frontend/hooks/usePlatform", () => realUsePlatformModule);
	mock.module("../MessageSelectionCtx", () => realMessageSelectionModule);
	mock.restore();
});

describe("VListRowInteraction — subagent card items", () => {
	test("offers open-session and detach for a live foreground subagent", async () => {
		await renderRow({
			toolMeta: { toolName: "Agent", subagentNarratorId: "sub-1" },
			handlers: ALL_HANDLERS,
		});
		const labels = menuLabels();
		expect(labels).toContain("viewSubagentSession");
		expect(labels).toContain("detachToBackground");
		expect(labels).not.toContain("backgroundTasks.cancel");
	});

	test("offers cancel instead of detach for a background subagent", async () => {
		await renderRow({
			toolMeta: { toolName: "Agent", subagentNarratorId: "sub-1", isBackground: true },
			handlers: ALL_HANDLERS,
		});
		const labels = menuLabels();
		expect(labels).toContain("backgroundTasks.cancel");
		expect(labels).not.toContain("detachToBackground");
	});

	test("drops both lifecycle items once the subagent is terminal", async () => {
		await renderRow({
			toolMeta: { toolName: "Agent", subagentNarratorId: "sub-1", isTerminal: true },
			handlers: ALL_HANDLERS,
		});
		const labels = menuLabels();
		expect(labels).toContain("viewSubagentSession");
		expect(labels).not.toContain("detachToBackground");
		expect(labels).not.toContain("backgroundTasks.cancel");
	});

	test("invokes the bound handler with the child narrator id", async () => {
		const seen: string[] = [];
		await renderRow({
			toolMeta: { toolName: "Agent", subagentNarratorId: "sub-7" },
			handlers: { ...ALL_HANDLERS, onViewSubagentSession: (id) => seen.push(id) },
		});
		clickMenuItem("viewSubagentSession");
		expect(seen).toEqual(["sub-7"]);
		expect(closeSwipeMock).toHaveBeenCalled();
	});

	test("hides every command item when no handler is wired", async () => {
		await renderRow({ toolMeta: { toolName: "Agent", subagentNarratorId: "sub-1" } });
		const labels = menuLabels();
		expect(labels).not.toContain("viewSubagentSession");
		expect(labels).not.toContain("detachToBackground");
	});
});

describe("VListRowInteraction — tool card items", () => {
	test("offers view-session for a resolved Await-agent call", async () => {
		await renderRow({
			toolMeta: {
				toolName: "Await",
				awaitAgentTargetId: "t-1",
				awaitAgentNarratorId: "sub-2",
			},
			handlers: ALL_HANDLERS,
		});
		expect(menuLabels()).toContain("viewSubagentSession");
	});

	test("hides view-session for an unresolved Await-agent call", async () => {
		await renderRow({
			toolMeta: { toolName: "Await", awaitAgentTargetId: "t-1" },
			handlers: ALL_HANDLERS,
		});
		expect(menuLabels()).not.toContain("viewSubagentSession");
	});

	test("offers inspect only with both a narrator id and a tool use id", async () => {
		await renderRow({ toolMeta: { toolName: "Read" }, narratorId: "n1", toolUseId: "tu_1" });
		expect(menuLabels()).toContain("toolCallInspector.inspect");

		await renderRow({ toolMeta: { toolName: "Read" }, toolUseId: "tu_1" });
		expect(menuLabels()).not.toContain("toolCallInspector.inspect");

		await renderRow({ toolMeta: { toolName: "Read" }, narratorId: "n1" });
		expect(menuLabels()).not.toContain("toolCallInspector.inspect");
	});

	test("offers copy-file-path for any file tool, view-file only for Read", async () => {
		await renderRow({ toolMeta: { toolName: "Read", filePath: "/a/b.ts", isReadTool: true } });
		let labels = menuLabels();
		expect(labels).toContain("contextMenu_copyFilePath");
		expect(labels).toContain("contextMenu_viewFile");

		await renderRow({ toolMeta: { toolName: "Write", filePath: "/a/b.ts" } });
		labels = menuLabels();
		expect(labels).toContain("contextMenu_copyFilePath");
		expect(labels).not.toContain("contextMenu_viewFile");
	});

	test("copies the raw path on posix and a backslash path on windows", async () => {
		await renderRow({ toolMeta: { toolName: "Read", filePath: "/a/b/c.ts" } });
		clickMenuItem("contextMenu_copyFilePath");
		expect(clipboardCopyMock).toHaveBeenLastCalledWith("/a/b/c.ts");

		platformMock = "windows";
		await renderRow({ toolMeta: { toolName: "Read", filePath: "/a/b/c.ts" } });
		clickMenuItem("contextMenu_copyFilePath");
		expect(clipboardCopyMock).toHaveBeenLastCalledWith("\\a\\b\\c.ts");
	});

	test("renders no command items for a plain content row", async () => {
		await renderRow({ copyText: "hello" });
		const labels = menuLabels();
		expect(labels).toContain("copy");
		expect(labels).not.toContain("contextMenu_copyFilePath");
		expect(labels).not.toContain("toolCallInspector.inspect");
		expect(labels).not.toContain("viewSubagentSession");
	});
});
