import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderAdapter } from "../../server/lib/agent/provider";
import { BenchProvider } from "./client";
import { RUNTIME_CONTRACT } from "./contract";
import { type CompletionEvidence, completionKind, qualifies } from "./delivery-experiment";
import { challenges, type MockState } from "./fixtures";
import {
	assertPodmanReady,
	codeProblem,
	executeEval as executeInContainer,
	podmanTestsEnabled,
} from "./isolate";
import { coherentProfiles, experimentProfiles, FROZEN_V4 } from "./profiles";
import { runEpisode } from "./run";
import { evaluateChallenge } from "./runner";

const containerTest = test.skipIf(!podmanTestsEnabled());
// Only trusted, fixed fixtures run here. The real model path never falls back to this evaluator.
const executeEval: typeof executeInContainer = async (state, code, contract = RUNTIME_CONTRACT) => {
	const problem = codeProblem(code);
	if (problem) {
		return {
			ok: false,
			state,
			logs: [],
			error: { code: "SCRIPT_CONTRACT", message: problem },
			interfaceViolation: problem,
		};
	}
	return evaluateChallenge({ state, code, contract });
};

const profiles = await experimentProfiles();
const coherent = await coherentProfiles();
function fixture(id = "6") {
	const challenge = challenges.find((entry) => entry.id === id);
	if (!challenge) throw new Error(`Missing fixture ${id}`);
	return challenge;
}

interface SyntheticCall {
	id: string;
	code: string;
}
type Protocol = "anthropic" | "codex";
function responseFor(protocol: Protocol, calls: SyntheticCall[], upstreamStopReason?: string) {
	const events: unknown[] = [];
	if (protocol === "anthropic") {
		events.push({ type: "message_start", message: { usage: { input_tokens: 1 } } });
		for (const [index, call] of calls.entries()) {
			events.push({
				type: "content_block_start",
				index,
				content_block: { type: "tool_use", id: call.id, name: "Eval", input: {} },
			});
			events.push({
				type: "content_block_delta",
				index,
				delta: { type: "input_json_delta", partial_json: JSON.stringify({ code: call.code }) },
			});
			events.push({ type: "content_block_stop", index });
		}
		events.push(
			{
				type: "message_delta",
				delta: { stop_reason: upstreamStopReason ?? (calls.length ? "tool_use" : "end_turn") },
				usage: { output_tokens: 1 },
			},
			{ type: "message_stop" },
		);
	} else {
		const output = calls.map((call) => ({
			type: "function_call",
			id: `fc-${call.id}`,
			call_id: call.id,
			name: "Eval",
			arguments: JSON.stringify({ code: call.code }),
		}));
		events.push({
			type: upstreamStopReason === "max_tokens" ? "response.incomplete" : "response.completed",
			response: { output, usage: { input_tokens: 1, output_tokens: 1 } },
		});
	}
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
function provider(protocol: Protocol) {
	return new BenchProvider({
		baseUrl: "https://offline.invalid",
		apiKey: "unused-offline-key",
		model: "offline",
		protocol,
		modelHash: "none",
	});
}
async function offline<T>(
	protocol: Protocol,
	responses: SyntheticCall[][],
	run: (p: BenchProvider) => Promise<T>,
	upstreamStopReason?: string,
) {
	const original = globalThis.fetch;
	const sent: Array<Record<string, unknown>> = [];
	globalThis.fetch = (async (_url, init) => {
		sent.push(JSON.parse(String(init?.body)));
		const calls = responses[sent.length - 1];
		if (!calls) throw new Error("Unexpected extra model request after delivery");
		return responseFor(protocol, calls, upstreamStopReason);
	}) as typeof fetch;
	try {
		return { result: await run(provider(protocol)), sent };
	} finally {
		globalThis.fetch = original;
	}
}

describe("frozen V4 and protocol replay", () => {
	containerTest(
		"replay four stored V4 model trajectories against the actual frozen runner",
		async () => {
			await assertPodmanReady();
			const directory = new URL("../../docs/task-call-challenges/results/", import.meta.url);
			const snapshot = await Bun.file(new URL(`${FROZEN_V4}-sources.json`, directory)).json();
			const temporary = await mkdtemp(join(import.meta.dir, ".delivery-replay-"));
			try {
				const runtime = join(temporary, "runner.ts");
				await Bun.write(runtime, snapshot.sources["runner.ts"]);
				for (const model of ["luna", "flash"])
					for (const id of ["3", "5"]) {
						const record = (await Bun.file(
							new URL(`${FROZEN_V4}-${model}-${id}.json`, directory),
						).json()) as { turns: Array<{ calls: Array<{ input: { code: string } }> }> };
						let current = fixture(id).makeState();
						let original = fixture(id).makeState();
						for (const call of record.turns.flatMap((turn) => turn.calls)) {
							const before = await executeInContainer(
								original,
								call.input.code,
								profiles.baseline.contract,
								runtime,
							);
							const after = await executeInContainer(
								current,
								call.input.code,
								profiles.baseline.contract,
							);
							expect(after).toEqual(before);
							original = before.state;
							current = after.state;
						}
					}
			} finally {
				await rm(temporary, { recursive: true, force: true });
			}
		},
		60_000,
	);
	test("V4 has no delivery capability or public helper", async () => {
		const result = await executeEval(
			fixture().makeState(),
			"return typeof deliver;",
			profiles.baseline.contract,
		);
		expect(result.ok).toBe(true);
		expect(result.value).toBe("undefined");
		expect(profiles.baseline.contract.delivery).toBeUndefined();
		expect(profiles.baseline.contract.help.deliver).toBeUndefined();
		expect(Object.keys(profiles.baseline.contract.help)).toHaveLength(16);
	});
	for (const protocol of ["anthropic", "codex"] as const) {
		test(`${protocol}: prior values and call IDs are replayed exactly once`, async () => {
			const { sent } = await offline(
				protocol,
				[1, 2, 3].map((n) => [{ id: `c${n}`, code: "return 1;" }]),
				async (p) => {
					const history: unknown[] = [];
					p.injectSystemPrompt(history, "guide");
					let pending: unknown[] = [];
					for (let index = 0; index < 3; index++) {
						const content = index === 0 ? "request" : "";
						let id = "";
						for await (const event of p.chat({
							history,
							content,
							model: "offline",
							toolResults: pending,
							tools: [],
							conversationId: "offline",
						}))
							if (event.toolUses) id = event.toolUses[0].toolUseId;
						expect(id).toBe(`c${index + 1}`);
						p.pushUserTurn(history, content, "offline", pending);
						p.pushAssistantTurn(history);
						pending = [
							p.formatToolResult(id, JSON.stringify({ ok: true, value: ["K1", "K2"] }), false),
						];
					}
				},
			);
			for (let index = 1; index < 3; index++) {
				const messages = sent[index].messages as Array<{ content: unknown }> | undefined;
				const entries = (
					protocol === "anthropic"
						? messages?.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
						: sent[index].input
				) as Array<Record<string, unknown>>;
				const results = entries.filter((e) =>
					["tool_result", "function_call_output"].includes(String(e.type)),
				);
				expect(results).toHaveLength(index);
				for (let n = 0; n < index; n++) {
					const matches = results.filter((e) => (e.tool_use_id ?? e.call_id) === `c${n + 1}`);
					expect(matches).toHaveLength(1);
					expect(JSON.parse(String(matches[0].content ?? matches[0].output))).toEqual({
						ok: true,
						value: ["K1", "K2"],
					});
				}
			}
		});
	}
});

containerTest(
	"Podman agrees with the fixed evaluator and exposes no host runtime globals",
	async () => {
		await assertPodmanReady();
		for (const challenge of challenges) {
			let state = challenge.makeState();
			for (const code of challenge.reference) {
				const expected = await executeEval(state, code, profiles.delivery.contract);
				const actual = await executeInContainer(state, code, profiles.delivery.contract);
				expect(actual).toEqual(expected);
				state = actual.state;
			}
		}
		// Bun folds bare `typeof require` to the literal "function" while transpiling.
		// Probe the actual global properties instead of testing that compile-time assumption.
		const result = await executeInContainer(
			fixture().makeState(),
			"return { process: typeof globalThis.process, require: typeof globalThis.require, fetch: typeof globalThis.fetch };",
		);
		expect(result.value).toEqual({
			process: "undefined",
			require: "undefined",
			fetch: "undefined",
		});
	},
	60_000,
);

describe("delivery snapshot and unchanged business semantics", () => {
	for (const challenge of challenges) {
		test(`reference ${challenge.id}: same state, original grade and immutable delivery`, async () => {
			let state = challenge.makeState();
			let baselineState = challenge.makeState();
			for (const [index, code] of challenge.reference.entries()) {
				const last = index === challenge.reference.length - 1;
				const baseline = await executeEval(baselineState, code, profiles.baseline.contract);
				const result = await executeEval(
					state,
					last ? `const value = (()=>{${code}})(); deliver(value);` : code,
					profiles.delivery.contract,
				);
				expect(result.ok).toBe(true);
				expect(baseline.ok).toBe(true);
				expect(result.state.tasks).toEqual(baseline.state.tasks);
				expect(result.state.trace.filter((entry) => entry.op !== "deliver")).toEqual(
					baseline.state.trace,
				);
				state = result.state;
				baselineState = baseline.state;
				if (last) {
					expect(result.value).toEqual(baseline.value);
					expect(result.delivery).toEqual({});
					expect(challenge.grade(state, result.value).pass).toBe(true);
				}
			}
		}, 60_000);
	}
	test("ordinary returned markers cannot forge delivery", async () => {
		const result = await executeEval(
			fixture().makeState(),
			'return {delivered:true, delivery:{}, value:"done"};',
			profiles.delivery.contract,
		);
		expect(result.ok).toBe(true);
		expect(result.delivery).toBeUndefined();
	});
	test("mutating the original array cannot overwrite a delivery", async () => {
		const result = await executeEval(
			fixture().makeState(),
			'const a=["K1"]; deliver(a,"说明"); a.push("changed"); return "ignored";',
			profiles.delivery.contract,
		);
		expect(result.ok).toBe(true);
		expect(result.value).toEqual(["K1"]);
		expect(result.delivery).toEqual({ summary: "说明" });
	});
	test("delivery helper is discoverable without changing task permissions", async () => {
		const state = fixture().makeState();
		state.actor = { id: "frontend", role: "subagent" };
		const result = await executeEval(
			state,
			'const h=help("deliver"); try {tasks.get("T21").accept();} catch(e) {} deliver(h);',
			profiles.delivery.contract,
		);
		expect(result.delivery).toEqual({});
		expect(String(result.value)).toContain("deliver(value, summary?)");
		expect(result.state.tasks).toEqual(state.tasks);
		expect(result.state.trace.some((entry) => entry.error?.code === "FORBIDDEN")).toBe(true);
	});
});

const invalid = [
	["missing value", "deliver(undefined);"],
	["function value", "deliver(()=>{});"],
	["non-finite value", "deliver(Infinity);"],
	["wrong summary", 'deliver("x",{});'],
	["summary length", 'deliver("x","a".repeat(2001));'],
	["UTF-8 bytes rather than characters", 'deliver("中".repeat(22000));'],
	["swallowed size error", 'try{deliver("中".repeat(22000));}catch{} return "pretend";'],
	["duplicate delivery", 'deliver("one"); deliver("two");'],
	["later RPC", 'deliver("x"); task.start();'],
	["swallowed later RPC error", 'deliver("x"); try{task.start();}catch{} return "pretend";'],
	["delivery getter", 'deliver({get x(){ task.start(); return "x"; }});'],
	["then getter RPC", "deliver({get then(){try{task.start();}catch{} return undefined;}});"],
	[
		"serialization reentry",
		'const a=[]; Object.defineProperty(a,"map",{value(){try{task.start();}catch{} return [];}}); deliver(a);',
	],
	["throw after delivery", 'deliver("x"); throw new Error("after");'],
] as const;
describe("delivery failures cannot become successful completion", () => {
	for (const [name, code] of invalid)
		test(name, async () => {
			const state = fixture().makeState();
			const result = await executeEval(state, code, profiles.delivery.contract);
			expect(result.ok).toBe(false);
			expect(result.delivery).toBeUndefined();
			expect(result.state.tasks).toEqual(state.tasks);
		});
	test("earlier successful calls are not rolled back", async () => {
		const state = fixture("2").makeState();
		const result = await executeEval(
			state,
			'tasks.add("kept"); deliver("x"); task.start();',
			profiles.delivery.contract,
		);
		expect(result.ok).toBe(false);
		expect(result.delivery).toBeUndefined();
		expect(result.state.tasks).toHaveLength(state.tasks.length + 1);
		expect(result.state.tasks.at(-1)?.text).toBe("kept");
	});
	test("VM timeout after delivery does not commit delivery", async () => {
		const result = await executeEval(
			fixture().makeState(),
			'deliver("x"); while(true){}',
			profiles.delivery.contract,
		);
		expect(result.ok).toBe(false);
		expect(result.delivery).toBeUndefined();
	}, 20_000);
});

describe("coherent wording without new execution semantics", () => {
	function withoutErrorMessages(state: MockState) {
		return {
			...state,
			trace: state.trace.map((entry) => ({
				...entry,
				error: entry.error ? { code: entry.error.code } : undefined,
			})),
		};
	}
	test("frozen V5 stays exact; V6 is no longer or more capable", () => {
		expect(coherent.baseline).toEqual(profiles.delivery);
		expect(coherent.delivery.api.length).toBeLessThanOrEqual(coherent.baseline.api.length);
		expect(coherent.delivery.contract.delivery).toEqual(coherent.baseline.contract.delivery);
		expect(Object.keys(coherent.delivery.contract.help).sort()).toEqual(
			Object.keys(coherent.baseline.contract.help).sort(),
		);
		const a = structuredClone(coherent.baseline.parameters),
			b = structuredClone(coherent.delivery.parameters);
		for (const schema of [a, b])
			delete (schema.properties as Record<string, Record<string, unknown>>).code.description;
		expect(a).toEqual(b);
		for (const text of [
			coherent.delivery.api,
			coherent.delivery.description,
			coherent.delivery.codeDescription,
			coherent.delivery.contract.help.deliver,
		]) {
			expect(text).toContain("deliver");
			expect(text).toMatch(/等待确认|待确认/);
		}
		expect(coherent.delivery.contract.feedback?.contractChanged).toContain("deliver");
	});
	for (const challenge of challenges)
		test(`V5/V6 reference ${challenge.id}: identical values, states and error codes`, async () => {
			let a = challenge.makeState(),
				b = challenge.makeState();
			for (const [index, reference] of challenge.reference.entries()) {
				const last = index === challenge.reference.length - 1;
				const code = last ? `const value=(()=>{${reference}})(); deliver(value);` : reference;
				const before = await executeEval(a, code, coherent.baseline.contract);
				const after = await executeEval(b, code, coherent.delivery.contract);
				expect(after.ok).toBe(before.ok);
				expect(withoutErrorMessages(after.state)).toEqual(withoutErrorMessages(before.state));
				a = before.state;
				b = after.state;
				if (last) {
					expect(after.value).toEqual(before.value);
					expect(after.delivery).toEqual({});
					expect(challenge.grade(b, after.value).pass).toBe(true);
				}
			}
		}, 60000);
	test("contract-change feedback changes wording, not code or lifecycle", async () => {
		const state = fixture("5").makeState();
		const code = `task.read(); const result=tools.Bash({command:${JSON.stringify(state.testCommand)}}); task.finish(result.output);`;
		const a = await executeEval(state, code, coherent.baseline.contract),
			b = await executeEval(state, code, coherent.delivery.contract);
		expect(a.error?.code).toBe("CONTRACT_CHANGED");
		expect(b.error?.code).toBe("CONTRACT_CHANGED");
		expect(b.error?.message).toContain("deliver");
		expect(a.error?.message).not.toContain("deliver");
		expect(withoutErrorMessages(a.state)).toEqual(withoutErrorMessages(b.state));
		expect(b.delivery).toBeUndefined();
	});
	test("IIFE and outer return semantics are unchanged in both profiles", async () => {
		const state = fixture("3").makeState();
		const expression = '(()=>{const p=tasks.list({scope:"team"});return p.items.map(t=>t.key);})()';
		for (const outerReturn of [false, true]) {
			const code = outerReturn ? `return ${expression};` : expression;
			const a = await executeEval(state, code, coherent.baseline.contract),
				b = await executeEval(state, code, coherent.delivery.contract);
			expect(a.ok && b.ok).toBe(true);
			expect(a.value).toEqual(b.value);
			expect(Array.isArray(a.value)).toBe(outerReturn);
			expect(a.delivery).toBeUndefined();
			expect(b.delivery).toBeUndefined();
		}
	}, 20000);
});

describe("qualification accepts natural completion, not missing execution or truncation", () => {
	function completed(): CompletionEvidence & { finalPass: boolean } {
		return {
			finalPass: true,
			naturalStop: true,
			deliveryAccepted: false,
			turns: [
				{ stopReason: "tool_use", calls: [{}], evals: [{ feedback: { ok: true } }] },
				{ stopReason: "end_turn", upstreamStopReason: "end_turn", calls: [], evals: [] },
			],
		};
	}
	test("correct natural return does not need a redundant deliver", () => {
		expect(completionKind(completed())).toBe("natural");
		expect(qualifies(completed())).toBe(true);
	});
	test("budget exhaustion is not natural completion", () => {
		const r = completed();
		r.naturalStop = false;
		r.turns.pop();
		expect(completionKind(r)).toBe("budget");
		expect(qualifies(r)).toBe(false);
	});
	test("raw upstream truncation overrides a normalized stop reason", () => {
		const r = completed();
		r.turns[1].upstreamStopReason = "max_tokens";
		expect(completionKind(r)).toBe("truncated");
		expect(qualifies(r)).toBe(false);
	});
	test("an unresolved last error is not successful completion", () => {
		const r = completed();
		r.turns[0].evals[0].feedback.ok = false;
		expect(completionKind(r)).toBe("unresolved_error");
		expect(qualifies(r)).toBe(false);
	});
	test("a corrected earlier error does not invalidate a valid final result", () => {
		const r = completed();
		r.turns[0].evals.unshift({ feedback: { ok: false } });
		expect(qualifies(r)).toBe(true);
	});
	test("unknown stop, no execution and infrastructure interruption do not qualify", () => {
		const unknown = completed();
		unknown.turns[1].upstreamStopReason = "unknown";
		expect(completionKind(unknown)).toBe("unknown_stop");
		expect(qualifies(unknown)).toBe(false);
		const empty = completed();
		empty.turns.shift();
		expect(completionKind(empty)).toBe("no_execution");
		expect(qualifies(empty)).toBe(false);
		const failed = completed();
		failed.infrastructureError = "request aborted";
		expect(completionKind(failed)).toBe("infrastructure");
		expect(qualifies(failed)).toBe(false);
	});
	test("delivery must have a trusted clean terminal envelope", () => {
		const r = completed();
		r.turns.pop();
		r.deliveryAccepted = true;
		r.naturalStop = false;
		expect(completionKind(r)).toBe("invalid_delivery");
		r.turns[0].evals[0].delivery = {};
		expect(qualifies(r)).toBe(true);
		r.turns[0].notExecutedAfterDelivery = [{}];
		expect(completionKind(r)).toBe("delivery_conflict");
		expect(qualifies(r)).toBe(false);
	});
	test("a valid ending never overrides failed business grading", () => {
		const r = completed();
		r.finalPass = false;
		expect(completionKind(r)).toBe("natural");
		expect(qualifies(r)).toBe(false);
	});
	for (const protocol of ["anthropic", "codex"] as const) {
		test(`${protocol}: real loop natural end qualifies`, async () => {
			const code = fixture("2").reference[0];
			const { result, sent } = await offline(protocol, [[{ id: "query", code }], []], (p) =>
				runEpisode("offline", "2", coherent.delivery, {
					adapter: p as unknown as ProviderAdapter,
					channelType: protocol,
					evaluate: executeEval,
				}),
			);
			expect(result.finalPass).toBe(true);
			expect(result.deliveryAccepted).toBe(false);
			expect(sent).toHaveLength(2);
			expect(qualifies(result)).toBe(true);
		});
		test(`${protocol}: a valid tool call cannot hide truncated upstream output`, async () => {
			const code = `const value=(()=>{${fixture("2").reference[0]}})(); deliver(value);`;
			const { result } = await offline(
				protocol,
				[[{ id: "delivery", code }]],
				(p) =>
					runEpisode("offline", "2", coherent.delivery, {
						adapter: p as unknown as ProviderAdapter,
						channelType: protocol,
						evaluate: executeEval,
					}),
				"max_tokens",
			);
			expect(result.finalPass).toBe(true);
			expect(result.deliveryAccepted).toBe(true);
			expect(result.turns[0].stopReason).toBe("tool_use");
			expect(result.turns[0].upstreamStopReason).toBe("max_tokens");
			expect(completionKind(result)).toBe("truncated");
			expect(qualifies(result)).toBe(false);
		});
	}
});

describe("real episode loop with offline model responses", () => {
	for (const protocol of ["anthropic", "codex"] as const) {
		test(`${protocol}: a premature wrong delivery ends without grade oracle`, async () => {
			const { result, sent } = await offline(
				protocol,
				[[{ id: "first", code: 'deliver("done","尚未做任何工作");' }]],
				(p) =>
					runEpisode("offline", "6", profiles.delivery, {
						adapter: p as unknown as ProviderAdapter,
						channelType: protocol,
						evaluate: executeEval,
					}),
			);
			expect(sent).toHaveLength(1);
			expect(result.deliveryAccepted).toBe(true);
			expect(result.evalCount).toBe(1);
			expect(result.finalPass).toBe(false);
			expect(result.correctDelivery).toBe(false);
			expect(result.finalState.tasks).toEqual(fixture().makeState().tasks);
		});
		test(`${protocol}: later calls in the same response are recorded, never run`, async () => {
			const calls = [
				{ id: "delivery", code: 'deliver("done");' },
				{ id: "later", code: 'tasks.add("must not execute");' },
			];
			const { result, sent } = await offline(protocol, [calls], (p) =>
				runEpisode("offline", "6", profiles.delivery, {
					adapter: p as unknown as ProviderAdapter,
					channelType: protocol,
					evaluate: executeEval,
				}),
			);
			expect(sent).toHaveLength(1);
			expect(result.evalCount).toBe(1);
			expect(result.deliveryProtocolErrors).toBe(1);
			expect(result.finalState.tasks).toEqual(fixture().makeState().tasks);
			expect(result.turns[0].notExecutedAfterDelivery).toEqual([
				{
					toolUseId: "later",
					name: "Eval",
					input: { code: 'tasks.add("must not execute");' },
					code: "DELIVERY_CLOSED",
					executed: false,
				},
			]);
		});
	}
});
