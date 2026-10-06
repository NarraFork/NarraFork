import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	closeUndiciDispatcher,
	createProxyAgent,
	createUndiciProxyDispatcher,
	detectSystemProxy,
	getOutboundProxy,
	resolveOverride,
	resolveProxyForUrl,
} from "@server/lib/net/proxy";
import { neutralizeAmbientProxyEnv, resetProxyEnvStateForTest } from "@server/lib/net/proxy-env";
import { normalizeProxyUrl, normalizeSettingsProxyUrls, settings } from "@server/lib/settings";

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

/**
 * The resolver reads the startup snapshot rather than the live environment, so a
 * test that wants an ambient proxy must set it and then re-take the snapshot.
 */
function setAmbientProxyEnv(vars: Record<string, string>): void {
	resetProxyEnvStateForTest();
	for (const [k, v] of Object.entries(vars)) process.env[k] = v;
	neutralizeAmbientProxyEnv();
}

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
		// No ambient proxy unless a test explicitly installs one.
		resetProxyEnvStateForTest();
		neutralizeAmbientProxyEnv();
	});

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (savedEnv[k] === undefined) delete process.env[k];
			else process.env[k] = savedEnv[k];
		}
		settings.proxy = savedProxy;
		resetProxyEnvStateForTest();
	});

	test("direct mode returns no proxy", () => {
		settings.proxy = { mode: "direct" };
		setAmbientProxyEnv({ HTTPS_PROXY: "http://sys:8080" });
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
		setAmbientProxyEnv({ HTTPS_PROXY: "http://sys:8080" });
		expect(detectSystemProxy()).toBe("http://sys:8080");
		expect(getOutboundProxy()).toBe("http://sys:8080");
	});

	test("defaults to direct when no policy is set", () => {
		settings.proxy = undefined;
		setAmbientProxyEnv({ ALL_PROXY: "socks5://sys:1080" });
		expect(getOutboundProxy()).toBeUndefined();
	});

	test("normalizes only HTTP(S) custom proxy URLs", () => {
		expect(normalizeProxyUrl("proxy.example.test:8080")).toBe("http://proxy.example.test:8080");
		expect(normalizeProxyUrl("https://proxy.example.test:8443")).toBe(
			"https://proxy.example.test:8443",
		);
		expect(normalizeProxyUrl("socks5://proxy.example.test:1080")).toBeUndefined();
	});

	test("preserves an existing SOCKS custom proxy so requests fail closed", () => {
		settings.proxy = { mode: "custom", url: "socks5://proxy.example.test:1080" };
		expect(normalizeSettingsProxyUrls(settings)).toBe(false);
		expect(settings.proxy).toEqual({
			mode: "custom",
			url: "socks5://proxy.example.test:1080",
		});
	});

	test("loopback targets are always exempted", () => {
		settings.proxy = { mode: "custom", url: "http://custom:3128" };
		expect(resolveProxyForUrl("http://127.0.0.1:7790/v1")).toBeUndefined();
		expect(resolveProxyForUrl("http://localhost:8080")).toBeUndefined();
		expect(resolveProxyForUrl("http://[::1]:8080")).toBeUndefined();
	});

	test("NO_PROXY entries are exempted", () => {
		settings.proxy = { mode: "custom", url: "http://custom:3128" };
		setAmbientProxyEnv({ NO_PROXY: "example.com,.internal.net" });
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
		resetProxyEnvStateForTest();
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
		setAmbientProxyEnv({ HTTPS_PROXY: "http://sys:8080" });
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
	test("createProxyAgent returns undefined for a falsy url", async () => {
		expect(await createProxyAgent(undefined)).toBeUndefined();
		expect(await createProxyAgent("")).toBeUndefined();
	});

	test("createProxyAgent rejects SOCKS proxy URLs", async () => {
		await expect(createProxyAgent("socks5://127.0.0.1:1080")).rejects.toMatchObject({
			code: "UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL",
			protocol: "socks5",
		});
	});

	test("createProxyAgent builds an HttpsProxyAgent for http urls", async () => {
		const agent = await createProxyAgent("http://127.0.0.1:3128");
		expect(agent).toBeDefined();
		expect(agent?.constructor.name).toBe("HttpsProxyAgent");
	});

	test("createUndiciProxyDispatcher rejects unsupported protocols", async () => {
		expect(await createUndiciProxyDispatcher(undefined)).toBeUndefined();
		for (const proxyUrl of ["socks5://127.0.0.1:1080", "ftp://127.0.0.1:21"]) {
			await expect(createUndiciProxyDispatcher(proxyUrl)).rejects.toMatchObject({
				code: "UNSUPPORTED_OUTBOUND_PROXY_PROTOCOL",
			});
		}
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
