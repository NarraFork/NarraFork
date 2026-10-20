/**
 * Publication through the one run service: a run's terminal reaches the exact tool call
 * it registered, exactly once, and nothing (notice, wake, rewritten tool result) becomes
 * visible before the publishing transaction commits. Only the model pass is fake.
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
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
import type { ProviderAdapter } from "../../lib/agent/provider";
import { registerExternalProviderResolver } from "../../lib/agent/provider";
import { eventBus } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import { getExecutionOwner } from "../agent-runtime/ownership";
import { getRuntimePublicationService, runtimePublication } from "../agent-runtime/publication";
import { listDeliveringRuns, startNarratorRun } from "../agent-runtime/run";
import { backgroundTaskService } from "../background-task-service";
import * as session from "../narrator-session";
import { activeNarrators } from "../narrator-session-state";

const provider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("Publication test must never call a model");
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const unregisterProvider = registerExternalProviderResolver({
	resolve: (name) => (name === "test" ? provider : null),
	listReadiness: () => [],
});

runtimePublication.stop();
const created: string[] = [];
afterEach(() => {
	for (const id of created.splice(0)) {
		getExecutionOwner(id)?.release();
		activeNarrators.delete(id);
	}
	runtimePublication.setWake(undefined);
	cleanDb(sqlite);
});
afterAll(() => unregisterProvider());

/** A delegated session `child` whose run delivers to the parent's Agent call. */
async function fixture(background: boolean) {
	const parent = generateId(),
		child = generateId(),
		messageId = generateId(),
		toolCallId = generateId(),
		toolUseId = generateId();
	created.push(parent, child);
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
				model: "test:model",
				cwd: process.env.HOME,
				isBackground: background,
				backgroundStatus: background ? "running" : null,
				originToolCallId: toolCallId,
				subagentOriginKind: "tool",
				autoContinuationOverride: "off",
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
	const binding = {
		deliverTo: { narratorId: parent, toolUseId, toolCallId, attempt: 1 },
		principal: { userId: null },
	};
	return { parent, child, toolCallId, toolUseId, binding };
}

/** The model pass: optionally writes one assistant reply, then reports its outcome. */
async function fakePass(child: string, output: string, write: boolean, hasError = false) {
	const orchestrator = await import("../agent-runtime/orchestrator");
	return spyOn(orchestrator, "runAgentLoopUnlocked").mockImplementation(async () => {
		db.update(narrators).set({ status: "working" }).where(eq(narrators.id, child)).run();
		if (write) {
			const id = generateId();
			db.insert(narratorMessages)
				.values({
					id,
					narratorId: child,
					role: "assistant",
					contentText: output,
					contentJson: [{ type: "text", text: output }],
					createdAt: new Date().toISOString(),
				})
				.run();
			db.insert(narratorMessageRefs)
				.values({ id: generateId(), narratorId: child, messageId: id, seq: 2 })
				.run();
		}
		return { started: true, finalText: output, hasError, allowInboxWake: false };
	});
}

const parentRows = (parent: string) =>
	db
		.select()
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, parent))
		.all();
const toolOutput = (toolCallId: string) =>
	db.select().from(narratorToolCalls).where(eq(narratorToolCalls.id, toolCallId)).get()?.outputJson;

for (const commitFailure of [true, false])
	test(`real Agent tool returns ${commitFailure ? "isError for infrastructure failure" : "ordinary model failure as a normal result"}`, async () => {
		const f = await fixture(false);
		db.update(narrators)
			.set({
				traits: ["standalone"],
				model: "test:model",
				cwd: process.cwd(),
				autoContinuationOverride: "off",
			})
			.where(eq(narrators.id, f.parent))
			.run();
		db.update(narratorToolCalls)
			.set({ status: "running" })
			.where(eq(narratorToolCalls.id, f.toolCallId))
			.run();
		const { agentTool } = await import("../../lib/agent/tools/task");
		const executor = await import("../narrator-executor");
		const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async ({ config }) => {
			if (config.narratorId) created.push(config.narratorId);
			return { finalText: "ordinary provider failure", hasError: true, shouldUpdateTitle: false };
		});
		const facade = getRuntimePublicationService();
		const commit = spyOn(facade, "commitAgentTerminal");
		if (commitFailure)
			commit.mockRejectedValue(new Error("injected Agent terminal commit failure"));
		try {
			const result = await agentTool.execute(
				{ prompt: "work", subagent_type: "general" },
				{
					narratorId: f.parent,
					cwd: process.cwd(),
					signal: new AbortController().signal,
					locale: "en",
					currentToolUseId: f.toolUseId,
					toolCallBinding: { toolCallId: f.toolCallId, attempt: 1 },
					updateExecutionLease: {
						kind: "resumable",
						setNarratorId: () => {},
						transfer: () => true,
						release: () => {},
					},
					requestPermission: async () => ({ behavior: "allow" }),
				},
			);
			expect(execute).toHaveBeenCalledTimes(1);
			expect(commit).toHaveBeenCalledTimes(1);
			if (commitFailure) {
				expect(result.isError).toBe(true);
				expect(result.output).toContain("injected Agent terminal commit failure");
			} else {
				expect(result.isError).toBeFalsy();
				expect(result.output).toContain("ordinary provider failure");
			}
		} finally {
			execute.mockRestore();
			commit.mockRestore();
		}
	});

describe("foreground publication", () => {
	for (const { failure, executionFailure } of [
		{ failure: false, executionFailure: false },
		{ failure: false, executionFailure: true },
		{ failure: true, executionFailure: true },
	])
		test(`the caller resolves only after the terminal commit (failure=${failure}, executionFailure=${executionFailure})`, async () => {
			const f = await fixture(false);
			const { awaitAgentResultDetailed } = await import("../agent-communication");
			const facade = getRuntimePublicationService();
			const gate = Promise.withResolvers<void>();
			const entered = Promise.withResolvers<void>();
			let wakes = 0;
			runtimePublication.setWake(() => {
				wakes++;
			});
			const output = executionFailure
				? "FOREGROUND FAILURE WITHOUT ASSISTANT"
				: "FOREGROUND SUCCESS";
			const pass = await fakePass(f.child, output, !executionFailure, executionFailure);
			const original = facade.commitAgentTerminal;
			const commit = spyOn(facade, "commitAgentTerminal").mockImplementation(async (input) => {
				entered.resolve();
				await gate.promise;
				if (failure) throw new Error("foreground receipt unavailable");
				return original(input);
			});
			try {
				const handle = await startNarratorRun({
					narratorId: f.child,
					locale: "en",
					text: "",
					binding: f.binding,
					foreground: true,
				});
				expect(handle.started).toBe(true);
				let foregroundSettled = false;
				const foreground = handle.foreground.then(
					(value) => {
						foregroundSettled = true;
						return value;
					},
					(error: unknown) => {
						foregroundSettled = true;
						return error;
					},
				);
				const completion = handle.completion.then(
					(value) => value,
					(error: unknown) => error,
				);
				await entered.promise;
				// The caller has not received anything yet, and nothing reached its mailbox.
				expect(foregroundSettled).toBe(false);
				expect(parentRows(f.parent)).toHaveLength(0);
				gate.resolve();
				if (failure) {
					// Infrastructure failure retains the foreground Agent tool boundary.
					expect(await foreground).toEqual(new Error("foreground receipt unavailable"));
					expect(await completion).toBeInstanceOf(Error);
				} else {
					const result = await handle.foreground;
					expect(result).toMatchObject({ finalText: output, hasError: executionFailure });
					expect(result.output).toContain(output);
					// The stored terminal is the Await receipt, readable more than once.
					for (let i = 0; i < 2; i++)
						expect(
							await awaitAgentResultDetailed({
								callerNarratorId: f.parent,
								id: f.child,
								timeoutMs: 100,
								signal: new AbortController().signal,
							}),
						).toMatchObject({ terminalResultReceived: true });
				}
				await handle.terminal;
				expect(commit).toHaveBeenCalledTimes(1);
				expect(getExecutionOwner(f.child)).toBeUndefined();
				expect(listDeliveringRuns().some((row) => row.narratorId === f.child)).toBe(false);
				// The foreground consumed its own terminal: nothing is left to publish.
				expect(
					db
						.select()
						.from(runtimePublicationOutbox)
						.where(eq(runtimePublicationOutbox.taskId, f.child))
						.all()
						.filter((row) => row.state === "pending" || row.state === "reserved"),
				).toHaveLength(0);
				expect(parentRows(f.parent)).toHaveLength(0);
				expect(wakes).toBe(0);
			} finally {
				gate.resolve();
				pass.mockRestore();
				commit.mockRestore();
			}
		});
});

describe("a run that fails before its pass still ends once", () => {
	for (const phase of ["history", "pass"] as const) {
		test(`${phase} failure keeps committed events and publishes one failed terminal`, async () => {
			const f = await fixture(false);
			const history = await import("../agent-runtime/history");
			const orchestrator = await import("../agent-runtime/orchestrator");
			const failing =
				phase === "history"
					? spyOn(history, "buildRuntimeHistory").mockRejectedValue(
							new Error("history preparation failed"),
						)
					: spyOn(orchestrator, "runAgentLoopUnlocked").mockRejectedValue(
							new Error("pass preparation failed"),
						);
			// A registered run that already published its start.
			const run = (
				await getRuntimePublicationService().startRun({
					narratorId: f.child,
					binding: f.binding,
				})
			).publication!;
			runtimePublication.store.reserveRunSlots(run, { started: true });
			runtimePublication.store.commitIntent({
				...run,
				eventKind: "started",
				resultRef: "message:existing",
				summary: "existing result",
			});
			const rows = () =>
				db
					.select()
					.from(runtimePublicationOutbox)
					.where(eq(runtimePublicationOutbox.logicalRunId, run.logicalRunId))
					.all();
			const committed = rows().filter((row) => row.state !== "reserved");
			expect(committed).toHaveLength(1);
			try {
				const handle = await startNarratorRun({
					narratorId: f.child,
					locale: "en",
					text: "continue",
					resumeRunId: run.logicalRunId,
				});
				// A thrown pass rejects completion; a failed preparation inside the pass
				// returns an error outcome. Either way the run ends once, as failed.
				await handle.completion.catch(() => {});
				const terminal = await handle.terminal;
				expect(terminal.hasError).toBe(true);
				expect(terminal.finalText).toContain(`${phase} preparation failed`);
				// The registered run continued; no second logical run was started.
				expect(
					db.select().from(narrators).where(eq(narrators.id, f.child)).get()?.logicalRunId,
				).toBe(run.logicalRunId);
				const after = rows();
				// The committed start survives, no slot stays reserved, one terminal exists.
				for (const row of committed)
					expect(after.find((candidate) => candidate.id === row.id)).toBeDefined();
				expect(after.filter((row) => row.state === "reserved")).toHaveLength(0);
				expect(String(toolOutput(f.toolCallId))).toContain(`${phase} preparation failed`);
				expect(getExecutionOwner(f.child)).toBeUndefined();
			} finally {
				failing.mockRestore();
			}
		});
	}
});

// A detached run delivers through the exact registered tool call (or its running task),
// and nothing becomes visible to the parent before that transaction commits.
describe("detached publication waits for the exact parent tool transaction", () => {
	for (const background of [false, true])
		for (const deliver of [true, false]) {
			test(`background=${background}, deliver=${deliver}`, async () => {
				const f = await fixture(background);
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
				const pass = await fakePass(f.child, "NEW RESULT", true);
				const originalConclusion = session.updateToolCallConclusion;
				const conclusion = spyOn(session, "updateToolCallConclusion").mockImplementation(
					async (input) => {
						entered.resolve();
						await gate.promise;
						return originalConclusion(input);
					},
				);
				try {
					let resumeRunId: string | undefined;
					if (background) {
						// The task projection registers the run; the run service adopts it.
						const task = await backgroundTaskService.createAgentTask({
							id: f.child,
							subagentNarratorId: f.child,
							subagentType: "general",
							binding: f.binding,
						});
						resumeRunId = task.logicalRunId ?? undefined;
					}
					const handle = await startNarratorRun({
						narratorId: f.child,
						locale: "en",
						text: "",
						...(resumeRunId ? { resumeRunId } : { binding: f.binding }),
						deliver,
					});
					if (deliver && !background) {
						await entered.promise;
						await runtimePublication.flushRecipient(f.parent);
						expect(parentRows(f.parent)).toHaveLength(0);
						expect(
							db
								.select()
								.from(runtimePublicationOutbox)
								.where(eq(runtimePublicationOutbox.state, "pending"))
								.all(),
						).toHaveLength(0);
						expect(wakes).toBe(0);
						expect(toolOutput(f.toolCallId)).toBe("OLD RESULT");
					}
					gate.resolve();
					await handle.terminal;
					await runtimePublication.flushRecipient(f.parent);
					const notices = parentRows(f.parent).filter((row) => row.kind === "task_notice");
					expect(notices).toHaveLength(deliver ? 1 : 0);
					if (background && !deliver) {
						// Intentional semantic change (unified runtime): a run started with
						// deliver=false delivers nothing, so it also notifies nothing — not even
						// for a background task. The old background runner still sent one task
						// notice here (1); the unified finalizer sends none (0). Not delivering
						// means not notifying.
						expect(notices).toHaveLength(0);
						expect(controlEvents).toHaveLength(0);
						expect(wakes).toBe(0);
					}
					// Background delivery goes through the task card, never the tool result.
					if (!deliver || background) expect(toolOutput(f.toolCallId)).toBe("OLD RESULT");
					else expect(String(toolOutput(f.toolCallId))).toContain("NEW RESULT");
					expect(pass).toHaveBeenCalledTimes(1);
					expect(controlEvents).toHaveLength(background && deliver ? 1 : 0);
					if (background && deliver)
						expect((await backgroundTaskService.getById(f.child))?.status).toBe("completed");
				} finally {
					gate.resolve();
					eventBus.offAny(watch);
					pass.mockRestore();
					conclusion.mockRestore();
				}
			}, 10000);
		}
});
