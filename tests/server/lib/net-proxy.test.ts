import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	closeUndiciDispatcher,
	createProxyAgent,
	createUndiciProxyDispatcher,
	detectSystemProxy,
	getOutboundProxy,
	isSocksProxy,
	resolveOverride,
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

	test("defaults to direct when no policy is set", () => {
		settings.proxy = undefined;
		process.env.ALL_PROXY = "socks5://sys:1080";
		expect(getOutboundProxy()).toBeUndefined();
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

describe("net/proxy per-location override", () => {
	let savedEnv: Record<string, string | undefined>;
	let savedProxy: typeof settings.proxy;

	beforeEach(() => {
		savedEnv = {};
		for (const k of ENV_KEYS) {
			savedEnv[k] = process.env[k];
			delete process.env[k];
		}
		savedProxy = settings.proxy;
		// Global policy = custom, so "default" inheritance is observable.
		settings.proxy = { mode: "custom", url: "http://global:3128" };
	});

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
		settings.proxy = savedProxy;
	});

	test("undefined / default override inherits the global policy", () => {
		expect(resolveOverride(undefined)).toBe("http://global:3128");
		expect(resolveOverride({ mode: "default" })).toBe("http://global:3128");
	});

	test("direct override forces no proxy even when global is set", () => {
		expect(resolveOverride({ mode: "direct" })).toBeUndefined();
		expect(resolveProxyForUrl("https://api.anthropic.com", { mode: "direct" })).toBeUndefined();
	});

	test("system override reads env vars regardless of global", () => {
		process.env.HTTPS_PROXY = "http://sys:8080";
		expect(resolveOverride({ mode: "system" })).toBe("http://sys:8080");
	});

	test("custom override uses its own url, not the global one", () => {
		expect(resolveOverride({ mode: "custom", url: "http://ovr:9000" })).toBe("http://ovr:9000");
		expect(
			resolveProxyForUrl("https://api.anthropic.com", { mode: "custom", url: "http://ovr:9000" }),
		).toBe("http://ovr:9000");
	});

	test("override still honours loopback exemption", () => {
		expect(
			resolveProxyForUrl("http://127.0.0.1:7790", { mode: "custom", url: "http://ovr:9000" }),
		).toBeUndefined();
	});

	test("codex-style precedence: a resolved string wins over global override", () => {
		// Mirrors OpenAIProvider.pfetch: an explicit resolved proxy string
		// (codex passes resolveOverride(codex.proxy)) is applied directly with
		// exemptions, independent of the global settings.proxy value.
		const codexResolved = "http://codex:7000";
		expect(
			resolveProxyForUrl("http://127.0.0.1:1", { mode: "custom", url: codexResolved }),
		).toBeUndefined();
		expect(resolveProxyForUrl("https://chatgpt.com", { mode: "custom", url: codexResolved })).toBe(
			codexResolved,
		);
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

	test("createUndiciProxyDispatcher supports socks and fails closed for unknown protocols", async () => {
		expect(await createUndiciProxyDispatcher(undefined)).toBeUndefined();
		const socks = await createUndiciProxyDispatcher("socks5://127.0.0.1:1080");
		expect(socks).toBeDefined();
		await closeUndiciDispatcher(socks);
		await expect(createUndiciProxyDispatcher("ftp://127.0.0.1:21")).rejects.toMatchObject({
			code: "UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL",
		});
	});

	test("createUndiciProxyDispatcher builds a dispatcher for http urls", async () => {
		const dispatcher = await createUndiciProxyDispatcher("http://127.0.0.1:3128");
		expect(dispatcher).toBeDefined();
		await closeUndiciDispatcher(dispatcher);
	});

	test("closeUndiciDispatcher tolerates undefined and missing teardown methods", async () => {
		await closeUndiciDispatcher(undefined);
		await closeUndiciDispatcher(null);
		await closeUndiciDispatcher({});
	});
});
