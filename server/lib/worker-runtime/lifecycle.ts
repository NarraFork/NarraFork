import { Worker as NodeWorker, type WorkerOptions as NodeWorkerOptions } from "node:worker_threads";

/** A failed startup stop still owns a resource; callers must retain it until exited settles. */
export class WorkerCleanupError extends Error {
	constructor(
		readonly handle: WorkerHandle<unknown>,
		cause: unknown,
	) {
		super(cause instanceof Error ? cause.message : "Worker shutdown was not confirmed", { cause });
		this.name = "WorkerCleanupError";
		Object.defineProperty(this, "handle", { enumerable: false });
	}
}

/** Ownership only: domain protocols, readiness checks, and graceful draining stay with the caller. */
export class WorkerHandle<Resource> {
	readonly exited: Promise<number>;
	private didExit = false;
	private stopping = false;
	private failure: unknown;
	private closing: Promise<void> | undefined;

	/** Existing launchers may supply their resource; exited must confirm its real termination. */
	constructor(
		readonly resource: Resource,
		exited: Promise<number>,
		private readonly stop: () => unknown | Promise<unknown>,
	) {
		this.exited = exited.then((code) => {
			this.didExit = true;
			return code;
		});
		void this.exited.catch((error: unknown) => {
			this.failure ??= error;
		});
	}

	/** Unusable also includes closing/failed; this does not claim that resources have exited. */
	get closed(): boolean {
		return this.stopping || this.didExit || this.failure !== undefined;
	}

	get error(): unknown {
		return this.failure;
	}

	/** Idempotent; successful termination means the underlying exit was actually observed. */
	close(): Promise<void> {
		if (!this.closing) {
			this.stopping = true;
			this.closing = Promise.resolve().then(async () => {
				if (!this.didExit) await this.stop();
				await this.exited;
			});
		}
		return this.closing;
	}

	/** Entries must already be normalized by compiled-worker, or be trusted eval source. */
	static thread(entry: string | URL, options?: NodeWorkerOptions): WorkerHandle<NodeWorker> {
		const worker = new NodeWorker(entry, options);
		let exited!: (code: number) => void;
		const exit = new Promise<number>((resolve) => {
			exited = resolve;
		});
		const handle = new WorkerHandle(worker, exit, () => worker.terminate());
		worker.on("error", (error: Error) => handle.fail(error));
		worker.on("messageerror", () => handle.fail(new Error("Worker message could not be decoded")));
		worker.once("exit", exited);
		return handle;
	}

	/** Bun Blob workers keep their native API instead of changing how the source is evaluated. */
	static bunThread(
		entry: string | URL,
		options?: Bun.WorkerOptions,
	): WorkerHandle<globalThis.Worker> {
		const worker = new globalThis.Worker(entry, options);
		let exited!: (code: number) => void;
		const exit = new Promise<number>((resolve) => {
			exited = resolve;
		});
		const handle = new WorkerHandle(worker, exit, () => worker.terminate());
		worker.addEventListener("error", (event) => {
			handle.fail(event.error ?? new Error(event.message || "Worker failed"));
		});
		worker.addEventListener("messageerror", () =>
			handle.fail(new Error("Worker message could not be decoded")),
		);
		// lib.dom's Worker map omits Bun's close event, which is a CloseEvent at runtime.
		worker.addEventListener("close", (event) => exited((event as CloseEvent).code), { once: true });
		return handle;
	}

	/** Dedicated worker subprocesses only. Graceful flush/drain happens before calling close. */
	static subprocess<
		const In extends Bun.SpawnOptions.Writable = "ignore",
		const Out extends Bun.SpawnOptions.Readable = "pipe",
		const Err extends Bun.SpawnOptions.Readable = "inherit",
	>(
		command: string[],
		options?: Bun.SpawnOptions.SpawnOptions<In, Out, Err>,
		stop?: (process: Bun.Subprocess<In, Out, Err>) => unknown | Promise<unknown>,
	): WorkerHandle<Bun.Subprocess<In, Out, Err>> {
		const process = Bun.spawn(command, options);
		return new WorkerHandle(process, process.exited, () => {
			if (stop) return stop(process);
			process.kill("SIGKILL");
		});
	}

	private fail(error: unknown): void {
		this.failure ??= error;
		// Keep lifetime error listeners: Bun can report a late error while terminating a probe.
		void this.close().catch(() => {});
	}
}
