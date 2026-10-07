import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import {
	beginNarratorResponseActivity,
	beginQuiescingTools,
	cancelScheduledUpdate,
	failScheduledUpdate,
	getUpdateCoordinationStatus,
	resetUpdateCoordinationForTests,
	scheduleUpdate,
	waitForUpdateCheckpointFence,
} from "../../../services/update-coordinator";
import type { ProviderAdapter } from "../provider";
import { toolRegistry } from "../tool-registry";
import type { AgentConfig, AgentEvent } from "../types";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
let script: ProviderAdapter["chat"];
let attempts = 0;
let scriptEveryAttempt = false;
let executions = 0;
toolRegistry.register({
	name: "RestartProbe",
	description: "Graceful restart tool probe",
	parameters: z.object({}),
	execute: async () => {
		executions++;
		return { output: "done" };
	},
});
const inputs: string[] = [];
const requestSignals: AbortSignal[] = [];
const provider: ProviderAdapter = {
	formatTools: (tools) => tools,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
	injectSystemPrompt: () => {},
	async *chat(params) {
		attempts++;
		inputs.push(params.content);
		requestSignals.push(params.signal);
		params.onRequestStart?.();
		if (attempts > 1 && !scriptEveryAttempt) {
			yield { text: "resumed answer" };
			return;
		}
		yield* script(params);
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
// Use the isolated schema-built DB; worktrees need not carry ignored migration SQL.
const { getTestDb } = await import("../../../../tests/setup");
const { db, sqlite } = getTestDb();
const dbStub = {
	db,
	sqlite,
	activeDatabaseBackend: "sqlite" as const,
	startupShutdownState: { canSkipVerification: true },
	markDatabaseCleanShutdown: () => true,
	releaseDatabaseInstanceLockOnly: () => {},
};
mock.module("../../../db", () => dbStub);
mock.module("@server/db", () => dbStub);
const realProvider = { ...(await import("../provider")) };
mock.module("../provider", () => ({
	getProvider: () => provider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:model",
		provider: "test",
		adapter: provider,
		model: "test:model",
	}),
}));
const { agentLoop } = await import("../loop");
beforeEach(() => {
	resetUpdateCoordinationForTests();
	attempts = 0;
	executions = 0;
	scriptEveryAttempt = false;
	inputs.length = 0;
	requestSignals.length = 0;
});
afterEach(() => resetUpdateCoordinationForTests());
afterAll(() => {
	toolRegistry.unregister("RestartProbe");
	mock.module("../provider", () => realProvider);
	mock.restore();
});
function run(events: AgentEvent[], consume?: (event: AgentEvent) => void | Promise<void>) {
	const controller = new AbortController();
	const config: AgentConfig = {
		narratorId: "update-reasoning",
		conversationId: "update-reasoning",
		provider: "test",
		model: "test:model",
		cwd: process.cwd(),
		signal: controller.signal,
		permissionHandler: async () => ({ behavior: "allow" }),
	};
	const done = (async () => {
		for await (const event of agentLoop(config, "original input", [])) {
			events.push(event);
			await consume?.(event);
		}
	})();
	return { controller, done };
}
function waitForAbort(signal: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

for (const stage of ["no-first-token", "reasoning", "graceful-reasoning"] as const) {
	test(`restart cuts ${stage} request and cancellation resumes original input`, async () => {
		const waiting = gate();
		const discarded = gate();
		const cleanup = gate();
		script = async function* (params) {
			if (stage !== "no-first-token") {
				yield { reasoning: "discard me", reasoningOutputIndex: 0 };
				yield { contentBoundary: { kind: "reasoning", phase: "complete", outputIndex: 0 } };
			}
			waiting.resolve();
			if (stage === "graceful-reasoning") {
				// Some adapters observe abort by ending the iterator instead of throwing.
				await new Promise<void>((resolve) => {
					if (params.signal.aborted) resolve();
					else params.signal.addEventListener("abort", () => resolve(), { once: true });
				});
				return;
			}
			await waitForAbort(params.signal);
		};
		const events: AgentEvent[] = [];
		const running = run(events, async (event) => {
			if (event.type === "attempt_discarded") {
				discarded.resolve();
				await cleanup.promise;
			}
		});
		await waiting.promise;
		scheduleUpdate("test", "system_shutdown");
		await discarded.promise;
		expect(requestSignals[0]?.aborted).toBe(true);
		expect(running.controller.signal.aborted).toBe(false);
		expect(getUpdateCoordinationStatus().activeResponseCount).toBe(1);
		cleanup.resolve();
		beginQuiescingTools();
		await waitForUpdateCheckpointFence();
		expect(attempts).toBe(1);
		cancelScheduledUpdate();
		failScheduledUpdate("test cancellation", { cancelled: true });
		await running.done;
		expect(inputs).toEqual(["original input", "original input"]);
		expect(events.some((event) => event.type === "error" || event.type === "retrying")).toBe(false);
		expect(events.filter((event) => event.type === "attempt_discarded")).toHaveLength(1);
		expect(
			events.some((event) => event.type === "assistant_message" && event.text === "resumed answer"),
		).toBe(true);
	});
}

for (const stage of ["text", "tool"] as const) {
	test(`${stage} first output protects the request even during trailing reasoning`, async () => {
		const waiting = gate();
		const finish = gate();
		script = async function* () {
			if (stage === "text") yield { text: "keep me" };
			else
				yield { toolUseChunk: { toolUseId: "unfinished", name: "Read", input: '{"file_path":' } };
			yield { reasoning: "trailing reasoning" };
			waiting.resolve();
			await finish.promise;
			yield { text: "safe finish" };
		};
		const events: AgentEvent[] = [];
		const running = run(events);
		await waiting.promise;
		scheduleUpdate();
		beginQuiescingTools();
		expect(requestSignals[0]?.aborted).toBe(false);
		expect(getUpdateCoordinationStatus().activeResponseCount).toBe(1);
		// An unfinished tool chunk is deliberately not completed/executed in this probe.
		if (stage === "tool") running.controller.abort();
		finish.resolve();
		await running.done;
		expect(events.some((event) => event.type === "attempt_discarded")).toBe(false);
		await waitForUpdateCheckpointFence();
	});
}

test("completed text/tool turn transitions to interruptible reasoning without replaying the tool", async () => {
	const waiting = gate();
	const discarded = gate();
	scriptEveryAttempt = true;
	script = async function* (params) {
		if (attempts === 1) {
			yield { text: "completed prefix" };
			yield { toolUses: [{ toolUseId: "probe", name: "RestartProbe", input: {} }] };
			return;
		}
		if (attempts === 2) {
			yield { reasoning: "next reasoning" };
			waiting.resolve();
			await waitForAbort(params.signal);
			return;
		}
		yield { text: "finished" };
	};
	const events: AgentEvent[] = [];
	const running = run(events, (event) => {
		if (event.type === "attempt_discarded") discarded.resolve();
	});
	await waiting.promise;
	expect(executions).toBe(1);
	scheduleUpdate();
	await discarded.promise;
	beginQuiescingTools();
	await waitForUpdateCheckpointFence();
	expect(requestSignals[0]?.aborted).toBe(false);
	expect(requestSignals[1]?.aborted).toBe(true);
	cancelScheduledUpdate();
	failScheduledUpdate("test cancellation", { cancelled: true });
	await running.done;
	expect(executions).toBe(1);
	expect(attempts).toBe(3);
	expect(events.filter((event) => event.type === "tool_result")).toHaveLength(1);
	expect(
		events.some((event) => event.type === "assistant_message" && event.text === "completed prefix"),
	).toBe(true);
});

test("new reasoning requests park during phase one and reflection remains exempt", async () => {
	scheduleUpdate();
	const abort = new AbortController();
	let admitted = false;
	const pending = beginNarratorResponseActivity("next-turn", abort.signal).then((lease) => {
		admitted = true;
		return lease;
	});
	const reflection = await beginNarratorResponseActivity("reflection", undefined, {
		isReflection: true,
	});
	let stopped = false;
	reflection.setReasoningAbort(() => {
		stopped = true;
	});
	expect(stopped).toBe(false);
	expect(admitted).toBe(false);
	expect(getUpdateCoordinationStatus().activeResponseCount).toBe(0);
	cancelScheduledUpdate();
	failScheduledUpdate("test cancellation", { cancelled: true });
	(await pending).release();
	expect(admitted).toBe(true);
});
