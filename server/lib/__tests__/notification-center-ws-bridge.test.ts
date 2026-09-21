import { describe, expect, test } from "bun:test";
import { eventBus } from "../event-bus";

/**
 * Bridge contract for `notification_center_changed` (task package D).
 *
 * WS delivery itself lives in narrator-ws (per-user broadcastToUser + coalesce).
 * This test pins the event-bus surface: user-scoped, body-free payload.
 */

describe("eventBus notification_center_changed", () => {
	test("accepts a user-scoped, body-free payload", () => {
		const seen: unknown[] = [];
		const handler = (event: {
			type: "notification_center_changed";
			userId: string;
			kinds?: string[];
		}) => {
			seen.push(event);
		};
		eventBus.on("notification_center_changed", handler);
		eventBus.emit({
			type: "notification_center_changed",
			userId: "user-1",
			kinds: ["chat_message"],
		});
		eventBus.off("notification_center_changed", handler);
		expect(seen).toEqual([
			{ type: "notification_center_changed", userId: "user-1", kinds: ["chat_message"] },
		]);
	});

	test("omits kinds when not provided", () => {
		const seen: unknown[] = [];
		const handler = (event: { type: "notification_center_changed"; userId: string }) => {
			seen.push(event);
		};
		eventBus.on("notification_center_changed", handler);
		eventBus.emit({ type: "notification_center_changed", userId: "user-2" });
		eventBus.off("notification_center_changed", handler);
		expect(seen).toEqual([{ type: "notification_center_changed", userId: "user-2" }]);
	});
});
