import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ActionIcon, MantineProvider } from "@mantine/core";
import type { IDockviewPanelProps } from "dockview-react";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { cancelDrag, getPanelDrag } from "../../../lib/panel-drag";
import { ToolPanelHeader, ToolPanelShell } from "../dock/panels";
import { HeaderToolbar, type HeaderToolbarProps } from "../header/HeaderToolbar";
import { HEADER_PIN_WIDTH_PX } from "../header/header-title-width";
import { NarratorHeaderLayout } from "../header/NarratorHeaderLayout";
import { HEADER_TOOLBAR_FIXED_ATTR } from "../header/narrator-header-toolbar-capacity";
import {
	type PanelHeaderControls,
	PanelHeaderControlsProvider,
	usePanelHeaderControls,
} from "./panel-header-controls";
import { usePanelHeaderDrag } from "./shared";

let root: Root;
let host: HTMLDivElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const matchMedia = (media: string) => ({
		media,
		matches: false,
		addEventListener() {},
		removeEventListener() {},
	});
	Object.assign(window, { matchMedia });
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		matchMedia,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
});

afterEach(async () => {
	cancelDrag();
	await act(async () => root.unmount());
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function render(children: ReactNode, controls?: PanelHeaderControls | null) {
	await act(async () => {
		root.render(
			<MantineProvider env="test">
				{controls === undefined ? (
					children
				) : (
					<PanelHeaderControlsProvider value={controls}>{children}</PanelHeaderControlsProvider>
				)}
			</MantineProvider>,
		);
	});
}

function pointer(target: EventTarget, type: string, x = 10) {
	target.dispatchEvent(
		Object.assign(new window.Event(type, { bubbles: true }), { clientX: x, clientY: 20 }),
	);
}

function pinAction(onClick = mock(() => {})) {
	return (
		<ActionIcon className="nodrag" size={HEADER_PIN_WIDTH_PX} aria-label="Pin" onClick={onClick}>
			P
		</ActionIcon>
	);
}

function shell(close = mock(() => {})) {
	const props = {
		api: { id: "panel-terminal", title: "Terminal", group: { id: "group-a" }, close },
	} as unknown as IDockviewPanelProps;
	return (
		<ToolPanelShell title="Terminal" props={props} subjectId="__terminal__" detachKind="terminal">
			<span>Content</span>
		</ToolPanelShell>
	);
}

function toolbarProps(): HeaderToolbarProps {
	return {
		narratorId: "subagent-a",
		headerHostCapabilities: ["inline"],
		openArchiveConfirm: mock(() => {}),
		archiveMutation: { isPending: false },
		dock: null,
		mockStreamEnabled: false,
		onClose: mock(() => {}),
		visibleToolCount: 0,
		toolbarBadgeCounts: { backgroundTasks: 0, browserSessions: 0, userChatUnread: 0, terminals: 0 },
		t: (key) => key,
		inlineControls: {
			executionDevicesQuery: { data: { devices: [] } },
			updateExecutionDeviceMutation: { mutate: mock(() => {}) },
			renderLod: 4,
			renderLodIsDefault: true,
			handleSelectLod: mock(() => {}),
			setAsDefault: mock(() => {}),
			openPluginPanel: mock(() => {}),
		},
		controller: {
			toolbarEntries: [],
			toolbarSurfacedDefs: [],
			toolbarTuckedDefs: [],
			toolbarBottomDefs: [],
			toolbarOverlays: null,
			saveToolbarLayout: mock(() => {}),
			toolbarEntryActive: () => false,
			activateToolbarEntry: mock(() => {}),
			renderToolbarInlineOptions: () => null,
		},
	};
}

function NarratorHeaderProbe({ adapter = true }: { adapter?: boolean }) {
	const props = {
		api: { id: "panel-subagent", title: "Subagent", group: { id: "group-a" } },
	} as unknown as IDockviewPanelProps;
	const onHeaderPointerDown = usePanelHeaderDrag(props, "subagent-a");
	return (
		<NarratorHeaderLayout
			titleFullWidth={200}
			surfacedToolCount={0}
			showClose
			onHeaderPointerDown={adapter ? onHeaderPointerDown : undefined}
		>
			{(layout) => <HeaderToolbar {...toolbarProps()} {...layout} />}
		</NarratorHeaderLayout>
	);
}

describe("host-supplied panel header controls", () => {
	test("production tool header keeps actions, 28px pin, close in that order", async () => {
		const pin = mock(() => {});
		const close = mock(() => {});
		const drag = mock(() => {});
		await render(
			<ToolPanelHeader
				title="Terminal"
				actions={<button type="button">Other action</button>}
				onPointerDown={drag}
				onClose={close}
			/>,
			{ pinAction: pinAction(pin) },
		);
		const buttons = [...host.querySelectorAll("button")];
		expect(
			buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent),
		).toEqual(["Other action", "Pin", ""]);
		// linkedom has no layout; assert the real Mantine size variable, not fake geometry.
		expect(buttons[1].style.getPropertyValue("--ai-size")).toBe(
			"calc(1.75rem * var(--mantine-scale))",
		);
		pointer(buttons[1], "pointerdown");
		buttons[1].click();
		buttons[2].click();
		expect(drag).not.toHaveBeenCalled();
		expect(pin).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("consumed header gestures bypass the singleton on the production shell", async () => {
		const onPointerDown = mock(() => true);
		await render(shell(), { onPointerDown });
		pointer(host.querySelector(".nf-panel-header") as HTMLElement, "pointerdown");
		pointer(document, "pointermove", 40);
		expect(onPointerDown).toHaveBeenCalledTimes(1);
		expect(getPanelDrag()).toBeNull();
	});

	test("declined overrides retain the normal panel drag", async () => {
		const onPointerDown = mock(() => false);
		await render(shell(), { onPointerDown });
		pointer(host.querySelector(".nf-panel-header") as HTMLElement, "pointerdown");
		pointer(document, "pointermove", 40);
		expect(onPointerDown).toHaveBeenCalledTimes(1);
		expect(getPanelDrag()).toMatchObject({ panelId: "panel-terminal", toolKind: "terminal" });
	});

	test("ordinary focus/graph headers have null controls, no pin, and unchanged drag/close", async () => {
		let value: PanelHeaderControls | null | undefined;
		function Probe() {
			value = usePanelHeaderControls();
			return null;
		}
		const close = mock(() => {});
		await render(
			<>
				{shell(close)}
				<Probe />
			</>,
		);
		expect(value).toBeNull();
		expect(host.querySelectorAll("button")).toHaveLength(1);
		pointer(host.querySelector(".nf-panel-header") as HTMLElement, "pointerdown");
		pointer(document, "pointermove", 40);
		expect(getPanelDrag()).toMatchObject({
			panelId: "panel-terminal",
			id: "__terminal__",
			sourceGroupId: "group-a",
			subjectKind: "tool",
		});
		host.querySelector("button")?.click();
		expect(close).toHaveBeenCalledTimes(1);
	});

	test.each([
		true,
		false,
	])("narrator layout forwards to the dock adapter with one host invocation (consumed=%s)", async (consumed) => {
		const onPointerDown = mock(() => consumed);
		await render(<NarratorHeaderProbe />, { pinAction: pinAction(), onPointerDown });
		pointer(host.querySelector(".nf-panel-header") as HTMLElement, "pointerdown");
		pointer(document, "pointermove", 40);
		expect(onPointerDown).toHaveBeenCalledTimes(1);
		if (consumed) expect(getPanelDrag()).toBeNull();
		else expect(getPanelDrag()).toMatchObject({ panelId: "panel-subagent", id: "subagent-a" });
	});

	test("narrator layout uses host drag when no adapter is present, excluding buttons", async () => {
		const onPointerDown = mock(() => true);
		await render(<NarratorHeaderProbe adapter={false} />, {
			pinAction: pinAction(),
			onPointerDown,
		});
		pointer(host.querySelector('[aria-label="Pin"]') as HTMLElement, "pointerdown");
		expect(onPointerDown).not.toHaveBeenCalled();
		pointer(host.querySelector(".nf-panel-header") as HTMLElement, "pointerdown");
		expect(onPointerDown).toHaveBeenCalledTimes(1);
		expect(getPanelDrag()).toBeNull();
	});

	test("narrator toolbar places pin before close in its measured fixed region", async () => {
		const props = toolbarProps();
		await render(<HeaderToolbar {...props} />, { pinAction: pinAction() });
		const buttons = [...host.querySelectorAll("button")];
		expect(buttons.at(-2)?.getAttribute("aria-label")).toBe("Pin");
		const pin = host.querySelector('[aria-label="Pin"]');
		expect(pin?.parentElement?.hasAttribute(HEADER_TOOLBAR_FIXED_ATTR)).toBe(true);
		await render(<HeaderToolbar {...props} onClose={undefined} />, { pinAction: pinAction() });
		expect(host.querySelector('[aria-label="Pin"]')).toBeNull();
		await render(<HeaderToolbar {...props} />);
		expect(host.querySelector('[aria-label="Pin"]')).toBeNull();
	});
});
