import type { AgentConfig, AgentEvent, ToolCallBinding } from "../../lib/agent/types";
import type { EventHandlerContext } from "../narrator-event-handler";
import {
	type ExecuteLoopOptions,
	type ExecuteLoopResult,
	executeAgentLoop,
} from "../narrator-executor";

/** Scenario labels are adapter inputs, not a reimplementation of runtime policy. */
export const runtimeContractScenarios = [
	{ name: "primary", child: false, background: false, takeover: false, readonly: false },
	{ name: "foreground-child", child: true, background: false, takeover: false, readonly: false },
	{ name: "background-child", child: true, background: true, takeover: false, readonly: false },
	{ name: "takeover", child: true, background: false, takeover: true, readonly: false },
	{ name: "custom-readonly", child: true, background: false, takeover: false, readonly: true },
] as const;
export type RuntimeContractScenario = (typeof runtimeContractScenarios)[number];

export function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

/** Local scheduler only: does not replace Date, global timers, or production deadlines. */
export function createContractClock() {
	let now = 0;
	let nextId = 0;
	const timers = new Map<number, { at: number; callback: () => void }>();
	return {
		now: () => now,
		pending: () => timers.size,
		schedule(delay: number, callback: () => void) {
			if (!Number.isFinite(delay) || delay < 0) throw new Error("Invalid clock delay");
			const id = ++nextId;
			timers.set(id, { at: now + delay, callback });
			return () => timers.delete(id);
		},
		advanceBy(delta: number) {
			if (!Number.isFinite(delta) || delta < 0) throw new Error("Invalid clock advance");
			const target = now + delta;
			let fired = 0;
			while (true) {
				const next = [...timers.entries()]
					.filter(([, timer]) => timer.at <= target)
					.sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
				if (!next) break;
				if (++fired > 1_000) throw new Error("Contract clock timer budget exceeded");
				timers.delete(next[0]);
				now = next[1].at;
				next[1].callback();
			}
			now = target;
		},
	};
}

export type ContractObservation =
	| { kind: "pass-input"; userText: string; history: unknown[]; trailingToolResults?: unknown[] }
	| { kind: "simulated-model-call"; model: string; provider: string }
	| { kind: "event"; stage: "produced" | "processed"; event: AgentEvent }
	| { kind: "binding"; toolUseId: string; binding: ToolCallBinding }
	| { kind: "cancel"; reason: string }
	| { kind: "deadline"; label: string }
	| { kind: "publish"; channel: string; value: unknown }
	| { kind: "pass-result"; result: ExecuteLoopResult }
	| { kind: "source-closed" };
export type ContractTraceEntry = ContractObservation & { seq: number; at: number };
export type ContractStep = AgentEvent | (() => void | Promise<void>);
type ProcessEventFn = NonNullable<
	NonNullable<Parameters<typeof executeAgentLoop>[1]>["processEventFn"]
>;

/**
 * Real shared executeAgentLoop pass; provider and persistence are explicit test doubles.
 * This does NOT exercise agentLoop/provider serialization, permission/execution claims,
 * main/child admission, policy enforcement, takeover, or terminal publication ownership.
 * Input/call traces describe the fixture packet, not proof of upstream model adoption.
 * P1-P3 adapters may reuse clock/record/publish without delegating policy to this helper.
 */
export function createRuntimeContractHarness(scenario: RuntimeContractScenario) {
	const clock = createContractClock();
	const controller = new AbortController();
	const trace: ContractTraceEntry[] = [];
	const record = (observation: ContractObservation) => {
		trace.push({ ...observation, seq: trace.length + 1, at: clock.now() });
	};
	const config: AgentConfig = {
		narratorId: `contract-${scenario.name}`,
		conversationId: `conversation-${scenario.name}`,
		parentNarratorId: scenario.child ? "contract-parent" : undefined,
		parentToolUseId: scenario.child ? "origin-tool-use" : undefined,
		model: "contract-model",
		provider: "contract-provider-never-contacted",
		cwd: process.cwd(),
		signal: controller.signal,
		permissionHandler: async () => {
			throw new Error("Event-source baseline must not invoke real tool permissions");
		},
		toolExecutionBindings: new WeakMap(),
	};
	// Matches the existing executor tests: persistence is replaced at the public seam.
	const eventContext = {} as EventHandlerContext;
	return {
		scenario,
		clock,
		controller,
		config,
		eventContext,
		trace,
		record,
		cancel(reason: string) {
			record({ kind: "cancel", reason });
			controller.abort(reason);
		},
		deadline(label: string, delay: number, callback: () => void) {
			return clock.schedule(delay, () => {
				record({ kind: "deadline", label });
				callback();
			});
		},
		/** Explicit spy sink only; the baseline never fabricates a runtime publication. */
		publish(channel: string, value: unknown) {
			record({ kind: "publish", channel, value });
		},
		async runPass(
			steps: readonly ContractStep[],
			input: Pick<ExecuteLoopOptions, "userText" | "history" | "trailingToolResults" | "hooks"> = {
				userText: "contract input",
				history: [],
			},
			processEventFn?: ProcessEventFn,
		) {
			record({
				kind: "pass-input",
				userText: input.userText,
				history: structuredClone(input.history),
				trailingToolResults: structuredClone(input.trailingToolResults),
			});
			async function* source(): AsyncIterable<AgentEvent> {
				record({ kind: "simulated-model-call", model: config.model, provider: config.provider });
				try {
					for (const step of steps) {
						if (typeof step === "function") {
							await step();
						} else {
							record({ kind: "event", stage: "produced", event: step });
							yield step;
						}
					}
				} finally {
					record({ kind: "source-closed" });
				}
			}
			const result = await executeAgentLoop(
				{ ...input, config, eventContext },
				{
					eventSource: source(),
					processEventFn: async (event, context, hooks) => {
						record({ kind: "event", stage: "processed", event });
						if (event.type === "tool_result" && event.toolCallBinding) {
							record({
								kind: "binding",
								toolUseId: event.toolUseId,
								binding: { ...event.toolCallBinding },
							});
						}
						return processEventFn ? processEventFn(event, context, hooks) : null;
					},
				},
			);
			record({ kind: "pass-result", result });
			return result;
		},
	};
}
