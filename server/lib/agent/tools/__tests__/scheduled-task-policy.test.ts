import { describe, expect, spyOn, test } from "bun:test";
import { db } from "@server/db";
import { narratorBlacklistDirs, narrators, scheduledTasks, users } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { setRunControl } from "../../../../services/agent-runtime/ownership";
import { resolveRuntimePolicy } from "../../../../services/agent-runtime/policy";
import { resolvePermissionDecision } from "../../../../services/narrator-permission";
import { scheduledTaskService } from "../../../../services/scheduled-task-service";
import { generateId } from "../../../id";
import { getHome } from "../../../platform";
import { scheduledTaskTool } from "../scheduled-task";
import {
	assertScheduledTaskApprovalFresh,
	expandsScheduledTaskPermission,
	previewScheduledTask,
	resolveScheduledTaskApproval,
} from "../scheduled-task-policy";
import { activeRun, bindCall, caller, dailyTask, taskFor } from "./scheduled-task-fixtures";

describe("ScheduledTask trusted policy and provenance", () => {
	test("requires a real current user, not model-supplied owner or admin flags", async () => {
		const fixture = await caller();
		for (const userId of [null, undefined, "deleted-user"]) {
			const result = await scheduledTaskTool.execute(
				{ action: "list", userId: fixture.userId, isAdmin: true },
				{ ...fixture.ctx, userId },
			);
			expect(result.isError).toBe(true);
		}
	});

	test("creation inherits scope and soft permission, and ignores forged provenance", async () => {
		const fixture = await caller();
		const binding = await bindCall(fixture.ctx);
		const approved = await resolveScheduledTaskApproval(fixture.ctx, {
			action: "create",
			task: {
				...dailyTask,
				ownerUserId: "forged-owner",
				createdBy: "forged-user",
				creatorNarratorId: "forged-narrator",
				creatorMessageId: "forged-message",
			},
			provenance: { kind: "user", narratorId: "forged-narrator" },
		});
		expect(approved.approval).toMatchObject({
			elevated: false,
			outsideScope: false,
			task: { cwd: fixture.ctx.cwd, permissionMode: "default", timezone: "UTC" },
		});
		const result = await scheduledTaskTool.execute(approved.input, fixture.ctx);
		expect(result.isError).toBeFalsy();
		const saved = await scheduledTaskService.get(JSON.parse(result.output).id);
		expect(saved).toMatchObject({
			ownerUserId: fixture.userId,
			createdBy: fixture.userId,
			creatorKind: "narrator",
			creatorNarratorId: fixture.narratorId,
			creatorMessageId: binding.messageId,
			creatorToolCallId: binding.toolCallId,
			creatorToolUseId: binding.toolUseId,
			creatorSnapshot: { narratorTitle: "Trusted source session" },
		});
	});

	test("call binding cannot attach another narrator's message", async () => {
		const fixture = await caller();
		const other = await caller();
		const foreign = await bindCall(other.ctx);
		fixture.ctx.toolCallBinding = { toolCallId: foreign.toolCallId, attempt: 1 };
		const result = await scheduledTaskTool.execute(
			{ action: "create", task: dailyTask },
			fixture.ctx,
		);
		expect(result.isError).toBeFalsy();
		const saved = await scheduledTaskService.get(JSON.parse(result.output).id);
		expect(saved?.creatorMessageId).toBeNull();
		expect(saved?.creatorToolCallId).toBeNull();
	});

	test("soft expansion and scope changes are explicitly marked in the approval", async () => {
		const fixture = await caller();
		const approval = await resolveScheduledTaskApproval(fixture.ctx, {
			action: "create",
			task: { ...dailyTask, permissionMode: "bypassPermissions", cwd: "/other-directory" },
		});
		expect(approval.approval).toMatchObject({
			elevated: true,
			outsideScope: true,
			task: { permissionMode: "bypassPermissions", cwd: "/other-directory" },
		});
		expect(expandsScheduledTaskPermission("dontAsk", "default")).toBe(true);
		expect(expandsScheduledTaskPermission("acceptEdits", "default")).toBe(false);
	});

	test.each([
		"readOnly",
		"dontAsk",
	])("%s cannot create or mutate scheduled tasks", async (permissionMode) => {
		const fixture = await caller();
		const task = await taskFor(fixture);
		await db.update(narrators).set({ permissionMode }).where(eq(narrators.id, fixture.narratorId));
		for (const input of [
			{ action: "create", task: dailyTask },
			{ action: "disable", id: task.id },
		]) {
			const result = await scheduledTaskTool.execute(input, fixture.ctx);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("mutations are denied");
		}
	});

	test("hard runtime ceilings cannot be laundered through a future task", async () => {
		const fixture = await caller();
		fixture.ctx.runtimePolicy = resolveRuntimePolicy([
			{ version: 1, tools: ["Read", "ScheduledTask"] },
		]);
		const result = await scheduledTaskTool.execute(
			{ action: "create", task: { ...dailyTask, permissionMode: "bypassPermissions" } },
			fixture.ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("hard capability");
	});

	test.each([
		`custom-disabled-tools:${Buffer.from(JSON.stringify({ version: 1, tools: ["Write"] })).toString("base64url")}`,
		`custom-blocked-skills:${Buffer.from(JSON.stringify({ version: 1, all: true, names: [] })).toString("base64url")}`,
	])("custom ceiling %s cannot be dropped by delegation", async (trait) => {
		const fixture = await caller();
		await db
			.update(narrators)
			.set({ traits: ["standalone", trait] })
			.where(eq(narrators.id, fixture.narratorId));
		const result = await scheduledTaskTool.execute(
			{ action: "create", task: dailyTask },
			fixture.ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("hard capability");
	});

	test("OAuth/device restrictions fail closed instead of creating local unbounded authority", async () => {
		const fixture = await caller();
		await db
			.update(narrators)
			.set({ oauthPolicySnapshotJson: {} })
			.where(eq(narrators.id, fixture.narratorId));
		const result = await scheduledTaskTool.execute(
			{ action: "create", task: dailyTask },
			fixture.ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("hard capability");
	});

	test("a different owner cannot discover or mutate a private task", async () => {
		const owner = await caller();
		const other = await caller();
		const task = await taskFor(owner);
		const listing = await scheduledTaskTool.execute({ action: "list" }, other.ctx);
		expect(listing.isError).toBeFalsy();
		expect(listing.output).not.toContain(task.id);
		for (const action of ["get", "runs", "disable", "delete", "run_now"]) {
			const result = await scheduledTaskTool.execute({ action, id: task.id }, other.ctx);
			expect(result.isError).toBe(true);
		}
	});

	test("permission changes and owner transfers after approval invalidate execution", async () => {
		const fixture = await caller();
		const other = await caller();
		const task = await taskFor(fixture);
		const approved = await resolveScheduledTaskApproval(fixture.ctx, {
			action: "update",
			id: task.id,
			task: { name: "Changed" },
		});
		await db
			.update(scheduledTasks)
			.set({ ownerUserId: other.userId })
			.where(eq(scheduledTasks.id, task.id));
		expect((await scheduledTaskTool.execute(approved.input, fixture.ctx)).isError).toBe(true);
		await db
			.update(scheduledTasks)
			.set({ ownerUserId: fixture.userId })
			.where(eq(scheduledTasks.id, task.id));
		await db
			.update(narrators)
			.set({ permissionMode: "readOnly" })
			.where(eq(narrators.id, fixture.narratorId));
		expect((await scheduledTaskTool.execute(approved.input, fixture.ctx)).isError).toBe(true);
		expect((await scheduledTaskService.get(task.id))?.name).toBe(dailyTask.name);
	});

	test("a changed task cannot silently consume a stale approval", async () => {
		const fixture = await caller();
		const task = await taskFor(fixture);
		const approved = await resolveScheduledTaskApproval(fixture.ctx, {
			action: "update",
			id: task.id,
			task: { name: "Approved name" },
		});
		await db
			.update(scheduledTasks)
			.set({ prompt: "NEW_UNREVIEWED_PROMPT" })
			.where(eq(scheduledTasks.id, task.id));
		const result = await scheduledTaskTool.execute(approved.input, fixture.ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("since approval");
		expect(() =>
			assertScheduledTaskApprovalFresh(
				{ _scheduledTaskApproval: { task: {}, expectedUpdatedAt: "old" } },
				{ task: {}, expectedUpdatedAt: "new" },
			),
		).toThrow("since approval");
	});

	test("live role is rechecked by service after the final authorization callback", async () => {
		const fixture = await caller("admin");
		const owner = await caller();
		const task = await taskFor(owner);
		fixture.ctx.recheckAuthorization = async () => {
			await db.update(users).set({ role: "user" }).where(eq(users.id, fixture.userId));
		};
		const result = await scheduledTaskTool.execute({ action: "delete", id: task.id }, fixture.ctx);
		expect(result.isError).toBe(true);
		expect(await scheduledTaskService.get(task.id)).toBeDefined();
	});

	test("active runs can only read or disable themselves; a later manual turn is not trapped", async () => {
		const fixture = await caller();
		const own = await taskFor(fixture);
		const another = await taskFor(fixture);
		const { owner } = await activeRun(fixture, own.id);
		for (const input of [
			{ action: "create", task: dailyTask },
			{ action: "list" },
			{ action: "get", id: another.id },
			{ action: "delete", id: own.id },
			{ action: "enable", id: own.id },
		]) {
			const result = await scheduledTaskTool.execute(input, fixture.ctx);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("active scheduled run");
		}
		for (const action of ["get", "runs", "disable"])
			expect(
				(await scheduledTaskTool.execute({ action, id: own.id }, fixture.ctx)).isError,
			).toBeFalsy();
		setRunControl(owner, {
			startedAt: Date.now(),
			logicalRunId: "manual-turn",
			cancel: new AbortController(),
			timedOut: false,
			terminal: new Promise(() => {}),
		});
		expect((await scheduledTaskTool.execute({ action: "list" }, fixture.ctx)).isError).toBeFalsy();
	});

	test("all mutations need a fresh session approval even in bypass mode", () => {
		for (const toolName of ["ScheduledTask", "ScheduledTaskAdmin"]) {
			for (const action of [
				"create",
				"update",
				"enable",
				"disable",
				"delete",
				"run_now",
				"unknown_action",
			]) {
				expect(
					resolvePermissionDecision({
						toolName,
						input: { action },
						permMode: "bypassPermissions",
						cwd: process.cwd(),
					}),
				).toBe("ask");
				for (const permMode of ["readOnly", "dontAsk"] as const)
					expect(
						resolvePermissionDecision({
							toolName,
							input: { action },
							permMode,
							cwd: process.cwd(),
						}),
					).toBe("deny");
			}
			expect(
				resolvePermissionDecision({
					toolName,
					input: { action: "preview" },
					permMode: "readOnly",
					cwd: process.cwd(),
				}),
			).toBe("allow");
		}
	});

	test("narrator deny rules cannot be erased by scheduling a fresh session", async () => {
		const fixture = await caller();
		await db.insert(narratorBlacklistDirs).values({
			id: generateId(),
			narratorId: fixture.narratorId,
			path: "/secrets",
			pathFlavor: "posix",
			denyLevel: "denyAll",
			createdAt: new Date().toISOString(),
		});
		const result = await scheduledTaskTool.execute(
			{ action: "create", task: dailyTask },
			fixture.ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("deny rules");
	});

	test("soft permission narrowing during the final recheck requires renewed review", async () => {
		const fixture = await caller();
		await db
			.update(narrators)
			.set({ permissionMode: "bypassPermissions" })
			.where(eq(narrators.id, fixture.narratorId));
		const approved = await resolveScheduledTaskApproval(fixture.ctx, {
			action: "create",
			task: dailyTask,
		});
		expect(approved.approval.elevated).toBe(false);
		fixture.ctx.recheckAuthorization = async () => {
			await db
				.update(narrators)
				.set({ permissionMode: "default" })
				.where(eq(narrators.id, fixture.narratorId));
		};
		const result = await scheduledTaskTool.execute(approved.input, fixture.ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("since approval");
		expect((await scheduledTaskService.list(fixture.principal)).tasks).toHaveLength(0);
	});

	test("legacy null cwd approval displays actual fallback, not the caller's directory", async () => {
		const fixture = await caller();
		const task = await taskFor(fixture);
		await db.update(scheduledTasks).set({ cwd: null }).where(eq(scheduledTasks.id, task.id));
		const approved = await resolveScheduledTaskApproval(fixture.ctx, {
			action: "disable",
			id: task.id,
		});
		expect(approved.approval.task).toMatchObject({ cwd: getHome(), enabled: false });
		expect(approved.approval.outsideScope).toBe(true);
	});

	test("passes the approved row version into every mutating service gate", async () => {
		const fixture = await caller();
		const task = await taskFor(fixture);
		const update = spyOn(scheduledTaskService, "update").mockResolvedValue(task);
		const toggle = spyOn(scheduledTaskService, "setEnabled").mockResolvedValue(task);
		const remove = spyOn(scheduledTaskService, "delete").mockResolvedValue(undefined);
		const run = spyOn(scheduledTaskService, "runTask").mockResolvedValue(undefined);
		try {
			for (const action of ["update", "enable", "disable", "delete", "run_now"]) {
				const approved = await resolveScheduledTaskApproval(fixture.ctx, {
					action,
					id: task.id,
					...(action === "update" ? { task: { name: "Reviewed name" } } : {}),
				});
				expect((await scheduledTaskTool.execute(approved.input, fixture.ctx)).isError).toBeFalsy();
			}
			const version = { expectedUpdatedAt: task.updatedAt };
			expect(update.mock.calls[0]?.[4]).toEqual(version);
			expect(toggle.mock.calls[0]?.[3]).toEqual(version);
			expect(toggle.mock.calls[1]?.[3]).toEqual(version);
			expect(remove.mock.calls[0]?.[2]).toEqual(version);
			expect(run.mock.calls[0]?.[1]).toMatchObject(version);
		} finally {
			update.mockRestore();
			toggle.mockRestore();
			remove.mockRestore();
			run.mockRestore();
		}
	});

	test("finite previews expose timezone, count and every upcoming occurrence", () => {
		const preview = previewScheduledTask({
			schedule: { kind: "cron", expr: "0 9 * * *", end: { type: "count", count: 2 } },
			timezone: "UTC",
		});
		expect(preview.timezone).toBe("UTC");
		expect(preview.finite).toBe(true);
		expect(preview.occurrences).toHaveLength(2);
		expect(preview.description).toContain("2");
	});
});
