import { afterEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { narratorGoals, narrators } from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

mock.module("../../../server/db", () => ({ db, sqlite }));

const { enterNarratorPlanMode } = await import("../../../server/services/narrator-plan-mode");

const NOW = "2026-05-10T00:00:00.000Z";

afterEach(() => cleanDb(sqlite));

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

function seedGoal(status: "pending" | "active" | "paused" = "active") {
	db.insert(narratorGoals)
		.values({
			id: `g-${status}`,
			narratorId: "n1",
			objective: "Finish the goal-driven implementation",
			status,
			sortOrder: 1,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

describe("enterNarratorPlanMode", () => {
	it("auto-enables relaxed plan for agent-entered plan mode with an active goal", async () => {
		seedNarrator();
		seedGoal("active");

		const result = await enterNarratorPlanMode("n1", {
			autoRelaxedPlanForActiveGoal: true,
		});

		expect(result.wasPlanMode).toBe(false);
		expect(result.relaxedPlan).toBe(true);
		expect(result.relaxedPlanChanged).toBe(true);
		expect(result.activeGoalId).toBe("g-active");

		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(row?.planMode).toBe(true);
		expect(row?.relaxedPlan).toBe(true);
		expect(row?.traits).toContain("plan");
	});

	it("keeps manual plan entry strict even when an active goal exists", async () => {
		seedNarrator();
		seedGoal("active");

		const result = await enterNarratorPlanMode("n1");

		expect(result.relaxedPlan).toBe(false);
		expect(result.relaxedPlanChanged).toBe(false);

		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(row?.planMode).toBe(true);
		expect(row?.relaxedPlan).toBe(false);
	});

	it("does not auto-enable relaxed plan without an active goal", async () => {
		seedNarrator();
		seedGoal("pending");

		const result = await enterNarratorPlanMode("n1", {
			autoRelaxedPlanForActiveGoal: true,
		});

		expect(result.relaxedPlan).toBe(false);
		expect(result.relaxedPlanChanged).toBe(false);
		expect(result.activeGoalId).toBeUndefined();

		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(row?.planMode).toBe(true);
		expect(row?.relaxedPlan).toBe(false);
	});
});
