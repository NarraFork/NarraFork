import { readQuery } from "../../db/worker-read";
import { DbReadError } from "../../lib/db-worker/errors";
import type { KnowledgeReadOptions } from "./read-store";

/** Finite business limits are collected without truncating the caller's requested rows. */
export async function readKnowledgePages<T>(
	limit: number,
	pageSize: number,
	query: (
		offset: number,
		size: number,
	) => PromiseLike<T[]> & { toSQL(): { sql: string; params: unknown[] } },
	options: KnowledgeReadOptions = {},
): Promise<T[]> {
	if (
		!Number.isSafeInteger(limit) ||
		limit < 0 ||
		limit > 10_000 ||
		!Number.isSafeInteger(pageSize) ||
		pageSize < 1 ||
		pageSize > 128
	)
		throw new Error("Invalid knowledge read page budget");
	const rows: T[] = [];
	let bytes = 0;
	const deadlineAt = options.deadlineAt ?? Date.now() + (options.timeoutMs ?? 30_000);
	for (let offset = 0; offset < limit; offset += pageSize) {
		const size = Math.min(pageSize, limit - offset);
		const page = await readQuery(query(offset, size), {
			...options,
			deadlineAt,
			executionPolicy: "worker-required",
			maxRows: size,
		});
		bytes += Buffer.byteLength(JSON.stringify(page));
		if (bytes > 64 * 1024 * 1024)
			throw new DbReadError("DB_READ_BUDGET", "Knowledge pages exceed their result byte budget");
		rows.push(...page);
		if (page.length < size) break;
	}
	return rows;
}

/** Preserve all requested identities while keeping each statement below the bind limit. */
export async function readKnowledgeIds<T>(
	ids: readonly string[],
	read: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
	if (ids.length > 10_000)
		throw new DbReadError("DB_READ_BUDGET", "Knowledge identity lookup exceeds its input budget");
	const unique = [...new Set(ids)];
	const rows: T[] = [];
	for (let offset = 0; offset < unique.length; offset += 100)
		rows.push(...(await read(unique.slice(offset, offset + 100))));
	return rows;
}
