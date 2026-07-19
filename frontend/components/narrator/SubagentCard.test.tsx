import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import type React from "react";
import { act, createContext } from "react";
import { createRoot, type Root } from "react-dom/client";

const realReactI18nextModule = { ...(await import("react-i18next")) };
const realUsePlatformModule = { ...(await import("../../hooks/usePlatform")) };
const realMessageSelectionModule = { ...(await import("./MessageSelectionCtx")) };

const navigateMock = mock(() => {});
mock.module("@tanstack/react-router", () => ({
	useNavigate: () => navigateMock,
	useSearch: () => ({}),
}));
mock.module("../../hooks/useNarrator", () => ({
	useAskInPassing: () => ({ isPending: false }),
	useCancelAskInPassing: () => ({ isPending: false }),
	useNarrator: () => ({ data: { status: "working", substatus: [] } }),
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
		swipeOffset: 0,
		swipeRevealed: false,
		swipeClosing: false,
		closeSwipe: () => {},
		ctxMenuOpened: false,
		setCtxMenuOpened: () => {},
		ctxMenuPos: { x: 0, y: 0, flipY: false },
		setCtxMenuPos: () => {},
		handleContextMenu: () => {},
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

const { SubagentCard } = await import("./SubagentCard");

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
	Object.assign(window, { requestAnimationFrame, cancelAnimationFrame, matchMedia });
	Object.assign(globalThis, {
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
	});
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
	mock.restore();
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
		await act(async () => row?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(openSession).toHaveBeenCalledWith("subagent-1");
		expect(navigateMock).not.toHaveBeenCalled();
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
							pendingPermsMap: new Map(),
							pendingPermissions: permissions,
							pendingPermsByRequestId: new Map(permissions.map((item) => [item.id, item])),
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
							pendingPermsMap: new Map([[pending.toolUseId, pending]]),
							pendingPermissions: [pending],
							pendingPermsByRequestId: new Map([[pending.id, pending]]),
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
