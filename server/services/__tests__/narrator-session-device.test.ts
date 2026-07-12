import { describe, expect, test } from "bun:test";
import { commitNarratorDefaultDevice } from "../narrator-session";

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
