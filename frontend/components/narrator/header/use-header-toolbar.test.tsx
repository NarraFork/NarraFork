import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as layoutHooks from "../../../hooks/useNarratorToolbarLayout";
import { PathRulesPopover } from "../interaction/PathRulesPopover";
import { narratorToolbarItem } from "./narrator-toolbar-items";
import {
	type UseHeaderToolbarOptions,
	type UseHeaderToolbarResult,
	useHeaderToolbar,
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
		detailsOpened: false,
		terminalToolOpened: false,
		specToolOpened: false,
		setMobileTasksOpen: mock(() => {}),
		setMobileToolPanel: mock(() => {}),
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
		await render();
		// Title width is pretext-measured in the title slot; this controller only
		// exposes layout zones (surfaced / tucked / bottom).
		expect("toolbarVisibleDefs" in controller).toBe(false);
		expect(controller.toolbarSurfacedDefs).toEqual([]);
		expect(controller.toolbarTuckedDefs).toEqual([]);
	});

	test("bottom entries stay out of the header hidden list", async () => {
		await render();
		expect(controller.toolbarBottomDefs.map((def) => def.id)).toEqual(["path-rules", "terminal"]);
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
