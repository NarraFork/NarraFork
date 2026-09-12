export type MailboxLimits = { requestBytes: number; responseBytes: number };
export type MailboxBuffers = {
	control: SharedArrayBuffer;
	request: SharedArrayBuffer;
	response: SharedArrayBuffer;
};
export type MailboxErrorCode =
	| "MAILBOX_CLOSED"
	| "MAILBOX_TIMEOUT"
	| "MAILBOX_PROTOCOL"
	| "MAILBOX_LIMIT";
export type MailboxError = Error & { code: MailboxErrorCode; reason?: number };
export type MailboxFrame = { sequence: number; text: string };
export type Mailbox = {
	buffers: MailboxBuffers;
	publishRequest(sequence: number, text: string): void;
	takeRequest(): MailboxFrame | null;
	publishResponse(sequence: number, text: string): void;
	takeResponse(sequence: number): string | null;
	hasPendingResponse(): boolean;
	waitForRequest(timeoutMs: number): Promise<void>;
	waitForResponseConsumed(timeoutMs: number): Promise<void>;
	/** Blocking API: call only inside a Worker, never on the server's event loop. */
	waitForResponse(sequence: number, timeoutMs: number): string;
	close(reason?: number): void;
	isClosed(): boolean;
};

/**
 * A bounded, single-frame mailbox in each direction. No queue, retries or UTF-8 conversion.
 *
 * This function is serialized into a fresh VM: keep ALL runtime dependencies inside it.
 * Its intrinsics are captured in the caller's realm; no host functions need to be injected.
 * The VM must freeze its intrinsics before running untrusted code. Sharing a SAB with
 * hostile code cannot ensure payload authenticity or progress against continuous mutation.
 *
 * Fixed 64-byte control ABI (Int32 words):
 * 0 magic, 1 version, 2 sticky close reason, 3/4 byte capacities;
 * 5..8 request state/signal/sequence/UTF-16 length;
 * 9..12 response state/signal/sequence/UTF-16 length; 13..15 reserved (zero).
 * States: EMPTY=0, WRITING=1, READY=2, READING=3. A sequence fits a positive Int32.
 * Close reasons: 1 explicit/default, 2 protocol failure, 3 capacity failure; callers may
 * supply other positive Int32 reasons. Timeouts do not close or consume an unread frame.
 */
export function createMailbox(limits: MailboxLimits, buffers?: MailboxBuffers): Mailbox {
	const NativeError = Error;
	const NativeSharedArrayBuffer = SharedArrayBuffer;
	const NativeInt32Array = Int32Array;
	const NativeUint16Array = Uint16Array;
	const apply = Reflect.apply;
	const descriptor = Object.getOwnPropertyDescriptor;
	const freeze = Object.freeze;
	const isInteger = Number.isInteger;
	const isFiniteNumber = Number.isFinite;
	const min = Math.min;
	const now =
		typeof performance === "object" && typeof performance.now === "function"
			? performance.now.bind(performance)
			: Date.now;
	const charCodeAt = Function.prototype.call.bind(String.prototype.charCodeAt) as (
		text: string,
		index: number,
	) => number;
	const fromCharCode = String.fromCharCode;
	const { load, store, compareExchange, add, notify, wait, waitAsync } = Atomics;
	const byteLengthGetter = descriptor(NativeSharedArrayBuffer.prototype, "byteLength")?.get;
	const growableGetter = descriptor(NativeSharedArrayBuffer.prototype, "growable")?.get;

	const MAGIC = 0x4e464d42;
	const VERSION = 1;
	const CONTROL_BYTES = 64;
	const MAX_SEQUENCE = 0x7fffffff;
	const CLOSED = 2;
	const REQUEST = 5;
	const RESPONSE = 9;
	const EMPTY = 0;
	const WRITING = 1;
	const READY = 2;
	const READING = 3;
	let control: Int32Array<SharedArrayBuffer> | undefined;

	function error(code: MailboxErrorCode, message: string, reason?: number): MailboxError {
		const result = new NativeError(message) as MailboxError;
		result.code = code;
		if (reason !== undefined) result.reason = reason;
		return result;
	}

	function signal(header: Int32Array<SharedArrayBuffer>, slot: number): void {
		add(header, slot + 1, 1);
		notify(header, slot + 1);
	}

	function markClosed(reason: number): void {
		if (!control) return;
		let previous = load(control, CLOSED);
		// A corrupt negative reason is not a valid close; never replace a positive reason.
		while (previous <= 0) {
			const observed = compareExchange(control, CLOSED, previous, reason);
			if (observed === previous) break;
			previous = observed;
		}
		signal(control, REQUEST);
		signal(control, RESPONSE);
	}

	function protocol(message: string): never {
		markClosed(2);
		throw error("MAILBOX_PROTOCOL", message);
	}

	function limit(message: string): never {
		markClosed(3);
		throw error("MAILBOX_LIMIT", message);
	}

	if (typeof limits !== "object" || limits === null) limit("Mailbox limits are required");
	const { requestBytes, responseBytes } = limits;
	for (const [bytes, maximum] of [
		[requestBytes, 64 * 1024],
		[responseBytes, 256 * 1024],
	]) {
		if (!isInteger(bytes) || bytes < 2 || bytes % 2 !== 0 || bytes > maximum) {
			limit("Mailbox capacities must be even byte counts within 2..64KiB/256KiB");
		}
	}

	function checkBuffer(buffer: SharedArrayBuffer, bytes: number): void {
		let actual: number;
		let growable: boolean;
		if (!byteLengthGetter) protocol("SharedArrayBuffer byteLength is unavailable");
		try {
			actual = apply(byteLengthGetter, buffer, []);
			growable = growableGetter ? apply(growableGetter, buffer, []) : false;
		} catch {
			protocol("Mailbox buffers must be SharedArrayBuffers");
		}
		if (actual !== bytes || growable) protocol("Mailbox buffer size or mutability is invalid");
	}

	if (buffers !== undefined && (typeof buffers !== "object" || buffers === null)) {
		protocol("Mailbox buffers must contain control, request and response buffers");
	}
	const shared = freeze({
		control: buffers === undefined ? new NativeSharedArrayBuffer(CONTROL_BYTES) : buffers.control,
		request: buffers === undefined ? new NativeSharedArrayBuffer(requestBytes) : buffers.request,
		response: buffers === undefined ? new NativeSharedArrayBuffer(responseBytes) : buffers.response,
	});
	checkBuffer(shared.control, CONTROL_BYTES);
	const header = new NativeInt32Array(shared.control);
	control = header;
	checkBuffer(shared.request, requestBytes);
	checkBuffer(shared.response, responseBytes);
	if (
		shared.control === shared.request ||
		shared.control === shared.response ||
		shared.request === shared.response
	) {
		protocol("Mailbox directions must have separate buffers");
	}
	const request = new NativeUint16Array(shared.request, 0, requestBytes / 2);
	const response = new NativeUint16Array(shared.response, 0, responseBytes / 2);

	if (buffers === undefined) {
		store(header, 1, VERSION);
		store(header, 3, requestBytes);
		store(header, 4, responseBytes);
		// Publish the header only after all immutable metadata is initialized.
		store(header, 0, MAGIC);
	}

	function checkHeader(): void {
		if (
			load(header, 0) !== MAGIC ||
			load(header, 1) !== VERSION ||
			load(header, 3) !== requestBytes ||
			load(header, 4) !== responseBytes ||
			load(header, 13) !== 0 ||
			load(header, 14) !== 0 ||
			load(header, 15) !== 0
		) {
			protocol("Mailbox magic, version, capacities or reserved words are invalid");
		}
	}

	function checkFrame(slot: number, capacity: number): void {
		const state = load(header, slot);
		const sequence = load(header, slot + 2);
		const length = load(header, slot + 3);
		if (state < EMPTY || state > READING) protocol("Invalid mailbox slot state");
		if (!isInteger(length) || length < 0 || length > capacity) {
			protocol("Mailbox frame length exceeds the actual buffer capacity");
		}
		if (sequence < 0 || ((state === READY || state === READING) && sequence === 0)) {
			protocol("Invalid mailbox frame sequence");
		}
	}

	function checkOpen(): void {
		const reason = load(header, CLOSED);
		if (reason > 0) throw error("MAILBOX_CLOSED", `Mailbox is closed (reason ${reason})`, reason);
		if (reason < 0) protocol("Invalid mailbox close reason");
		checkHeader();
		checkFrame(REQUEST, requestBytes / 2);
		checkFrame(RESPONSE, responseBytes / 2);
	}

	function checkSequence(sequence: number): void {
		if (!isInteger(sequence) || sequence <= 0 || sequence > MAX_SEQUENCE) {
			protocol("Mailbox sequence must be a positive Int32");
		}
	}

	function deadline(timeoutMs: number): number {
		if (!isFiniteNumber(timeoutMs) || timeoutMs < 0)
			protocol("Mailbox timeout must be finite and nonnegative");
		const end = now() + timeoutMs;
		if (!isFiniteNumber(end)) protocol("Mailbox deadline is out of range");
		return end;
	}

	function publish(
		slot: number,
		data: Uint16Array<SharedArrayBuffer>,
		capacity: number,
		sequence: number,
		text: string,
	): void {
		checkOpen();
		checkSequence(sequence);
		if (typeof text !== "string") protocol("Mailbox payload must be a string");
		const length = text.length;
		if (length > capacity) limit("Mailbox payload exceeds its byte budget");
		if (compareExchange(header, slot, EMPTY, WRITING) !== EMPTY) {
			protocol("Mailbox slot already has an unconsumed frame");
		}
		for (let i = 0; i < length; i++) data[i] = charCodeAt(text, i);
		store(header, slot + 2, sequence);
		store(header, slot + 3, length);
		checkOpen();
		if (
			load(header, slot + 2) !== sequence ||
			load(header, slot + 3) !== length ||
			compareExchange(header, slot, WRITING, READY) !== WRITING
		) {
			protocol("Mailbox frame changed while writing");
		}
		signal(header, slot);
		checkOpen();
	}

	function take(
		slot: number,
		data: Uint16Array<SharedArrayBuffer>,
		capacity: number,
		expectedSequence?: number,
	): MailboxFrame | null {
		checkOpen();
		if (compareExchange(header, slot, READY, READING) !== READY) return null;
		const sequence = load(header, slot + 2);
		const length = load(header, slot + 3);
		checkSequence(sequence);
		if (!isInteger(length) || length < 0 || length > capacity) {
			protocol("Mailbox frame length exceeds the actual buffer capacity");
		}
		if (expectedSequence !== undefined && sequence !== expectedSequence) {
			protocol("Mailbox response sequence does not match the request");
		}
		let text = "";
		// Bound each native call; preserve every UTF-16 code unit, including lone surrogates.
		const chunk: number[] = [];
		for (let offset = 0; offset < length; offset += 1024) {
			chunk.length = min(1024, length - offset);
			for (let i = 0; i < chunk.length; i++) chunk[i] = data[offset + i];
			text += apply(fromCharCode, undefined, chunk);
		}
		checkOpen();
		if (
			load(header, slot + 2) !== sequence ||
			load(header, slot + 3) !== length ||
			compareExchange(header, slot, READING, EMPTY) !== READING
		) {
			protocol("Mailbox frame changed while reading");
		}
		signal(header, slot);
		checkOpen();
		return { sequence, text };
	}

	function takeResponse(sequence: number): string | null {
		checkOpen();
		checkSequence(sequence);
		return take(RESPONSE, response, responseBytes / 2, sequence)?.text ?? null;
	}

	// Attaching to an already closed mailbox is valid, but never accept an invalid ABI.
	checkHeader();
	checkFrame(REQUEST, requestBytes / 2);
	checkFrame(RESPONSE, responseBytes / 2);
	if (load(header, CLOSED) < 0) protocol("Invalid mailbox close reason");

	return freeze({
		buffers: shared,
		publishRequest(sequence: number, text: string): void {
			publish(REQUEST, request, requestBytes / 2, sequence, text);
		},
		takeRequest(): MailboxFrame | null {
			return take(REQUEST, request, requestBytes / 2);
		},
		publishResponse(sequence: number, text: string): void {
			publish(RESPONSE, response, responseBytes / 2, sequence, text);
		},
		takeResponse,
		hasPendingResponse(): boolean {
			checkOpen();
			checkFrame(RESPONSE, responseBytes / 2);
			return load(header, RESPONSE) !== EMPTY;
		},
		async waitForResponseConsumed(timeoutMs: number): Promise<void> {
			const end = deadline(timeoutMs);
			for (;;) {
				const observed = load(header, RESPONSE + 1);
				checkHeader();
				checkFrame(RESPONSE, responseBytes / 2);
				if (load(header, RESPONSE) === EMPTY) return;
				checkOpen();
				const remaining = end - now();
				if (remaining <= 0) throw error("MAILBOX_TIMEOUT", "Response consumption timed out");
				if (typeof waitAsync !== "function") protocol("Atomics.waitAsync is required");
				const pending = waitAsync(header, RESPONSE + 1, observed, remaining);
				if (pending.async) await pending.value;
			}
		},
		async waitForRequest(timeoutMs: number): Promise<void> {
			checkOpen();
			const end = deadline(timeoutMs);
			let timedOut = false;
			for (;;) {
				// Read signal BEFORE checking readiness/closure to avoid a lost wakeup.
				const observed = load(header, REQUEST + 1);
				checkOpen();
				if (load(header, REQUEST) === READY) return;
				const remaining = end - now();
				if (timedOut || remaining <= 0) throw error("MAILBOX_TIMEOUT", "Mailbox request timed out");
				if (typeof waitAsync !== "function")
					protocol("Atomics.waitAsync is required for request waiting");
				try {
					const pending = waitAsync(header, REQUEST + 1, observed, remaining);
					const result = pending.async ? await pending.value : pending.value;
					timedOut = result === "timed-out";
				} catch {
					protocol("Native asynchronous mailbox waiting failed");
				}
			}
		},
		waitForResponse(sequence: number, timeoutMs: number): string {
			checkOpen();
			checkSequence(sequence);
			const end = deadline(timeoutMs);
			let timedOut = false;
			for (;;) {
				const observed = load(header, RESPONSE + 1);
				const text = takeResponse(sequence);
				if (text !== null) return text;
				const remaining = end - now();
				if (timedOut || remaining <= 0)
					throw error("MAILBOX_TIMEOUT", "Mailbox response timed out");
				// Deliberately synchronous. The embedding layer must call this only in a Worker;
				// a fresh VM has no portable, trustworthy way to discover its thread identity.
				try {
					timedOut = wait(header, RESPONSE + 1, observed, remaining) === "timed-out";
				} catch {
					protocol("Native synchronous mailbox waiting failed; use a Worker");
				}
			}
		},
		close(reason = 1): void {
			if (!isInteger(reason) || reason <= 0 || reason > MAX_SEQUENCE) {
				protocol("Mailbox close reason must be a positive Int32");
			}
			markClosed(reason);
		},
		isClosed(): boolean {
			const reason = load(header, CLOSED);
			if (reason < 0) protocol("Invalid mailbox close reason");
			return reason > 0;
		},
	});
}
