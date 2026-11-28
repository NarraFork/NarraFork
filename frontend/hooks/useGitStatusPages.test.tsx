import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type {
	GitStatusFilterChar,
	GitStatusPageCacheState,
	GitStatusPageResult,
} from "@shared/git-status-page";

type GitStatusPage = Extract<GitStatusPageResult, { status: "ready" }>;
let publishedMember = 1;
const cacheState = (
	memberVersion = publishedMember,
	statsVersion = 1,
): GitStatusPageCacheState => ({
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
let nextId = 0;
const sent: Record<string, unknown>[] = [];
let renderTarget: GitTarget | undefined;
const transport = {
	connected: true,
	send: (message: Record<string, unknown>) => {
		sent.push(message);
		if (message.type === "git_workspace_subscribe")
			queueMicrotask(() =>
				send({
					type: "git_workspace_subscribed",
					subscriptionId: message.subscriptionId,
					workspaceKey: message.workspaceKey,
					narratorId: message.narratorId,
					repositoryKey: renderTarget?.repositoryKey,
					version: 0,
				}),
			);
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
const { invalidateGitStatusPushQueries } = await import("./useGit");
const { api } = await import("../lib/api");
const { GIT_STATUS_PAGE_AUTO_PAGE_LIMIT, useGitStatusPages } = await import("./useGitStatusPages");
let root: Root;
let client: InstanceType<typeof QueryClient>;
let container: HTMLElement;
let latest: ReturnType<typeof useGitStatusPages>;
const target: GitTarget = { narratorId: "n1", workspaceKey: "root-a", canWrite: true };
function page(
	snapshotId: string,
	path: string,
	nextCursor: string | null = null,
	complete = true,
): GitStatusPage {
	return {
		status: "ready",
		cache: cacheState(),
		snapshotId,
		expiresAt: Date.now() + 120_000,
		files: [{ path, status: " M" }],
		hasMore: !!nextCursor,
		nextCursor,
		complete,
		...(complete ? {} : { limitReason: "remote-incomplete" }),
		counts: {
			totalFiles: 561,
			staged: 0,
			unstaged: 561,
			untracked: 0,
			filteredFiles: 561,
			filteredStaged: 0,
			filteredUnstaged: 561,
			badgeCounts: { A: 0, M: 561, D: 0, R: 0, C: 0, U: 0 },
			exact: complete,
		},
	};
}
function Probe({
	value,
	filter,
	enabled = true,
	autoPageLimit,
}: {
	value: GitTarget;
	filter: GitStatusFilterChar[];
	enabled?: boolean;
	autoPageLimit?: number;
}) {
	latest = useGitStatusPages(value, filter, { enabled, autoPageLimit });
	return (
		<div>
			{latest.pages.length}:{latest.queryGeneration}
		</div>
	);
}
async function flush() {
	for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
async function render(
	value = target,
	filter: GitStatusFilterChar[] = [],
	enabled = true,
	strict = false,
	options: { autoPageLimit?: number } = { autoPageLimit: 1 },
) {
	renderTarget = value;
	const surface = (
		<QueryClientProvider client={client}>
			<Probe
				value={value}
				filter={filter}
				enabled={enabled}
				autoPageLimit={options.autoPageLimit}
			/>
		</QueryClientProvider>
	);
	root.render(strict ? <StrictMode>{surface}</StrictMode> : surface);
	await flush();
}
async function settle(condition: () => boolean) {
	for (let attempt = 0; attempt < 150; attempt++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Git status page chain did not settle");
}
function fixturePage(total: number, cursor?: string, size = 100, snapshotId = "fixture") {
	const offset = Number(cursor ?? 0) * size;
	const length = Math.max(0, Math.min(size, total - offset));
	const result = page(
		snapshotId,
		"placeholder",
		offset + length < total ? String(offset / size + 1) : null,
	);
	result.files = Array.from({ length }, (_, index) => ({
		path: `file-${offset + index}`,
		status: " M",
	}));
	result.counts = {
		...result.counts,
		totalFiles: total,
		unstaged: total,
		filteredFiles: total,
		filteredUnstaged: total,
		badgeCounts: { ...result.counts.badgeCounts, M: total },
	};
	return result;
}
function send(data: Record<string, unknown>) {
	for (const callback of listeners.values())
		callback({
			subscriptionId: sent.filter((message) => message.type === "git_workspace_subscribe").at(-1)
				?.subscriptionId,
			narratorId: target.narratorId,
			...data,
		});
}
const backgroundChanges = ["files", "invalidation", "reconnect", "hidden", "disabled"] as const;
async function backgroundChange(change: (typeof backgroundChanges)[number], version = 1) {
	if (change === "files") {
		publishedMember++;
		send({
			type: "git_workspace_changed",
			workspaceKey: target.workspaceKey,
			version: 100 + version * 2,
			categories: ["index"],
			statusPagesChanged: true,
		});
		send({
			type: "git_workspace_snapshot",
			workspaceKey: target.workspaceKey,
			view: "details",
			version: 101 + version * 2,
			snapshot: { revision: version, updating: false, statusPages: cacheState() },
		});
	} else if (change === "invalidation") {
		void client.invalidateQueries({ queryKey: ["gitStatusPages", target.workspaceKey] });
	} else if (change === "reconnect") {
		transport.connected = false;
		for (const callback of [...connections]) callback(false, false);
		await flush();
		transport.connected = true;
		for (const callback of [...connections]) callback(true, true);
	} else if (change === "hidden") {
		Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
		document.dispatchEvent(new window.Event("visibilitychange"));
		await flush();
		Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
		document.dispatchEvent(new window.Event("visibilitychange"));
	} else {
		await render(target, [], false, false, {});
		await render(target, [], true, false, {});
	}
	await flush();
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { resolve, reject, promise };
}
beforeEach(() => {
	listeners.clear();
	connections.clear();
	transport.connected = true;
	sent.length = 0;
	publishedMember = 1;
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

test("StrictMode effect replay acquires a live generation and keeps refresh usable", async () => {
	const read = spyOn(api, "getGitStatusPage").mockImplementation(
		async (_target, _query, signal) => {
			signal?.throwIfAborted();
			return page("strict", "a");
		},
	);
	await render(target, [], true, true);
	expect(latest.pages[0]?.snapshotId).toBe("strict");
	expect(latest.snapshotValid).toBe(true);
	expect(read.mock.calls.at(-1)?.[2]?.aborted).toBe(false);
	const generation = latest.queryGeneration;
	latest.reset();
	await flush();
	expect(latest.queryGeneration).not.toBe(generation);
	expect(latest.snapshotValid).toBe(true);
});

test("repeated legacy badge pushes preserve the independent page chain", async () => {
	const read = spyOn(api, "getGitStatusPage").mockResolvedValue(page("pages", "a", "next"));
	client.setQueryData(["gitWorkspace", target.narratorId], { workspaceKey: target.workspaceKey });
	await render();
	const generation = latest.queryGeneration;
	for (let index = 0; index < 4; index++) invalidateGitStatusPushQueries(client, target.narratorId);
	await flush();
	expect(latest.queryGeneration).toBe(generation);
	expect(latest.pages).toHaveLength(1);
	expect(read).toHaveBeenCalledTimes(1);
});

test("a partial continuation does not replenish the same-version recovery ceiling", async () => {
	const expired = Object.assign(new Error("expired"), {
		data: { code: "GIT_STATUS_PAGE_EXPIRED" },
	});
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(page("first", "a", "expired-1"))
		.mockRejectedValueOnce(expired)
		.mockResolvedValueOnce(page("second", "b", "second-next"))
		.mockResolvedValueOnce(page("second", "c", "expired-2"))
		.mockRejectedValueOnce(expired)
		.mockResolvedValueOnce(page("third", "d"));
	await render();
	await latest.fetchNextPage();
	await flush();
	expect(latest.pages[0]?.snapshotId).toBe("second");
	await latest.fetchNextPage();
	await flush();
	expect(latest.pages).toHaveLength(2);
	await latest.fetchNextPage();
	await flush();
	expect(latest.pages.map((item) => item.snapshotId)).toEqual(["second", "second"]);
	expect(latest.error).toBe(expired);
	expect(latest.snapshotValid).toBe(false);
	expect(read).toHaveBeenCalledTimes(5);
	latest.reset();
	await flush();
	expect(latest.pages.map((item) => item.snapshotId)).toEqual(["third"]);
	expect(read).toHaveBeenCalledTimes(6);
});

test("repeated immediate cursor expiry stops after one automatic recovery and permits manual retry", async () => {
	const expired = Object.assign(new Error("expired"), {
		data: { code: "GIT_STATUS_PAGE_EXPIRED" },
	});
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(page("first", "a", "expired-1"))
		.mockRejectedValueOnce(expired)
		.mockResolvedValueOnce(page("second", "b", "expired-2"))
		.mockRejectedValueOnce(expired)
		.mockResolvedValueOnce(page("manual", "c"));
	await render();
	await latest.fetchNextPage();
	await flush();
	await latest.fetchNextPage();
	await flush();
	expect(read).toHaveBeenCalledTimes(4);
	expect(latest.error).toBe(expired);
	await latest.retry();
	await flush();
	expect(read).toHaveBeenCalledTimes(5);
	expect(latest.pages[0]?.snapshotId).toBe("manual");
});

test("pages append once and expose snapshot counts and terminal-chain completeness", async () => {
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(page("s1", "a", "c1"))
		.mockResolvedValueOnce(page("s1", "b"));
	await render();
	expect(latest.pages).toHaveLength(1);
	expect(latest.counts?.totalFiles).toBe(561);
	expect(latest.pageChainLoaded).toBe(false);
	await latest.fetchNextPage();
	await flush();
	expect(latest.pages.map((item) => item.files[0]?.path)).toEqual(["a", "b"]);
	expect(latest.isComplete).toBe(true);
	expect(latest.snapshotValid).toBe(true);
	expect(read.mock.calls.map((call) => call[1]?.cursor)).toEqual([undefined, "c1"]);
});

test("ordinary query invalidation aborts the old continuation and restarts a single-page chain", async () => {
	const oldPage = deferred<GitStatusPage>();
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(page("old", "a", "old-cursor"))
		.mockImplementationOnce(() => oldPage.promise)
		.mockResolvedValueOnce(page("new", "fresh"));
	await render();
	const generation = latest.queryGeneration;
	const next = latest.fetchNextPage();
	await flush();
	const signal = read.mock.calls[1]?.[2];
	void client.invalidateQueries({ queryKey: ["gitStatusPages", target.workspaceKey] });
	await flush();
	expect(signal?.aborted).toBe(true);
	expect(latest.queryGeneration).not.toBe(generation);
	oldPage.resolve(page("old", "late"));
	await next;
	await flush();
	expect(latest.pages.map((item) => item.snapshotId)).toEqual(["new"]);
	expect(read.mock.calls.map((call) => call[1]?.cursor)).toEqual([
		undefined,
		"old-cursor",
		undefined,
	]);
});

test("workspace and filter changes cancel prior reads and never display prior-generation pages", async () => {
	const pending = deferred<GitStatusPage>();
	const read = spyOn(api, "getGitStatusPage")
		.mockImplementationOnce(() => pending.promise)
		.mockResolvedValue(page("next", "new"));
	await render();
	const signal = read.mock.calls[0]?.[2];
	const generation = latest.queryGeneration;
	await render({ ...target, workspaceKey: "root-b" }, ["M"]);
	expect(signal?.aborted).toBe(true);
	expect(latest.queryGeneration).not.toBe(generation);
	pending.resolve(page("old", "late"));
	await flush();
	expect(latest.pages[0]?.snapshotId).toBe("next");
	expect(read.mock.calls[1]?.[1]?.filter).toEqual(["M"]);
});

test("expired cursor recovers once; repeated expiry does not produce an infinite retry loop", async () => {
	const expired = Object.assign(new Error("expired"), {
		data: { code: "GIT_STATUS_PAGE_EXPIRED" },
	});
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(page("old", "a", "c1"))
		.mockRejectedValue(expired);
	await render();
	const generation = latest.queryGeneration;
	await latest.fetchNextPage();
	await flush();
	expect(latest.queryGeneration).not.toBe(generation);
	expect(read).toHaveBeenCalledTimes(3);
	await flush();
	expect(read).toHaveBeenCalledTimes(3);
	expect(latest.snapshotValid).toBe(false);
	expect(latest.error).toBe(expired);
});

test("loadAll serializes continuation reads and preserves explicitly incomplete terminal pages", async () => {
	let active = 0,
		maximum = 0;
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) => {
		active++;
		maximum = Math.max(maximum, active);
		await Bun.sleep(1);
		active--;
		if (!query?.cursor) return page("all", "a", "c1", false);
		if (query.cursor === "c1") return page("all", "b", "c2", false);
		return page("all", "c", null, false);
	});
	await render();
	const all = latest.loadAll();
	expect(latest.loadAll()).toBe(all);
	await all;
	await flush();
	expect(maximum).toBe(1);
	expect(read).toHaveBeenCalledTimes(3);
	expect(latest.pages).toHaveLength(3);
	expect(latest.pageChainLoaded).toBe(true);
	expect(latest.isComplete).toBe(false);
	expect(latest.limitReason).toBe("remote-incomplete");
	expect(latest.isLoadingAll).toBe(false);
});

test("cancelLoadAll aborts its in-flight page while retaining already loaded pages", async () => {
	const pending = deferred<GitStatusPage>();
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(page("all", "a", "c1"))
		.mockImplementationOnce(() => pending.promise);
	await render();
	const all = latest.loadAll();
	await flush();
	expect(latest.isLoadingAll).toBe(true);
	latest.cancelLoadAll();
	await flush();
	expect(read.mock.calls[1]?.[2]?.aborted).toBe(true);
	pending.resolve(page("all", "late"));
	await all;
	await flush();
	expect(latest.pages).toHaveLength(1);
	expect(latest.isLoadingAll).toBe(false);
	expect(latest.isComplete).toBe(false);
});

test("workspace changes mark updating and only a published membership starts another page chain", async () => {
	const read = spyOn(api, "getGitStatusPage").mockResolvedValue(page("s", "a"));
	await render();
	const generation = latest.queryGeneration;
	const send = (data: Record<string, unknown>) => {
		for (const callback of listeners.values())
			callback({
				subscriptionId: sent.filter((message) => message.type === "git_workspace_subscribe").at(-1)
					?.subscriptionId,
				narratorId: target.narratorId,
				...data,
			});
	};
	send({
		type: "git_workspace_snapshot",
		workspaceKey: target.workspaceKey,
		version: 1,
		snapshot: { revision: 2, updating: true },
	});
	send({
		type: "git_workspace_changed",
		workspaceKey: target.workspaceKey,
		version: 2,
		categories: [],
	});
	send({
		type: "git_workspace_changed",
		workspaceKey: target.workspaceKey,
		version: 3,
		categories: ["stash"],
	});
	await flush();
	expect(latest.queryGeneration).toBe(generation);
	expect(read).toHaveBeenCalledTimes(1);
	const change = {
		type: "git_workspace_changed",
		workspaceKey: target.workspaceKey,
		version: 4,
		categories: ["index"],
	};
	send(change);
	await flush();
	expect(latest.queryGeneration).toBe(generation);
	expect(read).toHaveBeenCalledTimes(1);
	expect(latest.updating).toBe(true);
	publishedMember = 2;
	read.mockResolvedValue(page("s2", "b"));
	send({
		type: "git_workspace_snapshot",
		workspaceKey: target.workspaceKey,
		version: 5,
		view: "details",
		snapshot: { revision: 5, updating: false, statusPages: cacheState() },
	});
	await flush();
	expect(latest.queryGeneration).not.toBe(generation);
	expect(read).toHaveBeenCalledTimes(2);
	send(change);
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
});

test("uncertain statistical pushes retain the page chain and cancel full loading until verified", async () => {
	const pending = deferred<GitStatusPage>();
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(page("observed", "a", "next"))
		.mockImplementationOnce(() => pending.promise)
		.mockImplementationOnce(async () => page("new", "b"));
	await render();
	const generation = latest.queryGeneration;
	const all = latest.loadAll();
	await flush();
	const send = (version: number, statusPagesReliable: boolean, statusPagesChanged = false) => {
		for (const callback of listeners.values())
			callback({
				type: "git_workspace_changed",
				subscriptionId: sent.filter((message) => message.type === "git_workspace_subscribe").at(-1)
					?.subscriptionId,
				workspaceKey: target.workspaceKey,
				narratorId: target.narratorId,
				version,
				categories: ["worktree"],
				statusPagesReliable,
				statusPagesChanged,
			});
		if (statusPagesReliable) {
			if (statusPagesChanged) publishedMember++;
			for (const callback of listeners.values())
				callback({
					type: "git_workspace_snapshot",
					subscriptionId: sent
						.filter((message) => message.type === "git_workspace_subscribe")
						.at(-1)?.subscriptionId,
					workspaceKey: target.workspaceKey,
					narratorId: target.narratorId,
					view: "details",
					version: version * 2 + 10,
					snapshot: { revision: version, updating: false, statusPages: cacheState() },
				});
		}
	};
	send(1, false);
	await flush();
	expect(latest.queryGeneration).toBe(generation);
	expect(latest.pages).toHaveLength(1);
	expect(latest.snapshotValid).toBe(false);
	expect(latest.statusPagesReliable).toBe(false);
	expect(read.mock.calls[1]?.[2]?.aborted).toBe(true);
	pending.resolve(page("observed", "late"));
	await all;
	send(2, true);
	await flush();
	expect(latest.snapshotValid).toBe(true);
	expect(latest.queryGeneration).toBe(generation);
	send(3, true, true);
	await flush();
	expect(latest.queryGeneration).not.toBe(generation);
	expect(latest.pages[0]?.snapshotId).toBe("new");
});

test("snapshot expiry renews its cursor lease once from published cache", async () => {
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async () => ({
		...page("short-lived", "a"),
		expiresAt: Date.now() + 200,
	}));
	await render();
	expect(latest.isComplete).toBe(true);
	await Bun.sleep(210);
	await flush();
	expect(latest.snapshotValid).toBe(true);
	expect(latest.isComplete).toBe(true);
	expect(read).toHaveBeenCalledTimes(2);
});

test("reopening a disabled panel starts a fresh chain after missed notifications", async () => {
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(page("old", "a", "old-cursor"))
		.mockResolvedValueOnce(page("new", "b"));
	await render();
	const generation = latest.queryGeneration;
	await render(target, [], false);
	expect(latest.snapshotValid).toBe(false);
	await render(target);
	expect(latest.queryGeneration).not.toBe(generation);
	expect(latest.pages[0]?.snapshotId).toBe("new");
	expect(read.mock.calls.map((call) => call[1]?.cursor)).toEqual([undefined, undefined]);
});

test("closed panels do not start a detail request", async () => {
	const read = spyOn(api, "getGitStatusPage").mockResolvedValue(page("s", "a"));
	await render(target, [], false);
	expect(read).not.toHaveBeenCalled();
	expect(latest.snapshotValid).toBe(false);
});

for (const [total, autoPageLimit, expectedPages] of [
	[0, undefined, 1],
	[23, undefined, 1],
	[612, undefined, 7],
	[1000, undefined, 10],
	[1001, undefined, 10],
	[10000, undefined, 10],
	[612, 1, 1],
	[612, 3, 3],
	[10000, 10, 10],
] as const) {
	test(`automatic page budget ${autoPageLimit ?? "default"} loads ${expectedPages} pages for ${total} files`, async () => {
		const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) =>
			fixturePage(total, query?.cursor),
		);
		const stats = spyOn(api, "getGitStatusPageStats");
		const diff = spyOn(api, "getGitDiff");
		await render(target, [], true, false, { autoPageLimit });
		await settle(() => latest.pages.length === expectedPages && !latest.isFetching);
		expect(GIT_STATUS_PAGE_AUTO_PAGE_LIMIT).toBe(10);
		expect(latest.pages.flatMap((item) => item.files)).toHaveLength(
			Math.min(total, expectedPages * 100),
		);
		expect(latest.isLoadingAll).toBe(false);
		expect(latest.pageChainLoaded).toBe(total <= expectedPages * 100);
		expect(read.mock.calls.every((call) => call[1]?.limit === 100)).toBe(true);
		expect(read.mock.calls.map((call) => call[1]?.cursor)).toEqual(
			Array.from({ length: expectedPages }, (_, index) => (index ? String(index) : undefined)),
		);
		const generation = latest.queryGeneration;
		await render(target, [], true, false, { autoPageLimit });
		await flush();
		expect(latest.queryGeneration).toBe(generation);
		expect(read).toHaveBeenCalledTimes(expectedPages);
		expect(stats).not.toHaveBeenCalled();
		expect(diff).not.toHaveBeenCalled();
	});
}

test("StrictMode effect replay retains the bounded default automatic chain", async () => {
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query, signal) => {
		signal?.throwIfAborted();
		return fixturePage(10000, query?.cursor);
	});
	await render(target, [], true, true, {});
	await settle(() => latest.pages.length === 10 && !latest.isFetching);
	await flush();
	expect(latest.snapshotValid).toBe(true);
	expect(latest.isLoadingAll).toBe(false);
	expect(
		read.mock.calls.filter((call) => !call[2]?.aborted).map((call) => call[1]?.cursor),
	).toEqual([undefined, "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
});

test("automatic terminal pages preserve scan incompleteness and scope action validity", async () => {
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) => {
		const result = fixturePage(150, query?.cursor);
		return {
			...result,
			complete: false,
			limitReason: "remote-incomplete" as const,
			counts: { ...result.counts, exact: false },
		};
	});
	await render(target, [], true, false, {});
	await settle(() => latest.pages.length === 2 && !latest.isFetching);
	expect(read).toHaveBeenCalledTimes(2);
	expect(latest.pageChainLoaded).toBe(true);
	expect(latest.snapshotValid).toBe(true);
	expect(latest.isComplete).toBe(false);
	expect(latest.complete).toBe(false);
	expect(latest.counts?.exact).toBe(false);
	expect(latest.limitReason).toBe("remote-incomplete");
});

test("byte-limited short pages consume whole automatic page slots", async () => {
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) =>
		fixturePage(10000, query?.cursor, 7),
	);
	await render(target, [], true, false, { autoPageLimit: 3 });
	await settle(() => latest.pages.length === 3 && !latest.isFetching);
	await flush();
	expect(read).toHaveBeenCalledTimes(3);
	expect(latest.pages.flatMap((item) => item.files)).toHaveLength(21);
	expect(latest.hasNextPage).toBe(true);
});

test("automatic and repeated manual reads share one cursor request and do not replenish the budget", async () => {
	const pending = deferred<GitStatusPage>();
	let active = 0;
	let maximum = 0;
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) => {
		active++;
		maximum = Math.max(maximum, active);
		try {
			return query?.cursor === "1" ? await pending.promise : fixturePage(10000, query?.cursor);
		} finally {
			active--;
		}
	});
	await render(target, [], true, false, { autoPageLimit: 3 });
	await settle(() => read.mock.calls.length === 2);
	expect(latest.pages).toHaveLength(1);
	expect(latest.isLoadingAll).toBe(false);
	const first = latest.fetchNextPage();
	const second = latest.fetchNextPage();
	expect(read).toHaveBeenCalledTimes(2);
	pending.resolve(fixturePage(10000, "1"));
	await Promise.all([first, second]);
	await settle(() => latest.pages.length === 3 && !latest.isFetching);
	await latest.fetchNextPage();
	await latest.fetchNextPage();
	await settle(() => latest.pages.length === 5 && !latest.isFetching);
	await flush();
	expect(maximum).toBe(1);
	expect(read.mock.calls.map((call) => call[1]?.cursor)).toEqual([undefined, "1", "2", "3", "4"]);
	expect(latest.isLoadingAll).toBe(false);
});

test("loadAll takes over the in-flight automatic page and finishes the existing chain", async () => {
	const pending = deferred<GitStatusPage>();
	let active = 0;
	let maximum = 0;
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) => {
		active++;
		maximum = Math.max(maximum, active);
		try {
			return query?.cursor === "1" ? await pending.promise : fixturePage(612, query?.cursor);
		} finally {
			active--;
		}
	});
	await render(target, [], true, false, { autoPageLimit: 3 });
	await settle(() => read.mock.calls.length === 2);
	const all = latest.loadAll();
	expect(latest.loadAll()).toBe(all);
	await flush();
	expect(latest.isLoadingAll).toBe(true);
	expect(read).toHaveBeenCalledTimes(2);
	pending.resolve(fixturePage(612, "1"));
	await all;
	await flush();
	expect(maximum).toBe(1);
	expect(read).toHaveBeenCalledTimes(7);
	expect(new Set(read.mock.calls.map((call) => call[1]?.cursor)).size).toBe(7);
	expect(latest.pages.flatMap((item) => item.files)).toHaveLength(612);
	expect(latest.isComplete).toBe(true);
	expect(latest.isLoadingAll).toBe(false);
});

test("a failed automatic page stops its intent; manual retry works and refresh grants a new budget", async () => {
	const failure = new Error("page unavailable");
	let failed = false;
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) => {
		if (query?.cursor === "1" && !failed) {
			failed = true;
			throw failure;
		}
		return fixturePage(10000, query?.cursor);
	});
	await render(target, [], true, false, { autoPageLimit: 3 });
	await settle(() => latest.error === failure);
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	await latest.retry();
	await settle(() => latest.pages.length === 2 && !latest.isFetching);
	await flush();
	expect(read).toHaveBeenCalledTimes(3);
	const generation = latest.queryGeneration;
	latest.reset();
	await settle(() => latest.pages.length === 3 && !latest.isFetching);
	expect(latest.queryGeneration).not.toBe(generation);
	expect(read).toHaveBeenCalledTimes(6);
});

for (const code of ["GIT_STATUS_PAGE_EXPIRED", "GIT_STATUS_PAGE_INVALID_CURSOR"]) {
	for (const position of ["initial", "continuation"] as const) {
		for (const total of [829, 1001]) {
			test(`${position} ${code} recovery resumes automatic pagination for ${total} files with a ten-page limit`, async () => {
				const expired = Object.assign(new Error("expired"), { data: { code } });
				let recovered = false;
				const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) => {
					if (!recovered && (position === "initial" || query?.cursor === "3")) {
						recovered = true;
						throw expired;
					}
					return fixturePage(total, query?.cursor, 100, recovered ? "recovered" : "old");
				});
				await render(target, [], true, false, {});
				const expectedPages = Math.min(10, Math.ceil(total / 100));
				await settle(() => latest.pages.length === expectedPages && !latest.isFetching);
				await flush();
				expect(latest.pages.every((item) => item.snapshotId === "recovered")).toBe(true);
				const files = latest.pages.flatMap((item) => item.files);
				expect(files).toHaveLength(Math.min(total, 1000));
				expect(new Set(files.map((item) => item.path)).size).toBe(files.length);
				expect(latest.error).toBeNull();
				expect(latest.isComplete).toBe(total <= 1000);
				expect(latest.hasNextPage).toBe(total > 1000);
				expect(read).toHaveBeenCalledTimes(expectedPages + (position === "initial" ? 1 : 4));
				expect(read.mock.calls.every((call) => call[1]?.limit === 100)).toBe(true);
			});
		}
	}
}

for (const total of [829, 1001]) {
	test(`stats expiry replaces an in-flight snapshot and resumes automatic pagination for ${total} files with a ten-page limit`, async () => {
		const pending = deferred<GitStatusPage>();
		const read = spyOn(api, "getGitStatusPage")
			.mockResolvedValueOnce(page("old", "a", "old-cursor"))
			.mockImplementationOnce(() => pending.promise)
			.mockImplementation(async (_target, query) => fixturePage(total, query?.cursor));
		await render(target, [], true, false, {});
		await settle(() => read.mock.calls.length === 2);
		const generation = latest.queryGeneration;
		const observation = { snapshotId: "old", generation, expired: true };
		latest.observeSnapshotStats(observation);
		latest.observeSnapshotStats(observation);
		const expectedPages = Math.min(10, Math.ceil(total / 100));
		await settle(() => latest.pages.length === expectedPages && !latest.isFetching);
		expect(read.mock.calls[1]?.[2]?.aborted).toBe(true);
		expect(latest.queryGeneration).not.toBe(generation);
		pending.resolve(page("old", "late"));
		await flush();
		expect(latest.pages.every((item) => item.snapshotId === "fixture")).toBe(true);
		expect(latest.pages.flatMap((item) => item.files)).toHaveLength(Math.min(total, 1000));
		expect(latest.error).toBeNull();
		expect(latest.isComplete).toBe(total <= 1000);
		expect(read).toHaveBeenCalledTimes(expectedPages + 2);
	});
}

for (const firstExpiry of ["cursor", "stats"] as const) {
	for (const secondExpiry of ["cursor", "stats"] as const) {
		test(`${firstExpiry} then ${secondExpiry} expiry stays bounded while a partial chain and visible statistics succeed`, async () => {
			const expired = Object.assign(new Error("expired"), {
				data: { code: "GIT_STATUS_PAGE_EXPIRED" },
			});
			const oldPage = deferred<GitStatusPage>();
			const recoveredPage = deferred<GitStatusPage>();
			let recovering = false;
			let secondExpired = false;
			const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) => {
				if (!recovering) {
					if (!query?.cursor) return page("old", "a", "old-cursor");
					if (firstExpiry === "stats") return oldPage.promise;
					recovering = true;
					throw expired;
				}
				if (query?.cursor === "2" && !secondExpired) return recoveredPage.promise;
				return fixturePage(829, query?.cursor, 100, "recovered");
			});
			await render(target, [], true, false, {});
			if (firstExpiry === "stats") {
				await settle(() => read.mock.calls.length === 2);
				recovering = true;
				latest.observeSnapshotStats({
					snapshotId: "old",
					generation: latest.queryGeneration,
					expired: true,
				});
			}
			await settle(() => latest.pages.length === 2 && read.mock.calls.length === 5);
			const generation = latest.queryGeneration;
			latest.observeSnapshotStats({ snapshotId: "recovered", generation, expired: false });
			secondExpired = true;
			if (secondExpiry === "stats") {
				latest.observeSnapshotStats({ snapshotId: "recovered", generation, expired: true });
				recoveredPage.resolve(fixturePage(829, "2", 100, "recovered"));
			} else recoveredPage.reject(expired);
			oldPage.resolve(page("old", "late"));
			await settle(() => latest.isError && !latest.isFetching);
			expect(latest.queryGeneration).toBe(generation);
			expect(latest.pages).toHaveLength(2);
			expect(latest.snapshotValid).toBe(false);
			expect(read).toHaveBeenCalledTimes(5);
			await latest.retry();
			await settle(() => latest.pages.length === 9 && !latest.isFetching);
			expect(latest.queryGeneration).not.toBe(generation);
			expect(latest.isComplete).toBe(true);
			expect(read).toHaveBeenCalledTimes(14);
		});
	}
}

test("stats recovery retains an exhausted automatic intent until explicit refresh", async () => {
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) =>
		fixturePage(1001, query?.cursor),
	);
	await render(target, [], true, false, {});
	await settle(() => latest.pages.length === 10 && !latest.isFetching);
	await flush();
	const generation = latest.queryGeneration;
	latest.observeSnapshotStats({ snapshotId: "fixture", generation, expired: true });
	await settle(() => latest.queryGeneration !== generation && !latest.isFetching);
	await flush();
	expect(latest.pages).toHaveLength(1);
	expect(read).toHaveBeenCalledTimes(11);
	latest.reset();
	await settle(() => latest.pages.length === 10 && !latest.isFetching);
	expect(read).toHaveBeenCalledTimes(21);
	expect(latest.hasNextPage).toBe(true);
});

test("cancelled loadAll stays stopped across stats recovery until explicit refresh", async () => {
	const pending = deferred<GitStatusPage>();
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(page("old", "a", "old-cursor"))
		.mockImplementationOnce(() => pending.promise)
		.mockImplementation(async (_target, query) => fixturePage(829, query?.cursor));
	await render(target, [], true, false, {});
	await settle(() => read.mock.calls.length === 2);
	const all = latest.loadAll();
	await flush();
	latest.cancelLoadAll();
	await all;
	expect(read.mock.calls[1]?.[2]?.aborted).toBe(true);
	latest.observeSnapshotStats({
		snapshotId: "old",
		generation: latest.queryGeneration,
		expired: true,
	});
	await settle(() => latest.pages[0]?.snapshotId === "fixture" && !latest.isFetching);
	pending.resolve(page("old", "late"));
	await flush();
	expect(latest.pages).toHaveLength(1);
	expect(latest.isLoadingAll).toBe(false);
	expect(read).toHaveBeenCalledTimes(3);
	latest.reset();
	await settle(() => latest.pages.length === 9 && !latest.isFetching);
	expect(latest.isComplete).toBe(true);
	expect(read).toHaveBeenCalledTimes(12);
});

for (const change of backgroundChanges) {
	for (const intent of ["cancelled", "exhausted"] as const) {
		test(`${change} replaces the snapshot while retaining ${intent} intent until explicit refresh`, async () => {
			const pending = deferred<GitStatusPage>();
			const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) =>
				fixturePage(1001, query?.cursor),
			);
			if (intent === "cancelled") {
				read
					.mockResolvedValueOnce(fixturePage(1001, undefined, 100, "old"))
					.mockImplementationOnce(() => pending.promise);
			}
			await render(target, [], true, false, {});
			if (intent === "cancelled") {
				await settle(() => read.mock.calls.length === 2);
				const all = latest.loadAll();
				await flush();
				latest.cancelLoadAll();
				await all;
				expect(read.mock.calls[1]?.[2]?.aborted).toBe(true);
				pending.resolve(fixturePage(1001, "1", 100, "old"));
			} else await settle(() => latest.pages.length === 10 && !latest.isFetching);
			await flush();
			const previousReads = read.mock.calls.length;
			for (let version = 1; version <= 2; version++) {
				const generation = latest.queryGeneration;
				await backgroundChange(change, version);
				await settle(() => latest.queryGeneration !== generation && !latest.isFetching);
				await flush();
				expect(latest.pages).toHaveLength(1);
				expect(latest.hasNextPage).toBe(true);
				expect(latest.isLoadingAll).toBe(false);
				expect(read).toHaveBeenCalledTimes(previousReads + version);
			}
			await latest.fetchNextPage();
			await flush();
			expect(latest.pages).toHaveLength(2);
			expect(read).toHaveBeenCalledTimes(previousReads + 3);
			latest.reset();
			await settle(() => latest.pages.length === 10 && !latest.isFetching);
			expect(read).toHaveBeenCalledTimes(previousReads + 13);
			expect(latest.hasNextPage).toBe(true);
		});
	}

	test(`${change} permits one recovery after a valid chain and stops repeated same-version expiry`, async () => {
		const expired = Object.assign(new Error("expired"), {
			data: { code: "GIT_STATUS_PAGE_EXPIRED" },
		});
		let recovered = false;
		let background = false;
		const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) => {
			if (query?.cursor === "1" && (!recovered || background)) {
				recovered = true;
				throw expired;
			}
			return fixturePage(829, query?.cursor);
		});
		await render(target, [], true, false, {});
		await settle(() => latest.isComplete && !latest.isFetching);
		expect(read).toHaveBeenCalledTimes(11);
		background = true;
		await backgroundChange(change);
		await settle(() => latest.error === expired && !latest.isFetching);
		const generation = latest.queryGeneration;
		await flush();
		expect(latest.queryGeneration).toBe(generation);
		expect(latest.pages).toHaveLength(1);
		expect(latest.snapshotValid).toBe(false);
		expect(read).toHaveBeenCalledTimes(change === "files" ? 15 : 13);
	});
}

for (const change of ["workspace", "narrator", "filter"] as const) {
	test(`${change} starts a new cycle with its own single recovery allowance`, async () => {
		const recoveredScopes = new Set<string>();
		const read = spyOn(api, "getGitStatusPage").mockImplementation(async (value, query) => {
			const scope = JSON.stringify([value.workspaceKey, value.narratorId, query?.filter]);
			if (query?.cursor === "1" && !recoveredScopes.has(scope)) {
				recoveredScopes.add(scope);
				throw Object.assign(new Error("expired"), {
					data: { code: "GIT_STATUS_PAGE_EXPIRED" },
				});
			}
			return fixturePage(829, query?.cursor, 100, scope);
		});
		await render(target, [], true, false, {});
		await settle(() => latest.isComplete && !latest.isFetching);
		const generation = latest.queryGeneration;
		const value = {
			...target,
			...(change === "workspace" ? { workspaceKey: "root-b" } : {}),
			...(change === "narrator" ? { narratorId: "n2" } : {}),
		};
		await render(value, change === "filter" ? ["M"] : [], true, false, {});
		await settle(() => latest.isComplete && !latest.isFetching);
		expect(latest.queryGeneration).not.toBe(generation);
		expect(latest.pages.flatMap((item) => item.files)).toHaveLength(829);
		expect(latest.error).toBeNull();
		expect(recoveredScopes.size).toBe(2);
		expect(read).toHaveBeenCalledTimes(22);
	});
}

test("statistical pushes do not renew budgets or gate read-only automatic continuation", async () => {
	const pending = deferred<GitStatusPage>();
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(fixturePage(10000))
		.mockImplementationOnce(() => pending.promise)
		.mockImplementation(async (_target, query) => fixturePage(10000, query?.cursor));
	await render({ ...target, canWrite: false }, [], true, false, { autoPageLimit: 3 });
	await settle(() => read.mock.calls.length === 2);
	const generation = latest.queryGeneration;
	send({
		type: "git_workspace_changed",
		workspaceKey: target.workspaceKey,
		version: 1,
		categories: ["worktree"],
		statusPagesChanged: false,
		statusPagesReliable: false,
	});
	await flush();
	expect(read.mock.calls[1]?.[2]?.aborted).toBe(false);
	pending.resolve(fixturePage(10000, "1"));
	await settle(() => latest.pages.length === 3 && !latest.isFetching);
	expect(latest.statusPagesReliable).toBe(false);
	for (let version = 2; version < 5; version++) {
		send({
			type: "git_workspace_changed",
			workspaceKey: target.workspaceKey,
			version,
			categories: [],
			statusPagesChanged: false,
			statusPagesReliable: true,
		});
	}
	await render({ ...target, canWrite: false }, [], true, false, { autoPageLimit: 3 });
	expect(latest.queryGeneration).toBe(generation);
	expect(latest.statusPagesReliable).toBe(false);
	send({
		type: "git_workspace_snapshot",
		workspaceKey: target.workspaceKey,
		view: "details",
		version: 5,
		snapshot: { revision: 5, updating: false, statusPages: cacheState() },
	});
	await flush();
	expect(latest.statusPagesReliable).toBe(true);
	expect(read).toHaveBeenCalledTimes(3);
});

test("cancelled loadAll cleanup cannot release a newer loadAll owner", async () => {
	const oldPage = deferred<GitStatusPage>();
	const newPage = deferred<GitStatusPage>();
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(page("all", "a", "1"))
		.mockImplementationOnce(() => oldPage.promise)
		.mockImplementationOnce(() => newPage.promise)
		.mockResolvedValueOnce(page("all", "c"));
	await render();
	const oldAll = latest.loadAll();
	await settle(() => read.mock.calls.length === 2);
	latest.cancelLoadAll();
	const newAll = latest.loadAll();
	expect(newAll).not.toBe(oldAll);
	await settle(() => read.mock.calls.length === 3);
	await oldAll;
	await flush();
	expect(latest.isLoadingAll).toBe(true);
	expect(latest.loadAll()).toBe(newAll);
	oldPage.resolve(page("all", "late-old"));
	newPage.resolve(page("all", "b", "2"));
	await newAll;
	await flush();
	expect(latest.pages.map((item) => item.files[0]?.path)).toEqual(["a", "b", "c"]);
	expect(latest.isLoadingAll).toBe(false);
	expect(read.mock.calls[1]?.[2]?.aborted).toBe(true);
	expect(read.mock.calls[2]?.[2]?.aborted).toBe(false);
});

for (const change of [
	"workspace",
	"narrator",
	"filter",
	"reconnect",
	"invalidation",
	"files",
] as const) {
	test(`${change} cancels old automatic continuation and starts a fresh bounded snapshot`, async () => {
		const pending = deferred<GitStatusPage>();
		const read = spyOn(api, "getGitStatusPage")
			.mockResolvedValueOnce(page("old", "a", "old-cursor"))
			.mockImplementationOnce(() => pending.promise)
			.mockImplementation(async (_target, query) => fixturePage(10000, query?.cursor));
		await render(target, [], true, false, { autoPageLimit: 3 });
		await settle(() => read.mock.calls.length === 2);
		const generation = latest.queryGeneration;
		if (change === "workspace")
			await render({ ...target, workspaceKey: "root-b" }, [], true, false, { autoPageLimit: 3 });
		else if (change === "narrator")
			await render({ ...target, narratorId: "n2" }, [], true, false, { autoPageLimit: 3 });
		else if (change === "filter") await render(target, ["M"], true, false, { autoPageLimit: 3 });
		else if (change === "reconnect") await backgroundChange("reconnect");
		else if (change === "invalidation") {
			void client.invalidateQueries({ queryKey: ["gitStatusPages", target.workspaceKey] });
		} else await backgroundChange("files");
		await settle(() => latest.pages.length === 3 && !latest.isFetching);
		expect(read.mock.calls[1]?.[2]?.aborted).toBe(true);
		expect(latest.queryGeneration).not.toBe(generation);
		pending.resolve(page("old", "late"));
		await flush();
		expect(latest.pages.every((item) => item.snapshotId === "fixture")).toBe(true);
		expect(read).toHaveBeenCalledTimes(5);
	});
}

for (const change of ["hidden", "disabled"] as const) {
	test(`${change} pauses automatic reads and reopening starts a fresh bounded chain`, async () => {
		const pending = deferred<GitStatusPage>();
		const read = spyOn(api, "getGitStatusPage")
			.mockResolvedValueOnce(page("old", "a", "old-cursor"))
			.mockImplementationOnce(() => pending.promise)
			.mockImplementation(async (_target, query) => fixturePage(10000, query?.cursor));
		await render(target, [], true, false, { autoPageLimit: 3 });
		await settle(() => read.mock.calls.length === 2);
		const generation = latest.queryGeneration;
		if (change === "hidden") {
			Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
			document.dispatchEvent(new window.Event("visibilitychange"));
			await flush();
		} else await render(target, [], false, false, { autoPageLimit: 3 });
		expect(read.mock.calls[1]?.[2]?.aborted).toBe(true);
		expect(latest.snapshotValid).toBe(false);
		pending.resolve(page("old", "late"));
		await flush();
		expect(read).toHaveBeenCalledTimes(2);
		if (change === "hidden") {
			Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
			document.dispatchEvent(new window.Event("visibilitychange"));
		} else await render(target, [], true, false, { autoPageLimit: 3 });
		await settle(() => latest.pages.length === 3 && !latest.isFetching);
		expect(latest.queryGeneration).not.toBe(generation);
		expect(latest.pages.every((item) => item.snapshotId === "fixture")).toBe(true);
		expect(read).toHaveBeenCalledTimes(5);
	});
}

test("revoked access aborts automatic continuation and hides its late result", async () => {
	transport.connected = true;
	const transmit = spyOn(transport, "send");
	const pending = deferred<GitStatusPage>();
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(page("old", "a", "old-cursor"))
		.mockImplementationOnce(() => pending.promise);
	await render(target, [], true, false, { autoPageLimit: 3 });
	await settle(() => read.mock.calls.length === 2);
	const subscription = transmit.mock.calls.find(
		(call) => call[0].type === "git_workspace_subscribe",
	);
	expect(subscription).toBeDefined();
	send({
		type: "git_workspace_error",
		subscriptionId: subscription?.[0].subscriptionId,
		workspaceKey: target.workspaceKey,
		code: "ACCESS_DENIED",
	});
	await flush();
	expect(read.mock.calls[1]?.[2]?.aborted).toBe(true);
	pending.resolve(page("old", "late"));
	await flush();
	expect(latest.pages).toHaveLength(0);
	expect(latest.snapshotValid).toBe(false);
	expect(read).toHaveBeenCalledTimes(2);
});

test("display ownership binds root and repository without changing permission-only generations", async () => {
	const read = spyOn(api, "getGitStatusPage").mockImplementation(async (_target, query) =>
		fixturePage(1, query?.cursor),
	);
	const owned = { ...target, rootPath: "/repo/a", repositoryKey: "repository-a" };
	await render(owned, ["M", "D"]);
	const scope = latest.displayScope;
	const generation = latest.queryGeneration;
	await render({ ...owned, canWrite: false }, ["D", "M"]);
	expect(latest.displayScope).toBe(scope);
	expect(latest.queryGeneration).toBe(generation);
	expect(latest.displayAllowed).toBe(true);
	await render({ ...owned, rootPath: "/repo/b" }, ["M", "D"]);
	expect(latest.displayScope).not.toBe(scope);
	expect(latest.queryGeneration).not.toBe(generation);
	expect(latest.displayAllowed).toBe(true);
	expect(read).toHaveBeenCalledTimes(2);
	const rootScope = latest.displayScope;
	await render({ ...owned, rootPath: "/repo/b", repositoryKey: "repository-b" }, ["M", "D"]);
	expect(latest.displayScope).not.toBe(rootScope);
	expect(read).toHaveBeenCalledTimes(3);
	await render(owned, [], false);
	expect(latest.displayAllowed).toBe(false);
	expect(latest.pages).toEqual([]);
});

for (const status of [401, 403, 404]) {
	test(`HTTP ${status} immediately refuses cached pages and explicit retry starts a fresh chain`, async () => {
		const failure = Object.assign(new Error(`HTTP ${status}`), { status });
		const read = spyOn(api, "getGitStatusPage")
			.mockResolvedValueOnce(page("old", "private", "next"))
			.mockRejectedValueOnce(failure)
			.mockResolvedValueOnce(page("recovered", "public"));
		await render();
		expect(latest.displayAllowed).toBe(true);
		const generation = latest.queryGeneration;
		await latest.fetchNextPage();
		await flush();
		expect(latest.readRefused).toBe(true);
		expect(latest.displayAllowed).toBe(false);
		expect(latest.pages).toEqual([]);
		expect(latest.data).toBeUndefined();
		expect(latest.counts).toBeUndefined();
		await latest.retry();
		if (status !== 403) {
			// Server reauthorization replays its last snapshot after the transport's ACK.
			send({
				type: "git_workspace_snapshot",
				workspaceKey: target.workspaceKey,
				version: 11,
				view: "details",
				snapshot: { revision: 11, updating: false, statusPages: cacheState() },
			});
		}
		await flush();
		expect(latest.queryGeneration).not.toBe(generation);
		expect(latest.displayAllowed).toBe(true);
		expect(latest.pages[0]?.snapshotId).toBe("recovered");
		expect(read).toHaveBeenCalledTimes(3);
	});
}

test("unmount aborts automatic continuation without scheduling another page", async () => {
	const pending = deferred<GitStatusPage>();
	const read = spyOn(api, "getGitStatusPage")
		.mockResolvedValueOnce(page("old", "a", "old-cursor"))
		.mockImplementationOnce(() => pending.promise);
	await render(target, [], true, false, {});
	await settle(() => read.mock.calls.length === 2);
	root.render(null);
	await flush();
	expect(read.mock.calls[1]?.[2]?.aborted).toBe(true);
	pending.resolve(page("old", "late", "unexpected"));
	await flush();
	expect(read).toHaveBeenCalledTimes(2);
	expect(container.textContent).toBe("");
});
