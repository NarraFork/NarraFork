/**
 * SQLite authentication reads are admitted FIFO and executed as bounded point lookups on the
 * short-read Worker pool. Admission and execution share one deadline; reads never fall back.
 */
import { readQuery } from "@server/db/worker-read";
import { type AuthReadOptions, authReadAdmission } from "@server/lib/auth-read-admission";

export function authRead<T>(
	query: Parameters<typeof readQuery<T>>[0],
	{ signal, deadlineAt, maxRows = 1 }: AuthReadOptions & { maxRows?: number } = {},
): Promise<T[]> {
	return authReadAdmission.run(
		(context) =>
			readQuery(query, {
				executionPolicy: "worker-required",
				diagnosticSource: "auth.session",
				shortRead: true,
				maxRows,
				signal: context.signal,
				timeoutMs: context.timeoutMs,
			}),
		{ signal, deadlineAt },
	);
}
