import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as capacityHooks from "../../../hooks/useNarratorHeaderToolbarCapacity";
import * as layoutHooks from "../../../hooks/useNarratorToolbarLayout";
import { PathRulesPopover } from "../interaction/PathRulesPopover";
import { narratorToolbarItem } from "./narrator-toolbar-items";
import {
	type UseHeaderToolbarOptions,
	type UseHeaderToolbarResult,
	useHeaderToolbar,
	useHeaderToolbarCapacityPartition,
} from "./use-header-toolbar";

let root: Root;
let controller: UseHeaderToolbarResult;
let restoreLayout: () => void;
const originals = new Map<string, PropertyDescriptor | undefined>();

function Probe(props: UseHeaderToolbarOptions) {
	controller = useHeaderToolbar(props);
	return null;
}

function options(): UseHeaderToolbarOptions {
	return {
		narratorId: "narrator-a",
		headerHostCapabilities: ["inline", "drawer"],
		dock: null,
		gitWorkspaceAvailable: true,
		tasksSupported: true,
		tasksButtonEnabled: true,
		specToolAvailable: true,
		terminalToolAvailable: true,
		onOpenTerminalPanel: undefined,
		browserSessionsSupported: true,
		executionDevicesQuery: { data: { devices: [] } },
		mobileTasksOpen: false,
		mobileToolPanel: null,
		fileModDrawerOpened: false,
		detailsOpened: false,
		terminalToolOpened: false,
		specToolOpened: false,
		setMobileTasksOpen: mock(() => {}),
		setMobileToolPanel: mock(() => {}),
		setFileModDrawerOpened: mock(() => {}),
		toggleDetails: mock(() => {}),
		toggleTerminalTool: mock(() => {}),
		toggleSpecTool: mock(() => {}),
		updateExecutionDeviceMutation: { mutate: mock(() => {}) },
		renderLod: 4,
		renderLodIsDefault: true,
		handleSelectLod: mock(() => {}),
		setAsDefault: mock(() => {}),
		openPluginPanel: mock(() => {}),
		t: (key) => key,
	};
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	root = createRoot(document.body.appendChild(document.createElement("div")));
	const bottom = [narratorToolbarItem("path-rules"), narratorToolbarItem("terminal")].filter(
		(def): def is NonNullable<typeof def> => !!def,
	);
	const layout = spyOn(layoutHooks, "useNarratorToolbarLayout").mockReturnValue({
		entries: [],
		visible: [],
		overflow: [],
		bottom,
		saveLayout: mock(() => {}),
	});
	restoreLayout = () => layout.mockRestore();
});

afterEach(async () => {
	await act(async () => root.unmount());
	restoreLayout();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function render(props = options()) {
	await act(async () => root.render(<Probe {...props} />));
}

function overlay() {
	return controller.toolbarOverlays as ReactElement<{
		narratorId: string;
		controlled: { opened: boolean; onClose: () => void };
	}>;
}

describe("panel toolbar controller", () => {
	test("does not own width capacity state", async () => {
		const capacity = spyOn(capacityHooks, "useNarratorHeaderToolbarCapacity").mockReturnValue(2);
		try {
			await render();
			expect(capacity).not.toHaveBeenCalled();
			expect("toolbarVisibleDefs" in controller).toBe(false);
		} finally {
			capacity.mockRestore();
		}
	});

	test("bottom entries stay out of the header hidden list", async () => {
		await render();
		expect(controller.toolbarBottomDefs.map((def) => def.id)).toEqual(["path-rules", "terminal"]);
		expect(controller.toolbarSurfacedDefs).toEqual([]);
		expect(controller.toolbarTuckedDefs).toEqual([]);
	});

	test("path rules opens a separately hosted dialog and closes through its callback", async () => {
		await render();
		expect(overlay().type).toBe(PathRulesPopover);
		expect(overlay().props.controlled.opened).toBe(false);
		await act(async () => controller.activateToolbarEntry("path-rules"));
		expect(overlay().props.narratorId).toBe("narrator-a");
		expect(overlay().props.controlled.opened).toBe(true);
		await render();
		expect(overlay().props.controlled.opened).toBe(true);
		await act(async () => overlay().props.controlled.onClose());
		expect(overlay().props.controlled.opened).toBe(false);
	});

	test("terminal uses the host callback, with the standalone toggle as fallback", async () => {
		const props = options();
		const open = mock(() => {});
		await render({ ...props, onOpenTerminalPanel: open });
		controller.activateToolbarEntry("terminal");
		expect(open).toHaveBeenCalledTimes(1);
		expect(props.toggleTerminalTool).not.toHaveBeenCalled();
		await render(props);
		controller.activateToolbarEntry("terminal");
		expect(props.toggleTerminalTool).toHaveBeenCalledTimes(1);
	});
});

describe("useHeaderToolbarCapacityPartition", () => {
	function partitionProbe() {
		const result = { current: null as null | ReturnType<typeof useHeaderToolbarCapacityPartition> };
		function Probe2(props: Parameters<typeof useHeaderToolbarCapacityPartition>[0]) {
			result.current = useHeaderToolbarCapacityPartition(props);
			return null;
		}
		return { result, Probe2 };
	}

	test("reserves title width first; only mobile adds the count cap", async () => {
		const capacity = spyOn(capacityHooks, "useNarratorHeaderToolbarCapacity").mockReturnValue(2);
		const { result, Probe2 } = partitionProbe();
		const base = {
			surfacedDefs: [narratorToolbarItem("tasks"), narratorToolbarItem("git")].filter(
				(def): def is NonNullable<typeof def> => !!def,
			),
			tuckedDefs: [],
			headerRowRef: { current: null },
			headerToolbarRef: { current: null },
			headerLeadingRef: { current: null },
			hostOwnsTitle: false,
			isWorkspacePreview: false,
		};
		try {
			await act(async () => root.render(<Probe2 {...base} isMobileViewport />));
			expect(capacity).toHaveBeenLastCalledWith(
				expect.objectContaining({
					maxWidthFraction: null,
					maxCapacity: 2,
					titleSlotMinWidth: 184,
				}),
			);
			expect(result.current?.toolbarVisibleDefs.map((def) => def.id)).toEqual(["tasks", "git"]);
			await act(async () => root.render(<Probe2 {...base} isMobileViewport={false} />));
			expect(capacity).toHaveBeenLastCalledWith(
				expect.objectContaining({
					maxWidthFraction: null,
					maxCapacity: null,
					titleSlotMinWidth: 184,
				}),
			);
		} finally {
			capacity.mockRestore();
		}
	});
});
