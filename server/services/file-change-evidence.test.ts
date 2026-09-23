import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeActor,
	type FileChangeEffect,
	type FileChangeExecutionBinding,
	type FileChangeExecutionReceipt,
	type FileChangeState,
	hasConfirmedNoFileChange,
	hasSettledMeasuredFileEffect,
} from "@shared/file-change-protocol";
import { eq, inArray } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
	fileChangeBlobs,
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopes,
	fileChangeStorageBudgets,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../db/schema";
import { generateId } from "../lib/id";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "./file-change-blob-catalog";
import {
	type BeginFileChangeOperation,
	FILE_CHANGE_PREPARE_BATCH_ITEMS,
	type FileChangeEffectCursor,
	type FileChangeEffectRecord,
	FileChangeEvidenceService,
	type FileChangeOperationCursor,
	type FileChangeScopeRecord,
	type PrepareFileChangeEffect,
} from "./file-change-evidence";
import { createFileChangeIdentity } from "./file-change-identity";

let service: FileChangeEvidenceService;
let scope: FileChangeScopeRecord;
let source: string;
let binding: FileChangeExecutionBinding;
let actor: FileChangeActor;
let blobIds: string[];
let toolFixtures: { narratorId: string; messageId: string; toolCallId: string }[];
let oldBudget: typeof fileChangeStorageBudgets.$inferSelect | undefined;
let clock: number;
const ABSENT: FileChangeState = { kind: "absent" };
const UNKNOWN: FileChangeState = { kind: "unknown", reason: "missing_after" };

beforeEach(() => {
	// The repository bunfig preload owns HOME/NARRAFORK_HOME; never run on the real DB.
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(process.env.NARRAFORK_HOME).not.toBe(`${process.env.NARRAFORK_ORIGINAL_HOME}/.narrafork`);
	clock = Date.parse("2026-09-07T00:00:00.000Z");
	service = new FileChangeEvidenceService(db, () => new Date(clock++).toISOString());
	source = `evidence-test-${generateId()}`;
	blobIds = [];
	toolFixtures = [];
	binding = {
		deviceId: "local",
		runtimeEpoch: "executor-test",
		runtimeGeneration: 1,
		fencingToken: 0,
	};
	actor = {
		kind: "primary",
		subjectKey: `${source}:author`,
		narratorId: null,
		userId: null,
		label: "Author",
		deleted: false,
		parentSubjectKey: null,
	};
	oldBudget = db
		.select()
		.from(fileChangeStorageBudgets)
		.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
		.get();
	if (oldBudget) {
		db.update(fileChangeStorageBudgets)
			.set({ status: "ready" })
			.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.run();
	} else {
		db.insert(fileChangeStorageBudgets)
			.values({
				id: FILE_CHANGE_BLOB_BUDGET_ID,
				namespaceKey: "isolated-evidence-tests",
				status: "ready",
				quotaBytes: FILE_CHANGE_LIMITS.blobSoftQuotaBytes,
				updatedAt: new Date(clock).toISOString(),
			})
			.run();
	}
	scope = service.prepareScope({
		sourceInstanceId: source,
		deviceId: "local",
		workspaceInstanceId: generateId(),
		pathFlavor: "posix",
		canonicalRoot: "/repo",
	});
});

afterEach(() => {
	sqlite.run("DROP TRIGGER IF EXISTS evidence_test_failure");
	sqlite.run("PRAGMA defer_foreign_keys = OFF");
	for (const fixture of toolFixtures) {
		db.delete(narratorToolCalls).where(eq(narratorToolCalls.id, fixture.toolCallId)).run();
	}
	const operations = db
		.select({ id: fileChangeOperations.id })
		.from(fileChangeOperations)
		.where(eq(fileChangeOperations.sourceInstanceId, source))
		.all();
	if (operations.length)
		db.delete(fileChangeEffects)
			.where(
				inArray(
					fileChangeEffects.operationId,
					operations.map((row) => row.id),
				),
			)
			.run();
	db.delete(fileChangeOperations).where(eq(fileChangeOperations.sourceInstanceId, source)).run();
	for (const fixture of toolFixtures) {
		db.delete(narratorMessages).where(eq(narratorMessages.id, fixture.messageId)).run();
		db.delete(narrators).where(eq(narrators.id, fixture.narratorId)).run();
	}
	db.delete(fileChangeScopes).where(eq(fileChangeScopes.sourceInstanceId, source)).run();
	if (blobIds.length) db.delete(fileChangeBlobs).where(inArray(fileChangeBlobs.id, blobIds)).run();
	if (oldBudget)
		db.update(fileChangeStorageBudgets)
			.set(oldBudget)
			.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.run();
	else
		db.delete(fileChangeStorageBudgets)
			.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.run();
});

function hash(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

function known(
	sizeBytes = 3,
	status: "ready" | "staging" | "missing" | "expired" = "ready",
): FileChangeState {
	const id = generateId();
	const digest = hash(id);
	blobIds.push(id);
	db.insert(fileChangeBlobs)
		.values({
			id,
			digest,
			sizeBytes,
			status,
			storageKey: `${digest.slice(0, 2)}/${digest}`,
			createdAt: new Date(clock).toISOString(),
			updatedAt: new Date(clock).toISOString(),
		})
		.run();
	return { kind: "regular", blob: { algorithm: "sha256", digest, sizeBytes }, mode: 0o644 };
}

function activate(target = scope) {
	const verified = service.recordScopeVerification({
		scopeId: target.id,
		canonicalRoot: target.canonicalRoot,
		rootIdentity: { inode: `inode-${target.id}` },
	});
	if (target.id === scope.id) scope = verified;
	return verified;
}

function operationInput(
	overrides: Partial<BeginFileChangeOperation> = {},
): BeginFileChangeOperation {
	return {
		sourceInstanceId: source,
		sourceKind: "tool",
		sourceId: generateId(),
		attempt: 1,
		requestDigest: hash("fixed request"),
		expectedEffectCount: 1,
		actor,
		executionBinding: binding,
		...overrides,
	};
}

function effectInput(
	before: FileChangeState = ABSENT,
	intendedAfter: FileChangeState = known(),
	path = "a.txt",
): PrepareFileChangeEffect {
	return {
		identity: createFileChangeIdentity(scope, {
			deviceId: scope.deviceId,
			pathFlavor: scope.pathFlavor,
			objectRole: "referent",
			lexicalPath: `${scope.canonicalRoot}/${path}`,
			canonicalPath: `${scope.canonicalRoot}/${path}`,
		}),
		scopeRevision: scope.revision,
		requestDigest: hash(path),
		before,
		intendedAfter,
	};
}

async function readyEffect(before: FileChangeState = ABSENT, after: FileChangeState = known()) {
	activate();
	const operation = service.beginOperation(operationInput());
	const [effect] = service.prepareEffects(operation.id, [effectInput(before, after)]);
	if (!effect) throw new Error("Missing prepared fixture");
	await service.finalizePreparation(operation.id);
	return { operation, effect };
}

function apply(effect: FileChangeEffectRecord) {
	return service.markApplying({
		operationId: effect.operationId,
		mutationId: effect.mutationId,
		requestDigest: effect.requestDigest,
		executionBinding: binding,
	});
}

function receipt(
	effect: FileChangeEffectRecord,
	changes: Partial<FileChangeExecutionReceipt> = {},
): FileChangeExecutionReceipt {
	return {
		receiptId: `receipt-${effect.mutationId}`,
		mutationId: effect.mutationId,
		requestDigest: effect.requestDigest,
		executionBinding: binding,
		confirmed: true,
		outcome: "applied",
		observedAfter: effect.intendedAfterStateJson,
		...changes,
	};
}

function effectSelector(effect: FileChangeEffectRecord) {
	return {
		operationId: effect.operationId,
		mutationId: effect.mutationId,
		requestDigest: effect.requestDigest,
	};
}

function settle(
	effect: FileChangeEffectRecord,
	proof: FileChangeExecutionReceipt | null = receipt(effect),
	after?: FileChangeState,
) {
	return service.settleEffect({
		operationId: effect.operationId,
		mutationId: effect.mutationId,
		requestDigest: effect.requestDigest,
		receipt: proof,
		...(after === undefined ? {} : { observedAfter: after }),
	});
}

describe("explicit atomic settlement transactions", () => {
	test("effect and terminal outcome commit together or both roll back", async () => {
		const { operation, effect } = await readyEffect();
		apply(effect);
		expect(() =>
			db.transaction((tx) => {
				service.settleEffect({ ...effectSelector(effect), receipt: receipt(effect) }, tx);
				service.finishOperation(operation.id, "interrupted", tx);
				throw new Error("lease manifest failed");
			}),
		).toThrow("lease manifest failed");
		expect(service.getEffect(effect.operationId, effect.mutationId)).toMatchObject({
			settlement: "applying",
			executionReceiptJson: null,
		});
		expect(service.getOperation(operation.id)?.executionOutcome).toBe("running");
		db.transaction((tx) => {
			service.settleEffect({ ...effectSelector(effect), receipt: receipt(effect) }, tx);
			service.finishOperation(operation.id, "interrupted", tx);
		});
		expect(service.getEffect(effect.operationId, effect.mutationId)).toMatchObject({
			settlement: "settled",
			executionConfirmed: true,
		});
		expect(service.getOperation(operation.id)?.executionOutcome).toBe("interrupted");
	});

	test("explicit transaction must be active on the journal connection", async () => {
		const { operation, effect } = await readyEffect();
		apply(effect);
		let expired!: Parameters<typeof service.settleEffect>[1];
		db.transaction((tx) => {
			expired = tx;
		});
		expect(() =>
			service.settleEffect({ ...effectSelector(effect), receipt: receipt(effect) }, expired),
		).toThrow("current same-connection");
		expect(() => db.transaction(() => service.finishOperation(operation.id, "failed"))).toThrow(
			"ambient transaction",
		);
		expect(() =>
			db.transaction(() =>
				service.finishOperation(operation.id, "failed", {} as NonNullable<typeof expired>),
			),
		).toThrow("current same-connection");
	});

	test.each([
		false,
		true,
	])("preparation no-dispatch remains terminal and non-replayable (prepared=%s)", async (prepared) => {
		activate();
		const input = operationInput();
		const operation = service.beginOperation(input);
		const effect = prepared ? service.prepareEffects(operation.id, [effectInput()])[0] : undefined;
		const result = service.finishPreparationWithoutDispatch(operation.id, {
			targetDispatched: false,
			reason: "cancelled_before_dispatch",
		});
		expect(result).toMatchObject({
			settlement: "settled",
			executionOutcome: "interrupted",
			effectOutcome: "no_change",
			reason: "no_dispatch:cancelled_before_dispatch",
		});
		expect(service.beginOperation(input).id).toBe(operation.id);
		if (effect) {
			expect(service.getEffect(effect.operationId, effect.mutationId)).toMatchObject({
				settlement: "settled",
				outcome: "no_change",
				linesAdded: 0,
			});
			const settled = service.getEffect(effect.operationId, effect.mutationId);
			if (!settled) throw new Error("Missing settled effect");
			expect(hasConfirmedNoFileChange(sharedEffect(settled))).toBe(true);
			expect(apply(effect).mayExecute).toBe(false);
		}
	});

	test("no-dispatch proof cannot erase an applying effect", async () => {
		const { operation, effect } = await readyEffect();
		apply(effect);
		expect(() =>
			service.finishPreparationWithoutDispatch(operation.id, {
				targetDispatched: false,
				reason: "validation_rejected",
			}),
		).toThrow("preparation");
	});
});

function sharedEffect(effect: FileChangeEffectRecord): FileChangeEffect {
	return {
		id: effect.id,
		operationId: effect.operationId,
		attempt: 1,
		mutationId: effect.mutationId,
		requestDigest: effect.requestDigest,
		phase: effect.phase,
		identity: effect.identityJson,
		before: effect.beforeStateJson,
		intendedAfter: effect.intendedAfterStateJson,
		observedAfter: effect.observedAfterStateJson,
		outcome: effect.outcome,
		settlement: effect.settlement,
		attribution: effect.attributionGrade,
		executionConfirmed: effect.executionConfirmed,
		executionReceipt: effect.executionReceiptJson,
		linesAdded: effect.linesAdded,
		linesRemoved: effect.linesRemoved,
	};
}

function failSql(condition: string, table = "file_change_operations") {
	sqlite.run(
		`CREATE TRIGGER evidence_test_failure BEFORE UPDATE ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'injected evidence DB failure'); END`,
	);
}

function noDispatchInput(): BeginFileChangeOperation & { toolCallId: string; narratorId: string } {
	const fixture = { narratorId: generateId(), messageId: generateId(), toolCallId: generateId() };
	toolFixtures.push(fixture);
	const now = new Date(clock).toISOString();
	db.insert(narrators).values({ id: fixture.narratorId, createdAt: now, updatedAt: now }).run();
	db.insert(narratorMessages)
		.values({
			id: fixture.messageId,
			narratorId: fixture.narratorId,
			role: "assistant",
			contentJson: [],
			createdAt: now,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: fixture.toolCallId,
			narratorId: fixture.narratorId,
			messageId: fixture.messageId,
			toolUseId: "reused-provider-id",
			toolName: "Edit",
			createdAt: now,
			executionIdentityVersion: 1,
			executionAttempt: 1,
			status: "running",
			executionStartedAt: now,
			executionDeviceId: binding.deviceId,
			runtimeGeneration: binding.runtimeGeneration,
		})
		.run();
	return {
		...operationInput(),
		sourceId: fixture.toolCallId,
		toolCallId: fixture.toolCallId,
		toolUseId: "reused-provider-id",
		narratorId: fixture.narratorId,
		actor: { ...actor, narratorId: fixture.narratorId },
	};
}

const NO_DISPATCH = { targetDispatched: false, reason: "validation_rejected" } as const;

describe("explicit no-dispatch file-tool evidence", () => {
	test("records zero effects and links only the bound row atomically without invented bytes", () => {
		const input = noDispatchInput();
		const other = noDispatchInput();
		const result = service.beginNoDispatchOperation(input, NO_DISPATCH);
		expect(result).toMatchObject({
			expectedEffectCount: 0,
			preparedEffectCount: 0,
			settledEffectCount: 0,
			unresolvedEffectCount: 0,
			evidenceBytes: 0,
			effectOutcome: "no_change",
			executionOutcome: "failed",
			settlement: "settled",
			coverage: "complete",
			attributionGrade: "unknown",
			reason: "no_dispatch:validation_rejected",
		});
		expect(
			db.select().from(fileChangeEffects).where(eq(fileChangeEffects.operationId, result.id)).all(),
		).toEqual([]);
		const linked = (id: string) =>
			db
				.select({ operationId: narratorToolCalls.fileChangeOperationId })
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, id))
				.get()?.operationId;
		expect(linked(input.toolCallId)).toBe(result.id);
		expect(linked(other.toolCallId)).toBeNull();
		expect(service.getScope(scope.id)?.status).toBe("needs_verification");
		expect(() => service.prepareEffects(result.id, [effectInput()])).toThrow();
	});

	test("identical proof remains idempotent after the tool result, conflicting proof stays rejected", () => {
		const input = noDispatchInput();
		const result = service.beginNoDispatchOperation(input, NO_DISPATCH);
		db.update(narratorToolCalls)
			.set({ status: "fail" })
			.where(eq(narratorToolCalls.id, input.toolCallId))
			.run();
		expect(service.beginNoDispatchOperation(input, NO_DISPATCH)).toEqual(result);
		expect(() =>
			service.beginNoDispatchOperation(input, {
				targetDispatched: false,
				reason: "cancelled_before_dispatch",
			}),
		).toThrow("cannot become");
		expect(service.getOperation(result.id)).toEqual(result);
	});

	test("zero effects do not require or promote the blob namespace", () => {
		const input = noDispatchInput();
		db.update(fileChangeStorageBudgets)
			.set({ status: "unverified" })
			.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.run();
		expect(service.beginNoDispatchOperation(input, NO_DISPATCH).effectOutcome).toBe("no_change");
		expect(
			db
				.select()
				.from(fileChangeStorageBudgets)
				.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
				.get()?.status,
		).toBe("unverified");
	});

	for (const [name, patch] of [
		["legacy identity", { executionIdentityVersion: 0 }],
		["COW clone", { executionOriginToolCallId: "original-row" }],
		["history checkpoint", { isFileHistoryCheckpoint: true }],
		["different attempt", { executionAttempt: 2 }],
		["different runtime", { runtimeGeneration: 2 }],
		["different device", { executionDeviceId: "remote" }],
		["non-file tool", { toolName: "Bash" }],
		["unclaimed attempt", { executionStartedAt: null }],
		["completed attempt", { status: "success" }],
	] as const) {
		test(`rejects ${name} instead of guessing no change`, () => {
			const input = noDispatchInput();
			db.update(narratorToolCalls)
				.set(patch)
				.where(eq(narratorToolCalls.id, input.toolCallId))
				.run();
			expect(() => service.beginNoDispatchOperation(input, NO_DISPATCH)).toThrow();
			expect(
				db
					.select({ id: fileChangeOperations.id })
					.from(fileChangeOperations)
					.where(eq(fileChangeOperations.sourceInstanceId, source))
					.all(),
			).toEqual([]);
		});
	}

	test("rejects dispatched/unknown proof, actor substitution and an existing ordinary intent", () => {
		const input = noDispatchInput();
		expect(() =>
			service.beginNoDispatchOperation(input, { ...NO_DISPATCH, targetDispatched: true as false }),
		).toThrow("explicit no-dispatch");
		expect(() => service.beginNoDispatchOperation({ ...input, actor }, NO_DISPATCH)).toThrow(
			"explicit no-dispatch",
		);
		const existing = service.beginOperation(input);
		expect(() => service.beginNoDispatchOperation(input, NO_DISPATCH)).toThrow("cannot become");
		expect(service.getOperation(existing.id)).toEqual(existing);
	});

	test("failure linking the tool row rolls back the zero-effect evidence insertion", () => {
		const input = noDispatchInput();
		failSql("NEW.file_change_operation_id IS NOT NULL", "narrator_tool_calls");
		expect(() => service.beginNoDispatchOperation(input, NO_DISPATCH)).toThrow("injected");
		expect(
			db
				.select({ id: fileChangeOperations.id })
				.from(fileChangeOperations)
				.where(eq(fileChangeOperations.sourceInstanceId, source))
				.all(),
		).toEqual([]);
		expect(
			db
				.select({ operationId: narratorToolCalls.fileChangeOperationId })
				.from(narratorToolCalls)
				.where(eq(narratorToolCalls.id, input.toolCallId))
				.get()?.operationId,
		).toBeNull();
	});
});

describe("durable scope and operation identity", () => {
	test("scopes default unverified and preparing effects do not enable execution", async () => {
		expect(scope.status).toBe("needs_verification");
		const operation = service.beginOperation(operationInput());
		const [effect] = service.prepareEffects(operation.id, [effectInput()]);
		expect(effect?.observedAfterStateJson).toEqual(UNKNOWN);
		expect(effect?.outcome).toBe("pending");
		await expect(service.finalizePreparation(operation.id)).rejects.toThrow("not verified");
		expect(service.getOperation(operation.id)?.settlement).toBe("preparing");
		if (effect) expect(() => apply(effect)).toThrow("intent must be durable");
	});

	test("same instance root cannot drift, retired scope cannot be revived", () => {
		const input = {
			sourceInstanceId: source,
			deviceId: scope.deviceId,
			workspaceInstanceId: scope.workspaceInstanceId,
			pathFlavor: scope.pathFlavor,
			canonicalRoot: "/repo/./",
		};
		expect(service.prepareScope(input).id).toBe(scope.id);
		expect(() => service.prepareScope({ ...input, canonicalRoot: "/other" })).toThrow(
			"cannot change its root",
		);
		activate();
		expect(() =>
			service.recordScopeVerification({
				scopeId: scope.id,
				canonicalRoot: "/repo",
				rootIdentity: { inode: "replacement" },
			}),
		).toThrow("new workspace instance");
		db.update(fileChangeScopes)
			.set({ status: "retired" })
			.where(eq(fileChangeScopes.id, scope.id))
			.run();
		expect(() => activate()).toThrow("new workspace instance");
	});

	for (const [name, patch] of [
		["an active lease", { activeLeaseId: "lease", activeLeaseEpoch: "epoch" }],
		["an unsettled mutation", { activeMutationCount: 1 }],
		["a previously verified scope awaiting recovery", { status: "needs_verification" }],
	] as const) {
		test(`root re-verification cannot clear ${name}`, () => {
			activate();
			db.update(fileChangeScopes).set(patch).where(eq(fileChangeScopes.id, scope.id)).run();
			const before = service.getScope(scope.id);
			expect(() => activate()).toThrow("require recovery");
			expect(service.getScope(scope.id)).toEqual(before);
		});
	}

	test("verification metadata must fit the complete scope row, not just the new fields", () => {
		const longRoot = `/${"r".repeat(2900)}`;
		const largeScope = service.prepareScope({
			sourceInstanceId: source,
			deviceId: "local",
			workspaceInstanceId: generateId(),
			canonicalRoot: longRoot,
			pathFlavor: "posix",
		});
		const rootIdentity = Object.fromEntries(
			Array.from({ length: 16 }, (_, i) => [`proof-${i}`, "v".repeat(150)]),
		);
		expect(() =>
			service.recordScopeVerification({
				scopeId: largeScope.id,
				canonicalRoot: longRoot,
				rootIdentity,
			}),
		).toThrow("row budget");
		expect(service.getScope(largeScope.id)?.status).toBe("needs_verification");
		expect(service.getScope(largeScope.id)?.rootIdentityJson).toBeNull();
	});

	test("device and recreated workspace instances remain distinct", () => {
		const base = {
			sourceInstanceId: source,
			deviceId: "local",
			workspaceInstanceId: scope.workspaceInstanceId,
			pathFlavor: "posix" as const,
			canonicalRoot: "/repo",
		};
		const remote = service.prepareScope({ ...base, deviceId: "remote" });
		const recreated = service.prepareScope({ ...base, workspaceInstanceId: generateId() });
		expect(new Set([scope.id, remote.id, recreated.id]).size).toBe(3);
	});

	test("begin is idempotent for the actual source+attempt, not toolUseId", () => {
		const input = operationInput({ toolUseId: "reused-provider-id" });
		const first = service.beginOperation(input);
		expect(service.beginOperation(input)).toEqual(first);
		expect(service.beginOperation({ ...input, attempt: 2 }).id).not.toBe(first.id);
		expect(service.beginOperation({ ...input, sourceKind: "editor" }).id).not.toBe(first.id);
		expect(service.beginOperation({ ...input, sourceId: generateId() }).id).not.toBe(first.id);
		for (const changes of [
			{ requestDigest: hash("changed") },
			{ expectedEffectCount: 2 },
			{ actor: { ...actor, subjectKey: "someone-else" } },
			{ executionBinding: { ...binding, runtimeGeneration: 2 } },
		]) {
			expect(() => service.beginOperation({ ...input, ...changes })).toThrow(
				"cannot change its request",
			);
		}
	});

	test("legacy nullable request/count rows remain visible but never executable", async () => {
		const op = service.beginOperation(operationInput());
		db.update(fileChangeOperations)
			.set({ requestDigest: null, expectedEffectCount: null })
			.where(eq(fileChangeOperations.id, op.id))
			.run();
		expect(service.getOperation(op.id)?.requestDigest).toBeNull();
		await expect(service.finalizePreparation(op.id)).rejects.toThrow("Pre-journal");
		expect(() => service.prepareEffects(op.id, [effectInput()])).toThrow("Pre-journal");
		expect(
			service
				.listPendingOperations({ settlement: "preparing" })
				.items.some((item) => item.id === op.id),
		).toBe(true);
	});

	test("raw body fields, null absence and oversized metadata are rejected", () => {
		expect(() =>
			service.beginOperation(operationInput({ actor: { ...actor, label: "x".repeat(513) } })),
		).toThrow();
		const op = service.beginOperation(operationInput());
		expect(() =>
			service.prepareEffects(op.id, [effectInput(null as unknown as FileChangeState)]),
		).toThrow("Absence must be explicit");
		expect(() =>
			service.prepareEffects(op.id, [
				effectInput({ kind: "absent", body: "secret" } as FileChangeState),
			]),
		).toThrow("Unexpected fields");
		expect(() =>
			service.prepareEffects(op.id, [
				effectInput(ABSENT, { kind: "directory" } as unknown as FileChangeState),
			]),
		).toThrow("Unsupported file object");
		expect(service.listEffects(op.id).items).toHaveLength(0);
	});
});

describe("bounded complete preparation", () => {
	test("unknown before/intended cannot masquerade as absent or durable intent", () => {
		const op = service.beginOperation(operationInput());
		for (const input of [effectInput(UNKNOWN, ABSENT), effectInput(ABSENT, UNKNOWN)])
			expect(() => service.prepareEffects(op.id, [input])).toThrow("known before");
		expect(service.getOperation(op.id)?.preparedEffectCount).toBe(0);
		expect(service.getOperation(op.id)?.effectOutcome).toBe("pending");
	});

	test("ready catalog status, namespace and exact sizes are required", () => {
		const op = service.beginOperation(operationInput());
		for (const status of ["staging", "missing", "expired"] as const)
			expect(() => service.prepareEffects(op.id, [effectInput(ABSENT, known(3, status))])).toThrow(
				"ready catalog",
			);
		const ready = known();
		if (ready.kind !== "regular") throw new Error("fixture");
		expect(() =>
			service.prepareEffects(op.id, [
				effectInput(ABSENT, { ...ready, blob: { ...ready.blob, sizeBytes: 4 } }),
			]),
		).toThrow("matching size");
		expect(() =>
			service.prepareEffects(op.id, [
				effectInput(ABSENT, { ...ready, blob: { ...ready.blob, digest: "a".repeat(64) } }),
			]),
		).toThrow("ready catalog");
		db.update(fileChangeStorageBudgets)
			.set({ status: "unverified" })
			.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
			.run();
		expect(() => service.prepareEffects(op.id, [effectInput(ABSENT, ready)])).toThrow(
			"reconciliation must finish",
		);
		expect(service.getOperation(op.id)?.evidenceBytes).toBe(0);
	});

	test("effect retry is immutable and does not double-count references or bytes", () => {
		const op = service.beginOperation(operationInput());
		const input = effectInput(known(4), known(5));
		const [first] = service.prepareEffects(op.id, [input]);
		expect(service.prepareEffects(op.id, [input])).toEqual([first]);
		for (const changes of [
			{ requestDigest: hash("other") },
			{ before: ABSENT },
			{ intendedAfter: known() },
			{ identity: { ...input.identity, lexicalPath: "/alias/a.txt" } },
		])
			expect(() => service.prepareEffects(op.id, [{ ...input, ...changes }])).toThrow(
				"cannot change its prepared",
			);
		expect(service.getOperation(op.id)?.preparedEffectCount).toBe(1);
		expect(service.getOperation(op.id)?.evidenceBytes).toBe(9);
	});

	test("whole expected target count must exist before intent_durable", async () => {
		activate();
		const op = service.beginOperation(operationInput({ expectedEffectCount: 2 }));
		const [first] = service.prepareEffects(op.id, [effectInput()]);
		await expect(service.finalizePreparation(op.id)).rejects.toThrow("Every declared effect");
		if (first) expect(() => apply(first)).toThrow();
		service.prepareEffects(op.id, [effectInput(ABSENT, ABSENT, "b")]);
		expect((await service.finalizePreparation(op.id)).settlement).toBe("intent_durable");
		expect(() => service.prepareEffects(op.id, [effectInput(ABSENT, ABSENT, "c")])).toThrow();
		expect(
			service.listEffects(op.id).items.every((row) => row.settlement === "intent_durable"),
		).toBe(true);
	});

	test("batch size, target count, per-blob and total evidence limits reject rather than truncate", async () => {
		expect(() => service.beginOperation(operationInput({ expectedEffectCount: 0 }))).toThrow();
		expect(() => service.beginOperation(operationInput({ expectedEffectCount: 1001 }))).toThrow();
		const op = service.beginOperation(operationInput({ expectedEffectCount: 40 }));
		expect(() =>
			service.prepareEffects(
				op.id,
				Array.from({ length: 33 }, (_, i) => effectInput(ABSENT, ABSENT, String(i))),
			),
		).toThrow();
		expect(service.listEffects(op.id).items).toHaveLength(0);
		const large = known(FILE_CHANGE_LIMITS.blobBytes);
		const four = Array.from({ length: 4 }, (_, i) => effectInput(large, large, String(i)));
		service.prepareEffects(op.id, four);
		expect(service.getOperation(op.id)?.evidenceBytes).toBe(
			FILE_CHANGE_LIMITS.operationEvidenceBytes,
		);
		expect(() => service.prepareEffects(op.id, [effectInput(ABSENT, known(1), "over")])).toThrow(
			"over-budget evidence bytes",
		);
		expect(service.getOperation(op.id)?.preparedEffectCount).toBe(4);
		const oversized = known(FILE_CHANGE_LIMITS.blobBytes + 1);
		expect(() => service.prepareEffects(op.id, [effectInput(ABSENT, oversized, "huge")])).toThrow(
			"blob size",
		);
		await expect(
			service.prepareOperation({
				...operationInput({ expectedEffectCount: 5 }),
				effects: [...four, effectInput(ABSENT, known(1), "over")],
			}),
		).rejects.toThrow("evidence bytes");
	});

	test("prepared counters alone cannot prove the presence of the expected effect set", async () => {
		activate();
		const operation = service.beginOperation(operationInput());
		db.update(fileChangeOperations)
			.set({ preparedEffectCount: 1 })
			.where(eq(fileChangeOperations.id, operation.id))
			.run();
		await expect(service.finalizePreparation(operation.id)).rejects.toThrow(
			"complete intent is not durable",
		);
		expect(service.getOperation(operation.id)?.settlement).toBe("preparing");
	});

	test("prepareOperation refuses duplicate fixed targets and mismatched count", async () => {
		const input = effectInput();
		await expect(
			service.prepareOperation({
				...operationInput({ expectedEffectCount: 2 }),
				effects: [input, input],
			}),
		).rejects.toThrow("duplicates");
		await expect(
			service.prepareOperation({ ...operationInput({ expectedEffectCount: 2 }), effects: [input] }),
		).rejects.toThrow("count does not match");
	});

	test("1000 effects are recorded completely over yielded bounded transactions", async () => {
		activate();
		let yielded = false;
		setImmediate(() => {
			yielded = true;
		});
		const op = await service.prepareOperation({
			...operationInput({ expectedEffectCount: 1000 }),
			effects: Array.from({ length: 1000 }, (_, index) =>
				effectInput(ABSENT, ABSENT, `file-${index}`),
			),
		});
		expect(yielded).toBe(true);
		expect(op.preparedEffectCount).toBe(1000);
		expect(op.settlement).toBe("intent_durable");
		let count = 0;
		let cursor: FileChangeEffectCursor | undefined;
		do {
			const page = service.listEffects(op.id, { cursor, limit: 100 });
			count += page.items.length;
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(count).toBe(1000);
	}, 30_000);

	test("POSIX backslash, symlink entry/referent and compensate phases stay distinct", () => {
		const op = service.beginOperation(operationInput({ expectedEffectCount: 3 }));
		const input = effectInput(ABSENT, ABSENT, "a\\b");
		const effects = service.prepareEffects(op.id, [
			input,
			{ ...input, phase: "compensate" },
			{ ...input, identity: { ...input.identity, objectRole: "entry" } },
		]);
		expect(new Set(effects.map((item) => item.mutationId)).size).toBe(3);
		expect(effects[0]?.identityJson.displayPath).toBe("a\\b");
	});

	test("wrong scope, external targets and stale scope revision are rejected", () => {
		const op = service.beginOperation(operationInput());
		const input = effectInput();
		for (const changes of [
			{ scopeRevision: 1 },
			{ identity: { ...input.identity, deviceId: "remote" } },
			{ identity: { ...input.identity, canonicalPath: "/outside/a.txt" } },
		])
			expect(() => service.prepareEffects(op.id, [{ ...input, ...changes }])).toThrow();
		expect(service.getOperation(op.id)?.preparedEffectCount).toBe(0);
	});
});

describe("execution and receipt settlement", () => {
	for (const ceiling of ["observed_ambiguous", "unknown"] as const) {
		test(`first-settlement ${ceiling} ceiling lowers attribution without inventing execution uncertainty`, async () => {
			const { operation, effect } = await readyEffect();
			apply(effect);
			const input = {
				...effectSelector(effect),
				receipt: receipt(effect),
				attributionCeiling: ceiling,
				linesAdded: 3,
				linesRemoved: 2,
			};
			const result = service.settleEffect(input);
			expect(result).toMatchObject({
				outcome: "changed",
				settlement: "settled",
				executionConfirmed: true,
				attributionGrade: ceiling,
				linesAdded: null,
				linesRemoved: null,
			});
			expect(hasSettledMeasuredFileEffect(sharedEffect(result))).toBe(false);
			expect(service.getOperation(operation.id)?.unresolvedEffectCount).toBe(0);
			expect(service.settleEffect(input)).toEqual(result);
			expect(() => service.settleEffect({ ...input, attributionCeiling: "measured" })).toThrow(
				"cannot be overwritten",
			);
		});
	}

	for (const ceiling of ["observed_ambiguous", "unknown"] as const) {
		test(`receipt reconciliation preserves a durable ${ceiling} ceiling across service restart`, async () => {
			const { effect } = await readyEffect();
			apply(effect);
			service.settleEffect({
				...effectSelector(effect),
				receipt: null,
				observedAfter: effect.intendedAfterStateJson,
				attributionCeiling: ceiling,
			});
			service = new FileChangeEvidenceService(db, () => new Date(clock++).toISOString());
			const final = settle(effect);
			expect(final).toMatchObject({
				attributionCeiling: ceiling,
				attributionGrade: ceiling,
				executionConfirmed: true,
				outcome: "changed",
				settlement: "settled",
				linesAdded: null,
				linesRemoved: null,
			});
			expect(hasSettledMeasuredFileEffect(sharedEffect(final))).toBe(false);
			expect(settle(effect)).toEqual(final);
			expect(apply(effect).mayExecute).toBe(false);
		});
	}

	test("unfrozen ceilings may decrease but an explicit upgrade cannot change the pending evidence", async () => {
		const { effect } = await readyEffect();
		apply(effect);
		settle(effect, null, effect.intendedAfterStateJson);
		const lower = service.settleEffect({
			...effectSelector(effect),
			receipt: null,
			observedAfter: effect.intendedAfterStateJson,
			attributionCeiling: "observed_ambiguous",
		});
		expect(lower.attributionCeiling).toBe("observed_ambiguous");
		expect(() =>
			service.settleEffect({
				...effectSelector(effect),
				receipt: receipt(effect),
				attributionCeiling: "measured",
			}),
		).toThrow("cannot be overwritten");
		expect(
			db.select().from(fileChangeEffects).where(eq(fileChangeEffects.id, effect.id)).get(),
		).toEqual(lower);
		expect(settle(effect).attributionGrade).toBe("observed_ambiguous");
	});

	test("pre-column provisional uncertainty is conservative and pre-column receipts stay immutable", async () => {
		const { effect } = await readyEffect();
		apply(effect);
		settle(effect, null, effect.intendedAfterStateJson);
		db.update(fileChangeEffects)
			.set({ attributionCeiling: null })
			.where(eq(fileChangeEffects.id, effect.id))
			.run();
		const resolved = settle(effect);
		expect(resolved.attributionGrade).toBe("observed_ambiguous");
		db.update(fileChangeEffects)
			.set({ attributionCeiling: null })
			.where(eq(fileChangeEffects.id, effect.id))
			.run();
		const legacyFrozen = db
			.select()
			.from(fileChangeEffects)
			.where(eq(fileChangeEffects.id, effect.id))
			.get();
		if (!legacyFrozen) throw new Error("Missing legacy receipt fixture");
		expect(settle(effect)).toEqual(legacyFrozen);
		expect(settle(effect).attributionCeiling).toBeNull();
	});

	test("an explicit null ceiling is invalid rather than silently treated as measured", async () => {
		const { effect } = await readyEffect();
		apply(effect);
		expect(() =>
			service.settleEffect({
				...effectSelector(effect),
				receipt: receipt(effect),
				attributionCeiling: null as unknown as "measured",
			}),
		).toThrow("Invalid attribution confidence ceiling");
	});

	test("later activity cannot lower an already frozen receipt even with unchanged null line counts", async () => {
		const { effect } = await readyEffect();
		apply(effect);
		const input = { ...effectSelector(effect), receipt: receipt(effect) };
		const recorded = service.settleEffect(input);
		expect(recorded.linesAdded).toBeNull();
		expect(() =>
			service.settleEffect({ ...input, attributionCeiling: "observed_ambiguous" }),
		).toThrow("cannot be overwritten");
		expect(service.settleEffect(input)).toEqual(recorded);
	});

	test("a measured ceiling cannot upgrade a missing execution receipt", async () => {
		const { effect } = await readyEffect();
		apply(effect);
		const result = service.settleEffect({
			...effectSelector(effect),
			receipt: null,
			observedAfter: effect.intendedAfterStateJson,
			attributionCeiling: "measured",
		});
		expect(result).toMatchObject({
			executionConfirmed: false,
			outcome: "unknown",
			settlement: "reconcile_required",
			attributionGrade: "observed_ambiguous",
		});
	});

	test("only the first applying transition grants execution; receipt retries never re-grant it", async () => {
		const { operation, effect } = await readyEffect();
		expect(() => settle(effect)).toThrow("attempted effect");
		expect(apply(effect).mayExecute).toBe(true);
		expect(apply(effect).mayExecute).toBe(false);
		const settled = settle(effect);
		expect(settle(effect)).toEqual(settled);
		expect(apply(effect).mayExecute).toBe(false);
		expect(settled.outcome).toBe("changed");
		expect(hasSettledMeasuredFileEffect(sharedEffect(settled))).toBe(true);
		expect(service.getOperation(operation.id)?.settlement).toBe("applying");
		expect(service.finishOperation(operation.id, "succeeded").settlement).toBe("settled");
		expect(service.getOperation(operation.id)?.settledEffectCount).toBe(1);
	});

	test("generation and fencing drift cannot authorize a new write", async () => {
		const { effect } = await readyEffect();
		expect(() =>
			service.markApplying({
				...effectSelector(effect),
				executionBinding: { ...binding, runtimeGeneration: 2 },
			}),
		).toThrow("binding changed");
		db.update(fileChangeScopes)
			.set({ fencingToken: 1 })
			.where(eq(fileChangeScopes.id, scope.id))
			.run();
		expect(() => apply(effect)).toThrow("execution fence");
	});

	test("ready references are rechecked at apply, not only at prepare", async () => {
		const { effect } = await readyEffect();
		if (!effect.intendedAfterBlobDigest) throw new Error("fixture");
		db.update(fileChangeBlobs)
			.set({ status: "missing" })
			.where(eq(fileChangeBlobs.digest, effect.intendedAfterBlobDigest))
			.run();
		expect(() => apply(effect)).toThrow("ready catalog");
		expect(service.getEffect(effect.operationId, effect.mutationId)?.settlement).toBe(
			"intent_durable",
		);
	});

	test.each([
		"failed",
		"interrupted",
	] as const)("%s execution may still have a measured changed file", async (outcome) => {
		const { operation, effect } = await readyEffect();
		apply(effect);
		expect(service.finishOperation(operation.id, outcome).settlement).toBe("reconcile_required");
		const result = settle(effect);
		expect(result.outcome).toBe("changed");
		expect(service.getOperation(operation.id)?.executionOutcome).toBe(outcome);
		expect(service.getOperation(operation.id)?.effectOutcome).toBe("changed");
		expect(service.getOperation(operation.id)?.settlement).toBe("settled");
	});

	test("an unchanged hash without a receipt is not successful execution or no_change", async () => {
		const same = known();
		const { operation, effect } = await readyEffect(same, same);
		apply(effect);
		const unresolved = settle(effect, null, same);
		expect(unresolved.outcome).toBe("unknown");
		expect(unresolved.attributionGrade).toBe("observed_ambiguous");
		expect(unresolved.executionConfirmed).toBe(false);
		expect(service.finishOperation(operation.id, "succeeded").settlement).toBe(
			"reconcile_required",
		);
		expect(hasSettledMeasuredFileEffect(sharedEffect(unresolved))).toBe(false);
	});

	test("later matching durable receipt may resolve a previously unconfirmed observation", async () => {
		const { operation, effect } = await readyEffect();
		apply(effect);
		settle(effect, null, effect.intendedAfterStateJson);
		expect(service.getOperation(operation.id)?.unresolvedEffectCount).toBe(1);
		settle(effect);
		expect(service.getOperation(operation.id)?.unresolvedEffectCount).toBe(0);
		expect(service.finishOperation(operation.id, "succeeded").settlement).toBe("settled");
	});

	test.each([
		false,
		true,
	])("unknown mutation outcome remains unknown with confirmed=%s", async (confirmed) => {
		const { effect } = await readyEffect();
		apply(effect);
		const result = settle(effect, receipt(effect, { confirmed, outcome: "unknown" }));
		expect(result.executionConfirmed).toBe(false);
		expect(result.outcome).toBe("unknown");
		expect(result.settlement).toBe("reconcile_required");
	});

	test("unconfirmed applied receipt and missing after remain unresolved", async () => {
		const { effect } = await readyEffect();
		apply(effect);
		const noAfter = settle(effect, null);
		expect(noAfter.observedAfterStateJson).toEqual(UNKNOWN);
		expect(noAfter.outcome).toBe("unknown");
		const result = settle(effect, receipt(effect, { confirmed: false, observedAfter: UNKNOWN }));
		expect(result.outcome).toBe("unknown");
		expect(result.attributionGrade).toBe("unknown");
		expect(result.settlement).toBe("reconcile_required");
	});

	test("confirmed execution with unknown after cannot become a deletion or no-op", async () => {
		const { effect } = await readyEffect(known(), ABSENT);
		apply(effect);
		const result = settle(effect, receipt(effect, { observedAfter: UNKNOWN }));
		expect(result.executionConfirmed).toBe(true);
		expect(result.observedAfterStateJson.kind).toBe("unknown");
		expect(result.observedAfterBlobDigest).toBeNull();
		expect(result.outcome).toBe("unknown");
	});

	test("confirmed observation differing from intended is preserved as ambiguous", async () => {
		const { operation, effect } = await readyEffect();
		const external = known(9);
		apply(effect);
		const result = settle(effect, receipt(effect, { observedAfter: external }));
		expect(result.observedAfterStateJson).toEqual(external);
		expect(result.outcome).toBe("unknown");
		expect(result.attributionGrade).toBe("observed_ambiguous");
		expect(result.settlement).toBe("reconcile_required");
		expect(service.getOperation(operation.id)?.evidenceBytes).toBe(12);
	});

	test("confirmed not_applied is no_change for the mutation, not ownership of external bytes", async () => {
		const { operation, effect } = await readyEffect();
		const external = known(8);
		apply(effect);
		const result = settle(
			effect,
			receipt(effect, { outcome: "not_applied", observedAfter: external }),
		);
		expect(result.outcome).toBe("no_change");
		expect(result.attributionGrade).toBe("observed_ambiguous");
		expect(hasConfirmedNoFileChange(sharedEffect(result))).toBe(true);
		expect(hasSettledMeasuredFileEffect(sharedEffect(result))).toBe(false);
		const op = service.finishOperation(operation.id, "failed");
		expect(op.settlement).toBe("settled");
		expect(op.attributionGrade).not.toBe("measured");
	});

	test("failed without explicit not_applied receipt cannot imply no_change", async () => {
		const { operation, effect } = await readyEffect();
		apply(effect);
		settle(effect, null, ABSENT);
		const op = service.finishOperation(operation.id, "failed");
		expect(op.effectOutcome).toBe("unknown");
		expect(op.settlement).toBe("reconcile_required");
	});

	test("actual identical confirmed apply is a measured no_change", async () => {
		const same = known();
		const { effect } = await readyEffect(same, same);
		apply(effect);
		const result = settle(effect);
		expect(result.outcome).toBe("no_change");
		expect(result.linesAdded).toBe(0);
		expect(hasSettledMeasuredFileEffect(sharedEffect(result))).toBe(true);
	});

	test("creation, explicit deletion, symlink bytes and mode-only effects retain object semantics", async () => {
		const file = known();
		if (file.kind !== "regular") throw new Error("fixture");
		const link: FileChangeState = { kind: "symlink", target: file.blob, mode: 0o777 };
		for (const [before, after] of [
			[ABSENT, file],
			[file, ABSENT],
			[file, { ...file, mode: 0o755 }],
			[link, ABSENT],
		] as [FileChangeState, FileChangeState][]) {
			const { effect } = await readyEffect(before, after);
			apply(effect);
			const result = settle(effect);
			expect(result.outcome).toBe("changed");
			expect(result.observedAfterStateJson).toEqual(after);
			expect(hasSettledMeasuredFileEffect(sharedEffect(result))).toBe(true);
		}
	});

	test("different receipt identity, observation, digest or binding cannot replace original evidence", async () => {
		const { effect } = await readyEffect();
		apply(effect);
		const original = settle(effect);
		for (const changes of [
			{ receiptId: "other" },
			{ mutationId: "other" },
			{ requestDigest: hash("other") },
			{ observedAfter: ABSENT },
			{ executionBinding: { ...binding, runtimeEpoch: "new" } },
		])
			expect(() => settle(effect, receipt(effect, changes))).toThrow();
		expect(() => settle(effect, null, effect.intendedAfterStateJson)).toThrow(
			"cannot be overwritten",
		);
		expect(service.getEffect(effect.operationId, effect.mutationId)).toEqual(original);
	});

	test("receipt observation mismatch, null after and contradictory repeated lines are rejected", async () => {
		const { effect } = await readyEffect();
		apply(effect);
		expect(() => settle(effect, receipt(effect), ABSENT)).toThrow("receipt's own observation");
		expect(() => settle(effect, null, null as unknown as FileChangeState)).toThrow(
			"Absence must be explicit",
		);
		service.settleEffect({ ...effectSelector(effect), receipt: receipt(effect), linesAdded: 1 });
		expect(() =>
			service.settleEffect({ ...effectSelector(effect), receipt: receipt(effect), linesAdded: 2 }),
		).toThrow("cannot be overwritten");
	});

	test("previous unconfirmed known observation is retained if a later different state appears", async () => {
		const { effect } = await readyEffect();
		apply(effect);
		settle(effect, null, ABSENT);
		expect(() => settle(effect)).toThrow("previously recorded observation");
		expect(
			service.getEffect(effect.operationId, effect.mutationId)?.observedAfterStateJson,
		).toEqual(ABSENT);
	});

	test("one unresolved effect keeps the whole completed operation unsettled", async () => {
		activate();
		const op = await service.prepareOperation({
			...operationInput({ expectedEffectCount: 2 }),
			effects: [effectInput(), effectInput(ABSENT, ABSENT, "b")],
		});
		const effects = service.listEffects(op.id).items;
		for (const effect of effects) apply(effect);
		const [first, second] = effects;
		if (!first || !second) throw new Error("fixture");
		settle(first);
		settle(second, null);
		const result = service.finishOperation(op.id, "succeeded");
		expect(result.settledEffectCount).toBe(1);
		expect(result.unresolvedEffectCount).toBe(1);
		expect(result.effectOutcome).toBe("unknown");
		expect(result.coverage).toBe("partial");
		expect(result.settlement).toBe("reconcile_required");
	});

	test("terminal tool outcome is idempotent and cannot be rewritten", async () => {
		const { operation, effect } = await readyEffect();
		apply(effect);
		settle(effect);
		const first = service.finishOperation(operation.id, "failed");
		expect(service.finishOperation(operation.id, "failed")).toEqual(first);
		expect(() => service.finishOperation(operation.id, "succeeded")).toThrow("immutable");
	});
});

describe("durable failures, crash inventory and bounded reads", () => {
	test("ambient transactions cannot turn savepoint release into permission to write", async () => {
		const { operation, effect } = await readyEffect();
		expect(() => db.transaction(() => apply(effect))).toThrow("ambient transaction");
		expect(service.getOperation(operation.id)?.settlement).toBe("intent_durable");
		expect(service.getEffect(operation.id, effect.mutationId)?.settlement).toBe("intent_durable");
		expect(() =>
			db.transaction((tx) => new FileChangeEvidenceService(tx as unknown as typeof db)),
		).toThrow("root SQLite connection");
	});

	test("DB failure rolls back effect insert and counters together", () => {
		const op = service.beginOperation(operationInput({ expectedEffectCount: 2 }));
		failSql(`OLD.id = '${op.id}' AND NEW.prepared_effect_count = 2`);
		expect(() =>
			service.prepareEffects(op.id, [effectInput(), effectInput(ABSENT, ABSENT, "b")]),
		).toThrow();
		expect(service.listEffects(op.id).items).toHaveLength(0);
		expect(service.getOperation(op.id)?.preparedEffectCount).toBe(0);
		expect(service.getOperation(op.id)?.evidenceBytes).toBe(0);
		expect(service.getOperation(op.id)?.settlement).toBe("preparing");
	});

	test("DB failure after a preparation page preserves the incomplete operation for restart", async () => {
		activate();
		const count = FILE_CHANGE_PREPARE_BATCH_ITEMS + 1;
		const op = service.beginOperation(operationInput({ expectedEffectCount: count }));
		const inputs = Array.from({ length: count }, (_, i) => effectInput(ABSENT, ABSENT, String(i)));
		service.prepareEffects(op.id, inputs.slice(0, FILE_CHANGE_PREPARE_BATCH_ITEMS));
		service.prepareEffects(op.id, inputs.slice(FILE_CHANGE_PREPARE_BATCH_ITEMS));
		const last = service.listEffects(op.id).items.at(-1);
		if (!last) throw new Error("fixture");
		failSql(`OLD.id = '${last.id}' AND NEW.settlement = 'intent_durable'`, "file_change_effects");
		await expect(service.finalizePreparation(op.id)).rejects.toThrow();
		const intermediate = service.listEffects(op.id).items;
		expect(intermediate.filter((row) => row.settlement === "intent_durable")).toHaveLength(
			FILE_CHANGE_PREPARE_BATCH_ITEMS,
		);
		expect(service.getOperation(op.id)?.settlement).toBe("preparing");
		const first = intermediate[0];
		if (first) expect(() => apply(first)).toThrow();
		sqlite.run("DROP TRIGGER evidence_test_failure");
		service = new FileChangeEvidenceService(db);
		expect((await service.finalizePreparation(op.id)).settlement).toBe("intent_durable");
	});

	test("failed final intent commit leaves staged pages non-executable", async () => {
		activate();
		const op = service.beginOperation(operationInput());
		const [effect] = service.prepareEffects(op.id, [effectInput()]);
		failSql(`OLD.id = '${op.id}' AND NEW.settlement = 'intent_durable'`);
		await expect(service.finalizePreparation(op.id)).rejects.toThrow();
		expect(service.getOperation(op.id)?.settlement).toBe("preparing");
		if (effect) expect(() => apply(effect)).toThrow();
	});

	test("failed applying transaction never grants execution", async () => {
		const { operation, effect } = await readyEffect();
		failSql(`OLD.id = '${effect.id}' AND NEW.settlement = 'applying'`, "file_change_effects");
		expect(() => apply(effect)).toThrow();
		expect(service.getOperation(operation.id)?.settlement).toBe("intent_durable");
		expect(service.getEffect(operation.id, effect.mutationId)?.settlement).toBe("intent_durable");
	});

	test("DB failure after receipt insert leaves applying intent and permits receipt reconciliation only", async () => {
		const { operation, effect } = await readyEffect();
		apply(effect);
		failSql(`OLD.id = '${operation.id}' AND NEW.settled_effect_count = 1`);
		expect(() => settle(effect)).toThrow();
		const old = service.getEffect(operation.id, effect.mutationId);
		expect(old?.settlement).toBe("applying");
		expect(old?.executionReceiptJson).toBeNull();
		expect(old?.observedAfterStateJson).toEqual(UNKNOWN);
		expect(service.getOperation(operation.id)?.settledEffectCount).toBe(0);
		sqlite.run("DROP TRIGGER evidence_test_failure");
		service = new FileChangeEvidenceService(db);
		expect(apply(effect).mayExecute).toBe(false);
		expect(settle(effect).outcome).toBe("changed");
	});

	test("a deferred foreign-key COMMIT failure rolls back an otherwise completed receipt transaction", async () => {
		const { operation, effect } = await readyEffect();
		apply(effect);
		// The body runs successfully; the invalid deferred FK fails only at native COMMIT.
		sqlite.run("PRAGMA defer_foreign_keys = ON");
		sqlite.run(
			`CREATE TRIGGER evidence_test_failure AFTER UPDATE ON file_change_effects WHEN NEW.id = '${effect.id}' AND NEW.settlement = 'settled' BEGIN UPDATE file_change_operations SET owner_user_id = 'missing-${generateId()}' WHERE id = '${operation.id}'; END`,
		);
		expect(() => settle(effect)).toThrow();
		expect(service.getOperation(operation.id)?.settledEffectCount).toBe(0);
		expect(service.getOperation(operation.id)?.ownerUserId).toBeNull();
		expect(service.getEffect(operation.id, effect.mutationId)?.executionReceiptDigest).toBeNull();
		expect(service.getEffect(operation.id, effect.mutationId)?.settlement).toBe("applying");
		sqlite.run("DROP TRIGGER evidence_test_failure");
		sqlite.run("PRAGMA defer_foreign_keys = OFF");
		expect(settle(effect).settlement).toBe("settled");
	});

	test("missing after catalog object cannot be accepted as absent or settled", async () => {
		const { operation, effect } = await readyEffect();
		apply(effect);
		const bad = known(5, "missing");
		expect(() => settle(effect, receipt(effect, { observedAfter: bad }))).toThrow("ready catalog");
		expect(service.getEffect(operation.id, effect.mutationId)?.settlement).toBe("applying");
		expect(service.getEffect(operation.id, effect.mutationId)?.observedAfterStateJson).toEqual(
			UNKNOWN,
		);
	});

	test("cancellation retains every already prepared effect and never starts IO", async () => {
		activate();
		const op = service.beginOperation(operationInput());
		service.prepareEffects(op.id, [effectInput()]);
		const controller = new AbortController();
		controller.abort(new Error("test cancelled"));
		await expect(service.finalizePreparation(op.id, { signal: controller.signal })).rejects.toThrow(
			"cancelled",
		);
		expect(service.getOperation(op.id)?.settlement).toBe("preparing");
		expect(service.listEffects(op.id).items).toHaveLength(1);
	});

	test("fresh service locates preparing, durable, applying and reconciliation crash states", async () => {
		const preparing = service.beginOperation(operationInput());
		const durable = await readyEffect();
		const applying = await readyEffect();
		apply(applying.effect);
		const unresolved = await readyEffect();
		apply(unresolved.effect);
		settle(unresolved.effect, null);
		service = new FileChangeEvidenceService(db);
		for (const [settlement, id] of [
			["preparing", preparing.id],
			["intent_durable", durable.operation.id],
			["applying", applying.operation.id],
			["reconcile_required", unresolved.operation.id],
		] as const) {
			const items = service.listPendingOperations({ settlement }).items;
			expect(items.some((item) => item.id === id)).toBe(true);
		}
		expect(
			service.getEffect(applying.operation.id, applying.effect.mutationId)?.observedAfterStateJson
				.kind,
		).toBe("unknown");
		expect(service.getEffect(preparing.id, applying.effect.mutationId)).toBeNull();
	});

	test("pending cursors handle identical timestamps without offset scans or dropped rows", () => {
		const sameTime = new FileChangeEvidenceService(db, () => "2026-09-07T00:00:00.000Z");
		const ids = Array.from(
			{ length: 5 },
			() => sameTime.beginOperation(operationInput()).id,
		).sort();
		const found: string[] = [];
		let cursor: FileChangeOperationCursor | undefined;
		do {
			const page = sameTime.listPendingOperations({ settlement: "preparing", limit: 2, cursor });
			found.push(...page.items.map((row) => row.id));
			cursor = page.nextCursor ?? undefined;
			for (const row of page.items) {
				expect("actorJson" in row).toBe(false);
				expect("contentJson" in row).toBe(false);
			}
		} while (cursor);
		expect(found).toEqual(ids);
		expect(() => service.listEffects(ids[0] ?? "missing", { limit: 101 })).toThrow();
		expect(() => service.listPendingOperations({ settlement: "applying", limit: 0 })).toThrow();
	});

	test("metadata pages enforce byte budget and expose continuation rather than truncating completeness", async () => {
		activate();
		const op = await service.prepareOperation({
			...operationInput({ expectedEffectCount: 70 }),
			effects: Array.from({ length: 70 }, (_, i) =>
				effectInput(ABSENT, ABSENT, `${"a".repeat(1100)}-${i}`),
			),
		});
		const first = service.listEffects(op.id, { limit: 100 });
		expect(first.hasMore).toBe(true);
		expect(first.items.length).toBeLessThan(70);
		expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
			FILE_CHANGE_LIMITS.summaryBytes,
		);
		if (!first.nextCursor) throw new Error("Missing cursor");
		const second = service.listEffects(op.id, { limit: 100, cursor: first.nextCursor });
		expect(first.items.length + second.items.length).toBe(70);
		expect(second.hasMore).toBe(false);
	});

	test("recovery and effect pagination use their selective indexes", async () => {
		const { operation } = await readyEffect();
		const pendingPlan = sqlite
			.query(
				"EXPLAIN QUERY PLAN SELECT id FROM file_change_operations WHERE settlement = ? AND (updated_at,id) > (?,?) ORDER BY updated_at,id LIMIT 101",
			)
			.all("applying", "", "");
		const effectPlan = sqlite
			.query(
				"EXPLAIN QUERY PLAN SELECT id FROM file_change_effects WHERE operation_id = ? AND (file_key,phase) > (?,?) ORDER BY file_key,phase LIMIT 101",
			)
			.all(operation.id, "", "");
		expect(JSON.stringify(pendingPlan)).toContain("idx_fc_operation_pending");
		expect(JSON.stringify(pendingPlan)).toContain("(updated_at,id)>(?,?)");
		expect(JSON.stringify(effectPlan)).toContain("idx_fc_effect_operation_file");
		expect(JSON.stringify(effectPlan)).toContain("(file_key,phase)>(?,?)");
		expect(JSON.stringify([...pendingPlan, ...effectPlan])).not.toContain("SCAN file_change");
	});
});
