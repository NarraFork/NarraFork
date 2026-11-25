import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { UnattendedStatus } from "../lib/api/unattended";

// React Query must detect a browser so a regression to refetchInterval is observable.
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

let connected = true;
const listeners = new Set<() => void>();
const connections = new Set<(connected: boolean, reconnect: boolean) => void>();
const recoveries = new Set<() => void>();
mock.module("../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		get connected() {
			return connected;
		},
		addListener: (options: { types: string[] }, callback: () => void) => {
			expect(options.types).toEqual(["unattended_mode_changed"]);
			listeners.add(callback);
			return callback;
		},
		removeListener: (callback: () => void) => listeners.delete(callback),
		onConnectionChange: (callback: (connected: boolean, reconnect: boolean) => void) => {
			connections.add(callback);
			return () => connections.delete(callback);
		},
		onControlPlaneRecovery: (callback: () => void) => {
			recoveries.add(callback);
			return () => recoveries.delete(callback);
		},
	},
}));

function fixture(enabled = true): UnattendedStatus {
	return {
		enabled,
		phase: enabled ? "waiting" : "off",
		shutdownAt: null,
		blocked: enabled,
		options: { powerOff: false, quietSeconds: 120, armDelaySeconds: 70 },
		blockers: {
			narrators: 1,
			compacting: 0,
			queuedDeliveries: false,
			backgroundTasks: false,
			dueScheduledTasks: false,
			maintenance: false,
			unknown: false,
		},
	};
}
let status = fixture();
let requests: AbortSignal[] = [];
let response: ((signal: AbortSignal) => Promise<UnattendedStatus>) | undefined;
const originalApi = { ...(await import("../lib/api")) };
mock.module("../lib/api", () => ({
	...originalApi,
	api: {
		...originalApi.api,
		getUnattendedStatus: (signal: AbortSignal) => {
			requests.push(signal);
			return response ? response(signal) : Promise.resolve(status);
		},
	},
}));
const { act } = await import("react");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createRoot } = await import("react-dom/client");
const { useUnattendedStatus } = await import("./useUnattendedStatus");
const { unattendedStatusQueryKey } = await import("../lib/api/unattended");

let root: Root | undefined;
let client: InstanceType<typeof QueryClient>;
let container: HTMLElement;
let now = 0;
let timerId = 100_000;
const timers = new Map<number, { at: number; callback: () => void; interval?: number }>();
const realTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function Probe({ enabled = true }: { enabled?: boolean }) {
	const query = useUnattendedStatus(enabled);
	return <span>{query.data?.blockers.narrators}</span>;
}
async function flush() {
	await act(async () => {
		for (let i = 0; i < 5; i++) await new Promise((resolve) => realTimeout(resolve, 0));
	});
}
async function mount(count = 1, enabled = true) {
	root ??= createRoot(container);
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<Probe enabled={enabled} />
				{count > 1 && <Probe enabled={enabled} />}
			</QueryClientProvider>,
		);
	});
	await flush();
}
async function advance(ms: number) {
	const end = now + ms;
	while (true) {
		const next = [...timers]
			.filter(([, timer]) => timer.at <= end)
			.sort((a, b) => a[1].at - b[1].at)[0];
		if (!next) break;
		const [id, timer] = next;
		now = timer.at;
		timers.delete(id);
		if (timer.interval) timers.set(id, { ...timer, at: now + timer.interval });
		await act(async () => timer.callback());
		await flush();
	}
	now = end;
	await flush();
}
function connection(next: boolean) {
	connected = next;
	for (const callback of connections) callback(next, true);
}
function changed() {
	for (const callback of listeners) callback();
}

beforeEach(() => {
	connected = true;
	status = fixture();
	requests = [];
	response = undefined;
	now = Date.now();
	spyOn(Date, "now").mockImplementation(() => now);
	spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		delay = 0,
		...args: unknown[]
	) => {
		if (delay < 1_000) return realTimeout(callback, delay, ...args);
		const id = ++timerId;
		timers.set(id, { at: now + delay, callback });
		return id;
	}) as typeof setTimeout);
	spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
		if (!timers.delete(Number(id))) realClearTimeout(id);
	}) as typeof clearTimeout);
	spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay: number) => {
		const id = ++timerId;
		timers.set(id, { at: now + delay, callback, interval: delay });
		return id;
	}) as typeof setInterval);
	spyOn(globalThis, "clearInterval").mockImplementation(((id: number) =>
		timers.delete(Number(id))) as typeof clearInterval);
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	container = document.createElement("div");
	document.body.appendChild(container);
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	client.clear();
	container.remove();
	expect(listeners.size).toBe(0);
	expect(connections.size).toBe(0);
	expect(recoveries.size).toBe(0);
	timers.clear();
	mock.restore();
});
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

describe("useUnattendedStatus", () => {
	for (const enabled of [true, false]) {
		test(`connected ${enabled ? "armed" : "disarmed"}: two observers do not poll over 120 seconds`, async () => {
			status = fixture(enabled);
			await mount(2);
			expect(listeners.size).toBe(1);
			expect(connections.size).toBe(1);
			expect(recoveries.size).toBe(1);
			const initial = requests.length;
			await advance(120_000);
			expect(requests).toHaveLength(initial);
			expect(timers.size).toBe(0);
		});
	}

	test("offline safety polls at 5 seconds armed and 60 seconds disarmed; reconnect stops immediately", async () => {
		connected = false;
		await mount(2);
		const initial = requests.length;
		await advance(4_999);
		expect(requests).toHaveLength(initial);
		await advance(1);
		expect(requests).toHaveLength(initial + 1);
		status = fixture(false);
		await advance(5_000);
		const disarmed = requests.length;
		await advance(59_999);
		expect(requests).toHaveLength(disarmed);
		await advance(1);
		expect(requests).toHaveLength(disarmed + 1);
		await act(async () => {
			connection(true);
			changed();
			changed();
		});
		await flush();
		expect(requests).toHaveLength(disarmed + 2);
		await advance(120_000);
		expect(requests).toHaveLength(disarmed + 2);
	});

	test("heartbeat loss immediately discovers a missed remote arm before its 70-second undo window ends", async () => {
		status = fixture(false);
		await mount(2);
		const initial = requests.length;
		status = {
			...fixture(),
			phase: "quiet",
			shutdownAt: new Date(now + 70_000).toISOString(),
		};
		// No WS event arrives; the heartbeat only reports the lost socket 60 seconds later.
		await advance(60_000);
		expect(requests).toHaveLength(initial);
		expect(client.getQueryData<UnattendedStatus>(unattendedStatusQueryKey)?.enabled).toBe(false);
		await act(async () => {
			for (let i = 0; i < 20; i++) connection(false);
		});
		await flush();
		expect(requests).toHaveLength(initial + 1);
		expect(client.getQueryData<UnattendedStatus>(unattendedStatusQueryKey)?.enabled).toBe(true);
		expect(Date.parse(status.shutdownAt as string) - now).toBe(10_000);
		await advance(4_999);
		expect(requests).toHaveLength(initial + 1);
		// Repeated false must neither read again nor postpone the armed safety poll.
		await act(async () => connection(false));
		await advance(1);
		expect(requests).toHaveLength(initial + 2);
	});

	test("initially disconnected observers use one initial GET and duplicate false does not postpone polling", async () => {
		connected = false;
		status = fixture(false);
		await mount(2);
		expect(requests).toHaveLength(1);
		await advance(30_000);
		await act(async () => {
			for (let i = 0; i < 20; i++) connection(false);
		});
		await flush();
		expect(requests).toHaveLength(1);
		await advance(30_000);
		expect(requests).toHaveLength(2);
	});

	test("coalesces WS and foreground recovery bursts across observers", async () => {
		await mount(2);
		const initial = requests.length;
		status = { ...fixture(), blockers: { ...fixture().blockers, narrators: 5 } };
		await act(async () => {
			for (let i = 0; i < 20; i++) changed();
			for (const callback of recoveries) callback();
		});
		await flush();
		expect(requests).toHaveLength(initial + 1);
		expect(container.textContent).toBe("55");
		await mount(1);
		expect(listeners.size).toBe(1);
		expect(requests).toHaveLength(initial + 1);
	});

	test("first connect cancels an initial stale HTTP request even if transport ignores abort", async () => {
		connected = false;
		const old = Promise.withResolvers<UnattendedStatus>();
		response = () => old.promise;
		await mount();
		expect(requests).toHaveLength(1);
		response = undefined;
		await act(async () => connection(true));
		await flush();
		expect(requests[0]?.aborted).toBe(true);
		expect(requests).toHaveLength(2);
		await act(async () => old.resolve(fixture(false)));
		await flush();
		expect(client.getQueryData<UnattendedStatus>(unattendedStatusQueryKey)?.enabled).toBe(true);
	});

	test("an already-connected socket reconciles the initial HTTP-before-listener race", async () => {
		const old = Promise.withResolvers<UnattendedStatus>();
		let first = true;
		response = () => {
			if (first) {
				first = false;
				return old.promise;
			}
			return Promise.resolve(status);
		};
		await mount(2);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.aborted).toBe(true);
		await act(async () => old.resolve(fixture(false)));
		await flush();
		expect(client.getQueryData<UnattendedStatus>(unattendedStatusQueryKey)?.enabled).toBe(true);
	});

	test("offline failed probes keep their safety timer and the last observer tears it down", async () => {
		connected = false;
		response = () => Promise.reject(new Error("offline"));
		await mount();
		const initial = requests.length;
		await advance(60_000);
		expect(requests).toHaveLength(initial + 1);
		await mount(1, false);
		expect(timers.size).toBe(0);
		expect(listeners.size).toBe(0);
		await advance(120_000);
		expect(requests).toHaveLength(initial + 1);
	});

	test("a second queued hint cancels a read started after the first hint, even without cached data", async () => {
		connected = false;
		response = () => Promise.reject(new Error("initial read failed"));
		await mount();
		expect(client.getQueryData(unattendedStatusQueryKey)).toBeUndefined();
		const old = Promise.withResolvers<UnattendedStatus>();
		const before = requests.length;
		let pending: AbortSignal | undefined;
		const installed: UnattendedStatus[] = [];
		const offCache = client.getQueryCache().subscribe((event) => {
			if (event.type === "updated" && event.action.type === "success") {
				installed.push(event.query.state.data as UnattendedStatus);
			}
		});
		try {
			await act(async () => {
				changed(); // Queued recovery; dirty is now true.
				response = () => old.promise;
				// A newly subscribed observer or explicit read can start HTTP in this window.
				void client.refetchQueries({ queryKey: unattendedStatusQueryKey, exact: true });
				pending = requests.at(-1);
				expect(requests).toHaveLength(before + 1);
				response = undefined;
				changed();
			});
			await flush();
			expect(pending?.aborted).toBe(true);
			expect(requests).toHaveLength(before + 2);
			expect(client.getQueryData<UnattendedStatus>(unattendedStatusQueryKey)?.enabled).toBe(true);
			await act(async () => old.resolve(fixture(false)));
			await flush();
			expect(installed).toHaveLength(1);
			expect(installed.every((snapshot) => snapshot.enabled)).toBe(true);
			expect(client.getQueryData<UnattendedStatus>(unattendedStatusQueryKey)?.enabled).toBe(true);
		} finally {
			offCache();
		}
	});

	test("WS hints invalidate an in-flight reconcile and coalesce one trailing fresh read", async () => {
		await mount();
		const old = Promise.withResolvers<UnattendedStatus>();
		response = () => old.promise;
		await act(async () => changed());
		await flush();
		const pending = requests.at(-1);
		const before = requests.length;
		response = undefined;
		status = { ...fixture(), blockers: { ...fixture().blockers, narrators: 9 } };
		await act(async () => {
			for (let i = 0; i < 20; i++) changed();
		});
		await flush();
		expect(pending?.aborted).toBe(true);
		expect(requests).toHaveLength(before + 1);
		await act(async () => old.resolve(fixture(false)));
		await flush();
		expect(container.textContent).toBe("9");
	});

	test("disabled signed-out observers neither subscribe nor request", async () => {
		await mount(2, false);
		expect(listeners.size).toBe(0);
		expect(requests).toHaveLength(0);
		await advance(120_000);
		expect(requests).toHaveLength(0);
	});
});
