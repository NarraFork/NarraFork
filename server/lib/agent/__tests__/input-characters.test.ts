import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../logger";
import { countInputCharacters, reportInputCharacters } from "../input-characters";

describe("complete logical input characters", () => {
	test("composition follows final wire text and protocol ownership in traversal order", async () => {
		const wireText = 'line\n"quoted"😀';
		const call = { name: "tool", arguments: { _text: wireText } };
		const result = { _text: wireText };
		const tool = { name: "tool", parameters: { type: "object" } };
		const counts = await countInputCharacters(
			{
				instructions: "fixed\n\nhistory",
				input: [
					{ role: "user", content: wireText },
					{ type: "function_call", ...call },
					{ type: "function_call_output", output: result },
					{
						type: "reasoning",
						summary: [{ type: "summary_text", text: "kept" }],
						encrypted_content: "excluded",
					},
					{ role: "assistant", content: "reply" },
					{ role: "system", content: "old" },
					{ type: "input_text", text: "unknown owner" },
				],
				tools: [tool],
			},
			undefined,
			{ includeComposition: true, instructionsFixedChars: 5 },
		);
		expect(counts?.compositionSegments).toEqual([
			{ category: "system", chars: 5 },
			{ category: "other", chars: "\n\nhistory".length },
			{ category: "user", chars: wireText.length },
			{ category: "toolCall", chars: JSON.stringify(call).length },
			{ category: "toolResult", chars: JSON.stringify(result).length },
			{ category: "assistant", chars: "keptreply".length },
			{ category: "other", chars: "oldunknown owner".length },
			{ category: "toolDefinition", chars: JSON.stringify(tool).length },
		]);
		expect(counts?.compositionSegments?.reduce((sum, item) => sum + item.chars, 0)).toBe(
			counts?.totalChars,
		);
	});

	test("Anthropic and Gemini tool blocks override their enclosing wire role", async () => {
		for (const body of [
			{
				system: "sys",
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "kept", signature: "excluded" },
							{ type: "tool_use", name: "tool", input: { _text: 'a\n"b' } },
						],
					},
					{
						role: "user",
						content: [
							{ type: "tool_result", content: "result" },
							{ type: "text", text: "user" },
						],
					},
				],
			},
			{
				systemInstruction: { parts: [{ text: "sys" }] },
				contents: [
					{
						role: "model",
						parts: [
							{ text: "kept", thought: true, thoughtSignature: "excluded" },
							{ functionCall: { name: "tool", args: { _text: 'a\n"b' } } },
						],
					},
					{
						role: "user",
						parts: [
							{
								functionResponse: {
									name: "tool",
									response: { _text: "result" },
									parts: [{ text: "native result" }],
								},
							},
							{ text: "user" },
						],
					},
				],
			},
		]) {
			const counts = await countInputCharacters(body, undefined, { includeComposition: true });
			expect(counts?.compositionSegments?.map((item) => item.category)).toEqual([
				"system",
				"assistant",
				"toolCall",
				"toolResult",
				"user",
			]);
			expect(counts?.compositionSegments?.reduce((sum, item) => sum + item.chars, 0)).toBe(
				counts?.totalChars,
			);
			expect(counts?.compositionSegments?.[1].chars).toBe(4);
		}
	});

	test("composition hard cap discards only classification and does not publish partial counts", async () => {
		for (const size of [2048, 2049]) {
			const messages = Array.from({ length: size }, (_, index) => ({
				role: index % 2 ? "assistant" : "user",
				content: "x",
			}));
			const counts = await countInputCharacters({ messages }, undefined, {
				includeComposition: true,
				maxMilliseconds: 2000,
			});
			expect(counts?.totalChars).toBe(size);
			if (size === 2048) expect(counts?.compositionSegments).toHaveLength(size);
			else expect(counts?.compositionSegments).toBeNull();
		}
		expect(
			await countInputCharacters(
				{
					messages: [
						{ role: "user", content: "valid" },
						{ role: "assistant", content: [{ type: "unknown_new_type", text: "not counted" }] },
					],
				},
				undefined,
				{ includeComposition: true },
			),
		).toBeNull();
	});

	test("Anthropic counts UTF-16 text, schema/calls/results but not binary or signatures", async () => {
		const args = {
			signature: "legal",
			encrypted_content: "legal too",
			source: { data: "user data" },
		};
		const tool = { name: "Read", description: "read", input_schema: { properties: args } };
		const result = await countInputCharacters({
			system: [{ type: "text", text: "系统😀", cache_control: { type: "ephemeral" } }],
			tools: [{ ...tool, cache_control: { type: "ephemeral" } }],
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "thought", signature: "opaque".repeat(10000) },
						{ type: "redacted_thinking", data: "opaque".repeat(10000) },
						{ type: "image", source: { type: "base64", data: "binary".repeat(10000) } },
						{ type: "tool_use", name: "Read", input: args },
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							content: [
								{ type: "text", text: "result" },
								{ type: "image", source: { data: "binary" } },
							],
						},
						{ type: "text", text: "now" },
					],
				},
			],
			metadata: { user_id: "excluded" },
			model: "excluded",
			authorization: "secret",
		});
		expect(result).toEqual({
			systemChars: 4,
			toolsChars: JSON.stringify(tool).length,
			totalChars:
				4 +
				7 +
				6 +
				3 +
				JSON.stringify(tool).length +
				JSON.stringify({ name: "Read", input: args }).length,
		});
	});

	test("Responses keeps reasoning summaries and ignores encrypted content/images/transport", async () => {
		expect(
			await countInputCharacters({
				instructions: "sys",
				input: [
					{
						type: "reasoning",
						encrypted_content: "cipher".repeat(10000),
						summary: [{ type: "summary_text", text: "sum" }],
					},
					{
						type: "message",
						role: "user",
						content: [
							{ type: "input_text", text: "😀" },
							{ type: "input_image", image_url: "data:image/png;base64,binary" },
						],
					},
					{ type: "function_call", name: "tool", arguments: '{"signature":"legal"}' },
					{ type: "function_call_output", output: "result" },
				],
				previous_response_id: "ignored",
				client_metadata: { secret: "ignored" },
			}),
		).toEqual({
			systemChars: 3,
			toolsChars: 0,
			totalChars:
				3 + 3 + 2 + 6 + JSON.stringify({ name: "tool", arguments: '{"signature":"legal"}' }).length,
		});
	});

	test("Gemini excludes thought signatures and inline data but preserves arbitrary function JSON", async () => {
		const call = { name: "tool", args: { inlineData: "legal", thoughtSignature: "legal" } };
		const response = { name: "tool", response: { encrypted_content: "legal" } };
		expect(
			await countInputCharacters({
				systemInstruction: { parts: [{ text: "sys" }] },
				contents: [
					{
						role: "model",
						parts: [
							{ text: "text", thoughtSignature: "opaque" },
							{ functionCall: call, thoughtSignature: "opaque" },
							{ inlineData: { data: "binary" } },
							{ functionResponse: response },
						],
					},
				],
			}),
		).toEqual({
			systemChars: 3,
			toolsChars: 0,
			totalChars: 7 + JSON.stringify(call).length + JSON.stringify(response).length,
		});
	});

	test("Gemini native functionResponse parts exclude images without filtering response user JSON", async () => {
		const response = {
			inlineData: { data: "legal user data" },
			parts: [{ signature: "legal" }],
			encrypted_content: "legal",
		};
		const counts = await countInputCharacters({
			contents: [
				{
					role: "user",
					parts: [
						{
							functionResponse: {
								name: "tool",
								id: "call-1",
								response,
								signature: "opaque protocol signature",
								parts: [
									{ inlineData: { mimeType: "image/png", data: "image-secret".repeat(10000) } },
									{ text: "attachment text" },
								],
							},
						},
					],
				},
			],
		});
		expect(counts).toEqual({
			totalChars:
				JSON.stringify({ name: "tool", id: "call-1", response }).length + "attachment text".length,
			systemChars: 0,
			toolsChars: 0,
		});
	});

	test("fixed system characters exclude historical system/developer without losing their total text", async () => {
		const history = [
			{ role: "system", content: "old system" },
			{ role: "developer", content: "old developer" },
			{ role: "user", content: "user" },
		];
		expect(await countInputCharacters({ instructions: "runtime", input: history })).toEqual({
			systemChars: 7,
			toolsChars: 0,
			totalChars: "runtimeold systemold developeruser".length,
		});
		expect(
			await countInputCharacters(
				{
					instructions: "runtime\n\nold system\n\nold developer",
					input: [{ role: "user", content: "user" }],
				},
				undefined,
				{ instructionsFixedChars: 7 },
			),
		).toEqual({
			systemChars: 7,
			toolsChars: 0,
			totalChars: "runtime\n\nold system\n\nold developeruser".length,
		});
		const messages = [{ role: "system", content: "runtime" }, ...history];
		expect(
			await countInputCharacters({ messages }, undefined, { firstMessageIsRuntimeSystem: true }),
		).toEqual({
			systemChars: 7,
			toolsChars: 0,
			totalChars: "runtimeold systemold developeruser".length,
		});
		expect(await countInputCharacters({ messages })).toEqual({
			systemChars: 0,
			toolsChars: 0,
			totalChars: "runtimeold systemold developeruser".length,
		});
		expect(
			await countInputCharacters({
				system: [{ type: "text", text: "runtime" }],
				messages: history,
			}),
		).toEqual({
			systemChars: 7,
			toolsChars: 0,
			totalChars: "runtimeold systemold developeruser".length,
		});
	});

	test("unknown root input is unavailable, while supported empty inputs remain complete zero", async () => {
		for (const body of [
			undefined,
			null,
			"text",
			[],
			{},
			{ model: "transport-only", authorization: "secret" },
			{ instructions: 5 },
			{ contents: "wrong shape" },
			{ input: { unknown: "data" } },
		]) {
			expect(await countInputCharacters(body)).toBeNull();
		}
		for (const body of [{ input: "" }, { messages: [] }, { contents: [] }]) {
			expect(await countInputCharacters(body)).toEqual({
				totalChars: 0,
				systemChars: 0,
				toolsChars: 0,
			});
		}
	});

	test("report logs bounded failure reasons once per retry burst without input or exception data", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const debug = spyOn(logger, "debug").mockImplementation(() => {});
		const snapshots: unknown[] = [];
		const params = {
			signal: new AbortController().signal,
			onInputCharacters: (value: unknown) => {
				snapshots.push(value);
			},
		};
		try {
			for (let retry = 0; retry < 3; retry++) {
				await reportInputCharacters(params, { input: "PRIVATE BODY" }, { maxMilliseconds: -1 });
				await reportInputCharacters(params, { input: "PRIVATE BODY" }, { maxChars: 1 });
				await reportInputCharacters(params, { input: "PRIVATE BODY" }, { maxNodes: 0 });
				await reportInputCharacters(params, { model: "PRIVATE BODY" });
			}
			expect(snapshots).toEqual(Array(12).fill(null));
			expect(warn).toHaveBeenCalledTimes(4);
			expect(warn.mock.calls.map((call) => call[1]?.reason).sort()).toEqual([
				"character_budget",
				"node_budget",
				"time_budget",
				"unsupported_input",
			]);
			for (const call of warn.mock.calls) {
				expect(Object.keys(call[1] ?? {}).sort()).toEqual(["durationMs", "reason"]);
				expect(JSON.stringify(call)).not.toContain("PRIVATE BODY");
			}
			const abort = new AbortController();
			abort.abort();
			await reportInputCharacters({ ...params, signal: abort.signal }, { input: "PRIVATE BODY" });
			expect(debug).toHaveBeenCalledTimes(1);
			expect(debug.mock.calls[0]?.[1]?.reason).toBe("aborted");
		} finally {
			warn.mockRestore();
			debug.mockRestore();
		}
	});

	test("successful slow counts receive a throttled numeric-only warning", async () => {
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		let clock = 0;
		const timer = spyOn(performance, "now").mockImplementation(() => {
			clock += 10;
			return clock;
		});
		const snapshots: unknown[] = [];
		const params = {
			signal: new AbortController().signal,
			onInputCharacters: (value: unknown) => {
				snapshots.push(value);
			},
		};
		try {
			await reportInputCharacters(params, { input: "text" }, { maxMilliseconds: 1000 });
			await reportInputCharacters(params, { input: "text" }, { maxMilliseconds: 1000 });
			expect(snapshots).toEqual(
				Array(2).fill({
					totalChars: 4,
					systemChars: 0,
					toolsChars: 0,
					compositionSegments: [{ category: "other", chars: 4 }],
				}),
			);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[1]?.reason).toBe("slow");
			expect(warn.mock.calls[0]?.[1]?.durationMs).toBeGreaterThanOrEqual(25);
		} finally {
			timer.mockRestore();
			warn.mockRestore();
		}
	});

	test("native reasoning/search history is counted while generated image bytes are excluded", async () => {
		const action = { type: "search", query: "lookup", queries: ["one", "two"] };
		const result = await countInputCharacters({
			input: [
				{
					type: "reasoning",
					content: [{ type: "reasoning_text", text: "raw reasoning" }],
					encrypted_content: "cipher",
				},
				{ type: "web_search_call", action, status: "completed" },
				{ type: "image_generation_call", revised_prompt: "prompt", result: "base64".repeat(10000) },
				{ type: "refusal", refusal: "no" },
			],
		});
		expect(result?.totalChars).toBe("raw reasoningpromptno".length + JSON.stringify(action).length);
	});

	test("completions tool protocol selects args but excludes envelope signatures", async () => {
		const args = '{"signature":"legal user field"}';
		const result = await countInputCharacters({
			messages: [
				{
					role: "assistant",
					content: "hello",
					tool_calls: [
						{
							id: "transport-id",
							signature: "opaque",
							function: { name: "tool", arguments: args },
						},
					],
				},
			],
		});
		expect(result?.totalChars).toBe(5 + JSON.stringify({ name: "tool", arguments: args }).length);
	});

	test("unrecognized blocks or custom JSON serialization cannot report a complete count", async () => {
		expect(
			await countInputCharacters({ input: [{ type: "future_text", text: "unknown" }] }),
		).toBeNull();
		expect(await countInputCharacters({ tools: [{ parameters: new Date() }] })).toBeNull();
		expect(
			await countInputCharacters({ tools: [{ type: "future_tool", new_schema: "unknown" }] }),
		).toBeNull();
		const native = {
			type: "web_search",
			search_context_size: "high",
			filters: { allowed_domains: ["example.test"] },
		};
		expect((await countInputCharacters({ tools: [native] }))?.toolsChars).toBe(
			JSON.stringify(native).length,
		);
	});

	test("Gemini Interactions steps count complete text and arbitrary args/results, never signatures/images", async () => {
		const args = { signature: "legal", data: "user JSON" };
		const errorResult = { error: "failed", encrypted_content: "legal result field" };
		const result = await countInputCharacters({
			system_instruction: "system",
			input: [
				{
					type: "user_input",
					content: [
						{ type: "text", text: "user😀" },
						{ type: "image", data: "base64".repeat(10000) },
					],
				},
				{ type: "model_output", content: "reply" },
				{
					type: "thought",
					summary: { type: "text", text: "thought" },
					signature: "cipher".repeat(10000),
				},
				{ type: "function_call", name: "tool", arguments: args, signature: "cipher" },
				{
					type: "function_result",
					result: [
						{ type: "text", text: "result" },
						{ type: "image", data: "base64".repeat(10000) },
					],
				},
				{ type: "function_result", result: errorResult },
			],
		});
		expect(result).toEqual({
			systemChars: 6,
			toolsChars: 0,
			totalChars:
				"systemuser😀replythoughtresult".length +
				JSON.stringify({ name: "tool", arguments: args }).length +
				JSON.stringify(errorResult).length,
		});
		expect(
			await countInputCharacters({
				system_instruction: "system",
				previous_interaction_id: "upstream-prefix",
				input: [{ type: "user_input", content: "delta" }],
			}),
		).toBeNull();
	});

	test("JSON length matches serialization for escapes, lone surrogates, nested arrays", async () => {
		const tool = {
			name: "tool",
			parameters: {
				signature: '\n\t\\"\u0001\ud800😀',
				nested: [null, true, false, 3.14, { data: "value" }],
			},
		};
		const result = await countInputCharacters({ tools: [tool] });
		expect(result?.toolsChars).toBe(JSON.stringify(tool).length);
		expect(result?.totalChars).toBe(JSON.stringify(tool).length);
	});

	test("cancellation, traversal/character/time/depth limits and cycles return null, never partial", async () => {
		const body = { instructions: "sys", input: [{ role: "user", content: "hello" }] };
		const abort = new AbortController();
		abort.abort();
		expect(await countInputCharacters(body, abort.signal)).toBeNull();
		expect(await countInputCharacters(body, undefined, { maxNodes: 1 })).toBeNull();
		expect(await countInputCharacters(body, undefined, { maxChars: 3 })).toBeNull();
		expect(await countInputCharacters(body, undefined, { maxMilliseconds: -1 })).toBeNull();
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(await countInputCharacters({ tools: [{ parameters: cycle }] })).toBeNull();
		let nested: unknown = "text";
		for (let i = 0; i < 150; i++) nested = [nested];
		expect(await countInputCharacters({ input: nested })).toBeNull();
	});

	test("yields during bounded traversal so cancellation can interrupt counting", async () => {
		const controller = new AbortController();
		const request = { tools: [{ parameters: Array.from({ length: 20000 }, () => "x") }] };
		const timeout = setTimeout(() => controller.abort(), 0);
		expect(
			await countInputCharacters(request, controller.signal, { maxMilliseconds: 1000 }),
		).toBeNull();
		clearTimeout(timeout);
	});

	test("retry reports replaceable snapshots, not cumulative characters", async () => {
		const snapshots: unknown[] = [];
		const params = {
			signal: new AbortController().signal,
			onInputCharacters: (value: unknown) => {
				snapshots.push(value);
			},
		};
		await reportInputCharacters(params, { input: "first" }, { includeComposition: false });
		await reportInputCharacters(params, { input: "second" });
		expect(snapshots).toEqual([
			{
				totalChars: 5,
				systemChars: 0,
				toolsChars: 0,
				compositionSegments: [{ category: "other", chars: 5 }],
			},
			{
				totalChars: 6,
				systemChars: 0,
				toolsChars: 0,
				compositionSegments: [{ category: "other", chars: 6 }],
			},
		]);
	});
});

test("report preserves complete totals but marks classification unavailable above the hard cap", async () => {
	const snapshots: unknown[] = [];
	await reportInputCharacters(
		{
			signal: new AbortController().signal,
			onInputCharacters: (counts) => {
				snapshots.push(counts);
			},
		},
		{
			messages: Array.from({ length: 2049 }, (_, index) => ({
				role: index % 2 ? "assistant" : "user",
				content: "x",
			})),
		},
		{ maxMilliseconds: 2000 },
	);
	expect(snapshots).toEqual([
		{ totalChars: 2049, systemChars: 0, toolsChars: 0, compositionSegments: null },
	]);
});

test("report awaits asynchronous numeric preparation before returning to provider transport", async () => {
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let complete = false;
	const reporting = reportInputCharacters(
		{
			signal: new AbortController().signal,
			onInputCharacters: async (counts) => {
				expect(counts?.totalChars).toBe(5);
				entered();
				await gate;
				complete = true;
			},
		},
		{ input: "input" },
	);
	await ready;
	expect(complete).toBe(false);
	release();
	await reporting;
	expect(complete).toBe(true);
});
