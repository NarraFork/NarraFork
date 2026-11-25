import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EXECUTION_DEVICES_CHANGED_WS_TYPE } from "@shared/execution-devices";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { useNarratorExecutionDevices } from "./useNarratorExecutionDevices";

type DeviceState = Awaited<ReturnType<typeof api.getNarratorExecutionDevices>>;
let client: QueryClient;
let root: Root;
let container: HTMLElement;
let connection: (connected: boolean, isReconnect: boolean) => void;
let recovery: () => void;
let reads: ReturnType<typeof spyOn<typeof api, "getNarratorExecutionDevices">>;
const globals = new Map<string, PropertyDescriptor | undefined>();
const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout as (id: unknown) => void;
let nextTimer = 100_000;
const offConnection = mock(() => {});
const offRecovery = mock(() => {});

const state = (deviceId: string | null = null): DeviceState => ({
	defaultDeviceId: deviceId,
	devices: [],
	directories: {},
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function Probe({ id, enabled = true }: { id: string; enabled?: boolean }) {
	useNarratorExecutionDevices(id, enabled);
	return null;
}
async function mount(ids: Array<[string, boolean, string?]> = [["n1", true]]) {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				{ids.map(([id, enabled, slot]) => (
					<Probe key={slot ?? id} id={id} enabled={enabled} />
				))}
			</QueryClientProvider>,
		);
	});
}
async function settle() {
	await act(async () => {
		await new Promise((resolve) => realSetTimeout(resolve, 0));
	});
}
async function flushHints() {
	await act(async () => {
		const pending = [...timers.values()];
		timers.clear();
		for (const callback of pending) callback();
		for (let i = 0; i < 10; i++) await Promise.resolve();
	});
	await settle();
}
function hint() {
	narratorWSManager.dispatchLocalFrame({ type: EXECUTION_DEVICES_CHANGED_WS_TYPE });
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
	}
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	offConnection.mockClear();
	offRecovery.mockClear();
	spyOn(narratorWSManager, "onConnectionChange").mockImplementation((callback) => {
		connection = callback;
		return offConnection;
	});
	spyOn(narratorWSManager, "onControlPlaneRecovery").mockImplementation((callback) => {
		recovery = callback;
		return offRecovery;
	});
	reads = spyOn(api, "getNarratorExecutionDevices").mockResolvedValue(state());
	spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		delay?: number,
		...args: unknown[]
	) => {
		if (delay !== 100) return realSetTimeout(callback, delay, ...args);
		const id = ++nextTimer as unknown as ReturnType<typeof setTimeout>;
		timers.set(id, callback);
		return id;
	}) as typeof setTimeout);
	spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
		if (!timers.delete(id as ReturnType<typeof setTimeout>)) realClearTimeout(id);
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	timers.clear();
	mock.restore();
	container.remove();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

describe("event-driven narrator execution devices", () => {
	test("several panels share one subscription and one initial read per narrator without interval polling", async () => {
		const add = spyOn(narratorWSManager, "addListener");
		const intervals = spyOn(globalThis, "setInterval");
		await mount([
			["n1", true],
			["n1", true, "dialog"],
			["n2", true],
			["disabled", false],
		]);
		await settle();
		expect(reads.mock.calls.map(([id]) => id).sort()).toEqual(["n1", "n2"]);
		expect(add).toHaveBeenCalledTimes(1);
		expect(add.mock.calls[0]?.[0]).toEqual({ types: [EXECUTION_DEVICES_CHANGED_WS_TYPE] });
		expect(intervals).not.toHaveBeenCalled();
		expect(timers.size).toBe(0);
	});

	test("bursts coalesce, refresh active narrators only and do not refresh unrelated queries", async () => {
		await mount([
			["n1", true],
			["disabled", false],
		]);
		await settle();
		client.setQueryData(["narratorExecutionDevices", "hidden"], state());
		client.setQueryData(["narrators", "n1"], { id: "n1" });
		for (let i = 0; i < 10; i++) hint();
		expect(timers.size).toBe(1);
		await flushHints();
		expect(reads.mock.calls.map(([id]) => id)).toEqual(["n1", "n1"]);
		expect(client.getQueryState(["narratorExecutionDevices", "hidden"])?.isInvalidated).toBe(true);
		expect(client.getQueryState(["narrators", "n1"])?.isInvalidated).toBe(false);
		expect(timers.size).toBe(0);
	});

	test("first connect, reconnect and foreground recover once; disconnect and unrelated frames do not read", async () => {
		await mount();
		await settle();
		connection(false, false);
		narratorWSManager.dispatchLocalFrame({
			type: "status_change",
			narratorId: "n1",
			status: "working",
		});
		expect(timers.size).toBe(0);
		connection(true, false);
		hint();
		await flushHints();
		expect(reads).toHaveBeenCalledTimes(2);
		connection(false, false);
		connection(true, true);
		hint();
		await flushHints();
		expect(reads).toHaveBeenCalledTimes(3);
		recovery();
		recovery();
		await flushHints();
		expect(reads).toHaveBeenCalledTimes(4);
	});

	test("a device hint cancels an initial stale HTTP response and installs the authoritative replacement", async () => {
		const old = deferred<DeviceState>();
		reads.mockImplementationOnce(() => old.promise).mockResolvedValue(state("current"));
		await mount();
		const signal = reads.mock.calls[0]?.[1];
		expect(signal?.aborted).toBe(false);
		hint();
		expect(signal?.aborted).toBe(true);
		await flushHints();
		expect(reads).toHaveBeenCalledTimes(2);
		await act(async () => old.resolve(state("revoked")));
		await settle();
		expect(client.getQueryData(["narratorExecutionDevices", "n1"])).toEqual(state("current"));
	});

	test("another observer starting a read inside the debounce window is cancelled by the next hint", async () => {
		await mount();
		await settle();
		const old = deferred<DeviceState>();
		let firstSecondNarrator = true;
		reads.mockImplementation((id) => {
			if (id === "n2" && firstSecondNarrator) {
				firstSecondNarrator = false;
				return old.promise;
			}
			return Promise.resolve(state("current"));
		});
		hint();
		await mount([
			["n1", true],
			["n2", true],
		]);
		const newObserverSignal = reads.mock.calls.find(([id]) => id === "n2")?.[1];
		expect(newObserverSignal?.aborted).toBe(false);
		hint();
		expect(newObserverSignal?.aborted).toBe(true);
		await flushHints();
		await act(async () => old.resolve(state("revoked")));
		await settle();
		expect(reads).toHaveBeenCalledTimes(4);
		expect(client.getQueryData(["narratorExecutionDevices", "n2"])).toEqual(state("current"));
		expect(timers.size).toBe(0);
	});

	test("changes during a refresh produce one trailing read, never a permanently stale list", async () => {
		await mount();
		await settle();
		const old = deferred<DeviceState>();
		reads.mockImplementationOnce(() => old.promise).mockResolvedValue(state("current"));
		hint();
		await flushHints();
		expect(reads).toHaveBeenCalledTimes(2);
		for (let i = 0; i < 5; i++) hint();
		await settle();
		await flushHints();
		expect(reads).toHaveBeenCalledTimes(3);
		await act(async () => old.resolve(state("revoked")));
		await settle();
		expect(client.getQueryData(["narratorExecutionDevices", "n1"])).toEqual(state("current"));
		expect(timers.size).toBe(0);
	});

	test("the last observer detaches callbacks and clears pending hints; remount repairs missed changes", async () => {
		const remove = spyOn(narratorWSManager, "removeListener");
		await mount([
			["n1", true],
			["n1", true, "dialog"],
		]);
		await settle();
		hint();
		await mount([
			["n1", true],
			["n1", false, "dialog"],
		]);
		expect(remove).not.toHaveBeenCalled();
		await mount([]);
		expect(remove).toHaveBeenCalledTimes(1);
		expect(offConnection).toHaveBeenCalledTimes(1);
		expect(offRecovery).toHaveBeenCalledTimes(1);
		expect(timers.size).toBe(0);
		connection(true, true);
		recovery();
		expect(timers.size).toBe(0);
		reads.mockResolvedValue(state("new"));
		await mount();
		await settle();
		expect(client.getQueryData(["narratorExecutionDevices", "n1"])).toEqual(state("new"));
	});
});
