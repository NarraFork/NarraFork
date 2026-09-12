import type { createMailbox } from "./mailbox";
import type { ErrorShape, ReceiverManifest, RunBudgets } from "./protocol";

/** Serialized as a function literal into the VM. No runtime dependency may escape this body. */
export function createVmRuntime(
	config: { receivers: ReceiverManifest[]; budgets: RunBudgets },
	makeMailbox: typeof createMailbox,
) {
	const O = Object;
	const F = Function;
	const E = Error;
	const parse = JSON.parse;
	const stringify = JSON.stringify;
	const keys = Reflect.ownKeys;
	const descriptor = O.getOwnPropertyDescriptor;
	const prototype = O.getPrototypeOf;
	const create = O.create;
	const freeze = O.freeze;
	const define = O.defineProperty;
	const isArray = Array.isArray;
	const finite = Number.isFinite;
	const now = Date.now;
	const globals = globalThis;
	const budgets = freeze({ ...config.budgets });
	const mailbox = makeMailbox(budgets);
	const errors = new WeakMap<object, ErrorShape>();
	const logs: string[] = [];
	let phase: "preparing" | "running" | "closed" = "preparing";
	let sticky: ErrorShape | undefined;
	let failure: ErrorShape | undefined;
	let busy = false;
	let sequence = 0;
	let started = now();
	let returned: unknown;
	let last: unknown;
	let delivered: string | undefined;
	let summary: string | undefined;
	let finished: string | undefined;

	function close(): void {
		phase = "closed";
		mailbox.close();
	}
	function fault(code: string, message: string, fatal = true): Error {
		const shape = { code, message: message.slice(0, 2000), fatal };
		const error = new E(shape.message);
		define(error, "code", { value: code, enumerable: true });
		define(error, "fatal", { value: fatal, enumerable: true });
		errors.set(error, shape);
		if (fatal) {
			sticky ??= shape;
			close();
		}
		return error;
	}
	function record(error: unknown): void {
		if (failure) return;
		close();
		let message = typeof error === "string" ? error.slice(0, 2000) : "Script threw an error";
		if (error !== null && (typeof error === "object" || typeof error === "function")) {
			const known = errors.get(error);
			if (known) {
				failure = known;
				return;
			}
			// Never access error.message normally: thrown values can have hostile accessors.
			try {
				const prop = descriptor(error, "message");
				if (prop && "value" in prop && typeof prop.value === "string")
					message = prop.value.slice(0, 2000);
			} catch {
				/* A hostile thrown proxy does not replace the original failure. */
			}
		}
		failure = { code: "SCRIPT_ERROR", message, fatal: true };
	}
	function utf8(text: string, limit: number): number {
		let bytes = 0;
		for (let i = 0; i < text.length; i++) {
			const c = text.charCodeAt(i);
			if (c < 128) bytes++;
			else if (c < 2048) bytes += 2;
			else if (
				c >= 0xd800 &&
				c <= 0xdbff &&
				i + 1 < text.length &&
				text.charCodeAt(i + 1) >= 0xdc00 &&
				text.charCodeAt(i + 1) <= 0xdfff
			) {
				bytes += 4;
				i++;
			} else bytes += 3;
			if (bytes > limit) throw fault("OUTPUT_LIMIT", "JSON exceeds its byte budget");
		}
		return bytes;
	}
	// Clone only data descriptors to null-prototype containers. Never call a user toJSON/getter.
	function serialize(value: unknown, limit: number): string {
		if (busy) throw fault("REENTRANCY", "Serialization cannot reenter the runtime");
		busy = true;
		let nodes = 0;
		let chars = 0;
		const ancestors = new Set<object>();
		function clone(current: unknown, depth: number): unknown {
			if (++nodes > 20000 || depth > 32)
				throw fault("JSON_LIMIT", "JSON structure exceeds its budget");
			if (current === null || typeof current === "boolean") return current;
			if (typeof current === "string") {
				chars += current.length;
				if (chars > limit) throw fault("OUTPUT_LIMIT", "JSON exceeds its byte budget");
				return current;
			}
			if (typeof current === "number" && finite(current)) return current;
			if (!current || typeof current !== "object")
				throw fault("JSON_TYPE", "Only finite JSON data values are supported");
			const array = isArray(current);
			const proto = prototype(current);
			if (proto !== (array ? Array.prototype : O.prototype) && proto !== null)
				throw fault("JSON_TYPE", "Only plain JSON containers are supported");
			if (ancestors.has(current)) throw fault("JSON_TYPE", "Cyclic JSON is not supported");
			ancestors.add(current);
			const out = array ? [] : create(null);
			// Arrays must not inherit toJSON either.
			if (array) O.setPrototypeOf(out, null);
			const names = keys(current);
			if (names.length > 20001) throw fault("JSON_LIMIT", "JSON has too many properties");
			let count = 0;
			for (const key of names) {
				const prop = descriptor(current, key);
				if (!prop || prop.get || prop.set || typeof key !== "string" || key === "toJSON")
					throw fault("JSON_TYPE", "JSON accessors, symbols and toJSON are not supported");
				if (array && key === "length") continue;
				if (!prop.enumerable || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= 20000)))
					throw fault("JSON_TYPE", "JSON properties must be enumerable data");
				chars += key.length;
				if (chars > limit) throw fault("OUTPUT_LIMIT", "JSON exceeds its byte budget");
				define(out, key, {
					value: clone(prop.value, depth + 1),
					enumerable: true,
					configurable: true,
					writable: true,
				});
				count++;
			}
			if (array && descriptor(current, "length")?.value !== count)
				throw fault("JSON_TYPE", "Sparse arrays are not supported");
			ancestors.delete(current);
			return out;
		}
		try {
			const text = stringify(clone(value, 0));
			utf8(text, limit);
			if (sticky) throw fault(sticky.code, sticky.message);
			return text;
		} catch (error) {
			if (!sticky) throw fault("JSON_TYPE", "JSON inspection failed");
			throw error;
		} finally {
			busy = false;
		}
	}
	function check(): void {
		if (busy) throw fault("REENTRANCY", "API calls during serialization are forbidden");
		if (delivered !== undefined)
			throw fault("DELIVERY_CLOSED", "Delivery must be the final API action");
		if (phase !== "running" || mailbox.isClosed())
			throw fault("RUNTIME_CLOSED", "API is not running");
		if (now() - started >= budgets.wallMs) throw fault("TIMEOUT", "Execution deadline exceeded");
	}
	function rpc(receiver: string, method: string, args: unknown[]): unknown {
		check();
		if (++sequence > budgets.maxCalls || sequence > 100)
			throw fault("CALL_LIMIT", "Call budget exceeded");
		const text = serialize(
			{ type: "call", version: 1, sequence, receiver, method, args },
			budgets.requestBytes,
		);
		if (text.length * 2 > budgets.requestBytes)
			throw fault("REQUEST_LIMIT", "Request exceeds UTF-16 slot capacity");
		let response: string;
		try {
			mailbox.publishRequest(sequence, text);
			response = mailbox.waitForResponse(sequence, Math.max(0, budgets.wallMs - (now() - started)));
		} catch {
			throw fault("RPC_FAILED", "Mailbox closed, timed out, or rejected the frame");
		}
		if (response.length * 2 > budgets.responseBytes)
			throw fault("RESPONSE_LIMIT", "Response exceeds slot capacity");
		let frame: ReturnType<typeof parse>;
		try {
			frame = parse(response);
		} catch {
			throw fault("PROTOCOL", "Invalid response JSON");
		}
		if (
			!frame ||
			typeof frame !== "object" ||
			isArray(frame) ||
			frame.type !== "response" ||
			frame.version !== 1 ||
			frame.sequence !== sequence ||
			typeof frame.ok !== "boolean"
		)
			throw fault("PROTOCOL", "Invalid response schema or sequence");
		const expected = frame.ok
			? ["type", "version", "sequence", "ok", "value"]
			: ["type", "version", "sequence", "ok", "error"];
		if (keys(frame).length !== expected.length || expected.some((key) => !descriptor(frame, key)))
			throw fault("PROTOCOL", "Unexpected response fields");
		if (!frame.ok) {
			const error = frame.error;
			if (
				!error ||
				typeof error !== "object" ||
				isArray(error) ||
				keys(error).length !== 3 ||
				typeof error.code !== "string" ||
				!error.code.length ||
				error.code.length > 80 ||
				typeof error.message !== "string" ||
				error.message.length > 2000 ||
				typeof error.fatal !== "boolean"
			)
				throw fault("PROTOCOL", "Invalid host error");
			throw fault(error.code, error.message, error.fatal);
		}
		const snapshot = serialize(frame.value, budgets.responseBytes);
		last = parse(snapshot);
		// Keep the fallback independent of mutations to the returned API object.
		return parse(snapshot);
	}
	function expose(name: string, value: unknown): void {
		if (descriptor(globals, name)) throw fault("MANIFEST", "Receiver name collides with a global");
		define(globals, name, { value: freeze(value), writable: false, configurable: false });
	}
	const catalog: Array<{ name: string; methods: Array<{ name: string; description: string }> }> =
		[];
	for (const receiver of config.receivers) {
		const namespace = create(null);
		for (const method of receiver.methods) {
			if (descriptor(namespace, method.name)) throw fault("MANIFEST", "Duplicate receiver method");
			const receiverId = receiver.id;
			const methodName = method.name;
			define(namespace, methodName, {
				value: freeze((...args: unknown[]) => rpc(receiverId, methodName, args)),
				enumerable: true,
			});
		}
		catalog.push({
			name: receiver.name,
			methods: receiver.methods.map((method) => ({
				name: method.name,
				description: method.description,
			})),
		});
		expose(receiver.name, namespace);
	}
	expose("help", (topic?: unknown) => {
		check();
		if (topic === undefined) return parse(serialize(catalog, budgets.resultBytes));
		if (typeof topic !== "string") throw fault("HELP_TOPIC", "Help topic must be a string", false);
		for (const receiver of catalog) {
			if (topic === receiver.name) return parse(serialize(receiver, budgets.resultBytes));
			for (const method of receiver.methods)
				if (topic === `${receiver.name}.${method.name}`)
					return parse(serialize(method, budgets.resultBytes));
		}
		throw fault("HELP_TOPIC", "Unknown help topic", false);
	});
	expose("deliver", (value: unknown, note?: unknown) => {
		check();
		if (note !== undefined && (typeof note !== "string" || note.length > budgets.summaryChars))
			throw fault("SUMMARY_LIMIT", "Delivery summary exceeds its budget");
		delivered = serialize(value, budgets.resultBytes);
		summary = note as string | undefined;
		return undefined;
	});
	const log = (...values: unknown[]) => {
		check();
		if (logs.length >= budgets.maxLogs) throw fault("LOG_LIMIT", "Log count exceeded");
		const text = serialize(values, budgets.logBytes);
		serialize([...logs, text], budgets.logBytes);
		logs.push(text);
	};
	// A fresh VM supplies console; replace it rather than exposing a host console callback.
	define(globals, "console", {
		value: freeze({ log: freeze(log), info: log, warn: log, error: log, debug: log }),
		configurable: false,
		writable: false,
	});
	// Lock intrinsic prototypes and constructors before user compilation/evaluation.
	for (const intrinsic of [
		O,
		F,
		E,
		TypeError,
		RangeError,
		SyntaxError,
		ReferenceError,
		EvalError,
		URIError,
		Array,
		String,
		Number,
		Boolean,
		RegExp,
		Date,
		Map,
		Set,
		WeakMap,
		WeakSet,
		Promise,
		SharedArrayBuffer,
		ArrayBuffer,
		DataView,
		Int8Array,
		Uint8Array,
		Uint8ClampedArray,
		Int16Array,
		Uint16Array,
		Int32Array,
		Uint32Array,
		Float32Array,
		Float64Array,
		BigInt64Array,
		BigUint64Array,
		BigInt,
		Symbol,
	]) {
		if (intrinsic.prototype) freeze(intrinsic.prototype);
		freeze(intrinsic);
	}
	// for..of in trusted code also depends on iterator prototypes, not just Array.prototype.
	for (const root of [
		prototype(Uint8Array.prototype),
		prototype(Uint8Array),
		prototype([][Symbol.iterator]()),
		prototype(""[Symbol.iterator]()),
		prototype(new Map().entries()),
		prototype(new Set().values()),
		prototype(async () => undefined),
		prototype(function* () {}),
	]) {
		for (let current = root; current; current = prototype(current)) freeze(current);
	}
	for (const intrinsic of [JSON, Reflect, Atomics, Math]) freeze(intrinsic);
	for (const name of [
		"Bun",
		"process",
		"require",
		"Buffer",
		"Promise",
		"setTimeout",
		"setInterval",
		"setImmediate",
		"queueMicrotask",
		"fetch",
		"WebSocket",
		"eval",
		"SharedArrayBuffer",
		"Atomics",
	]) {
		define(globals, name, { value: undefined, writable: false, configurable: false });
	}
	// Pin remaining intrinsic global bindings as well as their prototype contents.
	for (const name of [
		"Object",
		"Function",
		"Error",
		"Array",
		"String",
		"Number",
		"Boolean",
		"RegExp",
		"Date",
		"Map",
		"Set",
		"WeakMap",
		"WeakSet",
		"JSON",
		"Reflect",
		"Math",
		"Int32Array",
		"Uint16Array",
	]) {
		const prop = descriptor(globals, name);
		if (prop && "value" in prop)
			define(globals, name, { ...prop, writable: false, configurable: false });
	}
	return freeze({
		buffers: mailbox.buffers,
		run(fn: unknown): void {
			try {
				if (phase !== "preparing") throw fault("RUNTIME_STATE", "Runtime can only run once");
				if (typeof fn !== "function" || !(fn instanceof F))
					throw fault("SCRIPT_TYPE", "Expected a VM function");
				phase = "running";
				started = now();
				returned = fn();
				if (now() - started >= budgets.wallMs)
					throw fault("TIMEOUT", "Execution deadline exceeded");
				// A thenable proxy must not reenter RPC while its descriptors are inspected.
				busy = true;
				try {
					if (returned && (typeof returned === "object" || typeof returned === "function")) {
						let current = returned;
						for (let depth = 0; current && depth < 40; depth++) {
							if (descriptor(current, "then"))
								throw fault("ASYNC_RESULT", "Promise and thenable returns are forbidden");
							current = prototype(current);
						}
					}
				} finally {
					busy = false;
				}
			} catch (error) {
				record(error);
			} finally {
				close();
			}
		},
		finish(): string {
			if (finished !== undefined) return finished;
			if (phase !== "closed") {
				fault("RUNTIME_STATE", "Runtime has not completed");
			}
			let value: unknown;
			try {
				if (!sticky && !failure) {
					if (delivered !== undefined) value = parse(delivered);
					else {
						const result = returned === undefined ? last : returned;
						if (result === undefined) throw fault("NO_RESULT", "Script produced no JSON result");
						value = parse(serialize(result, budgets.resultBytes));
					}
				}
			} catch (error) {
				record(error);
			}
			const error = sticky ?? failure;
			const result = error
				? { type: "result", version: 1, ok: false, error, logs }
				: {
						type: "result",
						version: 1,
						ok: true,
						value,
						...(delivered !== undefined
							? { delivery: summary === undefined ? {} : { summary } }
							: {}),
						logs,
					};
			finished = stringify(result);
			return finished;
		},
		fail(code: string, message: string): void {
			fault(
				typeof code === "string" ? code.slice(0, 80) || "SCRIPT_ERROR" : "SCRIPT_ERROR",
				typeof message === "string" ? message : "Script failed",
			);
		},
		close,
	});
}
