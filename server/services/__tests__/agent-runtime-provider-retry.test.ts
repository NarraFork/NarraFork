import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessages, narrators } from "../../db/schema";
import type { RuntimeProfile } from "../agent-runtime/input";
import { runtimePolicyForContext } from "../agent-runtime/policy";
import type { ExecuteLoopOptions } from "../narrator-executor";
import type { ActiveNarrator } from "../narrator-session-state";

// Real configured provider classification, real provider history and the real outer
// runtime; only model I/O and its bounded delay are replaced. Run in an isolated process.
const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { settings, usesStatefulModel } = await import("../../lib/settings");
const { runAgentLoopUnlocked } = await import("../agent-runtime/orchestrator");
const { buildRuntimeHistory } = await import("../agent-runtime/history");
const { tryClaimExecution, getExecutionOwner } = await import("../agent-runtime/ownership");
const { activeNarrators } = await import("../narrator-session-state");
const { narratorService } = await import("../narrator-service");
const executor = await import("../narrator-executor");
const recovery = await import("../narrator-recovery");
const ws = await import("../../websocket/narrator-ws");
const savedOpenai = settings.openaiProviders;
const savedAnthropic = settings.anthropicProviders;
const savedMaxToolCallsPerResponse = settings.agent.maxToolCallsPerResponse;
const ids = ["retry-parent", "retry-primary", "retry-child"];
const marker = "CONTINUATION_CONTEXT Self-continuations left: 5";

beforeEach(() => cleanDb(sqlite));
afterEach(() => {
	for (const id of ids) {
		getExecutionOwner(id)?.release();
		activeNarrators.delete(id);
	}
	settings.openaiProviders = savedOpenai;
	settings.anthropicProviders = savedAnthropic;
	settings.agent.maxToolCallsPerResponse = savedMaxToolCallsPerResponse;
	mock.restore();
});
afterAll(() => mock.module("../../db", () => realDb));

function session(id: string, model: string, provider: string): ActiveNarrator {
	return {
		narratorId: id,
		conversationId: `original-${id}`,
		cwd: process.env.HOME as string,
		model,
		provider,
		systemPrompt: null,
		events: new EventEmitter(),
		alive: true,
		locale: "en",
		abortController: new AbortController(),
		_enabledOptionalTools: new Set(),
		_disabledTools: new Set(),
		_blockedSkills: { all: false, names: new Set() },
		_substatus: new Set(),
	};
}

describe("tool-call limit stops the real runtime without locking later user turns", () => {
	for (const kind of ["primary", "subagent"] as const) {
		test(`${kind}: configured limit aborts once and suppresses retry and inbox wake`, async () => {
			const prefix = "runtime_tool_limit";
			const model = `${prefix}:gpt-5`;
			settings.agent.maxToolCallsPerResponse = 7;
			settings.openaiProviders = [
				{
					id: prefix,
					name: prefix,
					prefix,
					apiKey: "test-only",
					baseUrl: "https://example.invalid/v1",
					defaultModel: "gpt-5",
					apiMode: "responses",
				},
			];
			const id = kind === "primary" ? "retry-primary" : "retry-child";
			const now = new Date().toISOString();
			for (const target of ["retry-parent", id]) {
				await db.insert(narrators).values({
					id: target,
					type: target === "retry-child" ? "subagent" : "primary",
					variant: target === "retry-child" ? "subagent:general" : "primary",
					parentNarratorId: target === "retry-child" ? "retry-parent" : null,
					model,
					autoContinuationOverride: "off",
					cwd: process.env.HOME,
					createdAt: now,
					updatedAt: now,
				});
			}
			const profile: RuntimeProfile =
				kind === "primary"
					? { kind }
					: {
							kind,
							parentNarratorId: "retry-parent",
							parentToolUseId: "origin-tool",
							subagentType: "general",
							systemPrompt: "tool limit contract",
							initialHistory: [],
						};
			const active = session(id, model, prefix);
			activeNarrators.set(id, active);
			const owner = tryClaimExecution(id, kind);
			if (!owner) throw new Error("Missing tool-limit owner");
			const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
				expect(options.config.maxToolCallsPerResponse).toBe(7);
				expect(options.config.signal.aborted).toBe(false);
				expect(options.config.onToolCallLimitExceeded).toBeDefined();
				options.config.onToolCallLimitExceeded?.(7);
				expect(options.config.signal.aborted).toBe(true);
				// Even if a pass carries a recovery hint, the limit must win first.
				return {
					finalText: "",
					hasError: false,
					shouldUpdateTitle: false,
					retryableError: "transient failure after limit",
					interrupted: true,
				};
			});
			const retry = spyOn(recovery, "handleTransientError").mockResolvedValue({
				shouldRetry: true,
				delayMs: 0,
			});
			const outcome = await runAgentLoopUnlocked(
				active,
				owner,
				"first user input",
				undefined,
				profile,
			);
			expect(execute).toHaveBeenCalledTimes(1);
			expect(retry).not.toHaveBeenCalled();
			expect(outcome.hasError).toBe(true);
			expect(outcome.allowInboxWake).toBe(false);
			const stopped = await narratorService.getById(id);
			expect(stopped.status).toBe("idle");
			expect(stopped.substatus).toContain("interrupted");

			// A separate explicit user turn gets a fresh controller and local limit flag.
			owner.release();
			const next = session(id, model, prefix);
			activeNarrators.set(id, next);
			const nextOwner = tryClaimExecution(id, kind);
			if (!nextOwner) throw new Error("Missing new user-turn owner");
			execute.mockImplementation(async (options) => {
				expect(options.config.signal.aborted).toBe(false);
				expect(options.userText).toBe('<sender kind="system" />\nnew explicit user input');
				return {
					finalText: "finished",
					hasError: false,
					shouldUpdateTitle: false,
					completedNaturally: true,
					completedAssistantTurn: true,
				};
			});
			const resumed = await runAgentLoopUnlocked(
				next,
				nextOwner,
				"new explicit user input",
				undefined,
				profile,
			);
			expect(execute).toHaveBeenCalledTimes(2);
			expect(retry).not.toHaveBeenCalled();
			expect(resumed.hasError).toBe(false);
			expect(resumed.allowInboxWake).toBe(true);
			expect(resumed.finalText).toBe("finished");
		});
	}
});

describe("provider retry policy is identical through the real primary and child runtime", () => {
	for (const kind of ["primary", "subagent"] as const) {
		for (const mode of ["responses", "anthropic"] as const) {
			test(`${kind} / ${mode}: retry preserves one context and follows provider statefulness`, async () => {
				const prefix = `runtime_retry_${mode}`;
				const model = `${prefix}:${mode === "responses" ? "gpt-5" : "claude-sonnet-4"}`;
				const config = {
					id: prefix,
					name: prefix,
					prefix,
					apiKey: "test-only",
					baseUrl: "https://example.invalid/v1",
					defaultModel: model.split(":")[1],
				};
				if (mode === "responses") settings.openaiProviders = [{ ...config, apiMode: "responses" }];
				else settings.anthropicProviders = [{ ...config, officialApi: false }];
				expect(usesStatefulModel(prefix, model)).toBe(mode === "responses");
				const id = kind === "primary" ? "retry-primary" : "retry-child";
				const now = new Date().toISOString();
				for (const target of ["retry-parent", id]) {
					await db.insert(narrators).values({
						id: target,
						type: target === "retry-child" ? "subagent" : "primary",
						variant: target === "retry-child" ? "subagent:general" : "primary",
						parentNarratorId: target === "retry-child" ? "retry-parent" : null,
						model,
						autoContinuationOverride: "off",
						cwd: process.env.HOME,
						createdAt: now,
						updatedAt: now,
					});
				}
				await narratorService.persistSystemMessage(
					id,
					marker,
					undefined,
					undefined,
					undefined,
					kind === "subagent" ? { parentToolUseId: "origin-tool" } : undefined,
				);
				const prepared = await buildRuntimeHistory({
					narratorId: id,
					model,
					provider: prefix,
					profile: kind,
				});
				const profile: RuntimeProfile =
					kind === "primary"
						? { kind }
						: {
								kind,
								parentNarratorId: "retry-parent",
								parentToolUseId: "origin-tool",
								subagentType: "general",
								systemPrompt: "retry contract",
								initialHistory: prepared.history,
								initialTrailingToolResults: prepared.trailingToolResults,
							};
				const active = session(id, model, prefix);
				activeNarrators.set(id, active);
				const owner = tryClaimExecution(id, kind);
				if (!owner) throw new Error("Missing retry owner");
				const calls: Array<{ packet: string; conversation: string; reset: boolean | undefined }> =
					[];
				spyOn(executor, "executeAgentLoop").mockImplementation(
					async (options: ExecuteLoopOptions) => {
						const runtimePolicy = options.config.runtimePolicy;
						if (!runtimePolicy)
							throw new Error("Real shared config must carry its resolved policy");
						expect(runtimePolicy.variant).toBe(kind);
						expect(runtimePolicyForContext(options.config)).toBe(runtimePolicy);
						calls.push({
							packet: JSON.stringify({
								text: options.userText,
								history: options.history,
								tools: options.trailingToolResults,
							}),
							conversation: options.config.conversationId,
							reset: options.config.resetUpstreamSessionOnFirstRequest,
						});
						if (calls.length > 2) throw new Error("Unexpected extra retry or continuation");
						return calls.length === 1
							? {
									finalText: "stale success text",
									hasError: false,
									shouldUpdateTitle: false,
									retryableError: "configured provider transient failure",
								}
							: {
									finalText: "finished",
									hasError: false,
									shouldUpdateTitle: false,
									completedNaturally: true,
									completedAssistantTurn: true,
								};
					},
				);
				const delay = spyOn(recovery, "handleTransientError").mockResolvedValue({
					shouldRetry: true,
					delayMs: 0,
				});
				const outcome = await runAgentLoopUnlocked(
					active,
					owner,
					kind === "subagent" ? prepared.currentText : "",
					undefined,
					profile,
				);
				expect(outcome.hasError).toBe(mode !== "responses");
				expect(calls).toHaveLength(mode === "responses" ? 2 : 1);
				expect(delay).toHaveBeenCalledTimes(mode === "responses" ? 1 : 0);
				for (const call of calls)
					expect(call.packet.match(/CONTINUATION_CONTEXT/g)).toHaveLength(1);
				if (mode === "responses") {
					// Recovery must keep conversationId so prompt_cache_key stays stable.
					expect(calls[1].conversation).toBe(calls[0].conversation);
					expect(calls[1].reset).toBe(true);
					expect(outcome.finalText).toBe("finished");
				} else {
					expect(outcome.finalText).toBe("configured provider transient failure");
					expect(outcome.finalText).not.toContain("stale success");
				}
				const rows = await db
					.select()
					.from(narratorMessages)
					.where(eq(narratorMessages.narratorId, id));
				expect(rows.filter((row) => row.role === "sys" && row.contentText === marker)).toHaveLength(
					1,
				);
			});
		}
	}
});

describe("subagent transient-retry recovery notifies the parent", () => {
	// Regression: the unified runtime dropped the recovery broadcast, so a subagent
	// that recovered from a transient retry kept its stale "retry N/M" badge in the
	// parent panel for the whole remaining run — the badge clears only on
	// subagent_status_changed / subagent_conclusion_updated, and an already-working
	// subagent emits neither mid-run.
	test("successful pass after a transient retry broadcasts subagent_status_changed to the parent", async () => {
		const prefix = "runtime_retry_recovered";
		const model = `${prefix}:gpt-5`;
		settings.openaiProviders = [
			{
				id: prefix,
				name: prefix,
				prefix,
				apiKey: "test-only",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "gpt-5",
				apiMode: "responses",
			},
		];
		const id = "retry-child";
		const now = new Date().toISOString();
		for (const target of ["retry-parent", id]) {
			await db.insert(narrators).values({
				id: target,
				type: target === "retry-child" ? "subagent" : "primary",
				variant: target === "retry-child" ? "subagent:general" : "primary",
				parentNarratorId: target === "retry-child" ? "retry-parent" : null,
				model,
				autoContinuationOverride: "off",
				cwd: process.env.HOME,
				createdAt: now,
				updatedAt: now,
			});
		}
		const profile: RuntimeProfile = {
			kind: "subagent",
			parentNarratorId: "retry-parent",
			parentToolUseId: "origin-tool",
			subagentType: "general",
			systemPrompt: "retry recovered contract",
			initialHistory: [],
		};
		const active = session(id, model, prefix);
		activeNarrators.set(id, active);
		const owner = tryClaimExecution(id, "subagent");
		if (!owner) throw new Error("Missing retry-recovered owner");
		let calls = 0;
		spyOn(executor, "executeAgentLoop").mockImplementation(async () => {
			calls++;
			return calls === 1
				? {
						finalText: "",
						hasError: false,
						shouldUpdateTitle: false,
						retryableError: "configured provider transient failure",
					}
				: {
						finalText: "finished",
						hasError: false,
						shouldUpdateTitle: false,
						completedNaturally: true,
						completedAssistantTurn: true,
					};
		});
		spyOn(recovery, "handleTransientError").mockResolvedValue({
			shouldRetry: true,
			delayMs: 0,
		});
		const broadcast = spyOn(ws, "broadcastToNarrator").mockImplementation(() => {});
		const outcome = await runAgentLoopUnlocked(
			active,
			owner,
			"first user input",
			undefined,
			profile,
		);

		expect(outcome.finalText).toBe("finished");
		expect(calls).toBe(2);
		expect(broadcast).toHaveBeenCalledWith("retry-parent", {
			type: "subagent_status_changed",
			narratorId: "retry-parent",
			subagentNarratorId: id,
			status: "working",
		});
	});
});

describe("runtime outcome distinguishes resource cleanup from user cancellation", () => {
	for (const kind of ["primary", "subagent"] as const) {
		for (const ending of ["success", "error", "interrupted"] as const) {
			test(`${kind}: ${ending} retains its real outcome after cleanup`, async () => {
				const prefix = "runtime_finalization";
				const model = `${prefix}:gpt-5`;
				settings.openaiProviders = [
					{
						id: prefix,
						name: prefix,
						prefix,
						apiKey: "test-only",
						baseUrl: "https://example.invalid/v1",
						defaultModel: "gpt-5",
						apiMode: "responses",
					},
				];
				const id = kind === "primary" ? "retry-primary" : "retry-child";
				const now = new Date().toISOString();
				for (const target of ["retry-parent", id]) {
					await db.insert(narrators).values({
						id: target,
						type: target === "retry-child" ? "subagent" : "primary",
						variant: target === "retry-child" ? "subagent:general" : "primary",
						parentNarratorId: target === "retry-child" ? "retry-parent" : null,
						model,
						autoContinuationOverride: "off",
						cwd: process.env.HOME,
						createdAt: now,
						updatedAt: now,
					});
				}
				const profile: RuntimeProfile =
					kind === "primary"
						? { kind }
						: {
								kind,
								parentNarratorId: "retry-parent",
								parentToolUseId: "origin-tool",
								subagentType: "general",
								systemPrompt: "finalization contract",
								initialHistory: [],
							};
				const active = session(id, model, prefix);
				activeNarrators.set(id, active);
				const owner = tryClaimExecution(id, kind);
				if (!owner) throw new Error("Missing finalization owner");
				spyOn(executor, "executeAgentLoop").mockImplementation(async () => {
					if (ending === "interrupted") active.abortController.abort();
					return {
						finalText: ending === "error" ? "provider failed" : "final response",
						hasError: ending === "error",
						interrupted: ending === "interrupted",
						shouldUpdateTitle: false,
						completedNaturally: ending === "success",
						completedAssistantTurn: ending === "success",
					};
				});
				const outcome = await runAgentLoopUnlocked(active, owner, "input", undefined, profile);
				expect(outcome.started).toBe(true);
				expect(outcome.allowInboxWake).toBe(ending === "success");
				expect(outcome.aborted).toBe(ending === "interrupted");
				expect(outcome.hasError).toBe(ending === "error");
				if (kind === "primary") expect(active.abortController.signal.aborted).toBe(true);
				if (ending === "success") expect(outcome.finalText).toBe("final response");
				if (ending === "error") {
					expect(outcome.finalText).toBe("provider failed");
					expect((await narratorService.getById(id)).lastStopReason).toBe("error");
				}
			});
		}
	}
});
