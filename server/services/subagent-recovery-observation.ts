import { db } from "../db";
import { readQuery, readQueryFirst } from "../db/worker-read";
import { DbReadError } from "../lib/db-worker/errors";
import type { RuntimeStoreDb, RuntimeTx } from "./agent-runtime/mailbox-types";
import { RuntimeReadConflictError } from "./agent-runtime/read-conflict";
import type { RuntimeReadOptions } from "./agent-runtime/read-options";

type RecoveryQuery<T> = PromiseLike<T[]> & {
	toSQL(): { sql: string; params: unknown[] };
	all?(): T[];
	sync?(): T[];
};

function comparable(rows: readonly unknown[]): string {
	return JSON.stringify(rows.map((row) => JSON.stringify(row)).sort());
}

export class SubagentRecoveryObservation {
	private readonly checks: Array<(tx: RuntimeTx) => void> = [];
	constructor(private readonly options: RuntimeReadOptions = {}) {}

	private readOptions(maxRows: number) {
		return {
			signal: this.options.signal,
			deadlineAt: this.options.deadlineAt,
			timeoutMs: this.options.timeoutMs,
			executionPolicy: "worker-required" as const,
			maxRows,
		};
	}

	observe<T>(build: (store: RuntimeStoreDb) => RecoveryQuery<T>, rows: T[]): void {
		const expected = comparable(rows);
		this.checks.push((tx) => {
			const query = build(tx);
			const current = query.all ? query.all() : query.sync?.();
			if (!current || comparable(current) !== expected) throw new RuntimeReadConflictError();
		});
	}

	async all<T>(build: (store: RuntimeStoreDb) => RecoveryQuery<T>, maxRows = 1_000): Promise<T[]> {
		const rows = await readQuery(build(db), this.readOptions(maxRows));
		this.observe(build, rows);
		return rows;
	}

	async first<T>(build: (store: RuntimeStoreDb) => RecoveryQuery<T>): Promise<T | undefined> {
		const row = await readQueryFirst(build(db), this.readOptions(1));
		this.observe(build, row === undefined ? [] : [row]);
		return row;
	}

	async ids<T>(
		ids: readonly string[],
		build: (store: RuntimeStoreDb, batch: string[]) => RecoveryQuery<T>,
	): Promise<T[]> {
		const unique = [...new Set(ids)];
		const rows: T[] = [];
		for (let offset = 0; offset < unique.length; offset += 100) {
			const batch = unique.slice(offset, offset + 100);
			rows.push(...(await this.all((store) => build(store, batch))));
			if (rows.length > 10_000) throw new DbReadError("DB_READ_LIMIT", "Too many recovery rows");
		}
		return rows;
	}

	assert(tx: RuntimeTx): void {
		this.options.signal?.throwIfAborted();
		if (this.options.deadlineAt !== undefined && this.options.deadlineAt <= Date.now())
			throw new DbReadError("DB_READ_TASK_TIMEOUT", "Recovery observation deadline exceeded");
		for (const check of this.checks) check(tx);
	}
}
