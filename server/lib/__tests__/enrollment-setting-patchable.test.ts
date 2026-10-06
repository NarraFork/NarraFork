/**
 * enrollment-setting-patchable.test.ts — the plaintext-enrollment opt-in must be
 * reachable over the API.
 *
 * `updateSettingsSchema` is `.strict()`, so an unlisted group does not fall through
 * quietly: the WHOLE patch is rejected. When `devices` was missing, the install
 * dialog's refusal named a setting that could only be changed by hand-editing
 * settings.json — the instruction it gave was impossible to follow in the product.
 *
 * Pinned as its own file because nothing else fails when this regresses: the server
 * still enforces the policy correctly, the UI still explains itself, and only the
 * remedy is unreachable. That combination does not surface in any other test.
 */

import { describe, expect, test } from "bun:test";

async function parseDevices(devices: unknown) {
	const { updateSettingsSchema } = await import("../../routes/settings");
	return updateSettingsSchema.safeParse({ devices });
}

describe("devices.allowPlaintextEnrollmentOnPrivateNetwork over PATCH /api/settings", () => {
	test("both values are accepted", async () => {
		for (const value of [true, false]) {
			const parsed = await parseDevices({ allowPlaintextEnrollmentOnPrivateNetwork: value });
			expect(parsed.success).toBe(true);
			if (parsed.success) {
				expect(parsed.data.devices?.allowPlaintextEnrollmentOnPrivateNetwork).toBe(value);
			}
		}
	});

	test("a non-boolean is rejected rather than coerced", async () => {
		// A truthy string must not become "enabled": this flag decides whether a device
		// key may cross a plaintext network.
		expect((await parseDevices({ allowPlaintextEnrollmentOnPrivateNetwork: "true" })).success).toBe(
			false,
		);
	});

	test("the group is partial, so patching it does not require every field", async () => {
		expect((await parseDevices({})).success).toBe(true);
	});

	/**
	 * The rest of `devices` (transfer concurrency, verify mode, transfers dir) has no
	 * UI and is deliberately not exposed. Unlisted keys are STRIPPED rather than
	 * rejected — the group follows the schema's prevailing convention, unlike the
	 * `.strict()` top level.
	 *
	 * Stripping is the safe half of that: the value never reaches the merge, so it
	 * cannot write a setting nobody validated. Asserted on the parsed output rather
	 * than on `success`, because a passing parse alone would not show that.
	 */
	test("unrelated device settings are stripped, never merged", async () => {
		const parsed = await parseDevices({
			allowPlaintextEnrollmentOnPrivateNetwork: true,
			transferVerify: "none",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.devices).toEqual({ allowPlaintextEnrollmentOnPrivateNetwork: true });
		}
	});
});
