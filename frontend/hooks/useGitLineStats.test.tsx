import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { GitLineStats } from "../../shared/git-line-stats";
import type { GitWorkspaceView } from "../../shared/git-workspace-events";
import type { GitTarget } from "../lib/api/git";
import type { MessageCallback } from "../lib/narrator-ws-manager";

const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: false,
});
mock.module("./useNarrator", () => ({ useNarrator: () => ({ data: undefined }) }));
const wsListeners = new Map<number, MessageCallback>();
const connections = new Set<(connected: boolean, reconnect: boolean) => void>();
const messages: Record<string, unknown>[] = [];
let listenerId = 0;
const transport = {
	connected: false,
	send: (message: Record<string, unknown>) => {
		messages.push(message);
		return true;
	},
	addListener: (_options: unknown, callback: MessageCallback) => {
		const handle = { _id: ++listenerId };
		wsListeners.set(handle._id, callback);
		return handle;
	},
	removeListener: (handle: { _id: number }) => {
		wsListeners.delete(handle._id);
	},
	onConnectionChange: (callback: (connected: boolean, reconnect: boolean) => void) => {
		connections.add(callback);
		return () => {
			connections.delete(callback);
		};
	},
};
mock.module("../lib/narrator-ws-manager", () => ({ narratorWSManager: transport }));
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { api } = await import("../lib/api");
const {
	useGitLineStats,
	useGitStatus,
	useGitBadgeRefresh,
	invalidateWorkspaceQueries,
	invalidateGitStatusPushQueries,
} = await import("./useGit");

let root: Root;
let client: InstanceType<typeof QueryClient>;
let container: HTMLElement;
const target = { narratorId: "n1", workspaceKey: "workspace", canWrite: true };
const stats = (added: number): GitLineStats => ({
	files: [],
	linesAdded: added,
	linesRemoved: 2,
	complete: true,
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function Probe({ target, name }: { target: GitTarget; name: string }) {
	const status = useGitStatus(target);
	const lines = useGitLineStats(target);
	return (
		<div data-probe={name} data-fetching={lines.isFetching} data-error={lines.error?.message}>
			{status.data?.branch}:{lines.isFetching || lines.error ? "unknown" : lines.data?.linesAdded}
		</div>
	);
}
async function flush() {
	for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
async function render(value = target) {
	root.render(
		<QueryClientProvider client={client}>
			<Probe target={value} name="bar" />
			<Probe target={{ ...value, narratorId: "n2" }} name="panel" />
		</QueryClientProvider>,
	);
	await flush();
}
beforeEach(() => {
	transport.connected = false;
	messages.length = 0;
	wsListeners.clear();
	connections.clear();
	Object.defineProperty(document, "visibilityState", {
		value: "visible",
		configurable: true,
		writable: true,
	});
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	spyOn(api, "getGitStatus").mockResolvedValue({ branch: "main", files: [], totalFiles: 1 });
});
afterEach(async () => {
	root.unmount();
	client.clear();
	await flush();
	container.remove();
	mock.restore();
});

function PushProbe({ view = "summary" }: { view?: GitWorkspaceView }) {
	const status = useGitStatus(target, view);
	const lines = useGitLineStats(target, view);
	return (
		<div data-view={view} data-updating={lines.isFetching} data-error={lines.error?.message}>
			{status.data?.branch}:{lines.data?.linesAdded}
		</div>
	);
}
function PushSurface({ panel = false }: { panel?: boolean }) {
	useGitBadgeRefresh();
	return (
		<>
			<PushProbe />
			<PushProbe />
			{panel && <PushProbe view="details" />}
		</>
	);
}
async function renderPush(panel = false) {
	root.render(
		<QueryClientProvider client={client}>
			<PushSurface panel={panel} />
		</QueryClientProvider>,
	);
	await flush();
}
function push(type: string, extra: Record<string, unknown> = {}) {
	const subscribe = messages.filter((message) => message.type === "git_workspace_subscribe").at(-1);
	for (const callback of wsListeners.values())
		callback({
			type,
			subscriptionId: subscribe?.subscriptionId,
			workspaceKey: "workspace",
			repositoryKey: "r",
			...extra,
		});
}
function pushSnapshot(
	version: number,
	view: GitWorkspaceView = "summary",
	updating = false,
	linesAdded = 17,
) {
	push("git_workspace_snapshot", {
		version,
		view,
		snapshot: {
			revision: 1,
			updating,
			status: {
				branch: "main",
				headSha: "sha",
				totalFiles: 1,
				hasChanges: true,
				staged: 0,
				unstaged: 1,
				untracked: 0,
				...(view === "details" ? { files: [{ status: " M", path: "a.ts" }] } : {}),
			},
			lineStats: {
				linesAdded,
				linesRemoved: 2,
				complete: true,
				...(view === "details" ? { files: [] } : {}),
			},
		},
	});
}

test("healthy push shares one grant, keeps summary out of details and performs zero stats GETs", async () => {
	transport.connected = true;
	const statusGet = spyOn(api, "getGitStatus");
	const lineGet = spyOn(api, "getGitLineStats");
	client.setQueryData(["gitWorkspace", "n1"], { state: "ready", workspaceKey: "workspace" });
	await renderPush();
	expect(messages.filter((message) => message.type === "git_workspace_subscribe")).toHaveLength(1);
	expect(container.textContent).toBe("::");
	push("git_workspace_subscribed", { version: 0 });
	pushSnapshot(1, "summary", true);
	await flush();
	expect(container.textContent).toBe("main:17main:17");
	expect(container.querySelector("[data-view]")?.getAttribute("data-updating")).toBe("true");
	pushSnapshot(2);
	await flush();
	expect(container.querySelector("[data-view]")?.getAttribute("data-updating")).toBe("false");
	window.dispatchEvent(new window.Event("focus"));
	invalidateGitStatusPushQueries(client, "n1");
	invalidateWorkspaceQueries(client, target, false);
	await flush();
	expect(messages.filter((message) => message.type === "git_workspace_refresh")).toHaveLength(0);
	invalidateWorkspaceQueries(client, target);
	expect(messages.filter((message) => message.type === "git_workspace_refresh")).toHaveLength(1);
	await renderPush(true);
	expect(messages.at(-1)?.view).toBe("details");
	expect(client.getQueryData(["gitStatus", "workspace"])).toBeUndefined();
	expect(messages.at(-1)?.subscriptionId).toBe(messages[0]?.subscriptionId);
	pushSnapshot(3, "details");
	await flush();
	expect(container.textContent).toBe("main:17main:17main:17");
	await renderPush();
	expect(messages.at(-1)?.view).toBe("summary");
	expect(messages.at(-1)?.subscriptionId).toBe(messages[0]?.subscriptionId);
	expect(messages.some((message) => message.type === "git_workspace_unsubscribe")).toBe(false);
	expect(statusGet).not.toHaveBeenCalled();
	expect(lineGet).not.toHaveBeenCalled();
});

test("hidden consumers stop subscriptions and refresh; reconnect resumes via push, disconnected mode shares HTTP", async () => {
	transport.connected = true;
	const statusGet = spyOn(api, "getGitStatus");
	const lineGet = spyOn(api, "getGitLineStats").mockResolvedValue(stats(5));
	await renderPush();
	push("git_workspace_subscribed", { version: 0 });
	pushSnapshot(1);
	await flush();
	Object.defineProperty(document, "visibilityState", {
		value: "hidden",
		configurable: true,
		writable: true,
	});
	document.dispatchEvent(new window.Event("visibilitychange"));
	await flush();
	const beforeRefresh = messages.length;
	invalidateWorkspaceQueries(client, target);
	window.dispatchEvent(new window.Event("focus"));
	expect(messages).toHaveLength(beforeRefresh);
	transport.connected = false;
	for (const callback of connections) callback(false, false);
	await flush();
	expect(lineGet).not.toHaveBeenCalled();
	transport.connected = true;
	for (const callback of connections) callback(true, true);
	Object.defineProperty(document, "visibilityState", {
		value: "visible",
		configurable: true,
		writable: true,
	});
	document.dispatchEvent(new window.Event("visibilitychange"));
	window.dispatchEvent(new window.Event("focus"));
	await flush();
	expect(messages.filter((message) => message.type === "git_workspace_subscribe")).toHaveLength(2);
	push("git_workspace_subscribed", { version: 0 });
	pushSnapshot(1);
	await flush();
	expect(statusGet).not.toHaveBeenCalled();
	expect(lineGet).not.toHaveBeenCalled();
	// A disconnected page reads HTTP once per workspace/projection, not once per dock.
	client.invalidateQueries({ queryKey: ["gitStatus", "workspace"] });
	client.invalidateQueries({ queryKey: ["gitLineStats", "workspace"] });
	transport.connected = false;
	for (const callback of connections) callback(false, false);
	await flush();
	expect(statusGet).toHaveBeenCalledTimes(1);
	expect(lineGet).toHaveBeenCalledTimes(1);
	expect(container.textContent).toBe("main:5main:5");
});

test("HTTP summary and detail consumers share a read; only explicit manual refresh bypasses the server cache", async () => {
	const statusGet = spyOn(api, "getGitStatus");
	const lineGet = spyOn(api, "getGitLineStats").mockResolvedValue(stats(3));
	await renderPush(true);
	expect(statusGet).toHaveBeenCalledTimes(1);
	expect(lineGet).toHaveBeenCalledTimes(1);
	expect(lineGet.mock.calls[0]?.[2]).toBe(false);
	invalidateWorkspaceQueries(client, target);
	await flush();
	expect(lineGet).toHaveBeenCalledTimes(2);
	expect(lineGet.mock.calls[1]?.[2]).toBe(true);
	invalidateWorkspaceQueries(client, target, false);
	await flush();
	expect(lineGet.mock.calls[2]?.[2]).toBe(false);
});

test("WS recovery cancels old HTTP before a push; late GET never overwrites the snapshot", async () => {
	const pending = deferred<GitLineStats>();
	const lineGet = spyOn(api, "getGitLineStats").mockReturnValue(pending.promise);
	await renderPush(true);
	const signal = lineGet.mock.calls[0]?.[1];
	transport.connected = true;
	for (const callback of connections) callback(true, true);
	push("git_workspace_subscribed", { version: 0 });
	pushSnapshot(1, "details", false, 42);
	await flush();
	expect(signal?.aborted).toBe(true);
	expect(container.textContent).toBe("main:42main:42main:42");
	pending.resolve(stats(999));
	await flush();
	expect(container.textContent).toBe("main:42main:42main:42");
	expect(lineGet).toHaveBeenCalledTimes(1);
});

test("push failures retain workspace but never disguise unsupported stats or revoked data", async () => {
	transport.connected = true;
	const lineGet = spyOn(api, "getGitLineStats");
	await renderPush();
	push("git_workspace_subscribed", { version: 0 });
	pushSnapshot(1);
	await flush();
	push("git_workspace_snapshot", {
		version: 2,
		view: "summary",
		snapshot: { revision: 2, updating: false, lineStatsError: "GIT_LINE_STATS_UNSUPPORTED" },
	});
	await flush();
	expect(container.querySelector("[data-view]")?.getAttribute("data-error")).toBe(
		"GIT_LINE_STATS_UNSUPPORTED",
	);
	expect(container.textContent).toBe("main:17main:17");
	push("git_workspace_error", { code: "access_denied" });
	await flush();
	expect(container.textContent).toBe("::");
	expect(container.querySelector("[data-view]")?.getAttribute("data-error")).toBe("access_denied");
	expect(lineGet).not.toHaveBeenCalled();
});

test("two mounted consumers share one cancellable stats query and never wait to show status", async () => {
	const pending = deferred<GitLineStats>();
	const get = spyOn(api, "getGitLineStats").mockReturnValue(pending.promise);
	await render();
	expect(get).toHaveBeenCalledTimes(1);
	expect(get.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
	expect(container.textContent).toBe("main:unknownmain:unknown");
	pending.resolve(stats(17));
	await flush();
	expect(container.textContent).toBe("main:17main:17");
});

test.each([
	503, 501,
])("stats failure %s keeps ready workspace and status without retry or probe", async (status) => {
	client.setQueryData(["gitWorkspace", "n1"], { state: "ready", workspaceKey: "workspace" });
	const reset = spyOn(client, "resetQueries");
	const get = spyOn(api, "getGitLineStats").mockRejectedValue(
		Object.assign(new Error("stats unavailable"), {
			status,
			data: status === 501 ? { code: "GIT_LINE_STATS_UNSUPPORTED" } : undefined,
		}),
	);
	await render();
	expect(get).toHaveBeenCalledTimes(1);
	expect(reset).not.toHaveBeenCalled();
	expect(client.getQueryData(["gitWorkspace", "n1"])).toEqual({
		state: "ready",
		workspaceKey: "workspace",
	});
	expect(container.textContent).toBe("main:unknownmain:unknown");
	expect(container.querySelector('[data-probe="bar"]')?.getAttribute("data-error")).toBe(
		"stats unavailable",
	);
});

test("push, manual refresh and writes invalidate the shared query and update both consumers", async () => {
	client.setQueryData(["gitWorkspace", "n1"], { state: "ready", workspaceKey: "workspace" });
	const get = spyOn(api, "getGitLineStats").mockResolvedValue(stats(1));
	await render();
	expect(container.textContent).toBe("main:1main:1");
	const pending = deferred<GitLineStats>();
	get.mockReturnValue(pending.promise);
	invalidateGitStatusPushQueries(client, "n1");
	await flush();
	expect(container.textContent).toBe("main:unknownmain:unknown");
	pending.resolve(stats(8));
	await flush();
	expect(container.textContent).toBe("main:8main:8");
	get.mockResolvedValue(stats(21));
	invalidateWorkspaceQueries(client, target);
	await flush();
	expect(container.textContent).toBe("main:21main:21");
	expect(get).toHaveBeenCalledTimes(3);
});

test("switching workspace does not display old totals and cancels the abandoned read", async () => {
	const old = deferred<GitLineStats>();
	const next = deferred<GitLineStats>();
	const get = spyOn(api, "getGitLineStats")
		.mockReturnValueOnce(old.promise)
		.mockReturnValue(next.promise);
	await render();
	const signal = get.mock.calls[0]?.[1];
	await render({ ...target, workspaceKey: "other" });
	expect(signal?.aborted).toBe(true);
	old.resolve(stats(999));
	await flush();
	expect(container.textContent).not.toContain("999");
	next.resolve(stats(4));
	await flush();
	expect(container.textContent).toBe("main:4main:4");
});
