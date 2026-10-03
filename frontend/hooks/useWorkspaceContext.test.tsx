import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { WorkspaceContext } from "@shared/workspace-context";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = keys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const listeners = mock((_filter: unknown, _callback: (event: Record<string, unknown>) => void) => ({
	_id: 1,
}));
mock.module("./useNarrator", () => ({
	useFileTreeStatus: () => ({ data: { files: [] }, refetch: async () => {} }),
}));
mock.module("./useNarratorWS", () => ({ useNarratorWS: () => {} }));
mock.module("../components/narrator/file-tree/FileTreeContent", () => ({
	FileTreeContent: ({ root }: { root: string }) => <div data-tree-root={root}>{root}</div>,
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("@mantine/core", () => ({
	Center: ({ children }: { children?: import("react").ReactNode }) => <div>{children}</div>,
	Text: ({ children }: { children?: import("react").ReactNode }) => <span>{children}</span>,
}));
mock.module("../lib/narrator-ws-manager", () => ({
	narratorWSManager: { addListener: listeners, removeListener: () => {} },
}));
const { act } = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { api } = await import("../lib/api");
const {
	applyWorkspaceContext,
	latestWorkspaceContext,
	useWorkspaceContext,
	workspaceContextKey,
	useUpdateExecutionDevice,
	workspaceFileTarget,
} = await import("./useWorkspaceContext");
const { FileTreePanel } = await import("../components/narrator/file-tree/FileTreePanel");
const old: WorkspaceContext = {
	revision: 2,
	deviceId: "local",
	cwd: "/old",
	pathFlavor: "posix",
	contextKey: "old",
	capabilities: { switchDirectory: true },
	git: { workspaceKey: "old-wk", rootPath: "/old", repositoryKey: "repo" },
};
const next: WorkspaceContext = {
	...old,
	revision: 3,
	cwd: "/new",
	contextKey: "new",
	git: { workspaceKey: "new-wk", rootPath: "/new", repositoryKey: "repo" },
};
const remote: WorkspaceContext = {
	...next,
	revision: 4,
	deviceId: "remote",
	cwd: "D:\\remote\\project",
	pathFlavor: "windows",
	contextKey: "remote",
	git: undefined,
	capabilities: { switchDirectory: false, reason: "remote directory unsupported" },
};
function DeviceProbe() {
	const { data } = useWorkspaceContext("n");
	const update = useUpdateExecutionDevice("n");
	const target = workspaceFileTarget(data);
	return (
		<>
			<output data-references>{target ? `${target.deviceId}:${target.cwd}` : "pending"}</output>
			<button type="button" onClick={() => update.mutate("remote")}>
				device
			</button>
			{update.error && <span>{update.error.message}</span>}
			<FileTreePanel narratorId="n" onOpenFile={() => {}} />
		</>
	);
}
async function mountDevices() {
	client.setQueryData(workspaceContextKey("n"), old);
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<DeviceProbe />
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await flush();
	});
}
let root: Root;
let container: HTMLElement;
let client: InstanceType<typeof QueryClient>;
function Probe() {
	const { data } = useWorkspaceContext("n");
	return <output>{data?.contextKey ?? "pending"}</output>;
}
async function flush() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => {
	listeners.mockClear();
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
	mock.restore();
});
afterAll(() => {
	for (const [key, value] of originals) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
});
test("an older revision can never undo a completed switch", () => {
	expect(latestWorkspaceContext(next, old)).toBe(next);
	expect(latestWorkspaceContext(old, next)).toBe(next);
});
test("late context read is rejected even if it began before the switch", async () => {
	let resolve: ((value: WorkspaceContext) => void) | undefined;
	const deferred = new Promise<WorkspaceContext>((done) => {
		resolve = done;
	});
	const spy = (await import("bun:test"))
		.spyOn(api, "getWorkspaceContext")
		.mockReturnValue(deferred);
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<Probe />
			</QueryClientProvider>,
		);
		await flush();
	});
	expect(container.textContent).toBe("pending");
	await act(async () => {
		applyWorkspaceContext(client, "n", next);
		await flush();
	});
	expect(container.textContent).toBe("new");
	await act(async () => {
		resolve?.(old);
		await flush();
	});
	expect(client.getQueryData<WorkspaceContext>(workspaceContextKey("n"))).toEqual(next);
	expect(container.textContent).toBe("new");
	spy.mockRestore();
});
test("switch invalidates narrator, Git facts and worktree list, without mutating their roots", () => {
	for (const key of [
		["narrators", "n"],
		["gitWorkspace", "n"],
		["gitStatus", "new-wk"],
		["narratorWorktrees", "n"],
	])
		client.setQueryData(key, { path: "/old-file" });
	applyWorkspaceContext(client, "n", next);
	for (const key of [
		["narrators", "n"],
		["gitWorkspace", "n"],
		["gitStatus", "new-wk"],
		["narratorWorktrees", "n"],
	]) {
		expect(client.getQueryState(key)?.isInvalidated).toBe(true);
		expect(client.getQueryData<{ path: string }>(key)).toEqual({ path: "/old-file" });
	}
});
test("HTTP UI Local→remote refreshes references and tree from the same authorized revision", async () => {
	const { spyOn } = await import("bun:test");
	let resolve:
		| ((result: { defaultDeviceId: string; current: WorkspaceContext }) => void)
		| undefined;
	const response = new Promise<{ defaultDeviceId: string; current: WorkspaceContext }>((done) => {
		resolve = done;
	});
	const read = spyOn(api, "getWorkspaceContext").mockResolvedValue(old);
	const patch = spyOn(api, "updateNarratorDefaultDevice").mockReturnValue(response);
	await mountDevices();
	expect(container.querySelector("[data-references]")?.textContent).toBe("local:/old");
	expect(container.querySelector("[data-tree-root]")?.getAttribute("data-tree-root")).toBe("/old");
	await act(async () => {
		container.querySelector("button")?.click();
		await flush();
	});
	expect(container.querySelector("[data-references]")?.textContent).toBe("pending");
	expect(container.querySelector("[data-tree-root]")).toBeNull();
	read.mockResolvedValue(remote);
	await act(async () => {
		resolve?.({ defaultDeviceId: "remote", current: remote });
		await flush();
	});
	expect(patch).toHaveBeenCalledWith("n", "remote");
	expect(container.querySelector("[data-references]")?.textContent).toBe(
		"remote:D:\\remote\\project",
	);
	expect(container.querySelector("[data-tree-root]")).toBeNull();
	expect(container.textContent).toContain("fileTree.remoteUnsupported");
});
test("model WS SwitchDevice updates references/tree and late local response cannot resurrect old target", async () => {
	const { spyOn } = await import("bun:test");
	let resolve: ((value: WorkspaceContext) => void) | undefined;
	const late = new Promise<WorkspaceContext>((done) => {
		resolve = done;
	});
	spyOn(api, "getWorkspaceContext").mockReturnValue(late);
	client.setQueryData(workspaceContextKey("n"), old);
	await mountDevices();
	await act(async () => {
		listeners.mock.calls[0]?.[1]({ type: "workspace_context_changed", current: remote });
		await flush();
	});
	expect(container.querySelector("[data-references]")?.textContent).toBe(
		"remote:D:\\remote\\project",
	);
	expect(container.querySelector("[data-tree-root]")).toBeNull();
	await act(async () => {
		resolve?.(old);
		await flush();
	});
	expect(container.querySelector("[data-references]")?.textContent).toBe(
		"remote:D:\\remote\\project",
	);
	expect(client.getQueryData<WorkspaceContext>(workspaceContextKey("n"))).toEqual(remote);
});
test.each([
	"busy",
	"offline",
	"unsupported",
])("HTTP device %s failure leaves original identity and surfaces reason", async (reason) => {
	const { spyOn } = await import("bun:test");
	spyOn(api, "getWorkspaceContext").mockResolvedValue(old);
	spyOn(api, "updateNarratorDefaultDevice").mockRejectedValue(new Error(reason));
	await mountDevices();
	await act(async () => {
		container.querySelector("button")?.click();
		await flush();
	});
	expect(container.textContent).toContain(reason);
	expect(container.querySelector("[data-references]")?.textContent).toBe("local:/old");
});
test("legacy HTTP response must get authoritative context, never infer remote cwd from local", async () => {
	const { spyOn } = await import("bun:test");
	const read = spyOn(api, "getWorkspaceContext").mockResolvedValue(old);
	spyOn(api, "updateNarratorDefaultDevice").mockImplementation(async () => {
		read.mockResolvedValue(remote);
		return { defaultDeviceId: "remote" };
	});
	await mountDevices();
	await act(async () => {
		container.querySelector("button")?.click();
		await flush();
	});
	expect(container.querySelector("[data-references]")?.textContent).toBe(
		"remote:D:\\remote\\project",
	);
	expect(container.querySelector("[data-tree-root]")).toBeNull();
});
test("acknowledged device patch with failed context read keeps references/tree disabled", async () => {
	const { spyOn } = await import("bun:test");
	const read = spyOn(api, "getWorkspaceContext").mockResolvedValue(old);
	spyOn(api, "updateNarratorDefaultDevice").mockImplementation(async () => {
		read.mockRejectedValue(new Error("context unavailable"));
		return { defaultDeviceId: "remote" };
	});
	await mountDevices();
	await act(async () => {
		container.querySelector("button")?.click();
		await flush();
	});
	expect(container.querySelector("[data-references]")?.textContent).toBe("pending");
	expect(container.querySelector("[data-tree-root]")).toBeNull();
	expect(container.textContent).toContain("context unavailable");
});
test("multiple context consumers share a single WS listener", async () => {
	(await import("bun:test")).spyOn(api, "getWorkspaceContext").mockResolvedValue(old);
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<Probe />
				<Probe />
			</QueryClientProvider>,
		);
		await flush();
	});
	expect(listeners).toHaveBeenCalledTimes(1);
});
