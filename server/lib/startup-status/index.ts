/**
 * Startup status page, startup-thread side.
 *
 * Before `./main` loads, a worker thread listens on the configured port and shows what startup is
 * doing — chiefly a long database upgrade, which runs synchronously on this thread. `./main`
 * closes it right before binding the port itself. When startup fails, the same page shows why,
 * and the process waits briefly for an open page to read it before exiting.
 *
 * Best effort throughout: when the worker cannot listen there is simply no page, and the real
 * server reports the port problem as it always has.
 */

import type { Worker } from "node:worker_threads";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../compiled-worker";
import { logger } from "../logger";
import type {
	FromStatusWorker,
	StartupProblem,
	StartupSnapshot,
	StartupStep,
	StatusListenTarget,
	ToStatusWorker,
} from "./protocol";

/** How long a failed startup waits at most for a page to read why. */
const PROBLEM_LINGER_MS = 30_000;
/** Binding answers at once; a worker that never answers must not hold up startup. */
const LISTEN_REPLY_MS = 5_000;

let worker: Worker | undefined;
let snapshot: StartupSnapshot | undefined;

function next(worker: Worker, accept: (message: FromStatusWorker) => boolean) {
	return new Promise<FromStatusWorker>((resolve) => {
		const onMessage = (message: FromStatusWorker) => {
			if (!accept(message)) return;
			worker.off("message", onMessage);
			resolve(message);
		};
		worker.on("message", onMessage);
	});
}

/** Listen on `target` and answer with the status page. Resolves to whether it is listening. */
export async function startStartupStatus(
	target: StatusListenTarget,
	{ version, brandName }: { version: string; brandName: string },
): Promise<boolean> {
	const initial: StartupSnapshot = {
		version,
		step: { key: "starting" },
		stepStartedAt: Date.now(),
	};
	let started: Worker | undefined;
	try {
		({ worker: started } = await connectCompiledWorker(
			compiledWorkerSpecifiers("lib/startup-status/worker.ts", "./worker.ts", import.meta.url),
		));
		const reply = next(started, (message) => message.type !== "problem-shown");
		started.postMessage({
			type: "listen",
			target,
			snapshot: initial,
			brandName,
		} satisfies ToStatusWorker);
		const result = await Promise.race([
			reply,
			Bun.sleep(LISTEN_REPLY_MS).then(() => ({ type: "unavailable", error: "no reply" }) as const),
		]);
		if (result.type === "unavailable") throw new Error(result.error);
		// The page is a convenience; it must never keep a finished process alive.
		started.unref();
		// Windows can report a bind failure after `listen` returned. Without a listener that error
		// would be rethrown on this thread and end startup; with it, startup just loses the page.
		const current = started;
		const drop = (reason: string) => {
			if (worker !== current) return;
			logger.warn("Startup status page stopped; continuing without it", { reason });
			worker = undefined;
			snapshot = undefined;
		};
		current.on("error", (error) => drop(String(error)));
		current.on("exit", (code) => drop(`worker exited with ${code}`));
		worker = current;
		snapshot = initial;
		return true;
	} catch (error) {
		// Usually the port is taken; the real server then moves on or reports why not.
		logger.info("Startup status page unavailable; continuing without it", {
			error: String(error),
		});
		await started?.terminate();
		return false;
	}
}

/**
 * A browser is being opened on the page. A failure is then worth waiting for, so the person who
 * started NarraFork sees why; on a headless server nobody would, and exiting at once is better.
 */
export function expectStartupViewer(): void {
	worker?.postMessage({ type: "expect-viewer" } satisfies ToStatusWorker);
}

function update(next: StartupSnapshot): void {
	snapshot = next;
	worker?.postMessage({ type: "update", snapshot } satisfies ToStatusWorker);
}

export function reportStartupStep(step: StartupStep): void {
	if (worker && snapshot) update({ ...snapshot, step, stepStartedAt: Date.now() });
}

/** Free the port for the real server. Terminating the thread closes its listener. */
export async function closeStartupStatus(): Promise<void> {
	const closing = worker;
	worker = undefined;
	snapshot = undefined;
	await closing?.terminate();
}

/**
 * Show why startup failed and, when a page is open or being opened, give it the chance to read
 * that before the process exits. Returns at once when there is no status page.
 */
export async function showStartupProblem(problem: StartupProblem): Promise<void> {
	if (!worker || !snapshot) return;
	const shown = next(worker, (message) => message.type === "problem-shown");
	update({ ...snapshot, problem });
	await Promise.race([shown, Bun.sleep(PROBLEM_LINGER_MS)]);
}
