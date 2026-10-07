import type { RestoreWorkerRequest } from "./remote-workspace-restore-worker";

/** Dedicated bounded metadata parser lifetime, never parses 100k paths on HTTP/WS JS. */
export class RemoteRestoreParser {
	private readonly worker = new Worker(
		new URL("./remote-workspace-restore-worker.ts", import.meta.url).href,
	);
	private readonly pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void }
	>();
	private next = 0;
	private closed = false;
	constructor(private readonly signal: AbortSignal) {
		this.worker.onmessage = (
			event: MessageEvent<{ id: number; value?: unknown; error?: string }>,
		) => {
			const request = this.pending.get(event.data.id);
			if (!request) return;
			this.pending.delete(event.data.id);
			if (event.data.error) request.reject(new Error(event.data.error));
			else request.resolve(event.data.value);
		};
		this.worker.onerror = (event) =>
			this.close(new Error(event.message || "Workspace restore parser failed"));
		signal.addEventListener("abort", this.abort, { once: true });
		if (signal.aborted) this.abort();
	}
	private abort = () =>
		this.close(
			this.signal.reason instanceof Error
				? this.signal.reason
				: new Error("Workspace restore cancelled"),
		);
	request<Result>(request: RestoreWorkerRequest): Promise<Result> {
		this.signal.throwIfAborted();
		if (this.closed || this.pending.size >= 2)
			throw new Error("Workspace restore parser unavailable or request budget exceeded");
		const id = ++this.next;
		return new Promise<Result>((resolve, reject) => {
			this.pending.set(id, { resolve: (value) => resolve(value as Result), reject });
			this.worker.postMessage({ id, request });
		});
	}
	close(error = new Error("Workspace restore parser closed")) {
		if (this.closed) return;
		this.closed = true;
		this.signal.removeEventListener("abort", this.abort);
		this.worker.terminate();
		for (const request of this.pending.values()) request.reject(error);
		this.pending.clear();
	}
}
