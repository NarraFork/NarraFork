import { parentPort } from "node:worker_threads";
import { openDatabase } from "../db/connection";
import { withDbRetry } from "../lib/db-resilience";
import type {
	TokenRecalculationCursor,
	TokenRecalculationScope,
	TokenRecalculationStore,
	TokenRecalculationUpdate,
} from "./token-recalculation";
import { createSqliteTokenRecalculationStore } from "./token-recalculation-sqlite";

export type TokenRecalculationWorkerRequest =
	| { action: "init"; id: number; dbPath: string }
	| {
			action: "scan";
			id: number;
			scope: TokenRecalculationScope;
			cursor?: TokenRecalculationCursor;
	  }
	| { action: "apply"; id: number; updates: TokenRecalculationUpdate[] }
	| { action: "close"; id: number }
	| { action: "ping" };

let store: TokenRecalculationStore | undefined;
parentPort?.on("message", async (message: TokenRecalculationWorkerRequest) => {
	if (message.action === "ping") {
		parentPort?.postMessage({ ready: true });
		return;
	}
	try {
		let result: unknown;
		if (message.action === "init") {
			if (store) throw new Error("Token recalculation worker already initialized");
			const database = openDatabase(message.dbPath);
			database.run("PRAGMA busy_timeout = 50");
			store = createSqliteTokenRecalculationStore(database);
		} else if (store) {
			const activeStore = store;
			if (message.action === "scan") result = await activeStore.scan(message.scope, message.cursor);
			else if (message.action === "apply")
				result = await withDbRetry(() => activeStore.apply(message.updates), {
					label: "token-recalculation-batch",
				});
			else {
				await store.close();
				store = undefined;
			}
		} else throw new Error("Token recalculation worker not initialized");
		parentPort?.postMessage({ id: message.id, result });
	} catch (error) {
		parentPort?.postMessage({
			id: message.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
});
