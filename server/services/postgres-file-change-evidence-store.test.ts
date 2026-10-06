import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	fileChangeEffects,
	fileChangeOperations,
	narratorToolCalls,
} from "@server/db/postgres-schema";
import { getTableColumns, getTableName, type SQL, type Table } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { PgDialect } from "drizzle-orm/pg-core";
import type { BeginFileChangeOperation, FileChangeNoDispatchProof } from "./file-change-evidence";
import { PostgresFileChangeEvidenceStore } from "./postgres-file-change-evidence-store";

/** Adapter contract, NOT a live PostgreSQL integration test. No connection is opened.
 * The real store builds Drizzle SQL and owns the async transaction boundary. This
 * deliberately narrow transaction model evaluates the generated equality/null CAS,
 * projects the real schema columns, and rolls back all writes on callback rejection.
 * It cannot establish PostgreSQL lock scheduling, network retries or isolation. */
type Row = Record<string, unknown>;
type Projection = Record<string, { name: string }>;
const dialect = new PgDialect();
const timestamp = "2026-10-05T12:00:00.000Z";
const target = {
	cwd: "/workspace",
	pathFlavor: "posix",
	lexicalPath: "/workspace/example.ts",
	canonicalPath: "/workspace/example.ts",
};
function input(): BeginFileChangeOperation {
	return {
		sourceInstanceId: "installation",
		sourceKind: "tool",
		sourceId: "tool-pk",
		toolCallId: "tool-pk",
		toolUseId: "provider-id",
		narratorId: "narrator",
		attempt: 1,
		requestDigest: createHash("sha256").update("fixed request and target").digest("hex"),
		expectedEffectCount: 1,
		actor: {
			kind: "primary",
			subjectKey: "human:alice",
			narratorId: "narrator",
			userId: "alice",
			label: "Alice",
			deleted: false,
			parentSubjectKey: null,
		},
		executionBinding: {
			deviceId: "local",
			runtimeEpoch: "epoch",
			runtimeGeneration: 7,
			fencingToken: 4,
		},
	};
}
function tool(overrides: Row = {}): Row {
	return {
		id: "tool-pk",
		narratorId: "narrator",
		toolUseId: "provider-id",
		toolName: "StructSed",
		executionIdentityVersion: 1,
		executionOriginToolCallId: null,
		isFileHistoryCheckpoint: false,
		executionAttempt: 1,
		status: "running",
		executionStartedAt: timestamp,
		executionDeviceId: "local",
		runtimeGeneration: 7,
		executionCwd: target.cwd,
		executionPathFlavor: target.pathFlavor,
		resolvedFilePath: target.lexicalPath,
		canonicalFilePath: target.canonicalPath,
		fileChangeOperationId: null,
		...overrides,
	};
}

class Selection implements PromiseLike<Row[]> {
	private table!: Table;
	private condition?: SQL;
	private maximum = Number.MAX_SAFE_INTEGER;
	constructor(
		private readonly model: TransactionModel,
		private readonly projection?: Projection,
	) {}
	from(table: Table) {
		this.table = table;
		return this;
	}
	where(condition: SQL) {
		this.condition = condition;
		return this;
	}
	limit(maximum: number) {
		this.maximum = maximum;
		return this;
	}
	for(lock: string) {
		expect(lock).toBe("update");
		this.model.locks++;
		return this;
	}
	// biome-ignore lint/suspicious/noThenProperty: Drizzle SELECT builders are intentionally awaitable.
	then<TResult1 = Row[], TResult2 = never>(
		onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	): PromiseLike<TResult1 | TResult2> {
		const rows = this.model
			.rows(this.table)
			.filter((row) => this.model.matches(this.table, row, this.condition))
			.slice(0, this.maximum)
			.map((row) => this.model.project(this.table, row, this.projection));
		return Promise.resolve(rows).then(onfulfilled, onrejected);
	}
}
class TransactionModel {
	private tables = new Map<string, Row[]>([
		[getTableName(narratorToolCalls), [tool(), tool({ id: "other-pk" })]],
		[getTableName(fileChangeOperations), []],
		[getTableName(fileChangeEffects), []],
	]);
	readonly cas: ReturnType<PgDialect["sqlToQuery"]>[] = [];
	locks = 0;
	commits = 0;
	rollbacks = 0;
	beforeCas?: (row: Row) => void;
	rows(table: Table) {
		return this.tables.get(getTableName(table)) ?? [];
	}
	get tool() {
		return this.rows(narratorToolCalls)[0];
	}
	get operations() {
		return this.rows(fileChangeOperations);
	}
	project(table: Table, row: Row, projection?: Projection): Row {
		if (!projection) return structuredClone(row);
		const columns = Object.entries(getTableColumns(table));
		return Object.fromEntries(
			Object.entries(projection).map(([alias, column]) => {
				const property = columns.find(([, candidate]) => candidate.name === column.name)?.[0];
				if (!property) throw new Error(`Unknown projected column: ${column.name}`);
				return [alias, row[property]];
			}),
		);
	}
	matches(table: Table, row: Row, condition?: SQL): boolean {
		if (!condition) return true;
		const query = dialect.sqlToQuery(condition);
		// Fail closed if the producer changes this small model's predicate vocabulary.
		const remainder = query.sql
			.replace(/"[^"]+"\."[^"]+"\s*(?:=\s*\$\d+|is null)/g, "")
			.replace(/\band\b|\btrue\b|[()\s]/g, "");
		if (remainder) throw new Error(`Unsupported predicate: ${query.sql}`);
		const columns = Object.entries(getTableColumns(table));
		const value = (name: string) => {
			const property = columns.find(([, column]) => column.name === name)?.[0];
			if (!property) throw new Error(`Unknown predicate column: ${name}`);
			return row[property];
		};
		for (const match of query.sql.matchAll(/"[^"]+"\."([^"]+)"\s*=\s*\$(\d+)/g))
			if (value(match[1]) !== query.params[Number(match[2]) - 1]) return false;
		for (const match of query.sql.matchAll(/"[^"]+"\."([^"]+)"\s+is null/g))
			if (value(match[1]) !== null) return false;
		return true;
	}
	private tx() {
		return {
			select: (projection?: Projection) => new Selection(this, projection),
			insert: (table: Table) => ({
				values: (values: Row) => ({
					returning: async () => {
						const row = structuredClone(values);
						this.rows(table).push(row);
						return [structuredClone(row)];
					},
				}),
			}),
			update: (table: Table) => ({
				set: (values: Row) => ({
					where: (condition: SQL) => ({
						returning: async (projection?: Projection) => {
							this.cas.push(dialect.sqlToQuery(condition));
							this.beforeCas?.(this.tool);
							const rows = this.rows(table).filter((row) => this.matches(table, row, condition));
							for (const row of rows) Object.assign(row, values);
							return rows.map((row) => this.project(table, row, projection));
						},
					}),
				}),
			}),
		};
	}
	readonly database = {
		transaction: async <T>(
			callback: (tx: ReturnType<TransactionModel["tx"]>) => Promise<T>,
		): Promise<T> => {
			const original = structuredClone(this.tables);
			try {
				const result = await callback(this.tx());
				this.commits++;
				return result;
			} catch (error) {
				this.tables = original;
				this.rollbacks++;
				throw error;
			}
		},
	} as unknown as BunSQLDatabase;
}
function setup() {
	const model = new TransactionModel();
	return { model, store: new PostgresFileChangeEvidenceStore(model.database, () => timestamp) };
}
async function refusal(pending: Promise<unknown>, code: string) {
	const outcome = await pending.then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
	expect(outcome).toHaveProperty("error");
	if (!("error" in outcome)) throw new Error("Expected adapter refusal");
	expect(outcome.error).toMatchObject({ code: `FILE_CHANGE_${code}` });
}
const preview: FileChangeNoDispatchProof = {
	targetDispatched: false,
	reason: "preview",
	frozenTarget: target,
};

describe("PostgreSQL no_dispatch adapter contract (transaction model, no live PostgreSQL)", () => {
	test("StructSed preview is succeeded, strictly zero-effect, bound and repeat-idempotent", async () => {
		const { model, store } = setup();
		const operation = await store.beginNoDispatchOperation(input(), preview);
		expect(operation).toMatchObject({
			executionOutcome: "succeeded",
			reason: "no_dispatch:preview",
			effectOutcome: "no_change",
			settlement: "settled",
			coverage: "complete",
			expectedEffectCount: 0,
			preparedEffectCount: 0,
			settledEffectCount: 0,
			unresolvedEffectCount: 0,
			evidenceBytes: 0,
		});
		expect(model.rows(fileChangeEffects)).toEqual([]);
		expect(model.tool.fileChangeOperationId).toBe(operation.id);
		expect(model.rows(narratorToolCalls)[1].fileChangeOperationId).toBeNull();
		expect(model.cas[0].params).toEqual(["tool-pk", 1, "running", timestamp, "local", 7]);
		expect(model.cas[0].sql).toContain('"file_change_operation_id" is null');
		expect(await store.beginNoDispatchOperation(input(), preview)).toEqual(operation);
		expect(model.operations).toHaveLength(1);
		expect(model.cas).toHaveLength(1);
		expect(model.commits).toBe(2);
		expect(model.locks).toBe(2);
	});

	test.each([
		"running",
		"fail",
	] as const)("permission-terminal %s beforeInvocation closes an unstarted allocated attempt", async (status) => {
		const { model, store } = setup();
		Object.assign(model.tool, { status, executionStartedAt: null });
		const proof: FileChangeNoDispatchProof = {
			targetDispatched: false,
			reason: "invocation_rejected",
			frozenTarget: target,
			beforeInvocation: { status, observedStatus: "running", executionStartedAt: null },
		};
		const operation = await store.beginNoDispatchOperation(input(), proof);
		expect(operation).toMatchObject({
			executionOutcome: "failed",
			reason: "no_dispatch:invocation_rejected",
			expectedEffectCount: 0,
		});
		expect(model.tool).toMatchObject({
			status: "fail",
			executionStartedAt: null,
			executionAttempt: 1,
			fileChangeOperationId: operation.id,
		});
		const cas = model.cas[0];
		expect(cas.params).toEqual(["tool-pk", 1, status, "local", 7]);
		for (const name of [
			"id",
			"execution_attempt",
			"status",
			"execution_device_id",
			"runtime_generation",
		])
			expect(cas.sql).toMatch(new RegExp(`"${name}" = \\$\\d+`));
		for (const name of ["execution_started_at", "file_change_operation_id"])
			expect(cas.sql).toContain(`"${name}" is null`);
		expect(
			await store.beginNoDispatchOperation(input(), {
				...proof,
				beforeInvocation: { status: "fail", observedStatus: "running", executionStartedAt: null },
			}),
		).toEqual(operation);
	});

	test.each([
		["wrong attempt", { executionAttempt: 2 }],
		["wrong device", { executionDeviceId: "remote" }],
		["wrong generation", { runtimeGeneration: 8 }],
		["wrong frozen target", { canonicalFilePath: "/elsewhere/file" }],
	] as const)("%s cannot produce or link a zero-effect journal", async (_label, change) => {
		const { model, store } = setup();
		Object.assign(model.tool, change);
		await refusal(store.beginNoDispatchOperation(input(), preview), "IDENTITY_CONFLICT");
		expect(model.operations).toEqual([]);
		expect(model.tool.fileChangeOperationId).toBeNull();
		expect(model.cas).toEqual([]);
		expect(model.rollbacks).toBe(1);
	});

	test("fail status alone without invocation-observed status cannot prove no dispatch", async () => {
		const { model, store } = setup();
		Object.assign(model.tool, { status: "fail", executionStartedAt: null });
		await refusal(
			store.beginNoDispatchOperation(input(), {
				targetDispatched: false,
				reason: "invocation_rejected",
				frozenTarget: target,
				beforeInvocation: { status: "fail", executionStartedAt: null },
			}),
			"INVALID_TRANSITION",
		);
		expect(model.operations).toEqual([]);
	});

	test("a previously recorded attempt with effects cannot be converted to zero effects", async () => {
		const { model, store } = setup();
		const operation = await store.beginNoDispatchOperation(input(), preview);
		model.rows(fileChangeEffects).push({ id: "persisted-effect", operationId: operation.id });
		const before = structuredClone(model.operations);
		await refusal(store.beginNoDispatchOperation(input(), preview), "REQUEST_CONFLICT");
		expect(model.operations).toEqual(before);
		expect(model.rows(fileChangeEffects)).toHaveLength(1);
		expect(model.cas).toHaveLength(1);
	});

	test.each([
		["PK", { id: "different-pk" }],
		["attempt", { executionAttempt: 2 }],
		["status", { status: "success" }],
		["execution claim", { executionStartedAt: timestamp }],
		["device", { executionDeviceId: "remote" }],
		["generation", { runtimeGeneration: 8 }],
		["existing link", { fileChangeOperationId: "other-operation" }],
	] as const)("CAS races on %s roll back the preceding operation insert", async (_label, change) => {
		const { model, store } = setup();
		Object.assign(model.tool, { status: "running", executionStartedAt: null });
		const before = structuredClone(model.tool);
		model.beforeCas = (row) => Object.assign(row, change);
		await refusal(
			store.beginNoDispatchOperation(input(), {
				targetDispatched: false,
				reason: "invocation_rejected",
				frozenTarget: target,
				beforeInvocation: {
					status: "running",
					observedStatus: "running",
					executionStartedAt: null,
				},
			}),
			"REQUEST_CONFLICT",
		);
		expect(model.cas).toHaveLength(1);
		expect(model.operations).toEqual([]);
		expect(model.tool).toEqual(before);
		expect(model.rollbacks).toBe(1);
		expect(model.commits).toBe(0);
		model.beforeCas = undefined;
		const retry = await store.beginNoDispatchOperation(input(), {
			targetDispatched: false,
			reason: "invocation_rejected",
			frozenTarget: target,
			beforeInvocation: { status: "running", observedStatus: "running", executionStartedAt: null },
		});
		expect(model.operations).toHaveLength(1);
		expect(model.tool.fileChangeOperationId).toBe(retry.id);
	});
});
