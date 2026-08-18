import { describe, expect, test } from "bun:test";
import {
	enrollmentRefusalMessage,
	evaluateEnrollmentTransport,
} from "../executor-enrollment-policy";

function verdict(url: string, allowPrivateNetworkPlaintext = false) {
	return evaluateEnrollmentTransport({
		origin: new URL(url),
		allowPrivateNetworkPlaintext,
	});
}

describe("https and loopback are always allowed", () => {
	test("https on any host", () => {
		expect(verdict("https://nf.example.com")).toEqual({ allowed: true, reason: "https" });
		expect(verdict("https://192.168.1.10:7779")).toEqual({ allowed: true, reason: "https" });
	});

	test("plaintext loopback, because nothing leaves the machine", () => {
		for (const origin of ["http://localhost:7779", "http://127.0.0.1:7779", "http://[::1]:7779"]) {
			expect(verdict(origin)).toEqual({ allowed: true, reason: "loopback" });
		}
	});
});

describe("plaintext on a public address is never allowed", () => {
	test("refused regardless of the opt-in setting", () => {
		// The setting exists to cover LANs. If it also unlocked routable plaintext, a
		// LAN-motivated toggle would silently start leaking keys across the internet.
		for (const allow of [false, true]) {
			expect(verdict("http://nf.example.com", allow)).toEqual({
				allowed: false,
				reason: "insecure_public",
			});
		}
	});

	test("a public IP literal is treated as public", () => {
		expect(verdict("http://8.8.8.8:7779", true).allowed).toBe(false);
		// 172.32 is outside the 172.16–172.31 private block — an easy off-by-one.
		expect(verdict("http://172.32.0.1:7779", true).allowed).toBe(false);
		expect(verdict("http://11.0.0.1:7779", true).allowed).toBe(false);
	});
});

describe("plaintext on a private network requires the opt-in", () => {
	const privateOrigins = [
		"http://10.1.2.3:7779",
		"http://172.16.0.5:7779",
		"http://172.31.255.254:7779",
		"http://192.168.1.50:7779",
		// CGNAT — where Tailscale and similar overlays live.
		"http://100.100.5.5:7779",
		// Link-local.
		"http://169.254.10.10:7779",
		// IPv6 unique-local and link-local.
		"http://[fd00::1]:7779",
		"http://[fe80::1]:7779",
	];

	test("refused by default, so nobody inherits plaintext key delivery", () => {
		for (const origin of privateOrigins) {
			expect(verdict(origin, false)).toEqual({
				allowed: false,
				reason: "private_network_not_enabled",
			});
		}
	});

	test("allowed once explicitly enabled", () => {
		for (const origin of privateOrigins) {
			expect(verdict(origin, true)).toEqual({ allowed: true, reason: "private_network_opt_in" });
		}
	});
});

describe("refusal messages", () => {
	test("each refusal names an actionable remedy", () => {
		// A refusal that does not say what to do instead just looks like a broken
		// feature; manual key entry always remains available.
		const privateMsg = enrollmentRefusalMessage("private_network_not_enabled");
		expect(privateMsg).toContain("devices.allowPlaintextEnrollmentOnPrivateNetwork");
		expect(privateMsg).toContain("manual key entry");

		const publicMsg = enrollmentRefusalMessage("insecure_public");
		expect(publicMsg).toContain("https");
		expect(publicMsg).toContain("manual key entry");
	});

	test("a refused HOSTNAME gets its own explanation, not 'publicly routable'", () => {
		// The private-network check is literal-only, so `http://nas.lan` lands in the
		// insecure_public bucket even with the opt-in on. Telling that operator their
		// address is "publicly routable" reads as nonsense; the message has to name
		// the actual rule instead.
		const msg = enrollmentRefusalMessage("insecure_public", { hostname: "nas.lan" });
		expect(msg).toContain("hostname");
		expect(msg).toContain("devices.allowPlaintextEnrollmentOnPrivateNetwork");
		expect(msg).not.toContain("publicly routable");
		// The remedies do not change.
		expect(msg).toContain("https");
		expect(msg).toContain("manual key entry");

		// A routable IP literal keeps the original wording.
		const literalMsg = enrollmentRefusalMessage("insecure_public", { hostname: "203.0.113.10" });
		expect(literalMsg).toContain("publicly routable");
	});
});
