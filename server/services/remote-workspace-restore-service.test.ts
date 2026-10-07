import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileChangeRevertMutationJournal } from "@shared/file-change-protocol";
import type { WorkspaceContext } from "@shared/workspace-context";
import { eq } from "drizzle-orm";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import * as schema from "../db/schema";
import { resolveBackend } from "../lib/agent/execution/registry";
import { generateId } from "../lib/id";
import {
	boundedFixtureCommand,
	startNativeRemoteExecutorFixture,
} from "./__tests__/native-remote-executor-fixture";
import { createDevice } from "./device-service";
import { getDefaultLocalFileChangeRuntime } from "./file-change-runtime";
import { SQLiteRemoteHistoryMetadataStore } from "./remote-history-journal";
import { RemoteHistoryUncertainError } from "./remote-history-service";
import { remoteTreeCapturePolicy } from "./remote-tree-snapshot-hooks";
import {
	authorizeRemoteHistoryTarget,
	RemoteWorkspaceHistoryRuntime,
} from "./remote-workspace-history-runtime";
import type {
	RemoteWorkspaceRestoreAuthority,
	RemoteWorkspaceSnapshotOrigin,
} from "./remote-workspace-restore-authority";
import { RemoteWorkspaceRestoreService } from "./remote-workspace-restore-service";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("recover shares preparation admission and cancellation frees worker slots", async () => {
	const nativeWorker = globalThis.Worker;
	let workers = 0;
	globalThis.Worker = new Proxy(nativeWorker, {
		construct(target, args) {
			workers++;
			return Reflect.construct(target, args);
		},
	});
	const controllers = [new AbortController(), new AbortController()];
	let ownerCalls = 0;
	let ready!: () => void;
	const bothAdmitted = new Promise<void>((resolve) => {
		ready = resolve;
	});
	let rejectNext = false;
	const authority: RemoteWorkspaceRestoreAuthority = {
		async owner(_user, _id, signal) {
			if (rejectNext) throw new Error("Owner denied after admission release");
			return new Promise<never>((_resolve, reject) => {
				ownerCalls++;
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				if (ownerCalls === 2) ready();
			});
		},
		async snapshot() {
			throw new Error("Unreachable snapshot");
		},
		async policy() {
			throw new Error("Unreachable policy");
		},
		async authorizeEntry() {
			throw new Error("Unreachable entry");
		},
	};
	try {
		const registry = new RemoteWorkspaceHistoryRuntime({
			db,
			auditRuntime: await getDefaultLocalFileChangeRuntime(),
			backend: () => {
				throw new Error("Unreachable native backend");
			},
			authorize: authorizeRemoteHistoryTarget,
			metadataStore: new SQLiteRemoteHistoryMetadataStore(db),
		});
		const service = new RemoteWorkspaceRestoreService({ registry, authority });
		const principal = { userId: generateId(), isAdmin: false };
		const narratorId = generateId();
		const recovery = {
			principal,
			narratorId,
			planId: generateId(),
			planHash: hash("plan"),
			confirmation: {
				kind: "snapshot_restore" as const,
				captureId: generateId(),
				deviceId: generateId(),
				root: "/fixture",
				rootIdentity: "fixture",
				treeDigest: hash("tree"),
			},
		};
		const preparing = service.prepare({
			principal,
			narratorId,
			captureId: recovery.confirmation.captureId,
			idempotencyKey: generateId(),
			signal: controllers[0].signal,
		});
		const recovering = service.recover({ ...recovery, signal: controllers[1].signal });
		const settled = Promise.allSettled([preparing, recovering]);
		await bothAdmitted;
		expect(workers).toBe(2);
		await expect(service.recover(recovery)).rejects.toThrow("recovery busy");
		expect(workers).toBe(2);
		controllers[0].abort(new Error("Cancelled prepare"));
		controllers[1].abort(new Error("Cancelled recover"));
		expect((await settled).map((result) => result.status)).toEqual(["rejected", "rejected"]);
		rejectNext = true;
		await expect(service.recover(recovery)).rejects.toThrow("Owner denied after admission release");
		expect(workers).toBe(3);
	} finally {
		for (const controller of controllers) controller.abort(new Error("Fixture cleanup"));
		globalThis.Worker = nativeWorker;
	}
}, 15_000);
const crossFilesystemAvailable = await (async () => {
	if (process.platform !== "linux") return false;
	try {
		await access("/dev/shm", constants.W_OK);
		return (await stat("/dev/shm")).dev !== (await stat(testEnvironment.isolatedHome)).dev;
	} catch {
		return false;
	}
})();
for (const scenario of [
	"cross_filesystem_refused",
	"cross_filesystem_lost_refusal",
	"committed",
	"unchanged_modified",
	"new_file",
	"lost_reply",
	"lost_reply_unchanged_modified",
	"partial_receipt",
	"wrong_receipt_after",
	"wrong_receipt_binding",
	"git_filter_changed",
] as const) {
	test.skipIf(
		process.platform !== "linux" ||
			(scenario.startsWith("cross_filesystem_") && !crossFilesystemAvailable),
	)(
		`native whole-directory restore ${scenario} preserves source-qualified history`,
		async () => {
			const directory = await mkdtemp(
				join(testEnvironment.isolatedHome, "native-workspace-restore-"),
			);
			const root = scenario.startsWith("cross_filesystem_")
				? await mkdtemp(join("/dev/shm", "nf-workspace-restore-"))
				: join(directory, "non-git-root");
			const userId = generateId();
			const narratorId = generateId();
			const now = new Date().toISOString();
			let native: Awaited<ReturnType<typeof startNativeRemoteExecutorFixture>> | undefined;
			try {
				if (!scenario.startsWith("cross_filesystem_")) await mkdir(root);
				if (scenario === "git_filter_changed") {
					// Only the test-owned fixture directory, never a user's workspace.
					await boundedFixtureCommand(["git", "init", root]);
					await writeFile(join(root, ".git", "info", "exclude"), "keep.dat\n");
					await writeFile(join(root, "keep.dat"), "DO NOT DELETE\n");
				}
				await writeFile(join(root, "unchanged.txt"), "UNCHANGED\n", { mode: 0o600 });
				await mkdir(join(root, "excluded"));
				await writeFile(join(root, "a.txt"), "snapshot A\n", { mode: 0o600 });
				await writeFile(join(root, "b.txt"), "snapshot B\n", { mode: 0o600 });
				await writeFile(join(root, "excluded", "owner.txt"), "KEEP ORIGINAL\n", { mode: 0o600 });
				db.insert(schema.users)
					.values({
						id: userId,
						username: userId,
						passwordHash: "fixture-not-secret",
						createdAt: now,
					})
					.run();
				const device = await createDevice({
					name: `Whole restore ${userId}`,
					createdBy: userId,
					ownerScope: "private",
					scope: "global",
					connectionMode: "reverse",
				});
				native = await startNativeRemoteExecutorFixture({
					directory,
					root,
					deviceId: device.device.id,
					token: device.token,
				});
				const backend = native.backend;
				if (!backend.remoteHistory) throw new Error("Native history required");
				const originalNativeHistory = backend.remoteHistory.bind(backend);
				let restoreDispatches = 0;
				backend.remoteHistory = async (method, payload, requestSignal) => {
					const result = await originalNativeHistory(method, payload, requestSignal);
					if (method === "restore") {
						restoreDispatches++;
						if (scenario === "unchanged_modified" || scenario === "lost_reply_unchanged_modified")
							await writeFile(join(root, "unchanged.txt"), "EXTERNAL\n");
						if (scenario === "new_file")
							await writeFile(join(root, "external-new.txt"), "EXTERNAL\n");
						if (
							scenario === "lost_reply" ||
							scenario === "lost_reply_unchanged_modified" ||
							scenario === "cross_filesystem_lost_refusal"
						)
							throw new Error("Reply lost after real native restore");
					}
					return result;
				};
				const workspace: WorkspaceContext = {
					revision: 0,
					deviceId: backend.deviceId,
					cwd: root,
					pathFlavor: "posix",
					contextKey: `snapshot:${userId}`,
					capabilities: { switchDirectory: true },
				};
				db.insert(schema.narrators)
					.values({
						id: narratorId,
						ownerUserId: userId,
						cwd: root,
						defaultDeviceId: backend.deviceId,
						workspaceContext: workspace,
						permissionMode: "bypassPermissions",
						createdAt: now,
						updatedAt: now,
					})
					.run();
				const registry = new RemoteWorkspaceHistoryRuntime({
					db,
					auditRuntime: await getDefaultLocalFileChangeRuntime(),
					backend: (id) => (id === backend.deviceId ? backend : resolveBackend({ requested: id })),
					authorize: authorizeRemoteHistoryTarget,
					metadataStore: new SQLiteRemoteHistoryMetadataStore(db),
				});
				const principal = { userId, isAdmin: false };
				const actor = { userId, narratorId, projectId: null, kind: "human" as const };
				const signal = AbortSignal.timeout(80_000);
				const endpoint = await registry.resolveWorkspace(
					actor,
					{
						deviceId: backend.deviceId,
						cwd: root,
						lexicalPath: root,
						canonicalPath: root,
						runtimeGeneration: backend.runtimeGeneration,
					},
					signal,
				);
				const basePolicy = await remoteTreeCapturePolicy(
					actor,
					{
						deviceId: backend.deviceId,
						cwd: root,
						lexicalPath: root,
						canonicalPath: root,
						runtimeGeneration: backend.runtimeGeneration,
					},
					backend,
					signal,
				);
				const policy = {
					deniedDirectories: [join(root, "excluded")],
					policyDigest: hash([basePolicy.policyDigest, "excluded"]),
				};
				const receipt = await endpoint.history.captureTree(
					{
						binding: endpoint.history.binding,
						operationId: `original_${userId}`,
						requestDigest: hash(userId),
						treePolicy: policy,
						capturePhase: "warm",
					},
					signal,
				);
				expect(receipt.coverage).toBe("complete");
				expect(receipt.captureKind).toBe("whole_directory");
				if (!receipt.tree) throw new Error("Original complete tree missing");
				const origin: RemoteWorkspaceSnapshotOrigin = {
					captureId: generateId(),
					narratorId,
					projectId: null,
					deviceId: backend.deviceId,
					binding: receipt.binding,
					contextKey: workspace.contextKey,
					workspaceRevision: 0,
					descriptor: receipt.tree,
					receipt,
				};
				let liveOrigin = origin;
				let permit = true;
				const authority: RemoteWorkspaceRestoreAuthority = {
					async owner(user, id) {
						if (!permit || user.userId !== userId || id !== narratorId)
							throw new Error("Live owner denied");
						return { subjectKey: `human:${userId}`, narratorId, projectId: null };
					},
					async snapshot(user, id, captureId) {
						if (
							!permit ||
							user.userId !== userId ||
							id !== narratorId ||
							captureId !== origin.captureId
						)
							throw new Error("Snapshot source denied");
						return liveOrigin;
					},
					async policy() {
						if (!permit) throw new Error("Root read policy revoked");
						return policy;
					},
					async authorizeEntry(user, id, _origin, path, _need) {
						if (
							!permit ||
							user.userId !== userId ||
							id !== narratorId ||
							path.startsWith("excluded")
						)
							throw new Error("Entry authority denied");
					},
				};
				const service = new RemoteWorkspaceRestoreService({ registry, authority });
				let imports = 0;
				const importState = registry.importState.bind(registry);
				registry.importState = async (...args) => {
					if (restoreDispatches > 0) imports++;
					if (
						["partial_receipt", "wrong_receipt_after", "wrong_receipt_binding"].includes(
							scenario,
						) &&
						imports === 2
					)
						throw new RemoteHistoryUncertainError(origin.binding, "recording interrupted", {
							cause: new Error("Simulated process interruption after first immutable receipt"),
						});
					return importState(...args);
				};
				let dispatchNotifications = 0;
				await writeFile(join(root, "a.txt"), "CURRENT A\n");
				await writeFile(join(root, "b.txt"), "CURRENT B\n");
				await writeFile(join(root, "excluded", "owner.txt"), "KEEP EXTERNAL\n");
				if (scenario === "git_filter_changed") {
					await writeFile(join(root, ".git", "info", "exclude"), "");
					await expect(
						service.prepare({
							principal,
							narratorId,
							captureId: origin.captureId,
							idempotencyKey: `filter_${userId}`,
							signal,
						}),
					).rejects.toThrow("ignore-filter proof");
					expect(await readFile(join(root, "keep.dat"), "utf8")).toBe("DO NOT DELETE\n");
					expect(restoreDispatches).toBe(0);
					return;
				}
				const preview = await service.prepare({
					principal,
					narratorId,
					captureId: origin.captureId,
					idempotencyKey: `preview_${userId}`,
					signal,
				});
				expect(preview.plan.revertScope).toBe("workspace");
				expect(preview.totalFileCount).toBe(2);
				expect(preview.requiresExplicitSnapshotRestore).toBe(true);
				await expect(
					service.apply({
						principal,
						narratorId,
						planId: preview.plan.id,
						planHash: preview.plan.planHash as string,
						confirmation: { ...preview.confirmation, treeDigest: hash("unconfirmed snapshot") },
						onMutationDispatch: () => {
							dispatchNotifications++;
						},
						signal,
					}),
				).rejects.toThrow("consent");
				const request = {
					principal,
					narratorId,
					planId: preview.plan.id,
					planHash: preview.plan.planHash as string,
					confirmation: preview.confirmation,
					onMutationDispatch: () => {
						dispatchNotifications++;
					},
					signal,
				};
				liveOrigin = {
					...origin,
					binding: { ...origin.binding, sourceInstanceId: "replaced-source" },
				};
				await expect(service.apply(request)).rejects.toThrow("source");
				liveOrigin = origin;
				permit = false;
				await expect(service.apply(request)).rejects.toThrow("denied");
				permit = true;
				expect(dispatchNotifications).toBe(0);
				let result = await service.apply(request);
				expect(dispatchNotifications).toBe(1);
				expect(restoreDispatches).toBe(1);
				if (scenario.startsWith("cross_filesystem_")) {
					if (scenario === "cross_filesystem_lost_refusal") {
						expect(result.status).toBe("recovery_required");
						expect(
							db
								.select()
								.from(schema.workspaceWriteLeases)
								.where(eq(schema.workspaceWriteLeases.scopeId, origin.binding.scopeId))
								.limit(10)
								.all()
								.some((lease) => lease.status === "quarantined"),
						).toBe(true);
						result = await service.recover(request);
						expect(result.reason).toBe("ORIGINAL_NATIVE_REFUSAL_RECONCILED");
					}
					expect((await stat(root)).dev).not.toBe(
						(await stat(join(directory, "executor-private"))).dev,
					);
					expect(result.status).toBe("compensated");
					expect(result.reason).toBe(
						scenario === "cross_filesystem_lost_refusal"
							? "ORIGINAL_NATIVE_REFUSAL_RECONCILED"
							: "UNSUPPORTED_CROSS_FILESYSTEM_NOT_DISPATCHED",
					);
					expect(result.restoredFileCount).toBe(0);
					expect(await readFile(join(root, "a.txt"), "utf8")).toBe("CURRENT A\n");
					expect(await readFile(join(root, "b.txt"), "utf8")).toBe("CURRENT B\n");
					const refused = db
						.select()
						.from(schema.remoteHistoryReceipts)
						.where(
							eq(schema.remoteHistoryReceipts.operationId, `workspace_restore:${request.planId}`),
						)
						.get();
					expect(refused?.state).toBe("rejected");
					expect(
						refused?.receiptJson?.effects.every(
							(effect) => effect.outcome === "pending" && effect.after === undefined,
						),
					).toBe(true);
					expect(
						db
							.select()
							.from(schema.workspaceWriteLeases)
							.where(eq(schema.workspaceWriteLeases.scopeId, origin.binding.scopeId))
							.limit(10)
							.all()
							.every(
								(lease) =>
									lease.status ===
									(scenario === "cross_filesystem_lost_refusal" ? "recovered" : "settled"),
							),
					).toBe(true);
					expect(
						db
							.select()
							.from(schema.fileChangeScopes)
							.where(eq(schema.fileChangeScopes.id, origin.binding.scopeId))
							.get()?.status,
					).toBe("active");
					expect(
						native.trace.some(
							(frame) =>
								frame.method === "history.compensate" || frame.method === "history.finalize",
						),
					).toBe(false);
					return;
				}
				if (scenario === "lost_reply_unchanged_modified") {
					expect(result.status).toBe("recovery_required");
					await expect(service.recover(request)).rejects.toThrow("Whole workspace changed");
					expect(
						db
							.select({ status: schema.revertOperations.status })
							.from(schema.revertOperations)
							.where(eq(schema.revertOperations.id, request.planId))
							.get()?.status,
					).not.toBe("committed");
					expect(await readFile(join(root, "unchanged.txt"), "utf8")).toBe("EXTERNAL\n");
					expect(
						db
							.select({ status: schema.workspaceWriteLeases.status })
							.from(schema.workspaceWriteLeases)
							.where(eq(schema.workspaceWriteLeases.scopeId, origin.binding.scopeId))
							.limit(2)
							.all()
							.some((lease) => lease.status === "quarantined"),
					).toBe(true);
					expect(restoreDispatches).toBe(1);
					expect(dispatchNotifications).toBe(1);
					return;
				}
				if (["unchanged_modified", "new_file"].includes(scenario)) {
					expect(result.status).toBe("compensated");
					expect(result.reason).toContain("Whole workspace changed");
					expect(await readFile(join(root, "a.txt"), "utf8")).toBe("CURRENT A\n");
					expect(await readFile(join(root, "b.txt"), "utf8")).toBe("CURRENT B\n");
					expect(
						await readFile(
							join(root, scenario === "new_file" ? "external-new.txt" : "unchanged.txt"),
							"utf8",
						),
					).toBe("EXTERNAL\n");
					expect(
						db
							.select({ status: schema.revertOperations.status })
							.from(schema.revertOperations)
							.where(eq(schema.revertOperations.id, request.planId))
							.get()?.status,
					).not.toBe("committed");
					return;
				}
				if (
					[
						"lost_reply",
						"partial_receipt",
						"wrong_receipt_after",
						"wrong_receipt_binding",
					].includes(scenario)
				) {
					expect(result.status).toBe("recovery_required");
					const originalFiles = db
						.select()
						.from(schema.revertOperationFiles)
						.where(eq(schema.revertOperationFiles.revertOperationId, request.planId))
						.limit(3)
						.all();
					const recorded = originalFiles.find(
						(file) => (file.receiptJson as FileChangeRevertMutationJournal | null)?.apply?.receipt,
					);
					const beforeReceipt = recorded ? JSON.stringify(recorded.receiptJson) : undefined;
					if (scenario !== "lost_reply") {
						expect(recorded).toBeDefined();
						expect(
							originalFiles.filter(
								(file) =>
									(file.receiptJson as FileChangeRevertMutationJournal | null)?.apply?.receipt,
							),
						).toHaveLength(1);
					}
					if (recorded && ["wrong_receipt_after", "wrong_receipt_binding"].includes(scenario)) {
						const journal = recorded.receiptJson as FileChangeRevertMutationJournal | null;
						if (!journal?.apply?.receipt) throw new Error("Existing original receipt required");
						const oldReceipt = journal.apply.receipt;
						const forged = {
							...journal,
							apply: {
								...journal.apply,
								receipt: {
									...oldReceipt,
									...(scenario === "wrong_receipt_after"
										? { observedAfter: { kind: "absent" as const } }
										: {
												executionBinding: {
													...oldReceipt.executionBinding,
													deviceId: "another-source",
												},
											}),
								},
							},
						};
						db.update(schema.revertOperationFiles)
							.set({ receiptJson: forged })
							.where(eq(schema.revertOperationFiles.id, recorded.id))
							.run();
						await expect(service.recover(request)).rejects.toThrow("immutable workspace receipt");
						expect(restoreDispatches).toBe(1);
						db.update(schema.revertOperationFiles)
							.set({ receiptJson: journal })
							.where(eq(schema.revertOperationFiles.id, recorded.id))
							.run();
					}
					result = await service.recover(request);
					if (recorded)
						expect(
							JSON.stringify(
								db
									.select({ receipt: schema.revertOperationFiles.receiptJson })
									.from(schema.revertOperationFiles)
									.where(eq(schema.revertOperationFiles.id, recorded.id))
									.get()?.receipt,
							),
						).toBe(beforeReceipt as string);
					expect((await service.recover(request)).status).toBe("committed");
					expect(dispatchNotifications).toBe(1);
					expect(restoreDispatches).toBe(1);
				}
				if (result.reason) expect(result.reason).toBe("ORIGINAL_RECEIPT_RECONCILED");
				expect(result.status).toBe("committed");
				expect(result.restoredFileCount).toBe(2);
				expect(await readFile(join(root, "a.txt"), "utf8")).toBe("snapshot A\n");
				expect(await readFile(join(root, "b.txt"), "utf8")).toBe("snapshot B\n");
				expect(await readFile(join(root, "excluded", "owner.txt"), "utf8")).toBe("KEEP EXTERNAL\n");
				expect(
					db
						.select()
						.from(schema.narratorMessageRefs)
						.where(eq(schema.narratorMessageRefs.narratorId, narratorId))
						.limit(1)
						.all(),
				).toHaveLength(0);
				const nativeReceipt = await backend.remoteHistory(
					"status",
					{
						binding: {
							...origin.binding,
							fence: registry.evidence.getScope(origin.binding.scopeId)?.fencingToken as number,
						},
						operationId: `workspace_restore:${preview.plan.id}`,
					},
					signal,
				);
				expect(nativeReceipt.state).toBe("finalized");
				expect(nativeReceipt.effects).toHaveLength(2);
			} finally {
				await native?.dispose();
				db.delete(schema.narrators).where(eq(schema.narrators.id, narratorId)).run();
				db.delete(schema.users).where(eq(schema.users.id, userId)).run();
				if (scenario.startsWith("cross_filesystem_"))
					await rm(root, { recursive: true, force: true });
				await rm(directory, { recursive: true, force: true });
			}
		},
		90_000,
	);
}
