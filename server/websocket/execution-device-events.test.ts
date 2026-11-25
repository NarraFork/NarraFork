import { afterEach, describe, expect, test } from "bun:test";
import { EXECUTION_DEVICES_CHANGED_WS_TYPE } from "@shared/execution-devices";
import { eventBus, type NarraForkEvent } from "../lib/event-bus";
import { registerExecutionDeviceChangeBroadcast } from "./execution-device-events";

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 130));

describe("execution device change broadcasts", () => {
	test("device and visibility bursts publish only one data-free authenticated-channel hint", async () => {
		const frames: unknown[] = [];
		dispose = registerExecutionDeviceChangeBroadcast((frame) => frames.push(frame));
		const events: NarraForkEvent[] = [
			{ type: "device:changed", deviceId: "private-device" },
			{ type: "device:status", deviceId: "private-device", status: "online" },
			{ type: "device:revoked", deviceId: "private-device" },
			{
				type: "oauth:grant_changed",
				grantId: "private-grant",
				change: "revoked",
				reasonCode: "revoked",
			},
			{
				type: "oauth:client_changed",
				oauthClientId: "private-client",
				change: "restricted",
				reasonCode: "policy",
			},
			{ type: "project:access_changed", projectId: "private-project", reason: "members_changed" },
			{ type: "narrator:access_changed", narratorId: "private-session", reason: "owner_changed" },
			{ type: "narrator:execution_principal_changed", narratorId: "private-session" },
		];
		for (const event of events) eventBus.emit(event);
		expect(frames).toEqual([]);
		await flush();
		expect(frames).toEqual([{ type: EXECUTION_DEVICES_CHANGED_WS_TYPE }]);
	});

	test("online/offline updates keep publishing but status noise and OAuth token rotation do not", async () => {
		const frames: unknown[] = [];
		dispose = registerExecutionDeviceChangeBroadcast((frame) => frames.push(frame));
		eventBus.emit({ type: "device:status", deviceId: "d", status: "online" });
		await flush();
		eventBus.emit({ type: "device:status", deviceId: "d", status: "offline" });
		await flush();
		expect(frames).toHaveLength(2);
		eventBus.emit({
			type: "oauth:token_invalidated",
			tokenId: "rotated-token",
			reasonCode: "rotation",
		});
		eventBus.emit({ type: "narrator:status_changed", narratorId: "n1", status: "working" });
		await flush();
		expect(frames).toHaveLength(2);
	});

	test("disposal cancels queued signals and detaches every lifecycle listener", async () => {
		const frames: unknown[] = [];
		dispose = registerExecutionDeviceChangeBroadcast((frame) => frames.push(frame));
		eventBus.emit({ type: "device:changed", deviceId: "d" });
		dispose();
		eventBus.emit({ type: "device:changed", deviceId: "d" });
		await flush();
		expect(frames).toEqual([]);
	});
});
