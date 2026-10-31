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

	test("uses a static device string but rejects local execution when forbidden", async () => {
		const schema = switchDeviceTool.rawJsonSchema as {
			properties: { device: { type: string; enum?: string[] } };
		};
		expect(schema.properties.device.type).toBe("string");
		expect(schema.properties.device.enum).toBeUndefined();

		let applied = false;
		const result = await switchDeviceTool.execute(
			{ device: "local" },
			makeContext({
				allowLocalExecution: false,
				availableDevices: [
					{
						id: "device-1",
						slug: "device-1",
						name: "Device One",
						online: true,
						scope: "global" as const,
					},
				],
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
				availableDevices: [
					{
						id: "device-1",
						slug: "device-1",
						name: "Device One",
						online: false,
						scope: "global" as const,
					},
				],
			}),
		);

		expect(result.isError).toBe(true);
		expect(result.output).toContain("offline");
	});
});
