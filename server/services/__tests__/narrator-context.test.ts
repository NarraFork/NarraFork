import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as agent from "../../lib/agent";
import * as errorHandling from "../../lib/agent/error-handling";
import { estimateTokens } from "../../lib/agent/estimate-tokens";
import * as provider from "../../lib/agent/provider";
import * as requestTracker from "../../lib/api-request-tracker";
import { replaceModelOverridesForTests } from "../../lib/model-catalog";
import * as prompts from "../../lib/prompt-i18n";
import { settings } from "../../lib/settings";
import type { CompactSummaryRetryHandler, CompactSummaryRetryPolicy } from "../narrator-context";
import { narratorService } from "../narrator-service";
import type { NarratorTaskSource } from "../task-source";
import * as taskSource from "../task-source";

const { narratorContext } = await import("../narrator-context");

/** Compact reads only `compactContext` from the narrator's task source. */
function compactOnlyTaskSource(compactContext: () => Promise<string | null>): NarratorTaskSource {
	return { compactContext } as unknown as NarratorTaskSource;
}

describe("narrator compact summary", () => {
	let generate: ReturnType<typeof spyOn<typeof agent, "summaryGenerate">>;
	beforeEach(() => {
		generate = spyOn(agent, "summaryGenerate").mockResolvedValue({ text: "summary" });
	});
	afterEach(() => generate.mockRestore());

	function entriesFor(...texts: string[]) {
		return texts.map((text, i) => ({
			message: { id: `m${i}`, role: "user" as const, contentText: text },
			text,
		}));
	}

	function cascade(
		entries: ReturnType<typeof entriesFor>,
		policy: CompactSummaryRetryPolicy,
		onRetry?: CompactSummaryRetryHandler,
		tokenBudget = 40_000,
		signal?: AbortSignal,
	) {
		return narratorContext._summarizeChunkSequence(
			"n-test",
			[entries],
			"",
			"system",
			"suffix",
			0,
			tokenBudget,
			0,
			signal,
			"old-model",
			undefined,
			undefined,
			undefined,
			onRetry,
			"compact-user",
			policy,
		);
	}

	test("oversized input is rejected for splitting without deleting tool evidence", async () => {
		const entries = [
			{
				message: { id: "tool", role: "assistant" as const, contentText: "" },
				text: `[Assistant]: [Tool calls] Read: ${"evidence".repeat(2_000)}`,
			},
		];
		const before = JSON.stringify(entries);
		await expect(
			narratorContext._summarizeChunk("n-test", entries, "", "system", "suffix", 0, 100),
		).rejects.toThrow("maximum context length");
		expect(JSON.stringify(entries)).toBe(before);
	});

	test.each([
		false,
		true,
	])("local token splitting preserves both halves with zero retries (replacement queued: %s)", async (queued) => {
		const text = `FIRST ${"x".repeat(4_000)} LAST`;
		const entries = entriesFor(text);
		const policy = { limit: 0, used: 0, shouldChangeModel: () => queued };
		const retry = mock();
		generate.mockImplementation(async (input) => ({
			text: ["FIRST", "LAST"].filter((marker) => input.includes(marker)).join("|"),
		}));
		const result = await cascade(entries, policy, retry, 800);
		expect(generate).toHaveBeenCalledTimes(2);
		expect(generate.mock.calls.map((args) => args[5])).toEqual(["old-model", "old-model"]);
		const [first, second] = generate.mock.calls.map(([input]) => input);
		const midpoint = Math.floor(text.length / 2);
		expect(first).toContain(
			`${text.slice(0, midpoint)}\n[Message continues in next compact chunk]`,
		);
		expect(first).not.toContain("LAST");
		expect(second).toContain("[Previous context summary]:\nFIRST");
		expect(second).toContain(`[Continuation of previous message]\n${text.slice(midpoint)}`);
		expect(result.summary).toBe("FIRST|LAST");
		expect(entries[0].text).toBe(text);
		expect(policy.used).toBe(0);
		expect(retry).not.toHaveBeenCalled();
	});

	test("cancellation stops before fitting or requesting a summary", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			narratorContext._summarizeChunk(
				"n-test",
				[],
				"",
				"system",
				"suffix",
				0,
				100,
				controller.signal,
			),
		).rejects.toThrow("aborted");
	});

	const overflow = new Error("maximum context length exceeded");

	test("one provider overflow spends one retry for the entire smaller-chunk sequence", async () => {
		const longText = "x".repeat(2_300);
		const entries = entriesFor(`[User]: PART_ONE ${longText}`, `[Assistant]: PART_TWO ${longText}`);
		const policy = { limit: 1, used: 0 };
		const usedAtRequest: number[] = [];
		const chunks: string[][] = [];
		generate.mockImplementation(async (input, _system, tracking) => {
			expect(tracking?.userId).toBe("compact-user");
			usedAtRequest.push(policy.used);
			const chunk = entries
				.filter((entry) => input.includes(entry.text))
				.map((entry) => entry.text);
			chunks.push(chunk);
			if (chunk.length > 1) throw overflow;
			const text = ["PART_ONE", "PART_TWO"].filter((marker) => input.includes(marker)).join("|");
			return { text, contextPercent: 12 };
		});
		const retry = mock();
		const result = await cascade(entries, policy, retry);
		expect(chunks).toEqual([
			entries.map((entry) => entry.text),
			[entries[0].text],
			[entries[1].text],
		]);
		expect(usedAtRequest).toEqual([0, 1, 1]);
		expect(generate.mock.calls[2][0]).toContain("[Previous context summary]:\nPART_ONE");
		expect(result).toEqual({ summary: "PART_ONE|PART_TWO", contextPercent: 12 });
		expect(retry.mock.calls).toEqual([
			[{ attempt: 1, maxRetries: 1, delayMs: 0, error: overflow.message }],
		]);
	});

	for (const [limit, used] of [
		[0, 0],
		[1, 1],
	]) {
		test(`provider overflow cannot replan with retry budget ${used}/${limit}`, async () => {
			const policy = { limit, used };
			const retry = mock();
			generate.mockRejectedValue(overflow);
			await expect(cascade(entriesFor("PART_ONE", "PART_TWO"), policy, retry)).rejects.toBe(
				overflow,
			);
			expect(generate).toHaveBeenCalledTimes(1);
			expect(policy.used).toBe(used);
			expect(retry).not.toHaveBeenCalled();
		});
	}

	test("ordinary retries and recursive provider replans exhaust the same budget", async () => {
		const policy = { limit: 3, used: 0 };
		const ordinary = new Error("provider rejected request");
		const entries = entriesFor(...Array.from({ length: 8 }, (_, i) => `[part:${i}]`));
		const trace: number[][] = [];
		generate.mockImplementation(async (input) => {
			trace.push([entries.filter((entry) => input.includes(entry.text)).length, policy.used]);
			throw trace.length === 2 ? ordinary : overflow;
		});
		const retry = mock();
		await expect(cascade(entries, policy, retry)).rejects.toBe(overflow);
		expect(trace).toEqual([
			[8, 0],
			[4, 1],
			[4, 2],
			[2, 3],
		]);
		expect(retry.mock.calls).toEqual(
			[overflow, ordinary, overflow].map((err, i) => [
				{ attempt: i + 1, maxRetries: 3, delayMs: 0, error: err.message },
			]),
		);
		expect(policy.used).toBe(3);
	});

	for (const limit of [15, -1]) {
		test(`provider replans can use more than ten retries with limit ${limit}`, async () => {
			const policy = { limit, used: 0 };
			const entries = entriesFor(...Array.from({ length: 16 }, (_, i) => `[part:${i}]`));
			const completed: string[] = [];
			generate.mockImplementation(async (input) => {
				const chunk = entries.filter((entry) => input.includes(entry.text));
				if (chunk.length > 1) throw overflow;
				completed.push(chunk[0].text);
				return { text: "summary" };
			});
			const ordinals: number[] = [];
			await cascade(entries, policy, (info) => ordinals.push(info.attempt));
			expect(completed).toEqual(entries.map((entry) => entry.text));
			expect(generate).toHaveBeenCalledTimes(31);
			expect(ordinals).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
			expect(policy.used).toBe(15);
		});
	}

	test("unsplittable provider overflows never schedule or charge a retry", async () => {
		const policy = { limit: -1, used: 3 };
		const retry = mock();
		generate.mockRejectedValue(overflow);
		await expect(cascade(entriesFor("short"), policy, retry)).rejects.toBe(overflow);
		expect(generate).toHaveBeenCalledTimes(1);
		expect(policy.used).toBe(3);
		expect(retry).not.toHaveBeenCalled();
	});

	for (const pendingAt of ["failure", "replan"]) {
		test(`a model queued at ${pendingAt} takes priority over a provider replan`, async () => {
			let queued = false;
			const policy = { limit: 1, used: 0, shouldChangeModel: () => queued };
			generate.mockImplementation(async () => {
				queued = pendingAt === "failure";
				throw overflow;
			});
			const retry = mock(() => {
				queued = true;
			});
			await expect(cascade(entriesFor("ONE", "TWO"), policy, retry)).rejects.toBe(overflow);
			expect(generate.mock.calls.map((args) => args[5])).toEqual(["old-model"]);
			expect(policy.used).toBe(0);
			expect(retry).toHaveBeenCalledTimes(pendingAt === "failure" ? 0 : 1);
		});
	}

	test("cancelling a scheduled provider replan avoids both request and charge", async () => {
		const controller = new AbortController();
		const policy = { limit: 2, used: 1 };
		const retry = mock(() => controller.abort());
		generate.mockRejectedValue(overflow);
		await expect(
			cascade(entriesFor("ONE", "TWO"), policy, retry, 40_000, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(generate).toHaveBeenCalledTimes(1);
		expect(policy.used).toBe(1);
		expect(retry.mock.calls).toEqual([
			[{ attempt: 2, maxRetries: 2, delayMs: 0, error: overflow.message }],
		]);
	});

	test("a model queued during backoff reaches failover without another old-model request", async () => {
		const delay = spyOn(errorHandling, "auxiliaryRetryDelayMs").mockReturnValue(1);
		const error = new Error("429 rate limit");
		let queued = false;
		const policy = { limit: 1, used: 0, shouldChangeModel: () => queued };
		generate.mockRejectedValue(error);
		const retry = mock(() =>
			queueMicrotask(() => {
				queued = true;
			}),
		);
		try {
			await expect(cascade(entriesFor("text"), policy, retry)).rejects.toBe(error);
			expect(retry.mock.calls).toEqual([
				[{ attempt: 1, maxRetries: 1, delayMs: 1, error: error.message }],
			]);
			expect(delay.mock.calls).toEqual([[0]]);
			expect(queued).toBe(true);
			expect(generate.mock.calls.map((args) => args[5])).toEqual(["old-model"]);
			expect(policy.used).toBe(0);
		} finally {
			delay.mockRestore();
		}
	});
});

describe("question inputs in actual summary provider requests", () => {
	const canary = "USER_ANSWER_CANARY_compact_fork_7231";
	const originalInput = { questions: [{ question: "Which option?" }], async: false };
	const normalInput = { answers: { keep: "NORMAL_TOOL_ANSWER" }, annotations: "keep", async: true };
	const normalOutput = { text: `NORMAL_OUTPUT_START${"x".repeat(50_000)}NORMAL_OUTPUT_END` };
	const model = "anthropic:claude-haiku-4-5";
	const originalSummary = settings.agent.summaryModel;
	const generateText = mock(async (_text: string, _model: string, _system?: string) => ({
		text: "Saved summary",
	}));
	let getNarrator: ReturnType<typeof spyOn<typeof narratorService, "getById">>;
	let history: ReturnType<typeof spyOn<typeof narratorService, "getModelHistorySinceLastCompact">>;
	let resolve: ReturnType<typeof spyOn<typeof provider, "resolveProviderAndModel">>;
	let tracking: ReturnType<typeof spyOn<typeof requestTracker, "trackApiRequest">>;
	let spec: ReturnType<typeof spyOn<typeof taskSource, "taskSourceForNarrator">>;

	function sourceRows(sdkOriginal: boolean, legacyString = false) {
		const executionInput = {
			...originalInput,
			async: true,
			answers: { choice: canary },
			annotations: { choice: canary },
			deferredByUser: true,
		};
		return [
			{
				id: "question-call",
				role: "assistant" as const,
				contentText: "",
				contentJson: sdkOriginal
					? [
							{
								type: "tool_use",
								id: "question-tool",
								name: "AskUserQuestion",
								input: { ...originalInput, answers: { choice: canary }, annotations: canary },
							},
							{ type: "tool_use", id: "normal-tool", name: "Read", input: normalInput },
						]
					: [],
				toolCalls: [
					{
						toolUseId: "question-tool",
						toolName: "AskUserQuestion",
						status: "done",
						inputJson: legacyString ? JSON.stringify(executionInput) : executionInput,
						outputJson: { status: "UserAnswered", answers: { choice: canary } },
					},
					{
						toolUseId: "normal-tool",
						toolName: "Read",
						status: "done",
						inputJson: normalInput,
						outputJson: normalOutput,
					},
				],
			},
			{
				id: "sdk-result",
				role: "user" as const,
				contentText: "",
				contentJson: [
					{ type: "tool_result", tool_use_id: "question-tool", content: `SDK_RESULT ${canary}` },
				],
				toolCalls: [],
			},
			{
				id: "human-answer",
				role: "user" as const,
				contentText: `REAL_USER_REPLY ${canary}`,
				contentJson: [{ type: "text", text: `REAL_USER_REPLY ${canary}` }],
				toolCalls: [],
			},
		];
	}

	beforeEach(() => {
		generateText.mockClear();
		settings.agent.summaryModel = model;
		withWindow(model, 40_000);
		getNarrator = spyOn(narratorService, "getById").mockImplementation((async () => ({
			id: "n-question-summary",
			contextSummary: "",
		})) as never);
		history = spyOn(narratorService, "getModelHistorySinceLastCompact");
		resolve = spyOn(provider, "resolveProviderAndModel").mockReturnValue({
			provider: "anthropic",
			model: "summary-test",
			adapter: { generateWithMeta: generateText },
		} as never);
		tracking = spyOn(requestTracker, "trackApiRequest").mockImplementation(async (_options, fn) =>
			fn(),
		);
		spec = spyOn(taskSource, "taskSourceForNarrator").mockResolvedValue(
			compactOnlyTaskSource(async () => ""),
		);
	});

	afterEach(() => {
		getNarrator.mockRestore();
		history.mockRestore();
		resolve.mockRestore();
		tracking.mockRestore();
		spec.mockRestore();
		settings.agent.summaryModel = originalSummary;
		restoreWindows();
	});

	for (const kind of ["compact", "fork"] as const) {
		for (const { sdkOriginal, legacyString, label } of [
			{ sdkOriginal: true, legacyString: false, label: "SDK original" },
			{ sdkOriginal: false, legacyString: false, label: "legacy object" },
			{ sdkOriginal: false, legacyString: true, label: "legacy JSON string" },
		]) {
			test(`${kind} preserves answers as results/user text, not question inputs (${label})`, async () => {
				const rows = sourceRows(sdkOriginal, legacyString);
				const before = structuredClone(rows);
				history.mockResolvedValue(rows as never);
				if (kind === "compact") {
					await narratorContext.generateCompactSummary("n-question-summary", "en", rows);
				} else {
					await narratorContext.generateContextSummary("n-question-summary", "en", {
						throwOnFailure: true,
					});
				}

				expect(generateText).toHaveBeenCalledTimes(1);
				const text = generateText.mock.calls[0][0];
				const inputText = text.match(/AskUserQuestion: input=(.*?) → output=/)?.[1];
				expect(inputText).toBeDefined();
				expect(inputText).not.toContain(canary);
				const input = JSON.parse(inputText ?? "null");
				const projectedInput = typeof input === "string" ? JSON.parse(input) : input;
				expect(projectedInput).toEqual({ ...originalInput, async: !sdkOriginal });
				expect(text).toContain(`output={"status":"UserAnswered","answers":{"choice":"${canary}"}}`);
				expect(text).toContain(`SDK_RESULT ${canary}`);
				expect(text).toContain(`[User]: <sender kind="human" />\nREAL_USER_REPLY ${canary}`);
				if (kind === "fork" && sdkOriginal) {
					const sdkInput = text.match(
						/"name":"AskUserQuestion","input":(.*?)\},\{"type":"tool_use"/,
					)?.[1];
					expect(sdkInput).toBe(JSON.stringify(originalInput));
				}
				if (kind === "compact") {
					expect(text).toContain(`Read: input=${JSON.stringify(normalInput)} → output=`);
					expect(text).toContain("NORMAL_OUTPUT_START");
				} else {
					expect(text).not.toContain("NORMAL_OUTPUT_START");
				}
				expect(text).not.toContain("NORMAL_OUTPUT_END");
				expect(rows).toEqual(before);
				expect(rows[0].toolCalls[1].inputJson).toBe(normalInput);
				expect(rows[0].toolCalls[1].outputJson).toBe(normalOutput);
			});
		}

		test(`${kind} does not invent a missing async field for legacy questions`, async () => {
			const rows = sourceRows(false, true);
			rows[0].toolCalls[0].inputJson = JSON.stringify({
				questions: originalInput.questions,
				answers: { choice: canary },
			});
			const before = structuredClone(rows);
			history.mockResolvedValue(rows as never);
			if (kind === "compact") {
				await narratorContext.generateCompactSummary("n-question-summary", "en", rows);
			} else {
				await narratorContext.generateContextSummary("n-question-summary", "en", {
					throwOnFailure: true,
				});
			}
			const inputText = generateText.mock.calls[0][0].match(
				/AskUserQuestion: input=(.*?) → output=/,
			)?.[1];
			expect(JSON.parse(inputText ?? "null")).toEqual({ questions: originalInput.questions });
			expect(rows).toEqual(before);
		});
	}

	test("fork with assistant prose still includes the synchronous question answer", async () => {
		const rows = sourceRows(true);
		rows[0].contentText = "The assistant asked a question.";
		const before = structuredClone(rows);
		history.mockResolvedValue(rows as never);
		await narratorContext.generateContextSummary("n-question-summary", "en", {
			throwOnFailure: true,
		});
		const text = generateText.mock.calls[0][0];
		expect(text).toContain("[Assistant]: The assistant asked a question.");
		expect(text).toContain(`input=${JSON.stringify(originalInput)} → output=`);
		expect(text).toContain(`"status":"UserAnswered","answers":{"choice":"${canary}"}`);
		expect(text).not.toContain("NORMAL_OUTPUT_START");
		expect(rows).toEqual(before);
	});
});

/** A provider entry's own working window, as the provider page saves it (in memory only). */
const windowRestores: Array<() => void> = [];
function withWindow(model: string, window: number): void {
	windowRestores.push(
		replaceModelOverridesForTests({ connections: { [model]: { contextWindow: window } } }),
	);
}
function restoreWindows(): void {
	while (windowRestores.length) windowRestores.pop()?.();
}

describe("compact context-window budget guard", () => {
	test("a window that leaves no content budget fails fast with a context-window hint", async () => {
		const { settings } = await import("../../lib/settings");
		const { narratorService } = await import("../narrator-service");
		const originalGetById = narratorService.getById;
		const originalHistory = narratorService.getModelHistorySinceLastCompact;
		try {
			narratorService.getById = (async () => ({ id: "n-budget", contextSummary: "" })) as never;
			narratorService.getModelHistorySinceLastCompact = (async () => [
				{
					id: "m1",
					role: "user" as const,
					contentText: "hello world",
					contentJson: null,
					toolCalls: null,
				},
			]) as never;

			const originalDefault = settings.agent.defaultModel;
			const originalSummary = settings.agent.summaryModel;
			// 512 * 0.8 = 409 token budget — below the real fixed prompt overhead.
			settings.agent.defaultModel = "anthropic:claude-haiku-4-5";
			settings.agent.summaryModel = "anthropic:claude-haiku-4-5";
			withWindow("anthropic:claude-haiku-4-5", 512);

			try {
				await expect(narratorContext.generateCompactSummary("n-budget", "en")).rejects.toThrow(
					/context window/i,
				);
			} finally {
				settings.agent.defaultModel = originalDefault;
				settings.agent.summaryModel = originalSummary;
				restoreWindows();
			}
		} finally {
			narratorService.getById = originalGetById;
			narratorService.getModelHistorySinceLastCompact = originalHistory;
		}
	});
});

describe("compact small positive budgets use actual request capacity", () => {
	const model = "anthropic:claude-haiku-4-5";
	const originalSummary = settings.agent.summaryModel;
	let previousSummary = "";
	let specContext = "";
	const message = { id: "small", role: "user" as const, contentText: "Keep the evidence" };
	let generate: ReturnType<typeof spyOn<typeof agent, "summaryGenerate">>;
	let getNarrator: ReturnType<typeof spyOn<typeof narratorService, "getById">>;
	let prompt: ReturnType<typeof spyOn<typeof prompts, "getPrompt">>;
	let toolHint: ReturnType<typeof spyOn<typeof prompts, "getToolMessage">>;
	let spec: ReturnType<typeof spyOn<typeof taskSource, "taskSourceForNarrator">>;

	beforeEach(() => {
		previousSummary = "";
		specContext = "";
		settings.agent.summaryModel = model;
		withWindow(model, 1_200);
		getNarrator = spyOn(narratorService, "getById").mockImplementation((async () => ({
			id: "n-small",
			contextSummary: previousSummary,
		})) as never);
		prompt = spyOn(prompts, "getPrompt").mockReturnValue("Compact instructions");
		toolHint = spyOn(prompts, "getToolMessage").mockReturnValue("");
		spec = spyOn(taskSource, "taskSourceForNarrator").mockImplementation(async () =>
			compactOnlyTaskSource(async () => specContext),
		);
		generate = spyOn(agent, "summaryGenerate").mockResolvedValue({ text: "Retained summary" });
	});

	afterEach(() => {
		generate.mockRestore();
		getNarrator.mockRestore();
		prompt.mockRestore();
		toolHint.mockRestore();
		spec.mockRestore();
		settings.agent.summaryModel = originalSummary;
		restoreWindows();
	});

	function assertRequestFits(window = 1_200) {
		expect(generate).toHaveBeenCalledTimes(1);
		const [userText, systemText] = generate.mock.calls[0];
		expect(systemText).toBeString();
		expect(estimateTokens(userText) + estimateTokens(systemText ?? "")).toBeLessThanOrEqual(
			Math.floor(window * 0.8),
		);
	}

	test("a positive content budget below 1000 can fit a small conversation", async () => {
		const result = await narratorContext.generateCompactSummary("n-small", "en", [message]);
		expect(result).toMatchObject({ summary: "Retained summary", contextWindowSource: "user" });
		assertRequestFits();
		expect(generate.mock.calls[0][0]).toContain("Keep the evidence");
	});

	test("uses a separate automatic retry limit including zero", async () => {
		const before = settings.agent.compactMaxRetries;
		const ordinaryBefore = settings.agent.maxTransientRetries;
		const error = new Error("Compact provider rejected the prompt");
		try {
			settings.agent.compactMaxRetries = 0;
			settings.agent.maxTransientRetries = 8;
			generate.mockRejectedValue(error);
			await expect(
				narratorContext.generateCompactSummary("n-small", "en", [message]),
			).rejects.toThrow(error.message);
			expect(generate).toHaveBeenCalledTimes(1);
			expect(generate.mock.calls[0][11]).toEqual({ maxRetries: 0 });

			settings.agent.compactMaxRetries = 12;
			settings.agent.maxTransientRetries = 0;
			generate.mockClear();
			await expect(
				narratorContext.generateCompactSummary("n-small", "en", [message]),
			).rejects.toThrow(error.message);
			expect(generate).toHaveBeenCalledTimes(13);
		} finally {
			settings.agent.compactMaxRetries = before;
			settings.agent.maxTransientRetries = ordinaryBefore;
		}
	});

	test("unlimited retries keep backing off past ten failures until the model succeeds", async () => {
		const before = settings.agent.compactMaxRetries;
		const delay = spyOn(errorHandling, "auxiliaryRetryDelayMs").mockReturnValue(1);
		let calls = 0;
		try {
			settings.agent.compactMaxRetries = -1;
			generate.mockImplementation(async () => {
				if (++calls <= 12) throw new Error("Empty model response");
				return { text: "Recovered summary" };
			});
			expect(
				await narratorContext.generateCompactSummary("n-small", "en", [message]),
			).toMatchObject({
				summary: "Recovered summary",
			});
			expect(generate).toHaveBeenCalledTimes(13);
			expect(delay).toHaveBeenCalledTimes(12);
			expect(delay.mock.calls.at(-1)?.[0]).toBe(11);
		} finally {
			settings.agent.compactMaxRetries = before;
			delay.mockRestore();
		}
	});

	test("unlimited retries still stop immediately when cancelled during backoff", async () => {
		const before = settings.agent.compactMaxRetries;
		const controller = new AbortController();
		try {
			settings.agent.compactMaxRetries = -1;
			generate.mockRejectedValue(new Error("Empty model response"));
			const result = narratorContext.generateCompactSummary(
				"n-small",
				"en",
				[message],
				controller.signal,
				undefined,
				undefined,
				undefined,
				undefined,
				(info) => {
					expect(info.maxRetries).toBe(-1);
					expect(info.delayMs).toBeGreaterThan(0);
					controller.abort();
				},
			);
			await expect(result).rejects.toMatchObject({ name: "AbortError" });
			expect(generate).toHaveBeenCalledTimes(1);
		} finally {
			settings.agent.compactMaxRetries = before;
		}
	});
	test("previous summary and spec overhead are retained within the same small window", async () => {
		previousSummary = `PREVIOUS ${"x".repeat(600)}`;
		specContext = `LATEST SPEC ${"y".repeat(600)}`;
		await narratorContext.generateCompactSummary("n-small", "en", [message]);
		assertRequestFits();
		expect(generate.mock.calls[0][0]).toContain(previousSummary);
		expect(generate.mock.calls[0][1]).toContain(specContext);
	});

	test("a positive budget still rejects an unsplittable entry that cannot fit", async () => {
		withWindow(model, 250);
		const oversized = { ...message, contentText: "evidence".repeat(100) };
		await expect(
			narratorContext.generateCompactSummary("n-small", "en", [oversized]),
		).rejects.toThrow("maximum context length");
		expect(generate).not.toHaveBeenCalled();
	});

	test("fixed overhead that cannot fit fails with its context-window hint", async () => {
		withWindow(model, 1);
		await expect(
			narratorContext.generateCompactSummary("n-small", "en", [message]),
		).rejects.toThrow(/context window/i);
		expect(generate).not.toHaveBeenCalled();
	});

	test("filtered empty entries do not require an arbitrary minimum budget", async () => {
		const result = await narratorContext.generateCompactSummary("n-small", "en", [
			{ ...message, contentText: "" },
		]);
		expect(result.summary).toBe("No conversation history.");
		expect(generate).not.toHaveBeenCalled();
	});

	test("no entries with a previous summary can still fit and preserve that summary", async () => {
		previousSummary = "PREVIOUS EVIDENCE";
		await narratorContext.generateCompactSummary("n-small", "en", []);
		assertRequestFits();
		expect(generate.mock.calls[0][0]).toContain(previousSummary);
	});

	test("cancellation takes priority over an impossible budget or empty history", async () => {
		withWindow(model, 1);
		const controller = new AbortController();
		controller.abort();
		for (const entries of [[message], []]) {
			await expect(
				narratorContext.generateCompactSummary("n-small", "en", entries, controller.signal),
			).rejects.toMatchObject({ name: "AbortError" });
		}
		expect(generate).not.toHaveBeenCalled();
	});

	test("a growing cascade summary cannot turn nonpositive capacity into a provider request", async () => {
		generate.mockResolvedValue({ text: "x".repeat(2_000) });
		const entries = [{ message, text: "Keep evidence" }];
		await expect(
			narratorContext._summarizeChunkSequence(
				"n-small",
				[entries, entries],
				"",
				"system",
				"suffix",
				10,
				200,
				0,
			),
		).rejects.toThrow("maximum context length");
		expect(generate).toHaveBeenCalledTimes(1);
	});
});
