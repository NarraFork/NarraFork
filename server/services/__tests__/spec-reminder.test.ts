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
import { buildBehaviorFenceReminder, buildSpecToolResultReminder } from "../spec-reminder";
import { writeSpecFile } from "../spec-vfs-service";

let emptyFenceNarratorId: string;
let filledFenceNarratorId: string;
let neverCreatedTasksNarratorId: string;
let openTasksNarratorId: string;
let blockedTasksNarratorId: string;
let allDoneTasksNarratorId: string;

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
	neverCreatedTasksNarratorId = generateId();
	openTasksNarratorId = generateId();
	blockedTasksNarratorId = generateId();
	allDoneTasksNarratorId = generateId();
	await createNarrator(emptyFenceNarratorId);
	await createNarrator(filledFenceNarratorId);
	await createNarrator(neverCreatedTasksNarratorId);
	await createNarrator(openTasksNarratorId);
	await createNarrator(blockedTasksNarratorId);
	await createNarrator(allDoneTasksNarratorId);
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

describe("buildSpecToolResultReminder", () => {
	test("nudges to create tasks when none were ever created", async () => {
		// A brand-new narrator's tasks.json defaults to an empty tasks array.
		const en = await buildSpecToolResultReminder(neverCreatedTasksNarratorId, "en");
		expect(en).not.toBeNull();
		expect(en).toContain("no active tasks");
		expect(en).toContain("have not created any task");
		expect(en).toContain("spec://tasks.json");
		// Keeps the escape hatch for simple work.
		expect(en).toContain("you may ignore this reminder");

		const zh = await buildSpecToolResultReminder(neverCreatedTasksNarratorId, "zh-CN");
		expect(zh).not.toBeNull();
		expect(zh).toContain("没有进行中的任务");
		expect(zh).toContain("还没有在 spec://tasks.json 建立任何任务");
		expect(zh).toContain("可以忽略本提醒");
	});

	test("shows the progress reminder (not a nudge) when there is an open task", async () => {
		await writeSpecFile(
			openTasksNarratorId,
			"spec://tasks.json",
			`${JSON.stringify({ tasks: [{ text: "Implement the parser", status: "doing" }] }, null, "\t")}\n`,
			{ actor: "agent", createdBy: "assistant" },
		);
		const en = await buildSpecToolResultReminder(openTasksNarratorId, "en");
		expect(en).not.toBeNull();
		expect(en).toContain("Implement the parser");
		expect(en).toContain("compiled from spec://tasks.json");
		// Must not be the empty-tasks nudge.
		expect(en).not.toContain("no active tasks");
		expect(en).not.toContain("have not created any task");
	});

	test("tells blocked tasks to create and execute an autonomous unblock task", async () => {
		await writeSpecFile(
			blockedTasksNarratorId,
			"spec://tasks.json",
			`${JSON.stringify({ tasks: [{ text: "Collect missing trace evidence", status: "blocked" }] }, null, "\t")}\n`,
			{ actor: "agent", createdBy: "assistant" },
		);

		const en = await buildSpecToolResultReminder(blockedTasksNarratorId, "en");
		expect(en).toContain("Collect missing trace evidence");
		expect(en).toContain("add a concrete actionable unblock task");
		expect(en).toContain("immediately use tools to execute it");

		const zh = await buildSpecToolResultReminder(blockedTasksNarratorId, "zh-CN");
		expect(zh).toContain("新增一个具体、可执行的解阻任务");
		expect(zh).toContain("立即调用工具执行");
	});

	test("nudges to refresh when all tasks are done", async () => {
		await writeSpecFile(
			allDoneTasksNarratorId,
			"spec://tasks.json",
			`${JSON.stringify({ tasks: [{ text: "Ship the feature", status: "done" }] }, null, "\t")}\n`,
			{ actor: "agent", createdBy: "assistant" },
		);
		const en = await buildSpecToolResultReminder(allDoneTasksNarratorId, "en");
		expect(en).not.toBeNull();
		expect(en).toContain("no active tasks");
		expect(en).toContain("All tasks are marked done");
		// The all-done branch should not use the "never created" phrasing.
		expect(en).not.toContain("have not created any task");

		const zh = await buildSpecToolResultReminder(allDoneTasksNarratorId, "zh-CN");
		expect(zh).not.toBeNull();
		expect(zh).toContain("任务已全部标记完成");
		expect(zh).toContain("可以忽略本提醒");
	});
});
