import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import {
	backgroundTasks,
	fileChangeExecutionSegments,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import * as workerPool from "../../lib/db-worker/pool";
import { delegationRegistration } from "../../lib/validators/runtime-registration";
import {
	captureWorkerRejection,
	captureWorkerRejectionThrower,
	getNarratorWorkerTestDb,
} from "./narrator-worker-fixture";

const databaseFixture = getNarratorWorkerTestDb();
const { db, sqlite } = databaseFixture;
await databaseFixture.ready;
afterAll(() => databaseFixture.close());
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
			policySourceNarratorId: "parent",
			runtimeRegistrationJson: {
				...delegationRegistration("parent", "general"),
				run: {
					logicalRunId: "run-1",
					deliverTo: { narratorId: "parent", toolUseId: "provider-id", toolCallId: "call" },
				},
			},
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
	for (const mutation of ["attempt", "receipt"] as const) {
		test(`a concurrent ${mutation} change rejects with 409 instead of committing a stale run receipt`, async () => {
			await fixture();
			const read = workerPool.runReadTask;
			let changed = false;
			const reader = spyOn(workerPool, "runReadTask").mockImplementation(
				async <T>(...args: Parameters<typeof workerPool.runReadTask>) => {
					const result = await read<T>(...args);
					const task = args[1];
					if (
						!changed &&
						task.kind === "selectRows" &&
						task.sql.includes('from "file_change_execution_segments"')
					) {
						changed = true;
						if (mutation === "attempt") {
							db.update(narratorToolCalls)
								.set({ executionAttempt: 2 })
								.where(eq(narratorToolCalls.id, "call"))
								.run();
						} else {
							db.insert(fileChangeExecutionSegments)
								.values({
									id: "concurrent-receipt",
									narratorId: "child",
									sourceInputId: "subagent-run:run-1",
									parentSegmentId: null,
									createdAt: now,
								})
								.run();
						}
					}
					return result;
				},
			);
			try {
				const error = await captureWorkerRejection(
					establishSubagentExecutionSegment({ ...request, binding }),
				);
				expect(changed).toBe(true);
				expect(error).toMatchObject({ statusCode: 409, code: "RUNTIME_READ_CONFLICT" });
				const receipts = db
					.select()
					.from(fileChangeExecutionSegments)
					.where(eq(fileChangeExecutionSegments.narratorId, "child"))
					.all();
				expect(receipts.map((row) => row.id)).toEqual(
					mutation === "receipt" ? ["concurrent-receipt"] : [],
				);
			} finally {
				reader.mockRestore();
			}
		});
	}
	test("absent receipts and Worker failures remain distinct without main-thread fallback", async () => {
		await fixture();
		expect(await readSubagentExecutionBoundary("child")).toBeNull();
		const failure = new Error("injected Worker failure");
		const reader = spyOn(workerPool, "runReadTask").mockRejectedValue(failure);
		const local = spyOn(sqlite, "query");
		try {
			expect(await captureWorkerRejection(readSubagentExecutionBoundary("child"))).toBe(failure);
			expect(await captureWorkerRejection(establishSubagentExecutionSegment(request))).toBe(
				failure,
			);
			expect(local).not.toHaveBeenCalled();
		} finally {
			local.mockRestore();
			reader.mockRestore();
		}
	});
	test("cancelled and expired reads fail before receipt creation", async () => {
		await fixture();
		for (const options of [{ signal: AbortSignal.abort() }, { deadlineAt: Date.now() - 1 }]) {
			expect(
				await captureWorkerRejection(establishSubagentExecutionSegment({ ...request, ...options })),
			).toBeInstanceOf(Error);
		}
		expect(
			db
				.select()
				.from(fileChangeExecutionSegments)
				.where(eq(fileChangeExecutionSegments.narratorId, "child"))
				.all(),
		).toEqual([]);
	});
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
			await captureWorkerRejectionThrower(
				establishSubagentExecutionSegment({ ...request, binding: nextBinding }),
			),
		).toThrow("conflicts");
		expect(await readSubagentExecutionBoundary("child", "run-1")).toEqual(first.executionBoundary);
	});
	test("new attempt invalidates old proof and a foreign or forged segment is rejected", async () => {
		await fixture();
		await establishSubagentExecutionSegment({ ...request, binding });
		await expect(
			await captureWorkerRejectionThrower(
				establishSubagentExecutionSegment({
					...request,
					logicalRunId: "other",
					binding: { ...binding, executionSegmentId: "foreign" },
				}),
			),
		).toThrow("does not match");
		await db
			.update(narratorToolCalls)
			.set({ executionAttempt: 2 })
			.where(eq(narratorToolCalls.id, "call"));
		expect(await readSubagentExecutionBoundary("child")).toBeNull();
		await expect(
			await captureWorkerRejectionThrower(
				establishSubagentExecutionSegment({ ...request, binding }),
			),
		).toThrow("stale");
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
				// The one denied-tool retry entry, the same for every session.
				const { reExecuteDeniedToolCall } = await import("../narrator-session");
				const result = await reExecuteDeniedToolCall(
					"child",
					reason === "not_found" ? "unknown" : "retry-write",
					"en",
				);
				expect(result).toEqual({ ok: false, reason });
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
		test(`real admitted retry (${outcome}) attributes its I/O to the session's run segment`, async () => {
			await fixture();
			// The session's current run delivers to the Agent call and owns a segment.
			await establishSubagentExecutionSegment({ ...request, binding });
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
				const { narratorStore } = await import("../narrator-store");
				spyOn(narratorStore, "settleTool").mockRejectedValue(
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
			let runAtIo = null as string | null;
			const tools = await import("../../lib/agent/tool-executor");
			spyOn(tools, "executeTool").mockImplementation(async (_tool, _config, options) => {
				const current = await db.query.narrators.findFirst({ where: eq(narrators.id, "child") });
				runAtIo = current?.logicalRunId ?? null;
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
				history: [{ type: "tool_result", toolUseId: "denied-write", output: "written" }],
			});
			// The continuation after a successful retry is an ordinary run start; observe it.
			const runModule = await import("../agent-runtime/run");
			const continuations: Array<Record<string, unknown>> = [];
			const idle = Promise.resolve({
				started: true,
				output: "",
				finalText: "",
				hasError: false,
				interrupted: false,
				timedOut: false,
			});
			spyOn(runModule, "startNarratorRun").mockImplementation(async (input) => {
				continuations.push(input as unknown as Record<string, unknown>);
				return { started: true, foreground: idle, terminal: idle, completion: idle };
			});
			try {
				const { reExecuteDeniedToolCall } = await import("../narrator-session");
				const retried = reExecuteDeniedToolCall("child", "denied-write", "en");
				if (outcome === "prepare_failure") {
					await expect(await captureWorkerRejectionThrower(retried)).toThrow("prepare failed");
					// Nothing ran: the session's run and its attribution are untouched.
					expect(
						(await db.query.narrators.findFirst({ where: eq(narrators.id, "child") }))
							?.logicalRunId,
					).toBe("run-1");
				} else if (outcome === "tool_failure" || outcome === "result_persistence_failure") {
					expect(await retried).toMatchObject({ ok: true, shouldContinue: false });
				} else {
					expect(await retried).toEqual({ ok: true });
					expect(readFileSync(filePath, "utf8")).toBe("retried");
					// The continuation goes through the one run entry with no new relations:
					// the run still delivers to the destination the session registered.
					expect(continuations).toHaveLength(1);
					expect(continuations[0]).toMatchObject({ narratorId: "child" });
					expect(continuations[0].binding).toBeUndefined();
					expect(continuations[0].resumeRunId).toBeUndefined();
				}
				if (outcome !== "continue") expect(continuations).toEqual([]);
				// The retried attempt's file changes are recorded under the session's run
				// segment (asserted at I/O above), and no owner or runtime claim is left.
				if (outcome !== "prepare_failure") expect(runAtIo).toBe("run-1");
				expect(state.isNarratorRuntimeBusy("child")).toBe(false);
				if (outcome === "result_persistence_failure")
					expect(readFileSync(filePath, "utf8")).toBe("retried");
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
