import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { agentLoop } from "../loop";
import {
	type ChatParams,
	type ParsedStreamEvent,
	type ProviderAdapter,
	registerExternalProviderResolver,
} from "../provider";
import { captureResponseStream } from "../request-dump";
import {
	describeFirstTokenTimeout,
	describeStreamIdleTimeout,
	StreamProgress,
} from "../stream-progress";
import type { AgentConfig, AgentEvent } from "../types";

const encode = (text: string) => new TextEncoder().encode(text);

describe("StreamProgress", () => {
	test("classifies each stall phase in order", () => {
		const progress = new StreamProgress();
		expect(progress.stallPhase()).toBeUndefined();
		progress.beginAttempt();
		expect(progress.stallPhase()).toBe("no_response_headers");
		progress.onHeaders(200);
		expect(progress.stallPhase()).toBe("headers_only");
		progress.onBytes(encode(":\n\n: ping\r\n\r\n"));
		expect(progress.stallPhase()).toBe("heartbeat_only");
		expect(progress.snapshot()).toMatchObject({ heartbeats: 2, dataLines: 0, statusCode: 200 });
		progress.onBytes(encode('data: {"broken'));
		expect(progress.stallPhase()).toBe("unparsed_data");
	});

	test("classifies lines split across chunk boundaries", () => {
		const progress = new StreamProgress();
		progress.beginAttempt();
		progress.onHeaders(200);
		for (const chunk of [": keep", "-alive\r", "\n\r\n:", "\n\nda", "ta: {}\n\n"]) {
			progress.onBytes(encode(chunk));
		}
		expect(progress.snapshot()).toMatchObject({ heartbeats: 2, dataLines: 1 });
	});

	test("beginAttempt resets per HTTP attempt and markEvent measures the gap", () => {
		const progress = new StreamProgress();
		progress.beginAttempt();
		progress.onHeaders(500);
		progress.onBytes(encode("data: x\n\n"));
		progress.beginAttempt();
		expect(progress.snapshot()).toMatchObject({ bytes: 0, heartbeats: 0, dataLines: 0 });
		expect(progress.snapshot().statusCode).toBeUndefined();
		progress.onHeaders(200);
		progress.onBytes(encode("data: x\n\n"));
		progress.markEvent();
		progress.onBytes(encode(":\n\n:\n\n"));
		expect(progress.snapshot()).toMatchObject({ heartbeatsSinceEvent: 2, bytesSinceEvent: 6 });
	});

	test("timeout messages name the stalled phase and keep the classifier prefix", () => {
		const progress = new StreamProgress();
		expect(describeFirstTokenTimeout("p", 120_000, undefined)).toBe(
			"p: First token timeout after 120s without upstream activity",
		);
		progress.beginAttempt();
		expect(describeFirstTokenTimeout("p", 120_000, progress)).toBe(
			"p: First token timeout after 120s: no response headers received",
		);
		progress.onHeaders(200);
		expect(describeFirstTokenTimeout("p", 120_000, progress)).toBe(
			"p: First token timeout after 120s: response headers received (HTTP 200) but no response body",
		);
		progress.onBytes(encode(":\n\n:\n\n"));
		expect(describeFirstTokenTimeout("p", 120_000, progress)).toBe(
			"p: First token timeout after 120s: received 2 keep-alive heartbeat(s) but no model event",
		);
		progress.markEvent();
		expect(describeStreamIdleTimeout("p", 600_000, progress)).toBe(
			"p: Stream idle timeout after 600s without a parsed stream event (no data received)",
		);
		progress.onBytes(encode(":\n\n"));
		expect(describeStreamIdleTimeout("p", 600_000, progress)).toBe(
			"p: Stream idle timeout after 600s without a parsed stream event (1 keep-alive heartbeat(s), 3 bytes received)",
		);
	});

	test("captureResponseStream feeds progress without a dump collector", async () => {
		const progress = new StreamProgress();
		progress.beginAttempt();
		const source = new Response(":\n\ndata: {}\n\n").body as ReadableStream<Uint8Array>;
		const tap = captureResponseStream(source, undefined, progress);
		expect(tap.stream).not.toBe(source);
		expect(await new Response(tap.stream).text()).toBe(":\n\ndata: {}\n\n");
		expect(progress.snapshot()).toMatchObject({ bytes: 13, heartbeats: 1, dataLines: 1 });
	});
});

let chat: (params: ChatParams) => AsyncGenerator<ParsedStreamEvent> = async function* () {
	yield { text: "done" };
};
const adapter: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async () => ({ history: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		yield* chat(params);
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const unregister = registerExternalProviderResolver({
	resolve: (name) => (name === "progressfixture" ? adapter : null),
	listReadiness: () => [],
});
afterAll(() => unregister());
beforeEach(() => {
	chat = async function* () {
		yield { text: "done" };
	};
});

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: "stream-progress",
		conversationId: "stream-progress-conversation",
		model: "progressfixture:m",
		provider: "progressfixture",
		cwd: process.env.HOME as string,
		signal: new AbortController().signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		toolFilter: () => false,
		maxTransientRetries: 0,
		retryBackoffCeilMs: 0,
		firstTokenTimeoutMs: 50,
		...overrides,
	};
}

async function drain(input: AgentConfig): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(input, "fixture input", { rows: [] })) events.push(event);
	return events;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

describe("agent loop first-activity timeout with transport progress", () => {
	test("heartbeat-only responses still time out and report the phase", async () => {
		chat = async function* (params) {
			params.onRequestStart?.();
			params.streamProgress?.beginAttempt();
			params.streamProgress?.onHeaders(200);
			const timer = setInterval(() => params.streamProgress?.onBytes(encode(":\n\n")), 5);
			try {
				await waitForAbort(params.signal);
			} finally {
				clearInterval(timer);
			}
			throw new Error("aborted fixture");
		};
		const events = await drain(config());
		const terminal = events.at(-1);
		if (terminal?.type !== "retryable_error") throw new Error("missing retryable error");
		expect(terminal.message).toMatch(
			/^progressfixture: First token timeout after 0s: received \d+ keep-alive heartbeat\(s\) but no model event$/,
		);
		expect(terminal.diagnostics?.cause).toBe("heartbeat_only");
		expect(terminal.diagnostics?.statusCode).toBe(200);
	});

	test("missing response headers are reported as such", async () => {
		chat = async function* (params) {
			params.onRequestStart?.();
			params.streamProgress?.beginAttempt();
			await waitForAbort(params.signal);
			if (params.signal.aborted) throw new Error("aborted fixture");
			yield { text: "unreachable" };
		};
		const events = await drain(config());
		const terminal = events.at(-1);
		if (terminal?.type !== "retryable_error") throw new Error("missing retryable error");
		expect(terminal.message).toBe(
			"progressfixture: First token timeout after 0s: no response headers received",
		);
		expect(terminal.diagnostics?.cause).toBe("no_response_headers");
	});

	test("a non-text provider event still cancels the first-activity timer", async () => {
		chat = async function* (params) {
			params.onRequestStart?.();
			params.streamProgress?.beginAttempt();
			params.streamProgress?.onHeaders(200);
			yield { responseId: "resp_1" } as ParsedStreamEvent;
			await new Promise((resolve) => setTimeout(resolve, 120));
			yield { text: "done" };
		};
		const events = await drain(config());
		expect(events.some((event) => event.type === "retryable_error")).toBe(false);
	});
});
