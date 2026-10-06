import type { Writable } from "node:stream";
import { PROGRAMMATIC_LIMITS, ProgrammaticError } from "./protocol";

/** Shared inbound/outbound budget, charged before buffering or writing. */
export class WireBudget {
	private used = 0;
	constructor(private readonly max = PROGRAMMATIC_LIMITS.transferBytes) {}
	charge(bytes: number): void {
		if (bytes > this.max - this.used)
			throw new ProgrammaticError("TRANSFER_LIMIT", "Wire transfer budget exceeded");
		this.used += bytes;
	}
}

/** Eagerly drain input, even when the consumer is idle; never queue unbounded frames. */
export class NdjsonFrames implements AsyncIterable<string> {
	private readonly queue: string[] = [];
	private readonly partial = Buffer.alloc(PROGRAMMATIC_LIMITS.wireFrameBytes);
	private length = 0;
	private ended = false;
	private failure: Error | undefined;
	private wake: (() => void) | undefined;
	private claimed = false;
	private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	constructor(
		private readonly budget: WireBudget,
		private readonly onFailure: (error: Error) => void,
	) {}
	push(chunk: Uint8Array): void {
		if (this.ended) return;
		try {
			this.budget.charge(chunk.byteLength);
			let start = 0;
			for (let i = 0; i <= chunk.length; i++) {
				if (i !== chunk.length && chunk[i] !== 10) continue;
				const size = i - start;
				if (size > this.partial.length - this.length)
					throw new ProgrammaticError("FRAME_LIMIT", "NDJSON frame too large");
				this.partial.set(chunk.subarray(start, i), this.length);
				this.length += size;
				if (i !== chunk.length) {
					if (this.length === 0 || this.queue.length >= 1024)
						throw new ProgrammaticError("PROTOCOL", "Empty frame or pending frame limit exceeded");
					const text = this.decoder.decode(this.partial.subarray(0, this.length));
					JSON.parse(text);
					this.queue.push(text);
					this.length = 0;
				}
				start = i + 1;
			}
			this.wake?.();
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error("Invalid wire input"));
		}
	}
	finish(): void {
		if (this.ended) return;
		if (this.length) {
			this.fail(new ProgrammaticError("PROTOCOL", "Truncated NDJSON frame"));
			return;
		}
		this.ended = true;
		this.wake?.();
	}
	fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		this.ended = true;
		this.queue.length = 0;
		this.wake?.();
		this.onFailure(error);
	}
	async *[Symbol.asyncIterator](): AsyncIterator<string> {
		if (this.claimed) throw new Error("Wire stream has a single consumer");
		this.claimed = true;
		try {
			while (true) {
				if (this.failure) throw this.failure;
				const next = this.queue.shift();
				if (next !== undefined) {
					yield next;
					continue;
				}
				if (this.ended) return;
				await new Promise<void>((resolve) => {
					this.wake = resolve;
				});
				this.wake = undefined;
			}
		} finally {
			if (!this.ended) this.fail(new ProgrammaticError("CANCELLED", "Wire consumer closed"));
		}
	}
}

export class NdjsonWriter {
	private chain: Promise<void> = Promise.resolve();
	private closed = false;
	constructor(
		private readonly stream: Writable,
		private readonly budget: WireBudget,
		private readonly onFailure: (error: Error) => void,
	) {
		stream.on("error", (error) => {
			this.closed = true;
			this.onFailure(error);
		});
		stream.on("close", () => {
			this.closed = true;
		});
	}
	close(): void {
		this.closed = true;
		this.stream.destroy();
	}
	send(json: string): Promise<void> {
		try {
			if (this.closed || this.stream.destroyed || this.stream.writableEnded)
				throw new ProgrammaticError("CLOSED", "Sandbox input is closed");
			if (json.length > PROGRAMMATIC_LIMITS.wireFrameBytes || /[\r\n]/.test(json))
				throw new ProgrammaticError(
					"FRAME_LIMIT",
					"Expected one bounded JSON frame without literal newlines",
				);
			const bytes = Buffer.byteLength(json);
			if (bytes > PROGRAMMATIC_LIMITS.wireFrameBytes)
				throw new ProgrammaticError("FRAME_LIMIT", "JSON frame too large");
			JSON.parse(json);
			this.budget.charge(bytes + 1);
			const pending = this.chain.then(async () => {
				if (this.closed) throw new ProgrammaticError("CLOSED", "Sandbox input is closed");
				// Callback fires only after the entire frame has passed stream backpressure.
				await new Promise<void>((resolve, reject) => {
					const closed = () =>
						reject(new ProgrammaticError("CLOSED", "Sandbox input closed during write"));
					this.stream.once("close", closed);
					this.stream.write(`${json}\n`, (error) => {
						this.stream.off("close", closed);
						error ? reject(error) : resolve();
					});
				});
			});
			this.chain = pending.catch((error: Error) => {
				this.close();
				this.onFailure(error);
			});
			return pending;
		} catch (error) {
			const failure = error instanceof Error ? error : new Error("Invalid JSON frame");
			this.close();
			this.onFailure(failure);
			return Promise.reject(failure);
		}
	}
}

/** Keep a bounded diagnostic head/tail while continuously draining stderr. */
export class BoundedStderr {
	private head = Buffer.alloc(0);
	private tail = Buffer.alloc(0);
	private total = 0;
	private exceeded = false;
	constructor(
		private readonly onLimit: () => void,
		private readonly limit = PROGRAMMATIC_LIMITS.transferBytes,
	) {}
	push(chunk: Uint8Array): void {
		const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		this.total += bytes.length;
		const headBytes = Math.min(16 * 1024 - this.head.length, bytes.length);
		if (headBytes) this.head = Buffer.concat([this.head, bytes.subarray(0, headBytes)]);
		const rest = bytes.subarray(headBytes);
		if (rest.length)
			this.tail = Buffer.concat([
				this.tail,
				rest.subarray(Math.max(0, rest.length - 16 * 1024)),
			]).subarray(-16 * 1024);
		if (this.total > this.limit && !this.exceeded) {
			this.exceeded = true;
			this.onLimit();
		}
	}
	text(): string {
		return (
			this.head.toString("utf8") +
			(this.total > 32 * 1024 ? "\n[stderr truncated]\n" : "") +
			this.tail.toString("utf8")
		);
	}
}
