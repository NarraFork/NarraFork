import { afterEach, describe, expect, test } from "bun:test";
import { settings } from "../settings";
import { resolveRp } from "../webauthn-rp";

afterEach(() => {
	// Clear any per-test override (preload also restores settings globally).
	settings.auth.webauthn = undefined;
});

describe("resolveRp", () => {
	test("derives rpID + origin from the request Origin header by default", () => {
		const rp = resolveRp("https://app.example.com");
		expect(rp.rpID).toBe("app.example.com");
		expect(rp.origin).toBe("https://app.example.com");
		expect(rp.rpName).toBe("NarraFork");
		expect(rp.expectedOrigins).toContain("https://app.example.com");
	});

	test("handles localhost with a port", () => {
		const rp = resolveRp("http://localhost:7779");
		expect(rp.rpID).toBe("localhost");
		expect(rp.origin).toBe("http://localhost:7779");
	});

	test("configured rpID/rpName override the request-derived values", () => {
		settings.auth.webauthn = { rpID: "narrafork.example.com", rpName: "Acme" };
		const rp = resolveRp("https://internal-host.local");
		expect(rp.rpID).toBe("narrafork.example.com");
		expect(rp.rpName).toBe("Acme");
		// Origin still reflects the request.
		expect(rp.origin).toBe("https://internal-host.local");
	});

	test("configured origins are unioned with the live request origin", () => {
		settings.auth.webauthn = { origins: ["https://a.example.com", "https://b.example.com"] };
		const rp = resolveRp("https://b.example.com");
		expect(rp.expectedOrigins).toEqual(
			expect.arrayContaining(["https://a.example.com", "https://b.example.com"]),
		);
		// No duplicate when the request origin is already configured.
		expect(rp.expectedOrigins.filter((o) => o === "https://b.example.com")).toHaveLength(1);
	});

	test("falls back to the first configured origin when no Origin header is present", () => {
		settings.auth.webauthn = {
			rpID: "narrafork.example.com",
			origins: ["https://narrafork.example.com"],
		};
		const rp = resolveRp(undefined);
		expect(rp.rpID).toBe("narrafork.example.com");
		expect(rp.origin).toBe("https://narrafork.example.com");
	});

	test("throws when no RP can be determined (no header, no config)", () => {
		expect(() => resolveRp(undefined)).toThrow();
	});

	test("ignores an unparseable Origin header", () => {
		settings.auth.webauthn = {
			rpID: "narrafork.example.com",
			origins: ["https://narrafork.example.com"],
		};
		const rp = resolveRp("not-a-url");
		expect(rp.rpID).toBe("narrafork.example.com");
		expect(rp.origin).toBe("https://narrafork.example.com");
	});
});
