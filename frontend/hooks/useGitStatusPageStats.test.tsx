import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type {
	GitStatusFilterChar,
	GitStatusPageCacheState,
	GitStatusPageResult,
	GitStatusPageStatsQuery,
	GitStatusPageStatsResponse,
	GitStatusPageStatsRow,
} from "@shared/git-status-page";

type GitStatusPage = Extract<GitStatusPageResult, { status: "ready" }>;
type GitStatusPageStatsResult = Extract<GitStatusPageStatsResponse, { status: "ready" }>;
let publishedStats = 1;
const cacheState = (statsVersion = publishedStats, memberVersion = 1): GitStatusPageCacheState => ({
	status: "ready",
	workerEpoch: "worker",
	memberVersion,
	statsVersion,
	updating: false,
});

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
const listeners = new Map<number, MessageCallback>();
const connections = new Set<(connected: boolean, reconnect: boolean) => void>();
const sent: Record<string, unknown>[] = [];
let nextId = 0;
const transport = {
	connected: true,
	send: (message: Record<string, unknown>) => {
		sent.push(message);
		if (message.type === "git_workspace_subscribe")
			queueMicrotask(() => emit("git_workspace_subscribed", { version: 0 }));
		return true;
	},
	addListener: (_options: unknown, callback: MessageCallback) => {
		const handle = { _id: ++nextId };
		listeners.set(handle._id, callback);
		return handle;
	},
	removeListener: (handle: { _id: number }) => {
		listeners.delete(handle._id);
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
const { StrictMode } = await import("react");
const { invalidateWorkspaceQueries, invalidateGitStatusPushQueries } = await import("./useGit");
const { api } = await import("../lib/api");
const { useGitStatusPageStats } = await import("./useGitStatusPageStats");
const { useGitStatusPages } = await import("./useGitStatusPages");
let latestPages: ReturnType<typeof useGitStatusPages>;
let root: Root;
let client: InstanceType<typeof QueryClient>;
let container: HTMLElement;
let latest: ReturnType<typeof useGitStatusPageStats>;
const target: GitTarget = { narratorId: "n1", workspaceKey: "root-a", canWrite: true };
const file = (
	path: string,
	section: "staged" | "unstaged" = "unstaged",
): GitStatusPageStatsRow => ({ type: "file", section, path });
const directory: GitStatusPageStatsRow = {
	type: "directory",
	section: "unstaged",
	path: "src/deep",
};
const result = (
	query: GitStatusPageStatsQuery | undefined,
	added = 561,
): GitStatusPageStatsResult => {
	if (!query) throw new Error("Missing statistics request");
	return {
		status: "ready",
		cache: cacheState(),
		snapshotId: query.snapshotId,
		rows: query.rows.map((row) => ({ ...row, added, removed: 1, complete: true })),
	};
};
type Props = {
	value?: GitTarget | null;
	snapshotId?: string;
	filter?: GitStatusFilterChar[];
	rows?: GitStatusPageStatsRow[];
};
function Probe({
	value = target,
	snapshotId = "snapshot",
	filter = [],
	rows = [directory],
}: Props) {
	latest = useGitStatusPageStats(value, snapshotId, filter, [{ type: "section" }, ...rows]);
	return <div>{latest.data?.rows.length}</div>;
}
async function flush() {
	for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
async function render(props: Props = {}, strict = false) {
	const tree = (
		<QueryClientProvider client={client}>
			<Probe {...props} />
		</QueryClientProvider>
	);
	root.render(strict ? <StrictMode>{tree}</StrictMode> : tree);
	await flush();
}
function IntegratedProbe({ rows = [directory] }: { rows?: GitStatusPageStatsRow[] }) {
	latestPages = useGitStatusPages(target, [], { autoPageLimit: 1 });
	latest = useGitStatusPageStats(target, latestPages.pages[0]?.snapshotId, [], rows, {
		generation: latestPages.queryGeneration,
		onSnapshotObservation: latestPages.observeSnapshotStats,
	});
	return <div>{latest.data?.rows.length}</div>;
}
async function renderIntegrated(rows?: GitStatusPageStatsRow[]) {
	root.render(
		<QueryClientProvider client={client}>
			<IntegratedProbe rows={rows} />
		</QueryClientProvider>,
	);
	await flush();
	await flush();
}
const expired = () =>
	Object.assign(new Error("expired"), { data: { code: "GIT_STATUS_PAGE_EXPIRED" } });
function statusPage(snapshotId: string, hasMore = false): GitStatusPage {
	return {
		status: "ready",
		cache: cacheState(),
		snapshotId,
		expiresAt: Date.now() + 120_000,
		files: [{ path: "src/deep/file", status: " M" }],
		hasMore,
		nextCursor: hasMore ? "next" : null,
		complete: true,
		counts: {
			totalFiles: hasMore ? 561 : 1,
			staged: 0,
			unstaged: hasMore ? 561 : 1,
			untracked: 0,
			filteredFiles: hasMore ? 561 : 1,
			filteredStaged: 0,
			filteredUnstaged: hasMore ? 561 : 1,
			badgeCounts: { A: 0, M: hasMore ? 561 : 1, D: 0, R: 0, C: 0, U: 0 },
			exact: true,
		},
	};
}
function emit(type: string, extra: Record<string, unknown> = {}) {
	const subscription = sent.filter((message) => message.type === "git_workspace_subscribe").at(-1);
	for (const listener of listeners.values()) listener({ ...subscription, type, ...extra });
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
	publishedStats = 1;
	transport.connected = true;
	Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
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

test("viewport identities ignore count feedback and only fetch missing rows, including unknown observations", async () => {
	const read = spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) => ({
		status: "ready",
		cache: cacheState(),
		snapshotId: query.snapshotId,
		rows: query.rows.map((row) => ({
			...row,
			...(row.path === "unknown" ? { complete: false } : { complete: true, added: 0, removed: 0 }),
		})),
	}));
	const rows = [directory, file("file-201"), file("unknown")];
	await render({ rows });
	expect(read).toHaveBeenCalledTimes(1);
	expect(read.mock.calls[0]?.[1].rows).toEqual(rows);
	expect(latest.rows).toEqual(rows);
	const requestedRows = latest.rows;
	const source = latest.source;
	await render({ rows: rows.map((row) => ({ ...row, added: 999, removed: 12 })) });
	expect(read).toHaveBeenCalledTimes(1);
	expect(latest.source).toBe(source);
	expect(latest.rows).toBe(requestedRows);
	await render({ rows: [file("file-201"), file("file-202")] });
	expect(read.mock.calls[1]?.[1].rows).toEqual([file("file-202")]);
	await render({ rows });
	expect(read).toHaveBeenCalledTimes(2);
	expect(latest.data?.rows.find((row) => row.path === "unknown")).toMatchObject({
		complete: false,
	});
	expect(latest.data?.rows.find((row) => row.path === "file-201")).toMatchObject({
		added: 0,
		removed: 0,
		complete: true,
	});
});

test("a statistics response from before a pause cannot publish after the same subscription is acknowledged", async () => {
	const pending = deferred<GitStatusPageStatsResult>();
	const read = spyOn(api, "getGitStatusPageStats")
		.mockImplementationOnce(() => pending.promise)
		.mockImplementation(async (_target, query) => result(query, 23));
	await render({ rows: [file("private.ts")] });
	const oldSignal = read.mock.calls[0]?.[2];
	const query = read.mock.calls[0]?.[1];
	emit("git_workspace_error", {
		version: 1,
		kind: "retryable",
		code: "DB_READ_WORKER_UNAVAILABLE",
		retrying: true,
	});
	emit("git_workspace_subscribed", { version: 2 });
	await flush();
	expect(oldSignal?.aborted).toBe(true);
	expect(read).toHaveBeenCalledTimes(2);
	expect(latest.data?.rows[0]?.added).toBe(23);
	pending.resolve(result(query, 99));
	await flush();
	expect(latest.data?.rows[0]?.added).toBe(23);
	expect(sent.filter((message) => message.type === "git_workspace_subscribe")).toHaveLength(1);
});

test("batching reuses the existing status page row budget", async () => {
	const read = spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) =>
		result(query),
	);
	await render({ rows: Array.from({ length: 450 }, (_, index) => file(`file-${index}`)) });
	expect(read.mock.calls.map((call) => call[1].rows.length)).toEqual([200, 200, 50]);
	expect(latest.data?.rows).toHaveLength(450);
});

test("ordinary 200-file WS projections and badge pushes never replace viewport statistics", async () => {
	const read = spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) =>
		result(query, 201),
	);
	await render({ rows: [file("file-201")] });
	emit("git_workspace_subscribed", { version: 0 });
	const source = latest.source;
	client.setQueryData(["gitWorkspace", target.narratorId], { workspaceKey: target.workspaceKey });
	emit("git_workspace_snapshot", {
		version: 1,
		view: "details",
		snapshot: {
			revision: 1,
			updating: false,
			lineStats: {
				files: Array.from({ length: 200 }, (_, index) => ({
					path: `file-${index}`,
					unstagedLinesAdded: 999,
					complete: true,
				})),
				linesAdded: 999,
				linesRemoved: 0,
				complete: false,
			},
		},
	});
	invalidateGitStatusPushQueries(client, target.narratorId);
	await flush();
	expect(latest.source).toBe(source);
	expect(read).toHaveBeenCalledTimes(1);
	expect(latest.data?.rows[0]?.added).toBe(201);
});

test("content-only changes keep the same statistics epoch until a newer completed version is published", async () => {
	const old = deferred<GitStatusPageStatsResult>();
	const read = spyOn(api, "getGitStatusPageStats")
		.mockImplementationOnce(() => old.promise)
		.mockImplementation(async (_target, query) => result(query, 44));
	await render();
	emit("git_workspace_subscribed", { version: 0 });
	const source = latest.source;
	emit("git_workspace_changed", {
		version: 1,
		statusPagesChanged: false,
		categories: ["worktree"],
	});
	await flush();
	expect(read.mock.calls[0]?.[2]?.aborted).toBe(false);
	expect(latest.source.epoch).toBe(source.epoch);
	expect(latest.source.updating).toBe(true);
	expect(read).toHaveBeenCalledTimes(1);
	publishedStats = 2;
	emit("git_workspace_snapshot", {
		version: 2,
		view: "details",
		snapshot: { revision: 2, updating: false, statusPages: cacheState() },
	});
	await flush();
	expect(read.mock.calls[0]?.[2]?.aborted).toBe(true);
	expect(latest.source.epoch).not.toBe(source.epoch);
	expect(read).toHaveBeenCalledTimes(2);
	old.resolve(result(read.mock.calls[0]?.[1], 999));
	await flush();
	expect(latest.data?.rows[0]?.added).toBe(44);
});

test("refresh and reconnect renew statistics while unchanged monitor probes retain observations", async () => {
	const read = spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) =>
		result(query),
	);
	await render();
	emit("git_workspace_subscribed", { version: 0 });
	const initial = latest.source.epoch;
	invalidateWorkspaceQueries(client, target);
	await flush();
	expect(latest.source.epoch).toBe(initial);
	expect(read).toHaveBeenCalledTimes(1);
	publishedStats++;
	emit("git_workspace_snapshot", {
		version: 1,
		view: "details",
		snapshot: { revision: 1, updating: false, statusPages: cacheState() },
	});
	await flush();
	expect(latest.source.epoch).not.toBe(initial);
	const refreshedSource = latest.source;
	const refreshedData = latest.data;
	for (const version of [1, 2, 3]) {
		emit("git_workspace_changed", {
			version,
			statusPagesChanged: false,
			statusPagesReliable: false,
			categories: [],
		});
		await flush();
		expect(latest.source).toBe(refreshedSource);
		expect(latest.data).toBe(refreshedData);
		expect(read).toHaveBeenCalledTimes(2);
	}
	transport.connected = false;
	for (const connection of [...connections]) connection(false, false);
	await flush();
	transport.connected = true;
	for (const connection of [...connections]) connection(true, true);
	await flush();
	expect(latest.source.epoch).not.toBe(refreshedSource.epoch);
	expect(read).toHaveBeenCalledTimes(3);
});

test("hide cancels reads, restoring visibility remeasures, and revocation removes all statistics", async () => {
	const pending = deferred<GitStatusPageStatsResult>();
	const read = spyOn(api, "getGitStatusPageStats")
		.mockImplementationOnce(() => pending.promise)
		.mockImplementation(async (_target, query) => result(query, 17));
	await render();
	emit("git_workspace_subscribed", { version: 0 });
	Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
	document.dispatchEvent(new window.Event("visibilitychange"));
	await flush();
	expect(read.mock.calls[0]?.[2]?.aborted).toBe(true);
	expect(latest.data).toBeUndefined();
	pending.resolve(result(read.mock.calls[0]?.[1], 999));
	Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
	document.dispatchEvent(new window.Event("visibilitychange"));
	await flush();
	expect(latest.data?.rows[0]?.added).toBe(17);
	emit("git_workspace_error", { code: "access_denied" });
	await flush();
	expect(latest.data).toBeUndefined();
	expect(read.mock.calls[1]?.[2]?.aborted).toBe(true);
	expect(
		client
			.getQueriesData({ queryKey: ["gitStatusPageStats", target.workspaceKey] })
			.every(([, data]) => data === undefined),
	).toBe(true);
});

test("snapshot, filter and target switches cancel obsolete reads and preserve section identities", async () => {
	const pending = deferred<GitStatusPageStatsResult>();
	const read = spyOn(api, "getGitStatusPageStats")
		.mockImplementationOnce(() => pending.promise)
		.mockImplementation(async (_target, query) => result(query, 18));
	await render();
	await render({
		snapshotId: "new-snapshot",
		filter: ["M", "A"],
		rows: [file("new name", "staged"), file("new name")],
	});
	expect(read.mock.calls[0]?.[2]?.aborted).toBe(true);
	expect(read.mock.calls[1]?.[1]).toMatchObject({
		snapshotId: "new-snapshot",
		filter: ["A", "M"],
		rows: [file("new name", "staged"), file("new name")],
	});
	pending.resolve(result(read.mock.calls[0]?.[1], 999));
	await render({ value: { ...target, workspaceKey: "other" } });
	expect(read.mock.calls[1]?.[2]?.aborted).toBe(true);
	expect(read.mock.calls[2]?.[0].workspaceKey).toBe("other");
	expect(latest.data?.rows[0]?.added).toBe(18);
});

test("StrictMode replay acquires a live epoch and errors do not trigger request loops", async () => {
	const read = spyOn(api, "getGitStatusPageStats").mockImplementation(
		async (_target, query, signal) => {
			signal?.throwIfAborted();
			return result(query);
		},
	);
	await render({}, true);
	expect(latest.data?.rows[0]?.added).toBe(561);
	expect(read.mock.calls.at(-1)?.[2]?.aborted).toBe(false);
	read.mockRejectedValue(new Error("measurement failed"));
	void client.invalidateQueries({ queryKey: ["gitStatusPageStats", target.workspaceKey] });
	await flush();
	const count = read.mock.calls.length;
	await render({}, true);
	expect(latest.data).toBeUndefined();
	expect(latest.error?.message).toBe("measurement failed");
	expect(read).toHaveBeenCalledTimes(count);
});

test("failed rows remain unknown until a new observation epoch instead of retrying on scroll", async () => {
	const read = spyOn(api, "getGitStatusPageStats")
		.mockRejectedValueOnce(new Error("failed"))
		.mockImplementation(async (_target, query) => result(query, 8));
	await render({ rows: [file("failed")] });
	expect(latest.error?.message).toBe("failed");
	expect(latest.rows).toEqual([file("failed")]);
	await render({ rows: [file("failed"), file("next")] });
	expect(latest.rows).toEqual([file("failed"), file("next")]);
	expect(read.mock.calls[1]?.[1].rows).toEqual([file("next")]);
	expect(latest.data?.rows.find((row) => row.path === "failed")).toMatchObject({ complete: false });
	await render({ rows: [file("failed")] });
	expect(read).toHaveBeenCalledTimes(2);
});

test("overlapping scroll windows share a slow request and batch newly observed rows", async () => {
	const pending = deferred<GitStatusPageStatsResult>();
	const read = spyOn(api, "getGitStatusPageStats")
		.mockImplementationOnce(() => pending.promise)
		.mockImplementation(async (_target, query) => result(query, 8));
	const rows = (start: number) =>
		Array.from({ length: 20 }, (_, index) => file(`file-${start + index}`));
	await render({ rows: rows(0) });
	const source = latest.source;
	for (let start = 1; start <= 8; start++) {
		await render({ rows: rows(start) });
		expect(read).toHaveBeenCalledTimes(1);
		expect(read.mock.calls[0]?.[2]?.aborted).toBe(false);
		expect(latest.source).toBe(source);
	}
	pending.resolve(result(read.mock.calls[0]?.[1]));
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(read.mock.calls[1]?.[1].rows).toEqual(
		Array.from({ length: 8 }, (_, index) => file(`file-${20 + index}`)),
	);
	expect(latest.data?.rows).toHaveLength(20);
});

test("jumping across disjoint windows releases queued history and requests only current demand", async () => {
	const pending = deferred<GitStatusPageStatsResult>();
	const read = spyOn(api, "getGitStatusPageStats")
		.mockImplementationOnce(() => pending.promise)
		.mockImplementation(async (_target, query) => result(query, 8));
	const rows = (start: number) =>
		Array.from({ length: 160 }, (_, index) => file(`file-${start + index}`));
	await render({ rows: rows(0) });
	for (const start of [1000, 2000, 3000, 4000]) {
		await render({ rows: rows(start) });
		expect(read).toHaveBeenCalledTimes(1);
		expect(read.mock.calls[0]?.[2]?.aborted).toBe(false);
	}
	pending.resolve(result(read.mock.calls[0]?.[1]));
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(read.mock.calls[1]?.[1].rows).toEqual(rows(4000));
	expect(latest.data?.rows).toHaveLength(160);
	await render({ rows: rows(1000) });
	expect(read).toHaveBeenCalledTimes(3);
	expect(read.mock.calls[2]?.[1].rows).toEqual(rows(1000));
});

test("epoch replacement cancels shared in-flight and queued scroll observations", async () => {
	const pending = deferred<GitStatusPageStatsResult>();
	const read = spyOn(api, "getGitStatusPageStats")
		.mockImplementationOnce(() => pending.promise)
		.mockImplementation(async (_target, query) => result(query, 17));
	await render({ rows: [file("first"), file("shared")] });
	await render({ rows: [file("shared"), file("queued")] });
	expect(read).toHaveBeenCalledTimes(1);
	void client.invalidateQueries({ queryKey: ["gitStatusPageStats", target.workspaceKey] });
	await flush();
	expect(read.mock.calls[0]?.[2]?.aborted).toBe(true);
	expect(read).toHaveBeenCalledTimes(2);
	expect(read.mock.calls[1]?.[1].rows).toEqual([file("shared"), file("queued")]);
	pending.resolve(result(read.mock.calls[0]?.[1], 999));
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(latest.data?.rows.every((row) => row.added === 17)).toBe(true);
});

test("expired snapshots remain recoverable rather than entering the unknown measurement cache", async () => {
	const read = spyOn(api, "getGitStatusPageStats")
		.mockRejectedValueOnce(expired())
		.mockImplementation(async (_target, query) => result(query, 7));
	await render({ rows: [file("expired")] });
	await render({ rows: [file("expired"), file("next")] });
	expect(read).toHaveBeenCalledTimes(1);
	latest.retry();
	await flush();
	expect(read.mock.calls[1]?.[1].rows).toEqual([file("expired"), file("next")]);
	expect(latest.data?.rows.every((row) => row.added === 7)).toBe(true);
});

test.each([
	false,
	true,
])("statistics recovery requires a stable complete measured handoff (hasMore=%s)", async (hasMore) => {
	let now = Date.now();
	spyOn(Date, "now").mockImplementation(() => now);
	const pages = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(statusPage("old", hasMore))
		.mockResolvedValueOnce(statusPage("fresh", hasMore))
		.mockResolvedValue(statusPage("later", hasMore));
	const read = spyOn(api, "getGitStatusPageStats")
		.mockRejectedValueOnce(expired())
		.mockImplementation(async (_target, query) => result(query, 12));
	await renderIntegrated();
	expect(pages).toHaveBeenCalledTimes(2);
	expect(latestPages.pages[0]?.snapshotId).toBe("fresh");
	expect(latest.data?.snapshotId).toBe("fresh");
	expect(latest.data?.rows[0]?.added).toBe(12);
	now += 1_100;
	read.mockRejectedValueOnce(expired());
	void client.invalidateQueries({ queryKey: ["gitStatusPageStats", target.workspaceKey] });
	await flush();
	await flush();
	if (hasMore) {
		expect(pages).toHaveBeenCalledTimes(2);
		expect(latestPages.snapshotValid).toBe(false);
		expect(latestPages.error?.message).toContain("expired");
	} else {
		expect(pages).toHaveBeenCalledTimes(3);
		expect(latestPages.pages[0]?.snapshotId).toBe("later");
		expect(latestPages.error).toBeNull();
		expect(latestPages.snapshotValid).toBe(true);
		expect(latest.data?.snapshotId).toBe("later");
	}
});

test.each([
	false,
	true,
])("repeated immediate statistics expiry stops at the existing recovery guard (hasMore=%s)", async (hasMore) => {
	let id = 0;
	const pages = spyOn(api, "getGitStatusPage").mockImplementation(async () =>
		statusPage(`snapshot-${++id}`, hasMore),
	);
	const read = spyOn(api, "getGitStatusPageStats").mockRejectedValue(expired());
	await renderIntegrated();
	await flush();
	await flush();
	expect(pages).toHaveBeenCalledTimes(2);
	expect(read).toHaveBeenCalledTimes(2);
	expect(latest.data).toBeUndefined();
	latestPages.reset();
	await flush();
	await flush();
	expect(pages).toHaveBeenCalledTimes(4);
	expect(read).toHaveBeenCalledTimes(4);
});

test("late expiry and callbacks from an old generation cannot restart the replacement page chain", async () => {
	let rejectOld!: (error: Error) => void;
	const pending = new Promise<GitStatusPageStatsResult>((_done, fail) => {
		rejectOld = fail;
	});
	const pages = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(statusPage("old"))
		.mockResolvedValue(statusPage("fresh"));
	const read = spyOn(api, "getGitStatusPageStats")
		.mockImplementationOnce(() => pending)
		.mockImplementation(async (_target, query) => result(query, 23));
	await renderIntegrated();
	const oldGeneration = latestPages.queryGeneration;
	const oldObservation = latestPages.observeSnapshotStats;
	latestPages.reset();
	await flush();
	await flush();
	const generation = latestPages.queryGeneration;
	expect(read.mock.calls[0]?.[2]?.aborted).toBe(true);
	rejectOld(expired());
	oldObservation({ snapshotId: "old", generation: oldGeneration, expired: true });
	latestPages.observeSnapshotStats({ snapshotId: "old", generation, expired: true });
	latestPages.observeSnapshotStats({
		snapshotId: "fresh",
		generation: oldGeneration,
		expired: true,
	});
	await flush();
	expect(latestPages.queryGeneration).toBe(generation);
	expect(pages).toHaveBeenCalledTimes(2);
	expect(latest.data?.rows[0]?.added).toBe(23);
});

test.each([
	"active",
	"stats-epoch",
	"page-generation",
] as const)("an epoch batch reports expiry while the viewport is cached (scope=%s)", async (scope) => {
	let rejectSlow!: (error: Error) => void;
	const slow = new Promise<GitStatusPageStatsResult>((_done, fail) => {
		rejectSlow = fail;
	});
	const observedPage = (snapshotId: string) => {
		const page = statusPage(snapshotId);
		page.files = [
			{ path: "src/deep/a", status: " M" },
			{ path: "src/deep/b", status: " M" },
		];
		page.counts.totalFiles =
			page.counts.unstaged =
			page.counts.filteredFiles =
			page.counts.filteredUnstaged =
			page.counts.badgeCounts.M =
				2;
		return page;
	};
	const pages = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(observedPage("old"))
		.mockResolvedValue(observedPage("fresh"));
	const read = spyOn(api, "getGitStatusPageStats")
		.mockImplementationOnce(async (_target, query) => result(query, 5))
		.mockImplementationOnce(() => slow)
		.mockImplementation(async (_target, query) => result(query, 7));
	await renderIntegrated([file("src/deep/b")]);
	await renderIntegrated([file("src/deep/a")]);
	await renderIntegrated([file("src/deep/b")]);
	expect(read).toHaveBeenCalledTimes(2);
	expect(read.mock.calls[1]?.[2]?.aborted).toBe(false);
	expect(latest.data?.rows[0]?.added).toBe(5);
	if (scope === "stats-epoch") {
		void client.invalidateQueries({ queryKey: ["gitStatusPageStats", target.workspaceKey] });
		await flush();
		await flush();
	} else if (scope === "page-generation") {
		latestPages.reset();
		await flush();
		await flush();
	}
	const generation = latestPages.queryGeneration;
	rejectSlow(expired());
	await flush();
	await flush();
	expect(pages).toHaveBeenCalledTimes(scope === "stats-epoch" ? 1 : 2);
	expect(read).toHaveBeenCalledTimes(3);
	expect(latest.data?.rows[0]?.added).toBe(7);
	if (scope === "active") expect(latestPages.queryGeneration).not.toBe(generation);
	else expect(latestPages.queryGeneration).toBe(generation);
});

for (const status of [401, 403, 404]) {
	for (const owner of ["active", "renewed"] as const) {
		test(`late HTTP ${status} from a cancelled viewport revokes only its ${owner} epoch`, async () => {
			let rejectSlow!: (error: Error) => void;
			const slow = new Promise<GitStatusPageStatsResult>((_done, fail) => {
				rejectSlow = fail;
			});
			const read = spyOn(api, "getGitStatusPageStats")
				.mockImplementationOnce(async (_target, query) => result(query, 5))
				.mockImplementationOnce(() => slow)
				.mockImplementation(async (_target, query) => result(query, 7));
			await render({ rows: [file("cached.ts")] });
			await render({ rows: [file("slow.ts")] });
			await render({ rows: [file("cached.ts")] });
			expect(read).toHaveBeenCalledTimes(2);
			expect(latest.data?.rows[0]?.added).toBe(5);
			if (owner === "renewed") {
				latest.retry();
				await flush();
			}
			rejectSlow(Object.assign(new Error(`late HTTP ${status}`), { status }));
			await flush();
			if (owner === "active") {
				expect(latest.readRefused).toBe(true);
				expect(latest.displayAllowed).toBe(false);
				expect(latest.data).toBeUndefined();
				expect(read).toHaveBeenCalledTimes(2);
			} else {
				expect(latest.readRefused).toBe(false);
				expect(latest.displayAllowed).toBe(true);
				expect(latest.data?.rows[0]?.added).toBe(7);
				expect(read).toHaveBeenCalledTimes(3);
			}
		});
	}

	test(`HTTP ${status} hides statistics for the entire epoch and permits explicit retry`, async () => {
		const read = spyOn(api, "getGitStatusPageStats")
			.mockImplementationOnce(async (_target, query) => result(query, 17))
			.mockRejectedValueOnce(Object.assign(new Error(`HTTP ${status}`), { status }))
			.mockImplementation(async (_target, query) => result(query, 23));
		await render({ rows: [file("private.ts")] });
		expect(latest.data?.rows[0]?.added).toBe(17);
		await render({ rows: [file("other.ts")] });
		expect(latest.readRefused).toBe(true);
		expect(latest.displayAllowed).toBe(false);
		expect(latest.data).toBeUndefined();
		// A cached earlier viewport cannot revive facts from the refused epoch.
		await render({ rows: [file("private.ts")] });
		expect(latest.displayAllowed).toBe(false);
		expect(latest.data).toBeUndefined();
		latest.retry();
		emit("git_workspace_subscribed", { version: 10 });
		await flush();
		expect(latest.displayAllowed).toBe(true);
		expect(latest.data?.rows[0]?.added).toBe(23);
		expect(read).toHaveBeenCalledTimes(3);
	});
}

test("a mismatched response snapshot cannot publish measurements", async () => {
	spyOn(api, "getGitStatusPageStats").mockImplementation(async (_target, query) => ({
		...result(query),
		snapshotId: "other",
	}));
	await render();
	expect(latest.data).toBeUndefined();
	expect(latest.error?.message).toContain("snapshot changed");
});
