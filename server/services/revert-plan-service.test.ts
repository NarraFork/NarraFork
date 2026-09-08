import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	FILE_CHANGE_LIMITS,
	type FileChangeBlobRef,
	type FileChangeState,
} from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	fileChangeBlobs,
	fileChangeScopes,
	fileChangeStorageBudgets,
	revertOperationFiles,
	revertOperations,
} from "../db/schema";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "./file-change-blob-catalog";
import { createFileChangeIdentity } from "./file-change-identity";
import {
	type AppendRevertPlanFile,
	type BeginRevertPlan,
	fingerprintRevertPlanFiles,
	REVERT_PLAN_BATCH_ITEMS,
	type RevertPlanFileCursor,
	type RevertPlanHeader,
	type RevertPlanManifestProof,
	type RevertPlanOwner,
	RevertPlanService,
	type RevertPlanSummaryCursor,
	revertPlanHeaderDigest,
} from "./revert-plan-service";

// Standalone schema fixtures only: no application DB, migrations, runtime or production IO.
const DDL = `
CREATE TABLE narrators (id TEXT PRIMARY KEY);
CREATE TABLE projects (id TEXT PRIMARY KEY);
INSERT INTO narrators VALUES ('narrator-a'), ('narrator-b');
INSERT INTO projects VALUES ('project-a'), ('project-b');
CREATE TABLE file_change_blobs (
 id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL,
 storage_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'staging', lease_until TEXT,
 gc_generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE file_change_storage_budgets (
 id TEXT PRIMARY KEY, namespace_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'unverified',
 used_bytes INTEGER NOT NULL DEFAULT 0, reserved_bytes INTEGER NOT NULL DEFAULT 0,
 quota_bytes INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0, reconciled_at TEXT,
 updated_at TEXT NOT NULL
);
CREATE TABLE file_change_scopes (
 id TEXT PRIMARY KEY, source_instance_id TEXT NOT NULL, device_id TEXT NOT NULL,
 workspace_instance_id TEXT NOT NULL, canonical_root TEXT NOT NULL, display_root TEXT NOT NULL,
 path_flavor TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'needs_verification', root_identity_json TEXT,
 revision INTEGER NOT NULL DEFAULT 0, fencing_token INTEGER NOT NULL DEFAULT 0,
 active_lease_id TEXT, active_lease_epoch TEXT, active_lease_started_at TEXT,
 active_mutation_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE revert_operations (
 id TEXT PRIMARY KEY, protocol_version INTEGER NOT NULL DEFAULT 2,
 narrator_id TEXT REFERENCES narrators(id) ON DELETE SET NULL,
 project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
 requested_by_subject_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL,
 kind TEXT NOT NULL, scope TEXT NOT NULL, selector_kind TEXT NOT NULL,
 selector_blob_digest TEXT REFERENCES file_change_blobs(digest),
 plan_blob_digest TEXT REFERENCES file_change_blobs(digest),
 history_manifest_blob_digest TEXT REFERENCES file_change_blobs(digest),
 plan_hash TEXT, expected_message_version INTEGER, parent_revert_id TEXT,
 status TEXT NOT NULL DEFAULT 'planned', file_count INTEGER NOT NULL DEFAULT 0,
 applied_file_count INTEGER NOT NULL DEFAULT 0, coverage_complete INTEGER NOT NULL DEFAULT 0,
 reason TEXT, expires_at TEXT NOT NULL, lease_until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_revert_operation_request ON revert_operations(requested_by_subject_key, idempotency_key);
CREATE INDEX idx_revert_operation_narrator ON revert_operations(narrator_id, created_at, id);
CREATE INDEX idx_revert_operation_pending ON revert_operations(status, updated_at, id);
CREATE INDEX idx_revert_operation_parent ON revert_operations(parent_revert_id);
CREATE INDEX idx_revert_operation_plan_blob ON revert_operations(plan_blob_digest);
CREATE INDEX idx_revert_operation_selector_blob ON revert_operations(selector_blob_digest);
CREATE INDEX idx_revert_operation_history_blob ON revert_operations(history_manifest_blob_digest);
CREATE TABLE revert_operation_files (
 id TEXT PRIMARY KEY, revert_operation_id TEXT NOT NULL REFERENCES revert_operations(id),
 scope_id TEXT NOT NULL REFERENCES file_change_scopes(id), file_key TEXT NOT NULL,
 identity_json TEXT NOT NULL, sequence INTEGER NOT NULL, expected_state_json TEXT NOT NULL,
 desired_state_json TEXT NOT NULL, observed_after_state_json TEXT,
 compensation_after_state_json TEXT, compensation_after_blob_digest TEXT REFERENCES file_change_blobs(digest),
 before_blob_digest TEXT REFERENCES file_change_blobs(digest),
 desired_blob_digest TEXT REFERENCES file_change_blobs(digest),
 observed_after_blob_digest TEXT REFERENCES file_change_blobs(digest),
 apply_mutation_id TEXT NOT NULL, apply_request_digest TEXT NOT NULL,
 compensate_mutation_id TEXT NOT NULL, compensate_request_digest TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'prepared', receipt_json TEXT, reason TEXT, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_revert_file_identity ON revert_operation_files(revert_operation_id, file_key);
CREATE UNIQUE INDEX idx_revert_file_apply ON revert_operation_files(apply_mutation_id);
CREATE UNIQUE INDEX idx_revert_file_compensate ON revert_operation_files(compensate_mutation_id);
CREATE INDEX idx_revert_file_pending ON revert_operation_files(revert_operation_id, status, sequence);
CREATE INDEX idx_revert_file_before_blob ON revert_operation_files(before_blob_digest);
CREATE INDEX idx_revert_file_desired_blob ON revert_operation_files(desired_blob_digest);
CREATE INDEX idx_revert_file_observed_blob ON revert_operation_files(observed_after_blob_digest);
`;
const owner: RevertPlanOwner = {
	subjectKey: "human:alice",
	narratorId: "narrator-a",
	projectId: "project-a",
};
const namespaceKey = "isolated-revert-plan-blobs";
const ABSENT: FileChangeState = { kind: "absent" };
let sqlite: Database;
let db: ReturnType<typeof drizzle>;
let service: RevertPlanService;
let clock: number;
let serial: number;
let queries: string[];
let published: Map<string, string>;
let scope: typeof fileChangeScopes.$inferSelect;

beforeEach(() => {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(process.env.HOME).not.toBe(process.env.NARRAFORK_ORIGINAL_HOME);
	clock = Date.parse("2026-09-07T12:00:00.000Z");
	serial = 0;
	published = new Map();
	queries = [];
	sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
	sqlite.exec(DDL);
	db = drizzle(sqlite, {
		logger: {
			logQuery: (query) => {
				if (queries.length < 10_000) queries.push(query);
			},
		},
	});
	service = new RevertPlanService(db, { namespaceKey, now: () => new Date(clock).toISOString() });
	db.insert(fileChangeStorageBudgets)
		.values({
			id: FILE_CHANGE_BLOB_BUDGET_ID,
			namespaceKey,
			status: "ready",
			quotaBytes: FILE_CHANGE_LIMITS.blobSoftQuotaBytes,
			updatedAt: now(),
		})
		.run();
	scope = db
		.insert(fileChangeScopes)
		.values({
			id: "scope-a",
			sourceInstanceId: "installation-a",
			deviceId: "device-a",
			workspaceInstanceId: "workspace-a",
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
afterEach(() => sqlite.close());
function now() {
	return new Date(clock).toISOString();
}
function hash(body: string) {
	return createHash("sha256").update(body).digest("hex");
}
function publish(body: string): FileChangeBlobRef {
	const ref: FileChangeBlobRef = {
		algorithm: "sha256",
		digest: hash(body),
		sizeBytes: Buffer.byteLength(body),
	};
	if (!published.has(ref.digest))
		db.insert(fileChangeBlobs)
			.values({
				id: `blob-${serial++}`,
				digest: ref.digest,
				sizeBytes: ref.sizeBytes,
				storageKey: `${ref.digest.slice(0, 2)}/${ref.digest}`,
				status: "ready",
				createdAt: now(),
				updatedAt: now(),
			})
			.run();
	published.set(ref.digest, body);
	return ref;
}
function known(body: string): FileChangeState {
	return { kind: "regular", blob: publish(body), mode: 0o644 };
}
function file(
	sequence = 0,
	expected: FileChangeState = known(`before-${sequence}`),
	desired: FileChangeState = known(`after-${sequence}`),
): AppendRevertPlanFile {
	return {
		sequence,
		identity: createFileChangeIdentity(scope, {
			deviceId: scope.deviceId,
			pathFlavor: scope.pathFlavor,
			objectRole: "referent",
			canonicalPath: `/repo/file-${sequence}.txt`,
			lexicalPath: `/repo/file-${sequence}.txt`,
		}),
		expected,
		desired,
	};
}
function plan(
	files: AppendRevertPlanFile[] = [file()],
	overrides: Partial<RevertPlanHeader> = {},
): BeginRevertPlan {
	const header: RevertPlanHeader = {
		...owner,
		idempotencyKey: `request-${serial++}`,
		requestDigest: hash("complete original request"),
		kind: "revert",
		revertScope: "narrator",
		selectorKind: "all",
		selector: publish('{"kind":"all","fixedOperations":["actual-operation-1"]}'),
		historyManifest: publish('{"version":1,"complete":true,"stableMessageIds":[]}'),
		expectedMessageVersion: 7,
		expectedFileCount: files.length,
		...overrides,
	};
	const fingerprint = fingerprintRevertPlanFiles(files);
	const proof: RevertPlanManifestProof = {
		source: "trusted_published_planner_v1",
		headerDigest: revertPlanHeaderDigest(header),
		orderedFilesDigest: fingerprint.orderedFilesDigest,
		fileEvidenceBytes: fingerprint.fileEvidenceBytes,
		computation: "complete",
		selectorCoverage: "complete",
		historyCoverage: "complete",
		omittedFiles: 0,
		unknownFiles: 0,
	};
	return {
		...header,
		plan: publish(JSON.stringify({ header, completeOrderedFiles: files, proof })),
		manifestProof: proof,
	};
}
function code(run: () => unknown, suffix: string) {
	expect(run).toThrow(expect.objectContaining({ code: `REVERT_PLAN_${suffix}` }));
}
async function rejected(promise: Promise<unknown>, suffix: string) {
	await expect(promise).rejects.toMatchObject({ code: `REVERT_PLAN_${suffix}` });
}
function record(id: string) {
	return db.select().from(revertOperations).where(eq(revertOperations.id, id)).get();
}
function storedFiles(id: string) {
	return db
		.select()
		.from(revertOperationFiles)
		.where(eq(revertOperationFiles.revertOperationId, id))
		.limit(FILE_CHANGE_LIMITS.revertFiles + 1)
		.all();
}
function incomplete(id: string) {
	expect(service.getSummary(owner, id)).toMatchObject({
		status: "planned",
		coverageComplete: false,
	});
}
async function appendAll(input: BeginRevertPlan, files: AppendRevertPlanFile[]) {
	const result = service.begin(input);
	for (let index = 0; index < files.length; index += REVERT_PLAN_BATCH_ITEMS)
		await service.appendFiles(
			input,
			result.id,
			files.slice(index, index + REVERT_PLAN_BATCH_ITEMS),
		);
	return result;
}

describe("fixed manifest journal and owner boundary", () => {
	test("begin pins original refs, declares expected count and is idempotent without preparing", () => {
		const input = plan();
		const first = service.begin(input);
		expect(service.begin(input)).toEqual(first);
		expect(first).toMatchObject({
			status: "planned",
			coverageComplete: false,
			expectedFileCount: 1,
			expired: false,
		});
		expect(storedFiles(first.id)).toHaveLength(0);
		expect(record(first.id)).toMatchObject({
			selectorBlobDigest: input.selector.digest,
			planBlobDigest: input.plan.digest,
			historyManifestBlobDigest: input.historyManifest.digest,
			fileCount: 1,
			appliedFileCount: 0,
		});
		expect(Date.parse(first.expiresAt) - Date.parse(first.createdAt)).toBe(
			FILE_CHANGE_LIMITS.planLifetimeMs,
		);
		for (const ref of [input.selector, input.plan, input.historyManifest])
			expect(() =>
				db.delete(fileChangeBlobs).where(eq(fileChangeBlobs.digest, ref.digest)).run(),
			).toThrow();
		expect(first.manifestDigests).toEqual({
			selector: input.selector.digest,
			plan: input.plan.digest,
			history: input.historyManifest.digest,
		});
		expect(JSON.stringify(first)).not.toContain("fixedOperations");
		expect(JSON.stringify(first)).not.toContain("storageKey");
	});

	test("same actor/key rejects a different complete request even with an unchanged caller digest", () => {
		const files = [file()];
		const input = plan(files);
		service.begin(input);
		const changed = plan(files, {
			idempotencyKey: input.idempotencyKey,
			requestDigest: input.requestDigest,
			expectedMessageVersion: 8,
		});
		code(() => service.begin(changed), "REQUEST_CONFLICT");
		const targetChange = plan([file(0, known("another expected"))], {
			idempotencyKey: input.idempotencyKey,
		});
		code(() => service.begin(targetChange), "REQUEST_CONFLICT");
	});

	test("all caller-declared header fields and complete manifest proof stay immutable", () => {
		const files = [file()];
		const original = plan(files);
		service.begin(original);
		const changes: Partial<RevertPlanHeader>[] = [
			{ narratorId: "narrator-b" },
			{ projectId: "project-b" },
			{ kind: "history_delete" },
			{ revertScope: "workspace" },
			{ selectorKind: "messages" },
			{ expectedFileCount: 2 },
			{ selector: publish("other full selector") },
			{ historyManifest: publish("other complete history") },
			{ requestDigest: hash("another full request") },
		];
		for (const change of changes)
			code(
				() =>
					service.begin(
						plan(files, { ...original, ...change, idempotencyKey: original.idempotencyKey }),
					),
				"REQUEST_CONFLICT",
			);
		code(
			() =>
				service.begin({
					...original,
					manifestProof: {
						...original.manifestProof,
						orderedFilesDigest: hash("other ordered list"),
					},
				}),
			"REQUEST_CONFLICT",
		);
		code(
			() => service.begin({ ...original, plan: publish("replacement plan manifest") }),
			"REQUEST_CONFLICT",
		);
	});

	test("actor/context isolation applies to lookup, pages, append and finalize", async () => {
		const input = plan();
		const first = service.begin(input);
		const other: RevertPlanOwner = { ...owner, subjectKey: "human:bob" };
		const otherPlan = service.begin(
			plan([file()], { ...other, idempotencyKey: input.idempotencyKey }),
		);
		expect(otherPlan.id).not.toBe(first.id);
		for (const wrong of [
			other,
			{ ...owner, narratorId: "narrator-b" },
			{ ...owner, projectId: "project-b" },
		]) {
			code(() => service.getSummary(wrong, first.id), "NOT_FOUND");
			code(() => service.listFiles(wrong, first.id), "NOT_FOUND");
			await rejected(service.appendFiles(wrong, first.id, [file()]), "NOT_FOUND");
			await rejected(service.finalize(wrong, first.id, input.manifestProof), "NOT_FOUND");
		}
		expect(service.listSummaries(owner).items.map((item) => item.id)).toEqual([first.id]);
		expect(service.listSummaries(other).items.map((item) => item.id)).toEqual([otherPlan.id]);
	});

	test("root connection, enabled FKs and no ambient transaction are required", () => {
		const input = plan();
		expect(() =>
			db.transaction(
				(tx) =>
					new RevertPlanService(
						tx as unknown as ConstructorParameters<typeof RevertPlanService>[0],
						{ namespaceKey },
					),
			),
		).toThrow();
		db.transaction(() => code(() => service.begin(input), "DURABILITY_BOUNDARY"));
		sqlite.exec("PRAGMA foreign_keys = OFF");
		code(() => service.begin(input), "DURABILITY_BOUNDARY");
		code(() => new RevertPlanService(db, { namespaceKey }), "DURABILITY_BOUNDARY");
	});
});

describe("bounded fixed-file append and publication validation", () => {
	test("durable phase IDs and request digests differ, survive retries and bind all metadata", async () => {
		const files = [file()];
		const input = plan(files);
		const result = service.begin(input);
		const first = await service.appendFiles(owner, result.id, files);
		const row = storedFiles(result.id)[0];
		expect(await service.appendFiles(owner, result.id, files)).toEqual(first);
		expect(storedFiles(result.id)).toHaveLength(1);
		expect(row.applyMutationId).not.toBe(row.compensateMutationId);
		expect(row.applyRequestDigest).not.toBe(row.compensateRequestDigest);
		expect(row.applyMutationId).toMatch(/^[a-f0-9]{64}$/);
		await rejected(
			service.appendFiles(owner, result.id, [file(0, known("changed expected"))]),
			"REQUEST_CONFLICT",
		);
		expect(storedFiles(result.id)[0]).toEqual(row);
		incomplete(result.id);
		for (const digest of [row.beforeBlobDigest, row.desiredBlobDigest])
			expect(() =>
				db
					.delete(fileChangeBlobs)
					.where(eq(fileChangeBlobs.digest, digest ?? ""))
					.run(),
			).toThrow();
	});

	test("duplicate identity/sequence rejects the whole batch; sequence ownership survives batches", async () => {
		const files = [file(0), file(1)];
		const result = service.begin(plan(files));
		await rejected(service.appendFiles(owner, result.id, [files[0], files[0]]), "DUPLICATE_FILE");
		await rejected(
			service.appendFiles(owner, result.id, [files[0], { ...files[1], sequence: 0 }]),
			"DUPLICATE_FILE",
		);
		expect(storedFiles(result.id)).toHaveLength(0);
		await service.appendFiles(owner, result.id, [files[0]]);
		await rejected(
			service.appendFiles(owner, result.id, [{ ...files[1], sequence: 0 }]),
			"DUPLICATE_FILE",
		);
		expect(storedFiles(result.id)).toHaveLength(1);
	});

	test("max 32 files per append and no extra file beyond the declared count", async () => {
		const files = Array.from({ length: 33 }, (_, i) => file(i, ABSENT, ABSENT));
		const input = plan(files);
		const result = service.begin(input);
		await rejected(service.appendFiles(owner, result.id, files), "BUDGET_OR_INPUT");
		expect(storedFiles(result.id)).toHaveLength(0);
		const single = service.begin(plan([files[0]]));
		await service.appendFiles(owner, single.id, [files[0]]);
		await rejected(service.appendFiles(owner, single.id, [files[1]]), "BUDGET_OR_INPUT");
	});

	test("unknown state, unsupported object and raw-body metadata are never persisted", async () => {
		const input = plan();
		const result = service.begin(input);
		for (const bad of [{ kind: "unknown", reason: "missing_before" }, null, { kind: "directory" }])
			await rejected(
				service.appendFiles(owner, result.id, [{ ...file(), expected: bad as FileChangeState }]),
				"UNKNOWN_STATE",
			);
		await rejected(
			service.appendFiles(owner, result.id, [
				{
					...file(),
					desired: { kind: "absent", body: "must not store raw text" } as FileChangeState,
				},
			]),
			"INVALID_INPUT",
		);
		code(
			() => service.begin({ ...input, inputJson: "do not copy" } as BeginRevertPlan),
			"INVALID_INPUT",
		);
		expect(storedFiles(result.id)).toHaveLength(0);
	});

	test("undeclared inputJson is rejected before any getter/body copy", async () => {
		const input = plan([]);
		let reads = 0;
		Object.defineProperty(input, "inputJson", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("raw body must not be touched");
			},
		});
		code(() => service.begin(input), "INVALID_INPUT");
		await rejected(service.prepare(input, []), "INVALID_INPUT");
		expect(reads).toBe(0);
		expect(service.listSummaries(owner).items).toHaveLength(0);
	});

	test("each identity must match its actual source, device, workspace, scope and path grammar", async () => {
		const f = file();
		const result = service.begin(plan([f]));
		for (const patch of [
			{ sourceInstanceId: "other" },
			{ deviceId: "other" },
			{ workspaceInstanceId: "other" },
			{ scopeId: "unknown" },
			{ pathFlavor: "windows" },
			{ displayPath: "not-the-recorded-target" },
			{ canonicalPath: "/outside/file.txt" },
		]) {
			await expect(
				service.appendFiles(owner, result.id, [
					{ ...f, identity: { ...f.identity, ...patch } as typeof f.identity },
				]),
			).rejects.toBeDefined();
		}
		db.update(fileChangeScopes)
			.set({ status: "needs_verification" })
			.where(eq(fileChangeScopes.id, scope.id))
			.run();
		await rejected(service.appendFiles(owner, result.id, [f]), "TARGET_UNVERIFIED");
		expect(storedFiles(result.id)).toHaveLength(0);
	});

	test("manifest refs reject nonexistent, staging, expired, missing and wrong-size catalog entries", () => {
		for (const refName of ["selector", "plan", "historyManifest"] as const) {
			const input = plan();
			for (const status of ["staging", "missing", "expired"] as const) {
				db.update(fileChangeBlobs)
					.set({ status })
					.where(eq(fileChangeBlobs.digest, input[refName].digest))
					.run();
				code(() => service.begin(input), "BLOB_NOT_READY");
			}
			db.update(fileChangeBlobs)
				.set({ status: "ready", sizeBytes: input[refName].sizeBytes + 1 })
				.where(eq(fileChangeBlobs.digest, input[refName].digest))
				.run();
			code(() => service.begin(input), "BLOB_NOT_READY");
			db.delete(fileChangeBlobs).where(eq(fileChangeBlobs.digest, input[refName].digest)).run();
			code(() => service.begin(input), "BLOB_NOT_READY");
			published.delete(input[refName].digest);
		}
	});

	test("caller-provided ready flags cannot upgrade raw refs; namespace ready/identity is mandatory", async () => {
		const f = file();
		const input = plan([f]);
		const result = service.begin(input);
		const expectedRef = f.expected.kind === "regular" ? f.expected.blob : publish("unreachable");
		db.update(fileChangeBlobs)
			.set({ status: "staging" })
			.where(eq(fileChangeBlobs.digest, expectedRef.digest))
			.run();
		await rejected(service.appendFiles(owner, result.id, [f]), "BLOB_NOT_READY");
		db.update(fileChangeBlobs)
			.set({ status: "ready", sizeBytes: expectedRef.sizeBytes + 1 })
			.where(eq(fileChangeBlobs.digest, expectedRef.digest))
			.run();
		await rejected(service.appendFiles(owner, result.id, [f]), "BLOB_NOT_READY");
		db.update(fileChangeBlobs)
			.set({ sizeBytes: expectedRef.sizeBytes })
			.where(eq(fileChangeBlobs.digest, expectedRef.digest))
			.run();
		await rejected(
			service.appendFiles(owner, result.id, [
				{
					...f,
					expected: {
						kind: "regular",
						blob: { ...expectedRef, ready: true },
						mode: 0o644,
					} as FileChangeState,
				},
			]),
			"INVALID_INPUT",
		);
		for (const status of ["unverified", "reconciling"] as const) {
			db.update(fileChangeStorageBudgets).set({ status }).run();
			await rejected(service.appendFiles(owner, result.id, [f]), "CATALOG_UNVERIFIED");
			code(() => service.begin(plan()), "CATALOG_UNVERIFIED");
		}
		db.update(fileChangeStorageBudgets)
			.set({ status: "ready", namespaceKey: "another-physical-store" })
			.run();
		await rejected(service.appendFiles(owner, result.id, [f]), "CATALOG_UNVERIFIED");
		expect(storedFiles(result.id)).toHaveLength(0);
	});

	test("symlink targets stay raw refs and absence remains distinct from empty regular content", async () => {
		const symlink: FileChangeState = {
			kind: "symlink",
			target: publish("../real-file"),
			mode: null,
		};
		const f = file(0, symlink, known(""));
		const input = plan([f]);
		const prepared = await service.prepare(input, [f]);
		expect(prepared.status).toBe("prepared");
		expect(service.listFiles(owner, prepared.id).items[0]).toMatchObject({
			expectedStateJson: symlink,
			desiredStateJson: { kind: "regular", blob: { sizeBytes: 0 } },
		});
	});
});

describe("complete preparation, bounds and failures", () => {
	test("missing expected rows never become prepared, including count tampering", async () => {
		const files = [file(0), file(1)];
		const input = plan(files);
		const result = service.begin(input);
		await service.appendFiles(owner, result.id, [files[0]]);
		await rejected(service.finalize(owner, result.id, input.manifestProof), "INCOMPLETE_SET");
		incomplete(result.id);
		db.update(revertOperations)
			.set({ fileCount: 1 })
			.where(eq(revertOperations.id, result.id))
			.run();
		await rejected(service.finalize(owner, result.id, input.manifestProof), "REQUEST_CONFLICT");
	});

	test("counts alone cannot prove source coverage, and a changed fixed ordered list cannot finalize", async () => {
		const files = [file()];
		const input = plan(files);
		const result = await appendAll(input, files);
		for (const patch of [
			{ computation: "partial" },
			{ selectorCoverage: "unknown" },
			{ historyCoverage: "unknown" },
			{ omittedFiles: 1 },
			{ unknownFiles: 1 },
		])
			await rejected(
				service.finalize(owner, result.id, {
					...input.manifestProof,
					...patch,
				} as RevertPlanManifestProof),
				"COVERAGE_UNPROVEN",
			);
		await rejected(
			service.finalize(owner, result.id, {
				...input.manifestProof,
				orderedFilesDigest: hash("sample-only"),
			}),
			"REQUEST_CONFLICT",
		);
		await expect(
			service.finalize(owner, result.id, undefined as unknown as RevertPlanManifestProof),
		).rejects.toBeDefined();
		incomplete(result.id);
	});

	test("same count but different file/sequence metadata cannot stand in for the published manifest", async () => {
		const files = [file(0), file(1)];
		const input = plan(files);
		const result = service.begin(input);
		await service.appendFiles(owner, result.id, [
			{ ...files[0], sequence: 1 },
			{ ...files[1], sequence: 0 },
		]);
		await rejected(service.finalize(owner, result.id, input.manifestProof), "INCOMPLETE_SET");
		incomplete(result.id);
	});

	test("1000 files cross all pages; preparation and read pagination never infer completeness from a prefix", async () => {
		const files = Array.from({ length: 1000 }, (_, i) => file(i, ABSENT, ABSENT));
		const input = plan(files);
		const result = await appendAll(input, files);
		incomplete(result.id);
		let ticks = 0;
		const heartbeat = setInterval(() => ticks++, 0);
		const prepared = await service.finalize(owner, result.id, input.manifestProof);
		clearInterval(heartbeat);
		expect(ticks).toBeGreaterThan(0);
		expect(sqlite.inTransaction).toBe(false);
		expect(prepared).toMatchObject({
			status: "prepared",
			coverageComplete: true,
			expectedFileCount: 1000,
			planHash: result.planHash,
		});
		let cursor: RevertPlanFileCursor | undefined;
		const seen = new Set<string>();
		do {
			const page = service.listFiles(owner, result.id, { cursor, limit: 37 });
			for (const item of page.items) {
				expect(seen.has(item.fileKey)).toBe(false);
				seen.add(item.fileKey);
			}
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
				FILE_CHANGE_LIMITS.summaryBytes,
			);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(seen.size).toBe(1000);
		expect(await service.finalize(owner, result.id, input.manifestProof)).toEqual(prepared);
		const pages = queries.filter(
			(query) => query.includes('from "revert_operation_files"') && query.includes("order by"),
		);
		expect(pages.length).toBeGreaterThan(32);
		expect(
			pages.every(
				(query) => query.includes("limit ?") && query.includes('"revert_operation_id" = ?'),
			),
		).toBe(true);
		expect(
			queries.some((query) => /count\(|sum\(|group by|input_json|content_json/i.test(query)),
		).toBe(false);
	}, 20_000);

	test("no last-page success if an earlier declared file is missing", async () => {
		const files = Array.from({ length: 70 }, (_, i) => file(i, ABSENT, ABSENT));
		const input = plan(files);
		const result = await appendAll(input, files);
		const first = service.listFiles(owner, result.id, { limit: 1 }).items[0];
		db.delete(revertOperationFiles).where(eq(revertOperationFiles.id, first.id)).run();
		await rejected(service.finalize(owner, result.id, input.manifestProof), "INCOMPLETE_SET");
		incomplete(result.id);
	});

	test("over 1000 files, metadata overflow and evidence overflow never yield a complete prefix", async () => {
		const f = file();
		const input = plan([f]);
		code(() => service.begin({ ...input, expectedFileCount: 1001 }), "BUDGET_OR_INPUT");
		await rejected(
			service.prepare(
				input,
				Array.from({ length: 1001 }, () => f),
			),
			"BUDGET_OR_INPUT",
		);
		const longPath = `/repo/${"x".repeat(2400)}`;
		const huge = {
			...f,
			identity: createFileChangeIdentity(scope, {
				deviceId: scope.deviceId,
				pathFlavor: scope.pathFlavor,
				objectRole: "referent",
				canonicalPath: longPath,
				lexicalPath: longPath,
			}),
		};
		const result = service.begin(input);
		await rejected(service.appendFiles(owner, result.id, [huge]), "METADATA_BUDGET");
		expect(storedFiles(result.id)).toHaveLength(0);
		code(
			() =>
				service.begin({
					...input,
					manifestProof: {
						...input.manifestProof,
						fileEvidenceBytes: FILE_CHANGE_LIMITS.operationEvidenceBytes,
					},
				}),
			"BUDGET_OR_INPUT",
		);
		incomplete(result.id);
	});

	test("cumulative raw budget is checked across append batches, not per file only", async () => {
		const bigRef = publish("budget-fixture");
		// Simulated already-published metadata: budget tests intentionally do not allocate 32MiB.
		bigRef.sizeBytes = FILE_CHANGE_LIMITS.blobBytes;
		db.update(fileChangeBlobs)
			.set({ sizeBytes: bigRef.sizeBytes })
			.where(eq(fileChangeBlobs.digest, bigRef.digest))
			.run();
		const big: FileChangeState = { kind: "regular", blob: bigRef, mode: 0o644 };
		const placeholder = Array.from({ length: 8 }, (_, i) => file(i, ABSENT, ABSENT));
		const input = plan(placeholder);
		const result = service.begin(input);
		for (let i = 0; i < 3; i++) await service.appendFiles(owner, result.id, [file(i, big, big)]);
		await rejected(service.appendFiles(owner, result.id, [file(3, big, big)]), "BUDGET_OR_INPUT");
		expect(storedFiles(result.id)).toHaveLength(3);
		await rejected(service.finalize(owner, result.id, input.manifestProof), "INCOMPLETE_SET");
		incomplete(result.id);
	});

	test("append DB failure is atomic and earlier pins survive; final DB failure stays incomplete", async () => {
		const files = [file(0), file(1), file(2)];
		const input = plan(files);
		const result = service.begin(input);
		await service.appendFiles(owner, result.id, [files[0]]);
		sqlite.exec(
			"CREATE TRIGGER fail_append BEFORE INSERT ON revert_operation_files WHEN NEW.sequence = 2 BEGIN SELECT RAISE(ABORT, 'append-fault'); END",
		);
		await expect(service.appendFiles(owner, result.id, files.slice(1))).rejects.toThrow(
			"append-fault",
		);
		expect(storedFiles(result.id)).toHaveLength(1);
		incomplete(result.id);
		sqlite.exec("DROP TRIGGER fail_append");
		await service.appendFiles(owner, result.id, files.slice(1));
		sqlite.exec(
			"CREATE TRIGGER fail_finalize BEFORE UPDATE OF status ON revert_operations WHEN NEW.status = 'prepared' BEGIN SELECT RAISE(ABORT, 'finalize-fault'); END",
		);
		await expect(service.finalize(owner, result.id, input.manifestProof)).rejects.toThrow(
			"finalize-fault",
		);
		incomplete(result.id);
		expect(storedFiles(result.id)).toHaveLength(3);
		for (const ref of [input.selector, input.plan, input.historyManifest])
			expect(() =>
				db.delete(fileChangeBlobs).where(eq(fileChangeBlobs.digest, ref.digest)).run(),
			).toThrow();
		sqlite.exec("DROP TRIGGER fail_finalize");
		expect((await service.finalize(owner, result.id, input.manifestProof)).status).toBe("prepared");
	});

	test("begin failure has no partially persisted journal", () => {
		const input = plan();
		sqlite.exec(
			"CREATE TRIGGER fail_begin BEFORE INSERT ON revert_operations BEGIN SELECT RAISE(ABORT, 'begin-fault'); END",
		);
		expect(() => service.begin(input)).toThrow("begin-fault");
		expect(service.listSummaries(owner).items).toHaveLength(0);
		expect(
			db
				.select({ digest: fileChangeBlobs.digest })
				.from(fileChangeBlobs)
				.where(eq(fileChangeBlobs.digest, input.plan.digest))
				.get(),
		).toBeDefined();
	});

	test("cancellation at a preparation yield preserves incomplete rows and refs", async () => {
		const files = Array.from({ length: 70 }, (_, i) => file(i, ABSENT, ABSENT));
		const input = plan(files);
		const result = await appendAll(input, files);
		const controller = new AbortController();
		const pending = service.finalize(owner, result.id, input.manifestProof, {
			signal: controller.signal,
		});
		expect(sqlite.inTransaction).toBe(false);
		controller.abort(new Error("user-cancelled"));
		await expect(pending).rejects.toThrow("user-cancelled");
		incomplete(result.id);
		expect(storedFiles(result.id)).toHaveLength(70);
		expect(() =>
			db.delete(fileChangeBlobs).where(eq(fileChangeBlobs.digest, input.plan.digest)).run(),
		).toThrow();
		expect((await service.finalize(owner, result.id, input.manifestProof)).coverageComplete).toBe(
			true,
		);
	});

	test("prepare convenience cancellation after first batch never loses its fixed declaration", async () => {
		const files = Array.from({ length: 70 }, (_, i) => file(i, ABSENT, ABSENT));
		const input = plan(files);
		const controller = new AbortController();
		const pending = service.prepare(input, files, { signal: controller.signal });
		controller.abort(new Error("stop-batches"));
		await expect(pending).rejects.toThrow("stop-batches");
		const result = service.listSummaries(owner).items[0];
		expect(result).toMatchObject({
			expectedFileCount: 70,
			status: "planned",
			coverageComplete: false,
		});
		expect(storedFiles(result.id)).toHaveLength(32);
	});

	test("concurrent append during finalization forces a restart without a prepared prefix", async () => {
		const files = Array.from({ length: 70 }, (_, i) => file(i, ABSENT, ABSENT));
		const input = plan(files);
		const result = await appendAll(input, files.slice(0, 65));
		const pending = service.finalize(owner, result.id, input.manifestProof);
		db.update(revertOperations)
			.set({ updatedAt: new Date(clock + 5000).toISOString() })
			.where(eq(revertOperations.id, result.id))
			.run();
		await rejected(pending, "CONCURRENT_CHANGE");
		incomplete(result.id);
	});

	test("early-page raw readiness is rechecked before final transition", async () => {
		const files = Array.from({ length: 70 }, (_, i) => file(i));
		const input = plan(files);
		const result = await appendAll(input, files);
		const first = service.listFiles(owner, result.id, { limit: 1 }).items[0];
		const pending = service.finalize(owner, result.id, input.manifestProof);
		const ref = first.expectedStateJson.kind === "regular" ? first.expectedStateJson.blob : null;
		expect(ref).not.toBeNull();
		db.update(fileChangeBlobs)
			.set({ status: "missing" })
			.where(eq(fileChangeBlobs.digest, ref?.digest ?? ""))
			.run();
		await rejected(pending, "BLOB_NOT_READY");
		incomplete(result.id);
	});

	test("unknown status, duplicate sequence, phase corruption and missing reverse pins block finalization", async () => {
		const changes = [
			{ status: "unknown" as const },
			{ applyMutationId: hash("toolUseId-only") },
			{ compensateMutationId: hash("wrong-phase") },
			{ beforeBlobDigest: null },
			{ compensationAfterStateJson: { kind: "absent" } as FileChangeState },
			{ expectedStateJson: { kind: "unknown", reason: "missing_before" } as FileChangeState },
			{ sequence: 1 },
		];
		for (const patch of changes) {
			const files = [file(0), file(1)];
			const input = plan(files);
			const result = await appendAll(input, files);
			const f = storedFiles(result.id).find((item) => item.sequence === 0);
			db.update(revertOperationFiles)
				.set(patch)
				.where(eq(revertOperationFiles.id, f?.id ?? ""))
				.run();
			await expect(service.finalize(owner, result.id, input.manifestProof)).rejects.toBeDefined();
			incomplete(result.id);
		}
	});
});

describe("expiry, unrevert and metadata-only reads", () => {
	test("planned/prepared expiry refuses more preparation and never deletes unsettled journals", async () => {
		const f = file();
		const plannedInput = plan([f]);
		const planned = service.begin(plannedInput);
		const preparedInput = plan([f]);
		const prepared = await service.prepare(preparedInput, [f]);
		clock += FILE_CHANGE_LIMITS.planLifetimeMs;
		await rejected(service.appendFiles(owner, planned.id, [f]), "EXPIRED");
		await rejected(service.finalize(owner, planned.id, plannedInput.manifestProof), "EXPIRED");
		await rejected(service.finalize(owner, prepared.id, preparedInput.manifestProof), "EXPIRED");
		expect(service.getSummary(owner, planned.id)).toMatchObject({
			expired: true,
			status: "planned",
			coverageComplete: false,
		});
		expect(service.getSummary(owner, prepared.id)).toMatchObject({
			expired: true,
			status: "prepared",
		});
		expect(service.begin(plannedInput).id).toBe(planned.id);
		for (const name of [
			"apply",
			"markApplying",
			"recordApplied",
			"commit",
			"recordCommitted",
			"delete",
			"unrevert",
			"readBlob",
		])
			expect(name in service).toBe(false);
		for (const input of [plannedInput, preparedInput])
			expect(() =>
				db.delete(fileChangeBlobs).where(eq(fileChangeBlobs.digest, input.plan.digest)).run(),
			).toThrow();
	});

	test("expiry during a finalize page yield cannot slip through", async () => {
		const files = Array.from({ length: 40 }, (_, i) => file(i, ABSENT, ABSENT));
		const input = plan(files);
		const result = await appendAll(input, files);
		const pending = service.finalize(owner, result.id, input.manifestProof);
		clock += FILE_CHANGE_LIMITS.planLifetimeMs;
		await rejected(pending, "EXPIRED");
		incomplete(result.id);
	});

	test("unrevert requires a committed v2 parent in exactly the same owner and context", async () => {
		const files = [file()];
		const parentInput = plan(files);
		const parent = service.begin(parentInput);
		const childInput = () => plan(files, { kind: "unrevert", parentRevertId: parent.id });
		code(() => service.begin(childInput()), "PARENT_UNAVAILABLE");
		await service.appendFiles(owner, parent.id, files);
		await service.finalize(owner, parent.id, parentInput.manifestProof);
		code(() => service.begin(childInput()), "PARENT_UNAVAILABLE");
		// ONLY a fixture stands in for the future executor; this service has no commit API.
		db.update(revertOperations)
			.set({ status: "committed" })
			.where(eq(revertOperations.id, parent.id))
			.run();
		const child = service.begin(childInput());
		expect(child.status).toBe("planned");
		for (const patch of [
			{ subjectKey: "human:bob" },
			{ narratorId: "narrator-b" },
			{ projectId: "project-b" },
		])
			code(
				() => service.begin(plan(files, { ...patch, kind: "unrevert", parentRevertId: parent.id })),
				"PARENT_UNAVAILABLE",
			);
		db.update(revertOperations)
			.set({ planBlobDigest: null })
			.where(eq(revertOperations.id, parent.id))
			.run();
		code(() => service.begin(childInput()), "PARENT_UNAVAILABLE");
	});

	test("parent journal must remain committed through the final transition", async () => {
		const files = [file()];
		const parent = await service.prepare(plan(files), files);
		db.update(revertOperations)
			.set({ status: "committed" })
			.where(eq(revertOperations.id, parent.id))
			.run();
		const input = plan(files, { kind: "unrevert", parentRevertId: parent.id });
		const child = await appendAll(input, files);
		db.update(revertOperations)
			.set({ status: "recovery_required" })
			.where(eq(revertOperations.id, parent.id))
			.run();
		await rejected(service.finalize(owner, child.id, input.manifestProof), "PARENT_UNAVAILABLE");
		incomplete(child.id);
	});

	test("read-only file keyset pages do not lose equal sequence values", async () => {
		const files = Array.from({ length: 12 }, (_, i) => file(i, ABSENT, ABSENT));
		const result = await appendAll(plan(files), files);
		db.update(revertOperationFiles)
			.set({ sequence: 0 })
			.where(eq(revertOperationFiles.revertOperationId, result.id))
			.run();
		let cursor: RevertPlanFileCursor | undefined;
		const ids: string[] = [];
		do {
			const page = service.listFiles(owner, result.id, { cursor, limit: 3 });
			ids.push(...page.items.map((item) => item.id));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(new Set(ids).size).toBe(12);
		expect(ids).toHaveLength(12);
		incomplete(result.id);
	});

	test("summary keyset pagination preserves equal creation timestamps and hides other contexts", () => {
		for (let i = 0; i < 10; i++) service.begin(plan([], { idempotencyKey: `same-time-${i}` }));
		service.begin(plan([], { idempotencyKey: "same-time-actor", subjectKey: "human:bob" }));
		service.begin(plan([], { idempotencyKey: "same-time-context", projectId: "project-b" }));
		let cursor: RevertPlanSummaryCursor | undefined;
		const ids = new Set<string>();
		do {
			const page = service.listSummaries(owner, { cursor, limit: 3 });
			for (const item of page.items) {
				expect(ids.has(item.id)).toBe(false);
				ids.add(item.id);
			}
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(ids.size).toBe(10);
		code(() => service.listSummaries(owner, { limit: 101 }), "BUDGET_OR_INPUT");
	});

	test("summary byte budget limits output without losing the unreturned suffix", async () => {
		const files = Array.from({ length: 80 }, (_, i) => {
			const path = `/repo/${"x".repeat(1900)}-${i}`;
			return {
				sequence: i,
				identity: createFileChangeIdentity(scope, {
					deviceId: scope.deviceId,
					pathFlavor: scope.pathFlavor,
					objectRole: "referent",
					canonicalPath: path,
					lexicalPath: path,
				}),
				expected: ABSENT,
				desired: ABSENT,
			};
		});
		const result = await appendAll(plan(files), files);
		let cursor: RevertPlanFileCursor | undefined;
		const ids = new Set<string>();
		const first = service.listFiles(owner, result.id, { limit: 100 });
		expect(first.items.length).toBeLessThan(80);
		do {
			const page = service.listFiles(owner, result.id, { cursor, limit: 100 });
			expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
				FILE_CHANGE_LIMITS.summaryBytes,
			);
			for (const item of page.items) ids.add(item.id);
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(ids.size).toBe(80);
	});

	test("zero-file plan requires the same full proof but never modifies history", async () => {
		const input = plan([], { kind: "history_delete" });
		const result = await service.prepare(input, []);
		expect(result).toMatchObject({
			status: "prepared",
			coverageComplete: true,
			expectedFileCount: 0,
		});
		expect(service.listFiles(owner, result.id)).toEqual({
			items: [],
			hasMore: false,
			nextCursor: null,
		});
		expect(published.get(input.plan.digest)).toContain("completeOrderedFiles");
		expect(record(result.id)?.historyManifestBlobDigest).toBe(input.historyManifest.digest);
		expect(
			sqlite.query<{ id: string }, []>("SELECT id FROM narrators ORDER BY id").all(),
		).toHaveLength(2);
	});
});
