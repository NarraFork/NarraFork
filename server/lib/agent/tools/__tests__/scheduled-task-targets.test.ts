import { describe, expect, spyOn, test } from "bun:test";
import { db } from "@server/db";
import { aclGrants, narrators, projects, scheduledTasks } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { resolveRuntimePolicy } from "../../../../services/agent-runtime/policy";
import { resolvePermissionDecision } from "../../../../services/narrator-permission";
import { canWriteProject } from "../../../../services/project-acl";
import { scheduledTaskService } from "../../../../services/scheduled-task-service";
import { generateId } from "../../../id";
import { scheduledTaskTool } from "../scheduled-task";
import {
	assertScheduledTaskApprovalFresh,
	resolveScheduledTaskApproval,
} from "../scheduled-task-policy";
import { caller, dailyTask, onScheduledTaskFixtureCleanup } from "./scheduled-task-fixtures";

async function grantTarget(
	target: Awaited<ReturnType<typeof caller>>,
	grantee: Awaited<ReturnType<typeof caller>>,
	capability: "read" | "write",
) {
	const id = generateId();
	await db.insert(aclGrants).values({
		id,
		scopeType: "narrator",
		scopeId: target.narratorId,
		principalType: "user",
		principalId: grantee.userId,
		capability,
		grantedBy: target.userId,
		createdAt: new Date().toISOString(),
	});
	onScheduledTaskFixtureCleanup(async () => db.delete(aclGrants).where(eq(aclGrants.id, id)));
	return id;
}

function existingTask(targetNarratorId: string) {
	return { ...dailyTask, narratorMode: "existing" as const, targetNarratorId };
}

async function createExisting(
	fixture: Awaited<ReturnType<typeof caller>>,
	targetNarratorId = fixture.narratorId,
) {
	const approved = await resolveScheduledTaskApproval(fixture.ctx, {
		action: "create",
		task: existingTask(targetNarratorId),
	});
	const result = await scheduledTaskTool.execute(approved.input, fixture.ctx);
	expect(result.isError, result.output).toBeFalsy();
	const saved = await scheduledTaskService.get(JSON.parse(result.output).id);
	if (!saved) throw new Error("Missing created task");
	return saved;
}

describe("ScheduledTask existing target approval", () => {
	test("can target itself, preserves target scope and applies safe defaults", async () => {
		const fixture = await caller();
		fixture.ctx.cwd = "/caller-active-directory";
		await db
			.update(narrators)
			.set({
				cwd: "/target-working-directory",
				model: "target-model",
				systemPrompt: "PRIVATE_TARGET_SYSTEM_PROMPT",
			})
			.where(eq(narrators.id, fixture.narratorId));
		const approved = await resolveScheduledTaskApproval(fixture.ctx, {
			action: "create",
			task: {
				...existingTask(fixture.narratorId),
				cwd: "/untrusted-task-directory",
				projectId: "inaccessible-project",
				runContext: "project",
				permissionMode: "bypassPermissions",
			},
		});
		expect(approved.approval).toMatchObject({
			target: {
				id: fixture.narratorId,
				title: "Trusted source session",
				cwd: "/target-working-directory",
			},
			task: {
				cwd: "/target-working-directory",
				projectId: null,
				permissionMode: "default",
				model: "target-model",
				modelPolicy: "follow",
				contextPolicy: "keep",
				onBusy: "skip",
				busyWaitMinutes: 30,
				requireReport: true,
			},
			expectedTarget: { id: fixture.narratorId },
		});
		expect(typeof approved.approval.expectedTarget?.fingerprint).toBe("string");
		expect(approved.input.task).toMatchObject({
			cwd: null,
			projectId: null,
			runContext: "standalone",
			systemPrompt: null,
		});
		expect(approved.input.task).not.toHaveProperty("permissionMode");
		expect(approved.approval.inheritedFields).toEqual(
			expect.arrayContaining(["cwd", "projectId", "systemPrompt", "permissionMode", "model"]),
		);
		expect(JSON.stringify(approved.approval)).not.toContain("PRIVATE_TARGET_SYSTEM_PROMPT");
		const replay = await resolveScheduledTaskApproval(fixture.ctx, approved.input);
		expect(replay.approval.task).toEqual(approved.approval.task);
		expect(replay.approval.expectedTarget).toEqual(approved.approval.expectedTarget);
		assertScheduledTaskApprovalFresh(approved.input, replay.approval);
		const result = await scheduledTaskTool.execute(approved.input, fixture.ctx);
		expect(result.isError, result.output).toBeFalsy();
		expect(await scheduledTaskService.get(JSON.parse(result.output).id)).toMatchObject({
			ownerUserId: fixture.userId,
			narratorMode: "existing",
			targetNarratorId: fixture.narratorId,
			cwd: null,
			projectId: null,
			contextPolicy: "keep",
			onBusy: "skip",
			requireReport: true,
		});
	});

	test("a shared target needs session write, not ownership or project write", async () => {
		const fixture = await caller();
		const target = await caller();
		const projectId = generateId();
		const now = new Date().toISOString();
		await db.insert(projects).values({
			id: projectId,
			name: "Readable target project",
			ownerUserId: target.userId,
			visibility: "public",
			createdAt: now,
			updatedAt: now,
		});
		onScheduledTaskFixtureCleanup(async () => {
			await db
				.update(narrators)
				.set({ contextProjectId: null })
				.where(eq(narrators.contextProjectId, projectId));
			await db.delete(projects).where(eq(projects.id, projectId));
		});
		await db
			.update(narrators)
			.set({ contextProjectId: projectId, title: "Shared destination", cwd: "/shared-target" })
			.where(eq(narrators.id, target.narratorId));
		await grantTarget(target, fixture, "write");
		const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
		if (!project) throw new Error("Missing project fixture");
		expect(await canWriteProject(project, fixture.principal)).toBe(false);
		const approved = await resolveScheduledTaskApproval(fixture.ctx, {
			action: "create",
			task: existingTask(target.narratorId),
		});
		expect(approved.approval).toMatchObject({
			target: { id: target.narratorId, title: "Shared destination", projectId },
			task: { cwd: "/shared-target", projectId, runContext: "project" },
		});
		const result = await scheduledTaskTool.execute(approved.input, fixture.ctx);
		expect(result.isError, result.output).toBeFalsy();
		expect(await scheduledTaskService.get(JSON.parse(result.output).id)).toMatchObject({
			ownerUserId: fixture.userId,
			targetNarratorId: target.narratorId,
		});
	});

	test("read-only sharing cannot become a scheduled write", async () => {
		const fixture = await caller();
		const target = await caller();
		await grantTarget(target, fixture, "read");
		for (const id of [target.narratorId, "missing-target"]) {
			const result = await scheduledTaskTool.execute(
				{ action: "create", task: existingTask(id) },
				fixture.ctx,
			);
			expect(result.isError).toBe(true);
		}
		const missingId = await scheduledTaskTool.execute(
			{ action: "create", task: { ...dailyTask, narratorMode: "existing" } },
			fixture.ctx,
		);
		expect(missingId.output).toContain("targetNarratorId");
		expect((await scheduledTaskService.list(fixture.principal)).tasks).toHaveLength(0);
	});

	test("existing mode cannot bypass the caller's hard delegation ceiling", async () => {
		const fixture = await caller();
		fixture.ctx.runtimePolicy = resolveRuntimePolicy([
			{ version: 1, tools: ["Read", "ScheduledTask"] },
		]);
		const result = await scheduledTaskTool.execute(
			{ action: "create", task: existingTask(fixture.narratorId) },
			fixture.ctx,
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("hard capability");
	});

	test("ordinary target progress does not invalidate approval", async () => {
		const fixture = await caller();
		const approved = await resolveScheduledTaskApproval(fixture.ctx, {
			action: "create",
			task: existingTask(fixture.narratorId),
		});
		await db
			.update(narrators)
			.set({ updatedAt: "2099-01-01T00:00:00.000Z", status: "working" })
			.where(eq(narrators.id, fixture.narratorId));
		const live = await resolveScheduledTaskApproval(fixture.ctx, approved.input);
		expect(live.approval.expectedTarget).toEqual(approved.approval.expectedTarget);
		expect((await scheduledTaskTool.execute(approved.input, fixture.ctx)).isError).toBeFalsy();
	});

	test.each([
		{ title: "Unreviewed target name" },
		{ cwd: "/unreviewed-target-directory" },
		{ model: "unreviewed-model" },
		{ systemPrompt: "UNREVIEWED_SYSTEM_PROMPT" },
		{ permissionMode: "bypassPermissions" },
	])("target configuration changes invalidate approval: %j", async (change) => {
		const fixture = await caller();
		const target = await caller();
		await grantTarget(target, fixture, "write");
		const approved = await resolveScheduledTaskApproval(fixture.ctx, {
			action: "create",
			task: existingTask(target.narratorId),
		});
		await db.update(narrators).set(change).where(eq(narrators.id, target.narratorId));
		const result = await scheduledTaskTool.execute(approved.input, fixture.ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("since approval");
		expect((await scheduledTaskService.list(fixture.principal)).tasks).toHaveLength(0);
	});

	test("target access is checked again after the final authorization callback", async () => {
		const fixture = await caller();
		const target = await caller();
		const grantId = await grantTarget(target, fixture, "write");
		const approved = await resolveScheduledTaskApproval(fixture.ctx, {
			action: "create",
			task: existingTask(target.narratorId),
		});
		fixture.ctx.recheckAuthorization = async () => {
			await db.delete(aclGrants).where(eq(aclGrants.id, grantId));
		};
		const result = await scheduledTaskTool.execute(approved.input, fixture.ctx);
		expect(result.isError).toBe(true);
		expect((await scheduledTaskService.list(fixture.principal)).tasks).toHaveLength(0);
	});

	test("administrator execution still requires the task owner's target permission", async () => {
		const owner = await caller();
		const admin = await caller("admin");
		const target = await caller();
		const grantId = await grantTarget(target, owner, "write");
		const task = await createExisting(owner, target.narratorId);
		const approved = await resolveScheduledTaskApproval(admin.ctx, {
			action: "update",
			id: task.id,
			task: { name: "Reviewed by admin" },
		});
		await db.delete(aclGrants).where(eq(aclGrants.id, grantId));
		const result = await scheduledTaskTool.execute(approved.input, admin.ctx);
		expect(result.isError).toBe(true);
		expect((await scheduledTaskService.get(task.id))?.name).toBe(dailyTask.name);
	});

	test("transferring a task invalidates even an administrator's approval", async () => {
		const owner = await caller();
		const admin = await caller("admin");
		const target = await caller();
		await grantTarget(target, owner, "write");
		const task = await createExisting(owner, target.narratorId);
		const approved = await resolveScheduledTaskApproval(admin.ctx, {
			action: "update",
			id: task.id,
			task: { name: "Reviewed name" },
		});
		await db
			.update(scheduledTasks)
			.set({ ownerUserId: admin.userId })
			.where(eq(scheduledTasks.id, task.id));
		const result = await scheduledTaskTool.execute(approved.input, admin.ctx);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("since approval");
	});

	test("invalid targets may still be paused or deleted", async () => {
		const fixture = await caller();
		const target = await caller();
		await grantTarget(target, fixture, "write");
		const task = await createExisting(fixture, target.narratorId);
		await db
			.update(narrators)
			.set({ status: "archived" })
			.where(eq(narrators.id, target.narratorId));
		for (const action of ["enable", "run_now"]) {
			expect((await scheduledTaskTool.execute({ action, id: task.id }, fixture.ctx)).isError).toBe(
				true,
			);
		}
		for (const action of ["disable", "delete"]) {
			const approved = await resolveScheduledTaskApproval(fixture.ctx, { action, id: task.id });
			expect(approved.approval.expectedTarget).toBeNull();
			expect((await scheduledTaskTool.execute(approved.input, fixture.ctx)).isError).toBeFalsy();
		}
	});

	test("changing target or mode updates approval without requiring the previous target", async () => {
		const fixture = await caller();
		const previous = await caller();
		const grantId = await grantTarget(previous, fixture, "write");
		const task = await createExisting(fixture, previous.narratorId);
		await db.delete(aclGrants).where(eq(aclGrants.id, grantId));
		const approved = await resolveScheduledTaskApproval(fixture.ctx, {
			action: "update",
			id: task.id,
			task: {
				targetNarratorId: fixture.narratorId,
				contextPolicy: "clear",
				onBusy: "interrupt",
				requireReport: false,
			},
		});
		expect(approved.approval).toMatchObject({
			beforeTarget: null,
			target: { id: fixture.narratorId },
			task: { contextPolicy: "clear", onBusy: "interrupt", requireReport: false },
		});
		expect((await scheduledTaskTool.execute(approved.input, fixture.ctx)).isError).toBeFalsy();
		const newMode = await resolveScheduledTaskApproval(fixture.ctx, {
			action: "update",
			id: task.id,
			task: { narratorMode: "new" },
		});
		expect(newMode.input.task).toMatchObject({ narratorMode: "new", targetNarratorId: null });
		expect(newMode.approval.expectedTarget).toBeNull();
		expect((await scheduledTaskTool.execute(newMode.input, fixture.ctx)).isError).toBeFalsy();
	});

	test("forwards the approved target fingerprint into every dispatch-capable service gate", async () => {
		const fixture = await caller();
		const task = await createExisting(fixture);
		const create = spyOn(scheduledTaskService, "create").mockResolvedValue(task);
		const update = spyOn(scheduledTaskService, "update").mockResolvedValue(task);
		const toggle = spyOn(scheduledTaskService, "setEnabled").mockResolvedValue(task);
		const run = spyOn(scheduledTaskService, "runTask").mockResolvedValue(undefined);
		try {
			for (const action of ["create", "update", "enable", "run_now"]) {
				const approved = await resolveScheduledTaskApproval(fixture.ctx, {
					action,
					...(action === "create" ? { task: existingTask(fixture.narratorId) } : { id: task.id }),
					...(action === "update" ? { task: { name: "Reviewed name" } } : {}),
				});
				expect((await scheduledTaskTool.execute(approved.input, fixture.ctx)).isError).toBeFalsy();
				const callOptions =
					action === "create"
						? create.mock.calls[0]?.[3]
						: action === "update"
							? update.mock.calls[0]?.[4]
							: action === "enable"
								? toggle.mock.calls[0]?.[3]
								: run.mock.calls[0]?.[1];
				expect(callOptions).toMatchObject({ expectedTarget: approved.approval.expectedTarget });
			}
		} finally {
			create.mockRestore();
			update.mockRestore();
			toggle.mockRestore();
			run.mockRestore();
		}
	});
});

describe("ScheduledTask writable target discovery", () => {
	test("is a read action without granting mutation authority", () => {
		for (const permMode of ["readOnly", "dontAsk", "bypassPermissions"] as const) {
			expect(
				resolvePermissionDecision({
					toolName: "ScheduledTask",
					input: { action: "targets" },
					permMode,
					cwd: process.cwd(),
				}),
			).toBe("allow");
		}
	});

	test("lists writable sessions with bounded cursor pages and no prompt leakage", async () => {
		const fixture = await caller();
		const writable = await caller();
		const readable = await caller();
		const q = `target-discovery-${generateId()}`;
		await grantTarget(writable, fixture, "write");
		await grantTarget(readable, fixture, "read");
		for (const session of [fixture, writable, readable]) {
			await db
				.update(narrators)
				.set({ title: `${q}-${session.narratorId}`, systemPrompt: "PRIVATE_TARGET_SYSTEM_PROMPT" })
				.where(eq(narrators.id, session.narratorId));
		}
		const first = await scheduledTaskTool.execute({ action: "targets", q, limit: 1 }, fixture.ctx);
		expect(first.isError, first.output).toBeFalsy();
		const page = JSON.parse(first.output);
		expect(page.items).toHaveLength(1);
		expect(page.nextCursor).toEqual(expect.any(String));
		const second = await scheduledTaskTool.execute(
			{ action: "targets", q, limit: 1, cursor: page.nextCursor },
			fixture.ctx,
		);
		expect(second.isError).toBeFalsy();
		const next = JSON.parse(second.output);
		expect(new Set([...page.items, ...next.items].map((item: { id: string }) => item.id))).toEqual(
			new Set([fixture.narratorId, writable.narratorId]),
		);
		expect(next.nextCursor).toBeNull();
		expect(first.output + second.output).not.toContain(readable.narratorId);
		expect(first.output + second.output).not.toContain("PRIVATE_TARGET_SYSTEM_PROMPT");
	});
});
