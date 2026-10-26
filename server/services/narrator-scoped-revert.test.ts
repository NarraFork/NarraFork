import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { blockIdAt } from "../../tests/block-ids";
import { testEnvironment } from "../../tests/preload";
import { app } from "../app";
import { db } from "../db";
import * as schema from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import { writeTool } from "../lib/agent/tools/write";
import type { ToolExecutionTarget } from "../lib/agent/types";
import { createToken } from "../lib/auth";
import { generateId } from "../lib/id";
import { settings } from "../lib/settings";
import * as narratorWs from "../websocket/narrator-ws";
import { getDefaultLocalFileChangeRuntime } from "./file-change-runtime";
import * as scopedRevert from "./narrator-scoped-revert";
import {
	previewNarratorScopedForMessages,
	previewNarratorScopedForToolUses,
	revertNarratorScopedForMessages,
	revertNarratorScopedForToolUses,
	revertPrincipalForUser,
} from "./narrator-scoped-revert";
import { narratorService } from "./narrator-service";
import * as session from "./narrator-session";
import { editAndRegenerate, rollbackToBlock } from "./narrator-session";
import { hasNarratorAdmissionWork } from "./narrator-session-state";
import * as access from "./revert-planner-local-access";
import type { RevertTransactionOutcome } from "./revert-transaction-service";
import { emptyRevertResult, SnapshotRevertError } from "./snapshot-revert";

let cwd: string;
let narratorId: string;
let userId: string;
let seq: number;
const now = () => new Date().toISOString();
const options = () => ({ principal: { userId, isAdmin: false } });

beforeEach(async () => {
	cwd = await mkdtemp(join(testEnvironment.isolatedHome, "scoped-per-file-"));
	userId = generateId();
	narratorId = generateId();
	seq = 0;
	db.insert(schema.users)
		.values({ id: userId, username: userId, passwordHash: "test", role: "user", createdAt: now() })
		.run();
	db.insert(schema.narrators)
		.values({ id: narratorId, cwd, ownerUserId: userId, createdAt: now(), updatedAt: now() })
		.run();
	settings.workspace.treeSnapshotsEnabled = false;
});
afterEach(async () => {
	mock.restore();
	await rm(cwd, { recursive: true, force: true });
});

function message(blocks: unknown[] = [{ type: "text", text: "keep" }]) {
	const id = generateId();
	db.insert(schema.narratorMessages)
		.values({ id, narratorId, role: "assistant", contentJson: blocks, createdAt: now() })
		.run();
	db.insert(schema.narratorMessageRefs)
		.values({ id: generateId(), narratorId, messageId: id, seq: ++seq })
		.run();
	return id;
}
function content(messageId: string) {
	return db
		.select({ content: schema.narratorMessages.contentJson })
		.from(schema.narratorMessages)
		.where(eq(schema.narratorMessages.id, messageId))
		.get()?.content;
}
async function write(name: string, before = "original\n", after = "changed\n", existing?: string) {
	const path = join(cwd, name);
	await writeFile(path, before);
	const toolUseId = generateId();
	const toolCallId = generateId();
	const messageId = existing ?? message();
	const input = { file_path: path, content: after };
	const old = content(messageId) as unknown[];
	db.update(schema.narratorMessages)
		.set({ contentJson: [...old, { type: "tool_use", id: toolUseId, name: "Write", input }] })
		.where(eq(schema.narratorMessages.id, messageId))
		.run();
	const resolved = await localBackend.resolvePathIdentity(path);
	const executionTarget: ToolExecutionTarget = {
		deviceId: "local",
		backendKind: "local",
		cwd,
		pathFlavor: localBackend.pathFlavor,
		lexicalPath: resolved.lexicalPath,
		canonicalPath: resolved.canonicalPath,
		runtimeGeneration: localBackend.runtimeGeneration,
		selectionSource: "local_default",
	};
	db.insert(schema.narratorToolCalls)
		.values({
			id: toolCallId,
			narratorId,
			messageId,
			toolUseId,
			toolName: "Write",
			inputJson: input,
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionStartedAt: now(),
			executionDeviceId: "local",
			executionCwd: cwd,
			executionPathFlavor: executionTarget.pathFlavor,
			resolvedFilePath: path,
			canonicalFilePath: resolved.canonicalPath,
			runtimeGeneration: executionTarget.runtimeGeneration,
			createdAt: now(),
		})
		.run();
	const result = await writeTool.execute(input, {
		narratorId,
		userId,
		cwd,
		locale: "en",
		currentToolUseId: toolUseId,
		signal: AbortSignal.timeout(30_000),
		toolCallBinding: { toolCallId, attempt: 1 },
		executionTarget,
		requestPermission: async () => ({ behavior: "allow" }),
	});
	expect(result.isError, String(result.output)).not.toBe(true);
	db.update(schema.narratorToolCalls)
		.set({ status: "success" })
		.where(eq(schema.narratorToolCalls.id, toolCallId))
		.run();
	return { path, messageId, toolUseId, toolCallId, blockIndex: old.length };
}

function userMessage() {
	const id = message([{ type: "text", text: "old prompt" }]);
	db.update(schema.narratorMessages)
		.set({ role: "user", contentText: "old prompt" })
		.where(eq(schema.narratorMessages.id, id))
		.run();
	return id;
}

async function editPreview(
	messageId: string,
	action: "edit_and_regenerate" | "rollback_to_block" = "edit_and_regenerate",
) {
	const result = await access.prepareLocalRevertAction(
		options().principal,
		narratorId,
		{
			action,
			messageId,
			idempotencyKey: generateId(),
			...(action === "rollback_to_block" ? { blockIndex: 0 } : {}),
		},
		AbortSignal.timeout(30_000),
	);
	if (!result.plan?.planHash) throw new Error(`Missing edit plan: ${JSON.stringify(result)}`);
	return {
		planId: result.plan.id,
		planHash: result.plan.planHash,
		action: "edit_and_regenerate" as const,
	};
}

describe("edit regeneration executes only the reviewed plan", () => {
	test("same plan restores the tail and retains the actual new prompt", async () => {
		const target = userMessage();
		const call = await write("edit.txt");
		const revertPlan = await editPreview(target);
		const prepare = spyOn(access, "prepareLocalRevertPlan");
		const result = await editAndRegenerate(
			narratorId,
			target,
			"actual edited prompt",
			"en",
			false,
			{ userId, deferContinuation: true, revertPlan },
		);
		expect(result).toMatchObject({
			ok: true,
			revertResult: { planId: revertPlan.planId, status: "committed", historyCommitted: true },
		});
		expect(prepare).not.toHaveBeenCalled();
		expect(await readFile(call.path, "utf8")).toBe("original\n");
		expect(content(target)).toEqual([{ type: "text", text: "actual edited prompt" }]);
		await expect(
			editAndRegenerate(narratorId, target, "must not reuse committed authorization", "en", false, {
				userId,
				deferContinuation: true,
				revertPlan,
			}),
		).rejects.toThrow();
		expect(content(target)).toEqual([{ type: "text", text: "actual edited prompt" }]);
		expect(
			db
				.select()
				.from(schema.narratorMessageRefs)
				.where(eq(schema.narratorMessageRefs.messageId, call.messageId))
				.all(),
		).toHaveLength(0);
	}, 30_000);

	for (const drift of [
		"appended_message",
		"external_file",
		"expired",
		"wrong_operation",
		"wrong_target",
		"wrong_actor",
	] as const) {
		test(`${drift} refuses without replanning or saving the edited prompt`, async () => {
			const target = userMessage();
			const other = userMessage();
			const call = await write("protected.txt");
			const revertPlan = await editPreview(
				target,
				drift === "wrong_operation" ? "rollback_to_block" : "edit_and_regenerate",
			);
			let actor = userId;
			if (drift === "appended_message") {
				message();
				db.update(schema.narrators)
					.set({ messageVersion: 1 })
					.where(eq(schema.narrators.id, narratorId))
					.run();
			}
			if (drift === "external_file") await writeFile(call.path, "external user save\n");
			if (drift === "expired")
				db.update(schema.revertOperations)
					.set({ expiresAt: "1970-01-01T00:00:00.000Z" })
					.where(eq(schema.revertOperations.id, revertPlan.planId))
					.run();
			if (drift === "wrong_actor") {
				actor = generateId();
				db.insert(schema.users)
					.values({
						id: actor,
						username: actor,
						passwordHash: "test",
						role: "admin",
						createdAt: now(),
					})
					.run();
			}
			const prepare = spyOn(access, "prepareLocalRevertPlan");
			const failure = await editAndRegenerate(
				narratorId,
				drift === "wrong_target" ? other : target,
				"must not be saved",
				"en",
				false,
				{ userId: actor, deferContinuation: true, revertPlan },
			).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(SnapshotRevertError);
			const result = (failure as SnapshotRevertError).result;
			if (drift === "external_file") {
				expect(result.files).toContainEqual(
					expect.objectContaining({ status: "conflict", reason: "expected_mismatch" }),
				);
			} else {
				expect(result.reason).toMatch(
					drift === "appended_message"
						? /STALE/
						: drift === "wrong_actor"
							? /PLAN_NOT_FOUND/
							: /ACTION_MISMATCH/,
				);
			}
			expect(prepare).not.toHaveBeenCalled();
			expect(content(target)).toEqual([{ type: "text", text: "old prompt" }]);
			expect(await readFile(call.path, "utf8")).toBe(
				drift === "external_file" ? "external user save\n" : "changed\n",
			);
			expect(content(call.messageId)).toHaveLength(2);
		}, 30_000);
	}
});

describe("HTTP edit confirmation keeps primary/subagent semantics", () => {
	for (const variant of ["primary", "subagent:general"] as const) {
		for (const multipart of [false, true]) {
			test(`${variant} forwards the exact plan and new content (${multipart ? "multipart" : "json"})`, async () => {
				const parentNarratorId = variant === "primary" ? null : generateId();
				if (parentNarratorId)
					db.insert(schema.narrators)
						.values({
							id: parentNarratorId,
							cwd,
							ownerUserId: userId,
							createdAt: now(),
							updatedAt: now(),
						})
						.run();
				db.update(schema.narrators)
					.set({
						variant,
						parentNarratorId,
						aclRootNarratorId: parentNarratorId,
						type: parentNarratorId ? "subagent" : "primary",
					})
					.where(eq(schema.narrators.id, narratorId))
					.run();
				const target = userMessage();
				const call = await write("http-edit.txt");
				const token = await createToken(userId);
				const headers = { Authorization: `Bearer ${token}` };
				const previewResponse = await app.request(
					`/api/narrators/${narratorId}/revert-action-preview`,
					{
						method: "POST",
						headers: { ...headers, "Content-Type": "application/json" },
						body: JSON.stringify({
							action: "edit_and_regenerate",
							messageId: target,
							idempotencyKey: generateId(),
						}),
					},
				);
				const preview = await previewResponse.json();
				expect(previewResponse.status, JSON.stringify(preview)).toBe(200);
				expect(preview.plan?.planHash).toBeTruthy();
				const revertPlan = {
					planId: preview.plan.id,
					planHash: preview.plan.planHash,
					action: "edit_and_regenerate" as const,
				};
				const realEdit = session.editAndRegenerate;
				const edit = spyOn(session, "editAndRegenerate").mockImplementation(
					async (n, m, text, locale, reply, opts) => {
						const result = await realEdit(n, m, text, locale, reply, {
							...opts,
							deferContinuation: true,
						});
						return {
							...result,
							revertResult: result.revertResult
								? { ...result.revertResult, historyStatus: "unavailable" }
								: undefined,
						};
					},
				);
				const body = multipart
					? new FormData()
					: JSON.stringify({ content: "actual HTTP edited prompt", skipRevert: false, revertPlan });
				if (body instanceof FormData) {
					body.set("content", "actual HTTP edited prompt");
					body.set("skipRevert", "false");
					body.set("revertPlan", JSON.stringify(revertPlan));
					body.set(
						"textFiles",
						new File(["new attachment"], "attached.txt", { type: "text/plain" }),
					);
				}
				const response = await app.request(
					`/api/narrators/${narratorId}/edit-and-regenerate/${target}`,
					{
						method: "POST",
						headers: multipart ? headers : { ...headers, "Content-Type": "application/json" },
						body,
					},
				);
				const result = await response.json();
				expect(response.status, JSON.stringify(result)).toBe(200);
				expect(result).toMatchObject({
					ok: true,
					revertResult: {
						planId: revertPlan.planId,
						status: "committed",
						historyCommitted: true,
						historyStatus: "unavailable",
					},
				});
				expect(edit.mock.calls[0][5]?.revertPlan).toEqual(revertPlan);
				expect(edit.mock.calls).toHaveLength(1);
				expect(edit.mock.calls[0].slice(0, 3)).toEqual([
					narratorId,
					target,
					"actual HTTP edited prompt",
				]);
				expect(await readFile(call.path, "utf8")).toBe("original\n");
				expect(content(target)).toContainEqual({ type: "text", text: "actual HTTP edited prompt" });
			}, 30_000);
		}
	}
});

// Real Write evidence, local ACL/planner/executor and SQLite COW; only fault injection is mocked.
describe("narrator-scoped per-file recovery consumers", () => {
	test("preview contains measured files and execution preserves the file-only history", async () => {
		const call = await write("one.txt");
		const before = content(call.messageId);
		const preview = await previewNarratorScopedForToolUses(narratorId, [call], {
			...options(),
			withContents: true,
		});
		expect(preview.available).toBe(true);
		expect(preview.plan?.planHash).toBeTruthy();
		expect(preview.files).toMatchObject([
			{ filePath: "one.txt", currentContent: "changed\n", revertedContent: "original\n" },
		]);
		const result = await revertNarratorScopedForToolUses(narratorId, [call], options());
		expect(result).toMatchObject({
			status: "committed",
			historyCommitted: false,
			files: [{ filePath: "one.txt", status: "applied" }],
		});
		expect(await readFile(call.path, "utf8")).toBe("original\n");
		expect(content(call.messageId)).toEqual(before);
	}, 30_000);

	test("partial files retain successful writes and all selected history", async () => {
		const a = await write("a.txt");
		const b = await write("b.txt");
		const original = access.RevertPlannerLocalAccess.prototype.resolveFile;
		let executing = false;
		const execute = access.executeLocalRevertPlan;
		spyOn(access, "executeLocalRevertPlan").mockImplementation((input) => {
			executing = true;
			return execute(input);
		});
		spyOn(access.RevertPlannerLocalAccess.prototype, "resolveFile").mockImplementation(function (
			this: access.RevertPlannerLocalAccess,
			input,
		) {
			if (executing && input.identity.canonicalPath === b.path)
				return Promise.reject(new Error("second file denied"));
			return original.call(this, input);
		});
		const notify = spyOn(narratorWs, "broadcastToNarrator");
		let failure: unknown;
		try {
			await narratorService.deleteMessageBlocks(
				narratorId,
				[a, b].map((item) => ({ messageId: item.messageId, blockIndex: item.blockIndex })),
				options(),
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SnapshotRevertError);
		const result = (failure as SnapshotRevertError).result;
		expect(result.status).toBe("partial");
		expect(result.historyCommitted).toBe(false);
		expect(result.files.find((item) => item.filePath === "a.txt")?.status).toBe("applied");
		expect(result.files.find((item) => item.filePath === "b.txt")?.status).toBe("failed");
		expect(await readFile(a.path, "utf8")).toBe("original\n");
		expect(await readFile(b.path, "utf8")).toBe("changed\n");
		expect(content(a.messageId)).toHaveLength(2);
		expect(content(b.messageId)).toHaveLength(2);
		expect(
			notify.mock.calls.some(([id, event]) => id === narratorId && event.type === "full_reload"),
		).toBe(true);
	}, 30_000);

	test("a missing history blob reports its file while the other file restores", async () => {
		const a = await write("good.txt", "good-before", "good-after");
		const b = await write("missing.txt", "bad-before", "bad-after");
		const effect = db
			.select({ beforeBlobDigest: schema.fileChangeEffects.beforeBlobDigest })
			.from(schema.fileChangeEffects)
			.innerJoin(
				schema.fileChangeOperations,
				eq(schema.fileChangeOperations.id, schema.fileChangeEffects.operationId),
			)
			.where(eq(schema.fileChangeOperations.toolCallId, b.toolCallId))
			.get();
		const runtime = await getDefaultLocalFileChangeRuntime();
		const { store } = await runtime.verifyNamespace();
		const read = store.readBytes.bind(store);
		spyOn(store, "readBytes").mockImplementation((ref, opts) =>
			ref.digest === effect?.beforeBlobDigest
				? Promise.reject(new Error("missing blob"))
				: read(ref, opts),
		);
		const result = await revertNarratorScopedForMessages(
			narratorId,
			[a.messageId, b.messageId],
			options(),
		);
		expect(result.status).toBe("partial");
		expect(result.files.find((item) => item.filePath === "missing.txt")).toMatchObject({
			status: "failed",
		});
		expect(result.historyCommitted).toBe(false);
		expect(await readFile(a.path, "utf8")).toBe("good-before");
		expect(await readFile(b.path, "utf8")).toBe("bad-after");
	}, 30_000);

	test("message-block deletion preserves the fork's original and unselected blocks", async () => {
		const call = await write("cow.txt");
		const fork = generateId();
		db.insert(schema.narrators)
			.values({ id: fork, cwd, ownerUserId: userId, createdAt: now(), updatedAt: now() })
			.run();
		db.insert(schema.narratorMessageRefs)
			.values({ id: generateId(), narratorId: fork, messageId: call.messageId, seq: 1 })
			.run();
		const original = content(call.messageId);
		const result = await narratorService.deleteMessageBlock(
			narratorId,
			call.messageId,
			call.blockIndex,
			options(),
		);
		expect(result.revertResult?.historyCommitted).toBe(true);
		expect(content(call.messageId)).toEqual(original);
		const ref = db
			.select()
			.from(schema.narratorMessageRefs)
			.where(eq(schema.narratorMessageRefs.narratorId, narratorId))
			.get();
		expect(ref?.messageId).not.toBe(call.messageId);
		if (!ref) throw new Error("missing current narrator reference");
		expect(content(ref.messageId)).toEqual([{ type: "text", text: "keep" }]);
		expect(await readFile(call.path, "utf8")).toBe("original\n");
	}, 30_000);

	test("pending IO returns its unknown file and retains admission until actual settlement", async () => {
		const call = await write("pending.txt");
		const terminal = Promise.withResolvers<RevertTransactionOutcome>();
		const pending: RevertTransactionOutcome = {
			...emptyRevertResult(),
			planId: "pending-plan",
			status: "executing",
			journalStatus: "applying",
			settling: true,
			files: [
				{ deviceId: "local", filePath: "pending.txt", status: "unknown", reason: "IO_PENDING" },
			],
		};
		spyOn(access, "executeLocalRevertPlan").mockResolvedValue({
			result: Promise.resolve(pending),
			whenSettled: terminal.promise,
		});
		const notify = spyOn(narratorWs, "broadcastToNarrator");
		try {
			await expect(
				narratorService.deleteMessageBlock(narratorId, call.messageId, call.blockIndex, options()),
			).rejects.toMatchObject({ result: pending });
			expect(hasNarratorAdmissionWork(narratorId)).toBe(true);
			expect(content(call.messageId)).toHaveLength(2);
			expect(
				notify.mock.calls.some(([id, event]) => id === narratorId && event.type === "full_reload"),
			).toBe(true);
		} finally {
			terminal.resolve({ ...pending, status: "failed", settling: false });
			await terminal.promise;
			await Promise.resolve();
		}
		expect(hasNarratorAdmissionWork(narratorId)).toBe(false);
	});

	test("permission revoked after file restoration retains history and the applied outcome", async () => {
		const call = await write("revoked-after-io.txt");
		const authorize = scopedRevert.authorizeRevertHistory;
		spyOn(scopedRevert, "authorizeRevertHistory").mockImplementation(async (...args) => {
			db.update(schema.narrators)
				.set({ ownerUserId: null, visibility: "private" })
				.where(eq(schema.narrators.id, narratorId))
				.run();
			await authorize(...args);
		});
		await expect(
			narratorService.deleteMessageBlock(narratorId, call.messageId, call.blockIndex, options()),
		).rejects.toMatchObject({
			result: {
				status: "partial",
				historyCommitted: false,
				files: [{ filePath: "revoked-after-io.txt", status: "applied" }],
			},
		});
		expect(await readFile(call.path, "utf8")).toBe("original\n");
		expect(content(call.messageId)).toHaveLength(2);
	}, 30_000);

	test("rollback includes the selected message suffix and later messages in one plan", async () => {
		const a = await write("boundary.txt");
		const b = await write("later.txt");
		const result = await rollbackToBlock(narratorId, a.messageId, 0, options());
		expect(result.revertResult?.historyCommitted).toBe(true);
		expect(await readFile(a.path, "utf8")).toBe("original\n");
		expect(await readFile(b.path, "utf8")).toBe("original\n");
		const refs = db
			.select()
			.from(schema.narratorMessageRefs)
			.where(eq(schema.narratorMessageRefs.narratorId, narratorId))
			.all();
		expect(refs).toHaveLength(1);
		expect(content(refs[0].messageId)).toEqual([{ type: "text", text: "keep" }]);
	}, 30_000);

	test("confirmed HTTP file restore and message deletion expose the per-file result", async () => {
		const { app } = await import("../app");
		const { createToken } = await import("../lib/auth");
		const headers = {
			authorization: `Bearer ${await createToken(userId)}`,
			"content-type": "application/json",
		};
		const call = await write("http-revert.txt");
		const legacy = await app.request(`/api/narrators/${narratorId}/revert`, {
			method: "POST",
			headers,
			body: JSON.stringify({ messageId: call.messageId }),
		});
		expect(legacy.status).toBe(409);
		expect(await legacy.json()).toMatchObject({ code: "REVERT_CONFIRMATION_REQUIRED" });
		expect(await readFile(call.path, "utf8")).toBe("changed\n");
		const preview = await access.prepareLocalRevertAction(
			options().principal,
			narratorId,
			{
				action: "revert_files",
				messageId: call.messageId,
				idempotencyKey: generateId(),
			},
			AbortSignal.timeout(30_000),
		);
		if (!preview.plan?.planHash) throw new Error("Missing confirmed file plan");
		const response = await app.request(
			`/api/narrators/${narratorId}/revert-plans/${preview.plan.id}/apply`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ action: "revert_files", planHash: preview.plan.planHash }),
			},
		);
		const result = await response.json();
		expect(response.status, JSON.stringify(result)).toBe(200);
		expect(result).toMatchObject({
			status: "committed",
			historyCommitted: false,
			files: [{ filePath: "http-revert.txt", status: "applied" }],
		});
		expect(content(call.messageId)).toHaveLength(2);
		const next = await write("http-delete.txt");
		// HTTP deletions are history-only; restoring files without a reviewed plan is refused.
		const deleted = await app.request(`/api/narrators/${narratorId}/messages/${next.messageId}`, {
			method: "DELETE",
			headers,
		});
		expect(deleted.status).toBe(409);
		expect(await deleted.json()).toMatchObject({ code: "REVERT_CONFIRMATION_REQUIRED" });
		expect(await readFile(next.path, "utf8")).toBe("changed\n");
		expect(content(next.messageId)).toBeDefined();
	}, 30_000);

	test("HTTP partial failures retain file outcomes in the error response", async () => {
		const { app } = await import("../app");
		const { createToken } = await import("../lib/auth");
		const messageId = message();
		const result = {
			...emptyRevertResult(),
			status: "partial" as const,
			files: [
				{ deviceId: "local", filePath: "a.txt", status: "applied" as const },
				{
					deviceId: "local",
					filePath: "b.txt",
					status: "failed" as const,
					reason: "permission_revoked",
				},
			],
		};
		spyOn(narratorService, "deleteBlocks").mockRejectedValue(new SnapshotRevertError(result));
		const response = await app.request(`/api/narrators/${narratorId}/blocks`, {
			method: "DELETE",
			headers: {
				authorization: `Bearer ${await createToken(userId)}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ blockIds: [await blockIdAt(messageId, 0)], skipRevert: true }),
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ code: "SNAPSHOT_REVERT_FAILED", ...result });
		expect(content(messageId)).toHaveLength(1);
	});

	test("authentication is the actual requester, and tool ids cannot cross message boundaries", async () => {
		const call = await write("private.txt");
		await expect(revertNarratorScopedForToolUses(narratorId, [call])).rejects.toMatchObject({
			statusCode: 401,
		});
		const other = generateId();
		db.insert(schema.users)
			.values({ id: other, username: other, passwordHash: "test", role: "user", createdAt: now() })
			.run();
		await expect(
			previewNarratorScopedForMessages(narratorId, [call.messageId], {
				principal: { userId: other, isAdmin: false },
			}),
		).rejects.toMatchObject({ statusCode: 404 });
		const foreignMessage = message();
		const result = await revertNarratorScopedForToolUses(
			narratorId,
			[{ messageId: foreignMessage, toolUseId: call.toolUseId }],
			options(),
		);
		expect(result.status).toBe("failed");
		expect(result.reason).toContain("EVIDENCE_INCOMPLETE");
		expect(await readFile(call.path, "utf8")).toBe("changed\n");
		expect(await revertPrincipalForUser(userId)).toEqual(options().principal);
		await expect(revertPrincipalForUser(null)).rejects.toMatchObject({ statusCode: 401 });
	}, 30_000);
});
