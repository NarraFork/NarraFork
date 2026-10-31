import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as agent from "../../lib/agent";
import { estimateTokens } from "../../lib/agent/estimate-tokens";
import * as provider from "../../lib/agent/provider";
import * as requestTracker from "../../lib/api-request-tracker";
import * as prompts from "../../lib/prompt-i18n";
import { settings } from "../../lib/settings";
import { narratorService } from "../narrator-service";
import type { NarratorTaskSource } from "../task-source";
import * as taskSource from "../task-source";

const { narratorContext } = await import("../narrator-context");

/** Compact reads only `compactContext` from the narrator's task source. */
function compactOnlyTaskSource(compactContext: () => Promise<string | null>): NarratorTaskSource {
	return { compactContext } as unknown as NarratorTaskSource;
}

const originalSummarizeChunk = narratorContext._summarizeChunk.bind(narratorContext);
const summaryCalls: number[] = [];

afterEach(() => {
	narratorContext._summarizeChunk = originalSummarizeChunk;
	summaryCalls.length = 0;
});

describe("narrator compact summary", () => {
	test("oversized input is rejected for splitting without deleting tool evidence", async () => {
		const entries = [
			{
				message: { id: "tool", role: "assistant" as const, contentText: "" },
				text: `[Assistant]: [Tool calls] Read: ${"evidence".repeat(2_000)}`,
			},
		];
		const before = JSON.stringify(entries);
		await expect(
			originalSummarizeChunk("n-test", entries, "", "system", "suffix", 0, 100),
		).rejects.toThrow("maximum context length");
		expect(JSON.stringify(entries)).toBe(before);
	});

	test("single oversized message is split with both halves retained", async () => {
		const text = `FIRST ${"x".repeat(4_000)} LAST`;
		const entries = [{ message: { id: "m", role: "user" as const, contentText: text }, text }];
		narratorContext._summarizeChunk = async (
			id,
			chunk,
			previous,
			system,
			suffix,
			fixed,
			budget,
		) => {
			if (chunk.some((entry) => entry.text.length > 3_000)) {
				return originalSummarizeChunk(id, chunk, previous, system, suffix, fixed, budget);
			}
			return { summary: [previous, ...chunk.map((entry) => entry.text)].join("|") };
		};
		const result = await narratorContext._summarizeChunkSequence(
			"n-test",
			[entries],
			"",
			"system",
			"suffix",
			0,
			100,
			0,
		);
		expect(result.summary).toContain("FIRST");
		expect(result.summary).toContain("LAST");
		expect(entries[0].text).toBe(text);
	});

	test("cancellation stops before fitting or requesting a summary", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			originalSummarizeChunk("n-test", [], "", "system", "suffix", 0, 100, controller.signal),
		).rejects.toThrow("aborted");
	});

	test("falls back to cascading chunks when summary provider reports context overflow", async () => {
		const longText = "x".repeat(2_300);
		const entries = [
			{
				message: { id: "m1", role: "user", contentText: `PART_ONE ${longText}`, toolCalls: [] },
				text: `[User]: PART_ONE ${longText}`,
			},
			{
				message: {
					id: "m2",
					role: "assistant",
					contentText: `PART_TWO ${longText}`,
					toolCalls: [],
				},
				text: `[Assistant]: PART_TWO ${longText}`,
			},
		];

		narratorContext._summarizeChunk = async (...args) => {
			const [, chunkEntries, previousSummary] = args;
			expect(args[13]).toBe("compact-user");
			summaryCalls.push(chunkEntries.length);
			if (chunkEntries.length > 1) throw new Error("maximum context length exceeded");

			const markers = ["PART_ONE", "PART_TWO"].filter((marker) =>
				chunkEntries.some((entry) => entry.text.includes(marker)),
			);
			return {
				summary: [previousSummary, ...markers].filter(Boolean).join("|"),
				contextPercent: 12,
			};
		};

		const result = await narratorContext._summarizeChunkSequence(
			"n-test",
			[entries as never],
			"",
			"compact system prompt",
			"compact suffix",
			0,
			40_000,
			0,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"compact-user",
		);

		expect(summaryCalls).toEqual([2, 1, 1]);
		expect(result.summary).toContain("PART_ONE");
		expect(result.summary).toContain("PART_TWO");
	});
});

describe("question inputs in actual summary provider requests", () => {
	const canary = "USER_ANSWER_CANARY_compact_fork_7231";
	const originalInput = { questions: [{ question: "Which option?" }], async: false };
	const normalInput = { answers: { keep: "NORMAL_TOOL_ANSWER" }, annotations: "keep", async: true };
	const normalOutput = { text: `NORMAL_OUTPUT_START${"x".repeat(50_000)}NORMAL_OUTPUT_END` };
	const model = "anthropic:claude-haiku-4-5";
	const originalSummary = settings.agent.summaryModel;
	const originalCatalog = settings.agent.modelCatalog;
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
		settings.agent.modelCatalog = catalogWithWindow(model, 40_000);
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
		settings.agent.modelCatalog = originalCatalog;
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

/** A provider entry's own working window, held where production holds it: the catalog. */
function catalogWithWindow(model: string, window: number) {
	return {
		schemaVersion: 2 as const,
		migrationVersion: 2 as const,
		autoApply: false,
		pinnedVersion: null,
		local: {
			revision: 0,
			connections: { [model]: { working_context_tokens: window } },
		},
	};
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
			const originalCatalog = settings.agent.modelCatalog;
			// 512 * 0.8 = 409 token budget — below the real fixed prompt overhead.
			settings.agent.defaultModel = "anthropic:claude-haiku-4-5";
			settings.agent.summaryModel = "anthropic:claude-haiku-4-5";
			settings.agent.modelCatalog = catalogWithWindow("anthropic:claude-haiku-4-5", 512);

			try {
				await expect(narratorContext.generateCompactSummary("n-budget", "en")).rejects.toThrow(
					/context window/i,
				);
			} finally {
				settings.agent.defaultModel = originalDefault;
				settings.agent.summaryModel = originalSummary;
				settings.agent.modelCatalog = originalCatalog;
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
	const originalCatalog = settings.agent.modelCatalog;
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
		settings.agent.modelCatalog = catalogWithWindow(model, 1_200);
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
		settings.agent.modelCatalog = originalCatalog;
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

	test("previous summary and spec overhead are retained within the same small window", async () => {
		previousSummary = `PREVIOUS ${"x".repeat(600)}`;
		specContext = `LATEST SPEC ${"y".repeat(600)}`;
		await narratorContext.generateCompactSummary("n-small", "en", [message]);
		assertRequestFits();
		expect(generate.mock.calls[0][0]).toContain(previousSummary);
		expect(generate.mock.calls[0][1]).toContain(specContext);
	});

	test("a positive budget still rejects an unsplittable entry that cannot fit", async () => {
		settings.agent.modelCatalog = catalogWithWindow(model, 250);
		const oversized = { ...message, contentText: "evidence".repeat(100) };
		await expect(
			narratorContext.generateCompactSummary("n-small", "en", [oversized]),
		).rejects.toThrow("maximum context length");
		expect(generate).not.toHaveBeenCalled();
	});

	test("fixed overhead that cannot fit fails with its context-window hint", async () => {
		settings.agent.modelCatalog = catalogWithWindow(model, 1);
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
		settings.agent.modelCatalog = catalogWithWindow(model, 1);
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
