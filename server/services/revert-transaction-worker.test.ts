import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { on } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { connectCompiledWorker } from "../lib/compiled-worker";
import { logger } from "../lib/logger";
import * as sqlTrace from "../lib/sql-trace";
import { WorkerHandle } from "../lib/worker-runtime/lifecycle";
import type { RevertJournalOperation } from "./revert-mutation-journal";
import type { RevertSelectionResult } from "./revert-selection-service";
import type { TransactionManifestRequest } from "./revert-transaction-manifest-worker";
import {
	closeRevertManifestWorkers,
	RevertTransactionError,
	resetRevertManifestWorkersForTests,
	revertManifestWorkerSpecifiers,
	runRevertManifestWorker,
} from "./revert-transaction-worker";
import { REVERT_MANIFEST_WORKER_VERSION } from "./revert-transaction-worker-protocol";

// The compare action tests exact equality, independent of selection schema validation.
const selection = { metadataDigest: "fixed" } as RevertSelectionResult;
const request: TransactionManifestRequest = {
	action: "compare",
	fixed: selection,
	current: selection,
};
const realWorker = new URL("./revert-transaction-manifest-worker.ts", import.meta.url).href;
const ready = `parentPort.postMessage({ type: "revert-manifest-worker-ready", version: ${REVERT_MANIFEST_WORKER_VERSION} });`;
let root: string;
let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
let create: ReturnType<typeof spyOn<typeof WorkerHandle, "thread">>;

beforeEach(async () => {
	await resetRevertManifestWorkersForTests();
	root = await mkdtemp(join(tmpdir(), "revert-worker-test-"));
	warn = spyOn(logger, "warn").mockImplementation(() => {});
	create = spyOn(WorkerHandle, "thread");
});
afterEach(async () => {
	await closeRevertManifestWorkers();
	warn.mockRestore();
	create.mockRestore();
	await rm(root, { recursive: true, force: true });
});

async function fixture(name: string, source: string): Promise<string> {
	const path = join(root, `${name}.ts`);
	await writeFile(path, `import { parentPort } from "node:worker_threads";\n${source}`);
	return pathToFileURL(path).href;
}
const signal = () => AbortSignal.timeout(10_000);

// Bun 1.4.3 async matchers can starve native messages on a reused thread.
// Await normally first, retaining an explicit fulfillment/rejection assertion.
async function settled(pending: Promise<unknown>) {
	const result = await pending.then(
		(value: unknown) => ({ rejected: false, value }),
		(value: unknown) => ({ rejected: true, value }),
	);
	return {
		get error() {
			expect(result.rejected).toBe(true);
			return expect(result.value);
		},
		get value() {
			expect(result.rejected).toBe(false);
			return expect(result.value);
		},
	};
}

describe("revert manifest worker resolution", () => {
	test("source uses TypeScript; compiled builds probe bounded JavaScript entries", () => {
		expect(
			revertManifestWorkerSpecifiers(false, "file:///workspace/server/services/jobs.ts"),
		).toEqual(["file:///workspace/server/services/revert-transaction-manifest-worker.ts"]);
		expect(revertManifestWorkerSpecifiers(true, "file:///$bunfs/root/narrafork")).toEqual([
			"file:///$bunfs/root/services/revert-transaction-manifest-worker.js",
			"file:///$bunfs/root/server/services/revert-transaction-manifest-worker.js",
			"file:///$bunfs/root/revert-transaction-manifest-worker.js",
		]);
	});
});

describe("snapshot consent bound to original selector", () => {
	function entrypoint(recoveryMode: unknown = "snapshot", uiAction = "revert_files") {
		const owner = { subjectKey: "human:alice", narratorId: "narrator", projectId: "project" };
		const originalRequest = {
			principal: { userId: "alice", isAdmin: false },
			narratorId: "narrator",
			expectedMessageVersion: 7,
			idempotencyKey: "request-key",
			kind: "revert",
			revertScope: "narrator",
			selector: { kind: "all" },
			uiAction,
			...(recoveryMode === undefined ? {} : { recoveryMode }),
		};
		const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
		const bytes = Buffer.from(
			JSON.stringify({
				version: 1,
				owner,
				request: originalRequest,
				fixedSelector: { kind: "all" },
				boundary: null,
			}),
		);
		return {
			action: "entrypoint" as const,
			raw: {
				ref: { algorithm: "sha256" as const, digest: hash(bytes), sizeBytes: bytes.byteLength },
				bytes,
			},
			operation: {
				requestedBySubjectKey: owner.subjectKey,
				narratorId: owner.narratorId,
				projectId: owner.projectId,
				kind: "revert",
				scope: "narrator",
				expectedMessageVersion: 7,
				idempotencyKey: "request-key",
				selectorBlobDigest: hash(bytes),
				requestDigest: hash(JSON.stringify({ version: 1, owner, request: originalRequest })),
			} as RevertJournalOperation,
			userId: "alice",
			expectedAction: "revert_files" as const,
		};
	}

	test("snapshot entrypoint refuses absent/false confirmation, accepts literal true", async () => {
		const input = entrypoint();
		(await settled(runRevertManifestWorker(input, signal()))).error.toMatchObject({
			code: "REVERT_TRANSACTION_SNAPSHOT_CONFIRMATION_REQUIRED",
		});
		(
			await settled(
				runRevertManifestWorker(
					{ ...input, acceptSnapshotRestore: false } as unknown as TransactionManifestRequest,
					signal(),
				),
			)
		).error.toMatchObject({ code: "REVERT_TRANSACTION_SNAPSHOT_CONFIRMATION_REQUIRED" });
		(
			await settled(runRevertManifestWorker({ ...input, acceptSnapshotRestore: true }, signal()))
		).value.toBe(true);
		const { expectedAction: _action, ...internal } = input;
		(await settled(runRevertManifestWorker(internal, signal()))).error.toMatchObject({
			code: "REVERT_TRANSACTION_SNAPSHOT_CONFIRMATION_REQUIRED",
		});
	});

	test("entrypoint validates bound mode and UI action even when request digest is valid", async () => {
		(
			await settled(
				runRevertManifestWorker(
					{ ...entrypoint("automatic"), acceptSnapshotRestore: true },
					signal(),
				),
			)
		).error.toMatchObject({ code: "REVERT_TRANSACTION_RECOVERY_MODE" });
		(
			await settled(
				runRevertManifestWorker(
					{
						...entrypoint("snapshot", "rollback_to_block"),
						expectedAction: "rollback_to_block",
						acceptSnapshotRestore: true,
					},
					signal(),
				),
			)
		).error.toMatchObject({ code: "REVERT_TRANSACTION_ACTION_MISMATCH" });
	});

	test("unknown UI action cannot inherit delete_tool_block's selector semantics", async () => {
		const { expectedAction: _action, ...input } = entrypoint("snapshot", "unknown_action");
		const selector = JSON.parse(Buffer.from(input.raw.bytes).toString());
		selector.request.kind = "history_delete";
		selector.request.selector = { kind: "tool_calls", toolCallIds: ["tool"] };
		const bytes = Buffer.from(JSON.stringify(selector));
		const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
		const digest = hash(bytes);
		(
			await settled(
				runRevertManifestWorker(
					{
						...input,
						raw: { bytes, ref: { algorithm: "sha256", digest, sizeBytes: bytes.byteLength } },
						operation: {
							...input.operation,
							kind: "history_delete",
							selectorBlobDigest: digest,
							requestDigest: hash(
								JSON.stringify({ version: 1, owner: selector.owner, request: selector.request }),
							),
						},
						acceptSnapshotRestore: true,
					},
					signal(),
				),
			)
		).error.toMatchObject({ code: "REVERT_TRANSACTION_ACTION_MISMATCH" });
	});

	test("altering only the frozen selector mode cannot bypass the original request digest", async () => {
		const input = entrypoint();
		const selector = JSON.parse(Buffer.from(input.raw.bytes).toString());
		delete selector.request.recoveryMode;
		const bytes = Buffer.from(JSON.stringify(selector));
		const digest = createHash("sha256").update(bytes).digest("hex");
		(
			await settled(
				runRevertManifestWorker(
					{
						...input,
						raw: { bytes, ref: { algorithm: "sha256", digest, sizeBytes: bytes.byteLength } },
						operation: { ...input.operation, selectorBlobDigest: digest },
					},
					signal(),
				),
			)
		).error.toMatchObject({ code: "REVERT_TRANSACTION_ORIGINAL_REQUEST_DIGEST" });
	});
});

describe("revert manifest worker lifecycle", () => {
	test("real source worker acknowledges readiness before comparing", async () => {
		(await settled(runRevertManifestWorker<boolean>(request, signal()))).value.toBe(true);
		expect(warn).not.toHaveBeenCalled();
	});
	test("compare ignores only narrator version numbers and retains every structural field", async () => {
		const fixed = {
			metadataDigest: "fixed",
			messageVersions: [{ narratorId: "root", messageVersion: 7 }],
			history: { messages: [{ id: "selected", contentDigest: "body" }] },
			boundary: { messageId: "selected", contentDigest: "body" },
			tools: [{ id: "tool", executionAttempt: 1 }],
		} as unknown as RevertSelectionResult;
		const current = structuredClone(fixed);
		current.messageVersions[0].messageVersion++;
		expect(await runRevertManifestWorker({ action: "compare", fixed, current }, signal())).toBe(
			true,
		);
		for (const mutate of [
			(value: RevertSelectionResult) => {
				value.messageVersions[0].narratorId = "other";
			},
			(value: RevertSelectionResult) => {
				value.history.messages[0].contentDigest = "changed";
			},
			(value: RevertSelectionResult) => {
				if (value.boundary) value.boundary.contentDigest = "changed";
			},
			(value: RevertSelectionResult) => {
				value.tools[0].executionAttempt++;
			},
		]) {
			const changed = structuredClone(current);
			mutate(changed);
			const error = await runRevertManifestWorker(
				{ action: "compare", fixed, current: changed },
				signal(),
			).catch((error) => error);
			expect(error).toMatchObject({ code: "REVERT_TRANSACTION_SELECTION_STALE" });
		}
	});
	test("timing logs retain pool, RPC and SQL parent correlation without the request body", async () => {
		const specifier = await fixture(
			"timing-reply",
			`parentPort.on("message", (packet) => {
	 parentPort.postMessage({ requestId: packet.requestId, value: true });
	});
	${ready}`,
		);
		const parent = spyOn(sqlTrace, "currentSqlTraceSpan").mockReturnValue({
			id: "existing-sql-parent",
		} as sqlTrace.SqlTraceSpan);
		const info = spyOn(logger, "info").mockImplementation(() => {});
		try {
			expect(await runRevertManifestWorker(request, signal(), { specifiers: [specifier] })).toBe(
				true,
			);
			expect(info).toHaveBeenCalledTimes(1);
			const details = info.mock.calls[0]?.[1];
			expect(details).toMatchObject({
				pool: "revert-manifest",
				action: "compare",
				requestId: expect.any(String),
				parentTraceId: "existing-sql-parent",
				outcome: "ok",
				reused: false,
				queueMs: 0,
			});
			for (const phase of ["readyMs", "execMs", "closeMs", "totalMs"]) {
				expect(Number.isFinite(details?.[phase])).toBe(true);
				expect(Number(details?.[phase])).toBeGreaterThanOrEqual(0);
			}
			expect(details).not.toHaveProperty("request");
			expect(JSON.stringify(details)).not.toContain("metadataDigest");
		} finally {
			info.mockRestore();
			parent.mockRestore();
		}
	});
	test("real worker echoes independent IDs across a validation failure and the next task", async () => {
		const connected = await connectCompiledWorker([realWorker], {
			signal: signal(),
			isReady: (message) =>
				!!message &&
				typeof message === "object" &&
				"type" in message &&
				message.type === "revert-manifest-worker-ready" &&
				"version" in message &&
				message.version === REVERT_MANIFEST_WORKER_VERSION,
		});
		const replies = on(connected.worker, "message", { signal: signal() });
		const exchange = async (requestId: string, input: TransactionManifestRequest) => {
			connected.worker.postMessage({ requestId, request: input });
			for (;;) {
				const { value, done } = await replies.next();
				if (done) throw new Error("manifest worker reply stream ended");
				const [reply] = value;
				if (reply?.requestId === requestId) return reply;
			}
		};
		try {
			connected.worker.postMessage({ action: "ping" });
			expect(
				await exchange("first-task", {
					...request,
					current: { ...selection, metadataDigest: "changed" },
				}),
			).toEqual({ requestId: "first-task", error: "SELECTION_STALE" });
			expect(await exchange("next-task", request)).toEqual({
				requestId: "next-task",
				value: true,
			});
		} finally {
			await replies.return?.();
			await connected.handle.close();
		}
	});
	test("old success and error frames cannot settle a matching request", async () => {
		const specifier = await fixture(
			"old-replies",
			`parentPort.on("message", (packet) => {
	 parentPort.postMessage({ requestId: "old-task", value: "wrong" });
	 parentPort.postMessage({ requestId: "old-task", error: "SELECTION_STALE" });
	 parentPort.postMessage({ requestId: packet.requestId, value: "matching" });
	});
	${ready}`,
		);
		expect(
			await runRevertManifestWorker<string>(request, signal(), { specifiers: [specifier] }),
		).toBe("matching");
		expect(warn).not.toHaveBeenCalled();
	});
	test("identical domain requests still receive independent RPC IDs", async () => {
		const specifier = await fixture(
			"echo-request-id",
			`parentPort.on("message", (packet) => {
	 parentPort.postMessage({ requestId: packet.requestId, value: packet.requestId });
	});
	${ready}`,
		);
		const first = await runRevertManifestWorker<string>(request, signal(), {
			specifiers: [specifier],
		});
		const next = await runRevertManifestWorker<string>(request, signal(), {
			specifiers: [specifier],
		});
		expect(first).toHaveLength(21);
		expect(next).toHaveLength(21);
		expect(next).not.toBe(first);
	});
	test("duplicate ready control frames never dispatch the business task twice", async () => {
		const specifier = await fixture(
			"duplicate-ready",
			`parentPort.on("message", (packet) => {
	 ${ready}
	 parentPort.postMessage({ requestId: packet.requestId, value: true });
	});
	${ready}
	${ready}`,
		);
		const original = Worker.prototype.postMessage;
		let dispatches = 0;
		const post = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			...args: Parameters<Worker["postMessage"]>
		) {
			if (args[0] && typeof args[0] === "object" && "requestId" in args[0]) dispatches++;
			return original.apply(this, args);
		});
		try {
			expect(
				await runRevertManifestWorker<boolean>(request, signal(), { specifiers: [specifier] }),
			).toBe(true);
			expect(dispatches).toBe(1);
		} finally {
			post.mockRestore();
		}
	});
	test("an old success followed by exit fails without replaying on another entry", async () => {
		const marker = join(root, "executions");
		const specifier = await fixture(
			"old-reply-then-exit",
			`import { appendFileSync } from "node:fs";
	parentPort.on("message", () => {
	 appendFileSync(${JSON.stringify(marker)}, "x");
	 parentPort.postMessage({ requestId: "old-task", value: true });
	 process.exit(1);
	});
	${ready}`,
		);
		(
			await settled(
				runRevertManifestWorker(request, signal(), { specifiers: [specifier, realWorker] }),
			)
		).error.toMatchObject({ code: "REVERT_TRANSACTION_MANIFEST_WORKER_EXITED" });
		expect(await readFile(marker, "utf8")).toBe("x");
		expect(warn).not.toHaveBeenCalled();
	});
	test("missing pre-ready entry can fall through to the real worker", async () => {
		(
			await settled(
				runRevertManifestWorker(request, signal(), {
					specifiers: [pathToFileURL(join(root, "missing.ts")).href, realWorker],
				}),
			)
		).value.toBe(true);
		expect(create).toHaveBeenCalledTimes(2);
		expect(warn).not.toHaveBeenCalled();
	});
	test("startup probing is bounded to three candidates", async () => {
		const missing = pathToFileURL(join(root, "missing.ts")).href;
		(
			await settled(
				runRevertManifestWorker(request, signal(), {
					specifiers: [missing, missing, missing, realWorker],
				}),
			)
		).error.toMatchObject({ code: "REVERT_TRANSACTION_MANIFEST_WORKER_FAILED" });
		expect(create).toHaveBeenCalledTimes(3);
		expect(create.mock.calls.every(([entry]) => String(entry) === missing)).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
	});
	test("synchronous entry errors are sanitized and can probe the next entry", async () => {
		(
			await settled(
				runRevertManifestWorker(request, signal(), { specifiers: ["not-a-url", realWorker] }),
			)
		).value.toBe(true);
		expect(warn).not.toHaveBeenCalled();
	});
	test("startup exceptions are logged with bounded details, not exposed to callers", async () => {
		const secret = `${root}/${"sensitive".repeat(300)}`;
		const specifier = await fixture("startup-error", `throw new Error(${JSON.stringify(secret)});`);
		(
			await settled(runRevertManifestWorker(request, signal(), { specifiers: [specifier] }))
		).error.toMatchObject({
			code: "REVERT_TRANSACTION_MANIFEST_WORKER_FAILED",
			message: "Local revert transaction refused: MANIFEST_WORKER_FAILED",
		});
		expect(warn).toHaveBeenCalledTimes(1);
		const details = warn.mock.calls[0]?.[1];
		expect(String(details?.error)).toContain(root);
		expect(String(details?.error).length).toBeLessThanOrEqual(1024);
		expect(String(details?.specifier).length).toBeLessThanOrEqual(1024);
	});
	test("early exit is refused without hanging", async () => {
		const specifier = await fixture("early-exit", "parentPort.close();");
		(
			await settled(runRevertManifestWorker(request, signal(), { specifiers: [specifier] }))
		).error.toMatchObject({ code: "REVERT_TRANSACTION_MANIFEST_WORKER_EXITED" });
	});
	test("no request is dispatched before a valid readiness handshake", async () => {
		const marker = join(root, "dispatched");
		const specifier = await fixture(
			"wrong-handshake",
			`import { writeFileSync } from "node:fs";
parentPort.on("message", () => writeFileSync(${JSON.stringify(marker)}, "dispatched"));
parentPort.postMessage({ value: true });`,
		);
		(
			await settled(runRevertManifestWorker(request, signal(), { specifiers: [specifier] }))
		).error.toMatchObject({ code: "REVERT_TRANSACTION_MANIFEST_WORKER_PROTOCOL" });
		expect(await Bun.file(marker).exists()).toBe(false);
	});
	test("startup timeout terminates the worker without dispatch", async () => {
		const marker = join(root, "dispatched");
		const specifier = await fixture(
			"never-ready",
			`import { writeFileSync } from "node:fs";
parentPort.on("message", () => writeFileSync(${JSON.stringify(marker)}, "dispatched"));`,
		);
		(
			await settled(
				runRevertManifestWorker(request, signal(), {
					specifiers: [specifier],
					readyTimeoutMs: 100,
				}),
			)
		).error.toMatchObject({ code: "REVERT_TRANSACTION_MANIFEST_WORKER_TIMEOUT" });
		expect(await Bun.file(marker).exists()).toBe(false);
	});
	test("an already-cancelled request never starts a worker", async () => {
		const marker = join(root, "started");
		const specifier = await fixture(
			"should-not-start",
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "started");`,
		);
		const reason = new Error("cancelled before start");
		(
			await settled(
				runRevertManifestWorker(request, AbortSignal.abort(reason), { specifiers: [specifier] }),
			)
		).error.toBe(reason);
		expect(await Bun.file(marker).exists()).toBe(false);
		expect(warn).not.toHaveBeenCalled();
	});
	test("cancellation during startup does not try the next candidate", async () => {
		const specifier = await fixture("waiting", 'parentPort.on("message", () => {});');
		(
			await settled(
				runRevertManifestWorker(request, AbortSignal.timeout(100), {
					specifiers: [specifier, realWorker],
				}),
			)
		).error.toMatchObject({ code: "REVERT_TRANSACTION_MANIFEST_CANCELLED" });
		expect(create).toHaveBeenCalledTimes(1);
		expect(warn).not.toHaveBeenCalled();
	});
	test("real validation rejection is returned, not retried", async () => {
		(
			await settled(
				runRevertManifestWorker(
					{ ...request, current: { ...selection, metadataDigest: "changed" } },
					signal(),
					{ specifiers: [realWorker, realWorker] },
				),
			)
		).error.toMatchObject({ code: "REVERT_TRANSACTION_SELECTION_STALE" });
		expect(warn).not.toHaveBeenCalled();
	});
	for (const kind of [
		"validation",
		"crash",
		"exit",
		"malformed",
		"array",
		"empty-id",
		"missing-id",
		"bad-id",
		"sensitive-error",
	] as const) {
		test(`post-ready ${kind} failure never dispatches twice`, async () => {
			const marker = join(root, "executions");
			const action = {
				validation:
					'parentPort.postMessage({ requestId: message.requestId, error: "SELECTION_STALE" });',
				crash: 'throw new Error("crashed after dispatch");',
				exit: "process.exit(1);",
				malformed: "parentPort.postMessage(null);",
				array:
					"parentPort.postMessage(Object.assign([], { requestId: message.requestId, value: true }));",
				"empty-id": 'parentPort.postMessage({ requestId: "", value: true });',
				"missing-id": "parentPort.postMessage({ value: true });",
				"bad-id": "parentPort.postMessage({ requestId: 42, value: true });",
				"sensitive-error": `parentPort.postMessage({ requestId: message.requestId, error: ${JSON.stringify(`${root}/private manifest text`)} });`,
			}[kind];
			const specifier = await fixture(
				kind,
				`import { appendFileSync } from "node:fs";
parentPort.on("message", (message) => {
 appendFileSync(${JSON.stringify(marker)}, "x");
 ${action}
});
${ready}`,
			);
			const code = {
				validation: "SELECTION_STALE",
				crash: "MANIFEST_WORKER_FAILED",
				exit: "MANIFEST_WORKER_EXITED",
				malformed: "MANIFEST_WORKER_PROTOCOL",
				array: "MANIFEST_WORKER_PROTOCOL",
				"empty-id": "MANIFEST_WORKER_PROTOCOL",
				"missing-id": "MANIFEST_WORKER_PROTOCOL",
				"bad-id": "MANIFEST_WORKER_PROTOCOL",
				"sensitive-error": "INVALID_MANIFEST",
			}[kind];
			(
				await settled(
					runRevertManifestWorker(request, signal(), { specifiers: [specifier, specifier] }),
				)
			).error.toMatchObject({
				code: `REVERT_TRANSACTION_${code}`,
				message: `Local revert transaction refused: ${code}`,
			});
			expect(await readFile(marker, "utf8")).toBe("x");
			expect(create).toHaveBeenCalledTimes(1);
			expect(warn).not.toHaveBeenCalled();
		});
	}
	test("cancellation after dispatch terminates without retrying", async () => {
		const marker = join(root, "executions");
		const controller = new AbortController();
		const emit = Worker.prototype.emit;
		// Observe the real thread's completed side effect, without requiring an OS
		// filesystem watcher. Consume only this fixture's test-only acknowledgement.
		const messages = spyOn(Worker.prototype, "emit").mockImplementation(function (
			this: Worker,
			event: string | symbol,
			...args: unknown[]
		) {
			if (event === "message" && (args[0] as { type?: unknown })?.type === "test-dispatched") {
				controller.abort();
				return true;
			}
			return Reflect.apply(emit, this, [event, ...args]);
		});
		try {
			const specifier = await fixture(
				"cancel-after-dispatch",
				`import { appendFileSync } from "node:fs";
parentPort.on("message", (packet) => {
  if (!packet.requestId || !packet.request) return;
  appendFileSync(${JSON.stringify(marker)}, "x");
  parentPort.postMessage({ type: "test-dispatched" });
});
${ready}`,
			);
			(
				await settled(
					runRevertManifestWorker(request, AbortSignal.any([controller.signal, signal()]), {
						specifiers: [specifier, specifier],
					}),
				)
			).error.toBeInstanceOf(RevertTransactionError);
			expect(controller.signal.aborted).toBe(true);
			expect(await readFile(marker, "utf8")).toBe("x");
			expect(create).toHaveBeenCalledTimes(1);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			messages.mockRestore();
		}
	});
});
