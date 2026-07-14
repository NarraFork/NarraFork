import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { narrators } from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({ db, sqlite }));

const { enterNarratorPlanMode } = await import("../../../server/services/narrator-plan-mode");

const NOW = "2026-05-10T00:00:00.000Z";

afterEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.restore();
});

function seedNarrator(id = "n1", relaxedPlan = false) {
	db.insert(narrators)
		.values({
			id,
			type: "primary",
			inheritMode: "fresh",
			relaxedPlan,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

describe("enterNarratorPlanMode", () => {
	it("enters plan mode without auto-relaxing the plan", async () => {
		seedNarrator();

		const result = await enterNarratorPlanMode("n1");

		expect(result.wasPlanMode).toBe(false);
		expect(result.relaxedPlan).toBe(false);
		expect(result.relaxedPlanChanged).toBe(false);

		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(row?.planMode).toBe(true);
		expect(row?.relaxedPlan).toBe(false);
		expect(row?.traits).toContain("plan");
	});

	it("preserves an already-relaxed plan when entering plan mode", async () => {
		seedNarrator("n1", true);

		const result = await enterNarratorPlanMode("n1");

		expect(result.relaxedPlan).toBe(true);
		expect(result.relaxedPlanChanged).toBe(false);

		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(row?.planMode).toBe(true);
		expect(row?.relaxedPlan).toBe(true);
	});
});
