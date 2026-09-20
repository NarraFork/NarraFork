import { afterAll, describe, expect, mock, test } from "bun:test";
import { isRequestDumpEnabled, shouldCollectRequestDump } from "../../api-request-tracker";
import { settings } from "../../settings";
import type { ProviderAdapter } from "../provider";
import type { AgentConfig, AgentEvent } from "../types";

/**
 * Dump settings must be live: saving `agent.requestDumpEnabled` affects the next
 * provider request in an already-running process without rebuilding the narrator
 * session. Collection is decided at each attempt start; persist is decided at finish.
 */

/** Whether the last provider.chat() received a dump collector. */
let lastChatHadDump = false;
/** Whether any provider.chat() in the current run received a dump collector. */
let anyChatHadDump = false;
let chatCount = 0;

const testProvider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		chatCount++;
		lastChatHadDump = params.requestDump != null;
		if (params.requestDump) anyChatHadDump = true;
		params.requestDump?.setRequest({
			transport: "http",
			url: "https://example.test/v1/messages",
			body: { hello: "world" },
		});
		params.onRequestStart?.();
		params.requestDump?.setResponseMeta({ status: 200 });
		params.requestDump?.setResponseBodyText('{"ok":true}');
		yield { text: "ok" };
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

const realProviderModule = { ...(await import("../provider")) };

mock.module("../provider", () => ({
	getProvider: () => testProvider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		adapter: testProvider,
		model: "test:model",
	}),
}));

const { agentLoop } = await import("../loop");

afterAll(() => {
	mock.module("../provider", () => realProviderModule);
	mock.restore();
});

function makeConfig(signal: AbortSignal): AgentConfig {
	return {
		narratorId: "n-dump-live",
		conversationId: "conv-dump-live",
		model: "test:model",
		provider: "test",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		retryBackoffCeilMs: 1,
	};
}

async function runLoop(): Promise<AgentEvent[]> {
	const ac = new AbortController();
	const events: AgentEvent[] = [];
	anyChatHadDump = false;
	for await (const event of agentLoop(makeConfig(ac.signal), "go", [])) {
		events.push(event);
	}
	return events;
}

describe("dump 开关实时生效", () => {
	test("helpers read the live settings singleton", () => {
		const prev = settings.agent.requestDumpEnabled;
		try {
			settings.agent.requestDumpEnabled = false;
			expect(isRequestDumpEnabled()).toBe(false);
			expect(shouldCollectRequestDump(false)).toBe(false);
			expect(shouldCollectRequestDump(true)).toBe(true);

			settings.agent.requestDumpEnabled = true;
			expect(isRequestDumpEnabled()).toBe(true);
			expect(shouldCollectRequestDump(false)).toBe(true);
		} finally {
			settings.agent.requestDumpEnabled = prev;
		}
	});

	test("保存后下一次请求即带上 collector，无需重启叙述者", async () => {
		const prevEnabled = settings.agent.requestDumpEnabled;
		const prevErrorsOnly = settings.agent.requestDumpErrorsOnly;
		try {
			// Off: first "session" (next user message after save-to-off) collects nothing.
			settings.agent.requestDumpEnabled = false;
			settings.agent.requestDumpErrorsOnly = false;
			chatCount = 0;
			const offEvents = await runLoop();
			expect(chatCount).toBeGreaterThan(0);
			expect(anyChatHadDump).toBe(false);
			for (const event of offEvents) {
				if (event.type === "api_request_end") {
					expect(event.rawDump).toBeUndefined();
				}
			}

			// Toggle on — simulates settings PATCH updating the singleton mid-process.
			// The next agentLoop invocation is the next user message; no ActiveNarrator
			// rebuild, no process restart.
			settings.agent.requestDumpEnabled = true;
			settings.agent.requestDumpErrorsOnly = false;

			const onEvents = await runLoop();
			expect(anyChatHadDump).toBe(true);
			expect(lastChatHadDump).toBe(true);
			const ends = onEvents.filter((e) => e.type === "api_request_end");
			expect(ends.length).toBeGreaterThan(0);
			for (const end of ends) {
				expect(end.rawDump).toBeDefined();
				const dump = end.rawDump as { request?: { body?: unknown }; response?: unknown };
				expect(dump.request?.body).toEqual({ hello: "world" });
			}

			// Toggle off again: the subsequent request must stop collecting immediately.
			settings.agent.requestDumpEnabled = false;
			const offAgain = await runLoop();
			expect(anyChatHadDump).toBe(false);
			for (const event of offAgain) {
				if (event.type === "api_request_end") {
					expect(event.rawDump).toBeUndefined();
				}
			}
		} finally {
			settings.agent.requestDumpEnabled = prevEnabled;
			settings.agent.requestDumpErrorsOnly = prevErrorsOnly;
		}
	});
});
