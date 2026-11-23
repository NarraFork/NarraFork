import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { DOMAIN_READ_DEFINITIONS } from "./domain-protocol";
import { runDomainRead } from "./domain-task-registry";
import { DbReadError, errorFromWorkerFailure, readAborted, workerFailure } from "./errors";
import {
	attachDbReadAbortDiagnostics,
	type DbReadAbortDiagnostics,
	getDbReadAbortDiagnostics,
} from "./read-diagnostics";
import { decodeReadBinds, encodeReadBinds } from "./select-extended";

test("lazy domain loading cannot start SQL after its absolute deadline", async () => {
	const database = new Database(":memory:");
	const transaction = spyOn(database, "transaction");
	let clock = 0;
	const now = spyOn(Date, "now").mockImplementation(() => clock);
	try {
		const read = runDomainRead(
			database,
			{ kind: "domainRead", task: "readerProbe", input: null },
			new AbortController().signal,
			50,
		);
		clock = 100;
		await expect(read).rejects.toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		expect(transaction).not.toHaveBeenCalled();
	} finally {
		now.mockRestore();
		transaction.mockRestore();
		database.close(true);
	}
});

test("encoded BLOB owns only the charged view bytes", () => {
	const source = new Uint8Array(1024 * 1024);
	source[500000] = 7;
	const view = source.subarray(500000, 500002);
	const encoded = encodeReadBinds([view])[0];
	if (!encoded || typeof encoded !== "object" || encoded.type !== "blob")
		throw new Error("Expected encoded BLOB");
	expect(encoded.value.byteLength).toBe(2);
	expect(encoded.value.buffer.byteLength).toBe(2);
	view.fill(9);
	expect(encoded.value[0]).toBe(7);
	const large = new Uint8Array(128 * 1024 + 1);
	expect(encodeReadBinds([large])).toEqual([{ type: "blob", value: large }]);
	const decoded = decodeReadBinds({
		kind: "selectValues",
		sql: "SELECT ?",
		params: [{ type: "blob", value: source.subarray(500000, 500002) }],
		maxRows: 1,
	});
	expect((decoded[0] as Uint8Array).buffer.byteLength).toBe(2);
	expect(encodeReadBinds([-(1n << 63n), (1n << 63n) - 1n])).toEqual([
		{ type: "bigint", value: "-9223372036854775808" },
		{ type: "bigint", value: "9223372036854775807" },
	]);
	for (const illegal of [1n << 63n, -(1n << 63n) - 1n, NaN, Infinity, {}])
		expect(() => encodeReadBinds([illegal] as never)).toThrow("Invalid read query");
	for (const params of [
		[{ type: "bigint", value: "9223372036854775808" }],
		[{ type: "blob", value: [] }],
		[{ type: "arbitrary", value: "private" }],
	])
		expect(() =>
			decodeReadBinds({ kind: "selectValues", sql: "SELECT ?", params, maxRows: 1 } as never),
		).toThrow("Invalid read query");
});

describe("host read-abort diagnostics", () => {
	const context = {
		kind: "domainRead",
		domainTask: "readerProbe",
		phase: "running",
		taskId: "dbr-test-1",
	} as const;

	test("stores an immutable snapshot without changing the exception or its wire envelope", () => {
		const error = readAborted();
		const originalProperties = Object.getOwnPropertyDescriptors(error);
		const originalWire = workerFailure(error);
		attachDbReadAbortDiagnostics(error, context);
		const snapshot = getDbReadAbortDiagnostics(error);
		expect(snapshot).toEqual(context);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.getOwnPropertyDescriptors(error)).toEqual(originalProperties);
		expect(workerFailure(error)).toEqual(originalWire);
		expect(workerFailure(error)).toEqual({
			code: "DB_READ_ABORTED",
			message: "database read task aborted",
		});
		const restored = errorFromWorkerFailure({ ...originalWire, ...context } as never);
		expect(restored).toBeInstanceOf(DbReadError);
		expect(restored).toMatchObject({ code: "DB_READ_ABORTED", name: "DbReadError" });
		expect(getDbReadAbortDiagnostics(restored)).toBeUndefined();
		expect(restored).not.toHaveProperty("taskId");
		expect(restored).not.toHaveProperty("domainTask");
		expect(JSON.stringify(error)).not.toContain("readerProbe");
	});

	test("uses only the first execution context and snapshots caller-owned metadata", () => {
		const error = readAborted();
		const input: DbReadAbortDiagnostics = { ...context };
		attachDbReadAbortDiagnostics(error, input);
		Object.assign(input, { taskId: "dbr-other-2", domainTask: "narratorBodyTexts" });
		attachDbReadAbortDiagnostics(error, { kind: "selectRows", phase: "admission" });
		expect(getDbReadAbortDiagnostics(error)).toEqual(context);
	});

	test("accepts only real aborted read errors and preserves business prototypes and transport", () => {
		for (const error of [
			new Error("aborted"),
			{ code: "DB_READ_ABORTED", name: "DbReadError" },
			Object.assign(new Error("aborted"), { code: "DB_READ_ABORTED" }),
			new DbReadError("DB_READ_FAILED", "database read failed"),
			new AppError("business cancellation", 409, "DB_READ_ABORTED"),
			new NotFoundError("Message", "missing"),
			new ValidationError("Selection is required", "SELECTION_REQUIRED"),
			new ForbiddenError(),
			null,
			undefined,
		]) {
			const wire = workerFailure(error);
			const prototype = error instanceof Error ? Object.getPrototypeOf(error) : undefined;
			attachDbReadAbortDiagnostics(error, context);
			expect(getDbReadAbortDiagnostics(error)).toBeUndefined();
			expect(workerFailure(error)).toEqual(wire);
			if (error instanceof Error) expect(Object.getPrototypeOf(error)).toBe(prototype);
			if (error instanceof AppError) {
				const restored = errorFromWorkerFailure(wire);
				expect(Object.getPrototypeOf(restored)).toBe(prototype);
				expect(getDbReadAbortDiagnostics(restored)).toBeUndefined();
			}
		}
	});

	test("domain labels must be own registered definitions and are omitted for other kinds", () => {
		for (const domainTask of Object.keys(DOMAIN_READ_DEFINITIONS) as Array<
			keyof typeof DOMAIN_READ_DEFINITIONS
		>) {
			const error = readAborted();
			attachDbReadAbortDiagnostics(error, { ...context, domainTask });
			expect(getDbReadAbortDiagnostics(error)?.domainTask).toBe(domainTask);
		}
		for (const domainTask of [
			"toString",
			"__proto__",
			"SELECT private FROM secret",
			"unknownTask",
		]) {
			const error = readAborted();
			attachDbReadAbortDiagnostics(error, { ...context, domainTask } as never);
			expect(getDbReadAbortDiagnostics(error)).toEqual({
				kind: "domainRead",
				phase: "running",
				taskId: context.taskId,
			});
		}
		const error = readAborted();
		attachDbReadAbortDiagnostics(error, { ...context, kind: "selectRows" });
		expect(getDbReadAbortDiagnostics(error)).toEqual({
			kind: "selectRows",
			phase: "running",
			taskId: context.taskId,
		});
	});

	test("omits unallocated or malformed task IDs and rejects arbitrary kinds and phases", () => {
		for (const taskId of [
			undefined,
			"",
			"SELECT private",
			"/private/database.db",
			"dbr-a-secret!",
			"dbr-",
		]) {
			const error = readAborted();
			attachDbReadAbortDiagnostics(error, { ...context, taskId });
			expect(getDbReadAbortDiagnostics(error)).toEqual({
				kind: "domainRead",
				domainTask: "readerProbe",
				phase: "running",
			});
		}
		for (const input of [
			{ ...context, kind: "private-label" },
			{ ...context, phase: "private-phase" },
			{ ...context, kind: "toString" },
		]) {
			const error = readAborted();
			attachDbReadAbortDiagnostics(error, input as never);
			expect(getDbReadAbortDiagnostics(error)).toBeUndefined();
		}
	});

	test("does not inspect SQL, parameters, paths, reason, remote objects or arbitrary error properties", () => {
		const error = readAborted();
		const unexpected = () => {
			throw new Error("diagnostics inspected private content");
		};
		const input = { ...context };
		for (const key of [
			"sql",
			"binds",
			"params",
			"dbPath",
			"diagnosticSource",
			"reason",
			"remoteError",
		]) {
			Object.defineProperty(input, key, { get: unexpected, enumerable: true });
			Object.defineProperty(error, key, { get: unexpected, enumerable: true });
		}
		expect(() => attachDbReadAbortDiagnostics(error, input)).not.toThrow();
		expect(getDbReadAbortDiagnostics(error)).toEqual(context);
		expect(workerFailure(error)).toEqual({
			code: "DB_READ_ABORTED",
			message: "database read task aborted",
		});
	});

	test("malformed diagnostics never replace an exception and getters remain best-effort", () => {
		const error = readAborted();
		const input = Object.defineProperty({}, "kind", {
			get: () => {
				throw new Error("diagnostic metadata failed");
			},
		});
		expect(() => attachDbReadAbortDiagnostics(error, input as never)).not.toThrow();
		expect(getDbReadAbortDiagnostics(error)).toBeUndefined();
		expect(error).toMatchObject({
			code: "DB_READ_ABORTED",
			message: "database read task aborted",
		});
		const inaccessible = Proxy.revocable(readAborted(), {});
		inaccessible.revoke();
		expect(() => attachDbReadAbortDiagnostics(inaccessible.proxy, context)).not.toThrow();
		expect(getDbReadAbortDiagnostics(inaccessible.proxy)).toBeUndefined();
	});
});

describe("read worker error transport", () => {
	test("SQLite execution codes survive without exposing driver messages", () => {
		const database = new Database(":memory:");
		try {
			let error: unknown;
			try {
				database.query("SELECT private_column FROM private_table").all();
			} catch (failure) {
				error = failure;
			}
			expect(error).toBeInstanceOf(Error);
			expect(workerFailure(error)).toEqual({
				code: "SQLITE_ERROR",
				message: "database read worker query failed",
			});
			expect(
				workerFailure(Object.assign(new Error("private"), { code: "SQLITE_PRIVATE" })),
			).toEqual({ code: "DB_READ_FAILED", message: "database read worker query failed" });
		} finally {
			database.close();
		}
	});
	test("known not-found errors retain prototype status code and localization", () => {
		const original = new NotFoundError("Message", "missing");
		const wire = workerFailure(original);
		const error = errorFromWorkerFailure(wire);
		expect(error).toBeInstanceOf(NotFoundError);
		expect(error).toBeInstanceOf(AppError);
		expect(error).toMatchObject({
			statusCode: 404,
			code: "NOT_FOUND",
			messageCode: original.messageCode,
			messageParams: original.messageParams,
			message: original.message,
		});
		expect(wire).not.toHaveProperty("stack");
	});
	test("known validation and forbidden prototypes retain their constrained semantics", () => {
		expect(
			errorFromWorkerFailure(
				workerFailure(new ValidationError("Selection is required", "SELECTION_REQUIRED")),
			),
		).toBeInstanceOf(ValidationError);
		expect(errorFromWorkerFailure(workerFailure(new ForbiddenError()))).toBeInstanceOf(
			ForbiddenError,
		);
	});
	test("business conflict and payload-size failures remain 409 and 413", () => {
		for (const statusCode of [409, 413]) {
			const original = new AppError("Bounded domain failure", statusCode, "DOMAIN_REJECTED");
			const restored = errorFromWorkerFailure(workerFailure(original));
			expect(restored).toBeInstanceOf(AppError);
			expect(restored).toMatchObject({
				statusCode,
				code: original.code,
				message: original.message,
			});
		}
	});
	test("native and internal error details never cross the worker boundary", () => {
		for (const original of [
			new Error("SELECT secret FROM private_table WHERE token = password"),
			new AppError("SQL contains private credentials", 500, "INTERNAL_ERROR"),
			Object.assign(new Error("private SQL"), { statusCode: 404, code: "NOT_FOUND" }),
		]) {
			const wire = workerFailure(original);
			expect(wire).toEqual({
				code: "DB_READ_FAILED",
				message: "database read worker query failed",
			});
			expect(JSON.stringify(wire)).not.toContain("private");
		}
	});
	test("infrastructure classifications are retained without restoring arbitrary constructors", () => {
		expect(
			workerFailure(new DbReadError("DB_READ_BUDGET", "Bounded read exceeded its budget")),
		).toEqual({ code: "DB_READ_BUDGET", message: "Bounded read exceeded its budget" });
		const restored = errorFromWorkerFailure(
			workerFailure(new DbReadError("DB_READ_BUDGET", "Bounded read exceeded its budget")),
		);
		expect(restored).toBeInstanceOf(DbReadError);
		expect(restored).toMatchObject({ code: "DB_READ_BUDGET" });
		const forged = errorFromWorkerFailure({
			message: "Known failure",
			statusCode: 409,
			code: "DOMAIN_REJECTED",
			errorType: "Function",
		} as never);
		expect(forged.constructor).toBe(AppError);
	});
});
