import type { Worker, WorkerOptions } from "node:worker_threads";
import { isCompiledRuntime } from "./runtime-target";
import { WorkerCleanupError, WorkerHandle } from "./worker-runtime/lifecycle";

/**
 * How to load a worker inside `bun build --compile`.
 *
 * Bun's own docs list `new Worker("./worker.ts")`, `new Worker(new URL(..., import.meta.url))`,
 * and the `.href` form as equivalent. In a compiled binary they are not:
 *
 * - Every module's `import.meta.url` is the executable (`file:///$bunfs/root/<name>` on
 *   Linux/macOS, `file:///C:/%7EBUN/root/<name>.exe` on Windows), not that module's source
 *   path. A sibling `./worker.ts` URL therefore does not name the worker file.
 * - Extra entry points are stored under the common directory of the compile entries, with
 *   `.ts` rewritten to `.js`. Production entries all live under `server/`, so
 *   `server/services/foo.ts` becomes `/$bunfs/root/services/foo.js`. A probe whose main
 *   entry sits outside `server/` keeps the prefix: `/$bunfs/root/server/services/foo.js`.
 *   One hard-coded path fails with `Cannot find module '/$bunfs/root/...'`.
 * - `new Worker("file://...")` throws synchronously ("Wrap file:// URLs with `new URL`").
 *   A `URL` object works for `$bunfs` on POSIX when the embedded key matches.
 * - On Windows, `new Worker(fileURL)` converts the URL to a backslash path and misses Bun's
 *   virtual key. Pass `C:/~BUN/root/...` with forward slashes and no scheme.
 * - A relative `./file.js` string is resolved against the process cwd on Bun 1.4, not against
 *   the embedded graph (oven-sh/bun#40619).
 *
 * See oven-sh/bun#15981, #29124, #36286, #40619, and #32730.
 */

/**
 * Extra `bun build --compile` entry points, relative to `server/`. `new Worker()` specifiers are
 * not followed by the bundler, so a worker missing here is absent from the binary.
 */
export const COMPILED_WORKER_ENTRIES = [
	"lib/db-worker/worker-entry.ts",
	"lib/fs-scan-worker/fs-scan-worker-entry.ts",
	"lib/browser/memory-snapshot-worker.ts",
	"lib/browser/memory-profile-worker.ts",
	"lib/share-preview-worker.ts",
	"lib/request-recorder-worker.ts",
	"lib/startup-status/worker.ts",
	"lib/agent/request-json-worker.ts",
	"lib/agent/image-generation-response-worker.ts",
	"services/editor-document-worker.ts",
	"services/editor-document-stream-worker.ts",
	"services/outline/edit-text-worker.ts",
	"services/git-untracked-line-worker.ts",
	"services/git-current-baseline-worker.ts",
	"services/agent-runtime/model-history-worker.ts",
	"services/narrator-prefix-snapshots-worker.ts",
	"services/revert-transaction-manifest-worker.ts",
	"services/token-recalculation-worker.ts",
] as const;

export type CompiledWorkerEntry = (typeof COMPILED_WORKER_ENTRIES)[number];

/** Arguments inserted after `./server/index.ts` in the production compile command. */
export function compiledWorkerBuildEntrypoints(): string[] {
	return COMPILED_WORKER_ENTRIES.map((path) => `./server/${path}`);
}

const WINDOWS_VIRTUAL_ROOT = /^\/[a-z]:\/(?:~BUN|%7eBUN)\/root\//i;

/**
 * Specifiers to try, most likely first.
 *
 * `serverRelativePath` is the worker under `server/` (`services/foo.ts`).
 * `devRelativePath` is relative to the caller's `moduleUrl` and is the only candidate in source
 * runs. Callers must pass their own `import.meta.url`: a default here would be this file.
 */
export function compiledWorkerSpecifiers(
	serverRelativePath: CompiledWorkerEntry,
	devRelativePath: string,
	moduleUrl: string,
	compiled = isCompiledRuntime(),
): string[] {
	if (!compiled) return [new URL(devRelativePath, moduleUrl).href];
	const embedded = serverRelativePath.replace(/\.ts$/, ".js");
	const base = embedded.slice(embedded.lastIndexOf("/") + 1);
	return [`./${embedded}`, `./server/${embedded}`, `./${base}`].map(
		(path) => new URL(path, moduleUrl).href,
	);
}

/**
 * Turn a specifier into the value `new Worker` accepts.
 * Real `file:` URLs stay URL objects. Windows `~BUN` keys stay forward-slash strings.
 * Absolute filesystem paths and `./` relatives pass through unchanged.
 */
export function workerEntryFromSpecifier(specifier: string): string | URL {
	let url: URL;
	try {
		url = new URL(specifier);
	} catch {
		return specifier;
	}
	if (url.protocol !== "file:") return specifier;
	if (WINDOWS_VIRTUAL_ROOT.test(url.pathname)) return decodeURIComponent(url.pathname.slice(1));
	return url;
}

/** Startup failures can be translated to an existing domain error without parsing log text. */
export class WorkerStartupError extends Error {
	constructor(
		readonly code: "TIMEOUT" | "EXITED",
		message: string,
	) {
		super(message);
		this.name = "WorkerStartupError";
	}
}

interface ConnectedResource<Resource> {
	worker: Resource;
	specifier: string;
	handle: WorkerHandle<Resource>;
}
export type ConnectedWorker = ConnectedResource<Worker>;
export type ConnectedBunWorker = ConnectedResource<globalThis.Worker>;

interface ConnectOptions {
	signal?: AbortSignal;
	/** Default total startup budget; also caps each individual attempt (default 5 seconds). */
	timeoutMs?: number;
	/** Optional operation deadline, shared with queueing/execution rather than restarted here. */
	deadlineAt?: number;
	isReady?: (message: unknown) => boolean;
	/** False for self-announcing workers whose first input must be the business request. */
	sendPing?: boolean;
}
export interface ConnectWorkerOptions extends ConnectOptions {
	workerOptions?: WorkerOptions;
}
export interface ConnectBunWorkerOptions extends ConnectOptions {
	workerOptions?: Bun.WorkerOptions;
}
type ListenForMessage<Resource> = (
	worker: Resource,
	listener: (message: unknown) => void,
) => () => void;
interface StartupWorker {
	postMessage(message: unknown): void;
}

// Candidate lists are fixed by trusted backend callers; no workers or task payloads are cached.
const resolvedWorkerSpecifiers = new Map<string, string>();

export function connectCompiledWorker(
	specifiers: readonly string[],
	options: ConnectWorkerOptions = {},
): Promise<ConnectedWorker> {
	return connectNativeWorker(
		specifiers,
		options,
		"node",
		(specifier) => WorkerHandle.thread(workerEntryFromSpecifier(specifier), options.workerOptions),
		(worker, listener) => {
			worker.on("message", listener);
			return () => {
				worker.off("message", listener);
			};
		},
	);
}

/** Native Bun/self workers keep their original file href and EventTarget message API. */
export function connectCompiledBunWorker(
	specifiers: readonly string[],
	options: ConnectBunWorkerOptions = {},
): Promise<ConnectedBunWorker> {
	return connectNativeWorker(
		specifiers,
		options,
		"bun",
		(specifier) => WorkerHandle.bunThread(specifier, options.workerOptions),
		(worker, listener) => {
			const receive = (event: MessageEvent<unknown>) => listener(event.data);
			worker.addEventListener("message", receive);
			return () => {
				worker.removeEventListener("message", receive);
			};
		},
	);
}

async function connectNativeWorker<Resource extends StartupWorker>(
	specifiers: readonly string[],
	options: ConnectOptions,
	transport: "node" | "bun",
	create: (specifier: string) => WorkerHandle<Resource>,
	listen: ListenForMessage<Resource>,
): Promise<ConnectedResource<Resource>> {
	const { signal } = options;
	signal?.throwIfAborted();
	const timeoutMs = options.timeoutMs ?? 5_000;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647)
		throw new RangeError("Worker ready timeout must be between 1 and 2147483647 ms");
	const deadlineAt = options.deadlineAt ?? Date.now() + timeoutMs;
	if (!Number.isFinite(deadlineAt)) throw new RangeError("Worker startup deadline must be finite");
	const isReady =
		options.isReady ??
		((message: unknown) =>
			!!message && typeof message === "object" && (message as { ready?: boolean }).ready === true);
	// The same URI may work under one native loader but not the other.
	const key = JSON.stringify([transport, ...specifiers]);
	const preferred = resolvedWorkerSpecifiers.get(key);
	const candidates = preferred
		? [preferred, ...specifiers.filter((specifier) => specifier !== preferred)]
		: specifiers;
	const failures: string[] = [];
	let lastFailure: unknown;
	for (const specifier of candidates) {
		signal?.throwIfAborted();
		const remaining = deadlineAt - Date.now();
		if (remaining <= 0) {
			const timeout = new WorkerStartupError("TIMEOUT", "worker startup deadline exceeded");
			lastFailure = timeout;
			failures.push(timeout.message);
			break;
		}
		let handle: WorkerHandle<Resource> | undefined;
		try {
			handle = create(specifier);
			await waitReady(
				handle,
				Math.min(timeoutMs, remaining),
				isReady,
				listen,
				signal,
				options.sendPing,
			);
			if (handle.closed)
				throw handle.error ?? new WorkerStartupError("EXITED", "worker exited before ready");
			if (specifiers.length > 1) resolvedWorkerSpecifiers.set(key, specifier);
			return { worker: handle.resource, specifier, handle };
		} catch (error) {
			// A failed stop hands ownership to the pool/caller, never to an untracked retry.
			if (handle) {
				try {
					await handle.close();
				} catch (cleanupError) {
					throw new WorkerCleanupError(handle, cleanupError);
				}
			}
			if (signal?.aborted) throw error;
			if (specifier === preferred) resolvedWorkerSpecifiers.delete(key);
			lastFailure = error;
			failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`No worker entry loaded (${failures.join(" | ")})`, { cause: lastFailure });
}

function waitReady<Resource extends StartupWorker>(
	handle: WorkerHandle<Resource>,
	timeoutMs: number,
	isReady: (message: unknown) => boolean,
	listen: ListenForMessage<Resource>,
	signal?: AbortSignal,
	sendPing = true,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let removeMessage: (() => void) | undefined;
		const finish = (error?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			removeMessage?.();
			if (error === undefined) resolve();
			else reject(error);
		};
		const onAbort = () => finish(signal?.reason ?? new Error("worker start aborted"));
		const onMessage = (message: unknown) => {
			try {
				if (isReady(message)) finish();
			} catch (error) {
				finish(error);
			}
		};
		const timer = setTimeout(
			() => finish(new WorkerStartupError("TIMEOUT", "worker did not become ready")),
			timeoutMs,
		);
		removeMessage = listen(handle.resource, onMessage);
		// The handle already owns native error/exit events for either transport. One startup
		// continuation is retained for its lifetime, never any task or business input.
		void handle.exited.then(
			() => finish(handle.error ?? new WorkerStartupError("EXITED", "worker exited before ready")),
			(error: unknown) => finish(error),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) return onAbort();
		if (handle.closed) {
			finish(handle.error ?? new WorkerStartupError("EXITED", "worker exited before ready"));
			return;
		}
		if (!sendPing) return;
		try {
			handle.resource.postMessage({ action: "ping" });
		} catch (error) {
			finish(error);
		}
	});
}
