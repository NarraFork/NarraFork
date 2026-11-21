import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
	forgetModelTraceRequest,
	getModelTraceRequest,
	rememberModelTraceRequest,
} from "@server/lib/agent/modeltrace-request";
import type { ChatParams, ParsedStreamEvent, ProviderAdapter } from "@server/lib/agent/provider";
import type { AgentEvent } from "@server/lib/agent/types";
import type { ModelTraceResultBlock } from "@shared/modeltrace-result";
import type { EventHandlerContext } from "./narrator-event-handler";

const challenge = { prompt: "sample one", expectedCount: 300 };
const challenges = [
	challenge,
	{ prompt: "sample two", expectedCount: 240 },
	{ prompt: "sample three", expectedCount: 360 },
];
const ranked: ModelTraceResultBlock = {
	type: "modeltrace_result",
	decision: "partial",
	results: [{ model: "candidate", displayName: "Candidate", probability: null }],
};
const analyze = mock(
	async (
		outputs: { text: string; expected_count: number }[],
		_locale?: string,
		_signal?: AbortSignal,
	): Promise<ModelTraceResultBlock> =>
		outputs[0]?.text.startsWith("[")
			? ranked
			: { type: "modeltrace_result", results: [], error: "unscorable" },
);
mock.module("@server/lib/modeltrace", () => ({
	buildModelTraceChallenges: (count = 1) => challenges.slice(0, count),
	analyzeModelTrace: analyze,
	MODELTRACE_MAX_TEXT_LENGTH: 10_000,
}));

const latestRef = mock(async () => ({ messageId: "latest-parent-message" }));
const childRow = mock(
	async (): Promise<{ traits: string[]; status: string; model?: string }> => ({
		traits: ["modeltrace"],
		status: "idle",
		model: "configured:some-model",
	}),
);
const startRequest = mock((..._args: unknown[]) => ({ id: "request", startTime: Date.now() }));
const finishRequest = mock(async (..._args: unknown[]) => "request");
mock.module("@server/lib/api-request-tracker", () => ({
	startApiRequest: startRequest,
	finishApiRequest: finishRequest,
}));
const fork = mock(async (..._args: unknown[]) => "probe");
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
const status = mock(async (_id: string, state: string, _options?: unknown) => {
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
		query: { narratorMessageRefs: { findFirst: latestRef }, narrators: { findFirst: childRow } },
		update: () => ({ set: updateSet }),
	},
}));
mock.module("./narrator-service", () => ({ narratorService: { forkNarrator: fork } }));
// 舱的存取（建/复用、清历史、按模型查找）单独成模块，这里只关心探测流程：
// 用固定 id 的桩替换，断言「同一个模型复用舱、先清历史再跑」在本套件里可见。
const ensureTrace = mock(async (..._args: unknown[]) => "probe");
const clearTrace = mock(async (..._args: unknown[]) => {});
mock.module("./modeltrace-store", () => ({
	ensureTraceNarrator: ensureTrace,
	clearTraceHistory: clearTrace,
	createDiagnosticNarrator: fork,
}));
mock.module("./narrator-persistence", () => ({
	narratorPersistence: {
		persistUserMessage: persistUser,
		persistAssistantMessage: persistAssistant,
		persistDisplayMessage: persistDisplay,
		updateConversationId,
		updateStatus: status,
		patchStepMeta: (...args: unknown[]) => patchStepMeta(...args),
	},
}));
const patchStepMeta = mock(async (..._args: unknown[]) => {});
const process = mock(
	async (
		event: AgentEvent,
		ctx: EventHandlerContext,
		hooks?: { onTitleCheck?: (id: string) => Promise<unknown> },
	) => {
		if (event.type === "block_complete") ctx.setPartialMessageId("assistant-row");
		if (event.type === "assistant_message") {
			const usage = ctx.getTokenUsage();
			await persistAssistant(ctx.narratorId, {
				uuid: event.messageId,
				credentialId: event.credentialId,
				model: ctx.model,
				outputTokens: usage?.completionTokens,
				cachedInputTokens: usage?.cachedInputTokens,
				reasoningTokens: usage?.reasoningTokens,
				message: {
					content: [{ type: "text", text: event.text }],
					usage: { input_tokens: usage?.inputTokens, output_tokens: usage?.completionTokens },
				},
			});
			await hooks?.onTitleCheck?.("assistant-row");
		}
		return null;
	},
);
mock.module("./narrator-event-handler", () => ({
	processEvent: process,
	clearStreamingSnapshot: mock(() => {}),
}));
mock.module("./agent-runtime/ownership", () => ({ tryClaimExecution: claim }));
mock.module("./agent-runtime/inbox", () => ({ wakeInboxIfEligible: wake }));
mock.module("./narrator-acl", () => ({
	loadNarratorForAccess: async () => ({ id: "parent" }),
	assertNarratorAccess: async () => {},
}));
mock.module("@server/websocket/narrator-ws", () => ({ broadcastToNarrator: broadcast }));
const { startModelTrace, retryModelTrace, cancelModelTrace } = await import("./modeltrace-service");
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
		analyze,
		latestRef,
		childRow,
		startRequest,
		finishRequest,
		updateSet,
		updateWhere,
		fork,
		ensureTrace,
		clearTrace,
		persistUser,
		persistAssistant,
		process,
		patchStepMeta,
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
	rememberModelTraceRequest(
		"parent",
		{ chat, supportsDiagnosticFork: () => true } as unknown as ProviderAdapter,
		source,
		"frozen-provider",
		"affinity-credential",
	);
});
afterEach(() => {
	forgetModelTraceRequest("parent");
	forgetModelTraceRequest("probe");
	cancelModelTrace("probe");
});

function reportedResult(): ModelTraceResultBlock {
	return (persistDisplay.mock.calls[0]?.[2] as ModelTraceResultBlock[])[0];
}

async function complete(options?: Parameters<typeof startModelTrace>[3]) {
	const result = await startModelTrace("parent", "operator", "en", options);
	await idle.promise;
	await woke.promise;
	return result;
}

describe("ModelTrace independent single-request probe", () => {
	test("records exactly one operator-owned request with normalized cache buckets and persisted message identity", async () => {
		chat.mockImplementation(async function* (params: ChatParams) {
			received = params;
			params.onRequestStart?.({ credentialId: "first-credential" });
			params.onRequestStart?.({ credentialId: "final-credential" });
			yield { text: JSON.stringify(Array(300).fill(17)), messageId: "upstream-id" };
			yield {
				usage: {
					inputTokens: 100,
					completionTokens: 20,
					cachedInputTokens: 800,
					cacheCreationInputTokens: 50,
					cacheCreation5mTokens: 10,
					cacheCreation1hTokens: 40,
					reasoningTokens: 5,
				},
				metering: { unit: "credit", unitPlural: "credits", usage: 1.5 },
				contextUsagePercentage: 12,
			};
		});
		await complete();
		expect(startRequest).toHaveBeenCalledTimes(1);
		expect(startRequest).toHaveBeenCalledWith({
			kind: "modeltrace",
			userId: "operator",
			narratorId: "probe",
			provider: "frozen-provider",
			model: "gpt-5.4",
		});
		expect(finishRequest).toHaveBeenCalledTimes(1);
		expect(finishRequest.mock.calls[0]?.[1]).toMatchObject({
			messageId: "assistant-row",
			credentialId: "final-credential",
			contextPercent: 12,
			meterUsage: 1.5,
			meterUnit: "credit",
			usage: {
				inputTokens: 100,
				outputTokens: 20,
				cachedInputTokens: 800,
				cacheCreationInputTokens: 50,
				cacheCreation5mInputTokens: 10,
				cacheCreation1hInputTokens: 40,
				reasoningTokens: 5,
			},
			ttftMs: expect.any(Number),
			durationMs: expect.any(Number),
			errorMessage: undefined,
		});
		expect(source.onRequestStart).not.toHaveBeenCalled();
	});

	test("retries in the same child using the original prefix and clears prior error state", async () => {
		events = [{ text: "invalid answer", usage: { inputTokens: 3, completionTokens: 2 } }];
		await complete();
		expect(status).toHaveBeenLastCalledWith("probe", "idle", {
			substatus: ["error"],
			errorMessage: reportedResult().error,
			skipErrorMessage: true,
		});
		expect(finishRequest.mock.calls[0]?.[1]).toMatchObject({
			errorMessage: reportedResult().error,
			usage: { inputTokens: 3, outputTokens: 2 },
		});
		expect(getModelTraceRequest("probe")).toBeUndefined();
		forgetModelTraceRequest("parent");
		idle = Promise.withResolvers<void>();
		woke = Promise.withResolvers<void>();
		events = [{ text: JSON.stringify(Array(300).fill(17)) }];
		expect(await retryModelTrace("probe", "retry-operator")).toEqual({ id: "probe" });
		await woke.promise;
		expect(ensureTrace).toHaveBeenCalledTimes(1);
		expect(chat).toHaveBeenCalledTimes(2);
		expect(received?.content).toBe(challenge.prompt);
		expect(status).toHaveBeenNthCalledWith(3, "probe", "working", {
			setTurnStart: true,
			substatus: [],
		});
		expect(status).toHaveBeenLastCalledWith("probe", "idle", {
			substatus: [],
			errorMessage: undefined,
			skipErrorMessage: true,
		});
		expect(startRequest.mock.calls[1]?.[0]).toMatchObject({
			userId: "retry-operator",
			narratorId: "probe",
			provider: "frozen-provider",
		});
		expect(persistUser.mock.calls.map((call) => call[0])).toEqual(["probe", "probe"]);
		expect(persistDisplay.mock.calls.map((call) => call[0])).toEqual(["probe", "probe"]);
	});

	test("rejects non-diagnostic children, expired snapshots and legacy snapshots without provider", async () => {
		childRow.mockResolvedValueOnce({ traits: ["standalone"], status: "idle" });
		await expect(retryModelTrace("probe", "operator")).rejects.toThrow("Only a ModelTrace child");
		await expect(retryModelTrace("no-retry-plan", "operator")).rejects.toThrow("retry expired");
		const snapshot = getModelTraceRequest("parent");
		if (snapshot) delete (snapshot as Partial<typeof snapshot>).provider;
		await expect(startModelTrace("parent", "operator", "en", { fork: true })).rejects.toThrow();
		expect(ensureTrace).not.toHaveBeenCalled();
		expect(startRequest).not.toHaveBeenCalled();
	});

	test("uses the configured provider for an isolated probe before a parent request exists", async () => {
		forgetModelTraceRequest("parent");
		const providerModule = await import("@server/lib/agent/provider");
		const resolve = spyOn(providerModule, "resolveProviderAndModel").mockReturnValue({
			adapter: { chat } as unknown as ProviderAdapter,
			provider: "configured",
			model: "configured:some-model",
			requestedProvider: "configured",
			requestedModel: "configured:some-model",
		});
		try {
			await complete();
			expect(resolve).toHaveBeenCalledWith("configured:some-model");
			expect(received).toMatchObject({ model: "configured:some-model", content: challenge.prompt });
			expect(startRequest.mock.calls[0]?.[0]).toMatchObject({ provider: "configured" });
		} finally {
			resolve.mockRestore();
		}
	});

	test("a busy cabin is claimed before its history can be cleared", async () => {
		claimed = true;
		await expect(startModelTrace("parent", "operator")).rejects.toThrow("active execution");
		expect(ensureTrace).toHaveBeenCalledTimes(1);
		expect(clearTrace).not.toHaveBeenCalled();
		expect(chat).not.toHaveBeenCalled();
	});

	test("rejects busy retries without another launch or fork", async () => {
		await complete();
		childRow.mockResolvedValueOnce({ traits: ["modeltrace"], status: "working" });
		await expect(retryModelTrace("probe", "operator")).rejects.toThrow("active execution");
		claimed = true;
		await expect(retryModelTrace("probe", "operator")).rejects.toThrow("active execution");
		claimed = false;
		expect(ensureTrace).toHaveBeenCalledTimes(1);
		expect(chat).toHaveBeenCalledTimes(1);
		expect(startRequest).toHaveBeenCalledTimes(1);
	});

	test("cancellation keeps already received usage in its one history record", async () => {
		const started = Promise.withResolvers<void>();
		let calls = 0;
		chat.mockImplementation((params: ChatParams) => {
			params.onRequestStart?.({ credentialId: "cancel-credential" });
			return {
				next: async () => {
					if (calls++ === 0)
						return { done: false, value: { usage: { inputTokens: 7, completionTokens: 3 } } };
					started.resolve();
					return new Promise(() => {});
				},
				return: async () => ({ done: true, value: undefined }),
			} as unknown as AsyncGenerator<ParsedStreamEvent>;
		});
		await startModelTrace("parent", "operator");
		await started.promise;
		expect(cancelModelTrace("probe")).toBe(true);
		await woke.promise;
		expect(finishRequest).toHaveBeenCalledTimes(1);
		expect(finishRequest.mock.calls[0]?.[1]).toMatchObject({
			credentialId: "cancel-credential",
			messageId: "assistant-row",
			usage: { inputTokens: 7, outputTokens: 3 },
			errorMessage: "ModelTrace canceled",
		});
	});

	test("history persistence failure cannot strand the execution owner", async () => {
		finishRequest.mockRejectedValueOnce(new Error("history write failed"));
		await complete();
		expect(finishRequest).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
		expect(cancelModelTrace("probe")).toBe(false);
	});

	test("transport failures remain searchable even without text or usage", async () => {
		chat.mockImplementation(async function* (params: ChatParams) {
			params.onRequestStart?.({ credentialId: "transport-credential" });
			yield await Promise.reject(new Error("transport failed"));
		});
		await complete();
		expect(finishRequest).toHaveBeenCalledTimes(1);
		expect(finishRequest.mock.calls[0]?.[1]).toMatchObject({
			credentialId: "transport-credential",
			usage: null,
			errorMessage: "transport failed",
			messageId: undefined,
		});
	});

	test("assistant persistence failure still records usage and releases owner", async () => {
		persistAssistant.mockRejectedValueOnce(new Error("assistant write failed"));
		await complete();
		expect(finishRequest).toHaveBeenCalledTimes(1);
		expect(finishRequest.mock.calls[0]?.[1]).toMatchObject({
			usage: { inputTokens: 42, outputTokens: 99 },
			errorMessage: "assistant write failed",
			messageId: "assistant-row",
		});
		expect(patchStepMeta).toHaveBeenCalled();
		expect(process.mock.calls.some(([event]) => event.type === "stream_reset")).toBe(true);
		expect(release).toHaveBeenCalledTimes(1);
	});

	test("isolates the default probe while saving one raw answer plus a local report", async () => {
		expect(await complete()).toEqual({ id: "probe" });
		expect(ensureTrace).toHaveBeenCalledWith({
			parentId: "parent",
			provider: "frozen-provider",
			title: "ModelTrace: gpt-5.4",
			model: "gpt-5.4",
			userId: "operator",
			locale: "en",
		});
		expect(clearTrace).toHaveBeenCalledWith("probe");
		expect(chat).toHaveBeenCalledTimes(1);
		expect(received?.content).toBe(challenge.prompt);
		for (const field of ["history", "tools", "toolResults"] as const) {
			expect(received?.[field]).toEqual([]);
		}
		expect(received?.conversationId).not.toBe(source.conversationId);
		expect(received?.stickySessionKey).not.toBe(source.stickySessionKey);
		expect(received?.transportSessionKey).toBeString();
		expect(received?.images).toBeUndefined();
		expect(received?.metadata).toBeUndefined();
		expect(received?.cwd).toBe("");
		expect(received?.diagnostic).toBe(true);
		expect(received?.signal).not.toBe(source.signal);
		expect(received?.onRequestStart).toBeFunction();
		expect(received?.onRequestStart).not.toBe(source.onRequestStart);
		expect(received?.onInputCharacters).toBeUndefined();
		expect(received?.requestDump).toBeUndefined();
		expect(source.onRequestStart).not.toHaveBeenCalled();
		expect(source.onInputCharacters).not.toHaveBeenCalled();
		expect(updateConversationId).not.toHaveBeenCalled();
		expect(persistUser).toHaveBeenCalledWith(
			"probe",
			challenge.prompt,
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
		expect(reportedResult()).toEqual({
			...ranked,
			calibrationRequested: false,
			cacheReadTokens: [null],
		});
		expect(analyze).toHaveBeenCalledTimes(1);
		expect(analyze).toHaveBeenCalledWith(
			[{ text: events[0]?.text, expected_count: challenge.expectedCount }],
			"en",
			expect.any(AbortSignal),
		);
		// traits / parentNarratorId / hidden 与绑定键由 modeltrace-store 在创建舱时写入，
		// 本套件只校验服务把「同一个模型复用同一个舱」这件事交给它，并在跑之前清历史。
		expect(broadcast).toHaveBeenCalledTimes(1);
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

	test("fork calibration preserves the original prefix and affinity on a new private narrator and retry", async () => {
		expect(await complete({ fork: true, calibrate: true })).toEqual({ id: "probe" });
		expect(fork).toHaveBeenCalledWith({
			userId: "operator",
			model: "gpt-5.4",
			title: "ModelTrace: gpt-5.4",
			locale: "en",
		});
		expect(ensureTrace).not.toHaveBeenCalled();
		expect(clearTrace).not.toHaveBeenCalled();
		forgetModelTraceRequest("parent");
		woke = Promise.withResolvers<void>();
		await retryModelTrace("probe", "retry-operator");
		await woke.promise;
		const params = chat.mock.calls.map(([request]) => request);
		expect(params).toHaveLength(6);
		expect(new Set(params.map((request) => request.transportSessionKey)).size).toBe(6);
		for (const [i, request] of params.entries()) {
			expect(request).toMatchObject({
				content: source.content,
				conversationId: source.conversationId,
				stickySessionKey: source.stickySessionKey,
				history: source.history,
				tools: source.tools,
				toolResults: source.toolResults,
				images: source.images,
				diagnostic: true,
				diagnosticFork: { suffix: challenges[i % 3]?.prompt, credentialId: "affinity-credential" },
			});
			expect(request.signal).not.toBe(source.signal);
			expect(request.history).not.toBe(source.history);
			expect(request.onRequestStart).not.toBe(source.onRequestStart);
		}
		expect(parentController.signal.aborted).toBe(false);
		expect(fork).toHaveBeenCalledTimes(1);
	});

	test("calibrates three independent samples once, and remembers calibration on retry", async () => {
		let index = 0;
		chat.mockImplementation(async function* () {
			const i = index++ % 3;
			yield { text: `[${i}]`, credentialId: `credential-${i}` };
			yield {
				usage: {
					inputTokens: 42 + i,
					cachedInputTokens: i < 2 ? i * 12 : 0,
					cacheReported: i < 2,
				},
			};
		});
		await complete({ calibrate: true });
		const requests = chat.mock.calls.map(([params]) => params);
		expect(requests.map((params) => params.content)).toEqual(
			challenges.map(({ prompt }) => prompt),
		);
		for (const key of [
			"conversationId",
			"stickySessionKey",
			"transportSessionKey",
			"signal",
		] as const)
			expect(new Set(requests.map((params) => params[key])).size).toBe(3);
		expect(startRequest).toHaveBeenCalledTimes(3);
		expect(finishRequest.mock.calls.map((call) => call[1])).toEqual(
			[0, 1, 2].map((i) =>
				expect.objectContaining({
					credentialId: `credential-${i}`,
					usage: expect.objectContaining({ inputTokens: 42 + i }),
				}),
			),
		);
		expect(analyze.mock.calls[0]?.[0]).toEqual(
			challenges.map(({ expectedCount }, i) => ({
				text: `[${i}]`,
				expected_count: expectedCount,
			})),
		);
		expect(analyze).toHaveBeenCalledTimes(1);
		expect(reportedResult()).toEqual({
			...ranked,
			calibrationRequested: true,
			cacheReadTokens: [0, 12, null],
		});
		forgetModelTraceRequest("parent");
		woke = Promise.withResolvers<void>();
		await retryModelTrace("probe", "retry-operator");
		await woke.promise;
		expect(chat).toHaveBeenCalledTimes(6);
		expect(analyze).toHaveBeenCalledTimes(2);
		expect(persistDisplay).toHaveBeenCalledTimes(2);
		expect(clearTrace).toHaveBeenCalledTimes(1);
	});

	test.each([
		false,
		true,
	])("one round deadline/cancel stops the second calibration sample (timeout=%s)", async (timeout) => {
		const active = Promise.withResolvers<void>();
		const deadlines: Array<() => void> = [];
		const original = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			fn: () => void,
			ms: number,
		) => {
			if (ms === 180_000) deadlines.push(fn);
			return original(fn, ms);
		}) as typeof setTimeout);
		try {
			chat.mockImplementationOnce(async function* () {
				yield { text: "[1]", usage: { cachedInputTokens: 64 } };
			});
			chat.mockImplementationOnce(async function* () {
				yield { text: "[2", usage: { inputTokens: 17, completionTokens: 2 } };
				active.resolve();
				await new Promise(() => {});
			});
			await startModelTrace("parent", "operator", "en", { calibrate: true });
			await active.promise;
			expect(deadlines).toHaveLength(1);
			if (timeout) deadlines[0]?.();
			else expect(cancelModelTrace("probe")).toBe(true);
			await woke.promise;
			expect(chat).toHaveBeenCalledTimes(2);
			expect(analyze).not.toHaveBeenCalled();
			expect(reportedResult()).toMatchObject({
				cacheReadTokens: [64, null, null],
				calibrationRequested: true,
				error: timeout ? "ModelTrace timed out (180 seconds)" : "ModelTrace canceled",
			});
			expect(finishRequest).toHaveBeenCalledTimes(2);
			expect(finishRequest.mock.calls[1]?.[1]).toMatchObject({
				usage: { inputTokens: 17, outputTokens: 2 },
				errorMessage: reportedResult().error,
			});
			expect(parentController.signal.aborted).toBe(false);
		} finally {
			timer.mockRestore();
		}
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
		await expect(startModelTrace("parent", "operator", "en", { fork: true })).rejects.toThrow();
		expect(ensureTrace).not.toHaveBeenCalled();
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
			expect(analyze).not.toHaveBeenCalled();

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
			expect(finishRequest).toHaveBeenCalledTimes(1);
			expect(finishRequest.mock.calls[0]?.[1]).toMatchObject({
				credentialId: "terminal-credential",
				messageId: "assistant-row",
				errorMessage: reportedResult().error,
				usage: { inputTokens: 42, outputTokens: 99, cachedInputTokens: 12, reasoningTokens: 4 },
			});

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
		expect(reportedResult()).toEqual({
			...ranked,
			calibrationRequested: false,
			cacheReadTokens: [null],
		});
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
		expect(status).toHaveBeenLastCalledWith("probe", "idle", {
			substatus: ["error"],
			errorMessage: "database unavailable",
			skipErrorMessage: true,
		});
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
		expect(finishRequest).toHaveBeenCalledTimes(1);
		expect(finishRequest.mock.calls[0]?.[1]).toMatchObject({
			errorMessage: "ModelTrace canceled",
			usage: null,
		});
	});

	test.each([
		false,
		true,
	])("interrupts local analysis and keeps one sealed billable answer (timeout=%s)", async (timeout) => {
		const entered = Promise.withResolvers<void>();
		const deadlines: Array<() => void> = [];
		const original = globalThis.setTimeout;
		const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
			fn: () => void,
			ms: number,
		) => {
			if (ms === 180_000) deadlines.push(fn);
			return original(fn, ms);
		}) as typeof setTimeout);
		try {
			analyze.mockImplementationOnce(() => {
				entered.resolve();
				return new Promise(() => {});
			});
			await startModelTrace("parent", "operator");
			await entered.promise;
			expect(deadlines).toHaveLength(1);
			expect(persistAssistant).toHaveBeenCalledTimes(1);
			expect(process.mock.calls.map(([event]) => event)).toContainEqual(
				expect.objectContaining({ type: "assistant_message", outputCompleted: true }),
			);
			if (timeout) deadlines[0]?.();
			else expect(cancelModelTrace("probe")).toBe(true);
			await woke.promise;
			const errorMessage = timeout ? "ModelTrace timed out (180 seconds)" : "ModelTrace canceled";
			expect(reportedResult()).toEqual({
				type: "modeltrace_result",
				results: [],
				error: errorMessage,
				calibrationRequested: false,
				cacheReadTokens: [null],
			});
			expect(analyze.mock.calls[0]?.[2]?.aborted).toBe(true);
			expect(patchStepMeta).not.toHaveBeenCalled();
			expect(process.mock.calls.some(([event]) => event.type === "stream_reset")).toBe(false);
			expect(chat).toHaveBeenCalledTimes(1);
			expect(finishRequest).toHaveBeenCalledTimes(1);
			expect(finishRequest.mock.calls[0]?.[1]).toMatchObject({
				messageId: "assistant-row",
				usage: { inputTokens: 42, outputTokens: 99 },
				errorMessage,
			});
			expect(release).toHaveBeenCalledTimes(1);
		} finally {
			timer.mockRestore();
		}
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
