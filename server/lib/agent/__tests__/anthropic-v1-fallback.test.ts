import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression tests for AnthropicProvider's `/v1` base-URL fallback (exercised
 * via the public generateWithHistoryWithMeta path).
 *
 * The bug: when the configured base URL lacked `/v1`, ANY failure triggered a
 * retry against `${baseUrl}/v1`, and the retry's response was returned
 * unconditionally — so a correct configured URL that returned a meaningful
 * error (401 with a body) could be masked by a wrong-path 404 or a WAF that
 * drops the `/v1` connection. These tests lock in:
 *   1. original non-ok + fallback ALSO non-ok (not a wrong-path win) → surface
 *      the ORIGINAL endpoint's status + body.
 *   2. original 404 (wrong-path) + fallback 200 → succeed via the fallback.
 *   3. original non-ok + fallback THROWS (connection dropped) → surface the
 *      ORIGINAL endpoint's error, not the transport failure.
 */

interface TestProvider {
	generateWithHistoryWithMeta(
		systemInstruction: string,
		content: string,
		model: string,
	): Promise<{ text: string }>;
}

let AnthropicProvider: new (config: Record<string, unknown>) => TestProvider;
let testHome = "";
let originalNarraforkHome: string | undefined;
let setOutboundFetchOverrideForTest: (
	override: ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | null,
) => void;

beforeAll(async () => {
	// Importing anthropic-provider transitively initialises the DB layer, which
	// resolves its data dir from NARRAFORK_HOME (NOT process.env.HOME — node's
	// os.homedir() reads the system passwd entry, so overriding HOME would not
	// isolate it). Point it at a fresh temp dir so the test uses its own empty
	// SQLite file instead of contending for the real ~/.narrafork instance lock
	// (which also skips the multi-second startup integrity check on a real DB).
	originalNarraforkHome = process.env.NARRAFORK_HOME;
	testHome = mkdtempSync(join(tmpdir(), "narrafork-anthropic-v1fallback-"));
	process.env.NARRAFORK_HOME = testHome;
	const [mod, outboundFetchMod] = await Promise.all([
		import("../anthropic-provider"),
		import("../../net/outbound-fetch"),
	]);
	setOutboundFetchOverrideForTest = outboundFetchMod.setOutboundFetchOverrideForTest;
	AnthropicProvider = mod.AnthropicProvider as unknown as new (
		config: Record<string, unknown>,
	) => TestProvider;
});

afterEach(() => {
	setOutboundFetchOverrideForTest(null);
});

afterAll(() => {
	setOutboundFetchOverrideForTest(null);
	if (originalNarraforkHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = originalNarraforkHome;
	if (testHome) rmSync(testHome, { recursive: true, force: true });
});

/** Unique base URL per test to avoid the process-wide v1FallbackCache leaking. */
function makeProvider(host: string): TestProvider {
	return new AnthropicProvider({
		id: `p-${host}`,
		name: host,
		prefix: host,
		// No /v1 suffix → fallback is eligible.
		baseUrl: `https://${host}.example.com/relay`,
		apiKey: "sk-test",
		officialApi: false,
	});
}

describe("AnthropicProvider /v1 fallback error surfacing", () => {
	test("surfaces the ORIGINAL 401 when the /v1 fallback only 404s", async () => {
		const base = "https://a1.example.com/relay";
		setOutboundFetchOverrideForTest(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === `${base}/messages`) {
				return new Response('{"error":"invalid api key"}', {
					status: 401,
					headers: { "content-type": "application/json" },
				});
			}
			// /v1 fallback path is the wrong path here.
			return new Response("no such route", { status: 404 });
		});

		const provider = makeProvider("a1");
		let thrown: { status?: number; message?: string } | undefined;
		try {
			await provider.generateWithHistoryWithMeta("sys", "hi", "anthropic:claude-3");
		} catch (err) {
			thrown = err as { status?: number; message?: string };
		}
		expect(thrown).toBeDefined();
		// The real, user-controllable error (401) must be surfaced, NOT the 404.
		expect(thrown?.status).toBe(401);
		expect(thrown?.message).toContain("401");
		expect(thrown?.message).toContain("invalid api key");
	});

	test("uses the /v1 fallback when the original path is a 404 (wrong path) and /v1 succeeds", async () => {
		const base = "https://a2.example.com/relay";
		setOutboundFetchOverrideForTest(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === `${base}/v1/messages`) {
				return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			// Original path without /v1 is the wrong path.
			return new Response("not found", { status: 404 });
		});

		const provider = makeProvider("a2");
		const result = await provider.generateWithHistoryWithMeta("sys", "hi", "anthropic:claude-3");
		expect(result.text).toBe("ok");
	});

	test("surfaces the ORIGINAL error when the /v1 fallback drops the connection", async () => {
		const base = "https://a3.example.com/relay";
		setOutboundFetchOverrideForTest(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === `${base}/messages`) {
				return new Response('{"error":"rate limited"}', {
					status: 429,
					headers: { "content-type": "application/json" },
				});
			}
			// /v1 fallback trips a WAF that RSTs the connection.
			throw new Error("socket connection was closed unexpectedly");
		});

		const provider = makeProvider("a3");
		let thrown: { status?: number; message?: string } | undefined;
		try {
			await provider.generateWithHistoryWithMeta("sys", "hi", "anthropic:claude-3");
		} catch (err) {
			thrown = err as { status?: number; message?: string };
		}
		expect(thrown).toBeDefined();
		// The real endpoint's 429 must win over the fallback transport failure.
		expect(thrown?.status).toBe(429);
		expect(thrown?.message).toContain("rate limited");
	});
});
