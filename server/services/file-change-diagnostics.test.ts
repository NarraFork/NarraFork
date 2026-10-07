import { describe, expect, test } from "bun:test";
import {
	FileChangeDiagnostics,
	fileChangeDiagnosticMetadata,
	fileChangeDiagnosticSuffix,
	getFileChangeDiagnostics,
} from "./file-change-diagnostics";
import { LocalFileValidationError } from "./file-change-local-io";

describe("bounded file-change diagnostics", () => {
	test("separates coordinator, history, workspace and namespace admission from execution", () => {
		let now = 0;
		const trace = new FileChangeDiagnostics(() => now);
		trace.enter("resolve_source");
		now = 2;
		for (const stage of [
			"acquire_lease",
			"acquire_history_lock",
			"acquire_workspace_lock",
			"acquire_namespace_lock",
		] as const) {
			trace.enter(stage);
			now += 10;
		}
		trace.enter("io_write");
		now += 8;
		trace.finish();
		expect(trace.timing()).toEqual({ waitMs: 40, executionMs: 10, totalMs: 50 });
		now += 100;
		expect(trace.timing()).toEqual({ waitMs: 40, executionMs: 10, totalMs: 50 });
	});

	test("failure metadata preserves measured lock waiting instead of labelling it execution", () => {
		let now = 0;
		const trace = new FileChangeDiagnostics(() => now);
		trace.enter("acquire_namespace_lock");
		now = 700;
		trace.enter("io_write");
		now = 715;
		const error = new Error("failed IO");
		trace.fail(error);
		trace.finish();
		trace.attach(error);
		expect(fileChangeDiagnosticMetadata(error)?.fileChangeTiming).toEqual({
			waitMs: 700,
			executionMs: 15,
			totalMs: 715,
		});
	});
	test("zero-duration admission remains measured zero rather than missing", () => {
		const trace = new FileChangeDiagnostics(() => 0);
		trace.enter("acquire_namespace_lock");
		trace.enter("io_write");
		trace.finish();
		expect(trace.timing()).toEqual({ waitMs: 0, executionMs: 0, totalMs: 0 });
	});
	test("aggregates repeated stages and freezes elapsed time on finish", () => {
		let now = 10;
		const trace = new FileChangeDiagnostics(() => now);
		trace.enter("io_write");
		now = 20;
		trace.enter("io_sync");
		now = 24;
		trace.enter("io_write");
		now = 30;
		trace.finish();
		now = 90;
		expect(trace.snapshot()).toMatchObject({
			elapsedMs: 20,
			phases: [
				{ stage: "io_write", elapsedMs: 16, visits: 2 },
				{ stage: "io_sync", elapsedMs: 4, visits: 1 },
			],
		});
		trace.finish();
		expect(trace.snapshot().elapsedMs).toBe(20);
	});

	test("retains primary and secondary errors without retaining their free text", () => {
		const trace = new FileChangeDiagnostics();
		const first = new DOMException("secret file contents", "TimeoutError");
		trace.enter("io_final_read");
		trace.fail(first);
		trace.enter("after_read");
		trace.fail(Object.assign(new Error("/private/workspace/secret"), { code: "EIO" }));
		trace.identify({ sourceId: "call", operationId: "op", leaseId: "lease" });
		trace.finish();
		expect(trace.attach(first)).toBe(first);
		expect(first.message).toBe("secret file contents");
		expect(trace.hasFailure(first)).toBe(true);
		expect(getFileChangeDiagnostics(first)?.failures).toEqual([
			{ stage: "io_final_read", name: "TimeoutError" },
			{ stage: "after_read", name: "Error", code: "EIO" },
		]);
		expect(fileChangeDiagnosticSuffix(first)).toContain(
			"io_final_read(TimeoutError), after_read(EIO)",
		);
		expect(fileChangeDiagnosticSuffix(first)).toContain("operation=op; lease=lease");
		const serialized = JSON.stringify(fileChangeDiagnosticMetadata(first));
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("/private");
	});

	test("does not change validation error identity or custom fields", () => {
		const trace = new FileChangeDiagnostics();
		const error = new LocalFileValidationError("validation", "tool output");
		trace.enter("construct");
		trace.fail(error);
		expect(trace.attach(error)).toBe(error);
		expect(error.toolOutput).toBe("tool output");
		expect(error).toBeInstanceOf(LocalFileValidationError);
	});

	test("bounds repeated failures and ignores malicious diagnostic properties", () => {
		const trace = new FileChangeDiagnostics();
		trace.enter("io_write");
		const error = new Error("not logged");
		Object.defineProperty(error, "code", {
			get() {
				throw new Error("must not invoke code getter");
			},
		});
		for (let i = 0; i < 100; i++) trace.fail(error);
		const snapshot = trace.snapshot();
		expect(snapshot.failures).toHaveLength(8);
		expect(snapshot.droppedFailures).toBe(92);
		expect(snapshot.failures[0]).toEqual({ stage: "io_write", name: "Error" });
		snapshot.failures[0].name = "mutated";
		expect(trace.snapshot().failures[0].name).toBe("Error");
	});

	test("never invokes an error name getter or logs custom name/code labels", () => {
		const controller = new AbortController();
		let calls = 0;
		const error = new Error("secret contents");
		Object.defineProperty(error, "name", {
			get() {
				calls++;
				controller.abort();
				return "secret-file.txt";
			},
		});
		const trace = new FileChangeDiagnostics();
		trace.enter("io_sync");
		trace.fail(error);
		trace.fail(
			Object.assign(new Error("secret contents"), {
				name: "secret-file.txt",
				code: "secret-file.txt",
			}),
		);
		expect(calls).toBe(0);
		expect(controller.signal.aborted).toBe(false);
		expect(trace.snapshot().failures).toEqual([
			{ stage: "io_sync", name: "Error" },
			{ stage: "io_sync", name: "Error" },
		]);
		expect(JSON.stringify(trace.snapshot())).not.toContain("secret");
	});

	test("DOMException classification uses the native name without invoking overrides", () => {
		const error = new DOMException("private text", "TimeoutError");
		Object.defineProperty(error, "name", {
			get() {
				throw new Error("must not read override");
			},
		});
		const trace = new FileChangeDiagnostics();
		trace.enter("after_read");
		trace.fail(error);
		expect(trace.snapshot().failures).toEqual([{ stage: "after_read", name: "TimeoutError" }]);
	});

	test("primitive thrown values retain identity and remain log-only diagnostics", () => {
		for (const reason of ["cancelled", 42, null, undefined, false, Symbol("cancelled")]) {
			const trace = new FileChangeDiagnostics();
			trace.enter("verify_result");
			trace.fail(reason);
			expect(trace.attach(reason)).toBe(reason);
			expect(getFileChangeDiagnostics(reason)).toBeUndefined();
			expect(trace.snapshot().failures).toEqual([{ stage: "verify_result", name: "UnknownError" }]);
		}
	});
	test("unrelated errors do not gain diagnostic text or metadata", () => {
		const error = new Error("normal");
		expect(getFileChangeDiagnostics(error)).toBeUndefined();
		expect(fileChangeDiagnosticSuffix(error)).toBe("");
		expect(fileChangeDiagnosticMetadata(error)).toBeUndefined();
	});
});
