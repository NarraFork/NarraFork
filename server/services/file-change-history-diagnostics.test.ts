import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	attachFileHistoryBudgetDiagnostic,
	attachFileHistoryCatalogDiagnostic,
	FileHistoryNamespaceDiagnostics,
	fileHistoryCatalogDiagnostic,
} from "./file-change-history-diagnostics";

const currentKey = "b".repeat(64);
const storedKey = "a".repeat(64);
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
const identity = {
	sourceInstanceId: "private-source-instance",
	root: "/private/history/root",
	directoryIdentity: "51:51:125",
	namespaceKey: currentKey,
};

function harness() {
	let now = 0;
	const logs: Record<string, unknown>[] = [];
	const diagnostics = new FileHistoryNamespaceDiagnostics({
		now: () => now,
		log: (message, fields) => {
			expect(message).toBe("File history namespace diagnostic");
			logs.push(fields);
		},
	});
	return { diagnostics, logs, advance: (value: number) => (now = value) };
}

describe("file history namespace diagnostics", () => {
	test("sidecar preserves the exact exception and only exposes bounded whitelisted metadata", () => {
		const error = Object.freeze(new Error("original"));
		const keys = Reflect.ownKeys(error);
		expect(
			attachFileHistoryCatalogDiagnostic(error, {
				stage: "initialize",
				reason: "key_mismatch",
				currentKey,
				row: {
					namespaceKey: storedKey,
					status: "ready",
					generation: 2,
					updatedAt: "2026-10-31 03:54:39",
					sql: "SELECT secret",
					content: "secret file content",
				},
			}),
		).toBe(error);
		expect(Reflect.ownKeys(error)).toEqual(keys);
		expect(fileHistoryCatalogDiagnostic(error)).toEqual({
			errorCode: "namespace_mismatch",
			errorName: "FileChangeBlobCatalogError",
			catalogStage: "initialize",
			reason: "key_mismatch",
			keysEqual: false,
			storedKeyFingerprint: fingerprint(storedKey),
			currentKeyFingerprint: fingerprint(currentKey),
			status: "ready",
			generation: 2,
			updatedAt: "2026-10-31 03:54:39",
		});
		expect(Object.isFrozen(fileHistoryCatalogDiagnostic(error))).toBe(true);
		expect(JSON.stringify(error)).toBe("{}");
	});

	test.each([
		NaN,
		Infinity,
		-1,
		0.5,
		Number.MAX_SAFE_INTEGER + 1,
	])("invalid row values including generation %s cannot enter diagnostic fields", (generation) => {
		const error = attachFileHistoryCatalogDiagnostic(new Error(), {
			stage: "budget_read",
			reason: "key_mismatch",
			currentKey: "/private/current",
			row: {
				namespaceKey: "/private/stored",
				status: "sensitive".repeat(1000),
				updatedAt: "SQL secret".repeat(1000),
				generation,
			},
		});
		expect(fileHistoryCatalogDiagnostic(error)).toEqual({
			errorCode: "namespace_mismatch",
			errorName: "FileChangeBlobCatalogError",
			catalogStage: "budget_read",
			reason: "key_mismatch",
			keysEqual: false,
		});
	});

	test("diagnostic formatting failures do not replace or modify the original error", () => {
		const error = new Error("original failure");
		expect(
			attachFileHistoryCatalogDiagnostic(error, {
				stage: "initialize",
				reason: "budget_id",
				currentKey,
				row: {
					get namespaceKey() {
						throw new Error("diagnostic access failed");
					},
				},
			}),
		).toBe(error);
		expect(error.message).toBe("original failure");
		expect(fileHistoryCatalogDiagnostic(error)).toBeUndefined();
		for (const value of [null, undefined, "error", 1, false, new Error()])
			expect(fileHistoryCatalogDiagnostic(value)).toBeUndefined();
	});

	test("existing AggregateError causes retain sidecars through bounded getter-free lookup", () => {
		const original = attachFileHistoryCatalogDiagnostic(new Error("accounting failed"), {
			stage: "publication_accounting",
			reason: "key_mismatch",
			currentKey,
			row: { namespaceKey: storedKey },
		});
		const wrapped = new AggregateError([original], "existing BlobStore wrapper", {
			cause: original,
		});
		expect(fileHistoryCatalogDiagnostic(wrapped)).toBe(fileHistoryCatalogDiagnostic(original));
		let getters = 0;
		expect(
			fileHistoryCatalogDiagnostic({
				get cause() {
					getters++;
					return original;
				},
			}),
		).toBeUndefined();
		expect(getters).toBe(0);
		const cycle: { cause?: unknown } = {};
		cycle.cause = cycle;
		expect(fileHistoryCatalogDiagnostic(cycle)).toBeUndefined();
		let descriptorTraps = 0;
		let prototypeTraps = 0;
		const proxy = new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					descriptorTraps++;
					throw new Error("introspection failed");
				},
				getPrototypeOf() {
					prototypeTraps++;
					throw new Error("prototype inspection failed");
				},
			},
		);
		expect(fileHistoryCatalogDiagnostic(proxy)).toBeUndefined();
		const proxyCause = new Error("wrapped proxy", { cause: proxy });
		expect(fileHistoryCatalogDiagnostic(proxyCause)).toBeUndefined();
		for (const error of [proxy, proxyCause]) {
			const { diagnostics, logs } = harness();
			diagnostics.failure("initialize", error);
			expect(logs[0]).toMatchObject({
				errorCode: "unknown",
				errorName: error === proxy ? "unknown" : "Error",
			});
		}
		expect(descriptorTraps).toBe(0);
		expect(prototypeTraps).toBe(0);
		const threeWrappers = new Error("outer", { cause: new Error("middle", { cause: wrapped }) });
		expect(fileHistoryCatalogDiagnostic(threeWrappers)).toBe(
			fileHistoryCatalogDiagnostic(original),
		);
		expect(
			fileHistoryCatalogDiagnostic(new Error("too deep", { cause: threeWrappers })),
		).toBeUndefined();
	});

	test("controlled catalog and budget labels preserve exception properties without reading their labels", () => {
		let getters = 0;
		const original = Object.defineProperties(new Error("private catalog error"), {
			name: {
				get() {
					getters++;
					throw new Error("name getter");
				},
			},
			code: {
				get() {
					getters++;
					throw new Error("code getter");
				},
			},
		});
		attachFileHistoryCatalogDiagnostic(original, {
			stage: "initialize",
			reason: "key_mismatch",
			currentKey,
		});
		const catalog = harness();
		catalog.diagnostics.failure("initialize", original);
		expect(catalog.logs[0]).toMatchObject({
			errorCode: "namespace_mismatch",
			errorName: "FileChangeBlobCatalogError",
		});
		expect(getters).toBe(0);
		const timeout = Object.freeze(new Error("File history preparation budget exceeded"));
		const keys = Reflect.ownKeys(timeout);
		expect(attachFileHistoryBudgetDiagnostic(timeout)).toBe(timeout);
		expect(Reflect.ownKeys(timeout)).toEqual(keys);
		expect(timeout.message).toBe("File history preparation budget exceeded");
		expect(Object.getOwnPropertyDescriptor(timeout, "code")).toBeUndefined();
		const budget = harness();
		budget.diagnostics.failure("initialize", new Error("wrapper", { cause: timeout }));
		expect(budget.logs[0]).toMatchObject({
			errorCode: "history_budget_exceeded",
			errorName: "Error",
		});
	});

	test("other failure labels use fixed categories and skip getters and proxy prototypes", () => {
		const known = harness();
		known.diagnostics.failure(
			"initialize",
			Object.assign(new Error("private details"), { code: "EACCES" }),
		);
		expect(known.logs[0]).toMatchObject({ errorCode: "EACCES", errorName: "Error" });
		const unknown = harness();
		unknown.diagnostics.failure("initialize", {
			name: "private-name-token",
			code: "private-code-token",
		});
		expect(unknown.logs[0]).toMatchObject({ errorCode: "unknown", errorName: "unknown" });
		expect(JSON.stringify(unknown.logs)).not.toContain("private-");
		const unmarked = harness();
		unmarked.diagnostics.failure(
			"initialize",
			new Error("File history preparation budget exceeded"),
		);
		expect(unmarked.logs[0]).toMatchObject({ errorCode: "unknown", errorName: "Error" });
		let getters = 0;
		const accessor = {
			get name() {
				getters++;
				return "Error";
			},
			get code() {
				getters++;
				return "EACCES";
			},
			get cause() {
				getters++;
				return new Error();
			},
		};
		let traps = 0;
		const prototype = new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error("descriptor trap");
				},
				getPrototypeOf() {
					traps++;
					throw new Error("prototype trap");
				},
			},
		);
		for (const error of [accessor, Object.create(prototype)]) {
			const { diagnostics, logs } = harness();
			diagnostics.failure("initialize", error);
			expect(logs[0]).toMatchObject({ errorCode: "unknown", errorName: "unknown" });
		}
		expect(getters).toBe(0);
		expect(traps).toBe(0);
	});

	test("identity summaries are process-scoped, field-separated and reuse only supplied inputs", () => {
		const first = harness();
		const second = harness();
		first.diagnostics.rememberIdentity(identity);
		second.diagnostics.rememberIdentity({ ...identity, root: `${identity.root}/changed` });
		expect(first.logs).toEqual([]);
		first.diagnostics.failure("initialize", new Error("secret failure"));
		second.diagnostics.failure("publish_before", new Error());
		expect(first.logs[0]).toMatchObject({
			identityScope: "process",
			keyFingerprintScope: "cross_process",
			namespaceKeyAlgorithm: "sha256-length-prefixed-v1",
			identityFingerprintAlgorithm: "hmac-sha256-field-v1",
			currentKeyFingerprint: fingerprint(currentKey),
			birthtimeAvailable: true,
			bunVersion: Bun.version,
		});
		for (const field of [
			"identityScopeId",
			"sourceFingerprint",
			"directoryFingerprint",
			"deviceFingerprint",
			"inodeFingerprint",
			"birthtimeFingerprint",
		])
			expect(first.logs[0][field]).toBe(second.logs[0][field]);
		expect(first.logs[0].rootFingerprint).not.toBe(second.logs[0].rootFingerprint);
		expect(first.logs[0].deviceFingerprint).not.toBe(first.logs[0].inodeFingerprint);
		for (const sensitive of Object.values(identity))
			expect(JSON.stringify(first.logs)).not.toContain(sensitive);
		expect(JSON.stringify(first.logs)).not.toContain("secret failure");
	});

	test("unavailable birthtime and context clearing are explicit without retaining raw inputs", () => {
		const { diagnostics, logs, advance } = harness();
		diagnostics.rememberIdentity({ ...identity, directoryIdentity: "1:2:0" });
		diagnostics.failure("initialize", null);
		expect(logs[0].birthtimeAvailable).toBe(false);
		diagnostics.clearIdentity();
		advance(60_000);
		diagnostics.failure("initialize", null);
		expect(logs[1].sourceFingerprint).toBeUndefined();
		expect(logs[1].currentKeyFingerprint).toBeUndefined();
	});

	test("first failure is immediate and the exact 60 second boundary reports accumulated failures", () => {
		const { diagnostics, logs, advance } = harness();
		diagnostics.failure("initialize", null);
		expect(logs).toHaveLength(1);
		expect(logs[0].failureCount).toBe(1);
		advance(59_999);
		diagnostics.failure("publish_before", null);
		diagnostics.failure("read_after", null);
		expect(logs).toHaveLength(1);
		advance(60_000);
		diagnostics.failure("finish_operation", null);
		expect(logs).toHaveLength(2);
		expect(logs[1]).toMatchObject({ historyStage: "finish_operation", failureCount: 3 });
		advance(120_000);
		diagnostics.failure("record_effect", null);
		expect(logs[2].failureCount).toBe(1);
	});

	test("many arbitrary failures retain a fixed-size runtime state", () => {
		const { diagnostics, logs, advance } = harness();
		diagnostics.failure("initialize", null);
		const fields = Reflect.ownKeys(diagnostics);
		for (let index = 0; index < 10_000; index++)
			diagnostics.failure("publish_before", new Error(`source-${index}`));
		expect(Reflect.ownKeys(diagnostics)).toEqual(fields);
		expect(
			Object.values(diagnostics).some((value) => value instanceof Map || Array.isArray(value)),
		).toBe(false);
		advance(60_000);
		diagnostics.failure("publish_before", null);
		expect(logs[1].failureCount).toBe(10_001);
	});

	test("logger and clock faults are contained, and failed log attempts still consume the interval", () => {
		let now = 0;
		let attempts = 0;
		let count = 0;
		const diagnostics = new FileHistoryNamespaceDiagnostics({
			now: () => now,
			log: (_message, fields) => {
				attempts++;
				count = fields.failureCount as number;
				throw new Error("new diagnostic logger unavailable");
			},
		});
		expect(() => diagnostics.failure("initialize", null)).not.toThrow();
		diagnostics.failure("initialize", null);
		expect(attempts).toBe(1);
		now = 60_000;
		diagnostics.failure("publish_before", null);
		expect(attempts).toBe(2);
		expect(count).toBe(2);
		const clockFailure = new FileHistoryNamespaceDiagnostics({
			now: () => {
				throw new Error("clock unavailable");
			},
		});
		expect(() => clockFailure.failure("initialize", null)).not.toThrow();
	});
});
