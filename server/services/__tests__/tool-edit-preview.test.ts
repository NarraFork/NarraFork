import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FILE_CHANGE_LIMITS, type FileChangeState } from "@shared/file-change-protocol";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { testEnvironment } from "../../../tests/preload";
import { db, sqlite } from "../../db";
import {
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopes,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { safeSpawn } from "../../lib/spawn";
import { narratorRoutes } from "../../routes/narrators";
import { FileChangeBlobStore } from "../file-change-blob-store";
import { createFileChangeIdentity, fileChangeIdentityKey } from "../file-change-identity";
import { narratorService } from "../narrator-service";
import { getToolEditPreview, readToolEditPreviewState } from "../tool-edit-preview";
import { worktreeTreeSnapshot } from "../worktree-tree-snapshot";

const now = "2026-09-08T00:00:00.000Z";
const absent: FileChangeState = { kind: "absent" };
const missing: FileChangeState = { kind: "unknown", reason: "missing_after" };
const madeUsers: string[] = [];
const madeNarrators: string[] = [];
const madeOperations: string[] = [];
const madeScopes: string[] = [];
let seq = 0;

function narrator(ownerUserId?: string) {
	if (!ownerUserId) {
		ownerUserId = generateId();
		db.insert(users)
			.values({
				id: ownerUserId,
				username: `preview-${ownerUserId}`,
				passwordHash: "test-only",
				role: "user",
				createdAt: now,
			})
			.run();
		madeUsers.push(ownerUserId);
	}
	const id = generateId();
	db.insert(narrators)
		.values({ id, ownerUserId, visibility: "private", createdAt: now, updatedAt: now })
		.run();
	madeNarrators.push(id);
	return { id, ownerUserId };
}

function tool(narratorId: string, toolUseId = generateId(), parentToolUseId?: string) {
	const id = generateId();
	const messageId = generateId();
	db.insert(narratorMessages)
		.values({
			id: messageId,
			narratorId,
			role: "assistant",
			parentToolUseId,
			contentJson: [],
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId, messageId, seq: ++seq })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id,
			messageId,
			narratorId,
			toolUseId,
			toolName: "Edit",
			status: "success",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			runtimeGeneration: 1,
			executionDeviceId: "local",
			executionCwd: "/repo",
			executionPathFlavor: "posix",
			resolvedFilePath: "/repo/preview.ts",
			canonicalFilePath: "/repo/preview.ts",
			inputJson: {
				file_path: "/repo/preview.ts",
				old_string: "INPUT_OLD_IS_NOT_EVIDENCE",
				new_string: "INPUT_NEW_IS_NOT_EVIDENCE",
			},
			outputJson: { _metadata: { startLine: 3, endLine: 4, newEndLine: 5 } },
			createdAt: now,
		})
		.run();
	return { id, messageId, narratorId, toolUseId };
}

async function stored(value: string | Uint8Array): Promise<FileChangeState> {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	const blob = await new FileChangeBlobStore({ minimumFreeBytes: 0 }).putBytes(bytes, {
		expectedSize: bytes.byteLength,
	});
	return { kind: "regular", blob, mode: 0o644 };
}

function evidence(
	call: ReturnType<typeof tool>,
	before = absent,
	after = absent,
	intended = after,
) {
	const sourceInstanceId = generateId();
	const scopeId = generateId();
	const workspaceInstanceId = generateId();
	db.insert(fileChangeScopes)
		.values({
			id: scopeId,
			sourceInstanceId,
			workspaceInstanceId,
			deviceId: "local",
			canonicalRoot: "/repo",
			displayRoot: "/repo",
			pathFlavor: "posix",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	madeScopes.push(scopeId);
	const operationId = generateId();
	db.insert(fileChangeOperations)
		.values({
			id: operationId,
			sourceInstanceId,
			sourceKind: "tool",
			sourceId: call.id,
			toolCallId: call.id,
			toolUseId: call.toolUseId,
			narratorId: call.narratorId,
			attempt: 1,
			expectedEffectCount: 1,
			actorSubjectKey: call.narratorId,
			actorJson: {
				kind: "primary",
				subjectKey: call.narratorId,
				narratorId: call.narratorId,
				userId: null,
				label: null,
				deleted: false,
				parentSubjectKey: null,
			},
			executionBindingJson: {
				deviceId: "local",
				runtimeGeneration: 1,
				runtimeEpoch: "preview-tests",
				fencingToken: 0,
			},
			settlement: "settled",
			executionOutcome: "succeeded",
			startedAt: now,
			updatedAt: now,
		})
		.run();
	madeOperations.push(operationId);
	db.update(narratorToolCalls)
		.set({ fileChangeOperationId: operationId })
		.where(eq(narratorToolCalls.id, call.id))
		.run();
	const identity = createFileChangeIdentity(
		{
			id: scopeId,
			sourceInstanceId,
			workspaceInstanceId,
			deviceId: "local",
			pathFlavor: "posix",
			canonicalRoot: "/repo",
		},
		{
			canonicalPath: "/repo/preview.ts",
			lexicalPath: "/repo/preview.ts",
			objectRole: "referent",
			deviceId: "local",
			pathFlavor: "posix",
		},
	);
	const effectId = generateId();
	db.insert(fileChangeEffects)
		.values({
			id: effectId,
			operationId,
			scopeId,
			fileKey: fileChangeIdentityKey(identity),
			identityJson: identity,
			scopeRevision: 0,
			mutationId: generateId(),
			requestDigest: "a".repeat(64),
			phase: "apply",
			beforeStateJson: before,
			observedAfterStateJson: after,
			intendedAfterStateJson: intended,
			settlement: "settled",
			outcome: "changed",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return { operationId, effectId, identity };
}

function appFor(userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) =>
		Response.json(
			{ code: error instanceof AppError ? error.code : "INTERNAL_ERROR" },
			{ status: error instanceof AppError ? error.statusCode : 500 },
		),
	);
	app.route("/api/narrators", narratorRoutes);
	return app;
}

function url(
	narratorId: string,
	call: ReturnType<typeof tool>,
	query = `toolCallId=${call.id}&messageId=${call.messageId}`,
) {
	return `/api/narrators/${narratorId}/tool-calls/${call.toolUseId}/file-edit-preview?${query}`;
}

async function preview(narratorId: string, call: ReturnType<typeof tool>) {
	const row = await narratorService.getToolCallPreviewMetadata(narratorId, call.toolUseId, {
		toolCallId: call.id,
	});
	return getToolEditPreview(row);
}

function removeRef(narratorId: string, messageId: string) {
	db.delete(narratorMessageRefs)
		.where(
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, messageId),
			),
		)
		.run();
}

afterEach(() => {
	mock.restore();
	if (madeNarrators.length) {
		db.delete(narratorMessageRefs)
			.where(inArray(narratorMessageRefs.narratorId, madeNarrators))
			.run();
		db.delete(narratorToolCalls).where(inArray(narratorToolCalls.narratorId, madeNarrators)).run();
		db.delete(narratorMessages).where(inArray(narratorMessages.narratorId, madeNarrators)).run();
	}
	if (madeOperations.length) {
		db.delete(fileChangeEffects)
			.where(inArray(fileChangeEffects.operationId, madeOperations))
			.run();
		db.delete(fileChangeOperations).where(inArray(fileChangeOperations.id, madeOperations)).run();
	}
	if (madeScopes.length)
		db.delete(fileChangeScopes).where(inArray(fileChangeScopes.id, madeScopes)).run();
	if (madeNarrators.length) db.delete(narrators).where(inArray(narrators.id, madeNarrators)).run();
	if (madeUsers.length) db.delete(users).where(inArray(users.id, madeUsers)).run();
	madeUsers.length = madeNarrators.length = madeOperations.length = madeScopes.length = 0;
});

describe("exact tool file edit preview", () => {
	test("route returns actual observed evidence, original line range, and no cache", async () => {
		const owner = narrator();
		const call = tool(owner.id);
		evidence(
			call,
			await stored("actual before\n"),
			await stored("observed after\n"),
			await stored("INTENDED_BUT_NOT_OBSERVED"),
		);
		const response = await appFor(owner.ownerUserId).request(url(owner.id, call));
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({
			toolCallId: call.id,
			toolUseId: call.toolUseId,
			filePath: "/repo/preview.ts",
			deviceId: "local",
			before: { status: "available", content: "actual before\n" },
			after: { status: "available", content: "observed after\n" },
			location: { startLine: 3, endLine: 4, newEndLine: 5 },
			source: "evidence",
		});
	});

	test("unknown observed after is never replaced by intended bytes", async () => {
		const owner = narrator();
		const call = tool(owner.id);
		evidence(call, absent, missing, await stored("NOT_OBSERVED"));
		const result = await preview(owner.id, call);
		expect(result.before).toEqual({ status: "absent", content: "" });
		expect(result.after).toEqual({ status: "unavailable", reason: "missing_evidence" });
	});

	test("empty existing file differs from absence", async () => {
		const owner = narrator();
		const call = tool(owner.id);
		evidence(call, await stored(""), absent);
		const result = await preview(owner.id, call);
		expect(result.before).toEqual({ status: "available", content: "" });
		expect(result.after).toEqual({ status: "absent", content: "" });
	});

	for (const [label, value, reason] of [
		["binary", new Uint8Array([97, 0, 98]), "binary"],
		["non UTF-8", new Uint8Array([0xff, 0xfe]), "invalid_encoding"],
	] as const)
		test(`reports ${label} explicitly`, async () => {
			const owner = narrator();
			const call = tool(owner.id);
			evidence(call, await stored(value), absent);
			expect((await preview(owner.id, call)).before).toEqual({ status: "unavailable", reason });
		});

	test("UTF-8 BOM and replacement characters are retained byte-for-byte", async () => {
		const owner = narrator();
		const call = tool(owner.id);
		const text = "\uFEFFhello\uFFFD\n";
		evidence(call, await stored(text), absent);
		expect((await preview(owner.id, call)).before).toEqual({ status: "available", content: text });
	});

	test("over-budget refs are refused before reading blobs, missing blobs are unknown", async () => {
		const owner = narrator();
		const call = tool(owner.id);
		const base = { algorithm: "sha256" as const, digest: "f".repeat(64) };
		evidence(
			call,
			{
				kind: "regular",
				blob: { ...base, sizeBytes: FILE_CHANGE_LIMITS.previewFileBytes + 1 },
				mode: null,
			},
			{ kind: "regular", blob: { ...base, sizeBytes: 1 }, mode: null },
		);
		const read = spyOn(FileChangeBlobStore.prototype, "readBytes");
		const result = await preview(owner.id, call);
		expect(result.before).toEqual({ status: "unavailable", reason: "too_large" });
		expect(result.after).toEqual({ status: "unavailable", reason: "missing_evidence" });
		expect(read).toHaveBeenCalledTimes(1);
		expect(read.mock.calls[0][1]?.maxBytes).toBe(FILE_CHANGE_LIMITS.previewFileBytes);
		expect(read.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
	});

	test("each side admits exactly the shared preview budget without truncation", async () => {
		const owner = narrator();
		const call = tool(owner.id);
		const text = "a".repeat(FILE_CHANGE_LIMITS.previewFileBytes);
		evidence(call, await stored(text), await stored(`${text}b`));
		const result = await preview(owner.id, call);
		expect(result.before).toEqual({ status: "available", content: text });
		expect(result.after).toEqual({ status: "unavailable", reason: "too_large" });
	});

	test("unsupported symlinks and cancellation remain unavailable", async () => {
		const target = { algorithm: "sha256" as const, digest: "f".repeat(64), sizeBytes: 1 };
		const store = new FileChangeBlobStore();
		expect(
			await readToolEditPreviewState(
				{ kind: "symlink", target, mode: null },
				store,
				new AbortController().signal,
			),
		).toEqual({ status: "unavailable", reason: "unsupported" });
		expect(await readToolEditPreviewState(absent, store, AbortSignal.abort())).toEqual({
			status: "unavailable",
			reason: "cancelled",
		});
		expect(
			await readToolEditPreviewState(
				absent,
				store,
				AbortSignal.abort(new DOMException("expired", "TimeoutError")),
			),
		).toEqual({ status: "unavailable", reason: "timeout" });
	});

	test("legacy unknown targets never inherit the current narrator device or input text", async () => {
		const owner = narrator();
		const call = tool(owner.id);
		db.update(narratorToolCalls)
			.set({
				executionDeviceId: null,
				executionCwd: null,
				resolvedFilePath: null,
				canonicalFilePath: null,
				executionIdentityVersion: 0,
			})
			.where(eq(narratorToolCalls.id, call.id))
			.run();
		const result = await preview(owner.id, call);
		expect(result.filePath).toBeNull();
		expect(result.deviceId).toBeNull();
		expect(result.source).toBe("unavailable");
		expect(result.before.status).toBe("unavailable");
		expect(result.after.status).toBe("unavailable");
	});
});

describe("preview authorization and exact attempt binding", () => {
	test("real route denies private narrator ACL and foreign tool PKs before blob reads", async () => {
		const own = narrator();
		const foreign = narrator();
		const secret = tool(foreign.id);
		evidence(secret, await stored("PRIVATE_SECRET"), absent);
		const read = spyOn(FileChangeBlobStore.prototype, "readBytes");
		const app = appFor(own.ownerUserId);
		expect([403, 404]).toContain((await app.request(url(foreign.id, secret))).status);
		expect((await app.request(url(own.id, secret))).status).toBe(404);
		expect(read).not.toHaveBeenCalled();
	});

	test("repeated SDK IDs require the actual row, including two rows in one message", async () => {
		const owner = narrator();
		const a = tool(owner.id, "repeated-sdk-id");
		const b = tool(owner.id, a.toolUseId);
		evidence(a, await stored("attempt A"), absent);
		evidence(b, await stored("attempt B"), absent);
		const app = appFor(owner.ownerUserId);
		expect((await app.request(url(owner.id, a, ""))).status).toBe(409);
		expect((await (await app.request(url(owner.id, b))).json()).before.content).toBe("attempt B");
		db.update(narratorToolCalls)
			.set({ messageId: a.messageId })
			.where(eq(narratorToolCalls.id, b.id))
			.run();
		expect((await app.request(url(owner.id, a, `messageId=${a.messageId}`))).status).toBe(409);
		expect(
			(await app.request(url(owner.id, a, `toolCallId=${a.id}&messageId=${b.messageId}`))).status,
		).toBe(404);
	});

	test("COW carries the source PK and remains readable after original deletion", async () => {
		const owner = narrator();
		const original = tool(owner.id);
		evidence(original, await stored("shared historical bytes"), absent);
		const fork = narrator(owner.ownerUserId);
		const copy = tool(fork.id, original.toolUseId);
		const source = db
			.select()
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, original.id))
			.get();
		if (!source) throw new Error("fixture missing");
		db.update(narratorToolCalls)
			.set({
				fileChangeOperationId: source.fileChangeOperationId,
				executionOriginToolCallId: original.id,
			})
			.where(eq(narratorToolCalls.id, copy.id))
			.run();
		expect((await preview(fork.id, copy)).before).toEqual({
			status: "available",
			content: "shared historical bytes",
		});
		db.delete(narratorToolCalls).where(eq(narratorToolCalls.id, original.id)).run();
		expect((await preview(fork.id, copy)).source).toBe("evidence");
		removeRef(fork.id, copy.messageId);
		expect((await appFor(fork.ownerUserId).request(url(fork.id, copy))).status).toBe(404);
	});

	test("a foreign operation pointer, wrong attempt, or effect path cannot authorize blobs", async () => {
		const owner = narrator();
		const own = tool(owner.id);
		const foreign = tool(narrator().id, own.toolUseId);
		const e = evidence(foreign, await stored("PRIVATE_EVIDENCE"), absent);
		db.update(narratorToolCalls)
			.set({ fileChangeOperationId: e.operationId })
			.where(eq(narratorToolCalls.id, own.id))
			.run();
		const read = spyOn(FileChangeBlobStore.prototype, "readBytes");
		expect((await preview(owner.id, own)).before).toEqual({
			status: "unavailable",
			reason: "identity_unverified",
		});
		db.update(narratorToolCalls)
			.set({ executionAttempt: 2 })
			.where(eq(narratorToolCalls.id, foreign.id))
			.run();
		expect((await preview(foreign.narratorId, foreign)).source).toBe("unavailable");
		db.update(narratorToolCalls)
			.set({ executionAttempt: 1 })
			.where(eq(narratorToolCalls.id, foreign.id))
			.run();
		db.update(fileChangeEffects)
			.set({ identityJson: { ...e.identity, canonicalPath: "/other/secret" } })
			.where(eq(fileChangeEffects.id, e.effectId))
			.run();
		expect((await preview(foreign.narratorId, foreign)).before).toEqual({
			status: "unavailable",
			reason: "identity_unverified",
		});
		expect(read).not.toHaveBeenCalled();
	});

	test("multiple effects fail closed instead of selecting a bounded prefix", async () => {
		const owner = narrator();
		const call = tool(owner.id);
		const e = evidence(call, await stored("not a unique file"), absent);
		const effect = db
			.select()
			.from(fileChangeEffects)
			.where(eq(fileChangeEffects.id, e.effectId))
			.get();
		if (!effect) throw new Error("fixture missing");
		for (let index = 0; index < 3; index++)
			db.insert(fileChangeEffects)
				.values({
					...effect,
					id: generateId(),
					mutationId: generateId(),
					fileKey: `${effect.fileKey}-${index}`,
				})
				.run();
		const read = spyOn(FileChangeBlobStore.prototype, "readBytes");
		expect((await preview(owner.id, call)).before).toEqual({
			status: "unavailable",
			reason: "ambiguous",
		});
		expect(read).not.toHaveBeenCalled();
	});

	test("true child origin authorizes previews; a forged parent provider ID does not", async () => {
		const owner = narrator();
		const parentCall = tool(owner.id, "parent-provider-id");
		db.update(narratorToolCalls)
			.set({ toolName: "Agent" })
			.where(eq(narratorToolCalls.id, parentCall.id))
			.run();
		const child = narrator(owner.ownerUserId);
		db.update(narrators)
			.set({
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: owner.id,
				originToolCallId: parentCall.id,
			})
			.where(eq(narrators.id, child.id))
			.run();
		const childCall = tool(child.id, "child-edit", parentCall.toolUseId);
		evidence(childCall, await stored("child bytes"), absent);
		expect((await preview(owner.id, childCall)).source).toBe("evidence");
		const forged = tool(narrator().id, "forged-child", parentCall.toolUseId);
		evidence(forged, await stored("foreign"), absent);
		expect((await appFor(owner.ownerUserId).request(url(owner.id, forged))).status).toBe(404);
	});

	test("ref revocation during async blob IO prevents the route response", async () => {
		const owner = narrator();
		const call = tool(owner.id);
		evidence(call, await stored("revoked bytes"), absent);
		const original = FileChangeBlobStore.prototype.readBytes;
		spyOn(FileChangeBlobStore.prototype, "readBytes").mockImplementation(async function (
			this: FileChangeBlobStore,
			ref,
			options,
		) {
			removeRef(owner.id, call.messageId);
			return original.call(this, ref, options);
		});
		expect((await appFor(owner.ownerUserId).request(url(owner.id, call))).status).toBe(404);
	});

	test("large or malformed input/output JSON never hydrate as preview payloads", async () => {
		const owner = narrator();
		const call = tool(owner.id);
		evidence(call, absent, absent);
		sqlite.run("UPDATE narrator_tool_calls SET input_json = ?, output_json = ? WHERE id = ?", [
			"BROKEN".repeat(200_000),
			"INVALID".repeat(200_000),
			call.id,
		]);
		const queries: string[] = [];
		const prepare = sqlite.prepare.bind(sqlite);
		spyOn(sqlite, "prepare").mockImplementation((...args: Parameters<typeof sqlite.prepare>) => {
			queries.push(args[0]);
			return prepare(...args);
		});
		const result = await preview(owner.id, call);
		expect(result.source).toBe("evidence");
		expect(result.location).toBeUndefined();
		expect(queries.some((query) => query.includes('"input_json"'))).toBe(false);
		expect(
			queries
				.filter((query) => query.includes('"output_json"'))
				.every((query) => query.includes("octet_length") && query.includes("CASE")),
		).toBe(true);
	});
});

describe("local historical tree fallback", () => {
	test("an ignored file omitted from both trees is missing evidence, not an absent file", async () => {
		const root = await mkdtemp(join(testEnvironment.isolatedHome, "preview-ignored-tree-"));
		const initialized = await safeSpawn({
			cmd: ["git", "init", root],
			timeout: 10_000,
			maxOutputBytes: 4096,
		});
		expect(initialized.exitCode).toBe(0);
		const path = join(root, ".env");
		await writeFile(join(root, ".gitignore"), ".env\n");
		await writeFile(path, "EXISTING_IGNORED_BEFORE\n");
		const before = await worktreeTreeSnapshot.capture(root, "local");
		await writeFile(path, "EXISTING_IGNORED_AFTER\n");
		const after = await worktreeTreeSnapshot.capture(root, "local");
		// The real file changed, but filtering omitted it from both observations.
		expect(before).toBe(after);
		// A later ignore-policy change and live contents cannot fill the history gap.
		await writeFile(join(root, ".gitignore"), "");
		await writeFile(path, "CURRENT_CONTENT_IS_NOT_HISTORICAL_EVIDENCE\n");
		const owner = narrator();
		const call = tool(owner.id);
		db.update(narratorToolCalls)
			.set({
				executionCwd: root,
				resolvedFilePath: path,
				canonicalFilePath: path,
				executionPathFlavor: process.platform === "win32" ? "windows" : "posix",
				treeHashBefore: before,
				treeHashAfter: after,
			})
			.where(eq(narratorToolCalls.id, call.id))
			.run();
		try {
			const response = await appFor(owner.ownerUserId).request(url(owner.id, call));
			expect(response.status).toBe(200);
			const result = await response.json();
			expect(result.source).toBe("unavailable");
			expect(result.before).toEqual({ status: "unavailable", reason: "missing_evidence" });
			expect(result.after).toEqual({ status: "unavailable", reason: "missing_evidence" });
		} finally {
			await worktreeTreeSnapshot.destroy(root, "local");
		}
	});

	test("uses frozen workspace snapshots, never current file bytes; keeps missing evidence and binary distinct", async () => {
		expect(process.env.NARRAFORK_HOME).toBe(testEnvironment.narraforkHome);
		const root = await mkdtemp(join(testEnvironment.isolatedHome, "preview-tree-"));
		const initialized = await safeSpawn({
			cmd: ["git", "init", root],
			timeout: 10_000,
			maxOutputBytes: 4096,
		});
		expect(initialized.exitCode).toBe(0);
		const path = join(root, "preview.ts");
		await writeFile(path, "tree before\n");
		const before = await worktreeTreeSnapshot.capture(root, "local");
		await writeFile(path, "tree after\n");
		const after = await worktreeTreeSnapshot.capture(root, "local");
		await writeFile(path, "CURRENT_BYTES_MUST_NOT_APPEAR");
		const owner = narrator();
		const call = tool(owner.id);
		db.update(narratorToolCalls)
			.set({
				executionCwd: root,
				resolvedFilePath: path,
				canonicalFilePath: path,
				executionPathFlavor: process.platform === "win32" ? "windows" : "posix",
				treeHashBefore: before,
				treeHashAfter: after,
			})
			.where(eq(narratorToolCalls.id, call.id))
			.run();
		const result = await preview(owner.id, call);
		expect(result.source).toBe("tree");
		expect(result.before).toEqual({ status: "available", content: "tree before\n" });
		expect(result.after).toEqual({ status: "available", content: "tree after\n" });
		const options = { signal: new AbortController().signal, timeoutMs: 5000 };
		expect(
			await worktreeTreeSnapshot.readFilePreviewAtTree(
				root,
				after,
				"absent.ts",
				"local",
				100,
				options,
			),
		).toEqual({ status: "unavailable", reason: "missing_evidence" });
		expect(
			await worktreeTreeSnapshot.readFilePreviewAtTree(
				root,
				"0".repeat(40),
				"absent.ts",
				"local",
				100,
				options,
			),
		).toEqual({ status: "unavailable", reason: "missing_evidence" });
		expect(
			await worktreeTreeSnapshot.readFilePreviewAtTree(
				root,
				after,
				"preview.ts",
				"local",
				2,
				options,
			),
		).toEqual({ status: "unavailable", reason: "too_large" });
		await writeFile(path, new Uint8Array([97, 0, 98]));
		const binary = await worktreeTreeSnapshot.capture(root, "local");
		expect(
			await worktreeTreeSnapshot.readFilePreviewAtTree(
				root,
				binary,
				"preview.ts",
				"local",
				100,
				options,
			),
		).toEqual({ status: "unavailable", reason: "binary" });
		await worktreeTreeSnapshot.destroy(root, "local");
	});
});
