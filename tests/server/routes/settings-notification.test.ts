import { describe, expect, test } from "bun:test";
import { getDefaults } from "../../../server/lib/settings";
import { updateSettingsSchema } from "../../../server/routes/settings";

describe("Notification pre-approval settings", () => {
	test("defaults to requiring approval", () => {
		expect(getDefaults().agent.notificationPolicy?.allowSend).toBe(false);
	});

	test("accepts minimal patches without discarding either toggle value", () => {
		for (const allowSend of [true, false]) {
			const patch = { agent: { notificationPolicy: { allowSend } } };
			expect(updateSettingsSchema.parse(patch)).toEqual(patch);
		}
	});

	test("rejects non-boolean values rather than implicitly allowing send", () => {
		for (const allowSend of ["true", "false", 1, 0, null]) {
			expect(
				updateSettingsSchema.safeParse({ agent: { notificationPolicy: { allowSend } } }).success,
			).toBe(false);
		}
	});
});
