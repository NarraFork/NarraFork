import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	closeUndiciDispatcher,
	createProxyAgent,
	createUndiciProxyDispatcher,
	detectSystemProxy,
	getOutboundProxy,
	isSocksProxy,
	resolveProxyForUrl,
} from "@server/lib/net/proxy";
import { settings } from "@server/lib/settings";

const ENV_KEYS = [
	"HTTPS_PROXY",
	"https_proxy",
	"HTTP_PROXY",
	"http_proxy",
	"ALL_PROXY",
	"all_proxy",
	"NO_PROXY",
	"no_proxy",
];

describe("net/proxy resolver", () => {
	let savedEnv: Record<string, string | undefined>;
	let savedProxy: typeof settings.proxy;

	beforeEach(() => {
		savedEnv = {};
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
			delete process.env[k];
		}
		savedProxy = settings.proxy;
	});

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
		settings.proxy = savedProxy;
	});

	test("direct mode returns no proxy", () => {
		settings.proxy = { mode: "direct" };
		process.env.HTTPS_PROXY = "http://sys:8080";
		expect(getOutboundProxy()).toBeUndefined();
		expect(resolveProxyForUrl("https://api.anthropic.com")).toBeUndefined();
	});

	test("custom mode returns the configured URL", () => {
		settings.proxy = { mode: "custom", url: "http://custom:3128" };
		expect(getOutboundProxy()).toBe("http://custom:3128");
		expect(resolveProxyForUrl("https://api.anthropic.com")).toBe("http://custom:3128");
	});

	test("system mode reads env vars", () => {
		settings.proxy = { mode: "system" };
		process.env.HTTPS_PROXY = "http://sys:8080";
		expect(detectSystemProxy()).toBe("http://sys:8080");
		expect(getOutboundProxy()).toBe("http://sys:8080");
	});

	test("defaults to system when no policy is set", () => {
		settings.proxy = undefined;
		process.env.ALL_PROXY = "socks5://sys:1080";
		expect(getOutboundProxy()).toBe("socks5://sys:1080");
	});

	test("loopback targets are always exempted", () => {
		settings.proxy = { mode: "custom", url: "http://custom:3128" };
		expect(resolveProxyForUrl("http://127.0.0.1:7790/v1")).toBeUndefined();
		expect(resolveProxyForUrl("http://localhost:8080")).toBeUndefined();
		expect(resolveProxyForUrl("http://[::1]:8080")).toBeUndefined();
	});

	test("NO_PROXY entries are exempted", () => {
		settings.proxy = { mode: "custom", url: "http://custom:3128" };
		process.env.NO_PROXY = "example.com,.internal.net";
		expect(resolveProxyForUrl("https://api.example.com")).toBeUndefined();
		expect(resolveProxyForUrl("https://svc.internal.net")).toBeUndefined();
		expect(resolveProxyForUrl("https://api.anthropic.com")).toBe("http://custom:3128");
	});
});

describe("net/proxy agent factory", () => {
	test("isSocksProxy recognizes socks schemes", () => {
		expect(isSocksProxy("socks://h:1080")).toBe(true);
		expect(isSocksProxy("socks4://h:1080")).toBe(true);
		expect(isSocksProxy("socks4a://h:1080")).toBe(true);
		expect(isSocksProxy("socks5://h:1080")).toBe(true);
		expect(isSocksProxy("socks5h://h:1080")).toBe(true);
		expect(isSocksProxy("SOCKS5://h:1080")).toBe(true);
		expect(isSocksProxy("  socks5://h:1080  ")).toBe(true);
	});

	test("isSocksProxy rejects http(s) schemes", () => {
		expect(isSocksProxy("http://h:8080")).toBe(false);
		expect(isSocksProxy("https://h:8080")).toBe(false);
		expect(isSocksProxy("socksfoo://h")).toBe(false);
	});

	test("createProxyAgent returns undefined for a falsy url", async () => {
		expect(await createProxyAgent(undefined)).toBeUndefined();
		expect(await createProxyAgent("")).toBeUndefined();
	});

	test("createProxyAgent builds a SocksProxyAgent for socks urls", async () => {
		const agent = await createProxyAgent("socks5://127.0.0.1:1080");
		expect(agent).toBeDefined();
		expect(agent?.constructor.name).toBe("SocksProxyAgent");
	});

	test("createProxyAgent builds an HttpsProxyAgent for http urls", async () => {
		const agent = await createProxyAgent("http://127.0.0.1:3128");
		expect(agent).toBeDefined();
		expect(agent?.constructor.name).toBe("HttpsProxyAgent");
	});

	test("createUndiciProxyDispatcher returns undefined for socks (unsupported) and falsy", async () => {
		expect(await createUndiciProxyDispatcher(undefined)).toBeUndefined();
		expect(await createUndiciProxyDispatcher("socks5://127.0.0.1:1080")).toBeUndefined();
	});

	test("createUndiciProxyDispatcher builds a dispatcher for http urls", async () => {
		const dispatcher = await createUndiciProxyDispatcher("http://127.0.0.1:3128");
		expect(dispatcher).toBeDefined();
		// close/destroy may be absent under Bun's undici shim — teardown must be safe.
		await closeUndiciDispatcher(dispatcher);
	});

	test("closeUndiciDispatcher tolerates undefined and missing teardown methods", async () => {
		await closeUndiciDispatcher(undefined);
		await closeUndiciDispatcher(null);
		await closeUndiciDispatcher({});
	});
});
