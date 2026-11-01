import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaRefToContentBlock } from "@shared/media-attachments";
import { eq } from "drizzle-orm";
import { historyStrings } from "../../../tests/fixtures/model-input";
import { wavBytes, webmBytes } from "../../../tests/fixtures/native-media";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	backgroundTasks,
	narratorBlocks,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import { getMediaPath, saveUploadedMedia } from "../../lib/media-uploads";
import { setUploadsDirForTests } from "../../lib/uploads";
import type { RunControl } from "../agent-runtime/ownership";
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
const { tryClaimExecution, getExecutionOwner, setRunControl } = await import(
	"../agent-runtime/ownership"
);
const { activeNarrators } = await import("../narrator-session-state");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const { narratorService } = await import("../narrator-service");
const executor = await import("../narrator-executor");
const runtimeSession = await import("../narrator-session");
const { writeSpecFile } = await import("../spec-vfs-service");
const { readSpecContinuationState } = runtimeSession;
const recovery = await import("../narrator-recovery");
const { compileDelegationCeiling } = await import("../custom-subagent-service");
const { withRuntimePolicyTrait } = await import("../../lib/runtime-policy-trait");
const ws = await import("../../websocket/narrator-ws");
const savedOpenai = settings.openaiProviders;
const savedAnthropic = settings.anthropicProviders;
const savedGemini = settings.geminiProviders;
let mediaTestDir: string | undefined;
const savedMaxToolCallsPerResponse = settings.agent.maxToolCallsPerResponse;
const ids = ["retry-parent", "retry-primary", "retry-child"];
const marker = "CONTINUATION_CONTEXT Self-continuations left: 5";
// A delegated session is an ordinary session plus a registered result destination.
const delegatedRegistration = {
	version: 1 as const,
	run: {
		logicalRunId: "retry-run",
		deliverTo: { narratorId: "retry-parent", toolUseId: "origin-tool" },
	},
};
// The delegation's capability ceiling, compiled from its template at creation.
const delegatedTraits = withRuntimePolicyTrait([], await compileDelegationCeiling("general"));

beforeEach(async () => {
	backgroundOccupancyStore.resetForTests();
	cleanDb(sqlite);
	await backgroundOccupancyStore.start();
});
afterEach(async () => {
	for (const id of ids) {
		getExecutionOwner(id)?.release();
		activeNarrators.delete(id);
	}
	settings.openaiProviders = savedOpenai;
	settings.anthropicProviders = savedAnthropic;
	settings.geminiProviders = savedGemini;
	setUploadsDirForTests(null);
	if (mediaTestDir) rmSync(mediaTestDir, { recursive: true, force: true });
	mediaTestDir = undefined;
	settings.agent.maxToolCallsPerResponse = savedMaxToolCallsPerResponse;
	await backgroundOccupancyStore.flush();
	mock.restore();
});
afterAll(() => {
	backgroundOccupancyStore.resetForTests();
	mock.module("../../db", () => realDb);
});

// Direct SQL fixtures must publish the same entity-specific maintenance as production writes.
async function seedNarrator(row: typeof narrators.$inferInsert): Promise<void> {
	await db.insert(narrators).values(row);
	backgroundOccupancyStore.refreshNarrator(row.id);
}

async function seedTask(row: typeof backgroundTasks.$inferInsert): Promise<void> {
	await db.insert(backgroundTasks).values(row);
	backgroundOccupancyStore.refreshTask(row.id);
}

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

async function reasoningIdleFixture(kind: "primary" | "subagent", autoContinuation = false) {
	const prefix = "runtime_reasoning_idle";
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
		await seedNarrator({
			id: target,
			type: target === "retry-child" ? "subagent" : "primary",
			variant: target === "retry-child" ? "subagent:general" : "primary",
			parentNarratorId: target === "retry-child" ? "retry-parent" : null,
			// The delegated session's run delivers to the parent's call (its own turns).
			runtimeRegistrationJson:
				target === "retry-child"
					? {
							version: 1,
							run: {
								logicalRunId: "reasoning-idle-run",
								deliverTo: { narratorId: "retry-parent", toolUseId: "origin-tool" },
							},
						}
					: null,
			model,
			autoContinuationOverride: autoContinuation ? "always" : "off",
			cwd: process.env.HOME,
			createdAt: now,
			updatedAt: now,
		});
	}
	const active = session(id, model, prefix);
	activeNarrators.set(id, active);
	const owner = tryClaimExecution(id, "run");
	if (!owner) throw new Error("Missing reasoning-idle owner");
	const run: RunControl | undefined =
		kind === "primary"
			? undefined
			: {
					startedAt: Date.now(),
					cancel: new AbortController(),
					timedOut: false,
					terminal: new Promise(() => {}),
					deliverTo: { narratorId: "retry-parent", toolUseId: "origin-tool" },
				};
	if (run) setRunControl(owner, run);
	return { id, model, prefix, now, run, active, owner };
}

const reasoningIdleResult = {
	finalText: "",
	hasError: false,
	shouldUpdateTitle: false,
	completedNaturally: true,
	reasoningOnlyIdle: true,
};

async function openReasoningIdleTask(id: string) {
	await writeSpecFile(
		id,
		"spec://tasks.json",
		JSON.stringify({ tasks: [{ text: "Finish the pending implementation", status: "doing" }] }),
		{ actor: "agent", createdBy: "assistant" },
	);
	expect((await readSpecContinuationState(id)).openTask?.status).toBe("doing");
}

describe("reasoning-only idle uses the real runtime's work and input provenance", () => {
	for (const background of ["agent", "task", "service", "none", "completed"] as const) {
		test(`primary / ${background}: only live background work permits idle`, async () => {
			const expected = background === "agent" || background === "task";
			const fixture = await reasoningIdleFixture("primary", expected);
			const { id, now, active, owner, run } = fixture;
			if (background === "agent") {
				await seedNarrator({
					id: "retry-child",
					type: "subagent",
					variant: "subagent:general",
					parentNarratorId: id,
					status: "working",
					isBackground: true,
					createdAt: now,
					updatedAt: now,
				});
			}
			if (background !== "none") {
				await seedTask({
					id: "reasoning-idle-background",
					parentNarratorId: id,
					type: background === "agent" ? "agent" : "bash",
					backgroundKind: background === "service" ? "service" : "task",
					subagentNarratorId: background === "agent" ? "retry-child" : null,
					status: background === "completed" ? "completed" : "running",
					startedAt: now,
					createdAt: now,
					updatedAt: now,
				});
			}
			if (expected) await openReasoningIdleTask(id);
			const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
				if (execute.mock.calls.length > 1) throw new Error("Idle must not restart open Spec work");
				options.config.onModelInputConsumed?.(options.history.built ?? [], options.userText);
				expect(await options.config.shouldIdleOnReasoningOnly?.()).toBe(expected);
				return { ...reasoningIdleResult, reasoningOnlyIdle: expected };
			});
			const outcome = await runAgentLoopUnlocked(active, owner, "input", undefined, run);
			expect(execute).toHaveBeenCalledTimes(1);
			expect(outcome.hasError).toBe(false);
			expect((await narratorService.getById(id)).status).toBe("idle");
			if (expected) {
				expect((await readSpecContinuationState(id)).openTask?.status).toBe("doing");
			}
		});
	}

	for (const tail of ["mailbox", "user", "assistant"] as const) {
		test(`subagent / ${tail}: built history preserves only trusted mailbox tail provenance`, async () => {
			const expected = tail === "mailbox";
			const { id, active, owner, run } = await reasoningIdleFixture("subagent", expected);
			// A quiet mailbox pass must not replay an answer from an earlier turn.
			await narratorService.persistAssistantMessage(id, {
				uuid: "reasoning-idle-old-assistant",
				session_id: "reasoning-idle-session",
				parent_tool_use_id: "origin-tool",
				message: { content: [{ type: "text", text: "stale assistant answer" }] },
			});
			await narratorService.persistSystemMessage(
				id,
				"Mailbox update",
				[
					{
						type: "system_injection",
						source: "subagent_message",
						modelText: "Mailbox update",
						body: {
							kind: "messages",
							items: [{ fromId: "retry-parent", fromTitle: "Parent", text: "Mailbox update" }],
						},
					},
				],
				undefined,
				undefined,
				{ parentToolUseId: "origin-tool" },
			);
			if (tail === "user") {
				await narratorService.persistUserMessage(
					id,
					'<sender kind="agent" id="retry-parent" />\nordinary user text',
					undefined,
					undefined,
					undefined,
					undefined,
					{ parentToolUseId: "origin-tool" },
				);
			} else if (tail === "assistant") {
				await narratorService.persistAssistantMessage(id, {
					uuid: "reasoning-idle-assistant",
					session_id: "reasoning-idle-session",
					parent_tool_use_id: "origin-tool",
					message: { content: [{ type: "text", text: "ordinary assistant text" }] },
				});
			}
			if (expected) await openReasoningIdleTask(id);
			const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
				if (execute.mock.calls.length > 1) throw new Error("Idle must not restart open Spec work");
				options.config.onModelInputConsumed?.(options.history.built ?? [], options.userText);
				expect(await options.config.shouldIdleOnReasoningOnly?.()).toBe(expected);
				return { ...reasoningIdleResult, reasoningOnlyIdle: expected };
			});
			const outcome = await runAgentLoopUnlocked(active, owner, "", undefined, run);
			expect(execute).toHaveBeenCalledTimes(1);
			expect(outcome.hasError).toBe(false);
			if (expected) {
				expect(outcome.finalText).toBe("");
				expect((await narratorService.getById(id)).status).toBe("idle");
				expect((await readSpecContinuationState(id)).openTask?.status).toBe("doing");
			}
		});
	}

	test("busy subagent changes mailbox provenance only when after-tools input is consumed", async () => {
		const { active, owner, run } = await reasoningIdleFixture("subagent");
		const consumed = mock(() => {});
		const drain = spyOn(runtimeSession, "drainInjectionsIntoHistory");
		const execute = spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
			options.config.onModelInputConsumed?.(options.history.built ?? [], options.userText);
			expect(await options.config.shouldIdleOnReasoningOnly?.()).toBe(false);
			for (const step of [
				{ parts: [{ text: "mailbox update" }], mailbox: true, before: false, after: true },
				{ parts: [], mailbox: false, before: true, after: true },
				{ parts: [{ text: "ordinary guidance" }], mailbox: false, before: true, after: false },
			]) {
				drain.mockResolvedValueOnce({
					text: step.parts.map((part) => part.text).join("\n"),
					parts: step.parts,
					lastInputWasMailbox: step.mailbox,
					onConsumed: consumed,
				});
				const input = await options.config.getAfterToolsInjections?.();
				if (!input || typeof input === "string") throw new Error("Expected structured drain input");
				expect(await options.config.shouldIdleOnReasoningOnly?.()).toBe(step.before);
				input.onConsumed?.();
				expect(await options.config.shouldIdleOnReasoningOnly?.()).toBe(step.after);
				// Provider retries re-adopt the same packet, but do not repeat onConsumed.
				options.config.onModelInputConsumed?.(options.history.built ?? [], options.userText);
				expect(await options.config.shouldIdleOnReasoningOnly?.()).toBe(step.after);
			}
			expect(consumed).toHaveBeenCalledTimes(3);
			options.config.onModelInputConsumed?.(options.history.built ?? [], "a new user turn");
			expect(await options.config.shouldIdleOnReasoningOnly?.()).toBe(false);
			return { ...reasoningIdleResult, reasoningOnlyIdle: false };
		});
		const outcome = await runAgentLoopUnlocked(active, owner, "ordinary input", undefined, run);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(drain).toHaveBeenCalledTimes(3);
		expect(outcome.hasError).toBe(false);
	});
});

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
				await seedNarrator({
					id: target,
					type: target === "retry-child" ? "subagent" : "primary",
					variant: target === "retry-child" ? "subagent:general" : "primary",
					parentNarratorId: target === "retry-child" ? "retry-parent" : null,
					runtimeRegistrationJson: target === "retry-child" ? delegatedRegistration : null,
					model,
					autoContinuationOverride: "off",
					cwd: process.env.HOME,
					createdAt: now,
					updatedAt: now,
				});
			}
			const active = session(id, model, prefix);
			activeNarrators.set(id, active);
			const owner = tryClaimExecution(id, "run");
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
			const outcome = await runAgentLoopUnlocked(active, owner, "first user input", undefined);
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
			const nextOwner = tryClaimExecution(id, "run");
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
					await seedNarrator({
						id: target,
						type: target === "retry-child" ? "subagent" : "primary",
						variant: target === "retry-child" ? "subagent:general" : "primary",
						parentNarratorId: target === "retry-child" ? "retry-parent" : null,
						runtimeRegistrationJson: target === "retry-child" ? delegatedRegistration : null,
						traits: target === "retry-child" ? delegatedTraits : [],
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
				const active = session(id, model, prefix);
				activeNarrators.set(id, active);
				const owner = tryClaimExecution(id, "run");
				if (!owner) throw new Error("Missing retry owner");
				const calls: Array<{ packet: string; conversation: string; reset: boolean | undefined }> =
					[];
				spyOn(executor, "executeAgentLoop").mockImplementation(
					async (options: ExecuteLoopOptions) => {
						const runtimePolicy = options.config.runtimePolicy;
						if (!runtimePolicy)
							throw new Error("Real shared config must carry its resolved policy");
						// Delegated rows resolve their stored template ceiling.
						expect(runtimePolicy.capabilities.spawnAgent).toBe(kind === "primary");
						expect(runtimePolicyForContext(options.config)).toBe(runtimePolicy);
						calls.push({
							packet: JSON.stringify({
								text: options.userText,
								history: options.history.built,
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
				const outcome = await runAgentLoopUnlocked(active, owner, "", undefined);
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

describe("native media survives the unified runtime without duplicate current lanes", () => {
	for (const kind of ["primary", "subagent"] as const) {
		for (const turn of ["text", "media-only", "sys-tail", "mailbox"] as const) {
			test(`${kind} / ${turn}: both attempts retain native bytes and durable refs`, async () => {
				const prefix = "runtime_native_media";
				const model = `${prefix}:gemini-2.5-flash`;
				settings.geminiProviders = [
					{
						id: prefix,
						name: prefix,
						prefix,
						apiKey: "test-only",
						baseUrl: "https://example.invalid/v1beta",
						defaultModel: "gemini-2.5-flash",
					},
				];
				mediaTestDir = mkdtempSync(join(tmpdir(), "runtime-native-media-"));
				setUploadsDirForTests(mediaTestDir);
				const id = kind === "primary" ? "retry-primary" : "retry-child";
				const now = new Date().toISOString();
				for (const target of ["retry-parent", id])
					await seedNarrator({
						id: target,
						type: target === "retry-child" ? "subagent" : "primary",
						variant: target === "retry-child" ? "subagent:general" : "primary",
						parentNarratorId: target === "retry-child" ? "retry-parent" : null,
						runtimeRegistrationJson: target === "retry-child" ? delegatedRegistration : null,
						traits: target === "retry-child" ? delegatedTraits : [],
						model,
						cwd: process.env.HOME,
						autoContinuationOverride: "off",
						createdAt: now,
						updatedAt: now,
					});
				const bytes = [wavBytes(), webmBytes([1, 2])];
				const files = [
					new File([new Uint8Array(bytes[0])], "voice.wav", { type: "audio/wav" }),
					new File([new Uint8Array(bytes[1])], "clip.webm", { type: "video/webm" }),
				];
				const refs = await Promise.all(
					files.map((file) => saveUploadedMedia("retry-parent", file)),
				);
				const text =
					turn === "media-only" || turn === "mailbox" ? "" : "Inspect native attachments";
				const persistedText = text || "[user sent media]";
				if (turn === "mailbox") {
					const { enqueueBufferedMessage } = await import("../narrator-buffer");
					expect(
						(
							await enqueueBufferedMessage(
								id,
								text,
								undefined,
								undefined,
								undefined,
								undefined,
								undefined,
								undefined,
								undefined,
								undefined,
								undefined,
								undefined,
								undefined,
								undefined,
								refs,
							)
						).ok,
					).toBe(true);
				} else if (kind === "subagent") {
					await narratorService.persistSubagentUserMessage(id, persistedText, "origin-tool", {
						media: refs,
					});
				} else
					await narratorService.persistUserMessage(id, persistedText, [
						...refs.map((ref) => mediaRefToContentBlock(ref)),
						{ type: "text", text },
					]);
				if (turn === "sys-tail")
					await narratorService.persistSystemMessage(
						id,
						marker,
						undefined,
						undefined,
						undefined,
						kind === "subagent" ? { parentToolUseId: "origin-tool" } : undefined,
					);
				const packets: string[] = [];
				let emptyPasses = 0;
				spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
					expect(options.media).toBeUndefined();
					const packet = JSON.stringify(options.history.built);
					if (turn === "mailbox" && !packet.includes(bytes[0].toString("base64"))) {
						expect(++emptyPasses).toBe(1);
						return {
							finalText: "ready",
							hasError: false,
							shouldUpdateTitle: false,
							completedNaturally: true,
							completedAssistantTurn: true,
						};
					}
					for (const data of bytes) expect(packet.split(data.toString("base64"))).toHaveLength(2);
					packets.push(packet);
					if (packets.length > 2) throw new Error("Unexpected extra native media attempt");
					return packets.length === 1
						? { finalText: "", hasError: false, shouldUpdateTitle: false, silentDisconnect: true }
						: {
								finalText: "finished",
								hasError: false,
								shouldUpdateTitle: false,
								completedNaturally: true,
								completedAssistantTurn: true,
							};
				});
				const retry = spyOn(recovery, "handleTransientError").mockResolvedValue({
					shouldRetry: true,
					delayMs: 0,
				});
				const active = session(id, model, prefix);
				activeNarrators.set(id, active);
				const owner = tryClaimExecution(id, "run");
				if (!owner) throw new Error("Missing native-media owner");
				const result = await runAgentLoopUnlocked(
					active,
					owner,
					turn === "mailbox" ? "" : persistedText,
					undefined,
					undefined,
					undefined,
					turn === "mailbox" ? undefined : refs,
				);
				expect(result.hasError).toBe(false);
				expect(result.finalText).toBe("finished");
				expect(packets).toHaveLength(2);
				expect(packets[1]).toBe(packets[0]);
				expect(retry).toHaveBeenCalledTimes(1);
				const rows = await db
					.select()
					.from(narratorMessages)
					.where(eq(narratorMessages.narratorId, id));
				const users = rows.filter((row) => row.role === "user");
				expect(users).toHaveLength(1);
				for (const ref of refs)
					expect(users[0].contentJson).toContainEqual(mediaRefToContentBlock(ref));
				for (const data of bytes)
					expect(JSON.stringify(rows)).not.toContain(data.toString("base64"));
				expect(JSON.stringify(rows)).not.toContain('"base64"');
			});
		}
	}
});

describe("unsupported native media preserves refs across retries and model changes", () => {
	for (const kind of ["primary", "subagent"] as const)
		for (const lane of ["current", "history"] as const)
			for (const modality of ["audio", "video"] as const) {
				test(`${kind} / ${lane} / ${modality}: fallback once then native replay`, async () => {
					const prefix = "runtime_media_fallback";
					const model = `${prefix}:gpt-5`;
					const capablePrefix = "runtime_media_capable";
					const capableModel = `${capablePrefix}:gemini-2.5-flash`;
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
					settings.geminiProviders = [
						{
							id: capablePrefix,
							name: capablePrefix,
							prefix: capablePrefix,
							apiKey: "test-only",
							baseUrl: "https://example.invalid/v1beta",
							defaultModel: "gemini-2.5-flash",
						},
					];
					mediaTestDir = mkdtempSync(join(tmpdir(), "runtime-media-fallback-"));
					setUploadsDirForTests(mediaTestDir);
					const id = kind === "primary" ? "retry-primary" : "retry-child";
					const now = new Date().toISOString();
					for (const target of ["retry-parent", id])
						await seedNarrator({
							id: target,
							type: target === "retry-child" ? "subagent" : "primary",
							variant: target === "retry-child" ? "subagent:general" : "primary",
							parentNarratorId: target === "retry-child" ? "retry-parent" : null,
							runtimeRegistrationJson: target === "retry-child" ? delegatedRegistration : null,
							traits: target === "retry-child" ? delegatedTraits : [],
							model,
							cwd: process.env.HOME,
							autoContinuationOverride: "off",
							createdAt: now,
							updatedAt: now,
						});
					const bytes = modality === "audio" ? wavBytes() : webmBytes([7, 8]);
					const file = new File(
						[new Uint8Array(bytes)],
						modality === "audio" ? "voice.wav" : "clip.webm",
						{ type: modality === "audio" ? "audio/wav" : "video/webm" },
					);
					const ref = await saveUploadedMedia("retry-parent", file);
					const block = mediaRefToContentBlock(ref);
					if (kind === "subagent")
						await narratorService.persistSubagentUserMessage(
							id,
							"[user sent media]",
							"origin-tool",
							{ media: [ref] },
						);
					else
						await narratorService.persistUserMessage(id, "[user sent media]", [
							block,
							{ type: "text", text: "" },
						]);
					const broadcast = spyOn(ws, "broadcastToNarrator").mockImplementation(() => {});
					const packets: string[] = [];
					const execute = spyOn(executor, "executeAgentLoop").mockImplementation(
						async (options) => {
							expect(options.media).toBeUndefined();
							const texts = historyStrings(options.history.built);
							const key = `"mediaId":${JSON.stringify(ref.mediaId)}`;
							expect(texts.split(key)).toHaveLength(2);
							expect(texts).toContain("当前模型未读取该文件的音视频内容");
							expect(texts).toContain(JSON.stringify(getMediaPath("retry-parent", ref.mediaId)));
							expect(texts).toContain(file.name);
							expect(texts).toContain(file.type);
							expect(texts).toContain(`"size":${file.size}`);
							const packet = JSON.stringify(options.history.built);
							expect(packet).not.toContain(bytes.toString("base64"));
							packets.push(packet);
							if (packets.length > 2) throw new Error("Unexpected fallback retry");
							return packets.length === 1
								? {
										finalText: "",
										hasError: false,
										shouldUpdateTitle: false,
										retryableError: "fallback transient failure",
									}
								: {
										finalText: "fallback finished",
										hasError: false,
										shouldUpdateTitle: false,
										completedNaturally: true,
										completedAssistantTurn: true,
									};
						},
					);
					const retry = spyOn(recovery, "handleTransientError").mockResolvedValue({
						shouldRetry: true,
						delayMs: 0,
					});
					let active = session(id, model, prefix);
					active.locale = "zh-CN";
					activeNarrators.set(id, active);
					let owner = tryClaimExecution(id, "run");
					if (!owner) throw new Error("Missing fallback owner");
					const result = await runAgentLoopUnlocked(
						active,
						owner,
						"[user sent media]",
						undefined,
						undefined,
						undefined,
						lane === "current" ? [ref] : undefined,
					);
					expect(result.finalText).toBe("fallback finished");
					expect(result.hasError).toBe(false);
					expect(packets).toHaveLength(2);
					expect(retry).toHaveBeenCalledTimes(1);
					const warnings = () =>
						broadcast.mock.calls.filter(
							([target, event]) =>
								target === id &&
								event.type === "warning" &&
								event.warningCode === "native_media_fallback",
						);
					expect(warnings()).toHaveLength(1);
					const warning = warnings()[0]?.[1];
					if (warning?.type !== "warning") throw new Error("Missing native fallback warning");
					expect(warning.message).toContain("未读取音视频内容");
					const rows = await db
						.select()
						.from(narratorMessages)
						.where(eq(narratorMessages.narratorId, id));
					const users = rows.filter((row) => row.role === "user");
					expect(users).toHaveLength(1);
					expect(users[0].contentJson).toContainEqual(block);
					expect(JSON.stringify(rows)).not.toContain("nativeMediaFallback");
					expect(JSON.stringify(rows)).not.toContain('"base64"');
					owner.release();
					activeNarrators.delete(id);
					await db.update(narrators).set({ model: capableModel }).where(eq(narrators.id, id));
					execute.mockImplementation(async (options) => {
						expect(options.media).toBeUndefined();
						expect(
							JSON.stringify(options.history.built).split(bytes.toString("base64")),
						).toHaveLength(2);
						expect(JSON.stringify(options.history.built)).not.toContain("回退到一般文件");
						return {
							finalText: "native restored",
							hasError: false,
							shouldUpdateTitle: false,
							completedNaturally: true,
							completedAssistantTurn: true,
						};
					});
					active = session(id, capableModel, capablePrefix);
					activeNarrators.set(id, active);
					owner = tryClaimExecution(id, "run");
					if (!owner) throw new Error("Missing native-restoration owner");
					expect(
						(
							await runAgentLoopUnlocked(
								active,
								owner,
								"[user sent media]",
								undefined,
								undefined,
								undefined,
								[ref],
							)
						).finalText,
					).toBe("native restored");
					expect(warnings()).toHaveLength(1);
					const unchanged = await db
						.select()
						.from(narratorMessages)
						.where(eq(narratorMessages.id, users[0].id));
					expect(unchanged[0].contentJson).toEqual(users[0].contentJson);
				});
			}
});

for (const kind of ["primary", "subagent"] as const)
	test(`native media real bodyFormat2 tool ledger replays after database reload (${kind})`, async () => {
		const prefix = "runtime_tool_media";
		const model = `${prefix}:gemini-2.5-flash`;
		settings.geminiProviders = [
			{
				id: prefix,
				name: prefix,
				prefix,
				apiKey: "test-only",
				baseUrl: "https://example.invalid/v1beta",
				defaultModel: "gemini-2.5-flash",
			},
		];
		mediaTestDir = mkdtempSync(join(tmpdir(), "runtime-tool-ledger-media-"));
		setUploadsDirForTests(mediaTestDir);
		const id = kind === "primary" ? "retry-primary" : "retry-child";
		const now = new Date().toISOString();
		for (const target of ["retry-parent", id])
			await seedNarrator({
				id: target,
				type: target === "retry-child" ? "subagent" : "primary",
				variant: target === "retry-child" ? "subagent:general" : "primary",
				parentNarratorId: target === "retry-child" ? "retry-parent" : null,
				runtimeRegistrationJson: target === "retry-child" ? delegatedRegistration : null,
				traits: target === "retry-child" ? delegatedTraits : [],
				model,
				cwd: process.env.HOME,
				autoContinuationOverride: "off",
				createdAt: now,
				updatedAt: now,
			});
		const bytes = wavBytes();
		const ref = await saveUploadedMedia(
			"retry-parent",
			new File([new Uint8Array(bytes)], "ledger.wav", { type: "audio/wav" }),
		);
		const block = mediaRefToContentBlock(ref);
		const { processEvent } = await import("../narrator-event-handler");
		spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
			await processEvent(
				{
					type: "assistant_message",
					text: "",
					toolUses: [
						{ toolUseId: "read-ledger", name: "Read", input: { file_path: "ledger.wav" } },
					],
				},
				options.eventContext,
				options.hooks,
			);
			await processEvent(
				{
					type: "tool_call",
					toolUseId: "read-ledger",
					toolName: "Read",
					input: { file_path: "ledger.wav" },
				},
				options.eventContext,
				options.hooks,
			);
			await processEvent(
				{
					type: "tool_result",
					toolUseId: "read-ledger",
					toolName: "Read",
					output: "Native audio attachment",
					mediaRefs: [block],
					isError: false,
				},
				options.eventContext,
				options.hooks,
			);
			return {
				finalText: "persisted",
				hasError: false,
				shouldUpdateTitle: false,
				completedNaturally: true,
				completedAssistantTurn: true,
			};
		});
		const active = session(id, model, prefix);
		activeNarrators.set(id, active);
		const owner = tryClaimExecution(id, "run");
		if (!owner) throw new Error("Missing ledger owner");
		expect((await runAgentLoopUnlocked(active, owner, "read audio")).hasError).toBe(false);
		const stored = await db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.narratorId, id));
		const calls = await db
			.select()
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.narratorId, id));
		expect(calls).toHaveLength(1);
		expect(calls[0].outputJson).toMatchObject({ _media: [block] });
		const message = stored.find((entry) => entry.id === calls[0].messageId);
		expect(message?.bodyFormat).toBe(2);
		const ledger = await db
			.select()
			.from(narratorBlocks)
			.where(eq(narratorBlocks.messageId, calls[0].messageId));
		expect(ledger.some((entry) => entry.kind === "tool" && entry.subtype === "Read")).toBe(true);
		for (const payload of [stored, calls, ledger])
			expect(JSON.stringify(payload)).not.toContain(bytes.toString("base64"));
		const before = JSON.stringify([stored, calls, ledger]);
		const { buildRuntimeHistory } = await import("../agent-runtime/history");
		const reloaded = await buildRuntimeHistory({ narratorId: id, model, provider: prefix });
		expect(JSON.stringify(reloaded.history).split(bytes.toString("base64"))).toHaveLength(2);
		expect(JSON.stringify(reloaded.modelMessages)).toContain(ref.mediaId);
		expect(
			JSON.stringify([
				await db.select().from(narratorMessages).where(eq(narratorMessages.narratorId, id)),
				await db.select().from(narratorToolCalls).where(eq(narratorToolCalls.narratorId, id)),
				await db
					.select()
					.from(narratorBlocks)
					.where(eq(narratorBlocks.messageId, calls[0].messageId)),
			]),
		).toBe(before);
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
			await seedNarrator({
				id: target,
				type: target === "retry-child" ? "subagent" : "primary",
				variant: target === "retry-child" ? "subagent:general" : "primary",
				parentNarratorId: target === "retry-child" ? "retry-parent" : null,
				runtimeRegistrationJson:
					target === "retry-child"
						? {
								version: 1,
								run: {
									logicalRunId: "retry-run",
									deliverTo: { narratorId: "retry-parent", toolUseId: "origin-tool" },
								},
							}
						: null,
				model,
				autoContinuationOverride: "off",
				cwd: process.env.HOME,
				createdAt: now,
				updatedAt: now,
			});
		}
		const active = session(id, model, prefix);
		activeNarrators.set(id, active);
		const owner = tryClaimExecution(id, "run");
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
		const outcome = await runAgentLoopUnlocked(active, owner, "first user input", undefined);

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
					await seedNarrator({
						id: target,
						type: target === "retry-child" ? "subagent" : "primary",
						variant: target === "retry-child" ? "subagent:general" : "primary",
						parentNarratorId: target === "retry-child" ? "retry-parent" : null,
						runtimeRegistrationJson: target === "retry-child" ? delegatedRegistration : null,
						traits: target === "retry-child" ? delegatedTraits : [],
						model,
						autoContinuationOverride: "off",
						cwd: process.env.HOME,
						createdAt: now,
						updatedAt: now,
					});
				}
				const active = session(id, model, prefix);
				activeNarrators.set(id, active);
				const owner = tryClaimExecution(id, "run");
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
				const outcome = await runAgentLoopUnlocked(active, owner, "input");
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
