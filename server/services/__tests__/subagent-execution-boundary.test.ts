import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	backgroundTasks,
	fileChangeExecutionSegments,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));
// Initialize through the service entrypoint to honor its persistence import cycle.
await import("../narrator-service");
const {
	establishSubagentExecutionSegment,
	readSubagentExecutionBoundary,
	resolveSubagentExecutionSegment,
} = await import("../subagent-execution-boundary");
afterAll(() => {
	mock.module("../../db", () => realDb);
});
beforeEach(() => cleanDb(sqlite));
afterEach(() => mock.restore());
const now = new Date().toISOString();
async function fixture() {
	await db.insert(narrators).values([
		{ id: "parent", title: "p", createdAt: now, updatedAt: now },
		{
			id: "child",
			title: "c",
			parentNarratorId: "parent",
			logicalRunId: "run-1",
			createdAt: now,
			updatedAt: now,
		},
	]);
	await db.insert(fileChangeExecutionSegments).values({
		id: "parent-segment",
		narratorId: "parent",
		sourceToolCallId: "call",
		sourceExecutionAttempt: 1,
		createdAt: now,
	});
	await db.insert(narratorMessages).values({
		id: "message",
		narratorId: "parent",
		role: "assistant",
		contentJson: "[]",
		createdAt: now,
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: "ref", narratorId: "parent", messageId: "message", seq: 1 });
	await db.insert(narratorToolCalls).values({
		messageId: "message",
		id: "call",
		narratorId: "parent",
		toolUseId: "provider-id",
		toolName: "Agent",
		inputJson: "{}",
		executionAttempt: 1,
		executionIdentityVersion: 1,
		executionSegmentId: "parent-segment",
		createdAt: now,
	});
}
const request = {
	childNarratorId: "child",
	parentNarratorId: "parent",
	logicalRunId: "run-1",
	toolUseId: "provider-id",
};
const binding = { toolCallId: "call", attempt: 1, executionSegmentId: "parent-segment" };
describe("subagent logical-run receipts", () => {
	test("verified initial run survives recovery, detach and result reread without a new binding", async () => {
		await fixture();
		const first = await establishSubagentExecutionSegment({ ...request, binding });
		expect(first.executionBoundary?.sourceToolCallId).toBe("call");
		const recovered = await establishSubagentExecutionSegment(request);
		expect(recovered).toEqual(first);
		expect(await readSubagentExecutionBoundary("child")).toEqual(first.executionBoundary);
		expect((await resolveSubagentExecutionSegment("child"))?.id).toBe(first.executionSegmentId);
	});
	test("canonical receipt supplies a segment omitted by the caller", async () => {
		await fixture();
		const execution = await establishSubagentExecutionSegment({
			...request,
			binding: { toolCallId: "call", attempt: 1 },
		});
		expect(execution.executionBoundary?.executionSegmentId).toBe("parent-segment");
	});
	test("a fresh continuation cannot inherit the creation receipt", async () => {
		await fixture();
		await establishSubagentExecutionSegment({ ...request, binding });
		const next = await establishSubagentExecutionSegment({ ...request, logicalRunId: "run-2" });
		expect(next.executionBoundary).toBeNull();
		expect(await readSubagentExecutionBoundary("child", "run-2")).toBeNull();
	});
	test("continuation uses its initiating call even when the provider ID and result slot are reused", async () => {
		await fixture();
		const first = await establishSubagentExecutionSegment({ ...request, binding });
		await db.insert(fileChangeExecutionSegments).values({
			id: "next-segment",
			narratorId: "parent",
			sourceToolCallId: "next-call",
			sourceExecutionAttempt: 1,
			createdAt: now,
		});
		await db.insert(narratorToolCalls).values({
			id: "next-call",
			messageId: "message",
			narratorId: "parent",
			toolUseId: "provider-id",
			toolName: "Await",
			inputJson: "{}",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			executionSegmentId: "next-segment",
			createdAt: now,
		});
		const nextBinding = { toolCallId: "next-call", attempt: 1, executionSegmentId: "next-segment" };
		const next = await establishSubagentExecutionSegment({
			...request,
			logicalRunId: "run-2",
			binding: nextBinding,
		});
		expect(next.executionSegmentId).not.toBe(first.executionSegmentId);
		expect(next.executionBoundary?.sourceToolCallId).toBe("next-call");
		await expect(
			establishSubagentExecutionSegment({ ...request, binding: nextBinding }),
		).rejects.toThrow("conflicts");
		expect(await readSubagentExecutionBoundary("child", "run-1")).toEqual(first.executionBoundary);
	});
	test("new attempt invalidates old proof and a foreign or forged segment is rejected", async () => {
		await fixture();
		await establishSubagentExecutionSegment({ ...request, binding });
		await expect(
			establishSubagentExecutionSegment({
				...request,
				logicalRunId: "other",
				binding: { ...binding, executionSegmentId: "foreign" },
			}),
		).rejects.toThrow("does not match");
		await db
			.update(narratorToolCalls)
			.set({ executionAttempt: 2 })
			.where(eq(narratorToolCalls.id, "call"));
		expect(await readSubagentExecutionBoundary("child")).toBeNull();
		await expect(establishSubagentExecutionSegment({ ...request, binding })).rejects.toThrow(
			"stale",
		);
	});
	for (const reason of ["not_found", "not_latest_turn", "narrator_busy", "not_denied"] as const) {
		test(`rejected retry (${reason}) preserves narrator, background task and attribution`, async () => {
			await fixture();
			await db
				.update(narrators)
				.set({
					variant: "subagent:general",
					type: "subagent",
					originToolCallId: "call",
					cwd: process.env.HOME,
					status: "idle",
				})
				.where(eq(narrators.id, "child"));
			const originalSegment = await establishSubagentExecutionSegment({ ...request, binding });
			await db.insert(backgroundTasks).values({
				id: "child-task",
				parentNarratorId: "parent",
				type: "agent",
				subagentNarratorId: "child",
				logicalRunId: "run-1",
				status: "completed",
				startedAt: now,
				createdAt: now,
				updatedAt: now,
			});
			await db.insert(narratorMessages).values({
				id: "original-input",
				narratorId: "child",
				role: "user",
				parentToolUseId: "provider-id",
				contentJson: [],
				createdAt: now,
			});
			await db.insert(narratorMessageRefs).values({
				id: "original-input-ref",
				narratorId: "child",
				messageId: "original-input",
				seq: 0,
			});
			await db.insert(narratorMessages).values({
				id: "retry-message",
				narratorId: "child",
				role: "assistant",
				parentToolUseId: "provider-id",
				contentJson: [],
				createdAt: now,
			});
			await db.insert(narratorMessageRefs).values({
				id: "retry-ref",
				narratorId: "child",
				messageId: "retry-message",
				seq: 1,
			});
			await db.insert(narratorToolCalls).values({
				id: "retry-call",
				narratorId: "child",
				messageId: "retry-message",
				toolUseId: "retry-write",
				toolName: "Write",
				inputJson: {},
				status: reason === "not_denied" ? "success" : "fail",
				permissionDecidedBy: "user",
				createdAt: now,
			});
			if (reason === "not_latest_turn") {
				await db.insert(narratorMessages).values({
					id: "later-message",
					narratorId: "child",
					role: "user",
					parentToolUseId: "provider-id",
					contentJson: [],
					createdAt: now,
				});
				await db.insert(narratorMessageRefs).values({
					id: "later-ref",
					narratorId: "child",
					messageId: "later-message",
					seq: 2,
				});
			}
			const state = await import("../narrator-session-state");
			const release =
				reason === "narrator_busy" ? state.claimNarratorRuntime("child", "other") : () => {};
			const before = await db.query.fileChangeExecutionSegments.findMany();
			const persistence = (await import("../narrator-persistence")).narratorPersistence;
			const prepare = spyOn(persistence, "prepareToolCallAttempt");
			try {
				const { resumeSubagent } = await import("../subagent-resume");
				const result = await resumeSubagent({
					subagentId: "child",
					intent: "retry_denied_tool",
					actor: "user",
					retryToolUseId: reason === "not_found" ? "unknown" : "retry-write",
					locale: "en",
				});
				expect(result.retryDeniedReason).toBe(reason);
				expect(result.started).toBe(false);
				expect(prepare).not.toHaveBeenCalled();
				expect(
					(await db.query.narrators.findFirst({ where: eq(narrators.id, "child") }))?.logicalRunId,
				).toBe("run-1");
				expect(
					(
						await db.query.backgroundTasks.findFirst({
							where: eq(backgroundTasks.id, "child-task"),
						})
					)?.logicalRunId,
				).toBe("run-1");
				expect(await resolveSubagentExecutionSegment("child")).toEqual(
					expect.objectContaining({ id: originalSegment.executionSegmentId }),
				);
				expect(await readSubagentExecutionBoundary("child")).toEqual(
					originalSegment.executionBoundary,
				);
				expect(await db.query.fileChangeExecutionSegments.findMany()).toEqual(before);
			} finally {
				release();
			}
		});
	}
	for (const outcome of [
		"continue",
		"tool_failure",
		"prepare_failure",
		"result_persistence_failure",
	] as const) {
		test(`real admitted retry (${outcome}) owns its new segment and releases unused slots`, async () => {
			await fixture();
			await db
				.update(narrators)
				.set({
					variant: "subagent:general",
					type: "subagent",
					originToolCallId: "call",
					cwd: process.env.HOME,
					model: "claude-sonnet-4-5",
					status: "idle",
				})
				.where(eq(narrators.id, "child"));
			if (outcome === "result_persistence_failure") {
				await db
					.update(narrators)
					.set({
						isBackground: true,
						backgroundStatus: "completed",
						backgroundResult: "previous success",
						backgroundCompletedAt: "2020-01-01T00:00:00.000Z",
					})
					.where(eq(narrators.id, "child"));
				await db.insert(backgroundTasks).values({
					id: "child",
					parentNarratorId: "parent",
					type: "agent",
					subagentNarratorId: "child",
					logicalRunId: "run-1",
					status: "completed",
					output: "previous success",
					startedAt: "2020-01-01T00:00:00.000Z",
					completedAt: "2020-01-01T00:00:00.000Z",
					createdAt: now,
					updatedAt: now,
				});
				const service = (await import("../narrator-service")).narratorService;
				spyOn(service, "updateToolCallResult").mockRejectedValue(
					new Error("result persistence failed"),
				);
			}
			await db.insert(narratorMessages).values({
				id: "child-input",
				narratorId: "child",
				role: "user",
				parentToolUseId: "provider-id",
				contentJson: [{ type: "text", text: "write" }],
				createdAt: now,
			});
			await db
				.insert(narratorMessageRefs)
				.values({ id: "child-input-ref", narratorId: "child", messageId: "child-input", seq: 1 });
			const filePath = join(process.env.HOME as string, "denied-boundary.txt");
			await db.insert(narratorMessages).values({
				id: "denied-message",
				narratorId: "child",
				role: "assistant",
				parentToolUseId: "provider-id",
				contentJson: [
					{
						type: "tool_use",
						id: "denied-write",
						name: "Write",
						input: { file_path: filePath, content: "retried" },
					},
				],
				createdAt: now,
			});
			await db
				.insert(narratorMessageRefs)
				.values({ id: "denied-ref", narratorId: "child", messageId: "denied-message", seq: 2 });
			await db.insert(narratorToolCalls).values({
				id: "denied-call",
				narratorId: "child",
				messageId: "denied-message",
				toolUseId: "denied-write",
				toolName: "Write",
				inputJson: { file_path: filePath, content: "retried" },
				status: "fail",
				permissionDecidedBy: "user",
				executionAttempt: 1,
				executionIdentityVersion: 1,
				createdAt: now,
			});
			const persistence = (await import("../narrator-persistence")).narratorPersistence;
			const prepare = persistence.prepareToolCallAttempt.bind(persistence);
			const state = await import("../narrator-session-state");
			spyOn(persistence, "prepareToolCallAttempt").mockImplementation(async (...args) => {
				if (outcome === "prepare_failure") throw new Error("prepare failed");
				const prepared = await prepare(...args);
				state.activeNarrators.set("child", {
					narratorId: "child",
					conversationId: "child-conversation",
					systemPrompt: null,
					cwd: process.env.HOME as string,
					model: "claude-sonnet-4-5",
					provider: "anthropic",
					events: new EventEmitter(),
					alive: true,
					locale: "en",
					abortController: new AbortController(),
					_enabledOptionalTools: new Set(),
					_disabledTools: new Set(),
					_blockedSkills: { all: false, names: new Set() },
					_substatus: new Set(),
				});
				return prepared;
			});
			let runAtIo: string | null = null;
			const tools = await import("../../lib/agent/tool-executor");
			spyOn(tools, "executeTool").mockImplementation(async (_tool, _config, options) => {
				const current = await db.query.narrators.findFirst({ where: eq(narrators.id, "child") });
				runAtIo = current?.logicalRunId ?? null;
				expect(runAtIo).not.toBe("run-1");
				if (outcome === "result_persistence_failure") {
					expect(current?.backgroundStatus).toBe("running");
					expect(current?.backgroundResult).toBeNull();
					expect(current?.backgroundCompletedAt).toBeNull();
					const task = await db.query.backgroundTasks.findFirst({
						where: eq(backgroundTasks.id, "child"),
					});
					expect(task?.status).toBe("running");
					expect(task?.output).toBeNull();
					expect(task?.completedAt).toBeNull();
				}
				const childRun = await resolveSubagentExecutionSegment("child");
				const toolSegment = await db.query.fileChangeExecutionSegments.findFirst({
					where: eq(
						fileChangeExecutionSegments.id,
						options?.toolCallBinding?.executionSegmentId ?? "",
					),
				});
				expect(toolSegment?.parentSegmentId).toBe(childRun?.id);
				if (outcome === "tool_failure") throw new Error("tool failed");
				writeFileSync(filePath, "retried");
				return { output: "written", isError: false, durationMs: 1 };
			});
			const agent = await import("../../lib/agent");
			spyOn(agent, "buildHistory").mockResolvedValue({
				history: [],
				trailingToolResults: [
					{ type: "tool_result", toolUseId: "denied-write", output: "written" },
				],
			});
			const runner = await import("../subagent-runner");
			let continuation: Record<string, unknown> | undefined;
			spyOn(runner, "startContinuedSubagent").mockImplementation(async (input) => {
				continuation = input as unknown as Record<string, unknown>;
				return {
					runId: "continuation",
					completion: Promise.resolve("done"),
					terminalCompletion: Promise.resolve("done"),
				};
			});
			const publication = (
				await import("../agent-runtime/publication")
			).getRuntimePublicationService();
			const releaseSlots = spyOn(publication, "releaseUnusedRunSlots");
			try {
				const { resumeSubagent } = await import("../subagent-resume");
				const resumed = resumeSubagent({
					subagentId: "child",
					intent: "retry_denied_tool",
					actor: "user",
					retryToolUseId: "denied-write",
					locale: "en",
					skipConclusionDelivery: true,
				});
				if (outcome === "prepare_failure") {
					await expect(resumed).rejects.toThrow("prepare failed");
				} else if (outcome === "tool_failure" || outcome === "result_persistence_failure") {
					expect((await resumed).started).toBe(false);
				} else {
					const result = await resumed;
					expect(result.started).toBe(true);
					expect(readFileSync(filePath, "utf8")).toBe("retried");
					expect(continuation?.resumeLogicalRunId).toBe(runAtIo);
					expect(continuation?.fileChangeStartedAt).toEqual(expect.any(String));
					await result.terminalCompletion;
				}
				if (outcome !== "continue") {
					expect(releaseSlots).toHaveBeenCalledTimes(1);
					expect(continuation).toBeUndefined();
					expect(state.isNarratorRuntimeBusy("child")).toBe(false);
					const current = await db.query.narrators.findFirst({ where: eq(narrators.id, "child") });
					expect(current?.logicalRunId).not.toBe("run-1");
					expect(current?.logicalRunId).toBe(releaseSlots.mock.calls[0][0].logicalRunId);
					if (outcome === "result_persistence_failure") {
						expect(readFileSync(filePath, "utf8")).toBe("retried");
						expect(current?.backgroundStatus).toBe("failed");
						expect(current?.backgroundResult).toContain("result persistence failed");
						expect(current?.backgroundCompletedAt).not.toBe("2020-01-01T00:00:00.000Z");
						expect(Date.parse(current?.backgroundCompletedAt ?? "")).toBeGreaterThanOrEqual(
							Date.parse(current?.turnStartedAt ?? ""),
						);
						const task = await db.query.backgroundTasks.findFirst({
							where: eq(backgroundTasks.id, "child"),
						});
						expect(task?.status).toBe("failed");
						expect(task?.output).toBe(current?.backgroundResult);
						expect(task?.completedAt).toBe(current?.backgroundCompletedAt);
						expect(task?.logicalRunId).toBe(current?.logicalRunId);
					}
				}
			} finally {
				state.activeNarrators.delete("child");
				rmSync(filePath, { force: true });
			}
		});
	}
	test("legacy run without a durable receipt never upgrades its creation call to proof", async () => {
		await fixture();
		expect(await readSubagentExecutionBoundary("child")).toBeNull();
		expect(await readSubagentExecutionBoundary("child", null)).toBeNull();
	});
});
