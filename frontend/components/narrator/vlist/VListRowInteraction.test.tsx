/**
 * VListRowInteraction.test.tsx — DOM tests for the vlist row menu.
 *
 * Focus: the CARD-SPECIFIC command items this layer adds on top of the shared
 * message menu (open child session, detach to background, cancel background
 * task, inspect tool call, copy file path, view file) — that each appears only
 * under the same conditions the chunked ToolCallCard / SubagentCard use, and
 * that clicking one invokes the bound action.
 *
 * The swipe hook exposes controllable menu/closing state; existing action tests
 * start with the context menu open. Media queries use the real installed hook,
 * and i18n records menu construction while returning label-stable raw keys.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolCallDetailRef } from "../../../lib/api/narrators";
import { NarratorDockContext, type NarratorDockContextValue } from "../dock/NarratorDockContext";

const realMantineHooksModule = { ...(await import("@mantine/hooks")) };
const realSwipeMenuModule = { ...(await import("@frontend/hooks/useSwipeMenu")) };
const realReactI18nextModule = { ...(await import("react-i18next")) };
const realUsePlatformModule = { ...(await import("@frontend/hooks/usePlatform")) };
const realMessageSelectionModule = { ...(await import("../message/MessageSelectionCtx")) };

const closeSwipeMock = mock(() => {});
const clipboardCopyMock = mock((_value: string) => {});
let platformMock: "windows" | "macos" | "linux" = "linux";
let ctxMenuOpened = true;
let swipeOffset = 0;
let swipeClosing = false;
let mobileMatches = false;
const translateMock = mock((key: string) => key);
const mediaQueryValues: boolean[] = [];
const mediaQueryListeners = new Set<(event: MediaQueryListEvent) => void>();
const globalDescriptors = new Map<string, PropertyDescriptor | undefined>();

mock.module("@frontend/hooks/useSwipeMenu", () => ({
	useSwipeMenu: () => ({
		swipeBoxRef: { current: null },
		swipeMenuRef: { current: null },
		swipeOffset,
		swipeRevealed: swipeOffset > 0,
		swipeClosing,
		closeSwipe: closeSwipeMock,
		ctxMenuOpened,
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
	...realMantineHooksModule,
	useMediaQuery: (...args: Parameters<typeof realMantineHooksModule.useMediaQuery>) => {
		const matches = realMantineHooksModule.useMediaQuery(...args);
		if (args[0] === MOBILE_VIEWPORT_MEDIA_QUERY) mediaQueryValues.push(matches);
		return matches;
	},
	useClipboard: () => ({ copy: clipboardCopyMock, copied: false, reset: () => {} }),
	useDisclosure: (initial = false) => [
		initial,
		{ open: () => {}, close: () => {}, toggle: () => {} },
	],
}));
mock.module("react-i18next", () => ({
	useTranslation: () => ({ t: translateMock }),
}));
mock.module("../CompactMenuSub", () => ({ CompactMenuSub: () => null }));
mock.module("../message/MessageSelectionCtx", () => ({
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
		matches: query === MOBILE_VIEWPORT_MEDIA_QUERY ? mobileMatches : false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener(type: string, listener: (event: MediaQueryListEvent) => void) {
			if (query === MOBILE_VIEWPORT_MEDIA_QUERY && type === "change") {
				mediaQueryListeners.add(listener);
			}
		},
		removeEventListener(type: string, listener: (event: MediaQueryListEvent) => void) {
			if (query === MOBILE_VIEWPORT_MEDIA_QUERY && type === "change") {
				mediaQueryListeners.delete(listener);
			}
		},
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
		globalDescriptors.set(key, descriptor);
		if (descriptor && !descriptor.configurable) {
			if ("writable" in descriptor && descriptor.writable) Reflect.set(globalThis, key, value);
			continue;
		}
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}

interface RenderOpts {
	dock?: NarratorDockContextValue;
	toolDetailRef?: ToolCallDetailRef & { toolUseId?: string };
	toolMeta?: VListToolMeta;
	handlers?: VListRowHandlers;
	narratorId?: string;
	toolUseId?: string;
	copyText?: string;
	/** Message-level menu actions (default: id only, no items). */
	actions?: import("../message/MessageContextMenuCtx").MessageContextMenuActions;
	onViewOriginal?: () => void;
	onOpenFullscreen?: () => void;
}

async function renderRow(opts: RenderOpts = {}) {
	const toolActions = opts.toolMeta
		? buildRowToolActions(opts.toolMeta, opts.handlers ?? {})
		: undefined;
	await act(async () => {
		root?.render(
			<MantineProvider>
				<NarratorDockContext.Provider value={opts.dock ?? null}>
					<VListRowInteraction
						blockId="sa-tu_1"
						messageId="m1"
						blockIndex={0}
						copyText={opts.copyText}
						actions={opts.actions ?? { messageId: "m1" }}
						narratorId={opts.narratorId}
						toolUseId={opts.toolUseId}
						toolDetailRef={opts.toolDetailRef}
						toolMeta={opts.toolMeta}
						toolActions={toolActions}
						onViewOriginal={opts.onViewOriginal}
						onOpenFullscreen={opts.onOpenFullscreen}
					>
						<div>row body</div>
					</VListRowInteraction>
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
	ctxMenuOpened = true;
	swipeOffset = 0;
	swipeClosing = false;
	mobileMatches = false;
	mediaQueryValues.length = 0;
	translateMock.mockClear();
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
	expect(mediaQueryListeners.size).toBe(0);
	for (const [key, descriptor] of globalDescriptors) {
		if (!descriptor) Reflect.deleteProperty(globalThis, key);
		else if (!descriptor.configurable && "writable" in descriptor && descriptor.writable) {
			Reflect.set(globalThis, key, descriptor.value);
		} else Object.defineProperty(globalThis, key, descriptor);
	}
	globalDescriptors.clear();
});

afterAll(() => {
	mock.module("@mantine/hooks", () => realMantineHooksModule);
	mock.module("@frontend/hooks/useSwipeMenu", () => realSwipeMenuModule);
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.module("@frontend/hooks/usePlatform", () => realUsePlatformModule);
	mock.module("../message/MessageSelectionCtx", () => realMessageSelectionModule);
	mock.restore();
});

describe("VListRowInteraction — idle mounting cost", () => {
	test("does not construct menu content while both menus are closed", async () => {
		ctxMenuOpened = false;
		await renderRow({
			copyText: "copy body",
			onOpenFullscreen: () => {},
			onViewOriginal: () => {},
			actions: { messageId: "m1", onEditMessage: () => {}, onDeleteBlock: () => {} },
			toolMeta: { toolName: "Read", filePath: "/a.ts", isReadTool: true },
			narratorId: "n1",
			toolUseId: "tu_1",
		});
		expect(container?.textContent).toContain("row body");
		expect(menuLabels()).toEqual([]);
		// Unlike checking absent DOM alone, this catches eager creation of the
		// discarded menu JSX: every available menu item resolves its label.
		expect(translateMock).not.toHaveBeenCalled();
	});

	test("opens with current actions after closed-row updates, without swipe-only cancel", async () => {
		ctxMenuOpened = false;
		const oldEdit = mock(() => {});
		const newEdit = mock(() => {});
		await renderRow({ actions: { messageId: "m1", onEditMessage: oldEdit } });
		await renderRow({ actions: { messageId: "m1", onEditMessage: newEdit } });
		expect(translateMock).not.toHaveBeenCalled();
		ctxMenuOpened = true;
		await renderRow({ actions: { messageId: "m1", onEditMessage: newEdit } });
		expect(menuLabels()).toContain("contextMenu_edit");
		expect(menuLabels()).not.toContain("cancel");
		expect(translateMock.mock.calls.map(([key]) => key)).not.toContain("cancel");
		clickMenuItem("contextMenu_edit");
		expect(newEdit).toHaveBeenCalledTimes(1);
		expect(oldEdit).not.toHaveBeenCalled();
	});

	test("retains swipe items during closing, then stops building them", async () => {
		ctxMenuOpened = false;
		swipeOffset = 180;
		const onOpenFullscreen = mock(() => {});
		const opts = { copyText: "body", onOpenFullscreen };
		await renderRow(opts);
		expect(menuLabels()).toContain("fullscreen");
		expect(menuLabels()).toContain("copy");
		expect(menuLabels()).toContain("cancel");
		clickMenuItem("fullscreen");
		expect(onOpenFullscreen).toHaveBeenCalledTimes(1);
		swipeOffset = 0;
		swipeClosing = true;
		await renderRow(opts);
		expect(menuLabels()).toContain("fullscreen");
		expect(menuLabels()).toContain("cancel");
		swipeClosing = false;
		translateMock.mockClear();
		await renderRow(opts);
		expect(menuLabels()).toEqual([]);
		expect(translateMock).not.toHaveBeenCalled();
	});

	test.each([
		false,
		true,
	])("keeps the real deferred media query initialization (%s)", async (mobile) => {
		ctxMenuOpened = false;
		mobileMatches = mobile;
		await renderRow({ copyText: "body" });
		expect(mediaQueryValues).toEqual([false, mobile]);
		expect(mediaQueryListeners.size).toBe(1);
	});

	test("keeps subscribing to desktop/mobile breakpoint changes", async () => {
		ctxMenuOpened = false;
		await renderRow();
		expect(mediaQueryValues).toEqual([false, false]);
		for (const matches of [true, false]) {
			await act(async () => {
				mobileMatches = matches;
				for (const listener of mediaQueryListeners) {
					listener({ matches, media: MOBILE_VIEWPORT_MEDIA_QUERY } as MediaQueryListEvent);
				}
			});
		}
		expect(mediaQueryValues).toEqual([false, false, true, false]);
		expect(mediaQueryListeners.size).toBe(1);
		expect(translateMock).not.toHaveBeenCalled();
	});
});
test("Edit right-click prefers the persisted tool ref over the render id and current-file action", async () => {
	const openFilePanel = mock((..._args: unknown[]) => {});
	const legacyOpen = mock((_path: string) => {});
	const ref = {
		toolUseId: "actual-sdk",
		toolCallId: "actual-pk",
		messageId: "actual-message",
		executionAttempt: 2,
	};
	await renderRow({
		narratorId: "row-reader",
		toolUseId: "render-only-index",
		toolDetailRef: ref,
		toolMeta: { toolName: "Edit", filePath: "/work/a.ts", isFileTool: true },
		handlers: { onOpenFilePanel: legacyOpen },
		dock: { narratorId: "different-host", openFilePanel } as unknown as NarratorDockContextValue,
	});
	expect(menuLabels()).toContain("editPreview.open");
	clickMenuItem("editPreview.open");
	expect(openFilePanel).toHaveBeenCalledWith("/work/a.ts", undefined, {
		toolEdit: { ...ref, narratorId: "row-reader" },
	});
	expect(legacyOpen).not.toHaveBeenCalled();
});

describe("VListRowInteraction — Bash detachment", () => {
	test("offers detach and dispatches the Bash tool id, not the subagent handler", async () => {
		const detach = mock((_id: string) => {});
		const agent = mock((_id: string) => {});
		await renderRow({
			toolMeta: { toolName: "Bash", toolUseId: "bash-1", isRunningBash: true },
			handlers: { onDetachBash: detach, onDetachSubagent: agent },
		});
		expect(menuLabels()).toContain("detachToBackground");
		clickMenuItem("detachToBackground");
		expect(detach).toHaveBeenCalledWith("bash-1");
		expect(agent).not.toHaveBeenCalled();
	});
	test("hides detach when Bash is not running or the handler is absent", async () => {
		await renderRow({
			toolMeta: { toolName: "Bash", toolUseId: "bash-1" },
			handlers: { onDetachBash: () => {} },
		});
		expect(menuLabels()).not.toContain("detachToBackground");
		await renderRow({ toolMeta: { toolName: "Bash", toolUseId: "bash-1", isRunningBash: true } });
		expect(menuLabels()).not.toContain("detachToBackground");
	});
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

describe("VListRowInteraction — edit message item", () => {
	test("offers the edit item and invokes the ctx action", async () => {
		let edited = 0;
		await renderRow({
			actions: { messageId: "m1", onEditMessage: () => edited++ },
		});
		expect(menuLabels()).toContain("contextMenu_edit");
		clickMenuItem("contextMenu_edit");
		expect(edited).toBe(1);
		expect(closeSwipeMock).toHaveBeenCalled();
	});

	test("hides the edit item when the row carries no edit action", async () => {
		await renderRow();
		expect(menuLabels()).not.toContain("contextMenu_edit");
	});
});

describe("VListRowInteraction — view original item", () => {
	test("offers view-original and invokes the shell callback without mounting a modal", async () => {
		let viewed = 0;
		await renderRow({ onViewOriginal: () => viewed++ });
		expect(menuLabels()).toContain("viewOriginal");
		clickMenuItem("viewOriginal");
		expect(viewed).toBe(1);
		expect(closeSwipeMock).toHaveBeenCalled();
		// The modal is a single shell-level instance; this layer must not render one.
		expect(document.querySelectorAll(".mantine-Modal-content").length).toBe(0);
	});

	test("hides view-original when the message was never edited", async () => {
		await renderRow();
		expect(menuLabels()).not.toContain("viewOriginal");
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

/**
 * The row menu's single viewer entry. Wrap / source deliberately stay OFF this
 * menu: a row can host several readable bodies (a tool card has command +
 * output) and one item cannot say which — those controls live on each body's own
 * hover action bar, where the target is unambiguous.
 */
describe("VListRowInteraction — fullscreen viewer", () => {
	test("offers fullscreen only when the row has a readable body", async () => {
		await renderRow({ copyText: "hello" });
		expect(menuLabels()).not.toContain("fullscreen");

		await renderRow({ copyText: "hello", onOpenFullscreen: () => {} });
		expect(menuLabels()).toContain("fullscreen");
	});

	test("clicking it opens the shell's viewer and closes the menu", async () => {
		const onOpenFullscreen = mock(() => {});
		await renderRow({ copyText: "hello", onOpenFullscreen });
		clickMenuItem("fullscreen");
		expect(onOpenFullscreen).toHaveBeenCalledTimes(1);
		expect(closeSwipeMock).toHaveBeenCalled();
	});

	test("leads the menu, ahead of copy", async () => {
		await renderRow({ copyText: "hello", onOpenFullscreen: () => {} });
		const labels = menuLabels();
		expect(labels.indexOf("fullscreen")).toBeLessThan(labels.indexOf("copy"));
	});

	test("carries no wrap / source items (those belong to each body's bar)", async () => {
		await renderRow({ copyText: "hello", onOpenFullscreen: () => {} });
		const labels = menuLabels();
		expect(labels).not.toContain("wordWrap");
		expect(labels).not.toContain("noWrap");
		expect(labels).not.toContain("source");
		expect(labels).not.toContain("rendered");
	});
});
