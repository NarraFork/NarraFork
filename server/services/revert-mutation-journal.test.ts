import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeExecutionReceipt,
	type FileChangeRevertMutationJournal,
	type FileChangeState,
} from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { runMigrations } from "../db/run-migrations";
import {
	fileChangeBlobs,
	fileChangeScopes,
	fileChangeStorageBudgets,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	revertOperationFiles,
	revertOperations,
	users,
} from "../db/schema";
import { createFileChangeIdentity } from "./file-change-identity";
import { RevertHistoryCommitService } from "./revert-history-commit";
import {
	type RevertJournalClaim,
	type RevertJournalContext,
	type RevertJournalPendingCursor,
	type RevertJournalTransaction,
	RevertMutationJournal,
} from "./revert-mutation-journal";
import {
	type AppendRevertPlanFile,
	type BeginRevertPlan,
	fingerprintRevertPlanFiles,
	type RevertPlanFileCursor,
	type RevertPlanFileMetadata,
	type RevertPlanHeader,
	type RevertPlanOwner,
	RevertPlanService,
	revertPlanHeaderDigest,
} from "./revert-plan-service";
import { type RevertSelectionOptions, RevertSelectionService } from "./revert-selection-service";
import {
	createWorkspaceWriteCoordinatorState,
	WorkspaceWriteCoordinator,
	type WorkspaceWriteLease,
} from "./workspace-write-coordinator";

// Genuine generated migrations, once, in memory. Each test gets its own isolated
// copy, and reopen tests close/reopen that copy on a test-owned temporary path.
let migrated: Buffer;
let conn: Database;
let db: ReturnType<typeof drizzle>;
let service: RevertMutationJournal;
let plans: RevertPlanService;
let coordinator: WorkspaceWriteCoordinator;
let scope: typeof fileChangeScopes.$inferSelect;
let serial: number;
let clock: number;
let temp: string | undefined;
let queries: string[];
const namespaceKey = "revert-journal-test-namespace";
const runtime = { runtimeEpoch: "runtime-a", runtimeGeneration: 7 };
const owner: RevertPlanOwner = { subjectKey: "user:alice", narratorId: null, projectId: null };
const ABSENT: FileChangeState = { kind: "absent" };
const UNKNOWN: FileChangeState = { kind: "unknown", reason: "missing_after" };
const now = () => new Date(clock).toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	const template = new Database(":memory:");
	await runMigrations(template);
	// This migration-only fixture does not run the normal startup schema patcher.
	// Keep its disposable narrator rows compatible with the current Drizzle insert shape.
	if (
		!template
			.query(
				"SELECT 1 FROM pragma_table_info('narrators') WHERE name = 'context_usage_snapshot_json'",
			)
			.get()
	)
		template.exec("ALTER TABLE narrators ADD COLUMN context_usage_snapshot_json TEXT");
	migrated = template.serialize();
	template.close();
});

function connect() {
	conn.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
	db = drizzle(conn, {
		logger: {
			logQuery(query) {
				if (queries.length < 50_000) queries.push(query);
			},
		},
	});
	service = new RevertMutationJournal(db, { namespaceKey, now });
	plans = new RevertPlanService(db, { namespaceKey, now });
	coordinator = new WorkspaceWriteCoordinator({
		db,
		state: createWorkspaceWriteCoordinatorState(),
		readRuntime: () => runtime,
	});
}
beforeEach(() => {
	serial = 0;
	clock = Date.parse("2026-09-07T12:00:00.000Z");
	queries = [];
	conn = Database.deserialize(migrated);
	connect();
	db.insert(fileChangeStorageBudgets)
		.values({
			id: "file-change-blobs",
			namespaceKey,
			status: "ready",
			quotaBytes: FILE_CHANGE_LIMITS.blobSoftQuotaBytes,
			updatedAt: now(),
		})
		.run();
	scope = db
		.insert(fileChangeScopes)
		.values({
			id: "scope",
			sourceInstanceId: "source",
			workspaceInstanceId: "workspace",
			deviceId: "device",
			canonicalRoot: "/repo",
			displayRoot: "/repo",
			pathFlavor: "posix",
			status: "active",
			createdAt: now(),
			updatedAt: now(),
		})
		.returning()
		.get();
});
afterEach(() => {
	conn.close();
	if (temp) {
		rmSync(temp, { recursive: true, force: true });
		temp = undefined;
	}
});
function publish(content: string, sizeBytes = Buffer.byteLength(content)) {
	const ref = { algorithm: "sha256" as const, digest: hash(content), sizeBytes };
	db.insert(fileChangeBlobs)
		.values({
			id: `blob-${serial++}`,
			digest: ref.digest,
			sizeBytes,
			status: "ready",
			storageKey: `${ref.digest.slice(0, 2)}/${ref.digest}`,
			createdAt: now(),
			updatedAt: now(),
		})
		.onConflictDoNothing()
		.run();
	return ref;
}
function known(content = `body-${serial++}`, size?: number): FileChangeState {
	return { kind: "regular", blob: publish(content, size), mode: 0o644 };
}
function fixed(sequence = 0, expected = known(), desired = known()): AppendRevertPlanFile {
	return {
		sequence,
		identity: createFileChangeIdentity(scope, {
			deviceId: scope.deviceId,
			pathFlavor: scope.pathFlavor,
			objectRole: "referent",
			canonicalPath: `/repo/file-${sequence}`,
			lexicalPath: `/repo/file-${sequence}`,
		}),
		expected,
		desired,
	};
}
function input(
	files: AppendRevertPlanFile[],
	overrides: Partial<RevertPlanHeader> = {},
): BeginRevertPlan {
	const header: RevertPlanHeader = {
		...owner,
		idempotencyKey: `plan-${String(serial++).padStart(6, "0")}`,
		requestDigest: hash(`request-${serial++}`),
		kind: "revert",
		revertScope: "workspace",
		selectorKind: "all",
		selector: publish("selector"),
		historyManifest: publish("history"),
		expectedMessageVersion: 0,
		expectedFileCount: files.length,
		...overrides,
	};
	const fingerprint = fingerprintRevertPlanFiles(files);
	const proof = {
		source: "trusted_published_planner_v1" as const,
		headerDigest: revertPlanHeaderDigest(header),
		orderedFilesDigest: fingerprint.orderedFilesDigest,
		fileEvidenceBytes: fingerprint.fileEvidenceBytes,
		computation: "complete" as const,
		selectorCoverage: "complete" as const,
		historyCoverage: "complete" as const,
		omittedFiles: 0 as const,
		unknownFiles: 0 as const,
	};
	return {
		...header,
		manifestProof: proof,
		plan: publish(JSON.stringify({ header, proof, files })),
	};
}
async function prepared(fileList = [fixed()], overrides: Partial<RevertPlanHeader> = {}) {
	const request = input(fileList, overrides);
	const plan = await plans.prepare(request, fileList);
	if (!plan.planHash) throw new Error("Expected real plan hash");
	const ctx: RevertJournalContext = {
		owner: {
			subjectKey: request.subjectKey,
			narratorId: request.narratorId,
			projectId: request.projectId,
		},
		planId: plan.id,
		planHash: plan.planHash,
	};
	return { ctx, request, files: allFiles(ctx), plan };
}
function allFiles(ctx: RevertJournalContext) {
	const result: RevertPlanFileMetadata[] = [];
	let cursor: RevertPlanFileCursor | undefined;
	do {
		const page = plans.listFiles(ctx.owner, ctx.planId, { cursor });
		result.push(...page.items);
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
	return result.sort((a, b) => a.sequence - b.sequence);
}
async function started(fileList = [fixed()]) {
	const result = await prepared(fileList);
	await service.startExecution(result.ctx, result.request.manifestProof);
	return result;
}
function rollback<T>(body: (lease: WorkspaceWriteLease) => Promise<T> | T) {
	return coordinator.withRollback({ scope, runtime }, body);
}
function receipt(
	claim: RevertJournalClaim,
	overrides: Partial<FileChangeExecutionReceipt> = {},
): FileChangeExecutionReceipt {
	return {
		receiptId: `receipt-${serial++}`,
		mutationId: claim.mutationId,
		requestDigest: claim.requestDigest,
		executionBinding: claim.executionBinding,
		outcome: "applied",
		confirmed: true,
		observedAfter: claim.desired,
		...overrides,
	};
}
async function applyFile(
	ctx: RevertJournalContext,
	file: RevertPlanFileMetadata,
	lease: WorkspaceWriteLease,
	overrides: Partial<FileChangeExecutionReceipt> = {},
) {
	const claim = service.claimApply(ctx, file, lease);
	expect(claim.mayExecute).toBe(true);
	lease.registerMutation(claim.mutationId);
	const proof = receipt(claim, overrides);
	const recorded = await service.recordApplyReceipt(ctx, file.id, proof);
	// This test executes no target IO: the injected trusted receipt is the boundary.
	lease.settle(
		claim.mutationId,
		proof.confirmed && proof.outcome !== "unknown" ? proof.outcome : "not_applied",
	);
	return { claim, proof, recorded };
}
async function verified() {
	const p = await started();
	await rollback(async (lease) => {
		for (const file of p.files) await applyFile(p.ctx, file, lease);
	});
	expect((await service.finishFiles(p.ctx)).status).toBe("files_verified");
	return p;
}
function injection(table: string, timing: string, body: string) {
	conn.run(`CREATE TRIGGER injected_failure ${timing} ON ${table} BEGIN ${body}; END`);
}
function journal(ctx: RevertJournalContext, id: string) {
	return service.listFiles(ctx).items.find((file) => file.id === id);
}

async function historyScenario() {
	const principal = { userId: "alice", isAdmin: false };
	db.insert(users)
		.values({ id: "alice", username: "alice", passwordHash: "test-only", createdAt: now() })
		.run();
	db.insert(narrators)
		.values({
			id: "history-narrator",
			ownerUserId: "alice",
			messageVersion: 7,
			createdAt: now(),
			updatedAt: now(),
		})
		.run();
	for (const [id, seq] of [
		["keep-message", 1],
		["remove-message", 2],
	] as const) {
		db.insert(narratorMessages)
			.values({
				id,
				narratorId: "history-narrator",
				role: "assistant",
				contentJson: [{ type: "text", text: id }],
				createdAt: now(),
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: `${id}-ref`, narratorId: "history-narrator", messageId: id, seq })
			.run();
	}
	const authorize: RevertSelectionOptions["authorize"] = async (user, row, need, signal) => {
		signal.throwIfAborted();
		const account = db
			.select({ id: users.id, role: users.role })
			.from(users)
			.where(eq(users.id, user.userId))
			.get();
		if (
			need !== "write" ||
			!account ||
			user.isAdmin !== (account.role === "admin") ||
			row.ownerUserId !== user.userId
		)
			throw new Error("Real fixture ownership policy denied access");
	};
	const collector = new RevertSelectionService(db, { authorize });
	const selection = await collector.collect({
		principal,
		narratorId: "history-narrator",
		expectedMessageVersion: 7,
		selector: { kind: "messages", messageIds: ["remove-message"] },
	});
	const p = await prepared([fixed()], {
		narratorId: "history-narrator",
		selectorKind: "messages",
		selector: publish(JSON.stringify(selection.selector)),
		historyManifest: publish(JSON.stringify(selection)),
		expectedMessageVersion: 7,
	});
	await service.startExecution(p.ctx, p.request.manifestProof);
	await rollback(async (lease) => {
		for (const file of p.files) await applyFile(p.ctx, file, lease);
	});
	await service.finishFiles(p.ctx);
	const history = new RevertHistoryCommitService(db, { authorize });
	return {
		...p,
		history,
		prepareHistory: () => history.prepare({ principal, fixedSelection: selection }),
	};
}

function remainingMessages() {
	return db
		.select({ id: narratorMessages.id })
		.from(narratorMessages)
		.orderBy(narratorMessages.id)
		.all()
		.map((row) => row.id);
}

function historyVersion() {
	return db
		.select({ version: narrators.messageVersion })
		.from(narrators)
		.where(eq(narrators.id, "history-narrator"))
		.get()?.version;
}

describe("real prepared plans and lease-bound durable claims", () => {
	test("starts only a real complete prepared plan and a matching owner/hash/proof", async () => {
		const p = await prepared();
		await expect(
			service.startExecution(
				{ ...p.ctx, owner: { ...owner, subjectKey: "user:other" } },
				p.request.manifestProof,
			),
		).rejects.toThrow("owning context");
		await expect(
			service.startExecution({ ...p.ctx, planHash: hash("foreign") }, p.request.manifestProof),
		).rejects.toThrow("plan hash");
		await expect(
			service.startExecution(p.ctx, {
				...p.request.manifestProof,
				orderedFilesDigest: hash("prefix"),
			}),
		).rejects.toThrow();
		expect((await service.startExecution(p.ctx, p.request.manifestProof)).started).toBe(true);
		expect((await service.startExecution(p.ctx, p.request.manifestProof)).started).toBe(false);
	});

	test("coverage false, expired and missing manifest raw are rejected before dispatch", async () => {
		const p = await prepared();
		db.update(revertOperations)
			.set({ coverageComplete: false })
			.where(eq(revertOperations.id, p.ctx.planId))
			.run();
		await expect(service.startExecution(p.ctx, p.request.manifestProof)).rejects.toThrow(
			"complete v2",
		);
		db.update(revertOperations)
			.set({ coverageComplete: true })
			.where(eq(revertOperations.id, p.ctx.planId))
			.run();
		clock += FILE_CHANGE_LIMITS.planLifetimeMs + 1;
		await expect(service.startExecution(p.ctx, p.request.manifestProof)).rejects.toThrow("expired");
		clock -= FILE_CHANGE_LIMITS.planLifetimeMs + 1;
		db.update(fileChangeBlobs)
			.set({ status: "missing" })
			.where(eq(fileChangeBlobs.digest, p.request.plan.digest))
			.run();
		await expect(service.startExecution(p.ctx, p.request.manifestProof)).rejects.toThrow(
			"not ready",
		);
		expect(service.getOperation(p.ctx).status).toBe("prepared");
	});

	test("explicit recovery journal claims accept an observing lease during registered activity", async () => {
		const p = await started();
		const activity = coordinator.registerActivity({ scope, runtime });
		try {
			await expect(rollback(() => {})).rejects.toMatchObject({ code: "uncoordinated_activity" });
			await coordinator.withRollback(
				{ scope, runtime, activityPolicy: "observe" },
				async (lease) => {
					expect(lease.overlappedUncoordinatedActivity).toBe(true);
					for (const file of p.files) await applyFile(p.ctx, file, lease);
				},
			);
			expect((await service.finishFiles(p.ctx)).status).toBe("files_verified");
		} finally {
			coordinator.endActivity(activity);
		}
	});

	test("real rollback lease required; stale, write-only and foreign scope leases cannot claim", async () => {
		const p = await started();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		await coordinator.withWrite({ scope, runtime }, (lease) => {
			expect(() => service.claimApply(p.ctx, file, lease)).toThrow("rollback");
		});
		let stale: WorkspaceWriteLease | undefined;
		await rollback((lease) => {
			stale = lease;
		});
		if (!stale) throw new Error("fixture");
		const expiredLease = stale;
		expect(() => service.claimApply(p.ctx, file, expiredLease)).toThrow();
		await rollback((lease) => {
			expect(() => service.claimApply(p.ctx, { ...file, sequence: 7 }, lease)).toThrow(
				"fixed plan",
			);
			db.update(fileChangeScopes)
				.set({ fencingToken: lease.executionBinding.fencingToken + 1 })
				.where(eq(fileChangeScopes.id, scope.id))
				.run();
			expect(() => service.claimApply(p.ctx, file, lease)).toThrow();
			db.update(fileChangeScopes)
				.set({ fencingToken: lease.executionBinding.fencingToken })
				.where(eq(fileChangeScopes.id, scope.id))
				.run();
		});
	});

	test("a real lease on another scope cannot be used for this file", async () => {
		const p = await started();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		const other = db
			.insert(fileChangeScopes)
			.values({
				id: "other-scope",
				sourceInstanceId: scope.sourceInstanceId,
				deviceId: scope.deviceId,
				workspaceInstanceId: "other-workspace",
				canonicalRoot: "/elsewhere",
				displayRoot: "/elsewhere",
				pathFlavor: "posix",
				status: "active",
				createdAt: now(),
				updatedAt: now(),
			})
			.returning()
			.get();
		await coordinator.withRollback({ scope: other, runtime }, (lease) => {
			expect(() => service.claimApply(p.ctx, file, lease)).toThrow();
		});
		expect(journal(p.ctx, file.id)?.receiptJson).toBeNull();
	});

	test("first claim alone grants execution and never counts an actual apply", async () => {
		const p = await started();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		await rollback((lease) => {
			const first = service.claimApply(p.ctx, file, lease);
			expect(first.mayExecute).toBe(true);
			expect(service.claimApply(p.ctx, file, lease).mayExecute).toBe(false);
			expect(service.getOperation(p.ctx).appliedFileCount).toBe(0);
			expect(journal(p.ctx, file.id)?.observedAfterStateJson).toBeNull();
		});
		clock += FILE_CHANGE_LIMITS.planLifetimeMs * 5;
		await rollback((lease) => {
			expect(service.claimApply(p.ctx, file, lease).mayExecute).toBe(false);
		});
		expect(
			service
				.listPending(owner, { status: "applying" })
				.items.some((row) => row.id === p.ctx.planId),
		).toBe(true);
	});

	test("grant/claim failure rolls back both row journal and operation revision", async () => {
		const p = await started();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		const before = service.getOperation(p.ctx);
		injection(
			"revert_operations",
			"BEFORE UPDATE",
			"SELECT RAISE(ABORT, 'injected update failure')",
		);
		await rollback((lease) => {
			expect(() => service.claimApply(p.ctx, file, lease)).toThrow();
		});
		expect(service.getOperation(p.ctx)).toEqual(before);
		expect(journal(p.ctx, file.id)?.receiptJson).toBeNull();
		conn.run("DROP TRIGGER injected_failure");
		await rollback(async (lease) => {
			await applyFile(p.ctx, file, lease);
		});
	});

	test("start final CAS failure leaves the entire prepared plan untouched", async () => {
		const p = await prepared();
		injection("revert_operations", "BEFORE UPDATE", "SELECT RAISE(ABORT, 'start commit failed')");
		await expect(service.startExecution(p.ctx, p.request.manifestProof)).rejects.toThrow();
		expect(service.getOperation(p.ctx).status).toBe("prepared");
		expect(
			service
				.listFiles(p.ctx)
				.items.every((f) => f.receiptJson === null && f.status === "prepared"),
		).toBe(true);
	});
});

describe("immutable receipts and complete file verification", () => {
	test("confirmed applied desired receipt verifies, counts once and repeated receipt is frozen", async () => {
		const p = await started();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		await rollback(async (lease) => {
			const { proof, recorded } = await applyFile(p.ctx, file, lease);
			expect(recorded.status).toBe("verified");
			expect(service.getOperation(p.ctx).appliedFileCount).toBe(1);
			expect(await service.recordApplyReceipt(p.ctx, file.id, proof)).toEqual(recorded);
			await expect(
				service.recordApplyReceipt(p.ctx, file.id, { ...proof, receiptId: "replacement" }),
			).rejects.toThrow("overwritten");
			expect(service.getOperation(p.ctx).appliedFileCount).toBe(1);
		});
		expect((await service.finishFiles(p.ctx)).status).toBe("files_verified");
	});

	for (const variant of [
		"unconfirmed",
		"unknown_outcome",
		"missing_after",
		"foreign_after",
		"not_applied",
	] as const) {
		test(`${variant} cannot become files_verified from matching hashes or status`, async () => {
			const p = await started();
			const file = p.files[0];
			if (!file) throw new Error("fixture");
			await rollback(async (lease) => {
				const overrides: Partial<FileChangeExecutionReceipt> =
					variant === "unconfirmed"
						? { confirmed: false }
						: variant === "unknown_outcome"
							? { outcome: "unknown" }
							: variant === "missing_after"
								? { observedAfter: UNKNOWN }
								: variant === "foreign_after"
									? { observedAfter: known("external") }
									: { outcome: "not_applied", observedAfter: file.expectedStateJson };
				await applyFile(p.ctx, file, lease, overrides);
			});
			expect((await service.finishFiles(p.ctx)).status).toBe("recovery_required");
			expect(() => service.commit(p.ctx)).toThrow("receipts must be verified");
			if (variant === "foreign_after" || variant === "missing_after")
				expect(service.getOperation(p.ctx).appliedFileCount).toBe(1);
		});
	}

	test("confirmed not-applied is verified only for a true fixed desired no-op", async () => {
		const p = await started([fixed(0, ABSENT, ABSENT)]);
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		await rollback(async (lease) => {
			await applyFile(p.ctx, file, lease, { outcome: "not_applied" });
		});
		expect(service.getOperation(p.ctx).appliedFileCount).toBe(0);
		expect((await service.finishFiles(p.ctx)).status).toBe("files_verified");
	});

	test("null/missing observation, foreign mutation/request/phase/fence/binding receipts reject", async () => {
		const p = await started();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		await rollback(async (lease) => {
			const claim = service.claimApply(p.ctx, file, lease);
			const proof = receipt(claim);
			const variants = [
				null,
				{ ...proof, observedAfter: null },
				{ ...proof, mutationId: file.compensateMutationId },
				{ ...proof, requestDigest: hash("changed") },
				{
					...proof,
					executionBinding: {
						...proof.executionBinding,
						fencingToken: proof.executionBinding.fencingToken + 1,
					},
				},
				{ ...proof, executionBinding: { ...proof.executionBinding, runtimeEpoch: "foreign" } },
				{ ...proof, executionBinding: { ...proof.executionBinding, deviceId: "another" } },
			];
			for (const bad of variants)
				await expect(
					service.recordApplyReceipt(p.ctx, file.id, bad as unknown as FileChangeExecutionReceipt),
				).rejects.toThrow();
			expect(journal(p.ctx, file.id)?.observedAfterStateJson).toBeNull();
			expect(journal(p.ctx, file.id)?.status).toBe("applying");
			await service.recordApplyReceipt(p.ctx, file.id, proof);
		});
	});

	test("receipt publication with missing raw or namespace mismatch retains pending phase", async () => {
		const p = await started();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		await rollback(async (lease) => {
			const claim = service.claimApply(p.ctx, file, lease);
			const after = known("after-lost");
			if (after.kind !== "regular") throw new Error("fixture");
			db.update(fileChangeBlobs)
				.set({ status: "missing" })
				.where(eq(fileChangeBlobs.digest, after.blob.digest))
				.run();
			await expect(
				service.recordApplyReceipt(p.ctx, file.id, receipt(claim, { observedAfter: after })),
			).rejects.toThrow("not ready");
			db.update(fileChangeStorageBudgets).set({ namespaceKey: "wrong" }).run();
			await expect(service.recordApplyReceipt(p.ctx, file.id, receipt(claim))).rejects.toThrow(
				"namespace",
			);
			expect(journal(p.ctx, file.id)?.status).toBe("applying");
		});
	});

	test("receipt SQL failure leaves no applied counter, phase proof or raw pointer half-written", async () => {
		const p = await started();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		await rollback(async (lease) => {
			const claim = service.claimApply(p.ctx, file, lease);
			const proof = receipt(claim);
			injection("revert_operations", "BEFORE UPDATE", "SELECT RAISE(ABORT, 'receipt SQL failure')");
			await expect(service.recordApplyReceipt(p.ctx, file.id, proof)).rejects.toThrow();
			expect(service.getOperation(p.ctx).appliedFileCount).toBe(0);
			expect(journal(p.ctx, file.id)?.observedAfterStateJson).toBeNull();
			conn.run("DROP TRIGGER injected_failure");
			expect((await service.recordApplyReceipt(p.ctx, file.id, proof)).status).toBe("verified");
		});
	});

	test("finish verifies all pages/sequences rather than trusting counters or a prefix", async () => {
		const p = await started(Array.from({ length: 35 }, (_, i) => fixed(i, ABSENT, ABSENT)));
		await rollback(async (lease) => {
			for (const file of p.files.slice(0, 34)) await applyFile(p.ctx, file, lease);
		});
		db.update(revertOperations)
			.set({ appliedFileCount: 35 })
			.where(eq(revertOperations.id, p.ctx.planId))
			.run();
		let yielded = false;
		setImmediate(() => {
			yielded = true;
		});
		expect((await service.finishFiles(p.ctx)).status).toBe("recovery_required");
		expect(yielded).toBe(true);
		expect(service.getOperation(p.ctx).appliedFileCount).toBe(34);
		const last = p.files.at(-1);
		if (!last) throw new Error("fixture");
		db.delete(revertOperationFiles).where(eq(revertOperationFiles.id, last.id)).run();
		await expect(service.finishFiles(p.ctx)).rejects.toThrow("fixed file set is missing");
	});

	test("lowering fileCount and deleting a tail cannot forge the original full manifest", async () => {
		const p = await started([fixed(0), fixed(1)]);
		const [first, last] = p.files;
		if (!first || !last) throw new Error("fixture");
		await rollback(async (lease) => {
			await applyFile(p.ctx, first, lease);
		});
		db.delete(revertOperationFiles).where(eq(revertOperationFiles.id, last.id)).run();
		db.update(revertOperations)
			.set({ fileCount: 1 })
			.where(eq(revertOperations.id, p.ctx.planId))
			.run();
		await expect(service.finishFiles(p.ctx)).rejects.toThrow("prepared manifest commitment");
		expect(service.getOperation(p.ctx).status).toBe("applying");
	});

	test("journal changes across a verification page yield cannot advance a stale scan", async () => {
		const p = await started(Array.from({ length: 33 }, (_, i) => fixed(i, ABSENT, ABSENT)));
		setImmediate(() =>
			db
				.update(revertOperations)
				.set({ updatedAt: "2026-09-07T15:00:00.000Z" })
				.where(eq(revertOperations.id, p.ctx.planId))
				.run(),
		);
		await expect(service.finishFiles(p.ctx)).rejects.toThrow("bounded page yield");
		expect(service.getOperation(p.ctx).status).toBe("applying");
	});

	test("forged verified status with no receipt never passes finish", async () => {
		const p = await started();
		db.update(revertOperationFiles).set({ status: "verified" }).run();
		await expect(service.finishFiles(p.ctx)).rejects.toThrow("typed phase journal");
	});

	test("additional observed raw bytes are admitted against the complete plan budget", async () => {
		const huge = known("large-fixture", FILE_CHANGE_LIMITS.blobBytes);
		const list = Array.from({ length: 3 }, (_, i) => fixed(i, huge, huge));
		list.push(fixed(3, huge, known("near-budget", FILE_CHANGE_LIMITS.blobBytes - 1024 * 1024)));
		const p = await started(list);
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		await rollback(async (lease) => {
			const claim = service.claimApply(p.ctx, file, lease);
			await expect(
				service.recordApplyReceipt(
					p.ctx,
					file.id,
					receipt(claim, { observedAfter: known("too-big-observation", 2 * 1024 * 1024) }),
				),
			).rejects.toThrow("finite budget");
			expect(journal(p.ctx, file.id)?.observedAfterStateJson).toBeNull();
		});
	});
});

describe("history and journal form one synchronous transaction", () => {
	test("real history collector/commit runs through the actual journal transaction without invalidating its stamp", async () => {
		const p = await historyScenario();
		const token = await p.prepareHistory();
		const beforeFile = service.listFiles(p.ctx).items[0];
		let affected: string[] = [];
		const result = service.commit(p.ctx, {
			db,
			apply(tx) {
				affected = p.history.applyToTransaction(tx, token).affectedNarratorIds;
			},
		});
		expect(result.status).toBe("committed");
		expect(affected).toContain("history-narrator");
		expect(remainingMessages()).toEqual(["keep-message"]);
		expect(historyVersion()).toBe(8);
		expect(service.listFiles(p.ctx).items[0]).toEqual(beforeFile);
		expect(
			service.commit(p.ctx, {
				db,
				apply(tx) {
					p.history.applyToTransaction(tx, token);
				},
			}),
		).toEqual(result);
	});

	test("real history mutations and message version roll back when the committed journal update fails", async () => {
		const p = await historyScenario();
		injection(
			"revert_operations",
			"BEFORE UPDATE",
			"SELECT RAISE(ABORT, 'real journal commit failed')",
		);
		const token = await p.prepareHistory();
		expect(() =>
			service.commit(p.ctx, {
				db,
				apply(tx) {
					p.history.applyToTransaction(tx, token);
				},
			}),
		).toThrow("real journal commit failed");
		expect(remainingMessages()).toEqual(["keep-message", "remove-message"]);
		expect(historyVersion()).toBe(7);
		expect(service.getOperation(p.ctx).status).toBe("files_verified");
		conn.run("DROP TRIGGER injected_failure");
		const freshToken = await p.prepareHistory();
		expect(
			service.commit(p.ctx, {
				db,
				apply(tx) {
					p.history.applyToTransaction(tx, freshToken);
				},
			}).status,
		).toBe("committed");
		expect(remainingMessages()).toEqual(["keep-message"]);
	});

	test("a late async callback continuation cannot retain the live transaction capability", async () => {
		const p = await verified();
		let continuation: Promise<void> | undefined;
		expect(() =>
			service.commit(p.ctx, {
				db,
				apply(tx) {
					continuation = Promise.resolve().then(() => {
						tx.insert(narrators)
							.values({ id: "escaped", createdAt: now(), updatedAt: now() })
							.run();
					});
					return continuation;
				},
			}),
		).toThrow("Promise");
		if (!continuation) throw new Error("Expected continuation");
		await expect(continuation).rejects.toThrow();
		expect(db.select().from(narrators).where(eq(narrators.id, "escaped")).get()).toBeUndefined();
		expect(service.getOperation(p.ctx).status).toBe("files_verified");
	});

	test("empty fixed plans still require start and finish; file-only commit needs no callback", async () => {
		const p = await prepared([]);
		expect(() => service.commit(p.ctx)).toThrow();
		await service.startExecution(p.ctx, p.request.manifestProof);
		await service.finishFiles(p.ctx);
		expect(service.commit(p.ctx).status).toBe("committed");
		expect(service.commit(p.ctx).status).toBe("committed");
		expect(() => service.beginCompensation(p.ctx)).toThrow("Committed");
	});

	test("history callback runs once with a live same-root transaction", async () => {
		const p = await verified();
		let calls = 0;
		const history = {
			db,
			apply(tx: RevertJournalTransaction) {
				expect(conn.inTransaction).toBe(true);
				calls++;
				tx.insert(narrators).values({ id: "history", createdAt: now(), updatedAt: now() }).run();
			},
		};
		expect(service.commit(p.ctx, history).status).toBe("committed");
		service.commit(p.ctx, history);
		expect(calls).toBe(1);
		expect(db.select().from(narrators).where(eq(narrators.id, "history")).get()).toBeDefined();
	});

	test("history throw and final journal SQL failure both roll back all history", async () => {
		const p = await verified();
		expect(() =>
			service.commit(p.ctx, {
				db,
				apply(tx) {
					tx.insert(narrators).values({ id: "history", createdAt: now(), updatedAt: now() }).run();
					throw new Error("history failure");
				},
			}),
		).toThrow("history failure");
		expect(db.select().from(narrators).where(eq(narrators.id, "history")).get()).toBeUndefined();
		injection("revert_operations", "BEFORE UPDATE", "SELECT RAISE(ABORT, 'final journal failure')");
		expect(() =>
			service.commit(p.ctx, {
				db,
				apply(tx) {
					tx.insert(narrators).values({ id: "history", createdAt: now(), updatedAt: now() }).run();
				},
			}),
		).toThrow();
		expect(db.select().from(narrators).where(eq(narrators.id, "history")).get()).toBeUndefined();
		expect(service.getOperation(p.ctx).status).toBe("files_verified");
	});

	test("native COMMIT failure rolls back verified marker and history together", async () => {
		const p = await verified();
		conn.run("PRAGMA defer_foreign_keys = ON");
		expect(() =>
			service.commit(p.ctx, {
				db,
				apply(tx) {
					tx.insert(narrators).values({ id: "history", createdAt: now(), updatedAt: now() }).run();
					tx.update(revertOperations)
						.set({ narratorId: "does-not-exist" })
						.where(eq(revertOperations.id, p.ctx.planId))
						.run();
				},
			}),
		).toThrow();
		expect(service.getOperation(p.ctx).status).toBe("files_verified");
		expect(db.select().from(narrators).where(eq(narrators.id, "history")).get()).toBeUndefined();
	});

	test("raw evidence invalidated after files_verified blocks history commit", async () => {
		const p = await verified();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		if (file.expectedStateJson.kind !== "regular") throw new Error("fixture");
		db.update(fileChangeBlobs)
			.set({ status: "expired" })
			.where(eq(fileChangeBlobs.digest, file.expectedStateJson.blob.digest))
			.run();
		let called = false;
		expect(() =>
			service.commit(p.ctx, {
				db,
				apply() {
					called = true;
				},
			}),
		).toThrow("Pinned raw evidence");
		expect(called).toBe(false);
		expect(service.getOperation(p.ctx).status).toBe("files_verified");
	});

	test("async, Promise-returning, foreign DB and ambient transactions reject", async () => {
		const p = await verified();
		expect(() => service.commit(p.ctx, { db, async apply() {} })).toThrow("synchronous");
		expect(() =>
			service.commit(p.ctx, {
				db,
				apply(tx) {
					tx.insert(narrators).values({ id: "history", createdAt: now(), updatedAt: now() }).run();
					return Promise.resolve();
				},
			}),
		).toThrow("Promise");
		const foreign = new Database(":memory:");
		try {
			expect(() => service.commit(p.ctx, { db: drizzle(foreign), apply() {} })).toThrow(
				"same root",
			);
		} finally {
			foreign.close();
		}
		expect(() => db.transaction(() => service.commit(p.ctx))).toThrow("outside any transaction");
		expect(db.select().from(narrators).where(eq(narrators.id, "history")).get()).toBeUndefined();
	});
});

describe("separate guarded compensation", () => {
	test("apply and compensate preserve independent receipts, bindings and raw pins", async () => {
		const p = await verified();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		const before = journal(p.ctx, file.id);
		if (!before) throw new Error("fixture");
		service.beginCompensation(p.ctx);
		await rollback(async (lease) => {
			const claim = service.claimCompensate(p.ctx, file, lease);
			expect(claim.expected).toEqual(file.desiredStateJson);
			expect(claim.desired).toEqual(file.expectedStateJson);
			expect(claim.mutationId).not.toBe(file.applyMutationId);
			expect(service.claimCompensate(p.ctx, file, lease).mayExecute).toBe(false);
			lease.registerMutation(claim.mutationId);
			const proof = receipt(claim);
			const compensated = await service.recordCompensateReceipt(p.ctx, file.id, proof);
			lease.settle(claim.mutationId, "applied");
			expect(compensated.status).toBe("compensated");
			expect(compensated.observedAfterStateJson).toEqual(before.observedAfterStateJson);
			expect(compensated.observedAfterBlobDigest).toBe(before.observedAfterBlobDigest);
			expect(compensated.compensationAfterStateJson).toEqual(file.expectedStateJson);
			expect((compensated.receiptJson as FileChangeRevertMutationJournal).apply).toEqual(
				(before.receiptJson as FileChangeRevertMutationJournal).apply,
			);
			expect(await service.recordCompensateReceipt(p.ctx, file.id, proof)).toEqual(compensated);
			await expect(
				service.recordCompensateReceipt(p.ctx, file.id, { ...proof, receiptId: "other" }),
			).rejects.toThrow("overwritten");
		});
		expect((await service.finishCompensation(p.ctx)).status).toBe("compensated");
		expect(() => service.commit(p.ctx)).toThrow();
	});

	for (const reason of ["claimed_only", "unknown", "partial", "not_applied"] as const) {
		test(`${reason} never authorizes an inverse from an intended state`, async () => {
			const p = await started();
			const file = p.files[0];
			if (!file) throw new Error("fixture");
			await rollback(async (lease) => {
				if (reason === "claimed_only") service.claimApply(p.ctx, file, lease);
				else
					await applyFile(
						p.ctx,
						file,
						lease,
						reason === "unknown"
							? { outcome: "unknown", confirmed: false }
							: reason === "partial"
								? { observedAfter: known("third-party") }
								: { outcome: "not_applied", observedAfter: file.expectedStateJson },
					);
			});
			service.beginCompensation(p.ctx);
			await rollback((lease) => {
				expect(() => service.claimCompensate(p.ctx, file, lease)).toThrow();
			});
			const result = await service.finishCompensation(p.ctx);
			expect(result.status).toBe(reason === "not_applied" ? "compensated" : "recovery_required");
		});
	}

	test("never-claimed files require no compensation and have no fabricated receipt", async () => {
		const p = await started();
		service.beginCompensation(p.ctx);
		expect((await service.finishCompensation(p.ctx)).status).toBe("compensated");
		expect(service.listFiles(p.ctx).items[0]?.receiptJson).toBeNull();
	});

	test("unknown file cannot be hidden by compensating another confirmed file", async () => {
		const p = await started([fixed(0), fixed(1)]);
		const [a, b] = p.files;
		if (!a || !b) throw new Error("fixture");
		await rollback(async (lease) => {
			await applyFile(p.ctx, a, lease);
			await applyFile(p.ctx, b, lease, { confirmed: false, outcome: "unknown" });
		});
		service.beginCompensation(p.ctx);
		await rollback(async (lease) => {
			const claim = service.claimCompensate(p.ctx, a, lease);
			await service.recordCompensateReceipt(p.ctx, a.id, receipt(claim));
		});
		expect((await service.finishCompensation(p.ctx)).status).toBe("recovery_required");
		expect(journal(p.ctx, a.id)?.status).toBe("compensated");
		expect(journal(p.ctx, b.id)?.status).toBe("unknown");
	});

	test("compensation failure/foreign after cannot become compensated or erase apply evidence", async () => {
		const p = await verified();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		service.beginCompensation(p.ctx);
		await rollback(async (lease) => {
			const claim = service.claimCompensate(p.ctx, file, lease);
			const proof = receipt(claim, { observedAfter: known("later-third-party") });
			await service.recordCompensateReceipt(p.ctx, file.id, proof);
		});
		expect((await service.finishCompensation(p.ctx)).status).toBe("recovery_required");
		expect(journal(p.ctx, file.id)?.observedAfterStateJson).toEqual(file.desiredStateJson);
	});

	test("compensation claim commit failure cannot partly persist inverse execution permission", async () => {
		const p = await verified();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		service.beginCompensation(p.ctx);
		const before = journal(p.ctx, file.id);
		injection("revert_operations", "BEFORE UPDATE", "SELECT RAISE(ABORT, 'inverse claim failure')");
		await rollback((lease) => {
			expect(() => service.claimCompensate(p.ctx, file, lease)).toThrow();
		});
		expect(journal(p.ctx, file.id)).toEqual(before);
	});

	test("compensation phase failure rolls back only the new phase proof", async () => {
		const p = await verified();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		service.beginCompensation(p.ctx);
		await rollback(async (lease) => {
			const claim = service.claimCompensate(p.ctx, file, lease);
			const proof = receipt(claim);
			injection("revert_operations", "BEFORE UPDATE", "SELECT RAISE(ABORT, 'comp receipt failed')");
			await expect(service.recordCompensateReceipt(p.ctx, file.id, proof)).rejects.toThrow();
			expect(journal(p.ctx, file.id)?.compensationAfterStateJson).toBeNull();
			expect(journal(p.ctx, file.id)?.observedAfterStateJson).toEqual(file.desiredStateJson);
			conn.run("DROP TRIGGER injected_failure");
			expect((await service.recordCompensateReceipt(p.ctx, file.id, proof)).status).toBe(
				"compensated",
			);
		});
	});

	test("legacy scalar receipt and unknown typed observation cannot gain compensation permission", async () => {
		const p = await started();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		db.update(revertOperationFiles)
			.set({ status: "applied", receiptJson: { ok: true } })
			.where(eq(revertOperationFiles.id, file.id))
			.run();
		service.beginCompensation(p.ctx);
		await rollback((lease) => {
			expect(() => service.claimCompensate(p.ctx, file, lease)).toThrow();
		});
		await expect(service.finishCompensation(p.ctx)).rejects.toThrow();
	});
});

describe("recovery inventory, durable reopen and bounded access", () => {
	test("claim and original pending binding survive close/reopen without fresh mayExecute", async () => {
		const p = await started();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		let first: RevertJournalClaim | undefined;
		await rollback((lease) => {
			first = service.claimApply(p.ctx, file, lease);
		});
		const snapshot = conn.serialize();
		conn.close();
		temp = mkdtempSync(join(tmpdir(), "narrafork-revert-journal-"));
		const path = join(temp, "journal.db");
		writeFileSync(path, snapshot);
		conn = new Database(path);
		connect();
		conn.close();
		conn = new Database(path);
		connect();
		clock += FILE_CHANGE_LIMITS.planLifetimeMs * 10;
		expect(
			service.listPending(owner, { status: "applying" }).items.some((op) => op.id === p.ctx.planId),
		).toBe(true);
		if (!first) throw new Error("fixture");
		const old = first;
		await rollback(async (lease) => {
			const repeated = service.claimApply(p.ctx, file, lease);
			expect(repeated.mayExecute).toBe(false);
			expect(repeated.executionBinding).toEqual(old.executionBinding);
		});
		expect((await service.recordApplyReceipt(p.ctx, file.id, receipt(old))).status).toBe(
			"verified",
		);
	});

	test("owner/context bound read inventory never uses hashes as authorization", async () => {
		const p = await started();
		for (const altered of [
			{ ...owner, subjectKey: "other" },
			{ ...owner, narratorId: "other" },
			{ ...owner, projectId: "other" },
		]) {
			expect(service.listPending(altered, { status: "applying" }).items).toHaveLength(0);
			expect(() => service.listFiles({ ...p.ctx, owner: altered })).toThrow("owning context");
		}
		expect(() => service.listFiles(p.ctx, { limit: 101 })).toThrow();
		expect(() => service.listPending(owner, { status: "applying", limit: 0 })).toThrow();
	});

	test("pending inventory seeks one owner/context/status and preserves timestamp ties", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) ids.push((await started([])).ctx.planId);
		const found: string[] = [];
		let cursor: RevertJournalPendingCursor | undefined;
		do {
			const page = service.listPending(owner, { status: "applying", limit: 2, cursor });
			found.push(...page.items.map((row) => row.id));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(found.sort()).toEqual(ids.sort());
		const plan = conn
			.query(
				"EXPLAIN QUERY PLAN SELECT id FROM revert_operations WHERE requested_by_subject_key = ? AND narrator_id IS NULL AND project_id IS NULL AND status = ? AND (updated_at,id) > (?,?) ORDER BY updated_at,id LIMIT 101",
			)
			.all(owner.subjectKey, "applying", "", "");
		expect(JSON.stringify(plan)).toContain("idx_revert_operation_owner_pending");
		expect(JSON.stringify(plan)).toContain("(updated_at,id)>(?,?)");
		expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE");
	});

	test("every pending state has its own bounded owner-context inventory page", async () => {
		const applying = await started([]);
		const checked = await started([]);
		await service.finishFiles(checked.ctx);
		const compensating = await started([]);
		service.beginCompensation(compensating.ctx);
		const recovery = await started([fixed()]);
		await service.finishFiles(recovery.ctx);
		for (const [status, id] of [
			["applying", applying.ctx.planId],
			["files_verified", checked.ctx.planId],
			["compensating", compensating.ctx.planId],
			["recovery_required", recovery.ctx.planId],
		] as const) {
			const page = service.listPending(owner, { status, limit: 1 });
			expect(page.items.map((row) => row.id)).toEqual([id]);
			expect(page.hasMore).toBe(false);
		}
	});

	test("1000-file admission and finish enumerate the whole fixed set while yielding", async () => {
		const p = await started(Array.from({ length: 1000 }, (_, i) => fixed(i, ABSENT, ABSENT)));
		let yielded = false;
		setImmediate(() => {
			yielded = true;
		});
		expect((await service.finishFiles(p.ctx)).status).toBe("recovery_required");
		expect(yielded).toBe(true);
		service.beginCompensation(p.ctx);
		expect((await service.finishCompensation(p.ctx)).status).toBe("compensated");
	}, 30_000);

	test("cursor pagination is complete and has no body columns/global aggregation", async () => {
		const p = await started(Array.from({ length: 40 }, (_, i) => fixed(i, ABSENT, ABSENT)));
		const ids: string[] = [];
		let cursor: string | undefined;
		do {
			const page = service.listFiles(p.ctx, { cursor, limit: 7 });
			ids.push(...page.items.map((row) => row.id));
			cursor = page.nextCursor ?? undefined;
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(FILE_CHANGE_LIMITS.summaryBytes);
		} while (cursor);
		expect(new Set(ids).size).toBe(40);
		expect(queries.some((query) => /\b(sum|count)\s*\(/i.test(query))).toBe(false);
		expect(queries.some((query) => /raw_dump_json|content_json|input_json/i.test(query))).toBe(
			false,
		);
	});

	test("cancellation retains journal and refs, never resets a claim", async () => {
		const p = await started();
		const file = p.files[0];
		if (!file) throw new Error("fixture");
		await rollback((lease) => service.claimApply(p.ctx, file, lease));
		const c = new AbortController();
		c.abort(new Error("cancelled"));
		await expect(service.finishFiles(p.ctx, { signal: c.signal })).rejects.toThrow("cancelled");
		expect(journal(p.ctx, file.id)?.status).toBe("applying");
		expect(service.listPending(owner, { status: "applying" }).items).toHaveLength(1);
	});
});
