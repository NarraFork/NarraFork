import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AnthropicProvider } from "../../lib/agent/anthropic-provider";
import { agentLoop } from "../../lib/agent/loop";
import { type DbMessage, registerExternalProviderResolver } from "../../lib/agent/provider";
import type { AgentConfig, AgentEvent } from "../../lib/agent/types";
import type { EventHandlerContext } from "../narrator-event-handler";
import { executeAgentLoop } from "../narrator-executor";

// Mock the two dependency modules BEFORE importing the unit under test so the
// module-level `import { ... } from "./narrator-session"` in narrator-recovery
// binds to these controllable stubs. Bun's mock.module is process-global, so
// afterAll re-points them back to the real implementations to avoid leaking
// into later-loaded suites.
const realNarratorService = { ...(await import("../narrator-service")) };
const realNarratorSession = { ...(await import("../narrator-session")) };

let latestCompactSeqQueue: Array<number | null>;
let markCompactAsBlockingCalls: number;
let awaitCompactCompletionCalls: number;
let runCustomCompactCalls: number;
let awaitCompactImpl: (narratorId: string, signal?: AbortSignal) => Promise<void>;
let runCustomCompactImpl: () => Promise<boolean>;
let compactBoundaryImpl: () => Promise<string | null>;

function nextLatestCompactSeq(): number | null {
	// Return the head of the queue, keeping the last value sticky for repeated reads.
	return latestCompactSeqQueue.length > 1
		? (latestCompactSeqQueue.shift() ?? null)
		: (latestCompactSeqQueue[0] ?? null);
}

mock.module("../narrator-service", () => ({
	...realNarratorService,
	narratorService: {
		...realNarratorService.narratorService,
		getLatestCompactSeq: mock(async () => nextLatestCompactSeq()),
		getCompactBoundaryMessage: mock(async () => compactBoundaryImpl()),
		getEmergencyCompactBoundaryMessage: mock(async () => null),
	},
}));

mock.module("../narrator-session", () => ({
	...realNarratorSession,
	awaitCompactCompletion: mock((narratorId: string, signal?: AbortSignal) => {
		awaitCompactCompletionCalls++;
		return awaitCompactImpl(narratorId, signal);
	}),
	markCompactAsBlocking: mock(async () => {
		markCompactAsBlockingCalls++;
	}),
	runCustomCompact: mock(() => {
		runCustomCompactCalls++;
		return runCustomCompactImpl();
	}),
}));

const {
	handleContextOverflow,
	MAX_CONTEXT_OVERFLOW_RETRIES,
	resetContextOverflowRetriesAfterProgress,
} = await import("../narrator-recovery");
const originalFetch = globalThis.fetch;
const overflowProvider = new AnthropicProvider({
	id: "overflowfixture",
	name: "Overflow fixture",
	prefix: "overflowfixture",
	apiKey: "test-key",
	baseUrl: "https://example.com/v1",
	defaultModel: "claude-test",
});
const unregisterProvider = registerExternalProviderResolver({
	resolve: (name) => (name === "overflowfixture" ? overflowProvider : null),
	listReadiness: () => [],
});
const { compactLocks } = await import("../narrator-session-state");

const NARRATOR_ID = "n-overflow";

function seedInflightBackgroundCompact(compacted: boolean) {
	compactLocks.set(NARRATOR_ID, {
		kind: "history",
		mode: "background",
		promise: Promise.resolve({ kind: "history", compacted, mode: "background" }),
	} as never);
}

beforeEach(() => {
	latestCompactSeqQueue = [null];
	markCompactAsBlockingCalls = 0;
	awaitCompactCompletionCalls = 0;
	runCustomCompactCalls = 0;
	awaitCompactImpl = async () => {};
	runCustomCompactImpl = async () => true;
	compactBoundaryImpl = async () => "boundary-msg";
	compactLocks.clear();
});

afterEach(() => {
	compactLocks.clear();
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	unregisterProvider();
	globalThis.fetch = originalFetch;
	mock.module("../narrator-service", () => realNarratorService);
	mock.module("../narrator-session", () => realNarratorSession);
	mock.restore();
});

function overflowResponse(transport: "http" | "sse"): Response {
	const error = {
		type: "error",
		error: { type: "api_error", message: "opaque overflow failure" },
		diagnostics: { code: "context_length_exceeded" },
	};
	return transport === "http"
		? new Response(JSON.stringify(error), { status: 400 })
		: new Response(`event: error\ndata: ${JSON.stringify(error)}\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
}

function recoveredResponse(): Response {
	const events = [
		[
			"message_start",
			{ type: "message_start", message: { id: "recovered", usage: { input_tokens: 1 } } },
		],
		[
			"content_block_start",
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		],
		[
			"content_block_delta",
			{
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "recovered answer" },
			},
		],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		],
		["message_stop", { type: "message_stop" }],
	];
	return new Response(
		events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function historyRow(id: string, role: DbMessage["role"], text: string): DbMessage {
	return {
		id,
		role,
		contentText: text,
		contentJson: [{ type: "text", text }],
		parentToolUseId: null,
		messageUuid: null,
	};
}

/** Real provider -> loop -> executor -> recovery; only compact and persistence are fixtures. */
function recoveryFixture(transport: "http" | "sse", controller = new AbortController()) {
	const latestInput = historyRow("latest", "user", "unique latest input");
	const settledTool: DbMessage = {
		...historyRow("settled-tool", "assistant", ""),
		contentJson: [
			{ type: "tool_use", id: "already-ran", name: "Read", input: { file_path: "/fixture/file" } },
		],
		toolCalls: [
			{
				toolUseId: "already-ran",
				toolName: "Read",
				inputJson: { file_path: "/fixture/file" },
				outputJson: "settled tool output",
				status: "success",
			},
		],
	};
	let rows = [
		historyRow("old", "user", "oversized old history"),
		historyRow("old-answer", "assistant", "old answer"),
		latestInput,
		settledTool,
	];
	const config: AgentConfig = {
		narratorId: NARRATOR_ID,
		conversationId: "stable-conversation",
		model: "overflowfixture:claude-test",
		provider: "overflowfixture",
		cwd: "/tmp",
		signal: controller.signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		toolFilter: () => false,
		maxTransientRetries: 0,
	};
	const requests: Array<{ messages: unknown[] }> = [];
	const events: AgentEvent[] = [];
	let respond: () => Response = () => overflowResponse(transport);
	globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], options?: RequestInit) => {
		requests.push(JSON.parse(String(options?.body)));
		return respond();
	}) as unknown as typeof fetch;
	const pass = () => {
		const passConfig = { ...config };
		return executeAgentLoop(
			{
				config: passConfig,
				userText: "",
				history: { rows },
				eventContext: {} as EventHandlerContext,
			},
			{
				eventSource: agentLoop(passConfig, "", { rows }),
				processEventFn: async (event) => {
					events.push(event);
					return null;
				},
			},
		);
	};
	const recover = (overflowRetries: number) =>
		handleContextOverflow({
			narratorId: NARRATOR_ID,
			locale: "en",
			provider: "overflowfixture",
			model: config.model,
			overflowRetries,
			maxRetries: MAX_CONTEXT_OVERFLOW_RETRIES,
			baselineCompactSeq: -1,
			signal: controller.signal,
		});
	return {
		requests,
		events,
		controller,
		pass,
		recover,
		compact() {
			rows = [historyRow("summary", "sys", "compact summary"), latestInput, settledTool];
		},
		succeed() {
			respond = recoveredResponse;
		},
	};
}

describe("real loop/executor overflow recovery", () => {
	test.each([
		"http",
		"sse",
	] as const)("%s compact succeeds before rebuilding a request with exactly one latest input", async (transport) => {
		const h = recoveryFixture(transport);
		runCustomCompactImpl = async () => {
			h.compact();
			h.succeed();
			return true;
		};
		const failed = await h.pass();
		expect(failed.contextLengthExceeded).toBe(true);
		expect(failed.completedAssistantTurn).toBe(false);
		expect(failed.retryableError).toBeUndefined();
		const recovery = await h.recover(0);
		expect(recovery).toEqual({ action: "retry_compacted", overflowRetries: 1 });
		const retried = await h.pass();
		expect(retried).toMatchObject({
			completedNaturally: true,
			completedAssistantTurn: true,
			finalText: "recovered answer",
			hasError: false,
		});
		expect(h.requests).toHaveLength(2);
		expect(JSON.stringify(h.requests[0].messages)).toContain("oversized old history");
		const rebuilt = JSON.stringify(h.requests[1].messages);
		expect(rebuilt).toContain("compact summary");
		expect(rebuilt).not.toContain("oversized old history");
		expect(rebuilt.split("unique latest input")).toHaveLength(2);
		expect(rebuilt.split("settled tool output")).toHaveLength(2);
		expect(
			h.events.some((event) => event.type === "tool_executing" || event.type === "tool_result"),
		).toBe(false);
		expect(h.events.some((event) => event.type === "retrying" || event.type === "tool_call")).toBe(
			false,
		);
		expect(runCustomCompactCalls).toBe(1);
		expect(resetContextOverflowRetriesAfterProgress(1, failed.completedAssistantTurn)).toBe(1);
		expect(resetContextOverflowRetriesAfterProgress(1, retried.completedAssistantTurn)).toBe(0);
	});

	test.each([
		"noop",
		"failure",
	] as const)("%s compact stops without another provider request", async (mode) => {
		const h = recoveryFixture("sse");
		runCustomCompactImpl = async () => {
			if (mode === "failure") throw new Error("summary failed");
			return false;
		};
		expect((await h.pass()).contextLengthExceeded).toBe(true);
		const recovery = await h.recover(0);
		expect(recovery).toEqual({
			action: "failed",
			overflowRetries: 1,
			reason: mode === "noop" ? "compact_noop" : "compact_failed",
		});
		expect(h.requests).toHaveLength(1);
		expect(runCustomCompactCalls).toBe(1);
	});

	test("repeated overflow is bounded at two active compacts without completed assistant progress", async () => {
		const h = recoveryFixture("http");
		runCustomCompactImpl = async () => {
			h.compact();
			return true;
		};
		let retries = 0;
		for (let attempt = 0; attempt < 3; attempt++) {
			const result = await h.pass();
			expect(result.contextLengthExceeded).toBe(true);
			retries = resetContextOverflowRetriesAfterProgress(retries, result.completedAssistantTurn);
			const recovery = await h.recover(retries);
			retries = recovery.overflowRetries;
			expect(recovery.action).toBe(attempt < 2 ? "retry_compacted" : "failed");
			if (recovery.action === "failed") expect(recovery.reason).toBe("max_retries_exceeded");
		}
		expect(h.requests).toHaveLength(3);
		expect(runCustomCompactCalls).toBe(2);
	});

	test.each([
		"before_recovery",
		"inflight",
		"boundary",
		"compact",
	] as const)("cancelled at %s never authorizes retry or starts a subsequent compact", async (phase) => {
		const h = recoveryFixture("sse");
		expect((await h.pass()).contextLengthExceeded).toBe(true);
		if (phase === "before_recovery") h.controller.abort();
		if (phase === "inflight") {
			seedInflightBackgroundCompact(true);
			awaitCompactImpl = async () => {
				h.controller.abort();
			};
		}
		if (phase === "boundary")
			compactBoundaryImpl = async () => {
				h.controller.abort();
				return "boundary-msg";
			};
		if (phase === "compact")
			runCustomCompactImpl = async () => {
				h.controller.abort();
				return true;
			};
		const recovery = await h.recover(0);
		expect(recovery.action).toBe("failed");
		expect(runCustomCompactCalls).toBe(phase === "compact" ? 1 : 0);
		expect(h.requests).toHaveLength(1);
	});
});

describe("handleContextOverflow — wait for in-flight compact before spending retry quota", () => {
	test("waits for an in-flight background compact even when the retry quota is already exhausted", async () => {
		// The failed request built history at seq -1 (baseline). A background compact
		// is in flight and will land seq 5 by the time we re-check.
		seedInflightBackgroundCompact(true);
		// getLatestCompactSeq: first read (Phase A pre-wait) sees stale -1/null,
		// the post-wait read sees the completed compact at seq 5.
		latestCompactSeqQueue = [null, 5];

		const result = await handleContextOverflow({
			narratorId: NARRATOR_ID,
			locale: "en",
			provider: "anthropic",
			model: "test-model",
			// Already at the ceiling — the OLD code would immediately fail here.
			overflowRetries: 2,
			maxRetries: 2,
			baselineCompactSeq: -1,
		});

		expect(result.action).toBe("retry_compacted");
		// Waiting for a compact must NOT consume the retry quota.
		expect(result.overflowRetries).toBe(2);
		expect(markCompactAsBlockingCalls).toBe(1);
		expect(awaitCompactCompletionCalls).toBe(1);
		// No fresh emergency compact should have been started.
		expect(runCustomCompactCalls).toBe(0);
	});

	test("a compact that already completed (seq advanced) retries without spending quota", async () => {
		// No in-flight lock, but the latest compact seq is already ahead of baseline.
		latestCompactSeqQueue = [7];

		const result = await handleContextOverflow({
			narratorId: NARRATOR_ID,
			locale: "en",
			provider: "anthropic",
			model: "test-model",
			overflowRetries: 2,
			maxRetries: 2,
			baselineCompactSeq: -1,
		});

		expect(result.action).toBe("retry_compacted");
		expect(result.overflowRetries).toBe(2);
		expect(awaitCompactCompletionCalls).toBe(0);
		expect(runCustomCompactCalls).toBe(0);
	});

	test("fails with max_retries_exceeded only when there is no compact to ride on", async () => {
		// No in-flight compact, seq never advances past baseline.
		latestCompactSeqQueue = [null];

		const result = await handleContextOverflow({
			narratorId: NARRATOR_ID,
			locale: "en",
			provider: "anthropic",
			model: "test-model",
			overflowRetries: 2,
			maxRetries: 2,
			baselineCompactSeq: -1,
		});

		expect(result).toEqual({
			action: "failed",
			overflowRetries: 3,
			reason: "max_retries_exceeded",
		});
		// Phase B was reached but immediately tripped the quota — no compact started.
		expect(runCustomCompactCalls).toBe(0);
	});

	test.each([
		"anthropic",
		"codex",
	])("%s starts emergency compact on the first overflow", async (provider) => {
		latestCompactSeqQueue = [null];
		runCustomCompactImpl = async () => true;

		const result = await handleContextOverflow({
			narratorId: NARRATOR_ID,
			locale: "en",
			provider,
			model: "test-model",
			overflowRetries: 0,
			maxRetries: 2,
			baselineCompactSeq: -1,
		});

		expect(result.action).toBe("retry_compacted");
		// A real recovery attempt consumes one unit of quota.
		expect(result.overflowRetries).toBe(1);
		expect(runCustomCompactCalls).toBe(1);
	});

	test("an aborted in-flight compact wait does not fail as compact_noop and reports the interrupt", async () => {
		seedInflightBackgroundCompact(false);
		latestCompactSeqQueue = [null, null];
		const controller = new AbortController();
		// Simulate the wait being interrupted by a user/parent abort.
		awaitCompactImpl = async (_id, signal) => {
			controller.abort();
			const err = new Error("aborted");
			err.name = "AbortError";
			// Reflect the aborted signal the caller passed in.
			void signal;
			throw err;
		};

		const result = await handleContextOverflow({
			narratorId: NARRATOR_ID,
			locale: "en",
			provider: "anthropic",
			model: "test-model",
			overflowRetries: 0,
			maxRetries: 2,
			baselineCompactSeq: -1,
			signal: controller.signal,
		});

		// Interrupted wait is surfaced without starting a fresh emergency compact.
		expect(result.action).toBe("failed");
		expect(runCustomCompactCalls).toBe(0);
	});
});
