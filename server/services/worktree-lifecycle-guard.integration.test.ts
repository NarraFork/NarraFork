import { afterEach, beforeAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, sqlite } from "../db";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorWorktreeResources,
	projects,
	worktreeTreeSnapshots,
} from "../db/schema";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { getNarraforkPath } from "../lib/narrafork-home";
import * as spawn from "../lib/spawn";
import { chapterRoutes } from "../routes/chapters";
import { narratorRoutes } from "../routes/narrators";
import { projectRoutes } from "../routes/projects";
import { chapterCleanup } from "./chapter-cleanup";
import { chapterFork } from "./chapter-fork";
import { chapterMerge } from "./chapter-merge";
import { chapterService } from "./chapter-service";
import { chapterSplit } from "./chapter-split";
import { chapterWriteStore } from "./chapter-write/store";
import { containerService } from "./container-service";
import { gitService } from "./git-service";
import { narratorCreationWorkspaceTarget, narratorService } from "./narrator-service";
import * as narratorSession from "./narrator-session";
import { FileWorktreeJournal } from "./narrator-worktree-journal";
import { narratorWorktreeResourceRegistry } from "./narrator-worktree-resources";
import * as oauthRuntime from "./oauth-runtime-revocation";
import { reviewService } from "./review-service";
import {
	SnapshotCaptureReceiptService,
	withSnapshotCaptureReceipts,
} from "./snapshot-capture-receipts";
import { terminalService } from "./terminal-service";
import { treeSnapshotPhysicalDir } from "./tree-snapshot-paths";
import { workspaceContextService } from "./workspace-context-service";
import {
	confirmLifecyclePathCreated,
	inspect,
	ResourceProtectionError,
	withLegacyCreationRollback,
	withLegacyRetirement,
	withLifecycleGuardPorts,
	withProjectRetirement,
	withProtectionReservation,
	withWorkspaceAdmission,
} from "./worktree-lifecycle-guard";
import { TreeSnapshotError, treeSnapshotKey, worktreeTreeSnapshot } from "./worktree-tree-snapshot";
import * as writeClaimCache from "./worktree-write-claims";

beforeAll(() => {
	if (process.env.NARRAFORK_TEST !== "1") throw new Error("Isolated fixture database required");
	sqlite.exec(`CREATE TABLE IF NOT EXISTS narrator_worktree_resources (
		id TEXT PRIMARY KEY, owner_narrator_id TEXT REFERENCES narrators(id) ON DELETE SET NULL,
		device_id TEXT NOT NULL, repository_key TEXT NOT NULL, worktree_path TEXT NOT NULL,
		state TEXT NOT NULL, create_request_id TEXT NOT NULL,
		created_at TEXT NOT NULL, updated_at TEXT NOT NULL
	); CREATE UNIQUE INDEX IF NOT EXISTS uq_narrator_worktree_resource_path
	ON narrator_worktree_resources(device_id, worktree_path)`);
});
const app = new Hono()
	.use("*", async (c, next) => {
		c.set("user", {
			sub: "lifecycle-fixture-admin",
			role: "admin",
			iat: 0,
			exp: Number.MAX_SAFE_INTEGER,
		});
		await next();
	})
	.onError((error, c) =>
		c.json(
			{ code: error instanceof AppError ? error.code : "ERROR" },
			error instanceof AppError ? (error.statusCode as 409) : 500,
		),
	)
	.route("/projects", projectRoutes)
	.route("/chapters", chapterRoutes)
	.route("/narrators", narratorRoutes);
let temporary: string;
let path: string;
let projectId: string;
let chapterId: string;
let narratorId: string;
const otherNarrators: string[] = [];
const otherRoots: string[] = [];
function changes() {
	return sqlite.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n;
}
async function inventory(
	state: "preparing" | "ready" | "unknown" = "ready",
	owner: string | null = narratorId,
) {
	const now = new Date().toISOString();
	await db.insert(narratorWorktreeResources).values({
		id: generateId(),
		ownerNarratorId: owner,
		deviceId: "local",
		repositoryKey: "fixture-repository",
		worktreePath: path,
		createRequestId: generateId(),
		state,
		createdAt: now,
		updatedAt: now,
	});
}
beforeEach(async () => {
	temporary = await mkdtemp(join(tmpdir(), "nf-lifecycle-guard-"));
	path = join(temporary, ".worktrees", "legacy-Ab1234");
	await mkdir(path, { recursive: true });
	projectId = generateId();
	chapterId = generateId();
	narratorId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "lifecycle fixture",
		gitPath: temporary,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "legacy chapter",
		branch: "chapter/legacy-Ab1234",
		worktreePath: path,
		baseBranch: "main",
		status: "active",
		snapshotShadowKey: treeSnapshotKey("local", path),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	await db.insert(narrators).values({
		id: narratorId,
		title: "old chapter narrator",
		chapterId,
		cwd: path,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
});
afterEach(async () => {
	mock.restore();
	writeClaimCache.clearClaims(path);
	await db.delete(worktreeTreeSnapshots).where(eq(worktreeTreeSnapshots.worktreePath, path));
	await db
		.delete(narratorWorktreeResources)
		.where(eq(narratorWorktreeResources.repositoryKey, "fixture-repository"));
	await db
		.delete(narratorWorktreeResources)
		.where(eq(narratorWorktreeResources.scopeProjectId, projectId));
	const ids = [...otherNarrators.splice(0).reverse(), narratorId];
	await db.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.narratorId, ids));
	await db.delete(narratorMessages).where(inArray(narratorMessages.narratorId, ids));
	for (const id of ids) await db.delete(narrators).where(eq(narrators.id, id));
	await db.delete(projects).where(eq(projects.id, projectId));
	await rm(temporary, { recursive: true, force: true });
	for (const root of otherRoots.splice(0)) await rm(root, { recursive: true, force: true });
});
function sideEffects() {
	return [
		spyOn(terminalService, "cleanupForChapter").mockResolvedValue(undefined),
		spyOn(containerService, "removeChapterContainers").mockResolvedValue(undefined),
		spyOn(containerService, "pauseChapterContainers").mockResolvedValue(undefined),
		spyOn(narratorService, "remove").mockResolvedValue(undefined),
		spyOn(narratorSession, "interruptNarrator").mockImplementation(() => false),
		spyOn(narratorSession, "closeNarrator").mockImplementation(() => undefined),
		spyOn(oauthRuntime, "propagateOAuthProjectRemoval").mockResolvedValue(0),
		spyOn(gitService, "autoCommitUnlocked").mockResolvedValue(null),
		spyOn(gitService, "removeWorktree").mockResolvedValue(undefined),
		spyOn(gitService, "deleteBranch").mockResolvedValue(undefined),
		spyOn(fs, "rmSync").mockImplementation(() => undefined),
	];
}

for (const [name, action] of [
	["dormant before terminal cleanup", () => chapterCleanup.dormant(chapterId)],
	[
		"forced batch cleanup before status/terminal changes",
		() => chapterCleanup.batchCleanup([chapterId], { force: true, deleteBranch: true }),
	],
	["chapter remove before narrator archival", () => chapterService.remove(chapterId)],
	[
		"project chapter remove before narrator delete/volume down",
		() => chapterService.removeForProjectDeletion(chapterId, temporary),
	],
	[
		"merge source retirement before Git commit or target mutation",
		() => chapterMerge.merge(chapterId, { targetChapterId: "unused-target" }),
	],
] as const) {
	test(`${name}: independent inventory has zero lifecycle effects`, async () => {
		await inventory();
		const effects = sideEffects();
		const before = changes();
		await expect(action()).rejects.toBeInstanceOf(ResourceProtectionError);
		for (const effect of effects) expect(effect).toHaveBeenCalledTimes(0);
		expect(changes()).toBe(before);
	});
}

test("review dismissal preflight is before closeNarrator and SQL status update", async () => {
	await db
		.update(chapters)
		.set({ role: "review", reviewStatus: "concluded" })
		.where(eq(chapters.id, chapterId));
	await inventory();
	const effects = sideEffects();
	const before = changes();
	await expect(reviewService.dismissReview(chapterId)).rejects.toBeInstanceOf(
		ResourceProtectionError,
	);
	for (const effect of effects) expect(effect).toHaveBeenCalledTimes(0);
	expect(changes()).toBe(before);
});

test("Project DELETE protected preflight runs before OAuth removal and any fallback/cascade", async () => {
	// No repository directory is being removed in this case; paths come from chapters.
	await db.update(projects).set({ gitPath: null }).where(eq(projects.id, projectId));
	await inventory("unknown", null);
	const effects = sideEffects();
	const before = changes();
	const response = await app.request(`/projects/${projectId}`, { method: "DELETE" });
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: "RESOURCE_PROTECTED" });
	for (const effect of effects) expect(effect).toHaveBeenCalledTimes(0);
	expect(changes()).toBe(before);
	expect(
		db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()?.id,
	).toBe(projectId);
});

test("Project DELETE unreadable inventory refuses before all effects", async () => {
	await db.update(projects).set({ gitPath: null }).where(eq(projects.id, projectId));
	const effects = sideEffects();
	const before = changes();
	const response = await withLifecycleGuardPorts(
		{
			canonicalPath: async (path) => path,
			readClaims: async () => ({ complete: false, claims: [] }),
		},
		async () => app.request(`/projects/${projectId}`, { method: "DELETE" }),
	);
	expect(response.status).toBe(409);
	for (const effect of effects) expect(effect).toHaveBeenCalledTimes(0);
	expect(changes()).toBe(before);
});

test("Git final sink refuses owned inventory without invoking Git", async () => {
	await inventory("preparing");
	const dispatch = spyOn(spawn, "safeSpawn");
	await expect(gitService.removeWorktree(temporary, path)).rejects.toBeInstanceOf(
		ResourceProtectionError,
	);
	expect(dispatch).toHaveBeenCalledTimes(0);
});

test("shadow force cannot override inventory, shared chapter or incomplete evidence", async () => {
	await inventory();
	const deletion = spyOn(fs, "rmSync").mockImplementation(() => undefined);
	await expect(worktreeTreeSnapshot.destroy(path, "local", { force: true })).rejects.toBeInstanceOf(
		ResourceProtectionError,
	);
	expect(deletion).toHaveBeenCalledTimes(0);
	await db
		.delete(narratorWorktreeResources)
		.where(eq(narratorWorktreeResources.worktreePath, path));
	// Even without inventory, a caller cannot invent force authority for this live chapter.
	await expect(worktreeTreeSnapshot.destroy(path, "local", { force: true })).rejects.toBeInstanceOf(
		ResourceProtectionError,
	);
	await expect(
		withLifecycleGuardPorts(
			{
				canonicalPath: async (path) => path,
				readClaims: async () => {
					throw new Error("offline");
				},
			},
			() => worktreeTreeSnapshot.destroy(path, "local", { force: true }),
		),
	).rejects.toBeInstanceOf(ResourceProtectionError);
	expect(deletion).toHaveBeenCalledTimes(0);
});

test("wake/reclaim refuses independent path before add/remove/rm fallback", async () => {
	await db
		.update(chapters)
		.set({ status: "dormant", worktreePath: null })
		.where(eq(chapters.id, chapterId));
	await inventory();
	const add = spyOn(gitService, "createWorktree").mockRejectedValue(new Error("already exists"));
	const remove = spyOn(gitService, "removeWorktree").mockResolvedValue(undefined);
	const deletion = spyOn(fs, "rmSync").mockImplementation(() => undefined);
	await expect(chapterCleanup.wake(chapterId)).rejects.toBeInstanceOf(ResourceProtectionError);
	expect(add).toHaveBeenCalledTimes(0);
	expect(remove).toHaveBeenCalledTimes(0);
	expect(deletion).toHaveBeenCalledTimes(0);
});

test("typed removal failure in reclaim never enters rm fallback; ordinary Git failure still does", async () => {
	const add = spyOn(gitService, "createWorktree").mockRejectedValue(new Error("already exists"));
	spyOn(gitService, "pruneWorktrees").mockResolvedValue(undefined);
	const removal = spyOn(gitService, "removeWorktree").mockRejectedValue(
		new ResourceProtectionError("sink", { status: "protected", complete: true, claims: [] }),
	);
	const fixtureRm = fs.rmSync;
	const deletion = spyOn(fs, "rmSync").mockImplementation((target, options) => {
		if (String(target) !== path) throw new Error("rm fixture escaped its owned path");
		fixtureRm(target, options);
	});
	await expect(
		chapterCleanup._createWorktreeReclaiming(temporary, path, "chapter/legacy-Ab1234", chapterId),
	).rejects.toBeInstanceOf(ResourceProtectionError);
	expect(add).toHaveBeenCalledTimes(2);
	expect(deletion).toHaveBeenCalledTimes(0);
	removal.mockRejectedValue(new Error("ordinary Git failure"));
	add.mockClear();
	await expect(
		chapterCleanup._createWorktreeReclaiming(temporary, path, "chapter/legacy-Ab1234", chapterId),
	).rejects.toThrow("already exists");
	expect(deletion).toHaveBeenCalledTimes(1);
});

test("rollback preflight cannot erase claims through chapter/narrator deletion before force", async () => {
	await inventory();
	const rollback = mock(async () => undefined);
	const before = changes();
	await expect(withLegacyCreationRollback(chapterId, path, rollback)).rejects.toBeInstanceOf(
		ResourceProtectionError,
	);
	expect(rollback).toHaveBeenCalledTimes(0);
	expect(changes()).toBe(before);
});

test("canonical aliases and nested ordinary cwd are protected in actual bounded DB reads", async () => {
	const alias = join(temporary, "alias");
	await symlink(path, alias);
	const id = generateId();
	otherNarrators.push(id);
	await db.insert(narrators).values({
		id,
		cwd: alias,
		title: "independent alias",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	expect((await inspect([{ path }], "delete")).status).toBe("protected");
	await db
		.update(narrators)
		.set({ cwd: join(path, "src") })
		.where(eq(narrators.id, id));
	await expect(
		withLegacyRetirement([chapterId], "delete", async () => undefined),
	).rejects.toBeInstanceOf(ResourceProtectionError);
});

test("registry commit and directory switch share the destructive reservation; post-release retry succeeds", async () => {
	const resource = {
		ownerNarratorId: narratorId,
		deviceId: "local",
		repositoryKey: "fixture-repository",
		worktreePath: path,
		createRequestId: generateId(),
	};
	await withLegacyRetirement([chapterId], "retire", async () => {
		await expect(narratorWorktreeResourceRegistry.register(resource)).rejects.toBeInstanceOf(
			ResourceProtectionError,
		);
	});
	await narratorWorktreeResourceRegistry.register(resource);
	expect(
		db
			.select({ state: narratorWorktreeResources.state })
			.from(narratorWorktreeResources)
			.where(eq(narratorWorktreeResources.worktreePath, path))
			.get()?.state,
	).toBe("preparing");
});

test("independent inventory remains protected even inside a verified legacy retirement scope", async () => {
	const deletion = mock(async () => undefined);
	await expect(
		withLegacyRetirement([chapterId], "retire", async () => {
			await inventory();
			await withProtectionReservation([{ path }], "late sink", deletion);
		}),
	).rejects.toBeInstanceOf(ResourceProtectionError);
	expect(deletion).toHaveBeenCalledTimes(0);
});

test("review conversion refuses before reparenting its narrator", async () => {
	const sourceId = generateId();
	const sourceNarrator = generateId();
	otherNarrators.push(sourceNarrator);
	const now = new Date().toISOString();
	await db.insert(chapters).values({
		id: sourceId,
		projectId,
		title: "review source",
		branch: "chapter/source",
		worktreePath: join(temporary, "source"),
		baseBranch: "main",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narrators).values({
		id: sourceNarrator,
		chapterId: sourceId,
		title: "review source narrator",
		cwd: join(temporary, "source"),
		createdAt: now,
		updatedAt: now,
	});
	await db
		.update(chapters)
		.set({ role: "review", reviewStatus: "concluded", reviewSourceChapterId: sourceId })
		.where(eq(chapters.id, chapterId));
	await inventory();
	const before = changes();
	const effects = sideEffects();
	await expect(reviewService.convertToSubagent(chapterId)).rejects.toBeInstanceOf(
		ResourceProtectionError,
	);
	for (const effect of effects) expect(effect).toHaveBeenCalledTimes(0);
	expect(changes()).toBe(before);
});

test("real switch CAS rejects during retirement; the same request can retry after release", async () => {
	const nested = join(path, "src");
	await mkdir(nested);
	const request = {
		expectedRevision: 0,
		requestId: "lifecycle-switch",
		target: { deviceId: "local", cwd: nested },
	};
	await withLegacyRetirement([chapterId], "retire", async () => {
		const before = changes();
		await expect(
			workspaceContextService.switch(narratorId, request, { origin: "http" }),
		).rejects.toBeInstanceOf(ResourceProtectionError);
		expect(changes()).toBe(before);
	});
	const result = await workspaceContextService.switch(narratorId, request, { origin: "http" });
	expect(result.current.cwd).toBe(nested);
	expect(
		db
			.select({ revision: narrators.workspaceRevision })
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.get()?.revision,
	).toBe(1);
});

for (const protectedPrefix of [true, false]) {
	test(`actual split rollback ${protectedPrefix ? "preserves an independent prefix inventory" : "keeps ordinary failure cleanup"}`, async () => {
		await db.update(chapters).set({ role: "trunk" }).where(eq(chapters.id, chapterId));
		spyOn(gitService, "getRefCommit").mockResolvedValue("a".repeat(40));
		spyOn(gitService, "getHeadCommit").mockResolvedValue("b".repeat(40));
		spyOn(gitService, "isAncestor").mockResolvedValue(true);
		spyOn(gitService, "createBranch").mockResolvedValue(undefined);
		let prefixPath = "";
		let prefixId = "";
		const binary = Buffer.from([0, 255, 128, 13, 10, 0, 42]);
		spyOn(gitService, "createWorktree").mockImplementation(async (_repository, target) => {
			prefixPath = target;
			await mkdir(target, { recursive: true });
			await writeFile(join(target, "marker.bin"), binary);
			await confirmLifecyclePathCreated(target);
		});
		spyOn(narratorService, "forkNarrator").mockImplementation(async () => {
			const prefix = db
				.select({ id: chapters.id })
				.from(chapters)
				.where(eq(chapters.worktreePath, prefixPath))
				.get();
			if (!prefix) throw new Error("Missing fixture prefix");
			prefixId = prefix.id;
			if (protectedPrefix)
				await narratorWorktreeResourceRegistry.register({
					ownerNarratorId: narratorId,
					deviceId: "local",
					repositoryKey: "fixture-repository",
					worktreePath: prefixPath,
					createRequestId: "split-independent",
				});
			throw new Error("injected fork failure");
		});
		const remove = spyOn(gitService, "removeWorktree").mockResolvedValue(undefined);
		const branch = spyOn(gitService, "deleteBranch").mockResolvedValue(undefined);
		const shadow = spyOn(worktreeTreeSnapshot, "destroy").mockResolvedValue(true);
		const metadata = spyOn(chapterWriteStore, "deleteChapter");
		const split = chapterSplit.split(chapterId, {
			commitSha: "a".repeat(40),
			newFork: { title: "fixture fork", inheritMode: "fresh" },
		});
		// Compensation refuses independent claims, but must preserve the creation error.
		await expect(split).rejects.toThrow("injected fork failure");
		expect(prefixId.length).toBeGreaterThan(0);
		expect(remove).toHaveBeenCalledTimes(protectedPrefix ? 0 : 1);
		expect(branch).toHaveBeenCalledTimes(protectedPrefix ? 0 : 1);
		expect(shadow).toHaveBeenCalledTimes(protectedPrefix ? 0 : 1);
		expect(metadata).toHaveBeenCalledTimes(protectedPrefix ? 0 : 1);
		if (protectedPrefix) {
			expect(await readFile(join(prefixPath, "marker.bin"))).toEqual(binary);
			expect(
				db.select({ id: chapters.id }).from(chapters).where(eq(chapters.id, prefixId)).get()?.id,
			).toBe(prefixId);
		}
	});
}

test("creation persists the case-preserving cwd instead of the lifecycle comparison key", async () => {
	const cwd = join(temporary, "MixedCaseProject");
	await mkdir(cwd);
	const expected = await realpath(cwd);
	const created = await withLifecycleGuardPorts(
		{
			canonicalAdmissionPath: async (value) => realpath(value),
			// Simulate Windows identity folding on any test host.
			canonicalPath: async (value) => (await realpath(value)).toLowerCase(),
			readClaims: async () => ({ complete: true, claims: [] }),
		},
		() => narratorService.create({ cwd, title: "preserve cwd spelling" }),
	);
	otherNarrators.push(created.id);
	expect(created.cwd).toBe(expected);
	expect(
		db.select({ cwd: narrators.cwd }).from(narrators).where(eq(narrators.id, created.id)).get()
			?.cwd,
	).toBe(expected);
});

test("inherited committed workspace context keeps canonical path casing", async () => {
	const cwd = join(temporary, "InheritedWorkspace");
	await mkdir(cwd);
	const expected = await realpath(cwd);
	const row: Parameters<typeof narratorCreationWorkspaceTarget>[0] = {
		chapterId: null,
		contextProjectId: null,
		cwd,
		defaultDeviceId: "local",
		workspaceContext: {
			revision: 1,
			deviceId: "local",
			cwd,
			pathFlavor: "posix",
			contextKey: "case-fixture",
			capabilities: { switchDirectory: true },
		},
	};
	await withLifecycleGuardPorts(
		{
			canonicalAdmissionPath: async (value) => realpath(value),
			canonicalPath: async (value) => (await realpath(value)).toLowerCase(),
			readClaims: async () => ({ complete: true, claims: [] }),
		},
		() => narratorCreationWorkspaceTarget(row),
	);
	expect(row.cwd).toBe(expected);
	expect(row.workspaceContext?.cwd).toBe(expected);
});

test("real local relative cwd stays a protected absolute host claim without poisoning unrelated retirement", async () => {
	const created = await narratorService.create({ cwd: ".", title: "relative local compatibility" });
	otherNarrators.push(created.id);
	expect(created.cwd).toBe(".");
	const unrelated = join(temporary, "unrelated");
	await mkdir(unrelated);
	expect(await inspect([{ path: unrelated }], "unrelated cleanup")).toMatchObject({
		status: "clear",
		complete: true,
	});
	const current = await inspect([{ path: process.cwd() }], "host cwd cleanup");
	expect(current.status).toBe("protected");
	expect(current.claims.some((claim) => claim.id === created.id)).toBe(true);
});

for (const cwd of [0, false, "", [], {}]) {
	test(`malformed falsey/structured legacy context cwd ${JSON.stringify(cwd)} never becomes no-claim evidence`, async () => {
		sqlite
			.query("UPDATE narrators SET cwd=NULL, workspace_context=? WHERE id=?")
			.run(JSON.stringify({ deviceId: "local", cwd }), narratorId);
		const unrelated = join(temporary, "unrelated-malformed");
		await mkdir(unrelated);
		expect(await inspect([{ path: unrelated }], "malformed cleanup")).toMatchObject({
			status: "unavailable",
			complete: false,
		});
	});
}

for (const gitPathNull of [false, true]) {
	for (const state of ["ready", "preparing", "unknown"] as const) {
		test(`project scope protects ${state} external/different-repo owner-deleted resources with gitPath ${gitPathNull ? "NULL" : "present"}`, async () => {
			const external = await mkdtemp(join(tmpdir(), "nf-lifecycle-external-"));
			otherRoots.push(external);
			const binary = Buffer.from([0, 255, 128, 13, 10, 0, 42]);
			await writeFile(join(external, "marker.bin"), binary);
			if (gitPathNull)
				await db.update(projects).set({ gitPath: null }).where(eq(projects.id, projectId));
			const id = generateId();
			const now = new Date().toISOString();
			await db.insert(narratorWorktreeResources).values({
				id,
				ownerNarratorId: null,
				scopeKind: "project",
				scopeProjectId: projectId,
				scopeOwnerUserId: null,
				deviceId: gitPathNull ? "other-device" : "local",
				repositoryKey: "other-repository",
				worktreePath: external,
				state,
				createRequestId: id,
				createdAt: now,
				updatedAt: now,
			});
			const effects = sideEffects();
			const git = spyOn(spawn, "safeSpawn");
			const before = changes();
			const response = await app.request(`/projects/${projectId}`, { method: "DELETE" });
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ code: "RESOURCE_PROTECTED" });
			for (const effect of effects) expect(effect).toHaveBeenCalledTimes(0);
			expect(git).toHaveBeenCalledTimes(0);
			expect(changes()).toBe(before);
			expect(
				db
					.select({ scope: narratorWorktreeResources.scopeProjectId })
					.from(narratorWorktreeResources)
					.where(eq(narratorWorktreeResources.id, id))
					.get()?.scope,
			).toBe(projectId);
			expect(await readFile(join(external, "marker.bin"))).toEqual(binary);
		});
	}
}

for (const kind of ["create", "subagent", "fork", "forkFromMessages"] as const) {
	test(`actual ${kind} insert is rejected in retirement, with zero SQL writes, then can retry`, async () => {
		const messageId = generateId();
		const now = new Date().toISOString();
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId,
			role: "user",
			contentJson: [{ type: "text", text: "fixture fork" }],
			contentText: "fixture fork",
			createdAt: now,
		});
		await db
			.insert(narratorMessageRefs)
			.values({ id: generateId(), narratorId, messageId, seq: 1 });
		const action = () => {
			if (kind === "create")
				return narratorService.create({ cwd: path, title: "late independent cwd" });
			if (kind === "subagent")
				return narratorService.createSubagent({
					parentNarratorId: narratorId,
					subagentOriginKind: "standalone",
					subagentType: "general",
					cwd: path,
				});
			if (kind === "fork")
				return narratorService.forkNarrator(narratorId, null, {
					standalone: true,
					inheritMode: "fresh",
				});
			return narratorService.forkFromMessages(narratorId, [messageId]);
		};
		await withLegacyRetirement([chapterId], "retire during creation", async () => {
			const before = changes();
			await expect(action()).rejects.toBeInstanceOf(ResourceProtectionError);
			expect(changes()).toBe(before);
		});
		const created = await action();
		otherNarrators.push(created.id);
		expect(
			db.select({ cwd: narrators.cwd }).from(narrators).where(eq(narrators.id, created.id)).get()
				?.cwd,
		).toBe(path);
	});
}

for (const operation of ["git", "reclaim"] as const) {
	test(`mid-read alias retarget rejects ${operation} before dispatch/rm and preserves both directory bytes`, async () => {
		const alias = join(temporary, "dispatch-alias");
		const other = join(temporary, "other-worktree");
		await mkdir(other);
		const marker = Buffer.from([0, 255, 128, 13, 10, 42]);
		await writeFile(join(path, "marker.bin"), marker);
		await writeFile(join(other, "marker.bin"), marker);
		await symlink(path, alias);
		if (operation === "reclaim") {
			const digest = createHash("sha256")
				.update(treeSnapshotKey("local", alias))
				.digest("hex")
				.slice(0, 32);
			const shadow = getNarraforkPath("tree-snapshots", digest);
			await mkdir(shadow, { recursive: true });
			otherRoots.push(shadow);
		}
		if (operation === "reclaim")
			await db
				.update(chapters)
				.set({ worktreePath: alias, snapshotShadowKey: treeSnapshotKey("local", alias) })
				.where(eq(chapters.id, chapterId));
		let swapped = false;
		const effects = sideEffects();
		const git = spyOn(spawn, "safeSpawn");
		const add = spyOn(gitService, "createWorktree").mockRejectedValue(
			new Error("must not dispatch"),
		);
		const guardedAction = () =>
			operation === "git"
				? gitService.removeWorktree(temporary, alias)
				: chapterCleanup._createWorktreeReclaiming(
						temporary,
						alias,
						"chapter/legacy-Ab1234",
						chapterId,
					);
		// The Git sink itself remains real for this variant.
		if (operation === "git") mock.restore();
		const rmSpy = spyOn(fs, "rmSync").mockImplementation(() => undefined);
		const spawnSpy = spyOn(spawn, "safeSpawn");
		await expect(
			withLifecycleGuardPorts(
				{
					canonicalPath: (value) => realpath(value),
					readClaims: async () => {
						if (!swapped) {
							swapped = true;
							await unlink(alias);
							await symlink(other, alias);
						}
						return { complete: true, claims: [] };
					},
				},
				guardedAction,
			),
		).rejects.toBeInstanceOf(ResourceProtectionError);
		expect(swapped).toBe(true);
		expect(rmSpy).toHaveBeenCalledTimes(0);
		expect(spawnSpy).toHaveBeenCalledTimes(0);
		if (operation === "reclaim") {
			expect(add).toHaveBeenCalledTimes(0);
			for (const effect of effects) expect(effect).toHaveBeenCalledTimes(0);
			expect(git).toHaveBeenCalledTimes(0);
		}
		expect(await readFile(join(path, "marker.bin"))).toEqual(marker);
		expect(await readFile(join(other, "marker.bin"))).toEqual(marker);
	});
}

test("mid-read same-path inode replacement is not accepted as a new clean target", async () => {
	const original = join(temporary, "saved-original");
	const marker = Buffer.from([0, 128, 255, 13, 10]);
	await writeFile(join(path, "marker.bin"), marker);
	const dispatch = spyOn(spawn, "safeSpawn");
	const deletion = spyOn(fs, "rmSync").mockImplementation(() => undefined);
	let changed = false;
	await expect(
		withLifecycleGuardPorts(
			{
				canonicalPath: (value) => realpath(value),
				readClaims: async () => {
					if (!changed) {
						changed = true;
						await rename(path, original);
						await mkdir(path);
						await writeFile(join(path, "marker.bin"), marker);
					}
					return { complete: true, claims: [] };
				},
			},
			() => gitService.removeWorktree(temporary, path),
		),
	).rejects.toBeInstanceOf(ResourceProtectionError);
	expect(dispatch).toHaveBeenCalledTimes(0);
	expect(deletion).toHaveBeenCalledTimes(0);
	expect(await readFile(join(path, "marker.bin"))).toEqual(marker);
	expect(await readFile(join(original, "marker.bin"))).toEqual(marker);
});

test("shadow force freezes its actual directory before inspection; root alias swap cannot erase either store", async () => {
	const root = getNarraforkPath("tree-snapshots");
	const home = process.env.NARRAFORK_HOME;
	if (process.env.NARRAFORK_TEST !== "1" || !home || !root.startsWith(home))
		throw new Error("Shadow fixture escaped isolated test home");
	const backup = getNarraforkPath(`tree-snapshots-fixture-backup-${generateId()}`);
	const hadRoot = fs.existsSync(root);
	if (hadRoot) await rename(root, backup);
	const first = join(temporary, "shadow-first");
	const second = join(temporary, "shadow-second");
	const digest = createHash("sha256")
		.update(treeSnapshotKey("local", path))
		.digest("hex")
		.slice(0, 32);
	await mkdir(join(first, digest), { recursive: true });
	await mkdir(join(second, digest), { recursive: true });
	const marker = Buffer.from([0, 255, 128, 13, 10, 42]);
	await writeFile(join(first, digest, "marker.bin"), marker);
	await writeFile(join(second, digest, "marker.bin"), marker);
	await symlink(first, root);
	try {
		let changed = false;
		const before = changes();
		const deletion = spyOn(fs, "rmSync").mockImplementation(() => undefined);
		await expect(
			withLifecycleGuardPorts(
				{
					canonicalPath: (value) => realpath(value),
					readClaims: async () => {
						if (!changed) {
							changed = true;
							await unlink(root);
							await symlink(second, root);
						}
						return { complete: true, claims: [] };
					},
				},
				() => worktreeTreeSnapshot.destroy(path, "local", { force: true }),
			),
		).rejects.toBeInstanceOf(ResourceProtectionError);
		expect(changed).toBe(true);
		expect(deletion).toHaveBeenCalledTimes(0);
		expect(changes()).toBe(before);
		expect(await readFile(join(first, digest, "marker.bin"))).toEqual(marker);
		expect(await readFile(join(second, digest, "marker.bin"))).toEqual(marker);
	} finally {
		mock.restore();
		await unlink(root);
		if (hadRoot) await rename(backup, root);
	}
});

for (const kind of ["cwd", "registry", "receipt"] as const) {
	test(`shadow physical directory ${kind} claim prevents force rm, metadata and cache cleanup`, async () => {
		const digest = createHash("sha256")
			.update(treeSnapshotKey("local", path))
			.digest("hex")
			.slice(0, 32);
		const shadow = getNarraforkPath("tree-snapshots", digest);
		await mkdir(join(shadow, "refs"), { recursive: true });
		const marker = Buffer.from([0, 255, 128, 13, 10]);
		await writeFile(join(shadow, "marker.bin"), marker);
		let receipt: string | undefined;
		if (kind === "cwd") {
			const id = generateId();
			otherNarrators.push(id);
			const now = new Date().toISOString();
			const alias = join(temporary, "shadow-owner-alias");
			await symlink(shadow, alias);
			await db.insert(narrators).values({
				id,
				cwd: join(alias, "refs"),
				title: "independent shadow cwd alias",
				createdAt: now,
				updatedAt: now,
			});
		} else if (kind === "registry") {
			const now = new Date().toISOString();
			const id = generateId();
			await db.insert(narratorWorktreeResources).values({
				id,
				ownerNarratorId: null,
				deviceId: "local",
				repositoryKey: "fixture-repository",
				worktreePath: join(shadow, "refs"),
				state: "unknown",
				createRequestId: id,
				createdAt: now,
				updatedAt: now,
			});
		} else {
			const directory = getNarraforkPath("worktree-requests");
			await mkdir(directory, { recursive: true });
			receipt = join(directory, `${createHash("sha256").update(generateId()).digest("hex")}.json`);
			await writeFile(
				receipt,
				JSON.stringify({
					destination: join(shadow, "refs"),
					deviceId: "local",
					repositoryKey: "shadow-fixture",
				}),
			);
		}
		try {
			const deletion = spyOn(fs, "rmSync").mockImplementation(() => undefined);
			const before = changes();
			await expect(
				withLegacyRetirement([chapterId], "fixture legacy release", () =>
					worktreeTreeSnapshot.destroy(path, "local", { force: true }),
				),
			).rejects.toBeInstanceOf(ResourceProtectionError);
			expect(deletion).toHaveBeenCalledTimes(0);
			expect(changes()).toBe(before);
			expect(await readFile(join(shadow, "marker.bin"))).toEqual(marker);
			// Exercise actual high-level entrances, not just the final destroy sink.
			const effects = sideEffects();
			for (const action of [
				() => chapterService.remove(chapterId),
				() => chapterCleanup.dormant(chapterId),
				() => chapterService.removeForProjectDeletion(chapterId, temporary),
			]) {
				const before = changes();
				await expect(action()).rejects.toBeInstanceOf(ResourceProtectionError);
				for (const effect of effects) expect(effect).toHaveBeenCalledTimes(0);
				expect(changes()).toBe(before);
			}
			await db.update(projects).set({ gitPath: null }).where(eq(projects.id, projectId));
			const sqlBefore = changes();
			const response = await app.request(`/projects/${projectId}`, { method: "DELETE" });
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ code: "RESOURCE_PROTECTED" });
			for (const effect of effects) expect(effect).toHaveBeenCalledTimes(0);
			expect(changes()).toBe(sqlBefore);
			expect(
				db
					.select({ status: chapters.status })
					.from(chapters)
					.where(eq(chapters.id, chapterId))
					.get()?.status,
			).toBe("active");
		} finally {
			mock.restore();
			if (receipt) await rm(receipt);
			await rm(shadow, { recursive: true, force: true });
		}
	});
}

test("public extract-primary is rejected during reclaim Git await and cannot introduce a late cwd claim", async () => {
	const source = generateId();
	otherNarrators.push(source);
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: source,
		type: "subagent",
		variant: "subagent:general",
		subagentType: "general",
		parentNarratorId: narratorId,
		aclRootNarratorId: narratorId,
		chapterId,
		cwd: path,
		status: "idle",
		model: "__default__",
		createdAt: now,
		updatedAt: now,
	});
	spyOn(gitService, "createWorktree").mockRejectedValue(new Error("already exists"));
	spyOn(gitService, "pruneWorktrees").mockResolvedValue(undefined);
	let response: Response | undefined;
	let sqlBefore = 0;
	let sqlAfter = 0;
	spyOn(gitService, "removeWorktree").mockImplementation(async () => {
		sqlBefore = changes() ?? 0;
		response = await app.request(`/narrators/${source}/extract-primary`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ inheritMode: "full" }),
		});
		sqlAfter = changes() ?? 0;
		throw new Error("ordinary Git failure after extract attempt");
	});
	const fixtureRm = fs.rmSync;
	const deletion = spyOn(fs, "rmSync").mockImplementation((target, options) => {
		if (String(target) !== path) throw new Error("escaped rm fixture");
		fixtureRm(target, options);
	});
	await expect(
		chapterCleanup._createWorktreeReclaiming(temporary, path, "chapter/legacy-Ab1234", chapterId),
	).rejects.toThrow("already exists");
	expect(response?.status).toBe(409);
	expect(sqlAfter).toBe(sqlBefore);
	expect(deletion).toHaveBeenCalledTimes(1);
	const after = await app.request(`/narrators/${source}/extract-primary`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ inheritMode: "full" }),
	});
	expect(after.status).toBe(201);
	const row = (await after.json()) as { narrator: { id: string } };
	otherNarrators.push(row.narrator.id);
});

test("rm fallback re-reads complete claims after ordinary Git failure, beyond inode equality", async () => {
	spyOn(gitService, "createWorktree").mockRejectedValue(new Error("already exists"));
	spyOn(gitService, "pruneWorktrees").mockResolvedValue(undefined);
	spyOn(gitService, "removeWorktree").mockImplementation(async () => {
		// Simulate a legacy/uncoordinated durable writer, not a fake admission port.
		await inventory("preparing", null);
		throw new Error("ordinary Git failure");
	});
	const deletion = spyOn(fs, "rmSync").mockImplementation(() => undefined);
	const marker = Buffer.from([0, 255, 128]);
	await writeFile(join(path, "marker.bin"), marker);
	await expect(
		chapterCleanup._createWorktreeReclaiming(temporary, path, "chapter/legacy-Ab1234", chapterId),
	).rejects.toBeInstanceOf(ResourceProtectionError);
	expect(deletion).toHaveBeenCalledTimes(0);
	expect(await readFile(join(path, "marker.bin"))).toEqual(marker);
});

test("project Git probe ignores contaminated Git selectors rather than falsely changing repository identity", async () => {
	const env = {
		...process.env,
		GIT_DIR: undefined,
		GIT_COMMON_DIR: undefined,
		GIT_WORK_TREE: undefined,
		GIT_INDEX_FILE: undefined,
	};
	await spawn.safeSpawn({
		cmd: ["git", "-C", temporary, "init"],
		env,
		timeout: 5000,
		maxOutputBytes: 2048,
	});
	const foreign = await mkdtemp(join(tmpdir(), "nf-git-poison-"));
	otherRoots.push(foreign);
	await spawn.safeSpawn({
		cmd: ["git", "-C", foreign, "init"],
		env,
		timeout: 5000,
		maxOutputBytes: 2048,
	});
	const common = await realpath(join(temporary, ".git"));
	const repositoryKey = createHash("sha256")
		.update(JSON.stringify(["local", localPathSemantics.identityKey(common)]))
		.digest("hex");
	const now = new Date().toISOString();
	const id = generateId();
	await db.insert(narratorWorktreeResources).values({
		id,
		ownerNarratorId: null,
		deviceId: "local",
		repositoryKey,
		worktreePath: foreign,
		state: "unknown",
		createRequestId: id,
		createdAt: now,
		updatedAt: now,
	});
	const keys = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] as const;
	const previous = keys.map((key) => process.env[key]);
	try {
		process.env.GIT_DIR = join(foreign, ".git");
		process.env.GIT_COMMON_DIR = join(foreign, ".git");
		process.env.GIT_WORK_TREE = foreign;
		process.env.GIT_INDEX_FILE = join(foreign, ".git", "index");
		const effects = sideEffects();
		const before = changes();
		const response = await app.request(`/projects/${projectId}`, { method: "DELETE" });
		expect(response.status).toBe(409);
		for (const effect of effects) expect(effect).toHaveBeenCalledTimes(0);
		expect(changes()).toBe(before);
	} finally {
		keys.forEach((key, index) => {
			const value = previous[index];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		});
		await db.delete(narratorWorktreeResources).where(eq(narratorWorktreeResources.id, id));
	}
});

for (const deviceId of [false, "", {}, [], 42, null, " "] as const) {
	test(`receipt invalid explicit device ${JSON.stringify(deviceId)} refuses actual chapter removal before any effect`, async () => {
		const directory = getNarraforkPath("worktree-requests");
		await mkdir(directory, { recursive: true });
		const receipt = join(
			directory,
			`${createHash("sha256").update(generateId()).digest("hex")}.json`,
		);
		await writeFile(
			receipt,
			JSON.stringify({ destination: path, repositoryKey: "fixture-repository", deviceId }),
		);
		try {
			const effects = sideEffects();
			const dispatch = spyOn(spawn, "safeSpawn");
			const before = changes();
			await expect(chapterService.remove(chapterId)).rejects.toMatchObject({
				code: "RESOURCE_PROTECTION_UNAVAILABLE",
			});
			for (const effect of effects) expect(effect).toHaveBeenCalledTimes(0);
			expect(dispatch).toHaveBeenCalledTimes(0);
			expect(changes()).toBe(before);
		} finally {
			await rm(receipt);
		}
	});
}

for (const deviceId of [undefined, "local", "remote-fixture"] as const) {
	test(`receipt historical device ${deviceId ?? "missing"} has its proven protection domain`, async () => {
		const directory = getNarraforkPath("worktree-requests");
		await mkdir(directory, { recursive: true });
		const receipt = join(
			directory,
			`${createHash("sha256").update(generateId()).digest("hex")}.json`,
		);
		await writeFile(
			receipt,
			JSON.stringify({
				destination: path,
				repositoryKey: "fixture-repository",
				...(deviceId === undefined ? {} : { deviceId }),
			}),
		);
		try {
			const effects = sideEffects();
			const before = changes();
			let admitted = false;
			const run = () =>
				withLegacyRetirement([chapterId], "fixture retirement", async () => {
					admitted = true;
				});
			if (deviceId === "remote-fixture") await run();
			else await expect(run()).rejects.toMatchObject({ code: "RESOURCE_PROTECTED" });
			expect(admitted).toBe(deviceId === "remote-fixture");
			for (const effect of effects) expect(effect).toHaveBeenCalledTimes(0);
			expect(changes()).toBe(before);
		} finally {
			await rm(receipt);
		}
	});
}

for (const [name, create] of [
	["create auto narrator true", () => chapterService.create({ projectId, title: "late chapter" })],
	["create auto narrator false", () => chapterService.create({ projectId, title: "late chapter" })],
	[
		"root",
		() =>
			chapterService.createRootChapter({
				projectId,
				title: "late root",
				gitPath: temporary,
				defaultBranch: "main",
			}),
	],
	["fork", () => chapterFork.fork(chapterId, { title: "late fork", worktreeSource: "commit" })],
	[
		"split",
		() =>
			chapterSplit.split(chapterId, {
				commitSha: "1234567",
				newFork: { title: "late split", inheritMode: "fresh" },
			}),
	],
	["review", () => reviewService.createReview(chapterId, { title: "late review" })],
] as const) {
	test(`actual chapter ${name} is blocked inside project retirement before first Git or SQL effect`, async () => {
		await db
			.update(projects)
			.set({ chapterSettings: { autoCreateNarrator: name !== "create auto narrator false" } })
			.where(eq(projects.id, projectId));
		const effects = sideEffects();
		const git = [
			spyOn(gitService, "isGitRepo").mockResolvedValue(true),
			spyOn(gitService, "branchExists").mockResolvedValue(true),
			spyOn(gitService, "createBranch").mockResolvedValue(undefined),
			spyOn(gitService, "createWorktree").mockResolvedValue(undefined),
			spyOn(gitService, "getHeadCommit").mockResolvedValue("1234567"),
			spyOn(gitService, "getRefCommit").mockResolvedValue("1234567"),
		];
		const before = changes();
		await withProjectRetirement(projectId, null, async () => {
			await expect(create()).rejects.toBeInstanceOf(ResourceProtectionError);
			expect(changes()).toBe(before);
			for (const effect of [...effects, ...git]) expect(effect).toHaveBeenCalledTimes(0);
		});
		if (name.startsWith("create ")) {
			// The exact service entrance succeeds after the reservation releases.
			const narrator = spyOn(narratorService, "create").mockResolvedValue({
				id: generateId(),
			} as Awaited<ReturnType<typeof narratorService.create>>);
			const { commitSyncService } = await import("./commit-sync-service");
			spyOn(commitSyncService, "syncChapterCommits").mockResolvedValue(0);
			spyOn(chapterCleanup, "scheduleAutoDormant").mockImplementation(() => undefined);
			const created = await create();
			expect("id" in created && created.id).toBeTruthy();
			expect(git[2]).toHaveBeenCalledTimes(1);
			expect(git[3]).toHaveBeenCalledTimes(1);
			expect(narrator).toHaveBeenCalledTimes(name === "create auto narrator false" ? 0 : 1);
		} else {
			const { commitSyncService } = await import("./commit-sync-service");
			spyOn(commitSyncService, "syncChapterCommits").mockResolvedValue(0);
			spyOn(commitSyncService, "copyCommitsForFork").mockResolvedValue(undefined);
			spyOn(chapterCleanup, "scheduleAutoDormant").mockImplementation(() => undefined);
			spyOn(narratorService, "create").mockResolvedValue({ id: generateId() } as Awaited<
				ReturnType<typeof narratorService.create>
			>);
			spyOn(narratorService, "forkNarrator").mockResolvedValue({ id: generateId() } as Awaited<
				ReturnType<typeof narratorService.forkNarrator>
			>);
			spyOn(gitService, "isAncestor").mockResolvedValue(true);
			spyOn(gitService, "getHeadCommit").mockResolvedValue("b".repeat(40));
			spyOn(gitService, "getRefCommit").mockResolvedValue("a".repeat(40));
			if (name === "review") {
				spyOn(reviewService, "transferWorkingState").mockResolvedValue({
					snapshotCommitSha: null,
					baselineCommitSha: null,
					viaSnapshot: false,
				});
				spyOn(reviewService, "buildDiffContext").mockResolvedValue("");
				spyOn(narratorSession, "sendMessage").mockResolvedValue({ id: generateId() } as Awaited<
					ReturnType<typeof narratorSession.sendMessage>
				>);
			}
			const created = await create();
			expect("id" in created ? created.id : created.prefixChapter.id).toBeTruthy();
			expect(changes()).toBeGreaterThan(before ?? 0);
			expect(git[2]).toHaveBeenCalledTimes(name === "root" ? 0 : name === "split" ? 2 : 1);
		}
	});
}

test("public chapters POST cannot introduce even narrator-disabled late chapters; released retry succeeds", async () => {
	await db
		.update(projects)
		.set({ chapterSettings: { autoCreateNarrator: false } })
		.where(eq(projects.id, projectId));
	const branch = spyOn(gitService, "createBranch").mockResolvedValue(undefined);
	const worktree = spyOn(gitService, "createWorktree").mockResolvedValue(undefined);
	spyOn(gitService, "isGitRepo").mockResolvedValue(true);
	spyOn(gitService, "branchExists").mockResolvedValue(true);
	const { commitSyncService } = await import("./commit-sync-service");
	spyOn(commitSyncService, "syncChapterCommits").mockResolvedValue(0);
	spyOn(chapterCleanup, "scheduleAutoDormant").mockImplementation(() => undefined);
	const request = () =>
		app.request("/chapters", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ projectId, title: "public late chapter" }),
		});
	const before = changes();
	await withProjectRetirement(projectId, null, async () => {
		const response = await request();
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ code: "RESOURCE_PROTECTED" });
		expect(branch).toHaveBeenCalledTimes(0);
		expect(worktree).toHaveBeenCalledTimes(0);
		expect(changes()).toBe(before);
	});
	const response = await request();
	expect(response.status).toBe(201);
	expect(branch).toHaveBeenCalledTimes(1);
	expect(worktree).toHaveBeenCalledTimes(1);
});

test("chapter creation admission stays held through Git await, narrator insertion and compensation", async () => {
	spyOn(gitService, "isGitRepo").mockResolvedValue(true);
	spyOn(gitService, "branchExists").mockResolvedValue(true);
	let retired = false;
	const retire = () =>
		withProjectRetirement(projectId, null, async () => {
			retired = true;
		});
	const branch = spyOn(gitService, "createBranch").mockImplementation(async () => {
		await expect(retire()).rejects.toBeInstanceOf(ResourceProtectionError);
	});
	spyOn(gitService, "createWorktree").mockResolvedValue(undefined);
	const remove = spyOn(gitService, "removeWorktree").mockImplementation(async () => {
		await expect(retire()).rejects.toBeInstanceOf(ResourceProtectionError);
	});
	const deleteBranch = spyOn(gitService, "deleteBranch").mockResolvedValue(undefined);
	const original = new ResourceProtectionError("injected narrator failure", {
		status: "unavailable",
		complete: false,
		claims: [],
	});
	spyOn(narratorService, "create").mockImplementation(async () => {
		await expect(retire()).rejects.toBeInstanceOf(ResourceProtectionError);
		throw original;
	});
	await expect(
		chapterService.create({ projectId, title: "owned compensation fixture" }),
	).rejects.toBe(original);
	expect(retired).toBe(false);
	expect(branch).toHaveBeenCalledTimes(1);
	expect(remove).toHaveBeenCalledTimes(1);
	expect(deleteBranch).toHaveBeenCalledTimes(1);
	expect(
		db.select({ id: chapters.id }).from(chapters).where(eq(chapters.projectId, projectId)).all(),
	).toHaveLength(1);
	await retire();
	expect(retired).toBe(true);
});

test("root creation failure compensates only its new row, never the existing repository or its claims", async () => {
	const owner = generateId();
	otherNarrators.push(owner);
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: owner,
		cwd: temporary,
		title: "independent repository owner",
		createdAt: now,
		updatedAt: now,
	});
	const effects = sideEffects();
	const branch = spyOn(gitService, "createBranch").mockResolvedValue(undefined);
	const worktree = spyOn(gitService, "createWorktree").mockResolvedValue(undefined);
	const original = new ResourceProtectionError("injected root narrator failure", {
		status: "unavailable",
		complete: false,
		claims: [],
	});
	spyOn(narratorService, "create").mockRejectedValue(original);
	await expect(
		chapterService.createRootChapter({
			projectId,
			title: "failed root",
			gitPath: temporary,
			defaultBranch: "main",
		}),
	).rejects.toBe(original);
	expect(branch).toHaveBeenCalledTimes(0);
	expect(worktree).toHaveBeenCalledTimes(0);
	for (const effect of effects) expect(effect).toHaveBeenCalledTimes(0);
	expect(
		db.select({ id: chapters.id }).from(chapters).where(eq(chapters.projectId, projectId)).all(),
	).toHaveLength(1);
	expect(
		db.select({ cwd: narrators.cwd }).from(narrators).where(eq(narrators.id, owner)).get()?.cwd,
	).toBe(temporary);
});

test("ambiguous createWorktree failure never authorizes checkout rm; known branch compensation keeps original error", async () => {
	spyOn(gitService, "isGitRepo").mockResolvedValue(true);
	spyOn(gitService, "branchExists").mockResolvedValue(true);
	spyOn(gitService, "createBranch").mockResolvedValue(undefined);
	const original = new Error("ambiguous Git result");
	spyOn(gitService, "createWorktree").mockRejectedValue(original);
	const remove = spyOn(gitService, "removeWorktree").mockResolvedValue(undefined);
	const deletion = spyOn(fs, "rmSync").mockImplementation(() => undefined);
	const branch = spyOn(gitService, "deleteBranch").mockResolvedValue(undefined);
	await expect(chapterService.create({ projectId, title: "unknown Git worktree" })).rejects.toBe(
		original,
	);
	expect(branch).toHaveBeenCalledTimes(1);
	expect(remove).toHaveBeenCalledTimes(0);
	expect(deletion).toHaveBeenCalledTimes(0);
	expect(
		db.select({ id: chapters.id }).from(chapters).where(eq(chapters.projectId, projectId)).all(),
	).toHaveLength(1);
});

test("creator compensation cannot turn a foreign legacy narrator binding into release authority", async () => {
	spyOn(gitService, "isGitRepo").mockResolvedValue(true);
	spyOn(gitService, "branchExists").mockResolvedValue(true);
	spyOn(gitService, "createBranch").mockResolvedValue(undefined);
	let destination = "";
	spyOn(gitService, "createWorktree").mockImplementation(async (_repo, target) => {
		destination = target;
	});
	const remove = spyOn(gitService, "removeWorktree").mockResolvedValue(undefined);
	const branch = spyOn(gitService, "deleteBranch").mockResolvedValue(undefined);
	const narratorRemoval = spyOn(narratorService, "remove").mockResolvedValue(undefined);
	const original = new ResourceProtectionError(
		"foreign binding injected during narrator creation",
		{ status: "protected", complete: true, claims: [] },
	);
	spyOn(narratorService, "create").mockImplementation(async (input) => {
		await db
			.update(narrators)
			.set({ chapterId: input.chapterId, cwd: destination })
			.where(eq(narrators.id, narratorId));
		throw original;
	});
	await expect(chapterService.create({ projectId, title: "foreign binding fixture" })).rejects.toBe(
		original,
	);
	expect(remove).toHaveBeenCalledTimes(0);
	expect(branch).toHaveBeenCalledTimes(0);
	expect(narratorRemoval).toHaveBeenCalledTimes(0);
	expect(
		db.select({ cwd: narrators.cwd }).from(narrators).where(eq(narrators.id, narratorId)).get()
			?.cwd,
	).toBe(destination);
	expect(
		db.select({ id: chapters.id }).from(chapters).where(eq(chapters.projectId, projectId)).all(),
	).toHaveLength(2);
});

test("actual creation freezes the existing parent of an unknown destination before its first Git effect", async () => {
	spyOn(gitService, "isGitRepo").mockResolvedValue(true);
	spyOn(gitService, "branchExists").mockResolvedValue(true);
	const parent = join(temporary, ".worktrees");
	const backup = join(temporary, "original-worktrees");
	const marker = Buffer.from([0, 128, 255, 13, 10]);
	await writeFile(join(path, "marker.bin"), marker);
	spyOn(gitService, "createBranch").mockImplementation(async () => {
		await rename(parent, backup);
		await mkdir(parent);
	});
	const dispatch = spyOn(spawn, "safeSpawn");
	const removal = spyOn(gitService, "removeWorktree").mockResolvedValue(undefined);
	const branchRemoval = spyOn(gitService, "deleteBranch").mockResolvedValue(undefined);
	const deletion = spyOn(fs, "rmSync").mockImplementation(() => undefined);
	const before = changes();
	await expect(
		chapterService.create({ projectId, title: "parent replacement fixture" }),
	).rejects.toBeInstanceOf(ResourceProtectionError);
	expect(dispatch).toHaveBeenCalledTimes(0);
	expect(removal).toHaveBeenCalledTimes(0);
	expect(branchRemoval).toHaveBeenCalledTimes(0);
	expect(deletion).toHaveBeenCalledTimes(0);
	expect(changes()).toBe(before);
	expect(await readFile(join(backup, "legacy-Ab1234", "marker.bin"))).toEqual(marker);
});

for (const malformed of [
	"array",
	"prototype",
	"version",
	"missingRepository",
	"objectRepository",
] as const) {
	test(`receipt ${malformed} is unavailable in verified legacy scope, not skipped`, async () => {
		const directory = getNarraforkPath("worktree-requests");
		await mkdir(directory, { recursive: true });
		const receipt = join(
			directory,
			`${createHash("sha256").update(generateId()).digest("hex")}.json`,
		);
		const record: Record<string, unknown> = {
			destination: path,
			deviceId: "local",
			repositoryKey: "fixture-repository",
		};
		if (malformed === "version") record.version = 1;
		if (malformed === "missingRepository") delete record.repositoryKey;
		if (malformed === "objectRepository") record.repositoryKey = {};
		await writeFile(
			receipt,
			malformed === "prototype"
				? `{"__proto__":{},"destination":${JSON.stringify(path)},"repositoryKey":"fixture-repository"}`
				: JSON.stringify(malformed === "array" ? [record] : record),
		);
		try {
			const effects = sideEffects();
			const dispatch = spyOn(spawn, "safeSpawn");
			const before = changes();
			await expect(chapterService.remove(chapterId)).rejects.toMatchObject({
				code: "RESOURCE_PROTECTION_UNAVAILABLE",
			});
			for (const effect of effects) expect(effect).toHaveBeenCalledTimes(0);
			expect(dispatch).toHaveBeenCalledTimes(0);
			expect(changes()).toBe(before);
		} finally {
			await rm(receipt);
		}
	});
}

async function shadowBirthFixture() {
	const dir = treeSnapshotPhysicalDir("local", path);
	const home = process.env.NARRAFORK_HOME;
	if (process.env.NARRAFORK_TEST !== "1" || !home || !dir.startsWith(`${home}/`))
		throw new Error("Shadow birth fixture escaped isolated home");
	expect(fs.existsSync(dir)).toBe(false);
	otherRoots.push(dir);
	await db.insert(worktreeTreeSnapshots).values({
		id: generateId(),
		deviceId: "local",
		worktreePath: path,
		treeHash: "a".repeat(40),
		createdAt: new Date().toISOString(),
	});
	writeClaimCache.openClaim(path, narratorId, "retained-birth-cache", ["marker.bin"]);
	const cacheClear = spyOn(writeClaimCache, "clearClaims");
	const observations = new SnapshotCaptureReceiptService({ db, privateRoot: getNarraforkPath() });
	// Capture receipts are observation writes, not retirement/compensation writes.
	// Keep that separate observer inert so total_changes measures the actual sink.
	spyOn(observations, "begin").mockResolvedValue(null);
	spyOn(observations, "finish").mockResolvedValue(undefined);
	const capture = (legacy = true) =>
		withSnapshotCaptureReceipts(observations, () =>
			legacy
				? withLegacyRetirement([chapterId], "shadow birth fixture", () =>
						worktreeTreeSnapshot.capture(path),
					)
				: worktreeTreeSnapshot.capture(path),
		);
	const assertRetained = (before: number | undefined) => {
		expect(changes()).toBe(before);
		expect(cacheClear).toHaveBeenCalledTimes(0);
		expect(writeClaimCache.claimCount(path)).toBe(1);
		expect(
			db
				.select({ hash: worktreeTreeSnapshots.treeHash })
				.from(worktreeTreeSnapshots)
				.where(eq(worktreeTreeSnapshots.worktreePath, path))
				.all(),
		).toEqual([{ hash: "a".repeat(40) }]);
	};
	return { dir, capture, assertRetained };
}

const failedShadowInit = { exitCode: 1, stdout: "", stderr: "fixture shadow init failure" };

test("actual retirement capture init failure refuses rm after D is renamed and replaced by a new inode", async () => {
	const { dir, capture, assertRetained } = await shadowBirthFixture();
	const backup = join(temporary, "original-birth-D");
	const original = Buffer.from([0, 128, 255, 13, 10, 1]);
	const replacement = Buffer.from([0, 128, 255, 13, 10, 2]);
	const deletion = spyOn(fs, "rmSync");
	const init = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
		expect(opts.cmd).toEqual(["git", "init", "--bare", dir]);
		await writeFile(join(dir, "marker.bin"), original);
		await rename(dir, backup);
		await mkdir(dir);
		await writeFile(join(dir, "marker.bin"), replacement);
		return failedShadowInit;
	});
	const before = changes();
	await expect(capture()).rejects.toBeInstanceOf(ResourceProtectionError);
	expect(init).toHaveBeenCalledTimes(1);
	expect(deletion).toHaveBeenCalledTimes(0);
	assertRetained(before);
	expect(await readFile(join(backup, "marker.bin"))).toEqual(original);
	expect(await readFile(join(dir, "marker.bin"))).toEqual(replacement);
});

test("actual retirement capture init failure preserves a pre-existing invalid shadow directory", async () => {
	const { dir, capture, assertRetained } = await shadowBirthFixture();
	await mkdir(dir, { recursive: true });
	const marker = Buffer.from([0, 255, 128, 13, 10]);
	await writeFile(join(dir, "marker.bin"), marker);
	const deletion = spyOn(fs, "rmSync");
	const init = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
		expect(opts.cmd).toEqual(["git", "init", "--bare", dir]);
		return failedShadowInit;
	});
	const before = changes();
	await expect(capture()).rejects.toBeInstanceOf(TreeSnapshotError);
	expect(init).toHaveBeenCalledTimes(1);
	expect(deletion).toHaveBeenCalledTimes(0);
	assertRetained(before);
	expect(await readFile(join(dir, "marker.bin"))).toEqual(marker);
});

for (const legacy of [true, false]) {
	test(`actual ${legacy ? "retirement" : "ordinary"} capture cleans only its unchanged, unclaimed new birth on init failure`, async () => {
		const { dir, capture, assertRetained } = await shadowBirthFixture();
		const deletion = spyOn(fs, "rmSync");
		const init = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
			expect(opts.cmd).toEqual(["git", "init", "--bare", dir]);
			await writeFile(join(dir, "partial-owned.bin"), Buffer.from([0, 255, 13, 10]));
			return failedShadowInit;
		});
		const before = changes();
		await expect(capture(legacy)).rejects.toBeInstanceOf(TreeSnapshotError);
		expect(init).toHaveBeenCalledTimes(1);
		expect(deletion).toHaveBeenCalledTimes(1);
		expect(deletion).toHaveBeenCalledWith(dir, { recursive: true, force: true });
		expect(fs.existsSync(dir)).toBe(false);
		assertRetained(before);
	});
}

for (const kind of ["cwd", "registry", "receipt"] as const) {
	test(`actual retirement capture re-reads a late persisted ${kind} claim before failed-birth rm`, async () => {
		const { dir, capture, assertRetained } = await shadowBirthFixture();
		const marker = Buffer.from([0, 255, 128, 13, 10]);
		let before: number | undefined;
		let receipt: string | undefined;
		const deletion = spyOn(fs, "rmSync");
		spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
			expect(opts.cmd).toEqual(["git", "init", "--bare", dir]);
			await writeFile(join(dir, "marker.bin"), marker);
			if (kind === "cwd") {
				const id = generateId();
				otherNarrators.push(id);
				const now = new Date().toISOString();
				await db.insert(narrators).values({
					id,
					cwd: dir,
					title: "late independent birth cwd",
					createdAt: now,
					updatedAt: now,
				});
			} else if (kind === "registry") {
				const id = generateId();
				const now = new Date().toISOString();
				await db.insert(narratorWorktreeResources).values({
					id,
					ownerNarratorId: null,
					deviceId: "local",
					repositoryKey: "fixture-repository",
					worktreePath: dir,
					createRequestId: id,
					state: "unknown",
					createdAt: now,
					updatedAt: now,
				});
			} else {
				const directory = getNarraforkPath("worktree-requests");
				await mkdir(directory, { recursive: true });
				receipt = join(
					directory,
					`${createHash("sha256").update(generateId()).digest("hex")}.json`,
				);
				await writeFile(
					receipt,
					JSON.stringify({
						destination: dir,
						deviceId: "local",
						repositoryKey: "fixture-repository",
					}),
				);
			}
			before = changes(); // exclude the deliberate adversarial evidence insertion
			return failedShadowInit;
		});
		try {
			await expect(capture()).rejects.toMatchObject({ code: "RESOURCE_PROTECTED" });
			expect(deletion).toHaveBeenCalledTimes(0);
			assertRetained(before);
			expect(await readFile(join(dir, "marker.bin"))).toEqual(marker);
		} finally {
			if (receipt) await rm(receipt);
		}
	});
}

for (const kind of ["cwd", "registry", "receipt"] as const) {
	test(`actual retirement capture keeps the birth barrier during Git await and refuses ${kind} admission`, async () => {
		const { dir, capture, assertRetained } = await shadowBirthFixture();
		const directory = getNarraforkPath("worktree-requests");
		const journal = new FileWorktreeJournal(directory);
		const publish = spyOn(journal, "claim");
		const requestId = "birth-admission-receipt";
		const receipt = join(
			directory,
			`${createHash("sha256")
				.update(JSON.stringify([narratorId, requestId]))
				.digest("hex")}.json`,
		);
		const deletion = spyOn(fs, "rmSync");
		spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
			expect(opts.cmd).toEqual(["git", "init", "--bare", dir]);
			const admit =
				kind === "cwd"
					? narratorService.create({ cwd: dir, title: "late independent cwd" })
					: kind === "registry"
						? narratorWorktreeResourceRegistry.register({
								ownerNarratorId: narratorId,
								deviceId: "local",
								repositoryKey: "fixture-repository",
								worktreePath: dir,
								createRequestId: generateId(),
							})
						: withWorkspaceAdmission({ deviceId: "local", path: dir }, () =>
								journal.claim(narratorId, requestId, {
									proposalHash: "fixture",
									repositoryKey: "fixture-repository",
									destination: dir,
									deviceId: "local",
									expectedHead: "a".repeat(40),
									request: {
										expectedRevision: 0,
										workspaceKey: "fixture",
										requestId,
										destinationPath: dir,
										branch: { kind: "new", name: "fixture" },
									},
								}),
							);
			await expect(admit).rejects.toBeInstanceOf(ResourceProtectionError);
			return failedShadowInit;
		});
		const before = changes();
		await expect(capture()).rejects.toBeInstanceOf(TreeSnapshotError);
		assertRetained(before);
		expect(publish).toHaveBeenCalledTimes(0);
		expect(fs.existsSync(receipt)).toBe(false);
		expect(deletion).toHaveBeenCalledTimes(1);
		expect(fs.existsSync(dir)).toBe(false);
	});
}

test("actual retirement capture refuses failed-birth rm when the final inventory becomes unavailable", async () => {
	const { dir, capture, assertRetained } = await shadowBirthFixture();
	const marker = Buffer.from([0, 255, 128, 13, 10]);
	const deletion = spyOn(fs, "rmSync");
	let inventoryAvailable = true;
	spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
		expect(opts.cmd).toEqual(["git", "init", "--bare", dir]);
		await writeFile(join(dir, "marker.bin"), marker);
		inventoryAvailable = false;
		return failedShadowInit;
	});
	const before = changes();
	await expect(
		withLifecycleGuardPorts(
			{
				canonicalPath: async (value) => value,
				readClaims: async () => ({ complete: inventoryAvailable, claims: [] }),
			},
			() => capture(),
		),
	).rejects.toMatchObject({ code: "RESOURCE_PROTECTION_UNAVAILABLE" });
	expect(deletion).toHaveBeenCalledTimes(0);
	assertRetained(before);
	expect(await readFile(join(dir, "marker.bin"))).toEqual(marker);
});
