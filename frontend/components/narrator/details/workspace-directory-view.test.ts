import { describe, expect, test } from "bun:test";
import {
	describeDeviceDirectories,
	deviceDirectoryCwd,
	deviceDisplayName,
} from "./workspace-directory-view";

const devices = [
	{ id: "win-box", name: "windows box" },
	{ id: "mac-box", name: "mac box" },
];

describe("per-device directory display", () => {
	test("each device shows its own recorded directory", () => {
		const input = {
			directories: {
				local: { cwd: "/home/me/work", pathFlavor: "posix" as const },
				"win-box": { cwd: "C:\\work", pathFlavor: "windows" as const },
			},
			currentDeviceId: "local",
			currentCwd: "/home/me/work",
			devices,
			localLabel: "Local server",
		};
		expect(deviceDirectoryCwd(input, "local")).toBe("/home/me/work");
		expect(deviceDirectoryCwd(input, "win-box")).toBe("C:\\work");
		// Recorded nowhere: the panel must say "not set", not borrow another device's path.
		expect(deviceDirectoryCwd(input, "mac-box")).toBeNull();
	});

	test("only the current device falls back to the effective cwd", () => {
		// A row written before the map existed (or a session that never switched) still
		// has its directory only in the session's effective cwd.
		const input = {
			directories: undefined,
			currentDeviceId: "win-box",
			currentCwd: "C:\\work",
			devices,
			localLabel: "Local server",
		};
		expect(deviceDirectoryCwd(input, "win-box")).toBe("C:\\work");
		expect(deviceDirectoryCwd(input, "local")).toBeNull();
	});

	test("device list lists the server first, then every visible device", () => {
		const rows = describeDeviceDirectories({
			directories: { "win-box": { cwd: "C:\\work", pathFlavor: "windows" } },
			currentDeviceId: "win-box",
			currentCwd: "C:\\work",
			devices,
			localLabel: "Local server",
		});
		expect(rows).toEqual([
			{ id: "local", name: "Local server", cwd: null },
			{ id: "win-box", name: "windows box", cwd: "C:\\work" },
			{ id: "mac-box", name: "mac box", cwd: null },
		]);
	});

	test("labels the server itself and falls back to the id for an unknown device", () => {
		const input = { devices, localLabel: "Local server" };
		expect(deviceDisplayName(input, "local")).toBe("Local server");
		expect(deviceDisplayName(input, "win-box")).toBe("windows box");
		expect(deviceDisplayName(input, "gone-box")).toBe("gone-box");
	});
});
