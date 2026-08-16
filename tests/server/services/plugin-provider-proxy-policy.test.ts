/**
 * The proxy decision for a plugin provider request.
 *
 * The failure mode being guarded is specific and silent: `mode: "direct"` resolves to no proxy
 * URL, and a resolver that stays quiet whenever it has no URL would leave the plugin using the
 * proxy it was last told about. Since the reference plugin keeps that value for the life of the
 * process, an explicit "go direct" would quietly keep routing through the global proxy the user
 * just opted out of — traffic going somewhere they deliberately turned off, with nothing in the
 * UI to suggest it.
 */

import { describe, expect, it } from "bun:test";
import {
	decideProviderProxy,
	isPrivateOrReservedHost,
	ProxyTargetValidationError,
} from "@server/services/plugin-provider-proxy-policy";

/** Stand-in for `resolveOverride`, with the same mode semantics. */
const resolveOverride = (override: { mode: string; url?: string }): string | undefined => {
	switch (override.mode) {
		case "direct":
			return undefined;
		case "system":
			return "http://system-proxy:8080";
		case "custom":
			return override.url || undefined;
		default:
			return "http://global-proxy:8080";
	}
};

describe("decideProviderProxy", () => {
	it("sends the custom proxy when one is configured", () => {
		const decision = decideProviderProxy({
			override: { mode: "custom", url: "http://per-provider:7890" },
			resolveOverride,
		});
		expect(decision?.outbound?.proxyUrl).toBe("http://per-provider:7890");
	});

	it("speaks with an empty outbound for an explicit direct override", () => {
		// The critical case. A present `outbound` with no `proxyUrl` is how the host says "no
		// proxy"; returning undefined here would let the plugin keep its previous proxy.
		const decision = decideProviderProxy({
			override: { mode: "direct" },
			resolveOverride,
			globalProxyUrl: "http://global-proxy:8080",
		});
		expect(decision).toBeDefined();
		expect(decision?.outbound).toBeDefined();
		expect(decision?.outbound?.proxyUrl).toBeUndefined();
	});

	it("does not fall back to the global proxy when the override says direct", () => {
		// Same case stated as the user-visible property: opting out must actually opt out.
		const decision = decideProviderProxy({
			override: { mode: "direct" },
			resolveOverride,
			globalProxyUrl: "http://global-proxy:8080",
		});
		expect(decision?.outbound?.proxyUrl).not.toBe("http://global-proxy:8080");
	});

	it("uses the system proxy for a system override", () => {
		const decision = decideProviderProxy({
			override: { mode: "system" },
			resolveOverride,
		});
		expect(decision?.outbound?.proxyUrl).toBe("http://system-proxy:8080");
	});

	it("follows the global policy when there is no override", () => {
		const decision = decideProviderProxy({
			resolveOverride,
			globalProxyUrl: "http://global-proxy:8080",
		});
		expect(decision?.outbound?.proxyUrl).toBe("http://global-proxy:8080");
	});

	it("stays silent when there is neither an override nor a global proxy", () => {
		// A host with no proxy configuration should put nothing on the wire.
		expect(decideProviderProxy({ resolveOverride })).toBeUndefined();
	});

	it("treats a custom override with an empty url as no proxy, not as a fallback", () => {
		// The store rejects this, but the decision must not invent a global proxy if a malformed
		// row ever reached it.
		const decision = decideProviderProxy({
			override: { mode: "custom", url: "" },
			resolveOverride,
			globalProxyUrl: "http://global-proxy:8080",
		});
		expect(decision?.outbound?.proxyUrl).toBeUndefined();
	});

	it("lets a default override resolve through the global policy", () => {
		// `default` means "follow the host", which `resolveOverride` implements by returning the
		// global proxy. The store normally clears such a row, so this only pins the semantics.
		const decision = decideProviderProxy({
			override: { mode: "default" },
			resolveOverride,
		});
		expect(decision?.outbound?.proxyUrl).toBe("http://global-proxy:8080");
	});
});

describe("SSRF: private/reserved address rejection", () => {
	describe("isPrivateOrReservedHost", () => {
		it.each([
			["127.0.0.1", true],
			["127.0.1.1", true],
			["10.0.0.1", true],
			["10.255.255.255", true],
			["172.16.0.1", true],
			["172.31.255.255", true],
			["192.168.0.1", true],
			["192.168.255.255", true],
			["169.254.169.254", true],
			["0.0.0.0", true],
			["localhost", true],
			["sub.localhost", true],
			["::1", true],
			["fe80::1", true],
			["fd00::1", true],
			["fc00::1", true],
			["::ffff:127.0.0.1", true],
			["::ffff:10.0.0.1", true],
			["8.8.8.8", false],
			["203.0.113.1", false],
			["proxy.example.com", false],
			["172.32.0.1", false],
			["192.169.0.1", false],
		])("%s → %s", (host, expected) => {
			expect(isPrivateOrReservedHost(host)).toBe(expected);
		});
	});

	describe("decideProviderProxy rejects private addresses by default", () => {
		it("rejects 127.0.0.1 in global proxy", () => {
			expect(() =>
				decideProviderProxy({
					resolveOverride,
					globalProxyUrl: "http://127.0.0.1:8080",
				}),
			).toThrow(ProxyTargetValidationError);
		});

		it("rejects localhost in override", () => {
			expect(() =>
				decideProviderProxy({
					override: { mode: "custom", url: "http://localhost:3128" },
					resolveOverride,
					globalProxyUrl: "http://public-proxy:8080",
				}),
			).toThrow(ProxyTargetValidationError);
		});

		it("rejects 169.254.169.254 (cloud metadata)", () => {
			expect(() =>
				decideProviderProxy({
					resolveOverride,
					globalProxyUrl: "http://169.254.169.254/latest/meta-data",
				}),
			).toThrow(ProxyTargetValidationError);
		});

		it("rejects 10.x private range", () => {
			expect(() =>
				decideProviderProxy({
					resolveOverride,
					globalProxyUrl: "socks5://10.0.0.50:1080",
				}),
			).toThrow(ProxyTargetValidationError);
		});

		it("rejects 192.168.x private range", () => {
			expect(() =>
				decideProviderProxy({
					resolveOverride,
					globalProxyUrl: "http://192.168.1.1:3128",
				}),
			).toThrow(ProxyTargetValidationError);
		});

		it("rejects 172.16-31.x private range", () => {
			expect(() =>
				decideProviderProxy({
					resolveOverride,
					globalProxyUrl: "http://172.20.0.1:8080",
				}),
			).toThrow(ProxyTargetValidationError);
		});

		it("rejects IPv6 loopback", () => {
			expect(() =>
				decideProviderProxy({
					resolveOverride,
					globalProxyUrl: "http://[::1]:8080",
				}),
			).toThrow(ProxyTargetValidationError);
		});

		it("rejects unsupported scheme (ftp:)", () => {
			expect(() =>
				decideProviderProxy({
					resolveOverride,
					globalProxyUrl: "ftp://proxy.example.com:21",
				}),
			).toThrow(ProxyTargetValidationError);
		});

		it("allows public addresses", () => {
			const decision = decideProviderProxy({
				resolveOverride,
				globalProxyUrl: "http://proxy.example.com:8080",
			});
			expect(decision?.outbound?.proxyUrl).toBe("http://proxy.example.com:8080");
		});

		it("allows socks5 scheme with public address", () => {
			const decision = decideProviderProxy({
				resolveOverride,
				globalProxyUrl: "socks5://203.0.113.1:1080",
			});
			expect(decision?.outbound?.proxyUrl).toBe("socks5://203.0.113.1:1080");
		});

		it("allows socks5h scheme with public address", () => {
			const decision = decideProviderProxy({
				resolveOverride,
				globalProxyUrl: "socks5h://proxy.corp.example:1080",
			});
			expect(decision?.outbound?.proxyUrl).toBe("socks5h://proxy.corp.example:1080");
		});
	});

	describe("allowPrivateProxyTarget bypass", () => {
		it("allows 127.0.0.1 when opt-in is set", () => {
			const decision = decideProviderProxy({
				resolveOverride,
				globalProxyUrl: "http://127.0.0.1:8080",
				allowPrivateProxyTarget: true,
			});
			expect(decision?.outbound?.proxyUrl).toBe("http://127.0.0.1:8080");
		});

		it("allows 10.x when opt-in is set", () => {
			const decision = decideProviderProxy({
				resolveOverride,
				globalProxyUrl: "socks5://10.0.0.50:1080",
				allowPrivateProxyTarget: true,
			});
			expect(decision?.outbound?.proxyUrl).toBe("socks5://10.0.0.50:1080");
		});

		it("allows localhost override when opt-in is set", () => {
			const decision = decideProviderProxy({
				override: { mode: "custom", url: "http://localhost:3128" },
				resolveOverride,
				allowPrivateProxyTarget: true,
			});
			expect(decision?.outbound?.proxyUrl).toBe("http://localhost:3128");
		});

		it("still rejects invalid scheme even with opt-in", () => {
			expect(() =>
				decideProviderProxy({
					resolveOverride,
					globalProxyUrl: "ftp://127.0.0.1:21",
					allowPrivateProxyTarget: true,
				}),
			).toThrow(ProxyTargetValidationError);
		});
	});
});
