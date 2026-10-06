import { expect, mock, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import {
	fileAttributions,
	fileChangeBlobs,
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopes,
	fileChangeStorageBudgets,
	narratorFileSnapshots,
	narratorMessages,
	narrators,
	narratorToolCalls,
	workspaceWriteLeases,
} from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import { editTool } from "../lib/agent/tools/edit";
import { writeTool } from "../lib/agent/tools/write";
import type { ToolContext, ToolExecutionTarget } from "../lib/agent/types";
import { generateId } from "../lib/id";
import { getNarraforkHome } from "../lib/narrafork-home";
import { FILE_CHANGE_BLOB_BUDGET_ID } from "./file-change-blob-catalog";
import { localFileChangeRuntimeBinding } from "./file-change-runtime";

/**
 * Deliberately exercises the application DB and default runtime created by Write/Edit.
 * tests/preload owns this disposable HOME/database. No withLocalFileChangeRuntime,
 * test coordinator, catalog, quota override, or execution-backend resolver is injected.
 */
test.skipIf(process.platform === "win32")(
	"default Write/Edit accepts protected 0775 appdata and ignores a stale hotSafe runtime",
	async () => {
		expect(process.env.NARRAFORK_TEST).toBe("1");
		const uid = process.geteuid?.();
		if (uid === undefined) throw new Error("POSIX default-runtime test requires an effective uid");
		const home = await realpath(testEnvironment.isolatedHome);
		const data = await realpath(getNarraforkHome());
		// Refuse permissions changes outside the preload-owned, canonical sandbox.
		expect(data).toBe(join(home, ".narrafork"));
		expect(data).not.toBe(resolve(testEnvironment.realNarraforkHome));
		const [homeBefore, dataBefore] = await Promise.all([lstat(home), lstat(data)]);
		const staleKey = Symbol.for("narrafork.local-file-change-runtime.default.v1");
		const previousStale = Object.getOwnPropertyDescriptor(globalThis, staleKey);
		const rejectedOldRuntime = {
			execute: mock(async () => {
				throw new Error("Previous module generation cached a rejected initialization");
			}),
		};
		const narratorId = generateId();
		const messageIds: string[] = [];
		const toolCallIds: string[] = [];
		let workspace: string | undefined;
		try {
			await chmod(home, 0o700);
			await chmod(data, 0o775);
			Object.defineProperty(globalThis, staleKey, {
				value: rejectedOldRuntime,
				configurable: true,
				writable: true,
			});
			workspace = await mkdtemp(join(home, "default-runtime-workspace-"));
			const timestamp = new Date().toISOString();
			db.insert(narrators)
				.values({
					id: narratorId,
					title: "Default-runtime fixture",
					createdAt: timestamp,
					updatedAt: timestamp,
				})
				.run();
			const filePath = join(workspace, "default.txt");
			const runtimeBefore = localFileChangeRuntimeBinding();

			async function context(toolName: "Write" | "Edit"): Promise<ToolContext> {
				if (!workspace) throw new Error("Default-runtime workspace was not created");
				const path = await localBackend.resolvePathIdentity(filePath);
				const target: ToolExecutionTarget = Object.freeze({
					deviceId: "local",
					backendKind: "local",
					cwd: workspace,
					pathFlavor: localBackend.pathFlavor,
					lexicalPath: path.lexicalPath,
					canonicalPath: path.canonicalPath,
					runtimeGeneration: localBackend.runtimeGeneration,
					selectionSource: "local_default",
				});
				const messageId = generateId();
				const toolCallId = generateId();
				const toolUseId = generateId();
				messageIds.push(messageId);
				toolCallIds.push(toolCallId);
				db.insert(narratorMessages)
					.values({
						id: messageId,
						narratorId,
						role: "assistant",
						contentJson: [],
						createdAt: timestamp,
					})
					.run();
				db.insert(narratorToolCalls)
					.values({
						id: toolCallId,
						narratorId,
						messageId,
						toolUseId,
						toolName,
						status: "running",
						executionStartedAt: timestamp,
						executionIdentityVersion: 1,
						executionAttempt: 1,
						executionDeviceId: target.deviceId,
						executionCwd: workspace,
						executionPathFlavor: target.pathFlavor,
						resolvedFilePath: target.lexicalPath,
						canonicalFilePath: target.canonicalPath,
						runtimeGeneration: target.runtimeGeneration,
						createdAt: timestamp,
					})
					.run();
				return {
					narratorId,
					cwd: workspace,
					locale: "en",
					signal: new AbortController().signal,
					currentToolUseId: toolUseId,
					toolCallBinding: Object.freeze({ toolCallId, attempt: 1 }),
					executionTarget: target,
					requestPermission: async () => ({ behavior: "allow" }),
				};
			}

			const created = await writeTool.execute(
				{ file_path: filePath, content: "original\r\n" },
				await context("Write"),
			);
			expect(created).toMatchObject({
				output: `Wrote 10 bytes to ${filePath}`,
				metadata: {
					fileChangeEvidence: { version: 2, grade: "measured", settlement: "settled" },
				},
			});
			expect(created.isError).not.toBe(true);
			expect(await readFile(filePath, "utf8")).toBe("original\r\n");
			const sourcePath = join(data, "file-change-source.json");
			const sourceAfterWrite = await readFile(sourcePath);
			const budgetAfterWrite = db
				.select()
				.from(fileChangeStorageBudgets)
				.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
				.get();
			expect(budgetAfterWrite?.status).toBe("ready");

			const edited = await editTool.execute(
				{ file_path: filePath, old_string: "original", new_string: "edited" },
				await context("Edit"),
			);
			expect(edited).toMatchObject({
				output: `Edited ${filePath}`,
				metadata: {
					linesAdded: 1,
					linesRemoved: 1,
					fileChangeEvidence: { version: 2, grade: "measured", settlement: "settled" },
				},
			});
			expect(edited.isError).not.toBe(true);
			expect(await readFile(filePath, "utf8")).toBe("edited\r\n");
			expect(rejectedOldRuntime.execute).not.toHaveBeenCalled();
			expect(Object.getOwnPropertyDescriptor(globalThis, staleKey)?.value).toBe(rejectedOldRuntime);
			expect(localFileChangeRuntimeBinding()).toBe(runtimeBefore);

			const operations = db
				.select()
				.from(fileChangeOperations)
				.where(eq(fileChangeOperations.narratorId, narratorId))
				.limit(3)
				.all();
			expect(operations).toHaveLength(2);
			const operationIds = operations.map((operation) => operation.id);
			const effects = db
				.select()
				.from(fileChangeEffects)
				.where(inArray(fileChangeEffects.operationId, operationIds))
				.limit(3)
				.all();
			expect(effects).toHaveLength(2);
			for (const operation of operations) {
				expect(operation).toMatchObject({
					evidenceVersion: 2,
					attempt: 1,
					settlement: "settled",
					executionOutcome: "succeeded",
					expectedEffectCount: 1,
					settledEffectCount: 1,
				});
				if (!operation.toolCallId) throw new Error("Missing real tool-call PK");
				expect(toolCallIds).toContain(operation.toolCallId);
				expect(
					db
						.select({ operationId: narratorToolCalls.fileChangeOperationId })
						.from(narratorToolCalls)
						.where(eq(narratorToolCalls.id, operation.toolCallId))
						.get()?.operationId,
				).toBe(operation.id);
			}
			for (const effect of effects) {
				expect(effect).toMatchObject({
					settlement: "settled",
					attributionGrade: "measured",
					executionConfirmed: true,
					outcome: "changed",
					executionReceiptJson: { confirmed: true, outcome: "applied" },
				});
				expect(effect.observedAfterStateJson).toEqual(effect.intendedAfterStateJson);
				const state = effect.intendedAfterStateJson;
				if (state.kind !== "regular") throw new Error("Missing actual raw after blob");
				const blob = db
					.select()
					.from(fileChangeBlobs)
					.where(eq(fileChangeBlobs.digest, state.blob.digest))
					.get();
				expect(blob?.status).toBe("ready");
				if (!blob) throw new Error("Missing blob catalog reference");
				expect(blob.storageKey).toMatch(/^sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/);
				expect((await readFile(join(data, "file-change-blobs", blob.storageKey))).byteLength).toBe(
					state.blob.sizeBytes,
				);
				expect(
					db.select().from(fileChangeScopes).where(eq(fileChangeScopes.id, effect.scopeId)).get(),
				).toMatchObject({ status: "active", activeLeaseId: null, activeMutationCount: 0 });
			}
			expect(
				db
					.select()
					.from(fileAttributions)
					.where(eq(fileAttributions.narratorId, narratorId))
					.limit(3)
					.all(),
			).toHaveLength(2);
			expect(
				db
					.select({ id: narratorFileSnapshots.id })
					.from(narratorFileSnapshots)
					.where(eq(narratorFileSnapshots.narratorId, narratorId))
					.limit(1)
					.all(),
			).toHaveLength(0);
			expect(await readFile(sourcePath)).toEqual(sourceAfterWrite);
			expect(
				db
					.select()
					.from(fileChangeStorageBudgets)
					.where(eq(fileChangeStorageBudgets.id, FILE_CHANGE_BLOB_BUDGET_ID))
					.get()?.namespaceKey,
			).toBe(budgetAfterWrite?.namespaceKey);
			for (const [path, mode] of [
				[home, 0o700],
				[data, 0o775],
				[join(data, "file-change-blobs"), 0o700],
				[sourcePath, 0o600],
			] as const) {
				const stat = await lstat(path);
				expect(stat.mode & 0o777).toBe(mode);
				expect(stat.uid).toBe(uid);
			}
		} finally {
			// Always restore the private global fixture, even if permissions or IO fail.
			if (previousStale) Object.defineProperty(globalThis, staleKey, previousStale);
			else Reflect.deleteProperty(globalThis, staleKey);
			try {
				const operations = db
					.select({ id: fileChangeOperations.id })
					.from(fileChangeOperations)
					.where(eq(fileChangeOperations.narratorId, narratorId))
					.limit(3)
					.all();
				const ids = operations.map((operation) => operation.id);
				const scopes = ids.length
					? db
							.select({ id: fileChangeEffects.scopeId })
							.from(fileChangeEffects)
							.where(inArray(fileChangeEffects.operationId, ids))
							.limit(3)
							.all()
					: [];
				db.transaction((tx) => {
					tx.delete(fileAttributions).where(eq(fileAttributions.narratorId, narratorId)).run();
					if (toolCallIds.length)
						tx.delete(narratorToolCalls).where(inArray(narratorToolCalls.id, toolCallIds)).run();
					if (ids.length) {
						tx.delete(fileChangeEffects).where(inArray(fileChangeEffects.operationId, ids)).run();
						tx.delete(fileChangeOperations).where(inArray(fileChangeOperations.id, ids)).run();
					}
					for (const scope of scopes) {
						// Settled leases retain a restrictive scope FK. Remove only this
						// disposable fixture's terminal leases before removing its scope.
						tx.delete(workspaceWriteLeases)
							.where(
								and(
									eq(workspaceWriteLeases.scopeId, scope.id),
									eq(workspaceWriteLeases.status, "settled"),
								),
							)
							.run();
						tx.delete(fileChangeScopes)
							.where(
								and(
									eq(fileChangeScopes.id, scope.id),
									eq(fileChangeScopes.canonicalRoot, workspace ?? ""),
								),
							)
							.run();
					}
					if (messageIds.length)
						tx.delete(narratorMessages).where(inArray(narratorMessages.id, messageIds)).run();
					tx.delete(narrators).where(eq(narrators.id, narratorId)).run();
				});
			} finally {
				try {
					if (workspace) await rm(workspace, { recursive: true, force: true });
				} finally {
					await Promise.all([
						chmod(home, homeBefore.mode & 0o7777),
						chmod(data, dataBefore.mode & 0o7777),
					]);
				}
			}
			// The real source/catalog/blob namespace is owned by tests/preload and
			// removed with its disposable HOME. Do not invalidate the default runtime
			// or reset shared epoch/coordinator state merely to clean a tool fixture.
		}
	},
);
