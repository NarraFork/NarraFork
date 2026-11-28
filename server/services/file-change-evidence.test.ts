import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { FILE_CHANGE_LIMITS, type FileChangeState } from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqlite as isolatedTemplate } from "../db";
import * as schema from "../db/schema";
import { readEditorOperationEvidence, readRevertPlan } from "../lib/db-worker/file-read-snapshots";
import * as pool from "../lib/db-worker/pool";
import { generateId } from "../lib/id";
import { closeFileWorkerDatabase, openFileWorkerDatabase } from "./__tests__/file-worker-database";
import { FILE_CHANGE_BLOB_BUDGET_ID, FileChangeBlobCatalog } from "./file-change-blob-catalog";
import {
	type BeginFileChangeOperation,
	type FileChangeEffectCursor,
	FileChangeEvidenceService,
	type FileChangeNoDispatchProof,
	type FileChangeScopeRecord,
	type RecordFileChangeEffect,
} from "./file-change-evidence";
import { createFileChangeIdentity } from "./file-change-identity";

let sqlite: Database;
const wrap = (client: Database) => drizzle(client, { schema });
let db: ReturnType<typeof wrap>;
let service: FileChangeEvidenceService;
let scope: FileChangeScopeRecord;
const timestamp = "2026-10-05T00:00:00.000Z";
const ABSENT: FileChangeState = { kind: "absent" };
const UNKNOWN: FileChangeState = { kind: "unknown", reason: "history_unavailable" };
const target = {
	cwd: "/repo",
	pathFlavor: "posix",
	lexicalPath: "/repo/a",
	canonicalPath: "/repo/a",
};

beforeEach(() => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	sqlite = openFileWorkerDatabase(isolatedTemplate);
	sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
	db = wrap(sqlite);
	service = new FileChangeEvidenceService(db, () => timestamp);
	scope = service.prepareScope({
		sourceInstanceId: "source",
		deviceId: "local",
		workspaceInstanceId: "workspace",
		pathFlavor: "posix",
		canonicalRoot: "/repo",
	});
});
afterEach(async () => await closeFileWorkerDatabase(sqlite));
function hash(value: string) {
	return createHash("sha256").update(value).digest("hex");
}
function operationInput(
	overrides: Partial<BeginFileChangeOperation> = {},
): BeginFileChangeOperation {
	return {
		sourceInstanceId: "source",
		sourceKind: "editor",
		sourceId: generateId(),
		attempt: 1,
		requestDigest: hash("fixed request"),
		expectedEffectCount: 1,
		executionBinding: null,
		actor: {
			kind: "human",
			subjectKey: "source:author",
			narratorId: null,
			userId: null,
			label: "Author",
			deleted: false,
			parentSubjectKey: null,
		},
		...overrides,
	};
}

test("editor operation persists the full safe-integer snapshot revision and never a lease", async () => {
	const input = operationInput({
		executionBinding: {
			deviceId: "remote-fixture",
			runtimeEpoch: "epoch",
			runtimeGeneration: 3,
			fencingToken: 3,
		},
		editorRawSnapshotRevision: Number.MAX_SAFE_INTEGER,
	});
	const recorded = service.beginOperation(input);
	expect(await service.getEditorOperation("source", input.sourceId)).toMatchObject({
		id: recorded.id,
		workspaceLeaseId: null,
		editorRawSnapshotRevision: Number.MAX_SAFE_INTEGER,
	});
	const ordinary = service.beginOperation(operationInput());
	expect(ordinary.workspaceLeaseId).toBeNull();
	expect(ordinary.editorRawSnapshotRevision).toBeNull();
	for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
		expect(() =>
			service.beginOperation(
				operationInput({ ...input, sourceId: generateId(), editorRawSnapshotRevision: revision }),
			),
		).toThrow();
	expect(() =>
		service.beginOperation(
			operationInput({ ...input, sourceId: generateId(), sourceKind: "tool" }),
		),
	).toThrow();
});

function known(mode = 0o644, status: "ready" | "missing" = "ready"): FileChangeState {
	const digest = hash(generateId());
	db.insert(schema.fileChangeBlobs)
		.values({
			id: generateId(),
			digest,
			sizeBytes: 3,
			status,
			storageKey: `sha256/${digest.slice(0, 2)}/${digest}`,
			createdAt: timestamp,
			updatedAt: timestamp,
		})
		.run();
	return { kind: "regular", blob: { algorithm: "sha256", digest, sizeBytes: 3 }, mode };
}
function effectInput(
	operationId: string,
	overrides: Partial<RecordFileChangeEffect> = {},
	name = "a",
): RecordFileChangeEffect {
	const after = known();
	return {
		operationId,
		identity: createFileChangeIdentity(scope, {
			deviceId: "local",
			pathFlavor: "posix",
			objectRole: "referent",
			lexicalPath: `/repo/${name}`,
			canonicalPath: `/repo/${name}`,
		}),
		before: ABSENT,
		intendedAfter: after,
		observedAfter: after,
		outcome: "applied",
		...overrides,
	};
}
function noDispatchInput(): BeginFileChangeOperation & { toolCallId: string; narratorId: string } {
	const narratorId = generateId();
	const messageId = generateId();
	const toolCallId = generateId();
	db.insert(schema.narrators)
		.values({ id: narratorId, createdAt: timestamp, updatedAt: timestamp })
		.run();
	db.insert(schema.narratorMessages)
		.values({ id: messageId, narratorId, role: "assistant", contentJson: [], createdAt: timestamp })
		.run();
	db.insert(schema.narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId,
			messageId,
			toolUseId: "provider-id",
			toolName: "Edit",
			createdAt: timestamp,
			executionIdentityVersion: 1,
			executionAttempt: 1,
			status: "running",
			executionStartedAt: timestamp,
			executionDeviceId: "local",
			runtimeGeneration: 7,
			executionCwd: target.cwd,
			executionPathFlavor: "posix",
			resolvedFilePath: target.lexicalPath,
			canonicalFilePath: target.canonicalPath,
		})
		.run();
	const base = operationInput();
	return {
		...base,
		sourceKind: "tool",
		sourceId: toolCallId,
		toolCallId,
		toolUseId: "provider-id",
		narratorId,
		actor: { ...base.actor, kind: "primary", narratorId },
	};
}
const preview: FileChangeNoDispatchProof = {
	targetDispatched: false,
	reason: "preview",
	frozenTarget: target,
};

describe("version 3 final historical facts", () => {
	test("scope is metadata and old barriers remain untouched", async () => {
		db.update(schema.fileChangeScopes)
			.set({
				status: "needs_verification",
				revision: 42,
				fencingToken: 73,
				rootIdentityJson: { inode: "replaced-root" },
				activeLeaseId: "old-owner",
				activeMutationCount: 9,
			})
			.where(eq(schema.fileChangeScopes.id, scope.id))
			.run();
		const old = await service.getScope(scope.id);
		if (!old) throw new Error("Missing scope fixture");
		expect(service.prepareScope({ ...scope, canonicalRoot: "/repo" })).toEqual(old);
		const operation = service.beginOperation(operationInput());
		const effect = service.recordEffect(effectInput(operation.id));
		expect(effect).toMatchObject({
			diskOutcome: "applied",
			outcome: "changed",
			scopeRevision: null,
			executionReceiptJson: null,
			executionConfirmed: true,
			settlement: "settled",
		});
		expect(operation).toMatchObject({
			evidenceVersion: 3,
			executionBindingJson: null,
			replayed: false,
		});
		expect(effect.journalSeq).toBe(operation.journalSeq);
		expect(service.finishOperation(operation.id, "succeeded")).toMatchObject({
			effectOutcome: "changed",
			coverage: "complete",
			settlement: "settled",
		});
		expect(await service.getScope(scope.id)).toEqual(old);
	});
	test("retired scopes and global blob states do not gate independent history", async () => {
		db.update(schema.fileChangeScopes)
			.set({ status: "retired" })
			.where(eq(schema.fileChangeScopes.id, scope.id))
			.run();
		db.insert(schema.fileChangeStorageBudgets)
			.values({
				id: FILE_CHANGE_BLOB_BUDGET_ID,
				namespaceKey: "archive",
				status: "reconciling",
				reservedBytes: Number.MAX_SAFE_INTEGER,
				quotaBytes: 0,
				updatedAt: timestamp,
			})
			.run();
		const operation = service.beginOperation(operationInput());
		expect(service.recordEffect(effectInput(operation.id)).diskOutcome).toBe("applied");
	});
	test("request/attempt replay returns the original sequence, including unknown attempts", async () => {
		const input = operationInput();
		const first = service.beginOperation(input);
		expect(service.beginOperation(input)).toEqual({ ...first, replayed: true });
		const effect = effectInput(first.id, { outcome: "unknown" });
		const recorded = service.recordEffect(effect);
		expect(recorded).toMatchObject({
			diskOutcome: "unknown",
			outcome: "unknown",
			executionConfirmed: false,
		});
		service.finishOperation(first.id, "failed");
		expect(service.beginOperation(input)).toMatchObject({
			replayed: true,
			journalSeq: first.journalSeq,
		});
		expect(() => service.beginOperation({ ...input, requestDigest: hash("changed") })).toThrow(
			"cannot change",
		);
		const next = service.beginOperation(operationInput());
		expect(next.journalSeq).toBe((first.journalSeq ?? 0) + 1);
		expect(service.recordEffect(effectInput(next.id)).diskOutcome).toBe("applied");
	});
	test("effect replay is immutable and only increments counters once", async () => {
		const operation = service.beginOperation(operationInput());
		const input = effectInput(operation.id);
		const effect = service.recordEffect(input);
		expect(service.recordEffect(input)).toEqual(effect);
		expect(await service.getOperation(operation.id)).toMatchObject({
			preparedEffectCount: 1,
			settledEffectCount: 1,
			evidenceBytes: 6,
		});
		expect(() => service.recordEffect({ ...input, outcome: "unknown" })).toThrow("immutable");
		expect(() => service.recordEffect(effectInput(operation.id, {}, "extra"))).toThrow(
			"expected file results",
		);
	});
	test("unknown content preserves an applied result without inventing measured history", async () => {
		const operation = service.beginOperation(operationInput());
		const effect = service.recordEffect(
			effectInput(operation.id, {
				before: UNKNOWN,
				intendedAfter: UNKNOWN,
				observedAfter: UNKNOWN,
			}),
		);
		expect(effect).toMatchObject({
			diskOutcome: "applied",
			outcome: "unknown",
			attributionGrade: "unknown",
			executionConfirmed: true,
		});
		expect(service.finishOperation(operation.id, "succeeded")).toMatchObject({
			executionOutcome: "succeeded",
			effectOutcome: "unknown",
			reason: "result_unknown",
		});
	});
	test("known unchanged, not-applied, mode-only and deletion results remain distinct", async () => {
		const before = known();
		for (const outcome of ["applied", "not_applied", "unknown"] as const) {
			const op = service.beginOperation(operationInput());
			const effect = service.recordEffect(
				effectInput(op.id, { before, intendedAfter: before, observedAfter: before, outcome }),
			);
			expect(effect.outcome).toBe(outcome === "unknown" ? "unknown" : "no_change");
		}
		if (before.kind !== "regular") throw new Error("Invalid fixture");
		const op = service.beginOperation(operationInput());
		const modeOnly = { ...before, mode: 0o755 };
		expect(
			service.recordEffect(
				effectInput(op.id, { before, intendedAfter: modeOnly, observedAfter: modeOnly }),
			).outcome,
		).toBe("changed");
		const remove = service.beginOperation(operationInput());
		expect(
			service.recordEffect(
				effectInput(remove.id, { before, intendedAfter: ABSENT, observedAfter: ABSENT }),
			).outcome,
		).toBe("changed");
	});
	test("failed metadata transaction rolls back only this record and later requests succeed", async () => {
		const operation = service.beginOperation(operationInput());
		const input = effectInput(operation.id);
		sqlite.exec(
			"CREATE TRIGGER fail_history BEFORE UPDATE ON file_change_operations BEGIN SELECT RAISE(ABORT, 'accounting-fault'); END;",
		);
		expect(() => service.recordEffect(input)).toThrow("accounting-fault");
		expect((await service.listEffects(operation.id)).items).toHaveLength(0);
		expect((await service.getOperation(operation.id))?.preparedEffectCount).toBe(0);
		sqlite.exec("DROP TRIGGER fail_history;");
		expect(service.recordEffect(input).diskOutcome).toBe("applied");
		const next = service.beginOperation(operationInput());
		expect(service.recordEffect(effectInput(next.id)).diskOutcome).toBe("applied");
	});
	test("a missing blob affects only its result, leaves old content metadata intact", async () => {
		const missing = known(0o644, "missing");
		const op = service.beginOperation(operationInput());
		const input = effectInput(op.id, { before: missing });
		expect(() => service.recordEffect(input)).toThrow("verified catalog object");
		expect((await service.listEffects(op.id)).items).toEqual([]);
		const independent = service.beginOperation(operationInput());
		expect(service.recordEffect(effectInput(independent.id)).diskOutcome).toBe("applied");
		if (missing.kind !== "regular") throw new Error("Invalid fixture");
		expect(
			db
				.select()
				.from(schema.fileChangeBlobs)
				.where(eq(schema.fileChangeBlobs.digest, missing.blob.digest))
				.get()?.status,
		).toBe("missing");
	});
	test("version 2 history stays byte-for-byte readable and rejects new mutations", async () => {
		const op = service.beginOperation(operationInput());
		const effect = service.recordEffect(effectInput(op.id));
		db.update(schema.fileChangeOperations)
			.set({ evidenceVersion: 2, settlement: "reconcile_required", executionOutcome: "running" })
			.where(eq(schema.fileChangeOperations.id, op.id))
			.run();
		const before = await service.getOperation(op.id);
		expect(await service.getEffect(op.id, effect.mutationId)).toEqual(effect);
		expect(() => service.finishOperation(op.id, "failed")).toThrow("read-only");
		expect(() => service.recordEffect(effectInput(op.id))).toThrow("read-only");
		expect(await service.getOperation(op.id)).toEqual(before);
		expect(
			(await service.listPendingOperations({ settlement: "reconcile_required" })).items.map(
				(row) => row.id,
			),
		).toContain(op.id);
	});
	test("terminal history gap needs no recovery process and can receive a late fact", async () => {
		const op = service.beginOperation(operationInput());
		expect(service.finishOperation(op.id, "succeeded")).toMatchObject({
			reason: "history_unavailable",
			coverage: "unavailable",
			settlement: "settled",
		});
		service.recordEffect(effectInput(op.id));
		expect(await service.getOperation(op.id)).toMatchObject({
			reason: null,
			coverage: "complete",
			settlement: "settled",
		});
		expect(() => service.finishOperation(op.id, "failed")).toThrow("immutable");
	});
	test("source, target metadata, bounded input and transaction boundaries remain enforced", async () => {
		const op = service.beginOperation(operationInput());
		const input = effectInput(op.id);
		expect(() =>
			service.recordEffect({ ...input, identity: { ...input.identity, deviceId: "other" } }),
		).toThrow("historical source");
		expect(() =>
			service.recordEffect({ ...input, identity: { ...input.identity, displayPath: "other" } }),
		).toThrow("historical source");
		expect(() =>
			service.beginOperation(
				operationInput({ expectedEffectCount: FILE_CHANGE_LIMITS.revertFiles + 1 }),
			),
		).toThrow("over-budget");
		expect(() => db.transaction(() => service.beginOperation(operationInput()))).toThrow(
			"short transaction",
		);
		expect(() =>
			service.recordEffect({ ...input, scopeRevision: 0 } as RecordFileChangeEffect),
		).toThrow("Unexpected fields");
	});
	test("bounded keyset pages include every recorded file exactly once", async () => {
		const op = service.beginOperation(operationInput({ expectedEffectCount: 7 }));
		for (let index = 0; index < 7; index++)
			service.recordEffect(effectInput(op.id, {}, `file-${index}`));
		const keys: string[] = [];
		let cursor: FileChangeEffectCursor | undefined;
		do {
			const page = await service.listEffects(op.id, { limit: 2, cursor });
			keys.push(...page.items.map((row) => row.fileKey));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(keys).toHaveLength(7);
		expect(new Set(keys).size).toBe(7);
		expect(keys).toEqual([...keys].sort());
	});
});

describe("trusted no-dispatch records", () => {
	test("binding-null preview records a real attempt with zero effects and sequence", async () => {
		const input = noDispatchInput();
		const op = service.beginNoDispatchOperation(input, preview);
		expect(op).toMatchObject({
			evidenceVersion: 3,
			executionBindingJson: null,
			expectedEffectCount: 0,
			executionOutcome: "succeeded",
			reason: "no_dispatch:preview",
		});
		expect(op.journalSeq).toBeGreaterThan(0);
		expect(service.beginNoDispatchOperation(input, preview)).toEqual(op);
		expect((await service.listEffects(op.id)).items).toEqual([]);
		expect(
			db
				.select()
				.from(schema.narratorToolCalls)
				.where(eq(schema.narratorToolCalls.id, input.toolCallId))
				.get()?.fileChangeOperationId,
		).toBe(op.id);
	});
	test.each([
		{ executionAttempt: 2 },
		{ executionOriginToolCallId: "copied" },
		{ isFileHistoryCheckpoint: true },
		{ canonicalFilePath: "/other/a" },
		{ executionIdentityVersion: 0 },
		{ toolName: "Bash" },
	])("refuses source/attempt/target forgery %j", (patch) => {
		const input = noDispatchInput();
		db.update(schema.narratorToolCalls)
			.set(patch)
			.where(eq(schema.narratorToolCalls.id, input.toolCallId))
			.run();
		expect(() => service.beginNoDispatchOperation(input, preview)).toThrow("frozen file-tool");
		expect(db.select().from(schema.fileChangeOperations).all()).toEqual([]);
	});
	test("unstarted host rejection requires its actual observed status and frozen target", async () => {
		const input = noDispatchInput();
		db.update(schema.narratorToolCalls)
			.set({ status: "fail", executionStartedAt: null })
			.where(eq(schema.narratorToolCalls.id, input.toolCallId))
			.run();
		const proof: FileChangeNoDispatchProof = {
			...preview,
			reason: "invocation_rejected",
			beforeInvocation: { status: "fail", executionStartedAt: null },
		};
		expect(() => service.beginNoDispatchOperation(input, proof)).toThrow("exact live");
		const op = service.beginNoDispatchOperation(input, {
			...proof,
			beforeInvocation: { status: "fail", executionStartedAt: null, observedStatus: "running" },
		});
		expect(op).toMatchObject({ executionOutcome: "failed", effectOutcome: "no_change" });
	});
	test("linking failure rolls back the entire no-dispatch record and clock tick", async () => {
		const input = noDispatchInput();
		sqlite.exec(
			"CREATE TRIGGER fail_tool_link BEFORE UPDATE ON narrator_tool_calls BEGIN SELECT RAISE(ABORT, 'link-fault'); END;",
		);
		expect(() => service.beginNoDispatchOperation(input, preview)).toThrow("link-fault");
		expect(db.select().from(schema.fileChangeOperations).all()).toEqual([]);
		sqlite.exec("DROP TRIGGER fail_tool_link;");
		expect(service.beginNoDispatchOperation(input, preview).journalSeq).toBe(1);
	});
	test("a dispatched operation cannot be relabeled no-dispatch", async () => {
		const input = noDispatchInput();
		service.beginOperation(input);
		expect(() => service.beginNoDispatchOperation(input, preview)).toThrow("cannot change");
	});
});

describe("required evidence snapshots", () => {
	test("editor metadata has matching JSON/boolean projections and empty reads are explicit", async () => {
		const input = operationInput();
		const operation = service.beginOperation(input);
		service.recordEffect(effectInput(operation.id));
		const snapshot = await service.getEditorSnapshot("source", input.sourceId);
		expect(snapshot.operation).toEqual(await service.getEditorOperation("source", input.sourceId));
		expect(snapshot.effects).toEqual((await service.listEffects(operation.id)).items);
		expect(snapshot.effects[0].identityJson).toEqual(
			expect.objectContaining({ scopeId: scope.id }),
		);
		expect(await service.getEditorSnapshot("source", "missing")).toEqual({
			operation: null,
			effects: [],
		});
		const reader = new Database(sqlite.filename, { readonly: true });
		try {
			expect(
				readRevertPlan(
					reader,
					{
						owner: { subjectKey: "owner", narratorId: null, projectId: null },
						planId: "missing",
						cursor: null,
						limit: 0,
					},
					new AbortController().signal,
				),
			).toMatchObject({ operation: null, files: [], scopes: [], blobs: [] });
		} finally {
			reader.close();
		}
	});
	test("failed iteration finalizes the reader so its next snapshot sees newly committed evidence", () => {
		const first = operationInput();
		const operation = service.beginOperation(first);
		const reader = new Database(sqlite.filename, { readonly: true });
		const signal = new AbortController().signal;
		try {
			db.update(schema.fileChangeOperations)
				.set({ actorJson: { padding: "x".repeat(FILE_CHANGE_LIMITS.summaryBytes + 1) } as never })
				.where(eq(schema.fileChangeOperations.id, operation.id))
				.run();
			expect(() =>
				readEditorOperationEvidence(
					reader,
					{ sourceInstanceId: "source", sourceId: first.sourceId },
					signal,
				),
			).toThrow("source byte budget");
			db.update(schema.fileChangeOperations)
				.set({ actorJson: operation.actorJson })
				.where(eq(schema.fileChangeOperations.id, operation.id))
				.run();
			const next = operationInput();
			const committed = service.beginOperation(next);
			expect(
				readEditorOperationEvidence(
					reader,
					{ sourceInstanceId: "source", sourceId: next.sourceId },
					signal,
				).operation?.id,
			).toBe(committed.id);
			expect(() =>
				readEditorOperationEvidence(
					reader,
					{ sourceInstanceId: "source", sourceId: next.sourceId },
					signal,
					Date.now() - 1,
				),
			).toThrow("deadline");
		} finally {
			reader.close();
		}
	});
	test.each([
		"spawn",
		"crash",
		"timeout",
		"disabled",
		"cancelled",
		"deadline",
	])("%s fails closed for every evidence reader", async (fault) => {
		const setting = process.env.NARRAFORK_DB_WORKER;
		const controller = new AbortController();
		if (fault === "cancelled") controller.abort(new Error("evidence cancelled"));
		const options = {
			signal: controller.signal,
			deadlineAt: fault === "deadline" ? Date.now() - 1 : Date.now() + 5000,
		};
		const catalog = new FileChangeBlobCatalog({ db, namespaceKey: "/evidence" });
		const injected =
			fault === "disabled"
				? undefined
				: spyOn(pool, "runReadTask").mockRejectedValue(
						fault === "spawn"
							? new pool.WorkersUnavailableError("unavailable")
							: Object.assign(new Error(fault), {
									code: fault === "timeout" ? "DB_READ_TIMEOUT" : "DB_READ_FAILED",
								}),
					);
		if (fault === "disabled") process.env.NARRAFORK_DB_WORKER = "off";
		const prepare = spyOn(sqlite, "prepare");
		const query = spyOn(sqlite, "query");
		try {
			const reads = [
				() => service.getScope(scope.id, options),
				() => service.getOperation("missing", options),
				() => service.getEditorOperation("source", "missing", options),
				() => service.getEffect("missing", "mutation", options),
				() => service.listEffects("missing", { limit: 2, ...options }),
				() =>
					service.listPendingOperations({ settlement: "reconcile_required", limit: 2, ...options }),
				() => service.getEditorSnapshot("source", "missing", options),
				() => catalog.readBudget(options),
				() =>
					catalog.readMetadata({
						ref: { algorithm: "sha256", digest: hash("blob"), sizeBytes: 3 },
						...options,
					}),
			];
			for (const read of reads) await expect(read()).rejects.toThrow();
			expect(prepare).not.toHaveBeenCalled();
			expect(query).not.toHaveBeenCalled();
		} finally {
			injected?.mockRestore();
			prepare.mockRestore();
			query.mockRestore();
			if (setting === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = setting;
		}
	});
});
