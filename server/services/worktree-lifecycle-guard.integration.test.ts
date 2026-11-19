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
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, sqlite } from "../db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorWorktreeResources,
	projects,
	worktreeTreeSnapshots,
} from "../db/schema";
import { LocalBackend } from "../lib/agent/execution/local-backend";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { getNarraforkPath } from "../lib/narrafork-home";
import * as spawn from "../lib/spawn";
import { projectRoutes } from "../routes/projects";
import { narratorCreationWorkspaceTarget, narratorService } from "./narrator-service";
import * as narratorSession from "./narrator-session";
import { FileWorktreeJournal, worktreeReceiptHasResourceEffect } from "./narrator-worktree-journal";
import { narratorWorktreeResourceRegistry } from "./narrator-worktree-resources";
import { NarratorWorktreeService, type WorktreeTarget } from "./narrator-worktree-service";
import * as oauthRuntime from "./oauth-runtime-revocation";
import { canonicalProtectionPath, maintainProtectionIndex } from "./resource-protection-index";
import {
	SnapshotCaptureReceiptService,
	withSnapshotCaptureReceipts,
} from "./snapshot-capture-receipts";
import { extractSubagentToPrimary } from "./subagent-extract";
import { snapshotPathIdentity, treeSnapshotPhysicalDir } from "./tree-snapshot-paths";
import { workspaceContextService } from "./workspace-context-service";
import {
	inspect,
	ResourceProtectionError,
	withLifecycleGuardPorts,
	withProjectRetirement,
	withProtectionReservation,
	withWorkspaceAdmission,
} from "./worktree-lifecycle-guard";
import { TreeSnapshotError, worktreeTreeSnapshot } from "./worktree-tree-snapshot";
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
	.route("/projects", projectRoutes);
let temporary: string;
/** A checkout under the project's `.worktrees/` that no record owns (e.g. left by an old release). */
let path: string;
let projectId: string;
/** An ordinary standalone session working beside, not inside, the checkout. */
let narratorId: string;
const otherNarrators: string[] = [];
const otherRoots: string[] = [];
function changes() {
	return sqlite.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n;
}
function beginLegacyReceiptImport() {
	// Each fixture models an upgrade with files already present, not a live journal owner.
	sqlite.exec(`UPDATE resource_protection_sources SET complete = 0, cursor = NULL
		WHERE source = 'receipt' AND source_id = ''`);
}
async function importLegacyReceiptFixture(complete = true) {
	beginLegacyReceiptImport();
	for (let batch = 0; batch < 4; batch++) {
		await maintainProtectionIndex(performance.now() + 5000);
		if (
			sqlite
				.query<{ complete: number }, []>(
					"SELECT complete FROM resource_protection_sources WHERE source = 'receipt' AND source_id = ''",
				)
				.get()?.complete
		)
			return;
	}
	if (complete) throw new Error("Legacy fixture import did not complete");
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
	await rm(getNarraforkPath("worktree-requests"), { recursive: true, force: true });
	// Reset only this isolated test's compatibility lifetime, including invalid old fixtures.
	sqlite.exec(`DELETE FROM resource_protection_paths WHERE source = 'receipt';
		DELETE FROM resource_protection_sources WHERE source = 'receipt' AND source_id != ''`);
	temporary = await realpath(await mkdtemp(join(tmpdir(), "nf-lifecycle-guard-")));
	path = join(temporary, ".worktrees", "legacy-Ab1234");
	const home = join(temporary, "home");
	await mkdir(path, { recursive: true });
	await mkdir(home);
	projectId = generateId();
	narratorId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "lifecycle fixture",
		gitPath: temporary,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	await db.insert(narrators).values({
		id: narratorId,
		title: "fixture narrator",
		cwd: home,
		traits: ["standalone"],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	await importLegacyReceiptFixture();
});
afterEach(async () => {
	mock.restore();
	writeClaimCache.clearClaims(path);
	await db
		.delete(worktreeTreeSnapshots)
		.where(eq(worktreeTreeSnapshots.worktreePath, snapshotPathIdentity(path)));
	await db
		.delete(narratorWorktreeResources)
		.where(eq(narratorWorktreeResources.repositoryKey, "fixture-repository"));
	await db
		.delete(narratorWorktreeResources)
		.where(eq(narratorWorktreeResources.scopeProjectId, projectId));
	const ids = [...otherNarrators.splice(0).reverse(), narratorId];
	await db.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.narratorId, ids));
	// A selected-message fork also keeps its boundary as a message FK.
	// Retire that fixture pointer before deleting the shared message rows.
	await db.update(narrators).set({ forkMessageId: null }).where(inArray(narrators.id, ids));
	await db.delete(narratorMessages).where(inArray(narratorMessages.narratorId, ids));
	for (const id of ids) await db.delete(narrators).where(eq(narrators.id, id));
	await db.delete(projects).where(eq(projects.id, projectId));
	await rm(temporary, { recursive: true, force: true });
	for (const root of otherRoots.splice(0)) await rm(root, { recursive: true, force: true });
});
function sideEffects() {
	return [
		spyOn(narratorService, "remove").mockResolvedValue(undefined),
		spyOn(narratorSession, "interruptNarrator").mockImplementation(() => false),
		spyOn(narratorSession, "closeNarrator").mockImplementation(() => undefined),
		spyOn(oauthRuntime, "propagateOAuthProjectRemoval").mockResolvedValue(0),
		spyOn(fs, "rmSync").mockImplementation(() => undefined),
	];
}

test("Project DELETE without a repository preserves independent disk resources without blocking metadata", async () => {
	await db.update(projects).set({ gitPath: null }).where(eq(projects.id, projectId));
	await inventory("unknown", null);
	const marker = Buffer.from([0, 255, 42]);
	await writeFile(join(path, "retained.bin"), marker);
	const effects = sideEffects();
	const response = await app.request(`/projects/${projectId}`, { method: "DELETE" });
	expect(response.status).toBe(200);
	expect(await readFile(join(path, "retained.bin"))).toEqual(marker);
	expect(effects[4]).toHaveBeenCalledTimes(0);
	expect(
		db
			.select({ state: narratorWorktreeResources.state })
			.from(narratorWorktreeResources)
			.where(eq(narratorWorktreeResources.worktreePath, path))
			.get()?.state,
	).toBe("unknown");
});

test("metadata-only Project DELETE does not read unrelated resource inventory", async () => {
	await db.update(projects).set({ gitPath: null }).where(eq(projects.id, projectId));
	const effects = sideEffects();
	const readClaims = mock(async () => ({ complete: false, claims: [] }));
	const response = await withLifecycleGuardPorts(
		{ canonicalPath: async (value) => value, readClaims },
		async () => app.request(`/projects/${projectId}`, { method: "DELETE" }),
	);
	expect(response.status).toBe(200);
	expect(readClaims).not.toHaveBeenCalled();
	for (const effect of effects.slice(4)) expect(effect).not.toHaveBeenCalled();
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
	const deletion = mock(async () => undefined);
	await expect(withProtectionReservation([{ path }], "delete", deletion)).rejects.toBeInstanceOf(
		ResourceProtectionError,
	);
	expect(deletion).toHaveBeenCalledTimes(0);
});

test("registry commit and directory switch share the destructive reservation; post-release retry succeeds", async () => {
	const resource = {
		ownerNarratorId: narratorId,
		deviceId: "local",
		repositoryKey: "fixture-repository",
		worktreePath: path,
		createRequestId: generateId(),
	};
	await withProtectionReservation([{ path }], "retire", async () => {
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

test("inventory committed inside a held reservation still protects a nested destructive sink", async () => {
	const deletion = mock(async () => undefined);
	await expect(
		withProtectionReservation([{ path }], "retire", async () => {
			await inventory();
			await withProtectionReservation([{ path }], "late sink", deletion);
		}),
	).rejects.toBeInstanceOf(ResourceProtectionError);
	expect(deletion).toHaveBeenCalledTimes(0);
});

test("real switch CAS rejects during a checkout reservation; the same request can retry after release", async () => {
	const nested = join(path, "src");
	await mkdir(nested);
	const request = {
		expectedRevision: 0,
		requestId: "lifecycle-switch",
		target: { deviceId: "local", cwd: nested },
	};
	await withProtectionReservation([{ path }], "retire", async () => {
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
			const external = await realpath(await mkdtemp(join(tmpdir(), "nf-lifecycle-external-")));
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
	test(`actual ${kind} insert is rejected during project retirement, with zero SQL writes, then can retry`, async () => {
		await db
			.update(narrators)
			.set({ contextProjectId: projectId })
			.where(eq(narrators.id, narratorId));
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
				return narratorService.create({
					cwd: path,
					contextProjectId: projectId,
					title: "late project session",
				});
			if (kind === "subagent")
				return narratorService.createSubagent({
					parentNarratorId: narratorId,
					subagentOriginKind: "standalone",
					subagentType: "general",
					cwd: path,
				});
			if (kind === "fork")
				return narratorService.forkNarrator(narratorId, null, { inheritMode: "fresh" });
			return narratorService.forkFromMessages(narratorId, [messageId]);
		};
		expect((await narratorService.getById(narratorId)).replyContext).toBeNull();
		await withProjectRetirement(projectId, async () => {
			const before = changes();
			await expect(action()).rejects.toBeInstanceOf(ResourceProtectionError);
			expect(changes()).toBe(before);
			expect((await narratorService.getById(narratorId)).replyContext).toBeNull();
		});
		const created = await action();
		if (kind === "forkFromMessages") expect(created.forkMessageId).toBe(messageId);
		if (kind !== "create") {
			expect(created.replyContext).not.toBeNull();
			expect(created.replyContext).toEqual(
				(await narratorService.getById(narratorId)).replyContext,
			);
		}
		otherNarrators.push(created.id);
		expect(
			db
				.select({ project: narrators.contextProjectId })
				.from(narrators)
				.where(eq(narrators.id, created.id))
				.get()?.project,
		).toBe(projectId);
	});
}

for (const kind of ["create", "subagent", "extract"] as const) {
	test(`actual ${kind} insert into a reserved checkout is rejected with zero SQL writes, then can retry`, async () => {
		const action = () => {
			if (kind === "create")
				return narratorService.create({ cwd: path, title: "late independent cwd" });
			if (kind === "extract") return extractSubagentToPrimary(narratorId);
			return narratorService.createSubagent({
				parentNarratorId: narratorId,
				subagentOriginKind: "standalone",
				subagentType: "general",
				cwd: path,
			});
		};
		expect((await narratorService.getById(narratorId)).replyContext).toBeNull();
		await withProtectionReservation([{ path }], "retire during creation", async () => {
			// Simulate a legacy source appearing after reservation; setup is not part of action's writes.
			if (kind === "extract")
				await db
					.update(narrators)
					.set({
						type: "subagent",
						variant: "subagent:general",
						subagentType: "general",
						cwd: path,
					})
					.where(eq(narrators.id, narratorId));
			const before = changes();
			await expect(action()).rejects.toBeInstanceOf(ResourceProtectionError);
			expect(changes()).toBe(before);
			expect((await narratorService.getById(narratorId)).replyContext).toBeNull();
		});
		const created = await action();
		if (kind !== "create") {
			expect(created.replyContext).not.toBeNull();
			expect(created.replyContext).toEqual(
				(await narratorService.getById(narratorId)).replyContext,
			);
		}
		otherNarrators.push(created.id);
		expect(
			db.select({ cwd: narrators.cwd }).from(narrators).where(eq(narrators.id, created.id)).get()
				?.cwd,
		).toBe(path);
	});
}

test("project deletion does not claim unrelated same-repository resources or depend on a common-dir probe", async () => {
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
	const foreign = await realpath(await mkdtemp(join(tmpdir(), "nf-git-poison-")));
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
		sideEffects();
		const response = await app.request(`/projects/${projectId}`, { method: "DELETE" });
		expect(response.status).toBe(200);
		expect(fs.existsSync(join(foreign, ".git"))).toBe(true);
		expect(
			db
				.select({ id: narratorWorktreeResources.id })
				.from(narratorWorktreeResources)
				.where(eq(narratorWorktreeResources.id, id))
				.get()?.id,
		).toBe(id);
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
	test(`receipt invalid explicit device ${JSON.stringify(deviceId)} refuses a checkout reservation before any effect`, async () => {
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
		await importLegacyReceiptFixture(false);
		try {
			const body = mock(async () => undefined);
			const dispatch = spyOn(spawn, "safeSpawn");
			const before = changes();
			await expect(
				withProtectionReservation([{ path }], "fixture retirement", body),
			).rejects.toMatchObject({ code: "RESOURCE_PROTECTION_UNAVAILABLE" });
			expect(body).toHaveBeenCalledTimes(0);
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
		await importLegacyReceiptFixture();
		try {
			const effects = sideEffects();
			const before = changes();
			let admitted = false;
			const run = () =>
				withProtectionReservation([{ path }], "fixture retirement", async () => {
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

for (const malformed of [
	"array",
	"prototype",
	"version",
	"missingRepository",
	"objectRepository",
] as const) {
	test(`receipt ${malformed} is unavailable to a checkout reservation, not skipped`, async () => {
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
		await importLegacyReceiptFixture(false);
		try {
			const body = mock(async () => undefined);
			const dispatch = spyOn(spawn, "safeSpawn");
			const before = changes();
			await expect(
				withProtectionReservation([{ path }], "fixture retirement", body),
			).rejects.toMatchObject({ code: "RESOURCE_PROTECTION_UNAVAILABLE" });
			expect(body).toHaveBeenCalledTimes(0);
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
	if (
		process.env.NARRAFORK_TEST !== "1" ||
		!home ||
		localPathSemantics.equals(home, dir) ||
		!localPathSemantics.contains(home, dir)
	)
		throw new Error("Shadow birth fixture escaped isolated home");
	expect(fs.existsSync(dir)).toBe(false);
	otherRoots.push(dir);
	await db.insert(worktreeTreeSnapshots).values({
		id: generateId(),
		deviceId: "local",
		worktreePath: snapshotPathIdentity(path),
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
	const capture = () =>
		withSnapshotCaptureReceipts(observations, () => worktreeTreeSnapshot.capture(path));
	const assertRetained = (before: number | undefined, capturedHash?: string) => {
		if (capturedHash) expect(changes()).toBeGreaterThan(before ?? 0);
		else expect(changes()).toBe(before);
		expect(cacheClear).toHaveBeenCalledTimes(0);
		expect(writeClaimCache.claimCount(path)).toBe(1);
		const hashes = db
			.select({ hash: worktreeTreeSnapshots.treeHash })
			.from(worktreeTreeSnapshots)
			.where(eq(worktreeTreeSnapshots.worktreePath, snapshotPathIdentity(path)))
			.all()
			.map((row) => row.hash);
		expect(hashes).toContain("a".repeat(40));
		if (capturedHash) expect(hashes).toContain(capturedHash);
		else expect(hashes).toHaveLength(1);
	};
	const stageFromInit = (cmd: readonly string[]) => {
		expect(cmd.slice(0, 3)).toEqual(["git", "init", "--bare"]);
		const stage = cmd[3];
		if (!stage) throw new Error("Expected an isolated shadow stage");
		expect(dirname(stage)).toBe(dirname(dir));
		expect(basename(stage).startsWith(`.nf-shadow-stage-${basename(dir)}-`)).toBe(true);
		expect(fs.existsSync(join(stage, "nf-shadow-init"))).toBe(true);
		expect(stage).not.toBe(dir);
		otherRoots.push(stage);
		return stage;
	};
	return { dir, capture, assertRetained, stageFromInit };
}

for (const kind of ["cwd", "registry"] as const) {
	test(`cold initialization accepts an independent ${kind} reference to a missing cache while destruction stays protected`, async () => {
		const { dir, capture, assertRetained } = await shadowBirthFixture();
		const id = generateId();
		const now = new Date().toISOString();
		if (kind === "cwd") {
			otherNarrators.push(id);
			await db
				.insert(narrators)
				.values({ id, cwd: dir, title: "missing shadow claim", createdAt: now, updatedAt: now });
		} else {
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
		}
		const deletion = spyOn(fs, "rmSync");
		const readClaims = mock(async () => {
			throw new Error("A reference is not exclusive snapshot-creation ownership");
		});
		const before = changes();
		const hash = await withLifecycleGuardPorts(
			{ canonicalPath: canonicalProtectionPath, readClaims },
			() => capture(),
		);
		expect(hash).toMatch(/^[a-f0-9]{40,64}$/);
		expect(readClaims).not.toHaveBeenCalled();
		expect(deletion).not.toHaveBeenCalled();
		expect(fs.existsSync(join(dir, "HEAD"))).toBe(true);
		expect(fs.existsSync(join(dir, "nf-shadow-init"))).toBe(false);
		assertRetained(before, hash);
		expect((await inspect([{ path: dir }], "reference retirement fixture")).status).toBe(
			"protected",
		);
	});
}

const failedShadowInit = { exitCode: 1, stdout: "", stderr: "fixture shadow init failure" };

for (const legacy of ["frozen-pin", "corrupt", "unimported"] as const) {
	test(`cold initialization ignores ${legacy} legacy compatibility while destruction remains protected`, async () => {
		const { dir, capture, assertRetained, stageFromInit } = await shadowBirthFixture();
		const directory = getNarraforkPath("worktree-requests");
		await mkdir(directory, { recursive: true });
		// More than one read-only proof page models an unfinished import, not a permanent cap.
		const count = legacy === "unimported" ? 65 : 1;
		for (let index = 0; index < count; index++) {
			await writeFile(
				join(directory, `${index.toString(16).padStart(64, "0")}.json`),
				legacy === "corrupt"
					? "{"
					: JSON.stringify({
							destination: dir,
							deviceId: "local",
							repositoryKey: "fixture-repository",
						}),
			);
		}
		if (legacy === "unimported") beginLegacyReceiptImport();
		else await importLegacyReceiptFixture(legacy !== "corrupt");
		const marker = Buffer.from([0, 255, 128, 13, 10]);
		const deletion = spyOn(fs, "rmSync");
		const originalSpawn = spawn.safeSpawn;
		const init = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
			if (opts.cmd[1] === "init") {
				const stage = stageFromInit(opts.cmd);
				await writeFile(join(stage, "marker.bin"), marker);
			}
			return originalSpawn(opts);
		});
		const readClaims = mock(async () => {
			throw new Error("Legacy inventory must not gate capture");
		});
		const before = changes();
		const hash = await withLifecycleGuardPorts(
			{ canonicalPath: canonicalProtectionPath, readClaims },
			() => capture(),
		);
		expect(hash).toMatch(/^[a-f0-9]{40,64}$/);
		expect(readClaims).not.toHaveBeenCalled();
		expect(init.mock.calls.filter(([opts]) => opts.cmd[1] === "init")).toHaveLength(1);
		const destruction = mock(async () => undefined);
		await expect(
			withProtectionReservation(
				[{ path: dir }],
				"legacy compatibility destruction fixture",
				destruction,
			),
		).rejects.toMatchObject({
			code: legacy === "frozen-pin" ? "RESOURCE_PROTECTED" : "RESOURCE_PROTECTION_UNAVAILABLE",
		});
		expect(destruction).toHaveBeenCalledTimes(0);
		expect(deletion).toHaveBeenCalledTimes(0);
		assertRetained(before, hash);
		expect(fs.existsSync(join(dir, "nf-shadow-init"))).toBe(false);
		expect(await readFile(join(dir, "marker.bin"))).toEqual(marker);
	});
}

test("actual capture preserves the init error and both inodes after a private stage replacement", async () => {
	const { dir, capture, assertRetained, stageFromInit } = await shadowBirthFixture();
	const backup = join(temporary, "original-birth-D");
	const original = Buffer.from([0, 128, 255, 13, 10, 1]);
	const replacement = Buffer.from([0, 128, 255, 13, 10, 2]);
	const deletion = spyOn(fs, "rmSync");
	let stage = "";
	let originalInode = 0;
	let replacementInode = 0;
	const init = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
		stage = stageFromInit(opts.cmd);
		originalInode = fs.lstatSync(stage).ino;
		await writeFile(join(stage, "marker.bin"), original);
		await rename(stage, backup);
		await mkdir(stage);
		replacementInode = fs.lstatSync(stage).ino;
		await writeFile(join(stage, "marker.bin"), replacement);
		return failedShadowInit;
	});
	const before = changes();
	await expect(capture()).rejects.toThrow("shadow repo init failed: fixture shadow init failure");
	expect(init).toHaveBeenCalledTimes(1);
	expect(deletion).toHaveBeenCalledTimes(0);
	assertRetained(before);
	expect(await readFile(join(backup, "marker.bin"))).toEqual(original);
	expect(fs.lstatSync(backup).ino).toBe(originalInode);
	expect(await readFile(join(stage, "marker.bin"))).toEqual(replacement);
	expect(fs.lstatSync(stage).ino).toBe(replacementInode);
	expect(replacementInode).not.toBe(originalInode);
	expect(fs.existsSync(dir)).toBe(false);
});

for (const headOnly of [false, true]) {
	test(`actual capture refuses an unknown shadow directory ${headOnly ? "with only HEAD" : "without HEAD"} before git`, async () => {
		const { dir, capture, assertRetained } = await shadowBirthFixture();
		await mkdir(dir, { recursive: true });
		const marker = Buffer.from([0, 255, 128, 13, 10]);
		await writeFile(join(dir, "marker.bin"), marker);
		if (headOnly) await writeFile(join(dir, "HEAD"), "ref: refs/heads/main\n");
		const deletion = spyOn(fs, "rmSync");
		const git = spyOn(spawn, "safeSpawn");
		const before = changes();
		await expect(capture()).rejects.toBeInstanceOf(TreeSnapshotError);
		expect(git).toHaveBeenCalledTimes(0);
		expect(deletion).toHaveBeenCalledTimes(0);
		assertRetained(before);
		expect(await readFile(join(dir, "marker.bin"))).toEqual(marker);
	});
}

test("actual capture retains a failed private stage through gcAll and publishes a fresh retry", async () => {
	const { dir, capture, assertRetained, stageFromInit } = await shadowBirthFixture();
	const deletion = spyOn(fs, "rmSync");
	let failedStage = "";
	const partial = Buffer.from([0, 255, 13, 10]);
	const init = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
		failedStage = stageFromInit(opts.cmd);
		await writeFile(join(failedStage, "partial-owned.bin"), partial);
		return failedShadowInit;
	});
	const before = changes();
	await expect(capture()).rejects.toBeInstanceOf(TreeSnapshotError);
	expect(init).toHaveBeenCalledTimes(1);
	const birth = fs.lstatSync(failedStage);
	const marker = await readFile(join(failedStage, "nf-shadow-init"));
	await worktreeTreeSnapshot.gcAll();
	expect(init).toHaveBeenCalledTimes(1);
	expect(deletion).not.toHaveBeenCalled();
	expect(await readFile(join(failedStage, "partial-owned.bin"))).toEqual(partial);
	expect(fs.existsSync(dir)).toBe(false);
	assertRetained(before);
	expect(marker.length).toBeLessThanOrEqual(256);
	init.mockRestore();
	const hash = await capture();
	expect(hash).toMatch(/^[0-9a-f]{40,64}$/);
	expect(fs.lstatSync(dir).ino).not.toBe(birth.ino);
	expect(fs.lstatSync(failedStage).ino).toBe(birth.ino);
	expect(await readFile(join(failedStage, "nf-shadow-init"))).toEqual(marker);
	expect(await readFile(join(failedStage, "partial-owned.bin"))).toEqual(partial);
	expect(fs.existsSync(join(dir, "partial-owned.bin"))).toBe(false);
	expect(fs.existsSync(join(dir, "nf-shadow-init"))).toBe(false);
	expect(deletion).not.toHaveBeenCalled();
	assertRetained(before, hash);
});

for (const kind of ["cwd", "registry"] as const) {
	test(`actual capture retains failed stage evidence and permits retry after a late ${kind} reference`, async () => {
		const { dir, capture, assertRetained, stageFromInit } = await shadowBirthFixture();
		const marker = Buffer.from([0, 255, 128, 13, 10]);
		let before: number | undefined;
		let failedStage = "";
		const deletion = spyOn(fs, "rmSync");
		const init = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
			failedStage = stageFromInit(opts.cmd);
			await writeFile(join(failedStage, "marker.bin"), marker);
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
			} else {
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
			}
			before = changes(); // exclude the deliberate adversarial evidence insertion
			return failedShadowInit;
		});
		await expect(capture()).rejects.toThrow("shadow repo init failed: fixture shadow init failure");
		expect(init).toHaveBeenCalledTimes(1);
		expect(deletion).not.toHaveBeenCalled();
		assertRetained(before);
		expect(await readFile(join(failedStage, "marker.bin"))).toEqual(marker);
		expect(fs.existsSync(dir)).toBe(false);
		init.mockRestore();
		const hash = await capture();
		expect(hash).toMatch(/^[0-9a-f]{40,64}$/);
		assertRetained(before, hash);
		expect(await readFile(join(failedStage, "marker.bin"))).toEqual(marker);
		expect((await inspect([{ path: dir }], "late reference retirement")).status).toBe("protected");
	});
}

test("a late nonempty physical final refuses publication while preserving the complete stage and all history", async () => {
	const { dir, capture, assertRetained, stageFromInit } = await shadowBirthFixture();
	const independent = Buffer.from([0, 255, 42, 13, 10]);
	const staged = Buffer.from([0, 128, 27]);
	const deletion = spyOn(fs, "rmSync");
	const originalSpawn = spawn.safeSpawn;
	let stage = "";
	const git = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
		if (opts.cmd[1] === "init") {
			stage = stageFromInit(opts.cmd);
			await writeFile(join(stage, "stage-evidence.bin"), staged);
			await mkdir(dir);
			await writeFile(join(dir, "independent.bin"), independent);
		}
		return originalSpawn(opts);
	});
	const before = changes();
	await expect(capture()).rejects.toMatchObject({
		code: expect.stringMatching(/^(ENOTEMPTY|EEXIST|EPERM)$/),
	});
	assertRetained(before);
	expect(await readFile(join(dir, "independent.bin"))).toEqual(independent);
	expect(await readFile(join(stage, "stage-evidence.bin"))).toEqual(staged);
	expect(fs.existsSync(join(stage, "HEAD"))).toBe(true);
	expect(fs.existsSync(join(stage, "nf-shadow-init"))).toBe(false);
	const calls = git.mock.calls.length;
	await expect(capture()).rejects.toBeInstanceOf(TreeSnapshotError);
	expect(git).toHaveBeenCalledTimes(calls);
	expect(deletion).not.toHaveBeenCalled();
	assertRetained(before);
	expect(await readFile(join(dir, "independent.bin"))).toEqual(independent);
});

for (const kind of ["cwd", "registry", "receipt"] as const) {
	test(`cold initialization permits a shared checkout ${kind} reference without a global barrier`, async () => {
		const { dir, capture, assertRetained, stageFromInit } = await shadowBirthFixture();
		const directory = getNarraforkPath("worktree-requests-v2");
		const journal = new FileWorktreeJournal(directory, getNarraforkPath("worktree-requests"));
		const publish = spyOn(journal, "claim");
		const requestId = "birth-admission-receipt";
		const receipt = join(
			directory,
			`${createHash("sha256")
				.update(JSON.stringify([narratorId, requestId]))
				.digest("hex")}.json`,
		);
		const deletion = spyOn(fs, "rmSync");
		let before: number | undefined;
		const originalSpawn = spawn.safeSpawn;
		let stage = "";
		const init = spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
			// Session creation indexes its cwd into a project with a bounded git probe;
			// only the shadow initializer is the sink under test.
			if (opts.cmd[1] === "-C") return originalSpawn(opts);
			stage = stageFromInit(opts.cmd);
			if (kind === "cwd") {
				const created = await narratorService.create({ cwd: path, title: "shared checkout cwd" });
				otherNarrators.push(created.id);
			} else if (kind === "registry") {
				await narratorWorktreeResourceRegistry.register({
					ownerNarratorId: narratorId,
					deviceId: "local",
					repositoryKey: "fixture-repository",
					worktreePath: path,
					createRequestId: generateId(),
				});
			} else {
				// The production v2 publisher does not create a resource ownership claim.
				await journal.claim(narratorId, requestId, {
					proposalHash: "fixture",
					repositoryKey: "fixture-repository",
					destination: path,
					deviceId: "local",
					expectedHead: "",
					dispatchState: "not_started",
					request: {
						expectedRevision: 0,
						workspaceKey: "fixture",
						requestId,
						destinationPath: path,
						branch: { kind: "new", name: "fixture" },
					},
				});
			}
			before = changes();
			return failedShadowInit;
		});
		try {
			await expect(capture()).rejects.toThrow(
				"shadow repo init failed: fixture shadow init failure",
			);
			expect(init.mock.calls.filter(([opts]) => opts.cmd[1] === "init")).toHaveLength(1);
			assertRetained(before);
			expect(publish).toHaveBeenCalledTimes(kind === "receipt" ? 1 : 0);
			expect(fs.existsSync(receipt)).toBe(kind === "receipt");
			expect(deletion).not.toHaveBeenCalled();
			expect(fs.existsSync(dir)).toBe(false);
			expect(fs.existsSync(join(stage, "nf-shadow-init"))).toBe(true);
		} finally {
			if (kind === "receipt") await rm(receipt, { force: true });
		}
	});
}

test("actual capture preserves its init error without any global inventory query", async () => {
	const { dir, capture, assertRetained, stageFromInit } = await shadowBirthFixture();
	const marker = Buffer.from([0, 255, 128, 13, 10]);
	const deletion = spyOn(fs, "rmSync");
	let stage = "";
	spyOn(spawn, "safeSpawn").mockImplementation(async (opts) => {
		stage = stageFromInit(opts.cmd);
		await writeFile(join(stage, "marker.bin"), marker);
		return failedShadowInit;
	});
	const readClaims = mock(async () => {
		throw new Error("Global inventory is unavailable");
	});
	const before = changes();
	await expect(
		withLifecycleGuardPorts({ canonicalPath: canonicalProtectionPath, readClaims }, () =>
			capture(),
		),
	).rejects.toThrow("shadow repo init failed: fixture shadow init failure");
	expect(readClaims).not.toHaveBeenCalled();
	expect(deletion).not.toHaveBeenCalled();
	assertRetained(before);
	expect(await readFile(join(stage, "marker.bin"))).toEqual(marker);
	expect(fs.existsSync(dir)).toBe(false);
});

test("reserving one checkout does not block a sibling session using the same repository", async () => {
	const sibling = join(temporary, ".worktrees", "new-sibling");
	await mkdir(sibling);
	let created = false;
	await withProtectionReservation([{ path }], "retire existing checkout", async () => {
		const narrator = await narratorService.create({ cwd: sibling, title: "new sibling" });
		otherNarrators.push(narrator.id);
		created = true;
	});
	expect(created).toBe(true);
	expect(fs.existsSync(sibling)).toBe(true);
});

test("actual cold snapshot initialization allows shared subagents and unrelated local/remote admissions", async () => {
	const initialized = await spawn.safeSpawn({
		cmd: ["git", "init", path],
		timeout: 5000,
		maxOutputBytes: 4096,
	});
	expect(initialized.exitCode).toBe(0);
	await writeFile(join(path, "snapshot.txt"), "cold snapshot\n");
	const dir = treeSnapshotPhysicalDir("local", path);
	otherRoots.push(dir);
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const originalSpawn = spawn.safeSpawn;
	spyOn(spawn, "safeSpawn").mockImplementation(async (options) => {
		if (options.cmd[0] === "git" && options.cmd[1] === "init" && options.cmd[2] === "--bare") {
			enter();
			await gate;
		}
		return originalSpawn(options);
	});
	const readClaims = mock(async () => {
		throw new Error("Shared admissions and cold capture must not query global inventory");
	});
	const capture = withLifecycleGuardPorts(
		{ canonicalPath: canonicalProtectionPath, readClaims },
		() => worktreeTreeSnapshot.capture(path),
	);
	void capture.catch(() => {});
	try {
		await Promise.race([
			entered,
			capture.then(() => {
				throw new Error("cold initializer was not entered");
			}),
		]);
		const child = await narratorService.createSubagent({
			parentNarratorId: narratorId,
			subagentOriginKind: "standalone",
			subagentType: "general",
			cwd: path,
		});
		otherNarrators.push(child.id);
		const ordinary = await narratorService.create({
			cwd: "/",
			title: "ordinary root cwd is not an exclusive cache claim",
		});
		otherNarrators.push(ordinary.id);
		const remoteId = generateId();
		otherNarrators.push(remoteId);
		await db.insert(narrators).values({
			id: remoteId,
			cwd: "/",
			defaultDeviceId: "remote-fixture",
			workspaceRevision: 1,
			workspaceContext: {
				revision: 1,
				deviceId: "remote-fixture",
				cwd: "/",
				pathFlavor: "posix",
				contextKey: "remote-root-fixture",
				capabilities: { switchDirectory: false },
			},
			title: "remote root must not become a local cache inventory barrier",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		});
		let remote = false;
		await withWorkspaceAdmission(
			{ deviceId: "remote-fixture", path: "/unrelated/remote" },
			async () => {
				remote = true;
			},
		);
		expect(remote).toBe(true);
	} finally {
		release();
	}
	expect(await capture).toMatch(/^[0-9a-f]{40,64}$/);
	expect(readClaims).not.toHaveBeenCalled();
});

test("a real zero-dispatch failed create keeps its v2 receipt without creating protection pins", async () => {
	const directory = getNarraforkPath("worktree-requests-v2");
	const journal = new FileWorktreeJournal(directory, getNarraforkPath("worktree-requests"));
	const requestId = "failed-create-lifecycle";
	const target: WorktreeTarget = {
		workspace: {
			deviceId: "local",
			cwd: temporary,
			rootPath: temporary,
			workspaceKey: "fixture",
			repositoryKey: "fixture-repository",
			state: "ready",
			capabilities: { read: true, write: true },
		},
		backend: new LocalBackend(),
		repositoryPath: join(temporary, ".git"),
	};
	const runGit = mock(async () => {
		throw new Error("invalid path must not dispatch Git");
	});
	const service = new NarratorWorktreeService<string>({
		authorize: async () => target,
		withRevision: async (_id, _revision, action) => action(),
		withRepositoryLock: async (_key, action) => action(),
		journal,
		resources: narratorWorktreeResourceRegistry,
		runGit,
	});
	const request = {
		expectedRevision: 0,
		workspaceKey: "fixture",
		requestId,
		destinationPath: ".worktrees/rejected-relative",
		branch: { kind: "new" as const, name: "fixture" },
	};
	const receipt = join(
		directory,
		`${createHash("sha256")
			.update(JSON.stringify([narratorId, requestId]))
			.digest("hex")}.json`,
	);
	try {
		const result = await service.create("actor", narratorId, request, new AbortController().signal);
		expect(result.outcome).toBe("failed");
		const record = await journal.read(narratorId, requestId);
		expect(record?.dispatchState).toBe("not_started");
		expect(worktreeReceiptHasResourceEffect(record)).toBe(false);
		await maintainProtectionIndex(performance.now() + 5000);
		expect(
			sqlite
				.query<{ count: number }, []>(
					"SELECT count(*) AS count FROM resource_protection_paths WHERE source = 'receipt'",
				)
				.get()?.count,
		).toBe(0);
		let checked = false;
		await withProtectionReservation(
			[{ path }],
			"actual target check after failed create",
			async () => {
				checked = true;
			},
		);
		expect(checked).toBe(true);
		await expect(
			service.create("actor", narratorId, request, new AbortController().signal),
		).rejects.toMatchObject({ code: "WORKTREE_RECOVERY_DENIED" });
		expect(runGit).not.toHaveBeenCalled();
		expect(await journal.read(narratorId, requestId)).toEqual(record);
	} finally {
		await rm(receipt, { force: true });
	}
});
