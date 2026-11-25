import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { api } from "@frontend/lib/api";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import type { PendingAgentMessagesPage } from "@shared/agent-inbox";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	pendingAgentMessagesQueryKey,
	usePendingAgentMessages,
} from "./use-pending-agent-messages";

let root: Root;
let host: HTMLElement;
let qc: QueryClient;
let current: ReturnType<typeof usePendingAgentMessages>;
let narratorId = "n1";
let read: ReturnType<typeof spyOn<typeof api, "getPendingAgentMessages">>;
const originals = new Map<string, PropertyDescriptor | undefined>();
const restores: Array<() => void> = [];
const listeners = new Map<number, (frame: Record<string, unknown>) => void>();
const connections = new Set<(connected: boolean, isReconnect: boolean) => void>();
const recoveries = new Set<() => void>();
let listenerId = 0;

const page = (overrides: Partial<PendingAgentMessagesPage> = {}): PendingAgentMessagesPage => ({
	messages: [],
	hasMore: false,
	running: true,
	blockedReason: null,
	...overrides,
});
const message = (id: string) => ({
	id,
	sender: null,
	preview: id,
	truncated: false,
	createdAt: "now",
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function Harness() {
	current = usePendingAgentMessages(narratorId);
	return null;
}
const render = () =>
	act(async () =>
		root.render(
			<QueryClientProvider client={qc}>
				<Harness />
			</QueryClientProvider>,
		),
	);
const emit = (...frames: Record<string, unknown>[]) =>
	act(async () => {
		for (const frame of frames)
			for (const listener of listeners.values()) listener({ narratorId, ...frame });
	});
const connection = (connected: boolean) =>
	act(async () => {
		for (const callback of connections) callback(connected, connected);
	});

beforeEach(() => {
	const { window } = parseHTML("<html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	listeners.clear();
	connections.clear();
	recoveries.clear();
	narratorId = "n1";
	for (const spy of [
		spyOn(narratorWSManager, "addListener").mockImplementation((_options, callback) => {
			const id = ++listenerId;
			listeners.set(id, callback);
			return { _id: id };
		}),
		spyOn(narratorWSManager, "removeListener").mockImplementation((handle) => {
			listeners.delete(handle._id);
		}),
		spyOn(narratorWSManager, "onConnectionChange").mockImplementation((callback) => {
			connections.add(callback);
			return () => {
				connections.delete(callback);
			};
		}),
		spyOn(narratorWSManager, "onControlPlaneRecovery").mockImplementation((callback) => {
			recoveries.add(callback);
			return () => {
				recoveries.delete(callback);
			};
		}),
	])
		restores.push(() => spy.mockRestore());
	notifyManager.setScheduler(queueMicrotask);
	qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	read = spyOn(api, "getPendingAgentMessages").mockResolvedValue(page());
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	qc.clear();
	read.mockRestore();
	for (const restore of restores.splice(0)) restore();
	notifyManager.setScheduler((callback) => setTimeout(callback, 0));
	host.remove();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

describe("event-driven inbox with a real Query observer", () => {
	test("working/waiting and repeated statuses do not read; lifecycle/terminal boundaries do", async () => {
		await render();
		await emit(
			...["working", "waiting", "working", "waiting", "waiting"].map((status) => ({
				type: "status_change",
				status,
			})),
		);
		expect(read).toHaveBeenCalledTimes(1);
		read.mockResolvedValue(
			page({ running: false, blockedReason: "user_interrupt", messages: [message("held")] }),
		);
		await emit({ type: "status_change", status: "idle" });
		expect(read).toHaveBeenCalledTimes(2);
		expect(current.data?.blockedReason).toBe("user_interrupt");
		await emit({ type: "status_change", status: "idle" });
		expect(read).toHaveBeenCalledTimes(2);
		await emit({ type: "status_change", status: "archived" });
		expect(read).toHaveBeenCalledTimes(3);
		await emit({ type: "status_change", status: "working" });
		expect(read).toHaveBeenCalledTimes(4);
	});

	test("a burst cancels the pre-event initial snapshot and reads once", async () => {
		const old = deferred<PendingAgentMessagesPage>();
		read.mockReturnValueOnce(old.promise);
		await render();
		const initialSignal = read.mock.calls[0]?.[1];
		read.mockResolvedValue(
			page({ running: false, blockedReason: "error", messages: [message("new")] }),
		);
		await emit(...Array.from({ length: 20 }, () => ({ type: "agent_inbox_changed" })));
		expect(initialSignal?.aborted).toBe(true);
		expect(read).toHaveBeenCalledTimes(2);
		expect(current.data?.messages[0]?.id).toBe("new");
		await act(async () => old.resolve(page({ messages: [message("old")] })));
		expect(current.data?.messages[0]?.id).toBe("new");
		expect(current.data?.blockedReason).toBe("error");
	});

	test("a lifecycle edge before the initial snapshot reconciles once, then ignores status noise", async () => {
		const old = deferred<PendingAgentMessagesPage>();
		read.mockReturnValueOnce(old.promise);
		await render();
		const initialSignal = read.mock.calls[0]?.[1];
		read.mockResolvedValue(
			page({ running: false, blockedReason: "user_interrupt", messages: [message("held")] }),
		);
		await emit({ type: "status_change", status: "idle" });
		expect(initialSignal?.aborted).toBe(true);
		expect(read).toHaveBeenCalledTimes(2);
		await emit({ type: "status_change", status: "idle" });
		expect(read).toHaveBeenCalledTimes(2);
		await act(async () => old.resolve(page()));
		expect(current.data?.blockedReason).toBe("user_interrupt");
	});

	test("notifications during a pending refresh merge to exactly one trailing read", async () => {
		await render();
		const pending = deferred<PendingAgentMessagesPage>();
		read.mockReturnValueOnce(pending.promise);
		await emit({ type: "agent_inbox_changed" });
		expect(read).toHaveBeenCalledTimes(2);
		const refreshSignal = read.mock.calls[1]?.[1];
		await emit(...Array.from({ length: 30 }, () => ({ type: "agent_inbox_changed" })));
		expect(read).toHaveBeenCalledTimes(2);
		expect(refreshSignal?.aborted).toBe(false);
		read.mockResolvedValue(page({ running: false, messages: [message("latest")] }));
		await act(async () =>
			pending.resolve(page({ running: false, messages: [message("earlier")] })),
		);
		expect(read).toHaveBeenCalledTimes(3);
		expect(current.data?.messages[0]?.id).toBe("latest");
	});

	test("reconnection, foreground recovery and settled actions each reconcile current server state", async () => {
		await render();
		await connection(false);
		expect(read).toHaveBeenCalledTimes(1);
		await connection(true);
		expect(read).toHaveBeenCalledTimes(2);
		await act(async () => {
			for (const recover of recoveries) recover();
		});
		expect(read).toHaveBeenCalledTimes(3);
		read.mockResolvedValue(page({ running: false, messages: [message("resume-failed")] }));
		await act(async () => {
			await current.refresh();
		});
		expect(current.data?.messages[0]?.id).toBe("resume-failed");
		read.mockResolvedValue(page({ running: false }));
		await act(async () => {
			await current.refresh();
		});
		expect(current.data?.messages).toEqual([]);
		expect(read).toHaveBeenCalledTimes(5);
	});

	test("switching narrator cancels old requests and detaches old lifecycle listeners", async () => {
		const old = deferred<PendingAgentMessagesPage>();
		read.mockReturnValueOnce(old.promise);
		await render();
		const oldSignal = read.mock.calls[0]?.[1];
		narratorId = "n2";
		read.mockResolvedValue(page({ running: false, messages: [message("n2")] }));
		await render();
		expect(oldSignal?.aborted).toBe(true);
		expect(listeners.size).toBe(1);
		expect(connections.size).toBe(1);
		expect(recoveries.size).toBe(1);
		await act(async () => old.resolve(page({ messages: [message("private-old")] })));
		expect(current.data?.messages[0]?.id).toBe("n2");
		expect(qc.getQueryData(pendingAgentMessagesQueryKey("n1"))).toBeUndefined();
	});
});
