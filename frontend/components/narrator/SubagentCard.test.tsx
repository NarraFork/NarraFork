import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import type React from "react";
import { act, createContext } from "react";
import { createRoot, type Root } from "react-dom/client";

const realReactI18nextModule = { ...(await import("react-i18next")) };
const realUsePlatformModule = { ...(await import("../../hooks/usePlatform")) };
const realMessageSelectionModule = { ...(await import("./MessageSelectionCtx")) };
// Bun's mock.module is process-wide and mock.restore() does NOT undo it, so every module
// replaced below has to be re-pointed at the real namespace in afterAll. Snapshot them here:
// a partial stub that outlives this file makes any LATER test file that imports a symbol the
// stub omits fail with "Export named '…' not found".
const realUseNarratorModule = { ...(await import("../../hooks/useNarrator")) };
const realToolCallCardModule = { ...(await import("./ToolCallCard")) };
const realRouterModule = { ...(await import("@tanstack/react-router")) };
const realContentViewerModule = { ...(await import("./ContentViewer")) };
const realLazyCollapseModule = { ...(await import("./LazyCollapse")) };
const realSwipeMenuModule = { ...(await import("../../hooks/useSwipeMenu")) };
const realMessageContextMenuModule = { ...(await import("./MessageContextMenuCtx")) };
const realCompactMenuSubModule = { ...(await import("./CompactMenuSub")) };

const navigateMock = mock(() => {});
const handleContextMenuMock = mock(() => {});
let narratorDataMock: {
	status?: string;
	substatus?: string | string[];
	model?: string | null;
	reasoningEffort?: string | null;
} = { status: "working", substatus: [] };
let swipeOffsetMock = 0;
mock.module("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
	useSearch: () => ({}),
}));
mock.module("../../hooks/useNarrator", () => ({
	useAskInPassing: () => ({ isPending: false }),
	useCancelAskInPassing: () => ({ isPending: false }),
	useNarrator: () => ({ data: narratorDataMock }),
	useToolCallDetail: () => ({ data: undefined }),
}));
mock.module("../../hooks/usePlatform", () => ({
	...realUsePlatformModule,
	useNarratorSubagentsCapability: () => ({
		supported: true,
		detachAttach: true,
		background: true,
		staleRecovery: true,
	}),
}));
mock.module("../../hooks/useSwipeMenu", () => ({
	useSwipeMenu: () => ({
		swipeBoxRef: { current: null },
		swipeMenuRef: { current: null },
		swipeOffset: swipeOffsetMock,
		swipeRevealed: false,
		swipeClosing: false,
		closeSwipe: () => {},
		ctxMenuOpened: false,
		setCtxMenuOpened: () => {},
		ctxMenuPos: { x: 0, y: 0, flipY: false },
		setCtxMenuPos: () => {},
		handleContextMenu: handleContextMenuMock,
		swipeStyle: {},
		swipeTransition: "",
		swipeMenuTransition: "",
		getSwipeMenuPosition: () => ({ left: 0, top: 0 }),
	}),
}));
mock.module("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: { count?: number }) =>
			key === "subagentWaitingPermission" ? `Waiting (${values?.count ?? 0})` : key,
	}),
}));
mock.module("./ContentViewer", () => ({
	ContentViewer: ({ content }: { content: string }) => <div>{content}</div>,
}));
mock.module("./LazyCollapse", () => ({
	LazyCollapse: ({ in: opened, children }: { in: boolean; children: React.ReactNode }) =>
		opened ? children : null,
}));
mock.module("./CompactMenuSub", () => ({ CompactMenuSub: () => null }));
mock.module("./ToolCallCard", () => ({
	STATUS_COLORS: {},
	StatusIcon: ({ status }: { status: string }) => <span>{status}</span>,
	ToolTimingArea: () => null,
	InlinePermission: ({ permission }: { permission: { id: string } }) => (
		<div data-testid="outer-permission">{permission.id}</div>
	),
	ToolCallCard: ({ pendingPermission }: { pendingPermission?: { id: string } }) => (
		<div data-testid="pending-card">{pendingPermission?.id}</div>
	),
}));

const MessageContext = createContext<Record<string, unknown>>({});
mock.module("./MessageContextMenuCtx", () => ({
	MessageContextMenuCtx: MessageContext,
	useMessageContextMenu: () => ({}),
}));
const NestedContext = createContext<string | null>(null);
mock.module("./MessageSelectionCtx", () => ({
	...realMessageSelectionModule,
	BLOCK_ID_ATTR: "data-block-id",
	NestedBlockCtx: NestedContext,
	shouldIgnoreMessageBlockSelection: () => false,
	useMessageSelection: () => ({
		selectionMode: false,
		selectedBlockIds: new Set<string>(),
		deselectBlock: () => {},
		rangeSelectTo: () => {},
		toggleBlock: () => {},
	}),
}));

const { SubagentCard } = await import("./SubagentCard" + "?activity-summary-test");

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

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

async function renderReasoningEffortCard(
	input: Record<string, unknown>,
	activityReasoningEffort: string | null = null,
	toolName = "Agent",
) {
	await act(async () => {
		root?.render(
			<MantineProvider>
				<SubagentCard
					narratorId="owner-1"
					toolCall={{
						toolName,
						toolUseId: "parent-tool",
						inputJson: { prompt: "Do work", ...input },
						status: "running",
						_subagentActivity: {
							subagentNarratorId: "subagent-1",
							model: null,
							reasoningEffort: activityReasoningEffort,
							latestToolCalls: [],
						},
					}}
				/>
			</MantineProvider>,
		);
	});
}

async function renderModelCard(
	activityModel: string | null,
	inputModel: unknown = undefined,
	subagentNarratorId = "subagent-1",
) {
	await act(async () => {
		root?.render(
			<MantineProvider>
				<SubagentCard
					narratorId="owner-1"
					toolCall={{
						toolName: "Agent",
						toolUseId: "parent-tool",
						inputJson: { prompt: "Do work", model: inputModel },
						status: "running",
						_subagentActivity: {
							subagentNarratorId,
							model: activityModel,
							latestToolCalls: [],
						},
					}}
				/>
			</MantineProvider>,
		);
	});
}

function renderedModel() {
	return container?.querySelector('[data-testid="subagent-model"]')?.textContent;
}

function header(index: number) {
	return {
		toolCallId: `call-${index}`,
		toolUseId: `tool-${index}`,
		toolName: `Tool ${index}`,
		status: "running",
		createdAt: index,
		timing: null,
	};
}

function permission(index: number) {
	return {
		id: `permission-${index}`,
		toolName: `Tool ${index}`,
		toolUseId: `pending-${index}`,
		parentToolUseId: "parent-tool",
		subagentNarratorId: "subagent-1",
		ownerNarratorId: "owner-1",
		inputJson: {},
	};
}

beforeEach(() => {
	installDom();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	navigateMock.mockClear();
	handleContextMenuMock.mockClear();
	narratorDataMock = { status: "working", substatus: [] };
	swipeOffsetMock = 0;
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

afterAll(() => {
	mock.module("react-i18next", () => realReactI18nextModule);
	mock.module("../../hooks/usePlatform", () => realUsePlatformModule);
	mock.module("./MessageSelectionCtx", () => realMessageSelectionModule);
	mock.module("../../hooks/useNarrator", () => realUseNarratorModule);
	mock.module("./ToolCallCard", () => realToolCallCardModule);
	mock.module("@tanstack/react-router", () => realRouterModule);
	mock.module("./ContentViewer", () => realContentViewerModule);
	mock.module("./LazyCollapse", () => realLazyCollapseModule);
	mock.module("../../hooks/useSwipeMenu", () => realSwipeMenuModule);
	mock.module("./MessageContextMenuCtx", () => realMessageContextMenuModule);
	mock.module("./CompactMenuSub", () => realCompactMenuSubModule);
	mock.restore();
});

describe("SubagentCard model badge", () => {
	test("falls back to tool input when activity model is empty", async () => {
		await renderModelCard("   ", "input-model");

		expect(renderedModel()).toBe("input-model");
	});

	test("prefers the actual subagent narrator model", async () => {
		narratorDataMock = { status: "working", substatus: [], model: "narrator-model" };
		await renderModelCard("activity-model", "input-model");

		expect(renderedModel()).toBe("narrator-model");
	});

	test("updates to async narrator data and survives temporary empty sources", async () => {
		await renderModelCard("activity-model", "input-model");
		expect(renderedModel()).toBe("activity-model");

		narratorDataMock = { status: "working", substatus: [], model: "narrator-model" };
		await renderModelCard("activity-model", "input-model");
		expect(renderedModel()).toBe("narrator-model");

		narratorDataMock = { status: "working", substatus: [], model: "" };
		await renderModelCard("", null);
		expect(renderedModel()).toBe("narrator-model");
	});

	test("clears the cached model when the card switches to another subagent", async () => {
		narratorDataMock = { status: "working", substatus: [], model: "first-model" };
		await renderModelCard(null, undefined, "subagent-1");
		expect(renderedModel()).toBe("first-model");

		narratorDataMock = { status: "working", substatus: [], model: null };
		await renderModelCard(null, undefined, "subagent-2");
		expect(renderedModel()).toBeUndefined();
		expect(container?.querySelector('[data-testid="subagent-model"]')).toBeNull();
	});
});

describe("SubagentCard reasoning effort badge", () => {
	const renderedReasoningEffort = () =>
		container?.querySelector('[data-testid="subagent-reasoning-effort"]')?.textContent;

	test("reads the canonical persisted reasoning_effort input", async () => {
		await renderReasoningEffortCard({ reasoning_effort: "high" });

		expect(renderedReasoningEffort()).toBe("high");
	});

	test("also reads camelCase tool input from legacy and alternate Agent callers", async () => {
		await renderReasoningEffortCard({ reasoningEffort: "xhigh" });

		expect(renderedReasoningEffort()).toBe("xhigh");
	});

	test("uses projected effective effort when the narrator follows the default", async () => {
		narratorDataMock = { status: "working", substatus: [], reasoningEffort: null };
		await renderReasoningEffortCard({}, "max", "Send");

		expect(renderedReasoningEffort()).toBe("max");
	});

	test("prefers an explicit narrator effort over activity and tool input", async () => {
		narratorDataMock = { status: "working", substatus: [], reasoningEffort: "medium" };
		await renderReasoningEffortCard({ reasoning_effort: "high" }, "max");

		expect(renderedReasoningEffort()).toBe("medium");
	});

	test("updates when narrator and activity data arrive asynchronously", async () => {
		await renderReasoningEffortCard({ reasoningEffort: "low" });
		expect(renderedReasoningEffort()).toBe("low");

		await renderReasoningEffortCard({ reasoningEffort: "low" }, "high");
		expect(renderedReasoningEffort()).toBe("high");

		narratorDataMock = { status: "working", substatus: [], reasoningEffort: "xhigh" };
		await renderReasoningEffortCard({ reasoningEffort: "low" }, "high");
		expect(renderedReasoningEffort()).toBe("xhigh");
	});

	test("does not render null, blank, or non-string values", async () => {
		narratorDataMock = { status: "working", substatus: [], reasoningEffort: "   " };
		await renderReasoningEffortCard({ reasoning_effort: null, reasoningEffort: 3 }, "   ");

		expect(container?.querySelector('[data-testid="subagent-reasoning-effort"]')).toBeNull();
	});

	test("keeps tags in a wrapping header lane so the effort badge is not squeezed out", async () => {
		await renderReasoningEffortCard({ model: "very-long-model-name", reasoning_effort: "high" });

		const tags = container?.querySelector(
			'[data-testid="subagent-header-tags"]',
		) as HTMLElement | null;
		expect(tags).not.toBeNull();
		expect(tags?.style.flexWrap).toBe("wrap");
		expect(renderedReasoningEffort()).toBe("high");
	});
});

describe("SubagentCard activity summary", () => {
	test("opens Dockview through onViewSubagentSession when an activity row is clicked", async () => {
		const openSession = mock(() => {});
		await act(async () => {
			root?.render(
				<MantineProvider>
					<SubagentCard
						narratorId="owner-1"
						onViewSubagentSession={openSession}
						toolCall={{
							toolName: "Agent",
							toolUseId: "parent-tool",
							inputJson: { prompt: "Do work" },
							status: "running",
							_subagentActivity: {
								subagentNarratorId: "subagent-1",
								model: "model-1",
								latestToolCalls: [header(1)],
							},
						}}
					/>
				</MantineProvider>,
			);
		});
		const row = container?.querySelector('[data-testid="subagent-activity"]');
		expect(row).not.toBeNull();
		expect(container?.querySelector('[aria-label="sendOptions"]')).toBeNull();
		const card = container?.querySelector('[data-block-id="sa-parent-tool"]');
		await act(async () => card?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
		expect(handleContextMenuMock).toHaveBeenCalledTimes(1);
		await act(async () => row?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(openSession).toHaveBeenCalledWith("subagent-1");
		expect(navigateMock).not.toHaveBeenCalled();
	});

	test("renders the shared left-swipe menu without an overflow button", async () => {
		swipeOffsetMock = 180;
		await act(async () => {
			root?.render(
				<MantineProvider>
					<SubagentCard
						narratorId="owner-1"
						toolCall={{
							toolName: "Send",
							toolUseId: "parent-tool",
							inputJson: { message: "Follow up" },
							status: "running",
							_subagentActivity: {
								subagentNarratorId: "subagent-1",
								model: null,
								latestToolCalls: [],
							},
						}}
					/>
				</MantineProvider>,
			);
		});
		expect(document.body.textContent).toContain("openFullSubagentSession");
		expect(document.body.textContent).toContain("cancel");
		expect(container?.querySelector('[aria-label="sendOptions"]')).toBeNull();
	});

	test("shows only the latest three headers but all matching pending permissions", async () => {
		const permissions = [1, 2, 3, 4].map(permission);
		await act(async () => {
			root?.render(
				<MantineProvider>
					<SubagentCard
						narratorId="owner-1"
						isSoleInRun
						permCb={{
							pendingPermission: null,
							pendingPermissions: permissions,
							onPermissionDecision: () => {},
							onQuestionSubmit: () => {},
							onQuestionReflect: () => {},
							onQuestionDeny: () => {},
						}}
						toolCall={{
							toolName: "Send",
							toolUseId: "parent-tool",
							inputJson: { message: "Follow up" },
							status: "running",
							_subagentActivity: {
								subagentNarratorId: "subagent-1",
								model: null,
								latestToolCalls: [header(1), header(2), header(3), header(4)],
							},
						}}
					/>
				</MantineProvider>,
			);
		});
		expect(container?.querySelectorAll('[data-testid="subagent-activity"]').length).toBe(3);
		expect(container?.querySelectorAll('[data-testid="pending-card"]').length).toBe(4);
	});

	test("replaces a latest-three pending header with its full permission card", async () => {
		const pending = {
			...permission(4),
			id: "call-4",
			toolUseId: "tool-4",
		};
		await act(async () => {
			root?.render(
				<MantineProvider>
					<SubagentCard
						narratorId="owner-1"
						permCb={{
							pendingPermission: null,
							pendingPermissions: [pending],
							onPermissionDecision: () => {},
							onQuestionSubmit: () => {},
							onQuestionReflect: () => {},
							onQuestionDeny: () => {},
						}}
						toolCall={{
							toolName: "Agent",
							toolUseId: "parent-tool",
							inputJson: { prompt: "Do work" },
							status: "running",
							_subagentActivity: {
								subagentNarratorId: "subagent-1",
								model: null,
								latestToolCalls: [header(1), header(2), header(3), header(4)],
							},
						}}
					/>
				</MantineProvider>,
			);
		});
		expect(container?.querySelectorAll('[data-testid="subagent-activity"]').length).toBe(2);
		expect(container?.querySelectorAll('[data-testid="pending-card"]').length).toBe(1);
	});
});
