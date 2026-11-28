import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type {
	GitStatusPageCacheState,
	GitStatusPageResult,
	GitStatusPageStatsQuery,
	GitStatusPageStatsResponse,
	GitStatusPageStatsRow,
} from "@shared/git-status-page";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
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
const listeners = new Set<MessageCallback>();
const connections = new Set<(connected: boolean, reconnect: boolean) => void>();
const sent: Record<string, unknown>[] = [];
let listenerId = 0;
let eventVersion = 0;
let acknowledge = true;
const transport = {
	connected: true,
	send(message: Record<string, unknown>) {
		sent.push(message);
		if (message.type === "git_workspace_subscribe" && acknowledge)
			queueMicrotask(() => emit("git_workspace_subscribed", {}, message));
		return true;
	},
	addListener(_options: unknown, callback: MessageCallback) {
		listeners.add(callback);
		return { _id: ++listenerId };
	},
	removeListener() {},
	onConnectionChange(callback: (connected: boolean, reconnect: boolean) => void) {
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
const { ApiError } = await import("../lib/api/client");
const { useGitStatusPages } = await import("./useGitStatusPages");
const { useGitStatusPageStats } = await import("./useGitStatusPageStats");
const { useGitStatus, useGitLineStats, useGitLog, useGitStage } = await import("./useGit");
const target: GitTarget = {
	narratorId: "n",
	workspaceKey: "w",
	repositoryKey: "r",
	rootPath: "/root",
	canWrite: true,
};
const state = (
	memberVersion = 1,
	statsVersion = 1,
	workerEpoch = "worker",
): GitStatusPageCacheState => ({
	status: memberVersion ? "ready" : "pending",
	workerEpoch,
	memberVersion,
	statsVersion,
	updating: false,
});
function page(cache = state()): Extract<GitStatusPageResult, { status: "ready" }> {
	return {
		status: "ready",
		cache,
		snapshotId: `${cache.workerEpoch}:${cache.memberVersion}`,
		expiresAt: Date.now() + 120_000,
		files: [{ path: "src/a", status: " M" }],
		hasMore: false,
		nextCursor: null,
		complete: true,
		counts: {
			totalFiles: 1,
			staged: 0,
			unstaged: 1,
			untracked: 0,
			filteredFiles: 1,
			filteredStaged: 0,
			filteredUnstaged: 1,
			badgeCounts: { A: 0, M: 1, D: 0, R: 0, C: 0, U: 0 },
			exact: true,
		},
	};
}
function measured(
	query: GitStatusPageStatsQuery,
	cache = state(),
	added = cache.statsVersion,
): GitStatusPageStatsResponse {
	return {
		status: "ready",
		cache,
		snapshotId: query.snapshotId,
		rows: query.rows.map((row) => ({ ...row, added, removed: 0, complete: true })),
	};
}
function emit(
	type: string,
	extra: Record<string, unknown> = {},
	subscription = sent.filter((message) => message.type === "git_workspace_subscribe").at(-1),
) {
	for (const callback of listeners)
		callback({
			narratorId: target.narratorId,
			workspaceKey: target.workspaceKey,
			repositoryKey: target.repositoryKey,
			subscriptionId: subscription?.subscriptionId,
			type,
			version: ++eventVersion,
			...extra,
		});
}
function publish(cache: GitStatusPageCacheState) {
	emit("git_workspace_snapshot", {
		view: "details",
		snapshot: { revision: eventVersion + 1, updating: cache.updating, statusPages: cache },
	});
}
const row = (path: string): GitStatusPageStatsRow => ({ type: "file", section: "unstaged", path });
let root: Root;
let client: InstanceType<typeof QueryClient>;
let container: HTMLElement;
let latest: ReturnType<typeof useGitStatusPages>;
let stats: ReturnType<typeof useGitStatusPageStats>;
let summary: ReturnType<typeof useGitStatus>;
let overallStats: ReturnType<typeof useGitLineStats>;
let deliveries: number[][];
function Probe({
	rows = [row("src/a")],
	autoPageLimit = 1,
}: {
	rows?: GitStatusPageStatsRow[];
	autoPageLimit?: number;
}) {
	summary = useGitStatus(target, "details", { pushOnly: true });
	overallStats = useGitLineStats(target, "details", { pushOnly: true });
	latest = useGitStatusPages(target, [], { autoPageLimit });
	stats = useGitStatusPageStats(target, latest.pages[0]?.snapshotId, [], rows, {
		generation: latest.queryGeneration,
		cache: latest.cache,
		onSnapshotObservation: latest.observeSnapshotStats,
	});
	if (stats.data) deliveries.push(stats.data.rows.map((item) => item.added ?? -1));
	return <div>{latest.pages[0]?.files[0]?.path}</div>;
}
async function flush() {
	for (let turn = 0; turn < 12; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}
async function render(rows?: GitStatusPageStatsRow[], autoPageLimit = 1) {
	root.render(
		<QueryClientProvider client={client}>
			<Probe rows={rows} autoPageLimit={autoPageLimit} />
		</QueryClientProvider>,
	);
	await flush();
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
beforeEach(() => {
	listeners.clear();
	connections.clear();
	sent.length = 0;
	eventVersion = 0;
	acknowledge = true;
	transport.connected = true;
	deliveries = [];
	Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["auth", "me"], { id: "alice" });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	root.unmount();
	client.clear();
	await flush();
	container.remove();
	mock.restore();
});

test("new statistics preserve an in-flight continuation for the same membership", async () => {
	const pending = deferred<GitStatusPageResult>();
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce({ ...page(), hasMore: true, nextCursor: "second" })
		.mockImplementationOnce(() => pending.promise)
		.mockResolvedValue({ ...page(state(1, 2)), files: [{ path: "src/c", status: " M" }] });
	spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) => measured(query));
	await render();
	const continuation = latest.fetchNextPage();
	await flush();
	publish(state(1, 2));
	await flush();
	pending.resolve({
		...page(),
		files: [{ path: "src/b", status: " M" }],
		hasMore: true,
		nextCursor: "third",
	});
	await continuation;
	await flush();
	expect(latest.pages).toHaveLength(2);
	expect(latest.hasNextPage).toBe(true);
	expect(latest.cache?.statsVersion).toBe(2);
	await latest.fetchNextPage();
	await flush();
	expect(read.mock.calls.at(-1)?.[1]?.cursor).toBe("third");
	expect(latest.pages).toHaveLength(3);
	expect(latest.pages.flatMap((page) => page.files.map((file) => file.path))).toEqual([
		"src/a",
		"src/b",
		"src/c",
	]);
});

test("cached files cannot authorize range writes until their workspace subscription is acknowledged", async () => {
	acknowledge = false;
	const read = spyOn(api, "getGitStatusPage").mockResolvedValue(page());
	spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) => measured(query));
	await render();
	expect(read).not.toHaveBeenCalled();
	expect(latest.pages).toHaveLength(0);
	expect(latest.snapshotValid).toBe(false);
	expect(latest.waitingForConnection).toBe(true);
	emit("git_workspace_subscribed");
	await flush();
	expect(read).toHaveBeenCalledTimes(1);
	expect(latest.snapshotValid).toBe(true);
	expect(latest.waitingForConnection).toBe(false);
});

test("paused pages issue no fallback GET and a pre-pause HTTP result cannot publish after the same id is acknowledged", async () => {
	const pending = deferred<GitStatusPageResult>();
	const fresh = { ...page(state(2, 2)), files: [{ path: "fresh.ts", status: " M" }] };
	const read = spyOn(api, "getGitStatusPage")
		.mockImplementationOnce(() => pending.promise)
		.mockResolvedValue(fresh);
	const native = spyOn(api, "getGitStatus");
	const lines = spyOn(api, "getGitLineStats");
	spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) =>
		measured(query, state(2, 2)),
	);
	await render();
	const id = sent.find((message) => message.type === "git_workspace_subscribe")?.subscriptionId;
	const oldSignal = read.mock.calls[0]?.[2];
	emit("git_workspace_error", {
		kind: "retryable",
		code: "DB_READ_WORKER_UNAVAILABLE",
		retrying: true,
	});
	await flush();
	expect(oldSignal?.aborted).toBe(true);
	expect(latest.pages).toHaveLength(0);
	await summary.refetch();
	await overallStats.refetch();
	await latest.fetchNextPage();
	await flush();
	expect(read).toHaveBeenCalledTimes(1);
	expect(native).not.toHaveBeenCalled();
	expect(lines).not.toHaveBeenCalled();
	emit("git_workspace_error", {
		kind: "retryable",
		code: "DB_READ_WORKER_UNAVAILABLE",
		retrying: false,
	});
	latest.refresh();
	expect(sent.at(-1)).toEqual({ type: "git_workspace_refresh", subscriptionId: id });
	emit("git_workspace_subscribed");
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(latest.pages[0]?.files[0]?.path).toBe("fresh.ts");
	pending.resolve({ ...page(state(1, 1)), files: [{ path: "private-old.ts", status: " M" }] });
	await flush();
	expect(latest.pages[0]?.files[0]?.path).toBe("fresh.ts");
	for (const [, data] of client.getQueriesData<{ pages?: GitStatusPageResult[] }>({
		queryKey: ["gitStatusPages"],
	})) {
		expect(
			data?.pages?.some(
				(value) =>
					value.status === "ready" && value.files.some((file) => file.path === "private-old.ts"),
			),
		).not.toBe(true);
	}
	expect(sent.filter((message) => message.type === "git_workspace_subscribe")).toHaveLength(1);
});

test.each([
	401, 403, 404,
])("automatic reauthorization retires an HTTP %s history refusal", async (status) => {
	let history!: ReturnType<typeof useGitLog>;
	function History() {
		history = useGitLog(target);
		return null;
	}
	const refusal = new ApiError("History read refused", status);
	const commits = [
		{
			sha: "a".repeat(40),
			shortSha: "aaaaaaa",
			message: "Recovered commit",
			author: "Alice",
			date: "2026-06-10",
		},
	];
	const read = spyOn(api, "getGitLog").mockRejectedValueOnce(refusal).mockResolvedValue(commits);
	root.render(
		<QueryClientProvider client={client}>
			<History />
		</QueryClientProvider>,
	);
	await flush();
	expect(history.error).toBe(refusal);
	expect(history.data).toBeUndefined();
	transport.connected = false;
	for (const callback of connections) callback(false, false);
	await flush();
	transport.connected = true;
	for (const callback of connections) callback(true, true);
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(history.data).toEqual(commits);
	expect(history.error).toBeNull();
	expect(history.isError).toBe(false);
	read.mockResolvedValue([]);
	await history.refetch();
	await flush();
	expect(history.data).toEqual([]);
	expect(history.error).toBeNull();
	const nextRefusal = new ApiError("New history refusal", status);
	read.mockRejectedValue(nextRefusal);
	await history.refetch();
	await flush();
	expect(history.error).toBe(nextRefusal);
	expect(history.data).toBeUndefined();
});

test("ordinary facts and mutations cannot dispatch while paused or publish a pre-pause result after a new ack", async () => {
	let log!: ReturnType<typeof useGitLog>;
	let mutation!: ReturnType<typeof useGitStage>;
	function Facts() {
		useGitStatus(target);
		useGitLineStats(target);
		log = useGitLog(target);
		mutation = useGitStage(target);
		return null;
	}
	const oldLog = deferred<Awaited<ReturnType<typeof api.getGitLog>>>();
	const oldWrite = deferred<Awaited<ReturnType<typeof api.gitStage>>>();
	const history = spyOn(api, "getGitLog")
		.mockImplementationOnce(() => oldLog.promise)
		.mockResolvedValue([]);
	const write = spyOn(api, "gitStage").mockImplementation(() => oldWrite.promise);
	const status = spyOn(api, "getGitStatus");
	const lines = spyOn(api, "getGitLineStats");
	root.render(
		<QueryClientProvider client={client}>
			<Facts />
		</QueryClientProvider>,
	);
	await flush();
	expect(history).toHaveBeenCalledTimes(1);
	const result = mutation.mutateAsync({ files: ["before.ts"] }).then(
		() => "published",
		(error: Error) => error.name,
	);
	await flush();
	emit("git_workspace_error", {
		kind: "retryable",
		code: "DB_READ_WORKER_UNAVAILABLE",
		retrying: true,
	});
	await flush();
	expect(log.data).toBeUndefined();
	await log.refetch();
	await expect(mutation.mutateAsync({ files: ["paused.ts"] })).rejects.toThrow(
		"authorization pending",
	);
	expect(history).toHaveBeenCalledTimes(1);
	expect(write).toHaveBeenCalledTimes(1);
	emit("git_workspace_subscribed");
	await flush();
	oldLog.resolve([]);
	oldWrite.resolve({
		hasChanges: false,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		totalFiles: 0,
		files: [],
	});
	expect(await result).toBe("AbortError");
	await flush();
	expect(mutation.data).toBeUndefined();
	expect(log.data).toEqual([]);
	expect(status).not.toHaveBeenCalled();
	expect(lines).not.toHaveBeenCalled();
});

test("cold pending waits without retries, publishes files before statistics, and reads only completed versions", async () => {
	let current = state(0, 0);
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async () =>
		current.memberVersion ? page(current) : { status: "pending", cache: current },
	);
	const lineRead = spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) =>
		measured(query, current),
	);
	await render();
	expect(read).toHaveBeenCalledTimes(1);
	expect(latest.error).toBeNull();
	expect(latest.isCachePending).toBe(true);
	for (let i = 0; i < 3; i++) {
		emit("git_workspace_changed", { categories: ["worktree"] });
		await render();
	}
	expect(read).toHaveBeenCalledTimes(1);
	expect(lineRead).not.toHaveBeenCalled();
	current = { ...state(1, 0), status: "pending", updating: true };
	publish(current);
	await flush();
	expect(container.textContent).toBe("src/a");
	expect(read).toHaveBeenCalledTimes(2);
	expect(lineRead).not.toHaveBeenCalled();
	expect(stats.isSettled).toBe(false);
	expect(stats.error).toBeNull();
	current = state(1, 1);
	publish(current);
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(lineRead).toHaveBeenCalledTimes(1);
	expect(stats.data?.rows[0]?.added).toBe(1);
	publish(current);
	await render();
	expect(lineRead).toHaveBeenCalledTimes(1);
	emit("git_workspace_changed", { categories: ["worktree"] });
	await flush();
	expect(stats.data?.rows[0]?.added).toBe(1);
	expect(stats.updating).toBe(true);
	expect(lineRead).toHaveBeenCalledTimes(1);
	current = state(1, 2);
	publish(current);
	await flush();
	expect(stats.data?.rows[0]?.added).toBe(2);
	expect(read).toHaveBeenCalledTimes(2);
	expect(lineRead).toHaveBeenCalledTimes(2);
});

test("ready arriving before a stale pending response performs only one reconciliation for that membership", async () => {
	const first = deferred<GitStatusPageResult>();
	const read = spyOn(api, "getGitStatusPage")
		.mockImplementationOnce(() => first.promise)
		.mockResolvedValue({ status: "pending", cache: state(0, 0) });
	spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) => measured(query));
	await render();
	publish(state());
	await flush();
	expect(read).toHaveBeenCalledTimes(1);
	first.resolve({ status: "pending", cache: state(0, 0) });
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(latest.error).toBeNull();
	for (let i = 0; i < 3; i++) {
		publish(state());
		await render();
	}
	expect(read).toHaveBeenCalledTimes(2);
	read.mockResolvedValue(page(state(2, 0)));
	publish(state(2, 0));
	await flush();
	expect(read).toHaveBeenCalledTimes(3);
	expect(latest.pages[0]?.snapshotId).toBe("worker:2");
});

test("mixed statistics versions across 200-row batches never publish a mixed aggregate or seed the next epoch", async () => {
	let statsVersion = 1;
	const read = spyOn(api, "getGitStatusPage").mockResolvedValue(page());
	let requests = 0;
	const lineRead = spyOn(api, "getGitStatusPageStats").mockImplementation(
		async (_target, query) => {
			if (++requests === 2) statsVersion = 2;
			return measured(query, state(1, statsVersion));
		},
	);
	await render(Array.from({ length: 450 }, (_, index) => row(`file-${index}`)));
	expect(read).toHaveBeenCalledTimes(1);
	expect(lineRead.mock.calls.map((call) => call[1].rows.length)).toEqual([200, 200, 200, 200, 50]);
	expect(stats.source.statsVersion).toBe(2);
	expect(stats.data?.rows).toHaveLength(450);
	expect(deliveries.length).toBeGreaterThan(0);
	expect(deliveries.every((values) => values.every((value) => value === 2))).toBe(true);
});

test("a pending statistics epoch stays unsettled and scrolling cannot retry it before another ready version", async () => {
	spyOn(api, "getGitStatusPage").mockResolvedValue(page());
	const lineRead = spyOn(api, "getGitStatusPageStats").mockResolvedValue({
		status: "pending",
		cache: state(),
	});
	await render();
	expect(lineRead).toHaveBeenCalledTimes(1);
	expect(stats.error).toBeNull();
	expect(stats.isSettled).toBe(false);
	await render([row("other")]);
	await render([row("src/a")]);
	expect(lineRead).toHaveBeenCalledTimes(1);
	lineRead.mockImplementation(async (_target, query) => measured(query, state(1, 2)));
	publish(state(1, 2));
	await flush();
	expect(lineRead).toHaveBeenCalledTimes(2);
	expect(stats.data?.rows[0]?.added).toBe(2);
});

test("disconnected reads withhold private pages and resume with one cache reconciliation", async () => {
	const statusRead = spyOn(api, "getGitStatus");
	const totalRead = spyOn(api, "getGitLineStats");
	const read = spyOn(api, "getGitStatusPage").mockResolvedValue(page());
	spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) => measured(query));
	await render();
	expect(read).toHaveBeenCalledTimes(1);
	transport.connected = false;
	for (const callback of connections) callback(false, false);
	await flush();
	expect(latest.waitingForConnection).toBe(true);
	expect(latest.pages).toHaveLength(0);
	expect(latest.snapshotValid).toBe(false);
	latest.refresh();
	await summary.refetch();
	await overallStats.refetch();
	await render();
	expect(read).toHaveBeenCalledTimes(1);
	expect(statusRead).not.toHaveBeenCalled();
	expect(totalRead).not.toHaveBeenCalled();
	transport.connected = true;
	for (const callback of connections) callback(true, true);
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(latest.waitingForConnection).toBe(false);
});

test("manual refresh queues background work and waits for publication without reading HTTP immediately", async () => {
	const read = spyOn(api, "getGitStatusPage").mockResolvedValue(page());
	const lineRead = spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) =>
		measured(query),
	);
	await render();
	latest.refresh();
	await flush();
	expect(sent.filter((message) => message.type === "git_workspace_refresh")).toHaveLength(1);
	expect(read).toHaveBeenCalledTimes(1);
	expect(lineRead).toHaveBeenCalledTimes(1);
	expect(latest.snapshotValid).toBe(false);
	lineRead.mockImplementation(async (_target, query) => measured(query, state(1, 2)));
	publish(state(1, 2));
	await flush();
	expect(read).toHaveBeenCalledTimes(1);
	expect(lineRead).toHaveBeenCalledTimes(2);
	expect(latest.snapshotValid).toBe(true);
});

test("explicit refresh replenishes automatic paging after the previous limit", async () => {
	let cache = state();
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) => ({
		...page(cache),
		files: [{ path: `${cache.memberVersion}/${query?.cursor ?? "first"}`, status: " M" }],
		hasMore: true,
		nextCursor: `${Number(query?.cursor ?? 0) + 1}`,
	}));
	spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) =>
		measured(query, cache),
	);
	await render(undefined, 3);
	expect(latest.pages).toHaveLength(3);
	expect(read).toHaveBeenCalledTimes(3);
	const generation = latest.queryGeneration;
	latest.refresh();
	await flush();
	expect(read).toHaveBeenCalledTimes(3);
	cache = state(2, 2);
	publish(cache);
	await flush();
	expect(latest.queryGeneration).not.toBe(generation);
	expect(latest.pages).toHaveLength(3);
	expect(read).toHaveBeenCalledTimes(6);
	expect(latest.pages.every((page) => page.snapshotId === "worker:2")).toBe(true);
});

test("a Worker replacement cancels its old statistics and rejects a late old-Worker completion", async () => {
	const old = deferred<GitStatusPageStatsResponse>();
	let current = state();
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async () => page(current));
	const lineRead = spyOn(api, "getGitStatusPageStats")
		.mockImplementationOnce(() => old.promise)
		.mockImplementation(async (_target, query) => measured(query, current, 9));
	await render();
	current = state(1, 1, "replacement");
	publish(current);
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(lineRead.mock.calls[0]?.[2]?.aborted).toBe(true);
	const oldQuery = lineRead.mock.calls[0]?.[1];
	if (!oldQuery) throw new Error("Missing old statistics request");
	old.resolve(measured(oldQuery, state(), 999));
	await flush();
	expect(stats.source.workerEpoch).toBe("replacement");
	expect(stats.data?.rows[0]?.added).toBe(9);
});

test("a newer same-member statistics notice reconciles an older in-flight ready page once", async () => {
	const first = deferred<GitStatusPageResult>();
	const read = spyOn(api, "getGitStatusPage")
		.mockImplementationOnce(() => first.promise)
		.mockResolvedValue(page(state(1, 2)));
	spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) =>
		measured(query, state(1, 2)),
	);
	await render();
	publish(state(1, 2));
	await flush();
	first.resolve(page(state(1, 1)));
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(latest.isCachePending).toBe(false);
	expect(latest.snapshotValid).toBe(true);
	expect(stats.source.statsVersion).toBe(2);
	expect(stats.data?.rows[0]?.added).toBe(2);
	publish(state(1, 2));
	await render();
	expect(read).toHaveBeenCalledTimes(2);
});

test("HTTP can discover a new Worker before WS without reviving the old Worker or losing range validity", async () => {
	let current = state();
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async () => page(current));
	spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) =>
		measured(query, current),
	);
	await render();
	publish(state());
	await flush();
	current = state(1, 1, "http-worker");
	latest.reset();
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(latest.cache?.workerEpoch).toBe("http-worker");
	expect(latest.snapshotValid).toBe(true);
	expect(stats.data?.rows[0]?.added).toBe(1);
	publish(state());
	await render();
	expect(read).toHaveBeenCalledTimes(2);
	expect(latest.cache?.workerEpoch).toBe("http-worker");
	expect(latest.snapshotValid).toBe(true);
});

test("an initial cache error retains its version and a later ready publication recovers once", async () => {
	const failure: GitStatusPageResult = {
		status: "error",
		cache: {
			...state(0, 0),
			status: "error",
			errorCode: "GIT_STATUS_PAGE_SOURCE_FAILED",
			message: "unavailable",
		},
	};
	const read = spyOn(api, "getGitStatusPage").mockResolvedValue(failure);
	spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) => measured(query));
	await render();
	await render();
	expect(read).toHaveBeenCalledTimes(1);
	expect(latest.error?.message).toBe("unavailable");
	read.mockResolvedValue(page());
	publish(state());
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(latest.error).toBeNull();
	expect(latest.snapshotValid).toBe(true);
	publish(state());
	await render();
	expect(read).toHaveBeenCalledTimes(2);
});

test("successful first and second pages and viewport statistics cannot replenish repeated third-page expiry", async () => {
	const expired = Object.assign(new Error("expired"), { code: "GIT_STATUS_PAGE_EXPIRED" });
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) => {
		if (query?.cursor === "third") throw expired;
		return { ...page(), hasMore: true, nextCursor: query?.cursor ? "third" : "second" };
	});
	spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) => measured(query));
	await render(undefined, 10);
	await flush();
	expect(read).toHaveBeenCalledTimes(6);
	expect(latest.isError).toBe(true);
	await render([row("other")], 10);
	await render([row("src/a")], 10);
	expect(read).toHaveBeenCalledTimes(6);
	expect(latest.snapshotValid).toBe(false);
});

test("a complete measured handoff permits a later independent failure after it is stable", async () => {
	let now = Date.now();
	spyOn(Date, "now").mockImplementation(() => now);
	const expired = Object.assign(new Error("expired"), { code: "GIT_STATUS_PAGE_EXPIRED" });
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async () => page());
	const lines = spyOn(api, "getGitStatusPageStats")
		.mockRejectedValueOnce(expired)
		.mockImplementation(async (_target, query) => measured(query));
	await render();
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(latest.snapshotValid).toBe(true);
	now += 1_100;
	lines.mockRejectedValueOnce(expired);
	stats.retry();
	await flush();
	expect(read).toHaveBeenCalledTimes(3);
	expect(latest.snapshotValid).toBe(true);
	expect(stats.data?.rows[0]?.added).toBe(1);
});

test("expired cursor leases renew once from cache even when statistics are unavailable", async () => {
	const cache = { ...state(1, 0), statsErrorCode: "GIT_STATUS_PAGE_SOURCE_FAILED" };
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce({ ...page(cache), expiresAt: Date.now() + 80 })
		.mockImplementation(async () => page(cache));
	const lines = spyOn(api, "getGitStatusPageStats").mockResolvedValue({ status: "error", cache });
	await render();
	expect(latest.snapshotValid).toBe(true);
	expect(latest.statsError).not.toBeNull();
	await Bun.sleep(90);
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(lines).not.toHaveBeenCalled();
	expect(latest.snapshotValid).toBe(true);
	expect(latest.error).toBeNull();
});

test("new members with unavailable statistics settle as explicit unknown while keeping member ranges valid", async () => {
	let cache: GitStatusPageCacheState = state();
	spyOn(api, "getGitStatusPage").mockImplementation(async () => page(cache));
	const lines = spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) =>
		measured(query, cache),
	);
	await render();
	cache = { ...state(2, 0), statsErrorCode: "STATS_FAILED" };
	publish(cache);
	await flush();
	expect(latest.pages[0]?.snapshotId).toBe("worker:2");
	expect(latest.snapshotValid).toBe(true);
	expect(lines).toHaveBeenCalledTimes(1);
	expect(stats.data).toBeUndefined();
	expect(stats.isSettled).toBe(true);
	expect(stats.isPending).toBe(false);
	expect(stats.error).not.toBeNull();
});

test("failed cache lease renewal stops at the shared recovery ceiling", async () => {
	const expired = Object.assign(new Error("expired"), { code: "GIT_STATUS_PAGE_EXPIRED" });
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce({ ...page(), expiresAt: Date.now() + 80 })
		.mockRejectedValue(expired);
	spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) => measured(query));
	await render();
	await Bun.sleep(90);
	await flush();
	await render();
	expect(read).toHaveBeenCalledTimes(2);
	expect(latest.isError).toBe(true);
	expect(latest.snapshotValid).toBe(false);
});

test("statistics failures preserve membership reliability while member-observation failures retire it", async () => {
	let cache: GitStatusPageCacheState = { ...state(), statsErrorCode: "STATS_FAILED" };
	spyOn(api, "getGitStatusPage").mockImplementation(async () => page(cache));
	spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) =>
		measured(query, cache),
	);
	await render();
	expect(latest.snapshotValid).toBe(true);
	expect(latest.error).toBeNull();
	expect(latest.statsError?.message).toContain("statistics");
	cache = { ...cache, errorCode: "MEMBERS_FAILED", message: "member scan failed" };
	publish(cache);
	await flush();
	expect(latest.snapshotValid).toBe(false);
	expect(latest.error?.message).toBe("member scan failed");
});
