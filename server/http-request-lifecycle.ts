import { AsyncLocalStorage } from "node:async_hooks";
import { isUnattendedShutdownFenced } from "./lib/shutdown-activity";

const requestWork = new AsyncLocalStorage<Promise<unknown>[]>();

/** Keep a streaming operation tracked even if the client cancels its response. */
export function trackStreamingRequestWork<T>(run: (stream: T) => Promise<void>) {
	return (stream: T) => {
		const work = run(stream);
		requestWork.getStore()?.push(work);
		return work;
	};
}

/** Completion is the end/cancellation of the body, not the creation of Response. */
export function createServerRequestLifecycle() {
	const context = new AsyncLocalStorage<number>();
	const active = new Map<number, { completion: Promise<void>; abort: () => void }>();
	let accepting = true;
	let sequence = 0;
	return {
		context,
		get accepting() {
			return accepting && !isUnattendedShutdownFenced();
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
		run(
			id: number,
			request: Request,
			execute: () => Promise<Response | undefined>,
			trackBody: boolean,
		) {
			const work: Promise<unknown>[] = [];
			const execution = context.run(id, () => requestWork.run(work, execute));
			return this.track(id, request, execution, trackBody, work);
		},
		track(
			id: number,
			request: Request,
			execution: Promise<Response | undefined>,
			trackBody = false,
			work: Promise<unknown>[] = [],
		) {
			let finish!: () => void;
			let abort = () => {};
			const completion = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const finishRequest = () => {
				request.signal.removeEventListener("abort", onAbort);
				active.delete(id);
				finish();
			};
			const done = () => {
				if (work.length) void Promise.allSettled(work).then(finishRequest);
				else finishRequest();
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
