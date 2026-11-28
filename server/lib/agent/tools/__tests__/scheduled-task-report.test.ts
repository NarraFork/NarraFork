import { describe, expect, test } from "bun:test";
import { db } from "@server/db";
import { scheduledTaskRuns } from "@server/db/schema";
import { eq } from "drizzle-orm";
import {
	isRuntimeToolAllowed,
	resolveRuntimePolicy,
} from "../../../../services/agent-runtime/policy";
import { getBuiltinRoutine, getBuiltinToolNames } from "../../../builtin-routines";
import { scheduledTaskReportTool } from "../scheduled-task-report";
import { activeRun, caller, taskFor } from "./scheduled-task-fixtures";

describe("ScheduledTaskReport", () => {
	test("is an optional report routine and a read-only ceiling exception", () => {
		const routine = getBuiltinRoutine("scheduled_task_report");
		expect(routine?.tool).toBeDefined();
		expect(routine?.defaultEnabled).toBeUndefined();
		if (!routine?.tool) throw new Error("Missing report routine");
		expect(getBuiltinToolNames(routine.tool)).toEqual(["ScheduledTaskReport"]);
		expect(
			isRuntimeToolAllowed(
				resolveRuntimePolicy([{ version: 1, readOnly: true }]),
				"ScheduledTaskReport",
			),
		).toBe(true);
	});

	test("refuses outside a trusted active execution", async () => {
		const fixture = await caller();
		const result = await scheduledTaskReportTool.execute(
			{ outcome: "done", summary: "Evidence" },
			fixture.ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("no active scheduled run");
	});

	test("rejects model-supplied task and run identifiers", async () => {
		const fixture = await caller();
		for (const extra of [{ taskId: "other" }, { runId: "other" }]) {
			const result = await scheduledTaskReportTool.execute(
				{ outcome: "done", summary: "Evidence", ...extra },
				fixture.ctx,
			);
			expect(result.isError).toBe(true);
		}
	});

	test("requires a nonempty bounded summary and a known outcome", async () => {
		const fixture = await caller();
		for (const input of [
			{ outcome: "done", summary: " " },
			{ outcome: "success", summary: "Evidence" },
			{ outcome: "blocked", summary: "x".repeat(2001) },
		])
			expect((await scheduledTaskReportTool.execute(input, fixture.ctx)).isError).toBe(true);
	});

	test("reports only the currently bound run, without claiming system completion", async () => {
		const fixture = await caller();
		const task = await taskFor(fixture);
		const { runId } = await activeRun(fixture, task.id);
		const result = await scheduledTaskReportTool.execute(
			{ outcome: "partial", summary: "Checked two of three targets" },
			fixture.ctx,
		);
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(result.output).runId).toBe(runId);
		const row = await db.query.scheduledTaskRuns.findFirst({
			where: eq(scheduledTaskRuns.id, runId),
		});
		expect(row).toMatchObject({
			status: "running",
			outcome: "partial",
			outcomeSummary: "Checked two of three targets",
			finishedAt: null,
		});
		await db
			.update(scheduledTaskRuns)
			.set({ status: "completed" })
			.where(eq(scheduledTaskRuns.id, runId));
		expect(
			(
				await scheduledTaskReportTool.execute(
					{ outcome: "done", summary: "Late report" },
					fixture.ctx,
				)
			).isError,
		).toBe(true);
	});

	test("a missing user cannot report even with a valid active run", async () => {
		const fixture = await caller();
		const task = await taskFor(fixture);
		await activeRun(fixture, task.id);
		expect(
			(
				await scheduledTaskReportTool.execute(
					{ outcome: "done", summary: "Evidence" },
					{ ...fixture.ctx, userId: null },
				)
			).isError,
		).toBe(true);
	});
});
