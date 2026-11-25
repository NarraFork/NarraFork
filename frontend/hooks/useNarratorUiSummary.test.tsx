import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";

const listeners = new Set<(event: Record<string, unknown>) => void>();
const connections = new Set<(connected: boolean) => void>();
const recoveries = new Set<() => void>();
mock.module("./usePlatform", () => ({ useTerminalCapability: () => ({ supported: true }) }));
mock.module("../lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		addListener: (_options: unknown, callback: (event: Record<string, unknown>) => void) => {
			listeners.add(callback);
			return callback;
		},
		removeListener: (callback: (event: Record<string, unknown>) => void) =>
			listeners.delete(callback),
		onConnectionChange: (callback: (connected: boolean) => void) => {
			connections.add(callback);
			return () => connections.delete(callback);
		},
		onControlPlaneRecovery: (callback: () => void) => {
			recoveries.add(callback);
			return () => recoveries.delete(callback);
		},
	},
}));
const { businessTransport } = await import("../lib/business-transport");
const { clearToken, confirmAuthUser, getAuthSnapshot, setToken } = await import(
	"../lib/api/client"
);
const { getNarratorUiSummary } = await import("../lib/api/narrator-ui-summary");
const { narratorUiSummaryKey, useNarratorUiSummary } = await import("./useNarratorUiSummary");
const { useCanOpenTerminals, useNarratorTerminals } = await import("./useTerminals");

const summary = (count = 2, roomId: string | null = "room") => ({
	narratorId: "n",
	canWrite: true,
	activeTerminalCount: count,
	discussion: { roomId, unread: 4, unreadCapped: false },
});
let root: Root;
let client: QueryClient;
let host: HTMLElement;
let calls: string[];
let pending: ((response: Response) => void) | undefined;
let pendingSignal: AbortSignal | undefined;
let delay = false;
let payload = summary();
let requests: ReturnType<typeof spyOn>;
const originals = new Map<string, PropertyDescriptor | undefined>();

function Probe({ visible = false }: { visible?: boolean }) {
	return (
		<>
			{["route", "badge", "access"].map((name) => (
				<Consumer key={name} visible={visible} />
			))}
		</>
	);
}
function SummaryOnly({ narratorId }: { narratorId: string }) {
	useNarratorUiSummary(narratorId);
	return null;
}
function Consumer({ visible }: { visible: boolean }) {
	const query = useNarratorUiSummary("n");
	const canOpen = useCanOpenTerminals("n");
	useNarratorTerminals("n", visible);
	return (
		<output>{`${query.data?.activeTerminalCount ?? "?"}:${query.data?.discussion.unread ?? "?"}:${canOpen ?? "?"}`}</output>
	);
}
async function flush(ms = 0) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}
async function render(visible = false, strict = false) {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				{strict ? (
					<StrictMode>
						<Probe visible={visible} />
					</StrictMode>
				) : (
					<Probe visible={visible} />
				)}
			</QueryClientProvider>,
		),
	);
	await flush();
}
function emit(event: Record<string, unknown>) {
	for (const callback of listeners) callback(event);
}
const cache = () =>
	client.getQueryData<ReturnType<typeof summary>>(
		narratorUiSummaryKey("n", getAuthSnapshot().generation),
	);

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.defineProperty(window.document, "visibilityState", {
		value: "visible",
		configurable: true,
	});
	const store = new Map<string, string>();
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		IS_REACT_ACT_ENVIRONMENT: true,
		localStorage: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
		},
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	setToken("token-a");
	calls = [];
	delay = false;
	pending = undefined;
	payload = summary();
	requests = spyOn(businessTransport, "request").mockImplementation(async (url, options) => {
		calls.push(String(url));
		if (String(url).includes("ui-summary")) {
			if (delay) {
				pendingSignal = options?.signal ?? undefined;
				return new Promise<Response>((resolve) => {
					pending = resolve;
				});
			}
			return Response.json(payload);
		}
		if (String(url).includes("/terminals?")) return Response.json([]);
		throw new Error(`Unexpected endpoint ${url}`);
	});
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	await flush();
	requests.mockRestore();
	clearToken();
	host.remove();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

test("route/badge/access observers share one summary and hidden terminals read no entities/access/resolver", async () => {
	await render();
	expect(calls).toEqual(["/api/narrators/n/ui-summary"]);
	expect(listeners.size).toBe(1);
	expect(host.textContent).toBe("2:4:true".repeat(3));
	await act(async () => confirmAuthUser(getAuthSnapshot().generation, "user-a"));
	await flush();
	expect(calls).toEqual(["/api/narrators/n/ui-summary"]);
	await render(true);
	expect(calls.filter((path) => path.includes("/terminals?"))).toHaveLength(1);
	expect(calls.some((path) => path.includes("/access") || path.includes("/chat"))).toBe(false);
});
test("WS counts and unread replace an older pending HTTP read, never the reverse", async () => {
	await render();
	delay = true;
	void client.invalidateQueries({ queryKey: ["narrator-ui-summary"] });
	await flush();
	expect(pending).toBeDefined();
	await act(async () =>
		emit({ type: "terminal_count_changed", narratorId: "n", activeTerminalCount: 9 }),
	);
	expect(pendingSignal?.aborted).toBe(true);
	pending?.(Response.json(summary(1)));
	await flush();
	expect(cache()?.activeTerminalCount).toBe(9);
	await act(async () => emit({ type: "chat:unread_changed", roomId: "room", unread: 8 }));
	expect(cache()?.discussion.unread).toBe(8);
	expect(calls).toHaveLength(2);
});
test("ACL hints fail closed synchronously and coalesce the summary refresh", async () => {
	await render();
	delay = true;
	await act(async () => {
		emit({ type: "narrator_access_changed", narratorId: "n" });
		emit({ type: "project_access_changed", projectId: "p" });
	});
	expect(cache()?.canWrite).toBe(false);
	await flush(130);
	expect(calls).toHaveLength(2);
	pending?.(Response.json({ ...summary(), canWrite: false }));
	await flush();
	expect(host.textContent).toBe("2:4:false".repeat(3));
});
test("a count frame interrupting ACL reconciliation schedules one replacement read", async () => {
	await render();
	delay = true;
	await act(async () => emit({ type: "narrator_access_changed", narratorId: "n" }));
	await flush(130);
	const olderRead = pending;
	expect(cache()?.canWrite).toBe(false);
	delay = false;
	payload = summary(12);
	await act(async () =>
		emit({ type: "terminal_count_changed", narratorId: "n", activeTerminalCount: 12 }),
	);
	olderRead?.(Response.json({ ...summary(1), canWrite: false }));
	await flush(130);
	await flush();
	expect(cache()?.activeTerminalCount).toBe(12);
	expect(cache()?.canWrite).toBe(true);
	expect(calls).toHaveLength(3);
});
test("a no-room summary discovers a newly created room without calling its resolver", async () => {
	payload = summary(0, null);
	await render();
	payload = summary(0, "new-room");
	await act(async () => emit({ type: "chat:room_created", narratorId: "n", roomId: "new-room" }));
	await flush(130);
	await flush();
	expect(cache()?.discussion.roomId).toBe("new-room");
	expect(calls).toEqual(["/api/narrators/n/ui-summary", "/api/narrators/n/ui-summary"]);
});
test("fresh no-room summaries ignore unrelated legacy DMs and other narrators' targeted unread frames", async () => {
	payload = summary(0, null);
	await render();
	await act(async () => {
		for (let index = 0; index < 100; index++) {
			emit({ type: "chat:unread_changed", roomId: `dm-${index}`, unread: 1 });
			emit({ type: "chat:unread_changed", narratorId: "other", roomId: "other-room", unread: 1 });
			emit({ type: "chat:room_created", narratorId: "other", roomId: "other-room" });
		}
	});
	await flush(130);
	expect(calls).toHaveLength(1);
	payload = summary(0, "new-room");
	await act(async () =>
		emit({ type: "chat:unread_changed", narratorId: "n", roomId: "new-room", unread: 4 }),
	);
	await flush(130);
	await flush();
	expect(calls).toHaveLength(2);
	expect(cache()?.discussion.roomId).toBe("new-room");
});
test("a targeted creation refreshes only its narrator among multiple no-room panels", async () => {
	payload = summary(0, null);
	requests.mockImplementation(async (url: string) => {
		calls.push(url);
		return Response.json({ ...payload, narratorId: url.split("/")[3] });
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<SummaryOnly narratorId="n" />
				<SummaryOnly narratorId="other" />
			</QueryClientProvider>,
		),
	);
	await flush();
	expect(calls).toHaveLength(2);
	payload = summary(0, "new-room");
	await act(async () => emit({ type: "chat:room_created", narratorId: "n", roomId: "new-room" }));
	await flush(130);
	await flush();
	expect(calls.filter((path) => path === "/api/narrators/n/ui-summary")).toHaveLength(2);
	expect(calls.filter((path) => path === "/api/narrators/other/ui-summary")).toHaveLength(1);
	expect(
		client.getQueryData<ReturnType<typeof summary>>(
			narratorUiSummaryKey("other", getAuthSnapshot().generation),
		)?.discussion.roomId,
	).toBeNull();
});
test("legacy unknown-room events allow one stale probe per 30 seconds even when that probe fails", async () => {
	payload = summary(0, null);
	await render();
	client.setQueryData(narratorUiSummaryKey("n", getAuthSnapshot().generation), payload, {
		updatedAt: Date.now() - 31_000,
	});
	requests.mockImplementation(async (url: string) => {
		calls.push(url);
		return Response.json({ error: "Retry later" }, { status: 503 });
	});
	const burst = () => {
		for (let index = 0; index < 100; index++)
			emit({ type: "chat:unread_changed", roomId: `dm-${index}`, unread: 1 });
	};
	await act(async () => burst());
	await flush(130);
	await flush();
	expect(calls).toHaveLength(2);
	await act(async () => burst());
	await flush(130);
	expect(calls).toHaveLength(2);
});
test("known-room legacy unread updates remain a direct cache patch and unrelated rooms never refresh it", async () => {
	await render();
	client.setQueryData(narratorUiSummaryKey("n", getAuthSnapshot().generation), summary(), {
		updatedAt: Date.now() - 31_000,
	});
	await act(async () => {
		emit({ type: "chat:unread_changed", roomId: "dm", unread: 1 });
		emit({ type: "chat:unread_changed", roomId: "room", unread: 6 });
	});
	await flush(130);
	expect(cache()?.discussion.unread).toBe(6);
	expect(calls).toHaveLength(1);
});
test("workspace changes, connection edges and foreground recovery coalesce bounded refreshes", async () => {
	await render();
	await act(async () => {
		emit({ type: "workspace_context_changed", narratorId: "n", current: { revision: 2 } });
		for (const callback of connections) callback(true);
		for (const callback of recoveries) callback();
	});
	await flush(130);
	await flush();
	expect(calls).toHaveLength(2);
});
test("a replacement generation aborts old reads even when the same token returns", async () => {
	delay = true;
	await render();
	const resolveOld = pending;
	const oldSignal = pendingSignal;
	delay = false;
	payload = { ...summary(7), canWrite: false };
	await act(async () => {
		setToken("token-b");
		setToken("token-a");
	});
	await flush();
	expect(oldSignal?.aborted).toBe(true);
	resolveOld?.(Response.json(summary(999)));
	await flush();
	expect(cache()?.activeTerminalCount).toBe(7);
	expect(cache()?.canWrite).toBe(false);
	expect(listeners.size).toBe(1);
});
test("unknown access never enables terminal entity reads", async () => {
	delay = true;
	await render(true);
	expect(calls).toEqual(["/api/narrators/n/ui-summary"]);
	expect(host.textContent).toBe("?:?:?".repeat(3));
});
test("StrictMode retains one WS owner and eventually obtains a summary", async () => {
	await render(false, true);
	await flush();
	expect(listeners.size).toBe(1);
	expect(cache()?.activeTerminalCount).toBe(2);
});
test("summary reader rejects over-budget and invalid DTOs instead of inventing empty success", async () => {
	requests.mockImplementationOnce(async () =>
		Response.json({ ...summary(), padding: "x".repeat(2048) }),
	);
	await expect(getNarratorUiSummary("n")).rejects.toThrow();
	requests.mockImplementationOnce(async () => Response.json({ ...summary(), canWrite: "yes" }));
	await expect(getNarratorUiSummary("n")).rejects.toThrow("Invalid narrator UI summary");
});
test("hiding the final terminal observer aborts its list and later count/reconnect events do not read entities", async () => {
	await render();
	let listSignal: AbortSignal | undefined;
	let resolveList: ((response: Response) => void) | undefined;
	requests.mockImplementation(async (url: string, options?: RequestInit) => {
		calls.push(String(url));
		if (String(url).includes("ui-summary")) return Response.json(payload);
		listSignal = options?.signal ?? undefined;
		return new Promise<Response>((resolve) => {
			resolveList = resolve;
		});
	});
	await render(true);
	expect(listSignal?.aborted).toBe(false);
	await render(false);
	expect(listSignal?.aborted).toBe(true);
	await act(async () => {
		emit({ type: "terminal_count_changed", narratorId: "n", activeTerminalCount: 3 });
		for (const callback of connections) callback(true);
	});
	resolveList?.(Response.json([{ id: "late" }]));
	await flush(130);
	expect(calls.filter((path) => path.includes("/terminals?"))).toHaveLength(1);
});
test("fresh focus is free while a stale focus revalidates the shared summary once", async () => {
	await render();
	await act(async () => {
		focusManager.setFocused(false);
		focusManager.setFocused(true);
	});
	await flush();
	expect(calls).toHaveLength(1);
	client.setQueryData(narratorUiSummaryKey("n", getAuthSnapshot().generation), summary(), {
		updatedAt: Date.now() - 31_000,
	});
	await act(async () =>
		emit({ type: "terminal_count_changed", narratorId: "n", activeTerminalCount: 10 }),
	);
	await act(async () => {
		focusManager.setFocused(false);
		focusManager.setFocused(true);
	});
	await flush();
	expect(calls).toHaveLength(2);
	focusManager.setFocused(undefined);
});
test("badge frames cannot turn a denied HTTP authorization snapshot back into allow", async () => {
	await render();
	requests.mockImplementation(async () => Response.json({ error: "Forbidden" }, { status: 403 }));
	await act(async () => {
		await client.invalidateQueries({ queryKey: ["narrator-ui-summary"] });
	});
	await flush();
	expect(host.textContent).toBe("2:4:?".repeat(3));
	await act(async () =>
		emit({ type: "terminal_count_changed", narratorId: "n", activeTerminalCount: 10 }),
	);
	await flush();
	expect(host.textContent).toBe("2:4:?".repeat(3));
});
test("summary timeout aborts the underlying transport", async () => {
	const nativeTimeout = globalThis.setTimeout;
	const timeouts = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		ms?: number,
	) => nativeTimeout(callback, ms === 10_000 ? 1 : ms)) as typeof setTimeout);
	let signal: AbortSignal | undefined;
	requests.mockImplementation(async (_url: string, options?: RequestInit) => {
		signal = options?.signal ?? undefined;
		return new Promise<Response>((_resolve, reject) => {
			signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
		});
	});
	try {
		await expect(getNarratorUiSummary("n")).rejects.toThrow("UI summary request timed out");
		expect(signal?.aborted).toBe(true);
	} finally {
		timeouts.mockRestore();
	}
});
test("an already aborted summary cannot send a request", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(getNarratorUiSummary("n", { signal: controller.signal })).rejects.toThrow();
	expect(calls).toHaveLength(0);
});
