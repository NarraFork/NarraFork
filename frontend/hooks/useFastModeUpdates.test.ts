import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { useFastModeUpdates } from "./useFastModeUpdates";
import { useUpdateUserPreferences } from "./useUserPreferences";

let client: QueryClient;
let root: Root;
let container: HTMLDivElement;
let connection: (connected: boolean, isReconnect: boolean) => void;
let mutation: ReturnType<typeof useUpdateUserPreferences>;
const originals = new Map<string, PropertyDescriptor | undefined>();
const scheduled = new Map<ReturnType<typeof setTimeout>, () => void>();
const realSetTimeout = globalThis.setTimeout;
// The mocked overload accepts both DOM numeric IDs and Bun timer handles.
const realClearTimeout = globalThis.clearTimeout as (id: unknown) => void;
const releases: Array<() => void> = [];
let timerId = 100_000;
let removeListenerCalls: () => number;
const offConnection = mock(() => {});
function Probe({ enabled }: { enabled: boolean }) {
	useFastModeUpdates(enabled);
	mutation = useUpdateUserPreferences();
	return null;
}
async function mount(enabled = true) {
	await act(async () =>
		root.render(createElement(QueryClientProvider, { client }, createElement(Probe, { enabled }))),
	);
}
function watch(key: readonly unknown[], enabled = true) {
	const read = mock(async () => ({ revision: 1 }));
	const observer = new QueryObserver(client, {
		queryKey: key,
		queryFn: read,
		initialData: { revision: 0 },
		staleTime: Infinity,
		enabled,
	});
	releases.push(observer.subscribe(() => {}));
	return read;
}
async function flushHints() {
	await act(async () => {
		const callbacks = [...scheduled.values()];
		scheduled.clear();
		for (const callback of callbacks) callback();
		for (let i = 0; i < 8; i++) await Promise.resolve();
	});
}
beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
	offConnection.mockClear();
	spyOn(narratorWSManager, "onConnectionChange").mockImplementation((callback) => {
		connection = callback;
		return offConnection;
	});
	const removed = spyOn(narratorWSManager, "removeListener");
	removeListenerCalls = () => removed.mock.calls.length;
	spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		delay?: number,
		...args: unknown[]
	) => {
		if (delay !== 100) return realSetTimeout(callback, delay, ...args);
		const id = ++timerId as unknown as ReturnType<typeof setTimeout>;
		scheduled.set(id, callback);
		return id;
	}) as typeof setTimeout);
	spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
		if (!scheduled.delete(id as ReturnType<typeof setTimeout>)) realClearTimeout(id);
	});
});
afterEach(async () => {
	await act(async () => {
		await new Promise((resolve) => realSetTimeout(resolve, 0));
		root.unmount();
	});
	for (const release of releases.splice(0)) release();
	client.clear();
	scheduled.clear();
	mock.restore();
	container.remove();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

describe("authenticated fast-mode invalidation", () => {
	test("global ID-free hints refresh a child-only page, mark hidden details stale, and leave bodies/lists alone", async () => {
		const child = watch(["narrators", "child"]);
		const disabled = watch(["narrators", "disabled"], false);
		const body = watch(["narrators", "child", "messages"]);
		const list = watch(["narrators", { standalone: true }]);
		const preferences = watch(["user-preferences"]);
		client.setQueryData(["narrators", "hidden"], { revision: 0 });
		const subscribe = spyOn(narratorWSManager, "subscribe");
		await mount();
		for (let i = 0; i < 10; i++)
			narratorWSManager.dispatchLocalFrame({ type: "fast_mode_changed" });
		expect(scheduled.size).toBe(1);
		expect(child).not.toHaveBeenCalled();
		await flushHints();
		expect(child).toHaveBeenCalledTimes(1);
		expect(disabled).not.toHaveBeenCalled();
		expect(client.getQueryState(["narrators", "disabled"])?.isInvalidated).toBe(true);
		expect(client.getQueryState(["narrators", "hidden"])?.isInvalidated).toBe(true);
		expect(body).not.toHaveBeenCalled();
		expect(list).not.toHaveBeenCalled();
		expect(preferences).not.toHaveBeenCalled();
		expect(subscribe).not.toHaveBeenCalled();
		expect(client.getQueryState(["narrators", "root"])).toBeUndefined();
	});
	test("targeted preferences hints merge with the global hint and only literal true refreshes preferences", async () => {
		const detail = watch(["narrators", "child"]);
		const preferences = watch(["user-preferences"]);
		await mount();
		narratorWSManager.dispatchLocalFrame({ type: "fast_mode_changed" });
		narratorWSManager.dispatchLocalFrame({ type: "fast_mode_changed", refreshPreferences: true });
		narratorWSManager.dispatchLocalFrame({ type: "fast_mode_changed" });
		await flushHints();
		expect(detail).toHaveBeenCalledTimes(1);
		expect(preferences).toHaveBeenCalledTimes(1);
		narratorWSManager.dispatchLocalFrame({ type: "fast_mode_changed", refreshPreferences: "true" });
		await flushHints();
		expect(detail).toHaveBeenCalledTimes(2);
		expect(preferences).toHaveBeenCalledTimes(1);
	});
	test("first connection and reconnect repair missed detail and preference changes; disconnect alone does not read", async () => {
		const detail = watch(["narrators", "child"]);
		const preferences = watch(["user-preferences"]);
		await mount();
		connection(false, false);
		expect(scheduled.size).toBe(0);
		connection(true, false);
		await flushHints();
		expect(detail).toHaveBeenCalledTimes(1);
		expect(preferences).toHaveBeenCalledTimes(1);
		connection(false, false);
		connection(true, true);
		narratorWSManager.dispatchLocalFrame({ type: "fast_mode_changed" });
		await flushHints();
		expect(detail).toHaveBeenCalledTimes(2);
		expect(preferences).toHaveBeenCalledTimes(2);
	});
	test("disabling/unmounting removes listeners and cancels a pending flush", async () => {
		const detail = watch(["narrators", "child"]);
		await mount();
		narratorWSManager.dispatchLocalFrame({ type: "fast_mode_changed", refreshPreferences: true });
		expect(scheduled.size).toBe(1);
		await mount(false);
		expect(removeListenerCalls()).toBe(1);
		expect(offConnection).toHaveBeenCalledTimes(1);
		expect(scheduled.size).toBe(0);
		// Even a callback already queued by the manager is harmless after cleanup.
		connection(true, true);
		narratorWSManager.dispatchLocalFrame({ type: "fast_mode_changed" });
		await flushHints();
		expect(detail).not.toHaveBeenCalled();
	});
	test("a disabled authenticated-shell hook never attaches a listener", async () => {
		const listen = spyOn(narratorWSManager, "addListener");
		await mount(false);
		expect(listen).not.toHaveBeenCalled();
	});
	test("successful default mutations invalidate details without requiring WS, unrelated or failed patches do not", async () => {
		const update = spyOn(api, "updateUserPreferences").mockResolvedValue({});
		await mount(false);
		const key = ["narrators", "child"];
		client.setQueryData(key, { revision: 0 });
		await act(async () => {
			await mutation.mutateAsync({ fastModeDefault: false });
		});
		expect(client.getQueryState(key)?.isInvalidated).toBe(true);
		client.setQueryData(key, { revision: 1 });
		await act(async () => {
			await mutation.mutateAsync({ replyInUserLanguage: true });
		});
		expect(client.getQueryState(key)?.isInvalidated).toBe(false);
		update.mockRejectedValue(new Error("write failed"));
		await act(async () => {
			await expect(mutation.mutateAsync({ fastModeDefault: true })).rejects.toThrow("write failed");
		});
		expect(client.getQueryState(key)?.isInvalidated).toBe(false);
	});
});
