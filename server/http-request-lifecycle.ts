import { AsyncLocalStorage } from "node:async_hooks";

/** Completion is the end/cancellation of the body, not the creation of Response. */
export function createServerRequestLifecycle() {
	const context = new AsyncLocalStorage<number>();
	const active = new Map<number, { completion: Promise<void>; abort: () => void }>();
	let accepting = true;
	let sequence = 0;
	return {
		context,
		get accepting() {
			return accepting;
		},
		get activeCount() {
			return active.size;
		},
		nextRequestId: () => ++sequence,
		stopAccepting() {
			accepting = false;
		},
		abortAll() {
			for (const item of active.values()) item.abort();
		},
		async drain(excludedRequestId?: number) {
			while (true) {
				const pending = [...active.entries()]
					.filter(([id]) => id !== excludedRequestId)
					.map(([, item]) => item.completion);
				if (!pending.length) return;
				await Promise.allSettled(pending);
			}
		},
		track(
			id: number,
			request: Request,
			execution: Promise<Response | undefined>,
			trackBody = false,
		) {
			let finish!: () => void;
			let abort = () => {};
			const completion = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const done = () => {
				request.signal.removeEventListener("abort", onAbort);
				active.delete(id);
				finish();
			};
			const onAbort = () => abort();
			active.set(id, { completion, abort: () => abort() });
			return execution.then(
				(response) => {
					// Ordinary responses keep Bun's native file/Range/HEAD handling untouched.
					if (!trackBody || !response?.body) {
						done();
						return response;
					}
					const reader = response.body.getReader();
					let closed = false;
					let streamController: ReadableStreamDefaultController<Uint8Array>;
					abort = () => {
						if (closed) return;
						closed = true;
						streamController.error(new DOMException("Request cancelled", "AbortError"));
						void reader
							.cancel()
							.catch(() => {})
							.finally(done);
					};
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							streamController = controller;
						},
						async pull(controller) {
							try {
								const result = await reader.read();
								if (closed) return;
								if (result.done) {
									closed = true;
									controller.close();
									done();
								} else controller.enqueue(result.value);
							} catch (error) {
								if (!closed) {
									closed = true;
									controller.error(error);
								}
								done();
							}
						},
						async cancel(reason) {
							closed = true;
							try {
								await reader.cancel(reason);
							} finally {
								done();
							}
						},
					});
					request.signal.addEventListener("abort", onAbort, { once: true });
					if (request.signal.aborted) abort();
					return new Response(body, {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					});
				},
				(error) => {
					done();
					throw error;
				},
			);
		},
	};
}
export type ServerRequestLifecycle = ReturnType<typeof createServerRequestLifecycle>;
