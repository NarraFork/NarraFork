import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type {
	NarratorDeviceWorkspaceMutationResult,
	WorkspaceContext,
} from "@shared/workspace-context";
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
	useSwitchWorkspaceContext,
	executeDeviceWorkspaceIntent,
	transitionKey,
	deviceWorkspacesKey,
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
	capabilities: { switchDirectory: true, browse: { available: true } },
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
	spyOn(api, "getWorkspaceSelectionStatus").mockImplementation(async (id) => ({
		revision:
			client.getQueryData<WorkspaceContext>(workspaceContextKey(id))?.revision ?? old.revision,
		installed: true,
	}));
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
	expect(container.querySelector("[data-tree-root]")?.getAttribute("data-tree-root")).toBe(
		remote.cwd,
	);
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
	expect(container.querySelector("[data-tree-root]")?.getAttribute("data-tree-root")).toBe(
		remote.cwd,
	);
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
	expect(container.querySelector("[data-tree-root]")?.getAttribute("data-tree-root")).toBe(
		remote.cwd,
	);
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
test("lost workspace switch response recovers only the original durable request receipt", async () => {
	const { spyOn } = await import("bun:test");
	spyOn(api, "getWorkspaceContext").mockResolvedValue(old);
	const submit = spyOn(api, "switchWorkspaceContext").mockRejectedValue(
		new Error("response dropped"),
	);
	const receipt = spyOn(api, "getWorkspaceSwitchRequest").mockResolvedValue({
		requestId: "original-request",
		installState: "installed",
		result: { changed: true, previous: old, current: next },
	});
	function SwitchProbe() {
		const context = useWorkspaceContext("n");
		const mutation = useSwitchWorkspaceContext("n");
		return (
			<>
				<output>{context.data?.cwd ?? "pending"}</output>
				<button
					type="button"
					onClick={() =>
						mutation.mutate({
							requestId: "original-request",
							expectedRevision: 2,
							target: { deviceId: "local", cwd: "/new" },
						})
					}
				>
					switch
				</button>
			</>
		);
	}
	client.setQueryData(workspaceContextKey("n"), old);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<SwitchProbe />
			</QueryClientProvider>,
		),
	);
	await act(async () => {
		container.querySelector("button")?.click();
		await flush();
	});
	expect(submit).toHaveBeenCalledTimes(1);
	expect(receipt).toHaveBeenCalledWith("n", "original-request");
	expect(container.querySelector("output")?.textContent).toBe("/new");
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

function deviceResult(
	kind: "set" | "select",
	selection = true,
): NarratorDeviceWorkspaceMutationResult {
	return {
		kind,
		changed: true,
		binding: {
			id: "binding-b",
			narratorId: "n",
			deviceId: "remote",
			bindingRevision: 2,
			context: remote,
			createdAt: "created",
			updatedAt: "updated",
		},
		...(selection ? { selection: { changed: true, previous: old, current: remote } } : {}),
	};
}
const selectIntent = {
	narratorId: "n",
	kind: "select" as const,
	request: {
		requestId: "original-select",
		deviceId: "remote",
		expectedBindingRevision: 2,
		expectedSelectionRevision: 2,
	},
};

test("independent B set never transitions A or mutates its file root", async () => {
	const result = deviceResult("set", false);
	const set = spyOn(api, "setNarratorDeviceWorkspace").mockResolvedValue(result);
	const receipt = spyOn(api, "getNarratorDeviceWorkspaceRequest").mockResolvedValue({
		requestId: "original-set",
		kind: "set",
		installState: "installed",
		result,
	});
	try {
		client.setQueryData(workspaceContextKey("n"), old);
		await executeDeviceWorkspaceIntent(client, {
			narratorId: "n",
			kind: "set",
			request: {
				requestId: "original-set",
				deviceId: "remote",
				cwd: remote.cwd,
				expectedBindingRevision: 1,
			},
		});
		expect(client.getQueryData<WorkspaceContext>(workspaceContextKey("n"))).toEqual(old);
		expect(client.getQueryData<boolean | Record<string, unknown>>(transitionKey("n"))).toBe(false);
		expect(set).toHaveBeenCalledTimes(1);
	} finally {
		set.mockRestore();
		receipt.mockRestore();
	}
});

test("committed pending selection displays durable B while file operations stay blocked across newer WS", async () => {
	const result = deviceResult("select");
	const select = spyOn(api, "selectNarratorDeviceWorkspace").mockRejectedValue(
		new Error("installation failed"),
	);
	const receipt = spyOn(api, "getNarratorDeviceWorkspaceRequest").mockResolvedValue({
		requestId: "original-select",
		kind: "select",
		installState: "pending",
		result,
	});
	try {
		await mountDevices();
		await expect(executeDeviceWorkspaceIntent(client, selectIntent)).rejects.toMatchObject({
			phase: "committed_pending",
		});
		expect(client.getQueryData<WorkspaceContext>(workspaceContextKey("n"))).toEqual(remote);
		expect(
			client.getQueryData<boolean | Record<string, unknown>>(transitionKey("n")),
		).toMatchObject({
			phase: "committed_pending",
			intent: selectIntent,
		});
		await act(async () => {
			listeners.mock.calls[0]?.[1]({
				type: "workspace_context_changed",
				current: { ...remote, revision: 5 },
			});
			await flush();
		});
		expect(
			client.getQueryData<boolean | Record<string, unknown>>(transitionKey("n")),
		).toMatchObject({ phase: "committed_pending" });
		expect(container.querySelector("[data-references]")?.textContent).toBe("pending");
	} finally {
		select.mockRestore();
		receipt.mockRestore();
	}
});

test("unknown response preserves original ID and only installed original recovery unpauses", async () => {
	const result = deviceResult("select");
	const select = spyOn(api, "selectNarratorDeviceWorkspace").mockRejectedValue(
		new Error("lost response"),
	);
	const receipt = spyOn(api, "getNarratorDeviceWorkspaceRequest").mockRejectedValue(
		new Error("offline"),
	);
	const recover = spyOn(api, "recoverNarratorDeviceWorkspaceRequest").mockResolvedValue(result);
	const current = spyOn(api, "getWorkspaceContext").mockResolvedValue(remote);
	try {
		client.setQueryData(workspaceContextKey("n"), old);
		await expect(executeDeviceWorkspaceIntent(client, selectIntent)).rejects.toMatchObject({
			phase: "unconfirmed",
		});
		expect(client.getQueryData<WorkspaceContext>(workspaceContextKey("n"))).toEqual(old);
		expect(
			client.getQueryData<boolean | Record<string, unknown>>(transitionKey("n")),
		).toMatchObject({
			phase: "unconfirmed",
			intent: selectIntent,
		});
		receipt.mockResolvedValueOnce({
			requestId: "original-select",
			kind: "select",
			installState: "pending",
			result,
		});
		receipt.mockResolvedValueOnce({
			requestId: "original-select",
			kind: "select",
			installState: "installed",
			result,
		});
		await executeDeviceWorkspaceIntent(client, selectIntent, true);
		expect(recover).toHaveBeenCalledWith("n", "original-select");
		expect(select).toHaveBeenCalledTimes(1);
		expect(client.getQueryData<boolean | Record<string, unknown>>(transitionKey("n"))).toBe(false);
		expect(client.getQueryData<WorkspaceContext>(workspaceContextKey("n"))).toEqual(remote);
	} finally {
		select.mockRestore();
		receipt.mockRestore();
		recover.mockRestore();
		current.mockRestore();
	}
});

test("server-confirmed missing receipt classifies uncommitted conflict without guessing the attempted B", async () => {
	const { ApiError } = await import("../lib/api");
	const select = spyOn(api, "selectNarratorDeviceWorkspace").mockRejectedValue(
		new ApiError("CAS conflict", 409),
	);
	const receipt = spyOn(api, "getNarratorDeviceWorkspaceRequest").mockRejectedValue(
		new ApiError("No original receipt", 404, { code: "WORKSPACE_REQUEST_NOT_FOUND" }),
	);
	const current = spyOn(api, "getWorkspaceContext").mockResolvedValue(old);
	try {
		client.setQueryData(workspaceContextKey("n"), old);
		await expect(executeDeviceWorkspaceIntent(client, selectIntent)).rejects.toMatchObject({
			phase: "not_committed",
		});
		expect(client.getQueryData<WorkspaceContext>(workspaceContextKey("n"))).toEqual(old);
		expect(client.getQueryData<boolean | Record<string, unknown>>(transitionKey("n"))).toBe(false);
	} finally {
		select.mockRestore();
		receipt.mockRestore();
		current.mockRestore();
	}
});

test("receipt from another request or kind never clears the original selection barrier", async () => {
	const select = spyOn(api, "selectNarratorDeviceWorkspace").mockResolvedValue(
		deviceResult("select"),
	);
	const receipt = spyOn(api, "getNarratorDeviceWorkspaceRequest").mockResolvedValue({
		requestId: "other",
		kind: "set",
		installState: "installed",
		result: deviceResult("set"),
	});
	try {
		await expect(executeDeviceWorkspaceIntent(client, selectIntent)).rejects.toMatchObject({
			phase: "unconfirmed",
		});
		expect(
			client.getQueryData<boolean | Record<string, unknown>>(transitionKey("n")),
		).toMatchObject({
			phase: "unconfirmed",
			intent: selectIntent,
		});
	} finally {
		select.mockRestore();
		receipt.mockRestore();
	}
});

test("binding-summary invalidation WS carries no target and does not lift pending installation", async () => {
	await mountDevices();
	// This summary has no mounted observer in this test; keep it alive for the WS assertion.
	client.setQueryDefaults(deviceWorkspacesKey("n"), { gcTime: 60_000 });
	client.setQueryData([...deviceWorkspacesKey("n"), undefined], {
		pages: [{ items: [], nextCursor: null }],
		pageParams: [null],
	});
	client.setQueryData(transitionKey("n"), { phase: "committed_pending", intent: selectIntent });
	await act(async () => {
		listeners.mock.calls[0]?.[1]({ type: "device_workspace_bindings_changed", narratorId: "n" });
		await flush();
	});
	expect(client.getQueryState([...deviceWorkspacesKey("n"), undefined])?.isInvalidated).toBe(true);
	expect(client.getQueryData<boolean | Record<string, unknown>>(transitionKey("n"))).toMatchObject({
		phase: "committed_pending",
	});
});

test("inactive unknown set survives modal lifetimes and recovers the original set without pausing A", async () => {
	const intent = {
		narratorId: "n",
		kind: "set" as const,
		request: {
			requestId: "inactive-original",
			deviceId: "remote",
			cwd: remote.cwd,
			expectedBindingRevision: 1,
		},
	};
	const result = deviceResult("set", false);
	const set = spyOn(api, "setNarratorDeviceWorkspace").mockRejectedValue(
		new Error("lost response"),
	);
	const receipt = spyOn(api, "getNarratorDeviceWorkspaceRequest").mockRejectedValue(
		new Error("lookup offline"),
	);
	const current = spyOn(api, "getWorkspaceContext").mockResolvedValue(old);
	try {
		await mountDevices();
		await expect(executeDeviceWorkspaceIntent(client, intent)).rejects.toMatchObject({
			phase: "unconfirmed",
		});
		expect(
			client.getQueryData<boolean | Record<string, unknown>>(transitionKey("n")),
		).toMatchObject({
			phase: "unconfirmed",
			intent,
			affectsSelection: false,
		});
		await act(async () => {
			await flush();
		});
		expect(container.querySelector("[data-references]")?.textContent).toBe("local:/old");
		receipt.mockResolvedValue({
			requestId: "inactive-original",
			kind: "set",
			installState: "installed",
			result,
		});
		await executeDeviceWorkspaceIntent(client, intent, true);
		expect(set).toHaveBeenCalledTimes(1);
		expect(receipt).toHaveBeenLastCalledWith("n", "inactive-original");
		expect(client.getQueryData<boolean | Record<string, unknown>>(transitionKey("n"))).toBe(false);
		expect(client.getQueryData<WorkspaceContext>(workspaceContextKey("n"))).toEqual(old);
	} finally {
		set.mockRestore();
		receipt.mockRestore();
		current.mockRestore();
	}
});

test("no receipt during a network timeout is still unknown, not proof the original request cannot commit", async () => {
	const { ApiError } = await import("../lib/api");
	const select = spyOn(api, "selectNarratorDeviceWorkspace").mockRejectedValue(
		new Error("network timeout"),
	);
	const receipt = spyOn(api, "getNarratorDeviceWorkspaceRequest").mockRejectedValue(
		new ApiError("Not yet recorded", 404, { code: "WORKSPACE_REQUEST_NOT_FOUND" }),
	);
	const current = spyOn(api, "getWorkspaceContext").mockResolvedValue(old);
	try {
		client.setQueryData(workspaceContextKey("n"), old);
		await expect(executeDeviceWorkspaceIntent(client, selectIntent)).rejects.toMatchObject({
			phase: "unconfirmed",
		});
		expect(
			client.getQueryData<boolean | Record<string, unknown>>(transitionKey("n")),
		).toMatchObject({ phase: "unconfirmed", intent: selectIntent });
		expect(current).not.toHaveBeenCalled();
		expect(select).toHaveBeenCalledTimes(1);
	} finally {
		select.mockRestore();
		receipt.mockRestore();
		current.mockRestore();
	}
});

test.each([
	"committed_pending",
	"not_committed",
	"superseded",
] as const)("a failed receipt refresh cannot erase the known %s fact", async (phase) => {
	const receipt = spyOn(api, "getNarratorDeviceWorkspaceRequest").mockRejectedValue(
		new Error("network offline"),
	);
	const select = spyOn(api, "selectNarratorDeviceWorkspace");
	try {
		client.setQueryData(transitionKey("n"), {
			phase,
			intent: selectIntent,
			affectsSelection: true,
		});
		await expect(executeDeviceWorkspaceIntent(client, selectIntent, true)).rejects.toMatchObject({
			phase,
		});
		expect(
			client.getQueryData<boolean | Record<string, unknown>>(transitionKey("n")),
		).toMatchObject({ phase, intent: selectIntent });
		expect(select).not.toHaveBeenCalled();
	} finally {
		receipt.mockRestore();
		select.mockRestore();
	}
});

test("receipt installation alone cannot unpause a newer durable selection still pending on the server", async () => {
	const result = deviceResult("select");
	const select = spyOn(api, "selectNarratorDeviceWorkspace").mockResolvedValue(result);
	const receipt = spyOn(api, "getNarratorDeviceWorkspaceRequest").mockResolvedValue({
		requestId: "original-select",
		kind: "select",
		installState: "installed",
		result,
	});
	const current = spyOn(api, "getWorkspaceContext").mockResolvedValue({
		...remote,
		revision: 9,
		deviceId: "linux-newer",
	});
	const status = spyOn(api, "getWorkspaceSelectionStatus").mockResolvedValue({
		revision: 9,
		installed: false,
	});
	try {
		await expect(executeDeviceWorkspaceIntent(client, selectIntent)).rejects.toMatchObject({
			phase: "committed_pending",
		});
		expect(
			client.getQueryData<boolean | Record<string, unknown>>(transitionKey("n")),
		).toMatchObject({ phase: "committed_pending" });
		expect(client.getQueryData<WorkspaceContext>(workspaceContextKey("n"))?.deviceId).toBe(
			"linux-newer",
		);
	} finally {
		select.mockRestore();
		receipt.mockRestore();
		current.mockRestore();
		status.mockRestore();
	}
});
