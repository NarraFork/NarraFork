import { describe, expect, test } from "bun:test";
import { runSettingsSave } from "../../frontend/lib/settings-save";

describe("runSettingsSave", () => {
	test("returns the saved value when the request finishes", async () => {
		const result = await runSettingsSave(async () => ({ ok: true }), "stalled", 50);
		expect(result).toEqual({ ok: true });
	});

	test("rejects a request that never settles so the save button can recover", async () => {
		const pending = runSettingsSave(
			(signal) =>
				new Promise((_, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
			"save stalled",
			20,
		);
		await expect(pending).rejects.toThrow("save stalled");
	});

	test("preserves a failure that is not the timeout", async () => {
		await expect(
			runSettingsSave(
				async () => {
					throw new Error("validation");
				},
				"save stalled",
				50,
			),
		).rejects.toThrow("validation");
	});
});
