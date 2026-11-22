import { expect, mock, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { toErrorPayload } from "../../lib/app-error-response";
import * as compiledWorkerModule from "../../lib/compiled-worker";
import { AppError } from "../../lib/errors";
import { ChangelistStore } from "../git-changelist-store";
import { resolveGitStagingRepository } from "../git-staging-kernel";
import {
	createGitStagingListsService,
	executeGitStagingWork,
	type GitStagingChange,
	getGitStagingListsService,
	isGitStagingListWriting,
} from "../git-staging-lists-service";
import {
	dirtyGitStagingObservation,
	gitStagingObservationState,
	settleGitStagingObservations,
} from "../git-staging-observation";
import type { GitStagingWork } from "../git-staging-worker";
import type { GitWorkspaceTarget } from "../git-workspace";

const version = { expectedGeneration: 2, observationId: "observation" };
const applied = {
	outcome: "applied" as const,
	listId: "B",
	generation: 3,
	observationId: "observation",
	affectedListIds: ["A", "B"],
};
const move = {
	...version,
	action: "move" as const,
	fromListId: "A",
	toListId: "B",
	unitIds: ["file:unit:opaque"],
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const exec = promisify(execFile);
async function workerFixture(separate = false) {
	const directory = await mkdtemp(join(tmpdir(), "nf-staging-retries-"));
	const root = join(directory, "repository"),
		metadata = join(directory, "metadata");
	await mkdir(root);
	const env: Record<string, string | undefined> = {
		...process.env,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.test",
		GIT_COMMITTER_NAME: "Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.test",
	};
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_COMMON_DIR",
		"GIT_CONFIG_COUNT",
		"GIT_CONFIG_PARAMETERS",
	])
		delete env[key];
	const git = async (...args: string[]) =>
		(
			await exec("git", args, { cwd: root, env, timeout: 15_000, maxBuffer: 1_048_576 })
		).stdout.trimEnd();
	await git(
		"init",
		"--quiet",
		"--initial-branch=main",
		...(separate ? ["--separate-git-dir", metadata] : []),
	);
	await git("config", "user.name", "Fixture");
	await git("config", "user.email", "fixture@example.test");
	await git("config", "commit.gpgSign", "false");
	await writeFile(join(root, "tracked"), "base\n");
	await git("add", ".");
	await git("commit", "--quiet", "-m", "Base");
	await writeFile(join(root, "tracked"), "owned\n");
	const base = { cwd: root, workspaceKey: root };
	await executeGitStagingWork({ ...base, method: "action", request: { action: "init" } });
	const repo = await resolveGitStagingRepository(root);
	return { directory, root, repo, base, git };
}

test("real Worker retries exhaust once across service and coordinator without changing HTTP errors", async () => {
	const { directory, root, repo, git } = await workerFixture();
	try {
		const beforeStore = await ChangelistStore.open(repo);
		if (!beforeStore) throw new Error("Missing fixture store");
		const before = beforeStore.state(),
			previous = beforeStore.fileIds();
		beforeStore.close();
		const native = await readFile(repo.index),
			head = await git("rev-parse", "HEAD");
		await writeFile(join(repo.gitDir, "info", "attributes"), "tracked filter=racing\n");
		await git(
			"config",
			"filter.racing.clean",
			'cat; case "$GIT_INDEX_FILE" in *observe-*) printf x >> tracked; printf x >> .git/scan-attempts ;; esac',
		);
		await writeFile(join(root, "tracked"), "new owned\n");
		let dispatches = 0;
		const service = createGitStagingListsService(
			{
				rootPath: root,
				workspaceKey: root,
				beforeWrite: async () => {},
				authorizePaths: async () => {},
			},
			{
				execute: async <T>(request: GitStagingWork, signal?: AbortSignal) => {
					if (request.method === "action" && request.request.action === "sync") dispatches++;
					return executeGitStagingWork<T>(request, signal);
				},
			},
		);
		let caught: unknown;
		try {
			await service.action({ action: "sync" });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AppError);
		if (!(caught instanceof AppError)) throw new Error("Expected Worker application error");
		expect(caught).toMatchObject({
			code: "GIT_STAGING_CONCURRENT_CHANGE",
			statusCode: 409,
			observationRetriesExhausted: true,
		});
		expect(toErrorPayload(caught)).toEqual({
			error: "Working files changed before observation publication",
			code: "GIT_STAGING_CONCURRENT_CHANGE",
		});
		expect(Object.keys(caught)).not.toContain("observationRetriesExhausted");
		expect(dispatches).toBe(1);
		expect(await readFile(join(repo.gitDir, "scan-attempts"), "utf8")).toBe("xxx");
		const afterStore = await ChangelistStore.open(repo);
		if (!afterStore) throw new Error("Missing fixture store");
		try {
			expect(afterStore.state()).toMatchObject({
				state: "incomplete",
				observation_id: before.observation_id,
				generation: before.generation,
			});
			expect(afterStore.fileIds()).toEqual(previous);
			expect(
				afterStore.db.query("SELECT count(*) n FROM observations WHERE complete=0").get(),
			).toEqual({ n: 3 });
		} finally {
			afterStore.close();
		}
		expect(await readFile(repo.index)).toEqual(native);
		expect(await git("rev-parse", "HEAD")).toBe(head);
	} finally {
		await settleGitStagingObservations(root);
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);

test("real Worker Git-dir pointer read changes remain unmarked and retry before scanning", async () => {
	const { directory, root, repo, git } = await workerFixture(true);
	const pointer = join(root, ".git"),
		counter = join(directory, "pointer-retries");
	const bootstrap = join(directory, "pointer-worker.ts");
	await writeFile(
		bootstrap,
		`import { open, readFile, writeFile } from "node:fs/promises";
const pointer = ${JSON.stringify(pointer)}, counter = ${JSON.stringify(counter)};
const previous = Number(await readFile(counter, "utf8").catch(() => "0"));
if (previous < 2) {
 const probe = await open(pointer, "r"), prototype = Object.getPrototypeOf(probe), stat = prototype.stat;
 await probe.close();
 let checks = 0;
 prototype.stat = async function(...args) {
  if (++checks === 2) { const bytes = await readFile(pointer); await writeFile(pointer, Buffer.concat([bytes, Buffer.from("\\n")])); await writeFile(counter, String(previous + 1)); }
  return Reflect.apply(stat, this, args);
 };
}
await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../git-staging-worker.ts")).href)});
`,
	);
	const connect = compiledWorkerModule.connectCompiledWorker;
	const factory = spyOn(compiledWorkerModule, "connectCompiledWorker").mockImplementation(
		async (_specifiers, options) => connect([pathToFileURL(bootstrap).href], options),
	);
	try {
		const native = await readFile(repo.index),
			head = await git("rev-parse", "HEAD");
		const errors: unknown[] = [];
		let prepares = 0,
			dispatches = 0;
		const service = createGitStagingListsService(
			{
				rootPath: root,
				workspaceKey: root,
				beforeWrite: async () => {},
				authorizePaths: async () => {},
			},
			{
				execute: async <T>(request: GitStagingWork, signal?: AbortSignal) => {
					if (request.method === "actionPaths") prepares++;
					if (request.method === "action") dispatches++;
					try {
						return await executeGitStagingWork<T>(request, signal);
					} catch (error) {
						errors.push(error);
						throw error;
					}
				},
			},
		);
		expect(await service.action({ action: "sync" })).toMatchObject({ outcome: "applied" });
		expect(prepares).toBe(3);
		expect(dispatches).toBe(1);
		expect(errors).toHaveLength(2);
		for (const error of errors) {
			expect(error).toBeInstanceOf(AppError);
			expect(error).toMatchObject({ code: "GIT_STAGING_CONCURRENT_CHANGE" });
			expect("observationRetriesExhausted" in (error as AppError)).toBe(false);
		}
		expect(await readFile(counter, "utf8")).toBe("2");
		expect(await readFile(repo.index)).toEqual(native);
		expect(await git("rev-parse", "HEAD")).toBe(head);
	} finally {
		factory.mockRestore();
		await settleGitStagingObservations(root);
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);

test("complete backend-resolved scope is authorized before a CAS write", async () => {
	const requests: GitStagingWork[] = [];
	const authorizePaths = mock(async (_paths: string[]) => {});
	const beforeWrite = mock(async () => {});
	const changed = mock((_event: GitStagingChange) => {});
	const service = createGitStagingListsService(
		{ workspaceKey: "workspace", rootPath: "/authorized-root", beforeWrite, authorizePaths },
		{
			execute: async <T>(request: GitStagingWork) => {
				requests.push(request);
				if (request.method === "actionPaths")
					return ["loaded.txt", "not-loaded/secret.txt", "old-name.txt"] as T;
				expect(authorizePaths).toHaveBeenCalledWith([
					"loaded.txt",
					"not-loaded/secret.txt",
					"old-name.txt",
				]);
				return applied as T;
			},
			changed,
		},
	);
	expect(await service.action(move)).toEqual(applied);
	expect(requests.map((r) => r.method)).toEqual(["actionPaths", "action"]);
	expect(
		requests.every(
			(r) =>
				(r.method === "actionPaths" || r.method === "action") &&
				"expectedGeneration" in r.request &&
				r.request.expectedGeneration === 2,
		),
	).toBe(true);
	expect(beforeWrite).toHaveBeenCalledTimes(2);
	expect(changed).toHaveBeenCalledWith({
		workspaceKey: "workspace",
		metadataChanged: true,
		generation: 3,
		observationId: "observation",
		affectedListIds: ["A", "B"],
	});
});

test("authorization denial cannot reach the action Worker or publish an event", async () => {
	const methods: string[] = [];
	const changed = mock((_event: GitStagingChange) => {});
	const service = createGitStagingListsService(
		{
			workspaceKey: "denied",
			rootPath: "/denied-root",
			beforeWrite: async () => {},
			authorizePaths: async () => {
				throw new Error("denied hidden path");
			},
		},
		{
			execute: async <T>(request: GitStagingWork) => {
				methods.push(request.method);
				return ["hidden"] as T;
			},
			changed,
		},
	);
	await expect(service.action(move)).rejects.toThrow("denied hidden path");
	expect(methods).toEqual(["actionPaths"]);
	expect(changed).not.toHaveBeenCalled();
});

test("file pages and diff units authorize stored source paths before returning SQLite content", async () => {
	const authorizeReadPaths = mock(async (paths: string[]) => {
		if (paths.includes("private/old.txt")) throw new Error("denied stored path");
	});
	const service = createGitStagingListsService(
		{
			workspaceKey: "read-policy",
			rootPath: "/read-policy",
			beforeWrite: async () => {},
			authorizeReadPaths,
		},
		{
			execute: async <T>(request: GitStagingWork) =>
				(request.method === "files"
					? { files: [{ path: "visible.txt", oldPath: "private/old.txt" }] }
					: {
							path: "visible.txt",
							units: [{ path: "visible.txt", oldPath: "private/old.txt" }],
						}) as T,
		},
	);
	await expect(service.files("A")).rejects.toThrow("denied stored path");
	await expect(service.diff("A", { path: "visible.txt" })).rejects.toThrow("denied stored path");
	expect(authorizeReadPaths).toHaveBeenCalledTimes(2);
});

test("every list write serializes on its worktree while another worktree can proceed", async () => {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const entered: string[] = [];
	const make = (root: string) =>
		createGitStagingListsService(
			{ workspaceKey: root, rootPath: root, beforeWrite: async () => {} },
			{
				execute: async <T>(request: GitStagingWork) => {
					if (request.method !== "action" || request.request.action !== "rename")
						throw new Error("Unexpected work");
					entered.push(`${root}:${request.request.listId}`);
					if (root === "/worktree" && request.request.listId === "A") await held;
					return applied as T;
				},
			},
		);
	const service = make("/worktree");
	const first = service.action({ ...version, action: "rename", listId: "A", name: "first" });
	await tick();
	const second = service.action({ ...version, action: "rename", listId: "B", name: "second" });
	await make("/other-worktree").action({
		...version,
		action: "rename",
		listId: "C",
		name: "other",
	});
	expect(entered).toEqual(["/worktree:A", "/other-worktree:C"]);
	release();
	await Promise.all([first, second]);
	expect(entered).toEqual(["/worktree:A", "/other-worktree:C", "/worktree:B"]);
});

test("create uses server-generated IDs and all-list write markers clear after failures", async () => {
	const ids: string[] = [];
	let fail = false;
	const service = createGitStagingListsService(
		{ workspaceKey: "markers", rootPath: "/markers", beforeWrite: async () => {} },
		{
			execute: async <T>(request: GitStagingWork) => {
				expect(isGitStagingListWriting("markers", "any-list")).toBe(true);
				if (request.method !== "action" || request.request.action !== "create")
					throw new Error("Unexpected request");
				if (!request.request.listId) throw new Error("Missing server ID");
				ids.push(request.request.listId);
				if (fail) throw new Error("injected failure");
				return { ...applied, listId: request.request.listId } as T;
			},
			changed: () => {
				expect(isGitStagingListWriting("markers")).toBe(true);
			},
		},
	);
	await service.action({ ...version, action: "create", name: "first" });
	await service.action({ ...version, action: "create", name: "second" });
	expect(ids[0]).not.toBe(ids[1]);
	fail = true;
	await expect(service.action({ ...version, action: "create", name: "third" })).rejects.toThrow(
		"injected",
	);
	expect(isGitStagingListWriting("markers")).toBe(false);
});

test("unknown commit outcome is never retried or announced as applied", async () => {
	const changed = mock((_event: GitStagingChange) => {});
	const execute = mock(async (): Promise<never> => {
		throw new Error("Commit result unknown");
	});
	const service = createGitStagingListsService(
		{ workspaceKey: "unknown", rootPath: "/unknown", beforeWrite: async () => {} },
		{ execute, changed },
	);
	await expect(
		service.action({ ...version, action: "commit", listId: "A", message: "commit" }),
	).rejects.toThrow("unknown");
	expect(execute).toHaveBeenCalledTimes(1);
	expect(changed).not.toHaveBeenCalled();
});

test("reads are explicit and never trigger synchronization or write authorization", async () => {
	const methods: string[] = [];
	const beforeWrite = mock(async () => {});
	const service = createGitStagingListsService(
		{ workspaceKey: "reads", rootPath: "/reads", beforeWrite },
		{
			execute: async <T>(request: GitStagingWork) => {
				methods.push(request.method);
				return {} as T;
			},
		},
	);
	await service.summary();
	await service.files("A");
	await service.diff("A", { path: "file" });
	expect(methods).toEqual(["summary", "files", "diff"]);
	expect(beforeWrite).not.toHaveBeenCalled();
});

test("manual observation reads a lightweight baseline only after fresh complete-path authorization", async () => {
	const order: string[] = [];
	const paths = ["f", "hidden/old"];
	const service = createGitStagingListsService(
		{
			workspaceKey: "baseline-order",
			rootPath: "/baseline-order",
			beforeWrite: async () => {
				order.push("beforeWrite");
			},
			authorizePaths: async (authorized) => {
				expect(authorized).toBe(paths);
				order.push("authorizePaths");
			},
		},
		{
			execute: async <T>(request: GitStagingWork) => {
				order.push(request.method);
				if (request.method === "actionPaths") return paths as T;
				if (request.method === "baseline")
					return {
						initialized: true,
						generation: 2,
						observationId: "observation",
						state: "ready",
					} as T;
				expect(request.method).toBe("action");
				if (request.method !== "action") throw new Error("Unexpected full read during prepare");
				expect(request.request.authorizedPaths).toBe(paths);
				return { ...applied, generation: 2, affectedListIds: [] } as T;
			},
		},
	);
	await service.action({ action: "sync" });
	expect(order).toEqual([
		"beforeWrite",
		"actionPaths",
		"authorizePaths",
		"baseline",
		"beforeWrite",
		"authorizePaths",
		"action",
	]);
});

for (const changedBaseline of [false, true])
	test(`each refresh subject keeps its own authorized paths and baseline (changed=${changedBaseline})`, async () => {
		const identity = {
			workspaceKey: `baseline-subjects-${changedBaseline}`,
			rootPath: `/baseline-subjects-${changedBaseline}`,
		};
		const paths = [
			["f", "hidden/old"],
			["f", "hidden/old"],
		];
		const reads = [0, 0],
			baselines = [0, 0],
			permissions = [0, 0];
		let scans = 0;
		const make = (subject: number) =>
			createGitStagingListsService(
				{
					...identity,
					authorizationKey: "same-principal:narrator",
					beforeWrite: async () => {},
					authorizePaths: async (authorized) => {
						expect(authorized).toBe(paths[subject]);
						permissions[subject]++;
					},
				},
				{
					execute: async <T>(request: GitStagingWork) => {
						if (request.method === "actionPaths") {
							reads[subject]++;
							return paths[subject] as T;
						}
						if (request.method === "baseline") {
							baselines[subject]++;
							return {
								initialized: true,
								generation: changedBaseline ? subject + 2 : 2,
								observationId: "observation",
								state: "ready",
							} as T;
						}
						expect(request.method).toBe("action");
						if (request.method !== "action") throw new Error("Unexpected full read during prepare");
						expect(request.request.authorizedPaths).toBe(paths[subject]);
						scans++;
						return { ...applied, generation: 2 } as T;
					},
				},
			);
		await Promise.all([make(0).action({ action: "sync" }), make(1).action({ action: "sync" })]);
		const preparations = changedBaseline ? [1, 2] : [1, 1];
		expect(reads).toEqual(preparations);
		expect(baselines).toEqual(preparations);
		expect(permissions.every((count) => count >= 1)).toBe(true);
		expect(scans).toBe(changedBaseline ? 2 : 1);
	});

for (const failure of ["paths", "baseline", "revalidate"] as const)
	test(`observation ${failure} failure never reaches the scan Worker`, async () => {
		const methods: string[] = [];
		let writes = 0;
		const error = new AppError(
			"injected failure",
			409,
			failure === "baseline" ? "GIT_STAGING_STORAGE_INVALID" : "FORBIDDEN",
		);
		const service = createGitStagingListsService(
			{
				workspaceKey: `baseline-failure-${failure}`,
				rootPath: `/baseline-failure-${failure}`,
				beforeWrite: async () => {
					if (++writes === 2 && failure === "revalidate") throw error;
				},
				authorizePaths: async () => {
					if (failure === "paths") throw error;
				},
			},
			{
				execute: async <T>(request: GitStagingWork) => {
					methods.push(request.method);
					if (request.method === "actionPaths") return ["f"] as T;
					if (request.method === "baseline") {
						if (failure === "baseline") throw error;
						return {
							initialized: true,
							generation: 2,
							observationId: "observation",
							state: "ready",
						} as T;
					}
					throw new Error("Unexpected scan/full summary");
				},
			},
		);
		await expect(service.action({ action: "sync" })).rejects.toBe(error);
		expect(methods).toEqual(failure === "paths" ? ["actionPaths"] : ["actionPaths", "baseline"]);
	});

test("cancelling a baseline read cannot dispatch a scan or fall back to summary", async () => {
	const controller = new AbortController();
	const methods: string[] = [];
	const service = createGitStagingListsService(
		{
			workspaceKey: "baseline-cancel",
			rootPath: "/baseline-cancel",
			signal: controller.signal,
			beforeWrite: async () => {},
			authorizePaths: async () => {},
		},
		{
			execute: async <T>(request: GitStagingWork, signal?: AbortSignal) => {
				methods.push(request.method);
				if (request.method === "actionPaths") return ["f"] as T;
				if (request.method === "baseline") {
					controller.abort(new Error("baseline cancelled"));
					signal?.throwIfAborted();
				}
				throw new Error("Unexpected scan/full summary");
			},
		},
	);
	await expect(service.action({ action: "sync" })).rejects.toThrow("baseline cancelled");
	await settleGitStagingObservations("baseline-cancel");
	expect(methods).toEqual(["actionPaths", "baseline"]);
});

test("an unobserved background workspace reads baseline without scanning or constructing summary", async () => {
	const identity = { workspaceKey: "baseline-uninitialized", rootPath: "/baseline-uninitialized" };
	const methods: string[] = [];
	const service = createGitStagingListsService(
		{ ...identity, beforeWrite: async () => {}, authorizePaths: async () => {} },
		{
			execute: async <T>(request: GitStagingWork) => {
				methods.push(request.method);
				if (request.method === "actionPaths") return [] as T;
				if (request.method === "baseline")
					return {
						initialized: false,
						generation: 0,
						observationId: null,
						state: "incomplete",
					} as T;
				throw new Error("Unexpected background scan/full summary");
			},
		},
	);
	const stop = service.watchObservation(() => {});
	try {
		dirtyGitStagingObservation(identity);
		await tick();
		await settleGitStagingObservations(identity.workspaceKey);
		expect(methods).toEqual(["actionPaths", "baseline"]);
		expect(gitStagingObservationState(identity)).toMatchObject({
			status: "settled",
			generation: 0,
			observationId: null,
		});
	} finally {
		stop();
	}
});

test("manual and watch observation share one authorized run and no-op sync emits no list change", async () => {
	const identity = { workspaceKey: "shared-observation", rootPath: "/shared-observation" };
	const beforeWrite = mock(async () => {});
	const authorizePaths = mock(async (_paths: string[]) => {});
	const changed = mock((_event: GitStagingChange) => {});
	let scans = 0;
	const service = createGitStagingListsService(
		{ ...identity, authorizationKey: "owner:narrator", beforeWrite, authorizePaths },
		{
			execute: async <T>(request: GitStagingWork) => {
				if (request.method === "actionPaths") return ["f", "hidden/old"] as T;
				if (request.method === "baseline")
					return {
						initialized: true,
						generation: 2,
						observationId: "observation",
						state: "ready",
					} as T;
				scans++;
				return {
					outcome: "applied",
					affectedListIds: [],
					generation: 2,
					observationId: "observation",
				} as T;
			},
			changed,
		},
	);
	const states: string[] = [];
	const stop = service.watchObservation((state) => states.push(state.status));
	try {
		dirtyGitStagingObservation(identity);
		const result = await service.action({ action: "sync" });
		expect(scans).toBe(1);
		expect(result.observation).toMatchObject({ status: "settled", generation: 2 });
		expect(result.observationTargetEpoch).toBe(result.observation?.completedEpoch);
		expect(authorizePaths).toHaveBeenCalledWith(["f", "hidden/old"]);
		expect(beforeWrite.mock.calls.length).toBeGreaterThanOrEqual(3);
		expect(changed).not.toHaveBeenCalled();
		expect(states).toContain("observing");
		expect(states.at(-1)).toBe("settled");
	} finally {
		stop();
	}
});

for (const action of [
	move,
	{ ...version, action: "delete" as const, listId: "A" },
	{ ...version, action: "commit" as const, listId: "A", message: "selected" },
])
	test(`${action.action} rechecks dirty state after queued complete-path authorization`, async () => {
		const identity = {
			workspaceKey: `dirty-${action.action}`,
			rootPath: `/dirty-${action.action}`,
		};
		let dirtyDuringAuthorization = false;
		const actions: string[] = [];
		const service = createGitStagingListsService(
			{
				...identity,
				beforeWrite: async () => {},
				authorizePaths: async () => {
					if (dirtyDuringAuthorization) dirtyGitStagingObservation(identity);
				},
			},
			{
				execute: async <T>(request: GitStagingWork) => {
					if (request.method === "actionPaths") return ["f"] as T;
					if (request.method === "baseline")
						return {
							initialized: true,
							generation: 2,
							observationId: "observation",
							state: "ready",
						} as T;
					if (request.method === "action") actions.push(request.request.action);
					return {
						outcome: "applied",
						affectedListIds: [],
						generation: 2,
						observationId: "observation",
					} as T;
				},
			},
		);
		const stop = service.watchObservation(() => {}, false);
		try {
			await service.action({ action: "sync" });
			dirtyDuringAuthorization = true;
			await expect(service.action(action)).rejects.toMatchObject({ code: "GIT_STAGING_STALE" });
			expect(actions).toEqual(["sync"]);
			expect(gitStagingObservationState(identity)?.status).toBe("pending");
		} finally {
			stop();
		}
	});

test("an applied ownership action retains a later dirty event rather than reporting it verified", async () => {
	const identity = { workspaceKey: "late-dirty", rootPath: "/late-dirty" };
	const service = createGitStagingListsService(
		{ ...identity, beforeWrite: async () => {}, authorizePaths: async () => {} },
		{
			execute: async <T>(request: GitStagingWork) => {
				if (request.method === "actionPaths") return ["f"] as T;
				if (request.method === "baseline")
					return {
						initialized: true,
						generation: 2,
						observationId: "observation",
						state: "ready",
					} as T;
				if (request.method === "action" && request.request.action === "move")
					dirtyGitStagingObservation(identity);
				return {
					...applied,
					generation: request.method === "action" && request.request.action === "move" ? 3 : 2,
				} as T;
			},
		},
	);
	const stop = service.watchObservation(() => {}, false);
	try {
		await service.action({ action: "sync" });
		const result = await service.action(move);
		expect(result.generation).toBe(3);
		expect(result.observation).toMatchObject({
			status: "pending",
			generation: 3,
			epoch: 3,
			completedEpoch: 2,
		});
	} finally {
		stop();
	}
});

test("a revoked queued background subject never runs sync even with a writable neighboring consumer", async () => {
	const identity = { workspaceKey: "revoked-scan", rootPath: "/revoked-scan" };
	const actions: string[] = [];
	const service = createGitStagingListsService(
		{
			...identity,
			beforeWrite: async () => {
				throw new AppError("revoked", 403, "FORBIDDEN");
			},
			authorizePaths: async () => {},
		},
		{
			execute: async <T>(request: GitStagingWork) => {
				actions.push(request.method);
				return [] as T;
			},
		},
	);
	const stop = service.watchObservation(() => {});
	try {
		await expect(service.action({ action: "sync" })).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(actions).toEqual([]);
	} finally {
		stop();
	}
});

test("remote summaries are explicit unsupported snapshots and do not load a Worker", async () => {
	const execute = mock(async (): Promise<never> => {
		throw new Error("must not execute");
	});
	const service = createGitStagingListsService(
		{ workspaceKey: "remote", rootPath: "/remote", supported: false, beforeWrite: async () => {} },
		{ execute },
	);
	expect(await service.summary()).toMatchObject({
		capability: { supported: false },
		initialized: false,
		generation: 0,
		observationId: null,
		state: "uninitialized",
		lists: [],
	});
	await expect(service.files("A")).rejects.toMatchObject({ code: "GIT_STAGING_UNSUPPORTED" });
	await expect(service.action({ action: "init" })).rejects.toMatchObject({
		code: "GIT_STAGING_UNSUPPORTED",
	});
	expect(execute).not.toHaveBeenCalled();
	const target = {
		workspace: { workspaceKey: "remote", rootPath: "/remote" },
		backend: { kind: "remote" },
	} as GitWorkspaceTarget;
	expect(
		(await (await getGitStagingListsService(target, "actor")).summary()).capability.supported,
	).toBe(false);
});
