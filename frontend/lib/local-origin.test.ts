import { describe, expect, test } from "bun:test";
import { isLoopbackBrowserOrigin } from "./local-origin";

function windowWithHostname(hostname: string): Window {
	return { location: { hostname } } as unknown as Window;
}

describe("isLoopbackBrowserOrigin", () => {
	test("loopback forms count as the same machine as the server", () => {
		for (const hostname of ["localhost", "LOCALHOST", "127.0.0.1", "127.5.5.5", "::1", "[::1]"]) {
			expect(isLoopbackBrowserOrigin(windowWithHostname(hostname))).toBe(true);
		}
	});

	test("a LAN address is not local: the file manager would open on another desktop", () => {
		for (const hostname of ["192.168.1.10", "10.0.0.5", "172.16.0.9"]) {
			expect(isLoopbackBrowserOrigin(windowWithHostname(hostname))).toBe(false);
		}
	});

	test("hostnames are never assumed to resolve to loopback", () => {
		// `nf.local` may well point at 127.0.0.1, but the browser cannot know that, and
		// guessing wrong offers an action that silently does nothing.
		for (const hostname of ["nf.local", "narrafork.example.com", "localhost.example.com"]) {
			expect(isLoopbackBrowserOrigin(windowWithHostname(hostname))).toBe(false);
		}
	});

	test("fails closed when there is no usable location", () => {
		expect(isLoopbackBrowserOrigin(windowWithHostname(""))).toBe(false);
		expect(isLoopbackBrowserOrigin({} as unknown as Window)).toBe(false);
		expect(
			isLoopbackBrowserOrigin({
				get location(): never {
					throw new Error("cross-origin");
				},
			} as unknown as Window),
		).toBe(false);
	});
});
