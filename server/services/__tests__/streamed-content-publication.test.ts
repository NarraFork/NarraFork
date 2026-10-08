import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import { cleanDb, getTestDb } from "../../../tests/setup";
import type { ProviderAdapter } from "../../lib/agent/provider";
import type { AgentConfig, AgentEvent } from "../../lib/agent/types";
import type { EventHandlerContext } from "../narrator-event-handler";

// Only the upstream provider and the network sink are replaced. The actual loop,
// execution receipt, event consumer, append/publication and SQLite paths all run.
const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const realWs = { ...(await import("../../websocket/narrator-ws")) };
const frames: Array<{
	narratorId: string;
	// biome-ignore lint/suspicious/noExplicitAny: observe serialized websocket frames
	message: any;
}> = [];
mock.module("../../websocket/narrator-ws", () => ({
	...realWs,
	broadcastToNarrator: (narratorId: string, message: unknown) =>
		frames.push({ narratorId, message }),
}));

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Timed out waiting for real loop publication")),
					5000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

type Scenario = "streaming" | "eager" | "native-metadata";
let scenario: Scenario;
let turn = 0;
let firstToolStarted = gate();
let releaseFirstTool = gate();
let releaseProvider = gate();
const executions: string[] = [];
const completions: string[] = [];
const thought = "先分析，再运行工具。";
const text = "我先检查源文件。";
const provider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	getActiveReasoningSource: () => "test:channel",
	async *chat(params) {
		params.onRequestStart?.();
		if (++turn > 1) {
			yield { text: "收尾完成。" };
			return;
		}
		yield {
			reasoning: thought,
			reasoningBlockId: "provider-reasoning",
			reasoningOutputIndex: 0,
			reasoningMetadata: { openai: { itemId: "rs-native" } },
		};
		if (scenario === "native-metadata") {
			yield {
				contentBoundary: {
					kind: "reasoning",
					phase: "complete",
					blockId: "provider-reasoning",
					outputIndex: 0,
				},
			};
		}
		yield { text, textBlockId: "provider-text", textOutputIndex: 1 };
		if (scenario === "native-metadata") {
			yield {
				contentBoundary: {
					kind: "text",
					phase: "complete",
					blockId: "provider-text",
					outputIndex: 1,
				},
			};
		}
		for (const [toolUseId, outputIndex] of [
			["tool-1", 2],
			["tool-2", 3],
		] as const) {
			if (scenario === "streaming") {
				yield { toolUseChunk: { toolUseId, name: "PublicationHold", outputIndex } };
				yield {
					toolUseChunk: {
						toolUseId,
						input: JSON.stringify({ which: toolUseId }),
						stop: true,
						outputIndex,
					},
				};
			} else {
				yield {
					toolUses: [
						{ toolUseId, name: "PublicationHold", input: { which: toolUseId }, outputIndex },
					],
				};
			}
			if (toolUseId === "tool-1") {
				await bounded(firstToolStarted.promise);
				if (scenario === "native-metadata") {
					yield {
						reasoningMetadata: {
							openai: { itemId: "rs-native", reasoningEncryptedContent: "late-cipher" },
						},
						reasoningBlockId: "provider-reasoning",
						reasoningOutputIndex: 0,
					};
				}
			}
		}
		await bounded(releaseProvider.promise);
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const realProvider = { ...(await import("../../lib/agent/provider")) };
mock.module("../../lib/agent/provider", () => ({
	...realProvider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		model: "test:model",
		adapter: provider,
	}),
}));
const { toolRegistry } = await import("../../lib/agent/tool-registry");
const { agentLoop } = await import("../../lib/agent/loop");
await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");
const { handlePermission } = await import("../narrator-permission");
const {
	processEvent,
	clearStreamingSnapshot,
	getStreamingSnapshot,
	CriticalEventPersistenceError,
} = await import("../narrator-event-handler");
const { executeAgentLoop } = await import("../narrator-executor");
toolRegistry.register({
	name: "PublicationHold",
	description: "Hold the first actual execution while the second tool is streamed",
	metadata: { readOnly: true },
	parameters: z.object({ which: z.string() }),
	execute: async (input, ctx) => {
		expect(ctx.toolCallBinding?.toolCallId).toBeString();
		const which = String(input.which);
		executions.push(which);
		if (which === "tool-1") {
			firstToolStarted.resolve();
			await bounded(releaseFirstTool.promise);
		}
		completions.push(which);
		return { output: "finished" };
	},
});

function seed(subagent: boolean) {
	const now = new Date().toISOString();
	for (const id of subagent ? ["parent", "child"] : ["main"]) {
		sqlite
			.prepare(
				"INSERT INTO narrators (id, type, variant, parent_narrator_id, permission_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				id,
				id === "child" ? "subagent" : "primary",
				id === "child" ? "subagent:general" : "primary",
				id === "child" ? "parent" : null,
				"bypassPermissions",
				now,
				now,
			);
	}
}

function makeContext(subagent: boolean): EventHandlerContext {
	let partialId: string | undefined;
	return {
		narratorId: subagent ? "child" : "main",
		broadcastTargetId: subagent ? "parent" : "main",
		parentToolUseId: subagent ? "parent-agent" : undefined,
		conversationId: "publication-test",
		locale: "en",
		getPartialMessageId: () => partialId,
		setPartialMessageId: (id) => {
			partialId = id;
		},
		getContextUsagePct: () => undefined,
		getMeterUsage: () => undefined,
		getMeterUnit: () => undefined,
		getTokenUsage: () => undefined,
		setContextUsagePct: () => {},
		setMeterData: () => {},
		setTokenUsage: () => {},
	};
}

function makeConfig(ctx: EventHandlerContext): AgentConfig {
	const signal = new AbortController().signal;
	const cwd = process.env.NARRAFORK_HOME as string;
	return {
		narratorId: ctx.narratorId,
		conversationId: ctx.conversationId,
		provider: "test",
		model: "test:model",
		cwd,
		signal,
		silentToolCallThreshold: -1,
		// An in-memory `allow` is not an approval receipt. Exercise the real
		// permission writer so the real final-start gate can validate this attempt.
		permissionHandler: (name, input, id, options) =>
			handlePermission(
				ctx.narratorId,
				signal,
				name,
				input,
				id,
				cwd,
				"en",
				ctx.broadcastTargetId,
				options,
				ctx.parentToolUseId,
			),
		onToolExecutionStarting: (toolUseId, binding, startedAt) =>
			narratorPersistence.claimToolCallExecution(ctx.narratorId, toolUseId, binding, startedAt),
	};
}

function readMessage(messageId: string) {
	const row = sqlite
		.prepare(
			"SELECT m.content_json AS content, r.seq AS seq FROM narrator_messages m JOIN narrator_message_refs r ON r.message_id = m.id WHERE m.id = ?",
		)
		.get(messageId) as { content: string; seq: number };
	return { blocks: JSON.parse(row.content) as Array<Record<string, unknown>>, seq: row.seq };
}

beforeEach(() => {
	cleanDb(sqlite);
	frames.length = 0;
	executions.length = 0;
	completions.length = 0;
	turn = 0;
	firstToolStarted = gate();
	releaseFirstTool = gate();
	releaseProvider = gate();
});
afterEach(() => {
	releaseFirstTool.resolve();
	releaseProvider.resolve();
	sqlite.run("DROP TRIGGER IF EXISTS fail_content_checkpoint");
	for (const id of ["main", "child", "parent"]) clearStreamingSnapshot(id);
});
afterAll(() => {
	toolRegistry.unregister("PublicationHold");
	mock.module("../../lib/agent/provider", () => realProvider);
	mock.module("../../db", () => realDb);
	mock.module("../../websocket/narrator-ws", () => realWs);
	mock.restore();
	cleanDb(sqlite);
});

describe("real loop content publication before tools", () => {
	for (const route of ["streaming", "eager", "native-metadata"] as const) {
		for (const subagent of [false, true]) {
			test(`${route}: both bodies are committed before tool-2 while tool-1 is still running (subagent=${subagent})`, async () => {
				scenario = route;
				seed(subagent);
				const ctx = makeContext(subagent);
				const config = makeConfig(ctx);
				const secondVisible = gate();
				const events: AgentEvent[] = [];
				let messageId: string | undefined;
				const running = executeAgentLoop(
					{ config, userText: "Inspect then report", history: [], eventContext: ctx },
					{
						eventSource: agentLoop(config, "Inspect then report", []),
						processEventFn: async (event, context, hooks) => {
							const result = await processEvent(event, context, hooks);
							events.push(event);
							if (
								(event.type === "tool_use_chunk" || event.type === "tool_call") &&
								event.toolUseId === "tool-2"
							) {
								messageId ??= context.getPartialMessageId();
								secondVisible.resolve();
							}
							return result;
						},
					},
				);
				try {
					await bounded(
						Promise.race([
							secondVisible.promise,
							running.then(() => {
								throw new Error("Loop ended before second tool visibility");
							}),
						]),
					);
					expect(executions).toContain("tool-1");
					expect(completions).not.toContain("tool-1");
					expect(events.some((event) => event.type === "assistant_message")).toBe(false);
					expect(messageId).toBeString();
					const committed = readMessage(messageId as string);
					expect(committed.blocks.slice(0, 2)).toMatchObject([
						{ type: "reasoning", text: thought },
						{ type: "text", text },
					]);
					for (const block of committed.blocks.slice(0, 2)) {
						expect(block.id).toBeString();
						expect(block.revision).toBeNumber();
						expect(block.completed).toBe(route === "native-metadata");
					}
					if (route === "native-metadata")
						expect(committed.blocks[0]).toMatchObject({
							providerMetadata: {
								openai: { itemId: "rs-native", reasoningEncryptedContent: "late-cipher" },
							},
						});
					for (const target of subagent ? ["parent", "child"] : ["main"]) {
						const published = frames.findLast(
							(frame) =>
								frame.narratorId === target &&
								frame.message.type === "message_updated" &&
								frame.message.message?.id === messageId,
						);
						expect(published?.message.message.contentJson.slice(0, 2)).toMatchObject([
							{ type: "reasoning", text: thought },
							{ type: "text", text },
						]);
						const firstToolIndex = frames.findIndex(
							(frame) =>
								frame.narratorId === target &&
								["tool_use_chunk", "tool_started"].includes(frame.message.type),
						);
						const textCommitIndex = frames.findIndex(
							(frame) =>
								frame.narratorId === target &&
								frame.message.type === "message_updated" &&
								frame.message.message?.contentJson?.some(
									(block: { type?: string }) => block.type === "text",
								),
						);
						expect(textCommitIndex).toBeGreaterThanOrEqual(0);
						expect(textCommitIndex).toBeLessThan(firstToolIndex);
					}
					expect(
						getStreamingSnapshot(ctx.narratorId)?.streamingBlocks.filter(
							(block) => block.type === "text" || block.type === "reasoning",
						) ?? [],
					).toHaveLength(0);
					releaseProvider.resolve();
					releaseFirstTool.resolve();
					const result = await bounded(running);
					expect(result.hasError).toBe(false);
					const final = readMessage(messageId as string);
					expect(final.blocks.slice(0, 2).every((block) => block.completed === true)).toBe(true);
					expect(final.seq).toBe(committed.seq);
					expect(final.blocks.map((block) => block.type)).toEqual([
						"reasoning",
						"text",
						"tool_use",
						"tool_use",
					]);
					expect(final.blocks.slice(0, 2).map((block) => block.id)).toEqual(
						committed.blocks.slice(0, 2).map((block) => block.id),
					);
					expect(final.blocks.filter((block) => block.text === thought)).toHaveLength(1);
					expect(final.blocks.filter((block) => block.text === text)).toHaveLength(1);
					expect(completions).toContain("tool-1");
				} finally {
					releaseProvider.resolve();
					releaseFirstTool.resolve();
					await bounded(running);
				}
			});
		}
	}

	for (const failedType of ["reasoning", "text"] as const) {
		test(`a real SQLite ${failedType} failure retains its live body and starts no tool`, async () => {
			scenario = "eager";
			seed(false);
			const ctx = makeContext(false);
			sqlite.run(
				`CREATE TEMP TRIGGER fail_content_checkpoint BEFORE UPDATE OF content_json ON narrator_messages WHEN NEW.content_json LIKE '%"type":"${failedType}"%' BEGIN SELECT RAISE(ABORT, 'real content write rejected'); END`,
			);
			await expect(
				executeAgentLoop({
					config: makeConfig(ctx),
					userText: "Fail closed",
					history: [],
					eventContext: ctx,
				}),
			).rejects.toBeInstanceOf(CriticalEventPersistenceError);
			expect(executions).toEqual([]);
			expect(
				frames.some((frame) =>
					["tool_use_chunk", "tool_started", "tool_executing"].includes(frame.message.type),
				),
			).toBe(false);
			// The loop checkpoints reasoning BEFORE dispatching the first text delta.
			// A failed text commit therefore retains text live and reasoning durably.
			expect(getStreamingSnapshot("main")?.streamingBlocks).toMatchObject([
				{ type: failedType, text: failedType === "reasoning" ? thought : text },
			]);
			const durable = readMessage(ctx.getPartialMessageId() as string);
			expect(durable.blocks).toMatchObject(
				failedType === "text" ? [{ type: "reasoning", text: thought }] : [],
			);
		});
	}
});
