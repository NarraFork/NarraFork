/**
 * shiki-token-worker-client.ts — Runs the token cache's highlights in a Worker.
 *
 * TextMate tokenization is synchronous once a grammar is loaded: a 20k-char body
 * blocks for 50-150ms. On the main thread that landed inside fast-scroll frames
 * every time a newly revealed code or diff row asked for colours, so the cache's
 * loader is routed here instead. The cache contract is unchanged — a loader that
 * resolves tokens or null — so callers keep painting plain text until colours land.
 *
 * Scheduling is newest-first with a small in-flight window: during a fast scroll
 * the rows just revealed matter more than rows the reader already passed, and the
 * window keeps the Worker busy without letting a long backlog delay visible rows.
 */

import type { ShikiTokenLoader } from "./shiki-token-cache";
import type {
	ShikiToken,
	ShikiTokenWorkerRequest,
	ShikiTokenWorkerResponse,
} from "./shiki-token-worker-protocol";

export interface ShikiTokenWorkerPort {
	postMessage(message: ShikiTokenWorkerRequest): void;
	terminate(): void;
	onmessage: ((event: MessageEvent<ShikiTokenWorkerResponse>) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
}

export interface ShikiTokenWorkerLoaderOptions {
	factory: () => ShikiTokenWorkerPort;
	/** Absolute, trailing-slash app mount URL the Worker resolves grammars against. */
	appBase: () => string;
	/** Main-thread loader used once the Worker cannot start at all. */
	fallback: ShikiTokenLoader;
	maxInFlight?: number;
	/** Queued requests beyond this drop the OLDEST (resolved as null). */
	maxQueued?: number;
	/** A request still running after this is abandoned and the Worker restarted. */
	watchdogMs?: number;
}

interface Job {
	code: string;
	lang: string;
	theme: string;
	resolve: (tokens: ShikiToken[][] | null) => void;
}

const DEFAULT_MAX_IN_FLIGHT = 2;
const DEFAULT_MAX_QUEUED = 64;
const DEFAULT_WATCHDOG_MS = 30_000;

export function createShikiTokenWorkerLoader(
	options: ShikiTokenWorkerLoaderOptions,
): ShikiTokenLoader {
	const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
	const maxQueued = options.maxQueued ?? DEFAULT_MAX_QUEUED;
	const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
	const queue: Job[] = [];
	const inFlight = new Map<number, { job: Job; timer: ReturnType<typeof setTimeout> }>();
	let worker: ShikiTokenWorkerPort | null = null;
	let disabled = false;
	let nextId = 1;

	const runFallback = (job: Job) => {
		let request: Promise<ShikiToken[][] | null>;
		try {
			request = options.fallback(job.code, job.lang, job.theme);
		} catch {
			job.resolve(null);
			return;
		}
		request.then(job.resolve, () => job.resolve(null));
	};

	const terminate = () => {
		const current = worker;
		worker = null;
		if (current) {
			current.onmessage = null;
			current.onerror = null;
			current.terminate();
		}
	};

	/** Take back every in-flight job (timers cleared) so it can be re-routed. */
	const reclaimInFlight = (): Job[] => {
		const jobs: Job[] = [];
		for (const entry of inFlight.values()) {
			clearTimeout(entry.timer);
			jobs.push(entry.job);
		}
		inFlight.clear();
		return jobs;
	};

	// The Worker itself cannot run (blocked, unsupported): keep highlighting on the
	// main thread rather than silently losing colours for the session.
	const disable = () => {
		disabled = true;
		terminate();
		for (const job of [...reclaimInFlight(), ...queue.splice(0)]) runFallback(job);
	};

	const port = (): ShikiTokenWorkerPort => {
		if (worker) return worker;
		const created = options.factory();
		created.onmessage = (event) => {
			const packet = event.data;
			settle(packet.id, packet.type === "tokens" ? packet.tokens : null);
		};
		created.onerror = disable;
		created.postMessage({ type: "boot", assetBase: options.appBase() });
		worker = created;
		return created;
	};

	const settle = (id: number, tokens: ShikiToken[][] | null) => {
		const entry = inFlight.get(id);
		if (!entry) return;
		inFlight.delete(id);
		clearTimeout(entry.timer);
		entry.job.resolve(tokens);
		pump();
	};

	const abandon = (id: number) => {
		const entry = inFlight.get(id);
		if (!entry) return;
		inFlight.delete(id);
		// A runaway grammar: give up on this body only. The Worker is blocked inside
		// it, so restart it and requeue whatever else it was holding.
		terminate();
		queue.push(...reclaimInFlight());
		entry.job.resolve(null);
		pump();
	};

	function pump() {
		while (!disabled && inFlight.size < maxInFlight && queue.length > 0) {
			// Newest first: the rows just revealed are the ones on screen.
			const job = queue.pop() as Job;
			const id = nextId++;
			inFlight.set(id, { job, timer: setTimeout(() => abandon(id), watchdogMs) });
			try {
				port().postMessage({
					type: "tokens",
					id,
					code: job.code,
					lang: job.lang,
					theme: job.theme,
				});
			} catch {
				disable();
			}
		}
	}

	return (code, lang, theme) => {
		if (disabled) return options.fallback(code, lang, theme);
		return new Promise((resolve) => {
			queue.push({ code, lang, theme, resolve });
			// Rows scrolled past long ago would only delay the visible ones. A dropped
			// row that is still mounted asks again on its next render.
			while (queue.length > maxQueued) queue.shift()?.resolve(null);
			pump();
		});
	};
}
