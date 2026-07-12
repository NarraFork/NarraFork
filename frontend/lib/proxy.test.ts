import { describe, expect, test } from "bun:test";
import { normalizeProxyUrl, summarizeOutboundProxyPolicy } from "./proxy";

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

	test("summarizes the global outbound proxy policy", () => {
		expect(summarizeOutboundProxyPolicy({ mode: "direct" })).toEqual({
			mode: "direct",
			url: "",
			configured: false,
		});
		expect(
			summarizeOutboundProxyPolicy({ mode: "custom", url: "http://proxy.example.test:8080" }),
		).toEqual({
			mode: "custom",
			url: "http://proxy.example.test:8080",
			configured: true,
		});
		expect(summarizeOutboundProxyPolicy({ mode: "system" })).toEqual({
			mode: "system",
			url: "",
			configured: true,
		});
	});

	test("defaults to direct when policy is missing or malformed", () => {
		expect(summarizeOutboundProxyPolicy(undefined)).toEqual({
			mode: "direct",
			url: "",
			configured: false,
		});
		expect(summarizeOutboundProxyPolicy({ mode: "bogus" })).toEqual({
			mode: "direct",
			url: "",
			configured: false,
		});
	});
});
