import { describe, expect, test } from "bun:test";
import {
	commitNarratorDefaultDevice,
	filterOAuthSessionDevices,
	resolveNarratorDefaultDeviceRequest,
} from "../narrator-session";

describe("commitNarratorDefaultDevice", () => {
	test("updates memory only after persistence succeeds", async () => {
		const active = { _defaultDeviceId: "device-old" as string | null };
		const order: string[] = [];
		const committed = await commitNarratorDefaultDevice(
			"narrator-1",
			active,
			"device-new",
			async () => {
				order.push("persist");
				expect(active._defaultDeviceId).toBe("device-old");
				return true;
			},
		);
		order.push("returned");

		expect(committed).toBe(true);
		expect(active._defaultDeviceId).toBe("device-new");
		expect(order).toEqual(["persist", "returned"]);
	});

	test("preserves the previous memory target on zero-row or persistence failure", async () => {
		for (const persist of [
			async () => false,
			async () => {
				throw new Error("database unavailable");
			},
		]) {
			const active = { _defaultDeviceId: "device-old" as string | null };
			const committed = await commitNarratorDefaultDevice(
				"narrator-1",
				active,
				"device-new",
				persist,
			);
			expect(committed).toBe(false);
			expect(active._defaultDeviceId).toBe("device-old");
		}
	});
});

describe("OAuth narrator device routing", () => {
	const devices = [
		{ id: "device-a", slug: "a", name: "Device A", online: true },
		{ id: "device-b", slug: "b", name: "Device B", online: true },
		{ id: "device-c", slug: "c", name: "Device C", online: true },
	];

	test("intersects project devices with the provisioned authorization set", () => {
		expect(
			filterOAuthSessionDevices(devices, { deviceIds: ["device-a", "device-b"] }).map(
				(device) => device.id,
			),
		).toEqual(["device-a", "device-b"]);
	});

	test("allows an authorized id or slug but rejects local and out-of-set targets", () => {
		const authorized = new Set(["device-a", "device-b"]);
		expect(
			resolveNarratorDefaultDeviceRequest("b", devices, {
				allowLocal: false,
				authorizedDeviceIds: authorized,
			}),
		).toBe("device-b");
		expect(() =>
			resolveNarratorDefaultDeviceRequest("local", devices, {
				allowLocal: false,
				authorizedDeviceIds: authorized,
			}),
		).toThrow("may not execute on the local server");
		expect(() =>
			resolveNarratorDefaultDeviceRequest("device-c", devices, {
				allowLocal: false,
				authorizedDeviceIds: authorized,
			}),
		).toThrow("Unknown or unauthorized device");
	});
});
