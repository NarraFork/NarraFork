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
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CodexProvider } from "../codex-provider";
import * as websocket from "../codex-websocket";
import { ProviderInvalidStateError } from "../error-handling";
import { OpenAIProvider } from "../openai-provider";
import type { ChatParams, ParsedStreamEvent } from "../provider";
import {
	modelRejectsParameter,
	resetUnsupportedParameterMemory,
} from "../unsupported-parameter-fallback";

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
	recovery: string[];
	usageLookup: string[];
	acquired: number;
}

/** Stub the CodexManager surface CodexProvider touches; returns a restore fn. */
function stubManager(
	provider: CodexProvider,
	ctx: FakeContext,
	available = 1,
): { calls: ManagerCalls; restore: () => void } {
	const manager = (provider as unknown as { manager: Record<string, unknown> }).manager;
	const calls: ManagerCalls = {
		success: [],
		failure: [],
		quota: [],
		recovery: [],
		usageLookup: [],
		acquired: 0,
	};
	const originals: Record<string, unknown> = {};
	const stubs: Record<string, unknown> = {
		acquireContext: async () => {
			calls.acquired++;
			return ctx;
		},
		refreshUsageOnUseIfNeeded: async () => {},
		snapshot: () => ({ available, entries: [] }),
		recoverAgentIdentityTask: async (id: string) => {
			calls.recovery.push(id);
			return true;
		},
		getUsage: async (id: string) => {
			calls.usageLookup.push(id);
		},
		reportSuccess: (id: string) => {
			calls.success.push(id);
		},
		reportFailure: (id: string) => {
			calls.failure.push(id);
			return false;
		},
		reportQuotaExhaustedAndRefreshUsage: async (id: string) => {
			calls.quota.push(id);
			return available > 1;
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

describe("explicit refusal boundary: Codex credentials", () => {
	// Each phrase is actionable in a genuine upstream error, but here it is model output.
	const message = "401 invalid task id; usage_limit_reached; Expected 101 status code";
	const invalidState = { reason: "refusal", message };

	async function collectChat(provider: CodexProvider) {
		const events: ParsedStreamEvent[] = [];
		for await (const event of provider.chat(makeChatParams())) events.push(event);
		return events;
	}

	for (const outcome of ["event", "throw"] as const) {
		test.each([
			"http",
			"ws",
			"expected-101",
			"ws-unavailable",
		] as const)(`%s: ${outcome} does not rotate credentials or recover task identity`, async (route) => {
			const provider = new CodexProvider({ useWebSocket: route !== "http" });
			const ctx = fakeContext();
			ctx.credential.authMode = "agent_identity";
			const { calls, restore } = stubManager(provider, ctx, 2);
			const refusal = new ProviderInvalidStateError(invalidState.reason, message);
			const ws = spyOn(websocket, "streamCodexResponsesWebSocket").mockImplementation(
				async function* () {
					if (route === "expected-101") throw new Error("Expected 101 status code");
					if (route === "ws-unavailable")
						throw new websocket.CodexWebSocketFallbackError("Upgrade unavailable", 426);
					if (outcome === "throw") throw refusal;
					yield { invalidState };
				},
			);
			const http = spyOn(OpenAIProvider.prototype, "chat");
			try {
				if (outcome === "throw") {
					http.mockImplementation(async function* () {
						yield {};
						throw refusal;
					});
				} else {
					const frame = {
						type: "response.failed",
						response: { status: "failed", error: { code: "refusal", message } },
					};
					globalThis.fetch = (async () =>
						new Response(`data: ${JSON.stringify(frame)}\n\n`, {
							headers: { "content-type": "text/event-stream" },
						})) as unknown as typeof fetch;
				}
				if (outcome === "throw") {
					await expect(collectChat(provider)).rejects.toBe(refusal);
				} else {
					const events = await collectChat(provider);
					expect(events.filter((event) => event.invalidState)).toMatchObject([
						{ invalidState, credentialId: ctx.id },
					]);
				}
				expect(ws).toHaveBeenCalledTimes(route === "http" ? 0 : 1);
				expect(http).toHaveBeenCalledTimes(route === "ws" ? 0 : 1);
				expect(calls).toEqual({
					success: [],
					failure: [],
					quota: [],
					recovery: [],
					acquired: 1,
					// A real upgrade failure (but not one quoted by the model) probes usage.
					usageLookup: route === "expected-101" ? [ctx.id] : [],
				});
			} finally {
				http.mockRestore();
				ws.mockRestore();
				restore();
			}
		});
	}

	test.each([
		[400, "Unsupported parameter: prompt_cache_key"],
		[401, "invalid task id"],
		[429, "usage_limit_reached"],
	] as const)("genuine HTTP %i still recovers: %s", async (status, detail) => {
		const provider = new CodexProvider({ useWebSocket: false });
		const ctx = fakeContext();
		ctx.credential.authMode = "agent_identity";
		const { calls, restore } = stubManager(provider, ctx, 2);
		const sent: Record<string, unknown>[] = [];
		const model = makeChatParams().model;
		globalThis.fetch = (async (_input, init) => {
			sent.push(JSON.parse(String(init?.body)));
			return sent.length === 1
				? Response.json({ error: { message: detail } }, { status })
				: Response.json({
						output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }],
					});
		}) as typeof fetch;
		try {
			await expect(provider.generateWithMeta("hello", model)).resolves.toMatchObject({
				text: "ok",
			});
			expect(sent).toHaveLength(2);
			expect(sent[0]?.prompt_cache_key).toBeString();
			expect(Object.hasOwn(sent[1], "prompt_cache_key")).toBe(status !== 400);
			expect(modelRejectsParameter(model, "prompt_cache_key")).toBe(status === 400);
			expect(calls.quota).toEqual(status === 429 ? [ctx.id] : []);
			expect(calls.recovery).toEqual(status === 401 ? [ctx.id] : []);
			expect(calls.acquired).toBe(status === 400 ? 1 : 2);
			expect(calls.success).toEqual([ctx.id]);
		} finally {
			resetUnsupportedParameterMemory();
			restore();
		}
	});

	test("generateWithMeta does not learn parameters, recover identity or report quota from a refusal", async () => {
		const provider = new CodexProvider({ useWebSocket: false });
		const ctx = fakeContext();
		ctx.credential.authMode = "agent_identity";
		const { calls, restore } = stubManager(provider, ctx, 2);
		const model = makeChatParams().model;
		const text = `${message}; Unsupported parameter: prompt_cache_key`;
		const sent: Record<string, unknown>[] = [];
		globalThis.fetch = (async (_input, init) => {
			sent.push(JSON.parse(String(init?.body)));
			return Response.json({ status: "failed", error: { code: "refusal", message: text } });
		}) as typeof fetch;
		try {
			await expect(provider.generateWithMeta("hello", model)).rejects.toMatchObject({
				name: "ProviderInvalidStateError",
				reason: "refusal",
				message: text,
			});
			expect(sent).toHaveLength(1);
			expect(sent[0]?.prompt_cache_key).toBeString();
			expect(modelRejectsParameter(model, "prompt_cache_key")).toBe(false);
			expect(calls).toEqual({
				success: [],
				failure: [],
				quota: [],
				recovery: [],
				usageLookup: [],
				acquired: 1,
			});
		} finally {
			resetUnsupportedParameterMemory();
			restore();
		}
	});
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
