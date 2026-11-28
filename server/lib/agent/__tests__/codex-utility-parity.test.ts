/**
 * Codex one-shot utility requests such as title generation go through
 * generateWithMeta, which historically passed no
 * conversation id. The Codex emulation headers session-id/thread-id are only
 * emitted when a conversation id exists, and prompt_cache_key is likewise
 * derived from it — so these probes sent a visibly different client shape than
 * a real Codex session. Lock the emitted shape so the paths cannot drift.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ORIGINATOR_CODEX } from "../../user-agent";
import { OpenAIProvider } from "../openai-provider";
import { resetStructuredOutputFallbackMemory } from "../structured-output-fallback";
import { resetUnsupportedParameterMemory } from "../unsupported-parameter-fallback";

afterEach(() => {
	resetStructuredOutputFallbackMemory();
	resetUnsupportedParameterMemory();
});

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

async function capture(run: (p: OpenAIProvider) => Promise<unknown>): Promise<Captured> {
	const provider = new OpenAIProvider({
		id: "codex",
		name: "Codex",
		prefix: "codex",
		apiKey: "sk-test-key",
		baseUrl: "https://chatgpt.com/backend-api/codex",
		defaultModel: "gpt-5.3-codex",
		apiMode: "codex",
		// Match codexFingerprintConfig() used by the built-in CodexProvider.
		userAgentMode: "codex",
		// biome-ignore lint/suspicious/noExplicitAny: test config subset
	} as any);

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
		return new Response(sse, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		// biome-ignore lint/suspicious/noExplicitAny: fetch stub
	}) as any;

	try {
		await run(provider);
	} finally {
		globalThis.fetch = realFetch;
	}
	if (!captured) throw new Error("no request captured");
	return captured;
}

const genMeta = (p: OpenAIProvider) =>
	p.generateWithMeta("hello", "codex:gpt-5.3-codex", "You are a title generator.", {
		reasoningEffort: "high",
	});
const genHistory = (p: OpenAIProvider) =>
	p.generateWithHistoryWithMeta(
		"You are a title generator.",
		"content",
		"codex:gpt-5.3-codex",
		undefined,
		{ reasoningEffort: "high" },
	);

describe.each([
	["generateWithMeta", genMeta],
	["generateWithHistoryWithMeta", genHistory],
])("codex utility request parity: %s", (_name, run) => {
	test("sends the stable managed Codex client headers", async () => {
		const req = await capture(run);

		expect(req.headers.originator).toBe(ORIGINATOR_CODEX);
		// Official /responses never projects the installation id onto a header.
		expect(req.headers["x-codex-installation-id"]).toBeUndefined();
		expect(req.headers["user-agent"]).toMatch(new RegExp(`^${ORIGINATOR_CODEX}/[^ ]+ `));
		expect(req.headers["user-agent"]).toMatch(
			new RegExp(`unknown \\(${ORIGINATOR_CODEX}; [^)]+\\)$`),
		);
		expect(req.headers.accept).toBe("text/event-stream");
	});

	/**
	 * Utility requests (title/compact/reflection) go through the same transport and
	 * the same non-lite body shape, so they must not claim the lite contract either.
	 */
	test("does not claim the responses-lite contract", async () => {
		const req = await capture(run);

		expect(req.headers["x-openai-internal-codex-responses-lite"]).toBeUndefined();
	});

	test("puts the utility instruction in the developer input prefix", async () => {
		const req = await capture(run);
		expect(req.body).not.toHaveProperty("instructions");
		expect(req.body.input).toEqual([
			{
				type: "message",
				id: expect.stringMatching(/^msg_nf_instructions_/),
				role: "developer",
				content: [{ type: "input_text", text: "You are a title generator." }],
			},
			{ role: "user", content: expect.any(String) },
		]);
	});

	test("sends one correlated conversation identity across headers", async () => {
		const req = await capture(run);

		expect(req.headers["session-id"]).toBeTruthy();
		expect(req.headers["thread-id"]).toBe(req.headers["session-id"]);
	});

	/**
	 * codex-rs sends x-client-request-id (= thread_id) on every HTTP /responses
	 * request (codex-api/src/endpoint/responses.rs, next to
	 * build_session_headers) and on the websocket handshake; only
	 * /responses/compact omits it. The utility transport must match the main
	 * HTTP path and correlate it with the conversation identity.
	 */
	test("sends x-client-request-id matching the conversation identity", async () => {
		const req = await capture(run);

		expect(req.headers["x-client-request-id"]).toBe(req.headers["thread-id"]);
	});

	test("sets prompt_cache_key to the same id", async () => {
		const req = await capture(run);

		expect(req.body.prompt_cache_key).toBeTruthy();
		expect(req.body.prompt_cache_key).toBe(req.headers["session-id"]);
	});

	test("sends the stable Codex Responses body fields", async () => {
		const req = await capture(run);
		const metadata = req.body.client_metadata as Record<string, string>;

		expect(req.body.instructions).toBeUndefined();
		expect((req.body.input as unknown[])[0]).toMatchObject({
			type: "message",
			role: "developer",
			id: expect.stringMatching(/^msg_nf_instructions_/),
			content: [{ type: "input_text", text: "You are a title generator." }],
		});
		expect(req.body.input).toHaveLength(2);
		expect(req.body.tool_choice).toBe("auto");
		// Parallel tool calls stay on outside the responses-lite contract.
		expect(req.body.parallel_tool_calls).toBe(true);
		// No reasoning.context — real non-lite requests omit it (lite-only field).
		expect(req.body.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(req.body.include).toEqual(["reasoning.encrypted_content"]);
		expect(req.body.text).toEqual({ verbosity: "low" });
		expect(metadata.session_id).toBe(req.headers["session-id"]);
		expect(metadata.thread_id).toBe(req.headers["thread-id"]);
		// The real client uses the hyphenated key here and carries it ONLY in
		// client_metadata — never as a matching direct header.
		expect(metadata["x-codex-installation-id"]).toBeTruthy();
		expect(req.headers["x-codex-installation-id"]).toBeUndefined();
	});

	test("sends the window identity and omits the turn-metadata blob", async () => {
		const req = await capture(run);
		const metadata = req.body.client_metadata as Record<string, string>;

		// buildCodexEmulationHeaders intentionally excludes turn-level tracking.
		expect(req.headers["x-codex-turn-metadata"]).toBeUndefined();
		expect(req.headers["x-codex-window-id"]).toBeTruthy();
		expect(metadata["x-codex-window-id"]).toBe(req.headers["x-codex-window-id"]);
	});
});

test("both Codex utility paths omit a developer prefix without base instructions", async () => {
	const model = "codex:gpt-5.3-codex";
	const withoutSystem = await capture((provider) => provider.generateWithMeta("hello", model));
	const emptySystem = await capture((provider) =>
		provider.generateWithHistoryWithMeta("", "hello", model),
	);
	for (const { body } of [withoutSystem, emptySystem]) {
		expect(body).not.toHaveProperty("instructions");
		expect(body.input).toHaveLength(1);
		expect((body.input as Array<{ role: string }>)[0].role).toBe("user");
	}
});

describe("Codex structured-output compatibility", () => {
	test("format rejection replaces the input instruction prefix without changing turn identity", async () => {
		const provider = new OpenAIProvider({
			id: "codex",
			name: "Codex",
			prefix: "codex",
			apiKey: "sk-test-key",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			defaultModel: "gpt-5.3-codex",
			apiMode: "codex",
			codexInstallationId: "credential-owned-installation",
		});
		const bodies: Record<string, unknown>[] = [];
		const headers: Headers[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			headers.push(new Headers(init?.headers));
			if (bodies.length === 1)
				return new Response(
					JSON.stringify({
						error: { message: "Unsupported parameter: text.format", type: "invalid_request_error" },
					}),
					{
						status: 400,
						headers: {
							"content-type": "application/json",
							"x-codex-turn-state": "schema-retry-route",
						},
					},
				);
			return new Response(
				'data: {"type":"response.output_text.delta","delta":"{\\"value\\":\\"ok\\"}"}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		}) as unknown as typeof fetch;
		try {
			const result = await provider.generateWithMeta(
				"hello",
				"codex:gpt-5.3-codex",
				"Base instructions.",
				{
					responseFormat: {
						type: "json_schema",
						name: "value_result",
						schema: {
							type: "object",
							properties: { value: { type: "string" } },
							required: ["value"],
							additionalProperties: false,
						},
						strict: true,
					},
				},
			);
			expect(result.structured).toEqual({ value: "ok" });
			expect(bodies).toHaveLength(2);
			const prefixes = bodies.map(
				(body) =>
					(body.input as Array<{ id: string; role: string; content: Array<{ text: string }> }>)[0],
			);
			expect(prefixes[0].content[0].text).toBe("Base instructions.");
			expect(prefixes[1].content[0].text).toContain("Base instructions.");
			expect(prefixes[1].content[0].text).toContain('"value"');
			expect(prefixes[1].id).not.toBe(prefixes[0].id);
			for (const body of bodies) {
				expect(body.instructions).toBeUndefined();
				expect(
					(body.input as Array<{ role: string }>).filter((item) => item.role === "developer"),
				).toHaveLength(1);
				expect((body.client_metadata as Record<string, string>)["x-codex-installation-id"]).toBe(
					"credential-owned-installation",
				);
			}
			expect((bodies[0].text as Record<string, unknown>).format).toBeDefined();
			expect((bodies[1].text as Record<string, unknown>).format).toBeUndefined();
			expect(bodies[1].client_metadata).toEqual(bodies[0].client_metadata);
			expect(bodies[1].prompt_cache_key).toBe(bodies[0].prompt_cache_key);
			expect(headers[1].get("x-codex-turn-state")).toBe("schema-retry-route");
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
