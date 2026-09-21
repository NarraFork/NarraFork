import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	runtimePublicationOutbox,
} from "../../db/schema";
import { eventBus } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import { runtimePublication } from "../agent-runtime/publication";
import { backgroundTaskService } from "../background-task-service";
import * as session from "../narrator-session";
import * as executor from "../subagent-executor";
import { resumeSubagent } from "../subagent-resume";

runtimePublication.stop();
afterEach(() => cleanDb(sqlite));

async function fixture(background: boolean) {
	const parent = generateId(),
		child = generateId(),
		messageId = generateId(),
		toolCallId = generateId(),
		toolUseId = generateId();
	const now = new Date().toISOString();
	db.insert(narrators)
		.values([
			{ id: parent, variant: "primary", status: "idle", createdAt: now, updatedAt: now },
			{
				id: child,
				variant: "subagent:general",
				type: "subagent",
				parentNarratorId: parent,
				status: "idle",
				model: "claude-sonnet-4-6",
				isBackground: background,
				backgroundStatus: background ? "running" : null,
				originToolCallId: toolCallId,
				subagentOriginKind: "tool",
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();
	db.insert(narratorMessages)
		.values({
			id: messageId,
			narratorId: parent,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: toolUseId, name: "Agent", input: {} }],
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId: parent, messageId, seq: 1 })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId: parent,
			messageId,
			toolUseId,
			toolName: "Agent",
			inputJson: {},
			outputJson: "OLD RESULT",
			status: "success",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionStartedAt: now,
			createdAt: now,
		})
		.run();
	const childMessageId = generateId();
	db.insert(narratorMessages)
		.values({
			id: childMessageId,
			narratorId: child,
			parentToolUseId: toolUseId,
			role: "user",
			contentJson: [{ type: "text", text: "original task" }],
			contentText: "original task",
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId: child, messageId: childMessageId, seq: 1 })
		.run();
	const run = runtimePublication.startAgentRun({ narratorId: child, parentNarratorId: parent });
	if (background)
		await backgroundTaskService.createAgentTask({
			id: child,
			parentNarratorId: parent,
			subagentNarratorId: child,
			subagentType: "general",
			toolUseId,
		});
	return { parent, child, toolCallId, run };
}

describe("resume preparation reservation cleanup", () => {
	for (const phase of ["history", "attachment"] as const) {
		test(`${phase} failure releases unused slots without deleting committed events`, async () => {
			const f = await fixture(false);
			const { startContinuedSubagent } = await import("../subagent-runner");
			const { getExecutionOwner } = await import("../agent-runtime/ownership");
			const files = await import("../../lib/uploads");
			const history = spyOn(executor, "loadSubagentHistory").mockRejectedValue(
				new Error("history preparation failed"),
			);
			const attachment = spyOn(files, "saveTextFileToWorktree").mockRejectedValue(
				new Error("attachment preparation failed"),
			);
			const rows = () =>
				db
					.select()
					.from(runtimePublicationOutbox)
					.where(eq(runtimePublicationOutbox.logicalRunId, f.run.logicalRunId))
					.all();
			runtimePublication.store.reserveRunSlots(f.run, { started: true });
			runtimePublication.store.commitIntent({
				...f.run,
				eventKind: "started",
				resultRef: "message:existing",
				summary: "existing result",
			});
			const committed = rows().filter((row) => row.state !== "reserved");
			expect(committed).toHaveLength(1);
			expect(rows().some((row) => row.state === "reserved")).toBe(true);
			try {
				await expect(
					startContinuedSubagent({
						subagentId: f.child,
						parentNarratorId: f.parent,
						toolUseId: "origin-tool",
						prompt: "continue",
						locale: "en",
						signal: new AbortController().signal,
						persistPrompt: phase === "attachment",
						resumeLogicalRunId: f.run.logicalRunId,
						textFiles: phase === "attachment" ? [new File(["fixture"], "fixture.txt")] : undefined,
					}),
				).rejects.toThrow(`${phase} preparation failed`);
				expect(rows()).toEqual(committed);
				expect(getExecutionOwner(f.child)).toBeUndefined();
			} finally {
				history.mockRestore();
				attachment.mockRestore();
			}
		});
	}
});

// Real resume -> continued runner -> task producer -> exact parent conclusion.
// Only the model boundary is fake, and the genuine conclusion function is delayed, not replaced.
describe("runner publication waits for the exact parent tool transaction", () => {
	for (const preserveBackground of [false, true])
		for (const skipConclusionDelivery of [false, true]) {
			test(`preserve=${preserveBackground}, skipConclusion=${skipConclusionDelivery}`, async () => {
				const f = await fixture(preserveBackground);
				const gate = Promise.withResolvers<void>();
				const entered = Promise.withResolvers<void>();
				let wakes = 0;
				const controlEvents: string[] = [];
				const watch: Parameters<typeof eventBus.onAny>[0] = (event) => {
					if (
						"taskId" in event &&
						event.taskId === f.child &&
						[
							"background_task:completed",
							"background_task:failed",
							"background_task:cancelled",
						].includes(event.type)
					)
						controlEvents.push(event.type);
				};
				eventBus.onAny(watch);
				runtimePublication.setWake(() => {
					wakes++;
				});
				const history = spyOn(executor, "loadSubagentHistory").mockResolvedValue({
					history: [],
					trailingToolResults: [],
					trailingUserText: undefined,
				});
				const execute = spyOn(executor, "executeSubagent").mockResolvedValue({
					finalText: "NEW RESULT",
					hasError: false,
					allowInboxWake: true,
					finalUserId: null,
				});
				const originalConclusion = session.updateToolCallConclusion;
				const conclusion = spyOn(session, "updateToolCallConclusion").mockImplementation(
					async (input) => {
						entered.resolve();
						await gate.promise;
						return originalConclusion(input);
					},
				);
				try {
					const resumed = await resumeSubagent({
						subagentId: f.child,
						intent: "follow_up",
						prompt: "finish",
						actor: "parent_agent",
						locale: "en",
						preserveBackground,
						skipConclusionDelivery,
						skipStaleAttach: true,
						resumeLogicalRunId: f.run.logicalRunId,
					});
					if (!skipConclusionDelivery) {
						await entered.promise;
						runtimePublication.flushRecipient(f.parent);
						expect(
							db
								.select()
								.from(narratorBufferedMessages)
								.where(eq(narratorBufferedMessages.narratorId, f.parent))
								.all(),
						).toHaveLength(0);
						expect(
							db
								.select()
								.from(runtimePublicationOutbox)
								.where(eq(runtimePublicationOutbox.state, "pending"))
								.all(),
						).toHaveLength(0);
						expect(wakes).toBe(0);
						expect(controlEvents).toHaveLength(0);
						if (preserveBackground)
							expect((await backgroundTaskService.getById(f.child))?.status).toBe("running");
						expect(
							db
								.select()
								.from(narratorToolCalls)
								.where(eq(narratorToolCalls.id, f.toolCallId))
								.get()?.outputJson,
						).toBe("OLD RESULT");
					}
					gate.resolve();
					await resumed.terminalCompletion;
					runtimePublication.flushRecipient(f.parent);
					const notices = db
						.select()
						.from(narratorBufferedMessages)
						.where(
							and(
								eq(narratorBufferedMessages.narratorId, f.parent),
								eq(narratorBufferedMessages.kind, "task_notice"),
							),
						)
						.all();
					expect(notices).toHaveLength(preserveBackground || !skipConclusionDelivery ? 1 : 0);
					const output = db
						.select()
						.from(narratorToolCalls)
						.where(eq(narratorToolCalls.id, f.toolCallId))
						.get()?.outputJson;
					if (skipConclusionDelivery) expect(output).toBe("OLD RESULT");
					else expect(String(output)).toContain("NEW RESULT");
					expect(execute).toHaveBeenCalledTimes(1);
					expect(controlEvents).toHaveLength(preserveBackground ? 1 : 0);
					if (preserveBackground)
						expect((await backgroundTaskService.getById(f.child))?.status).toBe("completed");
				} finally {
					gate.resolve();
					eventBus.offAny(watch);
					execute.mockRestore();
					history.mockRestore();
					conclusion.mockRestore();
					runtimePublication.setWake(undefined);
				}
			}, 10000);
		}
});
