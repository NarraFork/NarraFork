import { afterEach, beforeEach, expect, test } from "bun:test";
import { narratorCommunicationApi } from "./narrator-communication";

const originalFetch = globalThis.fetch;
let previousStorage: PropertyDescriptor | undefined;
beforeEach(() => {
	previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => null, setItem() {}, removeItem() {} },
	});
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

test("candidate search encodes scope and query and propagates cancellation", async () => {
	let requested: URL | undefined;
	let signal: AbortSignal | null | undefined;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		requested = new URL(String(url), "http://test");
		signal = init?.signal;
		return Response.json({ items: [], hasMore: false });
	}) as unknown as typeof fetch;
	const controller = new AbortController();
	await narratorCommunicationApi.searchCommunicationCandidates("a/b", "中文 & @x", {
		signal: controller.signal,
		limit: 20,
	});
	expect(requested?.pathname).toBe("/api/narrators/a%2Fb/communication/candidates");
	expect(Object.fromEntries(requested?.searchParams ?? [])).toEqual({
		q: "中文 & @x",
		limit: "20",
	});
	expect(signal).toBe(controller.signal);
});

test("exact candidate lookup sends targetId separately from the query", async () => {
	let requested: URL | undefined;
	globalThis.fetch = (async (url: string | URL | Request) => {
		requested = new URL(String(url), "http://test");
		return Response.json({ items: [], hasMore: false });
	}) as unknown as typeof fetch;
	await narratorCommunicationApi.searchCommunicationCandidates("source", "", {
		targetId: "old-narrator_1",
	});
	expect(requested?.pathname).toBe("/api/narrators/source/communication/candidates");
	expect(Object.fromEntries(requested?.searchParams ?? [])).toEqual({
		q: "",
		targetId: "old-narrator_1",
	});
});

test("management preserves the exact relation identity without adding an inbox send", async () => {
	const requests: Array<{ path: string; method?: string; body: unknown }> = [];
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		requests.push({
			path: new URL(String(url), "http://test").pathname,
			method: init?.method,
			body: JSON.parse(String(init?.body)),
		});
		return Response.json({ changed: true });
	}) as unknown as typeof fetch;
	await narratorCommunicationApi.mutateCommunication("a", {
		kind: "disconnect",
		peerId: "precise-edge",
	});
	expect(requests).toEqual([
		{
			path: "/api/narrators/a/communication",
			method: "POST",
			body: { kind: "disconnect", peerId: "precise-edge" },
		},
	]);
});

test("a stale node version is surfaced without blindly retrying", async () => {
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		return Response.json({ error: "Relationship changed" }, { status: 409 });
	}) as unknown as typeof fetch;
	await expect(
		narratorCommunicationApi.mutateCommunication("a", { kind: "split", version: 1 }),
	).rejects.toThrow();
	expect(calls).toBe(1);
});

test("oversized candidate responses fail within the transport budget", async () => {
	globalThis.fetch = (async () =>
		new Response("", {
			headers: { "content-length": String(1024 * 1024) },
		})) as unknown as typeof fetch;
	await expect(narratorCommunicationApi.searchCommunicationCandidates("a", "q")).rejects.toThrow();
});
