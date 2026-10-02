import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const oldHome = process.env.NARRAFORK_HOME;
const home = mkdtempSync(join(tmpdir(), "nf-search-probe-"));
process.env.NARRAFORK_HOME = home;
const { settings } = await import("../../settings");
const { executeSearch, testSearchChannel } = await import("../router");
const { toolRegistry } = await import("../../agent/tool-registry");
const { webSearchTool } = await import("../../agent/tools/web-search");
const { webFetchTool } = await import("../../agent/tools/web-fetch");
toolRegistry.register(webSearchTool);
toolRegistry.register(webFetchTool);
const original = structuredClone(settings);
const oldFetch = globalThis.fetch;
const model = "probe_official:claude-opus-5";
const channel = {
	id: "subagent",
	kind: "subagent" as const,
	enabled: false,
	model,
	maxTurns: 2,
	reasoningEffort: "none" as const,
	timeoutMs: 5000,
};
const request = {
	channelId: "subagent",
	query: "current release",
	purpose: "Verify current release with sources",
	userId: "probe-admin",
};
const requests: Array<Record<string, unknown>> = [];

function sse(events: Array<Record<string, unknown>>) {
	return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
function chat(text = "Verified [source](https://source.example)") {
	return sse([
		{ type: "message_start", message: { id: "msg_probe", usage: { input_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]);
}
function toolCall() {
	return sse([
		{ type: "message_start", message: { id: "msg_tool", usage: { input_tokens: 1 } } },
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "call_search", name: "WebSearch", input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: {
				type: "input_json_delta",
				partial_json: JSON.stringify({ query: "current release" }),
			},
		},
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]);
}
function searchResult() {
	return sse([
		{ type: "message_start", message: { id: "msg_search", usage: { input_tokens: 1 } } },
		{
			type: "content_block_start",
			index: 0,
			content_block: {
				type: "web_search_tool_result",
				tool_use_id: "srv_1",
				content: [{ title: "Release", url: "https://source.example", encrypted_content: "x" }],
			},
		},
		{
			type: "content_block_start",
			index: 1,
			content_block: { type: "text", text: "Found current release" },
		},
		{ type: "message_stop" },
	]);
}
function capture(first = toolCall(), searchResponse = searchResult()) {
	let chats = 0;
	globalThis.fetch = (async (_input, init) => {
		const body = JSON.parse(String(init?.body));
		requests.push(body);
		const side = body.tools?.some((tool: { type?: string }) => tool.type === "web_search_20250305");
		return new Response(side ? searchResponse : chats++ === 0 ? first : chat(), {
			headers: { "content-type": "text/event-stream" },
		});
	}) as typeof fetch;
}

beforeEach(() => {
	Object.assign(settings, structuredClone(original));
	settings.clientFingerprint = {
		installationId: "11111111-2222-4333-8444-555555555555",
		claudeDeviceId: "a".repeat(64),
	};
	settings.anthropicProviders = [
		{
			id: "probe-official",
			name: "Probe official",
			prefix: "probe_official",
			apiKey: "fake-key",
			baseUrl: "https://probe.invalid/v1",
			defaultModel: "claude-opus-5",
			officialApi: true,
			nativeSearch: true,
		},
	];
	settings.customApiProviders = [
		{
			...settings.anthropicProviders[0],
			protocol: "anthropic-official",
		},
	];
	settings.search = {
		...settings.search,
		customProviders: [],
		channels: [
			{ ...channel, model: "missing:old", enabled: false },
			{ id: "native", kind: "native", enabled: false },
		],
	};
	requests.length = 0;
});
afterEach(() => {
	globalThis.fetch = oldFetch;
	Object.assign(settings, structuredClone(original));
});
afterAll(() => {
	if (oldHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = oldHome;
	rmSync(home, { recursive: true, force: true });
});

describe("search subagent settings probe", () => {
	test("tests a disabled unsaved model with real provider requests and no parent context", async () => {
		capture();
		const saved = JSON.stringify(settings.search);
		const result = await testSearchChannel(request, { channel });
		expect(result.text).toContain("Verified");
		expect(result.attempts).toHaveLength(1);
		expect(requests).toHaveLength(3);
		expect(requests[0].model).toBe("claude-opus-5");
		expect((requests[0].tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
			"WebSearch",
			"WebFetch",
			// Always-declared reflection gates are still denied outside their active gate.
			"DangerConfirm",
			"DangerCancel",
			"ExitPlanConfirm",
			"ExitPlanConfirmAndCompact",
			"ExitPlanRevise",
			"TaskReflectConfirm",
			"TaskReflectRevise",
		]);
		expect(requests[1].tool_choice).toEqual({ type: "tool", name: "web_search" });
		expect(JSON.stringify(settings.search)).toBe(saved);
	});
	test("pins the selected balanced aggregation member for the entire probe", async () => {
		const first = settings.anthropicProviders?.[0];
		if (!first) throw new Error("Missing probe provider");
		const second = {
			...first,
			id: "probe-second",
			prefix: "probe_second",
			baseUrl: "https://second.invalid/v1",
			defaultModel: "claude-sonnet-4-6",
		};
		settings.anthropicProviders = [first, second];
		settings.customApiProviders = [
			{ ...first, protocol: "anthropic-official" },
			{ ...second, protocol: "anthropic-official" },
		];
		settings.agent.modelAggregations = [
			{
				id: "balanced-probe",
				name: "Balanced probe",
				routingMode: "balanced",
				models: [model, "probe_second:claude-sonnet-4-6"],
			},
		];
		const draft = { ...channel, model: "__agg__:balanced-probe" };
		capture();
		expect((await testSearchChannel(request, { channel: draft })).text).toContain("Verified");
		capture();
		expect((await testSearchChannel(request, { channel: draft })).text).toContain("Verified");
		expect(requests).toHaveLength(6);
		expect(requests.slice(0, 3).map((body) => body.model)).toEqual([
			"claude-opus-5",
			"claude-opus-5",
			"claude-opus-5",
		]);
		expect(requests.slice(3).map((body) => body.model)).toEqual([
			"claude-sonnet-4-6",
			"claude-sonnet-4-6",
			"claude-sonnet-4-6",
		]);
	});
	test("normal routing still ignores a disabled channel", async () => {
		capture();
		await expect(executeSearch(request)).rejects.toThrow("No usable web search channel");
		expect(requests).toHaveLength(0);
	});
	test("reports missing configuration and unsupported models before dispatch", async () => {
		capture();
		await expect(
			testSearchChannel(request, { channel: { ...channel, model: undefined } }),
		).rejects.toThrow("model is not configured");
		await expect(
			testSearchChannel(request, { channel: { ...channel, model: "openai:gpt-4o-mini" } }),
		).rejects.toThrow("does not support native search");
		await expect(testSearchChannel({ ...request, channelId: "missing" })).rejects.toThrow(
			"does not exist",
		);
		expect(requests).toHaveLength(0);
	});
	test("enforces max turns instead of silently accepting an incomplete search", async () => {
		capture();
		await expect(
			testSearchChannel(request, { channel: { ...channel, maxTurns: 1 } }),
		).rejects.toThrow(/turn|budget/i);
		expect(requests.length).toBeLessThanOrEqual(2);
	});
	test("does not report an answer from memory as a successful search", async () => {
		capture(chat());
		await expect(testSearchChannel(request, { channel })).rejects.toThrow(
			"did not perform a web search",
		);
	});
	test("rejects a side request that only returns model prose without search evidence", async () => {
		capture(toolCall(), chat("An answer without actually searching"));
		await expect(testSearchChannel(request, { channel })).rejects.toThrow(
			/web search|search result/i,
		);
		expect(requests).toHaveLength(2);
		expect(requests[1].tool_choice).toEqual({ type: "tool", name: "web_search" });
	});
	test("cancelled probes never dispatch", async () => {
		capture();
		const controller = new AbortController();
		controller.abort(new Error("cancelled probe"));
		await expect(
			testSearchChannel({ ...request, signal: controller.signal }, { channel }),
		).rejects.toThrow("cancelled probe");
		expect(requests).toHaveLength(0);
	});
	test("channel timeout aborts an in-flight provider request", async () => {
		let aborted = false;
		globalThis.fetch = ((_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(init.signal?.reason);
					},
					{ once: true },
				);
			})) as typeof fetch;
		await expect(
			testSearchChannel(request, { channel: { ...channel, timeoutMs: 100 } }),
		).rejects.toThrow("timed out");
		expect(aborted).toBe(true);
	});
});
