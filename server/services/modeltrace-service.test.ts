import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
	forgetModelTraceRequest,
	rememberModelTraceRequest,
} from "@server/lib/agent/modeltrace-request";
import type { ChatParams, ParsedStreamEvent, ProviderAdapter } from "@server/lib/agent/provider";
import { buildModelTracePrompt } from "@server/lib/modeltrace";
import type { ModelTraceResultBlock } from "@shared/modeltrace-result";

const latestRef = mock(async () => ({ messageId: "latest-parent-message" }));
const fork = mock(async (..._args: unknown[]) => ({ id: "probe", traits: ["standalone"] }));
const updateWhere = mock(async (..._args: unknown[]) => {});
const updateSet = mock((_values: unknown) => ({ where: updateWhere }));
const persistUser = mock(async (..._args: unknown[]) => ({
	id: "user-row",
	seq: 20,
	role: "user",
}));
const persistAssistant = mock(async (..._args: unknown[]) => ({
	id: "assistant-row",
	seq: 21,
	role: "assistant",
}));
const persistDisplay = mock(async (..._args: unknown[]) => ({}));
const updateConversationId = mock(async (..._args: unknown[]) => true);
let idle = Promise.withResolvers<void>();
const status = mock(async (_id: string, state: string) => {
	if (state === "idle") idle.resolve();
});
const broadcast = mock((..._args: unknown[]) => {});
let claimed = false;
let woke = Promise.withResolvers<void>();
const wake = mock(async (..._args: unknown[]) => {
	expect(claimed).toBe(false);
	woke.resolve();
	return true;
});
const release = mock(() => {
	claimed = false;
	return true;
});
const claim = mock((_id: string, _kind: string) => {
	if (claimed) return null;
	claimed = true;
	return { release, isCurrent: () => true };
});
mock.module("@server/db", () => ({
	db: {
		query: { narratorMessageRefs: { findFirst: latestRef } },
		update: () => ({ set: updateSet }),
	},
}));
mock.module("./narrator-service", () => ({ narratorService: { forkNarrator: fork } }));
mock.module("./narrator-persistence", () => ({
	narratorPersistence: {
		persistUserMessage: persistUser,
		persistAssistantMessage: persistAssistant,
		persistDisplayMessage: persistDisplay,
		updateConversationId,
		updateStatus: status,
	},
}));
mock.module("./agent-runtime/ownership", () => ({ tryClaimExecution: claim }));
mock.module("./agent-runtime/inbox", () => ({ wakeInboxIfEligible: wake }));
mock.module("@server/websocket/narrator-ws", () => ({ broadcastToNarrator: broadcast }));
const { startModelTrace, cancelModelTrace } = await import("./modeltrace-service");
let received: ChatParams | undefined;
let events: ParsedStreamEvent[];
let source: ChatParams;
const chat = mock(async function* (params: ChatParams) {
	received = params;
	for (const event of events) yield event;
});
const parentController = new AbortController();

beforeEach(() => {
	idle = Promise.withResolvers<void>();
	woke = Promise.withResolvers<void>();
	wake.mockClear();
	claimed = false;
	received = undefined;
	events = [
		{ text: JSON.stringify(Array(300).fill(17)) },
		{ usage: { inputTokens: 42, completionTokens: 99 } },
		{ stopReason: "end_turn" },
	];
	for (const fn of [
		latestRef,
		updateSet,
		updateWhere,
		fork,
		persistUser,
		persistAssistant,
		persistDisplay,
		updateConversationId,
		status,
		broadcast,
		claim,
		release,
		chat,
	])
		fn.mockClear();
	chat.mockImplementation(async function* (params: ChatParams) {
		received = params;
		for (const event of events) yield event;
	});
	source = {
		conversationId: "parent-upstream",
		stickySessionKey: "parent-sticky",
		content: "original parent content",
		model: "gpt-5.4",
		cwd: "/work",
		history: [{ role: "system", content: "frozen system" }],
		tools: [{ name: "Bash" }],
		toolLoadingStrategy: "replace_tools",
		toolResults: [{ id: "old-tool-result" }],
		images: [{ format: "png", base64: "image" }],
		metadata: { user_id: "parent-metadata" },
		signal: parentController.signal,
		onRequestStart: mock(() => {}),
		onInputCharacters: mock(() => {}),
		requestDump: {} as ChatParams["requestDump"],
		reasoningEffort: "high",
		maxOutputTokens: 2048,
		resetUpstreamSession: true,
	};
	rememberModelTraceRequest("parent", { chat } as unknown as ProviderAdapter, source);
});
afterEach(() => {
	forgetModelTraceRequest("parent");
	cancelModelTrace("probe");
});

function reportedResult(): ModelTraceResultBlock {
	return (persistDisplay.mock.calls[0]?.[2] as ModelTraceResultBlock[])[0];
}

async function complete() {
	const result = await startModelTrace("parent", "operator", "en");
	await idle.promise;
	await woke.promise;
	return result;
}

describe("ModelTrace independent single-request probe", () => {
	test("forks at the latest ref, reuses frozen upstream request and saves one raw answer plus local reports", async () => {
		expect(await complete()).toEqual({ id: "probe" });
		expect(fork).toHaveBeenCalledWith("parent", null, {
			title: "ModelTrace",
			inheritMode: "full",
			specCarryover: "clear",
			forkMessageId: "latest-parent-message",
			userId: "operator",
			locale: "en",
		});
		expect(chat).toHaveBeenCalledTimes(1);
		expect(received?.content).toBe(`${source.content}\n\n${buildModelTracePrompt()}`);
		for (const field of ["history", "tools", "toolResults", "images"] as const) {
			expect(received?.[field]).toEqual(source[field]);
			expect(received?.[field]).not.toBe(source[field]);
		}
		expect(received?.conversationId).toBe("parent-upstream");
		expect(received?.stickySessionKey).toBe("parent-sticky");
		expect(received?.transportSessionKey).toBe("probe");
		expect(received?.toolLoadingStrategy).toBe("replace_tools");
		expect(received?.reasoningEffort).toBe("high");
		expect(received?.maxOutputTokens).toBe(2048);
		expect(received?.resetUpstreamSession).toBe(false);
		expect(received?.signal).not.toBe(source.signal);
		expect(received?.onRequestStart).toBeUndefined();
		expect(received?.onInputCharacters).toBeUndefined();
		expect(received?.requestDump).toBeUndefined();
		expect(source.onRequestStart).not.toHaveBeenCalled();
		expect(source.onInputCharacters).not.toHaveBeenCalled();
		expect(updateConversationId).not.toHaveBeenCalled();
		expect(persistUser).toHaveBeenCalledWith(
			"probe",
			buildModelTracePrompt(),
			undefined,
			"/modeltrace",
			"operator",
		);
		expect(persistAssistant).toHaveBeenCalledTimes(1);
		expect(persistAssistant.mock.calls[0]?.[1]).toMatchObject({
			model: "gpt-5.4",
			outputTokens: 99,
			message: { usage: { input_tokens: 42, output_tokens: 99 } },
		});
		expect(persistDisplay).toHaveBeenCalledTimes(1);
		expect(persistDisplay.mock.calls.map((call) => call[0])).toEqual(["probe"]);
		expect(reportedResult().type).toBe("modeltrace_result");
		expect(reportedResult().results).toHaveLength(5);
		expect(reportedResult().error).toBeUndefined();
		expect(updateSet).toHaveBeenCalledWith({
			traits: ["standalone", "modeltrace"],
			parentNarratorId: "parent",
		});
		expect(broadcast).toHaveBeenCalledTimes(2);
		expect(claim).toHaveBeenCalledWith("probe", "run");
		expect(status.mock.calls.map((call) => call.slice(0, 2))).toEqual([
			["probe", "working"],
			["probe", "idle"],
		]);
		expect(release).toHaveBeenCalledTimes(1);
		expect(wake).toHaveBeenCalledWith("probe", "en");
		expect(cancelModelTrace("probe")).toBe(false);
		expect(parentController.signal.aborted).toBe(false);
	});

	test("queued child input is eligible for an inbox wake only after the probe releases its owner", async () => {
		let queued = true;
		wake.mockImplementationOnce(async () => {
			expect(claimed).toBe(false);
			queued = false;
			woke.resolve();
			return true;
		});
		await complete();
		expect(queued).toBe(false);
		expect(wake).toHaveBeenCalledWith("probe", "en");
	});

	test("requires a previous request and does not create an empty fork", async () => {
		forgetModelTraceRequest("parent");
		await expect(startModelTrace("parent", "operator")).rejects.toThrow("先发送一条消息");
		expect(fork).not.toHaveBeenCalled();
		expect(chat).not.toHaveBeenCalled();
	});

	for (const [name, event] of [
		["tool call", { toolUses: [{ id: "t", name: "Bash", input: {} }] }],
		["streaming tool", { toolUseChunk: { toolUseId: "t", name: "Bash" } }],
		["native search", { webSearch: { id: "s", status: "searching" } }],
		["truncation", { stopReason: "max_tokens" }],
		["provider error", { invalidState: { reason: "broken", message: "upstream failure" } }],
		["silent disconnect", { silentDisconnect: true }],
	] as Array<[string, ParsedStreamEvent]>) {
		test(`${name} fails without an extra sampling round or a scored report`, async () => {
			events = [event, { text: JSON.stringify(Array(300).fill(17)) }];
			await complete();
			expect(chat).toHaveBeenCalledTimes(1);
			expect(reportedResult().error).toBeTruthy();
			expect(reportedResult().results).toEqual([]);
			expect(persistDisplay.mock.calls.map((call) => call[0])).toEqual(["probe"]);

			expect(persistAssistant).not.toHaveBeenCalled();
			expect(release).toHaveBeenCalledTimes(1);
		});
	}

	for (const terminal of [
		{ stopReason: "max_tokens" },
		{ invalidState: { reason: "broken", message: "upstream failure" } },
	]) {
		test(`keeps terminal usage, identity and partial text before ${JSON.stringify(terminal)}`, async () => {
			events = [
				{ text: "[17,", usage: { inputTokens: 42 } },
				{
					...terminal,
					text: "203",
					usage: { completionTokens: 99, cachedInputTokens: 12, reasoningTokens: 4 },
					messageId: "terminal-message",
					credentialId: "terminal-credential",
				},
			];
			await complete();
			expect(persistAssistant).toHaveBeenCalledTimes(1);
			expect(persistAssistant.mock.calls[0]?.[1]).toMatchObject({
				uuid: "terminal-message",
				credentialId: "terminal-credential",
				outputTokens: 99,
				cachedInputTokens: 12,
				reasoningTokens: 4,
				message: {
					content: [{ type: "text", text: "[17,203" }],
					usage: { input_tokens: 42, output_tokens: 99 },
				},
			});
			expect(reportedResult().error).toBeTruthy();
			expect(reportedResult().results).toEqual([]);
			expect(persistDisplay.mock.calls.map((call) => call[0])).toEqual(["probe"]);

			expect(chat).toHaveBeenCalledTimes(1);
		});
	}

	test.each([
		"STOP",
		"completed",
		"stop",
		"end_turn",
		"stop_sequence",
	])("accepts provider success reason %s", async (stopReason) => {
		events[2] = { stopReason };
		await complete();
		expect(reportedResult().results).toHaveLength(5);
	});

	test.each(["error", "outputTruncated"])("rejects explicit provider %s flags", async (key) => {
		events = [{ [key]: true } as ParsedStreamEvent];
		await complete();
		expect(reportedResult().error).toBeTruthy();
		expect(reportedResult().results).toEqual([]);
		expect(persistDisplay.mock.calls.map((call) => call[0])).toEqual(["probe"]);
		expect(chat).toHaveBeenCalledTimes(1);
	});

	test("startup persistence failure releases the child and does not call the provider", async () => {
		persistUser.mockRejectedValueOnce(new Error("database unavailable"));
		await expect(startModelTrace("parent", "operator")).rejects.toThrow("database unavailable");
		expect(release).toHaveBeenCalledTimes(1);
		expect(cancelModelTrace("probe")).toBe(false);
		expect(chat).not.toHaveBeenCalled();
		expect(status).toHaveBeenLastCalledWith("probe", "idle");
	});

	test("refusal is saved verbatim, then locally reported as unscorable", async () => {
		events = [{ text: "I cannot comply." }];
		await complete();
		expect(persistAssistant.mock.calls[0]?.[1]).toMatchObject({
			message: { content: [{ type: "text", text: "I cannot comply." }] },
		});
		expect(reportedResult().error).toBeTruthy();
		expect(reportedResult().results).toEqual([]);
		expect(persistDisplay.mock.calls.map((call) => call[0])).toEqual(["probe"]);
		expect(chat).toHaveBeenCalledTimes(1);
	});

	test("oversized output stops at the character cap", async () => {
		events = [{ text: "x".repeat(10_001) }];
		await complete();
		expect(reportedResult().error).toContain("10,000");
		expect(persistAssistant).not.toHaveBeenCalled();
	});

	test("child cancellation releases ownership even if the provider ignores its signal", async () => {
		const started = Promise.withResolvers<void>();
		chat.mockImplementation((params: ChatParams) => {
			received = params;
			started.resolve();
			return {
				next: () => new Promise(() => {}),
				return: async () => ({ done: true, value: undefined }),
			} as unknown as AsyncGenerator<ParsedStreamEvent>;
		});
		await startModelTrace("parent", "operator");
		await started.promise;
		expect(cancelModelTrace("probe")).toBe(true);
		await idle.promise;
		await woke.promise;
		expect(received?.signal.aborted).toBe(true);
		expect(parentController.signal.aborted).toBe(false);
		expect(release).toHaveBeenCalledTimes(1);
		expect(reportedResult().error).toContain("canceled");
	});

	test("the total timeout is independent of upstream signal compliance", async () => {
		const original = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			fn: () => void,
			ms: number,
		) => original(fn, ms === 180_000 ? 1 : ms)) as typeof setTimeout);
		try {
			chat.mockImplementation(
				() =>
					({
						next: () => new Promise(() => {}),
						return: async () => ({ done: true, value: undefined }),
					}) as unknown as AsyncGenerator<ParsedStreamEvent>,
			);
			await complete();
			expect(reportedResult().error).toContain("timed out");
			expect(release).toHaveBeenCalledTimes(1);
		} finally {
			timer.mockRestore();
		}
	});
});
