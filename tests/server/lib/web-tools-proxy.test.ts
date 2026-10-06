import { afterEach, describe, expect, test } from "bun:test";
import { browserContextProxyOptions } from "@server/lib/browser/pool";
import { migrateBrowserProxy, normalizeSettingsProxyUrls, settings } from "@server/lib/settings";
import {
	getBrowserProxy,
	getWebFetchProxy,
	getWebFetchProxyForUrl,
} from "@server/lib/web-fetch/proxy";

const savedProxy = settings.proxy;
const savedPolicy = settings.agent.webFetchPolicy;
const savedBrowserProxy = settings.agent.browserProxy;
// Read after migration through a function: TypeScript does not invalidate the
// caller's earlier `undefined` narrowing for a mutation inside another function.
const readBrowserProxy = () => settings.agent.browserProxy;

afterEach(() => {
	settings.proxy = savedProxy;
	settings.agent.webFetchPolicy = savedPolicy;
	settings.agent.browserProxy = savedBrowserProxy;
});

describe("Browser proxy migration", () => {
	for (const mode of ["custom", "direct", "system", "default"] as const) {
		test(`preserves the legacy shared ${mode} override without aliasing it`, () => {
			settings.proxy = { mode: "direct" };
			const proxy = mode === "custom" ? { mode, url: "http://fetch:8081" } : { mode };
			settings.agent.webFetchPolicy = { proxy };
			settings.agent.browserProxy = undefined;
			expect(migrateBrowserProxy(settings)).toBe(true);
			expect(readBrowserProxy()).toEqual(proxy);
			expect(readBrowserProxy()).not.toBe(proxy);
			if (mode === "custom") expect(getBrowserProxy()).toBe("http://fetch:8081");
			expect(migrateBrowserProxy(settings)).toBe(false);
		});
	}

	test("preserves an explicitly configured Browser override, including default", () => {
		settings.agent.webFetchPolicy = { proxy: { mode: "custom", url: "http://fetch:8081" } };
		for (const mode of ["default", "direct", "system", "custom"] as const) {
			const proxy = mode === "custom" ? { mode, url: "http://browser:8082" } : { mode };
			settings.agent.browserProxy = proxy;
			expect(migrateBrowserProxy(settings)).toBe(false);
			expect(readBrowserProxy()).toBe(proxy);
		}
	});

	test("persists default when no legacy override exists and never remigrates later edits", () => {
		settings.agent.webFetchPolicy = undefined;
		settings.agent.browserProxy = undefined;
		expect(migrateBrowserProxy(settings)).toBe(true);
		expect(readBrowserProxy()).toEqual({ mode: "default" });
		settings.agent.webFetchPolicy = { proxy: { mode: "custom", url: "http://fetch:8081" } };
		expect(migrateBrowserProxy(settings)).toBe(false);
		expect(readBrowserProxy()).toEqual({ mode: "default" });
	});
});

describe("independent web tool proxy overrides", () => {
	test("both inherit global policy without an override", () => {
		settings.proxy = { mode: "custom", url: "http://global:8080" };
		settings.agent.webFetchPolicy = undefined;
		settings.agent.browserProxy = undefined;
		expect(getWebFetchProxy()).toBe("http://global:8080");
		expect(getBrowserProxy()).toBe("http://global:8080");
	});

	test("custom overrides are independent and default restores inheritance", () => {
		settings.proxy = { mode: "custom", url: "http://global:8080" };
		settings.agent.webFetchPolicy = { proxy: { mode: "custom", url: "http://fetch:8081" } };
		settings.agent.browserProxy = { mode: "custom", url: "http://browser:8082" };
		expect(getWebFetchProxy()).toBe("http://fetch:8081");
		expect(getBrowserProxy()).toBe("http://browser:8082");
		settings.agent.browserProxy = { mode: "default" };
		expect(getBrowserProxy()).toBe("http://global:8080");
		expect(getWebFetchProxy()).toBe("http://fetch:8081");
		settings.agent.webFetchPolicy.proxy = { mode: "default" };
		expect(getWebFetchProxy()).toBe("http://global:8080");
	});

	test("direct mode does not inherit another tool's proxy", () => {
		settings.proxy = { mode: "custom", url: "http://global:8080" };
		settings.agent.webFetchPolicy = { proxy: { mode: "direct" } };
		settings.agent.browserProxy = { mode: "custom", url: "http://browser:8082" };
		expect(getWebFetchProxy()).toBeUndefined();
		expect(browserContextProxyOptions(getWebFetchProxy()).proxyServer).toBe("direct://");
		settings.agent.webFetchPolicy.proxy = { mode: "custom", url: "http://fetch:8081" };
		settings.agent.browserProxy = { mode: "direct" };
		expect(getBrowserProxy()).toBeUndefined();
		expect(getWebFetchProxy()).toBe("http://fetch:8081");
	});

	test("WebFetch loopback stays direct and browser contexts bypass local targets", () => {
		settings.agent.webFetchPolicy = { proxy: { mode: "custom", url: "http://fetch:8081" } };
		expect(getWebFetchProxyForUrl("http://127.0.0.2/test")).toBeUndefined();
		expect(getWebFetchProxyForUrl("http://localhost/test")).toBeUndefined();
		expect(browserContextProxyOptions("http://browser:8082")).toEqual({
			proxyServer: "http://browser:8082",
			proxyBypassList: ["localhost", "*.localhost", "127.0.0.0/8", "[::1]", "0.0.0.0"],
		});
	});

	test("normalizes tool overrides and drops stale non-custom URLs", () => {
		settings.agent.webFetchPolicy = {
			allowAll: true,
			proxy: { mode: "custom", url: "fetch.example:8081" },
		};
		settings.agent.browserProxy = { mode: "default", url: "http://stale:8082" };
		expect(normalizeSettingsProxyUrls(settings)).toBe(true);
		expect(settings.agent.webFetchPolicy.proxy?.url).toBe("http://fetch.example:8081");
		expect(settings.agent.webFetchPolicy.allowAll).toBe(true);
		expect(readBrowserProxy()).toEqual({ mode: "default" });
	});
});
