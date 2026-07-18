import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { NotFoundError } from "../../lib/errors";

const realNarratorServiceModule = { ...(await import("../narrator-service")) };
const updateCoordinator = await import("../update-coordinator");

let loadMode: "missing" | "transient" = "transient";

mock.module("../narrator-service", () => ({
	...realNarratorServiceModule,
	narratorService: {
		...realNarratorServiceModule.narratorService,
		getById: async (id: string) => {
			if (loadMode === "missing") throw new NotFoundError("Narrator", id);
			throw new Error("temporary database failure");
		},
	},
}));

const { restoreNarratorsAfterPlannedUpdate } = await import("../update-recovery-service");

beforeAll(() => {
	updateCoordinator.resetUpdateCoordinationForTests();
});

afterEach(() => {
	updateCoordinator.resetUpdateCoordinationForTests();
});

afterAll(() => {
	mock.module("../narrator-service", () => realNarratorServiceModule);
	mock.restore();
});

describe("planned update recovery snapshot", () => {
	test("retains transiently failed targets for the next startup", async () => {
		loadMode = "transient";
		updateCoordinator.writePlannedUpdateRecoverySnapshot({
			version: 1,
			targetVersion: "4.0.0",
			capturedAt: new Date().toISOString(),
			narrators: [{ narratorId: "n1", locale: "en" }],
		});

		await restoreNarratorsAfterPlannedUpdate();

		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()?.narrators).toEqual([
			{ narratorId: "n1", locale: "en" },
		]);
	});

	test("drops targets whose narrators were deleted", async () => {
		loadMode = "missing";
		updateCoordinator.writePlannedUpdateRecoverySnapshot({
			version: 1,
			targetVersion: "4.0.0",
			capturedAt: new Date().toISOString(),
			narrators: [{ narratorId: "deleted", locale: "en" }],
		});

		await restoreNarratorsAfterPlannedUpdate();

		expect(updateCoordinator.consumePlannedUpdateRecoverySnapshot()).toBeNull();
	});
});
