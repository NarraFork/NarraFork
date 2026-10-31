/**
 * A loop's transcript holds the rows the host would have stored, and its requests are
 * the same projection a rebuild runs (loop-transcript.ts, history-build.ts).
 */

import { describe, expect, test } from "bun:test";
import { assembleContent, splitEnvelope } from "@shared/narrator-blocks/storage";
import { AnthropicProvider } from "../anthropic-provider";
import { GeminiInteractionsProvider } from "../gemini-interactions-provider";
import { GeminiProvider } from "../gemini-provider";
import { buildAdapterHistory, historyTail } from "../history-build";
import { LoopTranscript } from "../loop-transcript";
import { OpenAIProvider } from "../openai-provider";
import { projectHistory } from "../projection";
import type { DbMessage, ProviderAdapter } from "../provider";
import { RemoteProviderAdapter } from "../remote-provider-adapter";

const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const TARGET = { strict: false };
const UPDATE_TEXT = "<context_update>\n[workspace]\n/repo/b\n</context_update>";
const UPDATE: DbMessage = {
	id: "context-update-1",
	role: "sys",
	contentText: UPDATE_TEXT,
	contentJson: [
		{ type: "text", text: UPDATE_TEXT },
		{
			type: "context_update",
			epochId: "epoch-1",
			changes: [{ key: "workspace", value: "/repo/b" }],
		},
	],
	parentToolUseId: null,
	messageUuid: null,
};
const CONFIG = {
	id: "context-update",
	name: "Context update",
	prefix: "context-update",
	apiKey: "unused",
	baseUrl: "https://example.invalid/v1",
	defaultModel: "test-model",
};

function projectionProviders(): Array<[string, ProviderAdapter, string]> {
	return [
		["Anthropic native", new AnthropicProvider({ ...CONFIG, officialApi: true }), "claude-opus-5"],
		[
			"Anthropic compatible",
			new AnthropicProvider({ ...CONFIG, officialApi: false }),
			"claude-opus-5",
		],
		["Responses", new OpenAIProvider({ ...CONFIG, apiMode: "responses" }), "gpt-5"],
		["Codex wire adapter", new OpenAIProvider({ ...CONFIG, apiMode: "codex" }), "gpt-5"],
		["Completions", new OpenAIProvider({ ...CONFIG, apiMode: "completions" }), "kimi-k2.5"],
		["Gemini", new GeminiProvider(CONFIG), "gemini-2.5-pro"],
		["Gemini interactions", new GeminiInteractionsProvider(CONFIG), "gemini-2.5-pro"],
		[
			"Remote",
			new RemoteProviderAdapter({
				providerTypeId: "test",
				providerInstanceId: "test",
				providerPrefix: "test",
				config: {},
				modelCatalog: [],
				rpc: {
					chat: async () => {
						throw new Error("No network in projection test");
					},
					generate: async () => {
						throw new Error("No network in projection test");
					},
				},
			}),
			"test-model",
		],
	];
}

/** Exercise the same split/assembly codec that durable message blocks use. */
function restoredRows(rows: DbMessage[]): DbMessage[] {
	return rows.map((row) => ({
		...structuredClone(row),
		contentJson: assembleContent(splitEnvelope(row).blocks),
	}));
}

for (const [name, provider, model] of projectionProviders()) {
	test(`${name}: typed updates append once and rebuild identically after a tool result`, async () => {
		const transcript = new LoopTranscript([
			{
				id: "user-1",
				role: "user",
				contentText: "read file",
				contentJson: [{ type: "text", text: "read file" }],
				parentToolUseId: null,
				messageUuid: null,
			},
		]);
		toolStep(transcript, ["read"]);
		transcript.settleTool("read", { output: "file contents" });
		const build = (rows: DbMessage[]) =>
			buildAdapterHistory(provider, rows, { provider: "test", model });
		const before = await build(transcript.rows);
		transcript.replace([...transcript.rows, UPDATE]);
		const live = await build(transcript.rows);
		const rebuilt = await build(restoredRows(transcript.rows));
		expect(live.history).toEqual(rebuilt.history);
		expect(live.history.slice(0, before.history.length)).toEqual(before.history);
		const last = live.history.at(-1) as { role?: string; type?: string };
		expect(last.role ?? last.type).toBe(name === "Gemini interactions" ? "user_input" : "user");
		const encoded = JSON.stringify(live.history);
		expect(encoded.split("<context_update>")).toHaveLength(2);
		expect(encoded).not.toContain("epoch-1");
		expect(encoded).not.toContain('"changes"');
		const neutral = await projectHistory(transcript.rows, TARGET);
		expect(neutral.turns.at(-1)).toMatchObject({
			kind: "input",
			items: [
				{
					text: UPDATE_TEXT,
					contextUpdate: {
						epochId: "epoch-1",
						changes: [{ key: "workspace", value: "/repo/b" }],
					},
				},
			],
		});
		transcript.replace([
			...transcript.rows,
			{
				id: "user-2",
				role: "user",
				contentText: "continue after update",
				contentJson: [{ type: "text", text: "continue after update" }],
				parentToolUseId: null,
				messageUuid: null,
			},
		]);
		const next = await build(transcript.rows);
		expect(next.history.slice(0, live.history.length)).toEqual(live.history);
		expect(next.history).toEqual((await build(restoredRows(transcript.rows))).history);
	});
}

for (const apiMode of ["responses", "codex"] as const) {
	test(`${apiMode}: outgoing instructions remain the baseline; update stays in input`, async () => {
		const provider = new OpenAIProvider({ ...CONFIG, apiMode });
		const requests: Array<{ instructions: string; input: unknown[] }> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)));
			return new Response(
				'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		}) as typeof fetch;
		try {
			const original: DbMessage[] = [
				{
					id: "first",
					role: "user",
					contentText: "first",
					contentJson: [{ type: "text", text: "first" }],
					parentToolUseId: null,
					messageUuid: null,
				},
			];
			for (const rows of [original, [...original, UPDATE], restoredRows([...original, UPDATE])]) {
				const { history } = await buildAdapterHistory(provider, rows, {
					provider: "test",
					model: "gpt-5",
				});
				provider.injectSystemPrompt(history, "frozen-baseline", "gpt-5");
				for await (const _event of provider.chat({
					conversationId: "context-update",
					content: "",
					model: "gpt-5",
					cwd: ".",
					history,
					tools: [],
					toolResults: [],
					signal: new AbortController().signal,
				})) {
					/* consume */
				}
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
		expect(requests).toHaveLength(3);
		expect(requests[1].instructions).toBe(requests[0].instructions);
		expect(requests[1].instructions).toContain("frozen-baseline");
		expect(requests[1].instructions).not.toContain("<context_update>");
		expect(requests[1].input.slice(0, requests[0].input.length)).toEqual(requests[0].input);
		expect(requests[1].input).toEqual(requests[2].input);
		expect(JSON.stringify(requests[1].input).split("<context_update>")).toHaveLength(2);
		expect(JSON.stringify(requests[1].input)).not.toContain("epoch-1");
	});
}

function toolStep(transcript: LoopTranscript, ids: string[]) {
	transcript.appendStep([
		{ type: "text", text: "Checking." },
		...ids.map((id) => ({
			type: "tool_use" as const,
			toolUseId: id,
			name: "Read",
			input: { file_path: `${id}.txt` },
		})),
	]);
}

describe("loop transcript", () => {
	test("a call reaches the model only together with its result, in call order", async () => {
		const transcript = new LoopTranscript();
		transcript.appendInput("read both");
		toolStep(transcript, ["a", "b"]);
		const open = await projectHistory(transcript.rows, TARGET);
		expect(open.turns.map((turn) => turn.kind)).toEqual(["input", "assistant"]);

		transcript.settleTool("b", { output: "second" });
		transcript.settleTool("a", { output: "first", isError: true });
		const settled = await projectHistory(transcript.rows, TARGET);
		const results = settled.turns.at(-1);
		expect(results).toMatchObject({
			kind: "tool_results",
			results: [
				{ wireId: "a", text: "first", isError: true },
				{ wireId: "b", text: "second", isError: false },
			],
		});
		expect(historyTail(transcript.rows)).toEqual({ toolResults: true, input: true });
	});

	test("a snapshot keeps describing the request it was taken for", () => {
		const transcript = new LoopTranscript();
		toolStep(transcript, ["a"]);
		const before = transcript.rows;
		transcript.settleTool("a", { output: "done" });
		transcript.appendInput("next");
		expect(before).toHaveLength(1);
		expect(before[0]?.toolCalls?.[0]?.status).toBe("running");
		expect(transcript.rows[0]?.toolCalls?.[0]?.status).toBe("success");
	});

	test("an input not answered yet is part of the request, not of the transcript", () => {
		const transcript = new LoopTranscript();
		transcript.appendInput("first");
		const request = transcript.withInput("pending");
		expect(request).toHaveLength(2);
		expect(transcript.rows).toHaveLength(1);
		expect(transcript.withInput("")).toEqual(transcript.rows);
	});

	test("a broken call and its result are left out", async () => {
		const transcript = new LoopTranscript();
		toolStep(transcript, ["ok", "bad"]);
		transcript.settleTool("ok", { output: "fine" });
		transcript.settleTool("bad", { output: "invalid input", isError: true, broken: true });
		const { turns } = await projectHistory(transcript.rows, TARGET);
		expect(JSON.stringify(turns)).not.toContain('"bad"');
		expect(turns.at(-1)).toMatchObject({ results: [{ wireId: "ok", text: "fine" }] });
	});

	test("images carry their bytes: inputs and tool results reach the projection", async () => {
		const transcript = new LoopTranscript();
		transcript.appendInput("look", [{ format: "png", base64: PNG }]);
		toolStep(transcript, ["shot"]);
		transcript.settleTool("shot", { output: "captured", images: [{ format: "png", base64: PNG }] });
		const { turns } = await projectHistory(transcript.rows, TARGET);
		expect(turns[0]).toMatchObject({
			kind: "input",
			items: [{ text: "look", images: [{ mediaType: "image/png", base64: PNG }] }],
		});
		expect(turns.at(-1)).toMatchObject({
			results: [{ wireId: "shot", images: [{ mediaType: "image/png", base64: PNG }] }],
		});
	});

	test("the input is sent as written, without a sender marker", async () => {
		const provider = new AnthropicProvider({
			id: "transcript",
			name: "Transcript",
			prefix: "transcript",
			apiKey: "unused",
			baseUrl: "https://example.invalid",
			defaultModel: "claude-sonnet-4",
		});
		const transcript = new LoopTranscript();
		transcript.appendInput("exactly this");
		const built = await buildAdapterHistory(provider, transcript.rows, {
			provider: "transcript",
			model: "claude-sonnet-4",
		});
		expect(built.history).toEqual([{ role: "user", content: "exactly this" }]);
	});
});
