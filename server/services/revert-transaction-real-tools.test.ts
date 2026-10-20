/**
 * Real tools -> original prepared manifests -> local transaction.
 * Shared fixture: ./__tests__/revert-transaction.fixture.ts (importing it registers the hooks).
 */
import { Database } from "bun:sqlite";
import { describe, expect, spyOn } from "bun:test";
import { renameSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import { and, eq } from "drizzle-orm";
import iconv from "iconv-lite";
import * as schema from "../db/schema";
import { generateId } from "../lib/id";
import { settings } from "../lib/settings";
import {
	access,
	allowedFiles,
	checkNarrator,
	coordinatorState,
	database,
	db,
	edit,
	execution,
	failHistoryCommit,
	fixedEvidenceBytes,
	hash,
	history,
	hold,
	journalFiles,
	lifetime,
	makeFixtureRuntime,
	makeFixtureTransaction,
	manifestRequest,
	namespace,
	operation,
	options,
	prepare,
	principal,
	restores,
	root,
	runtime,
	service,
	setFileHook,
	setReopenedDatabase,
	setService,
	snapshotConsentRequired,
	sqlite,
	test,
	tool,
	twoFiles,
	workspace,
	write,
} from "./__tests__/revert-transaction.fixture";
import { fileChangeLocalIo } from "./file-change-local-io";
import * as localRestore from "./file-change-local-restore";
import { resetFileChangeNamespace } from "./file-change-namespace-reset";
import { FileChangeReversalCalculator } from "./file-change-reversal";
import { localFileChangeRuntimeBinding } from "./file-change-runtime";
import { RevertHistoryCommitService } from "./revert-history-commit";
import { RevertMutationJournal } from "./revert-mutation-journal";
import type { ValidatedTransactionManifest } from "./revert-transaction-manifest-worker";
import type { RevertTransactionService } from "./revert-transaction-service";
import { runRevertManifestWorker } from "./revert-transaction-worker";

// Await outside Bun's native async matcher so worker messages can be dispatched.
async function rejectionOf(promise: Promise<unknown>): Promise<() => void> {
	try {
		await promise;
		return () => {};
	} catch (error) {
		return () => {
			throw error;
		};
	}
}

import { createWorkspaceWriteCoordinatorState } from "./workspace-write-coordinator";

describe("real tools -> original prepared manifests -> local transaction", () => {
	test("snapshot conflict recovery requires explicit confirmation before journal or target mutation", async () => {
		const path = join(workspace, "snapshot-conflict.txt");
		await fs.writeFile(path, "baseline\r\n", { mode: 0o751 });
		const originalMode = (await fs.stat(path)).mode & 0o7777;
		await write(path, "selected one\n");
		await fs.writeFile(path, "human between selections\n");
		await write(path, "selected two\n");
		await fs.writeFile(path, "human after selections\n");
		await fs.chmod(path, 0o600);
		const selectiveFailure = await prepare({ kind: "revert", uiAction: "revert_files" }).catch(
			(error: unknown) => error,
		);
		expect(selectiveFailure).toMatchObject({ code: "REVERT_PLANNER_REVERSAL_REFUSED" });
		const plan = await prepare({
			kind: "revert",
			uiAction: "revert_files",
			recoveryMode: "snapshot",
		});
		const request = {
			principal,
			narratorId: "narrator",
			planId: plan.id,
			planHash: plan.planHash ?? "",
			action: "revert_files" as const,
		};
		const before = history();
		const raw = await manifestRequest(plan);
		await snapshotConsentRequired(runRevertManifestWorker(raw, AbortSignal.timeout(10_000)));
		const validated = await runRevertManifestWorker<ValidatedTransactionManifest>(
			{ ...raw, acceptSnapshotRestore: true },
			AbortSignal.timeout(10_000),
		);
		expect(journalFiles(plan)[0].desiredStateJson).toEqual(validated.files[0].desired);
		await snapshotConsentRequired(service.validateHttpAction(request));
		await snapshotConsentRequired(service.execute(request).result);
		await snapshotConsentRequired(execution(plan).result);
		expect(operation(plan)?.status).toBe("prepared");
		expect(journalFiles(plan)[0].status).toBe("prepared");
		expect(await fs.readFile(path, "utf8")).toBe("human after selections\n");
		expect(history()).toBe(before);
		await service.validateHttpAction({ ...request, acceptSnapshotRestore: true });
		expect((await service.execute({ ...request, acceptSnapshotRestore: true }).result).status).toBe(
			"committed",
		);
		expect(await fs.readFile(path, "utf8")).toBe("baseline\r\n");
		expect((await fs.stat(path)).mode & 0o7777).toBe(originalMode);
		expect(history()).toBe(before);
		await snapshotConsentRequired(service.execute(request).result);
		await snapshotConsentRequired(execution(plan).result);
		expect((await service.execute({ ...request, acceptSnapshotRestore: true }).result).status).toBe(
			"committed",
		);
	});

	test.each([
		"wrong_snapshot_target",
		"wrong_snapshot_method",
		"snapshot_method_on_selective",
	] as const)("full worker refuses producer's committed %s manifest", async (fault) => {
		const path = join(workspace, "invalid-snapshot-manifest.txt");
		await fs.writeFile(path, "earliest selected before\n");
		await write(path, "selected one\n");
		await write(path, "selected two\n");
		const original = FileChangeReversalCalculator.prototype.calculate;
		const broken = spyOn(FileChangeReversalCalculator.prototype, "calculate").mockImplementation(
			async function (this: FileChangeReversalCalculator, input) {
				const result = await original.call(this, input);
				if (!result.ok) return result;
				if (fault === "wrong_snapshot_target") {
					const latest = [...input.effects]
						.sort((a, b) => b.scopeRevision - a.scopeRevision)
						.find((effect) => effect.outcome === "changed");
					if (!latest || latest.before.kind === "unknown" || latest.before.kind === "symlink")
						throw new Error("Expected real selected before");
					return { ...result, desired: latest.before };
				}
				return {
					...result,
					steps: result.steps.map((step) => ({
						...step,
						method:
							fault === "wrong_snapshot_method"
								? ("restore_before" as const)
								: ("restore_snapshot" as const),
					})),
				};
			},
		);
		restores.push(() => broken.mockRestore());
		const plan = await prepare({
			kind: "revert",
			uiAction: "revert_files",
			...(fault === "snapshot_method_on_selective" ? {} : { recoveryMode: "snapshot" as const }),
		});
		broken.mockRestore();
		const request = await manifestRequest(plan);
		const code = fault === "wrong_snapshot_target" ? "SNAPSHOT_TARGET_CONFLICT" : "STEP_METHOD";
		expect(
			await rejectionOf(
				runRevertManifestWorker(
					{ ...request, acceptSnapshotRestore: true },
					AbortSignal.timeout(10_000),
				),
			),
		).toThrow(code);
		expect(
			await rejectionOf(
				service.execute({
					principal,
					narratorId: "narrator",
					planId: plan.id,
					planHash: plan.planHash ?? "",
					action: "revert_files",
					acceptSnapshotRestore: true,
				}).result,
			),
		).toThrow(code);
		expect(operation(plan)?.status).toBe("prepared");
		expect(await fs.readFile(path, "utf8")).toBe("selected two\n");
	});

	test("snapshot never restores a measured no-change effect's unrelated baseline", async () => {
		const path = join(workspace, "snapshot-no-change.txt");
		await fs.writeFile(path, "same\n");
		await write(path, "same\n");
		await fs.writeFile(path, "human change after no-op\n");
		const before = history();
		const plan = await prepare({
			kind: "revert",
			uiAction: "revert_files",
			recoveryMode: "snapshot",
		});
		const raw = await manifestRequest(plan);
		const manifest = await runRevertManifestWorker<ValidatedTransactionManifest>(
			{ ...raw, acceptSnapshotRestore: true },
			AbortSignal.timeout(10_000),
		);
		expect(manifest.files[0].desired).toEqual(manifest.files[0].expected);
		expect(
			(
				await service.execute({
					principal,
					narratorId: "narrator",
					planId: plan.id,
					planHash: plan.planHash ?? "",
					action: "revert_files",
					acceptSnapshotRestore: true,
				}).result
			).status,
		).toBe("committed");
		expect(await fs.readFile(path, "utf8")).toBe("human change after no-op\n");
		expect(operation(plan)?.appliedFileCount).toBe(0);
		expect(history()).toBe(before);
	});

	test("snapshot confirmation does not permit new content after preview", async () => {
		const path = join(workspace, "snapshot-stale.txt");
		await fs.writeFile(path, "baseline\n");
		await write(path, "selected\n");
		await fs.writeFile(path, "conflicting before preview\n");
		const plan = await prepare({
			kind: "revert",
			uiAction: "revert_files",
			recoveryMode: "snapshot",
		});
		await fs.writeFile(path, "new content after preview\n");
		const before = history();
		expect(
			await rejectionOf(
				service.execute({
					principal,
					narratorId: "narrator",
					planId: plan.id,
					planHash: plan.planHash ?? "",
					action: "revert_files",
					acceptSnapshotRestore: true,
				}).result,
			),
		).toThrow();
		expect(await fs.readFile(path, "utf8")).toBe("new content after preview\n");
		expect(history()).toBe(before);
		expect(operation(plan)?.status).toBe("prepared");
	});

	test("confirmation cannot flip selective plan into snapshot and client mode/false confirmation are refused", async () => {
		const path = join(workspace, "selective-frozen.txt");
		const base = "A0\n1\n2\n3\n4\nH0\n";
		await fs.writeFile(path, base);
		await write(path, base.replace("A0", "A1"));
		await fs.writeFile(path, base.replace("A0", "A1").replace("H0", "H1"));
		const plan = await prepare({ kind: "revert", uiAction: "revert_files" });
		const request = {
			principal,
			narratorId: "narrator",
			planId: plan.id,
			planHash: plan.planHash ?? "",
			action: "revert_files" as const,
		};
		expect(() =>
			service.execute({
				...request,
				recoveryMode: "snapshot",
				acceptSnapshotRestore: true,
			} as Parameters<RevertTransactionService["execute"]>[0]),
		).toThrow("INVALID_REQUEST");
		expect(() =>
			service.execute({ ...request, acceptSnapshotRestore: false } as unknown as Parameters<
				RevertTransactionService["execute"]
			>[0]),
		).toThrow("INVALID_REQUEST");
		expect((await service.execute({ ...request, acceptSnapshotRestore: true }).result).status).toBe(
			"committed",
		);
		expect(await fs.readFile(path, "utf8")).toBe(base.replace("H0", "H1"));
	});
	test("A / authenticated editor / B: reverse A only preserves human and unselected B hunks; file-only history stays", async () => {
		const path = join(workspace, "hunks.txt");
		const original = "A0\n1\n2\n3\n4\nH0\n5\n6\n7\n8\nB0\n";
		await fs.writeFile(path, original);
		const first = await write(path, original.replace("A0", "A1"));
		await runtime.executeEditor({
			requestId: generateId(),
			userId: "alice",
			narratorId: "narrator",
			projectId: "project",
			cwd: workspace,
			lexicalPath: path,
			canonicalPath: path,
			signal: new AbortController().signal,
			input: { content: "human hunk" },
			authorize: async () => {
				checkNarrator(principal, {
					id: "narrator",
					ownerUserId: "alice",
					visibility: "private",
					writeAudience: "owner",
					type: "primary",
					aclRootNarratorId: null,
					chapterId: null,
					contextProjectId: "project",
				});
			},
			construct: (before) => ({
				nextBytes: Buffer.from(
					Buffer.from(before.bytes ?? [])
						.toString()
						.replace("H0", "H1"),
				),
				result: "saved",
				lineStats: null,
			}),
		});
		await edit(path, "B0", "B1");
		const before = history();
		const plan = await prepare({
			kind: "revert",
			selector: { kind: "messages", messageIds: [first.messageId] },
		});
		const result = await execution(plan).result;
		expect(result.status).toBe("committed");
		expect(await fs.readFile(path, "utf8")).toBe(original.replace("H0", "H1").replace("B0", "B1"));
		expect(history()).toBe(before);
		expect(journalFiles(plan)[0].receiptJson).toMatchObject({
			apply: { receipt: { confirmed: true, outcome: "applied" } },
			compensate: null,
		});
	});
	test("GBK/CRLF raw bytes and mode survive changed encoding settings; new file deletion is real", async () => {
		const path = join(workspace, "legacy.txt");
		const created = join(workspace, "created.txt");
		const original = iconv.encode("原始内容\r\n保留\r\n", "gbk");
		await fs.writeFile(path, original, { mode: 0o751 });
		const originalMode = (await fs.stat(path)).mode & 0o7777;
		settings.agent.legacyEncoding = true;
		await write(path, "修改内容\n保留\n");
		await write(created, "temporary\n");
		settings.agent.legacyEncoding = false;
		const plan = await prepare();
		expect((await execution(plan).result).status).toBe("committed");
		expect((await fs.readFile(path)).equals(original)).toBe(true);
		expect((await fs.stat(path)).mode & 0o7777).toBe(originalMode);
		expect(await fs.exists(created)).toBe(false);
		expect(db.select().from(schema.narratorMessageRefs).limit(100).all()).toHaveLength(0);
	});
	test("multiple exact workspace scopes restore in one history commit", async () => {
		const other = join(root, "other-workspace");
		await fs.mkdir(other);
		for (const cwd of [workspace, other]) {
			const path = join(cwd, "file.txt");
			await fs.writeFile(path, "before");
			await write(path, "after", cwd);
		}
		const plan = await prepare();
		expect(new Set(journalFiles(plan).map((file) => file.scopeId)).size).toBe(2);
		expect((await execution(plan).result).status).toBe("committed");
		for (const cwd of [workspace, other])
			expect(await fs.readFile(join(cwd, "file.txt"), "utf8")).toBe("before");
		expect(
			db.select().from(schema.narrators).where(eq(schema.narrators.id, "narrator")).get()
				?.messageVersion,
		).toBe(8);
	});
	test.each([
		"committed",
		"compensated",
	] as const)("final scope-release SQL failure preserves %s outcome and explicitly reports coordination recovery", async (terminal) => {
		const other = join(root, "z-last-workspace");
		await fs.mkdir(other);
		for (const cwd of [workspace, other]) {
			const path = join(cwd, "file.txt");
			await fs.writeFile(path, "before");
			await write(path, "after", cwd);
		}
		const plan = await prepare();
		const previousHistory = history();
		const targets = (
			await Promise.all(
				journalFiles(plan).map(async (file) => {
					const scope = await runtime.evidence.getScope(file.scopeId);
					if (!scope) throw new Error("Missing real scope");
					return scope;
				}),
			)
		).sort((left, right) => left.canonicalRoot.localeCompare(right.canonicalRoot));
		expect(targets).toHaveLength(2);
		if (terminal === "compensated") failHistoryCommit();
		// The second clear fails in the coordinator's real group transaction. The
		// first scope's tentative release must roll back along with the second.
		sqlite.exec(`CREATE TRIGGER reject_transaction_scope_release BEFORE UPDATE OF active_lease_id ON file_change_scopes
			WHEN NEW.id = '${targets[1].id}' AND OLD.active_lease_id IS NOT NULL AND NEW.active_lease_id IS NULL
			BEGIN SELECT RAISE(ABORT, 'final-scope-release-failed'); END;`);
		const attempt = execution(plan);
		const result = await attempt.result;
		expect(result).toMatchObject({
			status: terminal,
			journalStatus: terminal,
			settling: false,
			reason: "COORDINATOR_RECOVERY_REQUIRED",
		});
		expect(await attempt.whenSettled).toEqual(result);
		expect(operation(plan)?.status).toBe(terminal);
		for (const cwd of [workspace, other])
			expect(await fs.readFile(join(cwd, "file.txt"), "utf8")).toBe(
				terminal === "committed" ? "before" : "after",
			);
		const terminalHistory = history();
		if (terminal === "compensated") expect(terminalHistory).toBe(previousHistory);
		else
			expect(
				db
					.select()
					.from(schema.narratorMessageRefs)
					.where(eq(schema.narratorMessageRefs.narratorId, "narrator"))
					.limit(100)
					.all(),
			).toHaveLength(0);
		const terminalFiles = journalFiles(plan);
		for (const file of terminalFiles) {
			expect(file.status).toBe(terminal === "committed" ? "verified" : "compensated");
			if (terminal === "committed")
				expect((file.receiptJson as { compensate: unknown }).compensate).toBeNull();
		}
		expect(coordinatorState.leases.size).toBe(2);
		const retained = await Promise.all(
			targets.map(async (scope) => {
				const live = await runtime.evidence.getScope(scope.id);
				expect(live?.activeLeaseId).toBeString();
				expect(live?.activeMutationCount).toBe(0);
				expect(runtime.coordinator.capture(scope).active).toMatchObject({
					rollbacks: 1,
					retainedRecoveryHolds: 1,
				});
				return live;
			}),
		);
		const binding = localFileChangeRuntimeBinding("local");
		if (!binding) throw new Error("Missing local runtime");
		for (const scope of targets)
			expect(
				await rejectionOf(
					runtime.coordinator.withWrite({ scope, runtime: binding, waitTimeoutMs: 0 }, () => {}),
				),
			).toThrow("busy");
		// A repeated request uses the terminal journal, never compensates committed
		// files or repeats any apply while coordinator recovery remains outstanding.
		const path = join(workspace, "file.txt");
		await fs.writeFile(path, "external after terminal result");
		expect((await execution(plan).result).status).toBe(terminal);
		expect(await fs.readFile(path, "utf8")).toBe("external after terminal result");
		expect(history()).toBe(terminalHistory);
		expect(journalFiles(plan)).toEqual(terminalFiles);
		expect(coordinatorState.leases.size).toBe(2);
		const token = [...coordinatorState.leases.keys()][0];
		if (!token) throw new Error("Missing retained actual lease capability");
		sqlite.exec("DROP TRIGGER reject_transaction_scope_release");
		runtime.coordinator.retryUncertainPersistence(token);
		// Existing explicit retry only persists recovery/quarantine and drops the
		// in-memory hold. It is NOT authority to clear a durable crash barrier.
		expect(coordinatorState.leases.size).toBe(0);
		for (const [index, scope] of targets.entries()) {
			const live = await runtime.evidence.getScope(scope.id);
			expect(live).toMatchObject({
				status: "active",
				activeLeaseId: null,
				activeMutationCount: 0,
			});
			const leaseId = retained[index]?.activeLeaseId;
			if (!leaseId) throw new Error("Missing retained durable lease");
			const lease = db
				.select()
				.from(schema.workspaceWriteLeases)
				.where(eq(schema.workspaceWriteLeases.leaseId, leaseId))
				.get();
			expect(lease).toMatchObject({
				leaseId,
				scopeId: scope.id,
				status: "quarantined",
				rangesJson: {
					version: 1,
					ranges: terminalFiles
						.filter((file) => file.scopeId === scope.id)
						.map((file) => ({ kind: "file", canonicalPath: file.identityJson.canonicalPath })),
				},
				mutationManifestJson: {
					version: 1,
					mutations: terminalFiles
						.filter((file) => file.scopeId === scope.id)
						.flatMap((file) =>
							(terminal === "committed"
								? [file.applyMutationId]
								: [file.applyMutationId, file.compensateMutationId]
							).map((mutationId) => ({ mutationId, outcome: "applied" })),
						),
				},
			});
			expect(lease?.executionEndedAt).toBeString();
			expect(runtime.coordinator.capture(scope)).toMatchObject({
				status: "needs_verification",
				quarantinedLeaseCount: 1,
				active: { retainedRecoveryHolds: 0 },
			});
			// Only the actual rollback target remains quarantined.
			expect(
				await rejectionOf(
					runtime.coordinator.withWrite(
						{
							scope,
							runtime: binding,
							ranges: [{ kind: "file", canonicalPath: join(scope.canonicalRoot, "file.txt") }],
						},
						() => {
							throw new Error("Quarantined target must not admit writes");
						},
					),
				),
			).toThrow("verification");
			await runtime.coordinator.withWrite(
				{
					scope,
					runtime: binding,
					ranges: [
						{ kind: "file", canonicalPath: join(scope.canonicalRoot, "untouched-sibling.txt") },
					],
				},
				() => {},
			);
		}
		expect(history()).toBe(terminalHistory);
		expect(journalFiles(plan)).toEqual(terminalFiles);
	});
	test("shared partial block rollback COWs once and atomically removes later messages", async () => {
		const path = join(workspace, "cow.txt");
		await fs.writeFile(path, "A0\n1\n2\n3\nB0\n");
		const first = await edit(path, "A0", "A1");
		await edit(path, "B0", "B1");
		db.insert(schema.narratorMessageRefs)
			.values({ id: generateId(), narratorId: "fork", messageId: first.messageId, seq: 1 })
			.run();
		const originalMessage = db
			.select()
			.from(schema.narratorMessages)
			.where(eq(schema.narratorMessages.id, first.messageId))
			.get();
		const plan = await prepare({
			kind: "rollback_to_block",
			selector: { kind: "after_block", messageId: first.messageId, keepThroughBlockIndex: 0 },
		});
		expect((await execution(plan).result).status).toBe("committed");
		expect(await fs.readFile(path, "utf8")).toBe("A0\n1\n2\n3\nB0\n");
		const refs = db
			.select()
			.from(schema.narratorMessageRefs)
			.where(eq(schema.narratorMessageRefs.narratorId, "narrator"))
			.limit(100)
			.all();
		expect(refs).toHaveLength(1);
		expect(refs[0].messageId).not.toBe(first.messageId);
		expect(
			db
				.select()
				.from(schema.narratorMessages)
				.where(eq(schema.narratorMessages.id, refs[0].messageId))
				.get()?.contentJson,
		).toEqual([{ type: "text", text: "retain" }]);
		expect(
			db
				.select()
				.from(schema.narratorMessages)
				.where(eq(schema.narratorMessages.id, first.messageId))
				.get(),
		).toEqual(originalMessage);
		expect(
			db.select().from(schema.narrators).where(eq(schema.narrators.id, "narrator")).get()
				?.messageVersion,
		).toBe(8);
	});
	test("committed duplicate/response loss never rewrites a subsequent human edit", async () => {
		const { a, plan } = await twoFiles();
		const commit = RevertMutationJournal.prototype.commit;
		const fault = spyOn(RevertMutationJournal.prototype, "commit").mockImplementation(function (
			this: RevertMutationJournal,
			ctx,
			history,
		) {
			commit.call(this, ctx, history);
			throw new Error("response lost AFTER durable commit");
		});
		restores.push(() => fault.mockRestore());
		expect((await execution(plan).result).status).toBe("committed");
		fault.mockRestore();
		await fs.writeFile(a, "human after commit");
		const before = history();
		expect((await execution(plan).result).status).toBe("committed");
		expect(await fs.readFile(a, "utf8")).toBe("human after commit");
		expect(history()).toBe(before);
	});
	test("last file full preflight rejects all target writes and leaves prepared journal/history", async () => {
		const { a, b, plan } = await twoFiles();
		await fs.chmod(b, 0o444);
		const before = history();
		expect(await rejectionOf(execution(plan).result)).toThrow("FILE_PREFLIGHT");
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(await fs.readFile(b, "utf8")).toBe("changed");
		expect(history()).toBe(before);
		expect(operation(plan)?.status).toBe("prepared");
		expect(journalFiles(plan).every((row) => row.receiptJson === null)).toBe(true);
	});
	test("second file dispatch authorization rejection compensates earlier applied file", async () => {
		const { a, b, plan } = await twoFiles();
		const before = history();
		setFileHook((path) => {
			if (
				path === b &&
				operation(plan)?.status === "applying" &&
				journalFiles(plan)[1].status === "applying"
			)
				throw new Error("revoke before second dispatch");
		});
		expect((await execution(plan).result).status).toBe("compensated");
		for (const path of [a, b]) expect(await fs.readFile(path, "utf8")).toBe("changed");
		expect(history()).toBe(before);
		const rows = journalFiles(plan);
		expect(rows[0].compensateMutationId).not.toBe(rows[0].applyMutationId);
		expect(rows[0].receiptJson).toMatchObject({
			apply: { receipt: { outcome: "applied" } },
			compensate: { receipt: { outcome: "applied" } },
		});
		expect(rows[1].receiptJson).toMatchObject({
			apply: { receipt: { confirmed: true, outcome: "not_applied" } },
			compensate: null,
		});
	});
	test("real SQL commit abort rolls back COW/history and compensates files in reverse", async () => {
		const { a, b, plan } = await twoFiles();
		const before = history();
		failHistoryCommit();
		expect((await execution(plan).result).status).toBe("compensated");
		for (const path of [a, b]) expect(await fs.readFile(path, "utf8")).toBe("changed");
		expect(history()).toBe(before);
		expect(journalFiles(plan).every((row) => row.status === "compensated")).toBe(true);
	});
	test.each([
		false,
		true,
	])("compensation refuses third-party %s replacement, pins separate third-state observation", async (sameBytes) => {
		const { a, b, plan } = await twoFiles();
		const before = history();
		failHistoryCommit();
		const begin = RevertMutationJournal.prototype.beginCompensation;
		const change = spyOn(RevertMutationJournal.prototype, "beginCompensation").mockImplementation(
			function (this: RevertMutationJournal, ctx) {
				if (sameBytes) renameSync(a, `${a}.old`);
				writeFileSync(a, sameBytes ? "original" : "third-party");
				return begin.call(this, ctx);
			},
		);
		restores.push(() => change.mockRestore());
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(await fs.readFile(a, "utf8")).toBe(sameBytes ? "original" : "third-party");
		expect(history()).toBe(before);
		const row = journalFiles(plan)[0];
		expect(row.observedAfterBlobDigest).toBe(hash("original"));
		expect(row.compensationAfterBlobDigest).toBe(hash(sameBytes ? "original" : "third-party"));
		const scope = await runtime.evidence.getScope(row.scopeId);
		if (!scope) throw new Error("Missing rollback scope");
		expect(scope).toMatchObject({
			status: "active",
			activeLeaseId: null,
			activeMutationCount: 0,
		});
		const leases = db
			.select()
			.from(schema.workspaceWriteLeases)
			.where(
				and(
					eq(schema.workspaceWriteLeases.scopeId, row.scopeId),
					eq(schema.workspaceWriteLeases.status, "quarantined"),
				),
			)
			.limit(10)
			.all();
		expect(leases).toHaveLength(1);
		expect(leases[0]).toMatchObject({
			scopeId: row.scopeId,
			status: "quarantined",
			rangesJson: {
				version: 1,
				ranges: journalFiles(plan)
					.filter((file) => file.scopeId === scope.id)
					.map((file) => ({ kind: "file", canonicalPath: file.identityJson.canonicalPath })),
			},
			mutationManifestJson: {
				version: 1,
				mutations: expect.arrayContaining([
					{ mutationId: row.applyMutationId, outcome: "applied" },
					{ mutationId: row.compensateMutationId, outcome: "not_applied" },
				]),
			},
		});
		expect(leases[0].executionEndedAt).toBeString();
		expect(runtime.coordinator.capture(scope)).toMatchObject({
			status: "needs_verification",
			quarantinedLeaseCount: 1,
			active: { retainedRecoveryHolds: 0 },
		});
		const binding = localFileChangeRuntimeBinding("local");
		if (!binding) throw new Error("Missing local runtime");
		for (const path of [a, b])
			expect(
				await rejectionOf(
					runtime.coordinator.withWrite(
						{ scope, runtime: binding, ranges: [{ kind: "file", canonicalPath: path }] },
						() => {
							throw new Error("Quarantined subtree must not admit writes");
						},
					),
				),
			).toThrow("verification");
		// A failed two-file recovery does not quarantine the entire repository.
		await runtime.coordinator.withWrite(
			{
				scope,
				runtime: binding,
				ranges: [
					{ kind: "file", canonicalPath: join(scope.canonicalRoot, "untouched-sibling.txt") },
				],
			},
			() => {},
		);
		expect(await fs.readFile(a, "utf8")).toBe(sameBytes ? "original" : "third-party");
		expect(history()).toBe(before);
	});
	test("receipt SQL fault retains applying intent/quarantine; reopened DB never repeats IO", async () => {
		const owner = lifetime;
		if (!owner) throw new Error("Missing reopened transaction fixture owner");
		const { a, plan } = await twoFiles();
		const before = history();
		sqlite.exec(
			"CREATE TRIGGER reject_receipt BEFORE UPDATE OF observed_after_state_json ON revert_operation_files WHEN NEW.observed_after_state_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END",
		);
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(history()).toBe(before);
		expect(journalFiles(plan)[0].receiptJson).toMatchObject({ apply: { receipt: null } });
		await fs.writeFile(a, "human after unknown write");
		sqlite.close(true);
		const reopened = new Database(join(root, "isolated.sqlite"));
		owner.sqlite = reopened;
		reopened.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0; PRAGMA synchronous=NORMAL;");
		expect(
			reopened.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous,
		).toBe(1);
		const reopenedDb = database(reopened);
		setReopenedDatabase(
			reopened,
			reopenedDb,
			makeFixtureRuntime({
				db: reopenedDb,
				privateRoot: join(root, "private"),
				coordinatorState: createWorkspaceWriteCoordinatorState(),
				blobStoreOptions: { minimumFreeBytes: 0 },
			}),
		);
		setService(makeFixtureTransaction(db, { ...options, runtime }));
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(await fs.readFile(a, "utf8")).toBe("human after unknown write");
		expect(history()).toBe(before);
	});
	test("SQL failure after deleting a tool-created file recreates its exact bytes and mode", async () => {
		const path = join(workspace, "created-then-restored.txt");
		await write(path, "created bytes\r\n");
		const original = await fs.readFile(path);
		const mode = (await fs.stat(path)).mode & 0o7777;
		const before = history();
		const plan = await prepare();
		failHistoryCommit();
		expect((await execution(plan).result).status).toBe("compensated");
		expect(await fs.readFile(path)).toEqual(original);
		expect((await fs.stat(path)).mode & 0o7777).toBe(mode);
		expect(history()).toBe(before);
		expect(journalFiles(plan)[0]).toMatchObject({
			observedAfterStateJson: { kind: "absent" },
			compensationAfterBlobDigest: hash(original),
			status: "compensated",
		});
	});
	test("delete compensation does not overwrite a file created externally after verified absence", async () => {
		const path = join(workspace, "created-external.txt");
		await write(path, "tool-created");
		const plan = await prepare();
		failHistoryCommit();
		const begin = RevertMutationJournal.prototype.beginCompensation;
		const change = spyOn(RevertMutationJournal.prototype, "beginCompensation").mockImplementation(
			function (this: RevertMutationJournal, ctx) {
				writeFileSync(path, "external-new-file");
				return begin.call(this, ctx);
			},
		);
		restores.push(() => change.mockRestore());
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(await fs.readFile(path, "utf8")).toBe("external-new-file");
		expect(journalFiles(plan)[0]).toMatchObject({
			observedAfterStateJson: { kind: "absent" },
			compensationAfterBlobDigest: hash("external-new-file"),
		});
	});
	test.each([
		"history_delete",
		"revert",
	] as const)("last owner authorization external edit blocks %s commit and preserves history/third content", async (kind) => {
		const { a, plan: unused } = await twoFiles();
		const plan = kind === "history_delete" ? unused : await prepare({ kind });
		const before = history();
		const resolve = access.resolveContext.bind(access);
		let changed = false;
		const edit = spyOn(access, "resolveContext").mockImplementation(async (input) => {
			const result = await resolve(input);
			if (!changed && operation(plan)?.status === "files_verified") {
				changed = true;
				await fs.writeFile(a, "third during final owner authorization");
			}
			return result;
		});
		restores.push(() => edit.mockRestore());
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(changed).toBe(true);
		expect(history()).toBe(before);
		expect(await fs.readFile(a, "utf8")).toBe("third during final owner authorization");
		expect(journalFiles(plan)[0]).toMatchObject({
			observedAfterBlobDigest: hash("original"),
			compensationAfterBlobDigest: hash("third during final owner authorization"),
		});
	});
	test.each([
		"during",
		"after",
	] as const)("external edit %s actual final history preparation is rechecked before synchronous commit", async (timing) => {
		const { a, plan } = await twoFiles();
		const before = history();
		let changed = false;
		const change = async () => {
			if (!changed && operation(plan)?.status === "files_verified") {
				changed = true;
				await fs.writeFile(a, "third during history prepare");
			}
		};
		if (timing === "during") {
			const authorize = access.authorizeNarrator.bind(access);
			const hook = spyOn(access, "authorizeNarrator").mockImplementation(async (...args) => {
				await authorize(...args);
				await change();
			});
			restores.push(() => hook.mockRestore());
		} else {
			const prepare = RevertHistoryCommitService.prototype.prepare;
			const hook = spyOn(RevertHistoryCommitService.prototype, "prepare").mockImplementation(
				async function (this: RevertHistoryCommitService, request) {
					const token = await prepare.call(this, request);
					await change();
					return token;
				},
			);
			restores.push(() => hook.mockRestore());
		}
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(changed).toBe(true);
		expect(history()).toBe(before);
		expect(await fs.readFile(a, "utf8")).toBe("third during history prepare");
		expect(journalFiles(plan)[0].compensationAfterBlobDigest).toBe(
			hash("third during history prepare"),
		);
	});
	test("cleanup after revoked file ACL records unknown observation without another file read", async () => {
		const { b, plan } = await twoFiles();
		const before = history();
		let revoked = false;
		let forbiddenReads = 0;
		const read = fileChangeLocalIo.read.bind(fileChangeLocalIo);
		const spy = spyOn(fileChangeLocalIo, "read").mockImplementation(async (path, signal) => {
			if (revoked && path === b) forbiddenReads++;
			return read(path, signal);
		});
		restores.push(() => spy.mockRestore());
		setFileHook((path) => {
			if (
				path === b &&
				operation(plan)?.status === "applying" &&
				journalFiles(plan)[1].status === "applying"
			) {
				revoked = true;
				allowedFiles.delete(b);
				throw new Error("Real file permission revoked before initial restore read");
			}
		});
		expect((await execution(plan).result).status).toBe("compensated");
		expect(revoked).toBe(true);
		expect(forbiddenReads).toBe(0);
		expect(history()).toBe(before);
		expect(await fs.readFile(b, "utf8")).toBe("changed");
		expect(journalFiles(plan)[1]).toMatchObject({
			observedAfterStateJson: { kind: "unknown", reason: "target_unverified" },
			observedAfterBlobDigest: null,
			receiptJson: {
				apply: {
					receipt: {
						confirmed: true,
						outcome: "not_applied",
						observedAfter: { kind: "unknown", reason: "target_unverified" },
					},
				},
			},
		});
	});
	test("cleanup never reads another referent after a lexical ancestor becomes a symlink", async () => {
		const nested = join(workspace, "nested");
		const moved = join(workspace, "retained-original");
		const outside = join(root, "outside-target");
		await fs.mkdir(nested);
		await fs.mkdir(outside);
		const path = join(nested, "file.txt");
		const foreign = join(outside, "file.txt");
		await fs.writeFile(path, "original");
		await fs.writeFile(foreign, "private foreign bytes");
		await write(path, "changed");
		const plan = await prepare();
		const before = history();
		let retargeted = false;
		let forbiddenReads = 0;
		const read = fileChangeLocalIo.read.bind(fileChangeLocalIo);
		const spy = spyOn(fileChangeLocalIo, "read").mockImplementation(async (current, signal) => {
			if (retargeted && (current === path || current === foreign)) forbiddenReads++;
			return read(current, signal);
		});
		restores.push(() => spy.mockRestore());
		setFileHook(async (current) => {
			if (
				!retargeted &&
				current === path &&
				operation(plan)?.status === "applying" &&
				journalFiles(plan)[0].status === "applying"
			) {
				retargeted = true;
				await fs.rename(nested, moved);
				await fs.symlink(outside, nested);
			}
		});
		expect((await execution(plan).result).status).toBe("compensated");
		expect(retargeted).toBe(true);
		expect(forbiddenReads).toBe(0);
		expect(await fs.readFile(foreign, "utf8")).toBe("private foreign bytes");
		expect(await fs.readFile(join(moved, "file.txt"), "utf8")).toBe("changed");
		expect(history()).toBe(before);
		expect(journalFiles(plan)[0]).toMatchObject({
			observedAfterStateJson: { kind: "unknown", reason: "target_unverified" },
			observedAfterBlobDigest: null,
			receiptJson: { apply: { receipt: { confirmed: true, outcome: "not_applied" } } },
		});
		expect(
			db
				.select()
				.from(schema.fileChangeBlobs)
				.where(eq(schema.fileChangeBlobs.digest, hash("private foreign bytes")))
				.get(),
		).toBeUndefined();
	});
	test.each([
		false,
		true,
	])("low fixed evidence budget permits normal apply and SQL-compensation=%s without double charging", async (sqlFailure) => {
		const { a, b, plan } = await twoFiles();
		const before = history();
		const bytes = await fixedEvidenceBytes(plan);
		setService(makeFixtureTransaction(db, { ...options, maxEvidenceBytes: bytes }));
		if (sqlFailure) failHistoryCommit();
		expect((await execution(plan).result).status).toBe(sqlFailure ? "compensated" : "committed");
		for (const path of [a, b])
			expect(await fs.readFile(path, "utf8")).toBe(sqlFailure ? "changed" : "original");
		if (sqlFailure) expect(history()).toBe(before);
	});
	test.each([
		false,
		true,
	])("authorized third-state evidence admission respects lowered budget: overLimit=%s", async (overLimit) => {
		const { a, plan } = await twoFiles();
		const before = history();
		const third = "third party observed after dispatch";
		const bytes = await fixedEvidenceBytes(plan);
		setService(
			makeFixtureTransaction(db, {
				...options,
				maxEvidenceBytes: bytes + Buffer.byteLength(third) - (overLimit ? 1 : 0),
			}),
		);
		let changed = false;
		setFileHook(async (path) => {
			if (
				!changed &&
				path === a &&
				operation(plan)?.status === "applying" &&
				journalFiles(plan)[0].status === "applying" &&
				(await fs.readFile(a, "utf8")) === "original"
			) {
				changed = true;
				await fs.writeFile(a, third);
				throw new Error("Post-dispatch authorization interrupted before observation");
			}
		});
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(changed).toBe(true);
		expect(history()).toBe(before);
		expect(await fs.readFile(a, "utf8")).toBe(third);
		const row = journalFiles(plan)[0];
		expect(row.receiptJson).toMatchObject({
			apply: { receipt: { confirmed: false, outcome: "unknown" } },
			compensate: null,
		});
		if (overLimit) {
			expect(row.observedAfterStateJson).toEqual({ kind: "unknown", reason: "budget_exceeded" });
			expect(row.observedAfterBlobDigest).toBeNull();
			expect(
				db
					.select()
					.from(schema.fileChangeBlobs)
					.where(eq(schema.fileChangeBlobs.digest, hash(third)))
					.get(),
			).toBeUndefined();
		} else {
			expect(row.observedAfterBlobDigest).toBe(hash(third));
			expect(row.observedAfterStateJson?.kind).toBe("regular");
		}
	});
	test("trusted transaction budget cannot raise shared ceiling or admit an over-budget fixed plan", async () => {
		const { a, plan } = await twoFiles();
		expect(() =>
			makeFixtureTransaction(db, {
				...options,
				maxEvidenceBytes: FILE_CHANGE_LIMITS.operationEvidenceBytes + 1,
			}),
		).toThrow("BUDGET_EXCEEDED");
		setService(
			makeFixtureTransaction(db, {
				...options,
				maxEvidenceBytes: (await fixedEvidenceBytes(plan)) - 1,
			}),
		);
		expect(await rejectionOf(execution(plan).result)).toThrow("BUDGET_EXCEEDED");
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(operation(plan)?.status).toBe("prepared");
	});
	test("history manifest drift without a version bump refuses before all target IO", async () => {
		const { a, plan } = await twoFiles();
		const first = db.select().from(schema.narratorMessages).limit(1).get();
		if (!first) throw new Error("Missing message");
		db.update(schema.narratorMessages)
			.set({ contentJson: [{ type: "text", text: "edited outside selected history" }] })
			.where(eq(schema.narratorMessages.id, first.id))
			.run();
		const changed = history();
		expect(await rejectionOf(execution(plan).result)).toThrow();
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(history()).toBe(changed);
		expect(operation(plan)?.status).toBe("prepared");
	});
	test("unreadable commit outcome is recovery, never permission to compensate a possibly committed history", async () => {
		const { a, plan } = await twoFiles();
		const commit = RevertMutationJournal.prototype.commit;
		const get = RevertMutationJournal.prototype.getOperation;
		let unreadable = false;
		const reads = spyOn(RevertMutationJournal.prototype, "getOperation").mockImplementation(
			function (this: RevertMutationJournal, ctx) {
				if (unreadable) throw new Error("DB result unavailable");
				return get.call(this, ctx);
			},
		);
		const fault = spyOn(RevertMutationJournal.prototype, "commit").mockImplementation(function (
			this: RevertMutationJournal,
			ctx,
			history,
		) {
			commit.call(this, ctx, history);
			unreadable = true;
			throw new Error("connection response lost");
		});
		restores.push(
			() => reads.mockRestore(),
			() => fault.mockRestore(),
		);
		expect((await execution(plan).result).status).toBe("recovery_required");
		expect(operation(plan)?.status).toBe("committed");
		expect(
			journalFiles(plan).every(
				(row) => (row.receiptJson as { compensate: unknown }).compensate === null,
			),
		).toBe(true);
		expect(await fs.readFile(a, "utf8")).toBe("original");
		reads.mockRestore();
		fault.mockRestore();
		expect((await execution(plan).result).status).toBe("committed");
	});
	test("cancel before second dispatch uses independent raw-receipt and compensation budgets", async () => {
		const { a, b, plan } = await twoFiles();
		const before = history();
		const controller = new AbortController();
		setFileHook((path) => {
			if (
				path === b &&
				operation(plan)?.status === "applying" &&
				journalFiles(plan)[1].status === "applying"
			)
				controller.abort();
		});
		const attempt = execution(plan, controller.signal);
		expect((await attempt.result).status).toBe("compensated");
		expect((await attempt.whenSettled).status).toBe("compensated");
		for (const path of [a, b]) expect(await fs.readFile(path, "utf8")).toBe("changed");
		expect(history()).toBe(before);
		expect(journalFiles(plan)[1].receiptJson).toMatchObject({
			apply: { receipt: { confirmed: true, outcome: "not_applied" } },
		});
	});
	test("real 50ms early cleanup expiry before dispatch retains recovery-required without blind compensation", async () => {
		const { a, b, plan } = await twoFiles();
		const before = history();
		const filesBefore = journalFiles(plan);
		const controller = new AbortController();
		const entered = hold();
		const expired = hold();
		const release = hold();
		let cleanupSignal: AbortSignal | undefined;
		let namespaceAcquired = false;
		let namespaceWait: Promise<void> | undefined;
		setService(makeFixtureTransaction(db, { ...options, cleanupTimeoutMs: 50 }));
		const start = RevertMutationJournal.prototype.startExecution;
		const cancel = spyOn(RevertMutationJournal.prototype, "startExecution").mockImplementation(
			async function (this: RevertMutationJournal, ...args) {
				const admission = await start.apply(this, args);
				// Cancel after real durable admission, but before ANY restore or its own
				// 50ms receipt-publication budget. Slow blob IO must not choose our phase.
				if (admission.started) controller.abort();
				return admission;
			},
		);
		const finish = RevertMutationJournal.prototype.finishCompensation;
		const fault = spyOn(RevertMutationJournal.prototype, "finishCompensation").mockImplementation(
			async function (this: RevertMutationJournal, ctx, options) {
				// With no dispatched files, this is compensate()'s FIRST async dependency:
				// its original 50ms signal has just been created, with no intervening IO.
				const signal = options?.signal;
				if (!signal) throw new Error("Missing real compensation cleanup signal");
				cleanupSignal = signal;
				entered.release();
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				expired.release();
				await release.promise;
				// Run the original scan/transition with its REAL expired signal, never
				// a fabricated receipt or timer. Later tests cover pending dispatched IO.
				return finish.call(this, ctx, options);
			},
		);
		const restore = spyOn(localRestore, "restoreLocalFile");
		restores.push(
			() => cancel.mockRestore(),
			() => fault.mockRestore(),
			() => restore.mockRestore(),
		);
		const attempt = execution(plan, controller.signal);
		try {
			await Promise.race([
				entered.promise,
				attempt.whenSettled.then(() => {
					throw new Error("Compensation settled before the cleanup-entry barrier");
				}),
			]);
			namespaceWait = runtime.withNamespaceAccess(async () => {
				namespaceAcquired = true;
			});
			await expired.promise;
			expect(cleanupSignal?.aborted).toBe(true);
			expect(cleanupSignal?.reason).toMatchObject({ name: "TimeoutError" });
			expect(await attempt.result).toMatchObject({
				status: "recovery_required",
				journalStatus: "compensating",
				settling: true,
			});
			expect(journalFiles(plan)).toEqual(filesBefore);
			const scope = await runtime.evidence.getScope(filesBefore[0].scopeId);
			if (!scope) throw new Error("Missing scope");
			expect(scope.activeLeaseId).toBeTruthy();
			expect(scope.activeMutationCount).toBe(0);
			expect(namespaceAcquired).toBe(false);
		} finally {
			release.release();
		}
		const final = await attempt.whenSettled;
		await namespaceWait;
		expect(namespaceAcquired).toBe(true);
		expect(final).toMatchObject({
			status: "recovery_required",
			journalStatus: "compensating",
			settling: false,
		});
		// Expiry cannot pretend the final durable transition completed or dispatch
		// blind compensation for files that were never applied.
		expect(operation(plan)?.status).toBe("compensating");
		expect(restore).not.toHaveBeenCalled();
		expect(journalFiles(plan)).toEqual(filesBefore);
		for (const path of [a, b]) expect(await fs.readFile(path, "utf8")).toBe("changed");
		expect(history()).toBe(before);
	});

	test("bounded response keeps namespace until compensation IO settlement", async () => {
		const { a, b, plan } = await twoFiles();
		const before = history();
		const modes = await Promise.all(
			[a, b].map(async (path) => (await fs.stat(path)).mode & 0o7777),
		);
		const entered = hold();
		const release = hold();
		const controller = new AbortController();
		let held = false;
		let namespaceAcquired = false;
		let response: (() => void) | undefined;
		// Use the existing production cleanup bound. Control ONLY the response timer
		// queued synchronously by abort; real IO, guards and AbortSignal timers run normally.
		setService(makeFixtureTransaction(db, options));
		setFileHook(async (path) => {
			if (
				path === b &&
				operation(plan)?.status === "applying" &&
				journalFiles(plan)[1].status === "applying"
			) {
				const schedule = globalThis.setTimeout;
				const callbacks: (() => void)[] = [];
				const observe = ((
					callback: (...args: unknown[]) => void,
					delay?: number,
					...args: unknown[]
				) => {
					if (delay === 30_000) callbacks.push(() => callback(...args));
					return schedule(callback, delay, ...args);
				}) as typeof globalThis.setTimeout;
				const spy = spyOn(globalThis, "setTimeout").mockImplementation(observe);
				try {
					controller.abort();
				} finally {
					spy.mockRestore();
				}
				expect(callbacks).toHaveLength(1);
				response = callbacks[0];
			}
			if (
				!held &&
				path === a &&
				operation(plan)?.status === "compensating" &&
				(await fs.readFile(a, "utf8")) === "changed"
			) {
				held = true;
				entered.release();
				await release.promise;
			}
		});
		const attempt = execution(plan, controller.signal);
		await entered.promise;
		const namespaceWait = runtime.withNamespaceAccess(async () => {
			namespaceAcquired = true;
		});
		try {
			if (!response) throw new Error("Real bounded-response timer was not captured");
			response();
			expect(await attempt.result).toMatchObject({ status: "recovery_required", settling: true });
			expect(namespaceAcquired).toBe(false);
			expect(operation(plan)?.status).toBe("compensating");
		} finally {
			release.release();
		}
		expect(await attempt.whenSettled).toMatchObject({ status: "compensated", settling: false });
		await namespaceWait;
		expect(namespaceAcquired).toBe(true);
		expect(history()).toBe(before);
		for (const [index, path] of [a, b].entries()) {
			expect(await fs.readFile(path, "utf8")).toBe("changed");
			expect((await fs.stat(path)).mode & 0o7777).toBe(modes[index]);
		}
		expect(journalFiles(plan)[0].receiptJson).toMatchObject({
			apply: { receipt: { confirmed: true, outcome: "applied" } },
			compensate: { receipt: { confirmed: true, outcome: "applied" } },
		});
	});
	test("cancel during post-dispatch guard returns bounded response but retains lease until real lifetime settles", async () => {
		const { a, plan } = await twoFiles();
		const before = history();
		const entered = hold();
		const release = hold();
		const controller = new AbortController();
		let held = false;
		setService(makeFixtureTransaction(db, { ...options, cleanupTimeoutMs: 50 }));
		setFileHook(async (path) => {
			if (
				!held &&
				path === a &&
				operation(plan)?.status === "applying" &&
				journalFiles(plan)[0].status === "applying" &&
				(await fs.readFile(a, "utf8")) === "original"
			) {
				held = true;
				entered.release();
				await release.promise;
			}
		});
		const attempt = execution(plan, controller.signal);
		let namespaceAcquired = false;
		let namespaceWait: Promise<void> | undefined;
		try {
			await entered.promise;
			controller.abort();
			const early = await attempt.result;
			expect(early).toMatchObject({
				status: "recovery_required",
				settling: true,
				journalStatus: "applying",
			});
			namespaceWait = runtime.withNamespaceAccess(async () => {
				namespaceAcquired = true;
			});
			const row = journalFiles(plan)[0];
			const scope = await runtime.evidence.getScope(row.scopeId);
			if (!scope) throw new Error("Missing scope");
			expect(scope.activeLeaseId).toBeTruthy();
			expect(scope.activeMutationCount).toBe(1);
			expect(history()).toBe(before);
			expect(
				await rejectionOf(
					runtime.coordinator.withWrite(
						{
							scope,
							runtime: localFileChangeRuntimeBinding("local") as NonNullable<
								ReturnType<typeof localFileChangeRuntimeBinding>
							>,
							waitTimeoutMs: 20,
						},
						() => {},
					),
				),
			).toThrow();
			expect(namespaceAcquired).toBe(false);
		} finally {
			release.release();
		}
		const final = await attempt.whenSettled;
		await namespaceWait;
		expect(namespaceAcquired).toBe(true);
		expect(final).toMatchObject({ status: "recovery_required", settling: false });
		expect(journalFiles(plan)[0].receiptJson).toMatchObject({
			apply: { receipt: { confirmed: false, outcome: "unknown" } },
			compensate: null,
		});
		// Same desired bytes are observation, never confirmation of the cancelled invocation.
		expect(await fs.readFile(a, "utf8")).toBe("original");
		expect(history()).toBe(before);
	});
	test("already-aborted preflight performs no file IO or journal transition", async () => {
		const { a, plan } = await twoFiles();
		const controller = new AbortController();
		controller.abort();
		expect(await rejectionOf(execution(plan, controller.signal).result)).toThrow();
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(operation(plan)?.status).toBe("prepared");
	});
	test("raw original manifest corruption is refused before any target write", async () => {
		const { a, plan } = await twoFiles();
		const digest = plan.manifestDigests.plan ?? "";
		const path = join(root, "private", "file-change-blobs", "sha256", digest.slice(0, 2), digest);
		await fs.writeFile(path, "{}\n");
		const before = history();
		expect(await rejectionOf(execution(plan).result)).toThrow();
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(history()).toBe(before);
		expect(operation(plan)?.status).toBe("prepared");
	});
	test("waiting rollback releases namespace so a coordinator-owned writer can finish", async () => {
		const { a, plan } = await twoFiles();
		const waiting = hold();
		const release = hold();
		const original = runtime.coordinator.withRollbackMany.bind(runtime.coordinator);
		const delay = spyOn(runtime.coordinator, "withRollbackMany").mockImplementation(
			async (request, body) => {
				waiting.release();
				await release.promise;
				return original(request, body);
			},
		);
		restores.push(() => delay.mockRestore());
		const attempt = execution(plan);
		try {
			await waiting.promise;
			const scope = await runtime.evidence.getScope(journalFiles(plan)[0].scopeId);
			if (!scope) throw new Error("Missing scope");
			const writer = runtime.coordinator.withWrite(
				{
					scope,
					runtime: localFileChangeRuntimeBinding("local") as NonNullable<
						ReturnType<typeof localFileChangeRuntimeBinding>
					>,
				},
				() => runtime.withNamespaceAccess(async () => "namespace acquired"),
			);
			// The deadline is a deadlock guard, not the sequencing mechanism.
			expect(
				await Promise.race([
					writer,
					new Promise((_, reject) => {
						const timer = setTimeout(() => reject(new Error("Lock order deadlock")), 1000);
						void writer.finally(() => clearTimeout(timer));
					}),
				]),
			).toBe("namespace acquired");
		} finally {
			release.release();
			await attempt.whenSettled;
		}
		expect(operation(plan)?.status).toBe("committed");
		expect(await fs.readFile(a, "utf8")).toBe("original");
	});
	test("hot-loaded namespace-first writer finishes after rollback loses atomic namespace admission", async () => {
		const { a, plan } = await twoFiles();
		const entered = hold();
		const queued = hold();
		const original = runtime.coordinator.withRollbackMany.bind(runtime.coordinator);
		let legacy: Promise<void> | undefined;
		let attempts = 0;
		const admission = spyOn(runtime.coordinator, "withRollbackMany").mockImplementation(
			(request, body) =>
				original(request, async (batch) => {
					if (++attempts === 1) {
						// Simulate retained HEAD code: namespace first, then coordinator. The
						// new rollback already owns coordinator, so waiting for namespace deadlocks.
						legacy = coordinatorState.executionContext.exit(() =>
							runtime.withNamespaceAccess(async () => {
								entered.release();
								const { activityPolicy: _policy, ...target } = request.scopes[0];
								const write = runtime.coordinator.withWrite(target, () => {});
								queued.release();
								await write;
							}),
						);
						await entered.promise;
						await queued.promise;
					}
					return body(batch);
				}),
		);
		const previews = spyOn(access, "resolveFile");
		const claims = spyOn(RevertMutationJournal.prototype, "startExecution");
		restores.push(
			() => admission.mockRestore(),
			() => previews.mockRestore(),
			() => claims.mockRestore(),
		);
		setService(makeFixtureTransaction(db, { ...options, timeoutMs: 2000 }));
		const attempt = execution(plan);
		expect((await attempt.whenSettled).status).toBe("committed");
		await legacy;
		expect(attempts).toBe(2);
		expect(previews).toHaveBeenCalledTimes(journalFiles(plan).length);
		expect(claims).toHaveBeenCalledTimes(1);
		expect(await fs.readFile(a, "utf8")).toBe("original");
		expect(journalFiles(plan)).toHaveLength(2);
	});
	test("cancelled namespace drain never acquires rollback leases or interrupts its owner", async () => {
		const { a, plan } = await twoFiles();
		const entered = hold();
		const release = hold();
		const draining = hold();
		const controller = new AbortController();
		const original = runtime.waitForNamespaceDrain.bind(runtime);
		let holder: Promise<void> | undefined;
		const drain = spyOn(runtime, "waitForNamespaceDrain").mockImplementation(async (signal) => {
			holder = runtime.withNamespaceAccess(async () => {
				entered.release();
				await release.promise;
			});
			await entered.promise;
			draining.release();
			return original(signal);
		});
		const admission = spyOn(runtime.coordinator, "withRollbackMany");
		const claims = spyOn(RevertMutationJournal.prototype, "startExecution");
		restores.push(
			() => drain.mockRestore(),
			() => admission.mockRestore(),
			() => claims.mockRestore(),
		);
		const attempt = execution(plan, controller.signal);
		try {
			await draining.promise;
			controller.abort();
			expect(await rejectionOf(attempt.whenSettled)).toThrow("CANCELLED");
			expect(admission).not.toHaveBeenCalled();
			expect(claims).not.toHaveBeenCalled();
			expect(operation(plan)?.status).toBe("prepared");
		} finally {
			release.release();
			await holder;
		}
		expect(await fs.readFile(a, "utf8")).toBe("changed");
	});
	test("namespace busy with failed coordinator release is not retried through its cause", async () => {
		const { plan } = await twoFiles();
		const entered = hold();
		const release = hold();
		let holder: Promise<void> | undefined;
		const original = runtime.coordinator.withRollbackMany.bind(runtime.coordinator);
		const admission = spyOn(runtime.coordinator, "withRollbackMany").mockImplementation(
			(request, body) =>
				original(request, async (batch) => {
					holder = runtime.withNamespaceAccess(async () => {
						entered.release();
						await release.promise;
					});
					await entered.promise;
					sqlite.exec(`CREATE TRIGGER reject_busy_scope_release BEFORE UPDATE OF active_lease_id ON file_change_scopes
					WHEN NEW.active_lease_id IS NULL AND OLD.active_lease_id IS NOT NULL
					BEGIN SELECT RAISE(ABORT, 'busy-scope-release-failed'); END;`);
					return body(batch);
				}),
		);
		const claims = spyOn(RevertMutationJournal.prototype, "startExecution");
		restores.push(
			() => admission.mockRestore(),
			() => claims.mockRestore(),
		);
		try {
			expect(await rejectionOf(execution(plan).whenSettled)).toThrow(
				"Durable batch finalization failed",
			);
			expect(admission).toHaveBeenCalledTimes(1);
			expect(claims).not.toHaveBeenCalled();
			expect(operation(plan)?.status).toBe("prepared");
			expect(
				(await runtime.evidence.getScope(journalFiles(plan)[0].scopeId))?.activeLeaseId,
			).not.toBeNull();
		} finally {
			sqlite.exec("DROP TRIGGER IF EXISTS reject_busy_scope_release");
			release.release();
			await holder;
		}
	});
	test("cancelled rollback namespace admission releases its leases but not the current namespace owner", async () => {
		const { a, plan } = await twoFiles();
		const waiting = hold();
		const admit = hold();
		const namespaceEntered = hold();
		const namespaceRelease = hold();
		const callbackEntered = hold();
		const controller = new AbortController();
		const original = runtime.coordinator.withRollbackMany.bind(runtime.coordinator);
		const delay = spyOn(runtime.coordinator, "withRollbackMany").mockImplementation(
			async (request, body) => {
				waiting.release();
				await admit.promise;
				return original(request, (batch) => {
					callbackEntered.release();
					return body(batch);
				});
			},
		);
		const claims = spyOn(RevertMutationJournal.prototype, "startExecution");
		restores.push(
			() => delay.mockRestore(),
			() => claims.mockRestore(),
		);
		const attempt = execution(plan, controller.signal);
		await waiting.promise;
		const holder = runtime.withNamespaceAccess(async () => {
			namespaceEntered.release();
			await namespaceRelease.promise;
		});
		let successorEntered = false;
		let successor: Promise<void> | undefined;
		try {
			await namespaceEntered.promise;
			admit.release();
			await callbackEntered.promise;
			controller.abort();
			expect(await rejectionOf(attempt.whenSettled)).toThrow("CANCELLED");
			const scope = await runtime.evidence.getScope(journalFiles(plan)[0].scopeId);
			expect(scope?.activeLeaseId).toBeNull();
			expect(claims).not.toHaveBeenCalled();
			expect(operation(plan)?.status).toBe("prepared");
			successor = runtime.withNamespaceAccess(async () => {
				successorEntered = true;
			});
			await Promise.resolve();
			expect(successorEntered).toBe(false);
		} finally {
			admit.release();
			namespaceRelease.release();
			await holder;
			await successor;
		}
		expect(successorEntered).toBe(true);
		expect(await fs.readFile(a, "utf8")).toBe("changed");
	});
	test("namespace reset while rollback waits refuses its old plan before target IO", async () => {
		const { a, plan } = await twoFiles();
		const before = history();
		const waiting = hold();
		const release = hold();
		const original = runtime.coordinator.withRollbackMany.bind(runtime.coordinator);
		const delay = spyOn(runtime.coordinator, "withRollbackMany").mockImplementation(
			async (request, body) => {
				waiting.release();
				await release.promise;
				return original(request, body);
			},
		);
		const claims = spyOn(RevertMutationJournal.prototype, "startExecution");
		restores.push(
			() => delay.mockRestore(),
			() => claims.mockRestore(),
		);
		const attempt = execution(plan);
		await waiting.promise;
		const reset = runtime.withNamespaceAccess(() =>
			resetFileChangeNamespace({
				db,
				privateRoot: join(root, "private"),
				assertBoundary: async () => {},
			}),
		);
		// Gate release remains deferred until reset has actually invalidated old facts.
		await reset;
		const opens = spyOn(fileChangeLocalIo, "read");
		restores.push(() => opens.mockRestore());
		release.release();
		expect(await rejectionOf(attempt.whenSettled)).toThrow();
		expect(opens).not.toHaveBeenCalled();
		expect(claims).not.toHaveBeenCalled();
		expect(operation(plan)?.status).toBe("expired");
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(history()).toBe(before);
	});
	test("lease admission accepts unrelated coordinator revision/fence advancement", async () => {
		const { a, plan } = await twoFiles();
		const original = runtime.coordinator.withRollbackMany.bind(runtime.coordinator);
		const delay = spyOn(runtime.coordinator, "withRollbackMany").mockImplementation(
			async (request, body) => {
				const { activityPolicy: _activityPolicy, ...writeTarget } = request.scopes[0];
				await runtime.coordinator.withWrite(writeTarget, () => {});
				return original(request, body);
			},
		);
		restores.push(() => delay.mockRestore());
		expect((await execution(plan).result).status).toBe("committed");
		expect(await fs.readFile(a, "utf8")).toBe("original");
		expect(operation(plan)?.status).toBe("committed");
	});
	test("positive current-invocation no-op is not_applied, never counted as an applied mutation", async () => {
		const path = join(workspace, "no-op.txt");
		await fs.writeFile(path, "same");
		await write(path, "same");
		const plan = await prepare();
		expect((await execution(plan).result).status).toBe("committed");
		expect(operation(plan)?.appliedFileCount).toBe(0);
		expect(journalFiles(plan)[0].receiptJson).toMatchObject({
			apply: { receipt: { confirmed: true, outcome: "not_applied" } },
		});
	});
	test("execution request rejects client files/proof and independently rechecks authentication", async () => {
		const { a, plan } = await twoFiles();
		expect(() =>
			service.execute({
				principal,
				narratorId: "narrator",
				planId: plan.id,
				planHash: plan.planHash ?? "",
				files: [],
			} as Parameters<RevertTransactionService["execute"]>[0]),
		).toThrow("INVALID_REQUEST");
		expect(
			await rejectionOf(
				service.execute({
					principal: { userId: "bob", isAdmin: false },
					narratorId: "narrator",
					planId: plan.id,
					planHash: plan.planHash ?? "",
				}).result,
			),
		).toThrow("Narrator denied");
		expect(await fs.readFile(a, "utf8")).toBe("changed");
		expect(operation(plan)?.status).toBe("prepared");
	});
	test("a mixed StructSed write, default preview and pre-write refusals can retract as one range", async () => {
		const path = join(workspace, "structsed-mixed.txt");
		await fs.writeFile(path, "original\nkeep\n");
		await tool("StructSed", path, {
			file_path: path,
			command: "replace",
			address: "1",
			content: "changed",
			dry_run: false,
		});
		await tool("StructSed", path, {
			file_path: path,
			command: "replace",
			address: "1",
			content: "preview only",
		});
		await tool(
			"StructSed",
			path,
			{ file_path: path, operations: [], dry_run: false },
			workspace,
			true,
		);
		await tool(
			"StructSed",
			path,
			{ file_path: path, command: "delete", address: "/no-such-marker/", dry_run: false },
			workspace,
			true,
		);
		expect(await fs.readFile(path, "utf8")).toBe("changed\nkeep\n");
		const plan = await prepare();
		expect(plan.expectedFileCount).toBe(1);
		expect((await execution(plan).result).status).toBe("committed");
		expect(await fs.readFile(path, "utf8")).toBe("original\nkeep\n");
		expect(db.select().from(schema.narratorMessageRefs).limit(100).all()).toHaveLength(0);
	});
	test("partial rollback within one assistant message includes its failed StructSed safely", async () => {
		const path = join(workspace, "structsed-same-message.txt");
		await fs.writeFile(path, "original\n");
		const written = await write(path, "changed\n");
		await tool(
			"StructSed",
			path,
			{ file_path: path, operations: [], dry_run: false },
			workspace,
			true,
			"narrator",
			written.messageId,
		);
		const plan = await prepare({
			kind: "rollback_to_block",
			selector: { kind: "after_block", messageId: written.messageId, keepThroughBlockIndex: 0 },
		});
		expect(plan.expectedFileCount).toBe(1);
		expect((await execution(plan).result).status).toBe("committed");
		expect(await fs.readFile(path, "utf8")).toBe("original\n");
		const retained = db
			.select()
			.from(schema.narratorMessages)
			.where(eq(schema.narratorMessages.id, written.messageId))
			.get();
		expect(retained?.contentJson).toEqual([{ type: "text", text: "retain" }]);
		expect(db.select().from(schema.narratorToolCalls).limit(100).all()).toHaveLength(0);
	});
	test("StructSed previews and invalid stash do not require a fabricated file restore", async () => {
		const path = join(workspace, "structsed-preview.txt");
		await fs.writeFile(path, "unchanged\n");
		await tool("StructSed", path, {
			file_path: path,
			command: "delete",
			address: "1",
			dry_run: true,
		});
		await tool(
			"StructSed",
			path,
			{
				file_path: path,
				command: "append",
				address: "1",
				from_stash: "stash_missing_handle",
				dry_run: false,
			},
			workspace,
			true,
		);
		const plan = await prepare();
		expect(plan.expectedFileCount).toBe(0);
		expect((await execution(plan).result).status).toBe("committed");
		expect(await fs.readFile(path, "utf8")).toBe("unchanged\n");
		expect(db.select().from(schema.fileChangeEffects).limit(100).all()).toHaveLength(0);
		expect(db.select().from(schema.narratorMessageRefs).limit(100).all()).toHaveLength(0);
	});
	test("a legacy failed StructSed without evidence cannot be inferred harmless from its status", async () => {
		const path = join(workspace, "structsed-unverified.txt");
		await fs.writeFile(path, "unchanged\n");
		const call = await tool(
			"StructSed",
			path,
			{ file_path: path, operations: [], dry_run: false },
			workspace,
			true,
		);
		// Simulate an old record with no authoritative proof, not a safe migration guess.
		db.update(schema.narratorToolCalls)
			.set({ fileChangeOperationId: null })
			.where(eq(schema.narratorToolCalls.id, call.toolCallId))
			.run();
		const before = history();
		expect(await prepare().catch((error: unknown) => error)).toMatchObject({
			code: "REVERT_PLANNER_EVIDENCE_INCOMPLETE",
		});
		expect(history()).toBe(before);
		expect(await fs.readFile(path, "utf8")).toBe("unchanged\n");
	});
	test("zero-file rollback rechecks namespace after reset queued during preview", async () => {
		const path = join(workspace, "no-dispatch-reset.txt");
		await fs.writeFile(path, "unchanged");
		await edit(path, "missing", "new", true);
		const plan = await prepare();
		expect(plan.expectedFileCount).toBe(0);
		const before = history();
		const entered = hold();
		const release = hold();
		const readBytes = namespace.store.readBytes.bind(namespace.store);
		let held = false;
		const reads = spyOn(namespace.store, "readBytes").mockImplementation(async (ref, options) => {
			if (!held) {
				held = true;
				entered.release();
				await release.promise;
			}
			return readBytes(ref, options);
		});
		const claims = spyOn(RevertMutationJournal.prototype, "startExecution");
		const admission = spyOn(runtime.coordinator, "withRollbackMany");
		restores.push(
			() => reads.mockRestore(),
			() => claims.mockRestore(),
			() => admission.mockRestore(),
		);
		const attempt = execution(plan);
		await entered.promise;
		const reset = runtime.withNamespaceAccess(() =>
			resetFileChangeNamespace({
				db,
				privateRoot: join(root, "private"),
				assertBoundary: async () => {},
			}),
		);
		release.release();
		await reset;
		expect(await rejectionOf(attempt.whenSettled)).toThrow();
		expect(claims).not.toHaveBeenCalled();
		expect(admission).not.toHaveBeenCalled();
		expect(operation(plan)?.status).toBe("expired");
		expect(history()).toBe(before);
		expect(await fs.readFile(path, "utf8")).toBe("unchanged");
	});
	test("positive no_dispatch zero-file history deletion uses no fabricated workspace lease", async () => {
		const path = join(workspace, "no-dispatch.txt");
		await fs.writeFile(path, "unchanged");
		await edit(path, "missing", "new", true);
		const plan = await prepare();
		expect(plan.expectedFileCount).toBe(0);
		expect((await execution(plan).result).status).toBe("committed");
		expect(await fs.readFile(path, "utf8")).toBe("unchanged");
		expect(db.select().from(schema.narratorMessageRefs).limit(100).all()).toHaveLength(0);
	});
});
