import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { detectSystemProxy, getOutboundProxy, resolveProxyForUrl } from "@server/lib/net/proxy";
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
