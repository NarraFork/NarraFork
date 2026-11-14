import { describe, expect, spyOn, test } from "bun:test";
import { db } from "@server/db";
import { users } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { scheduledTaskService } from "../../../../services/scheduled-task-service";
import { scheduledTaskAdminTool } from "../scheduled-task-admin";
import { resolveScheduledTaskApproval } from "../scheduled-task-policy";
import { caller, dailyTask, taskFor } from "./scheduled-task-fixtures";

describe("ScheduledTaskAdmin compatibility alias", () => {
	test("requires a live administrator for reads as well as mutations", async () => {
		const fixture = await caller();
		const task = await taskFor(fixture);
		for (const args of [
			{ action: "list" },
			{ action: "get", id: task.id },
			{ action: "runs", id: task.id },
			{ action: "preview", task: dailyTask },
			{ action: "create", ...dailyTask },
		]) {
			const result = await scheduledTaskAdminTool.execute(args, fixture.ctx);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("administrators");
		}
	});

	test("keeps the typed summary envelope and never exposes prompts in list", async () => {
		const fixture = await caller("admin");
		const task = await taskFor(fixture);
		const result = await scheduledTaskAdminTool.execute({ action: "list" }, fixture.ctx);
		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.output);
		expect(payload.tasks.some((row: { id: string }) => row.id === task.id)).toBe(true);
		expect(payload.truncated).toBe(false);
		expect(result.output).not.toContain("PRIVATE_TASK_PROMPT");
		expect(result.output).not.toContain("PRIVATE_SYSTEM_PROMPT");
	});

	test("accepts legacy flat create fields through the unified service", async () => {
		const fixture = await caller("admin");
		const approved = await resolveScheduledTaskApproval(
			fixture.ctx,
			{ action: "create", ...dailyTask },
			"ScheduledTaskAdmin",
		);
		const result = await scheduledTaskAdminTool.execute(approved.input, fixture.ctx);
		expect(result.isError).toBeFalsy();
		const task = JSON.parse(result.output);
		expect(task.ownerUserId).toBe(fixture.userId);
		expect(task.permissionMode).toBe("default");
	});

	test("demotion after approval cannot reuse the admin alias", async () => {
		const fixture = await caller("admin");
		const task = await taskFor(fixture);
		const approved = await resolveScheduledTaskApproval(
			fixture.ctx,
			{ action: "delete", id: task.id },
			"ScheduledTaskAdmin",
		);
		await db.update(users).set({ role: "user" }).where(eq(users.id, fixture.userId));
		const result = await scheduledTaskAdminTool.execute(approved.input, fixture.ctx);
		expect(result.isError).toBe(true);
		expect(await scheduledTaskService.get(task.id)).toBeDefined();
	});

	test("freezes toggle to a concrete reviewed enabled state", async () => {
		const fixture = await caller("admin");
		const task = await taskFor(fixture);
		const approved = await resolveScheduledTaskApproval(
			fixture.ctx,
			{ action: "toggle", id: task.id },
			"ScheduledTaskAdmin",
		);
		expect(approved.input.action).toBe("disable");
		const result = await scheduledTaskAdminTool.execute(approved.input, fixture.ctx);
		expect(result.isError).toBeFalsy();
		expect((await scheduledTaskService.get(task.id))?.enabled).toBe(false);
	});

	test("legacy run requests a manual dispatch with a checked principal, not success", async () => {
		const fixture = await caller("admin");
		const task = await taskFor(fixture);
		const run = spyOn(scheduledTaskService, "runTask").mockResolvedValue(undefined);
		try {
			const result = await scheduledTaskAdminTool.execute(
				{ action: "run", id: task.id },
				fixture.ctx,
			);
			expect(result.isError).toBeFalsy();
			expect(run).toHaveBeenCalledWith(task.id, {
				manual: true,
				principal: fixture.principal,
				expectedUpdatedAt: task.updatedAt,
			});
			expect(result.title).toContain("not task completion");
		} finally {
			run.mockRestore();
		}
	});
});
