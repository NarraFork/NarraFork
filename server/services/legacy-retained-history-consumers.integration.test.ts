import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { testEnvironment } from "../../tests/preload";
import { app } from "../app";
import { db, sqlite } from "../db";
import { getDbPath } from "../db/connection";
import * as schema from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import { writeTool } from "../lib/agent/tools/write";
import { createToken } from "../lib/auth";
import { generateId } from "../lib/id";
import { getNarraforkHome } from "../lib/narrafork-home";
import { getDefaultLocalFileChangeRuntime } from "./file-change-runtime";
import { prepareLegacyRootAdoption } from "./legacy-main-checkout-adoption";
import { createLegacyProjectMigrationService } from "./legacy-project-migration-core";
import {
	getAuthorizedLegacyRetainedHistoryOrigin,
	isAuthorizedLegacyRetainedSnapshotCommit,
} from "./legacy-retained-history-origin";
import * as membershipReader from "./legacy-retained-snapshot-membership";
import { treeSnapshotPhysicalDir } from "./tree-snapshot-paths";
import { assertWorkspaceHistoryRevertSupported } from "./workspace-context-service";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const paths: string[] = [];
afterEach(async () => {
	for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture(verified = false) {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(getNarraforkHome()).toBe(testEnvironment.narraforkHome);
	expect(getDbPath().startsWith(testEnvironment.narraforkHome)).toBe(true);
	const root = await mkdtemp(join(testEnvironment.isolatedHome, "retained-consumer-"));
	paths.push(root, treeSnapshotPhysicalDir("local", root));
	execFileSync("git", ["init", "--quiet", "--initial-branch=feature", root], {
		timeout: 5000,
		maxBuffer: 32768,
	});
	const file = join(root, "file.txt");
	await writeFile(file, "before\n");
	execFileSync("git", ["-C", root, "add", "file.txt"], { timeout: 5000, maxBuffer: 32768 });
	execFileSync(
		"git",
		[
			"-C",
			root,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@test",
			"commit",
			"--quiet",
			"-m",
			"fixture",
		],
		{ timeout: 5000, maxBuffer: 32768 },
	);
	const before = await worktreeTreeSnapshot.capture(root, "local");
	const snapshot = await worktreeTreeSnapshot.linkSnapshot(root, before, "history", "local");
	if (!snapshot) throw new Error("Snapshot commit missing");
	await writeFile(file, "after\n");
	const after = await worktreeTreeSnapshot.capture(root, "local");
	const id = generateId(),
		user = generateId(),
		project = generateId(),
		chapter = generateId();
	const message = generateId(),
		tool = generateId(),
		use = generateId();
	const now = new Date().toISOString();
	db.insert(schema.users)
		.values({ id: user, username: user, passwordHash: "x", createdAt: now })
		.run();
	db.insert(schema.projects)
		.values({
			id: project,
			name: "Root0",
			ownerUserId: user,
			gitPath: root,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.chapters)
		.values({
			id: chapter,
			projectId: project,
			title: "Root0",
			branch: "feature",
			baseBranch: "feature",
			isRoot: 1,
			worktreePath: root,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.narrators)
		.values({
			id,
			chapterId: chapter,
			ownerUserId: user,
			cwd: null,
			workspaceRevision: 0,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.narratorMessages)
		.values({
			id: message,
			narratorId: id,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: use, name: "Edit", input: {} }],
			snapshotCommitSha: snapshot.commitSha,
			createdAt: now,
		})
		.run();
	db.insert(schema.narratorMessageRefs)
		.values({ id: generateId(), narratorId: id, messageId: message, seq: 0 })
		.run();
	db.insert(schema.narratorToolCalls)
		.values({
			id: tool,
			narratorId: id,
			messageId: message,
			toolUseId: use,
			toolName: "Edit",
			status: "success",
			executionDeviceId: "local",
			executionCwd: root,
			executionPathFlavor: "posix",
			resolvedFilePath: file,
			canonicalFilePath: file,
			treeHashBefore: before,
			treeHashAfter: after,
			createdAt: now,
		})
		.run();
	if (verified) {
		db.update(schema.narratorMessages)
			.set({
				contentJson: [
					{
						type: "tool_use",
						id: use,
						name: "Write",
						input: { file_path: file, content: "after\n" },
					},
				],
			})
			.where(eq(schema.narratorMessages.id, message))
			.run();
		await getDefaultLocalFileChangeRuntime();
		await writeFile(file, "before\n");
		const targetPath = await localBackend.resolvePathIdentity(file);
		const target = {
			deviceId: "local",
			backendKind: "local" as const,
			cwd: root,
			pathFlavor: localBackend.pathFlavor,
			lexicalPath: targetPath.lexicalPath,
			canonicalPath: targetPath.canonicalPath,
			runtimeGeneration: localBackend.runtimeGeneration,
			selectionSource: "local_default" as const,
		};
		db.update(schema.narratorToolCalls)
			.set({
				toolName: "Write",
				status: "running",
				executionIdentityVersion: 1,
				executionAttempt: 1,
				executionStartedAt: now,
				runtimeGeneration: target.runtimeGeneration,
			})
			.where(eq(schema.narratorToolCalls.id, tool))
			.run();
		const result = await writeTool.execute(
			{ file_path: file, content: "after\n" },
			{
				narratorId: id,
				userId: user,
				cwd: root,
				locale: "en",
				signal: new AbortController().signal,
				currentToolUseId: use,
				toolCallBinding: { toolCallId: tool, attempt: 1 },
				executionTarget: target,
				requestPermission: async () => ({ behavior: "allow" }),
			},
		);
		expect(result.isError, String(result.output)).not.toBe(true);
		db.update(schema.narratorToolCalls)
			.set({ status: "success" })
			.where(eq(schema.narratorToolCalls.id, tool))
			.run();
	}
	const actor = { userId: user, isAdmin: false };
	// Only the migration gate is enabled in this disposable fixture. Production stays false.
	const migration = createLegacyProjectMigrationService({
		sqlite,
		mainDatabasePath: getDbPath(),
		retainedHistoryConsumersReady: true,
		runtimeBusy: () => false,
		prepareRootAdoption: prepareLegacyRootAdoption,
		withRuntimeAdmission: async (_ids, body) => body(),
		disableSync: async () => {
			db.update(schema.projects)
				.set({ legacySyncDisabled: true })
				.where(eq(schema.projects.id, project))
				.run();
			return { syncDisabled: true, drained: true };
		},
	});
	const preview = await migration.preview(project, actor);
	expect(preview.blockers).toEqual([]);
	expect((await migration.migrate(project, actor, preview.revision)).phase).toBe("completed");
	const token = await createToken(user, "user");
	const http = (suffix: string, body?: unknown) =>
		app.request(`/api/narrators/${id}/${suffix}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { root, file, id, user, actor, message, use, snapshot: snapshot.commitSha, http };
}

async function completeWriteAt(f: Awaited<ReturnType<typeof fixture>>, root: string, seq: number) {
	const file = join(root, "file.txt"),
		message = generateId(),
		tool = generateId(),
		use = generateId();
	const now = new Date().toISOString(),
		input = { file_path: file, content: "new back-root bytes\n" };
	db.insert(schema.narratorMessages)
		.values({
			id: message,
			narratorId: f.id,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: use, name: "Write", input }],
			createdAt: now,
		})
		.run();
	db.insert(schema.narratorMessageRefs)
		.values({ id: generateId(), narratorId: f.id, messageId: message, seq })
		.run();
	const path = await localBackend.resolvePathIdentity(file);
	const target = {
		deviceId: "local",
		backendKind: "local" as const,
		cwd: root,
		pathFlavor: localBackend.pathFlavor,
		lexicalPath: path.lexicalPath,
		canonicalPath: path.canonicalPath,
		runtimeGeneration: localBackend.runtimeGeneration,
		selectionSource: "local_default" as const,
	};
	db.insert(schema.narratorToolCalls)
		.values({
			id: tool,
			narratorId: f.id,
			messageId: message,
			toolUseId: use,
			toolName: "Write",
			inputJson: input,
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionStartedAt: now,
			executionDeviceId: "local",
			executionCwd: root,
			executionPathFlavor: target.pathFlavor,
			resolvedFilePath: target.lexicalPath,
			canonicalFilePath: target.canonicalPath,
			runtimeGeneration: target.runtimeGeneration,
			createdAt: now,
		})
		.run();
	const result = await writeTool.execute(input, {
		narratorId: f.id,
		userId: f.user,
		cwd: root,
		locale: "en",
		signal: new AbortController().signal,
		currentToolUseId: use,
		toolCallBinding: { toolCallId: tool, attempt: 1 },
		executionTarget: target,
		requestPermission: async () => ({ behavior: "allow" }),
	});
	expect(result.isError, String(result.output)).not.toBe(true);
	db.update(schema.narratorToolCalls)
		.set({ status: "success" })
		.where(eq(schema.narratorToolCalls.id, tool))
		.run();
	const operation = db
		.select({ id: schema.narratorToolCalls.fileChangeOperationId })
		.from(schema.narratorToolCalls)
		.where(eq(schema.narratorToolCalls.id, tool))
		.get();
	if (!operation?.id) throw new Error("Complete operation missing");
	const effect = db
		.select({ scopeId: schema.fileChangeEffects.scopeId })
		.from(schema.fileChangeEffects)
		.where(eq(schema.fileChangeEffects.operationId, operation.id))
		.limit(1)
		.get();
	if (!effect) throw new Error("Complete effect missing");
	return { file, message, operationId: operation.id, scopeId: effect.scopeId };
}

test("Root0 null cwd history remains readable through real HTTP and singleton durable origin", async () => {
	const f = await fixture();
	const row = db
		.select({
			chapter: schema.narrators.chapterId,
			cwd: schema.narrators.cwd,
			revision: schema.narrators.workspaceRevision,
		})
		.from(schema.narrators)
		.where(eq(schema.narrators.id, f.id))
		.get();
	expect(row).toEqual({ chapter: null, cwd: f.root, revision: 1 });
	const origin = await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor);
	expect(origin?.origin.workspaceRevision).toBe(0);
	expect(origin?.origin.persistedCwd).toBeNull();
	const response = await f.http(`tool-calls/${f.use}/file-edit-preview`);
	expect(response.status).toBe(200);
	const preview = await response.json();
	expect(preview.before).toEqual({ status: "available", content: "before\n" });
	expect(preview.after).toEqual({ status: "available", content: "after\n" });
	expect(await readFile(f.file, "utf8")).toBe("after\n");
	const claim = db
		.select({
			id: schema.legacyMigrationArtifactClaims.id,
			latest: schema.legacyMigrationArtifactClaims.latestSnapshotCommitSha,
		})
		.from(schema.legacyMigrationArtifactClaims)
		.where(eq(schema.legacyMigrationArtifactClaims.narratorId, f.id))
		.get();
	expect(claim).toBeTruthy();
	if (!claim) throw new Error("Shadow claim missing");
	expect(claim.latest).toBeNull();
	expect(await isAuthorizedLegacyRetainedSnapshotCommit(claim.id, f.actor, f.snapshot)).toBe(true);
	expect(await isAuthorizedLegacyRetainedSnapshotCommit(claim.id, f.actor, "a".repeat(40))).toBe(
		false,
	);
	// A later normal cwd switch does not relocate the immutable archived namespace.
	db.update(schema.narrators)
		.set({ cwd: `${f.root}-new-cwd`, workspaceRevision: 2 })
		.where(eq(schema.narrators.id, f.id))
		.run();
	expect(await isAuthorizedLegacyRetainedSnapshotCommit(claim.id, f.actor, f.snapshot)).toBe(true);
	const movedPreview = await f.http(`tool-calls/${f.use}/file-edit-preview`);
	expect(movedPreview.status).toBe(200);
	expect((await movedPreview.json()).before).toEqual({ status: "available", content: "before\n" });
	await expect(assertWorkspaceHistoryRevertSupported(f.id)).rejects.toThrow("unsupported");
	const cancelled = new AbortController();
	cancelled.abort();
	expect(
		await isAuthorizedLegacyRetainedSnapshotCommit(claim.id, f.actor, f.snapshot, cancelled.signal),
	).toBe(false);
	db.update(schema.narrators).set({ ownerUserId: null }).where(eq(schema.narrators.id, f.id)).run();
	expect((await f.http(`tool-calls/${f.use}/file-edit-preview`)).status).toBe(404);
	await expect(getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor)).rejects.toThrow();
});

test("migrated Root0 complete file evidence restores through actual HTTP worker and leases", async () => {
	const f = await fixture(true);
	const response = await f.http("revert-action-preview", {
		idempotencyKey: generateId(),
		action: "revert_files",
		messageId: "__all__",
	});
	const body = await response.json();
	expect(response.status, JSON.stringify(body)).toBe(200);
	expect(body.plan.coverageComplete).toBe(true);
	// The fixed plan must not carry authority across replacement of Git metadata.
	await rename(join(f.root, ".git"), join(f.root, "original-git"));
	execFileSync("git", ["init", "--quiet", f.root], { timeout: 5000, maxBuffer: 32768 });
	const denied = await f.http(`revert-plans/${body.plan.id}/apply`, {
		planHash: body.plan.planHash,
		action: "revert_files",
	});
	expect(denied.status).toBe(409);
	expect(await readFile(f.file, "utf8")).toBe("after\n");
	await rm(join(f.root, ".git"), { recursive: true, force: true });
	await rename(join(f.root, "original-git"), join(f.root, ".git"));
	const originalRoot = `${f.root}-original`;
	paths.push(originalRoot);
	await rename(f.root, originalRoot);
	await mkdir(f.root);
	await writeFile(f.file, "after\n");
	const replacement = await f.http("revert-action-preview", {
		idempotencyKey: generateId(),
		action: "revert_files",
		messageId: "__all__",
	});
	const replacementBody = await replacement.json();
	expect(replacementBody.plan).toBeNull();
	expect(await readFile(f.file, "utf8")).toBe("after\n");
	await rm(f.root, { recursive: true, force: true });
	await rename(originalRoot, f.root);
	const scope = db
		.select({ id: schema.fileChangeScopes.id, status: schema.fileChangeScopes.status })
		.from(schema.fileChangeScopes)
		.where(eq(schema.fileChangeScopes.canonicalRoot, f.root))
		.limit(1)
		.get();
	if (!scope) throw new Error("Recorded scope missing");
	db.update(schema.fileChangeScopes)
		.set({ status: "retired" })
		.where(eq(schema.fileChangeScopes.id, scope.id))
		.run();
	const unknown = await f.http("revert-action-preview", {
		idempotencyKey: generateId(),
		action: "revert_files",
		messageId: "__all__",
	});
	expect((await unknown.json()).plan).toBeNull();
	expect(await readFile(f.file, "utf8")).toBe("after\n");
	db.update(schema.fileChangeScopes)
		.set({ status: scope.status })
		.where(eq(schema.fileChangeScopes.id, scope.id))
		.run();
	const renewed = await f.http("revert-action-preview", {
		idempotencyKey: generateId(),
		action: "revert_files",
		messageId: "__all__",
	});
	const renewedBody = await renewed.json();
	expect(renewedBody.plan.coverageComplete).toBe(true);
	const applied = await f.http(`revert-plans/${renewedBody.plan.id}/apply`, {
		planHash: renewedBody.plan.planHash,
		action: "revert_files",
	});
	const result = await applied.json();
	expect(applied.status, JSON.stringify(result)).toBe(200);
	expect(result.status).toBe("committed");
	expect(await readFile(f.file, "utf8")).toBe("before\n");
});

test("replacement Git metadata denies physical rollback but history-only rollback remains available", async () => {
	const f = await fixture();
	await assertWorkspaceHistoryRevertSupported(f.id);
	await rename(join(f.root, ".git"), join(f.root, "original-git"));
	execFileSync("git", ["init", "--quiet", f.root], { timeout: 5000, maxBuffer: 32768 });
	await expect(assertWorkspaceHistoryRevertSupported(f.id)).rejects.toThrow("unsupported");
	expect(await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor)).not.toBeNull();
	const absentRoot = `${f.root}-absent`;
	paths.push(absentRoot);
	await rename(f.root, absentRoot);
	// Historical bytes live in the retained shadow, not in the vanished checkout.
	const historical = await f.http(`tool-calls/${f.use}/file-edit-preview`);
	expect(historical.status).toBe(200);
	expect((await historical.json()).before).toEqual({ status: "available", content: "before\n" });
	const response = await f.http(`rollback/${f.message}`, { blockIndex: 0, skipRevert: true });
	expect(response.status).toBe(200);
	expect(await readFile(join(absentRoot, "file.txt"), "utf8")).toBe("after\n");
});

test("retirement does not bind new complete writes in a normally switched workspace to the old root", async () => {
	const f = await fixture(true);
	const origin = await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor);
	if (!origin || origin.scopeIds.length === 0) throw new Error("Legacy scope provenance missing");
	const newRoot = await mkdtemp(join(testEnvironment.isolatedHome, "new-workspace-"));
	paths.push(newRoot);
	const switched = await f.http("workspace-context/switch", {
		expectedRevision: 1,
		requestId: generateId(),
		target: { deviceId: "local", cwd: newRoot },
	});
	const switchedBody = await switched.json();
	expect(switched.status, JSON.stringify(switchedBody)).toBe(200);
	expect(switchedBody.current.cwd).toBe(newRoot);
	expect(switchedBody.current.revision).toBe(2);
	const newFile = join(newRoot, "file.txt");
	await writeFile(newFile, "new workspace before\n");
	const message = generateId(),
		tool = generateId(),
		use = generateId();
	const now = new Date().toISOString();
	const input = { file_path: newFile, content: "new workspace after\n" };
	db.insert(schema.narratorMessages)
		.values({
			id: message,
			narratorId: f.id,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: use, name: "Write", input }],
			createdAt: now,
		})
		.run();
	db.insert(schema.narratorMessageRefs)
		.values({ id: generateId(), narratorId: f.id, messageId: message, seq: 100 })
		.run();
	const targetPath = await localBackend.resolvePathIdentity(newFile);
	const target = {
		deviceId: "local",
		backendKind: "local" as const,
		cwd: newRoot,
		pathFlavor: localBackend.pathFlavor,
		lexicalPath: targetPath.lexicalPath,
		canonicalPath: targetPath.canonicalPath,
		runtimeGeneration: localBackend.runtimeGeneration,
		selectionSource: "local_default" as const,
	};
	db.insert(schema.narratorToolCalls)
		.values({
			id: tool,
			narratorId: f.id,
			messageId: message,
			toolUseId: use,
			toolName: "Write",
			inputJson: input,
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionStartedAt: now,
			executionDeviceId: "local",
			executionCwd: newRoot,
			executionPathFlavor: target.pathFlavor,
			resolvedFilePath: target.lexicalPath,
			canonicalFilePath: target.canonicalPath,
			runtimeGeneration: target.runtimeGeneration,
			createdAt: now,
		})
		.run();
	const written = await writeTool.execute(input, {
		narratorId: f.id,
		userId: f.user,
		cwd: newRoot,
		locale: "en",
		signal: new AbortController().signal,
		currentToolUseId: use,
		toolCallBinding: { toolCallId: tool, attempt: 1 },
		executionTarget: target,
		requestPermission: async () => ({ behavior: "allow" }),
	});
	expect(written.isError, String(written.output)).not.toBe(true);
	db.update(schema.narratorToolCalls)
		.set({ status: "success" })
		.where(eq(schema.narratorToolCalls.id, tool))
		.run();
	const newOperation = db
		.select({ id: schema.narratorToolCalls.fileChangeOperationId })
		.from(schema.narratorToolCalls)
		.where(eq(schema.narratorToolCalls.id, tool))
		.get();
	if (!newOperation?.id) throw new Error("New Write operation missing");
	const newEffect = db
		.select({ scope: schema.fileChangeEffects.scopeId })
		.from(schema.fileChangeEffects)
		.where(eq(schema.fileChangeEffects.operationId, newOperation.id))
		.limit(1)
		.get();
	if (!newEffect) throw new Error("New Write effect missing");
	expect(origin.scopeIds).not.toContain(newEffect.scope);
	const preview = await f.http("revert-action-preview", {
		idempotencyKey: generateId(),
		action: "revert_files",
		messageId: message,
	});
	const body = await preview.json();
	expect(preview.status, JSON.stringify(body)).toBe(200);
	expect(body.plan, JSON.stringify(body)).not.toBeNull();
	expect(body.plan.coverageComplete).toBe(true);
	const applied = await f.http(`revert-plans/${body.plan.id}/apply`, {
		planHash: body.plan.planHash,
		action: "revert_files",
	});
	const result = await applied.json();
	expect(applied.status, JSON.stringify(result)).toBe(200);
	expect(result.status).toBe("committed");
	expect(await readFile(newFile, "utf8")).toBe("new workspace before\n");
	expect(await readFile(f.file, "utf8")).toBe("after\n");
	// New cwd authority must not restore any retained old scope under the new context.
	const oldPreview = await f.http("revert-action-preview", {
		idempotencyKey: generateId(),
		action: "revert_files",
		messageId: f.message,
	});
	const oldBody = await oldPreview.json();
	expect(oldBody.plan).toBeNull();
	expect(await readFile(f.file, "utf8")).toBe("after\n");
	expect(await readFile(newFile, "utf8")).toBe("new workspace before\n");
});

test("new complete operations reusing an old scope after switch-back do not inherit old-epoch restore restrictions", async () => {
	const f = await fixture(true);
	const origin = await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor);
	if (!origin) throw new Error("Original provenance missing");
	const other = await mkdtemp(join(testEnvironment.isolatedHome, "switch-away-"));
	paths.push(other);
	for (const [revision, root] of [
		[1, other],
		[2, f.root],
	] as const) {
		const response = await f.http("workspace-context/switch", {
			expectedRevision: revision,
			requestId: generateId(),
			target: { deviceId: "local", cwd: root },
		});
		expect(response.status, await response.text()).toBe(200);
	}
	const fresh = await completeWriteAt(f, f.root, 1000);
	expect(origin.scopeIds).toContain(fresh.scopeId);
	const response = await f.http("revert-action-preview", {
		idempotencyKey: generateId(),
		action: "revert_files",
		messageId: fresh.message,
	});
	const preview = await response.json();
	expect(response.status, JSON.stringify(preview)).toBe(200);
	expect(preview.plan, JSON.stringify(preview)).not.toBeNull();
	const applied = await f.http(`revert-plans/${preview.plan.id}/apply`, {
		planHash: preview.plan.planHash,
		action: "revert_files",
	});
	const result = await applied.json();
	expect(applied.status, JSON.stringify(result)).toBe(200);
	expect(result.status).toBe("committed");
	expect(await readFile(f.file, "utf8")).toBe("after\n");
	const old = await f.http("revert-action-preview", {
		idempotencyKey: generateId(),
		action: "revert_files",
		messageId: f.message,
	});
	expect((await old.json()).plan).toBeNull();
	expect(await readFile(f.file, "utf8")).toBe("after\n");
});

for (const mutation of ["ACL", "digest", "namespace"] as const) {
	test(`SHA worker success cannot survive ${mutation} change before the response`, async () => {
		const f = await fixture();
		const claim = db
			.select({
				id: schema.legacyMigrationArtifactClaims.id,
				path: schema.legacyMigrationArtifactClaims.artifactPath,
			})
			.from(schema.legacyMigrationArtifactClaims)
			.where(eq(schema.legacyMigrationArtifactClaims.narratorId, f.id))
			.limit(1)
			.get();
		if (!claim) throw new Error("Shadow claim missing");
		const originalRead = membershipReader.readLegacySnapshotMembership;
		let observedWorkerSuccess = false;
		const injected = spyOn(membershipReader, "readLegacySnapshotMembership").mockImplementation(
			async (...args) => {
				const allowed = await originalRead(...args);
				observedWorkerSuccess = allowed;
				if (mutation === "ACL")
					db.update(schema.narrators)
						.set({ ownerUserId: null })
						.where(eq(schema.narrators.id, f.id))
						.run();
				if (mutation === "digest")
					db.update(schema.legacyMigrationArtifactClaims)
						.set({ manifestDigest: "f".repeat(64) })
						.where(eq(schema.legacyMigrationArtifactClaims.id, claim.id))
						.run();
				if (mutation === "namespace") {
					const originalArtifact = `${claim.path}-original`;
					paths.push(originalArtifact);
					await rename(claim.path, originalArtifact);
					await mkdir(claim.path);
				}
				return allowed;
			},
		);
		try {
			expect(
				await isAuthorizedLegacyRetainedSnapshotCommit(claim.id, f.actor, f.snapshot).catch(
					() => false,
				),
			).toBe(false);
			expect(observedWorkerSuccess).toBe(true);
		} finally {
			injected.mockRestore();
		}
	});
}
