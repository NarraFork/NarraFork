import { describe, expect, test } from "bun:test";
import { buildDeviceRunCommand, isValidOptionalDeviceSlug, isWebSocketUrl } from "./device-config";

describe("device configuration helpers", () => {
	test("requires wss except for loopback IP literals", () => {
		expect(isWebSocketUrl("ws://127.0.0.1:7900/ws/device")).toBe(true);
		expect(isWebSocketUrl("ws://[::1]:7900/ws/device")).toBe(true);
		expect(isWebSocketUrl("wss://executor.example.com/ws/device")).toBe(true);
		expect(isWebSocketUrl("ws://192.168.1.20:7900/ws/device")).toBe(false);
		expect(isWebSocketUrl("ws://localhost:7900/ws/device")).toBe(false);
		expect(isWebSocketUrl("https://executor.example.com/ws/device")).toBe(false);
		expect(isWebSocketUrl("not a URL")).toBe(false);
	});

	test("validates optional stable device slugs", () => {
		expect(isValidOptionalDeviceSlug("")).toBe(true);
		expect(isValidOptionalDeviceSlug("build_server-1")).toBe(true);
		expect(isValidOptionalDeviceSlug("A Device")).toBe(false);
		expect(isValidOptionalDeviceSlug("x")).toBe(false);
		expect(isValidOptionalDeviceSlug("x".repeat(65))).toBe(false);
	});

	test("builds mode-specific commands without exposing the token in argv", () => {
		const reverse = buildDeviceRunCommand("reverse", "build-server");
		expect(reverse).toContain("--server wss://<narrafork-host>/ws/device");
		expect(reverse).toContain("--device build-server");
		expect(reverse).toContain("--token-file /path/to/device-token");
		expect(reverse).not.toContain("--token rdev_");
		expect(reverse).not.toContain("--listen");

		const direct = buildDeviceRunCommand("direct", "lab-pc");
		expect(direct).toContain("--listen 0.0.0.0:7900");
		expect(direct).toContain("--tls-cert");
		expect(direct).toContain("--tls-key");
		expect(direct).toContain("--device lab-pc");

		const stdin = buildDeviceRunCommand("reverse", "pipe-device", "stdin");
		expect(stdin).toContain("--token-stdin");
		expect(stdin).not.toContain("--token-file");
	});
});
