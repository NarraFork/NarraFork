import { describe, expect, test } from "bun:test";
import { extractPrimaryDomainLabel, normalizeHttpUrlProtocol, normalizeUrlProtocol } from "./url";

describe("normalizeUrlProtocol", () => {
	test("adds https to domain-like URLs without a protocol", () => {
		expect(normalizeUrlProtocol("example.com")).toBe("https://example.com");
		expect(normalizeUrlProtocol("api.example.com:8443/v1?x=1#top")).toBe(
			"https://api.example.com:8443/v1?x=1#top",
		);
		expect(normalizeUrlProtocol("例子.测试/path")).toBe("https://例子.测试/path");
	});

	test("adds http to local and IP URLs without a protocol", () => {
		expect(normalizeUrlProtocol("localhost:7779/api")).toBe("http://localhost:7779/api");
		expect(normalizeUrlProtocol("127.0.0.1:7779/api")).toBe("http://127.0.0.1:7779/api");
		expect(normalizeUrlProtocol("192.168.1.20")).toBe("http://192.168.1.20");
		expect(normalizeUrlProtocol("[::1]:7779/api")).toBe("http://[::1]:7779/api");
		expect(normalizeUrlProtocol("::1")).toBe("http://[::1]");
		expect(normalizeUrlProtocol("2001:db8::1/path")).toBe("http://[2001:db8::1]/path");
	});

	test("keeps existing protocols unchanged", () => {
		expect(normalizeUrlProtocol(" https://example.com ")).toBe("https://example.com");
		expect(normalizeUrlProtocol("http://127.0.0.1:7779")).toBe("http://127.0.0.1:7779");
		expect(normalizeUrlProtocol("socks5://proxy.example.test:1080")).toBe(
			"socks5://proxy.example.test:1080",
		);
	});

	test("does not rewrite non-URL values", () => {
		expect(normalizeUrlProtocol("  ")).toBeUndefined();
		expect(normalizeUrlProtocol("git@github.com:owner/repo.git")).toBe(
			"git@github.com:owner/repo.git",
		);
		expect(normalizeUrlProtocol("github.com:owner/repo.git")).toBe("github.com:owner/repo.git");
		expect(normalizeUrlProtocol("./relative/path")).toBe("./relative/path");
		expect(normalizeUrlProtocol("/absolute/path")).toBe("/absolute/path");
	});
});

describe("normalizeHttpUrlProtocol", () => {
	test("keeps or completes only http and https URLs", () => {
		expect(normalizeHttpUrlProtocol("example.com/path")).toBe("https://example.com/path");
		expect(normalizeHttpUrlProtocol("localhost:7779/api")).toBe("http://localhost:7779/api");
		expect(normalizeHttpUrlProtocol("https://example.com")).toBe("https://example.com");
		expect(normalizeHttpUrlProtocol("http://127.0.0.1:7779")).toBe("http://127.0.0.1:7779");
	});

	test("rejects non-http schemes and non-url values", () => {
		expect(normalizeHttpUrlProtocol("socks5://proxy.example.test:1080")).toBeUndefined();
		expect(normalizeHttpUrlProtocol("file:///etc/passwd")).toBeUndefined();
		expect(normalizeHttpUrlProtocol("javascript://alert.example")).toBeUndefined();
		expect(normalizeHttpUrlProtocol("git@github.com:owner/repo.git")).toBeUndefined();
		expect(normalizeHttpUrlProtocol("/absolute/path")).toBeUndefined();
		expect(normalizeHttpUrlProtocol("  ")).toBeUndefined();
	});
});

describe("extractPrimaryDomainLabel", () => {
	test("takes the second-to-last hostname label", () => {
		expect(extractPrimaryDomainLabel("https://api.openai.com/v1")).toBe("openai");
		expect(extractPrimaryDomainLabel("https://api.deepseek.com")).toBe("deepseek");
		expect(extractPrimaryDomainLabel("https://open.bigmodel.cn")).toBe("bigmodel");
		expect(extractPrimaryDomainLabel("https://dashscope.aliyuncs.com")).toBe("aliyuncs");
		expect(extractPrimaryDomainLabel("https://openai.com")).toBe("openai");
	});

	test("works without an explicit protocol", () => {
		expect(extractPrimaryDomainLabel("api.moonshot.cn/v1")).toBe("moonshot");
		expect(extractPrimaryDomainLabel("example.com")).toBe("example");
	});

	test("returns empty string for hosts without a registrable label", () => {
		expect(extractPrimaryDomainLabel("http://localhost:7779/api")).toBe("");
		expect(extractPrimaryDomainLabel("http://127.0.0.1:8080")).toBe("");
		expect(extractPrimaryDomainLabel("http://[::1]:7779")).toBe("");
		expect(extractPrimaryDomainLabel("")).toBe("");
		expect(extractPrimaryDomainLabel(undefined)).toBe("");
		expect(extractPrimaryDomainLabel("   ")).toBe("");
	});

	test("ignores non-http schemes", () => {
		expect(extractPrimaryDomainLabel("socks5://proxy.example.com:1080")).toBe("");
	});
});
