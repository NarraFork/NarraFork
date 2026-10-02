import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import type { RuntimeProfile } from "../agent-runtime/input";
import type { ExecuteLoopOptions, ExecuteLoopResult } from "../narrator-executor";
import type { ActiveNarrator } from "../narrator-session-state";
import { deferred } from "./agent-runtime-contract.harness";

/**
 * Exercises the real shared orchestrator and its control/persistence hooks. Only the
 * low-level model pass is scripted; caller/executor/orchestrator are never mocked.
 * Call snapshots are model-boundary fixture evidence, not proof of upstream processing.
 * Deliberately not covered here: real network/provider serialization, tool authorization,
 * transient backoff timing, detach ownership, or full runner publication transactions.
 * Those remain separate integration contracts; custom fallback below checks visibility,
 * not permission enforcement. Each file is intended to run in its own Bun process.
 */
const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const provider = await import("../../lib/agent/provider");
const executor = await import("../narrator-executor");
const { isGitCommandToolResult, runAgentLoopUnlocked } = await import(
	"../agent-runtime/orchestrator"
);
const { tryClaimExecution, getExecutionOwner } = await import("../agent-runtime/ownership");
const { activeNarrators } = await import("../narrator-session-state");
const { settings } = await import("../../lib/settings");
const manual = await import("../subagent-manual-override");
const takeover = await import("../subagent-takeover");
const { ProxyAbortController } = await import("../subagent-detach");
const { resetForegroundTurn } = await import("../agent-runtime/control");
const { isExecutionSuspended } = await import("../agent-runtime/ownership");
const { createPublicationOutbox } = await import("../agent-runtime/publication-outbox");
const { bufferSubagentUserMessage } = await import("../subagent-executor");
const MODEL = "orchestratorfixture:model";
const adapter: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async (messages) => ({
		history: messages.map((message) => ({ role: message.role, content: message.contentJson })),
		trailingToolResults: messages.flatMap((message) =>
			(message.toolCalls ?? [])
				.filter((tool) => tool.status === "success")
				.map((tool) => ({
					toolUseId: tool.toolUseId,
					output: tool.outputJson,
				})),
		),
	}),
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("Contract must not contact a model");
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => {
		throw new Error("Contract must not generate titles");
	},
	generateWithMeta: async () => {
		throw new Error("Contract must not generate summaries");
	},
	generateWithHistory: async () => {
		throw new Error("Contract must not generate history");
	},
};
const unregister = provider.registerExternalProviderResolver((name) =>
	name === "orchestratorfixture" ? adapter : null,
);
const ids = ["contract-parent", "contract-primary", "contract-child"];
beforeEach(() => {
	cleanDb(sqlite);
	settings.agent.autoContinuationMode = "off";
	const now = new Date().toISOString();
	for (const id of ["principal-a", "principal-b"]) {
		db.insert(users).values({ id, username: id, passwordHash: "fixture", createdAt: now }).run();
	}
	for (const id of ids)
		db.insert(narrators)
			.values({
				id,
				type: id === "contract-child" ? "subagent" : "primary",
				variant: id === "contract-child" ? "subagent:general" : "primary",
				parentNarratorId: id === "contract-child" ? "contract-parent" : null,
				model: MODEL,
				cwd: process.env.HOME,
				autoContinuationOverride: "off",
				createdAt: now,
				updatedAt: now,
			})
			.run();
});
afterEach(() => {
	for (const id of ids) {
		getExecutionOwner(id)?.release();
		activeNarrators.delete(id);
	}
	mock.restore();
});
afterAll(() => {
	unregister();
	mock.module("../../db", () => realDb);
});

const finished: ExecuteLoopResult = {
	finalText: "finished",
	hasError: false,
	shouldUpdateTitle: false,
	completedAssistantTurn: true,
	completedNaturally: true,
};
function active(id: string): ActiveNarrator {
	return {
		narratorId: id,
		conversationId: `${id}-conversation`,
		cwd: process.env.HOME as string,
		model: MODEL,
		provider: "orchestratorfixture",
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
const profiles: RuntimeProfile[] = [
	{ kind: "primary" },
	{
		kind: "subagent",
		parentNarratorId: "contract-parent",
		parentToolUseId: "origin-agent",
		subagentType: "general",
		systemPrompt: "contract prompt",
		initialHistory: [],
	},
];
function fixture(
	profile: RuntimeProfile,
	script: Array<ExecuteLoopResult | ((options: ExecuteLoopOptions) => Promise<ExecuteLoopResult>)>,
) {
	const id = profile.kind === "primary" ? "contract-primary" : "contract-child";
	const session = active(id);
	const owner = tryClaimExecution(id, profile.kind);
	if (!owner) throw new Error("Missing fixture owner");
	activeNarrators.set(id, session);
	const calls: ExecuteLoopOptions[] = [];
	spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
		calls.push(options);
		const step = script[calls.length - 1];
		if (!step) throw new Error("Unexpected extra model pass");
		return typeof step === "function" ? step(options) : { ...step };
	});
	return {
		calls,
		owner,
		session,
		run: (text = "same input") => runAgentLoopUnlocked(session, owner, text, undefined, profile),
	};
}

describe("Bash Git command detection for status refresh", () => {
	test("uses parsed command nodes instead of matching argument text", async () => {
		expect(await isGitCommandToolResult("Bash", { command: "git status" }, "/tmp")).toBe(true);
		expect(await isGitCommandToolResult("Bash", { command: "git commit -m fix" }, "/tmp")).toBe(
			true,
		);
		expect(await isGitCommandToolResult("Bash", { command: "echo ok && git status" }, "/tmp")).toBe(
			true,
		);
		expect(await isGitCommandToolResult("Bash", { command: "echo git" }, "/tmp")).toBe(false);
		expect(await isGitCommandToolResult("Bash", { command: "printf git" }, "/tmp")).toBe(false);
		expect(await isGitCommandToolResult("Write", { command: "git status" }, "/tmp")).toBe(false);
	});
});

describe("real shared orchestrator profile contract", () => {
	for (const kind of ["references", "bash"] as const) {
		test(`primary: spilled ${kind} survive materialization and start the next pass`, async () => {
			const oldHome = process.env.NARRAFORK_HOME;
			const home = mkdtempSync(join(tmpdir(), "nf-orchestrator-spill-"));
			process.env.NARRAFORK_HOME = home;
			try {
				const { enqueueBufferedMessage } = await import("../narrator-buffer");
				const service = await import("../narrator-service");
				const bash = spyOn(service, "handleBashCommand").mockResolvedValue({
					type: "bash",
					id: "fixture-bash",
					output: "fixture",
					isError: false,
				});
				const command = `printf '${"x".repeat(3 * 1024)}'`;
				const snapshot = {
					type: "file_reference" as const,
					reference: { id: "ref", deviceId: "local", path: "/saved.ts", label: "saved.ts" },
					snapshotText: "saved-content-".repeat(1024),
					snapshotHash: "hash",
					capturedAt: new Date().toISOString(),
				};
				let spillPath = "";
				let id = "";
				const h = fixture({ kind: "primary" }, [
					async () => {
						const accepted = await enqueueBufferedMessage(
							"contract-primary",
							"queued prompt",
							undefined,
							null,
							null,
							null,
							undefined,
							"back",
							kind === "bash" ? command : null,
							kind === "references" ? [snapshot] : undefined,
						);
						expect(accepted.ok).toBe(true);
						id = accepted.id;
						const row = db
							.select()
							.from(narratorBufferedMessages)
							.where(eq(narratorBufferedMessages.id, id))
							.get();
						const metadata = JSON.parse(row?.metadataJson ?? "{}");
						spillPath = kind === "bash" ? metadata.bashCommandPath : metadata.fileReferencesPath;
						expect(existsSync(spillPath)).toBe(true);
						return { ...finished };
					},
					async (options) => {
						expect(existsSync(spillPath)).toBe(false);
						if (kind === "references") expect(options.userText).toContain(snapshot.snapshotText);
						// The Bash double does not append a tool result, so history rebuilding
						// may recover the queued prompt as the trailing current user turn.
						return { ...finished };
					},
				]);
				const result = await h.run();
				expect(result.hasError).toBe(false);
				expect(h.calls).toHaveLength(2);
				expect(
					db
						.select()
						.from(narratorBufferedMessages)
						.where(eq(narratorBufferedMessages.id, id))
						.get()?.state,
				).toBe("materialized");
				if (kind === "bash") {
					expect(bash).toHaveBeenCalledTimes(1);
					expect(bash.mock.calls[0][1]).toBe(command);
				} else expect(bash).not.toHaveBeenCalled();
			} finally {
				if (oldHome === undefined) delete process.env.NARRAFORK_HOME;
				else process.env.NARRAFORK_HOME = oldHome;
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
	for (const profile of profiles) {
		test(`${profile.kind}: production detached callback persists after the loop has returned`, async () => {
			const h = fixture(profile, [finished]);
			await h.run();
			const callback = h.calls[0].config.onDetachedToolResult;
			expect(callback).toBeFunction();
			if (!callback) throw new Error("Missing production detached callback");
			const narratorId = h.session.narratorId;
			const now = new Date().toISOString();
			await db.insert(narratorMessages).values({
				id: "detached-message",
				narratorId,
				role: "assistant",
				parentToolUseId: profile.kind === "subagent" ? profile.parentToolUseId : null,
				contentJson: [{ type: "tool_use", id: "detached-call", name: "Write", input: {} }],
				createdAt: now,
			});
			await db.insert(narratorMessageRefs).values({
				id: "detached-ref",
				narratorId,
				messageId: "detached-message",
				seq: 100,
			});
			await db.insert(narratorToolCalls).values({
				id: "detached-row",
				narratorId,
				messageId: "detached-message",
				toolUseId: "detached-call",
				toolName: "Write",
				inputJson: {},
				executionAttempt: 1,
				executionIdentityVersion: 1,
				status: "fail",
				errorMessage: "Narrator interrupted by user",
				createdAt: now,
			});
			await callback({
				type: "tool_result",
				toolUseId: "detached-call",
				toolName: "Write",
				toolCallBinding: { toolCallId: "detached-row", attempt: 1 },
				output: "actual post-abort output",
				isError: false,
			});
			expect(
				await db.query.narratorToolCalls.findFirst({
					where: eq(narratorToolCalls.id, "detached-row"),
				}),
			).toMatchObject({
				status: "success",
				errorMessage: null,
				outputJson: "actual post-abort output",
			});
		});

		test(`${profile.kind}: one completed pass retains model input and profile event identity`, async () => {
			const h = fixture(profile, [finished]);
			const result = await h.run();
			expect(result).toMatchObject({ started: true, finalText: "finished", hasError: false });
			expect(h.calls).toHaveLength(1);
			expect(h.calls[0].userText).toBe('<sender kind="system" />\nsame input');
			expect(h.calls[0].config.model).toBe(MODEL);
			expect(h.calls[0].eventContext).toMatchObject({
				narratorId: h.session.narratorId,
				broadcastTargetId: profile.kind === "primary" ? h.session.narratorId : "contract-parent",
				parentToolUseId: profile.kind === "primary" ? undefined : "origin-agent",
			});
		});

		test(`${profile.kind}: payment-required result fails the run without another model pass`, async () => {
			const h = fixture(profile, [
				{
					...finished,
					completedNaturally: false,
					paymentRequired: { message: "fixture balance exhausted", resumeAction: "retry" },
				},
			]);
			const result = await h.run();
			expect(result).toMatchObject({ started: true, hasError: true });
			expect(h.calls).toHaveLength(1);
			expect(result.lastPass?.paymentRequired?.message).toBe("fixture balance exhausted");
		});

		test(`${profile.kind}: exhausted stateless provider retry cannot multiply into outer model calls`, async () => {
			const h = fixture(profile, [
				{
					...finished,
					completedNaturally: false,
					retryableError: "fixture exhausted provider retries",
				},
			]);
			const result = await h.run();
			expect(result).toMatchObject({ started: true, hasError: true });
			expect(h.calls).toHaveLength(1);
			expect(result.lastPass?.retryableError).toBe("fixture exhausted provider retries");
		});

		for (const naturallyDone of [true, false]) {
			test(`${profile.kind}: late compact ${naturallyDone ? "does not restart natural completion" : "replays interrupted history exactly once"}`, async () => {
				const { markActiveHistoryCompactPending, hasPendingHistoryCompact } = await import(
					"../narrator-session-state"
				);
				const h = fixture(profile, [
					async (options) => {
						expect(markActiveHistoryCompactPending(options.config.narratorId, 2)).toBe(true);
						return { ...finished, completedNaturally: naturallyDone };
					},
					finished,
				]);
				const result = await h.run();
				expect(result.hasError).toBe(false);
				expect(h.calls).toHaveLength(naturallyDone ? 1 : 2);
				if (!naturallyDone) {
					expect(h.calls[1].userText).toBe("");
					expect(hasPendingHistoryCompact(h.session.narratorId)).toBe(false);
				}
			});
		}

		test(`${profile.kind}: interrupted continuation rebuilds history and takes exactly one extra pass`, async () => {
			const h = fixture(profile, [
				{
					...finished,
					completedNaturally: false,
					interrupted: true,
					interruptedReason: "completion_limit",
				},
				finished,
			]);
			const result = await h.run();
			expect(result.hasError).toBe(false);
			expect(h.calls).toHaveLength(2);
			const rows = db
				.select()
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, h.session.narratorId))
				.all();
			expect(rows.filter((row) => row.role === "user")).toHaveLength(1);
			expect(rows[0].origin).toBe("system");
			const content = rows[0].contentText;
			if (!content) throw new Error("Continuation must persist nonempty prompt text");
			expect(JSON.stringify(h.calls[1].history)).toContain(content);
			expect(h.calls[1].config.model).toBe(h.calls[0].config.model);
			expect(getExecutionOwner(h.session.narratorId)).toBe(h.owner);
		});

		test(`${profile.kind}: pure tool replay does not fabricate a continuation user message`, async () => {
			const h = fixture(profile, [
				async (options) => {
					const narratorId = options.config.narratorId;
					const now = new Date().toISOString();
					db.insert(narratorMessages)
						.values({
							id: "replay-message",
							narratorId,
							role: "assistant",
							contentJson: [{ type: "tool_use", id: "read-replay", name: "Read", input: {} }],
							createdAt: now,
						})
						.run();
					db.insert(narratorMessageRefs)
						.values({ id: "replay-ref", narratorId, messageId: "replay-message", seq: 1 })
						.run();
					db.insert(narratorToolCalls)
						.values({
							id: "replay-tool",
							narratorId,
							messageId: "replay-message",
							toolUseId: "read-replay",
							toolName: "Read",
							status: "success",
							executionIdentityVersion: 1,
							executionAttempt: 2,
							outputJson: "persisted replay output",
							createdAt: now,
						})
						.run();
					return {
						...finished,
						completedNaturally: false,
						interrupted: true,
						shouldReplayInterruptedToolResultTurn: true,
					};
				},
				finished,
			]);
			const result = await h.run();
			expect(result.hasError).toBe(false);
			expect(h.calls.map((call) => call.userText)).toEqual([
				'<sender kind="system" />\nsame input',
				"",
			]);
			expect(
				db.select().from(narratorMessages).where(eq(narratorMessages.role, "user")).all(),
			).toEqual([]);
			expect(h.calls[1].trailingToolResults).toEqual([
				{ toolUseId: "read-replay", output: "persisted replay output" },
			]);
		});

		test(`${profile.kind}: actual after-tools materialization remains unadopted until its request callback`, async () => {
			const h = fixture(profile, [
				async (options) => {
					const store = createPublicationOutbox(db);
					const run = {
						producerKind: "agent" as const,
						taskId: "contract-parent",
						recipientId: h.session.narratorId,
						logicalRunId: "after-tools-run",
					};
					store.reserveRunSlots(run);
					store.commitIntent({
						...run,
						eventKind: "completed",
						summary: "after-tools ready",
						resultRef: "narrator:contract-parent:after-tools-run",
					});
					store.transferNext(h.session.narratorId, "agent");
					const injection = await options.config.getAfterToolsInjections?.();
					expect(typeof injection).toBe("object");
					if (!injection || typeof injection === "string")
						throw new Error("Missing adoption packet");
					expect(injection.text).toContain("after-tools ready");
					const before = db.select().from(narratorBufferedMessages).get();
					expect(before).toMatchObject({ state: "materialized", adoptedAt: null });
					expect(injection.onConsumed).toBeFunction();
					injection.onConsumed?.();
					await new Promise<void>((resolve) => setImmediate(resolve));
					expect(db.select().from(narratorBufferedMessages).get()?.adoptedAt).toBeString();
					return finished;
				},
			]);
			expect((await h.run()).hasError).toBe(false);
			expect(h.calls).toHaveLength(1);
		});
	}

	for (const scenario of [
		{ name: "feedback soft-stop", recipient: "principal-a", softStop: true },
		{ name: "different principal", recipient: "principal-b", softStop: false },
	]) {
		test(`child ${scenario.name} stays queued until the next pass adopts its exact user`, async () => {
			const order: string[] = [];
			const feedback = `${scenario.name} input`;
			const h = fixture(profiles[1], [
				async (options) => {
					expect(options.config.userId).toBe("principal-a");
					const accepted = await bufferSubagentUserMessage("contract-child", feedback, {
						createdBy: scenario.recipient,
						requestSoftStop: scenario.softStop,
					});
					expect(accepted.ok).toBe(true);
					order.push("queued");
					if (scenario.softStop) expect(options.config.shouldStop?.()).toBe(true);
					const injection = await options.config.getAfterToolsInjections?.();
					const text = typeof injection === "string" ? injection : injection?.text;
					expect(text ?? "").not.toContain(feedback);
					expect(
						db
							.select()
							.from(narratorBufferedMessages)
							.where(eq(narratorBufferedMessages.id, accepted.id))
							.get()?.state,
					).toBe("queued");
					order.push("old-pass-stopped");
					return { ...finished, completedNaturally: false, hadToolUses: true };
				},
				async (options) => {
					expect(options.config.userId).toBe(scenario.recipient);
					expect(options.userText).toContain(feedback);
					order.push("feedback-before-next-tool");
					const message = db
						.select()
						.from(narratorMessages)
						.where(eq(narratorMessages.contentText, feedback))
						.get();
					expect(message).toMatchObject({
						createdBy: scenario.recipient,
						parentToolUseId: "origin-agent",
					});
					return finished;
				},
			]);
			h.session._currentUserId = "principal-a";
			expect((await h.run()).hasError).toBe(false);
			expect(h.calls).toHaveLength(2);
			expect(order).toEqual(["queued", "old-pass-stopped", "feedback-before-next-tool"]);
		});
	}

	test("same-principal child input can adopt after tools with real dual placement and no new pass", async () => {
		const ws = await import("../../websocket/narrator-ws");
		const broadcast = spyOn(ws, "broadcastToNarrator").mockImplementation(() => {});
		const text = "same principal after-tools input";
		const h = fixture(profiles[1], [
			async (options) => {
				const accepted = await bufferSubagentUserMessage("contract-child", text, {
					createdBy: "principal-a",
					requestSoftStop: false,
				});
				expect(accepted.ok).toBe(true);
				expect(options.config.shouldStop?.()).toBe(false);
				const packet = await options.config.getAfterToolsInjections?.();
				if (!packet || typeof packet === "string") throw new Error("Missing after-tools packet");
				expect(packet.text).toContain(text);
				const row = db
					.select()
					.from(narratorBufferedMessages)
					.where(eq(narratorBufferedMessages.id, accepted.id))
					.get();
				expect(row).toMatchObject({ state: "materialized", adoptedAt: null });
				const message = db
					.select()
					.from(narratorMessages)
					.where(eq(narratorMessages.contentText, text))
					.get();
				expect(message).toMatchObject({
					createdBy: "principal-a",
					parentToolUseId: "origin-agent",
				});
				const projected = broadcast.mock.calls.filter(
					([, event]) =>
						event.type === "user_message" &&
						typeof event.message === "object" &&
						event.message !== null &&
						"id" in event.message &&
						event.message.id === message?.id,
				);
				expect(projected.map(([id]) => id)).toEqual(["contract-parent", "contract-child"]);
				packet.onConsumed?.();
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(
					db
						.select()
						.from(narratorBufferedMessages)
						.where(eq(narratorBufferedMessages.id, accepted.id))
						.get()?.adoptedAt,
				).toBeString();
				return finished;
			},
		]);
		h.session._currentUserId = "principal-a";
		expect((await h.run()).hasError).toBe(false);
		expect(h.calls).toHaveLength(1);
	});

	test("missing custom child definition retains readonly fallback in the real pass policy", async () => {
		const { toolRegistry } = await import("../../lib/agent/tool-registry");
		const base = profiles[1];
		if (base.kind !== "subagent") throw new Error("Missing child profile");
		const h = fixture(
			{ ...base, subagentType: "custom:missing-definition", customDefinition: null },
			[finished],
		);
		expect((await h.run()).hasError).toBe(false);
		const read = toolRegistry.get("Read");
		const write = toolRegistry.get("Write");
		if (!read || !write) throw new Error("Core tools must be registered");
		expect(h.calls[0].config.toolFilter?.(read)).toBe(true);
		expect(h.calls[0].config.toolFilter?.(write)).toBe(false);
	});

	test("child stream reaches both audiences through the real event handler with different origin projection", async () => {
		const ws = await import("../../websocket/narrator-ws");
		const { processEvent } = await import("../narrator-event-handler");
		const broadcast = spyOn(ws, "broadcastToNarrator").mockImplementation(() => {});
		const h = fixture(profiles[1], [
			async (options) => {
				await processEvent(
					{ type: "stream_text", text: "child output" },
					options.eventContext,
					options.hooks,
				);
				return finished;
			},
		]);
		expect((await h.run()).hasError).toBe(false);
		const stream = broadcast.mock.calls.filter(([, message]) => message.type === "stream_event");
		expect(stream).toHaveLength(2);
		expect(stream[0]).toEqual([
			"contract-parent",
			expect.objectContaining({
				event: expect.objectContaining({
					subagentToolUseId: "origin-agent",
					subagentNarratorId: "contract-child",
				}),
			}),
		]);
		expect(stream[1][0]).toBe("contract-child");
		expect(stream[1][1]).toMatchObject({ event: { delta: { text: "child output" } } });
		expect(JSON.stringify(stream[1][1])).not.toContain("subagentToolUseId");
	});

	test("child doing Spec work exhausts the real per-run continuation budget without changing task status", async () => {
		const { writeSpecFile, readSpecFile } = await import("../spec-vfs-service");
		const { MAX_SUBAGENT_CONTINUATION_PASSES } = await import("../turn-continuation-decisions");
		await db
			.update(narrators)
			.set({ autoContinuationOverride: "always" })
			.where(eq(narrators.id, "contract-child"));
		await writeSpecFile(
			"contract-child",
			"spec://tasks.json",
			JSON.stringify({ tasks: [{ text: "finite fixture work", status: "doing" }] }),
		);
		const h = fixture(
			profiles[1],
			Array.from({ length: MAX_SUBAGENT_CONTINUATION_PASSES + 1 }, () => ({
				...finished,
				hadToolUses: true,
			})),
		);
		const result = await h.run();
		expect(result.hasError).toBe(false);
		expect(h.calls).toHaveLength(MAX_SUBAGENT_CONTINUATION_PASSES + 1);
		expect(result.finalText).toContain("budget");
		expect((await readSpecFile("contract-child", "spec://tasks.json"))?.content).toContain(
			'"doing"',
		);
	});

	test("takeover waits in real control, resumes the same epoch and rejects an old-turn abort", async () => {
		const parent = new AbortController();
		const proxy = new ProxyAbortController();
		const profile: Extract<RuntimeProfile, { kind: "subagent" }> = {
			...(profiles[1] as Extract<RuntimeProfile, { kind: "subagent" }>),
			control: {
				parentSignal: parent.signal,
				proxy,
				turnAbort: new AbortController(),
				detached: false,
			},
		};
		const entered = deferred<void>();
		const originalWait = manual.waitForManualOverride;
		spyOn(manual, "waitForManualOverride").mockImplementation((...args) => {
			const waiting = originalWait(...args);
			entered.resolve();
			return waiting;
		});
		const h = fixture(profile, [
			finished,
			async (options) => {
				if (!oldTurn) throw new Error("Missing captured old turn");
				oldTurn.abort("late cancelled turn callback");
				expect(options.config.signal.aborted).toBe(false);
				expect(profile.control?.turnAbort).not.toBe(oldTurn);
				return finished;
			},
		]);
		resetForegroundTurn(h.session, profile);
		const oldTurn = profile.control?.turnAbort;
		if (!oldTurn) throw new Error("Takeover fixture requires foreground control");
		takeover.markTakenOver(h.session.narratorId);
		const run = h.run();
		try {
			await entered.promise;
			expect(isExecutionSuspended(h.session.narratorId)).toBe(true);
			expect(tryClaimExecution(h.session.narratorId, "primary")).toBeNull();
			takeover.clearTakenOver(h.session.narratorId);
			expect(
				manual.resumeManualOverride(h.session.narratorId, {
					prompt: "manual resume",
					history: [],
					trailingToolResults: [],
				}),
			).toBe(true);
			expect((await run).hasError).toBe(false);
			expect(h.calls.map((call) => call.userText)).toEqual([
				'<sender kind="system" />\nsame input',
				'<sender kind="system" />\nmanual resume',
			]);
			expect(getExecutionOwner(h.session.narratorId)).toBe(h.owner);
		} finally {
			takeover.clearTakenOver(h.session.narratorId);
			manual.clearManualOverrideRuntimes();
			profile.control?.cleanupTurnAbort?.();
			proxy.dispose();
			await run;
		}
	});

	test("a SESSION-level abort on a taken-over subagent re-suspends instead of ending the run", async () => {
		/*
		 * The production Stop path aborted `active.abortController` directly (via
		 * `interruptNarrator`), never `turnAbort`. The runtime then took the generic
		 * abort exit, the runner cleared the takeover and the parent's blocked Agent
		 * call was settled. The stop must instead land in the control transition and
		 * park the subagent in `taken_over`, with the same run resumable afterwards.
		 */
		const parent = new AbortController();
		const proxy = new ProxyAbortController();
		const profile: Extract<RuntimeProfile, { kind: "subagent" }> = {
			...(profiles[1] as Extract<RuntimeProfile, { kind: "subagent" }>),
			control: {
				parentSignal: parent.signal,
				proxy,
				turnAbort: new AbortController(),
				detached: false,
			},
		};
		const entered = deferred<void>();
		const originalWait = manual.waitForManualOverride;
		spyOn(manual, "waitForManualOverride").mockImplementation((...args) => {
			const waiting = originalWait(...args);
			entered.resolve();
			return waiting;
		});
		const h = fixture(profile, [
			async () => {
				// Exactly what `interruptNarrator(subagentId)` does to a running subagent.
				h.session.abortController.abort();
				return { ...finished, aborted: true, completedNaturally: false };
			},
			finished,
		]);
		resetForegroundTurn(h.session, profile);
		const turn = profile.control?.turnAbort;
		takeover.markTakenOver(h.session.narratorId);
		const run = h.run();
		try {
			await entered.promise;
			// The turn controller was never touched: the session abort alone got here.
			expect(turn?.signal.aborted).toBe(false);
			expect(takeover.isTakenOver(h.session.narratorId)).toBe(true);
			expect(isExecutionSuspended(h.session.narratorId)).toBe(true);
			// Release before resuming, otherwise the next natural completion re-suspends
			// in `taken_over` (correctly) and the run never returns.
			takeover.clearTakenOver(h.session.narratorId);
			expect(
				manual.resumeManualOverride(h.session.narratorId, {
					prompt: "after stop",
					history: [],
					trailingToolResults: [],
				}),
			).toBe(true);
			const result = await run;
			expect(result.hasError).toBe(false);
			expect(h.calls.map((call) => call.userText)).toEqual([
				'<sender kind="system" />\nsame input',
				'<sender kind="system" />\nafter stop',
			]);
		} finally {
			takeover.clearTakenOver(h.session.narratorId);
			manual.clearManualOverrideRuntimes();
			profile.control?.cleanupTurnAbort?.();
			proxy.dispose();
			await run;
		}
	});

	test("a stop that lands during a transient-retry backoff re-suspends a taken-over subagent", async () => {
		/*
		 * Only the check right after a model pass used to route a stop into control.
		 * A stop during the retry backoff hit the retry's own abort exit instead, the
		 * runner cleared the takeover and settled the parent — "stop this turn" ended
		 * the takeover depending on when it was clicked.
		 */
		const parent = new AbortController();
		const proxy = new ProxyAbortController();
		const profile: Extract<RuntimeProfile, { kind: "subagent" }> = {
			...(profiles[1] as Extract<RuntimeProfile, { kind: "subagent" }>),
			control: {
				parentSignal: parent.signal,
				proxy,
				turnAbort: new AbortController(),
				detached: false,
			},
		};
		const entered = deferred<void>();
		const originalWait = manual.waitForManualOverride;
		spyOn(manual, "waitForManualOverride").mockImplementation((...args) => {
			const waiting = originalWait(...args);
			entered.resolve();
			return waiting;
		});
		const recovery = await import("../narrator-recovery");
		spyOn(recovery, "handleTransientError").mockImplementation(async () => {
			// The user presses Stop while the loop sleeps before replaying.
			profile.control?.turnAbort.abort("Interrupted by user");
			return { shouldRetry: false, delayMs: 0 };
		});
		const h = fixture(profile, [
			// A silent disconnect takes the backoff path even on a stateless provider
			// (a stateless `retryableError` is "retry-exhausted" and never sleeps).
			{
				...finished,
				completedNaturally: false,
				completedAssistantTurn: false,
				silentDisconnect: true,
			},
			finished,
		]);
		resetForegroundTurn(h.session, profile);
		takeover.markTakenOver(h.session.narratorId);
		const run = h.run();
		try {
			await entered.promise;
			expect(takeover.isTakenOver(h.session.narratorId)).toBe(true);
			expect(isExecutionSuspended(h.session.narratorId)).toBe(true);
			takeover.clearTakenOver(h.session.narratorId);
			expect(
				manual.resumeManualOverride(h.session.narratorId, {
					prompt: "after backoff stop",
					history: [],
					trailingToolResults: [],
				}),
			).toBe(true);
			expect((await run).hasError).toBe(false);
			expect(h.calls.map((call) => call.userText)).toEqual([
				'<sender kind="system" />\nsame input',
				'<sender kind="system" />\nafter backoff stop',
			]);
		} finally {
			takeover.clearTakenOver(h.session.narratorId);
			manual.clearManualOverrideRuntimes();
			profile.control?.cleanupTurnAbort?.();
			proxy.dispose();
			await run;
		}
	});

	test("a SESSION-level abort on a subagent that is NOT taken over still ends the run", async () => {
		const parent = new AbortController();
		const proxy = new ProxyAbortController();
		const profile: Extract<RuntimeProfile, { kind: "subagent" }> = {
			...(profiles[1] as Extract<RuntimeProfile, { kind: "subagent" }>),
			control: {
				parentSignal: parent.signal,
				proxy,
				turnAbort: new AbortController(),
				detached: false,
			},
		};
		const wait = spyOn(manual, "waitForManualOverride");
		const h = fixture(profile, [
			async () => {
				h.session.abortController.abort();
				return { ...finished, aborted: true, completedNaturally: false };
			},
		]);
		resetForegroundTurn(h.session, profile);
		try {
			await h.run();
			expect(wait).not.toHaveBeenCalled();
			expect(h.calls).toHaveLength(1);
		} finally {
			profile.control?.cleanupTurnAbort?.();
			proxy.dispose();
		}
	});

	test("PG finalizer/consumption contract has no SQLite cleanup fallthrough", async () => {
		const source = await Bun.file(
			new URL("../agent-runtime/orchestrator.ts", import.meta.url),
		).text();
		expect(source).toContain("cleanupBufferedTextFilesAsync");
		expect(source).not.toContain("cleanupBufferedTextFiles(");
		expect(source).toContain("function hasPostgresRuntime()");
		expect(source).toContain("Skipping pending model restore");
		expect(source).toContain("Skipping persisted transient substatus cleanup");
		expect(source).toContain("Skipping persisted subagent handoff");
		expect(source).toContain("const narr = pgRuntime");
		expect(source).not.toContain("const narr = await db.query.narrators.findFirst");
		const subagentSource = await Bun.file(
			new URL("../subagent-executor.ts", import.meta.url),
		).text();
		expect(subagentSource).toContain("cleanupBufferedTextFilesAsync");
		expect(subagentSource).not.toContain("cleanupBufferedTextFiles(");
	});
});

test("prepared child current packet preserves distinct knowledge and human senders", async () => {
	const child = profiles.find((profile) => profile.kind === "subagent");
	if (!child || child.kind !== "subagent") throw new Error("Missing child profile");
	const packet =
		'<sender kind="system" id="knowledge_hint" name="knowledge_hint" />\nRelevant context\n\n<sender kind="human" id="principal-a" name="principal-a" />\nHuman request';
	const h = fixture({ ...child, initialCurrentText: packet }, [finished]);
	const outcome = await h.run("Human request");
	expect(outcome.hasError).toBe(false);
	expect(h.calls).toHaveLength(1);
	expect(h.calls[0].userText).toBe(packet);
	expect(h.calls[0].userText.match(/Human request/g)).toHaveLength(1);
	expect(h.calls[0].userText.match(/kind="human"/g)).toHaveLength(1);
});

for (const profile of profiles) {
	test(`${profile.kind}: real keyword knowledge hit has the same system sender live and in history`, async () => {
		const { knowledgeService } = await import("../knowledge-service");
		const { narratorPersistence } = await import("../narrator-persistence");
		const { buildRuntimeHistory } = await import("../agent-runtime/history");
		const { projectMessageSenderText } = await import("../../lib/agent/sender-projection");
		const previousMode = settings.knowledge.injectMode;
		settings.knowledge.injectMode = "summary";
		try {
			const collection = await knowledgeService.createCollection({
				name: `Sender knowledge ${profile.kind}`,
				ownerUserId: "principal-a",
			});
			const keyword = `senderkeyword${profile.kind}`;
			const entry = await knowledgeService.createEntry({
				collectionId: collection.id,
				title: `Sender regression ${profile.kind}`,
				content: "Real knowledge evidence",
				keywords: [keyword],
				authorUserId: "principal-a",
			});
			const h = fixture(profile, [finished]);
			h.session._currentUserId = "principal-a";
			const request = `Please recall ${keyword}`;
			await narratorPersistence.persistUserMessage(
				h.session.narratorId,
				request,
				undefined,
				undefined,
				"principal-a",
				undefined,
				profile.kind === "subagent" ? { parentToolUseId: profile.parentToolUseId } : undefined,
			);
			expect((await h.run(request)).hasError).toBe(false);
			expect(h.calls).toHaveLength(1);
			const rawMessages = await (
				await import("../narrator-service")
			).narratorService.getModelHistorySinceLastCompact(h.session.narratorId);
			const knowledge = rawMessages.find(
				(message) => message.role === "sys" && message.contentText?.includes(entry.id),
			);
			if (!knowledge?.contentText)
				throw new Error("Real keyword lookup did not persist a knowledge hit");
			const projected = projectMessageSenderText(knowledge, knowledge.contentText);
			expect(projected).toStartWith('<sender kind="system" />\n');
			expect(h.calls[0].userText).toStartWith(
				'<sender kind="human" id="principal-a" name="principal-a" />\n',
			);
			expect(h.calls[0].userText).toContain(`\n\n${projected}`);
			expect(h.calls[0].userText.match(/<sender kind="system"/g)).toHaveLength(1);
			expect(knowledge.contentText).not.toContain("<sender ");
			const rebuilt = await buildRuntimeHistory({
				narratorId: h.session.narratorId,
				profile: profile.kind,
				model: MODEL,
				provider: "orchestratorfixture",
				sourceMessages: rawMessages,
			});
			expect(JSON.stringify(rebuilt.history)).toContain(JSON.stringify(projected).slice(1, -1));
			expect(h.session._currentUserId).toBe("principal-a");
		} finally {
			settings.knowledge.injectMode = previousMode;
		}
	});
}
