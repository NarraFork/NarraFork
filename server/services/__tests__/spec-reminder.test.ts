/**
 * Unit tests for behavior-fence reminder building.
 *
 * Run with an isolated data dir, for example:
 * NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$HOME/.narrafork/perf-isolation/spec-reminder-test \
 *   bun test server/services/__tests__/spec-reminder.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { generateId } from "../../lib/id";
import { buildBehaviorFenceReminder } from "../spec-reminder";
import { writeSpecFile } from "../spec-vfs-service";

let emptyFenceNarratorId: string;
let filledFenceNarratorId: string;

async function createNarrator(id: string): Promise<void> {
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "default",
		permissionMode: "default",
		status: "idle",
		createdAt: now,
		updatedAt: now,
	});
}

beforeAll(async () => {
	emptyFenceNarratorId = generateId();
	filledFenceNarratorId = generateId();
	await createNarrator(emptyFenceNarratorId);
	await createNarrator(filledFenceNarratorId);
});

describe("buildBehaviorFenceReminder", () => {
	test("returns null when the fence is empty (default)", async () => {
		const reminder = await buildBehaviorFenceReminder(emptyFenceNarratorId, "en");
		expect(reminder).toBeNull();
	});

	test("returns null when the fence is only whitespace", async () => {
		await writeSpecFile(emptyFenceNarratorId, "spec://behavior_fence", "   \n\t\n  ", {
			actor: "user",
			createdBy: "user",
		});
		const reminder = await buildBehaviorFenceReminder(emptyFenceNarratorId, "en");
		expect(reminder).toBeNull();
	});

	test("formats the fence content when non-empty", async () => {
		const body = "Never touch the auth module without approval.";
		await writeSpecFile(filledFenceNarratorId, "spec://behavior_fence", body, {
			actor: "user",
			createdBy: "user",
		});
		const en = await buildBehaviorFenceReminder(filledFenceNarratorId, "en");
		expect(en).toContain(body);
		expect(en).toContain("Behavior fence");

		const zh = await buildBehaviorFenceReminder(filledFenceNarratorId, "zh-CN");
		expect(zh).toContain(body);
		expect(zh).toContain("行为护栏");
	});
});
