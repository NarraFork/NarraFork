import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testEnvironment } from "../../../../../tests/preload";
import { cleanDb, getTestDb } from "../../../../../tests/setup";
import * as schema from "../../../../db/schema";
import type { FileChangeScopeIdentity } from "../../../../services/file-change-identity";
import type { LocalFileChangeRuntime } from "../../../../services/file-change-runtime";
import type { ExecHandle, ExecutionBackend } from "../../execution/backend";
import type { ToolContext } from "../../types";

const migrationScenarios = ["cold", "legacy-empty", "reload-cold", "reload-legacy"] as const;
const migrationScenario = process.env.NARRAFORK_BASH_MIGRATION_FIXTURE;

if (migrationScenario) {
	test(`isolated Bash activity migration: ${migrationScenario}`, async () => {
		expect(migrationScenarios.some((scenario) => scenario === migrationScenario)).toBe(true);
		expect(process.env.NARRAFORK_TEST).toBe("1");
		expect(process.env.HOME).toBe(testEnvironment.isolatedHome);
		expect(process.env.NARRAFORK_HOME).toBe(testEnvironment.narraforkHome);
		expect(testEnvironment.narraforkHome).not.toBe(testEnvironment.realNarraforkHome);
		const { db, sqlite } = getTestDb();
		mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
		const registryKey = Symbol.for("narrafork:runningBashProcesses");
		const migrationKey = Symbol.for("narrafork:bashActivityMigration:v1");
		const state = (key: symbol): unknown => Object.getOwnPropertyDescriptor(globalThis, key)?.value;
		// No Bash import may precede fixture setup; otherwise this is not cold/legacy admission.
		expect(state(registryKey)).toBeUndefined();
		expect(state(migrationKey)).toBeUndefined();
		const legacy = migrationScenario === "legacy-empty" || migrationScenario === "reload-legacy";
		const oldRegistry = new Map();
		if (legacy)
			Object.defineProperty(globalThis, registryKey, {
				value: oldRegistry,
				configurable: true,
				writable: true,
			});
		try {
			const require = createRequire(import.meta.url);
			const modulePath = require.resolve("../bash");
			const first: typeof import("../bash") = await import(modulePath);
			const migration = state(migrationKey);
			expect(migration).toEqual({ requiresColdStart: legacy });
			expect(Object.isFrozen(migration)).toBe(true);
			const check = (module: typeof import("../bash")) => {
				if (!legacy) {
					expect(() => module.assertBashActivityProtectionReady()).not.toThrow();
					return;
				}
				let failure: unknown;
				try {
					module.assertBashActivityProtectionReady();
				} catch (error) {
					failure = error;
				}
				expect(failure).toMatchObject({ statusCode: 409, code: "REVERT_RUNTIME_RELOAD_REQUIRED" });
			};
			check(first);
			if (legacy) {
				expect(state(registryKey)).toBe(oldRegistry);
				expect(oldRegistry.size).toBe(0);
				// An old suspended closure can still dispatch later. Empty is not a proof
				// that old code is gone, even after it ran and drained again.
				oldRegistry.set("old-loop", {});
				oldRegistry.clear();
				check(first);
			}
			if (migrationScenario.startsWith("reload-")) {
				let previous = first;
				for (let generation = 2; generation <= 3; generation++) {
					// Bun ignores query-string cache busters. Invalidate only this child's
					// module cache; globalThis keeps the hotSafe state as on a hot reload.
					// No --hot, service restart, source rewrite or migration-state reset.
					delete require.cache[modulePath];
					const reloaded: typeof import("../bash") = await import(modulePath);
					expect(reloaded.assertBashActivityProtectionReady).not.toBe(
						previous.assertBashActivityProtectionReady,
					);
					expect(state(migrationKey)).toBe(migration);
					check(reloaded);
					check(first); // Older exported closures share the same one-time decision.
					previous = reloaded;
				}
			}
		} finally {
			sqlite.close();
		}
	}, 10_000);
} else if (process.env.NARRAFORK_BASH_ACTIVITY_FIXTURE !== "1") {
	for (const scenario of migrationScenarios) {
		test(`Bash activity migration regression: ${scenario}`, async () => {
			const home = await mkdtemp(join(await realpath(tmpdir()), "bash-migration-home-"));
			try {
				const env: NodeJS.ProcessEnv = {
					...process.env,
					HOME: home,
					USERPROFILE: home,
					NARRAFORK_BASH_MIGRATION_FIXTURE: scenario,
				};
				// Child preload owns its actual temporary HOME/DB path. This additional
				// owned HOME also isolates Bun before preload runs; neither points at user data.
				delete env.NARRAFORK_HOME;
				delete env.NARRAFORK_BASH_ACTIVITY_FIXTURE;
				const result = spawnSync(process.execPath, ["test", import.meta.path], {
					env,
					encoding: "utf8",
					timeout: 15_000,
					maxBuffer: 256 * 1024,
				});
				if (result.error || result.status !== 0)
					throw new Error(
						`${result.error ?? "Migration fixture failed"}\n${result.stdout}\n${result.stderr}`,
					);
				expect(result.status).toBe(0);
			} finally {
				await rm(home, { recursive: true, force: true });
			}
		}, 20_000);
	}
	// Real Bash + background service + coordinator, in a dedicated preload-isolated
	// process. Only the DB is replaced with in-memory SQLite; no real user data is opened.
	test.skipIf(process.platform === "win32")(
		"isolated real Bash workspace activity suite",
		() => {
			const env: NodeJS.ProcessEnv = { ...process.env, NARRAFORK_BASH_ACTIVITY_FIXTURE: "1" };
			delete env.NARRAFORK_HOME;
			const result = spawnSync(process.execPath, ["test", import.meta.path], {
				env,
				encoding: "utf8",
				timeout: 120_000,
				maxBuffer: 1024 * 1024,
			});
			if (result.error || result.status !== 0)
				throw new Error(
					`${result.error ?? "Bash fixture failed"}\n${result.stdout}\n${result.stderr}`,
				);
			expect(result.status).toBe(0);
		},
		125_000,
	);
} else {
	if (process.env.NARRAFORK_TEST !== "1" || process.env.HOME !== testEnvironment.isolatedHome)
		throw new Error("Isolated Bun preload is required");
	const { db, sqlite } = getTestDb();
	sqlite.exec("PRAGMA busy_timeout = 0;");
	mock.module("@server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
	const { backgroundTaskService } = await import("@server/services/background-task-service");
	const { bashTool, updateBashTimeout } = await import("../bash");
	const { writeTool } = await import("../write");
	const { localBackend } = await import("../../execution/local-backend");
	const { windowsPathSemantics } = await import("../../execution/path-semantics");
	const { LocalFileValidationError, LocalObjectIdentityUnavailableError } = await import(
		"@server/services/file-change-local-io"
	);
	const {
		LocalFileChangeRuntime: Runtime,
		withLocalFileChangeRuntime,
		getDefaultLocalFileChangeRuntime,
		localFileChangeRuntimeBinding,
	} = await import("@server/services/file-change-runtime");
	const { createWorkspaceWriteCoordinatorState } = await import(
		"@server/services/workspace-write-coordinator"
	);
	const binding = localFileChangeRuntimeBinding();
	if (!binding) throw new Error("Local runtime required");
	const runtimeBinding = binding;

	function deferred<T = void>() {
		let resolve!: (value: T | PromiseLike<T>) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<T>((yes, no) => {
			resolve = yes;
			reject = no;
		});
		return { promise, resolve, reject };
	}
	function quote(text: string) {
		return `'${text.replaceAll("'", "'\\''")}'`;
	}
	let root: string;
	let workspace: string;
	let privateRoot: string;
	let runtime: LocalFileChangeRuntime;
	let nextId = 0;
	let dispatched: ExecHandle[];
	let spawned: ReturnType<typeof deferred<ExecHandle>>;
	let killRequested: ReturnType<typeof deferred<void>>;
	let holdKill: boolean;
	let decorate: ((handle: ExecHandle) => ExecHandle) | undefined;
	let backend: ExecutionBackend;
	let useDefault: boolean;
	type Program = {
		ready: ReturnType<typeof deferred<void>>;
		release: ReturnType<typeof deferred<void>>;
		server: Bun.Server<undefined>;
		command: string;
	};
	let gates: Program[];
	let calls: Promise<unknown>[];

	beforeEach(async () => {
		cleanDb(sqlite);
		root = await mkdtemp(join(await realpath(tmpdir()), "bash-activity-"));
		workspace = join(root, "workspace");
		privateRoot = join(root, "private");
		await mkdir(workspace);
		runtime = new Runtime({
			db,
			privateRoot,
			coordinatorState: createWorkspaceWriteCoordinatorState(),
			blobStoreOptions: { minimumFreeBytes: 0 },
		});
		for (const id of ["root-writer", "root-bash"]) {
			db.insert(schema.narrators)
				.values({ id, createdAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z" })
				.run();
		}
		dispatched = [];
		spawned = deferred<ExecHandle>();
		killRequested = deferred();
		holdKill = false;
		decorate = undefined;
		useDefault = false;
		gates = [];
		calls = [];
		backend = Object.create(localBackend);
		backend.execCommand = async (params) => {
			const handle = await localBackend.execCommand({
				...params,
				signal: holdKill ? undefined : params.signal,
			});
			dispatched.push(handle);
			spawned.resolve(handle);
			const controlled = holdKill
				? {
						pid: handle.pid,
						exited: handle.exited,
						whenSettled: handle.whenSettled,
						onData: handle.onData.bind(handle),
						isExited: handle.isExited.bind(handle),
						// A successful control acknowledgement is intentionally NOT exit.
						kill: async () => {
							killRequested.resolve();
						},
					}
				: handle;
			return decorate?.(controlled) ?? controlled;
		};
	});

	afterEach(async () => {
		for (const gate of gates) gate.release.resolve();
		// Only handles spawned by this fixture, never any running application service.
		await Promise.all(dispatched.map((handle) => handle.kill()));
		await Promise.allSettled(dispatched.map((handle) => handle.whenSettled ?? handle.exited));
		await Promise.allSettled(calls);
		const tasks = db.select().from(schema.backgroundTasks).limit(100).all();
		for (const task of tasks) {
			if (task.status === "running") await backgroundTaskService.waitForCompletion(task.id, 5_000);
		}
		for (const gate of gates) await gate.server.stop(true);
		await runtime.initialize().catch(() => {});
		mock.restore();
		await rm(root, { recursive: true, force: true });
	});

	function target(cwd = workspace) {
		return Object.freeze({
			deviceId: backend.deviceId,
			backendKind: backend.kind,
			cwd,
			pathFlavor: backend.pathFlavor,
			runtimeGeneration: backend.runtimeGeneration,
			selectionSource: "explicit" as const,
		});
	}
	function context(cwd = workspace, extra: Partial<ToolContext> = {}): ToolContext {
		return {
			narratorId: "root-bash",
			cwd,
			currentToolUseId: `bash-use-${++nextId}`,
			locale: "en",
			signal: new AbortController().signal,
			resolveBackend: () => backend,
			executionTarget: target(cwd),
			requestPermission: async () => ({ behavior: "allow" }),
			...extra,
		};
	}
	function run(command: string, ctx = context(), extra: Record<string, unknown> = {}) {
		const body = () => bashTool.execute({ command, timeout: 10_000, ...extra }, ctx);
		const call = useDefault ? body() : withLocalFileChangeRuntime(runtime, body);
		calls.push(call);
		return call;
	}
	async function scopeFromWrite(cwd = workspace) {
		const path = join(cwd, "bash.txt");
		const resolved = await localBackend.resolvePathIdentity(path);
		const id = `write-${++nextId}`;
		db.insert(schema.narratorMessages)
			.values({
				id,
				narratorId: "root-writer",
				role: "assistant",
				contentJson: [],
				createdAt: "2026-09-08T00:00:00Z",
			})
			.run();
		db.insert(schema.narratorToolCalls)
			.values({
				id,
				narratorId: "root-writer",
				messageId: id,
				toolUseId: id,
				toolName: "Write",
				status: "running",
				executionIdentityVersion: 1,
				executionAttempt: 1,
				executionStartedAt: "2026-09-08T00:00:00Z",
				executionDeviceId: "local",
				executionCwd: cwd,
				executionPathFlavor: "posix",
				resolvedFilePath: path,
				canonicalFilePath: resolved.canonicalPath,
				runtimeGeneration: 0,
				createdAt: "2026-09-08T00:00:00Z",
			})
			.run();
		const ctx = context(cwd, {
			narratorId: "root-writer",
			currentToolUseId: id,
			toolCallBinding: { toolCallId: id, attempt: 1 },
			executionTarget: {
				...target(cwd),
				lexicalPath: path,
				canonicalPath: resolved.canonicalPath,
			},
		});
		const body = () => writeTool.execute({ file_path: path, content: "before" }, ctx);
		const result = useDefault ? await body() : await withLocalFileChangeRuntime(runtime, body);
		expect(result.isError).not.toBe(true);
		const scope = db
			.select()
			.from(schema.fileChangeScopes)
			.all()
			.find((row) => row.canonicalRoot === cwd);
		if (!scope) throw new Error(`Real Write did not establish scope: ${JSON.stringify(result)}`);
		return scope;
	}
	function rollback(scope: FileChangeScopeIdentity) {
		return runtime.coordinator.withRollbackMany(
			{ scopes: [{ scope, runtime: runtimeBinding }] },
			() => "granted",
		);
	}
	async function blocked(scope: FileChangeScopeIdentity, code = "uncoordinated_activity") {
		await expect(rollback(scope)).rejects.toMatchObject({ code });
	}
	async function finished() {
		await Promise.all(dispatched.map((handle) => handle.whenSettled ?? handle.exited));
		// Join the already-attached lifecycle observer, not a guessed sleep/pid probe.
		await Promise.resolve();
	}
	function program(options: { outputBytes?: number; prefix?: string } = {}): Program {
		const ready = deferred();
		const release = deferred();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch() {
				ready.resolve();
				await release.promise;
				return new Response("exit");
			},
		});
		const code = `${options.prefix ?? ""}
await Bun.write("bash.txt", "running");
${options.outputBytes ? `process.stdout.write(Buffer.alloc(${options.outputBytes}, 65));` : "console.log('ready');"}
await fetch("http://127.0.0.1:${server.port}/barrier");
await Bun.write("bash.txt", "finished");`;
		const gate = {
			ready,
			release,
			server,
			command: `exec ${quote(process.execPath)} -e ${quote(code)}`,
		};
		gates.push(gate);
		return gate;
	}
	async function taskId() {
		const task = db.select().from(schema.backgroundTasks).limit(1).get();
		if (!task) throw new Error("Background task was not created");
		return task.id;
	}

	describe("real local Bash activity admission", () => {
		for (const background of [false, true]) {
			for (const relation of ["same", "child", "parent", "alias"] as const) {
				test(`${background ? "background" : "foreground"} ${relation} cwd blocks another root rollback until real close`, async () => {
					const child = join(workspace, "nested");
					await mkdir(child);
					const scope = await scopeFromWrite(relation === "parent" ? child : workspace);
					let cwd = relation === "child" ? child : workspace;
					if (relation === "alias") {
						cwd = join(root, "alias");
						await symlink(workspace, cwd);
					}
					const gate = program();
					const result = run(gate.command, context(cwd), { run_in_background: background });
					if (background) expect((await result).output).toContain("Background bash task started");
					await gate.ready.promise;
					expect(await readFile(join(cwd, "bash.txt"), "utf8")).toBe("running");
					expect(runtime.coordinator.capture(scope).active.uncoordinatedActivities).toBe(1);
					await blocked(scope);
					gate.release.resolve();
					await result;
					await finished();
					expect(await rollback(scope)).toBe("granted");
					expect(await readFile(join(cwd, "bash.txt"), "utf8")).toBe("finished");
					// Bash never fabricates reversible history/effects.
					expect(db.select().from(schema.fileChangeOperations).all()).toHaveLength(1);
				});
			}
			test(`${background ? "background" : "foreground"} cannot spawn through an active rollback lease`, async () => {
				const scope = await scopeFromWrite();
				await runtime.coordinator.withRollbackMany(
					{ scopes: [{ scope, runtime: runtimeBinding }] },
					async () => {
						const child = join(workspace, "nested");
						await mkdir(child);
						for (const cwd of [workspace, child]) {
							for (const command of ["printf changed > bash.txt", "true"]) {
								const result = run(command, context(cwd), { run_in_background: background });
								if (background) await expect(result).rejects.toThrow("overlapping rollback");
								else {
									const refused = await result;
									expect(refused.isError).toBe(true);
									expect(refused.output).toContain("overlapping rollback");
								}
							}
						}
						expect(dispatched).toHaveLength(0);
						expect(await readFile(join(workspace, "bash.txt"), "utf8")).toBe("before");
					},
				);
				expect(runtime.coordinator.capture(scope).active.uncoordinatedActivities).toBe(0);
			});
		}

		test("the real two-second legacy lock fallback cannot bypass activity protection", async () => {
			const { withWorkspaceWriteLock, resolveBashSerializationInput, decideBashSerialization } =
				await import("../write-serialization");
			const scope = await scopeFromWrite();
			const gate = program();
			const executable = join(workspace, "touch");
			await Bun.write(executable, `#!/bin/sh\n${gate.command}\n`);
			await chmod(executable, 0o700);
			const command = "./touch bash.txt";
			const policy = await resolveBashSerializationInput({
				command,
				cwd: workspace,
				isBackground: false,
				isChapter: false,
			});
			expect(decideBashSerialization(policy).shouldSerialize).toBe(true);
			const entered = deferred();
			const release = deferred();
			const legacy = withWorkspaceWriteLock(localBackend, workspace, async () => {
				entered.resolve();
				await release.promise;
			});
			try {
				await entered.promise;
				const result = run(command);
				// Only the actual bounded-mutex fallback can dispatch while legacy stays held.
				await gate.ready.promise;
				await blocked(scope);
				gate.release.resolve();
				await result;
				await finished();
				expect(await rollback(scope)).toBe("granted");
			} finally {
				release.resolve();
				await legacy;
			}
		}, 15_000);

		test("background startup never resolves another execution backend", async () => {
			const scope = await scopeFromWrite();
			let resolutions = 0;
			const ctx = context(workspace, {
				resolveBackend: () => {
					if (++resolutions > 1) throw new Error("Frozen backend was resolved twice");
					return backend;
				},
			});
			const gate = program();
			expect((await run(gate.command, ctx, { run_in_background: true })).isError).not.toBe(true);
			await gate.ready.promise;
			expect(resolutions).toBe(1);
			await blocked(scope);
			gate.release.resolve();
			await finished();
		});

		test("unrelated sibling cwd is not excluded by local activity", async () => {
			const scope = await scopeFromWrite();
			const elsewhere = join(root, "elsewhere");
			await mkdir(elsewhere);
			const gate = program();
			const result = run(gate.command, context(elsewhere));
			await gate.ready.promise;
			expect(await rollback(scope)).toBe("granted");
			gate.release.resolve();
			await result;
		});

		test("explicit actual workdir, not the narrator default, determines the protected scope", async () => {
			const other = join(root, "other");
			await mkdir(other);
			const scope = await scopeFromWrite(other);
			const gate = program();
			const ctx = context(other);
			ctx.cwd = workspace;
			const result = run(gate.command, ctx, { workdir: other });
			await gate.ready.promise;
			await blocked(scope);
			gate.release.resolve();
			await result;
		});

		test("stop acknowledgement and foreground abort retain a still-running local process", async () => {
			for (const background of [false, true]) {
				const scope = await scopeFromWrite();
				holdKill = true;
				const abort = new AbortController();
				const ctx = context(workspace, { signal: abort.signal });
				const gate = program();
				const result = run(gate.command, ctx, { run_in_background: background });
				if (background) await result;
				await gate.ready.promise;
				if (background) {
					const stopped = await bashTool.execute({ stop: await taskId() }, ctx);
					expect(stopped.output).toContain("has been cancelled");
				} else abort.abort();
				await killRequested.promise;
				await blocked(scope);
				expect(dispatched.at(-1)?.isExited()).toBe(false);
				gate.release.resolve();
				await result;
				await finished();
				expect(await rollback(scope)).toBe("granted");
			}
		});

		for (const background of [false, true]) {
			test(`${background ? "background" : "foreground"} timeout does not release on kill acknowledgement`, async () => {
				const scope = await scopeFromWrite();
				holdKill = true;
				const gate = program();
				const ctx = context();
				const result = run(gate.command, ctx, {
					run_in_background: background,
					timeout: background ? 1 : 10_000,
				});
				if (background) await result;
				await gate.ready.promise;
				if (!ctx.currentToolUseId) throw new Error("Tool use ID missing");
				if (!background) expect(updateBashTimeout(ctx.currentToolUseId, 1000)).toBe(1000);
				await killRequested.promise;
				await blocked(scope);
				gate.release.resolve();
				await result;
				await finished();
				expect(await rollback(scope)).toBe("granted");
			});

			test(`${background ? "background" : "foreground"} output cap retains activity until the real process exits`, async () => {
				const scope = await scopeFromWrite();
				const gate = program({ outputBytes: 10 * 1024 * 1024 + 4096 });
				const result = run(gate.command, context(), { run_in_background: background });
				if (background) await result;
				await gate.ready.promise;
				await blocked(scope);
				gate.release.resolve();
				const output = await result;
				await finished();
				if (!background) expect(output.output).toContain("Output truncated at 10MB");
				expect(await rollback(scope)).toBe("granted");
			}, 20_000);
		}

		test("shell exit/tool return keeps activity while an ordinary child still owns stdio", async () => {
			const scope = await scopeFromWrite();
			const gate = program();
			const result = await run(`${gate.command.slice("exec ".length)} &`);
			const handle = await spawned.promise;
			await handle.exited;
			await gate.ready.promise;
			expect(result.isError).not.toBe(true);
			let settled = false;
			void handle.whenSettled?.then(() => {
				settled = true;
			});
			await blocked(scope);
			expect(settled).toBe(false);
			gate.release.resolve();
			await finished();
			expect(await rollback(scope)).toBe("granted");
		});

		for (const background of [false, true]) {
			test(`${background ? "background stop" : "foreground abort"} real kill path releases only after confirmed process close`, async () => {
				const scope = await scopeFromWrite();
				const abort = new AbortController();
				const ctx = context(workspace, { signal: abort.signal });
				const gate = program();
				const result = run(gate.command, ctx, { run_in_background: background });
				if (background) await result;
				await gate.ready.promise;
				await blocked(scope);
				if (background) await bashTool.execute({ stop: await taskId() }, ctx);
				else abort.abort();
				await result;
				await finished();
				expect(dispatched[0].isExited()).toBe(true);
				expect(await rollback(scope)).toBe("granted");
			});
		}

		test("tool error is not the independent local lifetime barrier", async () => {
			const scope = await scopeFromWrite();
			const earlyError = deferred<number | null>();
			decorate = (handle) => ({
				pid: handle.pid,
				exited: earlyError.promise,
				whenSettled: handle.whenSettled,
				onData: handle.onData.bind(handle),
				kill: handle.kill.bind(handle),
				isExited: handle.isExited.bind(handle),
			});
			const gate = program();
			const result = run(gate.command);
			await gate.ready.promise;
			earlyError.reject(new Error("Control transport failed before exit"));
			expect((await result).isError).toBe(true);
			await blocked(scope);
			gate.release.resolve();
			await finished();
			expect(await rollback(scope)).toBe("granted");
		});

		test("unknown real termination persists quarantine, never a forged finished outcome", async () => {
			const scope = await scopeFromWrite();
			const uncertain = deferred();
			decorate = (handle) => ({
				pid: handle.pid,
				exited: handle.exited,
				whenSettled: uncertain.promise,
				onData: handle.onData.bind(handle),
				kill: handle.kill.bind(handle),
				isExited: handle.isExited.bind(handle),
			});
			const end = spyOn(runtime.coordinator, "endActivity");
			const gate = program();
			const result = run(gate.command);
			await gate.ready.promise;
			uncertain.reject(new Error("Exit confirmation unavailable"));
			await Promise.resolve();
			expect(end.mock.calls[0]?.[1]).toBe("unknown");
			await blocked(scope, "needs_verification");
			gate.release.resolve();
			await result;
			await finished();
			expect(end).toHaveBeenCalledTimes(1);
			await blocked(scope, "needs_verification");
		});

		test("cancellation after registration but before spawn leaves no activity", async () => {
			const scope = await scopeFromWrite();
			const abort = new AbortController();
			const register = runtime.coordinator.registerActivity.bind(runtime.coordinator);
			spyOn(runtime.coordinator, "registerActivity").mockImplementation((input) => {
				const token = register(input);
				abort.abort();
				return token;
			});
			expect(
				(await run("printf bad > bash.txt", context(workspace, { signal: abort.signal }))).isError,
			).toBe(true);
			expect(dispatched).toHaveLength(0);
			expect(await rollback(scope)).toBe("granted");
		});

		test("synchronous and asynchronous real spawn failures clean up registration", async () => {
			const scope = await scopeFromWrite();
			expect((await run("invalid\0command")).isError).toBe(true);
			expect(await rollback(scope)).toBe("granted");
			const execute = backend.execCommand.bind(backend);
			backend.execCommand = async (params) => {
				await rename(workspace, `${workspace}-saved`);
				return execute(params);
			};
			expect((await run("printf bad > bash.txt")).isError).toBe(true);
			await finished();
			await rename(`${workspace}-saved`, workspace);
			expect(await rollback(scope)).toBe("granted");
			expect(await readFile(join(workspace, "bash.txt"), "utf8")).toBe("before");
		});

		test("registration rejection fails closed; background-record failure releases unspawned activity", async () => {
			const scope = await scopeFromWrite();
			const registration = spyOn(runtime.coordinator, "registerActivity").mockImplementation(() => {
				throw new Error("registration denied");
			});
			expect((await run("printf bad > bash.txt")).output).toContain("registration denied");
			registration.mockRestore();
			spyOn(backgroundTaskService, "createBashTask").mockRejectedValueOnce(
				new Error("task persistence failed"),
			);
			await expect(
				run("printf bad > bash.txt", context(), { run_in_background: true }),
			).rejects.toThrow("task persistence failed");
			expect(dispatched).toHaveLength(0);
			expect(await rollback(scope)).toBe("granted");
		});

		for (const damage of ["missing", "corrupt"] as const) {
			test(`real Bash preserves coordination with ${damage} source identity`, async () => {
				const scope = await scopeFromWrite();
				const identityPath = join(privateRoot, "file-change-source.json");
				if (damage === "missing") await rm(identityPath);
				else await writeFile(identityPath, "{broken");
				const registration = spyOn(runtime.coordinator, "registerActivity");
				expect((await run("printf first > bash.txt")).isError).not.toBe(true);
				await finished();
				expect((await run("printf second > bash.txt")).isError).not.toBe(true);
				await finished();
				expect(dispatched).toHaveLength(2);
				expect(registration).toHaveBeenCalledTimes(2);
				for (const [input] of registration.mock.calls) expect(input.scope.id).toBe(scope.id);
				expect(await readFile(join(workspace, "bash.txt"), "utf8")).toBe("second");
				await expect(runtime.verifyNamespace()).rejects.toThrow();
				await runtime.initialize().catch(() => {});
			});
		}

		test("blob permission/catalog failures do not prevent shell dispatch", async () => {
			const namespace = await runtime.initialize();
			await chmod(join(privateRoot, "file-change-blobs"), 0o755);
			expect((await run("printf first > bash.txt")).isError).not.toBe(true);
			await finished();
			await chmod(join(privateRoot, "file-change-blobs"), 0o700);
			namespace.catalog.beginReconciliation({ expectedGeneration: namespace.generation });
			expect((await run("printf second > bash.txt")).isError).not.toBe(true);
			await finished();
			expect(dispatched).toHaveLength(2);
			expect(await readFile(join(workspace, "bash.txt"), "utf8")).toBe("second");
		});

		const complete = (): ExecHandle => ({
			exited: Promise.resolve(0),
			onData() {},
			isExited: () => true,
			kill: async () => {},
		});

		test("remote targets never initialize a local evidence namespace", async () => {
			const register = spyOn(runtime, "registerBashActivity");
			backend = Object.assign(Object.create(localBackend), {
				kind: "remote",
				deviceId: "remote-fixture",
				defaultCwd: workspace,
				execCommand: mock(async () => complete()),
			});
			expect((await run("remote-command", context())).isError).not.toBe(true);
			expect(register).not.toHaveBeenCalled();
			expect(db.select().from(schema.fileChangeScopes).all()).toHaveLength(0);
		});

		test("local Windows Bash is registered with the coordinator like POSIX", async () => {
			// Rollback runs on Windows too, so an unregistered local shell could write
			// under a rollback lease. The Windows-flavored backend must reach admission.
			const register = spyOn(runtime, "registerBashActivity").mockImplementation(async () => {
				throw new Error("admission reached");
			});
			const execCommand = mock(async () => complete());
			backend = Object.assign(Object.create(localBackend), {
				pathFlavor: "windows",
				paths: windowsPathSemantics,
				statFile: async () => ({ isDirectory: true, isFile: false, size: 0 }),
				execCommand,
			});
			expect((await run("windows-command", context("C:\\workspace"))).isError).toBe(true);
			expect(register).toHaveBeenCalledTimes(1);
			// Failed admission fails closed before the shell is dispatched.
			expect(execCommand).not.toHaveBeenCalled();
		});

		const windowsBackend = (execCommand: ExecutionBackend["execCommand"]) =>
			Object.assign(Object.create(localBackend), {
				pathFlavor: "windows",
				paths: windowsPathSemantics,
				statFile: async () => ({ isDirectory: true, isFile: false, size: 0 }),
				execCommand,
			});

		test("a Windows volume without object identities runs Bash uncoordinated", async () => {
			// FAT/exFAT and some shares report no dev/ino/birthtime: such a workspace can
			// never hold rollback evidence, so there is no lease for the shell to race.
			spyOn(runtime, "registerBashActivity").mockImplementation(async () => {
				throw new LocalObjectIdentityUnavailableError("no object identity");
			});
			const execCommand = mock(async () => complete());
			backend = windowsBackend(execCommand);
			expect((await run("windows-command", context("C:\\workspace"))).isError).not.toBe(true);
			expect(execCommand).toHaveBeenCalledTimes(1);
		});

		test("other Windows admission validation failures still fail closed", async () => {
			// Only "the volume has no identities" is exempt; a real mismatch is not.
			spyOn(runtime, "registerBashActivity").mockImplementation(async () => {
				throw new LocalFileValidationError("Canonical workspace root is not a directory");
			});
			const execCommand = mock(async () => complete());
			backend = windowsBackend(execCommand);
			expect((await run("windows-command", context("C:\\workspace"))).isError).toBe(true);
			expect(execCommand).not.toHaveBeenCalled();
		});

		test("POSIX never degrades on a missing object identity", async () => {
			spyOn(runtime, "registerBashActivity").mockImplementation(async () => {
				throw new LocalObjectIdentityUnavailableError("no object identity");
			});
			const execCommand = mock(async () => complete());
			backend = Object.assign(Object.create(localBackend), { execCommand });
			expect((await run("posix-command")).isError).toBe(true);
			expect(execCommand).not.toHaveBeenCalled();
		});

		test("frozen remote target cannot fall back to local and stale local runtime cannot spawn", async () => {
			const ctx = context();
			ctx.executionTarget = {
				...target(),
				deviceId: "remote-fixture",
				backendKind: "remote",
			};
			expect((await run("printf bad > bash.txt", ctx)).isError).toBe(true);
			const stale = context();
			stale.executionTarget = { ...target(), runtimeGeneration: 999 };
			expect((await run("printf bad > bash.txt", stale)).isError).toBe(true);
			expect(dispatched).toHaveLength(0);
		});

		test("the actual default runtime is shared with Write/Edit, without DI or a second coordinator", async () => {
			useDefault = true;
			runtime = await getDefaultLocalFileChangeRuntime();
			const scope = await scopeFromWrite();
			const gate = program();
			const result = run(gate.command);
			await gate.ready.promise;
			await blocked(scope);
			expect(db.select().from(schema.fileChangeScopes).all()).toHaveLength(1);
			gate.release.resolve();
			await result;
			await finished();
			expect(await rollback(scope)).toBe("granted");
		});
	});
}
