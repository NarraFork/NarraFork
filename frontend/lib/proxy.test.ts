import { describe, expect, test } from "bun:test";
import {
	buildProxyOverride,
	commitProxyUrlDraft,
	normalizeProxyUrl,
	summarizeOutboundProxyPolicy,
} from "./proxy";

describe("proxy helpers", () => {
	test("normalizes proxy URLs without schemes", () => {
		expect(normalizeProxyUrl("proxy.example.test:8080")).toBe("http://proxy.example.test:8080");
		expect(normalizeProxyUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
		expect(normalizeProxyUrl("localhost:8080")).toBe("http://localhost:8080");
		expect(normalizeProxyUrl("https://proxy.example.test:8443")).toBe(
			"https://proxy.example.test:8443",
		);
		expect(normalizeProxyUrl("socks5://proxy.example.test:1080")).toBeUndefined();
		expect(normalizeProxyUrl("ftp://proxy.example.test:21")).toBeUndefined();
		expect(normalizeProxyUrl("  ")).toBeUndefined();
	});

	test("builds only complete proxy override payloads", () => {
		expect(buildProxyOverride("default", undefined)).toBeUndefined();
		expect(buildProxyOverride("direct", undefined)).toEqual({ mode: "direct" });
		expect(buildProxyOverride("system", undefined)).toEqual({ mode: "system" });
		expect(buildProxyOverride("custom", "")).toBeNull();
		expect(buildProxyOverride("custom", "socks5://proxy.example.test:1080")).toBeNull();
		expect(buildProxyOverride("custom", "proxy.example.test:8080")).toEqual({
			mode: "custom",
			url: "http://proxy.example.test:8080",
		});
	});

	test("commits a typed custom URL only when it changes something", () => {
		// Typed without a scheme: normalize and save.
		expect(
			commitProxyUrlDraft("127.0.0.1:7890", { mode: "custom", url: "http://127.0.0.1:1080" }),
		).toEqual({
			action: "save",
			override: { mode: "custom", url: "http://127.0.0.1:7890" },
			normalizedUrl: "http://127.0.0.1:7890",
		});

		// Same as stored (before and after normalization): skip the round-trip so a
		// settings refetch cannot steal focus from the field.
		expect(
			commitProxyUrlDraft("http://127.0.0.1:1080", {
				mode: "custom",
				url: "http://127.0.0.1:1080",
			}),
		).toEqual({ action: "noop", normalizedUrl: "http://127.0.0.1:1080" });
		expect(
			commitProxyUrlDraft("127.0.0.1:1080", { mode: "custom", url: "http://127.0.0.1:1080" }),
		).toEqual({ action: "noop", normalizedUrl: "http://127.0.0.1:1080" });

		// Switching from another mode to custom is a real change.
		expect(commitProxyUrlDraft("127.0.0.1:1080", { mode: "system" })).toEqual({
			action: "save",
			override: { mode: "custom", url: "http://127.0.0.1:1080" },
			normalizedUrl: "http://127.0.0.1:1080",
		});
		expect(commitProxyUrlDraft("127.0.0.1:1080", undefined)).toEqual({
			action: "save",
			override: { mode: "custom", url: "http://127.0.0.1:1080" },
			normalizedUrl: "http://127.0.0.1:1080",
		});
	});

	test("keeps an unusable custom URL as a local draft", () => {
		// Empty or unsupported input must not be persisted, and must not wipe what
		// the user is still typing.
		for (const draft of ["", "   ", "socks5://proxy.example.test:1080", "ftp://host:21"]) {
			expect(commitProxyUrlDraft(draft, { mode: "custom", url: "http://127.0.0.1:1080" })).toEqual({
				action: "keep-draft",
			});
		}
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
