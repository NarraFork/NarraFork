import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { localBackend, setRemoteBackendResolver } from "../lib/agent/execution/registry";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";

const spawnModule = await import("../lib/spawn");
let repo = "";
let repository = "";
let gitCalls = 0;
mock.module("../lib/spawn", () => ({
	...spawnModule,
	safeSpawn: async () => {
		gitCalls++;
		return { exitCode: 0, stdout: `true\nfalse\n${repo}\n${repository}\n`, stderr: "" };
	},
}));
const { db } = await import("../db");
const { narrators, remoteDevices, users } = await import("../db/schema");
const { authorizeGitTargetForPrincipal } = await import("./git-workspace-access");
const { executionPolicyEngine } = await import("./execution-policy/engine");
const { activeNarrators } = await import("./narrator-session-state");
let root = "";
let owner = "";
let narratorId = "";
const now = () => new Date().toISOString();
const actor = () => ({ userId: owner, isAdmin: false });
const authorize = (need: "read" | "write" = "read", metadata = true) =>
	authorizeGitTargetForPrincipal(
		actor(),
		{ narratorId },
		need,
		new AbortController().signal,
		false,
		false,
		metadata,
	);

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "git-metadata-access-")));
	repo = join(root, "repo");
	repository = join(repo, ".git");
	await mkdir(join(repo, ".git"), { recursive: true });
	await writeFile(join(repo, ".git/HEAD"), "ref: refs/heads/main\n");
	owner = generateId();
	narratorId = generateId();
	await db
		.insert(users)
		.values({ id: owner, username: owner, passwordHash: "fixture", createdAt: now() });
	await db.insert(narrators).values({
		id: narratorId,
		title: "Metadata authorization",
		cwd: repo,
		ownerUserId: owner,
		visibility: "private",
		writeAudience: "owner",
		createdAt: now(),
		updatedAt: now(),
	});
	gitCalls = 0;
});
afterEach(async () => {
	activeNarrators.delete(narratorId);
	setRemoteBackendResolver(null);
	await rm(root, { recursive: true, force: true });
});
afterAll(() => mock.module("../lib/spawn", () => spawnModule));

test("ordinary discovery seeds metadata read/write/WS authorization with zero subsequent Git, beyond display TTL", async () => {
	const policy = spyOn(executionPolicyEngine, "compile");
	const ordinary = await authorize("read", false);
	expect(ordinary.workspace.state).toBe("ready");
	expect(gitCalls).toBe(1);
	gitCalls = 0;
	const clock = spyOn(Date, "now").mockImplementation(() => 9_000_000_000_000);
	try {
		for (const need of ["read", "write", "write"] as const) {
			const target = await authorize(need);
			expect(target.workspace.workspaceKey).toBe(ordinary.workspace.workspaceKey);
			expect(target.workspace.capabilities).toEqual({ read: true, write: true });
		}
		const ws = await authorizeGitTargetForPrincipal(
			actor(),
			{ narratorId },
			"read",
			new AbortController().signal,
			false,
			false,
			ordinary,
		);
		expect(ws.workspace.workspaceKey).toBe(ordinary.workspace.workspaceKey);
		expect(gitCalls).toBe(0);
		expect(policy.mock.calls.length).toBeGreaterThanOrEqual(5);
	} finally {
		clock.mockRestore();
		policy.mockRestore();
	}
});

test("ordinary index lock churn preserves directory identity, while same-path Git directory replacement rejects without Git", async () => {
	await authorize("read", false);
	gitCalls = 0;
	await writeFile(join(repo, ".git/index.lock"), "in-progress index");
	expect((await authorize("write")).workspace.state).toBe("ready");
	await rm(join(repo, ".git/index.lock"));
	expect((await authorize()).workspace.state).toBe("ready");
	await rename(join(repo, ".git"), join(repo, "old-git"));
	await mkdir(join(repo, ".git"));
	await writeFile(join(repo, ".git/HEAD"), "ref: refs/heads/main\n");
	await expect(authorize("write")).rejects.toMatchObject({ code: "GIT_WORKSPACE_CHANGED" });
	expect(gitCalls).toBe(0);
	// Only an ordinary, explicit target resolution can establish the replacement.
	await authorize("read", false);
	expect(gitCalls).toBe(1);
	gitCalls = 0;
	expect((await authorize()).workspace.state).toBe("ready");
	expect(gitCalls).toBe(0);
});

test("cwd revisions, ancestor repository markers and retargeted root symlinks cannot reuse a binding", async () => {
	await mkdir(join(repo, "sub"));
	await db
		.update(narrators)
		.set({ cwd: join(repo, "sub") })
		.where(eq(narrators.id, narratorId));
	await authorize("read", false);
	gitCalls = 0;
	await mkdir(join(repo, "sub/.git"));
	await expect(authorize()).rejects.toMatchObject({ code: "GIT_WORKSPACE_CHANGED" });
	await rm(join(repo, "sub/.git"), { recursive: true });
	await db.update(narrators).set({ workspaceRevision: 1 }).where(eq(narrators.id, narratorId));
	await expect(authorize()).rejects.toMatchObject({ code: "GIT_WORKSPACE_CHANGED" });
	expect(gitCalls).toBe(0);
	await authorize("read", false);
	gitCalls = 0;
	await rename(repo, join(root, "old-root"));
	await mkdir(join(root, "replacement/.git"), { recursive: true });
	await symlink(join(root, "replacement"), repo);
	await expect(authorize()).rejects.toMatchObject({ code: "GIT_WORKSPACE_CHANGED" });
	expect(gitCalls).toBe(0);
});

test("fresh ACL and compiled policy are never replaced by metadata discovery", async () => {
	await authorize("read", false);
	gitCalls = 0;
	const policy = spyOn(executionPolicyEngine, "compile").mockImplementation(async () => {
		throw new AppError("Policy revoked", 403, "GIT_WORKSPACE_ACCESS_DENIED");
	});
	try {
		await expect(authorize("write")).rejects.toMatchObject({ statusCode: 403 });
	} finally {
		policy.mockRestore();
	}
	const stranger = generateId();
	await db
		.insert(users)
		.values({ id: stranger, username: stranger, passwordHash: "fixture", createdAt: now() });
	await db.update(narrators).set({ ownerUserId: stranger }).where(eq(narrators.id, narratorId));
	await expect(authorize()).rejects.toMatchObject({ statusCode: 404 });
	expect(gitCalls).toBe(0);
});

test("gitfile pointer replacement and bounded-read overflow fail closed without a discovery fallback", async () => {
	const gitDir = join(root, "linked-git");
	await rename(join(repo, ".git"), gitDir);
	await writeFile(join(repo, ".git"), `gitdir: ${gitDir}\n`);
	await writeFile(join(gitDir, "gitdir"), `${join(repo, ".git")}\n`);
	await writeFile(join(gitDir, "commondir"), `${join(repo, "common")}\n`);
	await mkdir(join(repo, "common"));
	repository = join(repo, "common");
	await authorize("read", false);
	gitCalls = 0;
	expect((await authorize()).workspace.state).toBe("ready");
	await writeFile(join(gitDir, "gitdir"), `${join(root, "wrong/.git")}\n`);
	await expect(authorize()).rejects.toMatchObject({ code: "GIT_WORKSPACE_CHANGED" });
	await writeFile(join(gitDir, "gitdir"), `${join(repo, ".git")}\n`);
	expect((await authorize()).workspace.state).toBe("ready");
	await writeFile(join(repo, ".git"), "gitdir: elsewhere\n");
	await expect(authorize()).rejects.toMatchObject({ code: "GIT_WORKSPACE_CHANGED" });
	await writeFile(join(repo, ".git"), "x".repeat(4097));
	await expect(authorize()).rejects.toMatchObject({ code: "GIT_WORKSPACE_CHANGED" });
	expect(gitCalls).toBe(0);
});

test("remote targets retain live ordinary discovery and device authorization", async () => {
	const deviceId = generateId();
	await db.insert(remoteDevices).values({
		id: deviceId,
		name: "Remote",
		slug: deviceId,
		tokenHash: deviceId,
		tokenPrefix: "fixture",
		createdBy: owner,
		scope: "global",
		ownerScope: "private",
		createdAt: now(),
		updatedAt: now(),
	});
	await db.update(narrators).set({ defaultDeviceId: deviceId }).where(eq(narrators.id, narratorId));
	let probes = 0;
	const remote = {
		deviceId,
		kind: "remote" as const,
		paths: localBackend.paths,
		pathFlavor: localBackend.pathFlavor,
		runtimeGeneration: 1,
		defaultCwd: repo,
		supportsGitWorkspace: true,
		supportsFsStatResolvedPath: true,
		statFile: localBackend.statFile.bind(localBackend),
		readFileBytes: localBackend.readFileBytes.bind(localBackend),
		resolvePathIdentity: localBackend.resolvePathIdentity.bind(localBackend),
		gitWorkspace: async () => {
			probes++;
			return { state: "ready", rootPath: repo, repositoryPath: join(repo, ".git") };
		},
	} as unknown as ExecutionBackend;
	setRemoteBackendResolver(() => remote);
	const ordinary = await authorize("read", false);
	expect(ordinary.workspace.state).toBe("ready");
	expect(probes).toBe(1);
	for (const need of ["read", "write"] as const)
		expect((await authorize(need)).workspace.state).toBe("ready");
	expect(probes).toBe(3);
	Object.assign(remote, { runtimeGeneration: 2 });
	const refreshed = await authorize();
	expect(refreshed.discoveryRuntimeGeneration).toBe(2);
	expect(probes).toBe(4);
	await db.update(remoteDevices).set({ revokedAt: now() }).where(eq(remoteDevices.id, deviceId));
	await expect(authorize()).rejects.toMatchObject({ statusCode: 403 });
	expect(probes).toBe(4);
	expect(gitCalls).toBe(0);
});

test("remote ChangeLists report unsupported while ordinary authorization stays available", async () => {
	const deviceId = generateId();
	await db.insert(remoteDevices).values({
		id: deviceId,
		name: "Legacy remote",
		slug: deviceId,
		tokenHash: deviceId,
		tokenPrefix: "fixture",
		createdBy: owner,
		scope: "global",
		ownerScope: "private",
		createdAt: now(),
		updatedAt: now(),
	});
	await db.update(narrators).set({ defaultDeviceId: deviceId }).where(eq(narrators.id, narratorId));
	let probes = 0;
	const remote = {
		deviceId,
		kind: "remote" as const,
		paths: localBackend.paths,
		pathFlavor: localBackend.pathFlavor,
		runtimeGeneration: 1,
		defaultCwd: repo,
		supportsGitWorkspace: true,
		statFile: async () => {
			throw new Error("Legacy canonical stat is unavailable");
		},
		gitWorkspace: async () => {
			probes++;
			return { state: "ready", rootPath: repo, repositoryPath: join(repo, ".git") };
		},
	} as unknown as ExecutionBackend;
	setRemoteBackendResolver(() => remote);
	expect((await authorize("read", false)).workspace.state).toBe("ready");
	expect((await authorize()).workspace.state).toBe("ready");
	expect((await authorize("write")).workspace.capabilities.write).toBe(true);
	const { getGitStagingListsService } = await import("./git-staging-lists-service");
	const service = await getGitStagingListsService(await authorize("read", false), "owner");
	expect((await service.summary()).capability.supported).toBe(false);
	expect(probes).toBe(4);
});

test("the bounded metadata binding capacity preserves existing targets and refuses uncached metadata without Git", async () => {
	const first = narratorId;
	await authorize("read", false);
	const extraIds = Array.from({ length: 129 }, () => generateId());
	await db.insert(narrators).values(
		extraIds.map((id) => ({
			id,
			title: "Capacity target",
			cwd: repo,
			ownerUserId: owner,
			visibility: "private" as const,
			writeAudience: "owner" as const,
			createdAt: now(),
			updatedAt: now(),
		})),
	);
	const { resolveNarratorGitTarget } = await import("./git-workspace");
	for (const id of extraIds) await resolveNarratorGitTarget(id, new AbortController().signal);
	gitCalls = 0;
	narratorId = first;
	expect((await authorize()).workspace.state).toBe("ready");
	narratorId = extraIds.at(-1) ?? first;
	await expect(authorize()).rejects.toMatchObject({ code: "GIT_WORKSPACE_CHANGED" });
	expect(gitCalls).toBe(0);
}, 30_000);
