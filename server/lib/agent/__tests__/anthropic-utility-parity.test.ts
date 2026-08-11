/**
 * The one-shot utility paths (generateWithMeta / generateWithHistoryWithMeta)
 * back auxiliary features such as title generation. Captured CLI traffic shows
 * the real client sends its full
 * fingerprint on these auxiliary calls, identical to the chat path. These
 * paths used to hand-roll a stripped-down header set, so a relay that
 * fingerprints request shape saw a different client here than in a real
 * session. Lock the emitted shape so the two cannot drift apart again.
 */
import { describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../anthropic-provider";

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/**
 * Drive a provider method with fetch stubbed out, returning the request it
 * tried to send. A minimal non-streaming SSE body is enough for the response
 * parser to resolve.
 */
async function capture(
	official: boolean,
	run: (p: AnthropicProvider) => Promise<unknown>,
): Promise<Captured> {
	const provider = new AnthropicProvider({
		name: "test",
		prefix: "anthropic",
		apiKey: "sk-test-key",
		officialApi: official,
		baseUrl: "https://api.anthropic.com/v1",
		// biome-ignore lint/suspicious/noExplicitAny: test config subset
	} as any);

	let captured: Captured | undefined;
	const sse = [
		'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
		'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
		'event: message_stop\ndata: {"type":"message_stop"}\n\n',
	].join("");

	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		// The outbound fetch layer normalizes headers into a Headers instance,
		// so plain-object enumeration is not enough here.
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

const genMeta = (p: AnthropicProvider) =>
	p.generateWithMeta("hello", "anthropic:claude-opus-4-8", "You are a title generator.");
const genHistory = (p: AnthropicProvider) =>
	p.generateWithHistoryWithMeta(
		"You are a title generator.",
		"some content",
		"anthropic:claude-opus-4-8",
	);

describe.each([
	["generateWithMeta", genMeta],
	["generateWithHistoryWithMeta", genHistory],
])("official utility request parity: %s", (_name, run) => {
	test("sends the full Claude Code client fingerprint", async () => {
		const req = await capture(true, run);

		// Full beta flag set, not just the bare claude-code flag.
		const betas = (req.headers["anthropic-beta"] ?? "").split(",");
		expect(betas).toContain("claude-code-20250219");
		expect(betas).toContain("interleaved-thinking-2025-05-14");
		expect(betas).toContain("context-1m-2025-08-07");
		expect(betas.length).toBeGreaterThan(5);

		// Client identity headers the CLI always sends.
		expect(req.headers["x-app"]).toBe("cli");
		expect(req.headers["x-claude-code-session-id"]).toBeTruthy();
		expect(req.headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
		// The CLI mints a UUID per official-API attempt and sends it here too — the
		// side-query path goes through the same `ZGp` header builder as chat.
		expect(req.headers["x-client-request-id"]).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(req.headers["user-agent"]).toContain("claude-cli/");

		// Stainless SDK headers.
		expect(req.headers["x-stainless-lang"]).toBe("js");
		expect(req.headers["x-stainless-runtime"]).toBe("node");
		expect(req.headers["x-stainless-package-version"]).toBeTruthy();

		// Official API is addressed via the beta query path.
		expect(req.url).toContain("/messages?beta=true");
	});

	test("sends the stable 3-block system prefix", async () => {
		const req = await capture(true, run);
		const system = req.body.system as Array<Record<string, unknown>>;

		expect(system).toHaveLength(3);
		expect(system[0].text as string).toContain("x-anthropic-billing-header:");
		expect(system[0].text as string).toContain("cc_entrypoint=cli");
		expect(system[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
		expect(system[2].text).toBe("You are a title generator.");
	});

	test("sends no cache breakpoints, matching the CLI", async () => {
		const req = await capture(true, run);
		const system = req.body.system as Array<Record<string, unknown>>;

		// Captured CLI utility requests carry zero breakpoints: these prompts are
		// short-lived and vary per call, so a breakpoint would only pay the
		// cache-write cost without ever producing a read.
		for (const block of system) {
			expect(block.cache_control).toBeUndefined();
		}
	});

	test("sends attribution metadata", async () => {
		const req = await capture(true, run);
		const metadata = req.body.metadata as Record<string, string>;
		const userId = JSON.parse(metadata.user_id) as Record<string, string>;

		expect(userId.device_id).toBeTruthy();
		expect(userId.session_id).toBeTruthy();
		expect(userId).toHaveProperty("account_uuid");
	});

	test("proxy mode stays lean and unfingerprinted", async () => {
		const req = await capture(false, run);

		expect(req.headers["x-api-key"]).toBe("sk-test-key");
		expect(req.headers.authorization).toBeUndefined();
		expect(req.headers["x-app"]).toBeUndefined();
		expect(req.headers["x-claude-code-session-id"]).toBeUndefined();
		expect(req.headers["x-stainless-lang"]).toBeUndefined();
		expect(req.url).not.toContain("beta=true");

		// No billing/identity prefix or attribution leaked to third-party relays.
		const system = req.body.system as Array<Record<string, unknown>> | undefined;
		expect(system).toHaveLength(1);
		expect(system?.[0].text).toBe("You are a title generator.");
		expect(req.body.metadata).toBeUndefined();
	});
});
