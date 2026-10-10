import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ProxyOverride } from "../../settings/types";

const config: {
	proxy: { mode: "direct" | "system" | "custom"; url?: string };
	update: { proxy?: ProxyOverride };
} = { proxy: { mode: "direct" }, update: {} };
let systemProxy = "http://system-proxy.test:8080";
let noProxy = "";
mock.module("../../settings", () => ({ settings: config }));
mock.module("../proxy-env", () => ({
	ambientSystemProxy: () => systemProxy,
	ambientNoProxy: () => noProxy,
}));
const { createUpdateFetchContext, fetchUpdateSameOrigin, fetchUpdateWithTimeout, readUpdateJson } =
	await import("../update-fetch");
const { GithubReleaseUpdater, fetchGithubAsset } = await import(
	"../../../services/github-release-update"
);
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeEach(() => {
	config.proxy = { mode: "direct" };
	config.update = {};
	noProxy = "";
	systemProxy = "http://system-proxy.test:8080";
	fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("payload"));
});
afterEach(() => fetchSpy.mockRestore());
afterAll(() => mock.restore());

function sentProxy(index = 0) {
	return (fetchSpy.mock.calls[index]?.[1] as RequestInit & { proxy?: string })?.proxy;
}

describe("update transport proxy policy", () => {
	test("inherits global proxy but a dedicated direct override wins", async () => {
		config.proxy = { mode: "custom", url: "http://global-proxy.test:8080" };
		await createUpdateFetchContext().fetch("https://github.com/test/repo");
		expect(sentProxy()).toBe("http://global-proxy.test:8080/");
		config.update.proxy = { mode: "direct" };
		await createUpdateFetchContext().fetch("https://github.com/test/repo");
		expect(sentProxy(1)).toBe("");
	});
	test("dedicated custom/system and explicit default use the existing modes", async () => {
		config.update.proxy = { mode: "custom", url: "http://custom-proxy.test:3128" };
		await createUpdateFetchContext().fetch("https://github.com/test/repo");
		expect(sentProxy()).toBe("http://custom-proxy.test:3128/");
		config.update.proxy = { mode: "system" };
		await createUpdateFetchContext().fetch("https://github.com/test/repo");
		expect(sentProxy(1)).toBe("http://system-proxy.test:8080/");
		config.proxy = { mode: "custom", url: "http://global-proxy.test:8080" };
		config.update.proxy = { mode: "default" };
		await createUpdateFetchContext().fetch("https://github.com/test/repo");
		expect(sentProxy(2)).toBe("http://global-proxy.test:8080/");
	});
	test("one context freezes policy and still applies exemptions for each actual hop", async () => {
		config.proxy = { mode: "custom", url: "http://user:secret@proxy.test:8080" };
		noProxy = "raw.githubusercontent.com";
		const context = createUpdateFetchContext();
		const key = context.key;
		config.proxy = { mode: "direct" };
		expect(context.isCurrent()).toBe(false);
		expect(key).not.toContain("secret");
		expect(key).not.toContain("proxy.test");
		await context.fetch("https://github.com/test/repo");
		await context.fetch("https://raw.githubusercontent.com/test/repo/main/file");
		await context.fetch("http://127.0.0.1:1234/file");
		expect(sentProxy()).toBe("http://user:secret@proxy.test:8080/");
		expect(sentProxy(1)).toBe("");
		expect(sentProxy(2)).toBe("");
	});
	test("preserves cancellation/headers/redirect and never disables TLS", async () => {
		const signal = new AbortController().signal;
		await createUpdateFetchContext().fetch("https://github.com/test/repo", {
			signal,
			redirect: "manual",
			headers: { "If-None-Match": "etag" },
		});
		const init = fetchSpy.mock.calls[0]?.[1] as RequestInit & { tls?: unknown };
		expect(init.signal).toBe(signal);
		expect(init.redirect).toBe("manual");
		expect(new Headers(init.headers).get("If-None-Match")).toBe("etag");
		expect(init.tls).toEqual({ rejectUnauthorized: true });
		const unsafeInit: RequestInit & { tls: { rejectUnauthorized: boolean } } = {
			tls: { rejectUnauthorized: false },
		};
		await createUpdateFetchContext().fetch("https://github.com/test/repo", unsafeInit);
		expect((fetchSpy.mock.calls[1]?.[1] as RequestInit & { tls: unknown }).tls).toEqual({
			rejectUnauthorized: true,
		});
	});
	test("empty custom proxy fails closed without an outbound request", () => {
		config.update.proxy = { mode: "custom", url: "" };
		expect(() => createUpdateFetchContext()).toThrow("invalid");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
	test("unsupported protocols fail closed and proxy errors are not retried direct", async () => {
		config.update.proxy = { mode: "custom", url: "socks5://proxy.test:1080" };
		await expect(createUpdateFetchContext().fetch("https://github.com/test/repo")).rejects.toThrow(
			"Unsupported",
		);
		expect(fetchSpy).not.toHaveBeenCalled();
		config.update.proxy = { mode: "custom", url: "http://proxy.test:8080" };
		fetchSpy.mockRejectedValue(
			new Error("proxy unavailable at http://user:secret@proxy.test:8080"),
		);
		await expect(createUpdateFetchContext().fetch("https://github.com/test/repo")).rejects.toThrow(
			"Update transport request failed",
		);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});

describe("GitHub update transport integration", () => {
	const input = {
		repository: "Test/Repo",
		channel: "stable" as const,
		platform: "linux-x64",
		currentVersion: "1.0.0",
	};
	test("proxy edits immediately bypass prior check errors without changing source identity", async () => {
		config.proxy = { mode: "custom", url: "http://proxy-one.test:8080" };
		fetchSpy.mockResolvedValue(new Response(null, { status: 500 }));
		const updater = new GithubReleaseUpdater();
		expect((await updater.check(input)).errorCode).toBe("NETWORK_ERROR");
		await updater.check(input);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		config.update.proxy = { mode: "custom", url: "http://proxy-two.test:8080" };
		const result = await updater.check(input);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(sentProxy(1)).toBe("http://proxy-two.test:8080/");
		expect(result.repository).toBe(input.repository);
	});
	test("new policy does not share an old policy in-flight request or quota cooldown", async () => {
		config.proxy = { mode: "custom", url: "http://proxy-one.test:8080" };
		let resolveFirst: (response: Response) => void = () => {};
		const firstResponse = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});
		fetchSpy
			.mockReturnValueOnce(firstResponse)
			.mockResolvedValue(new Response(null, { status: 500 }));
		const updater = new GithubReleaseUpdater();
		const first = updater.check(input);
		config.proxy = { mode: "custom", url: "http://proxy-two.test:8080" };
		const second = await updater.check(input);
		expect(second.errorCode).toBe("NETWORK_ERROR");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		resolveFirst(new Response(null, { status: 429, headers: { "retry-after": "600" } }));
		expect((await first).errorCode).toBe("RATE_LIMITED");
		expect((await updater.check(input, { force: true })).errorCode).toBe("NETWORK_ERROR");
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});
	test("default asset downloads apply NO_PROXY per trusted CDN hop", async () => {
		config.proxy = { mode: "custom", url: "http://proxy.test:8080" };
		noProxy = "release-assets.githubusercontent.com";
		fetchSpy.mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: {
					location: "https://release-assets.githubusercontent.com/asset",
				},
			}),
		);
		const response = await fetchGithubAsset(
			"https://github.com/test/repo/releases/download/v1.0.0/binary",
			new AbortController().signal,
		);
		expect(response.ok).toBe(true);
		expect(sentProxy()).toBe("http://proxy.test:8080/");
		expect(sentProxy(1)).toBe("");
	});
});

describe("legacy update redirects", () => {
	test("follows bounded same-origin redirects with manual transport", async () => {
		fetchSpy.mockResolvedValueOnce(
			new Response(null, { status: 302, headers: { location: "/asset" } }),
		);
		await fetchUpdateSameOrigin("https://updates.test/start");
		expect(fetchSpy.mock.calls.map((args) => args[0])).toEqual([
			"https://updates.test/start",
			"https://updates.test/asset",
		]);
		expect(fetchSpy.mock.calls.every((args) => args[1]?.redirect === "manual")).toBe(true);
	});
	test.each([
		"https://other.test/file",
		"http://updates.test/file",
		"https://user:password@updates.test/file",
	])("rejects cross-authority redirect %s", async (location) => {
		fetchSpy.mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
		await expect(fetchUpdateSameOrigin("https://updates.test/start")).rejects.toThrow("Untrusted");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
	test("rejects redirect loops after five hops", async () => {
		fetchSpy.mockResolvedValue(new Response(null, { status: 302, headers: { location: "/loop" } }));
		await expect(fetchUpdateSameOrigin("https://updates.test/start")).rejects.toThrow("limit");
		expect(fetchSpy).toHaveBeenCalledTimes(6);
	});
});

describe("legacy response lifetime and metadata budget", () => {
	test("header arrival does not end the body deadline", async () => {
		fetchSpy.mockResolvedValue(new Response(new ReadableStream<Uint8Array>()));
		const response = await fetchUpdateWithTimeout("https://updates.test/meta", { timeoutMs: 20 });
		await expect(response.text()).rejects.toThrow("timed out");
	});
	test("caller cancellation after headers still aborts an unresponsive body", async () => {
		fetchSpy.mockResolvedValue(new Response(new ReadableStream<Uint8Array>()));
		const controller = new AbortController();
		const response = await fetchUpdateWithTimeout("https://updates.test/meta", {
			timeoutMs: 1000,
			signal: controller.signal,
		});
		const pending = response.text();
		controller.abort(new DOMException("caller cancelled", "AbortError"));
		await expect(pending).rejects.toThrow("caller cancelled");
	});
	test("an already cancelled caller makes no request", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			fetchUpdateWithTimeout("https://updates.test/meta", {
				timeoutMs: 20,
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
	test("an injected transport ignoring cancellation cannot hang the header budget", async () => {
		fetchSpy.mockReturnValueOnce(new Promise<Response>(() => {}));
		await expect(
			fetchUpdateWithTimeout("https://updates.test/meta", { timeoutMs: 20 }),
		).rejects.toThrow("timed out");
	});
	test("metadata byte limit applies without Content-Length and cancels the owned body", async () => {
		let cancelled = false;
		fetchSpy.mockResolvedValue(
			new Response(
				new ReadableStream<Uint8Array>({
					start(stream) {
						stream.enqueue(new TextEncoder().encode("x".repeat(32)));
					},
					cancel() {
						cancelled = true;
					},
				}),
			),
		);
		const response = await fetchUpdateWithTimeout("https://updates.test/meta", { timeoutMs: 1000 });
		await expect(readUpdateJson(response, 16)).rejects.toThrow("size limit");
		expect(cancelled).toBe(true);
	});
	test("bounded valid metadata completes without leaving a body deadline active", async () => {
		fetchSpy.mockResolvedValue(Response.json({ ready: true }));
		const response = await fetchUpdateWithTimeout("https://updates.test/meta", { timeoutMs: 1000 });
		expect(await readUpdateJson(response, 64)).toEqual({ ready: true });
	});
});
