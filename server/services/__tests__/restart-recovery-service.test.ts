import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFile, unlink } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { testEnvironment } from "../../../tests/preload";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	backgroundTasks,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import { getNarraforkPath } from "../../lib/narrafork-home";

// Keep all recovery classification, conditional result writes, and continuation claims real.
// Only the boundaries that would launch a tool/model are replaced below.
const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
// Initialize the service first to avoid its persistence facade's circular import.
await import("../narrator-service");
const recovery = await import("../restart-recovery-service");
const { toolContinuationService } = await import("../tool-continuation-service");
const { narratorPersistence } = await import("../narrator-persistence");
const coordinator = await import("../update-coordinator");
const session = await import("../narrator-session");
const subagentResume = await import("../subagent-resume");
const now = "2026-10-07T00:00:00.000Z";
const backgroundStartOutput =
	'<background_task_id>helper</background_task_id>\n\nBackground task started. Await({ type: "agent", id: "helper" })';
const originalArgs = [...process.argv];
const resumed: Array<Parameters<typeof subagentResume.resumeSubagent>[0]> = [];
const continued: string[] = [];
let executedTools = 0;

function emptyProtection() {
	return {
		narratorIds: new Set<string>(),
		toolCallIds: new Set<string>(),
		backgroundTaskIds: new Set<string>(),
	};
}

async function seedNarrator(id: string, values: Partial<typeof narrators.$inferInsert> = {}) {
	await db.insert(narrators).values({
		id,
		variant: "subagent:general",
		type: "subagent",
		status: "working",
		logicalRunId: `run-${id}`,
		createdAt: now,
		updatedAt: now,
		...values,
	});
}

async function seedTool(
	id: string,
	narratorId: string,
	values: Partial<typeof narratorToolCalls.$inferInsert> = {},
) {
	const messageId = `message-${id}`;
	const toolUseId = `use-${id}`;
	const toolName = values.toolName ?? "Bash";
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: toolUseId, name: toolName, input: {} }],
		createdAt: now,
	});
	const refs = await db.query.narratorMessageRefs.findMany({
		where: eq(narratorMessageRefs.narratorId, narratorId),
	});
	await db.insert(narratorMessageRefs).values({
		id: `ref-${id}`,
		narratorId,
		messageId,
		seq: refs.length,
	});
	await db.insert(narratorToolCalls).values({
		id,
		narratorId,
		messageId,
		toolUseId,
		toolName,
		inputJson: {},
		executionIdentityVersion: 1,
		status: "running",
		createdAt: now,
		...values,
	});
}

async function seedAgent(background = false) {
	await seedNarrator("parent", {
		variant: "primary",
		type: "primary",
		status: "waiting",
		substatus: JSON.stringify(["awaiting_subagent"]),
	});
	await seedTool("agent-call", "parent", {
		toolName: "Agent",
		executionStartedAt: now,
		...(background ? { status: "success", outputJson: backgroundStartOutput } : {}),
	});
	await seedNarrator("child", {
		parentNarratorId: "parent",
		originToolCallId: "agent-call",
	});
	if (background) {
		await db.insert(backgroundTasks).values({
			id: "background-child",
			parentNarratorId: "parent",
			subagentNarratorId: "child",
			type: "agent",
			status: "running",
			toolCallId: "agent-call",
			logicalRunId: "run-child",
			alias: "helper",
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		});
	}
}

async function tool(id: string) {
	return db.query.narratorToolCalls.findFirst({ where: eq(narratorToolCalls.id, id) });
}

beforeEach(async () => {
	cleanDb(sqlite);
	recovery.resetRestartRecoveryForTests();
	coordinator.resetUpdateCoordinationForTests();
	process.argv = originalArgs.filter((arg) => arg !== recovery.NO_AUTO_RESUME_FLAG);
	resumed.length = 0;
	continued.length = 0;
	executedTools = 0;
	await unlink(getNarraforkPath("restart-recovery.json")).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
	spyOn(subagentResume, "resumeSubagent").mockImplementation(async (input) => {
		resumed.push(input);
		// Simulate the resume/model boundary completing the existing Agent call, not a new run.
		const child = await db.query.narrators.findFirst({
			where: eq(narrators.id, input.subagentId),
		});
		if (child?.originToolCallId && !input.preserveBackground && !input.skipConclusionDelivery) {
			const origin = await tool(child.originToolCallId);
			if (origin) {
				await narratorPersistence.updateToolCallResultIfActive(
					origin.toolUseId,
					{ status: "success", output: "Recovered child result", completedAt: Date.now() },
					origin.messageId,
					origin.id,
				);
			}
		}
		return {
			started: true,
			terminalCompletion: Promise.resolve("Recovered child result"),
		} as never;
	});
	spyOn(session, "continueNarrator").mockImplementation(async (id) => {
		continued.push(id);
		return { ok: true } as never;
	});
	spyOn(session, "executePersistedToolCall").mockImplementation(async () => {
		executedTools++;
		throw new Error("Unexpected tool execution in restart recovery test");
	});
	spyOn(session, "resumeBufferedMessagesIfIdle").mockResolvedValue(undefined as never);
});

afterEach(() => {
	process.argv = [...originalArgs];
	coordinator.resetUpdateCoordinationForTests();
	mock.restore();
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	cleanDb(sqlite);
	sqlite.close();
});

describe("ordinary restart eligibility and tool disposition", () => {
	test("preload isolates all manifests from the user's data", () => {
		expect(process.env.NARRAFORK_HOME).toBe(testEnvironment.narraforkHome);
		expect(process.env.NARRAFORK_HOME).not.toBe(testEnvironment.realNarraforkHome);
	});

	test("automatic resume is enabled unless the exact opt-out flag is present", () => {
		expect(recovery.automaticResumeEnabled([])).toBe(true);
		expect(recovery.automaticResumeEnabled(["bun", "--no-auto-resume"])).toBe(false);
		expect(recovery.automaticResumeEnabled(["--no-auto-resume=false"])).toBe(true);
	});

	test("only active non-severed runs are eligible", () => {
		for (const status of ["working", "waiting"]) {
			expect(recovery.restartEligible({ status, substatus: null })).toBe(true);
			for (const tag of ["taken_over", "manual_override", "cancelled", "error"]) {
				expect(recovery.restartEligible({ status, substatus: JSON.stringify([tag]) })).toBe(false);
			}
		}
		for (const status of ["idle", "archived"]) {
			expect(recovery.restartEligible({ status, substatus: null })).toBe(false);
		}
	});

	test("terminal results win; execution evidence never becomes permission to retry", () => {
		const row = { status: "running", executionStartedAt: null, fileChangeOperationId: null };
		expect(recovery.restartToolDisposition(row)).toBe("deferred");
		expect(recovery.restartToolDisposition({ ...row, status: "pending" })).toBe("permission");
		expect(recovery.restartToolDisposition({ ...row, executionStartedAt: now })).toBe(
			"execution_unknown",
		);
		expect(recovery.restartToolDisposition({ ...row, fileChangeOperationId: "operation" })).toBe(
			"execution_unknown",
		);
		for (const status of ["success", "fail"]) {
			expect(recovery.restartToolDisposition({ ...row, status, executionStartedAt: now })).toBe(
				"terminal",
			);
		}
	});
});

describe("ordinary restart with real persisted recovery records", () => {
	test("active foreground child resumes its logical run and settles its parent exactly once", async () => {
		await seedAgent();
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.protection.narratorIds).toEqual(new Set(["parent", "child"]));
		expect(prepared.protection.toolCallIds.has("agent-call")).toBe(true);
		const record = await toolContinuationService.getByToolCallId("agent-call");
		expect(record?.kind).toBe("foreground_agent");
		expect(record?.payloadJson?.logicalRunId).toBe("run-child");
		const handle = await recovery.restoreOrdinaryRestartRecovery(prepared);
		expect(handle).not.toBeNull();
		await handle?.completion;
		expect(resumed.map((input) => input.subagentId)).toEqual(["child"]);
		expect(resumed[0]?.resumeLogicalRunId).toBe("run-child");
		expect(continued).toEqual(["parent"]);
		expect((await tool("agent-call"))?.status).toBe("success");
		expect(executedTools).toBe(0);
		const repeated = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(repeated.manifest).toBeNull();
		expect(await recovery.restoreOrdinaryRestartRecovery(repeated)).toBeNull();
		expect(resumed).toHaveLength(1);
	});

	test("background Agent preserves its existing task and does not rerun the parent", async () => {
		await seedAgent(true);
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.protection.backgroundTaskIds).toEqual(new Set(["background-child"]));
		const record = await toolContinuationService.getByToolCallId("agent-call");
		expect(record?.kind).toBe("background_agent");
		expect(record?.payloadJson?.backgroundTaskId).toBe("background-child");
		await (await recovery.restoreOrdinaryRestartRecovery(prepared))?.completion;
		expect(resumed).toHaveLength(1);
		expect(resumed[0]?.preserveBackground).toBe(true);
		expect(resumed[0]?.skipConclusionDelivery).toBe(true);
		expect(continued).toEqual([]);
		expect((await db.select().from(backgroundTasks)).map((row) => row.id)).toEqual([
			"background-child",
		]);
		expect((await tool("agent-call"))?.outputJson).toBe(backgroundStartOutput);
		expect(executedTools).toBe(0);
	});

	test("a started side-effect tool gets an explicit unknown result without being executed", async () => {
		await seedNarrator("standalone");
		await seedTool("started-write", "standalone", { toolName: "Write", executionStartedAt: now });
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		const repaired = await tool("started-write");
		expect(repaired?.status).toBe("fail");
		expect(repaired?.outputJson).toBe(recovery.RESTART_EXECUTION_UNKNOWN);
		expect(repaired?.errorMessage).toContain("not automatically retried");
		expect(repaired?.completedAt).not.toBeNull();
		expect(await toolContinuationService.getByToolCallId("started-write")).toBeNull();
		await (await recovery.restoreOrdinaryRestartRecovery(prepared))?.completion;
		expect(executedTools).toBe(0);
		expect(resumed.map((input) => input.subagentId)).toEqual(["standalone"]);
	});

	test("pending approval and not-yet-started tools are protected, not blanket-failed", async () => {
		await seedNarrator("standalone");
		await seedTool("approval", "standalone", { status: "pending", permissionStartedAt: now });
		await seedTool("deferred", "standalone", { status: "initializing" });
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.protection.toolCallIds).toEqual(new Set(["approval", "deferred"]));
		const approval = await toolContinuationService.getByToolCallId("approval");
		expect(approval?.kind).toBe("pending_permission");
		expect(approval?.state).toBe("waiting");
		expect(approval?.payloadJson?.preservePendingPermission).toBe(true);
		expect(approval?.payloadJson?.permissionMode).toBe("normal");
		expect((await tool("approval"))?.status).toBe("pending");
		expect((await toolContinuationService.getByToolCallId("deferred"))?.kind).toBe("deferred_tool");
		expect(executedTools).toBe(0);
		expect(resumed).toEqual([]);
	});

	test("scanner protects only verified execution rows, never COW history clones or legacy identities", async () => {
		await seedNarrator("owner");
		await seedTool("real", "owner", { status: "pending" });
		await seedTool("history", "owner", {
			status: "pending",
			executionOriginToolCallId: "real",
			executionIdentityVersion: 1,
		});
		await seedTool("unverified", "owner", {
			status: "running",
			executionIdentityVersion: 0,
			executionStartedAt: now,
		});
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.protection.toolCallIds).toEqual(new Set(["real"]));
		expect(await toolContinuationService.getByToolCallId("history")).toBeNull();
		expect(await toolContinuationService.getByToolCallId("unverified")).toBeNull();
		expect((await tool("history"))?.status).toBe("pending");
		expect((await tool("unverified"))?.status).toBe("running");
		expect(executedTools).toBe(0);
	});

	test("approval remount keeps normal permissions and does not block an independent streaming child", async () => {
		await seedNarrator("approval-child");
		await seedTool("approval", "approval-child", { status: "pending", permissionStartedAt: now });
		await seedNarrator("streaming-child");
		let releaseApproval: () => void = () => {};
		const decision = new Promise<void>((resolve) => {
			releaseApproval = resolve;
		});
		const mountedInputs: Array<Parameters<typeof session.executePersistedToolCall>[0]> = [];
		let reportMounted: () => void = () => {};
		const approvalMounted = new Promise<void>((resolve) => {
			reportMounted = resolve;
		});
		spyOn(session, "executePersistedToolCall").mockImplementation(async (input) => {
			mountedInputs.push(input);
			reportMounted();
			await decision;
			const call = await tool(input.toolCallId);
			if (!call) throw new Error("Missing pending approval fixture");
			await narratorPersistence.updateToolCallResultIfActive(
				call.toolUseId,
				{ status: "success", output: "Explicit approval result", completedAt: Date.now() },
				call.messageId,
				call.id,
			);
			return { ok: true, shouldContinue: true } as never;
		});
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		const handle = await recovery.restoreOrdinaryRestartRecovery(prepared);
		try {
			expect(handle).not.toBeNull();
			await approvalMounted;
			expect(mountedInputs).toHaveLength(1);
			expect(mountedInputs[0]?.permissionMode).toBe("normal");
			expect((await tool("approval"))?.status).toBe("pending");
			expect(resumed.map((input) => input.subagentId)).toEqual(["streaming-child"]);
		} finally {
			releaseApproval();
			await handle?.completion;
		}
		expect((await tool("approval"))?.status).toBe("success");
		expect(resumed.map((input) => input.subagentId).sort()).toEqual([
			"approval-child",
			"streaming-child",
		]);
	});

	test("terminal tool results and completed or severed legacy children are never revived", async () => {
		await seedNarrator("active-legacy", { logicalRunId: null });
		await seedTool("legacy-success", "active-legacy", { status: "success", outputJson: "kept" });
		await seedTool("legacy-fail", "active-legacy", { status: "fail", outputJson: "kept failure" });
		await seedNarrator("done", { status: "idle", logicalRunId: null });
		await seedNarrator("cancelled", {
			substatus: JSON.stringify(["cancelled"]),
			logicalRunId: null,
		});
		await seedNarrator("taken-over", {
			substatus: JSON.stringify(["taken_over"]),
			logicalRunId: null,
		});
		await seedNarrator("unrelated-primary", { type: "primary", variant: "primary" });
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.manifest?.targets.map((row) => row.narratorId)).toEqual(["active-legacy"]);
		expect(prepared.protection.toolCallIds.size).toBe(0);
		await (await recovery.restoreOrdinaryRestartRecovery(prepared))?.completion;
		expect(resumed.map((input) => input.subagentId)).toEqual(["active-legacy"]);
		expect((await tool("legacy-success"))?.outputJson).toBe("kept");
		expect((await tool("legacy-fail"))?.outputJson).toBe("kept failure");
		expect(continued).toEqual([]);
		expect(executedTools).toBe(0);
	});

	test("a terminal historical foreground Agent call is not replayed for a child's later run", async () => {
		await seedAgent();
		await db
			.update(narratorToolCalls)
			.set({ status: "success", outputJson: "Historical result" })
			.where(eq(narratorToolCalls.id, "agent-call"));
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(await toolContinuationService.getByToolCallId("agent-call")).toBeNull();
		await (await recovery.restoreOrdinaryRestartRecovery(prepared))?.completion;
		expect(resumed.map((input) => input.subagentId)).toEqual(["child"]);
		expect(resumed[0]?.skipConclusionDelivery).toBe(true);
		expect((await tool("agent-call"))?.outputJson).toBe("Historical result");
		expect(continued).toEqual([]);
		expect(executedTools).toBe(0);
	});

	test("planned-update protected rows remain owned by their existing recovery", async () => {
		await seedNarrator("planned-child");
		await seedTool("planned-tool", "planned-child", { executionStartedAt: now });
		const protection = emptyProtection();
		protection.narratorIds.add("planned-child");
		protection.toolCallIds.add("planned-tool");
		const prepared = await recovery.prepareOrdinaryRestartRecovery(protection);
		expect(prepared.manifest).toBeNull();
		expect((await tool("planned-tool"))?.status).toBe("running");
		expect(await toolContinuationService.getByToolCallId("planned-tool")).toBeNull();
	});

	test("--no-auto-resume still repairs and protects durable records but launches nothing", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedAgent();
		await seedTool("approval", "child", { status: "pending" });
		await seedTool("started", "child", { executionStartedAt: now });
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.protection.toolCallIds.has("approval")).toBe(true);
		expect((await tool("started"))?.status).toBe("fail");
		expect(await recovery.restoreOrdinaryRestartRecovery(prepared)).toBeNull();
		expect(resumed).toEqual([]);
		expect(continued).toEqual([]);
		expect(executedTools).toBe(0);
		const manifest = JSON.parse(await readFile(getNarraforkPath("restart-recovery.json"), "utf8"));
		expect(manifest.snapshot.updateEpoch).toBe(prepared.manifest?.snapshot.updateEpoch);
	});

	test("opt-out boot followed by real signal preparation retains paused runs for default cold recovery", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedNarrator("paused");
		await seedTool("approval", "paused", { status: "pending" });
		for (const id of ["done", "cancelled", "archived", "taken-over", "new-run"]) {
			await seedNarrator(id);
		}
		const first = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		const approvalId = (await toolContinuationService.getByToolCallId("approval"))?.id;
		await recovery.restoreOrdinaryRestartRecovery(first);
		await db.update(narrators).set({ status: "idle", substatus: '["interrupted"]' });
		await db.update(narrators).set({ substatus: "[]" }).where(eq(narrators.id, "done"));
		await db
			.update(narrators)
			.set({ substatus: '["cancelled"]' })
			.where(eq(narrators.id, "cancelled"));
		await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, "archived"));
		await db
			.update(narrators)
			.set({ substatus: '["taken_over"]' })
			.where(eq(narrators.id, "taken-over"));
		await db
			.update(narrators)
			.set({ logicalRunId: "replacement-run" })
			.where(eq(narrators.id, "new-run"));
		await seedNarrator("live");
		coordinator.registerNarratorLoop("live", "zh-CN", {
			userId: "signal-user",
			replyInUserLanguage: true,
		});
		await recovery.prepareSignalRestartRecovery();
		const signal = JSON.parse(await readFile(getNarraforkPath("restart-recovery.json"), "utf8"));
		expect(signal.snapshot.updateEpoch).toBe(first.manifest?.snapshot.updateEpoch);
		expect(
			signal.targets.map((target: { narratorId: string }) => target.narratorId).sort(),
		).toEqual(["live", "paused"]);
		expect(
			signal.snapshot.narrators.find(
				(target: { narratorId: string }) => target.narratorId === "live",
			),
		).toEqual({
			narratorId: "live",
			locale: "zh-CN",
			userId: "signal-user",
			replyInUserLanguage: true,
		});
		coordinator.resetUpdateCoordinationForTests();
		recovery.resetRestartRecoveryForTests();
		process.argv = originalArgs.filter((arg) => arg !== recovery.NO_AUTO_RESUME_FLAG);
		spyOn(session, "executePersistedToolCall").mockImplementation(async (input) => {
			const call = await tool(input.toolCallId);
			if (!call) throw new Error("Missing signal approval fixture");
			await narratorPersistence.updateToolCallResultIfActive(
				call.toolUseId,
				{
					status: "success",
					output: "Approved after cold boot",
					completedAt: Date.now(),
				},
				call.messageId,
				call.id,
			);
			return { ok: true, shouldContinue: true } as never;
		});
		const cold = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect((await toolContinuationService.getByToolCallId("approval"))?.id).toBe(approvalId);
		await (await recovery.restoreOrdinaryRestartRecovery(cold))?.completion;
		expect(resumed.map((input) => input.subagentId).sort()).toEqual(["live", "paused"]);
		expect((await tool("approval"))?.status).toBe("success");
	});

	test("signal preparation preserves terminal result epoch until its idle owner receives continuation", async () => {
		await seedNarrator("result-owner");
		await seedTool("finished", "result-owner", { status: "initializing" });
		const first = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		await toolContinuationService.claim("finished", {
			claimToken: "result-claim",
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		});
		const call = await tool("finished");
		if (!call) throw new Error("Missing finished signal fixture");
		await narratorPersistence.updateToolCallResultIfActive(
			call.toolUseId,
			{
				status: "success",
				output: "Durable signal result",
				completedAt: Date.now(),
			},
			call.messageId,
			call.id,
		);
		await toolContinuationService.markResultWritten("finished", { claimToken: "result-claim" });
		await db.update(narrators).set({ status: "idle", substatus: "[]" });
		await recovery.prepareSignalRestartRecovery();
		const signal = JSON.parse(await readFile(getNarraforkPath("restart-recovery.json"), "utf8"));
		expect(signal.snapshot.updateEpoch).toBe(first.manifest?.snapshot.updateEpoch);
		expect(signal.targets.map((target: { narratorId: string }) => target.narratorId)).toEqual([
			"result-owner",
		]);
		coordinator.resetUpdateCoordinationForTests();
		recovery.resetRestartRecoveryForTests();
		const cold = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		await (await recovery.restoreOrdinaryRestartRecovery(cold))?.completion;
		expect(resumed.map((input) => input.subagentId)).toEqual(["result-owner"]);
		expect((await tool("finished"))?.outputJson).toBe("Durable signal result");
		expect(
			(await toolContinuationService.getByToolCallId("finished"))?.payloadJson?.recoveryPhase,
		).toBe("owner_continuation_started");
		expect(executedTools).toBe(0);
	});

	test("cancelled continuations override interrupted tags, including foreground children, without dropping opt-out pauses", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedAgent();
		await seedNarrator("cancelled-owner");
		await seedTool("cancelled-tool", "cancelled-owner", { status: "pending" });
		await seedNarrator("paused-owner");
		await seedTool("paused-tool", "paused-owner", { status: "pending" });
		await seedNarrator("streaming-only");
		await seedNarrator("mixed-owner");
		await seedTool("mixed-cancelled", "mixed-owner", { status: "pending" });
		const first = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		const epoch = first.manifest?.snapshot.updateEpoch;
		if (!epoch) throw new Error("Missing cancellation test epoch");
		await toolContinuationService.cancelInterruptibleForNarrator("parent", epoch);
		await toolContinuationService.cancelInterruptibleForNarrator("cancelled-owner", epoch);
		await toolContinuationService.cancelInterruptibleForNarrator("mixed-owner", epoch);
		await seedTool("mixed-pending", "mixed-owner", { status: "pending" });
		await toolContinuationService.upsert({
			toolCallId: "mixed-pending",
			narratorId: "mixed-owner",
			updateEpoch: epoch,
			kind: "pending_permission",
			state: "waiting",
			payloadJson: { ordinaryRestart: true },
		});
		expect((await toolContinuationService.getByToolCallId("agent-call"))?.state).toBe("cancelled");
		expect(
			(await toolContinuationService.getByToolCallId("agent-call"))?.payloadJson?.subagentId,
		).toBe("child");
		await db.update(narrators).set({ status: "idle", substatus: '["interrupted"]' });
		await recovery.prepareSignalRestartRecovery();
		const signal = JSON.parse(await readFile(getNarraforkPath("restart-recovery.json"), "utf8"));
		expect(signal.snapshot.updateEpoch).toBe(epoch);
		expect(
			signal.targets.map((target: { narratorId: string }) => target.narratorId).sort(),
		).toEqual(["mixed-owner", "paused-owner", "streaming-only"]);
		coordinator.resetUpdateCoordinationForTests();
		recovery.resetRestartRecoveryForTests();
		const cold = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(cold.manifest?.targets.map((target) => target.narratorId).sort()).toEqual([
			"mixed-owner",
			"paused-owner",
			"streaming-only",
		]);
		expect(await recovery.restoreOrdinaryRestartRecovery(cold)).toBeNull();
		expect(resumed).toEqual([]);
		expect(executedTools).toBe(0);
	});

	test("signal does not retain an idle owner after its continuation was already delivered", async () => {
		await seedNarrator("delivered");
		await seedTool("delivered-tool", "delivered", { status: "initializing" });
		const first = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		const epoch = first.manifest?.snapshot.updateEpoch;
		if (!epoch) throw new Error("Missing delivered owner epoch");
		const call = await tool("delivered-tool");
		if (!call) throw new Error("Missing delivered owner tool");
		await toolContinuationService.claim(call.id, {
			claimToken: "delivered-claim",
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		});
		await narratorPersistence.updateToolCallResultIfActive(
			call.toolUseId,
			{
				status: "success",
				output: "Already delivered",
				completedAt: Date.now(),
			},
			call.messageId,
			call.id,
		);
		await toolContinuationService.markResultWritten(call.id, { claimToken: "delivered-claim" });
		await toolContinuationService.markOwnerContinuationPendingForMessage(call.messageId, epoch);
		await toolContinuationService.markOwnerContinuationStartedForMessage(call.messageId, epoch);
		expect(
			(await toolContinuationService.getByToolCallId(call.id))?.payloadJson?.recoveryPhase,
		).toBe("owner_continuation_started");
		await db.update(narrators).set({ status: "idle", substatus: "[]" });
		await recovery.prepareSignalRestartRecovery();
		const signal = JSON.parse(await readFile(getNarraforkPath("restart-recovery.json"), "utf8"));
		expect(signal.targets).toEqual([]);
		coordinator.resetUpdateCoordinationForTests();
		recovery.resetRestartRecoveryForTests();
		const cold = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(cold.manifest).toBeNull();
		expect(resumed).toEqual([]);
		expect(executedTools).toBe(0);
	});

	test("fresh signal snapshot keeps only eligible live targets and their locale/user options", async () => {
		await seedNarrator("live");
		await seedNarrator("done", { status: "idle" });
		await seedNarrator("taken-over", { substatus: '["taken_over"]' });
		for (const id of ["live", "done", "taken-over"]) {
			coordinator.registerNarratorLoop(id, "zh-CN", {
				userId: "live-user",
				replyInUserLanguage: false,
			});
		}
		await recovery.prepareSignalRestartRecovery();
		const signal = JSON.parse(await readFile(getNarraforkPath("restart-recovery.json"), "utf8"));
		expect(signal.snapshot.updateEpoch.startsWith("restart-")).toBe(true);
		expect(signal.targets).toEqual([{ narratorId: "live", logicalRunId: "run-live" }]);
		expect(signal.snapshot.narrators).toEqual([
			{
				narratorId: "live",
				locale: "zh-CN",
				userId: "live-user",
				replyInUserLanguage: false,
			},
		]);
		expect(signal.snapshot.handoffMarkerNonce).toBeUndefined();
		expect(signal.snapshot.resumeOnNextStartup).toBeUndefined();
	});

	test("signal during a planned update cannot translate its epoch or handoff into restart authorization", async () => {
		await seedNarrator("planned-child");
		coordinator.registerNarratorLoop("planned-child", "zh-CN");
		coordinator.scheduleUpdate("future-version", "update");
		await recovery.prepareSignalRestartRecovery();
		expect(await Bun.file(getNarraforkPath("restart-recovery.json")).exists()).toBe(false);
		expect(coordinator.getUpdateCoordinationStatus().operation).toBe("update");
	});

	test("explicit manual continue resumes only the chosen subtree with --no-auto-resume", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedNarrator("chosen");
		await seedNarrator("descendant", { parentNarratorId: "chosen" });
		await seedNarrator("unrelated");
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(prepared.protection.narratorIds.size).toBe(0);
		// Startup's generic cleanup may rest these rows; the durable manifest still authorizes Continue.
		await db.update(narrators).set({ status: "idle", substatus: JSON.stringify(["interrupted"]) });
		expect(await recovery.restoreOrdinaryRestartRecovery(prepared)).toBeNull();
		expect(await recovery.manuallyResumeRestartRecovery("missing")).toBe(false);
		expect(resumed).toEqual([]);
		expect(await recovery.manuallyResumeRestartRecovery("chosen")).toBe(true);
		expect(resumed.map((input) => input.subagentId).sort()).toEqual(["chosen", "descendant"]);
		expect(resumed.map((input) => input.resumeLogicalRunId).sort()).toEqual([
			"run-chosen",
			"run-descendant",
		]);
		expect(executedTools).toBe(0);
		expect(continued).toEqual([]);
		// Manual entry returns after mounting; wait for its real background manifest transaction.
		let remaining: string[] = [];
		const deadline = Date.now() + 2_000;
		do {
			const manifest = JSON.parse(
				await readFile(getNarraforkPath("restart-recovery.json"), "utf8"),
			);
			remaining = manifest.targets.map((target: { narratorId: string }) => target.narratorId);
			if (remaining.length === 1) break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		} while (Date.now() < deadline);
		expect(remaining).toEqual(["unrelated"]);
		expect(await recovery.manuallyResumeRestartRecovery("chosen")).toBe(false);
		expect(resumed).toHaveLength(2);
	});

	test("idle children without interrupted tags retain eligibility for undelivered persisted results", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedNarrator("result-owner");
		await seedTool("finished", "result-owner", { status: "initializing" });
		const first = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		const epoch = first.manifest?.snapshot.updateEpoch;
		if (!epoch) throw new Error("Missing initial restart manifest");
		const claim = await toolContinuationService.claim("finished", {
			claimToken: "old-result-claim",
			deadlineAt: new Date(Date.now() + 60_000).toISOString(),
		});
		expect(claim).not.toBeNull();
		const call = await tool("finished");
		if (!call) throw new Error("Missing finished tool fixture");
		await narratorPersistence.updateToolCallResultIfActive(
			call.toolUseId,
			{ status: "success", output: "Persisted before owner resumed", completedAt: Date.now() },
			call.messageId,
			call.id,
		);
		await toolContinuationService.markResultWritten("finished", { claimToken: "old-result-claim" });
		await db
			.update(narrators)
			.set({ status: "idle", substatus: "[]" })
			.where(eq(narrators.id, "result-owner"));
		recovery.resetRestartRecoveryForTests();
		const second = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(second.manifest?.snapshot.updateEpoch).toBe(epoch);
		expect(second.manifest?.targets.map((target) => target.narratorId)).toEqual(["result-owner"]);
		expect(
			(await toolContinuationService.getByToolCallId("finished"))?.payloadJson?.recoveryPhase,
		).toBe("result_written");
		expect(await recovery.restoreOrdinaryRestartRecovery(second)).toBeNull();
		expect(resumed).toEqual([]);
		expect(executedTools).toBe(0);
	});

	test("manual child-only recovery is not deferred behind its excluded foreground parent", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedAgent();
		await seedTool("child-approval", "child", { status: "pending" });
		const prepared = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect((await toolContinuationService.getByToolCallId("agent-call"))?.kind).toBe(
			"foreground_agent",
		);
		await db.update(narrators).set({ status: "idle", substatus: JSON.stringify(["interrupted"]) });
		spyOn(session, "executePersistedToolCall").mockImplementation(async (input) => {
			executedTools++;
			expect(input.permissionMode).toBe("normal");
			const call = await tool(input.toolCallId);
			if (!call) throw new Error("Missing child approval fixture");
			await narratorPersistence.updateToolCallResultIfActive(
				call.toolUseId,
				{ status: "success", output: "Child approved result", completedAt: Date.now() },
				call.messageId,
				call.id,
			);
			return { ok: true, shouldContinue: true } as never;
		});
		const handle = await recovery.restoreOrdinaryRestartRecovery(prepared, {
			manual: true,
			includedNarratorIds: new Set(["child"]),
		});
		expect(handle).not.toBeNull();
		await handle?.completion;
		expect(resumed.map((input) => input.subagentId)).toEqual(["child"]);
		expect(resumed[0]?.resumeLogicalRunId).toBe("run-child");
		expect(executedTools).toBe(1);
		expect(continued).toEqual([]);
		expect((await tool("agent-call"))?.status).toBe("success");
		expect((await toolContinuationService.getByToolCallId("agent-call"))?.state).toBe("paused");
		expect(
			(await toolContinuationService.getByToolCallId("child-approval"))?.payloadJson?.recoveryPhase,
		).toBe("owner_continuation_started");
	});

	test("cold recovery reconciles a terminal tool result before an expired execution claim", async () => {
		await seedNarrator("result-owner");
		await seedTool("finished", "result-owner", { status: "initializing" });
		const first = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		await toolContinuationService.claim("finished", {
			claimToken: "expired-execution",
			deadlineAt: now,
			now: new Date(Date.parse(now) - 60_000).toISOString(),
		});
		const call = await tool("finished");
		if (!call) throw new Error("Missing finished tool fixture");
		await narratorPersistence.updateToolCallResultIfActive(
			call.toolUseId,
			{ status: "success", output: "Successful durable side effect", completedAt: Date.now() },
			call.messageId,
			call.id,
		);
		const before = await toolContinuationService.getByToolCallId("finished");
		expect(before?.state).toBe("resuming");
		expect(before?.payloadJson?.recoveryPhase).toBeUndefined();
		const completedAt = (await tool("finished"))?.completedAt;
		await db
			.update(narrators)
			.set({ status: "idle", substatus: "[]" })
			.where(eq(narrators.id, "result-owner"));
		recovery.resetRestartRecoveryForTests();
		const second = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(second.manifest?.snapshot.updateEpoch).toBe(first.manifest?.snapshot.updateEpoch);
		await (await recovery.restoreOrdinaryRestartRecovery(second))?.completion;
		const after = await tool("finished");
		expect(after?.status).toBe("success");
		expect(after?.outputJson).toBe("Successful durable side effect");
		expect(after?.completedAt).toBe(completedAt);
		expect(after?.errorMessage).toBeNull();
		expect(executedTools).toBe(0);
		expect(resumed.map((input) => input.subagentId)).toEqual(["result-owner"]);
		expect(
			(await toolContinuationService.getByToolCallId("finished"))?.payloadJson?.recoveryPhase,
		).toBe("owner_continuation_started");
	});

	test("repeated cold boots retain the epoch, one continuation per call, and repaired results", async () => {
		process.argv.push(recovery.NO_AUTO_RESUME_FLAG);
		await seedAgent();
		await seedTool("approval", "child", { status: "pending" });
		await seedTool("started", "child", { executionStartedAt: now });
		const first = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		const approvalId = (await toolContinuationService.getByToolCallId("approval"))?.id;
		const completedAt = (await tool("started"))?.completedAt;
		await db.update(narrators).set({ status: "idle", substatus: JSON.stringify(["interrupted"]) });
		recovery.resetRestartRecoveryForTests();
		const second = await recovery.prepareOrdinaryRestartRecovery(emptyProtection());
		expect(second.manifest?.snapshot.updateEpoch).toBe(first.manifest?.snapshot.updateEpoch);
		expect((await toolContinuationService.getByToolCallId("approval"))?.id).toBe(approvalId);
		expect(
			await toolContinuationService.listByEpoch(second.manifest?.snapshot.updateEpoch ?? ""),
		).toHaveLength(2);
		expect((await tool("started"))?.completedAt).toBe(completedAt);
		expect((await tool("started"))?.outputJson).toBe(recovery.RESTART_EXECUTION_UNKNOWN);
		expect(await recovery.restoreOrdinaryRestartRecovery(second)).toBeNull();
		expect(resumed).toEqual([]);
		expect(executedTools).toBe(0);
	});
});
