import { compiledWorkerSpecifiers, connectCompiledWorker } from "../lib/compiled-worker";
import {
	TOKEN_RECALCULATION_BATCH_TIMEOUT_MS,
	type TokenRecalculationBatchResult,
	type TokenRecalculationRow,
	type TokenRecalculationStore,
} from "./token-recalculation";
import type { TokenRecalculationWorkerRequest } from "./token-recalculation-worker";

type Request = Exclude<TokenRecalculationWorkerRequest, { action: "ping" }>;
type RequestInput = Request extends infer R ? (R extends Request ? Omit<R, "id"> : never) : never;

export async function createTokenRecalculationWorkerStore(
	dbPath: string,
	signal?: AbortSignal,
): Promise<TokenRecalculationStore> {
	const { worker } = await connectCompiledWorker(
		compiledWorkerSpecifiers(
			"services/token-recalculation-worker.ts",
			"./token-recalculation-worker.ts",
			import.meta.url,
		),
		{
			signal: AbortSignal.any([
				...(signal ? [signal] : []),
				AbortSignal.timeout(TOKEN_RECALCULATION_BATCH_TIMEOUT_MS),
			]),
		},
	);
	let sequence = 0;
	let stopped = false;
	let termination: Promise<number> | undefined;
	let pending:
		| { id: number; resolve(value: unknown): void; reject(error: Error): void }
		| undefined;
	function stop() {
		stopped = true;
		termination ??= worker.terminate();
		return termination;
	}
	worker.on("message", (message: { id?: number; result?: unknown; error?: string }) => {
		if (!pending || message.id !== pending.id) return;
		if (message.error) pending.reject(new Error(message.error));
		else pending.resolve(message.result);
	});
	worker.on("error", (error) => {
		stopped = true;
		pending?.reject(error instanceof Error ? error : new Error(String(error)));
	});
	worker.on("exit", () => {
		stopped = true;
		pending?.reject(new Error("Token recalculation worker exited"));
	});
	function call<T>(request: RequestInput): Promise<T> {
		if (stopped) return Promise.reject(new Error("Token recalculation worker is closed"));
		if (pending) return Promise.reject(new Error("Token recalculation batches must be serial"));
		return new Promise<T>((resolve, reject) => {
			const id = ++sequence;
			const finish = (error?: Error, value?: unknown) => {
				clearTimeout(timer);
				pending = undefined;
				if (error) reject(error);
				else resolve(value as T);
			};
			const timer = setTimeout(() => {
				void stop();
				finish(new Error("Token recalculation batch timed out"));
			}, TOKEN_RECALCULATION_BATCH_TIMEOUT_MS);
			pending = {
				id,
				resolve: (value) => finish(undefined, value),
				reject: (error) => finish(error),
			};
			try {
				worker.postMessage({ ...request, id });
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}
	try {
		await call({ action: "init", dbPath });
	} catch (error) {
		await stop();
		throw error;
	}
	return {
		scan: (scope, cursor) => call<TokenRecalculationRow[]>({ action: "scan", scope, cursor }),
		apply: (updates) => call<TokenRecalculationBatchResult>({ action: "apply", updates }),
		async close() {
			try {
				if (!stopped) await call({ action: "close" });
			} finally {
				await stop();
			}
		},
	};
}
