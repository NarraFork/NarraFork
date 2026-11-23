import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { localBackend, setRemoteBackendResolver } from "../lib/agent/execution/registry";
import { AppError } from "../lib/errors";
import { generateId } from "../lib/id";
import { captureWorkerRejection } from "./__tests__/narrator-worker-fixture";

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
const workerPool = await import("../lib/db-worker/pool");
const originalWorkerRead = workerPool.runReadTask;
let interceptRead: typeof originalWorkerRead | undefined;
const workerReads = spyOn(workerPool, "runReadTask").mockImplementation(
	<T>(
		path: string,
		params: Parameters<typeof originalWorkerRead>[1],
		options: Parameters<typeof originalWorkerRead>[2],
	): Promise<T> =>
		interceptRead
			? interceptRead<T>(path, params, options)
			: originalWorkerRead<T>(path, params, options),
);
const { aclGrants, narrators, projects, remoteDevices, users } = await import("../db/schema");
const { authorizeGitTargetForPrincipal } = await import("./git-workspace-access");
const { GitAccessScan } = await import("./git-workspace-access-scan");
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
	workerReads.mockClear();
	interceptRead = undefined;
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
	interceptRead = undefined;
	activeNarrators.delete(narratorId);
	setRemoteBackendResolver(null);
	await rm(root, { recursive: true, force: true });
});
afterAll(() => {
	workerReads.mockRestore();
	mock.module("../lib/spawn", () => spawnModule);
});

test("SQLite authorization reads share one total deadline and successful targets retain request path authorization", async () => {
	const request = new AbortController();
	const reads = workerReads;
	const start = Date.now();
	try {
		const target = await authorizeGitTargetForPrincipal(
			actor(),
			{ narratorId },
			"read",
			request.signal,
		);
		expect(target.workspace.state).toBe("ready");
		const options = reads.mock.calls.map(([, , options]) => options);
		expect(options.length).toBeGreaterThan(3);
		const firstDeadline = options[0]?.deadlineAt;
		expect(firstDeadline).toBeGreaterThanOrEqual(start + 30_000);
		expect(firstDeadline).toBeLessThanOrEqual(Date.now() + 30_000);
		for (const option of options) {
			expect(option?.signal).toBeDefined();
			expect(option?.deadlineAt).toBeGreaterThan(start);
			expect(option?.deadlineAt).toBeLessThanOrEqual(firstDeadline as number);
			expect(option?.timeoutMs).toBeLessThanOrEqual(30_000);
		}
		const initial = options.filter(
			(option) => !option?.diagnosticSource?.startsWith("git-workspace-access."),
		);
		expect(new Set(initial.map((option) => option?.deadlineAt)).size).toBe(1);
		expect(initial[0]?.signal?.aborted).toBe(false);
		const sqlReads = reads.mock.calls.filter(
			([, params]) => params.kind === "selectRows" && params.sql.includes('from "narrators"'),
		);
		expect(sqlReads).toHaveLength(1);
		expect(typeof target.authorizeFilePaths).toBe("function");
		if (!target.authorizeFilePaths) throw new Error("Missing path authorizer");
		await target.authorizeFilePaths(["src/file.ts"], "read");
		await target.authorizeFilePaths(["src/file.ts"], "write");
		request.abort(new Error("request ended"));
		expect(
			await target.authorizeFilePaths(["src/file.ts"], "read").catch((error: unknown) => error),
		).toMatchObject({ message: "request ended" });
	} finally {
		interceptRead = undefined;
	}
});

test("private project grants use budgeted worker reads and revocation reauthorizes before discovery", async () => {
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Protected checkout",
		gitPath: repo,
		ownerUserId: null,
		visibility: "private",
		createdAt: now(),
		updatedAt: now(),
	});
	await db
		.update(narrators)
		.set({ contextProjectId: projectId })
		.where(eq(narrators.id, narratorId));
	const grantId = generateId();
	await db.insert(aclGrants).values({
		id: grantId,
		principalType: "user",
		principalId: owner,
		scopeType: "project",
		scopeId: projectId,
		capability: "write",
		createdAt: now(),
	});
	const reads = workerReads;
	try {
		const target = await authorize("write", false);
		expect(target.workspace.capabilities.write).toBe(true);
		const grants = reads.mock.calls.filter(
			([, params]) => params.kind === "selectRows" && params.sql.includes('from "acl_grants"'),
		);
		expect(grants.length).toBeGreaterThan(0);
		for (const [, , options] of grants) {
			expect(options?.signal).toBeDefined();
			expect(options?.deadlineAt).toBeDefined();
		}
		await db.delete(aclGrants).where(eq(aclGrants.id, grantId));
		const probes = gitCalls;
		expect(await authorize("write").catch((error: unknown) => error)).toMatchObject({
			statusCode: 404,
		});
		expect(gitCalls).toBe(probes);
	} finally {
		interceptRead = undefined;
		await db.update(narrators).set({ contextProjectId: null }).where(eq(narrators.id, narratorId));
		await db.delete(projects).where(eq(projects.id, projectId));
	}
});

for (const phase of ["narrator", "grants", "oauth", "policy"] as const) {
	for (const failure of ["cancel", "deadline"] as const) {
		test(`${phase} SQLite reads receive the authorization signal and cancel on ${failure}`, async () => {
			if (phase === "grants") {
				await db.update(narrators).set({ ownerUserId: null }).where(eq(narrators.id, narratorId));
				await db.insert(aclGrants).values({
					id: generateId(),
					principalType: "user",
					principalId: owner,
					scopeType: "narrator",
					scopeId: narratorId,
					capability: "write",
					createdAt: now(),
				});
			}
			const request = new AbortController();
			const scopes = spyOn(GitAccessScan.prototype, "readOptions");
			const originalRead = originalWorkerRead;
			let actual: Parameters<typeof originalRead>[2];
			let cancelled: Promise<unknown> | undefined;
			let readsAfterCancellation = 0;
			let started = false;
			interceptRead = <T>(
				path: string,
				params: Parameters<typeof originalRead>[1],
				options: Parameters<typeof originalRead>[2],
			): Promise<T> => {
				if (started) readsAfterCancellation++;
				const match =
					phase === "policy"
						? params.kind === "executionPolicyFacts"
						: params.kind === "selectRows" &&
							params.sql.includes(
								phase === "grants"
									? 'from "acl_grants"'
									: phase === "oauth"
										? 'from "integration_resource_bindings"'
										: 'from "narrators"',
							);
				if (!match || started) return originalRead<T>(path, params, options);
				started = true;
				actual = options;
				const work = originalRead<T>(
					path,
					{
						kind: "selectRows",
						sql: "WITH RECURSIVE slow(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM slow WHERE n < 1000000) SELECT sum(n) FROM slow",
						params: [],
						maxRows: 1,
					},
					options,
				);
				cancelled = work.catch((error: unknown) => error);
				setTimeout(() => {
					if (failure === "cancel") request.abort(new Error("caller cancelled authorization"));
					else {
						const scope = scopes.mock.contexts[0] as InstanceType<typeof GitAccessScan>;
						const clock = spyOn(performance, "now").mockReturnValue(scope.started + 30_000);
						try {
							scope.check();
						} catch {
							// The scope rejects its waiter and cancels the actual worker signal.
						} finally {
							clock.mockRestore();
						}
					}
				}, 20);
				return work;
			};
			try {
				const error = await authorizeGitTargetForPrincipal(
					actor(),
					{ narratorId },
					"read",
					request.signal,
				).catch((error: unknown) => error);
				expect(started).toBe(true);
				expect(actual?.signal?.aborted).toBe(true);
				expect(actual?.deadlineAt).toBeDefined();
				expect(actual?.timeoutMs).toBeLessThanOrEqual(30_000);
				expect(error).toMatchObject({
					statusCode: 503,
					code: "GIT_WORKSPACE_ACCESS_CHECK_UNAVAILABLE",
				});
				expect(await cancelled).toMatchObject({ code: "DB_READ_ABORTED" });
				expect(readsAfterCancellation).toBe(0);
			} finally {
				request.abort();
				await cancelled;
				interceptRead = undefined;
				scopes.mockRestore();
			}
		});
	}
}

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
	await expect(await captureWorkerRejection(authorize("write"))).toMatchObject({
		code: "GIT_WORKSPACE_CHANGED",
	});
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
	await expect(await captureWorkerRejection(authorize())).toMatchObject({
		code: "GIT_WORKSPACE_CHANGED",
	});
	await rm(join(repo, "sub/.git"), { recursive: true });
	await db.update(narrators).set({ workspaceRevision: 1 }).where(eq(narrators.id, narratorId));
	await expect(await captureWorkerRejection(authorize())).toMatchObject({
		code: "GIT_WORKSPACE_CHANGED",
	});
	expect(gitCalls).toBe(0);
	await authorize("read", false);
	gitCalls = 0;
	await rename(repo, join(root, "old-root"));
	await mkdir(join(root, "replacement/.git"), { recursive: true });
	await symlink(join(root, "replacement"), repo);
	await expect(await captureWorkerRejection(authorize())).toMatchObject({
		code: "GIT_WORKSPACE_CHANGED",
	});
	expect(gitCalls).toBe(0);
});

test("fresh ACL and compiled policy are never replaced by metadata discovery", async () => {
	await authorize("read", false);
	gitCalls = 0;
	const policy = spyOn(executionPolicyEngine, "compile").mockImplementation(async () => {
		throw new AppError("Policy revoked", 403, "GIT_WORKSPACE_ACCESS_DENIED");
	});
	try {
		await expect(await captureWorkerRejection(authorize("write"))).toMatchObject({
			statusCode: 403,
		});
	} finally {
		policy.mockRestore();
	}
	const stranger = generateId();
	await db
		.insert(users)
		.values({ id: stranger, username: stranger, passwordHash: "fixture", createdAt: now() });
	await db.update(narrators).set({ ownerUserId: stranger }).where(eq(narrators.id, narratorId));
	await expect(await captureWorkerRejection(authorize())).toMatchObject({ statusCode: 404 });
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
	await expect(await captureWorkerRejection(authorize())).toMatchObject({
		code: "GIT_WORKSPACE_CHANGED",
	});
	await writeFile(join(gitDir, "gitdir"), `${join(repo, ".git")}\n`);
	expect((await authorize()).workspace.state).toBe("ready");
	await writeFile(join(repo, ".git"), "gitdir: elsewhere\n");
	await expect(await captureWorkerRejection(authorize())).toMatchObject({
		code: "GIT_WORKSPACE_CHANGED",
	});
	await writeFile(join(repo, ".git"), "x".repeat(4097));
	await expect(await captureWorkerRejection(authorize())).toMatchObject({
		code: "GIT_WORKSPACE_CHANGED",
	});
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
	await expect(await captureWorkerRejection(authorize())).toMatchObject({ statusCode: 403 });
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
	await expect(await captureWorkerRejection(authorize())).toMatchObject({
		code: "GIT_WORKSPACE_CHANGED",
	});
	expect(gitCalls).toBe(0);
}, 30_000);
