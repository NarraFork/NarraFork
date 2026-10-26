import { describe, expect, test } from "bun:test";
import {
	isLoopbackHost,
	managerControlCompanionHost,
	managerControlHost,
	managerControlOrigin,
	probeHost,
	urlHost,
} from "./server-host";

describe("urlHost", () => {
	test("通配地址和 auto-lan 写成回环，裸 IPv6 加方括号", () => {
		expect(urlHost("0.0.0.0")).toBe("127.0.0.1");
		expect(urlHost("::")).toBe("127.0.0.1");
		expect(urlHost("[::]")).toBe("127.0.0.1");
		expect(urlHost("")).toBe("127.0.0.1");
		expect(urlHost("auto-lan")).toBe("127.0.0.1");
		expect(urlHost("::1")).toBe("[::1]");
		expect(urlHost("[::1]")).toBe("[::1]");
		expect(urlHost("localhost")).toBe("localhost");
	});
});

describe("manager control destination", () => {
	for (const [host, destination, companion] of [
		["0.0.0.0", "127.0.0.1", false],
		["::", "::1", false],
		["[::]", "::1", false],
		["::1", "::1", false],
		["[::1]", "::1", false],
		["127.0.0.1", "127.0.0.1", false],
		["127.12.34.56", "127.12.34.56", false],
		["localhost", "localhost", false],
		["auto-lan", "127.0.0.1", true],
		["192.168.1.50", "127.0.0.1", true],
		["fe80::1234", "127.0.0.1", true],
		["server.example", "127.0.0.1", true],
	] as const) {
		test(host, () => {
			expect(managerControlHost(host)).toBe(destination);
			expect(managerControlCompanionHost(host)).toBe(companion ? "127.0.0.1" : undefined);
			const authority = destination.includes(":") ? `[${destination}]` : destination;
			expect(managerControlOrigin({ protocol: "https", host, port: 9876 })).toBe(
				`https://${authority}:9876`,
			);
		});
	}

	test("only actual loopback literals or the exact localhost name are trusted", () => {
		for (const host of [
			"127.1.2.3",
			"localhost",
			"LOCALHOST",
			"::1",
			"0:0:0:0:0:0:0:1",
			"::ffff:127.0.0.1",
		]) {
			expect(isLoopbackHost(host)).toBe(true);
		}
		for (const host of [
			"0.0.0.0",
			"::",
			"127.999.0.1",
			"127.0.0.1.example",
			"server.example",
			"localhost.example",
			"localhost.",
			"192.168.1.1",
			"::ffff:192.168.1.1",
		]) {
			expect(isLoopbackHost(host)).toBe(false);
		}
	});
});

describe("probeHost", () => {
	test("通配地址探测回环，auto-lan 探测第一块局域网地址", () => {
		expect(probeHost("0.0.0.0", ["192.168.1.5"])).toBe("127.0.0.1");
		expect(probeHost("::")).toBe("127.0.0.1");
		expect(probeHost("auto-lan", ["192.168.1.5", "10.0.0.2"])).toBe("192.168.1.5");
		expect(probeHost("auto-lan", ["", "10.0.0.2"])).toBe("10.0.0.2");
		expect(probeHost("auto-lan")).toBe("127.0.0.1");
		expect(probeHost("::1")).toBe("[::1]");
		expect(probeHost("[fe80::1]")).toBe("[fe80::1]");
	});
});
