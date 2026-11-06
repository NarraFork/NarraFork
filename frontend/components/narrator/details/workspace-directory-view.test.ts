import { describe, expect, test } from "bun:test";
import {
	beginEditingDevice,
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

describe("selecting a device for editing", () => {
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

	test("starts from that device's own recorded directory", () => {
		expect(beginEditingDevice(input, "win-box")).toEqual({
			editingDeviceId: "win-box",
			cwd: "C:\\work",
		});
	});

	test("a device with no directory starts empty instead of borrowing one", () => {
		// The panel is about to ask for a directory: prefilling the server's path would
		// present a path that means nothing on the target machine.
		expect(beginEditingDevice(input, "mac-box")).toEqual({
			editingDeviceId: "mac-box",
			cwd: "",
		});
	});

	test("re-selecting the current device is not a pending change", () => {
		expect(beginEditingDevice(input, "local")).toEqual({
			editingDeviceId: null,
			cwd: "/home/me/work",
		});
	});
});
