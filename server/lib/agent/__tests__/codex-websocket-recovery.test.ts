/**
 * Recovery behaviour of the Codex Responses WebSocket transport, driven through a
 * real local WebSocket server.
 *
 * The helper-level tests in codex-websocket.test.ts pin the classifiers; these pin
 * what the transport actually DOES with them. That distinction matters here because
 * every bug this file guards was a wiring bug, not a classification bug: the
 * detector was right, but the recovery path either resent a stale delta, reused
 * poisoned accumulators, or gave up while a documented recovery was available.
 *
 * Each server below speaks the subset of the protocol the transport reads:
 * `response.created` → optional content → `response.completed`.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
	CodexWebSocketRetryableError,
	clearCodexResponsesWebSocketSessions,
	streamCodexResponsesWebSocket,
} from "../codex-websocket";
import { diagnosticsFromError } from "../error-diagnostics";
import { isRetryableError, ProviderInvalidStateError } from "../error-handling";
import { OpenAIProvider } from "../openai-provider";
import type { ChatParams, ParsedStreamEvent } from "../provider";
import { ApiRequestDumpCollector } from "../request-dump";

const CONNECTION_LIMIT_FRAME = JSON.stringify({
	type: "error",
	status: 400,
	error: {
		type: "invalid_request_error",
		code: "websocket_connection_limit_reached",
		message:
			"Responses websocket connection limit reached (60 minutes). " +
			"Create a new websocket connection to continue.",
	},
});

const PREVIOUS_RESPONSE_MISSING_FRAME = JSON.stringify({
	type: "error",
	status: 400,
	error: {
		type: "invalid_request_error",
		code: "previous_response_not_found",
		message: "Previous response was not found. Retrying the full request.",
	},
});

interface ReceivedRequest {
	/** Which physical connection carried it (0-based, in accept order). */
	connectionIndex: number;
	body: Record<string, unknown>;
}

interface TestServer {
	baseUrl: string;
	requests: ReceivedRequest[];
	handshakes: Headers[];
	connectionCount: () => number;
	stop: () => void;
}

/**
 * Start a WebSocket server that replies to each `response.create` by invoking
 * `respond` with the frames to send.
 *
 * `respond` receives the running request index so a scenario can fail the first
 * request and succeed the retry.
 */
function startServer(
	respond: (context: {
		requestIndex: number;
		connectionIndex: number;
		body: Record<string, unknown>;
		send: (frame: string) => void;
		close: (code: number, reason: string) => void;
	}) => void,
): TestServer {
	const requests: ReceivedRequest[] = [];
	const handshakes: Headers[] = [];
	let connectionsAccepted = 0;
	const connectionIndexes = new WeakMap<ServerWebSocket<unknown>, number>();

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			// Bun consumes the request on upgrade; snapshot its headers beforehand.
			const headers = new Headers(req.headers);
			if (srv.upgrade(req)) {
				handshakes.push(headers);
				return undefined;
			}
			return new Response("expected websocket upgrade", { status: 426 });
		},
		websocket: {
			open(ws) {
				connectionIndexes.set(ws, connectionsAccepted);
				connectionsAccepted++;
			},
			message(ws, raw) {
				const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
				const body = JSON.parse(text) as Record<string, unknown>;
				const connectionIndex = connectionIndexes.get(ws) ?? -1;
				const requestIndex = requests.length;
				requests.push({ connectionIndex, body });
				respond({
					requestIndex,
					connectionIndex,
					body,
					send: (frame) => ws.send(frame),
					close: (code, reason) => ws.close(code, reason),
				});
			},
		},
	});

	return {
		baseUrl: `http://127.0.0.1:${server.port}/backend-api/codex`,
		requests,
		handshakes,
		connectionCount: () => connectionsAccepted,
		stop: () => server.stop(true),
	};
}

function completedFrames(responseId: string, text?: string): string[] {
	const frames = [JSON.stringify({ type: "response.created", response: { id: responseId } })];
	if (text !== undefined) {
		frames.push(
			JSON.stringify({ type: "response.output_text.delta", delta: text, output_index: 0 }),
		);
	}
	frames.push(JSON.stringify({ type: "response.completed", response: { id: responseId } }));
	return frames;
}

let activeServer: TestServer | null = null;

afterEach(async () => {
	await clearCodexResponsesWebSocketSessions();
	activeServer?.stop();
	activeServer = null;
});

function userMessage(text: string) {
	return { role: "user", content: [{ type: "input_text", text }] };
}

async function runStream(
	server: TestServer,
	overrides: { sessionKey?: string; input?: string[]; requestDump?: ApiRequestDumpCollector } = {},
): Promise<ParsedStreamEvent[]> {
	const events: ParsedStreamEvent[] = [];
	for await (const event of streamCodexResponsesWebSocket({
		baseUrl: server.baseUrl,
		apiKey: "sk-test",
		requestDump: overrides.requestDump,
		sessionKey: overrides.sessionKey ?? "narrator-1",
		conversationId: "conv-1",
		credentialId: "cred-1",
		model: "gpt-5.3-codex",
		request: {
			model: "gpt-5.3-codex",
			input: (overrides.input ?? ["hello"]).map(userMessage) as never,
			stream: true,
			instructions: "base",
		},
		signal: new AbortController().signal,
	})) {
		events.push(event);
	}
	return events;
}

test("raw malformed frames and close reasons survive retries without mixing attempts", async () => {
	activeServer = startServer(({ requestIndex, send, close }) => {
		if (requestIndex === 0) {
			send("not-json 中");
			close(1008, "websocket_connection_limit_reached");
		} else for (const frame of completedFrames(`r-${requestIndex}`, "ok")) send(frame);
	});
	const first = new ApiRequestDumpCollector();
	await runStream(activeServer, { requestDump: first });
	expect(first.snapshot().attempts?.[0].response?.bodyText).toContain("not-json 中\n");
	expect(first.snapshot().attempts?.[0].response?.bodyText).toContain("[websocket close 1008]");
	expect(first.snapshot().response?.bodyText).toContain("response.completed");
	expect(first.snapshot().response?.bodyText).not.toContain("not-json");
	const before = JSON.stringify(first.snapshot());
	const second = new ApiRequestDumpCollector();
	await runStream(activeServer, { requestDump: second });
	expect(JSON.stringify(first.snapshot())).toBe(before);
	expect(second.snapshot().response?.bodyText).toContain("r-2");
});

function collectText(events: ParsedStreamEvent[]): string {
	return events.map((event) => event.text ?? "").join("");
}

function createChatProvider(server: TestServer): OpenAIProvider {
	// Exercise the real chat -> chatCodexWebSocket -> transport path, not a mock or
	// an in-generator reconnect. tests/preload.ts isolates HOME/NARRAFORK_HOME.
	return new OpenAIProvider({
		id: "codex-ws-recovery",
		name: "Local Codex WebSocket recovery test",
		prefix: "codex-ws-recovery",
		apiKey: "sk-local-test-only",
		baseUrl: server.baseUrl,
		defaultModel: "gpt-5.3-codex",
		apiMode: "codex",
		codexWebSocket: true,
		codexWebSearch: false,
		codexImageGeneration: false,
	});
}

async function runChat(
	provider: OpenAIProvider,
	overrides: Partial<ChatParams> = {},
	onEvent?: (event: ParsedStreamEvent) => "break" | undefined,
): Promise<{ events: ParsedStreamEvent[]; error: unknown }> {
	const events: ParsedStreamEvent[] = [];
	let error: unknown;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2_000);
	try {
		for await (const event of provider.chat({
			conversationId: "conv-chat-recovery",
			content: "hello",
			model: "codex-ws-recovery:gpt-5.3-codex",
			cwd: process.cwd(),
			history: [],
			tools: [],
			toolResults: [],
			...overrides,
			signal: overrides.signal
				? AbortSignal.any([controller.signal, overrides.signal])
				: controller.signal,
		})) {
			events.push(event);
			if (onEvent?.(event) === "break") break;
		}
	} catch (caught) {
		error = caught;
	} finally {
		clearTimeout(timer);
	}
	return { events, error };
}

function turnStateFrame(turnState = "sticky-1"): string {
	return JSON.stringify({
		type: "response.metadata",
		headers: { "x-codex-turn-state": turnState },
	});
}

function requestTurnState(server: TestServer, requestIndex: number): unknown {
	const metadata = server.requests[requestIndex]?.body.client_metadata as
		| Record<string, unknown>
		| undefined;
	return metadata?.["x-codex-turn-state"];
}

test.each([
	["message", 503, true],
	["close", 503, true],
	["message", 400, false],
	["close", 400, false],
] as const)("preserves string error text and structured retry classification (%s, %i)", async (delivery, status, retryable) => {
	// No retry keywords in the message: classification must use the supplied status.
	const message = "backend rejected this request";
	const frame = JSON.stringify({ type: "error", status, error: message });
	const server = startServer(({ send, close }) => {
		if (delivery === "message") send(frame);
		else close(1011, frame);
	});
	activeServer = server;

	// No requestDump collector: correct errors cannot depend on dump being enabled.
	const result = await runChat(createChatProvider(server));
	expect(result.error).toBeInstanceOf(ProviderInvalidStateError);
	expect(result.error).toMatchObject({ message, status, code: "api_error" });
	expect(diagnosticsFromError(result.error)).toMatchObject({ message, statusCode: status });
	expect(isRetryableError(result.error)).toBe(retryable);
	expect(server.requests).toHaveLength(1);
});

test("preserves detail, code and nested statusCode on a typed WS error", async () => {
	const server = startServer(({ send }) => {
		send(
			JSON.stringify({
				type: "error",
				error: { detail: "upstream rejected", code: "gateway_failure", statusCode: 503 },
			}),
		);
	});
	activeServer = server;
	const result = await runChat(createChatProvider(server));
	expect(result.error).toMatchObject({
		message: "upstream rejected",
		code: "gateway_failure",
		status: 503,
		retryable: true,
	});
	expect(diagnosticsFromError(result.error)).toMatchObject({
		message: "upstream rejected",
		code: "gateway_failure",
		statusCode: 503,
	});
});

test.each([
	false,
	true,
])("surfaces errors inside completed frames instead of an empty response (usage=%s)", async (withUsage) => {
	const server = startServer(({ send }) => {
		send(
			JSON.stringify({
				type: "response.completed",
				response: {
					id: "failed-response",
					status: "failed",
					error: { message: "upstream rejected", code: "server_error", statusCode: 503 },
					...(withUsage ? { usage: { input_tokens: 4, output_tokens: 0 } } : {}),
				},
			}),
		);
	});
	activeServer = server;
	const result = await runChat(createChatProvider(server));
	expect(result.error).toBeUndefined();
	expect(result.events.find((event) => event.invalidState)?.invalidState).toMatchObject({
		message: "upstream rejected",
		reason: "server_error",
		diagnostics: { message: "upstream rejected", code: "server_error", statusCode: 503 },
	});
	expect(result.events.filter((event) => event.usage)).toHaveLength(withUsage ? 1 : 0);
	expect(server.requests).toHaveLength(1);
});

test("empty error sentinels on metadata and completed frames do not fail a healthy turn", async () => {
	const server = startServer(({ send }) => {
		send(JSON.stringify({ type: "response.metadata", status: 200, message: "ok", error: {} }));
		send(JSON.stringify({ type: "response.output_text.delta", delta: "ok" }));
		send(
			JSON.stringify({
				type: "response.completed",
				response: {
					id: "healthy",
					status: "completed",
					error: {},
					usage: { input_tokens: 2, output_tokens: 1 },
				},
			}),
		);
	});
	activeServer = server;
	const result = await runChat(createChatProvider(server));
	expect(result.error).toBeUndefined();
	expect(result.events.some((event) => event.invalidState)).toBe(false);
	expect(collectText(result.events)).toBe("ok");
});

test("an explicit policy refusal outranks an incomplete output-limit reason", async () => {
	const server = startServer(({ send }) => {
		send(
			JSON.stringify({
				type: "response.incomplete",
				response: {
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					error: { code: "cyber_policy", message: "blocked" },
				},
			}),
		);
	});
	activeServer = server;
	const result = await runChat(createChatProvider(server));
	expect(result.error).toBeUndefined();
	expect(result.events.find((event) => event.invalidState)?.invalidState).toMatchObject({
		reason: "cyber_policy",
		message: "blocked",
	});
	expect(server.requests).toHaveLength(1);
});

test("reconnects and completes the turn when upstream reports its connection limit", async () => {
	const server = startServer(({ requestIndex, send }) => {
		if (requestIndex === 0) {
			send(CONNECTION_LIMIT_FRAME);
			return;
		}
		for (const frame of completedFrames("resp-recovered", "recovered")) send(frame);
	});
	activeServer = server;

	const events = await runStream(server);

	expect(collectText(events)).toBe("recovered");
	// The retry rode a NEW physical connection, which is the whole point of
	// "Create a new websocket connection to continue" — resending on the dead
	// socket would fail identically.
	expect(server.requests).toHaveLength(2);
	expect(server.requests[1]?.connectionIndex).toBe(1);
	expect(server.connectionCount()).toBe(2);
});

test("recovery resends the full input rather than a delta the new socket cannot resolve", async () => {
	const server = startServer(({ requestIndex, send }) => {
		if (requestIndex === 1) {
			// Second logical request: the connection dies right after the chain was
			// established by request 0, so the retry must NOT keep previous_response_id.
			send(CONNECTION_LIMIT_FRAME);
			return;
		}
		for (const frame of completedFrames(`resp-${requestIndex}`, "ok")) send(frame);
	});
	activeServer = server;

	// The second request EXTENDS the first, which is what makes it eligible for
	// `previous_response_id` continuation instead of a full resend.
	await runStream(server, { input: ["first"] });
	const events = await runStream(server, { input: ["first", "second"] });

	expect(collectText(events)).toBe("ok");
	expect(server.requests).toHaveLength(3);
	// Request 1 chained onto request 0's response over the reused connection.
	expect(server.requests[1]?.body.previous_response_id).toBe("resp-0");
	// Request 1 sent only the delta.
	expect(server.requests[1]?.body.input).toEqual([userMessage("second")]);
	// The retry dropped the chain: previous_response_id is gone and the FULL input is
	// back. Keeping the delta here is what turns a recoverable connection limit into a
	// `previous_response_not_found` failure on the replacement socket.
	expect(server.requests[2]?.body.previous_response_id).toBeUndefined();
	expect(server.requests[2]?.body.input).toEqual([userMessage("first"), userMessage("second")]);
});

test("retries the full request when upstream has forgotten the previous response", async () => {
	const server = startServer(({ requestIndex, send }) => {
		if (requestIndex === 1) {
			send(PREVIOUS_RESPONSE_MISSING_FRAME);
			return;
		}
		for (const frame of completedFrames(`resp-${requestIndex}`, "ok")) send(frame);
	});
	activeServer = server;

	await runStream(server, { input: ["first"] });
	const events = await runStream(server, { input: ["first", "second"] });

	expect(collectText(events)).toBe("ok");
	expect(server.requests).toHaveLength(3);
	expect(server.requests[2]?.body.previous_response_id).toBeUndefined();
	expect(server.requests[2]?.body.input).toEqual([userMessage("first"), userMessage("second")]);
});

test("a connection limit delivered in a truncated close reason still recovers", async () => {
	// RFC 6455 caps a close reason at 123 bytes and this payload is ~230, so the frame
	// arrives cut mid-string and is NOT parseable JSON. Recovery therefore cannot rely
	// on parsing — before the fix this fell through to "closed before
	// response.completed" and threw a plain, non-retryable Error.
	const truncated = CONNECTION_LIMIT_FRAME.slice(0, 123);
	expect(() => JSON.parse(truncated)).toThrow();

	const server = startServer(({ requestIndex, send, close }) => {
		if (requestIndex === 0) {
			close(1011, truncated);
			return;
		}
		for (const frame of completedFrames("resp-1", "recovered")) send(frame);
	});
	activeServer = server;

	const events = await runStream(server);

	expect(collectText(events)).toBe("recovered");
	expect(server.connectionCount()).toBe(2);
});

test("surfaces a retryable error once the reconnect budget is spent", async () => {
	// Every attempt hits the limit, so the transport runs out of reconnects. It must
	// still hand the caller a RETRYABLE error: the agent loop's outer retry (fresh
	// history, fresh upstream session) is the remaining recovery, and a plain Error
	// would be classified terminal and end the turn.
	const server = startServer(({ send }) => send(CONNECTION_LIMIT_FRAME));
	activeServer = server;

	let thrown: unknown;
	try {
		await runStream(server);
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(CodexWebSocketRetryableError);
	const retryable = thrown as CodexWebSocketRetryableError;
	expect(retryable.retryable).toBe(true);
	expect(retryable.code).toBe("websocket_connection_limit_reached");
	// Nothing streamed, so the caller may replay outright rather than resume.
	expect(retryable.resumable).toBe(false);
});

test("a connection limit after streamed output is reported as resumable", async () => {
	// Output already reached the caller and was persisted, so the recovery contract
	// changes: continue from the partial turn instead of replaying and duplicating it.
	const server = startServer(({ send }) => {
		send(JSON.stringify({ type: "response.created", response: { id: "resp-partial" } }));
		send(JSON.stringify({ type: "response.output_text.delta", delta: "partial", output_index: 0 }));
		send(CONNECTION_LIMIT_FRAME);
	});
	activeServer = server;

	const events: ParsedStreamEvent[] = [];
	let thrown: unknown;
	try {
		for await (const event of streamCodexResponsesWebSocket({
			baseUrl: server.baseUrl,
			apiKey: "sk-test",
			sessionKey: "narrator-partial",
			conversationId: "conv-partial",
			credentialId: "cred-1",
			model: "gpt-5.3-codex",
			request: {
				model: "gpt-5.3-codex",
				input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] as never,
				stream: true,
				instructions: "base",
			},
			signal: new AbortController().signal,
		})) {
			events.push(event);
		}
	} catch (error) {
		thrown = error;
	}

	expect(collectText(events)).toBe("partial");
	expect(thrown).toBeInstanceOf(CodexWebSocketRetryableError);
	expect((thrown as CodexWebSocketRetryableError).resumable).toBe(true);
	// No speculative reconnect: replaying would re-emit "partial".
	expect(server.connectionCount()).toBe(1);
});

test("captures turn state from a metadata event and replays it on later requests", async () => {
	const server = startServer(({ requestIndex, send }) => {
		if (requestIndex === 0) {
			send(
				JSON.stringify({
					type: "response.metadata",
					headers: { "x-codex-turn-state": "ts-1" },
				}),
			);
		}
		for (const frame of completedFrames(`resp-${requestIndex}`, "ok")) send(frame);
	});
	activeServer = server;

	await runStream(server, { input: ["first"] });
	await runStream(server, { input: ["first", "second"] });

	expect(server.requests).toHaveLength(2);
	// The token only exists after the first response, so the first request cannot
	// carry it; every later request in the turn must.
	const first = server.requests[0]?.body.client_metadata as Record<string, string> | undefined;
	expect(first?.["x-codex-turn-state"]).toBeUndefined();
	const second = server.requests[1]?.body.client_metadata as Record<string, string> | undefined;
	expect(second?.["x-codex-turn-state"]).toBe("ts-1");
});

test("the request dump records the original request, not a recovery resend", async () => {
	const server = startServer(({ requestIndex, send }) => {
		if (requestIndex === 0) {
			send(CONNECTION_LIMIT_FRAME);
			return;
		}
		for (const frame of completedFrames("resp-1", "ok")) send(frame);
	});
	activeServer = server;

	const dumped: Array<Record<string, unknown>> = [];
	for await (const _event of streamCodexResponsesWebSocket({
		baseUrl: server.baseUrl,
		apiKey: "sk-test",
		sessionKey: "narrator-dump",
		conversationId: "conv-dump",
		credentialId: "cred-1",
		model: "gpt-5.3-codex",
		request: {
			model: "gpt-5.3-codex",
			input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] as never,
			stream: true,
			instructions: "base",
		},
		signal: new AbortController().signal,
		onRequestPrepared: ({ body }) => dumped.push(body),
	})) {
		// drain
	}

	// Reported once. Overwriting the dump with the resend would erase the payload
	// that actually triggered the failure someone is trying to diagnose.
	expect(dumped).toHaveLength(1);
});

const recoverableErrors = [
	{ code: "websocket_connection_limit_reached", frame: CONNECTION_LIMIT_FRAME },
	{ code: "previous_response_not_found", frame: PREVIOUS_RESPONSE_MISSING_FRAME },
];

for (const { code, frame } of recoverableErrors) {
	test.each([
		"error frame",
		"close reason",
		"truncated close reason",
	])(`preserves sticky routing across two chat calls after resumable ${code} (%s)`, async (delivery) => {
		const server = startServer(({ requestIndex, send, close }) => {
			if (requestIndex === 0) {
				send(turnStateFrame());
				send(JSON.stringify({ type: "response.created", response: { id: "resp-partial" } }));
				send(JSON.stringify({ type: "response.output_text.delta", delta: "partial" }));
				if (delivery === "error frame") send(frame);
				else if (delivery === "close reason") close(1011, JSON.stringify({ error: { code } }));
				else close(1011, frame.slice(0, 123));
				return;
			}
			for (const completed of completedFrames("resp-resumed", "continued")) send(completed);
		});
		activeServer = server;
		const provider = createChatProvider(server);

		const first = await runChat(provider);
		expect(collectText(first.events)).toBe("partial");
		expect(first.error).toBeInstanceOf(CodexWebSocketRetryableError);
		expect(first.error).toMatchObject({ code, retryable: true, resumable: true });
		// The first generator has fully unwound through catch/finally. No replay
		// occurred inside it: continuation belongs to the NEXT chat invocation.
		expect(server.requests).toHaveLength(1);
		expect(server.connectionCount()).toBe(1);

		const history = [
			userMessage("hello"),
			{ role: "assistant", content: [{ type: "output_text", text: "partial" }] },
		];
		const second = await runChat(provider, { history, content: "continue" });
		expect(second.error).toBeUndefined();
		expect(collectText(second.events)).toBe("continued");
		expect(server.requests).toHaveLength(2);
		expect(server.connectionCount()).toBe(2);
		expect(server.requests[1]?.connectionIndex).toBe(1);
		expect(server.requests[1]?.body.previous_response_id).toBeUndefined();
		expect(server.requests[1]?.body.input).toEqual([...history, userMessage("continue")]);
		expect(requestTurnState(server, 0)).toBeUndefined();
		expect(requestTurnState(server, 1)).toBe("sticky-1");
		// WS routing state rides response.create.client_metadata, NOT handshake
		// headers (docs/codex-websocket.md). Conversation identity stays stable.
		for (const headers of server.handshakes) {
			expect(headers.get("authorization")).toBe("Bearer sk-local-test-only");
			expect(headers.get("session-id")).toBe("conv-chat-recovery");
			expect(headers.get("x-codex-turn-state")).toBeNull();
		}
	});

	test(`preserves the latest sticky token across chat calls after exhausted ${code} retries`, async () => {
		const server = startServer(({ requestIndex, send }) => {
			if (requestIndex < 2) {
				send(turnStateFrame(`sticky-${requestIndex + 1}`));
				send(frame);
				return;
			}
			for (const completed of completedFrames("resp-retried", "retried")) send(completed);
		});
		activeServer = server;
		const provider = createChatProvider(server);

		const first = await runChat(provider);
		expect(collectText(first.events)).toBe("");
		expect(first.error).toBeInstanceOf(CodexWebSocketRetryableError);
		expect(first.error).toMatchObject({ code, retryable: true, resumable: false });
		expect(server.requests).toHaveLength(2);
		expect(requestTurnState(server, 1)).toBe("sticky-1");

		const second = await runChat(provider);
		expect(second.error).toBeUndefined();
		expect(collectText(second.events)).toBe("retried");
		expect(server.requests).toHaveLength(3);
		expect(server.requests[2]?.connectionIndex).toBe(2);
		expect(server.requests[2]?.body.previous_response_id).toBeUndefined();
		expect(server.requests[2]?.body.input).toEqual(server.requests[0]?.body.input);
		expect(requestTurnState(server, 2)).toBe("sticky-2");
	});

	test(`abort during ${code} cleanup still clears sticky state before the next chat`, async () => {
		const controller = new AbortController();
		const server = startServer(({ requestIndex, send }) => {
			if (requestIndex === 0) {
				send(turnStateFrame());
				send(JSON.stringify({ type: "response.output_text.delta", delta: "partial" }));
				send(frame);
				return;
			}
			for (const completed of completedFrames("resp-after-abort", "fresh")) send(completed);
		});
		activeServer = server;
		const provider = createChatProvider(server);

		// Cancel exactly when discardResponseChain closes the real client socket.
		// A server-side close callback is too late on Bun: the client can finish
		// cleanup before the server observes its close. Keep the real close intact.
		const { default: WebSocket } = await import("ws");
		const originalClose = WebSocket.prototype.close;
		const closeSpy = spyOn(WebSocket.prototype, "close").mockImplementation(function (
			this: InstanceType<typeof WebSocket>,
			...args
		) {
			controller.abort();
			originalClose.apply(this, args);
		});
		try {
			const first = await runChat(provider, { signal: controller.signal });
			expect(controller.signal.aborted).toBe(true);
			expect(collectText(first.events)).toBe("partial");
			expect(first.error).toBeInstanceOf(CodexWebSocketRetryableError);
			expect(first.error).toMatchObject({ code, resumable: true });
		} finally {
			closeSpy.mockRestore();
		}

		const second = await runChat(provider);
		expect(second.error).toBeUndefined();
		expect(collectText(second.events)).toBe("fresh");
		expect(server.requests).toHaveLength(2);
		expect(server.requests[1]?.connectionIndex).toBe(1);
		expect(requestTurnState(server, 1)).toBeUndefined();
	});
}

test.each([
	"error frame",
	"close reason",
])("ordinary errors still clear sticky state before the next chat (%s)", async (delivery) => {
	const failure = JSON.stringify({
		type: "error",
		status: 400,
		error: { code: "invalid_request_error", message: "bad request" },
	});
	const server = startServer(({ requestIndex, send, close }) => {
		if (requestIndex === 0) {
			send(turnStateFrame());
			send(JSON.stringify({ type: "response.output_text.delta", delta: "partial" }));
			if (delivery === "error frame") send(failure);
			else close(1011, failure);
			return;
		}
		for (const completed of completedFrames("resp-after-error", "fresh")) send(completed);
	});
	activeServer = server;
	const provider = createChatProvider(server);

	const first = await runChat(provider);
	expect(collectText(first.events)).toBe("partial");
	expect(first.error).toBeInstanceOf(Error);
	expect(first.error).not.toBeInstanceOf(CodexWebSocketRetryableError);
	expect((first.error as Error).message).toContain("bad request");

	const second = await runChat(provider);
	expect(second.error).toBeUndefined();
	expect(collectText(second.events)).toBe("fresh");
	expect(server.requests).toHaveLength(2);
	expect(server.requests[1]?.connectionIndex).toBe(1);
	expect(server.requests[1]?.body.previous_response_id).toBeUndefined();
	expect(requestTurnState(server, 1)).toBeUndefined();
});

test("normal abort still clears sticky state before the next chat", async () => {
	const server = startServer(({ requestIndex, send }) => {
		if (requestIndex === 0) {
			send(turnStateFrame());
			send(JSON.stringify({ type: "response.output_text.delta", delta: "partial" }));
			return;
		}
		for (const completed of completedFrames("resp-after-abort", "fresh")) send(completed);
	});
	activeServer = server;
	const provider = createChatProvider(server);
	const controller = new AbortController();

	const first = await runChat(provider, { signal: controller.signal }, (event) => {
		if (event.text) controller.abort();
	});
	expect(collectText(first.events)).toBe("partial");
	expect(first.error).toBeUndefined();
	expect(first.events.some((event) => event.silentDisconnect)).toBe(true);

	const second = await runChat(provider);
	expect(second.error).toBeUndefined();
	expect(collectText(second.events)).toBe("fresh");
	expect(server.requests).toHaveLength(2);
	expect(server.requests[1]?.connectionIndex).toBe(1);
	expect(requestTurnState(server, 1)).toBeUndefined();
});

test("an explicit upstream reset clears the sticky token retained for resumable chat recovery", async () => {
	const server = startServer(({ requestIndex, send }) => {
		if (requestIndex === 0) {
			send(turnStateFrame());
			send(JSON.stringify({ type: "response.output_text.delta", delta: "partial" }));
			send(CONNECTION_LIMIT_FRAME);
			return;
		}
		for (const completed of completedFrames("resp-reset", "fresh")) send(completed);
	});
	activeServer = server;
	const provider = createChatProvider(server);

	const first = await runChat(provider);
	expect(first.error).toBeInstanceOf(CodexWebSocketRetryableError);
	expect(first.error).toMatchObject({ resumable: true });
	const second = await runChat(provider, { resetUpstreamSession: true });
	expect(second.error).toBeUndefined();
	expect(collectText(second.events)).toBe("fresh");
	expect(server.requests).toHaveLength(2);
	expect(server.requests[1]?.connectionIndex).toBe(1);
	expect(server.requests[1]?.body.previous_response_id).toBeUndefined();
	expect(requestTurnState(server, 1)).toBeUndefined();
});

const CYBER_POLICY_FRAME = JSON.stringify({
	type: "error",
	status: 400,
	error: {
		type: "invalid_request_error",
		code: "cyber_policy",
		message: "Request blocked by cyber safety policy",
	},
});

test("a policy-violation error frame ends the turn as invalidState — never retried, never thrown", async () => {
	const server = startServer(({ send }) => {
		send(CYBER_POLICY_FRAME);
	});
	activeServer = server;

	const events = await runStream(server);

	// The violation surfaces through the same terminal channel a streamed
	// response.failed takes, so the loop classifies it content_filter and the
	// credential pool records neither a success nor a failure.
	const invalid = events.find((event) => event.invalidState);
	expect(invalid?.invalidState?.reason).toBe("cyber_policy");
	expect(invalid?.invalidState?.message).toBe("Request blocked by cyber safety policy");
	// Exactly one request on one connection: no reconnect, no resend, no SSE fallback.
	expect(server.requests).toHaveLength(1);
	expect(server.connectionCount()).toBe(1);
});

test("a policy violation delivered on the close frame still ends the turn as invalidState", async () => {
	const server = startServer(({ close }) => {
		close(1008, CYBER_POLICY_FRAME);
	});
	activeServer = server;

	const events = await runStream(server);

	const invalid = events.find((event) => event.invalidState);
	expect(invalid?.invalidState?.reason).toBe("cyber_policy");
	expect(server.requests).toHaveLength(1);
	expect(server.connectionCount()).toBe(1);
});

test.each([
	["error frame", "cyber_policy"],
	["close reason", "cyber_policy"],
	["truncated close reason", "cyber_policy"],
	["response.failed", "cyber_policy"],
	["response.incomplete", "cyber_policy"],
	["response.failed", "server_error"],
	["response.completed", "server_error"],
	["response.completed", "cyber_policy"],
	["response.incomplete", "content_filter"],
	["response.incomplete", "max_output_tokens"],
])("discards the chain when the consumer immediately breaks on invalidState (%s: %s)", async (delivery, reason) => {
	const server = startServer(({ requestIndex, send, close }) => {
		if (requestIndex === 1) {
			if (delivery === "error frame") {
				send(CYBER_POLICY_FRAME);
			} else if (delivery === "close reason") {
				// Keep this valid JSON within the RFC 6455 close-reason limit so it
				// exercises the structured close branch, not the truncated fallback.
				close(1008, JSON.stringify({ error: { code: reason, message: "blocked" } }));
			} else if (delivery === "truncated close reason") {
				const truncated = CYBER_POLICY_FRAME.slice(0, 123);
				expect(() => JSON.parse(truncated)).toThrow();
				close(1008, truncated);
			} else {
				send(
					JSON.stringify({
						type: delivery,
						response: {
							id: "resp-rejected",
							...(delivery !== "response.incomplete"
								? { status: "failed", error: { code: reason, message: "blocked" } }
								: { incomplete_details: { reason } }),
						},
					}),
				);
			}
			return;
		}
		if (requestIndex === 0) send(turnStateFrame());
		for (const frame of completedFrames(`resp-${requestIndex}`, "ok")) send(frame);
	});
	activeServer = server;
	const provider = createChatProvider(server);
	const { default: WebSocket } = await import("ws");
	// Inspect the real client's state, not a delayed server-side close callback.
	let sendingClient: InstanceType<typeof WebSocket> | undefined;
	const originalSend = WebSocket.prototype.send;
	const sendSpy = spyOn(WebSocket.prototype, "send").mockImplementation(function (
		this: InstanceType<typeof WebSocket>,
		...args
	) {
		sendingClient = this;
		Reflect.apply(originalSend, this, args);
	});
	let clientClosedAtInvalidState = false;
	try {
		const first = await runChat(provider);
		expect(first.error).toBeUndefined();
		expect(collectText(first.events)).toBe("ok");

		const rejected = await runChat(
			provider,
			{ history: [userMessage("hello")], content: "blocked" },
			(event) => {
				if (event.invalidState) {
					clientClosedAtInvalidState = sendingClient?.readyState === WebSocket.CLOSED;
					// The real agent loop returns here. Draining the generator would
					// execute cleanup AFTER yield and hide the leaked socket/chain.
					return "break";
				}
			},
		);
		expect(rejected.error).toBeUndefined();
		expect(rejected.events.filter((event) => event.invalidState)).toHaveLength(1);
		expect(rejected.events.find((event) => event.invalidState)?.invalidState?.reason).toBe(reason);
		// No replay, reconnect, or fallback within the rejected chat. Its request
		// really continued a successful response; there is stale state to discard.
		expect(server.requests).toHaveLength(2);
		expect(server.connectionCount()).toBe(1);
		expect(server.requests[1]?.connectionIndex).toBe(0);
		expect(server.requests[1]?.body.previous_response_id).toBe("resp-0");
		expect(server.requests[1]?.body.input).toEqual([userMessage("blocked")]);

		const history = [userMessage("hello"), userMessage("blocked")];
		const next = await runChat(provider, { history, content: "next" });
		expect(next.error).toBeUndefined();
		expect(collectText(next.events)).toBe("ok");
		expect(server.requests).toHaveLength(3);
		expect(server.requests[2]?.body.previous_response_id).toBeUndefined();
		expect(server.requests[2]?.body.input).toEqual([...history, userMessage("next")]);
		expect(server.requests[2]?.connectionIndex).toBe(1);
		expect(server.connectionCount()).toBe(2);
		expect(clientClosedAtInvalidState).toBe(true);
		// Only the connection-scoped response chain is discarded. Sticky routing
		// and the credential identity retain their existing semantics.
		expect(requestTurnState(server, 2)).toBe("sticky-1");
		for (const headers of server.handshakes) {
			expect(headers.get("authorization")).toBe("Bearer sk-local-test-only");
		}
	} finally {
		sendSpy.mockRestore();
	}
});
