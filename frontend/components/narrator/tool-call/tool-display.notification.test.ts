import { describe, expect, it } from "bun:test";
import { getCategory, getSummary } from "./tool-display";

describe("Notification routing-only summary", () => {
	it("shows the action, exact user and channel without message or credentials", () => {
		const summary = getSummary("Notification", {
			action: "send",
			user_id: "user-123",
			username: "ignored-name",
			channels: ["dingtalk"],
			title: "private title",
			message: "private message",
			webhook: "private webhook",
			secret: "private secret",
		});
		expect(summary).toBe("send · → user-123 · dingtalk");
		expect(summary).not.toContain("private");
	});

	it("shows an exact username and multiple channels", () => {
		expect(
			getSummary("Notification", {
				action: "send",
				username: "alice",
				channels: ["dingtalk", "feishu", "dingtalk"],
			}),
		).toBe("send · → alice · dingtalk · feishu");
	});

	it("identifies the default send as using available channels", () => {
		expect(getSummary("Notification", { action: "send", username: "alice" })).toBe(
			"send · → alice · available channels",
		);
	});

	it("lists channels without inventing a send operation", () => {
		expect(getSummary("Notification", { action: "list_channels", username: "alice" })).toBe(
			"list_channels · → alice",
		);
	});

	it("never falls back to message fields for missing or malformed routing input", () => {
		for (const input of [
			null,
			{},
			"private body",
			{ message: "private body", title: "private title" },
			{ action: "private action", channel: "private channel", channels: [null, 123] },
			{ _truncated: true, preview: "private body" },
		]) {
			expect(getSummary("Notification", input)).toBe("Notification");
		}
	});

	it("uses routing fields during streaming instead of a message or character preview", () => {
		expect(
			getSummary("Notification", {
				_streamingChars: 1000,
				_streamingFields: {
					action: "send",
					username: "alice",
					channels: ["feishu"],
					message: "private body",
				},
			}),
		).toBe("send · → alice · feishu");
	});

	it("bounds long targets and keeps the existing generic icon/detail category", () => {
		const summary = getSummary("Notification", {
			action: "send",
			username: "a".repeat(1000),
			channels: ["dingtalk", "feishu"],
		});
		expect(summary.length).toBeLessThanOrEqual(100);
		expect(summary).toContain("feishu");
		expect(getCategory("Notification")).toBe("generic");
	});
});
