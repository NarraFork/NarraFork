import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
	FileChangeActor,
	FileChangeIdentity,
	FileChangeState,
} from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { db, sqlite } from "../db";
import {
	fileChangeBlobs,
	fileChangeEffects,
	fileChangeOperations,
	fileChangeRollups,
	fileChangeScopeRecoveries,
	fileChangeScopes,
	narrators,
	revertOperationFiles,
	revertOperations,
	snapshotCaptures,
	workspaceWriteLeases,
} from "../db/schema";
import { generateId } from "../lib/id";

let scopeId: string;
let narratorId: string;
let operationId: string;
let revertId: string;
let blobId: string;
let blobDigest: string;
let actor: FileChangeActor;
const now = () => new Date().toISOString();

beforeEach(async () => {
	scopeId = generateId();
	narratorId = generateId();
	operationId = generateId();
	revertId = generateId();
	blobId = generateId();
	blobDigest = Buffer.from(`${blobId}${blobId}`).toString("hex").slice(0, 64);
	actor = {
		kind: "primary",
		subjectKey: `narrator:${narratorId}`,
		narratorId,
		userId: null,
		label: "Writer",
		deleted: false,
		parentSubjectKey: null,
	};
	await db.insert(narrators).values({ id: narratorId, createdAt: now(), updatedAt: now() });
	await db.insert(fileChangeScopes).values({
		id: scopeId,
		sourceInstanceId: "test-instance",
		deviceId: "local",
		workspaceInstanceId: scopeId,
		canonicalRoot: "/repo",
		displayRoot: "/repo",
		pathFlavor: "posix",
		createdAt: now(),
		updatedAt: now(),
	});
	await db.insert(fileChangeOperations).values({
		id: operationId,
		sourceInstanceId: "test-instance",
		sourceKind: "tool",
		sourceId: operationId,
		attempt: 1,
		narratorId,
		actorSubjectKey: actor.subjectKey,
		actorJson: actor,
		startedAt: now(),
		updatedAt: now(),
	});
});

afterEach(async () => {
	await db.delete(fileChangeRollups).where(eq(fileChangeRollups.scopeId, scopeId));
	await db.delete(revertOperationFiles).where(eq(revertOperationFiles.scopeId, scopeId));
	await db.delete(revertOperations).where(eq(revertOperations.id, revertId));
	await db.delete(snapshotCaptures).where(eq(snapshotCaptures.scopeId, scopeId));
	await db.delete(fileChangeEffects).where(eq(fileChangeEffects.operationId, operationId));
	await db.delete(fileChangeOperations).where(eq(fileChangeOperations.id, operationId));
	await db.delete(fileChangeScopeRecoveries).where(eq(fileChangeScopeRecoveries.scopeId, scopeId));
	await db.delete(workspaceWriteLeases).where(eq(workspaceWriteLeases.scopeId, scopeId));
	await db.delete(fileChangeScopes).where(eq(fileChangeScopes.id, scopeId));
	await db.delete(fileChangeBlobs).where(eq(fileChangeBlobs.id, blobId));
	await db.delete(narrators).where(eq(narrators.id, narratorId));
});

function identity(): FileChangeIdentity {
	return {
		sourceInstanceId: "test-instance",
		deviceId: "local",
		workspaceInstanceId: scopeId,
		scopeId,
		pathFlavor: "posix",
		objectRole: "referent",
		canonicalPath: "/repo/a.txt",
		lexicalPath: "/repo/a.txt",
		displayPath: "a.txt",
	};
}

async function insertBlob() {
	await db.insert(fileChangeBlobs).values({
		id: blobId,
		digest: blobDigest,
		sizeBytes: 3,
		storageKey: `${blobDigest.slice(0, 2)}/${blobDigest}`,
		createdAt: now(),
		updatedAt: now(),
	});
}

function effectValues() {
	const unknown: FileChangeState = { kind: "unknown", reason: "missing_after" };
	return {
		id: generateId(),
		operationId,
		scopeId,
		fileKey: "a-file",
		identityJson: identity(),
		scopeRevision: 1,
		mutationId: generateId(),
		requestDigest: "a".repeat(64),
		phase: "apply" as const,
		beforeStateJson: { kind: "absent" } as FileChangeState,
		intendedAfterStateJson: {
			kind: "regular",
			blob: { algorithm: "sha256", digest: blobDigest, sizeBytes: 3 },
			mode: 0o644,
		} as FileChangeState,
		observedAfterStateJson: unknown,
		intendedAfterBlobDigest: blobDigest,
		createdAt: now(),
		updatedAt: now(),
	};
}

describe("file change evidence schema migration", () => {
	test("all additive evidence tables exist in the isolated migrated database", () => {
		expect(process.env.NARRAFORK_TEST).toBe("1");
		const names = [
			"file_change_scopes",
			"workspace_write_leases",
			"file_change_scope_recoveries",
			"file_change_blobs",
			"file_change_operations",
			"file_change_effects",
			"snapshot_captures",
			"revert_operations",
			"revert_operation_files",
			"file_change_rollups",
			"file_change_storage_budgets",
			"file_change_blob_reservations",
		];
		const rows = sqlite
			.query(
				`SELECT name FROM sqlite_master WHERE type = ? AND name IN (${names.map(() => "?").join(",")})`,
			)
			.all("table", ...names);
		expect(rows).toHaveLength(names.length);
	});

	test("durable range quarantine and legacy audit remain independently representable", () => {
		const leaseId = generateId();
		db.insert(workspaceWriteLeases)
			.values({
				leaseId,
				scopeId,
				deviceId: "local",
				ownerEpoch: "ended-owner",
				runtimeEpoch: "local-runtime",
				runtimeGeneration: 0,
				fencingToken: 7,
				scopeRevision: 3,
				pathFlavor: "posix",
				status: "quarantined",
				rangesJson: { version: 1, ranges: [{ kind: "file", canonicalPath: "/repo/a.txt" }] },
				mutationManifestJson: {
					version: 1,
					mutations: [{ mutationId: "unknown-write", operationId, outcome: "unknown" }],
				},
				executionEndedAt: now(),
				createdAt: now(),
				updatedAt: now(),
			})
			.run();
		const baseAudit = {
			scopeId,
			deviceId: "local",
			canonicalRoot: "/repo",
			pathFlavor: "posix" as const,
			effectDecisionsJson: [],
			scopeRevisionBefore: 3,
			fencingTokenBefore: 7,
			createdAt: now(),
		};
		const legacyId = generateId();
		const recoveryId = generateId();
		db.insert(fileChangeScopeRecoveries)
			.values({ ...baseAudit, id: legacyId })
			.run();
		db.insert(fileChangeScopeRecoveries)
			.values({ ...baseAudit, id: recoveryId, workspaceLeaseId: leaseId })
			.run();
		expect(
			db
				.select()
				.from(fileChangeScopeRecoveries)
				.where(eq(fileChangeScopeRecoveries.id, legacyId))
				.get()?.workspaceLeaseId,
		).toBeNull();
		expect(
			db.select().from(workspaceWriteLeases).where(eq(workspaceWriteLeases.leaseId, leaseId)).get()
				?.rangesJson,
		).toEqual({ version: 1, ranges: [{ kind: "file", canonicalPath: "/repo/a.txt" }] });
		// Retention may drop a terminal lease, never the immutable recovery audit.
		db.update(workspaceWriteLeases)
			.set({ status: "recovered" })
			.where(eq(workspaceWriteLeases.leaseId, leaseId))
			.run();
		db.delete(workspaceWriteLeases).where(eq(workspaceWriteLeases.leaseId, leaseId)).run();
		expect(
			db
				.select()
				.from(fileChangeScopeRecoveries)
				.where(eq(fileChangeScopeRecoveries.id, recoveryId))
				.get()?.workspaceLeaseId,
		).toBe(leaseId);
	});
	test("scope, operation and blob defaults never imply verified evidence", async () => {
		await insertBlob();
		const scope = await db.query.fileChangeScopes.findFirst({
			where: eq(fileChangeScopes.id, scopeId),
		});
		const operation = await db.query.fileChangeOperations.findFirst({
			where: eq(fileChangeOperations.id, operationId),
		});
		const blob = await db.query.fileChangeBlobs.findFirst({
			where: eq(fileChangeBlobs.id, blobId),
		});
		expect(scope?.status).toBe("needs_verification");
		expect(scope?.activeLeaseId).toBeNull();
		expect(scope?.activeMutationCount).toBe(0);
		expect(
			db
				.select({ origin: narrators.originToolCallId })
				.from(narrators)
				.where(eq(narrators.id, narratorId))
				.get()?.origin,
		).toBeNull();
		expect(operation?.coverage).toBe("unavailable");
		expect(operation?.settlement).toBe("preparing");
		expect(operation?.attributionGrade).toBe("unknown");
		expect(blob?.status).toBe("staging");
	});

	test("the same tree hash can have complete and partial scan receipts", async () => {
		const common = {
			scopeId,
			treeHash: "a".repeat(40),
			policyVersion: 2,
			startedAt: now(),
			finishedAt: now(),
		};
		await db.insert(snapshotCaptures).values([
			{
				...common,
				id: generateId(),
				coverage: "complete",
				temporalConsistency: "platform_quiescent",
				omittedCount: 0,
			},
			{ ...common, id: generateId(), coverage: "partial", reason: "unreadable", omittedCount: 1 },
		]);
		const rows = await db.query.snapshotCaptures.findMany({
			where: eq(snapshotCaptures.scopeId, scopeId),
		});
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.coverage).sort()).toEqual(["complete", "partial"]);
		expect(rows[0]?.id).not.toBe(rows[1]?.id);
	});

	test("an execution attempt cannot be inserted twice under another row id", () => {
		expect(() =>
			db
				.insert(fileChangeOperations)
				.values({
					id: generateId(),
					sourceInstanceId: "test-instance",
					sourceKind: "tool",
					sourceId: operationId,
					attempt: 1,
					actorSubjectKey: actor.subjectKey,
					actorJson: actor,
					startedAt: now(),
					updatedAt: now(),
				})
				.run(),
		).toThrow();
	});

	test("deleting a narrator does not cascade-delete its operation or change its actor kind", async () => {
		await db.delete(narrators).where(eq(narrators.id, narratorId));
		const operation = await db.query.fileChangeOperations.findFirst({
			where: eq(fileChangeOperations.id, operationId),
		});
		expect(operation).toBeDefined();
		expect(operation?.narratorId).toBeNull();
		expect(operation?.actorJson.kind).toBe("primary");
		expect(operation?.actorSubjectKey).toBe(actor.subjectKey);
	});

	test("effect defaults preserve the unknown after and do not authorize a no-op", async () => {
		await insertBlob();
		const effect = effectValues();
		await db.insert(fileChangeEffects).values(effect);
		const row = await db.query.fileChangeEffects.findFirst({
			where: eq(fileChangeEffects.id, effect.id),
		});
		expect(row?.beforeStateJson.kind).toBe("absent");
		expect(row?.observedAfterStateJson.kind).toBe("unknown");
		expect(row?.executionConfirmed).toBe(false);
		expect(row?.executionReceiptJson).toBeNull();
		expect(row?.attributionCeiling).toBeNull();
		expect(row?.outcome).toBe("pending");
		expect(row?.linesAdded).toBeNull();
		expect(row?.linesRemoved).toBeNull();
	});

	test("referenced blobs and scopes cannot be deleted underneath an effect", async () => {
		await insertBlob();
		await db.insert(fileChangeEffects).values(effectValues());
		expect(() => db.delete(fileChangeBlobs).where(eq(fileChangeBlobs.id, blobId)).run()).toThrow();
		expect(() =>
			db.delete(fileChangeScopes).where(eq(fileChangeScopes.id, scopeId)).run(),
		).toThrow();
	});

	test("mutation ids deduplicate across files and missing body references fail closed", async () => {
		await insertBlob();
		const first = effectValues();
		await db.insert(fileChangeEffects).values(first);
		expect(() =>
			db
				.insert(fileChangeEffects)
				.values({ ...effectValues(), fileKey: "b-file", mutationId: first.mutationId })
				.run(),
		).toThrow();
		expect(() =>
			db
				.insert(fileChangeEffects)
				.values({ ...effectValues(), fileKey: "c-file", intendedAfterBlobDigest: "f".repeat(64) })
				.run(),
		).toThrow();
	});

	test("compensation observations are independently nullable and pinned without replacing apply evidence", async () => {
		await insertBlob();
		await db.insert(revertOperations).values({
			id: revertId,
			narratorId,
			requestedBySubjectKey: "test-user",
			idempotencyKey: generateId(),
			requestDigest: "b".repeat(64),
			kind: "revert",
			scope: "narrator",
			selectorKind: "all",
			expiresAt: now(),
			createdAt: now(),
			updatedAt: now(),
		});
		const before: FileChangeState = {
			kind: "regular",
			mode: 0o644,
			blob: { algorithm: "sha256", digest: blobDigest, sizeBytes: 3 },
		};
		const file = db
			.insert(revertOperationFiles)
			.values({
				id: generateId(),
				revertOperationId: revertId,
				scopeId,
				fileKey: "phase-file",
				identityJson: identity(),
				sequence: 0,
				expectedStateJson: before,
				desiredStateJson: { kind: "absent" },
				observedAfterStateJson: { kind: "absent" },
				applyMutationId: generateId(),
				applyRequestDigest: "c".repeat(64),
				compensateMutationId: generateId(),
				compensateRequestDigest: "d".repeat(64),
				updatedAt: now(),
			})
			.returning()
			.get();
		expect(file.compensationAfterStateJson).toBeNull();
		expect(file.compensationAfterBlobDigest).toBeNull();
		const compensated = db
			.update(revertOperationFiles)
			.set({
				compensationAfterStateJson: before,
				compensationAfterBlobDigest: blobDigest,
			})
			.where(eq(revertOperationFiles.id, file.id))
			.returning()
			.get();
		expect(compensated?.observedAfterStateJson).toEqual({ kind: "absent" });
		expect(compensated?.compensationAfterStateJson).toEqual(before);
		expect(() => db.delete(fileChangeBlobs).where(eq(fileChangeBlobs.id, blobId)).run()).toThrow();
		expect(
			sqlite
				.query(
					"SELECT name FROM sqlite_master WHERE type='index' AND name='idx_revert_file_compensation_blob'",
				)
				.get(),
		).toBeDefined();
	});

	test("revert requests have an explicit incomplete default and actor-scoped idempotency", async () => {
		const request = {
			id: revertId,
			narratorId,
			requestedBySubjectKey: "test-user",
			idempotencyKey: generateId(),
			requestDigest: "b".repeat(64),
			kind: "revert" as const,
			scope: "narrator" as const,
			selectorKind: "all" as const,
			expiresAt: now(),
			createdAt: now(),
			updatedAt: now(),
		};
		await db.insert(revertOperations).values(request);
		const row = await db.query.revertOperations.findFirst({
			where: eq(revertOperations.id, revertId),
		});
		expect(row?.status).toBe("planned");
		expect(row?.coverageComplete).toBe(false);
		expect(row?.planHash).toBeNull();
		expect(() =>
			db
				.insert(revertOperations)
				.values({ ...request, id: generateId() })
				.run(),
		).toThrow();
	});
});
