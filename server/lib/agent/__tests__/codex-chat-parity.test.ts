/**
 * The Codex HTTP chat path (provider.chat) must present the same client shape as
 * the WebSocket transport and the one-shot utility calls. It previously set only
 * `prompt_cache_key` + `parallel_tool_calls: true` and built its own reasoning
 * block, so a relay that fingerprints request shape saw three different clients
 * depending on which NarraFork path issued the call.
 *
 * Locks the outbound HTTP chat request against the shared stable contract.
 */
import { describe, expect, spyOn, test } from "bun:test";
import type { RecordingRequest, RequestRecording } from "@shared/request-recording";
import { logger } from "../../logger";
import type { OpenAIProviderConfig } from "../../settings";
import { ORIGINATOR, ORIGINATOR_CODEX } from "../../user-agent";
import { createProviderTurnContext } from "../codex-turn-state";
import type { CodexResponsesRequestBody } from "../codex-websocket";
import { type OAIMessage, OpenAIProvider } from "../openai-provider";
import type { ChatParams } from "../provider";
import { ApiRequestDumpCollector } from "../request-dump";
import { StreamProgress } from "../stream-progress";

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

async function captureChat(
	overrides: {
		reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
		userAgentMode?: "narrafork" | "claude-code" | "codex" | "custom";
		config?: Partial<OpenAIProviderConfig>;
		chat?: Partial<ChatParams>;
	} = {},
): Promise<Captured> {
	const provider = new OpenAIProvider({
		id: "codex",
		name: "Codex",
		prefix: "codex",
		apiKey: "sk-test-key",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		defaultModel: "gpt-5.3-codex",
		apiMode: "codex",
		// Match codexFingerprintConfig() used by the built-in CodexProvider.
		userAgentMode: overrides.userAgentMode ?? "codex",
		...overrides.config,
	});

	let captured: Captured | undefined;
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		const raw = init?.headers;
		if (raw instanceof Headers) {
			raw.forEach((v, k) => {
				headers[k.toLowerCase()] = v;
			});
		} else if (Array.isArray(raw)) {
			for (const [k, v] of raw) headers[String(k).toLowerCase()] = String(v);
		} else {
			for (const [k, v] of Object.entries((raw ?? {}) as Record<string, string>)) {
				headers[k.toLowerCase()] = v;
			}
		}
		captured = {
			url: String(input),
			headers,
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		};
		const sse = 'data: {"type":"response.completed","response":{"output":[]}}\n\n';
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		// biome-ignore lint/suspicious/noExplicitAny: fetch stub
	}) as any;

	try {
		for await (const _event of provider.chat({
			conversationId: "conv-http-1",
			content: "hello",
			model: "codex:gpt-5.3-codex",
			cwd: process.cwd(),
			history: [],
			tools: [],
			toolResults: [],
			signal: new AbortController().signal,
			reasoningEffort: overrides.reasoningEffort ?? "high",
			...overrides.chat,
		})) {
			// Drain the stream so the request completes.
		}
	} finally {
		globalThis.fetch = realFetch;
	}

	if (!captured) throw new Error("no request captured");
	return captured;
}

describe("codex HTTP chat request parity", () => {
	test("sends the stable managed Codex client headers", async () => {
		const req = await captureChat();

		expect(req.headers.originator).toBe(ORIGINATOR_CODEX);
		// Official /responses never projects the installation id onto a header.
		expect(req.headers["x-codex-installation-id"]).toBeUndefined();
		expect(req.headers["user-agent"]).toMatch(new RegExp(`^${ORIGINATOR_CODEX}/[^ ]+ `));
		// The Codex Responses transport is always streamed.
		expect(req.headers.accept).toBe("text/event-stream");
	});

	/**
	 * User-reported bug lock: selecting NarraFork UA on the Codex provider must
	 * change both identity headers, not just User-Agent. originator is what
	 * request dumps and relays surface first.
	 */
	test("NarraFork UA mode presents NarraFork on User-Agent and originator", async () => {
		const req = await captureChat({ userAgentMode: "narrafork" });

		expect(req.headers.originator).toBe(ORIGINATOR);
		expect(req.headers["user-agent"]).toMatch(new RegExp(`^${ORIGINATOR}/[^ ]+ `));
		expect(req.headers["user-agent"]).not.toMatch(/^codex-tui\//);
		// Protocol identity fields still travel in the body; only the presented
		// client name changes. No direct installation-id header.
		expect(req.headers["x-codex-installation-id"]).toBeUndefined();
	});

	/**
	 * Codex 0.171.0 puts nonempty instructions in the input prefix for both contracts.
	 * Non-lite retains top-level tools and parallel calls; the lite header must
	 * not be paired with this body.
	 */
	test("does not claim the responses-lite contract while sending a non-lite body", async () => {
		const req = await captureChat();

		expect(req.headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
		expect(req.body.tools).toBeDefined();
		expect(req.body.instructions).toBeUndefined();
		expect(req.body.input).toEqual([
			{ role: "user", content: [{ type: "input_text", text: "hello" }] },
		]);
	});

	test("HTTP and WS share the same stable instruction prefix without losing tools", async () => {
		const chat: Partial<ChatParams> = {
			history: [
				{ role: "developer", content: "runtime" },
				{ role: "system", content: "old" },
			],
			tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
		};
		const req = await captureChat({ chat });
		const provider = new OpenAIProvider({
			id: "codex",
			name: "Codex",
			prefix: "codex",
			apiKey: "test",
			baseUrl: "https://example.invalid",
			defaultModel: "gpt-5.3-codex",
			apiMode: "codex",
		});
		const ws = (
			provider as unknown as {
				buildCodexWebSocketRequest(params: ChatParams): CodexResponsesRequestBody;
			}
		).buildCodexWebSocketRequest({
			conversationId: "conv-http-1",
			content: "hello",
			model: "codex:gpt-5.3-codex",
			cwd: process.cwd(),
			history: [],
			tools: [],
			toolResults: [],
			signal: new AbortController().signal,
			reasoningEffort: "high",
			...chat,
		});
		expect(ws.instructions).toBeUndefined();
		expect(ws.input).toEqual(req.body.input as OAIMessage[]);
		expect(ws.tools).toEqual(req.body.tools);
		expect(
			(ws.input as Array<{ role?: string }>).filter((item) => item.role === "developer"),
		).toHaveLength(1);
	});

	test("records split metadata frames without leaking turn tokens or changing business text", async () => {
		const token = "private-routing-token-from-metadata";
		const laterToken = "ignored-later-routing-token";
		const text =
			'正文中的 {"x-codex-turn-state":"public-example","turn_id":"user-text"} 不应脱敏。';
		const turnContext = createProviderTurnContext();
		const requests: RecordingRequest[] = [];
		const metas: Record<string, unknown>[] = [];
		const chunks: string[] = [];
		const wireHeaders: Headers[] = [];
		const wireBodies: Array<{ client_metadata?: { turn_id?: string } }> = [];
		const recording: RequestRecording = {
			requestId: "codex-redacted-sse",
			request: (request) => requests.push(request),
			responseMeta: (meta) => metas.push(meta),
			responseChunk: (chunk) =>
				chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
			frame: () => {},
			pin: () => {},
			finish: () => {},
		};
		const dump = new ApiRequestDumpCollector(recording);
		const streamProgress = new StreamProgress();
		const provider = new OpenAIProvider({
			id: "codex",
			name: "Codex",
			prefix: "codex",
			apiKey: "sk-test-key",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			defaultModel: "gpt-5.3-codex",
			apiMode: "codex",
		});
		const bytes = new TextEncoder().encode(
			": keepalive\r\n\r\n" +
				`event: response.metadata\ndata: ${JSON.stringify({ headers: { "X-Codex-Turn-State": token } })}\n\n` +
				`data: ${JSON.stringify({ type: "response.metadata", headers: { "x-codex-turn-state": laterToken } })}\n\n` +
				`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n` +
				'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
		);
		let cancellations = 0;
		const realFetch = globalThis.fetch;
		const debug = spyOn(logger, "debug").mockImplementation(() => {});
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			wireHeaders.push(new Headers(init?.headers));
			wireBodies.push(JSON.parse(String(init?.body)));
			let offset = 0;
			return new Response(
				new ReadableStream<Uint8Array>(
					{
						pull(controller) {
							if (offset >= bytes.length) throw new Error("read after response.completed");
							controller.enqueue(bytes.subarray(offset, offset + 7));
							offset += 7;
						},
						cancel() {
							cancellations++;
						},
					},
					{ highWaterMark: 0 },
				),
				{ headers: { "content-type": "text/event-stream" } },
			);
		}) as unknown as typeof fetch;
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				let output = "";
				for await (const event of provider.chat({
					conversationId: "redacted-http",
					content: "hello",
					model: "codex:gpt-5.3-codex",
					cwd: process.cwd(),
					history: [],
					tools: [],
					toolResults: [],
					signal: new AbortController().signal,
					turnContext,
					requestDump: dump,
					streamProgress,
				}))
					output += event.text ?? "";
				expect(output).toBe(text);
				expect(streamProgress.snapshot()).toMatchObject({
					tracked: true,
					statusCode: 200,
					bytes: bytes.length,
					heartbeats: 1,
					dataLines: 5,
				});
			}
			const evidence = JSON.stringify({ requests, metas, chunks, logs: debug.mock.calls });
			expect(evidence).not.toContain(token);
			expect(evidence).not.toContain(laterToken);
			expect(evidence).not.toContain(turnContext.id);
			expect(chunks.join("")).toContain(JSON.stringify(text));
			expect(chunks.join("")).toContain('"X-Codex-Turn-State":"[REDACTED]"');
			expect(wireHeaders[0].get("x-codex-turn-state")).toBeNull();
			expect(wireHeaders[1].get("x-codex-turn-state")).toBe(token);
			expect(wireBodies.map((body) => body.client_metadata?.turn_id)).toEqual([
				turnContext.id,
				turnContext.id,
			]);
			expect(requests[1].headers?.["x-codex-turn-state"]).toBe("[REDACTED]");
			expect(Object.assign({}, ...metas)).toMatchObject({
				bodyIncomplete: false,
				bodyRecording: "redacted_sse_frames",
			});
			expect(cancellations).toBe(2);
		} finally {
			debug.mockRestore();
			globalThis.fetch = realFetch;
		}
	});

	test("incomplete metadata stays redacted in evidence and malformed-stream diagnostics", async () => {
		const tokenPrefix = "unfinished-private-routing-token";
		const chunks: string[] = [];
		const metas: Record<string, unknown>[] = [];
		const dump = new ApiRequestDumpCollector({
			requestId: "codex-incomplete-metadata",
			request: () => {},
			responseMeta: (meta) => metas.push(meta),
			responseChunk: (chunk) => chunks.push(String(chunk)),
			frame: () => {},
			pin: () => {},
			finish: () => {},
		});
		const realFetch = globalThis.fetch;
		const debug = spyOn(logger, "debug").mockImplementation(() => {});
		globalThis.fetch = (async () =>
			new Response(
				`event: response.metadata\ndata: {"headers":{"x-codex-turn-state":"${tokenPrefix}`,
				{ headers: { "content-type": "text/event-stream" } },
			)) as unknown as typeof fetch;
		try {
			const provider = new OpenAIProvider({
				id: "codex",
				name: "Codex",
				prefix: "codex",
				apiKey: "sk-test-key",
				baseUrl: "https://chatgpt.com/backend-api/codex",
				defaultModel: "gpt-5.3-codex",
				apiMode: "codex",
			});
			const events = [];
			for await (const event of provider.chat({
				conversationId: "incomplete-metadata",
				content: "hello",
				model: "codex:gpt-5.3-codex",
				cwd: process.cwd(),
				history: [],
				tools: [],
				toolResults: [],
				signal: new AbortController().signal,
				requestDump: dump,
			}))
				events.push(event);
			expect(
				events.some(
					(event) => event.invalidState?.reason === "stream_closed_before_response_completed",
				),
			).toBe(true);
			expect(JSON.stringify({ chunks, metas, events, logs: debug.mock.calls })).not.toContain(
				tokenPrefix,
			);
			expect(chunks.join("")).toContain("[REDACTED]");
		} finally {
			debug.mockRestore();
			globalThis.fetch = realFetch;
		}
	});

	test("native developer content and additional_tools stay in input without a synthetic prefix", async () => {
		const developerItem = {
			type: "message",
			role: "developer",
			id: "msg_supplied",
			content: [{ type: "input_text", text: "supplied in position" }],
		};
		const toolsItem = {
			type: "additional_tools",
			role: "developer",
			tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
		};
		for (const apiMode of ["responses", "codex"] as const) {
			const { body } = await captureChat({
				config: { apiMode },
				chat: { history: [developerItem, toolsItem] },
			});
			expect(body).not.toHaveProperty("instructions");
			expect(body.input).toEqual([
				developerItem,
				toolsItem,
				{ role: "user", content: [{ type: "input_text", text: "hello" }] },
			]);
		}
	});

	test("ordinary Responses keeps root instructions", async () => {
		const req = await captureChat({
			config: { apiMode: "responses" },
			chat: { history: [{ role: "developer", content: "ordinary instructions" }] },
		});
		expect(req.body.instructions).toBe("ordinary instructions");
		expect(req.body.input).toHaveLength(1);
	});

	test("final headers apply case-insensitive fingerprint and dynamic overrides", async () => {
		const req = await captureChat({
			config: {
				extraHeaders: {
					"USER-AGENT": "static-client",
					"content-type": "static/type",
					authorization: "Bearer static",
				},
				dynamicHeaders: () => ({
					"uSeR-aGeNt": "dynamic-client",
					"CONTENT-TYPE": "dynamic/type",
					Authorization: "Bearer dynamic",
					"X-OpenAI-Internal-Codex-Responses-Lite": "true",
				}),
			},
		});
		expect(req.headers["user-agent"]).toBe("static-client");
		expect(req.headers["content-type"]).toBe("dynamic/type");
		expect(req.headers.authorization).toBe("Bearer dynamic");
		expect(req.headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
	});

	test("correlates the conversation identity across headers and body", async () => {
		const req = await captureChat();
		const clientMetadata = req.body.client_metadata as Record<string, string>;

		expect(req.headers["session-id"]).toBe("conv-http-1");
		expect(req.headers["thread-id"]).toBe("conv-http-1");
		expect(req.body.prompt_cache_key).toBe("conv-http-1");
		expect(clientMetadata.session_id).toBe("conv-http-1");
		expect(clientMetadata.thread_id).toBe("conv-http-1");
		// The real client uses the hyphenated key here and carries it ONLY in
		// client_metadata — never as a matching direct header.
		expect(clientMetadata["x-codex-installation-id"]).toBeTruthy();
		expect(req.headers["x-codex-installation-id"]).toBeUndefined();
	});

	test("sends the same stable body fields as the WebSocket and utility paths", async () => {
		const req = await captureChat();

		expect(req.body.tool_choice).toBe("auto");
		// Parallel tool calls stay on outside the responses-lite contract.
		expect(req.body.parallel_tool_calls).toBe(true);
		// No reasoning.context: the real client only sends it in responses-lite
		// mode; the non-lite shape omits it so the server default applies.
		expect(req.body.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(req.body.include).toEqual(["reasoning.encrypted_content"]);
		expect(req.body.text).toEqual({ verbosity: "low" });
		expect(req.body.store).toBe(false);
		expect(req.body.stream).toBe(true);
	});

	test("normalizes the requested reasoning effort onto the Codex ladder", async () => {
		const req = await captureChat({ reasoningEffort: "medium" });

		expect(req.body.reasoning).toEqual({ effort: "medium", summary: "auto" });
	});

	test("sends the window identity and omits the turn-metadata blob", async () => {
		const req = await captureChat();
		const clientMetadata = req.body.client_metadata as Record<string, string>;

		expect(req.headers["x-codex-turn-metadata"]).toBeUndefined();
		// Window id is conversation-stable and mirrored between the direct
		// header and client_metadata, like the real client's compatibility
		// projection of CodexResponsesMetadata.
		expect(req.headers["x-codex-window-id"]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(clientMetadata["x-codex-window-id"]).toBe(req.headers["x-codex-window-id"]);
	});
});
