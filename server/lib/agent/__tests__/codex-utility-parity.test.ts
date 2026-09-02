/**
 * Codex one-shot utility requests such as title generation go through
 * generateWithMeta, which historically passed no
 * conversation id. The Codex emulation headers session-id/thread-id are only
 * emitted when a conversation id exists, and prompt_cache_key is likewise
 * derived from it — so these probes sent a visibly different client shape than
 * a real Codex session. Lock the emitted shape so the paths cannot drift.
 */
import { describe, expect, test } from "bun:test";
import { ORIGINATOR_CODEX } from "../../user-agent";
import { OpenAIProvider } from "../openai-provider";

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
		expect(req.headers["x-codex-installation-id"]).toBeTruthy();
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

	test("sends one correlated conversation identity across headers", async () => {
		const req = await capture(run);

		expect(req.headers["session-id"]).toBeTruthy();
		expect(req.headers["thread-id"]).toBe(req.headers["session-id"]);
	});

	/**
	 * codex-rs writes x-client-request-id in exactly one place —
	 * build_websocket_headers — so the HTTP /responses path (and
	 * /responses/compact) never carries it. Sending it here produced a shape no
	 * real client emits: a non-lite HTTP body with a websocket-only header.
	 */
	test("does not send the websocket-only x-client-request-id over HTTP", async () => {
		const req = await capture(run);

		expect(req.headers["x-client-request-id"]).toBeUndefined();
	});

	test("sets prompt_cache_key to the same id", async () => {
		const req = await capture(run);

		expect(req.body.prompt_cache_key).toBeTruthy();
		expect(req.body.prompt_cache_key).toBe(req.headers["session-id"]);
	});

	test("sends the stable Codex Responses body fields", async () => {
		const req = await capture(run);
		const metadata = req.body.client_metadata as Record<string, string>;

		expect(req.body.tool_choice).toBe("auto");
		// Parallel tool calls stay on outside the responses-lite contract.
		expect(req.body.parallel_tool_calls).toBe(true);
		// No reasoning.context — real non-lite requests omit it (lite-only field).
		expect(req.body.reasoning).toEqual({ effort: "high", summary: "auto" });
		expect(req.body.include).toEqual(["reasoning.encrypted_content"]);
		expect(req.body.text).toEqual({ verbosity: "low" });
		expect(metadata.session_id).toBe(req.headers["session-id"]);
		expect(metadata.thread_id).toBe(req.headers["thread-id"]);
		// The real client uses the hyphenated key here, matching the header name.
		expect(metadata["x-codex-installation-id"]).toBe(req.headers["x-codex-installation-id"]);
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
