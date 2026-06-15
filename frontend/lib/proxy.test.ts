import { describe, expect, test } from "bun:test";
import { normalizeProxyUrl, summarizeWebFetchProxyPolicy } from "./proxy";

describe("proxy helpers", () => {
	test("normalizes proxy URLs without schemes", () => {
		expect(normalizeProxyUrl("proxy.example.test:8080")).toBe("http://proxy.example.test:8080");
		expect(normalizeProxyUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
		expect(normalizeProxyUrl("localhost:8080")).toBe("http://localhost:8080");
		expect(normalizeProxyUrl("socks5://proxy.example.test:1080")).toBe(
			"socks5://proxy.example.test:1080",
		);
		expect(normalizeProxyUrl("  ")).toBeUndefined();
	});

	test("summarizes current WebFetch proxy object policy", () => {
		expect(summarizeWebFetchProxyPolicy({ proxy: { mode: "direct" } })).toEqual({
			mode: "direct",
			url: "",
			configured: false,
		});
		expect(
			summarizeWebFetchProxyPolicy({
				proxy: { mode: "custom", url: "http://proxy.example.test:8080" },
			}),
		).toEqual({
			mode: "custom",
			url: "http://proxy.example.test:8080",
			configured: true,
		});
		expect(summarizeWebFetchProxyPolicy({ proxy: { mode: "system" } })).toEqual({
			mode: "system",
			url: "",
			configured: true,
		});
	});

	test("keeps legacy WebFetch proxy string policy readable", () => {
		expect(
			summarizeWebFetchProxyPolicy({
				proxy: "custom",
				proxyUrl: "http://legacy-proxy.example.test",
			}),
		).toEqual({
			mode: "custom",
			url: "http://legacy-proxy.example.test",
			configured: true,
		});
	});
});
