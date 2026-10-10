import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as agent from "../../lib/agent";
import { estimateTokens } from "../../lib/agent/estimate-tokens";
import * as prompts from "../../lib/prompt-i18n";
import { settings } from "../../lib/settings";
import { narratorService } from "../narrator-service";
import * as specReminder from "../spec-reminder";

const { narratorContext } = await import("../narrator-context");

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
			const originalWindows = settings.agent.modelContextWindows;
			const originalCatalog = settings.agent.modelCatalog;
			// 512 * 0.8 = 409 token budget — below the real fixed prompt overhead.
			// Catalog overlay must be off or it
			// shadows the in-place modelContextWindows override.
			settings.agent.defaultModel = "anthropic:claude-haiku-4-5";
			settings.agent.summaryModel = "anthropic:claude-haiku-4-5";
			settings.agent.modelCatalog = undefined;
			settings.agent.modelContextWindows = { "anthropic:claude-haiku-4-5": 512 };

			try {
				await expect(narratorContext.generateCompactSummary("n-budget", "en")).rejects.toThrow(
					/context window/i,
				);
			} finally {
				settings.agent.defaultModel = originalDefault;
				settings.agent.summaryModel = originalSummary;
				settings.agent.modelContextWindows = originalWindows;
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
	const originalWindows = settings.agent.modelContextWindows;
	const originalCatalog = settings.agent.modelCatalog;
	let previousSummary = "";
	let specContext = "";
	const message = { id: "small", role: "user" as const, contentText: "Keep the evidence" };
	let generate: ReturnType<typeof spyOn<typeof agent, "summaryGenerate">>;
	let getNarrator: ReturnType<typeof spyOn<typeof narratorService, "getById">>;
	let prompt: ReturnType<typeof spyOn<typeof prompts, "getPrompt">>;
	let toolHint: ReturnType<typeof spyOn<typeof prompts, "getToolMessage">>;
	let spec: ReturnType<typeof spyOn<typeof specReminder, "buildSpecCompactContext">>;

	beforeEach(() => {
		previousSummary = "";
		specContext = "";
		settings.agent.summaryModel = model;
		settings.agent.modelCatalog = undefined;
		settings.agent.modelContextWindows = { [model]: 1_200 };
		getNarrator = spyOn(narratorService, "getById").mockImplementation((async () => ({
			id: "n-small",
			contextSummary: previousSummary,
		})) as never);
		prompt = spyOn(prompts, "getPrompt").mockReturnValue("Compact instructions");
		toolHint = spyOn(prompts, "getToolMessage").mockReturnValue("");
		spec = spyOn(specReminder, "buildSpecCompactContext").mockImplementation(
			async () => specContext,
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
		settings.agent.modelContextWindows = originalWindows;
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
		settings.agent.modelContextWindows = { [model]: 250 };
		const oversized = { ...message, contentText: "evidence".repeat(100) };
		await expect(
			narratorContext.generateCompactSummary("n-small", "en", [oversized]),
		).rejects.toThrow("maximum context length");
		expect(generate).not.toHaveBeenCalled();
	});

	test("fixed overhead that cannot fit fails with its context-window hint", async () => {
		settings.agent.modelContextWindows = { [model]: 1 };
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
		settings.agent.modelContextWindows = { [model]: 1 };
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
