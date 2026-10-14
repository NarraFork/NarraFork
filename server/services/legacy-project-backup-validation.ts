import { Worker } from "node:worker_threads";
import { hotSafe } from "../lib/hot-safe";

// Keep failed-to-exit readers counted across hot reloads. Never create an unbounded worker queue.
const readers = hotSafe<Set<Worker>>("narrafork.legacyBackupValidationReaders", () => new Set());

/** A filename is not deletion authority. Validate privately, then wait for the reader to exit. */
export async function validateLegacyProjectBackup(
	path: string,
	projectId: string,
): Promise<boolean> {
	if (readers.size >= 2) return false;
	const worker = new Worker(
		new URL("./legacy-project-backup-validation-worker.ts", import.meta.url),
		{ workerData: { path, projectId } },
	);
	readers.add(worker);
	worker.once("exit", () => readers.delete(worker));
	const valid = await new Promise<boolean>((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		const finish = (value: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		timer = setTimeout(() => finish(false), 5_000);
		worker.once("message", (message: unknown) =>
			finish(
				!!message && typeof message === "object" && "valid" in message && message.valid === true,
			),
		);
		worker.once("error", () => finish(false));
		worker.once("exit", () => finish(false));
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const exited = await Promise.race([
		worker.terminate().then(
			() => true,
			() => false,
		),
		new Promise<false>((resolve) => {
			timeout = setTimeout(() => resolve(false), 1_000);
		}),
	]);
	clearTimeout(timeout);
	// Unconfirmed termination is never sufficient evidence to unlink a file the reader may use.
	return valid && exited;
}
