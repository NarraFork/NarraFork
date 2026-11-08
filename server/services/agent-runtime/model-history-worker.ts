// Never import db/index: this thread has only an independent read-only connection.

import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { type ModelHistoryManifest, queryModelHistoryDelta } from "./model-history-delta";
import {
	type ModelHistoryCounters,
	type ModelHistoryQueryOptions,
	postgresHistorySql,
	queryModelHistory,
	sqliteHistoryQuery,
} from "./model-history-query";
import {
	type ModelHistorySignature,
	readPostgresModelHistorySignature,
	readSqliteModelHistorySignature,
} from "./model-history-revision";

declare const self: Worker;

type Request = Omit<ModelHistoryQueryOptions, "signal"> & {
	previous?: ModelHistoryManifest;
	previousCatalogIdentity?: string;
} & ({ backend: "sqlite"; path: string } | { backend: "postgres"; url: string });
let acknowledge: (() => void) | undefined;
const sendPage = (message: unknown) =>
	new Promise<void>((resolve) => {
		acknowledge = resolve;
		postMessage(message);
	});
self.onmessage = async (event: MessageEvent<Request | { type: "ack" }>) => {
	const request = event.data;
	if ("type" in request) {
		acknowledge?.();
		acknowledge = undefined;
		return;
	}
	try {
		let completed:
			| {
					counters: ModelHistoryCounters;
					compactSeq?: number | null;
					signature?: ModelHistorySignature;
			  }
			| undefined;
		// The first read pins the transaction snapshot, so the signature labels exactly the rows
		// read after it. Writes landing meanwhile belong to the next snapshot, not to this one.
		const pin = (signature: ModelHistorySignature) => {
			if (request.previous && signature.catalogIdentity !== request.previousCatalogIdentity)
				throw new Error("Model history delta structure changed");
			return signature;
		};
		if (request.backend === "sqlite") {
			const connection = new Database(request.path, { readonly: true });
			try {
				connection.run("PRAGMA busy_timeout = 50");
				connection.run("PRAGMA cache_size = -4096");
				connection.run("BEGIN");
				const signature = request.versioned
					? pin(readSqliteModelHistorySignature(connection, request.narratorId))
					: undefined;
				const query = sqliteHistoryQuery(connection);
				completed = {
					...(request.previous
						? await queryModelHistoryDelta(query, request, request.previous, sendPage)
						: await queryModelHistory(
								query,
								request,
								(rows) => sendPage({ type: "page", rows }),
								(rows) => sendPage({ type: "tools", rows }),
							)),
					signature,
				};
				connection.run("COMMIT");
			} finally {
				connection.close();
			}
		} else {
			const sql = new SQL(request.url, { max: 1, connectTimeout: 2 });
			try {
				completed = await sql.begin(async (tx) => {
					await tx.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
					const signature = request.versioned
						? pin(await readPostgresModelHistorySignature(tx, request.narratorId))
						: undefined;
					const query = async <T>(statement: string, parameters: unknown[] = []) =>
						(await tx.unsafe(postgresHistorySql(statement), parameters as string[])) as T[];
					return {
						...(request.previous
							? await queryModelHistoryDelta(query, request, request.previous, sendPage)
							: await queryModelHistory(
									query,
									request,
									(rows) => sendPage({ type: "page", rows }),
									(rows) => sendPage({ type: "tools", rows }),
								)),
						signature,
					};
				});
			} finally {
				await sql.close();
			}
		}
		if (!completed) throw new Error("Model history worker did not complete");
		// Close the independent DB/socket before announcing success; the parent may
		// terminate this worker as soon as it receives done.
		postMessage({
			type: "done",
			counters: completed.counters,
			compactSeq: completed.compactSeq,
			signature: completed.signature,
		});
	} catch (error) {
		// PG driver errors may contain connection secrets. Only forward our fixed budget errors.
		const message = error instanceof Error ? error.message : "";
		postMessage({
			type: "error",
			message: message.startsWith("Model history")
				? message
				: "Model history read-only worker failed",
		});
	}
};
