import type { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { hotSafe } from "@server/lib/hot-safe";
import { isCompiledRuntime } from "@server/lib/runtime-target";
export type PrivateArchiveWorkerKind = "backup" | "legacy-sync" | "legacy-import";
const paths = {
	backup: "narrator-backup/worker",
	"legacy-sync": "project-archive/legacy-sync-worker",
	"legacy-import": "project-archive/legacy-import-worker",
} as const;
export function privateArchiveWorkerSpecifiers(
	kind: PrivateArchiveWorkerKind,
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	const path = paths[kind];
	return (
		compiled
			? [`./services/${path}.js`, `./server/services/${path}.js`, `./${path.split("/").at(-1)}.js`]
			: [kind === "backup" ? "./worker.ts" : `../${path}.ts`]
	).map((specifier) => new URL(specifier, moduleUrl).href);
}
function entryPoint(specifier: string): URL | string {
	const url = new URL(specifier);
	if (url.protocol === "file:" && /^\/[a-z]:\/(?:~BUN|%7eBUN)\/root\//i.test(url.pathname))
		return decodeURIComponent(url.pathname.slice(1));
	return url;
}
type PrivateArchiveWorkerHandle = Pick<EventEmitter, "once" | "off"> & {
	terminate(): Promise<number>;
};

/** Independent lifecycle for fixture workers; production always uses the fixed Node factory below. */
export function createPrivateArchiveWorkerLifecycle<W extends PrivateArchiveWorkerHandle>(
	createWorker: (specifier: URL | string) => W,
) {
	type Entry = {
		onExit: () => void;
		cancelStartup?: () => void;
		termination?: Promise<void>;
	};
	const workers = new Map<W, Entry>();
	let closed = false;
	let shutdownPromise: Promise<void> | undefined;
	const assertOpen = () => {
		if (closed) throw new Error("Private archive workers are shutting down");
	};
	const forget = (worker: W, entry: Entry) => {
		workers.delete(worker);
		worker.off("exit", entry.onExit);
	};
	const terminate = (worker: W, entry: Entry): Promise<void> => {
		// Retain unknown workers on failure, and share the proof with an in-flight startup.
		entry.termination ??= Promise.resolve()
			.then(() => worker.terminate())
			.then(() => forget(worker, entry));
		return entry.termination;
	};

	/** Probe only BEFORE dispatch. A ready worker is never replayed against a fallback entry. */
	async function start(
		kind: PrivateArchiveWorkerKind,
		signal: AbortSignal,
		deadline: number,
	): Promise<W> {
		assertOpen();
		for (const specifier of privateArchiveWorkerSpecifiers(kind)) {
			assertOpen();
			signal.throwIfAborted();
			if (Date.now() >= deadline) throw new Error("Backup worker startup timed out");
			const worker = createWorker(entryPoint(specifier));
			const entry: Entry = { onExit: () => forget(worker, entry) };
			// Register BEFORE ready: startup and detached HTTP-202 jobs also hold DB handles.
			workers.set(worker, entry);
			worker.once("exit", entry.onExit);
			let timer: ReturnType<typeof setTimeout> | undefined;
			let abort = () => {};
			let onMessage = (_message: unknown) => {};
			let onError = () => {};
			let onExit = () => {};
			try {
				try {
					await new Promise<void>((resolve, reject) => {
						abort = () => reject(new Error("Backup worker startup cancelled"));
						entry.cancelStartup = () =>
							reject(new Error("Private archive workers are shutting down"));
						signal.addEventListener("abort", abort, { once: true });
						timer = setTimeout(
							() => reject(new Error("Backup worker startup timed out")),
							Math.min(5000, deadline - Date.now()),
						);
						onMessage = (message: unknown) => {
							if (
								message &&
								typeof message === "object" &&
								"ready" in message &&
								message.ready === "private-archive-worker-v1"
							)
								resolve();
							else reject(new Error("Backup worker startup protocol failed"));
						};
						onError = () => reject(new Error("Backup worker unavailable"));
						onExit = () => reject(new Error("Backup worker unavailable"));
						worker.once("message", onMessage);
						worker.once("error", onError);
						worker.once("exit", onExit);
						if (signal.aborted) abort();
					});
				} finally {
					clearTimeout(timer);
					signal.removeEventListener("abort", abort);
					worker.off("message", onMessage);
					worker.off("error", onError);
					worker.off("exit", onExit);
					entry.cancelStartup = undefined;
				}
				// Ready can race shutdown/exit before this continuation gets a turn.
				assertOpen();
				if (!workers.has(worker)) throw new Error("Backup worker unavailable");
				return worker;
			} catch {
				if (workers.has(worker)) await terminate(worker, entry);
				assertOpen();
			}
		}
		throw new Error("Backup worker unavailable");
	}

	function shutdown(): Promise<void> {
		if (shutdownPromise) return shutdownPromise;
		closed = true;
		const terminations = [...workers].map(([worker, entry]) => {
			entry.cancelStartup?.();
			return terminate(worker, entry);
		});
		shutdownPromise = Promise.allSettled(terminations).then((results) => {
			const failures = results.filter((result) => result.status === "rejected");
			if (failures.length) {
				throw new AggregateError(
					failures.map((failure) => failure.reason),
					"Private archive worker termination failed",
				);
			}
		});
		return shutdownPromise;
	}

	return { start, shutdown };
}

// Keep both registry and closed admission across Bun --hot module re-evaluation.
const privateArchiveWorkers = hotSafe("narrafork.privateArchiveWorkers.v1", () =>
	createPrivateArchiveWorkerLifecycle((specifier) => new Worker(specifier)),
);
export const startPrivateArchiveWorker = privateArchiveWorkers.start;
export const shutdownPrivateArchiveWorkers = privateArchiveWorkers.shutdown;
