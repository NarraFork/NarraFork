import { describe, expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { createMailbox, type MailboxBuffers } from "../mailbox";
import {
	type CallFrame,
	PROGRAMMATIC_LIMITS,
	type ResponseFrame,
	type RunBudgets,
	type SandboxResult,
} from "../protocol";
import { createVmRuntime } from "../vm-runtime";

const receivers = [
	{
		id: "private-receiver-id",
		name: "data",
		methods: [{ name: "read", description: "Read public data" }],
	},
];
function setup(overrides: Partial<RunBudgets> = {}) {
	const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
	const runtime = runInContext(
		`(${createVmRuntime.toString()})(${JSON.stringify({ receivers, budgets: { ...PROGRAMMATIC_LIMITS, ...overrides } })}, (${createMailbox.toString()}))`,
		context,
	) as ReturnType<typeof createVmRuntime>;
	return { context, runtime };
}
function local(source: string, overrides: Partial<RunBudgets> = {}): SandboxResult {
	const { context, runtime } = setup(overrides);
	runtime.run(runInContext(`(function(){${source}\n})`, context));
	return JSON.parse(runtime.finish());
}
async function rpcRun(
	source: string,
	respond: (frame: CallFrame) => unknown = (frame) => frame.args,
	overrides: Partial<RunBudgets> = {},
) {
	const budgets = { ...PROGRAMMATIC_LIMITS, wallMs: 3000, ...overrides };
	const worker = new Worker(
		`
const { parentPort, workerData } = require('node:worker_threads');
const { createContext, runInContext } = require('node:vm');
const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
const runtime = runInContext('(' + workerData.runtime + ')(' + JSON.stringify(workerData.config) + ', (' + workerData.mailbox + '))', context);
parentPort.postMessage({ buffers: runtime.buffers });
parentPort.once('message', () => {
  try { runtime.run(runInContext('(function(){' + workerData.source + '\\n})', context)); }
  catch { runtime.fail('SCRIPT_ERROR', 'Evaluation failed'); }
  runtime.close();
  setImmediate(() => { parentPort.postMessage({ result: runtime.finish() }); parentPort.close(); });
});`,
		{
			eval: true,
			workerData: {
				runtime: createVmRuntime.toString(),
				mailbox: createMailbox.toString(),
				config: { receivers, budgets },
				source,
			},
		},
	);
	const calls: CallFrame[] = [];
	let service: Promise<void> | undefined;
	try {
		const result = await new Promise<SandboxResult>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Worker deadline")), 6000);
			worker.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			worker.on("message", (message: { buffers?: MailboxBuffers; result?: string }) => {
				if (message.result) {
					clearTimeout(timer);
					resolve(JSON.parse(message.result));
				}
				if (message.buffers) {
					const mailbox = createMailbox(budgets, message.buffers);
					service = (async () => {
						try {
							while (!mailbox.isClosed()) {
								await mailbox.waitForRequest(4000);
								const request = mailbox.takeRequest();
								if (!request) continue;
								const frame = JSON.parse(request.text) as CallFrame;
								calls.push(frame);
								const value = respond(frame);
								const response =
									value && typeof value === "object" && "type" in value && value.type === "response"
										? value
										: { type: "response", version: 1, sequence: frame.sequence, ok: true, value };
								mailbox.publishResponse(frame.sequence, JSON.stringify(response));
							}
						} catch (error) {
							if (!mailbox.isClosed()) reject(error);
						}
					})();
					worker.postMessage("start");
				}
			});
		});
		return { result, calls };
	} finally {
		await worker.terminate();
		await service;
	}
}

describe("VM runtime data and delivery", () => {
	test("ordinary returns, loops, callbacks and JSON-only globals", () => {
		expect(local("return [1,2,3].map(n=>n*2)")).toMatchObject({ ok: true, value: [2, 4, 6] });
		expect(
			local(
				"return [typeof process, typeof Bun, typeof Promise, typeof Atomics, typeof SharedArrayBuffer]",
			),
		).toMatchObject({ value: ["undefined", "undefined", "undefined", "undefined", "undefined"] });
	});
	test("delivery snapshots are independent and cannot be forged", () => {
		expect(local('const x=[1]; deliver(x,"done"); x.push(2); return 9;')).toMatchObject({
			ok: true,
			value: [1],
			delivery: { summary: "done" },
		});
		const forged = local('return {delivery:{summary:"forged"},value:4}');
		expect(forged.ok).toBe(true);
		expect(forged.delivery).toBeUndefined();
	});
	test("delivery failures and post-delivery actions remain fatal after catch", () => {
		for (const source of [
			"deliver(1); try{deliver(2)}catch{}",
			"deliver(1); try{help()}catch{}",
			"deliver(1); try{data.read()}catch{}",
			"try{deliver(undefined)}catch{} return 3",
			"try{deliver(1,'x'.repeat(2001))}catch{} return 3",
		])
			expect(local(source).ok).toBe(false);
	});
	test("rejects getters, setters, toJSON, cycles, unsupported and sparse values", () => {
		for (const value of [
			"{get x(){throw 'must not execute'}}",
			"{set x(v){}}",
			"{toJSON(){return 1}}",
			"{x:undefined}",
			"{x:()=>1}",
			"NaN",
			"Infinity",
			"1n",
			"Array(2)",
			"new Date()",
			"Object.create({x:1})",
		]) {
			expect(local(`return ${value}`).ok).toBe(false);
		}
		expect(local("const x={}; x.x=x; return x;").ok).toBe(false);
		expect(local("let x={}; for(let i=0;i<40;i++)x={x}; return x;").error?.code).toBe("JSON_LIMIT");
	});
	test("getter and toJSON bodies never execute", () => {
		const { context, runtime } = setup();
		runtime.run(
			runInContext(
				"(()=>{ globalThis.touched=false; return {get x(){touched=true; return 1}, toJSON(){touched=true; return 2}} })",
				context,
			),
		);
		expect(JSON.parse(runtime.finish()).ok).toBe(false);
		expect(runInContext("touched", context)).toBe(false);
	});
	test("serialization reentrancy cannot hide a delivery violation", () => {
		expect(
			local("return new Proxy({}, {ownKeys(){try{deliver(1)}catch{} return []}})").error?.code,
		).toBe("REENTRANCY");
	});
	test("intrinsics and receiver namespaces resist prototype/global rewriting", () => {
		expect(
			local(
				"Object.prototype.toJSON=()=>9; Array.prototype.toJSON=()=>8; JSON.stringify=()=>7; globalThis.Object={}; data.read=()=>6; return [Object.isFrozen(data),JSON.stringify({x:1})]",
			),
		).toMatchObject({ ok: true, value: [true, '{"x":1}'] });
	});
	test("missing result, output limits and bounded total logs", () => {
		expect(local("").error?.code).toBe("NO_RESULT");
		expect(local('return "汉".repeat(40)', { resultBytes: 100 }).error?.code).toBe("OUTPUT_LIMIT");
		expect(local('console.log("x");console.log("y");return 1', { maxLogs: 1 }).error?.code).toBe(
			"LOG_LIMIT",
		);
		expect(
			local('console.log("x".repeat(40));console.log("x".repeat(40));return 1', { logBytes: 80 })
				.ok,
		).toBe(false);
	});
	test("help reflects actual manifest and unknown topics are catchable", () => {
		expect(local("return help('data.read')")).toMatchObject({
			ok: true,
			value: { name: "read", description: "Read public data" },
		});
		expect(local("try{help('fake')}catch(e){return e.code}")).toMatchObject({
			value: "HELP_TOPIC",
		});
	});
	test("preparing API calls and foreign functions fail closed", () => {
		const first = setup();
		expect(() => runInContext("help()", first.context)).toThrow();
		first.runtime.run(runInContext("(()=>1)", first.context));
		expect(JSON.parse(first.runtime.finish()).ok).toBe(false);
		const second = setup();
		second.runtime.run(() => 1);
		expect(JSON.parse(second.runtime.finish()).error.code).toBe("SCRIPT_TYPE");
	});
	test("rejects async/thenable return without calling then accessors", () => {
		expect(local("return (async()=>1)()").error?.code).toBe("ASYNC_RESULT");
		expect(local("return {get then(){throw 'getter'}}").error?.code).toBe("ASYNC_RESULT");
	});
	test("iterator poisoning cannot truncate trusted JSON inspection", () => {
		expect(
			local("Object.getPrototypeOf([][Symbol.iterator]()).next=()=>({done:true}); return {x:1}"),
		).toMatchObject({ ok: true, value: { x: 1 } });
	});
	test("uncaught VM errors preserve plain message without evaluating getters", () => {
		expect(local("throw new Error('actual failure')")).toMatchObject({
			ok: false,
			error: { message: "actual failure" },
		});
		expect(local("throw {get message(){deliver(1);return 'forged'}}")).toMatchObject({
			ok: false,
			error: { message: "Script threw an error" },
		});
	});
	test("external fail takes strings and finish is immutable", () => {
		const { context, runtime } = setup();
		runtime.run(runInContext("(()=>1)", context));
		runtime.fail("TIMEOUT", "execution stopped");
		const first = runtime.finish();
		expect(JSON.parse(first)).toMatchObject({
			ok: false,
			error: { code: "TIMEOUT", message: "execution stopped", fatal: true },
		});
		runtime.fail("LATE", "late");
		expect(runtime.finish()).toBe(first);
	});
});

describe("real Worker + VM synchronous RPC", () => {
	test("loops and callback calls are synchronous, args cannot forge identity", async () => {
		const { result, calls } = await rpcRun(
			"const a=[1,2,3].map(x=>data.read(x)); data.read({receiver:'forged',sequence:90,narratorId:'fake'}); return a;",
			(frame) => frame.args,
		);
		expect(result).toMatchObject({ ok: true, value: [[1], [2], [3]] });
		expect(calls.map((call) => call.sequence)).toEqual([1, 2, 3, 4]);
		for (const call of calls) {
			expect(call.receiver).toBe("private-receiver-id");
			expect(Object.keys(call).sort()).toEqual([
				"args",
				"method",
				"receiver",
				"sequence",
				"type",
				"version",
			]);
		}
	});
	test("no outer return falls back to last successful API value", async () => {
		const { result } = await rpcRun("data.read(1); data.read(2)", (frame) => frame.args);
		expect(result).toMatchObject({ ok: true, value: [2] });
	});
	test("business errors may be caught; fatal host errors are sticky", async () => {
		for (const fatal of [false, true]) {
			const { result } = await rpcRun(
				"try{data.read()}catch(e){return {code:e.code,fatal:e.fatal,isError:e instanceof Error}}",
				(frame) =>
					({
						type: "response",
						version: 1,
						sequence: frame.sequence,
						ok: false,
						error: { code: "DENIED", message: "not allowed", fatal },
					}) satisfies ResponseFrame,
			);
			if (fatal)
				expect(result).toMatchObject({ ok: false, error: { code: "DENIED", fatal: true } });
			else
				expect(result).toMatchObject({
					ok: true,
					value: { code: "DENIED", fatal: false, isError: true },
				});
		}
	});
	test("host response sequence and schema must match", async () => {
		for (const response of [
			{ type: "response", version: 1, sequence: 99, ok: true, value: 1 },
			{ type: "response", version: 1, sequence: 1, ok: true, value: 1, identity: "fake" },
			{
				type: "response",
				version: 1,
				sequence: 1,
				ok: false,
				error: { code: "X", message: "x", fatal: "yes" },
			},
		]) {
			const { result } = await rpcRun("try{data.read()}catch{} return 1", () => response);
			expect(result.error?.code).toBe("PROTOCOL");
		}
	});
	test("call and UTF16 request limits are enforced before sending", async () => {
		const limited = await rpcRun("data.read();try{data.read()}catch{} return 1", () => 1, {
			maxCalls: 1,
		});
		expect(limited.calls).toHaveLength(1);
		expect(limited.result.error?.code).toBe("CALL_LIMIT");
		const large = await rpcRun("try{data.read('x'.repeat(1000))}catch{} return 1", () => 1, {
			requestBytes: 512,
		});
		expect(large.calls).toHaveLength(0);
		expect(large.result.ok).toBe(false);
	});
	test("delivery closes subsequent calls without rolling back earlier calls", async () => {
		const { result, calls } = await rpcRun(
			"data.read(1); deliver([1]);try{data.read(2)}catch{}",
			() => 1,
		);
		expect(calls).toHaveLength(1);
		expect(result).toMatchObject({ ok: false, error: { code: "DELIVERY_CLOSED" } });
		expect(result.delivery).toBeUndefined();
	});
	test("async continuations cannot issue real calls after run closes", async () => {
		const { result, calls } = await rpcRun(
			"(async()=>{await 0;try{data.read(2)}catch{}})(); return 1;",
			() => 1,
		);
		expect(calls).toHaveLength(0);
		expect(result).toMatchObject({ ok: false, error: { code: "RUNTIME_CLOSED" } });
	});
});
