import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Worker } from "node:worker_threads";
import * as compiledWorkers from "../../compiled-worker";
import { createNativeMediaDumpEncoder, redactNativeMediaForDump } from "../native-media";
import {
	createRequestBodyEncoder,
	resetRequestJsonWorkersForTests,
	stringifyRequestBody,
} from "../request-json";

describe("bounded request JSON", () => {
	describe("native worker packet replies", () => {
		let worker: Worker;
		beforeEach(async () => {
			// Malformed replies now retire their native worker instead of returning an unconfirmed slot.
			await resetRequestJsonWorkersForTests();
			const connect = compiledWorkers.connectCompiledWorker;
			const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockImplementation(
				async (...args) => {
					const connected = await connect(...args);
					worker = connected.worker;
					return connected;
				},
			);
			try {
				// Capture a real connection; packets within this case still reuse the same worker.
				const body = { text: "warmup".repeat(10000) };
				expect(await stringifyRequestBody(body)).toBe(JSON.stringify(body));
				expect(connection).toHaveBeenCalledTimes(1);
			} finally {
				connection.mockRestore();
			}
		});

		test("ignores stale success and error frames without consuming the current listener", async () => {
			const post = worker.postMessage.bind(worker);
			const requestIds: string[] = [];
			let staleSuccesses = 0;
			let staleErrors = 0;
			const dispatch = spyOn(worker, "postMessage").mockImplementation((message) => {
				const staleId = requestIds.at(-1) ?? "previous-worker-packet";
				requestIds.push(message.requestId);
				const listeners = worker.listeners("message");
				expect(listeners.length).toBeGreaterThan(0);
				if (worker.emit("message", { requestId: staleId, text: "stale success" })) staleSuccesses++;
				expect(worker.listeners("message")).toEqual(listeners);
				if (worker.emit("message", { requestId: staleId, error: "stale error" })) staleErrors++;
				expect(worker.listeners("message")).toEqual(listeners);
				post(message);
			});
			try {
				const body = {
					text: `${"x".repeat(65535)}\ud83d\ude80\ud800\n\t"\\${"y".repeat(160000)}`,
				};
				expect(await stringifyRequestBody(body)).toBe(JSON.stringify(body));
				expect(requestIds.length).toBeGreaterThan(2);
				expect(new Set(requestIds).size).toBe(requestIds.length);
				expect(requestIds.every((id) => typeof id === "string" && id.length === 21)).toBe(true);
				expect(staleSuccesses).toBe(requestIds.length);
				expect(staleErrors).toBe(requestIds.length);
			} finally {
				dispatch.mockRestore();
			}
		});

		const malformedReplies: [string, (requestId: string) => unknown][] = [
			["missing ID", () => ({ text: "unowned" })],
			["missing error ID", () => ({ error: "unowned" })],
			["empty ID", () => ({ requestId: "", text: "unowned" })],
			["non-string ID", () => ({ requestId: 1, text: "unowned" })],
			["non-object frame", () => null],
			["array frame", (requestId) => Object.assign([], { requestId, text: "unowned" })],
			["missing result", (requestId) => ({ requestId })],
			["invalid text", (requestId) => ({ requestId, text: 1 })],
			["invalid error", (requestId) => ({ requestId, error: 1 })],
			["ambiguous result", (requestId) => ({ requestId, text: "text", error: "error" })],
		];
		test.each(
			malformedReplies,
		)("rejects %s without recomputing or replaying", async (_name, reply) => {
			let injected = 0;
			let exited = false;
			worker.once("exit", () => {
				exited = true;
			});
			const dispatch = spyOn(worker, "postMessage").mockImplementation((message) => {
				if (worker.emit("message", reply(message.requestId))) injected++;
			});
			try {
				const failure = await stringifyRequestBody({ text: "x".repeat(100000) }).catch(
					(error: unknown) => error,
				);
				expect(failure).toBeInstanceOf(Error);
				expect((failure as Error).message).toBe("Invalid request JSON worker response");
				expect(exited).toBe(true);
				expect(injected).toBe(1);
				expect(dispatch).toHaveBeenCalledTimes(1);
			} finally {
				dispatch.mockRestore();
			}
		});

		test("native escaping errors retain the packet ID and fail without replay", async () => {
			const post = worker.postMessage.bind(worker);
			const dispatch = spyOn(worker, "postMessage").mockImplementation((message) => {
				post({ ...message, parts: [null] });
			});
			try {
				const failure = await stringifyRequestBody({ text: "x".repeat(100000) }).catch(
					(error: unknown) => error,
				);
				expect(failure).toBeInstanceOf(Error);
				expect((failure as Error).message).toBe("Request JSON escaping failed");
				expect(dispatch).toHaveBeenCalledTimes(1);
			} finally {
				dispatch.mockRestore();
			}
		});

		test("readiness during a packet is control traffic, not a second business dispatch", async () => {
			const post = worker.postMessage.bind(worker);
			let readyControls = 0;
			const observe = (reply: { ready?: boolean }) => {
				if (reply.ready === true) readyControls++;
			};
			worker.on("message", observe);
			const dispatch = spyOn(worker, "postMessage").mockImplementation((message) => {
				post({ action: "ping" });
				post(message);
			});
			try {
				const body = { text: "control-frame".repeat(10000) };
				expect(await stringifyRequestBody(body)).toBe(JSON.stringify(body));
				expect(dispatch.mock.calls.length).toBeGreaterThan(0);
				expect(readyControls).toBe(dispatch.mock.calls.length);
			} finally {
				dispatch.mockRestore();
				worker.off("message", observe);
			}
		});
		test("ping readiness does not carry a business packet ID", async () => {
			const ready = new Promise<unknown>((resolve) => worker.once("message", resolve));
			worker.postMessage({ action: "ping" });
			expect(await ready).toEqual({ ready: true });
		});

		test("packet timeout terminates the native worker without recomputing or replaying", async () => {
			const setTimer = globalThis.setTimeout;
			let expire: (() => void) | undefined;
			let injected = 0;
			const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((
				callback: (...args: unknown[]) => void,
				delay?: number,
				...args: unknown[]
			) => {
				if (delay === 30_000) expire = () => callback(...args);
				return setTimer(callback, delay, ...args);
			}) as typeof setTimeout);
			const dispatch = spyOn(worker, "postMessage").mockImplementation(() => {
				if (!expire) throw new Error("Packet deadline was not registered");
				injected++;
				expire();
			});
			const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
			try {
				const failure = await stringifyRequestBody({ text: "x".repeat(100000) }).catch(
					(error: unknown) => error,
				);
				expect(failure).toBeInstanceOf(Error);
				expect((failure as Error).message).toBe("Request JSON packet timed out");
				expect(injected).toBe(1);
				expect(dispatch).toHaveBeenCalledTimes(1);
				await exited;
			} finally {
				dispatch.mockRestore();
				schedule.mockRestore();
			}
		});

		test.each(["creation failed", "disabled"])("worker %s fails closed", async (mode) => {
			// Also works when filtered independently of the preceding timeout test.
			await worker.terminate();
			const reason = new Error(`Request JSON worker ${mode}`);
			const connection = spyOn(compiledWorkers, "connectCompiledWorker").mockRejectedValue(reason);
			try {
				const failure = await stringifyRequestBody({ text: "x".repeat(100000) }).catch(
					(error: unknown) => error,
				);
				expect(failure).toBe(reason);
				expect(connection).toHaveBeenCalledTimes(1);
			} finally {
				connection.mockRestore();
			}
		});
	});

	test("matches JSON.stringify across large strings, surrogate boundaries and omitted values", async () => {
		const text = `${"x".repeat(65535)}\ud83d\ude80\ud800\n\t"\\${"y".repeat(100000)}`;
		const body = {
			input: [{ text, missing: undefined, callable: () => 1, symbol: Symbol("omitted") }],
			array: [undefined, NaN, Infinity, -Infinity, -0, null, true, false, ""],
			sparse: new Array(4),
			tools: Array.from({ length: 600 }, (_, i) => ({
				name: `tool-${i}`,
				parameters: { type: "object" },
			})),
			date: new Date("2026-10-30T00:00:00.000Z"),
			bytes: new Uint8Array([0, 127, 255]),
			signed: new Int16Array([-32768, 0, 32767]),
			floats: new Float32Array([1.5, NaN, Infinity]),
			buffer: Buffer.from([0, 127, 255]),
			view: new DataView(new ArrayBuffer(4)),
		};
		expect(await stringifyRequestBody(body)).toBe(JSON.stringify(body));
	});

	test("retry reuses large tools/history fragments while root fields can change", async () => {
		let reads = 0;
		const tools = [
			{
				get description() {
					reads++;
					return "x".repeat(100000);
				},
				name: "Read",
			},
		];
		const body: Record<string, unknown> = {
			tools,
			input: [{ text: "history" }],
			max_output_tokens: 1,
		};
		const encode = createRequestBodyEncoder();
		const first = await encode(body);
		const beforeRetry = reads;
		delete body.max_output_tokens;
		body.service_tier = "priority";
		const second = await encode(body);
		expect(reads).toBe(beforeRetry);
		expect(JSON.parse(first).tools).toEqual(JSON.parse(second).tools);
		expect(JSON.parse(second)).not.toHaveProperty("max_output_tokens");
		expect(JSON.parse(second).service_tier).toBe("priority");
	});

	test("abort is caller-local while another large caller continues", async () => {
		const controller = new AbortController();
		const reason = new Error("cancel this request");
		const a = stringifyRequestBody({ text: "a".repeat(4 * 1024 * 1024) }, controller.signal);
		const b = stringifyRequestBody({ text: "b".repeat(256 * 1024) }, new AbortController().signal);
		controller.abort(reason);
		await expect(a).rejects.toBe(reason);
		expect(JSON.parse(await b).text).toHaveLength(256 * 1024);
		await expect(stringifyRequestBody({ text: "never" }, controller.signal)).rejects.toBe(reason);
	});

	test("no-media diagnostics reuse wire text without revisiting large tool schemas", async () => {
		let dispatched = false;
		const body = {
			input: [{ type: "message", content: [{ type: "input_text", text: "hello" }] }],
			tools: [
				{
					get description() {
						if (dispatched) throw new Error("dump traversed tools again");
						return "x".repeat(100000);
					},
					parameters: { bytes: new Uint8Array([1, 2, 3]) },
				},
			],
		};
		const wire = await stringifyRequestBody(body);
		dispatched = true;
		expect(await createNativeMediaDumpEncoder()(body, wire)).toBe(wire);
	});

	test("large media diagnostics use shallow transforms, preserve wire, and reuse retry fragments", async () => {
		const bytes = "a".repeat(100000);
		let dispatched = false;
		const body: Record<string, unknown> = {
			messages: [
				{
					content: [
						{ type: "input_audio", input_audio: { data: bytes, format: "wav" } },
						{ type: "video_url", video_url: { url: `data:video/mp4;base64,${bytes}` } },
						{ type: "input_video", video_url: `data:video/mp4;base64,${bytes}` },
					],
				},
			],
			contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: bytes } }] }],
			input: [
				{ type: "user_input", content: [{ type: "video", mime_type: "video/mp4", data: bytes }] },
			],
			tools: [
				{
					get description() {
						if (dispatched) throw new Error("retry traversed tools again");
						return "x".repeat(100000);
					},
					parameters: { bytes: new Uint8Array([1, 2, 3]) },
				},
			],
			max_tokens: 10,
		};
		const expected = JSON.stringify(redactNativeMediaForDump(body));
		const encodeWire = createRequestBodyEncoder();
		const encodeDump = createNativeMediaDumpEncoder();
		const wire = await encodeWire(body);
		const dump = await encodeDump(body, wire);
		expect(dump).toBe(expected);
		expect(wire).toContain(bytes);
		expect(dump).not.toContain(bytes);
		expect(dump).toContain("native media omitted");
		dispatched = true;
		delete body.max_tokens;
		const retryWire = await encodeWire(body);
		const retryDump = await encodeDump(body, retryWire);
		const expectedRetry = JSON.parse(dump);
		delete expectedRetry.max_tokens;
		expect(JSON.parse(retryDump)).toEqual(expectedRetry);
		expect(JSON.parse(retryDump)).not.toHaveProperty("max_tokens");
		expect(JSON.parse(retryDump).messages).toEqual(JSON.parse(dump).messages);
		expect(retryWire).toContain(bytes);
	});

	test("cancelling media diagnostic encoding is caller-local and leaves wire bytes unchanged", async () => {
		const body = {
			messages: [
				{ content: [{ type: "input_audio", input_audio: { data: "secret", format: "wav" } }] },
			],
			tools: [{ description: "x".repeat(4 * 1024 * 1024) }],
		};
		const controller = new AbortController();
		const reason = new Error("cancel diagnostic encoding");
		const cancelled = createNativeMediaDumpEncoder()(body, "wire", controller.signal);
		const other = createNativeMediaDumpEncoder()(
			{ messages: body.messages, text: "x".repeat(100000) },
			"other wire",
		);
		const timer = setTimeout(() => controller.abort(reason), 0);
		try {
			await expect(cancelled).rejects.toBe(reason);
			expect(await other).not.toContain("secret");
			expect(body.messages[0].content[0].input_audio.data).toBe("secret");
			await expect(createNativeMediaDumpEncoder()(body, "wire", controller.signal)).rejects.toBe(
				reason,
			);
		} finally {
			clearTimeout(timer);
		}
	});

	test("circular values and BigInt reject rather than truncating", async () => {
		const cycle: Record<string, unknown> = { text: "x".repeat(40000) };
		cycle.self = cycle;
		await expect(stringifyRequestBody(cycle)).rejects.toThrow("circular");
		await expect(stringifyRequestBody({ value: 1n })).rejects.toThrow();
	});
});
