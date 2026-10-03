import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	STREAMING_EDIT_ORIGIN_MAX_CODE_UNITS,
	type StreamingEditOrigin,
	validateStreamingEditOrigin,
} from "@shared/streaming-edit-origin";
import { z } from "zod/v4";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent } from "../types";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// A turn of the event loop, not a timing guess: pending promise chains get to settle.
const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
type ChatScript = ProviderAdapter["chat"];
let script: ChatScript;
let attempts = 0;
let scriptedAttempts = 1;
const started: string[] = [];
const starts = new Map<string, ReturnType<typeof gate>>();
const finishes = new Map<string, ReturnType<typeof gate>>();
const executionFailures = new Set<string>();
const abortAwareValues = new Set<string>();
const toolSignals = new Map<string, AbortSignal>();
const names = [
	"Write",
	"Edit",
	"Read",
	"Agent",
	"Await",
	"Send",
	"EnterPlanMode",
	"DangerConfirm",
	"TaskReflectConfirm",
	"ExitPlanConfirm",
];

const provider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		params.onRequestStart?.();
		if (++attempts > scriptedAttempts) {
			yield { text: "done" };
			return;
		}
		yield* script(params);
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const realProviderModule = { ...(await import("../provider")) };
mock.module("../provider", () => ({
	getProvider: () => provider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		adapter: provider,
		model: "test:model",
	}),
}));
const { agentLoop, resolveStreamingEditMetadata } = await import("../loop");

for (const name of names) {
	toolRegistry.register({
		name,
		description: `Controlled ${name} execution`,
		parameters: z.object({ value: z.string(), file_path: z.string().optional() }),
		execute: async (input, ctx) => {
			const value = String(input.value);
			started.push(value);
			toolSignals.set(value, ctx.signal);
			starts.get(value)?.resolve();
			if (abortAwareValues.has(value)) {
				await new Promise<void>((resolve) => {
					if (ctx.signal.aborted) resolve();
					else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return { output: `cancelled:${value}`, isError: true };
			}
			await finishes.get(value)?.promise;
			if (executionFailures.has(value)) throw new Error(`failed:${value}`);
			return { output: `ok:${value}` };
		},
	});
}

beforeEach(() => {
	attempts = 0;
	scriptedAttempts = 1;
	started.length = 0;
	starts.clear();
	finishes.clear();
	executionFailures.clear();
	abortAwareValues.clear();
	toolSignals.clear();
});
afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	for (const name of names) toolRegistry.unregister(name);
	mock.restore();
});

function tool(name: string, value: string, outputIndex: number, extra = {}) {
	return { toolUseId: value, name, input: { value, ...extra }, outputIndex };
}

function watch(value: string, hold = false) {
	const start = gate();
	starts.set(value, start);
	const finish = gate();
	if (hold) finishes.set(value, finish);
	return { started: start.promise, release: finish.resolve };
}

function run(
	overrides: Partial<AgentConfig> = {},
	onEvent?: (event: AgentEvent) => Promise<void> | void,
) {
	const events: AgentEvent[] = [];
	const config: AgentConfig = {
		narratorId: "n-stream-scheduling",
		conversationId: "conv-stream-scheduling",
		provider: "test",
		model: "test:model",
		cwd: "/tmp",
		signal: new AbortController().signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		...overrides,
	};
	return (async () => {
		for await (const event of agentLoop(config, "execute in order", [])) {
			events.push(event);
			await onEvent?.(event);
		}
		return events;
	})();
}

function expectSuccess(events: AgentEvent[]) {
	expect(events.filter((event) => event.type === "error")).toEqual([]);
}

describe("trusted streaming Edit origins", () => {
	for (const changeAtStop of [false, true]) {
		test(`20k pre-match survives final input without rebinding (changed=${changeAtStop})`, async () => {
			const dir = await mkdtemp(join(tmpdir(), "nf-edit-origin-"));
			try {
				const old = `${"h".repeat(20_000)}\nold`;
				const input = {
					value: "origin",
					file_path: "a.ts",
					old_string: old,
					_streamingMetadata: { startLine: 999 },
					_streamingEditOrigin: { startLine: 999 },
					new_string: "new",
				};
				await writeFile(join(dir, "a.ts"), `${"prefix\n".repeat(41)}${old}\nend`);
				script = async function* () {
					yield { toolUseChunk: { toolUseId: "edit-origin", name: "Edit" } };
					yield {
						toolUseChunk: {
							toolUseId: "edit-origin",
							input: JSON.stringify(input).replace(/"new"\}$/, '"'),
						},
					};
					yield {
						toolUseChunk: {
							toolUseId: "edit-origin",
							input: changeAtStop ? 'new","old_string":"CHANGED"}' : 'new"}',
							stop: true,
						},
					};
				};
				const events = await run({ cwd: dir });
				const preview = events.find(
					(event) => event.type === "tool_use_chunk" && event.metadata?.startLine === 42,
				);
				expect(preview).toBeDefined();
				const startedEvent = events.find(
					(event) => event.type === "tool_call" && event.toolUseId === "edit-origin",
				);
				if (startedEvent?.type !== "tool_call") throw new Error("missing tool_call");
				expect(startedEvent.input).not.toHaveProperty("_streamingMetadata");
				expect(startedEvent.input).not.toHaveProperty("_streamingEditOrigin");
				if (changeAtStop) expect(startedEvent.streamingEditOrigin).toBeUndefined();
				else {
					expect(startedEvent.streamingEditOrigin).toMatchObject({
						toolUseId: "edit-origin",
						filePath: "a.ts",
						device: "local",
						startLine: 42,
					});
					expect(
						validateStreamingEditOrigin(
							startedEvent.streamingEditOrigin,
							"edit-origin",
							startedEvent.input,
						),
					).toBeDefined();
				}
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		});
	}
	test("non-streaming model input cannot mint or persist origin annotations", async () => {
		script = async function* () {
			yield {
				toolUses: [
					tool("Edit", "batch-origin", 0, {
						file_path: "a.ts",
						old_string: "old",
						new_string: "new",
						_streamingMetadata: { startLine: 999 },
						_streamingEditOrigin: { startLine: 999 },
					}),
				],
			};
		};
		const events = await run();
		const call = events.find((event) => event.type === "tool_call");
		if (call?.type !== "tool_call") throw new Error("missing tool_call");
		expect(call.streamingEditOrigin).toBeUndefined();
		expect(call.input).not.toHaveProperty("_streamingMetadata");
		expect(call.input).not.toHaveProperty("_streamingEditOrigin");
		const block = events.find(
			(event) => event.type === "block_complete" && event.block.type === "tool_use",
		);
		if (block?.type !== "block_complete" || block.block.type !== "tool_use")
			throw new Error("missing persisted block");
		expect(block.block.input).not.toHaveProperty("_streamingMetadata");
	});
	test("local matcher cannot issue evidence for remote/default-remote, unmatched or over-budget inputs", async () => {
		const dir = await mkdtemp(join(tmpdir(), "nf-edit-origin-"));
		try {
			await writeFile(join(dir, "a.ts"), `${"prefix\n".repeat(41)}old\nline`);
			const acc: {
				name: string;
				extractedFields: Record<string, string>;
				streamingEditOrigin?: StreamingEditOrigin;
			} = {
				name: "Edit",
				extractedFields: { file_path: "a.ts", old_string: "old\r\nline" },
			};
			expect(await resolveStreamingEditMetadata(acc, dir, "edit", "remote")).toBeUndefined();
			expect(acc.streamingEditOrigin).toBeUndefined();
			acc.extractedFields.device = "remote";
			expect(await resolveStreamingEditMetadata(acc, dir, "edit")).toBeUndefined();
			acc.extractedFields.device = "local";
			expect(await resolveStreamingEditMetadata(acc, dir, "edit")).toMatchObject({
				startLine: 42,
				endLine: 43,
			});
			expect(
				validateStreamingEditOrigin(acc.streamingEditOrigin, "edit", {
					file_path: "a.ts",
					old_string: "old\nline",
					device: "local",
				}),
			).toBeDefined();
			delete acc.streamingEditOrigin;
			acc.extractedFields.old_string = "not present";
			expect(await resolveStreamingEditMetadata(acc, dir, "edit")).toMatchObject({
				matchStatus: "unmatched",
			});
			expect(acc.streamingEditOrigin).toBeUndefined();
			acc.extractedFields.old_string = "x".repeat(STREAMING_EDIT_ORIGIN_MAX_CODE_UNITS + 1);
			expect(await resolveStreamingEditMetadata(acc, dir, "edit")).toBeUndefined();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("per-response tool call limit", () => {
	for (const shape of ["batch", "chunks"] as const) {
		test(`711 distinct IDs stop at the default 32 without retry (${shape})`, async () => {
			let providerSignal: AbortSignal | undefined;
			script = async function* (params) {
				providerSignal = params.signal;
				const calls = Array.from({ length: 711 }, (_, i) => ({
					...tool("Read", `value-${i % 13}`, i),
					toolUseId: `call-${i}`,
				}));
				if (shape === "batch") yield { toolUses: calls };
				else {
					for (const call of calls) {
						yield { toolUseChunk: { toolUseId: call.toolUseId, name: call.name } };
						yield {
							toolUseChunk: {
								toolUseId: call.toolUseId,
								input: JSON.stringify(call.input),
								stop: true,
							},
						};
					}
				}
			};
			const controller = new AbortController();
			const limits: number[] = [];
			const events = await run({
				signal: controller.signal,
				onToolCallLimitExceeded: (limit) => {
					limits.push(limit);
				},
			});
			expect(limits).toEqual([32]);
			const errors = events.filter((event) => event.type === "error");
			expect(errors).toHaveLength(1);
			expect(errors[0]?.message).toContain("32");
			expect(
				events.filter(
					(event) => event.type === "block_complete" && event.block.type === "tool_use",
				),
			).toHaveLength(32);
			expect(events.some((event) => event.type === "retrying")).toBe(false);
			expect(
				events.some((event) => event.type === "tool_call" && event.toolUseId === "call-32"),
			).toBe(false);
			expect(providerSignal?.aborted).toBe(true);
			expect(controller.signal.aborted).toBe(false);
			expect(attempts).toBe(1);
		});
	}

	test("safety stop cancels the running tool, retains success and closes queued calls", async () => {
		const running = watch("running");
		abortAwareValues.add("running");
		const controller = new AbortController();
		script = async function* () {
			yield { toolUses: [tool("Read", "success", 0)] };
			await nextTick();
			yield { toolUses: [tool("Write", "running", 1)] };
			await running.started;
			yield {
				toolUses: Array.from({ length: 20 }, (_, i) => ({
					...tool("Edit", "repeat", i + 2),
					toolUseId: `repeat-${i}`,
				})),
			};
		};
		const events = await run({ signal: controller.signal, maxToolCallsPerResponse: 9 });
		expect(started).toEqual(["success", "running"]);
		expect(toolSignals.get("running")?.aborted).toBe(true);
		expect(controller.signal.aborted).toBe(false);
		expect(
			events.filter((event) => event.type === "tool_result" && event.toolUseId === "success"),
		).toEqual([expect.objectContaining({ output: "ok:success", isError: false })]);
		expect(
			events.filter(
				(event) => event.type === "tool_result" && event.toolUseId.startsWith("repeat-"),
			),
		).toHaveLength(7);
		expect(
			events.some(
				(event) =>
					event.type === "block_complete" &&
					event.block.type === "tool_use" &&
					event.block.toolUseId === "repeat-7",
			),
		).toBe(false);
		expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("9") });
		expect(attempts).toBe(1);
	});

	test("129 start-only identities stop and discard incomplete cards", async () => {
		script = async function* () {
			for (let i = 0; i < 711; i++) {
				yield { toolUseChunk: { toolUseId: `start-${i}`, name: "Read" } };
			}
		};
		const limits: number[] = [];
		const events = await run({
			maxToolCallsPerResponse: 128,
			onToolCallLimitExceeded: (limit) => {
				limits.push(limit);
			},
		});
		expect(limits).toEqual([128]);
		expect(events.filter((event) => event.type === "tool_use_chunk")).toHaveLength(128);
		expect(events.filter((event) => event.type === "error")).toEqual([
			expect.objectContaining({ type: "error", message: expect.stringContaining("128") }),
		]);
		expect(
			events
				.filter((event) => event.type === "tool_use_discarded")
				.flatMap((event) => event.toolUseIds),
		).toHaveLength(128);
		expect(started).toEqual([]);
		expect(attempts).toBe(1);
	});

	test("identity budget resets for each provider reply", async () => {
		scriptedAttempts = 2;
		script = async function* () {
			yield {
				toolUses: Array.from({ length: 70 }, (_, i) => tool("Read", `turn-${attempts}-${i}`, i)),
			};
		};
		const events = await run({ maxToolCallsPerResponse: 128 });
		expectSuccess(events);
		expect(started).toHaveLength(140);
		expect(attempts).toBe(3);
	});

	test("post-stream parallel tools use one bounded abort drain", async () => {
		const one = watch("one", true);
		const two = watch("two", true);
		const controller = new AbortController();
		const detached: AgentEvent[] = [];
		script = async function* () {
			yield { toolUses: [tool("Read", "one", 0), tool("Read", "two", 1)] };
		};
		const pending = run({
			signal: controller.signal,
			deferEagerToolsForSafeStop: true,
			onDetachedToolResult: async (event) => {
				detached.push(event);
			},
		});
		try {
			await Promise.all([one.started, two.started]);
			controller.abort();
			const events = await pending;
			expect(events.at(-1)).toMatchObject({ type: "error", message: "Aborted" });
			expect(events.filter((event) => event.type === "tool_result")).toHaveLength(0);
		} finally {
			one.release();
			two.release();
		}
		await nextTick();
		expect(detached).toHaveLength(2);
		expect(detached.every((event) => event.type === "tool_result" && !event.isError)).toBe(true);
	});

	test("abort at a tool_call yield never starts a deferred tool", async () => {
		const controller = new AbortController();
		script = async function* () {
			yield { toolUses: [tool("Read", "one", 0), tool("Read", "two", 1)] };
		};
		const events = await run(
			{ signal: controller.signal, deferEagerToolsForSafeStop: true },
			(event) => {
				if (event.type === "tool_call") controller.abort();
			},
		);
		expect(started).toEqual([]);
		expect(events.at(-1)).toMatchObject({ type: "error", message: "Aborted" });
		expect(attempts).toBe(1);
	});

	test("stream chunks and completed duplicate share one identity budget slot", async () => {
		script = async function* () {
			yield { toolUseChunk: { toolUseId: "same", name: "Read" } };
			yield { toolUseChunk: { toolUseId: "same", input: '{"value":"same"}', stop: true } };
			yield { toolUses: [tool("Read", "same", 0)] };
		};
		const events = await run({ maxToolCallsPerResponse: 1 });
		expectSuccess(events);
		expect(started).toEqual(["same"]);
	});

	test("configured limit allows 100 distinct tools", async () => {
		script = async function* () {
			yield { toolUses: Array.from({ length: 100 }, (_, i) => tool("Read", `different-${i}`, i)) };
		};
		const events = await run({ maxToolCallsPerResponse: 128 });
		expectSuccess(events);
		expect(started).toHaveLength(100);
	});

	test("abort inside a batch ignores cached provider calls and preserves finished results", async () => {
		const controller = new AbortController();
		script = async function* () {
			yield { toolUses: [tool("Read", "finished", 0)] };
			await nextTick();
			yield {
				toolUses: Array.from({ length: 711 }, (_, i) => tool("Read", `buffered-${i}`, i + 1)),
			};
			// Deliberately ignores params.signal, like an already decoded SSE buffer.
			yield { toolUses: [tool("Read", "cached-late", 999)] };
		};
		const events = await run({ signal: controller.signal }, (event) => {
			if (
				event.type === "block_complete" &&
				event.block.type === "tool_use" &&
				event.block.toolUseId === "buffered-0"
			)
				controller.abort();
		});
		expect(started).toEqual(["finished"]);
		expect(
			events.filter((event) => event.type === "tool_result" && event.toolUseId === "finished"),
		).toEqual([expect.objectContaining({ isError: false, output: "ok:finished" })]);
		expect(
			events.some(
				(event) =>
					event.type === "tool_result" && event.toolUseId === "buffered-0" && event.isError,
			),
		).toBe(true);
		expect(
			events.some((event) => event.type === "tool_call" && event.toolUseId === "cached-late"),
		).toBe(false);
		expect(attempts).toBe(1);
	});
});

describe("ordered streaming tool scheduling", () => {
	test("Write starts with Edit input still open, then serial Write → Edit → Read finishes before stream end", async () => {
		const write = watch("write", true);
		const edit = watch("edit", true);
		const read = watch("read");
		const editInputOpen = gate();
		const completeEdit = gate();
		const streamPending = gate();
		const endStream = gate();
		script = async function* () {
			yield { toolUses: [tool("Write", "write", 0)] };
			yield { toolUseChunk: { toolUseId: "edit", name: "Edit", outputIndex: 1 } };
			editInputOpen.resolve();
			await completeEdit.promise;
			yield { toolUseChunk: { toolUseId: "edit", input: '{"value":"edit"}', stop: true } };
			yield { toolUses: [tool("Read", "read", 2)] };
			streamPending.resolve();
			await endStream.promise;
		};
		const result = run();
		try {
			await editInputOpen.promise;
			await write.started;
			expect(started).toEqual(["write"]);
			completeEdit.resolve();
			await streamPending.promise;
			await nextTick();
			expect(started).toEqual(["write"]);
			write.release();
			await edit.started;
			expect(started).toEqual(["write", "edit"]);
			edit.release();
			await read.started;
			expect(started).toEqual(["write", "edit", "read"]);
		} finally {
			completeEdit.resolve();
			write.release();
			edit.release();
			endStream.resolve();
		}
		expectSuccess(await result);
	});

	for (const shape of [
		"out-of-order completion",
		"one reversed batch",
		"mixed complete and partial event",
	] as const) {
		test(`${shape} cannot pass incomplete or unpersisted predecessor`, async () => {
			const first = watch("first", true);
			const second = watch("second");
			const secondReady = gate();
			const completeFirst = gate();
			const persistenceEntered = gate();
			const persisted = gate();
			const firstCallYielded = gate();
			const consumeFirstCall = gate();
			const endStream = gate();
			script = async function* () {
				if (shape === "one reversed batch") {
					yield { toolUses: [tool("Read", "second", 1), tool("Write", "first", 0)] };
				} else {
					if (shape === "mixed complete and partial event") {
						yield {
							toolUses: [tool("Read", "second", 1)],
							toolUseChunk: { toolUseId: "first", name: "Write", outputIndex: 0 },
						};
					} else {
						yield { toolUseChunk: { toolUseId: "first", name: "Write", outputIndex: 0 } };
						yield { toolUses: [tool("Read", "second", 1)] };
					}
					secondReady.resolve();
					await completeFirst.promise;
					yield { toolUseChunk: { toolUseId: "first", input: '{"value":"first"}', stop: true } };
				}
				await endStream.promise;
			};
			const result = run({}, async (event) => {
				if (event.type === "block_complete" && event.block.type === "tool_use") {
					if (event.block.toolUseId === "second") secondReady.resolve();
					if (event.block.toolUseId === "first") {
						persistenceEntered.resolve();
						await persisted.promise;
					}
					event.onToolPersisted?.({ toolCallId: event.block.toolUseId, attempt: 1 });
				}
				if (event.type === "tool_call" && event.toolUseId === "first") {
					firstCallYielded.resolve();
					await consumeFirstCall.promise;
				}
			});
			try {
				await secondReady.promise;
				await nextTick();
				expect(started).toEqual([]);
				completeFirst.resolve();
				await persistenceEntered.promise;
				await nextTick();
				expect(started).toEqual([]);
				persisted.resolve();
				await firstCallYielded.promise;
				await nextTick();
				expect(started).toEqual([]);
				consumeFirstCall.resolve();
				await first.started;
				expect(started).toEqual(["first"]);
				first.release();
				await second.started;
				expect(started).toEqual(["first", "second"]);
			} finally {
				completeFirst.resolve();
				persisted.resolve();
				consumeFirstCall.resolve();
				first.release();
				endStream.resolve();
			}
			expectSuccess(await result);
		});
	}

	test("pending permission lets provider produce next chunk but prevents execution and serial overtaking", async () => {
		const permissionEntered = gate();
		const allow = gate();
		const nextChunkConsumed = gate();
		const endStream = gate();
		const write = watch("write");
		const read = watch("read");
		script = async function* () {
			yield { toolUses: [tool("Write", "write", 0)] };
			yield { toolUses: [tool("Read", "read", 1)], text: "next chunk" };
			nextChunkConsumed.resolve();
			await endStream.promise;
		};
		const result = run({
			permissionHandler: async () => {
				permissionEntered.resolve();
				await allow.promise;
				return { behavior: "allow" };
			},
		});
		try {
			await permissionEntered.promise;
			await nextChunkConsumed.promise;
			expect(started).toEqual([]);
			allow.resolve();
			await write.started;
			await read.started;
			expect(started).toEqual(["write", "read"]);
		} finally {
			allow.resolve();
			endStream.resolve();
		}
		expectSuccess(await result);
	});

	for (const name of [
		"Agent",
		"Await",
		"Send",
		"EnterPlanMode",
		"DangerConfirm",
		"TaskReflectConfirm",
		"ExitPlanConfirm",
		"Write",
		"Edit",
	]) {
		const virtualWrite = name === "Write" || name === "Edit";
		test(`${virtualWrite ? `virtual spec ${name}` : name} defers itself and following Read until stream end`, async () => {
			const streamPending = gate();
			const endStream = gate();
			script = async function* () {
				yield {
					toolUses: [
						tool(name, "control", 0, virtualWrite ? { file_path: "spec://notes.json" } : {}),
						tool("Read", "read", 1),
					],
				};
				streamPending.resolve();
				await endStream.promise;
			};
			const result = run();
			try {
				await streamPending.promise;
				await nextTick();
				expect(started).toEqual([]);
			} finally {
				endStream.resolve();
			}
			expectSuccess(await result);
			expect(started).toEqual(["control", "read"]);
		});
	}

	test("before and after snapshot promises bracket Write and block the following Read without blocking the stream", async () => {
		const beforeEntered = gate();
		const finishBefore = gate();
		const afterEntered = gate();
		const finishAfter = gate();
		const streamPending = gate();
		const endStream = gate();
		const read = watch("read");
		const lifecycle: string[] = [];
		script = async function* () {
			yield { toolUses: [tool("Write", "write", 0), tool("Read", "read", 1)] };
			streamPending.resolve();
			await endStream.promise;
		};
		const result = run({
			onToolExecutionBefore: async ({ toolUse }) => {
				lifecycle.push(`before:${toolUse.toolUseId}`);
				if (toolUse.toolUseId === "write") {
					beforeEntered.resolve();
					await finishBefore.promise;
				}
			},
			onToolExecutionAfter: async ({ toolUse }) => {
				lifecycle.push(`after:${toolUse.toolUseId}`);
				if (toolUse.toolUseId === "write") {
					afterEntered.resolve();
					await finishAfter.promise;
				}
			},
		});
		try {
			await beforeEntered.promise;
			await streamPending.promise;
			expect(started).toEqual([]);
			finishBefore.resolve();
			await afterEntered.promise;
			await nextTick();
			expect(started).toEqual(["write"]);
			expect(lifecycle).toEqual(["before:write", "after:write"]);
			finishAfter.resolve();
			await read.started;
			expect(started).toEqual(["write", "read"]);
		} finally {
			finishBefore.resolve();
			finishAfter.resolve();
			endStream.resolve();
		}
		expectSuccess(await result);
		expect(lifecycle).toEqual(["before:write", "after:write", "before:read", "after:read"]);
	});

	test("safe-stop opt-in defers Write and Read for the entire stream", async () => {
		const streamPending = gate();
		const endStream = gate();
		script = async function* () {
			yield { toolUses: [tool("Write", "write", 0), tool("Read", "read", 1)] };
			streamPending.resolve();
			await endStream.promise;
		};
		const result = run({ deferEagerToolsForSafeStop: true });
		try {
			await streamPending.promise;
			await nextTick();
			expect(started).toEqual([]);
		} finally {
			endStream.resolve();
		}
		expectSuccess(await result);
		expect(started).toEqual(["write", "read"]);
	});

	for (const ending of ["silent-disconnect", "invalid-state", "throw"] as const) {
		test(`${ending} drains in-flight Write exactly once and never starts queued Edit after closing the stream`, async () => {
			const write = watch("write", true);
			const editQueued = gate();
			const failStream = gate();
			const failureDelivered = gate();
			let returned = false;
			script = async function* () {
				yield { toolUses: [tool("Write", "write", 0)] };
				await write.started;
				yield { toolUses: [tool("Edit", "edit", 1)] };
				editQueued.resolve();
				await failStream.promise;
				if (ending === "throw") {
					failureDelivered.resolve();
					throw new Error("terminal stream failure");
				}
				// The marker is yielded only after the loop has closed streaming execution.
				if (ending === "silent-disconnect") {
					yield { silentDisconnect: true, text: "terminal boundary" };
				} else {
					yield {
						invalidState: { reason: "authentication_error", message: "Invalid API key" },
						text: "terminal boundary",
					};
				}
			};
			const result = run({}, (event) => {
				if (event.type === "stream_text" && event.text === "terminal boundary") {
					failureDelivered.resolve();
				}
			}).then((events) => {
				returned = true;
				return events;
			});
			try {
				await editQueued.promise;
				expect(started).toEqual(["write"]);
				failStream.resolve();
				await failureDelivered.promise;
				await nextTick();
				// The terminal path must wait for the executing write, not drop its result.
				expect(returned).toBe(false);
				expect(started).toEqual(["write"]);
				write.release();
				const events = await result;
				expect(started).toEqual(["write"]);
				expect(attempts).toBe(1);
				const results = events.filter((event) => event.type === "tool_result");
				expect(results).toHaveLength(1);
				expect(results[0]).toMatchObject({
					toolUseId: "write",
					isError: false,
					output: "ok:write",
				});
				const terminal =
					ending === "silent-disconnect"
						? "silent_disconnect"
						: ending === "invalid-state"
							? "invalid_state"
							: "error";
				expect(events.at(-1)?.type).toBe(terminal);
			} finally {
				failStream.resolve();
				write.release();
			}
		});
	}

	for (const ending of ["soft-stop", "abort", "stream-error"] as const) {
		test(`${ending} after a streamed Write never repeats its side effect`, async () => {
			const write = watch("write");
			const ac = new AbortController();
			let stopped = false;
			script = async function* () {
				yield { toolUses: [tool("Write", "write", 0)] };
				await write.started;
				await nextTick();
				if (ending === "abort") ac.abort();
				if (ending === "soft-stop") stopped = true;
				if (ending === "stream-error") throw new Error("stream failed after side effect");
				yield { text: "stop boundary" };
			};
			const events = await run({ signal: ac.signal, shouldStop: () => stopped });
			expect(started).toEqual(["write"]);
			expect(
				events.filter((event) => event.type === "tool_result" && event.toolUseId === "write")
					.length,
			).toBeLessThanOrEqual(1);
			if (ending === "soft-stop") expectSuccess(events);
		});
	}
});

describe("detached eager tool results after interruption", () => {
	function persistReceipt(event: AgentEvent) {
		if (event.type === "block_complete" && event.block.type === "tool_use") {
			event.onToolPersisted?.({ toolCallId: `row-${event.block.toolUseId}`, attempt: 1 });
		}
	}

	test("a finished Write survives a slow after snapshot without blocking abort or starting queued Edit", async () => {
		const ac = new AbortController();
		const afterEntered = gate();
		const finishAfter = gate();
		const persisted = gate();
		const detached: Array<Extract<AgentEvent, { type: "tool_result" }>> = [];
		script = async function* () {
			yield { toolUses: [tool("Write", "write", 0), tool("Edit", "queued", 1)] };
			await afterEntered.promise;
			ac.abort();
			throw new Error("Aborted");
		};
		try {
			const events = await run(
				{
					signal: ac.signal,
					requireToolCallBinding: true,
					onToolExecutionStarting: async (_id, binding) => binding,
					onToolExecutionAfter: async ({ toolUse, result }) => {
						if (toolUse.toolUseId !== "write") return;
						expect(result?.output).toBe("ok:write");
						afterEntered.resolve();
						await finishAfter.promise;
					},
					onDetachedToolResult: async (event) => {
						detached.push(event);
						persisted.resolve();
					},
				},
				persistReceipt,
			);
			expect(events.at(-1)).toMatchObject({ type: "error", message: "Aborted" });
			expect(events.filter((event) => event.type === "tool_result")).toEqual([
				expect.objectContaining({ toolUseId: "queued", isError: true, durationMs: 0 }),
			]);
			expect(detached).toEqual([]);
			expect(started).toEqual(["write"]);
			finishAfter.resolve();
			await persisted.promise;
			await nextTick();
			expect(detached).toHaveLength(1);
			expect(detached[0]).toMatchObject({
				type: "tool_result",
				toolUseId: "write",
				toolCallBinding: { toolCallId: "row-write", attempt: 1 },
				output: "ok:write",
				isError: false,
			});
			expect(started).toEqual(["write"]);
		} finally {
			finishAfter.resolve();
		}
	});

	for (const failed of [false, true]) {
		test(`an in-flight Write persists its real ${failed ? "failure" : "success"} after the consumer exits`, async () => {
			const ac = new AbortController();
			const write = watch("write", true);
			const persisted = gate();
			const detached: Array<Extract<AgentEvent, { type: "tool_result" }>> = [];
			if (failed) executionFailures.add("write");
			script = async function* () {
				yield { toolUses: [tool("Write", "write", 0), tool("Edit", "queued", 1)] };
				await write.started;
				ac.abort();
				throw new Error("Aborted");
			};
			try {
				const events = await run(
					{
						signal: ac.signal,
						requireToolCallBinding: true,
						onToolExecutionStarting: async (_id, binding) => binding,
						onDetachedToolResult: async (event) => {
							detached.push(event);
							persisted.resolve();
						},
					},
					persistReceipt,
				);
				expect(events.at(-1)).toMatchObject({ type: "error", message: "Aborted" });
				expect(detached).toEqual([]);
				write.release();
				await persisted.promise;
				await nextTick();
				expect(detached).toHaveLength(1);
				expect(detached[0]).toMatchObject({
					toolCallBinding: { toolCallId: "row-write", attempt: 1 },
					output: failed ? "Tool error: failed:write" : "ok:write",
					isError: failed,
				});
				expect(started).toEqual(["write"]);
			} finally {
				write.release();
			}
		});
	}

	test("results delivered by the abort drain are not persisted again as detached", async () => {
		const ac = new AbortController();
		const write = watch("write");
		const detached = mock(async (_event: AgentEvent) => {});
		script = async function* () {
			yield { toolUses: [tool("Write", "write", 0)] };
			await write.started;
			await nextTick();
			ac.abort();
			throw new Error("Aborted");
		};
		const events = await run({ signal: ac.signal, onDetachedToolResult: detached });
		expect(events.filter((event) => event.type === "tool_result")).toHaveLength(1);
		expect(detached).not.toHaveBeenCalled();
	});
});
