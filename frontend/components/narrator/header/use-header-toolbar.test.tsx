import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as layoutHooks from "../../../hooks/useNarratorToolbarLayout";
import { api } from "../../../lib/api";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";
import { PathRulesPopover } from "../interaction/PathRulesPopover";
import {
	ExecutionDeviceOptions,
	type ExecutionDeviceOptionsProps,
} from "../model/ExecutionDeviceMenu";
import { WorkspaceTargetPickerModal } from "../model/WorkspaceTargetPickerModal";
import { WorkspaceSnapshotRestoreModal } from "../workspace/WorkspaceSnapshotRestoreModal";
import { narratorToolbarItem } from "./narrator-toolbar-items";
import {
	type UseHeaderToolbarOptions,
	type UseHeaderToolbarResult,
	useHeaderToolbar,
} from "./use-header-toolbar";

let root: Root;
let client: QueryClient;
let controller: UseHeaderToolbarResult;
let restoreLayout: () => void;
let entryEnabled: Parameters<typeof layoutHooks.useNarratorToolbarLayout>[0]["entryEnabled"];
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
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
	});
	client.setQueryData(["auth", "me"], { id: "actor" });
	for (const id of ["narrator-a", "narrator-b"])
		client.setQueryData(["deviceWorkspaces", id, "actor"], {
			pages: [{ items: [], nextCursor: null }],
			pageParams: [null],
		});
	spyOn(narratorWSManager, "addListener").mockReturnValue({ _id: 1 } as ReturnType<
		typeof narratorWSManager.addListener
	>);
	spyOn(narratorWSManager, "removeListener").mockImplementation(() => {});
	spyOn(api, "listNarratorDeviceWorkspaces").mockResolvedValue({ items: [], nextCursor: null });
	root = createRoot(document.body.appendChild(document.createElement("div")));
	const bottom = [narratorToolbarItem("path-rules"), narratorToolbarItem("terminal")].filter(
		(def): def is NonNullable<typeof def> => !!def,
	);
	const layout = spyOn(layoutHooks, "useNarratorToolbarLayout").mockImplementation((input) => {
		entryEnabled = input.entryEnabled;
		return { entries: [], visible: [], overflow: [], bottom, saveLayout: mock(() => {}) };
	});
	restoreLayout = () => layout.mockRestore();
});

afterEach(async () => {
	await act(async () => root.unmount());
	restoreLayout();
	client.clear();
	mock.restore();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function render(props = options()) {
	client.setQueryData(
		["workspaceContext", props.narratorId],
		props.workspaceContext ?? {
			revision: 4,
			deviceId: "local",
			cwd: "/local",
			contextKey: "local:4",
			pathFlavor: "posix",
			capabilities: { switchDirectory: true },
		},
	);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<Probe {...props} />
			</QueryClientProvider>,
		),
	);
}

function overlayOf(type: unknown) {
	const fragment = controller.toolbarOverlays as ReactElement<{ children: ReactNode }>;
	const element = Children.toArray(fragment.props.children).find(
		(child) => isValidElement(child) && child.type === type,
	);
	if (!isValidElement(element)) throw new Error("overlay missing");
	return element as ReactElement<{
		narratorId: string;
		deviceId: string;
		opened: boolean;
		onClose: () => void;
		controlled: { opened: boolean; onClose: () => void };
	}>;
}
function overlay() {
	return overlayOf(PathRulesPopover);
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

	test("overflow device selection opens a narrator-bound modal outside the closing dropdown", async () => {
		const props = options();
		props.executionDevicesQuery = {
			data: { devices: [{ id: "remote", name: "Remote", online: true }], defaultDeviceId: "local" },
		};
		await render(props);
		const close = mock(() => {});
		const rows = controller.renderToolbarInlineOptions(
			"device",
			close,
		) as ReactElement<ExecutionDeviceOptionsProps>;
		expect(rows.type).toBe(ExecutionDeviceOptions);
		await act(async () => rows.props.onSelect("remote"));
		expect(close).toHaveBeenCalledTimes(1);
		expect(props.updateExecutionDeviceMutation.mutate).not.toHaveBeenCalled();
		expect(overlayOf(WorkspaceTargetPickerModal).props.narratorId).toBe("narrator-a");
		expect(overlayOf(WorkspaceTargetPickerModal).props.deviceId).toBe("remote");
		// A dropdown being removed/re-rendered cannot remove the separately hosted modal.
		await render({
			...props,
			executionDevicesQuery: { data: { devices: [], defaultDeviceId: "local" } },
		});
		expect(overlayOf(WorkspaceTargetPickerModal).props.deviceId).toBe("remote");
		await act(async () => overlayOf(WorkspaceTargetPickerModal).props.onClose());
		expect(() => overlayOf(WorkspaceTargetPickerModal)).toThrow("overlay missing");
	});
	test("ordinary non-Git local directory switching remains reachable with no remote devices", async () => {
		const props = { ...options(), gitWorkspaceAvailable: false };
		await render(props);
		expect(entryEnabled?.("device")).toBe(true);
		expect(entryEnabled?.("git")).toBe(false);
		const close = mock(() => {});
		const rows = controller.renderToolbarInlineOptions(
			"device",
			close,
		) as ReactElement<ExecutionDeviceOptionsProps>;
		await act(async () => rows.props.onChangeDirectory?.());
		expect(overlayOf(WorkspaceTargetPickerModal).props.deviceId).toBe("local");
		expect(props.updateExecutionDeviceMutation.mutate).not.toHaveBeenCalled();
	});

	test("overflow current-directory action uses authoritative context, not a late local device query", async () => {
		const props = options();
		props.workspaceContext = {
			revision: 4,
			deviceId: "remote",
			cwd: "/selected",
			contextKey: "remote:4",
			pathFlavor: "posix",
			capabilities: { switchDirectory: true },
		};
		props.executionDevicesQuery = { data: { devices: [], defaultDeviceId: "local" } };
		await render(props);
		const rows = controller.renderToolbarInlineOptions(
			"device",
			() => {},
		) as ReactElement<ExecutionDeviceOptionsProps>;
		expect(rows.props.currentDeviceId).toBe("remote");
		await act(async () => rows.props.onChangeDirectory?.());
		expect(overlayOf(WorkspaceTargetPickerModal).props.deviceId).toBe("remote");
	});

	test("whole-directory snapshot manager opens from the actual overflow and remains outside its closing dropdown", async () => {
		const props = options();
		await render(props);
		const close = mock(() => {});
		const rows = controller.renderToolbarInlineOptions(
			"device",
			close,
		) as ReactElement<ExecutionDeviceOptionsProps>;
		await act(async () => rows.props.onManageSnapshots?.());
		expect(close).toHaveBeenCalledTimes(1);
		expect(overlayOf(WorkspaceSnapshotRestoreModal).props.narratorId).toBe("narrator-a");
		expect(props.updateExecutionDeviceMutation.mutate).not.toHaveBeenCalled();
		await render(props);
		expect(overlayOf(WorkspaceSnapshotRestoreModal).props.opened).toBe(true);
		await act(async () => overlayOf(WorkspaceSnapshotRestoreModal).props.onClose());
		expect(() => overlayOf(WorkspaceSnapshotRestoreModal)).toThrow("overlay missing");
	});

	test("changing the narrator owner discards the previous directory confirmation", async () => {
		const props = options();
		await render(props);
		const rows = controller.renderToolbarInlineOptions(
			"device",
			() => {},
		) as ReactElement<ExecutionDeviceOptionsProps>;
		await act(async () => rows.props.onSelect("remote"));
		expect(overlayOf(WorkspaceTargetPickerModal).props.narratorId).toBe("narrator-a");
		await render({ ...props, narratorId: "narrator-b" });
		expect(() => overlayOf(WorkspaceTargetPickerModal)).toThrow("overlay missing");
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
