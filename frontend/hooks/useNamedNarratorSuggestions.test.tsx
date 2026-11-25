import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../lib/api";
import { getToken, setToken } from "../lib/api/client";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { useNamedNarratorSuggestions } from "./useNamedNarratorSuggestions";

let originals: Map<string, PropertyDescriptor | undefined>;
let client: QueryClient;
let root: Root;
let result: ReturnType<typeof useNamedNarratorSuggestions>;
let requests: { url: string; init: RequestInit; answer: (response: Response) => void }[];
let event: (() => void) | undefined;
let restoreListener: () => void;
let restoreConnection: () => void;
const page = (handle: string) => ({
	items: [{ id: handle, handle, title: handle, status: "idle" }],
	nextCursor: null,
});

function Harness({ q, enabled }: { q: string | null; enabled: boolean }) {
	result = useNamedNarratorSuggestions(q, enabled);
	return <div>{result.data?.items.map((item) => item.handle).join(",") ?? "empty"}</div>;
}
async function flush(ms = 0) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
		for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
async function render(q: string | null = null, enabled = false) {
	await act(async () =>
		root.render(
			<StrictMode>
				<QueryClientProvider client={client}>
					<Harness q={q} enabled={enabled} />
				</QueryClientProvider>
			</StrictMode>,
		),
	);
	await flush();
}

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values = new Map<string, string>();
	requests = [];
	const replacements = {
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
		localStorage: {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
			removeItem: (key: string) => values.delete(key),
		},
		fetch: (url: unknown, init: RequestInit) =>
			new Promise<Response>((answer) => {
				requests.push({ url: String(url), init, answer });
			}),
	};
	originals = new Map();
	for (const [key, value] of Object.entries(replacements)) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	event = undefined;
	const listener = spyOn(narratorWSManager, "addListener").mockImplementation((_opts, cb) => {
		event = () => cb({ type: "narrator_access_changed" });
		return { _id: -1 };
	});
	const connection = spyOn(narratorWSManager, "onConnectionChange").mockReturnValue(() => {});
	restoreListener = () => listener.mockRestore();
	restoreConnection = () => connection.mockRestore();
	setToken("session-a");
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	root = createRoot(document.createElement("div"));
});

afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	restoreListener();
	restoreConnection();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test("closed, unfocused/no-mention and overlong inputs do not request; StrictMode debounces once", async () => {
	await render("", false);
	await flush(200);
	await render(null, true);
	await flush(200);
	await render("𐐨".repeat(33), true);
	await flush(200);
	expect(requests).toHaveLength(0);
	await render("小", true);
	expect(requests).toHaveLength(0);
	await render("小明", true);
	await flush(200);
	expect(requests).toHaveLength(1);
	const url = new URL(requests[0].url, "http://local");
	expect(url.searchParams.get("view")).toBe("suggestions");
	expect(url.searchParams.get("q")).toBe("小明");
	requests[0].answer(Response.json(page("小明")));
	await flush();
	expect(result.data?.items[0].handle).toBe("小明");
});

test("changing search hides previous rows immediately and cancels the previous request", async () => {
	await render("alpha", true);
	await flush(200);
	requests[0].answer(Response.json(page("alpha")));
	await flush();
	expect(result.data?.items[0].handle).toBe("alpha");
	await render("beta", true);
	expect(result.data).toBeUndefined();
	await flush(200);
	expect(requests).toHaveLength(2);
	await render("gamma", true);
	expect(requests[1].init.signal?.aborted).toBe(true);
	requests[1].answer(Response.json(page("beta")));
	await flush();
	expect(result.data).toBeUndefined();
	await flush(200);
	requests[2].answer(Response.json(page("gamma")));
	await flush();
	expect(result.data?.items[0].handle).toBe("gamma");
});

test("close cancels in-flight request; token change never displays old-account results", async () => {
	await render("alpha", true);
	await flush(200);
	await render("alpha", false);
	expect(requests[0].init.signal?.aborted).toBe(true);
	requests[0].answer(Response.json(page("old")));
	await flush();
	expect(result.data).toBeUndefined();
	await render("alpha", true);
	await flush(200);
	requests[1].answer(Response.json(page("account-a")));
	await flush();
	expect(result.data?.items[0].handle).toBe("account-a");
	await act(async () => setToken("session-b"));
	expect(result.data).toBeUndefined();
	await flush(200);
	expect((requests[2].init.headers as Record<string, string>).Authorization).toBe(
		"Bearer session-b",
	);
	requests[2].answer(Response.json(page("account-b")));
	await flush();
	expect(result.data?.items[0].handle).toBe("account-b");
});

test("cross-tab storage token change hides rows and aborts without another component rerender", async () => {
	await render("alpha", true);
	await flush(200);
	await act(async () => {
		localStorage.setItem("narrafork_token", "other-tab-b");
		const storage = new window.Event("storage");
		Object.defineProperty(storage, "key", { value: "narrafork_token" });
		window.dispatchEvent(storage);
	});
	expect(requests[0].init.signal?.aborted).toBe(true);
	expect(result.data).toBeUndefined();
	requests[0].answer(Response.json(page("old-account")));
	await flush(200);
	expect(result.data).toBeUndefined();
	requests[1].answer(Response.json(page("new-account")));
	await flush();
	expect(result.data?.items[0].handle).toBe("new-account");
	await act(async () => {
		localStorage.removeItem("narrafork_token");
		const storage = new window.Event("storage");
		Object.defineProperty(storage, "key", { value: null });
		window.dispatchEvent(storage);
	});
	expect(result.data).toBeUndefined();
	await flush(200);
	expect(requests).toHaveLength(2);
});

test("ACL invalidation clears rows and reauthorizes without showing stale entries", async () => {
	await render("alpha", true);
	await flush(200);
	requests[0].answer(Response.json(page("visible")));
	await flush();
	expect(result.data?.items).toHaveLength(1);
	await act(async () => event?.());
	await flush();
	expect(result.data).toBeUndefined();
	expect(requests).toHaveLength(2);
	requests[1].answer(Response.json({ items: [], nextCursor: null }));
	await flush();
	expect(result.data?.items).toEqual([]);
});

test("closed views invalidate revoked caches without requesting, and reauthorize on reopen", async () => {
	await render("alpha", true);
	await flush(200);
	requests[0].answer(Response.json(page("visible")));
	await flush();
	await render("alpha", false);
	await act(async () => event?.());
	await flush(200);
	expect(requests).toHaveLength(1);
	await render("alpha", true);
	expect(result.data).toBeUndefined();
	await flush(200);
	expect(requests).toHaveLength(2);
});

test("late old-session 401 does not clear a newer token", async () => {
	await render("alpha", true);
	await flush(200);
	await act(async () => setToken("session-b"));
	requests[0].answer(Response.json({ code: "TOKEN_EXPIRED" }, { status: 401 }));
	await flush();
	expect(getToken()).toBe("session-b");
	expect(result.data).toBeUndefined();
});

test("bounded named API preserves full legacy endpoint and rejects over-budget response", async () => {
	const legacy = api.listNamedNarrators();
	expect(requests[0].url).toBe("/api/narrators/named");
	requests[0].answer(Response.json([]));
	await legacy;
	const pending = api.listNamedNarratorSuggestions();
	requests[1].answer(Response.json({ items: [], huge: "x".repeat(49 * 1024) }));
	await expect(pending).rejects.toThrow("byte budget");
});
