import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	approveKitRequest,
	forgetKitOverview,
	loadKitOverview,
	loadUiRuntime,
	resetUiRuntimeCachesForTest,
} from "./kit-client";

const originalFetch = globalThis.fetch;
const saved = new Map<string, PropertyDescriptor | undefined>();
let requests: Array<{ url: string; method: string; token: string | null }>;
/** What the stand-in server answers for the kit overview and bundle. */
let server: {
	overview?: () => Response;
	bundle?: () => Response;
};

function putGlobal(key: string, value: unknown) {
	if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const count = (fragment: string) => requests.filter((r) => r.url.includes(fragment)).length;
const signal = () => new AbortController().signal;
const kitOverview = (hash?: string) =>
	Response.json({
		status: hash
			? { state: "ready", components: ["Pill"], hash }
			: { state: "builtin", components: [] },
		request: null,
	});

beforeEach(() => {
	const { window } = parseHTML("<html><head></head><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		localStorage: { getItem: () => "private-login-token", removeItem: () => {} },
	}))
		putGlobal(key, value);
	resetUiRuntimeCachesForTest();
	requests = [];
	server = {};
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		requests.push({
			url,
			method: init?.method ?? "GET",
			token: new Headers(init?.headers).get("Authorization"),
		});
		if (url.endsWith("/intelligent-ui/kit/bundle"))
			return (
				server.bundle?.() ??
				Response.json({ js: "kitRuntime()", css: ".k{}", hash: "h1", components: ["Pill"] })
			);
		if (url.endsWith("/intelligent-ui/kit/approve"))
			return Response.json({ status: { state: "builtin", components: [] }, request: null });
		if (url.endsWith("/intelligent-ui/kit")) return server.overview?.() ?? kitOverview();
		return new Response(url.endsWith(".js") ? "builtinRuntime()" : ".b{}");
	}) as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	saved.clear();
});

describe("which runtime a card renders with", () => {
	test("no project kit: the built-in runtime, fetched once for every card on the page", async () => {
		const [first, second] = await Promise.all([
			loadUiRuntime("n1", signal()),
			loadUiRuntime("n1", signal()),
		]);
		expect(first).toEqual({
			runtimeJs: "builtinRuntime()",
			runtimeCss: ".b{}",
			kit: false,
			id: "builtin",
		});
		expect(second).toBe(first);
		expect(count("vendor.js")).toBe(1);
		expect(count("vendor.css")).toBe(1);
		// Both cards asked about the kit at the same moment: one request.
		expect(count("/intelligent-ui/kit")).toBe(1);
		// The static runtime never carries the login token.
		expect(requests.find((r) => r.url.includes("vendor.js"))?.token).toBeNull();
	});

	test("a built kit is loaded once per build and identified by its hash", async () => {
		server.overview = () => kitOverview("h1");
		const first = await loadUiRuntime("n1", signal());
		const second = await loadUiRuntime("n1", signal());
		expect(first).toEqual({
			runtimeJs: "kitRuntime()",
			runtimeCss: ".k{}",
			kit: true,
			id: "kit:h1",
		});
		expect(second).toBe(first);
		expect(count("/kit/bundle")).toBe(1);
		expect(count("vendor.js")).toBe(0);
		expect(requests.find((r) => r.url.endsWith("/kit/bundle"))?.token).toBe(
			"Bearer private-login-token",
		);
	});

	test("UI recorded as drawn with built-in components keeps them after a kit appears", async () => {
		server.overview = () => kitOverview("h1");
		const runtime = await loadUiRuntime("n1", signal(), "builtin");
		expect(runtime.id).toBe("builtin");
		// The workspace's current kit is not even consulted.
		expect(count("/intelligent-ui/kit")).toBe(0);
		// Recorded as project UI, or still streaming: the current kit.
		expect((await loadUiRuntime("n1", signal(), "project")).id).toBe("kit:h1");
		expect((await loadUiRuntime("n1", signal())).id).toBe("kit:h1");
	});

	test("a reader who cannot see kit state falls back to the built-in runtime", async () => {
		server.overview = () => Response.json({ error: "forbidden" }, { status: 403 });
		expect((await loadUiRuntime("n1", signal())).id).toBe("builtin");
	});

	test("a kit that exists but fails to load is an error, not a silent switch of components", async () => {
		server.overview = () => kitOverview("h1");
		server.bundle = () =>
			Response.json({ error: "Component kit bundle is missing" }, { status: 404 });
		await expect(loadUiRuntime("n1", signal())).rejects.toThrow("Component kit bundle is missing");
		expect(count("vendor.js")).toBe(0);
		// The failure is not cached: the next card tries again and succeeds.
		server.bundle = undefined;
		expect((await loadUiRuntime("n1", signal())).id).toBe("kit:h1");
		expect(count("/kit/bundle")).toBe(2);
	});

	test("a card that goes away stops waiting without poisoning the shared fetch", async () => {
		const controller = new AbortController();
		const abandoned = loadUiRuntime("n1", controller.signal);
		controller.abort(new Error("unmounted"));
		await expect(abandoned).rejects.toThrow("unmounted");
		expect((await loadUiRuntime("n1", signal())).id).toBe("builtin");
		expect(count("vendor.js")).toBe(1);
	});
});

describe("kit overview", () => {
	test("is shared briefly and refreshed after the user acts on a request", async () => {
		await loadKitOverview("n1", signal());
		await loadKitOverview("n1", signal());
		expect(count("/intelligent-ui/kit")).toBe(1);
		// Another conversation is another answer.
		await loadKitOverview("n2", signal());
		expect(requests.filter((r) => r.url.endsWith("/n2/intelligent-ui/kit")).length).toBe(1);
		await approveKitRequest("n1", "req-1");
		await loadKitOverview("n1", signal());
		expect(requests.filter((r) => r.url.endsWith("/n1/intelligent-ui/kit")).length).toBe(2);
		forgetKitOverview("n1");
		await loadKitOverview("n1", signal());
		expect(requests.filter((r) => r.url.endsWith("/n1/intelligent-ui/kit")).length).toBe(3);
	});

	test("a failed read is not remembered", async () => {
		server.overview = () => new Response("<html>bad gateway</html>", { status: 502 });
		// Proxy HTML is never shown to the reader.
		await expect(loadKitOverview("n1", signal())).rejects.toThrow(
			"Component kit request failed (502)",
		);
		server.overview = undefined;
		expect((await loadKitOverview("n1", signal())).status.state).toBe("builtin");
	});
});
