import { afterEach, describe, expect, mock, test } from "bun:test";

const requests: Array<{ path: string; init?: RequestInit }> = [];
const response: unknown = { success: true, status: { enabled: false } };
mock.module("./client", () => ({
	request: async (path: string, init?: RequestInit) => {
		requests.push({ path, init });
		return response;
	},
	ApiError: class ApiError extends Error {},
}));

const { unattendedApi } = await import("./unattended");

afterEach(() => {
	requests.length = 0;
});

describe("unattended mode API", () => {
	test("status reads the system endpoint with the caller's signal", async () => {
		const controller = new AbortController();
		await unattendedApi.getUnattendedStatus(controller.signal);
		expect(requests[0]?.path).toBe("/system/unattended");
		expect(requests[0]?.init?.signal).toBe(controller.signal);
	});

	test("arming posts the full option set as JSON", async () => {
		await unattendedApi.setUnattendedMode({
			enabled: true,
			powerOff: true,
			quietSeconds: 120,
			armDelaySeconds: 60,
			powerOffCommand: null,
		});
		expect(requests[0]?.path).toBe("/system/unattended");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
			enabled: true,
			powerOff: true,
			quietSeconds: 120,
			armDelaySeconds: 60,
			powerOffCommand: null,
		});
	});

	test("cancelling uses its own parameterless endpoint", async () => {
		await unattendedApi.cancelUnattendedMode();
		expect(requests[0]?.path).toBe("/system/unattended/cancel");
		expect(requests[0]?.init?.method).toBe("POST");
		expect(requests[0]?.init?.body).toBeUndefined();
	});

	test("the query key is shared by the banner and the settings card", async () => {
		const { unattendedStatusQueryKey } = await import("./unattended");
		expect(unattendedStatusQueryKey).toEqual(["system-unattended"]);
	});
});
