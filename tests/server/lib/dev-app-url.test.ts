import { describe, expect, test } from "bun:test";
import {
	DEFAULT_DEV_FRONTEND_PORT,
	DEV_ALL_BACKEND_PORT,
	DEV_APP_URL_ENV,
	devAllBackendEnv,
	devFrontendOrigin,
	resolveAdvertisedAppUrl,
} from "@server/lib/dev-app-url";

const LISTEN = "http://localhost:7779";

describe("devFrontendOrigin", () => {
	test("defaults to the Vite port", () => {
		expect(devFrontendOrigin({})).toBe(`http://localhost:${DEFAULT_DEV_FRONTEND_PORT}`);
	});

	test("honors a numeric VITE_PORT", () => {
		expect(devFrontendOrigin({ VITE_PORT: "41221" })).toBe("http://localhost:41221");
		expect(devFrontendOrigin({ VITE_PORT: " 8080 " })).toBe("http://localhost:8080");
	});

	test("ignores a VITE_PORT that is not a TCP port", () => {
		for (const vitePort of ["", "0", "65536", "abc", "7778/app", "-1"]) {
			expect(devFrontendOrigin({ VITE_PORT: vitePort })).toBe(
				`http://localhost:${DEFAULT_DEV_FRONTEND_PORT}`,
			);
		}
	});
});

describe("devAllBackendEnv", () => {
	test("points the API at 7779 and advertises the frontend origin", () => {
		const env = devAllBackendEnv({ PATH: "/usr/bin", VITE_PORT: "9000", PORT: "7778" });
		expect(env.PORT).toBe(DEV_ALL_BACKEND_PORT);
		expect(env[DEV_APP_URL_ENV]).toBe("http://localhost:9000");
		expect(env.PATH).toBe("/usr/bin");
		expect(env.VITE_PORT).toBe("9000");
	});

	test("uses the default frontend port when VITE_PORT is unset", () => {
		expect(devAllBackendEnv({})[DEV_APP_URL_ENV]).toBe("http://localhost:7778");
		expect(devAllBackendEnv({}).PORT).toBe("7779");
	});
});

describe("resolveAdvertisedAppUrl", () => {
	test("keeps the listen URL when no dev app URL is set", () => {
		expect(resolveAdvertisedAppUrl({ listenUrl: LISTEN })).toBe(LISTEN);
		expect(resolveAdvertisedAppUrl({ listenUrl: LISTEN, devAppUrl: "  " })).toBe(LISTEN);
	});

	test("advertises the frontend origin from dev:all", () => {
		expect(
			resolveAdvertisedAppUrl({
				listenUrl: LISTEN,
				devAppUrl: "http://localhost:7778",
			}),
		).toBe("http://localhost:7778");
	});

	test("accepts an IPv6 loopback origin and drops a trailing slash", () => {
		expect(
			resolveAdvertisedAppUrl({
				listenUrl: LISTEN,
				devAppUrl: "http://[::1]:7778/",
			}),
		).toBe("http://[::1]:7778");
	});

	test("rejects values that are not an http(s) origin", () => {
		for (const devAppUrl of [
			"javascript:alert(1)",
			"file:///etc/passwd",
			"http://localhost:7778/login",
			"http://user:pass@localhost:7778",
			"http://localhost:7778?x=1",
			"not a url",
			"7778",
		]) {
			expect(resolveAdvertisedAppUrl({ listenUrl: LISTEN, devAppUrl })).toBe(LISTEN);
		}
	});
});
