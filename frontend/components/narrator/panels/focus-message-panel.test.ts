import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import {
	WorkspaceDockStore,
	workspaceSubagentPanelId,
	workspaceToolPanelId,
} from "../workspace/workspace-dock";
import { focusMessagePanel } from "./focus-message-panel";

const originalFrame = globalThis.requestAnimationFrame;
let frames: FrameRequestCallback[] = [];
beforeEach(() => {
	frames = [];
	globalThis.requestAnimationFrame = (callback) => frames.push(callback);
});
afterEach(() => {
	globalThis.requestAnimationFrame = originalFrame;
});
function flushFrame() {
	const pending = frames.splice(0);
	for (const callback of pending) callback(0);
}
function fixture(active = false) {
	const panel = {
		id: "legacy-primary-panel-id",
		params: { panelType: "narrator", narratorId: "primary" },
		group: {
			id: "primary-group",
			api: { boundingBox: { left: 0, top: 0, width: 800, height: 600 } },
		},
		api: {
			location: { type: "grid" },
			isActive: active,
			isVisible: active,
			setActive: mock(() => {
				panel.api.isActive = true;
				panel.api.isVisible = true;
			}),
		},
	};
	const panels = [panel];
	const addPanel = mock(() => {});
	const api = {
		width: 1200,
		height: 800,
		panels,
		getPanel: (id: string) => panels.find((p) => p.id === id),
		addPanel,
	} as unknown as DockviewApi;
	return { api, panel, panels, addPanel };
}

describe("primary message panel navigation", () => {
	for (const active of [true, false]) {
		test(`reuses ${active ? "foreground" : "background"} primary and waits for layout`, () => {
			const { api, panel, addPanel } = fixture(active);
			const scroll = mock(() => {});
			focusMessagePanel(api, panel as unknown as IDockviewPanel, "message", scroll);
			expect(panel.api.setActive).toHaveBeenCalledTimes(active ? 0 : 1);
			expect(scroll).not.toHaveBeenCalled();
			flushFrame();
			expect(scroll).toHaveBeenCalledWith("message");
			expect(addPanel).not.toHaveBeenCalled();
		});
	}
	test("every click on the same message jumps again", () => {
		const { api, panel } = fixture();
		const scroll = mock(() => {});
		for (let i = 0; i < 2; i++) {
			focusMessagePanel(api, panel as unknown as IDockviewPanel, "message", scroll);
			flushFrame();
		}
		expect(scroll).toHaveBeenCalledTimes(2);
	});
	test("without a message only brings the panel forward", () => {
		const { api, panel } = fixture();
		const scroll = mock(() => {});
		focusMessagePanel(api, panel as unknown as IDockviewPanel, undefined, scroll);
		expect(panel.api.isActive).toBe(true);
		expect(frames).toHaveLength(0);
		expect(scroll).not.toHaveBeenCalled();
	});
	for (const action of ["close", "hide"]) {
		test(`does not jump after target ${action}`, () => {
			const { api, panel, panels } = fixture();
			const scroll = mock(() => {});
			focusMessagePanel(api, panel as unknown as IDockviewPanel, "message", scroll);
			if (action === "close") panels.length = 0;
			else panel.api.isVisible = false;
			flushFrame();
			expect(scroll).not.toHaveBeenCalled();
		});
	}
});

describe("workspace tool panel toggle", () => {
	type ToolPanel = {
		id: string;
		params: { panelType: string; narratorId: string };
		group: { id: string };
		api: {
			location: { type: "floating" };
			isActive: boolean;
			setActive: () => void;
			close: () => void;
		};
	};

	function bindToolPanel(
		api: { getPanel: (id: string) => unknown },
		options: { panelType?: string; narratorId?: string; isActive?: boolean } = {},
	) {
		const panelType = options.panelType ?? "git";
		const narratorId = options.narratorId ?? "primary";
		const id = workspaceToolPanelId(narratorId, panelType as "git");
		const closed = { value: false };
		const panel: ToolPanel = {
			id,
			params: { panelType, narratorId },
			group: { id: "tool-group" },
			api: {
				location: { type: "floating" },
				isActive: options.isActive ?? false,
				setActive: mock(() => {
					panel.api.isActive = true;
				}),
				close: mock(() => {
					closed.value = true;
				}),
			},
		};
		const original = api.getPanel;
		api.getPanel = (panelId: string) => (panelId === id ? panel : original(panelId));
		return { panel, closed, id };
	}

	test("focuses an open background tool tab instead of closing it", () => {
		const { api } = fixture();
		const store = new WorkspaceDockStore({ current: api });
		const { panel, closed } = bindToolPanel(api, { isActive: false });
		store.toggleToolPanel("primary", "git", null);
		expect(panel.api.setActive).toHaveBeenCalledTimes(1);
		expect(closed.value).toBe(false);
		expect(panel.api.isActive).toBe(true);
	});

	test("closes only the already-active tool tab", () => {
		const { api } = fixture();
		const store = new WorkspaceDockStore({ current: api });
		const { panel, closed } = bindToolPanel(api, { isActive: true });
		store.toggleToolPanel("primary", "git", null);
		expect(panel.api.setActive).not.toHaveBeenCalled();
		expect(closed.value).toBe(true);
	});
});

describe("workspace primary reuse", () => {
	for (const host of ["primary", "another-host"]) {
		test(`uses target identity rather than ${host} or serialized panel id`, () => {
			const { api, panel, addPanel } = fixture();
			const store = new WorkspaceDockStore({ current: api });
			const primaryScroll = mock(() => {});
			const otherScroll = mock(() => {});
			store.registerScrollToMessage("primary", primaryScroll);
			store.registerScrollToMessage("another-host", otherScroll);
			store.openSubagentPanel(host, "primary", "message");
			flushFrame();
			expect(primaryScroll).toHaveBeenCalledWith("message");
			expect(otherScroll).not.toHaveBeenCalled();
			expect(panel.api.isActive).toBe(true);
			expect(addPanel).not.toHaveBeenCalled();
		});
	}
	test("still opens a child when there is no matching primary", () => {
		const { api, addPanel } = fixture();
		const store = new WorkspaceDockStore({ current: api });
		store.openSubagentPanel("primary", "child", "message");
		expect(addPanel).toHaveBeenCalledTimes(1);
		expect(addPanel.mock.calls[0]).toMatchObject([
			{
				params: {
					panelType: "subagent",
					subagentNarratorId: "child",
					highlightMessageId: "message",
				},
			},
		]);
	});
	test("still reuses an existing child and renews repeated jump requests", () => {
		const { api, addPanel } = fixture();
		const updateParameters = mock((_params: Record<string, unknown>) => {});
		const child = {
			id: workspaceSubagentPanelId("primary", "child"),
			params: { panelType: "subagent", subagentNarratorId: "child" },
			group: { id: "child-group" },
			api: { location: { type: "floating" }, setActive: mock(() => {}), updateParameters },
		} as unknown as IDockviewPanel;
		const getPanel = api.getPanel;
		api.getPanel = (id) => (id === child.id ? child : getPanel(id));
		const store = new WorkspaceDockStore({ current: api });
		store.openSubagentPanel("primary", "child", "message");
		store.openSubagentPanel("primary", "child", "message");
		expect(addPanel).not.toHaveBeenCalled();
		expect(updateParameters).toHaveBeenCalledTimes(2);
		expect(updateParameters.mock.calls[0]?.[0].highlightMessageId).toBe("message");
		expect(updateParameters.mock.calls[0]?.[0].highlightRequestId).not.toBe(
			updateParameters.mock.calls[1]?.[0].highlightRequestId,
		);
	});
	test("single-narrator dock checks its primary before child lookup", async () => {
		const source = await Bun.file(
			new URL("../dock/NarratorDockContext.tsx", import.meta.url),
		).text();
		const start = source.indexOf("const openSubagentPanel =");
		const end = source.indexOf("const openFilePanel =", start);
		const open = source.slice(start, end);
		expect(open.indexOf("subagentNarratorId === narratorId")).toBeLessThan(
			open.indexOf("const id = subagentDockPanelId"),
		);
		expect(open).toContain('api.getPanel(dockPanelId("chat"))');
		expect(open).toContain("focusMessagePanel(api, primary, messageId");
		expect(open).toContain("bridgesRef.current.scrollToMessage?.(id)");
		expect(open).toContain("[narratorId]");
	});
});
