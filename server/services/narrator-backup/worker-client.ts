import { Worker } from "node:worker_threads";
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
/** Probe only BEFORE dispatch. After ready an import is NEVER replayed against a fallback entry. */
export async function startPrivateArchiveWorker(
	kind: PrivateArchiveWorkerKind,
	signal: AbortSignal,
	deadline: number,
): Promise<Worker> {
	for (const specifier of privateArchiveWorkerSpecifiers(kind)) {
		signal.throwIfAborted();
		if (Date.now() >= deadline) throw new Error("Backup worker startup timed out");
		const worker = new Worker(entryPoint(specifier));
		let timer: ReturnType<typeof setTimeout> | undefined;
		let abort = () => {};
		try {
			await new Promise<void>((resolve, reject) => {
				abort = () => reject(new Error("Backup worker startup cancelled"));
				signal.addEventListener("abort", abort, { once: true });
				timer = setTimeout(
					() => reject(new Error("Backup worker startup timed out")),
					Math.min(5000, deadline - Date.now()),
				);
				worker.once("message", (message: unknown) => {
					if (
						message &&
						typeof message === "object" &&
						"ready" in message &&
						message.ready === "private-archive-worker-v1"
					)
						resolve();
					else reject(new Error("Backup worker startup protocol failed"));
				});
				worker.once("error", () => reject(new Error("Backup worker unavailable")));
				worker.once("exit", () => reject(new Error("Backup worker unavailable")));
				if (signal.aborted) abort();
			});
			worker.removeAllListeners("error");
			worker.removeAllListeners("exit");
			return worker;
		} catch {
			await worker.terminate();
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
		}
	}
	throw new Error("Backup worker unavailable");
}
