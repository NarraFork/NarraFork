import { describe, expect, test } from "bun:test";
import type { ToolContext } from "../../types";
import { switchDeviceTool } from "../switch-device";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		narratorId: "narrator-1",
		cwd: "/tmp",
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" }),
		...overrides,
	};
}

describe("SwitchDevice", () => {
	test("can switch a stale remote default back to local with no online devices", async () => {
		let applied: string | null | undefined;
		const result = await switchDeviceTool.execute(
			{ device: "local" },
			makeContext({
				availableDevices: [],
				defaultDeviceId: "stale-device",
				setDefaultDevice: async (deviceId) => {
					applied = deviceId;
					return true;
				},
			}),
		);

		expect(result.isError).not.toBe(true);
		expect(result.output).toContain("local");
		expect(applied).toBeNull();
	});

	test("hides and rejects local execution when the runtime forbids it", async () => {
		const schema = switchDeviceTool.getRawJsonSchema?.({
			availableDevices: [{ id: "device-1", slug: "device-1", name: "Device One", online: true }],
			allowLocalExecution: false,
		} as never) as { properties: { device: { enum: string[] } } };
		expect(schema.properties.device.enum).toEqual(["device-1"]);

		let applied = false;
		const result = await switchDeviceTool.execute(
			{ device: "local" },
			makeContext({
				allowLocalExecution: false,
				availableDevices: [{ id: "device-1", slug: "device-1", name: "Device One", online: true }],
				setDefaultDevice: async () => {
					applied = true;
					return true;
				},
			}),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("not allowed");
		expect(applied).toBe(false);
	});

	test("rejects an offline remote target", async () => {
		const result = await switchDeviceTool.execute(
			{ device: "device-1" },
			makeContext({
				availableDevices: [{ id: "device-1", slug: "device-1", name: "Device One", online: false }],
			}),
		);

		expect(result.isError).toBe(true);
		expect(result.output).toContain("offline");
	});
});
