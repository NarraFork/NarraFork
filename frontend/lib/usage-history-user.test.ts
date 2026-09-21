import { describe, expect, test } from "bun:test";
import en from "@frontend/locales/en/common.json";
import zh from "@frontend/locales/zh-CN/common.json";
import { usageDimensionLabel, usageUserLabel, usageUserOptions } from "./usage-history-user";

describe("usage ownership labels", () => {
	test("keeps explicitly selected deleted IDs alongside existing users and unattributed", () => {
		const users = [{ id: "alice-id", username: "Alice" }];
		expect(usageUserOptions(users, "deleted-id", "未归属")).toEqual([
			{ value: "__unattributed__", label: "未归属" },
			{ value: "alice-id", label: "Alice" },
			{ value: "deleted-id", label: "deleted-id" },
		]);
		expect(usageUserOptions(users, "alice-id", "未归属")).toHaveLength(2);
		expect(usageUserOptions(users, "__unattributed__", "未归属")).toHaveLength(2);
		expect(usageUserOptions(users, undefined, "未归属")).toHaveLength(2);
		expect(usageUserOptions([], "deleted-id", "未归属")).toHaveLength(2);
	});

	test("prefers current username, retains deleted user IDs and never guesses old ownership", () => {
		expect(usageUserLabel({ userId: "user-1", username: "Alice" }, "Unattributed")).toBe("Alice");
		expect(usageUserLabel({ userId: "deleted-user", username: null }, "Unattributed")).toBe(
			"deleted-user",
		);
		expect(usageUserLabel({ userId: null, username: null }, "Unattributed")).toBe("Unattributed");
		expect(usageUserLabel({}, "未归属")).toBe("未归属");
	});

	test("translates only the user dimension's unattributed sentinel in both locales", () => {
		for (const locale of [en, zh]) {
			expect(usageDimensionLabel("__unattributed__", "user", locale.usageHistoryUnattributed)).toBe(
				locale.usageHistoryUnattributed,
			);
			expect(usageDimensionLabel("Alice", "user", locale.usageHistoryUnattributed)).toBe("Alice");
			expect(usageDimensionLabel("deleted-user", "user", locale.usageHistoryUnattributed)).toBe(
				"deleted-user",
			);
			expect(
				usageDimensionLabel("__unattributed__", "model", locale.usageHistoryUnattributed),
			).toBe("__unattributed__");
		}
	});
});
