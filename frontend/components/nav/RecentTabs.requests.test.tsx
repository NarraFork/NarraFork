import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { notifications } from "@mantine/notifications";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { RecentTab } from "../../hooks/recent-tabs-utils";
import { type RecentTabsInfiniteData, recentTabsSectionQueryKey } from "../../hooks/useRecentTabs";
import { api } from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";

const realRouter = { ...(await import("@tanstack/react-router")) };
const navigate = mock(() => {});
mock.module("@tanstack/react-router", () => ({
	...realRouter,
	useNavigate: () => navigate,
	useRouterState: () => "/",
}));
const { RecentTabsWSProvider } = await import("./RecentTabs");
const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { nav: {} } }, react: { useSuspense: false } });

type RuntimeResult = Awaited<ReturnType<typeof api.getRecentTabsRuntime>>;
type MoveResult = Awaited<ReturnType<typeof api.moveRecentTab>>;
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
const tab = (id: string, fields: Partial<RecentTab> = {}): RecentTab => ({
	type: "narrator",
	id,
	title: id,
	status: "idle",
	lastVisitedAt: 1,
	...fields,
});
const unchanged: MoveResult = { changed: false, baseRevision: 0, revision: 0, operations: [] };
let root: Root | undefined;
let client: QueryClient;
let container: HTMLElement;
let restoreDom: () => void;
let frames: Map<number, FrameRequestCallback>;
let zeroTimers: Map<number, () => void>;
let nextTimer: number;
let onListEvent: (event: Record<string, unknown>) => void;
let onConnection: (connected: boolean, isReconnect: boolean) => void;
let runtimeRequests: Array<{ keys: string[]; result: ReturnType<typeof deferred<RuntimeResult>> }>;
let moveRequests: Array<{ key: string; result: ReturnType<typeof deferred<MoveResult>> }>;
let pages: RecentTab[];
let now: number;

function setTabs(tabs: RecentTab[]) {
	pages = tabs;
	flushSync(() => {
		client.setQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"), {
			pages: [{ items: tabs, revision: 0, hasMore: false, nextCursor: undefined }],
			pageParams: [undefined],
		});
	});
}
async function settle() {
	await act(async () => {
		await Promise.resolve();
	});
}
async function mount(tabs = [tab("a"), tab("b")]) {
	setTabs(tabs);
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={i18n}>
					<RecentTabsWSProvider />
				</I18nextProvider>
			</QueryClientProvider>,
		);
	});
}
function emitStatus(id: string, status: string) {
	onListEvent({ type: "status_change", narratorId: id, status, substatus: [] });
}
function snapshot(id: string, status = "working") {
	onListEvent({
		type: "list_state_snapshot",
		items: [{ narratorId: id, state: { status, substatus: [], title: id } }],
	});
}
function flushFrame() {
	flushSync(() => {
		for (const [id, callback] of [...frames]) {
			frames.delete(id);
			callback(0);
		}
	});
}
function cachedTab(id: string) {
	return client
		.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work"))
		?.pages.flatMap((page) => page.items)
		.find((item) => item.id === id);
}
function reconnect() {
	now += 6000;
	onConnection(true, true);
}
beforeEach(() => {
	frames = new Map();
	zeroTimers = new Map();
	nextTimer = 1;
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.defineProperty(window.document, "visibilityState", { value: "visible" });
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			const id = nextTimer++;
			frames.set(id, callback);
			return id;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const originals = Object.keys(values).map(
		(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	);
	Object.assign(globalThis, values);
	restoreDom = () => {
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: (...args: unknown[]) => void,
		delay?: number,
		...args: unknown[]
	) => {
		if (delay === 0) {
			const id = nextTimer++;
			zeroTimers.set(id, () => callback(...args));
			return id;
		}
		return realSetTimeout(callback, delay, ...args);
	}) as typeof setTimeout);
	spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
		if (!zeroTimers.delete(Number(id))) realClearTimeout(Number(id));
	});
	notifyManager.setScheduler(queueMicrotask);
	now = 100_000;
	spyOn(Date, "now").mockImplementation(() => now);
	runtimeRequests = [];
	moveRequests = [];
	spyOn(api, "getRecentTabsRuntime").mockImplementation((keys) => {
		const result = deferred<RuntimeResult>();
		runtimeRequests.push({ keys, result });
		return result.promise;
	});
	spyOn(api, "moveRecentTab").mockImplementation((key) => {
		const result = deferred<MoveResult>();
		moveRequests.push({ key, result });
		return result.promise;
	});
	spyOn(api, "getUserPreferences").mockImplementation(() => new Promise(() => {}));
	spyOn(api, "getRecentTabsPage").mockImplementation(async (section) => ({
		items: section === "work" ? pages : [],
		revision: 0,
		hasMore: false,
		nextCursor: undefined,
	}));
	spyOn(notifications, "show").mockImplementation(() => "notice");
	spyOn(narratorWSManager, "addListener").mockImplementation((options, callback) => {
		if (options.narratorIds === "*") onListEvent = callback;
		return { _id: 1 };
	});
	spyOn(narratorWSManager, "removeListener").mockImplementation(() => {});
	spyOn(narratorWSManager, "subscribe").mockImplementation((ids) => ({
		_id: 1,
		_narratorIds: ids,
		_kind: "list",
	}));
	spyOn(narratorWSManager, "updateSubscription").mockImplementation(() => {});
	spyOn(narratorWSManager, "unsubscribe").mockImplementation(() => {});
	spyOn(narratorWSManager, "onConnectionChange").mockImplementation((callback) => {
		onConnection = callback;
		return () => {};
	});
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	client.setQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("projects"), {
		pages: [{ items: [], revision: 0, hasMore: false, nextCursor: undefined }],
		pageParams: [undefined],
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	client.clear();
	container.remove();
	notifyManager.setScheduler((callback) => setTimeout(callback, 0));
	mock.restore();
	restoreDom();
});
afterAll(() => mock.module("@tanstack/react-router", () => realRouter));

test("working events and snapshot replay share one promotion before RAF flush", async () => {
	await mount();
	emitStatus("a", "working");
	emitStatus("a", "working");
	snapshot("a");
	expect(frames.size).toBe(1);
	expect(cachedTab("a")?.status).toBe("idle");
	expect(moveRequests.map(({ key }) => key)).toEqual(["narrator:a"]);
	flushFrame();
	await settle();
	expect(cachedTab("a")?.status).toBe("working");
	moveRequests[0]?.result.resolve(unchanged);
	await settle();
	snapshot("a");
	expect(moveRequests).toHaveLength(1);
});

test("in-flight promotions coalesce per narrator and the next real turn recovers", async () => {
	await mount();
	emitStatus("a", "working");
	emitStatus("a", "idle");
	emitStatus("a", "working");
	emitStatus("b", "working");
	expect(moveRequests.map(({ key }) => key)).toEqual(["narrator:a", "narrator:b"]);
	moveRequests[0]?.result.resolve(unchanged);
	await settle();
	expect(moveRequests.map(({ key }) => key)).toEqual(["narrator:a", "narrator:b", "narrator:a"]);
	moveRequests[2]?.result.resolve(unchanged);
	await settle();
	emitStatus("a", "idle");
	emitStatus("a", "working");
	expect(moveRequests.map(({ key }) => key)).toEqual([
		"narrator:a",
		"narrator:b",
		"narrator:a",
		"narrator:a",
	]);
});

for (const outcome of ["success", "failure"] as const) {
	test(`a real working transition queues one promotion after in-flight ${outcome}`, async () => {
		await mount([tab("a")]);
		emitStatus("a", "working");
		for (let turn = 0; turn < 3; turn++) {
			emitStatus("a", "idle");
			emitStatus("a", "working");
			snapshot("a");
		}
		expect(moveRequests).toHaveLength(1);
		if (outcome === "success") moveRequests[0]?.result.resolve(unchanged);
		else moveRequests[0]?.result.reject(new Error("busy"));
		await settle();
		expect(moveRequests.map(({ key }) => key)).toEqual(["narrator:a", "narrator:a"]);
		snapshot("a");
		moveRequests[1]?.result.reject(new Error("still busy"));
		await settle();
		snapshot("a");
		expect(moveRequests).toHaveLength(2);
	});
}

for (const latest of ["idle", "unmounted"] as const) {
	test(`a queued promotion is discarded when the latest provider state is ${latest}`, async () => {
		await mount([tab("a")]);
		emitStatus("a", "working");
		emitStatus("a", "idle");
		emitStatus("a", "working");
		if (latest === "idle") emitStatus("a", "idle");
		else {
			await act(async () => root?.unmount());
			root = undefined;
		}
		moveRequests[0]?.result.reject(new Error("busy"));
		await settle();
		expect(moveRequests).toHaveLength(1);
	});
}

test("failed promotion does not retry replayed working state but a new turn can retry", async () => {
	await mount();
	emitStatus("a", "working");
	moveRequests[0]?.result.reject(new Error("busy"));
	await settle();
	snapshot("a");
	emitStatus("a", "working");
	expect(moveRequests).toHaveLength(1);
	flushFrame();
	await settle();
	emitStatus("a", "idle");
	emitStatus("a", "working");
	expect(moveRequests).toHaveLength(2);
});

test("RAF-flushed status is visible before React commits its new tabs reference", async () => {
	await mount();
	emitStatus("a", "working");
	moveRequests[0]?.result.resolve(unchanged);
	await settle();
	act(() => {
		for (const callback of [...frames.values()]) callback(0);
		emitStatus("a", "working");
		expect(moveRequests).toHaveLength(1);
	});
	await settle();
});

test("runtime target reorder preserves display and subscription order without another read", async () => {
	await mount();
	await act(async () => setTabs([tab("b"), tab("a")]));
	expect(runtimeRequests).toHaveLength(1);
	expect(
		client.getQueryData<RecentTab[]>(["user-preferences", "recent-tabs"])?.map((item) => item.id),
	).toEqual(["b", "a"]);
	expect(narratorWSManager.updateSubscription).toHaveBeenLastCalledWith(
		expect.objectContaining({ _id: 1, _kind: "list" }),
		["b", "a"],
	);
	runtimeRequests[0]?.result.resolve({
		revision: 0,
		patches: [{ key: "narrator:a", patch: { title: "runtime" } }],
	});
	await settle();
	expect(cachedTab("a")?.title).toBe("runtime");
	await act(async () => setTabs([tab("a"), tab("b")]));
	expect(runtimeRequests).toHaveLength(1);
});

test("runtime changes and reconnects during a request collapse to the final target set", async () => {
	await mount([tab("a")]);
	await act(async () => setTabs([tab("b")]));
	await act(async () => reconnect());
	await act(async () => setTabs([tab("c")]));
	await act(async () => reconnect());
	await act(async () => setTabs([tab("d")]));
	expect(runtimeRequests.map(({ keys }) => keys)).toEqual([["narrator:a"]]);
	runtimeRequests[0]?.result.resolve({
		revision: 0,
		patches: [{ key: "narrator:d", patch: { title: "obsolete" } }],
	});
	await settle();
	expect(cachedTab("d")?.title).toBe("d");
	expect(runtimeRequests.map(({ keys }) => keys)).toEqual([["narrator:a"], ["narrator:d"]]);
	runtimeRequests[1]?.result.resolve({
		revision: 0,
		patches: [{ key: "narrator:d", patch: { title: "current" } }],
	});
	await settle();
	expect(cachedTab("d")?.title).toBe("current");
	expect(runtimeRequests).toHaveLength(2);
});

test("repeated reconnects on unchanged targets queue just one fresh runtime read", async () => {
	await mount([tab("a")]);
	await act(async () => reconnect());
	await act(async () => reconnect());
	expect(runtimeRequests).toHaveLength(1);
	runtimeRequests[0]?.result.resolve({ revision: 0, patches: [] });
	await settle();
	expect(runtimeRequests).toHaveLength(2);
	runtimeRequests[1]?.result.resolve({ revision: 0, patches: [] });
	await settle();
	expect(runtimeRequests).toHaveLength(2);
});

test("runtime preserves newer WS fields and still applies untouched snapshot fields", async () => {
	await mount([tab("a")]);
	snapshot("a");
	onListEvent({ type: "draft_changed", narratorId: "a", hasDraft: true });
	onListEvent({ type: "terminal_count_changed", narratorId: "a", activeTerminalCount: 2 });
	flushFrame();
	await settle();
	runtimeRequests[0]?.result.resolve({
		revision: 0,
		patches: [
			{
				key: "narrator:a",
				patch: {
					title: "stale",
					status: "idle",
					hasDraft: false,
					activeTerminalCount: 0,
					activeBackgroundTaskCount: 3,
				},
			},
		],
	});
	await settle();
	expect(cachedTab("a")).toMatchObject({
		title: "a",
		status: "working",
		hasDraft: true,
		activeTerminalCount: 2,
		activeBackgroundTaskCount: 3,
	});
});

test("a target leaving and returning invalidates the old runtime generation", async () => {
	await mount([tab("a")]);
	await act(async () => setTabs([tab("b")]));
	await act(async () => setTabs([tab("a")]));
	expect(runtimeRequests).toHaveLength(1);
	runtimeRequests[0]?.result.resolve({
		revision: 0,
		patches: [{ key: "narrator:a", patch: { title: "obsolete" } }],
	});
	await settle();
	expect(cachedTab("a")?.title).toBe("a");
	expect(runtimeRequests.map(({ keys }) => keys)).toEqual([["narrator:a"], ["narrator:a"]]);
});

test("a failed runtime read releases the slot for the latest requested targets", async () => {
	await mount([tab("a")]);
	await act(async () => setTabs([tab("b")]));
	runtimeRequests[0]?.result.reject(new Error("busy"));
	await settle();
	expect(runtimeRequests.map(({ keys }) => keys)).toEqual([["narrator:a"], ["narrator:b"]]);
	runtimeRequests[1]?.result.resolve({ revision: 0, patches: [] });
	await settle();
	expect(runtimeRequests).toHaveLength(2);
});

for (const firstOutcome of ["success", "failure"] as const) {
	test(`runtime latest result supersedes an earlier ${firstOutcome} for reconnect`, async () => {
		await mount([tab("a")]);
		await act(async () => setTabs([tab("b")]));
		await act(async () => reconnect());
		expect(runtimeRequests).toHaveLength(1);
		if (firstOutcome === "success") {
			runtimeRequests[0]?.result.resolve({ revision: 0, patches: [] });
		} else {
			runtimeRequests[0]?.result.reject(new Error("busy"));
		}
		await settle();
		expect(runtimeRequests.map(({ keys }) => keys)).toEqual([["narrator:a"], ["narrator:b"]]);
		if (firstOutcome === "success") {
			runtimeRequests[1]?.result.reject(new Error("latest read failed"));
			await settle();
			expect(notifications.show).toHaveBeenCalledTimes(1);
			expect(notifications.show).toHaveBeenLastCalledWith({
				color: "red",
				message: "recentTabsSyncError",
			});
		} else {
			runtimeRequests[1]?.result.resolve({
				revision: 0,
				patches: [{ key: "narrator:b", patch: { title: "latest" } }],
			});
			await settle();
			expect(cachedTab("b")?.title).toBe("latest");
			expect(notifications.show).not.toHaveBeenCalled();
		}
		expect(runtimeRequests).toHaveLength(2);
	});
}

test("empty targets issue no runtime request and discard queued refreshes", async () => {
	await mount([]);
	await act(async () => reconnect());
	expect(runtimeRequests).toHaveLength(0);
	await act(async () => setTabs([tab("a")]));
	await act(async () => setTabs([tab("b")]));
	await act(async () => setTabs([]));
	await act(async () => reconnect());
	expect(runtimeRequests).toHaveLength(1);
	runtimeRequests[0]?.result.resolve({ revision: 0, patches: [] });
	await settle();
	expect(runtimeRequests).toHaveLength(1);
	await act(async () => setTabs([tab("c")]));
	expect(runtimeRequests.map(({ keys }) => keys)).toEqual([["narrator:a"], ["narrator:c"]]);
});

test.each([
	false,
	true,
])("unmount ignores late runtime responses and queued reconnect=%s", async (queuedReconnect) => {
	await mount([tab("a")]);
	if (queuedReconnect) await act(async () => reconnect());
	await act(async () => root?.unmount());
	root = undefined;
	runtimeRequests[0]?.result.resolve({
		revision: 0,
		patches: [{ key: "narrator:a", patch: { title: "late" } }],
	});
	await settle();
	expect(runtimeRequests).toHaveLength(1);
	expect(cachedTab("a")?.title).toBe("a");
});

test("runtime failures wait for a new trigger and reconnect retains the sync error notice", async () => {
	await mount([tab("a")]);
	runtimeRequests[0]?.result.reject(new Error("busy"));
	await settle();
	expect(runtimeRequests).toHaveLength(1);
	expect(notifications.show).not.toHaveBeenCalled();
	await act(async () => reconnect());
	expect(runtimeRequests).toHaveLength(2);
	runtimeRequests[1]?.result.reject(new Error("busy again"));
	await settle();
	expect(runtimeRequests).toHaveLength(2);
	expect(notifications.show).toHaveBeenCalledTimes(1);
	expect(notifications.show).toHaveBeenLastCalledWith({
		color: "red",
		message: "recentTabsSyncError",
	});
	await act(async () => reconnect());
	expect(runtimeRequests).toHaveLength(3);
	runtimeRequests[2]?.result.resolve({ revision: 0, patches: [] });
	await settle();
	expect(runtimeRequests).toHaveLength(3);
});
