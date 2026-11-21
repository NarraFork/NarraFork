/**
 * Every SQLite authentication read goes through here: admitted FIFO, then run as a bounded
 * point lookup on the short-read Worker pool. Once dispatched, failures propagate; the read is
 * never retried on the main connection (`readQuery` only runs inline for in-memory databases
 * and open transactions, before dispatch).
 */
import { readQuery } from "@server/db/worker-read";
import { type AuthReadOptions, authReadAdmission } from "@server/lib/auth-read-admission";

export function authRead<T>(
	query: Parameters<typeof readQuery<T>>[0],
	{ signal, maxRows = 1 }: AuthReadOptions & { maxRows?: number } = {},
): Promise<T[]> {
	return authReadAdmission.run(
		(context) =>
			readQuery(query, {
				diagnosticSource: "auth.session",
				shortRead: true,
				maxRows,
				signal: context.signal,
				timeoutMs: context.timeoutMs,
			}),
		{ signal },
	);
}
