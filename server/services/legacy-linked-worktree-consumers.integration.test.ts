import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { testEnvironment } from "../../tests/preload";
import { app } from "../app";
import { db, sqlite } from "../db";
import { getDbPath } from "../db/connection";
import * as schema from "../db/schema";
import { localBackend } from "../lib/agent/execution/local-backend";
import { agentWorktreeTools } from "../lib/agent/tools/worktree";
import { writeTool } from "../lib/agent/tools/write";
import { createToken } from "../lib/auth";
import { generateId } from "../lib/id";
import { getNarraforkHome } from "../lib/narrafork-home";
import { executionPolicyEngine } from "./execution-policy/engine";
import { getDefaultLocalFileChangeRuntime } from "./file-change-runtime";
import { gitWorkspaceIdentity } from "./git-workspace";
import { prepareLegacyRootAdoption } from "./legacy-main-checkout-adoption";
import { createLegacyProjectMigrationService } from "./legacy-project-migration-core";
import {
	getAuthorizedLegacyRetainedHistoryOrigin,
	isAuthorizedLegacyRetainedSnapshotCommit,
} from "./legacy-retained-history-origin";
import { canUseLegacyWorkspaceRollbackBridge } from "./legacy-workspace-rollback-bridge";
import { narratorWorktreeService } from "./narrator-worktree-runtime";
import { treeSnapshotPhysicalDir } from "./tree-snapshot-paths";
import { assertWorkspaceHistoryRevertSupported } from "./workspace-context-service";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

// Real readonly probes, HTTP workers and lease settlement on a shared CI host.
setDefaultTimeout(15_000);
const paths: string[] = [];
afterEach(async () => {
	for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
function git(root: string, ...args: string[]) {
	return execFileSync("git", ["--no-optional-locks", "-C", root, ...args], {
		timeout: 5000,
		maxBuffer: 65536,
		encoding: "utf8",
		env: {
			...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@test",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@test",
		},
	}).trim();
}
async function fixture(
	complete = false,
	retainedScopeCount = 0,
	additionalNarrators = 0,
	includeRoot0Narrator = false,
) {
	expect(process.env.NARRAFORK_TEST).toBe("1");
	expect(getNarraforkHome()).toBe(testEnvironment.narraforkHome);
	expect(getDbPath().startsWith(testEnvironment.narraforkHome)).toBe(true);
	const folder = await mkdtemp(join(testEnvironment.isolatedHome, "linked-consumer-"));
	const projectRoot = join(folder, "main"),
		root = join(folder, "linked"),
		file = join(root, "file.txt");
	paths.push(folder, treeSnapshotPhysicalDir("local", root));
	await mkdir(projectRoot);
	git(projectRoot, "init", "--quiet", "--initial-branch=main-fixture");
	await writeFile(join(projectRoot, "file.txt"), "before\n");
	git(projectRoot, "add", "file.txt");
	git(projectRoot, "commit", "--quiet", "-m", "fixture");
	git(projectRoot, "worktree", "add", "--quiet", "-b", "linked-fixture", root);
	const before = await worktreeTreeSnapshot.capture(root, "local");
	const snapshot = await worktreeTreeSnapshot.linkSnapshot(root, before, "history", "local");
	if (!snapshot) throw new Error("Snapshot missing");
	await writeFile(file, "after\n");
	const after = await worktreeTreeSnapshot.capture(root, "local");
	const id = generateId(),
		user = generateId(),
		project = generateId(),
		chapter = generateId(),
		rootChapter = generateId();
	const message = generateId(),
		tool = generateId(),
		use = generateId(),
		now = new Date().toISOString();
	db.insert(schema.users)
		.values({ id: user, username: user, passwordHash: "x", createdAt: now })
		.run();
	db.insert(schema.projects)
		.values({
			id: project,
			name: "Linked",
			ownerUserId: user,
			gitPath: projectRoot,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.chapters)
		.values({
			id: rootChapter,
			projectId: project,
			title: "Root0",
			branch: "main-fixture",
			baseBranch: "main-fixture",
			isRoot: 1,
			worktreePath: projectRoot,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.chapters)
		.values({
			id: chapter,
			projectId: project,
			title: "Linked",
			branch: "linked-fixture",
			baseBranch: "main-fixture",
			isRoot: 0,
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
	const executeWrite = async (currentRoot: string, content: string, seq?: number) => {
		const currentFile = join(currentRoot, "file.txt");
		const currentMessage = seq === undefined ? message : generateId();
		const currentTool = seq === undefined ? tool : generateId();
		const currentUse = seq === undefined ? use : generateId();
		const input = { file_path: currentFile, content };
		if (seq !== undefined) {
			db.insert(schema.narratorMessages)
				.values({
					id: currentMessage,
					narratorId: id,
					role: "assistant",
					contentJson: [{ type: "tool_use", id: currentUse, name: "Write", input }],
					createdAt: now,
				})
				.run();
			db.insert(schema.narratorMessageRefs)
				.values({ id: generateId(), narratorId: id, messageId: currentMessage, seq })
				.run();
			db.insert(schema.narratorToolCalls)
				.values({
					id: currentTool,
					narratorId: id,
					messageId: currentMessage,
					toolUseId: currentUse,
					toolName: "Write",
					status: "running",
					createdAt: now,
				})
				.run();
		} else
			db.update(schema.narratorMessages)
				.set({ contentJson: [{ type: "tool_use", id: use, name: "Write", input }] })
				.where(eq(schema.narratorMessages.id, message))
				.run();
		await getDefaultLocalFileChangeRuntime();
		const targetPath = await localBackend.resolvePathIdentity(currentFile);
		const target = {
			deviceId: "local",
			backendKind: "local" as const,
			cwd: currentRoot,
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
				executionDeviceId: "local",
				executionCwd: currentRoot,
				executionPathFlavor: target.pathFlavor,
				resolvedFilePath: currentFile,
				canonicalFilePath: target.canonicalPath,
			})
			.where(eq(schema.narratorToolCalls.id, currentTool))
			.run();
		const result = await writeTool.execute(input, {
			narratorId: id,
			userId: user,
			cwd: currentRoot,
			locale: "en",
			signal: new AbortController().signal,
			currentToolUseId: currentUse,
			toolCallBinding: { toolCallId: currentTool, attempt: 1 },
			executionTarget: target,
			requestPermission: async () => ({ behavior: "allow" }),
		});
		expect(result.isError, String(result.output)).not.toBe(true);
		db.update(schema.narratorToolCalls)
			.set({ status: "success" })
			.where(eq(schema.narratorToolCalls.id, currentTool))
			.run();
		return currentMessage;
	};
	if (complete) {
		await writeFile(file, "before\n");
		await executeWrite(root, "after\n");
	}
	const retainedScopeIds: string[] = [];
	if (retainedScopeCount > 0) {
		const actual = await db.query.fileChangeScopes.findFirst({
			where: eq(schema.fileChangeScopes.canonicalRoot, root),
		});
		if (
			!actual ||
			actual.status !== "active" ||
			actual.activeMutationCount !== 0 ||
			actual.activeLeaseId !== null
		)
			throw new Error("Actual settled physical scope missing");
		retainedScopeIds.push(actual.id);
		for (let i = 1; i < retainedScopeCount; i++) {
			const scopeId = generateId();
			// Historical healthy incarnations retain the actual source and physical
			// identity. Only the immutable scope/workspace-incarnation IDs differ.
			db.insert(schema.fileChangeScopes)
				.values({
					...actual,
					id: scopeId,
					workspaceInstanceId: `history-${i}-${actual.workspaceInstanceId}`,
				})
				.run();
			retainedScopeIds.push(scopeId);
		}
	}
	const rootNarratorId = includeRoot0Narrator ? generateId() : null;
	if (rootNarratorId)
		db.insert(schema.narrators)
			.values({
				id: rootNarratorId,
				chapterId: rootChapter,
				ownerUserId: user,
				cwd: null,
				workspaceRevision: 0,
				createdAt: now,
				updatedAt: now,
			})
			.run();
	const additionalNarratorIds: string[] = [];
	for (let index = 0; index < additionalNarrators; index++) {
		const sibling = generateId();
		db.insert(schema.narrators)
			.values({
				id: sibling,
				chapterId: chapter,
				ownerUserId: user,
				cwd: null,
				workspaceRevision: 0,
				createdAt: now,
				updatedAt: now,
			})
			.run();
		additionalNarratorIds.push(sibling);
	}
	const actor = { userId: user, isAdmin: false };
	const migration = createLegacyProjectMigrationService({
		sqlite,
		mainDatabasePath: getDbPath(),
		retainedHistoryConsumersReady: true,
		linkedWorktreeConsumersReady: true,
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
	return {
		folder,
		root,
		projectRoot,
		file,
		id,
		actor,
		use,
		message,
		snapshot: snapshot.commitSha,
		http,
		executeWrite,
		retainedScopeIds,
		additionalNarratorIds,
		rootNarratorId,
	};
}
async function previewRestore(f: Awaited<ReturnType<typeof fixture>>, messageId = "__all__") {
	const response = await f.http("revert-action-preview", {
		idempotencyKey: generateId(),
		action: "revert_files",
		messageId,
	});
	const body = await response.json();
	expect(response.status, JSON.stringify(body)).toBe(200);
	return body;
}

test("linked archived preview and snapshot membership survive cwd move with current claim and ACL", async () => {
	const f = await fixture();
	const origin = await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor);
	expect(origin?.origin.workspacePath).toBe(f.root);
	expect(origin?.linkedWorktree?.resourceId).toBeDefined();
	const response = await f.http(`tool-calls/${f.use}/file-edit-preview`);
	const body = await response.json();
	expect(response.status).toBe(200);
	expect(body.before).toEqual({ status: "available", content: "before\n" });
	expect(body.after).toEqual({ status: "available", content: "after\n" });
	const claim = db
		.select({ id: schema.legacyMigrationArtifactClaims.id })
		.from(schema.legacyMigrationArtifactClaims)
		.where(eq(schema.legacyMigrationArtifactClaims.narratorId, f.id))
		.limit(1)
		.get();
	if (!claim) throw new Error("Archive missing");
	expect(await isAuthorizedLegacyRetainedSnapshotCommit(claim.id, f.actor, f.snapshot)).toBe(true);
	db.update(schema.narrators)
		.set({ cwd: f.projectRoot, workspaceRevision: 2 })
		.where(eq(schema.narrators.id, f.id))
		.run();
	expect(await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor)).not.toBeNull();
	expect((await (await f.http(`tool-calls/${f.use}/file-edit-preview`)).json()).before.status).toBe(
		"available",
	);
	db.update(schema.narratorWorktreeResourceClaims)
		.set({ state: "released" })
		.where(eq(schema.narratorWorktreeResourceClaims.narratorId, f.id))
		.run();
	expect(await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor)).toBeNull();
});

test("150 healthy same-source physical scope incarnations survive real migration and authorized reads", async () => {
	const f = await fixture(true, 150);
	const origin = await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor);
	if (!origin?.linkedWorktree) throw new Error("Linked origin missing");
	expect(origin.scopeIds).toHaveLength(150);
	expect([...origin.scopeIds].sort()).toEqual([...f.retainedScopeIds].sort());
	expect(Buffer.byteLength(JSON.stringify(origin))).toBeLessThan(65536);
	const response = await f.http(`tool-calls/${f.use}/file-edit-preview`);
	const body = await response.json();
	expect(response.status, JSON.stringify(body)).toBe(200);
	expect(body.before).toEqual({ status: "available", content: "before\n" });
	expect(body.after).toEqual({ status: "available", content: "after\n" });
	// Count relaxation is not permission to replace an owned set with duplicate IDs.
	db.update(schema.legacyNarratorWorkspaceAdoptions)
		.set({
			originJson: JSON.parse(
				JSON.stringify({
					...origin,
					scopeIds: [origin.scopeIds[0], origin.scopeIds[0]],
				}),
			),
		})
		.where(eq(schema.legacyNarratorWorkspaceAdoptions.narratorId, f.id))
		.run();
	expect(await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor)).toBeNull();
});

test("linked adoption origin retains the 64KiB budget independently of its 16KiB native identity", async () => {
	const f = await fixture();
	const origin = await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor);
	if (!origin?.linkedWorktree) throw new Error("Linked origin missing");
	// Non-authorizing extension bytes exercise the projection ceiling without replacing
	// the actual chapter/workspace/namespace, claimant, native proof or history digest.
	const bounded = { ...origin, budgetFixturePadding: "x".repeat(20_000) };
	expect(Buffer.byteLength(JSON.stringify(bounded))).toBeGreaterThan(16384);
	expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThan(65536);
	db.update(schema.legacyNarratorWorkspaceAdoptions)
		.set({ originJson: JSON.parse(JSON.stringify(bounded)) })
		.where(eq(schema.legacyNarratorWorkspaceAdoptions.narratorId, f.id))
		.run();
	expect((await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor))?.linkedWorktree).toEqual(
		origin.linkedWorktree,
	);
	expect((await (await f.http(`tool-calls/${f.use}/file-edit-preview`)).json()).before.status).toBe(
		"available",
	);
	const oversized = { ...origin, budgetFixturePadding: "x".repeat(65536) };
	db.update(schema.legacyNarratorWorkspaceAdoptions)
		.set({ originJson: JSON.parse(JSON.stringify(oversized)) })
		.where(eq(schema.legacyNarratorWorkspaceAdoptions.narratorId, f.id))
		.run();
	expect(await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor)).toBeNull();
});

test("linked archived reads reject missing markers, tampered evidence, stale claim revisions and changed owners", async () => {
	const f = await fixture();
	const origin = await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor);
	if (!origin?.linkedWorktree) throw new Error("Linked origin missing");
	const resourceId = origin.linkedWorktree.resourceId;
	const saved = await db.query.narratorWorktreeResourceOrigins.findFirst({
		where: eq(schema.narratorWorktreeResourceOrigins.resourceId, resourceId),
	});
	const claim = await db.query.narratorWorktreeResourceClaims.findFirst({
		where: eq(schema.narratorWorktreeResourceClaims.narratorId, f.id),
	});
	if (!saved || !claim) throw new Error("Claim missing");
	const missingMarker = { ...origin };
	delete missingMarker.linkedWorktree;
	db.update(schema.legacyNarratorWorkspaceAdoptions)
		.set({ originJson: JSON.parse(JSON.stringify(missingMarker)) })
		.where(eq(schema.legacyNarratorWorkspaceAdoptions.narratorId, f.id))
		.run();
	expect(await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor)).toBeNull();
	db.update(schema.legacyNarratorWorkspaceAdoptions)
		.set({ originJson: JSON.parse(JSON.stringify(origin)) })
		.where(eq(schema.legacyNarratorWorkspaceAdoptions.narratorId, f.id))
		.run();
	db.update(schema.narratorWorktreeResourceOrigins)
		.set({ evidenceJson: { ...saved.evidenceJson, branch: "refs/heads/tampered" } })
		.where(eq(schema.narratorWorktreeResourceOrigins.resourceId, resourceId))
		.run();
	expect(await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor)).toBeNull();
	db.update(schema.narratorWorktreeResourceOrigins)
		.set({ evidenceJson: saved.evidenceJson })
		.where(eq(schema.narratorWorktreeResourceOrigins.resourceId, resourceId))
		.run();
	db.update(schema.narratorWorktreeResourceClaims)
		.set({ ownershipRevision: claim.ownershipRevision + 1 })
		.where(eq(schema.narratorWorktreeResourceClaims.id, claim.id))
		.run();
	expect(await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor)).toBeNull();
	db.update(schema.narratorWorktreeResourceClaims)
		.set({ ownershipRevision: claim.ownershipRevision })
		.where(eq(schema.narratorWorktreeResourceClaims.id, claim.id))
		.run();
	expect(await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor)).not.toBeNull();
	const resource = await db.query.narratorWorktreeResources.findFirst({
		where: eq(schema.narratorWorktreeResources.id, resourceId),
	});
	if (!resource) throw new Error("Resource missing");
	db.update(schema.narratorWorktreeResources)
		.set({ repositoryKey: "different-namespace" })
		.where(eq(schema.narratorWorktreeResources.id, resourceId))
		.run();
	expect(await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor)).toBeNull();
	db.update(schema.narratorWorktreeResources)
		.set({ repositoryKey: resource.repositoryKey })
		.where(eq(schema.narratorWorktreeResources.id, resourceId))
		.run();
	const other = generateId();
	db.insert(schema.users)
		.values({ id: other, username: other, passwordHash: "x", createdAt: new Date().toISOString() })
		.run();
	db.update(schema.narrators)
		.set({ ownerUserId: other })
		.where(eq(schema.narrators.id, f.id))
		.run();
	await expect(getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor)).rejects.toThrow();
});

test("linked old complete file restores through HTTP worker/lease while whole-tree stays closed", async () => {
	const f = await fixture(true);
	const row = await db.query.narrators.findFirst({ where: eq(schema.narrators.id, f.id) });
	if (!row) throw new Error("Narrator missing");
	expect(await canUseLegacyWorkspaceRollbackBridge(row, f.actor)).toBe(true);
	expect(await canUseLegacyWorkspaceRollbackBridge(row)).toBe(false);
	await expect(assertWorkspaceHistoryRevertSupported(f.id)).rejects.toThrow();
	const body = await previewRestore(f);
	expect(body.plan.coverageComplete).toBe(true);
	const response = await f.http(`revert-plans/${body.plan.id}/apply`, {
		planHash: body.plan.planHash,
		action: "revert_files",
	});
	const result = await response.json();
	expect(response.status, JSON.stringify(result)).toBe(200);
	expect(result.status).toBe("committed");
	expect(await readFile(f.file, "utf8")).toBe("before\n");
});

test("normal same-branch commit and index updates preserve archived reads and complete old file restoration", async () => {
	const f = await fixture(true);
	const origin = await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor);
	if (!origin?.linkedWorktree) throw new Error("Linked origin missing");
	const oldHead = git(f.root, "rev-parse", "HEAD");
	const indexPath = join(origin.linkedWorktree.gitAdminDirectoryPath, "index");
	const oldIndex = await readFile(indexPath);
	git(f.root, "add", "file.txt");
	git(f.root, "commit", "--quiet", "-m", "normal post-adoption commit");
	expect(git(f.root, "rev-parse", "HEAD")).not.toBe(oldHead);
	expect((await readFile(indexPath)).equals(oldIndex)).toBe(false);
	expect(git(f.root, "symbolic-ref", "HEAD")).toBe("refs/heads/linked-fixture");
	expect((await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor))?.linkedWorktree).toEqual(
		origin.linkedWorktree,
	);
	const archived = await (await f.http(`tool-calls/${f.use}/file-edit-preview`)).json();
	expect(archived.before).toEqual({ status: "available", content: "before\n" });
	const row = await db.query.narrators.findFirst({ where: eq(schema.narrators.id, f.id) });
	if (!row) throw new Error("Narrator missing");
	expect(await canUseLegacyWorkspaceRollbackBridge(row, f.actor)).toBe(true);
	const body = await previewRestore(f);
	expect(body.plan, JSON.stringify(body)).not.toBeNull();
	expect(body.plan.coverageComplete).toBe(true);
	const response = await f.http(`revert-plans/${body.plan.id}/apply`, {
		planHash: body.plan.planHash,
		action: "revert_files",
	});
	const result = await response.json();
	expect(response.status, JSON.stringify(result)).toBe(200);
	expect(result.status).toBe("committed");
	expect(await readFile(f.file, "utf8")).toBe("before\n");
	expect(git(f.root, "rev-parse", "HEAD")).not.toBe(oldHead);
});

test("linked retired old origin does not bind modern writes in a normally switched workspace", async () => {
	const f = await fixture(true);
	const newRoot = join(f.folder, "new-workspace");
	await mkdir(newRoot);
	const switched = await f.http("workspace-context/switch", {
		expectedRevision: 1,
		requestId: generateId(),
		target: { deviceId: "local", cwd: newRoot },
	});
	const switchedBody = await switched.json();
	expect(switched.status, JSON.stringify(switchedBody)).toBe(200);
	await writeFile(join(newRoot, "file.txt"), "new before\n");
	const message = await f.executeWrite(newRoot, "new after\n", 100);
	const body = await previewRestore(f, message);
	expect(body.plan, JSON.stringify(body)).not.toBeNull();
	expect(body.plan.coverageComplete).toBe(true);
	const applied = await f.http(`revert-plans/${body.plan.id}/apply`, {
		planHash: body.plan.planHash,
		action: "revert_files",
	});
	const result = await applied.json();
	expect(applied.status, JSON.stringify(result)).toBe(200);
	expect(result.status).toBe("committed");
	expect(await readFile(join(newRoot, "file.txt"), "utf8")).toBe("new before\n");
	expect((await previewRestore(f, f.message)).plan).toBeNull();
	expect(await readFile(f.file, "utf8")).toBe("after\n");
});

test("linked reused old scope still classifies modern operation PKs without relaxing old or mixed restore", async () => {
	const f = await fixture(true);
	const origin = await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor);
	if (!origin?.scopeIds.length) throw new Error("Old scopes missing");
	const newRoot = join(f.folder, "switch-away");
	await mkdir(newRoot);
	for (const [cwd, revision] of [
		[newRoot, 1],
		[f.root, 2],
	] as const) {
		const switched = await f.http("workspace-context/switch", {
			expectedRevision: revision,
			requestId: generateId(),
			target: { deviceId: "local", cwd },
		});
		const result = await switched.json();
		expect(switched.status, JSON.stringify(result)).toBe(200);
	}
	const message = await f.executeWrite(f.root, "modern linked bytes\n", 100);
	const body = await previewRestore(f, message);
	expect(body.plan, JSON.stringify(body)).not.toBeNull();
	expect(body.plan.coverageComplete).toBe(true);
	const applied = await f.http(`revert-plans/${body.plan.id}/apply`, {
		planHash: body.plan.planHash,
		action: "revert_files",
	});
	const result = await applied.json();
	expect(applied.status, JSON.stringify(result)).toBe(200);
	expect(result.status).toBe("committed");
	expect(await readFile(f.file, "utf8")).toBe("after\n");
	expect((await previewRestore(f, f.message)).plan).toBeNull();
	expect((await previewRestore(f)).plan).toBeNull();
});

for (const changed of ["root", "common", "admin", "workspace"] as const) {
	test(`linked replacement ${changed} incarnation refuses old restore without deleting archive reads`, async () => {
		const f = await fixture(true);
		const origin = await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor);
		if (!origin?.linkedWorktree) throw new Error("Linked origin missing");
		const path =
			changed === "root"
				? f.projectRoot
				: changed === "common"
					? origin.linkedWorktree.commonDirectoryPath
					: changed === "admin"
						? origin.linkedWorktree.gitAdminDirectoryPath
						: f.root;
		await rename(path, `${path}.original`);
		await mkdir(path);
		if (changed === "workspace") await writeFile(f.file, "after\n");
		const body = await previewRestore(f);
		expect(body.plan).toBeNull();
		expect(await readFile(f.file, "utf8")).toBe("after\n");
		expect(await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor)).not.toBeNull();
		const archived = await (await f.http(`tool-calls/${f.use}/file-edit-preview`)).json();
		expect(archived.before.status).toBe("available");
	});
}

test("linked replaced gitfile, branch and unknown claim refuse old restore", async () => {
	const f = await fixture(true);
	const row = await db.query.narrators.findFirst({ where: eq(schema.narrators.id, f.id) });
	if (!row) throw new Error("Narrator missing");
	const gitfile = join(f.root, ".git");
	await rename(gitfile, `${gitfile}.original`);
	await writeFile(gitfile, await readFile(`${gitfile}.original`));
	expect(await canUseLegacyWorkspaceRollbackBridge(row, f.actor)).toBe(false);
	expect((await previewRestore(f)).plan).toBeNull();
	expect(await readFile(f.file, "utf8")).toBe("after\n");
	await rm(gitfile);
	await rename(`${gitfile}.original`, gitfile);
	git(f.root, "symbolic-ref", "HEAD", "refs/heads/main-fixture");
	expect(await canUseLegacyWorkspaceRollbackBridge(row, f.actor)).toBe(false);
	git(f.root, "symbolic-ref", "HEAD", "refs/heads/linked-fixture");
	const resourceId = (await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor))?.linkedWorktree
		?.resourceId;
	if (!resourceId) throw new Error("Resource missing");
	db.update(schema.narratorWorktreeResources)
		.set({ scopeKind: "unknown" })
		.where(eq(schema.narratorWorktreeResources.id, resourceId))
		.run();
	expect((await previewRestore(f)).plan).toBeNull();
	expect(await readFile(f.file, "utf8")).toBe("after\n");
});

// Runtime tests share the *actual migrated* HTTP fixture above; no metadata-store mock ports.
const unexpectedWorktreePermission = async () => {
	throw new Error("Unexpected tool permission request in read/denied fixture");
};
test("linked current worktree HTTP and real singleton preserve source repo/index while listing", async () => {
	const f = await fixture();
	const workspaceKey = gitWorkspaceIdentity(localBackend, f.root);
	const index = git(f.root, "rev-parse", "--path-format=absolute", "--git-path", "index");
	const indexBefore = await readFile(index);
	const gitfileBefore = await readFile(join(f.root, ".git"));
	const response = await f.http(`git/worktrees?workspaceKey=${workspaceKey}`);
	expect(response.status, await response.clone().text()).toBe(200);
	const result = await response.json();
	expect(result.entries.map((entry: { path: string }) => entry.path).sort()).toEqual(
		[f.root, f.projectRoot].sort(),
	);
	const singleton = await narratorWorktreeService.list(
		f.actor,
		f.id,
		{ workspaceKey },
		new AbortController().signal,
	);
	expect(singleton.repositoryKey).toBe(
		gitWorkspaceIdentity(localBackend, join(f.projectRoot, ".git")),
	);
	expect(singleton.entries.map((entry) => entry.path).sort()).toEqual(
		[f.root, f.projectRoot].sort(),
	);
	const narrator = await db.query.narrators.findFirst({ where: eq(schema.narrators.id, f.id) });
	if (!narrator?.workspaceContext) throw new Error("Current committed workspace missing");
	const tool = agentWorktreeTools.find((candidate) => candidate.name === "ListWorktrees");
	if (!tool) throw new Error("Normal ListWorktrees tool missing");
	const toolResult = await tool.execute(
		{},
		{
			narratorId: f.id,
			userId: f.actor.userId,
			cwd: f.root,
			locale: "en",
			signal: new AbortController().signal,
			workspaceContext: narrator.workspaceContext,
			requestPermission: unexpectedWorktreePermission,
		},
	);
	expect(toolResult.isError).not.toBe(true);
	expect(JSON.parse(String(toolResult.output)).repositoryKey).toBe(singleton.repositoryKey);
	expect(
		JSON.parse(String(toolResult.output))
			.entries.map((entry: { path: string }) => entry.path)
			.sort(),
	).toEqual([f.root, f.projectRoot].sort());
	expect(await readFile(index)).toEqual(indexBefore);
	expect(await readFile(join(f.root, ".git"))).toEqual(gitfileBefore);
});

test("linked runtime same-owner second current claim works; same cwd alone and foreign owner cannot adopt it", async () => {
	const f = await fixture(false, 0, 1);
	const workspaceKey = gitWorkspaceIdentity(localBackend, f.root);
	const original = await db.query.narrators.findFirst({ where: eq(schema.narrators.id, f.id) });
	const proof = await db.query.legacyNarratorWorkspaceAdoptions.findFirst({
		where: eq(schema.legacyNarratorWorkspaceAdoptions.narratorId, f.id),
	});
	const claim = db
		.select()
		.from(schema.narratorWorktreeResourceClaims)
		.where(eq(schema.narratorWorktreeResourceClaims.narratorId, f.id))
		.limit(1)
		.get();
	if (!original || !proof?.originJson || !claim) throw new Error("Migration bound fixture missing");
	const second = f.additionalNarratorIds[0];
	if (!second) throw new Error("Actual second migrated claimant missing");
	const sameCwd = generateId(),
		foreign = generateId(),
		otherUser = generateId();
	const now = new Date().toISOString();
	db.insert(schema.users)
		.values({ id: otherUser, username: otherUser, passwordHash: "x", createdAt: now })
		.run();
	for (const [id, ownerUserId] of [
		[sameCwd, f.actor.userId],
		[foreign, otherUser],
	])
		db.insert(schema.narrators)
			.values({ ...original, id: id as string, ownerUserId: ownerUserId as string })
			.run();
	for (const id of [foreign]) {
		db.insert(schema.legacyNarratorWorkspaceAdoptions)
			.values({
				...proof,
				narratorId: id,
				originJson: { ...proof.originJson, origin: { ...proof.originJson.origin, narratorId: id } },
			})
			.run();
		db.insert(schema.narratorWorktreeResourceClaims)
			.values({ ...claim, id: generateId(), narratorId: id })
			.run();
	}
	expect(
		(
			await narratorWorktreeService.list(
				f.actor,
				second,
				{ workspaceKey },
				new AbortController().signal,
			)
		).entries,
	).toHaveLength(2);
	await expect(
		narratorWorktreeService.list(f.actor, sameCwd, { workspaceKey }, new AbortController().signal),
	).rejects.toThrow();
	await expect(
		narratorWorktreeService.list(
			{ userId: otherUser, isAdmin: false },
			foreign,
			{ workspaceKey },
			new AbortController().signal,
		),
	).rejects.toThrow();
});

test("linked runtime HTTP refuses missing/stale/unresolved current claim, changed owner and missing namespace", async () => {
	const f = await fixture();
	const workspaceKey = gitWorkspaceIdentity(localBackend, f.root);
	const claim = db
		.select()
		.from(schema.narratorWorktreeResourceClaims)
		.where(eq(schema.narratorWorktreeResourceClaims.narratorId, f.id))
		.limit(1)
		.get();
	if (!claim) throw new Error("Claim missing");
	const request = () => f.http(`git/worktrees?workspaceKey=${workspaceKey}`);
	for (const patch of [
		{ state: "unresolved" as const },
		{ ownershipRevision: claim.ownershipRevision + 1 },
		{ ownerUserId: null },
	]) {
		db.update(schema.narratorWorktreeResourceClaims)
			.set({ ...claim, ...patch })
			.where(eq(schema.narratorWorktreeResourceClaims.id, claim.id))
			.run();
		expect((await request()).status).toBe(403);
	}
	db.delete(schema.narratorWorktreeResourceClaims)
		.where(eq(schema.narratorWorktreeResourceClaims.id, claim.id))
		.run();
	expect((await request()).status).toBe(403);
	db.insert(schema.narratorWorktreeResourceClaims).values(claim).run();
	db.update(schema.narratorWorktreeResources)
		.set({ state: "unknown" })
		.where(eq(schema.narratorWorktreeResources.id, claim.resourceId))
		.run();
	expect((await request()).status).toBe(403);
	db.update(schema.narratorWorktreeResources)
		.set({ state: "ready" })
		.where(eq(schema.narratorWorktreeResources.id, claim.resourceId))
		.run();
	// Archive provenance is RESTRICT-protected: corrupt its digest rather than bypassing its FK.
	db.update(schema.legacyRetainedChapterMetadata)
		.set({ manifestDigest: "tampered" })
		.where(eq(schema.legacyRetainedChapterMetadata.sourceChapterId, claim.sourceChapterId))
		.run();
	expect((await request()).status).toBe(403);
});

test("linked runtime actual Git admin identity cannot be replaced by matching forged summary paths", async () => {
	const f = await fixture();
	const workspaceKey = gitWorkspaceIdentity(localBackend, f.root);
	const claim = db
		.select({ resourceId: schema.narratorWorktreeResourceClaims.resourceId })
		.from(schema.narratorWorktreeResourceClaims)
		.where(eq(schema.narratorWorktreeResourceClaims.narratorId, f.id))
		.limit(1)
		.get();
	if (!claim) throw new Error("Claim missing");
	const gitfile = await readFile(join(f.root, ".git"));
	const wrongAdmin = join(f.projectRoot, ".git");
	db.update(schema.narratorWorktreeResourceOrigins)
		.set({ gitAdminDirectoryPath: wrongAdmin })
		.where(eq(schema.narratorWorktreeResourceOrigins.resourceId, claim.resourceId))
		.run();
	sqlite
		.query(
			"UPDATE legacy_narrator_workspace_adoptions SET origin_json=json_set(origin_json,'$.linkedWorktree.gitAdminDirectoryPath',?) WHERE narrator_id=?",
		)
		.run(wrongAdmin, f.id);
	expect((await f.http(`git/worktrees?workspaceKey=${workspaceKey}`)).status).toBe(403);
	expect(await readFile(join(f.root, ".git"))).toEqual(gitfile);
});

for (const component of ["root", "common", "admin", "gitfile"] as const) {
	test(`linked runtime same-path replacement of ${component} refuses current namespace access`, async () => {
		const f = await fixture();
		const origin = await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor);
		if (!origin?.linkedWorktree) throw new Error("Binding missing");
		const path =
			component === "root"
				? f.root
				: component === "common"
					? origin.linkedWorktree.commonDirectoryPath
					: component === "admin"
						? origin.linkedWorktree.gitAdminDirectoryPath
						: join(f.root, ".git");
		await rename(path, `${path}.original`);
		await cp(`${path}.original`, path, { recursive: component !== "gitfile" });
		const response = await f.http(
			`git/worktrees?workspaceKey=${gitWorkspaceIdentity(localBackend, f.root)}`,
		);
		expect(response.status).toBe(403);
		expect(await readFile(f.file, "utf8")).toBe("after\n");
	});
}

for (const component of ["root", "common", "admin", "gitfile"] as const) {
	test(`linked runtime refresh-await gap replacement of ${component} is denied by final snapshot`, async () => {
		const f = await fixture();
		const origin = await getAuthorizedLegacyRetainedHistoryOrigin(f.id, f.actor);
		if (!origin?.linkedWorktree) throw new Error("Binding missing");
		const path =
			component === "root"
				? f.root
				: component === "common"
					? origin.linkedWorktree.commonDirectoryPath
					: component === "admin"
						? origin.linkedWorktree.gitAdminDirectoryPath
						: join(f.root, ".git");
		const expectedCommon = origin.linkedWorktree.commonDirectoryPath;
		const compile = executionPolicyEngine.compile.bind(executionPolicyEngine);
		let calls = 0,
			replaced = false;
		const hook = spyOn(executionPolicyEngine, "compile").mockImplementation(async (...args) => {
			const result = await compile(...args); // Real permissions, never synthetic all-allowed flags.
			if (args[0] === f.id && ++calls === 2) {
				// The initial authorization and native inode snapshot finished. The second
				// actual resolver is paused in its async policy hook, before its Git probe.
				await rename(path, `${path}.refresh-original`);
				await cp(`${path}.refresh-original`, path, { recursive: component !== "gitfile" });
				replaced = true;
				expect(git(f.root, "rev-parse", "--show-toplevel")).toBe(f.root);
				expect(git(f.root, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(
					expectedCommon,
				);
			}
			return result;
		});
		try {
			const response = await f.http(
				`git/worktrees?workspaceKey=${gitWorkspaceIdentity(localBackend, f.root)}`,
			);
			expect(calls).toBe(2);
			expect(replaced).toBe(true);
			expect(response.status).toBe(403);
			expect((await response.json()).code).toBe("RESOURCE_ACCESS_DENIED");
			expect(await readFile(f.file, "utf8")).toBe("after\n");
		} finally {
			hook.mockRestore();
		}
	});
}

test("linked runtime refresh-await normal commit/index update remains authorized", async () => {
	const f = await fixture();
	const compile = executionPolicyEngine.compile.bind(executionPolicyEngine);
	let calls = 0,
		committed = false;
	const hook = spyOn(executionPolicyEngine, "compile").mockImplementation(async (...args) => {
		const result = await compile(...args);
		if (args[0] === f.id && ++calls === 2) {
			git(f.root, "add", "file.txt");
			git(f.root, "commit", "--quiet", "-m", "normal-refresh-gap-commit");
			committed = true;
		}
		return result;
	});
	try {
		const response = await f.http(
			`git/worktrees?workspaceKey=${gitWorkspaceIdentity(localBackend, f.root)}`,
		);
		expect(calls).toBe(2);
		expect(committed).toBe(true);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await readFile(f.file, "utf8")).toBe("after\n");
	} finally {
		hook.mockRestore();
	}
});

test("linked runtime empty lineage proof is explicitly unsupported, never fabricated as ready", async () => {
	const f = await fixture();
	db.update(schema.legacyNarratorWorkspaceAdoptions)
		.set({ proofMode: "empty" })
		.where(eq(schema.legacyNarratorWorkspaceAdoptions.narratorId, f.id))
		.run();
	const response = await f.http(
		`git/worktrees?workspaceKey=${gitWorkspaceIdentity(localBackend, f.root)}`,
	);
	expect(response.status).toBe(409);
	expect((await response.json()).code).toBe("RESOURCE_CAPABILITY_UNSUPPORTED");
});

test("linked runtime real current narrator grant revocation denies HTTP despite retained claim", async () => {
	const f = await fixture();
	const workspaceKey = gitWorkspaceIdentity(localBackend, f.root);
	const user = generateId(),
		grant = generateId(),
		now = new Date().toISOString();
	db.insert(schema.users)
		.values({ id: user, username: user, passwordHash: "x", createdAt: now })
		.run();
	db.insert(schema.aclGrants)
		.values({
			id: grant,
			scopeType: "narrator",
			scopeId: f.id,
			principalType: "user",
			principalId: user,
			capability: "read",
			grantedBy: f.actor.userId,
			createdAt: now,
		})
		.run();
	const token = await createToken(user, "user");
	const request = () =>
		app.request(`/api/narrators/${f.id}/git/worktrees?workspaceKey=${workspaceKey}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
	expect((await request()).status).toBe(200);
	db.delete(schema.aclGrants).where(eq(schema.aclGrants.id, grant)).run();
	// Existing private-narrator ACL hides unreadable objects instead of leaking their existence.
	expect((await request()).status).toBe(404);
});

test("linked runtime claim does not let CreateWorktree escape the current linked root into its main parent", async () => {
	const f = await fixture();
	const row = await db.query.narrators.findFirst({ where: eq(schema.narrators.id, f.id) });
	if (!row?.workspaceContext) throw new Error("Current workspace missing");
	const before = git(f.root, "worktree", "list", "--porcelain");
	const create = agentWorktreeTools.find((candidate) => candidate.name === "CreateWorktree");
	if (!create) throw new Error("Create tool missing");
	const destination = join(f.projectRoot, "outside-current-linked-root");
	const result = await create.execute(
		{ branchName: "not-created-outside-root", destinationPath: destination },
		{
			narratorId: f.id,
			userId: f.actor.userId,
			cwd: f.root,
			locale: "en",
			workspaceContext: row.workspaceContext,
			requestPermission: unexpectedWorktreePermission,
			signal: new AbortController().signal,
		},
	);
	expect(result.isError).toBe(true);
	expect(git(f.root, "worktree", "list", "--porcelain")).toBe(before);
	expect(
		db
			.select({ id: schema.narratorWorktreeResources.id })
			.from(schema.narratorWorktreeResources)
			.where(eq(schema.narratorWorktreeResources.worktreePath, destination))
			.limit(1)
			.get(),
	).toBeUndefined();
});

test("linked runtime readonly tools deny create without opening resource or bypassing destination guard", async () => {
	const f = await fixture();
	const row = await db.query.narrators.findFirst({ where: eq(schema.narrators.id, f.id) });
	if (!row?.workspaceContext) throw new Error("Current workspace missing");
	const workspaceContext = { ...row.workspaceContext, mode: "readonly" as const };
	db.update(schema.narrators).set({ workspaceContext }).where(eq(schema.narrators.id, f.id)).run();
	const before = git(f.root, "worktree", "list", "--porcelain");
	const list = await narratorWorktreeService.list(
		f.actor,
		f.id,
		{ workspaceKey: workspaceContext.git?.workspaceKey },
		new AbortController().signal,
	);
	expect(list.capabilities.create).toBe(false);
	const create = agentWorktreeTools.find((candidate) => candidate.name === "CreateWorktree");
	if (!create) throw new Error("Create tool missing");
	const result = await create.execute(
		{ branchName: "not-created-by-readonly", destinationPath: join(f.root, "not-created") },
		{
			narratorId: f.id,
			userId: f.actor.userId,
			cwd: f.root,
			locale: "en",
			workspaceContext,
			requestPermission: unexpectedWorktreePermission,
			signal: new AbortController().signal,
		},
	);
	expect(result.isError).toBe(true);
	expect(git(f.root, "worktree", "list", "--porcelain")).toBe(before);
	expect(
		db
			.select({ id: schema.narratorWorktreeResources.id })
			.from(schema.narratorWorktreeResources)
			.where(eq(schema.narratorWorktreeResources.worktreePath, join(f.root, "not-created")))
			.limit(1)
			.get(),
	).toBeUndefined();
});

test("linked runtime extension preserves ordinary migrated Root0 even with unresolved sibling linked claims", async () => {
	const f = await fixture(false, 0, 0, true);
	if (!f.rootNarratorId) throw new Error("Actual migrated Root0 narrator missing");
	db.update(schema.narratorWorktreeResourceClaims)
		.set({ state: "unresolved" })
		.where(eq(schema.narratorWorktreeResourceClaims.narratorId, f.id))
		.run();
	const token = await createToken(f.actor.userId, "user");
	const workspaceKey = gitWorkspaceIdentity(localBackend, f.projectRoot);
	const response = await app.request(
		`/api/narrators/${f.rootNarratorId}/git/worktrees?workspaceKey=${workspaceKey}`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	expect(response.status, await response.clone().text()).toBe(200);
	const result = await response.json();
	expect(result.entries.map((entry: { path: string }) => entry.path).sort()).toEqual(
		[f.root, f.projectRoot].sort(),
	);
	expect(
		db
			.select({ id: schema.narratorWorktreeResourceClaims.id })
			.from(schema.narratorWorktreeResourceClaims)
			.where(eq(schema.narratorWorktreeResourceClaims.narratorId, f.rootNarratorId))
			.limit(1)
			.get(),
	).toBeUndefined();
});

test("linked runtime rejects native Git root drift while current cwd stays inside the adopted source namespace", async () => {
	const f = await fixture();
	const child = join(f.root, "nested-new-root");
	await mkdir(child);
	git(child, "init", "--quiet", "--initial-branch=nested-fixture");
	const row = await db.query.narrators.findFirst({ where: eq(schema.narrators.id, f.id) });
	if (!row?.workspaceContext) throw new Error("Current workspace missing");
	const revision = row.workspaceRevision + 1;
	const workspaceKey = gitWorkspaceIdentity(localBackend, child);
	db.update(schema.narrators)
		.set({
			cwd: child,
			workspaceRevision: revision,
			workspaceContext: {
				...row.workspaceContext,
				cwd: child,
				revision,
				git: {
					workspaceKey,
					repositoryKey: gitWorkspaceIdentity(localBackend, join(child, ".git")),
					rootPath: child,
				},
			},
		})
		.where(eq(schema.narrators.id, f.id))
		.run();
	expect((await f.http(`git/worktrees?workspaceKey=${workspaceKey}`)).status).toBe(403);
});

test("linked runtime switching current cwd to normal new repo is not permanently bound to old claims", async () => {
	const f = await fixture();
	const next = join(f.folder, "ordinary-next");
	await mkdir(next);
	git(next, "init", "--quiet", "--initial-branch=normal-fixture");
	const row = await db.query.narrators.findFirst({ where: eq(schema.narrators.id, f.id) });
	if (!row?.workspaceContext) throw new Error("Committed workspace missing");
	const revision = row.workspaceRevision + 1;
	db.update(schema.narrators)
		.set({
			cwd: next,
			workspaceRevision: revision,
			workspaceContext: { ...row.workspaceContext, cwd: next, revision },
		})
		.where(eq(schema.narrators.id, f.id))
		.run();
	db.update(schema.narratorWorktreeResourceClaims)
		.set({ state: "unresolved" })
		.where(eq(schema.narratorWorktreeResourceClaims.narratorId, f.id))
		.run();
	const response = await f.http(
		`git/worktrees?workspaceKey=${gitWorkspaceIdentity(localBackend, next)}`,
	);
	expect(response.status, await response.clone().text()).toBe(200);
	const result = await response.json();
	expect(result.entries.map((entry: { path: string }) => entry.path)).toEqual([next]);
});
