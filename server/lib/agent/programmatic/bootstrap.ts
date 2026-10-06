import parserSource from "@babel/parser" with { type: "text" };
import { createMailbox } from "./mailbox";
import type { RunBudgets, StartFrame } from "./protocol";
import { PROGRAMMATIC_LIMITS } from "./protocol";
import { guardSource } from "./source-guard";
import { createVmRuntime } from "./vm-runtime";

/** Executed only inside the isolated child Worker. All runtime references are local. */
function workerMain(
	vm: typeof import("node:vm"),
	mailboxSource: string,
	runtimeSource: string,
	parseSource: typeof import("@babel/parser").parse,
	validateSource: typeof guardSource,
) {
	let started = false;
	self.onmessage = async (event: MessageEvent<StartFrame>) => {
		if (started) return;
		started = true;
		self.onmessage = null;
		const input = event.data;
		const context = vm.createContext(
			Object.assign(Object.create(null), {
				require: undefined,
				fetch: undefined,
				process: undefined,
				Bun: undefined,
				module: undefined,
				exports: undefined,
				__filename: undefined,
				__dirname: undefined,
			}),
			{ codeGeneration: { strings: false, wasm: false } },
		);
		const configuration = JSON.stringify({ receivers: input.receivers, budgets: input.budgets });
		// Explicitly shadow runtime/module conveniences inside the contextified realm.
		vm.runInContext(
			`for (const name of ["require","fetch","process","Bun","module","exports","__filename","__dirname"]) Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false});`,
			context,
			{ timeout: 1000 },
		);
		// No host functions, Error objects, capabilities, or buffers are injected into the VM.
		const control = vm.runInContext(
			`(${runtimeSource})(JSON.parse(${JSON.stringify(configuration)}), (${mailboxSource}))`,
			context,
			{ timeout: 1000 },
		) as ReturnType<typeof createVmRuntime>;
		self.postMessage({ type: "mailbox", buffers: control.buffers });
		try {
			let guarded: string;
			try {
				guarded = validateSource(input.source, parseSource);
			} catch {
				control.fail(
					"SCRIPT_CONTRACT",
					"Source must be a valid synchronous TypeScript function body without async/await/Promise/import",
				);
				control.close();
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				self.postMessage({ type: "result", json: control.finish() });
				return;
			}
			const compiled = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(
				`globalThis.__nfCompiledEntry = ${guarded};`,
			);
			const fn: unknown = vm.runInContext(compiled, context, { timeout: 1000 });
			vm.runInContext("delete globalThis.__nfCompiledEntry", context, { timeout: 1000 });
			// Execution (including hostile loops/native waits) is bounded by the outer
			// process CPU quota, memory/PID limits and wall deadline, not a fake CPU timer.
			control.run(fn);
		} catch {
			// Do not inspect user-thrown getters/stack in the surrounding Worker realm.
			control.fail("SCRIPT_ERROR", "Script compilation or execution failed");
		} finally {
			control.close();
		}
		// Bun does not synchronously drain VM microtasks via microtaskMode. Let queued
		// continuations observe the closed channel before serialization; CPU/wall limits
		// also cover a deliberately non-draining microtask queue.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		let result: string;
		try {
			result = control.finish();
		} catch {
			result = JSON.stringify({
				type: "result",
				version: 1,
				ok: false,
				error: { code: "SERIALIZATION", message: "Result serialization failed", fatal: true },
				logs: [],
			});
		}
		self.postMessage({ type: "result", json: result });
	};
}

/** Self-contained trusted entrypoint, generated into the private container bootstrap. */
async function brokerMain(
	mailboxFactory: typeof createMailbox,
	workerSource: string,
	limits: typeof PROGRAMMATIC_LIMITS,
) {
	let worker: Worker | undefined;
	let mailbox: ReturnType<typeof createMailbox> | undefined;
	let finished = false;
	let started = false;
	let expected = 1;
	let awaiting = 0;
	let transferred = 0;
	let deadline = 0;
	let budgets: RunBudgets | undefined;
	let queuedResult: string | undefined;
	let responsePublished = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let outputQueue = Promise.resolve();
	let notifyChange: () => void = () => {};
	let change = new Promise<void>((resolve) => {
		notifyChange = resolve;
	});
	const changed = () => {
		const notify = notifyChange;
		change = new Promise<void>((resolve) => {
			notifyChange = resolve;
		});
		notify();
	};
	const write = (frame: unknown) => {
		const text = `${JSON.stringify(frame)}\n`;
		if (Buffer.byteLength(text) > limits.wireFrameBytes) throw new Error("wire output limit");
		const operation = outputQueue.then(
			() =>
				new Promise<void>((resolve, reject) => {
					process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
				}),
		);
		outputQueue = operation;
		return operation;
	};
	async function exitResult(json: string) {
		if (finished) return;
		finished = true;
		changed();
		if (timer) clearTimeout(timer);
		mailbox?.close();
		worker?.terminate();
		try {
			if (Buffer.byteLength(json) > limits.wireFrameBytes) throw new Error("result frame limit");
			await write(JSON.parse(json));
			process.exit(0);
		} catch {
			process.exit(1);
		}
	}
	async function fail(code: string) {
		await exitResult(
			JSON.stringify({
				type: "result",
				version: 1,
				ok: false,
				error: { code, message: "Isolated execution stopped", fatal: true },
				logs: [],
			}),
		);
	}
	const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.keys(value).every((key) => keys.includes(key));
	const bytes = (text: string) => Buffer.byteLength(text, "utf8");
	const account = (text: string) => {
		transferred += bytes(text);
		if (!budgets || transferred > budgets.transferBytes) throw new Error("transfer limit");
	};
	async function pump() {
		if (!mailbox || !budgets) throw new Error("mailbox not initialized");
		try {
			while (!finished) {
				const observedChange = change;
				if (awaiting) {
					if (!responsePublished) {
						await observedChange;
						continue;
					}
					await mailbox.waitForResponseConsumed(Math.max(1, deadline - Date.now()));
					awaiting = 0;
					responsePublished = false;
					continue;
				}
				if (queuedResult) {
					await exitResult(queuedResult);
					return;
				}
				if (mailbox.isClosed()) {
					// Worker close is not cancellation authority for the host. Await its
					// structured result (or the outer deadline), not another RPC.
					await observedChange;
					continue;
				}
				const request = mailbox.takeRequest();
				if (!request) {
					await mailbox
						.waitForRequest(Math.min(100, Math.max(1, deadline - Date.now())))
						.catch((error) => {
							if ((error as { code?: string }).code !== "MAILBOX_TIMEOUT" && !mailbox?.isClosed())
								throw error;
						});
					continue;
				}
				if (request.sequence !== expected || expected > budgets.maxCalls)
					throw new Error("sequence");
				const frame: unknown = JSON.parse(request.text);
				if (
					!exact(frame, ["type", "version", "sequence", "receiver", "method", "args"]) ||
					frame.type !== "call" ||
					frame.version !== 1 ||
					frame.sequence !== expected ||
					!Object.hasOwn(frame, "args")
				)
					throw new Error("request");
				account(request.text);
				awaiting = expected++;
				await write(frame);
			}
		} catch {
			if (!finished) await fail("BROKER_PROTOCOL");
		}
	}
	async function onFrame(text: string) {
		const frame: unknown = JSON.parse(text);
		if (!frame || typeof frame !== "object" || Array.isArray(frame)) throw new Error("frame");
		const data = frame as Record<string, unknown>;
		if (data.type === "cancel") {
			await fail("CANCELLED");
			return;
		}
		if (!started) {
			if (
				!exact(data, ["type", "version", "source", "receivers", "budgets"]) ||
				data.type !== "start" ||
				data.version !== 1 ||
				typeof data.source !== "string" ||
				bytes(data.source) > limits.sourceBytes ||
				!Array.isArray(data.receivers)
			)
				throw new Error("start");
			started = true;
			budgets = data.budgets as RunBudgets;
			if (
				!budgets ||
				!Number.isInteger(budgets.wallMs) ||
				budgets.wallMs < 1 ||
				budgets.wallMs > limits.maxWallMs ||
				budgets.requestBytes !== limits.requestBytes ||
				budgets.responseBytes !== limits.responseBytes ||
				budgets.maxCalls !== limits.maxCalls
			)
				throw new Error("budgets");
			deadline = Date.now() + budgets.wallMs;
			timer = setTimeout(() => {
				void fail("DEADLINE");
			}, budgets.wallMs);
			const url = URL.createObjectURL(new Blob([workerSource], { type: "application/javascript" }));
			worker = new Worker(url);
			worker.onerror = (event) => {
				if (typeof event.message === "string") process.stderr.write(event.message.slice(0, 2000));
				URL.revokeObjectURL(url);
				void fail("WORKER_ERROR");
			};
			worker.onmessage = (event: MessageEvent<unknown>) => {
				try {
					const message = event.data;
					if (!exact(message, ["type", "buffers", "json"])) throw new Error("worker frame");
					if (message.type === "mailbox") {
						if (mailbox || !budgets) throw new Error("duplicate handshake");
						mailbox = mailboxFactory(
							budgets,
							message.buffers as Parameters<typeof createMailbox>[1],
						);
						void pump();
					} else if (message.type === "result" && typeof message.json === "string") {
						if (queuedResult || !mailbox || (awaiting && !responsePublished))
							throw new Error("premature result");
						queuedResult = message.json;
						changed();
					} else throw new Error("worker message");
				} catch {
					void fail("WORKER_PROTOCOL");
				}
			};
			worker.postMessage(data);
			return;
		}
		if (
			!exact(data, ["type", "version", "sequence", "ok", "value", "error"]) ||
			data.type !== "response" ||
			data.version !== 1 ||
			data.sequence !== awaiting ||
			!awaiting ||
			!mailbox ||
			!budgets ||
			typeof data.ok !== "boolean"
		)
			throw new Error("response");
		account(text);
		mailbox.publishResponse(awaiting, text);
		responsePublished = true;
		changed();
	}
	try {
		const [memory, pids, cpu] = await Promise.all([
			Bun.file("/sys/fs/cgroup/memory.max").text(),
			Bun.file("/sys/fs/cgroup/pids.max").text(),
			Bun.file("/sys/fs/cgroup/cpu.max").text(),
		]);
		const [quota, period] = cpu.trim().split(/\s+/).map(Number);
		await write({
			type: "ready",
			version: 1,
			probe: {
				uid: process.getuid?.() ?? -1,
				memoryBytes: Number(memory.trim()),
				pids: Number(pids.trim()),
				cpuQuota: quota,
				cpuPeriod: period,
			},
		});
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let buffer = "";
		for await (const chunk of Bun.stdin.stream()) {
			buffer += decoder.decode(chunk, { stream: true });
			if (bytes(buffer) > limits.wireFrameBytes) throw new Error("input budget");
			for (;;) {
				const end = buffer.indexOf("\n");
				if (end < 0) break;
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				if (!frame || finished) throw new Error("closed frame");
				await onFrame(frame);
			}
		}
		if (!finished) await fail("HOST_DISCONNECTED");
	} catch {
		await fail("BROKER_PROTOCOL");
	}
}

/** Parser text is statically embedded (also in compiled binaries), never read at runtime. */
export function createSandboxBootstrap(): string {
	// Babel's self-contained CJS exports remain local to the Worker, never the VM.
	const workerSource = `import vm from "node:vm";\nconst parser = {};\n(function(exports){${parserSource}\n})(parser);\n(${workerMain.toString()})(vm,${JSON.stringify(createMailbox.toString())},${JSON.stringify(createVmRuntime.toString())},parser.parse,(${guardSource.toString()}));`;
	return `(${brokerMain.toString()})((${createMailbox.toString()}),${JSON.stringify(workerSource)},${JSON.stringify(PROGRAMMATIC_LIMITS)});`;
}
