import { afterAll, describe, expect, mock, test } from "bun:test";
import { getModelContextWindow } from "../../settings";
import { estimateTokens } from "../estimate-tokens";
import type { ParsedStreamEvent, ProviderAdapter } from "../provider";
import { type AgentConfig, type AgentEvent, ApiError } from "../types";

let attempts: Array<Array<ParsedStreamEvent | Error>> = [];
let attempt = 0;
const model = "claude-sonnet-4-20250514";
const adapter: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		params.onRequestStart?.();
		for (const event of attempts[attempt++] ?? []) {
			if (event instanceof Error) throw event;
			yield event;
		}
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const originalProvider = { ...(await import("../provider")) };
mock.module("../provider", () => ({
	...originalProvider,
	getProvider: () => adapter,
	resolveProviderAndModel: () => ({
		requestedProvider: "anthropic",
		requestedModel: model,
		provider: "anthropic",
		model,
		adapter,
	}),
}));
const { agentLoop } = await import("../loop");
afterAll(() => mock.module("../provider", () => originalProvider));

async function run(...streams: Array<Array<ParsedStreamEvent | Error>>) {
	return runWithConfig({}, ...streams);
}

async function runWithConfig(
	overrides: Partial<AgentConfig>,
	...streams: Array<Array<ParsedStreamEvent | Error>>
) {
	attempts = streams;
	attempt = 0;
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(
		{
			narratorId: "context-occupancy-test",
			conversationId: "context-occupancy-test",
			provider: "anthropic",
			model,
			cwd: ".",
			signal: AbortSignal.timeout(10_000),
			permissionHandler: async () => ({ behavior: "allow" }),
			maxTransientRetries: 1,
			retryBackoffCeilMs: 1,
			...overrides,
		},
		"hello",
		[],
	))
		events.push(event);
	return {
		ends: events.filter((event) => event.type === "api_request_end"),
		contexts: events.filter((event) => event.type === "context_usage"),
	};
}

const measured = {
	usage: { promptTokens: 1200, inputTokens: 1000, completionTokens: 17, cachedInputTokens: 200 },
};
const placeholder = { usage: { promptTokens: 0, completionTokens: 0 } };
const occupancy = { contextUsagePercentage: 80 };
const text = { text: "The final answer contains enough text for a nonzero output estimate." };
const windowSize = getModelContextWindow(model, "anthropic") ?? 0;

describe("independent upstream context occupancy", () => {
	test("explicit zero occupancy prevents compacting from stale high caller usage", async () => {
		let compactCalls = 0;
		const { ends } = await runWithConfig(
			{
				getContextUsagePercentage: () => 96,
				onReasoningOnlyHighContext: async () => {
					compactCalls++;
					return null;
				},
			},
			[
				{ contextUsagePercentage: 0 },
				{ reasoning: "thinking but no answer", reasoningOutputIndex: 0 },
			],
			[text],
		);
		expect(attempt).toBe(2);
		expect(ends[0]?.contextPercent).toBe(0);
		expect(compactCalls).toBe(0);
	});

	for (const order of ["before", "after", "same"] as const) {
		test(`measured usage ${order} occupancy preserves both signals`, async () => {
			const stream =
				order === "before"
					? [measured, occupancy]
					: order === "after"
						? [occupancy, measured]
						: [{ ...occupancy, ...measured }];
			const { ends, contexts } = await run([...stream, placeholder, text]);
			expect(ends.at(-1)?.contextPercent).toBe(80);
			expect(ends.at(-1)?.usage).toMatchObject(measured.usage);
			expect(contexts.at(-1)).toMatchObject({ percentage: 80, isEstimated: true });
		});
	}

	test("preserves a genuine zero output count alongside measured prompt usage", async () => {
		const { ends } = await run([
			{ usage: { promptTokens: 1200, inputTokens: 1200, completionTokens: 0 } },
			occupancy,
			placeholder,
			text,
		]);
		expect(ends.at(-1)?.usage).toMatchObject({
			promptTokens: 1200,
			inputTokens: 1200,
			completionTokens: 0,
		});
	});

	for (const withOccupancy of [false, true]) {
		test(`partial usage preserves prompt counters and updates output (occupancy=${withOccupancy})`, async () => {
			const initial = {
				usage: {
					promptTokens: 2000,
					inputTokens: 1500,
					completionTokens: 10,
					reasoningTokens: 3,
					cachedInputTokens: 500,
					cacheCreationInputTokens: 40,
					cacheCreation5mTokens: 30,
					cacheCreation1hTokens: 10,
				},
			};
			const { ends } = await run([
				initial,
				...(withOccupancy ? [occupancy] : []),
				{
					usage: {
						promptTokens: 0,
						inputTokens: 0,
						completionTokens: 100,
						reasoningTokens: 20,
						cacheCreation5mTokens: 35,
					},
				},
				{ usage: { promptTokens: 0, completionTokens: 100 } },
				text,
			]);
			expect(ends.at(-1)?.usage).toMatchObject({
				...initial.usage,
				completionTokens: 100,
				reasoningTokens: 20,
				cacheCreation5mTokens: 35,
			});
			expect(ends.at(-1)?.contextPercent).toBe(withOccupancy ? 80 : (2000 / windowSize) * 100);
		});
	}

	for (const percent of [0, 80, -10, 120]) {
		test(`percentage ${percent} survives zero placeholders and uses final output`, async () => {
			const clamped = Math.max(0, Math.min(100, percent));
			const { ends, contexts } = await run([
				{ contextUsagePercentage: percent },
				placeholder,
				{ text: "first " },
				text,
			]);
			expect(ends.at(-1)).toMatchObject({
				contextPercent: clamped,
				usage: {
					promptTokens: Math.round((clamped / 100) * windowSize),
					completionTokens: estimateTokens(`first ${text.text}`),
				},
			});
			expect(contexts.at(-1)).toMatchObject({ percentage: clamped, isEstimated: true });
		});
	}

	test("percentage without usage uses final output", async () => {
		const { ends } = await run([occupancy, text]);
		expect(ends.at(-1)?.usage).toMatchObject({
			promptTokens: Math.round(windowSize * 0.8),
			completionTokens: estimateTokens(text.text),
		});
	});

	for (const percent of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		test(`ignores non-finite occupancy ${String(percent)}`, async () => {
			const { ends, contexts } = await run([{ contextUsagePercentage: percent }, measured, text]);
			expect(ends.at(-1)?.contextPercent).toBe((1200 / windowSize) * 100);
			expect(contexts).toHaveLength(1);
			expect(contexts[0]?.isEstimated).toBeUndefined();
		});
	}

	test("zero placeholder before occupancy cannot suppress its estimate", async () => {
		const { ends } = await run([placeholder, occupancy, text]);
		expect(ends.at(-1)?.usage).toMatchObject({
			promptTokens: Math.round(windowSize * 0.8),
			completionTokens: estimateTokens(text.text),
		});
	});

	test("non-finite events cannot replace an accepted occupancy", async () => {
		const { ends, contexts } = await run([
			occupancy,
			{ contextUsagePercentage: Number.NaN },
			{ contextUsagePercentage: Number.POSITIVE_INFINITY },
			measured,
			text,
		]);
		expect(ends.at(-1)?.contextPercent).toBe(80);
		expect(contexts).toHaveLength(1);
	});

	test("retry clears measured counts before an estimate-only response", async () => {
		const { ends } = await run(
			[measured, new ApiError(503, "upstream temporarily unavailable")],
			[occupancy, text],
		);
		expect(ends).toHaveLength(2);
		expect(ends[1]?.usage).toMatchObject({
			promptTokens: Math.round(windowSize * 0.8),
			completionTokens: estimateTokens(text.text),
		});
		expect(ends[1]?.usage?.cachedInputTokens).toBeUndefined();
	});

	test("retry resets upstream occupancy and measured counts", async () => {
		const { ends, contexts } = await run(
			[occupancy, new ApiError(503, "upstream temporarily unavailable")],
			[measured, text],
		);
		expect(attempt).toBe(2);
		expect(ends).toHaveLength(2);
		expect(ends[0]?.contextPercent).toBe(80);
		expect(ends[1]?.contextPercent).toBe((1200 / windowSize) * 100);
		expect(ends[1]?.usage).toMatchObject(measured.usage);
		expect(contexts.at(-1)?.isEstimated).toBeUndefined();
	});
});
