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
import {
	buildBehaviorFenceReminder,
	buildSpecToolResultReminder,
	SPEC_TASKS_REORGANIZE_THRESHOLD,
} from "../spec-reminder";
import { writeSpecFile } from "../spec-vfs-service";

let emptyFenceNarratorId: string;
let filledFenceNarratorId: string;
let neverCreatedTasksNarratorId: string;
let openTasksNarratorId: string;
let blockedTasksNarratorId: string;
let allDoneTasksNarratorId: string;
let tooManyTasksNarratorId: string;

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
	tooManyTasksNarratorId = generateId();
	await createNarrator(emptyFenceNarratorId);
	await createNarrator(filledFenceNarratorId);
	await createNarrator(neverCreatedTasksNarratorId);
	await createNarrator(openTasksNarratorId);
	await createNarrator(blockedTasksNarratorId);
	await createNarrator(allDoneTasksNarratorId);
	await createNarrator(tooManyTasksNarratorId);
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
		expect(en).toContain("no open tasks");
		expect(en).toContain("spec://tasks.json");
		// Keeps the escape hatch for simple work.
		expect(en).toContain("Simple work needs no list");

		const zh = await buildSpecToolResultReminder(neverCreatedTasksNarratorId, "zh-CN");
		expect(zh).not.toBeNull();
		expect(zh).toContain("没有开放任务");
		expect(zh).toContain("请在 spec://tasks.json 建立任务清单");
		expect(zh).toContain("可忽略本提醒");
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
		// The digest shows at most 4 selected tasks, so the heading must say it is an
		// excerpt — otherwise a model reads it as the whole file and "restores" the
		// entries it thinks it lost by overwriting tasks.json with just these lines.
		expect(en).toContain("excerpt of open tasks");
		expect(en).toContain("not the full list");
		expect(en).toContain("do not rewrite the file from this excerpt");
		// Must not be the empty-tasks or oversized-list nudge.
		expect(en).not.toContain("no open tasks");
		expect(en).not.toContain("Multi-step work?");
		expect(en).not.toContain("over the");

		const zh = await buildSpecToolResultReminder(openTasksNarratorId, "zh-CN");
		expect(zh).toContain("Dynamic Spec 当前任务节选");
		expect(zh).toContain("非完整列表");
		expect(zh).toContain("状态有变化就更新 spec://tasks.json");
		expect(zh).toContain("不要按本节选重写整个文件");
	});

	// ⚠️ The cadence digest is injected mid-turn, so it must NOT carry the rules the
	// system prompt already states on every request. This is the regression guard for
	// that: the digest reports state, `getDynamicSpecSystemReminder` teaches the rules.
	test("stays short: a blocked task is reported without restating the blocked-task rule", async () => {
		await writeSpecFile(
			blockedTasksNarratorId,
			"spec://tasks.json",
			`${JSON.stringify({ tasks: [{ text: "Collect missing trace evidence", status: "blocked" }] }, null, "\t")}\n`,
			{ actor: "agent", createdBy: "assistant" },
		);

		const en = await buildSpecToolResultReminder(blockedTasksNarratorId, "en");
		expect(en).toContain("Collect missing trace evidence");
		expect(en).toContain("- blocked:");
		// The full rule lives in the system prompt (see prompts/system-reminders.ts).
		expect(en).not.toContain("Blocked-task rule");
		expect(en).not.toContain("unblock task");
		expect(en).not.toContain("text/status/protected");
		// heading + one task + one update line.
		expect(en?.split("\n")).toHaveLength(3);

		const zh = await buildSpecToolResultReminder(blockedTasksNarratorId, "zh-CN");
		expect(zh).toContain("Collect missing trace evidence");
		expect(zh).not.toContain("blocked 任务处理规则");
		expect(zh?.split("\n")).toHaveLength(3);
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
		expect(en).toContain("no open tasks");
		expect(en).toContain("Previous phase is done");
		expect(en).toContain("Reorganize spec://tasks.json");
		// The all-done branch should not use the "never created" phrasing.
		expect(en).not.toContain("Multi-step work?");

		const zh = await buildSpecToolResultReminder(allDoneTasksNarratorId, "zh-CN");
		expect(zh).not.toBeNull();
		expect(zh).toContain("上一阶段已完成");
		expect(zh).toContain("整理 spec://tasks.json");
	});

	test("asks to reorganize when the task count exceeds the threshold", async () => {
		const tasks = Array.from({ length: SPEC_TASKS_REORGANIZE_THRESHOLD + 1 }, (_, index) => ({
			text: `Task ${index + 1}`,
			status: index === 0 ? "doing" : "todo",
		}));
		await writeSpecFile(
			tooManyTasksNarratorId,
			"spec://tasks.json",
			`${JSON.stringify({ tasks }, null, "\t")}\n`,
			{ actor: "agent", createdBy: "assistant" },
		);

		const en = await buildSpecToolResultReminder(tooManyTasksNarratorId, "en");
		expect(en).not.toBeNull();
		expect(en).toContain(`over the ${SPEC_TASKS_REORGANIZE_THRESHOLD} threshold`);
		expect(en).toContain("merge duplicates");
		expect(en).toContain("Preserve protected-task intent");
		// heading + one action line: the reorganize nudge is two lines, not six.
		expect(en?.split("\n")).toHaveLength(2);

		const zh = await buildSpecToolResultReminder(tooManyTasksNarratorId, "zh-CN");
		expect(zh).not.toBeNull();
		expect(zh).toContain(`超过 ${SPEC_TASKS_REORGANIZE_THRESHOLD} 条`);
		expect(zh).toContain("合并重复项");
	});
});
