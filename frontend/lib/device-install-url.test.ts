import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	isEnrollableServerBaseUrl,
	isLoopbackHost,
	isLoopbackServerBaseUrl,
	isPrivateNetworkHost,
	rememberInstallServerBaseUrl,
	suggestedInstallServerBaseUrl,
} from "./device-install-url";

describe("isEnrollableServerBaseUrl", () => {
	test("https is always offered", () => {
		expect(isEnrollableServerBaseUrl("https://nf.example.com")).toBe(true);
		expect(isEnrollableServerBaseUrl("https://192.168.1.5:7779")).toBe(true);
	});

	test("plaintext http on a public address is disabled", () => {
		// The one case that can never be permitted, and the only one worth disabling
		// client-side: the refusal explains itself before the operator submits.
		expect(isEnrollableServerBaseUrl("http://nf.example.com")).toBe(false);
		expect(isEnrollableServerBaseUrl("http://8.8.8.8:7779")).toBe(false);
	});

	test("plaintext http on a private network stays offered", () => {
		// Whether LAN plaintext is allowed depends on a server setting the browser
		// cannot see, so the option is left available and the server decides. Disabling
		// it here would hide a working configuration.
		expect(isEnrollableServerBaseUrl("http://192.168.1.5:7779")).toBe(true);
		expect(isEnrollableServerBaseUrl("http://10.1.2.3:7779")).toBe(true);
		expect(isEnrollableServerBaseUrl("http://127.0.0.1:7779")).toBe(true);
	});

	test("an empty or unparseable value defers to the server", () => {
		// Empty means "derive it from the request origin"; the browser has no basis to
		// pre-judge that.
		for (const value of ["", "   ", "not a url", "ftp://nf.example.com"]) {
			expect(isEnrollableServerBaseUrl(value)).toBe(true);
		}
	});
});

describe("isLoopbackServerBaseUrl", () => {
	test("flags loopback so an unreachable address is noticed before install", () => {
		expect(isLoopbackServerBaseUrl("http://localhost:7779")).toBe(true);
		expect(isLoopbackServerBaseUrl("http://127.0.0.1:7779")).toBe(true);
		expect(isLoopbackServerBaseUrl("https://nf.example.com")).toBe(false);
		expect(isLoopbackServerBaseUrl("http://192.168.1.5:7779")).toBe(false);
		expect(isLoopbackServerBaseUrl("")).toBe(false);
	});
});

describe("host classification mirrors the server", () => {
	test("loopback forms", () => {
		for (const host of ["localhost", "127.0.0.1", "127.5.5.5", "::1"]) {
			expect(isLoopbackHost(host)).toBe(true);
		}
		expect(isLoopbackHost("128.0.0.1")).toBe(false);
		expect(isLoopbackHost("127.999.1.1")).toBe(false);
	});

	test("private ranges and their boundaries", () => {
		for (const host of [
			"10.0.0.1",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.0.1",
			"100.64.0.1",
			"169.254.1.1",
			"fd00::1",
			"fe80::1",
		]) {
			expect(isPrivateNetworkHost(host)).toBe(true);
		}
		for (const host of [
			"172.15.0.1",
			"172.32.0.1",
			"192.169.0.1",
			"100.63.0.1",
			"100.128.0.1",
			"8.8.8.8",
			"2001:db8::1",
		]) {
			expect(isPrivateNetworkHost(host)).toBe(false);
		}
	});

	test("a hostname is never assumed private", () => {
		expect(isPrivateNetworkHost("intranet.example.com")).toBe(false);
	});
});

describe("remembering the operator's choice", () => {
	const store = new Map<string, string>();
	let originalWindow: unknown;

	beforeEach(() => {
		store.clear();
		originalWindow = (globalThis as { window?: unknown }).window;
		(globalThis as { window?: unknown }).window = {
			location: { origin: "https://browser.example.com" },
			localStorage: {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => void store.set(key, value),
			},
		};
	});

	afterEach(() => {
		(globalThis as { window?: unknown }).window = originalWindow;
	});

	test("defaults to the browser's own origin, which demonstrably reaches the server", () => {
		expect(suggestedInstallServerBaseUrl()).toBe("https://browser.example.com");
	});

	test("an explicit override wins on later visits", () => {
		rememberInstallServerBaseUrl("https://vpn.internal:7779");
		expect(suggestedInstallServerBaseUrl()).toBe("https://vpn.internal:7779");
	});

	test("garbage is neither stored nor returned", () => {
		rememberInstallServerBaseUrl("not a url");
		expect(suggestedInstallServerBaseUrl()).toBe("https://browser.example.com");
	});

	test("storage failures never break the dialog", () => {
		// Private browsing throws on localStorage access; the field must still render.
		(globalThis as { window?: unknown }).window = {
			location: { origin: "https://browser.example.com" },
			get localStorage(): never {
				throw new Error("blocked");
			},
		};
		expect(suggestedInstallServerBaseUrl()).toBe("https://browser.example.com");
		expect(() => rememberInstallServerBaseUrl("https://ok.example.com")).not.toThrow();
	});
});
