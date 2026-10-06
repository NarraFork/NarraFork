/** Regression coverage for user-configured plugin proxy inheritance, explicit opt-out, and the private-target capability gate. */
import { describe, expect, it } from "bun:test";
import {
	applyPrivateProxyGate,
	decideProviderProxy,
	isPrivateProxyTarget,
	PRIVATE_PROXY_CAPABILITY,
	ProxyTargetValidationError,
} from "@server/services/plugin-provider-proxy-policy";

/** Stand-in for `resolveOverride`, with the same mode semantics. */
const resolveOverride = (override: { mode: string; url?: string }): string | undefined => {
	switch (override.mode) {
		case "direct":
			return undefined;
		case "system":
			return "http://127.0.0.1:7890";
		case "custom":
			return override.url || undefined;
		default:
			return "http://192.168.50.22:1081/";
	}
};

const configuredProxies = [
	"http://192.168.50.22:1081/",
	"http://127.0.0.1:7890",
	"http://localhost:3128",
	"socks5://10.0.0.50:1080",
	"http://172.20.0.1:8080",
	"http://[::1]:8080",
	"http://[fd00::1]:8080",
	"http://169.254.0.1:8080",
	"https://proxy.example.com:8443",
	"socks5h://proxy.corp.example:1080",
];

describe("decideProviderProxy", () => {
	it.each(configuredProxies)("inherits configured global proxy %s without an opt-in", (url) => {
		expect(decideProviderProxy({ resolveOverride, globalProxyUrl: url })).toEqual({
			outbound: { proxyUrl: url },
		});
	});

	it.each(configuredProxies)("honors the provider override %s without an opt-in", (url) => {
		expect(
			decideProviderProxy({
				override: { mode: "custom", url },
				resolveOverride,
				globalProxyUrl: "http://other-proxy:8080",
			}),
		).toEqual({ outbound: { proxyUrl: url } });
	});

	it("sends an empty outbound for direct mode, clearing the previous LAN proxy", () => {
		expect(
			decideProviderProxy({
				override: { mode: "direct" },
				resolveOverride,
				globalProxyUrl: "http://192.168.50.22:1081/",
			}),
		).toEqual({ outbound: {} });
	});

	it("uses the system proxy for a system override", () => {
		expect(decideProviderProxy({ override: { mode: "system" }, resolveOverride })).toEqual({
			outbound: { proxyUrl: "http://127.0.0.1:7890" },
		});
	});

	it("stays silent when there is neither an override nor a global proxy", () => {
		expect(decideProviderProxy({ resolveOverride })).toBeUndefined();
	});

	it("treats a custom override with an empty url as no proxy, not as a fallback", () => {
		expect(
			decideProviderProxy({
				override: { mode: "custom", url: "" },
				resolveOverride,
				globalProxyUrl: "http://192.168.50.22:1081/",
			}),
		).toEqual({ outbound: {} });
	});

	it("lets a default override resolve through the global policy", () => {
		expect(decideProviderProxy({ override: { mode: "default" }, resolveOverride })).toEqual({
			outbound: { proxyUrl: "http://192.168.50.22:1081/" },
		});
	});

	it.each([
		"not-a-url",
		"http://",
		"ftp://127.0.0.1:21",
		"file:///etc/passwd",
	])("rejects malformed or unsupported global proxy %s", (url) => {
		expect(() => decideProviderProxy({ resolveOverride, globalProxyUrl: url })).toThrow(
			ProxyTargetValidationError,
		);
	});

	it.each([
		"not-a-url",
		"http://",
		"ftp://127.0.0.1:21",
		"file:///etc/passwd",
	])("rejects malformed or unsupported provider proxy %s", (url) => {
		expect(() =>
			decideProviderProxy({ override: { mode: "custom", url }, resolveOverride }),
		).toThrow(ProxyTargetValidationError);
	});
});

// ---------------------------------------------------------------------------
// isPrivateProxyTarget
// ---------------------------------------------------------------------------

describe("isPrivateProxyTarget — private addresses", () => {
	it.each([
		// IPv4 loopback
		"http://127.0.0.1:3128",
		"http://127.0.0.2:3128",
		"http://127.255.255.255:3128",
		// IPv4 RFC 1918
		"http://10.0.0.1:3128",
		"http://10.255.255.255:3128",
		"http://172.16.0.1:3128",
		"http://172.31.255.255:3128",
		"http://192.168.0.1:3128",
		"http://192.168.255.255:3128",
		// IPv4 link-local
		"http://169.254.0.1:3128",
		"http://169.254.255.255:3128",
		// IPv4 unspecified / reserved
		"http://0.0.0.1:3128",
		"http://224.0.0.1:3128",
		"http://255.255.255.255:3128",
		// IPv6 loopback
		"http://[::1]:3128",
		// IPv6 link-local
		"http://[fe80::1]:3128",
		"http://[fe80::abcd:ef01]:3128",
		// IPv6 unique-local
		"http://[fc00::1]:3128",
		"http://[fd00::1]:3128",
		"http://[fdff:ffff::1]:3128",
		// Named loopback
		"http://localhost:3128",
		"http://localhost:8080",
		"http://sub.localhost:3128",
		// socks5 schemes also checked
		"socks5://127.0.0.1:1080",
		"socks5://192.168.1.1:1080",
	])("classifies %s as private", (url) => {
		expect(isPrivateProxyTarget(url)).toBe(true);
	});
});

describe("isPrivateProxyTarget — public addresses", () => {
	it.each([
		"http://proxy.example.com:3128",
		"https://corporate-proxy.acme.corp:8443",
		"http://8.8.8.8:3128",
		"http://1.1.1.1:3128",
		"http://104.21.0.1:3128",
		"http://172.15.255.255:3128", // just below 172.16 range
		"http://172.32.0.1:3128", // just above 172.31 range
		"http://[2001:db8::1]:3128", // documentation range — public-looking
		"http://[2600::1]:3128",
		"socks5h://proxy.corp.example:1080",
		// unparseable URL → not private (validation elsewhere rejects it)
		"not-a-url",
	])("classifies %s as public (or unparseable)", (url) => {
		expect(isPrivateProxyTarget(url)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// applyPrivateProxyGate
// ---------------------------------------------------------------------------

describe("applyPrivateProxyGate", () => {
	const granted = [PRIVATE_PROXY_CAPABILITY];
	const ungranteed: string[] = [];

	// No proxy URL at all → vacuously allowed, capability irrelevant.
	it("allows when proxyUrl is absent", () => {
		expect(applyPrivateProxyGate({ proxyUrl: undefined, grantedCapabilities: ungranteed })).toBe(
			"allow",
		);
	});

	it("allows when proxyUrl is empty string", () => {
		expect(applyPrivateProxyGate({ proxyUrl: "", grantedCapabilities: ungranteed })).toBe("allow");
	});

	// Public targets: always allowed regardless of grants.
	it.each([
		"http://proxy.example.com:3128",
		"https://corporate.proxy:8443",
		"http://8.8.8.8:3128",
		"socks5://1.2.3.4:1080",
	])("allows public proxy %s without any capability", (url) => {
		expect(applyPrivateProxyGate({ proxyUrl: url, grantedCapabilities: ungranteed })).toBe("allow");
	});

	it.each([
		"http://proxy.example.com:3128",
		"http://8.8.8.8:3128",
	])("allows public proxy %s even with capability granted", (url) => {
		expect(applyPrivateProxyGate({ proxyUrl: url, grantedCapabilities: granted })).toBe("allow");
	});

	// Private targets: suppressed without the capability.
	it.each([
		"http://127.0.0.1:3128",
		"http://localhost:3128",
		"http://10.0.0.1:3128",
		"http://192.168.1.1:3128",
		"http://172.16.0.1:3128",
		"http://169.254.0.1:3128",
		"http://[::1]:3128",
		"http://[fe80::1]:3128",
		"http://[fd00::1]:3128",
		"socks5://10.0.0.50:1080",
	])("suppresses private proxy %s when capability is absent", (url) => {
		expect(applyPrivateProxyGate({ proxyUrl: url, grantedCapabilities: ungranteed })).toBe(
			"suppress",
		);
	});

	// Private targets: allowed when the capability IS granted.
	it.each([
		"http://127.0.0.1:3128",
		"http://localhost:3128",
		"http://10.0.0.1:3128",
		"http://192.168.1.1:3128",
		"http://[::1]:3128",
		"socks5://10.0.0.50:1080",
	])("allows private proxy %s when network.egress.allowlist is granted", (url) => {
		expect(applyPrivateProxyGate({ proxyUrl: url, grantedCapabilities: granted })).toBe("allow");
	});

	it("suppresses even when other capabilities are granted but not network.egress.allowlist", () => {
		expect(
			applyPrivateProxyGate({
				proxyUrl: "http://192.168.1.1:3128",
				grantedCapabilities: ["query.read.projects", "secret.use_self"],
			}),
		).toBe("suppress");
	});

	it("PRIVATE_PROXY_CAPABILITY equals network.egress.allowlist", () => {
		expect(PRIVATE_PROXY_CAPABILITY).toBe("network.egress.allowlist");
	});
});
