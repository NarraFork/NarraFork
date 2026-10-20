import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash } from "node:crypto";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import type { SelectRowsParams } from "../lib/db-worker/protocol";
import { streamSelectRows } from "../lib/db-worker/select-rows";
import { AppError } from "../lib/errors";

export const REVERT_SELECTION_PAGE_ITEMS = 32;
export interface SourceCommitment {
	query: string;
	params: SQLQueryBindings[];
	digest: string;
}
export interface AssociationPageQuery {
	query: string;
	params: SQLQueryBindings[];
	/** A nonempty narrator page must return to the main-thread ACL check. */
	stopOnRows: boolean;
}
export interface AssociationPageRow {
	pageIndex: number;
	row: { id: string; cursor: number };
}
export type RevertSelectionReadTask = {
	kind: "revertSelectionReadV1";
	deadlineAt: number;
} & (
	| { action: "verify"; commitments: SourceCommitment[] }
	| { action: "associationPages"; queries: AssociationPageQuery[] }
);
export class RevertSelectionError extends AppError {
	constructor(code: string, message: string) {
		super(message, 409, `REVERT_SELECTION_${code}`);
		this.name = "RevertSelectionError";
	}
}
/** Preserve the collector's original JSON encoding, row order and newline framing. */
export function sourceRowsDigest(rows: Iterable<unknown>): string {
	const hash = createHash("sha256");
	for (const row of rows) hash.update(JSON.stringify(row)).update("\n");
	return hash.digest("hex");
}
/** Replays only internally recorded bounded SELECTs, each in its own original snapshot. */
export function executeRevertSelectionReadTask(
	connection: Database,
	task: RevertSelectionReadTask,
	signal: AbortSignal,
	consume?: (rows: unknown[], bytes: number) => Promise<void>,
): { checkedCount: number } | Promise<{ pageCount: number }> {
	const check = () => {
		signal.throwIfAborted();
		if (Date.now() >= task.deadlineAt)
			throw new DOMException("The operation timed out.", "TimeoutError");
	};
	check();
	if (connection.inTransaction)
		throw new RevertSelectionError(
			"AMBIENT_TRANSACTION",
			"Collection cannot hold an ambient transaction across yields",
		);
	if (task.action === "associationPages") {
		if (!consume) throw new Error("Association pages require a chunk consumer");
		return readAssociationPages(connection, task.queries, signal, check, consume);
	}
	const bytes = task.commitments.reduce(
		(sum, { query, params, digest }) =>
			sum + Buffer.byteLength(JSON.stringify([query, params])) + digest.length,
		0,
	);
	if (task.commitments.length > REVERT_SELECTION_PAGE_ITEMS || bytes > FILE_CHANGE_LIMITS.blobBytes)
		throw new RevertSelectionError("BUDGET_EXCEEDED", "Invalid or over-budget source commitments");
	for (const commitment of task.commitments) {
		check();
		if (!/^\s*(?:SELECT|WITH)\b/i.test(commitment.query))
			throw new RevertSelectionError(
				"INVALID_INPUT",
				"Selection verification requires a server-built SELECT",
			);
		const statement = connection.prepare(commitment.query);
		try {
			function* rows() {
				for (const row of statement.iterate(...commitment.params)) {
					check();
					yield row;
				}
			}
			if (sourceRowsDigest(rows()) !== commitment.digest)
				throw new RevertSelectionError(
					"STALE",
					"Selected source metadata changed during collection",
				);
		} finally {
			statement.finalize();
		}
	}
	check();
	return { checkedCount: task.commitments.length };
}

async function readAssociationPages(
	connection: Database,
	queries: AssociationPageQuery[],
	signal: AbortSignal,
	check: () => void,
	consume: (rows: unknown[], bytes: number) => Promise<void>,
): Promise<{ pageCount: number }> {
	// The existing fixed message/tool association lists contain at most eight pages.
	if (queries.length > 8)
		throw new RevertSelectionError("INVALID_INPUT", "Invalid association page batch");
	let pageCount = 0;
	for (const [pageIndex, page] of queries.entries()) {
		check();
		const result = await streamSelectRows(
			connection,
			{
				kind: "selectRowsV1",
				sql: page.query,
				params: page.params as SelectRowsParams["params"],
				mode: "objects",
			},
			signal,
			async (rows, bytes) => {
				check();
				// Reuse exactly the SELECT transport's chunk threshold and oversized-row behavior.
				await consume(
					rows.map((row) => ({ pageIndex, row })),
					bytes,
				);
			},
		);
		check();
		pageCount++;
		// Do not read across the collector's next pause/cursor or narrator ACL boundary.
		if (result.rows > REVERT_SELECTION_PAGE_ITEMS || (page.stopOnRows && result.rows > 0)) break;
	}
	return { pageCount };
}
