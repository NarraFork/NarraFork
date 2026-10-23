import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type {
	ListNarratorDeviceWorkspacesResult,
	NarratorDeviceWorkspaceMutationResult,
	NarratorDeviceWorkspaceSummary,
	WorkspaceContext,
} from "@shared/workspace-context";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

const globals = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = globals.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
});
type Children = { children?: ReactNode };
const Wrapper = ({ children }: Children) => <div>{children}</div>;
const Button = ({
	children,
	onClick,
	disabled,
	"aria-label": label,
}: Children & { onClick?: () => void; disabled?: boolean; "aria-label"?: string }) => (
	<button type="button" disabled={disabled} onClick={onClick} aria-label={label}>
		{children}
	</button>
);
mock.module("@mantine/core", () => ({
	Alert: Wrapper,
	Button,
	Group: Wrapper,
	Stack: Wrapper,
	Text: Wrapper,
	Tooltip: Wrapper,
	ActionIcon: Button,
	Modal: ({ opened, children }: Children & { opened: boolean }) =>
		opened ? <section>{children}</section> : null,
	Menu: Object.assign(Wrapper, {
		Target: Wrapper,
		Dropdown: Wrapper,
		Item: Button,
		Label: Wrapper,
	}),
}));
mock.module("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options?.cwd ? `${key}:${options.cwd}` : options?.device ? `${key}:${options.device}` : key,
	}),
}));
mock.module("../../common/DirectoryPicker", () => ({
	DirectoryPicker: ({
		value,
		onChange,
		disabled,
		deviceId,
		narratorId,
	}: {
		value: string;
		onChange: (value: string) => void;
		disabled?: boolean;
		deviceId: string;
		narratorId: string;
	}) => (
		<input
			data-directory
			data-device={deviceId}
			data-narrator={narratorId}
			disabled={disabled}
			value={value}
			onInput={(event) => onChange(event.currentTarget.value)}
		/>
	),
}));
const events: Array<(event: Record<string, unknown>) => void> = [];
mock.module("../../../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		addListener: (_filter: unknown, callback: (event: Record<string, unknown>) => void) => {
			events.push(callback);
			return { _id: events.length };
		},
		removeListener: () => {},
	},
}));
mock.module("../interaction/PathRulesPopover", () => ({ PathRulesPopover: () => null }));
mock.module("../../plugins/PluginContributionPicker", () => ({
	PluginContributionOptions: () => null,
}));
mock.module("../lod/NarratorLodMenu", () => ({ NarratorLodOptions: () => null }));
mock.module("../workspace/WorkspaceSnapshotRestoreModal", () => ({
	WorkspaceSnapshotRestoreModal: () => null,
}));
mock.module("../../../hooks/useNarratorToolbarLayout", () => ({
	useNarratorToolbarLayout: () => ({
		entries: [],
		visible: [],
		overflow: [],
		bottom: [],
		saveLayout: () => {},
	}),
}));
const { act } = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { api, ApiError } = await import("../../../lib/api");
const { useWorkspaceContext, workspaceContextKey, transitionKey } = await import(
	"../../../hooks/useWorkspaceContext"
);
const { WorkspaceTargetPickerModal } = await import("./WorkspaceTargetPickerModal");
const { ExecutionDeviceMenu } = await import("./ExecutionDeviceMenu");
const { useHeaderToolbar } = await import("../header/use-header-toolbar");
let client: InstanceType<typeof QueryClient>, container: HTMLElement, root: Root;
const devices = [
	{ id: "win", name: "Windows", online: true },
	{ id: "linux", name: "Linux", online: true },
];
const contexts = new Map<string, WorkspaceContext>();
const summaries = new Map<string, NarratorDeviceWorkspaceSummary[]>();
const receipts = new Map<
	string,
	{
		requestId: string;
		kind: "set" | "select";
		result: NarratorDeviceWorkspaceMutationResult;
		installState: "installed" | "pending" | "superseded";
	}
>();
let selectionState: "installed" | "pending" | "unknown" | "not_committed" = "installed";
let currentInstalled = true;
let statusSpy: ReturnType<typeof spyOn<typeof api, "getWorkspaceSelectionStatus">>;
let receiptSpy: ReturnType<typeof spyOn<typeof api, "getNarratorDeviceWorkspaceRequest">>;
let gate: Promise<void> | undefined;
let resolveGate: (() => void) | undefined;
let getPage:
	| ((id: string, cursor?: string) => Promise<ListNarratorDeviceWorkspacesResult>)
	| undefined;
let selectSpy: ReturnType<typeof spyOn<typeof api, "selectNarratorDeviceWorkspace">>;
let setSpy: ReturnType<typeof spyOn<typeof api, "setNarratorDeviceWorkspace">>;
let recoverSpy: ReturnType<typeof spyOn<typeof api, "recoverNarratorDeviceWorkspaceRequest">>;
function context(deviceId: string, cwd: string, revision = 7): WorkspaceContext {
	return {
		deviceId,
		cwd,
		revision,
		pathFlavor: deviceId === "win" ? "windows" : "posix",
		contextKey: `${deviceId}:${cwd}:${revision}`,
		capabilities: { switchDirectory: true },
	};
}
function summary(
	deviceId: string,
	cwd: string,
	bindingRevision = 2,
): NarratorDeviceWorkspaceSummary {
	return {
		id: `b-${deviceId}`,
		deviceId,
		cwd,
		bindingRevision,
		pathFlavor: deviceId === "win" ? "windows" : "posix",
		selected: deviceId === "local",
		availability: "ready",
		updatedAt: "now",
	};
}
function result(
	id: string,
	kind: "set" | "select",
	deviceId: string,
	cwd: string,
	bindingRevision: number,
): NarratorDeviceWorkspaceMutationResult {
	return {
		kind,
		changed: true,
		binding: {
			id: `b-${deviceId}`,
			narratorId: id,
			deviceId,
			bindingRevision,
			context: context(deviceId, cwd),
			createdAt: "now",
			updatedAt: "now",
		},
	};
}
async function flush() {
	for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => {
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	client.setQueryData(["auth", "me"], { id: "actor" });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	contexts.clear();
	summaries.clear();
	receipts.clear();
	events.length = 0;
	selectionState = "installed";
	currentInstalled = true;
	gate = undefined;
	resolveGate = undefined;
	getPage = undefined;
	contexts.set("n1", context("local", "/n1/local"));
	contexts.set("n2", context("local", "/n2/local", 3));
	summaries.set("n1", [
		summary("local", "/n1/local"),
		summary("win", "C:\\n1"),
		summary("linux", "/n1/linux"),
	]);
	summaries.set("n2", [summary("local", "/n2/local"), summary("win", "D:\\n2")]);
	spyOn(api, "getWorkspaceContext").mockImplementation(
		async (id) => contexts.get(id) as WorkspaceContext,
	);
	statusSpy = spyOn(api, "getWorkspaceSelectionStatus").mockImplementation(async (id) => ({
		revision: contexts.get(id)?.revision ?? 0,
		installed: currentInstalled,
	}));
	spyOn(api, "listNarratorDeviceWorkspaces").mockImplementation(async (id, opts) =>
		getPage ? getPage(id, opts?.cursor) : { items: summaries.get(id) ?? [], nextCursor: null },
	);
	setSpy = spyOn(api, "setNarratorDeviceWorkspace").mockImplementation(async (id, request) => {
		if (gate) await gate;
		const value = result(
			id,
			"set",
			request.deviceId,
			request.cwd,
			request.expectedBindingRevision + 1,
		);
		const old = summaries.get(id) ?? [];
		summaries.set(id, [
			...old.filter((item) => item.deviceId !== request.deviceId),
			summary(request.deviceId, request.cwd, value.binding.bindingRevision),
		]);
		if (request.expectedSelectionRevision !== undefined) {
			const previous = contexts.get(id) as WorkspaceContext;
			const current = context(request.deviceId, request.cwd, previous.revision + 1);
			contexts.set(id, current);
			value.selection = { previous, current, changed: true };
		}
		receipts.set(request.requestId, {
			requestId: request.requestId,
			kind: "set",
			result: value,
			installState: "installed",
		});
		return value;
	});
	selectSpy = spyOn(api, "selectNarratorDeviceWorkspace").mockImplementation(
		async (id, request) => {
			if (selectionState === "not_committed") throw new ApiError("conflict", 409);
			if (selectionState === "unknown") throw new Error("lost response");
			const binding = summaries
				.get(id)
				?.find((item) => item.deviceId === request.deviceId) as NarratorDeviceWorkspaceSummary;
			const value = result(id, "select", request.deviceId, binding.cwd, binding.bindingRevision);
			const previous = contexts.get(id) as WorkspaceContext;
			const current = context(request.deviceId, binding.cwd, previous.revision + 1);
			contexts.set(id, current);
			value.selection = { previous, current, changed: true };
			receipts.set(request.requestId, {
				requestId: request.requestId,
				kind: "select",
				result: value,
				installState: selectionState,
			});
			return value;
		},
	);
	receiptSpy = spyOn(api, "getNarratorDeviceWorkspaceRequest").mockImplementation(
		async (_id, requestId) => {
			if (selectionState === "unknown" && !receipts.has(requestId))
				throw new Error("receipt unreachable");
			const receipt = receipts.get(requestId);
			if (!receipt) throw new ApiError("not found", 404, { code: "WORKSPACE_REQUEST_NOT_FOUND" });
			return receipt;
		},
	);
	recoverSpy = spyOn(api, "recoverNarratorDeviceWorkspaceRequest").mockImplementation(
		async (_id, requestId) => {
			const receipt = receipts.get(requestId);
			if (!receipt) throw new Error("missing");
			receipt.installState = "installed";
			return receipt.result;
		},
	);
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
	mock.restore();
});
afterAll(() => {
	for (const [key, descriptor] of originals)
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
});
const close = mock(() => {});
function OperationalProbe({ narratorId }: { narratorId: string }) {
	const { data } = useWorkspaceContext(narratorId);
	return <output data-operational>{data ? `${data.deviceId}:${data.cwd}` : "paused"}</output>;
}
async function renderModal({
	narratorId = "n1",
	deviceId = "win",
	opened = true,
	mode = "configureAndSelect" as "configure" | "configureAndSelect",
} = {}) {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<WorkspaceTargetPickerModal
					narratorId={narratorId}
					deviceId={deviceId}
					deviceLabel={deviceId}
					opened={opened}
					mode={mode}
					onClose={close}
				/>
				<OperationalProbe narratorId={narratorId} />
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await flush();
	});
}
async function click(text: string) {
	const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.textContent === text,
	);
	if (!button) throw new Error(`button missing: ${text}`);
	await act(async () => {
		button.click();
		await flush();
	});
}
function field() {
	return container.querySelector<HTMLInputElement>("[data-directory]") as HTMLInputElement;
}
async function input(value: string) {
	await act(async () => {
		field().value = value;
		field().dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}
function mobileProps() {
	return {
		narratorId: "n1",
		headerHostCapabilities: ["inline", "drawer"] as const,
		dock: null,
		gitWorkspaceAvailable: true,
		tasksSupported: true,
		tasksButtonEnabled: true,
		specToolAvailable: true,
		terminalToolAvailable: true,
		onOpenTerminalPanel: undefined,
		browserSessionsSupported: true,
		executionDevicesQuery: { data: { devices } },
		mobileTasksOpen: false,
		mobileToolPanel: null,
		detailsOpened: false,
		terminalToolOpened: false,
		specToolOpened: false,
		setMobileTasksOpen: () => {},
		setMobileToolPanel: () => {},
		toggleDetails: () => {},
		toggleTerminalTool: () => {},
		toggleSpecTool: () => {},
		updateExecutionDeviceMutation: {},
		renderLod: 4 as const,
		renderLodIsDefault: true,
		handleSelectLod: () => {},
		setAsDefault: () => {},
		openPluginPanel: () => {},
		t: (key: string) => key,
	};
}
function Mobile() {
	const toolbar = useHeaderToolbar(mobileProps());
	return (
		<>
			{toolbar.renderToolbarInlineOptions("device", () => {})}
			{toolbar.toolbarOverlays}
			<OperationalProbe narratorId="n1" />
		</>
	);
}
async function renderMenu(mobile: boolean) {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				{mobile ? (
					<Mobile />
				) : (
					<>
						<ExecutionDeviceMenu
							narratorId="n1"
							label="devices"
							localLabel="Local"
							offlineLabel="Offline"
							currentDeviceId="local"
							devices={devices}
						/>
						<OperationalProbe narratorId="n1" />
					</>
				)}
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await flush();
	});
}

test("pair-specific local/Windows/Linux prefill resets on same mounted device and narrator changes, never uses host defaults", async () => {
	close.mockClear();
	await renderModal();
	expect(field().value).toBe("C:\\n1");
	await input("C:\\typed");
	await renderModal({ deviceId: "linux" });
	expect(field().value).toBe("/n1/linux");
	await renderModal({ deviceId: "local" });
	expect(field().value).toBe("/n1/local");
	await renderModal({ narratorId: "n2" });
	expect(field().value).toBe("D:\\n2");
	await renderModal({ narratorId: "n2", deviceId: "linux" });
	expect(field().value).toBe("");
});
test("closed and reopened mounted modal discards old text and late summaries cannot overwrite typed text", async () => {
	let done: ((value: ListNarratorDeviceWorkspacesResult) => void) | undefined;
	getPage = () =>
		new Promise((resolve) => {
			done = resolve;
		});
	await renderModal();
	await input("C:\\typed");
	await act(async () => {
		done?.({ items: summaries.get("n1") ?? [], nextCursor: null });
		await flush();
	});
	expect(field().value).toBe("C:\\typed");
	getPage = undefined;
	await renderModal({ opened: false });
	await renderModal();
	expect(field().value).toBe("C:\\n1");
});
test("a missing summary in an unfinished page is unknown and cannot submit expected binding revision zero", async () => {
	getPage = async (_id, cursor) =>
		cursor
			? { items: [summary("win", "C:\\paged", 9)], nextCursor: null }
			: { items: [summary("local", "/n1/local")], nextCursor: "p2" };
	await renderModal();
	await input("C:\\typed");
	await click("deviceWorkspace.configureAndSelect");
	expect(setSpy).not.toHaveBeenCalled();
	await click("deviceWorkspace.loadMore");
	expect(field().value).toBe("C:\\typed");
	await click("deviceWorkspace.configureAndSelect");
	expect(setSpy.mock.calls[0]?.[1].expectedBindingRevision).toBe(9);
});
test("saving inactive directory changes neither selection nor operational local cwd", async () => {
	await renderModal({ mode: "configure" });
	await input("C:\\saved");
	await click("deviceWorkspace.saveOnly");
	expect(selectSpy).not.toHaveBeenCalled();
	expect(setSpy.mock.calls[0]?.[1].expectedSelectionRevision).toBeUndefined();
	expect(contexts.get("n1")?.deviceId).toBe("local");
	expect(container.querySelector("[data-operational]")?.textContent).toBe("local:/n1/local");
});
for (const mobile of [false, true])
	test(`${mobile ? "mobile" : "desktop"} mounted rows directly select configured devices without cwd and restore each pair`, async () => {
		await renderMenu(mobile);
		expect(container.textContent).toContain("C:\\n1");
		expect(container.textContent).toContain("/n1/linux");
		await click("WindowsC:\\n1");
		expect(selectSpy.mock.calls[0]?.[1]).toMatchObject({
			deviceId: "win",
			expectedBindingRevision: 2,
			expectedSelectionRevision: 7,
		});
		expect(selectSpy.mock.calls[0]?.[1]).not.toHaveProperty("cwd");
		expect(setSpy).not.toHaveBeenCalled();
		expect(field()).toBeNull();
		await click(`${mobile ? "executionTargetLocal" : "Local"}/n1/local`);
		expect(container.querySelector("[data-operational]")?.textContent).toBe("local:/n1/local");
	});
for (const mobile of [false, true])
	test(`${mobile ? "mobile" : "desktop"} unconfigured device requires explicit directory submission before selecting`, async () => {
		summaries.set(
			"n1",
			(summaries.get("n1") ?? []).filter((item) => item.deviceId !== "win"),
		);
		await renderMenu(mobile);
		await click("WindowsdeviceWorkspace.unconfigured");
		expect(field().value).toBe("");
		expect(selectSpy).not.toHaveBeenCalled();
		expect(setSpy).not.toHaveBeenCalled();
		await input("C:\\chosen");
		await click("deviceWorkspace.configureAndSelect");
		expect(setSpy.mock.calls[0]?.[1]).toMatchObject({
			cwd: "C:\\chosen",
			expectedBindingRevision: 0,
		});
		expect(selectSpy.mock.calls[0]?.[1]).toMatchObject({
			expectedBindingRevision: 1,
			expectedSelectionRevision: 7,
		});
	});
test("configure-and-select keeps the initial user-observed selection CAS through a late set", async () => {
	gate = new Promise((resolve) => {
		resolveGate = resolve;
	});
	await renderModal();
	await click("deviceWorkspace.configureAndSelect");
	await act(async () => {
		const changed = context("linux", "/concurrent", 9);
		contexts.set("n1", changed);
		client.setQueryData<WorkspaceContext>(workspaceContextKey("n1"), changed);
		resolveGate?.();
		await flush();
	});
	expect(selectSpy.mock.calls[0]?.[1].expectedSelectionRevision).toBe(7);
});
test("same-open confirmed binding conflict preserves text and dispatches a new intent only after explicit baseline refresh and second submit", async () => {
	setSpy.mockImplementation(async (id, request) => {
		const actual = summaries.get(id)?.find((item) => item.deviceId === request.deviceId);
		if (actual?.bindingRevision !== request.expectedBindingRevision)
			throw new ApiError("binding revision conflict", 409);
		const value = result(
			id,
			"set",
			request.deviceId,
			request.cwd,
			request.expectedBindingRevision + 1,
		);
		summaries.set(id, [
			...(summaries.get(id) ?? []).filter((item) => item.deviceId !== request.deviceId),
			summary(request.deviceId, request.cwd, value.binding.bindingRevision),
		]);
		receipts.set(request.requestId, {
			requestId: request.requestId,
			kind: "set",
			result: value,
			installState: "installed",
		});
		return value;
	});
	await renderModal();
	await input("C:\\user-proposal");
	summaries.set("n1", [
		...(summaries.get("n1") ?? []).filter((item) => item.deviceId !== "win"),
		summary("win", "C:\\external", 3),
	]);
	contexts.set("n1", context("linux", "/new-current", 9));
	await click("deviceWorkspace.configureAndSelect");
	expect(setSpy.mock.calls[0]?.[1].expectedBindingRevision).toBe(2);
	expect(container.textContent).toContain("deviceWorkspace.not_committed");
	expect(field().value).toBe("C:\\user-proposal");
	expect(selectSpy).not.toHaveBeenCalled();
	await click("deviceWorkspace.configureAndSelect");
	expect(setSpy).toHaveBeenCalledTimes(1);
	await click("deviceWorkspace.refreshBaseline");
	expect(field().value).toBe("C:\\user-proposal");
	expect(setSpy).toHaveBeenCalledTimes(1);
	expect(selectSpy).not.toHaveBeenCalled();
	await click("deviceWorkspace.configureAndSelect");
	expect(setSpy).toHaveBeenCalledTimes(2);
	expect(setSpy.mock.calls[1]?.[1]).toMatchObject({
		cwd: "C:\\user-proposal",
		expectedBindingRevision: 3,
	});
	expect(setSpy.mock.calls[1]?.[1].requestId).not.toBe(setSpy.mock.calls[0]?.[1].requestId);
	expect(selectSpy.mock.calls[0]?.[1]).toMatchObject({
		expectedBindingRevision: 4,
		expectedSelectionRevision: 9,
	});
});
test("same-open baseline refresh cannot prepare or dispatch while the current selection is not installed", async () => {
	selectionState = "not_committed";
	currentInstalled = false;
	await renderModal();
	await input("C:\\kept-proposal");
	await click("deviceWorkspace.configureAndSelect");
	const original = selectSpy.mock.calls[0]?.[1].requestId;
	await click("deviceWorkspace.refreshBaseline");
	expect(field().value).toBe("C:\\kept-proposal");
	expect(container.textContent).toContain("deviceWorkspace.baselineNotReady");
	expect(client.getQueryData<{ phase: string }>(transitionKey("n1"))?.phase).toBe("not_committed");
	await click("deviceWorkspace.configureAndSelect");
	expect(setSpy).toHaveBeenCalledTimes(1);
	expect(selectSpy).toHaveBeenCalledTimes(1);
	expect(receiptSpy.mock.calls.at(-1)).toEqual(["n1", original]);
	expect(recoverSpy).not.toHaveBeenCalled();
});
test("configure and select use different IDs and only confirmed not committed says saved/not switched", async () => {
	selectionState = "not_committed";
	await renderModal();
	await input("C:\\saved");
	await click("deviceWorkspace.configureAndSelect");
	expect(setSpy.mock.calls[0]?.[1].requestId).not.toBe(selectSpy.mock.calls[0]?.[1].requestId);
	expect(selectSpy.mock.calls[0]?.[1]).toMatchObject({
		expectedBindingRevision: 3,
		expectedSelectionRevision: 7,
	});
	expect(container.textContent).toContain("deviceWorkspace.savedNotSelected");
	expect(container.textContent).not.toContain("deviceWorkspace.committed_pending");
});
test("late set after modal changed narrator neither closes new modal nor launches select", async () => {
	close.mockClear();
	gate = new Promise((resolve) => {
		resolveGate = resolve;
	});
	await renderModal();
	await click("deviceWorkspace.configureAndSelect");
	await renderModal({ narratorId: "n2" });
	await input("D:\\new-user");
	await act(async () => {
		resolveGate?.();
		await flush();
	});
	expect(close).not.toHaveBeenCalled();
	expect(selectSpy).not.toHaveBeenCalled();
	expect(field().value).toBe("D:\\new-user");
});
test("late set after close/reopen same mounted modal cannot close or select from a newer open epoch", async () => {
	close.mockClear();
	gate = new Promise((resolve) => {
		resolveGate = resolve;
	});
	await renderModal();
	await click("deviceWorkspace.configureAndSelect");
	await renderModal({ opened: false });
	await renderModal();
	await input("C:\\new-epoch");
	await act(async () => {
		resolveGate?.();
		await flush();
	});
	expect(close).not.toHaveBeenCalled();
	expect(selectSpy).not.toHaveBeenCalled();
	expect(field().value).toBe("C:\\new-epoch");
});
test("durable pending select survives modal close/reopen and newer WS; only original recover installed unpauses", async () => {
	selectionState = "pending";
	await renderModal();
	await click("deviceWorkspace.configureAndSelect");
	const requestId = selectSpy.mock.calls[0]?.[1].requestId;
	expect(container.textContent).toContain("deviceWorkspace.committed_pending");
	expect(container.textContent).not.toContain("deviceWorkspace.refreshBaseline");
	expect(container.textContent).not.toContain("deviceWorkspace.savedNotSelected");
	expect(container.querySelector("[data-operational]")?.textContent).toBe("paused");
	await renderModal({ opened: false });
	await renderModal();
	expect(container.textContent).toContain("deviceWorkspace.committed_pending");
	await act(async () => {
		for (const callback of events)
			callback({ type: "workspace_context_changed", current: context("linux", "/newer", 10) });
		await flush();
	});
	expect(container.querySelector("[data-operational]")?.textContent).toBe("paused");
	expect(client.getQueryData<{ phase: string }>(transitionKey("n1"))?.phase).toBe(
		"committed_pending",
	);
	await click("deviceWorkspace.recover");
	expect(recoverSpy).toHaveBeenCalledWith("n1", requestId);
	expect(selectSpy).toHaveBeenCalledTimes(1);
	expect(client.getQueryData<boolean>(transitionKey("n1"))).toBe(false);
	expect(container.querySelector("[data-operational]")?.textContent).not.toBe("paused");
});
test("unknown select keeps original ID across reopening without guessing chosen target", async () => {
	selectionState = "unknown";
	await renderModal();
	await click("deviceWorkspace.configureAndSelect");
	expect(container.textContent).toContain("deviceWorkspace.unconfirmed");
	expect(container.textContent).not.toContain("deviceWorkspace.refreshBaseline");
	expect(container.textContent).not.toContain("deviceWorkspace.savedNotSelected");
	const intent = client.getQueryData<{ intent: { request: { requestId: string } } }>(
		transitionKey("n1"),
	)?.intent;
	await renderModal({ opened: false });
	await renderModal();
	await click("deviceWorkspace.recover");
	expect(client.getQueryData<{ intent: unknown }>(transitionKey("n1"))?.intent).toEqual(intent);
	expect(selectSpy).toHaveBeenCalledTimes(1);
	expect(container.querySelector("[data-operational]")?.textContent).toBe("paused");
});
test("confirmed CAS non-commit refreshes the actual newer installed selection without resubmitting", async () => {
	currentInstalled = false;
	selectSpy.mockImplementation(async (id) => {
		contexts.set(id, context("linux", "/concurrent/current", 9));
		throw new ApiError("concurrent selection conflict", 409);
	});
	await renderModal();
	await input("C:\\saved");
	await click("deviceWorkspace.configureAndSelect");
	const requestId = selectSpy.mock.calls[0]?.[1].requestId;
	expect(selectSpy.mock.calls[0]?.[1].expectedSelectionRevision).toBe(7);
	expect(container.textContent).toContain("deviceWorkspace.savedNotSelected");
	expect(container.textContent).toContain("deviceWorkspace.not_committed");
	expect(container.textContent).not.toContain("deviceWorkspace.unconfirmed");
	expect(container.querySelector("[data-operational]")?.textContent).toBe("paused");
	await renderModal({ opened: false });
	await renderModal();
	statusSpy.mockRejectedValueOnce(new Error("readiness temporarily unavailable"));
	await click("deviceWorkspace.refreshCurrent");
	expect(client.getQueryData<{ phase: string }>(transitionKey("n1"))?.phase).toBe("not_committed");
	expect(container.querySelector("[data-operational]")?.textContent).toBe("paused");
	currentInstalled = true;
	await click("deviceWorkspace.refreshCurrent");
	expect(receiptSpy.mock.calls.at(-1)).toEqual(["n1", requestId]);
	expect(statusSpy.mock.calls.at(-1)).toEqual(["n1"]);
	expect(client.getQueryData<boolean>(transitionKey("n1"))).toBe(false);
	expect(container.querySelector("[data-operational]")?.textContent).toBe(
		"linux:/concurrent/current",
	);
	expect(selectSpy).toHaveBeenCalledTimes(1);
	expect(setSpy).toHaveBeenCalledTimes(1);
	expect(recoverSpy).not.toHaveBeenCalled();
});
test("superseded request refreshes only the actual current selection and never replays its old target", async () => {
	currentInstalled = false;
	contexts.set("n1", context("linux", "/replacement/current", 11));
	receipts.set("original", {
		requestId: "original",
		kind: "select",
		result: result("n1", "select", "win", "C:\\original", 2),
		installState: "superseded",
	});
	client.setQueryData(workspaceContextKey("n1"), contexts.get("n1"));
	client.setQueryData(transitionKey("n1"), {
		phase: "superseded",
		affectsSelection: true,
		intent: {
			narratorId: "n1",
			kind: "select",
			request: {
				requestId: "original",
				deviceId: "win",
				expectedBindingRevision: 2,
				expectedSelectionRevision: 7,
			},
		},
	});
	await renderModal();
	expect(container.textContent).toContain("deviceWorkspace.superseded");
	expect(container.textContent).not.toContain("deviceWorkspace.refreshBaseline");
	expect(container.textContent).not.toContain("deviceWorkspace.recover");
	await click("deviceWorkspace.refreshCurrent");
	expect(receiptSpy).toHaveBeenCalledWith("n1", "original");
	expect(client.getQueryData<{ phase: string }>(transitionKey("n1"))?.phase).toBe("superseded");
	expect(container.querySelector("[data-operational]")?.textContent).toBe("paused");
	currentInstalled = true;
	await click("deviceWorkspace.refreshCurrent");
	expect(client.getQueryData<boolean>(transitionKey("n1"))).toBe(false);
	expect(container.querySelector("[data-operational]")?.textContent).toBe(
		"linux:/replacement/current",
	);
	expect(selectSpy).not.toHaveBeenCalled();
	expect(setSpy).not.toHaveBeenCalled();
	expect(recoverSpy).not.toHaveBeenCalled();
});
