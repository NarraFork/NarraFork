import { describe, expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import { Worker } from "node:worker_threads";
import {
	createMailbox,
	type Mailbox,
	type MailboxBuffers,
	type MailboxError,
	type MailboxErrorCode,
	type MailboxLimits,
} from "../mailbox";

// Deliberately inspect the documented wire ABI, not module-private runtime exports.
const ABI = { closed: 2, request: 5, response: 9 };
const SMALL = { requestBytes: 16, responseBytes: 32 };

function throwsCode(action: () => unknown, code: MailboxErrorCode): MailboxError {
	let caught: unknown;
	try {
		action();
	} catch (error) {
		caught = error;
	}
	expect(caught).toMatchObject({ code });
	return caught as MailboxError;
}

function header(mailbox: Mailbox): Int32Array<SharedArrayBuffer> {
	return new Int32Array(mailbox.buffers.control);
}

function inVm(setup = "", limits: MailboxLimits = SMALL) {
	const context = createContext({});
	runInContext(setup, context);
	const mailbox = runInContext(
		`globalThis.mailbox = (${createMailbox.toString()})(${JSON.stringify(limits)}); mailbox`,
		context,
	) as Mailbox;
	return { context, mailbox };
}

type WorkerMessage = { event: string } & Record<string, unknown>;

// No temporary files, application imports, or host functions in the VM sandbox.
function vmWorker(body: string) {
	const worker = new Worker(
		`const { parentPort, workerData } = require("node:worker_threads");
const { createContext, runInContext } = require("node:vm");
const context = createContext({});
runInContext(
  "for (const value of [Object, Array, String, Number, Error, Date, Int32Array, Uint16Array, SharedArrayBuffer, Promise, Function]) { Object.freeze(value.prototype); Object.freeze(value); } Object.freeze(Atomics); Object.freeze(Reflect); Object.freeze(Math);",
  context,
);
const mailbox = runInContext("globalThis.mailbox = (" + workerData.factory + ")(" + JSON.stringify(workerData.limits) + "); mailbox", context);
try {
  ${body}
} catch (error) {
  parentPort.postMessage({event: "result", code: error.code, reason: error.reason, message: error.message});
} finally {
  parentPort.close();
}`,
		{ eval: true, workerData: { factory: createMailbox.toString(), limits: SMALL } },
	);
	const inbox = new Map<string, WorkerMessage>();
	const pending = new Map<
		string,
		{
			resolve: (message: WorkerMessage) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	let failure: Error | undefined;
	worker.on("message", (message: WorkerMessage) => {
		const waiter = pending.get(message.event);
		if (waiter) {
			clearTimeout(waiter.timer);
			pending.delete(message.event);
			waiter.resolve(message);
		} else {
			inbox.set(message.event, message);
		}
	});
	worker.on("error", (error: Error) => {
		failure = error;
		for (const waiter of pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		pending.clear();
	});
	return {
		next(event: string): Promise<WorkerMessage> {
			if (failure) return Promise.reject(failure);
			const message = inbox.get(event);
			if (message) {
				inbox.delete(event);
				return Promise.resolve(message);
			}
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(event);
					reject(new Error(`Worker did not send ${event}`));
				}, 3000);
				pending.set(event, { resolve, reject, timer });
			});
		},
		async dispose() {
			for (const waiter of pending.values()) clearTimeout(waiter.timer);
			pending.clear();
			await worker.terminate();
		},
	};
}

describe("mailbox allocation and attachment", () => {
	test("allocates three distinct bounded SABs and attaches without resetting a frame", () => {
		const mailbox = createMailbox(SMALL);
		expect(mailbox.buffers.control).toBeInstanceOf(SharedArrayBuffer);
		expect(mailbox.buffers.control.byteLength).toBe(64);
		expect(mailbox.buffers.request.byteLength).toBe(16);
		expect(mailbox.buffers.response.byteLength).toBe(32);
		expect(new Set(Object.values(mailbox.buffers)).size).toBe(3);
		mailbox.publishRequest(7, "pending");
		const peer = createMailbox(SMALL, mailbox.buffers);
		expect(peer.buffers.control).toBe(mailbox.buffers.control);
		expect(peer.takeRequest()).toEqual({ sequence: 7, text: "pending" });
		expect(mailbox.takeRequest()).toBeNull();
		expect(createMailbox(SMALL).buffers.control).not.toBe(mailbox.buffers.control);
	});

	for (const direction of ["requestBytes", "responseBytes"] as const) {
		for (const invalid of [-2, 0, 1, 3, 2.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
			test(`rejects invalid ${direction} capacity ${invalid}`, () => {
				throwsCode(() => createMailbox({ ...SMALL, [direction]: invalid }), "MAILBOX_LIMIT");
			});
		}
	}

	test("enforces hard maxima and rejects missing or non-numeric limits", () => {
		for (const limits of [
			{ requestBytes: 65538, responseBytes: 32 },
			{ requestBytes: 16, responseBytes: 262146 },
			{ requestBytes: "16", responseBytes: 32 },
			{},
			null,
			undefined,
		]) {
			throwsCode(() => createMailbox(limits as MailboxLimits), "MAILBOX_LIMIT");
		}
		expect(createMailbox({ requestBytes: 2, responseBytes: 2 }).buffers.request.byteLength).toBe(2);
	});

	for (const field of ["control", "request", "response"] as const) {
		test(`requires a correctly sized SAB for ${field}`, () => {
			for (const replacement of [
				new ArrayBuffer(field === "control" ? 64 : SMALL[`${field}Bytes`]),
				new SharedArrayBuffer(0),
				new SharedArrayBuffer(68),
				{},
			]) {
				const mailbox = createMailbox(SMALL);
				throwsCode(
					() =>
						createMailbox(SMALL, { ...mailbox.buffers, [field]: replacement } as MailboxBuffers),
					"MAILBOX_PROTOCOL",
				);
				if (field !== "control") expect(mailbox.isClosed()).toBe(true);
			}
		});
	}

	test("rejects buffer aliases, growable storage and missing buffer fields", () => {
		const limits = { requestBytes: 16, responseBytes: 16 };
		const mailbox = createMailbox(limits);
		throwsCode(
			() => createMailbox(limits, { ...mailbox.buffers, response: mailbox.buffers.request }),
			"MAILBOX_PROTOCOL",
		);
		expect(mailbox.isClosed()).toBe(true);
		const another = createMailbox(SMALL);
		throwsCode(
			() =>
				createMailbox(SMALL, {
					...another.buffers,
					request: new SharedArrayBuffer(16, { maxByteLength: 32 }),
				}),
			"MAILBOX_PROTOCOL",
		);
		expect(another.isClosed()).toBe(true);
		throwsCode(() => createMailbox(SMALL, {} as MailboxBuffers), "MAILBOX_PROTOCOL");
		throwsCode(() => createMailbox(SMALL, null as unknown as MailboxBuffers), "MAILBOX_PROTOCOL");
	});

	for (const [word, value] of [
		[0, 0],
		[1, 2],
		[3, 65536],
		[4, 262144],
		[13, 1],
		[14, -1],
		[15, 1],
	]) {
		test(`validates ABI word ${word} both on attach and on use`, () => {
			for (const attach of [true, false]) {
				const mailbox = createMailbox(SMALL);
				Atomics.store(header(mailbox), word, value);
				throwsCode(
					() => (attach ? createMailbox(SMALL, mailbox.buffers) : mailbox.takeRequest()),
					"MAILBOX_PROTOCOL",
				);
				expect(mailbox.isClosed()).toBe(true);
			}
		});
	}

	test("rejects mismatching attachment limits instead of trusting header capacities", () => {
		const mailbox = createMailbox(SMALL);
		throwsCode(
			() => createMailbox({ requestBytes: 8, responseBytes: 32 }, mailbox.buffers),
			"MAILBOX_PROTOCOL",
		);
		expect(mailbox.isClosed()).toBe(true);
	});
});

describe("mailbox UTF-16 frames", () => {
	test("preserves NULs, BMP characters, astral characters and unpaired surrogates exactly", () => {
		const text = "\ud800\0\u007f\u00ff\u0100中文🙂\ud800x\udc00\uffff\udc00";
		const mailbox = createMailbox({
			requestBytes: text.length * 2,
			responseBytes: text.length * 2,
		});
		mailbox.publishRequest(1, text);
		expect(Atomics.load(header(mailbox), ABI.request + 3)).toBe(text.length);
		const encoded = new Uint16Array(mailbox.buffers.request);
		for (let i = 0; i < text.length; i++) expect(encoded[i]).toBe(text.charCodeAt(i));
		expect(mailbox.takeRequest()).toEqual({ sequence: 1, text });
		mailbox.publishResponse(1, text);
		expect(mailbox.takeResponse(1)).toBe(text);
	});

	test("handles all 65536 code units and chunk boundaries without lossy decoding", () => {
		let allUnits = "";
		for (let i = 0; i <= 0xffff; i++) allUnits += String.fromCharCode(i);
		const boundary = `${"a".repeat(1023)}\ud800\ud800\udc00\udc00${"b".repeat(1024)}\ud800`;
		const mailbox = createMailbox({ requestBytes: 65536, responseBytes: 262144 });
		mailbox.publishRequest(1, boundary);
		expect(mailbox.takeRequest()?.text).toBe(boundary);
		mailbox.publishResponse(1, allUnits);
		expect(mailbox.takeResponse(1)).toBe(allUnits);
	});

	test("accepts the exact hard byte limits", () => {
		const mailbox = createMailbox({ requestBytes: 65536, responseBytes: 262144 });
		const request = "\ud800x\udc00\0".repeat(8192);
		const response = "\ud800x\udc00\0".repeat(32768);
		mailbox.publishRequest(0x7fffffff, request);
		expect(mailbox.takeRequest()).toEqual({ sequence: 0x7fffffff, text: request });
		mailbox.publishResponse(0x7fffffff, response);
		expect(mailbox.takeResponse(0x7fffffff)).toBe(response);
	});

	test("distinguishes empty payloads from absent frames and reuses consumed slots", () => {
		const mailbox = createMailbox({ requestBytes: 2, responseBytes: 2 });
		for (let sequence = 1; sequence <= 32; sequence++) {
			expect(mailbox.takeRequest()).toBeNull();
			expect(mailbox.takeResponse(sequence)).toBeNull();
			mailbox.publishRequest(sequence, "");
			mailbox.publishResponse(sequence, "");
			expect(mailbox.takeRequest()).toEqual({ sequence, text: "" });
			expect(mailbox.takeResponse(sequence)).toBe("");
		}
	});

	test("bounds encoding by code units rather than code points or UTF-8 bytes", () => {
		const mailbox = createMailbox({ requestBytes: 2, responseBytes: 2 });
		mailbox.publishRequest(1, "\ud800");
		expect(mailbox.takeRequest()?.text).toBe("\ud800");
		throwsCode(() => mailbox.publishRequest(2, "🙂"), "MAILBOX_LIMIT");
		expect(mailbox.isClosed()).toBe(true);
		const other = createMailbox({ requestBytes: 2, responseBytes: 2 });
		throwsCode(() => other.publishResponse(1, "xx"), "MAILBOX_LIMIT");
		expect(other.isClosed()).toBe(true);
	});

	test("reports response ownership without consuming it", () => {
		const mailbox = createMailbox(SMALL);
		expect(mailbox.hasPendingResponse()).toBe(false);
		mailbox.publishResponse(1, "pending");
		expect(mailbox.hasPendingResponse()).toBe(true);
		expect(mailbox.takeResponse(1)).toBe("pending");
		expect(mailbox.hasPendingResponse()).toBe(false);
		mailbox.publishResponse(2, "reading");
		Atomics.compareExchange(header(mailbox), ABI.response, 2, 3);
		expect(mailbox.hasPendingResponse()).toBe(true);
		Atomics.store(header(mailbox), ABI.response, 2);
		expect(mailbox.takeResponse(2)).toBe("reading");
		expect(mailbox.hasPendingResponse()).toBe(false);
	});

	test("hasPendingResponse validates response state and preserves the frame", () => {
		for (const state of [1, 2, 3]) {
			const mailbox = createMailbox(SMALL);
			mailbox.publishResponse(1, "frame");
			Atomics.store(header(mailbox), ABI.response, state);
			expect(mailbox.hasPendingResponse()).toBe(true);
			expect(Atomics.load(header(mailbox), ABI.response + 2)).toBe(1);
		}
		for (const state of [-1, 4, 0x7fffffff]) {
			const mailbox = createMailbox(SMALL);
			Atomics.store(header(mailbox), ABI.response, state);
			throwsCode(() => mailbox.hasPendingResponse(), "MAILBOX_PROTOCOL");
			expect(mailbox.isClosed()).toBe(true);
		}
	});

	test("closed mailboxes reject pending-response inspection", () => {
		const mailbox = createMailbox(SMALL);
		mailbox.close(19);
		expect(throwsCode(() => mailbox.hasPendingResponse(), "MAILBOX_CLOSED").reason).toBe(19);
	});

	test("each direction can hold one independent frame", () => {
		const mailbox = createMailbox(SMALL);
		mailbox.publishRequest(3, "req");
		mailbox.publishResponse(2, "previous");
		expect(mailbox.takeResponse(2)).toBe("previous");
		expect(mailbox.takeRequest()).toEqual({ sequence: 3, text: "req" });
	});
});

describe("mailbox protocol validation", () => {
	for (const direction of ["request", "response"] as const) {
		test(`${direction} rejects invalid outbound sequences without integer wrapping`, () => {
			for (const sequence of [0, -1, 0.5, NaN, Infinity, 0x80000000, 0x100000001, "1", null]) {
				const mailbox = createMailbox(SMALL);
				const publish = direction === "request" ? mailbox.publishRequest : mailbox.publishResponse;
				throwsCode(() => publish(sequence as number, "x"), "MAILBOX_PROTOCOL");
				expect(mailbox.isClosed()).toBe(true);
			}
		});

		test(`${direction} rejects bad inbound lengths and sequences before copying`, () => {
			for (const [field, value] of [
				[3, -1],
				[3, SMALL[`${direction}Bytes`] / 2 + 1],
				[3, 0x7fffffff],
				[3, -0x80000000],
				[2, 0],
				[2, -1],
				[2, -0x80000000],
			]) {
				const mailbox = createMailbox(SMALL);
				if (direction === "request") mailbox.publishRequest(1, "x");
				else mailbox.publishResponse(1, "x");
				Atomics.store(header(mailbox), ABI[direction] + field, value);
				throwsCode(
					() => (direction === "request" ? mailbox.takeRequest() : mailbox.takeResponse(1)),
					"MAILBOX_PROTOCOL",
				);
				expect(mailbox.isClosed()).toBe(true);
			}
		});

		test(`${direction} validates states, including empty and in-flight metadata`, () => {
			for (const state of [-0x80000000, -1, 4, 0x7fffffff]) {
				const mailbox = createMailbox(SMALL);
				Atomics.store(header(mailbox), ABI[direction], state);
				throwsCode(() => mailbox.takeRequest(), "MAILBOX_PROTOCOL");
				expect(mailbox.isClosed()).toBe(true);
			}
			for (const state of [0, 1]) {
				const mailbox = createMailbox(SMALL);
				Atomics.store(header(mailbox), ABI[direction], state);
				Atomics.store(header(mailbox), ABI[direction] + 3, -1);
				throwsCode(() => mailbox.takeRequest(), "MAILBOX_PROTOCOL");
				expect(mailbox.isClosed()).toBe(true);
			}
		});

		test(`${direction} refuses double publication without overwriting the first payload`, () => {
			for (const state of [1, 2, 3]) {
				const mailbox = createMailbox(SMALL);
				const publish = direction === "request" ? mailbox.publishRequest : mailbox.publishResponse;
				publish(1, "first");
				Atomics.store(header(mailbox), ABI[direction], state);
				const before = Array.from(new Uint16Array(mailbox.buffers[direction]));
				throwsCode(() => publish(2, "second"), "MAILBOX_PROTOCOL");
				expect(Array.from(new Uint16Array(mailbox.buffers[direction]))).toEqual(before);
				expect(Atomics.load(header(mailbox), ABI[direction] + 2)).toBe(1);
				expect(mailbox.isClosed()).toBe(true);
			}
		});
	}

	test("does not consume WRITING or READING slots", () => {
		for (const state of [1, 3]) {
			const mailbox = createMailbox(SMALL);
			mailbox.publishRequest(1, "pending");
			Atomics.store(header(mailbox), ABI.request, state);
			expect(mailbox.takeRequest()).toBeNull();
			expect(Atomics.load(header(mailbox), ABI.request)).toBe(state);
			expect(mailbox.isClosed()).toBe(false);
		}
	});

	test("rejects non-string payloads without coercing them", () => {
		for (const text of [null, undefined, 42, { toString: () => "not allowed" }]) {
			const mailbox = createMailbox(SMALL);
			throwsCode(() => mailbox.publishRequest(1, text as string), "MAILBOX_PROTOCOL");
			expect(mailbox.isClosed()).toBe(true);
		}
	});

	test("a mismatching response closes rather than dropping, retrying or overwriting it", () => {
		const mailbox = createMailbox(SMALL);
		mailbox.publishResponse(2, "wrong");
		throwsCode(() => mailbox.takeResponse(1), "MAILBOX_PROTOCOL");
		expect(mailbox.isClosed()).toBe(true);
		expect(Atomics.load(header(mailbox), ABI.response + 2)).toBe(2);
		expect(Atomics.load(header(mailbox), ABI.response)).toBe(3);
	});

	test("rejects invalid expected sequences even when the response slot is empty", () => {
		for (const sequence of [0, -1, 0.5, Infinity, NaN, 0x80000000]) {
			const mailbox = createMailbox(SMALL);
			throwsCode(() => mailbox.takeResponse(sequence), "MAILBOX_PROTOCOL");
			expect(mailbox.isClosed()).toBe(true);
		}
	});
});

describe("mailbox ownership and mid-copy corruption", () => {
	for (const slot of [ABI.request, ABI.response]) {
		test(`revalidates slot ${slot} length after obtaining the read CAS`, () => {
			const { mailbox } = inVm(`
const originalCAS = Atomics.compareExchange;
Atomics.compareExchange = (view, index, expected, replacement) => {
  const previous = originalCAS(view, index, expected, replacement);
  if (index === ${slot} && expected === 2 && replacement === 3 && previous === 2) {
    Atomics.store(view, index + 3, 0x7fffffff);
  }
  return previous;
};`);
			if (slot === ABI.request) mailbox.publishRequest(1, "frame");
			else mailbox.publishResponse(1, "frame");
			throwsCode(
				() => (slot === ABI.request ? mailbox.takeRequest() : mailbox.takeResponse(1)),
				"MAILBOX_PROTOCOL",
			);
			expect(mailbox.isClosed()).toBe(true);
			expect(Atomics.load(header(mailbox), slot)).toBe(3);
		});
	}

	for (const [field, value] of [
		[7, 2],
		[8, 6],
		[5, 2],
	]) {
		test(`rejects mutation of request word ${field} during decoding without releasing it`, () => {
			const { mailbox } = inVm(`
const originalFromCharCode = String.fromCharCode;
String.fromCharCode = (...units) => {
  const view = new Int32Array(mailbox.buffers.control);
  if (Atomics.load(view, 5) !== 3) throw new Error("decoder did not own the slot");
  Atomics.store(view, ${field}, ${value});
  return originalFromCharCode(...units);
};`);
			mailbox.publishRequest(1, "frame");
			throwsCode(() => mailbox.takeRequest(), "MAILBOX_PROTOCOL");
			expect(mailbox.isClosed()).toBe(true);
			expect(Atomics.load(header(mailbox), ABI.request)).not.toBe(0);
		});
	}

	test("refuses to publish if ownership changes while encoding", () => {
		const { mailbox } = inVm(`
const originalCharCodeAt = String.prototype.charCodeAt;
String.prototype.charCodeAt = function(index) {
  Atomics.store(new Int32Array(mailbox.buffers.control), 5, 2);
  return Reflect.apply(originalCharCodeAt, this, [index]);
};`);
		throwsCode(() => mailbox.publishRequest(1, "frame"), "MAILBOX_PROTOCOL");
		expect(mailbox.isClosed()).toBe(true);
	});

	test("refuses publication when written metadata changes within the real capacity", () => {
		const { mailbox } = inVm(`
const originalStore = Atomics.store;
Atomics.store = (view, index, value) => originalStore(view, index, index === 8 ? value + 1 : value);`);
		throwsCode(() => mailbox.publishRequest(1, "frame"), "MAILBOX_PROTOCOL");
		expect(mailbox.isClosed()).toBe(true);
		expect(Atomics.load(header(mailbox), ABI.request)).toBe(1);
	});

	test("encoding cannot overwrite a concurrent close reason", () => {
		const { mailbox } = inVm(`
const originalCharCodeAt = String.prototype.charCodeAt;
String.prototype.charCodeAt = function(index) {
  mailbox.close(71);
  return Reflect.apply(originalCharCodeAt, this, [index]);
};`);
		expect(throwsCode(() => mailbox.publishRequest(1, "frame"), "MAILBOX_CLOSED").reason).toBe(71);
		expect(Atomics.load(header(mailbox), ABI.closed)).toBe(71);
		expect(Atomics.load(header(mailbox), ABI.request)).toBe(1);
	});

	test("decoding cannot release a cancelled slot or overwrite the close reason", () => {
		const { mailbox } = inVm(`
const originalFromCharCode = String.fromCharCode;
String.fromCharCode = (...units) => {
  mailbox.close(72);
  return originalFromCharCode(...units);
};`);
		mailbox.publishRequest(1, "frame");
		expect(throwsCode(() => mailbox.takeRequest(), "MAILBOX_CLOSED").reason).toBe(72);
		expect(Atomics.load(header(mailbox), ABI.closed)).toBe(72);
		expect(Atomics.load(header(mailbox), ABI.request)).toBe(3);
	});
});

describe("mailbox closure and timeouts", () => {
	test("keeps the first positive close reason separate from occupied data slots", () => {
		const mailbox = createMailbox(SMALL);
		const peer = createMailbox(SMALL, mailbox.buffers);
		mailbox.publishRequest(11, "request");
		mailbox.publishResponse(12, "response");
		const before = Array.from(header(mailbox));
		mailbox.close(77);
		peer.close(88);
		mailbox.close();
		expect(Atomics.load(header(mailbox), ABI.closed)).toBe(77);
		expect(mailbox.isClosed()).toBe(true);
		expect(peer.isClosed()).toBe(true);
		for (const word of [5, 7, 8, 9, 11, 12]) {
			expect(Atomics.load(header(mailbox), word)).toBe(before[word]);
		}
		for (const action of [
			() => mailbox.publishRequest(13, "x"),
			() => mailbox.publishResponse(13, "x"),
			() => mailbox.takeRequest(),
			() => mailbox.takeResponse(12),
			() => mailbox.waitForResponse(12, 0),
		]) {
			expect(throwsCode(action, "MAILBOX_CLOSED").reason).toBe(77);
		}
		expect(createMailbox(SMALL, mailbox.buffers).isClosed()).toBe(true);
	});

	test("default and invalid close reasons remain positive and sticky", () => {
		const mailbox = createMailbox(SMALL);
		mailbox.close();
		expect(Atomics.load(header(mailbox), ABI.closed)).toBe(1);
		for (const reason of [0, -1, 0.5, Infinity, NaN, 0x80000000]) {
			const other = createMailbox(SMALL);
			throwsCode(() => other.close(reason), "MAILBOX_PROTOCOL");
			expect(Atomics.load(header(other), ABI.closed)).toBe(2);
			throwsCode(() => mailbox.close(reason), "MAILBOX_PROTOCOL");
			expect(Atomics.load(header(mailbox), ABI.closed)).toBe(1);
		}
	});

	test("repairs a corrupt negative close reason and preserves closure across protocol faults", () => {
		const mailbox = createMailbox(SMALL);
		Atomics.store(header(mailbox), ABI.closed, -1);
		throwsCode(() => mailbox.takeRequest(), "MAILBOX_PROTOCOL");
		expect(Atomics.load(header(mailbox), ABI.closed)).toBe(2);
		Atomics.store(header(mailbox), 0, 0);
		throwsCode(() => createMailbox(SMALL, mailbox.buffers), "MAILBOX_PROTOCOL");
		expect(Atomics.load(header(mailbox), ABI.closed)).toBe(2);
	});

	test("close cancels every pending asynchronous waiter and rejects subsequent waiting", async () => {
		const mailbox = createMailbox(SMALL);
		const peer = createMailbox(SMALL, mailbox.buffers);
		const waiting = [mailbox.waitForRequest(1000), peer.waitForRequest(1000)];
		const settled = Promise.allSettled(waiting);
		peer.close(29);
		for (const result of await settled) {
			expect(result).toMatchObject({
				status: "rejected",
				reason: { code: "MAILBOX_CLOSED", reason: 29 },
			});
		}
		await expect(mailbox.waitForRequest(0)).rejects.toMatchObject({
			code: "MAILBOX_CLOSED",
			reason: 29,
		});
	});

	test("zero and finite asynchronous timeouts do not close or consume the next frame", async () => {
		const mailbox = createMailbox(SMALL);
		await expect(mailbox.waitForRequest(0)).rejects.toMatchObject({ code: "MAILBOX_TIMEOUT" });
		await expect(mailbox.waitForRequest(10)).rejects.toMatchObject({ code: "MAILBOX_TIMEOUT" });
		expect(mailbox.isClosed()).toBe(false);
		mailbox.publishRequest(1, "later");
		await mailbox.waitForRequest(0);
		expect(mailbox.takeRequest()).toEqual({ sequence: 1, text: "later" });
	});

	test("ready requests return immediately without consuming and empty responses are returned", async () => {
		const mailbox = createMailbox(SMALL);
		mailbox.publishRequest(1, "ready");
		await mailbox.waitForRequest(0);
		await mailbox.waitForRequest(0);
		expect(mailbox.takeRequest()?.text).toBe("ready");
		mailbox.publishResponse(1, "");
		// This zero-timeout ready path cannot enter the blocking native wait.
		expect(mailbox.waitForResponse(1, 0)).toBe("");
		throwsCode(() => mailbox.waitForResponse(1, 0), "MAILBOX_TIMEOUT");
		expect(mailbox.isClosed()).toBe(false);
	});

	test("rejects invalid deadlines before invoking native waits", async () => {
		for (const timeout of [-1, NaN, Infinity, "10"] as const) {
			const asyncMailbox = createMailbox(SMALL);
			await expect(asyncMailbox.waitForRequest(timeout as number)).rejects.toMatchObject({
				code: "MAILBOX_PROTOCOL",
			});
			expect(asyncMailbox.isClosed()).toBe(true);
			const syncMailbox = createMailbox(SMALL);
			throwsCode(() => syncMailbox.waitForResponse(1, timeout as number), "MAILBOX_PROTOCOL");
			expect(syncMailbox.isClosed()).toBe(true);
		}
	});
});

describe("mailbox waitAsync races and realm isolation", () => {
	test("toString creates buffers and errors exclusively in a fresh VM realm", () => {
		const { context, mailbox } = inVm();
		expect(Object.getPrototypeOf(mailbox.buffers.request)).toBe(
			runInContext("SharedArrayBuffer.prototype", context),
		);
		expect(Object.getPrototypeOf(mailbox.buffers.request)).not.toBe(SharedArrayBuffer.prototype);
		expect(
			runInContext("typeof process + ':' + typeof require + ':' + typeof Buffer", context),
		).toBe("undefined:undefined:undefined");
		const peer = createMailbox(SMALL, mailbox.buffers);
		mailbox.publishRequest(1, "\ud800");
		expect(peer.takeRequest()).toEqual({ sequence: 1, text: "\ud800" });
		mailbox.close(9);
		const error = throwsCode(() => mailbox.takeRequest(), "MAILBOX_CLOSED");
		expect(Object.getPrototypeOf(error)).toBe(runInContext("Error.prototype", context));
		expect(error).not.toBeInstanceOf(Error);
	});

	test("captured intrinsics survive later VM global and prototype rewrites", async () => {
		const { context, mailbox } = inVm();
		runInContext(
			`const fail = () => { throw "rewritten intrinsic"; };
String.prototype.charCodeAt = fail;
String.fromCharCode = fail;
Object.freeze = fail;
Reflect.apply = fail;
Function.prototype.call = fail;
Number.isInteger = fail;
Number.isFinite = fail;
Math.min = fail;
Date.now = fail;
for (const name of ["load", "store", "compareExchange", "add", "notify", "wait", "waitAsync"]) Atomics[name] = fail;
for (const name of ["Error", "SharedArrayBuffer", "Int32Array", "Uint16Array", "String", "Number", "Date", "Array"]) globalThis[name] = fail;`,
			context,
		);
		const pending = mailbox.waitForRequest(1000);
		mailbox.publishRequest(1, "\ud800x");
		await pending;
		expect(mailbox.takeRequest()).toEqual({ sequence: 1, text: "\ud800x" });
		mailbox.publishResponse(1, "\udc00");
		expect(mailbox.takeResponse(1)).toBe("\udc00");
		mailbox.close(14);
		expect(throwsCode(() => mailbox.takeRequest(), "MAILBOX_CLOSED").reason).toBe(14);
	});

	test("ready requests never call waitAsync", async () => {
		const { mailbox } = inVm(`Atomics.waitAsync = () => { throw new Error("must not wait"); };`);
		mailbox.publishRequest(1, "ready");
		await mailbox.waitForRequest(1000);
		expect(mailbox.takeRequest()?.text).toBe("ready");
	});

	test("handles the synchronous not-equal result when publication races with wait registration", async () => {
		const { context, mailbox } = inVm(`
const originalWaitAsync = Atomics.waitAsync;
globalThis.waitResults = [];
Atomics.waitAsync = (...args) => {
  mailbox.publishRequest(1, "race");
  const result = originalWaitAsync(...args);
  waitResults.push({async: result.async, value: result.value});
  return result;
};`);
		await mailbox.waitForRequest(1000);
		expect(runInContext("waitResults", context)).toEqual([{ async: false, value: "not-equal" }]);
		expect(mailbox.takeRequest()?.text).toBe("race");
	});

	test("waits asynchronously, tolerates a spurious wake and handles signal rollover", async () => {
		const { context, mailbox } = inVm(`
const originalWaitAsync = Atomics.waitAsync;
globalThis.waitResults = [];
Atomics.waitAsync = (...args) => {
  const result = originalWaitAsync(...args);
  waitResults.push(result.async);
  return result;
};`);
		Atomics.store(header(mailbox), ABI.request + 1, 0x7fffffff);
		let resolved = false;
		const pending = mailbox.waitForRequest(1000).then(() => {
			resolved = true;
		});
		expect(runInContext("waitResults", context)).toEqual([true]);
		Atomics.add(header(mailbox), ABI.request + 1, 1);
		Atomics.notify(header(mailbox), ABI.request + 1);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(resolved).toBe(false);
		expect(runInContext("waitResults.length", context)).toBe(2);
		createMailbox(SMALL, mailbox.buffers).publishRequest(2, "later");
		await pending;
		expect(mailbox.takeRequest()).toEqual({ sequence: 2, text: "later" });
		expect(runInContext("waitResults", context)).toEqual([true, true]);
	});

	test("rechecks closure if cancellation races just before native wait", async () => {
		const { context, mailbox } = inVm(`
const originalWaitAsync = Atomics.waitAsync;
globalThis.waitResults = [];
Atomics.waitAsync = (...args) => {
  mailbox.close(31);
  const result = originalWaitAsync(...args);
  waitResults.push({async: result.async, value: result.value});
  return result;
};`);
		await expect(mailbox.waitForRequest(1000)).rejects.toMatchObject({
			code: "MAILBOX_CLOSED",
			reason: 31,
		});
		expect(runInContext("waitResults", context)).toEqual([{ async: false, value: "not-equal" }]);
	});

	test("handles an immediate timed-out result without retrying or busy waiting", async () => {
		const { context, mailbox } = inVm(`
const originalWaitAsync = Atomics.waitAsync;
globalThis.waitCalls = 0;
Atomics.waitAsync = (view, index, expected) => {
  waitCalls++;
  return originalWaitAsync(view, index, expected, 0);
};`);
		await expect(mailbox.waitForRequest(1000)).rejects.toMatchObject({ code: "MAILBOX_TIMEOUT" });
		expect(runInContext("waitCalls", context)).toBe(1);
		expect(mailbox.isClosed()).toBe(false);
	});

	test("normalizes native wait failures to coded protocol errors and closes", async () => {
		const asyncVm = inVm(
			`Atomics.waitAsync = () => { throw new TypeError("native wait failed"); };`,
		);
		await expect(asyncVm.mailbox.waitForRequest(1000)).rejects.toMatchObject({
			code: "MAILBOX_PROTOCOL",
		});
		expect(asyncVm.mailbox.isClosed()).toBe(true);
		const syncVm = inVm(`Atomics.wait = () => { throw new TypeError("thread cannot wait"); };`);
		throwsCode(() => syncVm.mailbox.waitForResponse(1, 1000), "MAILBOX_PROTOCOL");
		expect(syncVm.mailbox.isClosed()).toBe(true);
	});

	test("never falls back to a blocking wait when waitAsync is unavailable", async () => {
		const { context, mailbox } = inVm(`
Atomics.waitAsync = undefined;
globalThis.syncWaitCalls = 0;
Atomics.wait = () => { syncWaitCalls++; throw new Error("host would block"); };`);
		await expect(mailbox.waitForRequest(1000)).rejects.toMatchObject({ code: "MAILBOX_PROTOCOL" });
		expect(runInContext("syncWaitCalls", context)).toBe(0);
		expect(mailbox.isClosed()).toBe(true);
	});
});

describe("mailbox real Worker + VM integration", () => {
	test("a frozen Worker VM synchronously receives a response while the host heartbeat continues", async () => {
		const fixture = vmWorker(`
parentPort.postMessage({event: "buffers", buffers: mailbox.buffers});
runInContext('mailbox.publishRequest(5, "req\\ud800")', context);
parentPort.postMessage({event: "waiting"});
const text = runInContext('mailbox.waitForResponse(5, 2000)', context);
parentPort.postMessage({event: "result", text});`);
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		try {
			const event = await fixture.next("buffers");
			const mailbox = createMailbox(SMALL, event.buffers as MailboxBuffers);
			await fixture.next("waiting");
			await mailbox.waitForRequest(1000);
			expect(mailbox.takeRequest()).toEqual({ sequence: 5, text: "req\ud800" });
			let ticks = 0;
			heartbeat = setInterval(() => {
				if (++ticks === 3) mailbox.publishResponse(5, "response\udc00");
			}, 10);
			expect(await fixture.next("result")).toMatchObject({
				event: "result",
				text: "response\udc00",
			});
			expect(ticks).toBeGreaterThanOrEqual(3);
			expect(mailbox.isClosed()).toBe(false);
		} finally {
			clearInterval(heartbeat);
			await fixture.dispose();
		}
	});

	test("reuses both CAS slots across repeated real cross-thread exchanges", async () => {
		const fixture = vmWorker(`
parentPort.postMessage({event: "buffers", buffers: mailbox.buffers});
runInContext('for (let seq = 1; seq <= 128; seq++) { mailbox.publishRequest(seq, "q" + seq); const text = mailbox.waitForResponse(seq, 2000); if (text !== "r" + seq) throw new Error("response was torn"); }', context);
parentPort.postMessage({event: "result", rounds: 128});`);
		try {
			const event = await fixture.next("buffers");
			const mailbox = createMailbox(SMALL, event.buffers as MailboxBuffers);
			for (let sequence = 1; sequence <= 128; sequence++) {
				await mailbox.waitForRequest(2000);
				expect(mailbox.takeRequest()).toEqual({ sequence, text: `q${sequence}` });
				mailbox.publishResponse(sequence, `r${sequence}`);
			}
			expect(await fixture.next("result")).toMatchObject({ rounds: 128 });
			expect(mailbox.isClosed()).toBe(false);
		} finally {
			await fixture.dispose();
		}
	});

	test("one close wakes both an async request waiter and a synchronous Worker response waiter", async () => {
		const fixture = vmWorker(`
parentPort.postMessage({event: "buffers", buffers: mailbox.buffers});
parentPort.postMessage({event: "waiting"});
runInContext('mailbox.waitForResponse(1, 2000)', context);`);
		try {
			const event = await fixture.next("buffers");
			const mailbox = createMailbox(SMALL, event.buffers as MailboxBuffers);
			await fixture.next("waiting");
			const settled = Promise.allSettled([mailbox.waitForRequest(2000)]);
			await new Promise((resolve) => setTimeout(resolve, 20));
			mailbox.close(91);
			expect(await settled).toMatchObject([
				{ status: "rejected", reason: { code: "MAILBOX_CLOSED", reason: 91 } },
			]);
			expect(await fixture.next("result")).toMatchObject({ code: "MAILBOX_CLOSED", reason: 91 });
			expect(Atomics.load(header(mailbox), ABI.closed)).toBe(91);
		} finally {
			await fixture.dispose();
		}
	});

	test("the Worker observes response timeout without closing the mailbox", async () => {
		const fixture = vmWorker(`
parentPort.postMessage({event: "buffers", buffers: mailbox.buffers});
runInContext('mailbox.waitForResponse(1, 20)', context);`);
		try {
			const event = await fixture.next("buffers");
			const mailbox = createMailbox(SMALL, event.buffers as MailboxBuffers);
			expect(await fixture.next("result")).toMatchObject({ code: "MAILBOX_TIMEOUT" });
			expect(mailbox.isClosed()).toBe(false);
		} finally {
			await fixture.dispose();
		}
	});

	test("the Worker rejects an unexpected response rather than waiting for another", async () => {
		const fixture = vmWorker(`
parentPort.postMessage({event: "buffers", buffers: mailbox.buffers});
runInContext('mailbox.waitForResponse(1, 2000)', context);`);
		try {
			const event = await fixture.next("buffers");
			const mailbox = createMailbox(SMALL, event.buffers as MailboxBuffers);
			mailbox.publishResponse(2, "wrong");
			expect(await fixture.next("result")).toMatchObject({ code: "MAILBOX_PROTOCOL" });
			expect(mailbox.isClosed()).toBe(true);
		} finally {
			await fixture.dispose();
		}
	});
});
