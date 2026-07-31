import { describe, expect, test } from "bun:test";
import {
	isTrustedProxyAddress,
	isValidTrustedProxyCidr,
	normalizeIp,
	resolveClientIp,
} from "../client-ip";

describe("normalizeIp", () => {
	test("normalizes IPv4, mapped IPv4, ports and IPv6", () => {
		expect(normalizeIp("192.168.001.010")).toBeNull();
		expect(normalizeIp("192.168.1.10:443")).toBe("192.168.1.10");
		expect(normalizeIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
		expect(normalizeIp("::ffff:c000:201")).toBe("192.0.2.1");
		expect(normalizeIp("[2001:0db8:0:0:0:0:0:1]:443")).toBe("2001:db8::1");
	});
});

describe("isValidTrustedProxyCidr", () => {
	test("accepts exact IPs and bounded CIDRs", () => {
		expect(isValidTrustedProxyCidr("127.0.0.1")).toBe(true);
		expect(isValidTrustedProxyCidr("10.0.0.0/24")).toBe(true);
		expect(isValidTrustedProxyCidr("::1/128")).toBe(true);
		expect(isValidTrustedProxyCidr("10.0.0.0/33")).toBe(false);
		expect(isValidTrustedProxyCidr("not-an-ip")).toBe(false);
	});
});

describe("isTrustedProxyAddress", () => {
	test("matches only configured socket peer addresses", () => {
		expect(isTrustedProxyAddress("127.0.0.1", ["127.0.0.0/8"])).toBe(true);
		expect(isTrustedProxyAddress("::ffff:127.0.0.1", ["127.0.0.0/8"])).toBe(true);
		expect(isTrustedProxyAddress("198.51.100.10", ["127.0.0.0/8"])).toBe(false);
		expect(isTrustedProxyAddress("not-an-ip", ["0.0.0.0/0"])).toBe(false);
	});
});

describe("resolveClientIp", () => {
	test("direct clients cannot spoof forwarding headers", () => {
		expect(
			resolveClientIp({
				peerIp: "198.51.100.10",
				xForwardedFor: "203.0.113.99",
				xRealIp: "203.0.113.98",
				trustedProxyCidrs: ["127.0.0.0/8", "::1/128"],
			}),
		).toBe("198.51.100.10");
	});

	test("accepts a client address from a trusted loopback proxy", () => {
		expect(
			resolveClientIp({
				peerIp: "127.0.0.1",
				xForwardedFor: "198.51.100.25",
				trustedProxyCidrs: ["127.0.0.0/8", "::1/128"],
			}),
		).toBe("198.51.100.25");
	});

	test("walks right-to-left so a spoofed leftmost hop is ignored", () => {
		expect(
			resolveClientIp({
				peerIp: "127.0.0.1",
				xForwardedFor: "203.0.113.99, 198.51.100.25",
				trustedProxyCidrs: ["127.0.0.0/8", "::1/128"],
			}),
		).toBe("198.51.100.25");
	});

	test("supports multiple explicitly trusted proxies", () => {
		expect(
			resolveClientIp({
				peerIp: "10.0.0.2",
				xForwardedFor: "198.51.100.25, 10.0.0.1",
				trustedProxyCidrs: ["10.0.0.0/24"],
			}),
		).toBe("198.51.100.25");
	});

	test("falls back to the socket peer for invalid or excessive chains", () => {
		expect(
			resolveClientIp({
				peerIp: "127.0.0.1",
				xForwardedFor: "not-an-ip",
				trustedProxyCidrs: ["127.0.0.0/8"],
			}),
		).toBe("127.0.0.1");
		expect(
			resolveClientIp({
				peerIp: "127.0.0.1",
				xForwardedFor: Array.from({ length: 21 }, () => "198.51.100.1").join(","),
				trustedProxyCidrs: ["127.0.0.0/8"],
			}),
		).toBe("127.0.0.1");
	});

	test("uses X-Real-IP only when no forwarded chain is present", () => {
		expect(
			resolveClientIp({
				peerIp: "::1",
				xRealIp: "2001:db8::5",
				trustedProxyCidrs: ["::1/128"],
			}),
		).toBe("2001:db8::5");
	});
});
