import { afterAll, describe, expect, mock, test } from "bun:test";
import type { ContextInputCharacters } from "@shared/context-usage";
import { getModelContextWindow } from "../../settings";
import type { ParsedStreamEvent, ProviderAdapter } from "../provider";
import { type AgentConfig, type AgentEvent, ApiError } from "../types";

let attempts: Array<Array<ParsedStreamEvent | Error>> = [];
let attempt = 0;
let inputPlans: Array<ContextInputCharacters | null> = [];
let requestReadyObserver: (() => void) | undefined;
const model = "claude-sonnet-4-20250514";
const adapter: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		await params.onInputCharacters?.(inputPlans[attempt] ?? null);
		requestReadyObserver?.();
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
	inputPlans = [];
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
	test("overflow display preserves token/window arithmetic without changing compact occupancy cap", async () => {
		const { ends, contexts } = await run([
			{
				usage: { promptTokens: 1100, inputTokens: 1100, completionTokens: 1, contextWindow: 1000 },
			},
			text,
		]);
		expect(contexts.at(-1)?.percentage).toBe(100);
		expect(contexts.at(-1)?.snapshot).toMatchObject({
			occupiedTokens: 1100,
			contextWindow: 1000,
		});
		expect(contexts.at(-1)?.snapshot?.percentage).toBeCloseTo(110, 10);
		expect(ends.at(-1)?.contextPercent).toBe(100);
		expect(ends.at(-1)?.contextSnapshot).toMatchObject({
			occupiedTokens: 1100,
			contextWindow: 1000,
		});
		expect(ends.at(-1)?.contextSnapshot?.percentage).toBeCloseTo(110, 10);
	});
	test("upstream 92.6% on a raw 1M window is 926K, independent of billed 510800", async () => {
		inputPlans = [{ totalChars: 1_000_000, systemChars: 0, toolsChars: 0 }];
		const { ends, contexts } = await run([
			{
				contextUsagePercentage: 92.6,
				usage: { promptTokens: 510800, inputTokens: 510800, contextWindow: 1_000_000 },
			},
			text,
		]);
		expect(ends.at(-1)?.usage?.promptTokens).toBe(510800);
		expect(ends.at(-1)?.contextSnapshot).toMatchObject({
			source: "upstream",
			percentage: 92.6,
			contextWindow: 1_000_000,
			occupiedTokens: 926000,
			inputCharacters: { totalChars: 1_000_000 },
		});
		expect(contexts.at(-1)?.snapshot).toEqual(ends.at(-1)?.contextSnapshot);
	});
	test("real input-only usage yields 51.08% and clears estimated flag", async () => {
		const { ends, contexts } = await run([
			{ usage: { promptTokens: 510800, contextWindow: 1_000_000 } },
			text,
		]);
		expect(ends.at(-1)?.contextSnapshot).toMatchObject({
			source: "usage",
			occupiedTokens: 510800,
		});
		expect(ends.at(-1)?.contextSnapshot?.percentage).toBeCloseTo(51.08, 10);
		expect(contexts.at(-1)?.isEstimated).toBe(false);
	});
	test("fallback counts only the final full input and is saved before matching request end", async () => {
		inputPlans = [{ totalChars: 1000, systemChars: 100, toolsChars: 10 }];
		const { ends, contexts } = await run([text]);
		expect(ends.at(-1)?.usage).toBeUndefined();
		expect(ends.at(-1)?.contextSnapshot).toMatchObject({
			source: "estimate",
			occupiedTokens: 300,
			inputCharacters: { totalChars: 1000 },
		});
		expect(contexts.at(-1)?.snapshot).toEqual(ends.at(-1)?.contextSnapshot);
	});
	test("retry cannot retain the prior attempt's full character denominator", async () => {
		inputPlans = [{ totalChars: 1000, systemChars: 0, toolsChars: 0 }, null];
		const { ends } = await run(
			[measured, new ApiError(503, "upstream temporarily unavailable")],
			[occupancy, text],
		);
		expect(ends[0]?.contextSnapshot?.inputCharacters?.totalChars).toBe(1000);
		expect(ends[1]?.contextSnapshot?.inputCharacters).toBeNull();
		expect(ends[1]?.contextSnapshot?.requestId).not.toBe(ends[0]?.contextSnapshot?.requestId);
	});
	test("zero full-input callback never borrows a known cache denominator", async () => {
		inputPlans = [{ totalChars: 0, systemChars: 0, toolsChars: 0 }];
		const { ends, contexts } = await run([text]);
		expect(contexts).toHaveLength(0);
		expect(ends.at(-1)?.contextSnapshot?.inputCharacters).toBeNull();
		expect(ends.at(-1)?.contextSnapshot?.occupiedTokens).toBeNull();
	});
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
				usage: { promptTokens: 0, completionTokens: 0 },
				contextSnapshot: {
					source: "upstream",
					occupiedTokens: Math.round((clamped / 100) * windowSize),
				},
			});
			expect(contexts.at(-1)).toMatchObject({ percentage: clamped, isEstimated: true });
		});
	}

	test("percentage without usage never synthesizes billable counters", async () => {
		const { ends } = await run([occupancy, text]);
		expect(ends.at(-1)?.usage).toBeUndefined();
		expect(ends.at(-1)?.contextSnapshot).toMatchObject({
			source: "upstream",
			occupiedTokens: Math.round(windowSize * 0.8),
		});
	});

	for (const percent of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		test(`ignores non-finite occupancy ${String(percent)}`, async () => {
			const { ends, contexts } = await run([{ contextUsagePercentage: percent }, measured, text]);
			expect(ends.at(-1)?.contextPercent).toBe((1200 / windowSize) * 100);
			expect(contexts).toHaveLength(1);
			expect(contexts[0]?.isEstimated).toBe(false);
		});
	}

	test("zero placeholder before occupancy remains a billing placeholder", async () => {
		const { ends } = await run([placeholder, occupancy, text]);
		expect(ends.at(-1)?.usage).toMatchObject(placeholder.usage);
		expect(ends.at(-1)?.contextSnapshot?.occupiedTokens).toBe(Math.round(windowSize * 0.8));
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
		expect(ends[1]?.usage).toBeUndefined();
		expect(ends[1]?.contextSnapshot?.occupiedTokens).toBe(Math.round(windowSize * 0.8));
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
		expect(contexts.at(-1)?.isEstimated).toBe(false);
	});
});

test("loop awaits request numeric preparation and binds its pin before consuming response events", async () => {
	inputPlans = [{ totalChars: 1000, systemChars: 100, toolsChars: 10 }];
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let sent = false;
	requestReadyObserver = () => {
		sent = true;
	};
	try {
		const running = runWithConfig(
			{
				freezeContextComposition: async (counts, requestId, _startedAt, signal) => {
					expect(counts?.totalChars).toBe(1000);
					expect(signal.aborted).toBe(false);
					entered();
					await gate;
					return {
						generation: requestId,
						revision: "prepared",
						pageCount: 0,
						totalChars: 200,
						totals: [{ category: "user", chars: 200 }],
					};
				},
			},
			[text],
		);
		await ready;
		expect(sent).toBe(false);
		release();
		const { ends, contexts } = await running;
		expect(sent).toBe(true);
		expect(ends.at(-1)?.contextSnapshot?.composition?.totalChars).toBe(200);
		expect(ends.at(-1)?.contextSnapshot?.composition?.generation).toBe(ends.at(-1)?.requestId);
		expect(contexts.at(-1)?.snapshot?.composition).toEqual(
			ends.at(-1)?.contextSnapshot?.composition,
		);
	} finally {
		release();
		requestReadyObserver = undefined;
	}
});
