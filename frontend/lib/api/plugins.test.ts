import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, api } from "./index";
import { normalizePluginList, type PluginSummary } from "./plugins";

describe("plugins API", () => {
	const g = globalThis as typeof globalThis & {
		localStorage?: Storage;
		fetch: typeof fetch;
	};
	const originalFetch = g.fetch;
	const originalLocalStorage = g.localStorage;

	afterEach(() => {
		Object.defineProperty(g, "fetch", { value: originalFetch, configurable: true });
		if (originalLocalStorage === undefined) {
			Reflect.deleteProperty(g, "localStorage");
		} else {
			Object.defineProperty(g, "localStorage", { value: originalLocalStorage, configurable: true });
		}
	});

	function installEnvironment(response: Response) {
		Object.defineProperty(g, "localStorage", {
			value: {
				getItem: () => null,
				setItem: () => {},
				removeItem: () => {},
			},
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async () => response,
			configurable: true,
		});
	}

	function jsonResponse(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}

	test("list fetches /plugins and returns the sanitized payload", async () => {
		installEnvironment(
			jsonResponse({
				plugins: [
					{
						pluginId: "acme.hello",
						displayName: "Hello",
						version: "1.0.0",
						desiredState: "enabled",
						diagnosticCount: 2,
					},
				],
			}),
		);
		const result = await api.list();
		expect(Array.isArray(result)).toBe(false);
		const envelope = result as { plugins: PluginSummary[] };
		expect(envelope.plugins).toHaveLength(1);
		expect(envelope.plugins[0]?.pluginId).toBe("acme.hello");
		expect(envelope.plugins[0]?.diagnosticCount).toBe(2);
	});

	test("normalizePluginList accepts both envelope and bare array payloads", () => {
		const item: PluginSummary = { pluginId: "acme.hello" };
		expect(normalizePluginList({ plugins: [item] })).toEqual([item]);
		expect(normalizePluginList([item])).toEqual([item]);
		expect(normalizePluginList({} as never)).toEqual([]);
	});

	test("detail request encodes pluginId in the path", async () => {
		let capturedUrl = "";
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async (input: RequestInfo | URL) => {
				capturedUrl = String(input);
				return jsonResponse({ pluginId: "acme.hello" });
			},
			configurable: true,
		});
		await api.get("acme.hello/tool");
		expect(capturedUrl).toBe("/api/plugins/acme.hello%2Ftool");
	});

	test("lifecycle mutations POST to the expected endpoints", async () => {
		const calls: Array<{ url: string; method?: string; body?: string }> = [];
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({
					url: String(input),
					method: init?.method,
					body: typeof init?.body === "string" ? init.body : undefined,
				});
				return jsonResponse({ pluginId: "acme.hello" });
			},
			configurable: true,
		});

		await api.install("hello.nfplugin");
		await api.enable("acme.hello");
		await api.disable("acme.hello");
		await api.activate("acme.hello");
		await api.retry("acme.hello");
		await api.uninstall("acme.hello");

		expect(calls.map((c) => [c.method, c.url])).toEqual([
			["POST", "/api/plugins/install"],
			["POST", "/api/plugins/acme.hello/enable"],
			["POST", "/api/plugins/acme.hello/disable"],
			["POST", "/api/plugins/acme.hello/activate"],
			["POST", "/api/plugins/acme.hello/retry"],
			["POST", "/api/plugins/acme.hello/uninstall"],
		]);
		expect(calls[0]?.body).toBe(JSON.stringify({ path: "hello.nfplugin" }));
	});

	test("503 PLUGINS_DISABLED surfaces a structured ApiError with the code preserved", async () => {
		installEnvironment(
			jsonResponse({ error: "Plugin system is disabled", code: "PLUGINS_DISABLED" }, 503),
		);
		try {
			await api.enable("acme.hello");
			expect.unreachable("expected ApiError");
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			const apiError = error as ApiError;
			expect(apiError.status).toBe(503);
			expect(apiError.data?.code).toBe("PLUGINS_DISABLED");
		}
	});

	test("ui contributions and health endpoints are wired", async () => {
		const calls: string[] = [];
		Object.defineProperty(g, "localStorage", {
			value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
			configurable: true,
		});
		Object.defineProperty(g, "fetch", {
			value: async (input: RequestInfo | URL) => {
				calls.push(String(input));
				return jsonResponse([]);
			},
			configurable: true,
		});
		await api.listUiContributions();
		await api.getUiHealth();
		expect(calls).toEqual(["/api/plugins/ui/contributions", "/api/plugins/ui/health"]);
	});
});
