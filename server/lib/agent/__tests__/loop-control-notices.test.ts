/**
 * Loop-control notices are rows, not in-memory text.
 *
 * The turn nudge used to be appended inside the last tool result, and the broken-call
 * reminder lived only in the next turn's string, so a request rebuilt from the database
 * never said what the live one had. Both are now notice rows the host persists
 * (`deliverInjectionRow`), placed after the step's results; a host that cannot persist
 * (a reflection loop) still sends their text, as the next turn's input.
 *
 * These loops have no rebuild, so each later request is the projection of the loop's
 * own transcript: the rows the fake builder receives are exactly what the model reads.
 */

import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { isBrokenToolOutput, outputToText } from "@shared/agent-protocol/tool-output";
import { z } from "zod/v4";
import { ContextEvidenceBudget } from "../../../services/context-evidence-budget";
import * as knowledge from "../../../services/knowledge-injection";
import type { ChatParams, DbMessage, ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent } from "../types";

const TOOL = "LoopNoticeTool";

let script: (request: number) => Array<Record<string, unknown>> = () => [{ text: "done" }];
const requests: Array<
	Pick<ChatParams, "content" | "toolResults" | "resetUpstreamSession"> & { rows: DbMessage[] }
> = [];
let projectedRows: DbMessage[] = [];

const provider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async (rows) => {
		projectedRows = structuredClone(rows);
		return { history: [] };
	},
	injectSystemPrompt: () => {},
	async *chat(params) {
		requests.push({
			content: params.content,
			toolResults: structuredClone(params.toolResults),
			resetUpstreamSession: params.resetUpstreamSession,
			rows: projectedRows,
		});
		params.onRequestStart?.();
		for (const event of script(requests.length - 1)) yield event;
	},
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
const { agentLoop } = await import("../loop");

toolRegistry.register({
	name: TOOL,
	description: "Loop notice test tool",
	parameters: z.object({ value: z.string() }),
	execute: async (args) => ({ output: `ran:${args.value}` }),
});

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	toolRegistry.unregister(TOOL);
});

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: "loop-notices",
		conversationId: "loop-notices",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal: new AbortController().signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		...overrides,
	};
}

function toolCall(request: number, input: Record<string, unknown>): Record<string, unknown> {
	return { toolUses: [{ toolUseId: `call-${request}`, name: TOOL, input, outputIndex: 0 }] };
}

async function run(cfg: AgentConfig): Promise<AgentEvent[]> {
	requests.length = 0;
	projectedRows = [];
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(cfg, "start", { rows: [] })) events.push(event);
	return events;
}

/** Every settled call's stored output across the requests' rows. */
function resultOutputs(): string[] {
	return requests.flatMap((request) =>
		request.rows.flatMap((row) =>
			(row.toolCalls ?? []).flatMap((call) =>
				call.status === "success" || call.status === "fail" ? [outputToText(call.outputJson)] : [],
			),
		),
	);
}

/** The text of the input a request ends with. */
function trailingInput(rows: readonly DbMessage[]): string | null | undefined {
	const last = rows.at(-1);
	return last?.role === "user" ? last.contentText : undefined;
}

describe("turn nudge", () => {
	test("is a row after the step's results, never inside the last result", async () => {
		script = (request) =>
			request < 9 ? [toolCall(request, { value: `v${request}` })] : [{ text: "done" }];
		const delivered: Array<{ source: string; content: string }> = [];
		await run(
			config({
				maxTurns: 10,
				deliverInjectionRow: (injection) => {
					delivered.push({ source: injection.source, content: injection.content });
					return { text: injection.content, messageId: `row-${delivered.length}` };
				},
			}),
		);
		const nudges = delivered.filter((row) => row.source === "turn_nudge");
		// 80% of 10 turns: only the step at turn index 8 nudges.
		expect(nudges).toEqual([
			{
				source: "turn_nudge",
				content:
					"[SYSTEM: You have used 9 of 10 turns. Please wrap up your work soon — summarize remaining steps if you cannot finish in time.]",
			},
		]);
		expect(resultOutputs().some((output) => output.includes("wrap up"))).toBe(false);
		// The next request carries it once, after that step's results.
		const rows = requests[9]?.rows ?? [];
		expect(requests[9]?.content).toBe("");
		expect(trailingInput(rows)).toBe(nudges[0]?.content);
		expect(rows.filter((row) => row.contentText?.includes("You have used"))).toHaveLength(1);
		expect(rows.at(-2)?.toolCalls).toEqual([
			expect.objectContaining({ toolUseId: "call-8", status: "success", outputJson: "ran:v8" }),
		]);
	});
});

describe("broken call", () => {
	test("its reminder is a row and the stored result is marked by its sanitized input", async () => {
		script = (request) =>
			request === 0 ? [toolCall(request, { _raw: '{"value":' })] : [{ text: "done" }];
		const delivered: Array<{ source: string; content: string }> = [];
		const events = await run(
			config({
				deliverInjectionRow: (injection) => {
					delivered.push({ source: injection.source, content: injection.content });
					return { text: injection.content, messageId: "broken-row" };
				},
			}),
		);
		const result = events.find(
			(event): event is Extract<AgentEvent, { type: "tool_result" }> =>
				event.type === "tool_result",
		);
		expect(result?.brokenInputOverride).toBeDefined();
		const reminder = delivered.find((row) => row.source === "broken_call");
		expect(reminder?.content).toContain(
			`Your previous ${TOOL} call(s) had invalid or missing input`,
		);
		// The broken pair is stored marked, so the projection leaves it out; the reminder
		// says why, as the next request's input.
		const rows = requests[1]?.rows ?? [];
		const call = rows.flatMap((row) => row.toolCalls ?? []).find((c) => c.toolUseId === "call-0");
		expect(isBrokenToolOutput(call?.outputJson)).toBe(true);
		expect(trailingInput(rows)).toBe(reminder?.content ?? "missing reminder");
	});

	test("a host without a store still sends the reminder from memory", async () => {
		script = (request) =>
			request === 0 ? [toolCall(request, { _raw: '{"value":' })] : [{ text: "done" }];
		await run(config());
		expect(trailingInput(requests[1]?.rows ?? [])).toContain(
			`Your previous ${TOOL} call(s) had invalid or missing input`,
		);
	});
});

describe("tool-output shared evidence budget", () => {
	for (const cap of [0, 64]) {
		test(`rejects oversized knowledge without losing results or required notices (${cap} bytes)`, async () => {
			const budget = new ContextEvidenceBudget(() => cap);
			const already = new Set<string>();
			const scan = spyOn(knowledge, "scanToolOutputForKnowledgeDetailed").mockResolvedValue({
				hits: [{ entryId: "overflow", title: "OVERFLOW", summary: "文".repeat(500) }],
				content: "unused projection",
			});
			const delivered: Array<{ source: string; content: string }> = [];
			script = (request) =>
				request < 2 ? [toolCall(request, { value: `v${request}` })] : [{ text: "done" }];
			try {
				await run(
					config({
						maxTurns: 3,
						evidenceBudget: budget,
						knowledgeInjectedEntryIds: already,
						deliverInjectionRow: (injection) => {
							delivered.push(injection);
							return { text: injection.content, messageId: `budget-row-${delivered.length}` };
						},
					}),
				);
				expect(delivered.filter((item) => item.source === "knowledge_base_hint")).toEqual([]);
				expect(resultOutputs()).toContain("ran:v0");
				expect(resultOutputs()).toContain("ran:v1");
				expect(budget.remaining).toBe(cap);
				expect(already.size).toBe(0);
				if (cap === 0) expect(scan).not.toHaveBeenCalled();
			} finally {
				scan.mockRestore();
			}
		});
	}

	test("charges rendered knowledge after memory and deduplicates across tool turns", async () => {
		const budget = new ContextEvidenceBudget(() => 1024);
		budget.reserve("memory", 300).commit("m".repeat(300));
		const already = new Set<string>();
		const scan = spyOn(knowledge, "scanToolOutputForKnowledgeDetailed").mockImplementation(
			async (_user, _output, local, options) => {
				expect(options?.byteBudget).toBeLessThanOrEqual(724);
				expect(local).not.toBe(already);
				local.add("global:one");
				return {
					hits: [{ entryId: "one", title: "Advice", summary: "Check the logs" }],
					content: "unused projection",
				};
			},
		);
		const delivered: Array<{ source: string; content: string }> = [];
		script = (request) =>
			request < 2 ? [toolCall(request, { value: `v${request}` })] : [{ text: "done" }];
		try {
			await run(
				config({
					evidenceBudget: budget,
					knowledgeInjectedEntryIds: already,
					deliverInjectionRow: (injection) => {
						delivered.push(injection);
						return { text: injection.content, messageId: `budget-row-${delivered.length}` };
					},
				}),
			);
			const hints = delivered.filter((item) => item.source === "knowledge_base_hint");
			expect(hints).toHaveLength(1);
			expect(budget.remaining).toBe(724 - Buffer.byteLength(hints[0]?.content ?? ""));
			expect(already.has("global:one")).toBe(true);
		} finally {
			scan.mockRestore();
		}
	});
});

test("a budget-omitted durable hint is not reintroduced from the pending-input queue", async () => {
	script = (request) =>
		request === 0 ? [toolCall(request, { value: "once" })] : [{ text: "done" }];
	let drained = false;
	await run(
		config({
			evidenceBudget: new ContextEvidenceBudget(() => 0),
			rebuildRequestHistory: async () => ({
				history: [],
				rows: [],
				omittedOptionalMessageIds: requests.length === 0 ? [] : ["omitted-hint"],
			}),
			getAfterToolsInjections: () => {
				if (drained) return { text: "" };
				drained = true;
				return {
					text: "OPTIONAL_OMITTED\n\nREQUIRED_NOTICE",
					parts: [
						{ messageId: "omitted-hint", text: "OPTIONAL_OMITTED" },
						{ messageId: "required-notice", text: "REQUIRED_NOTICE" },
					],
				};
			},
		}),
	);
	expect(JSON.stringify(requests[1])).toContain("REQUIRED_NOTICE");
	expect(JSON.stringify(requests[1])).not.toContain("OPTIONAL_OMITTED");
	expect(requests[1]?.resetUpstreamSession).toBe(true);
});
