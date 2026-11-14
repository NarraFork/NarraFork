import type { Worker } from "node:worker_threads";
import type { WorkerHandle } from "../lib/worker-runtime/lifecycle";
import type { PoolWorker, WorkerTaskContext } from "../lib/worker-runtime/pool";

/** Git domain protocol: cancel owned IO first, then force retirement after the original 1s grace. */
export class GitReaderSession<Request, Result> implements PoolWorker<Request, Result> {
	private retiring = false;
	private closing?: Promise<void>;
	private active?: { cleaned: Promise<void> };

	constructor(
		private readonly worker: Worker,
		private readonly handle: WorkerHandle<Worker>,
		private readonly error: (message: string) => Error,
		private readonly timeoutMs?: number,
	) {
		worker.unref();
	}

	get closed(): boolean {
		return this.retiring || this.handle.closed;
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.retiring = true;
		const active = this.active;
		// Sending cancel is synchronous: even pool-initiated abort must precede terminate().
		if (active) {
			try {
				this.worker.postMessage({ action: "cancel" });
			} catch {}
		}
		this.closing = (async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				if (active)
					await Promise.race([
						active.cleaned,
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, 1000);
						}),
					]);
			} finally {
				clearTimeout(timer);
				await this.handle.close();
			}
		})();
		return this.closing;
	}

	async run(request: Request, { signal }: WorkerTaskContext): Promise<Result> {
		signal.throwIfAborted();
		if (this.closed || this.active) throw this.error("reader_unavailable");
		this.worker.ref();
		let cleaned!: () => void;
		this.active = { cleaned: new Promise<void>((resolve) => (cleaned = resolve)) };
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		let receive!: (message: unknown) => void;
		let fail!: (error: unknown) => void;
		let exit!: () => void;
		try {
			return await new Promise<Result>((resolve, reject) => {
				receive = (message) => {
					if (!message || typeof message !== "object" || Array.isArray(message)) {
						cleaned();
						reject(this.error("Invalid Git reader reply"));
						return;
					}
					// A connector's ready frame is not a business completion/cleanup acknowledgement.
					if ("ready" in message && message.ready === true) return;
					if (signal.aborted) reject(signal.reason);
					else if (timedOut) reject(this.error("Git line statistics worker timed out"));
					else if ("error" in message && typeof message.error === "string" && message.error)
						reject(this.error(message.error));
					else if ("value" in message && message.value) resolve(message.value as Result);
					else reject(this.error("Invalid Git reader reply"));
					cleaned();
				};
				fail = (error) => {
					cleaned();
					reject(error);
				};
				exit = () => fail(this.error("reader_exited"));
				this.worker.on("message", receive);
				this.worker.once("error", fail);
				this.worker.once("messageerror", fail);
				this.worker.once("exit", exit);
				if (this.timeoutMs)
					timer = setTimeout(() => {
						timedOut = true;
						// Leave the RPC listener installed for the worker's IO-cleanup acknowledgement.
						void this.close().then(
							() => reject(this.error("Git line statistics worker timed out")),
							reject,
						);
					}, this.timeoutMs);
				try {
					this.worker.postMessage(request);
				} catch (error) {
					fail(error);
				}
			});
		} catch (error) {
			// RPC rejection is not resource retirement. Never allow another batch before real exit.
			await this.close();
			throw error;
		} finally {
			clearTimeout(timer);
			this.worker.off("message", receive);
			this.worker.off("error", fail);
			this.worker.off("messageerror", fail);
			this.worker.off("exit", exit);
			cleaned();
			this.active = undefined;
			this.worker.unref();
		}
	}
}
