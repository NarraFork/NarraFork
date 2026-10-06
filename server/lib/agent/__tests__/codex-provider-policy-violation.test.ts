/**
 * Built-in Codex provider must treat upstream policy violations (cyber_policy)
 * as content verdicts, not credential-health signals:
 *
 *  - a streamed `response.failed` with error.code=cyber_policy flows through as
 *    an invalidState event and must NOT be counted as a credential success;
 *  - a non-streaming 400 with the same code is thrown, and must NOT be counted
 *    as a credential failure (which would eventually disable a healthy account
 *    as too_many_failures) and must NOT rotate to the next credential.
 *
 * Replaying a violating prompt across the account pool is how upstream bans
 * propagate, so these guards are the load-bearing part of the capture.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CodexProvider } from "../codex-provider";
import type { ChatParams } from "../provider";

interface FakeContext {
	id: string;
	token: string;
	authorization: string;
	credential: { accountId: string; disabled: boolean; expiresAt: number; authMode: string };
}

function fakeContext(): FakeContext {
	return {
		id: "cred-1",
		token: "tok-1",
		authorization: "Bearer tok-1",
		credential: {
			accountId: "acc-1",
			disabled: false,
			expiresAt: Date.now() + 3_600_000,
			authMode: "oauth",
		},
	};
}

interface ManagerCalls {
	success: string[];
	failure: string[];
	quota: string[];
}

/** Stub the CodexManager surface CodexProvider touches; returns a restore fn. */
function stubManager(
	provider: CodexProvider,
	ctx: FakeContext,
): { calls: ManagerCalls; restore: () => void } {
	const manager = (provider as unknown as { manager: Record<string, unknown> }).manager;
	const calls: ManagerCalls = { success: [], failure: [], quota: [] };
	const originals: Record<string, unknown> = {};
	const stubs: Record<string, unknown> = {
		acquireContext: async () => ctx,
		refreshUsageOnUseIfNeeded: async () => {},
		snapshot: () => ({ available: 1, entries: [] }),
		reportSuccess: (id: string) => {
			calls.success.push(id);
		},
		reportFailure: (id: string) => {
			calls.failure.push(id);
			return false;
		},
		reportQuotaExhaustedAndRefreshUsage: async (id: string) => {
			calls.quota.push(id);
			return false;
		},
	};
	for (const [key, value] of Object.entries(stubs)) {
		originals[key] = manager[key];
		manager[key] = value;
	}
	return {
		calls,
		restore: () => {
			for (const [key, value] of Object.entries(originals)) manager[key] = value;
		},
	};
}

function makeChatParams(): ChatParams {
	return {
		conversationId: "conv-policy",
		content: "hello",
		model: "codex:gpt-5.5",
		cwd: process.cwd(),
		history: [],
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
		reasoningEffort: "high",
	};
}

const CYBER_FAILED_SSE =
	'data: {"type":"response.failed","response":{"id":"resp-1","status":"failed",' +
	'"error":{"code":"cyber_policy","message":"Request blocked by cyber safety policy"}}}\n\n';

const CYBER_400_BODY = JSON.stringify({
	error: { code: "cyber_policy", message: "Request blocked by cyber safety policy" },
});

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("CodexProvider policy-violation capture", () => {
	test("streamed cyber_policy response.failed yields invalidState without touching credential health", async () => {
		const provider = new CodexProvider({ useWebSocket: false });
		const ctx = fakeContext();
		const { calls, restore } = stubManager(provider, ctx);
		globalThis.fetch = (async () =>
			new Response(CYBER_FAILED_SSE, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
				// biome-ignore lint/suspicious/noExplicitAny: fetch stub
			})) as any;

		try {
			const events = [];
			for await (const event of provider.chat(makeChatParams())) {
				events.push(event);
			}
			// The violation reaches the loop with its machine code intact…
			expect(events.some((e) => e.invalidState?.reason === "cyber_policy")).toBe(true);
			// …and the credential pool heard nothing about it: no false "success",
			// no penalizing failure, no quota rotation.
			expect(calls.success).toHaveLength(0);
			expect(calls.failure).toHaveLength(0);
			expect(calls.quota).toHaveLength(0);
		} finally {
			restore();
		}
	});

	test("non-streaming cyber_policy 400 throws without reportFailure or failover", async () => {
		const provider = new CodexProvider({ useWebSocket: false });
		const ctx = fakeContext();
		const { calls, restore } = stubManager(provider, ctx);
		globalThis.fetch = (async () =>
			new Response(CYBER_400_BODY, {
				status: 400,
				headers: { "content-type": "application/json" },
				// biome-ignore lint/suspicious/noExplicitAny: fetch stub
			})) as any;

		try {
			let thrown: unknown;
			try {
				for await (const _event of provider.chat(makeChatParams())) {
					// drain
				}
			} catch (err) {
				thrown = err;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect(String((thrown as Error).message)).toContain("cyber safety policy");
			// Healthy credential must not accumulate a failure for a content verdict,
			// and the single-credential pool must not be rotated through.
			expect(calls.failure).toHaveLength(0);
			expect(calls.success).toHaveLength(0);
			expect(calls.quota).toHaveLength(0);
		} finally {
			restore();
		}
	});

	test("ordinary upstream 500 still reports a failure (guard does not overreach)", async () => {
		const provider = new CodexProvider({ useWebSocket: false });
		const ctx = fakeContext();
		const { calls, restore } = stubManager(provider, ctx);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: { code: "server_error", message: "boom" } }), {
				status: 500,
				headers: { "content-type": "application/json" },
				// biome-ignore lint/suspicious/noExplicitAny: fetch stub
			})) as any;

		try {
			let thrown: unknown;
			try {
				for await (const _event of provider.chat(makeChatParams())) {
					// drain
				}
			} catch (err) {
				thrown = err;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect(calls.failure).toEqual(["cred-1"]);
		} finally {
			restore();
		}
	});
});
