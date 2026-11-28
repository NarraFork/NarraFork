import { afterEach } from "bun:test";
import { db } from "@server/db";
import {
	narratorMessages,
	narrators,
	narratorToolCalls,
	scheduledTaskRuns,
	scheduledTasks,
	users,
} from "@server/db/schema";
import { eq } from "drizzle-orm";
import { setRunControl, tryClaimExecution } from "../../../../services/agent-runtime/ownership";
import {
	bindScheduledRunMember,
	registerScheduledRun,
	unregisterScheduledRun,
} from "../../../../services/scheduled-run-registry";
import { scheduledTaskService } from "../../../../services/scheduled-task-service";
import { generateId } from "../../../id";
import type { ToolContext } from "../../types";

const cleanup: (() => Promise<unknown> | undefined)[] = [];
afterEach(async () => {
	for (const remove of cleanup.splice(0).reverse()) await remove();
});

export function onScheduledTaskFixtureCleanup(remove: () => Promise<unknown>): void {
	cleanup.push(remove);
}

export async function caller(role: "admin" | "user" = "user") {
	const userId = generateId();
	const narratorId = generateId();
	const now = new Date().toISOString();
	await db.insert(users).values({
		id: userId,
		username: `scheduled-tool-${userId}`,
		role,
		passwordHash: "test",
		createdAt: now,
	});
	await db.insert(narrators).values({
		id: narratorId,
		title: "Trusted source session",
		cwd: process.cwd(),
		type: "primary",
		variant: "primary",
		ownerUserId: userId,
		traits: ["standalone"],
		permissionMode: "default",
		createdAt: now,
		updatedAt: now,
	});
	cleanup.push(async () => {
		await db.delete(narratorToolCalls).where(eq(narratorToolCalls.narratorId, narratorId));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId));
		await db.delete(narrators).where(eq(narrators.id, narratorId));
		await db.delete(scheduledTasks).where(eq(scheduledTasks.ownerUserId, userId));
		await db.delete(users).where(eq(users.id, userId));
	});
	const ctx: ToolContext = {
		userId,
		narratorId,
		cwd: process.cwd(),
		locale: "en",
		signal: new AbortController().signal,
		requestPermission: async () => ({ behavior: "allow" }),
	};
	return { ctx, userId, narratorId, principal: { userId, isAdmin: role === "admin" } };
}

export const dailyTask = {
	name: "Daily review",
	cronExpr: "0 9 * * *",
	timezone: "UTC",
	prompt: "PRIVATE_TASK_PROMPT",
	systemPrompt: "PRIVATE_SYSTEM_PROMPT",
};

export async function taskFor(fixture: Awaited<ReturnType<typeof caller>>) {
	return scheduledTaskService.create(
		{ ...dailyTask, cwd: fixture.ctx.cwd, permissionMode: "default", runContext: "standalone" },
		fixture.principal,
	);
}

export async function bindCall(ctx: ToolContext) {
	const messageId = generateId();
	const toolCallId = generateId();
	const toolUseId = generateId();
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: ctx.narratorId,
		role: "assistant",
		contentJson: [],
		createdAt: new Date().toISOString(),
	});
	await db.insert(narratorToolCalls).values({
		id: toolCallId,
		narratorId: ctx.narratorId,
		messageId,
		toolUseId,
		toolName: "ScheduledTask",
		createdAt: new Date().toISOString(),
	});
	ctx.toolCallBinding = { toolCallId, attempt: 1 };
	ctx.currentToolUseId = toolUseId;
	return { messageId, toolCallId, toolUseId };
}

export async function activeRun(fixture: Awaited<ReturnType<typeof caller>>, taskId: string) {
	const runId = generateId();
	const logicalRunId = generateId();
	const owner = tryClaimExecution(fixture.narratorId, "run");
	if (!owner) throw new Error("test narrator is already executing");
	setRunControl(owner, {
		startedAt: Date.now(),
		logicalRunId,
		cancel: new AbortController(),
		timedOut: false,
		terminal: new Promise(() => {}),
	});
	registerScheduledRun({
		runId,
		taskId,
		narratorId: fixture.narratorId,
		ownerUserId: fixture.userId,
		onBlocked: "auto",
		blockedWaitMinutes: 30,
		deadlineAt: null,
		permissionMode: "default",
		modelPolicy: "sync",
		model: null,
	});
	bindScheduledRunMember({ runId, narratorId: fixture.narratorId, logicalRunId });
	await db.insert(scheduledTaskRuns).values({
		id: runId,
		taskId,
		narratorId: fixture.narratorId,
		logicalRunId,
		status: "running",
		runContext: "standalone",
		createdAt: new Date().toISOString(),
	});
	cleanup.push(() => {
		unregisterScheduledRun(runId);
		setRunControl(owner, undefined);
		owner.release();
		return undefined;
	});
	return { runId, logicalRunId, owner };
}
