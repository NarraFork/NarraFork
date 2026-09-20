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
const savedOpenai = settings.openaiProviders;
const savedAnthropic = settings.anthropicProviders;
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
