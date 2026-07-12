import { describe, expect, test } from "bun:test";
import { filterDeviceTools } from "../loop";
import type { ResolvedToolDefinition } from "../types";

const tools = ["Read", "SwitchDevice", "TransferFile"].map(
	(name) => ({ name }) as ResolvedToolDefinition,
);

function visibleToolNames(config: Parameters<typeof filterDeviceTools>[1]): string[] {
	return filterDeviceTools(tools, config).map((tool) => tool.name);
}

describe("device tool visibility", () => {
	test("hides both device tools for a local-only session", () => {
		expect(visibleToolNames({ availableDevices: [], defaultDeviceId: null })).toEqual(["Read"]);
	});

	test("shows both device tools when a remote device is online", () => {
		expect(
			visibleToolNames({
				availableDevices: [{ id: "device-1", slug: "device-1", name: "Device One", online: true }],
				defaultDeviceId: "device-1",
			}),
		).toEqual(["Read", "SwitchDevice", "TransferFile"]);
	});

	test("keeps SwitchDevice but hides TransferFile for a stale remote default", () => {
		expect(
			visibleToolNames({
				availableDevices: [{ id: "device-1", slug: "device-1", name: "Device One", online: false }],
				defaultDeviceId: "device-1",
			}),
		).toEqual(["Read", "SwitchDevice"]);
	});
});
