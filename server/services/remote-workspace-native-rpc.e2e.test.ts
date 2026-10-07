import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RemoteHistoryBackend } from "@shared/remote-history-protocol";
import type { WorkspaceContext } from "@shared/workspace-context";
import { and, eq } from "drizzle-orm";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import * as schema from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { resolveBackend } from "../lib/agent/execution/registry";
import { editTool } from "../lib/agent/tools/edit";
import { structSedTool } from "../lib/agent/tools/struct-sed/tool";
import { writeTool } from "../lib/agent/tools/write";
import type { ToolContext, ToolResult } from "../lib/agent/types";
import { generateId } from "../lib/id";
import {
	boundedFixtureCommand,
	startNativeRemoteExecutorFixture,
} from "./__tests__/native-remote-executor-fixture";
import { createDevice } from "./device-service";
import { configureRemoteEditorAdapter } from "./editor-document-runtime";
import { type EditorActor, EditorDocumentService } from "./editor-document-service";
import { getDefaultLocalFileChangeRuntime } from "./file-change-runtime";
import { loadNarratorForAccess } from "./narrator-acl";
import { authorizeRemoteEditorBinding } from "./remote-editor-access";
import { SQLiteRemoteHistoryMetadataStore } from "./remote-history-journal";
import { remoteHistoryObjectId } from "./remote-history-service";
import {
	createRecordQualifiedRevertAccess,
	RemoteRevertTransactionProvider,
} from "./remote-revert-transaction";
import {
	authorizeRemoteHistoryTarget,
	createProductionRemoteEditorAdapter,
	RemoteWorkspaceHistoryRuntime,
	resolveProductionRemoteEditorRoot,
	withRemoteWorkspaceHistoryRuntime,
} from "./remote-workspace-history-runtime";
import { RevertPlannerLocalAccess } from "./revert-planner-local-access";
import { RevertPlannerService } from "./revert-planner-service";
import { RevertTransactionService } from "./revert-transaction-service";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function requireHistory(backend: ExecutionBackend): ExecutionBackend & RemoteHistoryBackend {
	if (backend.kind !== "remote" || !backend.remoteHistory)
		throw new Error("Real remote history backend required");
	return backend as ExecutionBackend & RemoteHistoryBackend;
}

/** One managed native child; no fake backend, mocked RPC response, production server or process restart. */
test.skipIf(process.platform !== "linux")(
	"H4 real Go reverse RPC: tool history, lost reply, human editor and scoped COW restore",
	async () => {
		expect(process.env.NARRAFORK_TEST).toBe("1");
		const directory = await mkdtemp(join(testEnvironment.isolatedHome, "native-history-rpc-"));
		const root = join(directory, "remote-repo");
		const hostDecoy = join(directory, "host-decoy");
		const userId = generateId();
		const narratorId = generateId();
		const viewerId = generateId();
		const now = () => new Date().toISOString();
		const deadline = AbortSignal.timeout(80_000);
		let fixture: Awaited<ReturnType<typeof startNativeRemoteExecutorFixture>> | undefined;
		let editor: EditorDocumentService | undefined;
		try {
			await mkdir(root);
			await mkdir(hostDecoy);
			for (const [name, content] of [
				["a.txt", "old\n"],
				["editor.txt", "editor before\n"],
				["lost.txt", "before lost\n"],
			]) {
				await writeFile(join(root, name), content, { mode: 0o600 });
				await writeFile(join(hostDecoy, name), `HOST DECOY ${name}\n`, { mode: 0o600 });
			}
			await boundedFixtureCommand(["git", "init", "--quiet", root]);
			db.insert(schema.users)
				.values({
					id: userId,
					username: `native-${userId}`,
					passwordHash: "fixture-not-a-credential",
					role: "user",
					createdAt: now(),
				})
				.run();
			const created = await createDevice({
				name: `Native H4 ${userId}`,
				connectionMode: "reverse",
				ownerScope: "private",
				scope: "global",
				createdBy: userId,
			});
			const deviceId = created.device.id;
			fixture = await startNativeRemoteExecutorFixture({
				directory,
				root,
				deviceId,
				token: created.token,
			});
			const native = requireHistory(fixture.backend);
			expect(native.supportsRemoteHistory).toBe(true);
			expect(fixture.hello?.platform.os).toBe("linux");
			expect(fixture.hello?.capabilities.shell).toBe(false);
			const workspace: WorkspaceContext = {
				revision: 0,
				contextKey: `native:${deviceId}:${root}`,
				deviceId,
				cwd: root,
				pathFlavor: "posix",
				capabilities: { switchDirectory: true },
			};
			for (const id of [narratorId, viewerId])
				db.insert(schema.narrators)
					.values({
						id,
						ownerUserId: userId,
						cwd: root,
						defaultDeviceId: deviceId,
						workspaceContext: workspace,
						permissionMode: "bypassPermissions",
						createdAt: now(),
						updatedAt: now(),
					})
					.run();
			const auditRuntime = await getDefaultLocalFileChangeRuntime();
			const registry = new RemoteWorkspaceHistoryRuntime({
				db,
				auditRuntime,
				backend: (id) => resolveBackend({ requested: id }),
				authorize: authorizeRemoteHistoryTarget,
				metadataStore: new SQLiteRemoteHistoryMetadataStore(db),
			});
			const principal = { userId, isAdmin: false };
			let seq = 0;
			async function context(
				name: "Write" | "Edit" | "StructSed",
				file = "a.txt",
				signal: AbortSignal = deadline,
			) {
				const toolId = generateId();
				const messageId = generateId();
				const refId = generateId();
				const path = join(root, file);
				db.insert(schema.narratorMessages)
					.values({
						id: messageId,
						narratorId,
						role: "assistant",
						contentJson: [
							{ type: "text", text: "retained explanation" },
							{ type: "tool_use", id: toolId, name, input: {} },
						],
						createdAt: now(),
					})
					.run();
				db.insert(schema.narratorMessageRefs)
					.values({ id: refId, narratorId, messageId, seq: ++seq })
					.run();
				db.insert(schema.narratorToolCalls)
					.values({
						id: toolId,
						messageId,
						narratorId,
						toolUseId: toolId,
						toolName: name,
						status: "running",
						executionIdentityVersion: 1,
						executionAttempt: 1,
						executionStartedAt: now(),
						executionDeviceId: deviceId,
						executionCwd: root,
						executionPathFlavor: "posix",
						resolvedFilePath: path,
						canonicalFilePath: path,
						runtimeGeneration: native.runtimeGeneration,
						createdAt: now(),
					})
					.run();
				const ctx: ToolContext = {
					narratorId,
					userId,
					cwd: hostDecoy,
					locale: "en",
					signal,
					workspaceContext: workspace,
					currentToolUseId: toolId,
					toolCallBinding: { toolCallId: toolId, attempt: 1 },
					executionTarget: {
						deviceId,
						backendKind: "remote",
						cwd: root,
						lexicalPath: path,
						canonicalPath: path,
						pathFlavor: "posix",
						runtimeGeneration: native.runtimeGeneration,
						selectionSource: "explicit",
					},
					resolveBackend: () => native,
					recordFileNoDispatch: async () => {
						throw new Error("Expected a real native mutation");
					},
					requestPermission: async () => ({ behavior: "allow" }),
				};
				return { ctx, messageId, toolId, refId };
			}
			function settle(toolId: string, result: ToolResult) {
				if (result.isError) {
					fixture?.assertHealthy();
					throw new Error(
						`${result.output}\nWire trace: ${JSON.stringify(fixture?.trace.slice(-8))}\nNative log: ${fixture?.logs.slice(-4096)}`,
					);
				}
				db.update(schema.narratorToolCalls)
					.set({ status: "success", outputJson: result.metadata ?? {}, completedAt: now() })
					.where(eq(schema.narratorToolCalls.id, toolId))
					.run();
			}
			const lostReceipt = await withRemoteWorkspaceHistoryRuntime(registry, async () => {
				const write = await context("Write");
				settle(
					write.toolId,
					await writeTool.execute({ file_path: "a.txt", content: "written\n" }, write.ctx),
				);
				expect(await readFile(join(root, "a.txt"), "utf8")).toBe("written\n");
				const edit = await context("Edit");
				settle(
					edit.toolId,
					await editTool.execute(
						{ file_path: "a.txt", old_string: "written", new_string: "edited" },
						edit.ctx,
					),
				);
				expect(await readFile(join(root, "a.txt"), "utf8")).toBe("edited\n");
				const structured = await context("StructSed");
				settle(
					structured.toolId,
					await structSedTool.execute(
						{
							file_path: "a.txt",
							command: "substitute",
							address: "1",
							pattern: "edited",
							replacement: "structured",
							dry_run: false,
						},
						structured.ctx,
					),
				);
				expect(await readFile(join(root, "a.txt"), "utf8")).toBe("structured\n");
				expect(await readFile(join(hostDecoy, "a.txt"), "utf8")).toBe("HOST DECOY a.txt\n");
				const operations = db
					.select()
					.from(schema.fileChangeOperations)
					.where(eq(schema.fileChangeOperations.narratorId, narratorId))
					.limit(8)
					.all();
				expect(operations).toHaveLength(3);
				for (const operation of operations) {
					expect(operation.settlement).toBe("settled");
					const effect = registry.evidence.listEffects(operation.id, { limit: 2 }).items;
					expect(effect).toHaveLength(1);
					expect(effect[0].identityJson.deviceId).toBe(deviceId);
					expect(effect[0].identityJson.canonicalPath).toBe(join(root, "a.txt"));
					expect(effect[0].identityJson.sourceInstanceId).toBe(operation.sourceInstanceId);
					expect(effect[0].attributionGrade).toBe("measured");
					expect(effect[0].executionConfirmed).toBe(true);
				}
				const receipts = db
					.select()
					.from(schema.remoteHistoryReceipts)
					.where(eq(schema.remoteHistoryReceipts.deviceId, deviceId))
					.limit(8)
					.all();
				expect(receipts).toHaveLength(3);
				for (const row of receipts) {
					expect(row.state).toBe("finalized");
					if (!row.receiptJson) throw new Error("Missing actual native receipt");
					const actual = await native.remoteHistory(
						"status",
						{ binding: row.receiptJson.binding, operationId: row.operationId },
						deadline,
					);
					expect(actual.state).toBe("finalized");
					expect(actual.requestDigest).toBe(row.requestDigest);
					expect(actual.serverCommitId ?? null).toBe(row.serverCommitId);
				}
				const audit = await registry.auditNamespace(deadline);
				const firstEffect = registry.evidence.listEffects(operations[0].id, { limit: 1 }).items[0];
				if (firstEffect.beforeStateJson.kind !== "regular")
					throw new Error("Missing original audit blob");
				expect(
					Buffer.from(
						await audit.store.readBytes(firstEffect.beforeStateJson.blob, { signal: deadline }),
					).toString(),
				).toBe("old\n");
				expect(
					db
						.select()
						.from(schema.remoteHistoryObjects)
						.where(eq(schema.remoteHistoryObjects.deviceId, deviceId))
						.limit(32)
						.all()
						.every((row) => row.placement === "remote" && row.originPath === "a.txt"),
				).toBe(true);

				// Native scope identity and object chunks are served by the actual Go manager.
				const probe = await native.remoteHistory(
					"open",
					{ root, scopeId: `probe-${randomUUID()}`, fence: 1 },
					deadline,
				);
				const inspected = await native.remoteHistory(
					"inspect",
					{ binding: probe, paths: ["a.txt"] },
					deadline,
				);
				const state = inspected.observations[0]?.state;
				if (!state || state.kind !== "regular")
					throw new Error("Native inspection did not return a regular file");
				expect(state.metadata).toBeDefined();
				expect(state.incarnation).toBeTruthy();
				const chunks: Uint8Array[] = [];
				let offset = 0;
				for (let count = 0; count < 8 && offset < state.object.sizeBytes; count++) {
					const chunk = await native.remoteHistory(
						"objectRead",
						{ binding: probe, object: state.object, offset, maxBytes: 3 },
						deadline,
					);
					const bytes = Buffer.from(chunk.contentBase64, "base64");
					expect(bytes.byteLength).toBeLessThanOrEqual(3);
					expect(chunk.offset).toBe(offset);
					expect(chunk.object.sourceInstanceId).toBe(probe.sourceInstanceId);
					chunks.push(bytes);
					offset += bytes.byteLength;
					expect(chunk.eof).toBe(offset === state.object.sizeBytes);
				}
				expect(Buffer.concat(chunks).toString()).toBe("structured\n");
				expect(hash(Buffer.concat(chunks))).toBe(state.object.digest);
				await expect(
					native.remoteHistory(
						"objectRead",
						{
							binding: probe,
							object: { ...state.object, path: "editor.txt" },
							offset: 0,
							maxBytes: 3,
						},
						deadline,
					),
				).rejects.toThrow();
				const privateMarker = join(directory, "executor-private", "history", "source.json");
				expect(JSON.parse(await readFile(privateMarker, "utf8")).sourceInstanceId).toBe(
					probe.sourceInstanceId,
				);
				await expect(
					native.readFileBytes(privateMarker, { maxBytes: 1024, signal: deadline }),
				).rejects.toThrow();
				for (const invalid of [
					{ ...probe, sourceInstanceId: hash("different but well-formed source identity") },
					{ ...probe, workspaceInstanceId: hash("different but well-formed workspace identity") },
					{ ...probe, rootIdentity: "another-root" },
					{ ...probe, root: hostDecoy },
				])
					await expect(
						native.remoteHistory("inspect", { binding: invalid, paths: ["a.txt"] }, deadline),
					).rejects.toThrow();
				const advanced = await native.remoteHistory(
					"open",
					{ root, scopeId: probe.scopeId, fence: 2 },
					deadline,
				);
				expect(advanced.sourceInstanceId).toBe(probe.sourceInstanceId);
				// Historical reads may retain an original proof, but an old fence never grants new mutation.
				await expect(
					native.remoteHistory(
						"mutate",
						{
							binding: probe,
							operationId: `stale-fence-${randomUUID()}`,
							requestDigest: hash("valid change under stale native fence"),
							changes: [
								{
									path: "a.txt",
									expected: state,
									desired: {
										kind: "regular",
										object: state.object,
										metadata: state.metadata,
										mode: state.mode,
									},
								},
							],
						},
						deadline,
					),
				).rejects.toThrow();
				expect(await readFile(join(root, "a.txt"), "utf8")).toBe("structured\n");
				await expect(
					native.readFileBytes(join(hostDecoy, "a.txt"), { maxBytes: 1024, signal: deadline }),
				).rejects.toThrow();

				// Shared message history forces real COW; only the selected live owner ref changes.
				const originalMessage = db
					.select()
					.from(schema.narratorMessages)
					.where(eq(schema.narratorMessages.id, structured.messageId))
					.get();
				db.insert(schema.narratorMessageRefs)
					.values({
						id: generateId(),
						narratorId: viewerId,
						messageId: structured.messageId,
						seq: 1,
					})
					.run();
				const access = createRecordQualifiedRevertAccess(new RevertPlannerLocalAccess(), registry);
				const namespaceKey = audit.catalog.getBudget()?.namespaceKey;
				if (!namespaceKey) throw new Error("Missing real private audit namespace");
				const planner = new RevertPlannerService(db, {
					access,
					blobStore: audit.store,
					blobCatalog: audit.catalog,
					generation: audit.generation,
					planOptions: { namespaceKey },
				});
				const preview = await planner.prepare({
					principal,
					narratorId,
					expectedMessageVersion: 0,
					idempotencyKey: generateId(),
					kind: "history_delete",
					revertScope: "narrator",
					selector: { kind: "tool_calls", toolCallIds: [structured.toolId] },
					uiAction: "delete_tool_block",
					signal: deadline,
				});
				expect(preview.plan.expectedFileCount).toBe(1);
				const laterCwd = join(root, "later-cwd");
				await mkdir(laterCwd);
				// A committed workspace binding may change after preview; the record-qualified restore must not follow it.
				db.update(schema.narrators)
					.set({
						cwd: laterCwd,
						workspaceRevision: 1,
						workspaceContext: {
							...workspace,
							cwd: laterCwd,
							revision: 1,
							contextKey: `${workspace.contextKey}:later`,
						},
					})
					.where(eq(schema.narrators.id, narratorId))
					.run();
				const transaction = new RevertTransactionService(db, {
					access,
					runtime: auditRuntime,
					namespace: audit,
					planOptions: { namespaceKey },
					coordinator: registry.coordinator,
					provider: new RemoteRevertTransactionProvider(registry),
					readRuntime: (id) => registry.runtimeBinding(id),
				});
				const restored = await transaction.execute({
					principal,
					narratorId,
					planId: preview.plan.id,
					planHash: preview.plan.planHash as string,
					action: "delete_tool_block",
					signal: deadline,
				}).whenSettled;
				expect(restored.status).toBe("committed");
				expect(await readFile(join(root, "a.txt"), "utf8")).toBe("edited\n");
				expect(await native.statFile(join(laterCwd, "a.txt"), { signal: deadline })).toBeNull();
				const liveRef = db
					.select()
					.from(schema.narratorMessageRefs)
					.where(eq(schema.narratorMessageRefs.id, structured.refId))
					.get();
				expect(liveRef?.messageId).not.toBe(structured.messageId);
				const clone = db
					.select()
					.from(schema.narratorMessages)
					.where(eq(schema.narratorMessages.id, liveRef?.messageId ?? "missing"))
					.get();
				expect(clone?.contentJson).toEqual([{ type: "text", text: "retained explanation" }]);
				expect(
					db
						.select()
						.from(schema.narratorMessages)
						.where(eq(schema.narratorMessages.id, structured.messageId))
						.get()?.contentJson,
				).toEqual(originalMessage?.contentJson);
				expect(
					db
						.select()
						.from(schema.narratorMessageRefs)
						.where(eq(schema.narratorMessageRefs.narratorId, viewerId))
						.get()?.messageId,
				).toBe(structured.messageId);
				expect(
					db.select().from(schema.narrators).where(eq(schema.narrators.id, viewerId)).get()
						?.messageVersion,
				).toBe(0);
				const nativeRestore = db
					.select()
					.from(schema.remoteHistoryReceipts)
					.where(
						and(
							eq(schema.remoteHistoryReceipts.deviceId, deviceId),
							eq(schema.remoteHistoryReceipts.kind, "restore"),
						),
					)
					.limit(2)
					.all();
				expect(nativeRestore).toHaveLength(1);
				if (nativeRestore[0].state !== "finalized") {
					const received = nativeRestore[0].receiptJson;
					const actual = received
						? await native.remoteHistory(
								"status",
								{ binding: received.binding, operationId: received.operationId },
								deadline,
							)
						: undefined;
					throw new Error(
						`Single-file positive finalize regressed: server=${nativeRestore[0].state}, native=${actual?.state}; native errors=${JSON.stringify(fixture?.rpcErrors.slice(-6))}`,
					);
				}
				expect(nativeRestore[0].state).toBe("finalized");
				expect(nativeRestore[0].serverCommitId).toBe(preview.plan.id);

				// Return to the original directory as a NEW revision, never roll the logical workspace clock backwards.
				workspace.revision = 2;
				workspace.contextKey = `${workspace.contextKey}:returned`;
				db.update(schema.narrators)
					.set({ cwd: root, workspaceRevision: workspace.revision, workspaceContext: workspace })
					.where(eq(schema.narrators.id, narratorId))
					.run();
				await verifyNativeModeTransform();
				// Two selected paths share one native scope; a file-by-file pending receipt must not block file two.
				const pairA = await context("Write", "a.txt");
				settle(
					pairA.toolId,
					await writeTool.execute({ file_path: "a.txt", content: "pair A\n" }, pairA.ctx),
				);
				const pairB = await context("Write", "editor.txt");
				settle(
					pairB.toolId,
					await writeTool.execute({ file_path: "editor.txt", content: "pair B\n" }, pairB.ctx),
				);
				const pairVersion = db
					.select({ version: schema.narrators.messageVersion })
					.from(schema.narrators)
					.where(eq(schema.narrators.id, narratorId))
					.get()?.version;
				if (pairVersion === undefined) throw new Error("Missing live pair history version");
				const pairSeq = db
					.select({ seq: schema.narratorMessageRefs.seq })
					.from(schema.narratorMessageRefs)
					.where(eq(schema.narratorMessageRefs.id, pairA.refId))
					.get()?.seq;
				if (pairSeq === undefined) throw new Error("Missing bounded pair history sequence");
				const pairPlan = await planner.prepare({
					principal,
					narratorId,
					expectedMessageVersion: pairVersion,
					idempotencyKey: generateId(),
					kind: "revert",
					revertScope: "narrator",
					selector: { kind: "from_seq", minSeq: pairSeq },
					uiAction: "revert_files",
					signal: deadline,
				});
				expect(pairPlan.plan.expectedFileCount).toBe(2);
				const pairResult = await transaction.execute({
					principal,
					narratorId,
					planId: pairPlan.plan.id,
					planHash: pairPlan.plan.planHash as string,
					action: "revert_files",
					signal: deadline,
				}).whenSettled;
				if (pairResult.status !== "committed")
					throw new Error(
						`Actual two-file restore failed: ${pairResult.status}; native errors=${JSON.stringify(fixture?.rpcErrors.slice(-6))}; wire=${JSON.stringify(fixture?.trace.slice(-12))}`,
					);
				expect(pairResult.status).toBe("committed");
				expect(await readFile(join(root, "a.txt"), "utf8")).toBe("edited\n");
				expect(await readFile(join(root, "editor.txt"), "utf8")).toBe("editor before\n");
				const pairNative = db
					.select()
					.from(schema.remoteHistoryReceipts)
					.where(
						and(
							eq(schema.remoteHistoryReceipts.deviceId, deviceId),
							eq(schema.remoteHistoryReceipts.kind, "restore"),
							eq(schema.remoteHistoryReceipts.serverCommitId, pairPlan.plan.id),
						),
					)
					.limit(3)
					.all();
				expect(pairNative).toHaveLength(1);
				expect(pairNative[0].receiptJson?.effects).toHaveLength(2);
				expect(pairNative[0].state).toBe("finalized");

				async function verifyNativeModeTransform() {
					// Explicit native metadata mode transform must retain owner/xattrs while updating the opaque metadata object.
					const modeInspection = await native.remoteHistory(
						"inspect",
						{ binding: advanced, paths: ["editor.txt"] },
						deadline,
					);
					const modeBefore = modeInspection.observations[0]?.state;
					if (!modeBefore || modeBefore.kind !== "regular" || !modeBefore.metadata)
						throw new Error("Native mode before-state metadata unavailable");
					expect(modeBefore.mode).toBe(0o600);
					const originalMetadata = await native.remoteHistory(
						"objectRead",
						{ binding: advanced, object: modeBefore.metadata, offset: 0, maxBytes: 4096 },
						deadline,
					);
					expect(originalMetadata.eof).toBe(true);
					const modeOperation = `mode-${randomUUID()}`;
					const modeDigest = hash(`mode 0600 to 0640 ${modeOperation}`);
					const modeReceipt = await native.remoteHistory(
						"mutate",
						{
							binding: advanced,
							operationId: modeOperation,
							requestDigest: modeDigest,
							changes: [
								{
									path: "editor.txt",
									expected: modeBefore,
									desired: {
										kind: "regular",
										object: modeBefore.object,
										metadata: modeBefore.metadata,
										mode: 0o640,
									},
								},
							],
						},
						deadline,
					);
					const modeAfter = modeReceipt.effects[0]?.after;
					if (!modeAfter || modeAfter.kind !== "regular" || !modeAfter.metadata)
						throw new Error("Native mode result is missing actual metadata");
					expect(modeAfter.mode).toBe(0o640);
					expect(modeAfter.metadata.digest).not.toBe(modeBefore.metadata.digest);
					const transformed = await native.remoteHistory(
						"objectRead",
						{ binding: advanced, object: modeAfter.metadata, offset: 0, maxBytes: 4096 },
						deadline,
					);
					const originalNative = JSON.parse(
						Buffer.from(originalMetadata.contentBase64, "base64").toString(),
					);
					const transformedNative = JSON.parse(
						Buffer.from(transformed.contentBase64, "base64").toString(),
					);
					expect(transformed.eof).toBe(true);
					expect(transformedNative.mode).toBe(0o640);
					expect(transformedNative.uid).toBe(originalNative.uid);
					expect(transformedNative.gid).toBe(originalNative.gid);
					expect(transformedNative.attrs).toEqual(originalNative.attrs);
					await native.remoteHistory(
						"finalize",
						{
							binding: advanced,
							operationId: modeOperation,
							requestDigest: modeDigest,
							serverCommitId: "native-fixture-mode-proof",
						},
						deadline,
					);
				}

				// Full production editor adapter and human ACL factory; ordinary AI readOnly must not veto a human save.
				db.update(schema.narrators)
					.set({ permissionMode: "readOnly" })
					.where(eq(schema.narrators.id, narratorId))
					.run();
				const remote = createProductionRemoteEditorAdapter();
				configureRemoteEditorAdapter(remote, resolveProductionRemoteEditorRoot);
				const actor: EditorActor = {
					userId,
					narratorId,
					authorize: (input, need) =>
						authorizeRemoteEditorBinding(actor, workspace, input, need, {
							signal: deadline,
							authorizationGuard: async (required) => {
								await loadNarratorForAccess(narratorId, principal, required);
								const current = db
									.select({
										workspaceContext: schema.narrators.workspaceContext,
										revision: schema.narrators.workspaceRevision,
									})
									.from(schema.narrators)
									.where(eq(schema.narrators.id, narratorId))
									.get();
								if (
									current?.revision !== workspace.revision ||
									current.workspaceContext?.contextKey !== workspace.contextKey
								)
									throw new Error("Frozen editor workspace changed");
							},
						}),
				};
				editor = new EditorDocumentService({
					root: join(directory, "editor-private"),
					remote,
					execute: async () => {
						throw new Error("Remote human editor must never use local target IO");
					},
				});
				const doc = await editor.create(actor, { path: "editor.txt", deviceId, origin: "legacy" });
				expect(doc.editable).toBe(true);
				expect(
					await new Response(await editor.content(actor, doc.docId, doc.versionHandle)).text(),
				).toBe("editor before\n");
				const upload = await editor.createUpload(actor, doc.docId, {
					baseHash: doc.baseHash,
					encoding: doc.encoding,
					snapshotRevision: 3,
				});
				const humanBytes = new TextEncoder().encode("saved by human\n");
				await editor.put(
					actor,
					doc.docId,
					upload.uploadId,
					new Response(humanBytes).body,
					humanBytes.byteLength,
				);
				const saved = await editor.commit(actor, doc.docId, upload.uploadId, {});
				expect(saved.status).toBe("saved");
				expect(await readFile(join(root, "editor.txt"), "utf8")).toBe("saved by human\n");
				expect(await readFile(join(hostDecoy, "editor.txt"), "utf8")).toBe(
					"HOST DECOY editor.txt\n",
				);
				const human = db
					.select()
					.from(schema.fileChangeOperations)
					.where(
						and(
							eq(schema.fileChangeOperations.narratorId, narratorId),
							eq(schema.fileChangeOperations.sourceKind, "editor"),
						),
					)
					.limit(2)
					.all();
				expect(human).toHaveLength(1);
				expect(human[0].ownerUserId).toBe(userId);
				expect(human[0].settlement).toBe("settled");
				expect(await editor.commit(actor, doc.docId, upload.uploadId, {})).toEqual(saved);
				await editor.remove(actor, doc.docId);

				// Discard only the actual Go response. The private receipt and physical bytes already exist.
				db.update(schema.narrators)
					.set({ permissionMode: "bypassPermissions" })
					.where(eq(schema.narrators.id, narratorId))
					.run();
				fixture?.dropNextMutationReply();
				const lost = await context("Write", "lost.txt", AbortSignal.timeout(1200));
				const uncertain = await writeTool.execute(
					{ file_path: "lost.txt", content: "applied once despite lost reply\n" },
					lost.ctx,
				);
				expect(uncertain.isError).toBe(true);
				const durable = fixture?.droppedReceipt;
				if (!durable)
					throw new Error("No actual native reply was lost; refusing a fake recovery assertion");
				expect(await readFile(join(root, "lost.txt"), "utf8")).toBe(
					"applied once despite lost reply\n",
				);
				const status = await native.remoteHistory(
					"status",
					{ binding: durable.binding, operationId: durable.operationId },
					deadline,
				);
				expect(status.operationId).toBe(durable.operationId);
				expect(status.requestDigest).toBe(durable.requestDigest);
				expect(status.state).toBe("settled");
				expect(status.effects[0].after?.kind).toBe("regular");
				const unknown = db
					.select()
					.from(schema.remoteHistoryReceipts)
					.where(
						and(
							eq(schema.remoteHistoryReceipts.deviceId, deviceId),
							eq(schema.remoteHistoryReceipts.operationId, durable.operationId),
						),
					)
					.get();
				expect(unknown?.state).toBe("unknown");
				expect(
					fixture?.trace.filter(
						(entry) =>
							entry.method === "history.mutate" && entry.operationId === durable.operationId,
					),
				).toHaveLength(1);
				expect(await readFile(join(hostDecoy, "lost.txt"), "utf8")).toBe("HOST DECOY lost.txt\n");
				return durable;
			});
			fixture.assertHealthy();
			expect(fixture.trace.some((entry) => entry.method === "history.restore")).toBe(true);
			expect(fixture.trace.some((entry) => entry.method === "history.objectRead")).toBe(true);
			expect(fixture.trace.some((entry) => entry.method === "history.finalize")).toBe(true);
			expect(
				fixture.trace.some(
					(entry) =>
						entry.method === "fs.write" ||
						entry.method === "fs.writeConditional" ||
						entry.method.startsWith("exec."),
				),
			).toBe(false);
			expect(
				fixture.trace
					.filter((entry) =>
						[
							"history.mutate",
							"history.restore",
							"history.finalize",
							"history.objectStage",
						].includes(entry.method),
					)
					.every((entry) => entry.root === root),
			).toBe(true);
			if (!lostReceipt) throw new Error("Missing real lost-reply receipt before native restart");
			const reopened = requireHistory(await fixture.restartFixtureChild());
			expect(reopened.runtimeGeneration).not.toBe(native.runtimeGeneration);
			const persisted = await reopened.remoteHistory(
				"status",
				{ binding: lostReceipt.binding, operationId: lostReceipt.operationId },
				deadline,
			);
			expect(persisted.operationId).toBe(lostReceipt.operationId);
			expect(persisted.requestDigest).toBe(lostReceipt.requestDigest);
			expect(persisted.binding.sourceInstanceId).toBe(lostReceipt.binding.sourceInstanceId);
			expect(persisted.binding.rootIdentity).toBe(lostReceipt.binding.rootIdentity);
			expect(persisted.state).toBe("settled");
			expect(await readFile(join(root, "lost.txt"), "utf8")).toBe(
				"applied once despite lost reply\n",
			);
			expect(
				fixture.trace.filter(
					(entry) =>
						entry.method === "history.mutate" && entry.operationId === lostReceipt?.operationId,
				),
			).toHaveLength(1);
			await expect(native.statFile(join(root, "a.txt"), { signal: deadline })).rejects.toThrow();
			const legacy = requireHistory(await fixture.advertiseLegacyHistory());
			const count = fixture.trace.length;
			expect(legacy.supportsRemoteHistory).toBe(false);
			await expect(
				legacy.remoteHistory("open", { root, scopeId: "legacy-unsupported", fence: 1 }, deadline),
			).rejects.toThrow("upgrade required");
			expect(fixture.trace).toHaveLength(count);
			await expect(native.statFile(join(root, "a.txt"), { signal: deadline })).rejects.toThrow();
			fixture.assertHealthy();
		} finally {
			await editor?.dispose();
			await fixture?.dispose();
			await rm(directory, { recursive: true, force: true });
		}
	},
	90_000,
);

// Kept independent from application restore batching: a controller regression cannot hide durable restart proof.
test.skipIf(process.platform !== "linux")(
	"H4 native lost-reply receipt survives fixture process restart and same-ID finalization",
	async () => {
		const directory = await mkdtemp(join(testEnvironment.isolatedHome, "native-restart-rpc-"));
		const root = join(directory, "remote-root");
		let fixture: Awaited<ReturnType<typeof startNativeRemoteExecutorFixture>> | undefined;
		try {
			await mkdir(root);
			await writeFile(join(root, "a.txt"), "before\n", { mode: 0o600 });
			await writeFile(join(root, "b.txt"), "untouched\n", { mode: 0o600 });
			const userId = generateId();
			db.insert(schema.users)
				.values({
					id: userId,
					username: `restart-${userId}`,
					passwordHash: "fixture-not-a-credential",
					role: "user",
					createdAt: new Date().toISOString(),
				})
				.run();
			const device = await createDevice({
				name: `Native restart ${userId}`,
				connectionMode: "reverse",
				ownerScope: "private",
				scope: "global",
				createdBy: userId,
			});
			fixture = await startNativeRemoteExecutorFixture({
				directory,
				root,
				deviceId: device.device.id,
				token: device.token,
			});
			const backend = requireHistory(fixture.backend);
			const signal = AbortSignal.timeout(30_000);
			const binding = await backend.remoteHistory(
				"open",
				{ root, scopeId: generateId(), fence: 1 },
				signal,
			);
			const inspected = await backend.remoteHistory(
				"inspect",
				{ binding, paths: ["a.txt"] },
				signal,
			);
			const before = inspected.observations[0]?.state;
			if (!before || before.kind !== "regular")
				throw new Error("Missing actual native before-state");
			const next = Buffer.from("native persisted despite reply loss\n");
			const digest = hash(next);
			const operationId = generateId();
			const requestDigest = hash(`native restart ${operationId}`);
			fixture.dropNextMutationReply();
			await expect(
				backend.remoteHistory(
					"mutate",
					{
						binding,
						operationId,
						requestDigest,
						changes: [
							{
								path: "a.txt",
								expected: before,
								desired: {
									kind: "regular",
									mode: before.mode,
									object: {
										...before.object,
										objectId: remoteHistoryObjectId(binding.scopeId, "blob", digest, "a.txt"),
										digest,
										sizeBytes: next.byteLength,
									},
								},
								contentBase64: next.toString("base64"),
							},
						],
					},
					AbortSignal.timeout(400),
				),
			).rejects.toThrow("RPC aborted");
			expect(fixture.droppedReceipt?.operationId).toBe(operationId);
			expect(await readFile(join(root, "a.txt"), "utf8")).toBe(next.toString());
			const reopened = requireHistory(await fixture.restartFixtureChild());
			expect(reopened.runtimeGeneration).not.toBe(backend.runtimeGeneration);
			const recovered = await reopened.remoteHistory("status", { binding, operationId }, signal);
			expect(recovered.operationId).toBe(operationId);
			expect(recovered.requestDigest).toBe(requestDigest);
			expect(recovered.binding).toEqual(binding);
			expect(recovered.state).toBe("settled");
			expect(recovered.effects[0].after?.kind).toBe("regular");
			const finalized = await reopened.remoteHistory(
				"finalize",
				{ binding, operationId, requestDigest, serverCommitId: "native-restart-fixture-proof" },
				signal,
			);
			expect(finalized.state).toBe("finalized");
			expect((await reopened.remoteHistory("status", { binding, operationId }, signal)).state).toBe(
				"finalized",
			);
			expect(
				fixture.trace.filter(
					(entry) => entry.method === "history.mutate" && entry.operationId === operationId,
				),
			).toHaveLength(1);
			expect(await readFile(join(root, "b.txt"), "utf8")).toBe("untouched\n");
			await expect(backend.statFile(join(root, "a.txt"), { signal })).rejects.toThrow("changed");
			fixture.assertHealthy();
		} finally {
			await fixture?.dispose();
			await rm(directory, { recursive: true, force: true });
		}
	},
	60_000,
);
