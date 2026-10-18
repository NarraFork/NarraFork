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

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fileReferenceApi } from "@frontend/lib/api/file-references";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolCallDetailRef } from "../../../lib/api/narrators";
import {
	FileReferenceScopeProvider,
	type FileReferenceScopeValue,
} from "../composer/FileReferenceScope";
import { NarratorDockContext, type NarratorDockContextValue } from "../dock/NarratorDockContext";
import { useInternalFileViewer } from "../interaction/use-internal-file-viewer";
import type { NarratorMsg } from "../narrator-panel-types";
import { buildToolMetaIndex } from "./vlist-tool-meta";

const realMantineHooksModule = { ...(await import("@mantine/hooks")) };
const realSwipeMenuModule = { ...(await import("@frontend/hooks/useSwipeMenu")) };
const realReactI18nextModule = { ...(await import("react-i18next")) };
const realUsePlatformModule = { ...(await import("@frontend/hooks/usePlatform")) };
const realMessageSelectionModule = { ...(await import("../message/MessageSelectionCtx")) };
// Same cycle boundary as the service projection suite; use the actual history projection.
const realNarratorWsModule = { ...(await import("@server/websocket/narrator-ws")) };
mock.module("@server/websocket/narrator-ws", () => ({ broadcastToNarrator: () => {} }));
const { enrichToolUseBlocks, stripRedundantToolCallRows, stripProviderMetadata } = await import(
	"@server/services/narrator-messages"
);

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
}));
mock.module("@frontend/hooks/useClipboard", () => ({
	useClipboard: () => ({ copy: clipboardCopyMock, copied: false, reset: () => {}, error: null }),
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
	actualOffDock?: boolean;
	hideRow?: boolean;
	fileScope?: FileReferenceScopeValue;
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

function TestFileScope({ opts, children }: { opts: RenderOpts; children: ReactNode }) {
	const viewer = useInternalFileViewer({
		narratorId: opts.fileScope?.narratorId ?? opts.narratorId ?? "child",
		isWorkspacePreview: false,
		t: translateMock,
	});
	return (
		<FileReferenceScopeProvider
			value={
				opts.actualOffDock
					? { narratorId: opts.narratorId ?? "child", openFile: viewer.handleOpenReferencedFile }
					: (opts.fileScope ?? {})
			}
		>
			{children}
			{opts.actualOffDock && (
				<output data-offdock-path>{viewer.internalFileViewerPath ?? "closed"}</output>
			)}
		</FileReferenceScopeProvider>
	);
}

async function renderRow(opts: RenderOpts = {}) {
	const toolActions = opts.toolMeta
		? buildRowToolActions(opts.toolMeta, opts.handlers ?? {})
		: undefined;
	await act(async () => {
		root?.render(
			<MantineProvider>
				<NarratorDockContext.Provider value={opts.dock ?? null}>
					<TestFileScope opts={opts}>
						{!opts.hideRow && (
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
						)}
					</TestFileScope>
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
	mock.module("@server/websocket/narrator-ws", () => realNarratorWsModule);
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
		await renderRow({
			toolMeta: {
				toolName: "Read",
				filePath: "/a/b.ts",
				isReadTool: true,
				fileTarget: { deviceId: "local", path: "/a/b.ts" },
				fileNarratorId: "reader",
			},
			dock: { openFilePanel: () => {} } as unknown as NarratorDockContextValue,
		});
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
describe("Read execution target — real row menu", () => {
	const cwd = "/home/ysc/projects/ops-service/.worktrees/logs-lod-redesign";
	const relative = "frontend/.test-build/logs-browser/tree-desktop.png";
	const cases = [
		{ path: `${cwd}/${relative}`, cwd, expected: `${cwd}/${relative}`, deviceId: "local" },
		{ path: relative, cwd, expected: `${cwd}/${relative}`, deviceId: "LinuxRemote" },
		{
			path: "文档/空 格.txt",
			cwd: "D:\\项目\\worktree",
			expected: "D:/项目/worktree/文档/空 格.txt",
			deviceId: "WindowsRemote",
		},
	];
	for (const item of cases) {
		test(`opens captured ${item.deviceId} image/text target as child, never host cwd`, async () => {
			const target = { deviceId: item.deviceId, path: item.expected };
			const resolve = spyOn(fileReferenceApi, "resolve").mockResolvedValue({ targets: [target] });
			try {
				const onOpenFileTarget = mock((..._args: unknown[]) => {});
				const legacyOpen = mock((_path: string) => {});
				const message = {
					id: "read-message",
					narratorId: "actual-child",
					contentJson: [
						{
							type: "tool_use",
							name: "Read",
							id: "read-1",
							input: { file_path: item.path, device: "wrong-current-default" },
						},
					],
					toolCalls: [
						{
							toolUseId: "read-1",
							toolName: "Read",
							inputJson: { file_path: item.path },
							status: "success",
							executionDeviceId: item.deviceId,
							executionCwd: item.cwd,
						},
					],
				} as unknown as NarratorMsg;
				const [historyDto] = JSON.parse(
					JSON.stringify(stripRedundantToolCallRows(enrichToolUseBlocks([message]))),
				);
				expect(historyDto.toolCalls).toEqual([]);
				await renderRow({
					narratorId: "host-after-cwd-change",
					toolUseId: "read-1",
					toolMeta: buildToolMetaIndex([historyDto]).get("read-1"),
					handlers: { onOpenFilePanel: legacyOpen },
					dock: {
						narratorId: "host-after-device-change",
						openFilePanel: onOpenFileTarget,
					} as unknown as NarratorDockContextValue,
				});
				await act(async () => clickMenuItem("contextMenu_openFilePanel"));
				expect(resolve).toHaveBeenCalledWith("actual-child", [target], expect.any(AbortSignal));
				expect(onOpenFileTarget).toHaveBeenCalledWith(
					item.expected,
					undefined,
					expect.objectContaining({
						deviceId: item.deviceId,
						fileNarratorId: "actual-child",
						referenceOrigin: true,
					}),
				);
				expect(legacyOpen).not.toHaveBeenCalled();
			} finally {
				resolve.mockRestore();
			}
		});
	}

	test("reload history DTO after real server enrichment/stripping opens the selected Read retry as its child", async () => {
		const target = { deviceId: "history-remote", path: `${cwd}/${relative}` };
		const resolve = spyOn(fileReferenceApi, "resolve").mockResolvedValue({ targets: [target] });
		try {
			const onOpenFileTarget = mock((..._args: unknown[]) => {});
			const [dto] = JSON.parse(
				JSON.stringify(
					stripProviderMetadata(
						stripRedundantToolCallRows(
							enrichToolUseBlocks([
								{
									id: "history",
									narratorId: "actual-history-child",
									children: [],
									contentJson: [
										{
											type: "tool_use",
											name: "Read",
											id: "history-read",
											input: { file_path: "old.txt" },
											executionAttempt: 1,
											tcId: "old",
											executionDeviceId: "stale",
											executionCwd: "/stale",
											resolvedFilePath: "/stale/old.txt",
											executionTarget: { deviceId: "stale", cwd: "/stale" },
										},
									],
									toolCalls: [
										{
											id: "retry",
											toolUseId: "history-read",
											toolName: "Read",
											status: "success",
											executionAttempt: 2,
											inputJson: { file_path: relative },
											executionDeviceId: target.deviceId,
											executionCwd: cwd,
											executionTarget: { deviceId: target.deviceId, cwd },
										},
										{
											id: "old",
											toolUseId: "history-read",
											toolName: "Read",
											status: "error",
											executionAttempt: 1,
											inputJson: { file_path: "old.txt" },
											executionDeviceId: "old-device",
											executionCwd: "/old",
										},
									],
								},
							]),
						),
					),
				),
			);
			expect(dto.toolCalls).toEqual([]);
			await renderRow({
				narratorId: "current-host",
				toolMeta: buildToolMetaIndex([dto]).get("history-read"),
				dock: {
					narratorId: "current-host",
					openFilePanel: onOpenFileTarget,
				} as unknown as NarratorDockContextValue,
			});
			await act(async () => clickMenuItem("contextMenu_openFilePanel"));
			expect(resolve).toHaveBeenCalledWith(
				"actual-history-child",
				[target],
				expect.any(AbortSignal),
			);
			expect(onOpenFileTarget).toHaveBeenCalledWith(
				target.path,
				undefined,
				expect.objectContaining({
					deviceId: target.deviceId,
					fileNarratorId: "actual-history-child",
					referenceOrigin: true,
				}),
			);
		} finally {
			resolve.mockRestore();
		}
	});

	test("later cwd/default-device changes cannot rebind an existing Read menu", async () => {
		const target = { deviceId: "original-remote", path: `${cwd}/${relative}` };
		const resolve = spyOn(fileReferenceApi, "resolve").mockResolvedValue({ targets: [target] });
		try {
			const onOpenFileTarget = mock((..._args: unknown[]) => {});
			const options: RenderOpts = {
				narratorId: "child",
				toolMeta: {
					toolName: "Read",
					filePath: relative,
					isFileTool: true,
					isReadTool: true,
					fileTarget: target,
					fileNarratorId: "child",
				},
				dock: { openFilePanel: onOpenFileTarget } as unknown as NarratorDockContextValue,
			};
			await renderRow({
				...options,
				fileScope: { narratorId: "child", context: { deviceId: target.deviceId, cwd } },
			});
			await renderRow({
				...options,
				fileScope: { narratorId: "child", context: { deviceId: "local", cwd: "/home/ysc/桌面" } },
			});
			await act(async () => clickMenuItem("contextMenu_openFilePanel"));
			expect(resolve).toHaveBeenCalledWith("child", [target], expect.any(AbortSignal));
			expect(onOpenFileTarget).toHaveBeenCalledWith(
				target.path,
				undefined,
				expect.objectContaining({
					deviceId: target.deviceId,
					fileNarratorId: "child",
					referenceOrigin: true,
				}),
			);
		} finally {
			resolve.mockRestore();
		}
	});

	test("off-dock opens through the existing target capability only for the actual source narrator", async () => {
		const target = { deviceId: "Remote", path: "/original/read.txt" };
		const onOpenFileTarget = mock((_target: typeof target) => {});
		const options: RenderOpts = {
			narratorId: "child",
			toolMeta: {
				toolName: "Read",
				filePath: "read.txt",
				isFileTool: true,
				isReadTool: true,
				fileTarget: target,
				fileNarratorId: "child",
			},
		};
		await renderRow({
			...options,
			fileScope: {
				narratorId: "child",
				openFile: onOpenFileTarget,
				context: { deviceId: "today", cwd: "/today" },
			},
		});
		await act(async () => clickMenuItem("contextMenu_openFilePanel"));
		expect(onOpenFileTarget).toHaveBeenCalledWith(
			target,
			expect.objectContaining({ signal: expect.any(AbortSignal), isCurrent: expect.any(Function) }),
		);
		onOpenFileTarget.mockClear();
		await renderRow({ ...options, fileScope: { narratorId: "host", openFile: onOpenFileTarget } });
		expect(menuLabels()).not.toContain("contextMenu_openFilePanel");
		expect(onOpenFileTarget).not.toHaveBeenCalled();
	});

	test("denied resolution cannot open the panel or fall back to the legacy path", async () => {
		const target = { deviceId: "Remote", path: "/private/.env" };
		const resolve = spyOn(fileReferenceApi, "resolve").mockRejectedValue(new Error("Forbidden"));
		const notify = spyOn(notifications, "show").mockReturnValue("denied");
		try {
			const onOpenFileTarget = mock((..._args: unknown[]) => {});
			const legacyOpen = mock((_path: string) => {});
			await renderRow({
				narratorId: "host",
				toolMeta: {
					toolName: "Read",
					filePath: target.path,
					fileTarget: target,
					fileNarratorId: "child",
					isFileTool: true,
					isReadTool: true,
				},
				handlers: { onOpenFilePanel: legacyOpen },
				dock: { openFilePanel: onOpenFileTarget } as unknown as NarratorDockContextValue,
			});
			await act(async () => clickMenuItem("contextMenu_openFilePanel"));
			expect(resolve).toHaveBeenCalledWith("child", [target], expect.any(AbortSignal));
			expect(onOpenFileTarget).not.toHaveBeenCalled();
			expect(legacyOpen).not.toHaveBeenCalled();
			expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: "Forbidden" }));
		} finally {
			resolve.mockRestore();
			notify.mockRestore();
		}
	});

	test("UNC input remains copyable but is never joined to a current local directory", async () => {
		const path = "\\\\server\\share\\中文 空格.png";
		const message = {
			id: "m",
			narratorId: "child",
			contentJson: [
				{
					type: "tool_use",
					name: "Read",
					id: "unc",
					input: { file_path: path },
					executionDeviceId: "WindowsRemote",
					executionCwd: "C:/original",
				},
			],
		} as unknown as NarratorMsg;
		await renderRow({
			narratorId: "host",
			toolMeta: buildToolMetaIndex([message]).get("unc"),
			handlers: {
				onOpenFilePanel: () => {
					throw new Error("unsafe fallback");
				},
			},
		});
		expect(menuLabels()).not.toContain("contextMenu_openFilePanel");
		expect(menuLabels()).toContain("fileReferences.missingContext");
		clickMenuItem("contextMenu_copyFilePath");
		expect(clipboardCopyMock).toHaveBeenCalledWith(path);
	});

	test("unknown historical execution identity never inherits current host defaults", async () => {
		const legacyOpen = mock((_path: string) => {});
		await renderRow({
			narratorId: "today",
			toolMeta: { toolName: "Read", filePath: relative, isFileTool: true, isReadTool: true },
			handlers: { onOpenFilePanel: legacyOpen },
		});
		expect(menuLabels()).not.toContain("contextMenu_openFilePanel");
		expect(menuLabels()).not.toContain("contextMenu_viewFile");
		expect(menuLabels()).toContain("fileReferences.missingContext");
		expect(legacyOpen).not.toHaveBeenCalled();
	});
});

describe("Read pending navigation lifetime", () => {
	const target = { deviceId: "Remote", path: "/original/read.txt" };
	const toolMeta: VListToolMeta = {
		toolName: "Read",
		isReadTool: true,
		isFileTool: true,
		filePath: "read.txt",
		fileTarget: target,
		fileNarratorId: "child",
	};
	function deferred() {
		let accept!: (value: { targets: (typeof target)[] }) => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<{ targets: (typeof target)[] }>((resolve, fail) => {
			accept = resolve;
			reject = fail;
		});
		return { promise, accept, reject };
	}
	for (const kind of [
		"host",
		"opener",
		"surface",
		"capability-revoke",
		"target",
		"source",
		"row-unmount",
	] as const) {
		test(`cancels pending dock Read when ${kind} changes`, async () => {
			const pending = deferred();
			const resolve = spyOn(fileReferenceApi, "resolve").mockReturnValue(pending.promise);
			try {
				const oldOpen = mock((..._args: unknown[]) => {});
				const newOpen = mock((..._args: unknown[]) => {});
				const surface = { current: {} };
				const opts: RenderOpts = {
					narratorId: "child",
					toolMeta,
					dock: {
						...(kind === "opener" ? {} : { narratorId: "host-A" }),
						...(kind === "surface" ? { apiRef: surface } : {}),
						openFilePanel: oldOpen,
					} as unknown as NarratorDockContextValue,
				};
				await renderRow(opts);
				await act(async () => clickMenuItem("contextMenu_openFilePanel"));
				const signal = resolve.mock.calls[0]?.[2];
				if (kind === "surface") surface.current = {};
				await renderRow({
					...opts,
					...(kind === "capability-revoke"
						? { dock: { narratorId: "host-A" } as unknown as NarratorDockContextValue }
						: {}),
					...(kind === "host"
						? {
								dock: {
									narratorId: "host-B",
									openFilePanel: newOpen,
								} as unknown as NarratorDockContextValue,
							}
						: {}),
					...(kind === "opener"
						? { dock: { openFilePanel: newOpen } as unknown as NarratorDockContextValue }
						: {}),
					...(kind === "target"
						? { toolMeta: { ...toolMeta, fileTarget: { ...target, path: "/new.txt" } } }
						: {}),
					...(kind === "source"
						? { toolMeta: { ...toolMeta, fileNarratorId: "other-child" } }
						: {}),
					...(kind === "row-unmount" ? { hideRow: true } : {}),
				});
				await act(async () => {
					pending.accept({ targets: [target] });
				});
				expect(signal?.aborted).toBe(true);
				expect(oldOpen).not.toHaveBeenCalled();
				expect(newOpen).not.toHaveBeenCalled();
			} finally {
				resolve.mockRestore();
			}
		});
	}
	test("an imperative receiving surface replacement cannot publish into the new host without a row rerender", async () => {
		const pending = deferred();
		const resolve = spyOn(fileReferenceApi, "resolve").mockReturnValue(pending.promise);
		try {
			const open = mock((..._args: unknown[]) => {});
			const apiRef = { current: {} };
			await renderRow({
				narratorId: "child",
				toolMeta,
				dock: {
					narratorId: "host",
					apiRef,
					openFilePanel: open,
				} as unknown as NarratorDockContextValue,
			});
			await act(async () => clickMenuItem("contextMenu_openFilePanel"));
			const signal = resolve.mock.calls[0]?.[2];
			apiRef.current = {};
			await act(async () => {
				pending.accept({ targets: [target] });
			});
			expect(signal?.aborted).toBe(true);
			expect(open).not.toHaveBeenCalled();
		} finally {
			resolve.mockRestore();
		}
	});
	test("same-host callback reconstruction keeps the request and opens only through the latest callback", async () => {
		const pending = deferred();
		const resolve = spyOn(fileReferenceApi, "resolve").mockReturnValue(pending.promise);
		try {
			const oldOpen = mock((..._args: unknown[]) => {});
			const newOpen = mock((..._args: unknown[]) => {});
			await renderRow({
				narratorId: "child",
				toolMeta,
				dock: {
					narratorId: "same-host",
					openFilePanel: oldOpen,
				} as unknown as NarratorDockContextValue,
			});
			await act(async () => clickMenuItem("contextMenu_openFilePanel"));
			const signal = resolve.mock.calls[0]?.[2];
			await renderRow({
				narratorId: "child",
				toolMeta: { ...toolMeta, fileTarget: { ...target } },
				dock: {
					narratorId: "same-host",
					openFilePanel: newOpen,
				} as unknown as NarratorDockContextValue,
			});
			await act(async () => {
				pending.accept({ targets: [target] });
			});
			expect(signal?.aborted).toBe(false);
			expect(oldOpen).not.toHaveBeenCalled();
			expect(newOpen).toHaveBeenCalledTimes(1);
		} finally {
			resolve.mockRestore();
		}
	});
	test("normal off-dock rerender and equivalent target reconstruction preserve pending navigation", async () => {
		const pending = deferred();
		const resolve = spyOn(fileReferenceApi, "resolve").mockReturnValue(pending.promise);
		try {
			const opts: RenderOpts = { narratorId: "child", toolMeta, actualOffDock: true };
			await renderRow(opts);
			await act(async () => clickMenuItem("contextMenu_openFilePanel"));
			const signal = resolve.mock.calls[0]?.[2];
			await renderRow({ ...opts, toolMeta: { ...toolMeta, fileTarget: { ...target } } });
			await act(async () => {
				pending.accept({ targets: [target] });
			});
			expect(signal?.aborted).toBe(false);
			expect(document.querySelector("[data-offdock-path]")?.textContent).toBe(target.path);
		} finally {
			resolve.mockRestore();
		}
	});
	test("unmounting an off-dock row cancels the real drawer opener before its late resolve", async () => {
		const pending = deferred();
		const resolve = spyOn(fileReferenceApi, "resolve").mockReturnValue(pending.promise);
		try {
			const opts: RenderOpts = { narratorId: "child", toolMeta, actualOffDock: true };
			await renderRow(opts);
			await act(async () => clickMenuItem("contextMenu_openFilePanel"));
			const signal = resolve.mock.calls[0]?.[2];
			await renderRow({ ...opts, hideRow: true });
			await act(async () => {
				pending.accept({ targets: [target] });
			});
			expect(signal?.aborted).toBe(true);
			expect(document.querySelector("[data-offdock-path]")?.textContent).toBe("closed");
		} finally {
			resolve.mockRestore();
		}
	});
	for (const changed of ["target", "source"] as const) {
		test(`off-dock ${changed} replacement cancels the initiating row before drawer publication`, async () => {
			const pending = deferred();
			const resolve = spyOn(fileReferenceApi, "resolve").mockReturnValue(pending.promise);
			try {
				const opts: RenderOpts = { narratorId: "child", toolMeta, actualOffDock: true };
				await renderRow(opts);
				await act(async () => clickMenuItem("contextMenu_openFilePanel"));
				const signal = resolve.mock.calls[0]?.[2];
				await renderRow({
					...opts,
					toolMeta: {
						...toolMeta,
						...(changed === "target"
							? { fileTarget: { ...target, path: "/other.txt" } }
							: { fileNarratorId: "other-child" }),
					},
				});
				await act(async () => {
					pending.accept({ targets: [target] });
				});
				expect(signal?.aborted).toBe(true);
				expect(document.querySelector("[data-offdock-path]")?.textContent).toBe("closed");
			} finally {
				resolve.mockRestore();
			}
		});
	}
	for (const actualOffDock of [false, true]) {
		test(`late errors never overwrite a newer request (off-dock=${actualOffDock})`, async () => {
			const pending = deferred();
			const resolve = spyOn(fileReferenceApi, "resolve")
				.mockReturnValueOnce(pending.promise)
				.mockImplementation(async (_narrator, targets) => ({ targets }));
			const notify = spyOn(notifications, "show").mockReturnValue("notification");
			try {
				const open = mock((..._args: unknown[]) => {});
				const opts: RenderOpts = {
					narratorId: "child",
					toolMeta,
					actualOffDock,
					...(!actualOffDock
						? {
								dock: {
									narratorId: "host",
									openFilePanel: open,
								} as unknown as NarratorDockContextValue,
							}
						: {}),
				};
				await renderRow(opts);
				await act(async () => clickMenuItem("contextMenu_openFilePanel"));
				await act(async () => clickMenuItem("contextMenu_openFilePanel"));
				await act(async () => {
					pending.reject(new Error("stale denied"));
				});
				expect(notify).not.toHaveBeenCalled();
				if (actualOffDock)
					expect(document.querySelector("[data-offdock-path]")?.textContent).toBe(target.path);
				else expect(open).toHaveBeenCalledTimes(1);
			} finally {
				resolve.mockRestore();
				notify.mockRestore();
			}
		});
	}
});

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
