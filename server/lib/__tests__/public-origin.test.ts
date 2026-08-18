/**
 * `resolvePublicOrigin` decides which absolute URL this server hands to *other*
 * machines (install commands, OAuth metadata). Two failure directions, both quiet:
 *
 * - Trusting forwarded headers too readily lets a caller redirect those URLs.
 * - Not using them at all bakes in `http://127.0.0.1:7779`, which is unreachable
 *   from anywhere else. That was the original install-script defect.
 */
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
	isIpLiteralHostname,
	isLoopbackHostname,
	isPrivateNetworkHostname,
	resolvePublicOrigin,
	rightmostForwardedHeaderValue,
} from "../public-origin";

/** Resolve through a real Hono request so header parsing is not simulated. */
async function resolve(
	headers: Record<string, string>,
	options: { trustedProxy?: boolean; url?: string } = {},
): Promise<string> {
	const app = new Hono();
	app.get("/probe", (c) => c.text(resolvePublicOrigin(c).origin));
	const response = await app.request(
		options.url ?? "http://127.0.0.1:7779/probe",
		{ headers },
		{ trustedProxy: options.trustedProxy ?? false },
	);
	return response.text();
}

describe("untrusted peers", () => {
	test("forwarded headers are ignored entirely", async () => {
		expect(
			await resolve(
				{ "X-Forwarded-Proto": "https", "X-Forwarded-Host": "evil.example.com" },
				{ trustedProxy: false },
			),
		).toBe("http://127.0.0.1:7779");
	});
});

describe("trusted proxies", () => {
	test("the forwarded origin is used, which is the whole point", async () => {
		// Without this, every generated install command points at the proxy's upstream
		// target and no remote machine can reach it.
		expect(
			await resolve(
				{ "X-Forwarded-Proto": "https", "X-Forwarded-Host": "nf.example.com" },
				{ trustedProxy: true },
			),
		).toBe("https://nf.example.com");
	});

	test("a multi-hop chain uses the rightmost value", async () => {
		// The rightmost hop is the proxy we actually trust. Taking the leftmost would
		// accept whatever the original caller prepended.
		expect(
			await resolve(
				{
					"X-Forwarded-Proto": "http, https",
					"X-Forwarded-Host": "evil.example.com, nf.example.com",
				},
				{ trustedProxy: true },
			),
		).toBe("https://nf.example.com");
	});

	test("a non-http scheme falls back to the direct origin", async () => {
		expect(await resolve({ "X-Forwarded-Proto": "gopher" }, { trustedProxy: true })).toBe(
			"http://127.0.0.1:7779",
		);
	});

	test("a credentialed or path-bearing host falls back", async () => {
		// "user@host" and "host/path" are not origins; concatenating them would produce
		// a URL that reads as one host and resolves to another.
		for (const host of ["user:pw@nf.example.com", "nf.example.com/evil"]) {
			expect(await resolve({ "X-Forwarded-Host": host }, { trustedProxy: true })).toBe(
				"http://127.0.0.1:7779",
			);
		}
	});

	test("an empty or unparseable host falls back", async () => {
		expect(await resolve({ "X-Forwarded-Host": "   " }, { trustedProxy: true })).toBe(
			"http://127.0.0.1:7779",
		);
	});
});

describe("rightmostForwardedHeaderValue", () => {
	test("bounds header length and hop count", () => {
		// Untrusted input even from a trusted peer: an unbounded split is free work.
		expect(rightmostForwardedHeaderValue("a".repeat(3_000))).toBeNull();
		expect(rightmostForwardedHeaderValue(Array(25).fill("h").join(","))).toBeNull();
		expect(rightmostForwardedHeaderValue("a, b , c")).toBe("c");
	});
});

describe("isLoopbackHostname", () => {
	test("recognizes the loopback forms", () => {
		for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
			expect(isLoopbackHostname(host)).toBe(true);
		}
	});

	test("rejects non-loopback hosts", () => {
		for (const host of ["nf.example.com", "10.0.0.1", "128.0.0.1", "1.2.3.4"]) {
			expect(isLoopbackHostname(host)).toBe(false);
		}
	});

	test("rejects out-of-range octets rather than reading them as loopback", () => {
		expect(isLoopbackHostname("127.999.1.1")).toBe(false);
	});
});

describe("isPrivateNetworkHostname", () => {
	test("covers the private ranges", () => {
		for (const host of [
			"10.0.0.1",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.0.1",
			"100.64.0.1",
			"169.254.1.1",
			"fd00::1",
			"[fc00::1]",
			"fe80::1",
			"127.0.0.1",
		]) {
			expect(isPrivateNetworkHostname(host)).toBe(true);
		}
	});

	test("excludes public addresses and the near-misses around each boundary", () => {
		for (const host of [
			"8.8.8.8",
			"11.0.0.1",
			"172.15.0.1",
			"172.32.0.1",
			"192.169.0.1",
			"100.63.0.1",
			"100.128.0.1",
			"169.253.0.1",
			"2001:db8::1",
			"fe00::1",
		]) {
			expect(isPrivateNetworkHostname(host)).toBe(false);
		}
	});

	test("a hostname is never treated as private, however it resolves today", () => {
		// Resolution is outside this server's control and can change, so a DNS-based
		// answer would make the plaintext decision unverifiable.
		for (const host of ["intranet.example.com", "nas.local"]) {
			expect(isPrivateNetworkHostname(host)).toBe(false);
		}
	});
});

describe("isIpLiteralHostname", () => {
	test("recognizes v4 and v6 literals", () => {
		for (const host of [
			"10.0.0.1",
			"8.8.8.8",
			"127.0.0.1",
			"::1",
			"[::1]",
			"fd00::1",
			"[fe80::1]",
		]) {
			expect(isIpLiteralHostname(host)).toBe(true);
		}
	});

	test("names are not literals, including ones that look numeric-ish", () => {
		for (const host of ["nas.lan", "nf.example.com", "123.456.example.com", "1.2.3", "1.2.3.4.5"]) {
			expect(isIpLiteralHostname(host)).toBe(false);
		}
	});
});
