import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { testEnvironment } from "../../../tests/preload";
import { cleanDb, getTestDb } from "../../../tests/setup";
import * as relations from "../../db/relations";
import * as schema from "../../db/schema";
import type { ExecHandle, ExecParams, ExecutionBackend } from "../../lib/agent/execution/backend";
import { posixPathSemantics } from "../../lib/agent/execution/path-semantics";
import type { ToolCallBinding, ToolContext, ToolExecutionTarget } from "../../lib/agent/types";

// Module mocks are process-global in Bun. Keep this full-schema in-memory fixture
// in its own process, including when a larger test directory is run in parallel.
if (process.env.NARRAFORK_BG_BASH_BINDING_FIXTURE !== "1") {
	test("isolated background Bash execution binding suite", () => {
		const env: NodeJS.ProcessEnv = { ...process.env, NARRAFORK_BG_BASH_BINDING_FIXTURE: "1" };
		delete env.NARRAFORK_HOME;
		const result = spawnSync(process.execPath, ["test", import.meta.path], {
			env,
			encoding: "utf8",
			timeout: 60_000,
			maxBuffer: 512 * 1024,
		});
		if (result.error || result.status !== 0) {
			throw new Error(`${result.error ?? "Fixture failed"}\n${result.stdout}\n${result.stderr}`);
		}
		expect(result.status).toBe(0);
	}, 65_000);
} else {
	if (
		process.env.NARRAFORK_TEST !== "1" ||
		process.env.HOME !== testEnvironment.isolatedHome ||
		process.env.NARRAFORK_HOME !== testEnvironment.narraforkHome ||
		testEnvironment.narraforkHome === testEnvironment.realNarraforkHome
	) {
		throw new Error("Isolated bunfig preload is required");
	}

	const { backgroundTasks, narratorMessages, narrators, narratorToolCalls } = schema;
	const { sqlite } = getTestDb();
	const queries: string[] = [];
	const db = drizzle({
		client: sqlite,
		schema: { ...schema, ...relations },
		logger: { logQuery: (query) => queries.push(query) },
	});
	// No real DB module or session runtime is imported by this fixture.
	mock.module("../../db", () => ({ db, sqlite }));
	mock.module("../narrator-session", () => ({
		isNarratorActive: () => false,
		isLoopRunning: () => false,
	}));
	const aliases = await import("../subagent-alias");
	mock.module("../narrator-subagent", () => ({ registerTaskAlias: aliases.registerTaskAlias }));
	mock.module("../narrator-service", () => ({
		narratorService: {
			listSubagentsByParent: (id: string) =>
				db.select({ id: narrators.id }).from(narrators).where(eq(narrators.parentNarratorId, id)),
		},
	}));
	const realId = { ...(await import("../../lib/id")) };
	let failId = false;
	let fixedId: string | undefined;
	mock.module("../../lib/id", () => ({
		...realId,
		generateShortId() {
			if (failId) throw new Error("Injected ID generation failure");
			return fixedId ?? realId.generateShortId();
		},
	}));

	const { backgroundTaskService } = await import("../background-task-service");
	const { bashTool } = await import("../../lib/agent/tools/bash");
	const { teamStatusTool } = await import("../../lib/agent/tools/team-status");
	const { drainPendingInjections } = await import("../parent-injection-queue");
	const PARENT = "binding-parent";
	const OTHER = "binding-other";
	const TOOL_USE_ID = "reused-provider-id";
	const now = "2026-09-07T10:00:00.000Z";
	const target: ToolExecutionTarget = {
		deviceId: "fixture-remote-device",
		backendKind: "remote",
		cwd: "/fixture/workspace",
		pathFlavor: "posix",
		runtimeGeneration: 17,
		selectionSource: "explicit",
	};
	const events: string[] = [];

	function controlledHandle(params: ExecParams) {
		let finish!: (code: number | null) => void;
		let exited = false;
		let onData: ((chunk: Uint8Array) => void) | undefined;
		const kill = mock(async () => {});
		const handle: ExecHandle = {
			exited: new Promise((resolve) => {
				finish = resolve;
			}),
			onData: (callback) => {
				onData = callback;
			},
			isExited: () => exited,
			// Cancellation deliberately does not prove exit. Tests resolve exit separately.
			kill,
		};
		return {
			handle,
			params,
			kill,
			rowsAtSpawn: db.select().from(backgroundTasks).all(),
			send: (output: string) => onData?.(Buffer.from(output)),
			finish: (code: number | null = 0) => {
				exited = true;
				finish(code);
			},
		};
	}
	const executions: ReturnType<typeof controlledHandle>[] = [];
	const execCommand = mock(async (params: ExecParams) => {
		events.push("exec");
		const execution = controlledHandle(params);
		executions.push(execution);
		return execution.handle;
	});
	async function unexpectedBackendOperation(): Promise<never> {
		throw new Error("Unexpected backend operation in isolated Bash test");
	}
	// Only this controlled handle is used: no local shell, remote RPC, or real service.
	const backend: ExecutionBackend = {
		kind: "remote",
		deviceId: target.deviceId,
		defaultCwd: target.cwd,
		paths: posixPathSemantics,
		pathFlavor: "posix",
		runtimeGeneration: 17,
		resolvePathIdentity: unexpectedBackendOperation,
		statFile: unexpectedBackendOperation,
		readFileBytes: unexpectedBackendOperation,
		writeFileBytes: unexpectedBackendOperation,
		removeFile: unexpectedBackendOperation,
		mkdirp: unexpectedBackendOperation,
		listDir: unexpectedBackendOperation,
		fileExists: unexpectedBackendOperation,
		glob: unexpectedBackendOperation,
		grep: unexpectedBackendOperation,
		gitStatus: unexpectedBackendOperation,
		gitDiff: unexpectedBackendOperation,
		execCommand,
	};

	function context(binding?: ToolCallBinding, extra: Partial<ToolContext> = {}): ToolContext {
		return {
			narratorId: PARENT,
			cwd: target.cwd,
			locale: "en",
			signal: new AbortController().signal,
			requestPermission: async () => ({ behavior: "allow" }),
			currentToolUseId: TOOL_USE_ID,
			toolCallBinding: binding,
			executionTarget: target,
			resolveBackend: () => backend,
			...extra,
		};
	}

	function lease() {
		let resolveReleased!: () => void;
		const released = new Promise<void>((resolve) => {
			resolveReleased = resolve;
		});
		return {
			released,
			kind: "background_bash" as const,
			setNarratorId() {},
			transfer: mock(() => {
				events.push("transfer");
				expect(db.select({ id: backgroundTasks.id }).from(backgroundTasks).all()).toHaveLength(1);
				return true;
			}),
			release: mock(() => {
				events.push("release");
				resolveReleased();
			}),
		};
	}

	function run(ctx: ToolContext) {
		return bashTool.execute(
			{ command: "fixture-command", run_in_background: true, timeout: 0, description: "Bind Bash" },
			ctx,
		);
	}

	async function bounded<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Background lifecycle stalled")), 1500);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	async function flush() {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}

	async function seedCall(
		id = "actual-call",
		extra: Partial<typeof narratorToolCalls.$inferInsert> = {},
	): Promise<ToolCallBinding> {
		const narratorId = extra.narratorId ?? PARENT;
		const messageId = extra.messageId ?? `message-${id}`;
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId,
			role: "assistant",
			contentJson: [],
			createdAt: now,
		});
		await db.insert(narratorToolCalls).values({
			id,
			narratorId,
			messageId,
			toolUseId: TOOL_USE_ID,
			toolName: "Bash",
			status: "running",
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionStartedAt: now,
			executionDeviceId: target.deviceId,
			executionCwd: target.cwd,
			executionPathFlavor: target.pathFlavor,
			runtimeGeneration: target.runtimeGeneration,
			createdAt: now,
			...extra,
		});
		return { toolCallId: id, attempt: extra.executionAttempt ?? 1 };
	}

	function create(binding?: ToolCallBinding, id = "bash-direct") {
		return backgroundTaskService.createBashTask({
			id,
			parentNarratorId: PARENT,
			command: "fixture-command",
			toolUseId: TOOL_USE_ID,
			toolCallBinding: binding,
			executionTarget: target,
		});
	}

	function taskRow() {
		const rows = db.select().from(backgroundTasks).all();
		expect(rows).toHaveLength(1);
		return rows[0];
	}

	beforeEach(async () => {
		backgroundTaskService.setBroadcastFnForTests(() => {});
		backgroundTaskService.resetListVersionsForTests();
		queries.length = 0;
		events.length = 0;
		executions.length = 0;
		execCommand.mockClear();
		for (const id of [PARENT, OTHER]) {
			await db.insert(narrators).values({ id, createdAt: now, updatedAt: now });
		}
	});

	afterEach(async () => {
		failId = false;
		fixedId = undefined;
		sqlite.run("DROP TRIGGER IF EXISTS reject_background_insert");
		for (const execution of executions) execution.finish();
		await flush();
		for (const row of db.select({ id: backgroundTasks.id }).from(backgroundTasks).all()) {
			await backgroundTaskService.markCancelled(row.id);
		}
		await flush();
		for (const id of [PARENT, OTHER]) {
			aliases.clearAliasRegistry(id);
			drainPendingInjections(id);
		}
		cleanDb(sqlite);
	});

	afterAll(() => {
		backgroundTaskService.setBroadcastFnForTests(null);
		sqlite.close();
	});

	describe("background Bash actual execution provenance", () => {
		test("uses a real in-memory DB and temporary HOME", () => {
			const databases = sqlite.query("PRAGMA database_list").all() as Array<{ file: string }>;
			expect(databases.every((database) => database.file === "")).toBe(true);
			expect(process.env.HOME).toBe(testEnvironment.isolatedHome);
			expect(process.env.HOME).not.toBe(testEnvironment.originalHome);
		});

		test("provider ids reused across messages and parents bind to the selected actual PK", async () => {
			const first = await seedCall("first-message-call");
			const second = await seedCall("second-message-call");
			const third = await seedCall("other-parent-call", { narratorId: OTHER });
			for (const [binding, narratorId] of [
				[first, PARENT],
				[second, PARENT],
				[third, OTHER],
			] as const) {
				await bounded(run(context(binding, { narratorId })));
			}
			const rows = db.select().from(backgroundTasks).orderBy(backgroundTasks.toolCallId).all();
			expect(
				rows.map((row) => [row.toolCallId, row.parentNarratorId, row.executionAttempt]),
			).toEqual([
				[first.toolCallId, PARENT, 1],
				[third.toolCallId, OTHER, 1],
				[second.toolCallId, PARENT, 1],
			]);
			expect(rows.every((row) => row.toolUseId === TOOL_USE_ID)).toBe(true);
			expect(execCommand).toHaveBeenCalledTimes(3);
		});

		test("one PK may represent distinct already-claimed attempts, never a default/latest guess", async () => {
			const binding = await seedCall();
			await create(binding, "bash-attempt-1");
			await db
				.update(narratorToolCalls)
				.set({ executionAttempt: 2 })
				.where(eq(narratorToolCalls.id, binding.toolCallId));
			await expect(create(binding, "bash-stale")).rejects.toThrow("not an actual running attempt");
			await create({ ...binding, attempt: 2 }, "bash-attempt-2");
			expect(
				db
					.select({ attempt: backgroundTasks.executionAttempt })
					.from(backgroundTasks)
					.orderBy(backgroundTasks.executionAttempt)
					.all(),
			).toEqual([{ attempt: 1 }, { attempt: 2 }]);
		});

		test.each([
			["another narrator", { narratorId: OTHER }],
			["non-Bash tool", { toolName: "Write" }],
			["legacy identity", { executionIdentityVersion: 0 }],
			["unknown identity version", { executionIdentityVersion: 2 }],
			["COW clone", { executionOriginToolCallId: "original-call" }],
			["checkpoint", { isFileHistoryCheckpoint: true }],
			["initializing", { status: "initializing" }],
			["pending", { status: "pending" }],
			["completed", { status: "success" }],
			["failed", { status: "fail" }],
			["unstarted", { executionStartedAt: null }],
			["empty start", { executionStartedAt: "" }],
			["unallocated attempt", { executionAttempt: 0 }],
			["wrong attempt", { executionAttempt: 2 }],
			["wrong provider id", { toolUseId: "not-this-provider-id" }],
		] satisfies Array<
			[string, Partial<typeof narratorToolCalls.$inferInsert>]
		>)("rejects %s without starting a process", async (_label, overrides) => {
			await seedCall("bad-call", overrides);
			const binding = { toolCallId: "bad-call", attempt: 1 };
			await expect(run(context(binding))).rejects.toThrow("not an actual running attempt");
			expect(execCommand).not.toHaveBeenCalled();
			expect(db.select().from(backgroundTasks).all()).toEqual([]);
		});

		test("wrong PK is rejected even when a matching provider id exists", async () => {
			await seedCall();
			await expect(run(context({ toolCallId: "missing", attempt: 1 }))).rejects.toThrow(
				"not an actual running attempt",
			);
			expect(execCommand).not.toHaveBeenCalled();
		});

		test.each([
			0,
			-1,
			1.5,
			Number.NaN,
			Number.MAX_SAFE_INTEGER + 1,
		])("rejects malformed attempt %s rather than allocating one", async (attempt) => {
			const binding = await seedCall();
			await expect(create({ ...binding, attempt })).rejects.toThrow(
				"Invalid background Bash execution binding",
			);
			expect(db.select().from(backgroundTasks).all()).toEqual([]);
		});

		test.each([
			["device", { deviceId: "different-device" }],
			["cwd", { cwd: "/different/workspace" }],
			["path flavor", { pathFlavor: "windows" }],
			["runtime generation", { runtimeGeneration: 18 }],
			["backend kind", { backendKind: "local" }],
		] satisfies Array<
			[string, Partial<ToolExecutionTarget>]
		>)("rejects mismatched frozen %s before execCommand", async (_label, overrides) => {
			const binding = await seedCall();
			await expect(
				run(context(binding, { executionTarget: { ...target, ...overrides } })),
			).rejects.toThrow("execution target does not match");
			expect(execCommand).not.toHaveBeenCalled();
		});

		test("source validation reads bounded metadata, never the large JSON columns", async () => {
			const binding = await seedCall();
			// Malformed JSON would throw if any of these columns were deserialized.
			sqlite.run(
				"UPDATE narrator_tool_calls SET input_json = ?, output_json = ?, execution_targets_json = ? WHERE id = ?",
				["{".repeat(1024 * 1024), "{".repeat(1024 * 1024), "{", binding.toolCallId],
			);
			queries.length = 0;
			await create(binding);
			const reads = queries.filter(
				(query) => /^select /i.test(query) && query.includes('from "narrator_tool_calls"'),
			);
			expect(reads).toHaveLength(1);
			expect(reads[0]).toContain('where "narrator_tool_calls"."id" = ? limit ?');
			expect(reads[0]).not.toMatch(/input_json|output_json|execution_targets_json|order by/i);
		});

		test("a missing optional provider id is not guessed from other rows", async () => {
			const binding = await seedCall();
			const result = await backgroundTaskService.createBashTask({
				id: "no-provider",
				parentNarratorId: PARENT,
				command: "fixture-command",
				toolCallBinding: binding,
				executionTarget: target,
			});
			expect(result).toMatchObject({
				toolCallId: binding.toolCallId,
				executionAttempt: 1,
				toolUseId: null,
			});
		});

		test("unbound legacy/direct callers remain valid and store both evidence columns as NULL", async () => {
			await seedCall();
			await create(undefined, "legacy-direct-1");
			await create(undefined, "legacy-direct-2");
			await bounded(run(context()));
			const rows = db.select().from(backgroundTasks).all();
			expect(rows).toHaveLength(3);
			expect(rows.every((row) => row.toolCallId === null && row.executionAttempt === null)).toBe(
				true,
			);
			expect(execCommand).toHaveBeenCalledTimes(1);
		});
	});

	describe("background Bash pre-spawn durability and unchanged lifecycle", () => {
		test("returns immediately after durable binding and transfers its lease before spawning", async () => {
			const binding = await seedCall();
			const updateExecutionLease = lease();
			const result = await bounded(run(context(binding, { updateExecutionLease })));
			expect(result.output).toBe(
				`<background_task_id>bind-bash</background_task_id>\n\n` +
					`Background bash task started: ${result.title}\n` +
					'Await({ type: "bash", id: "bind-bash" })',
			);
			expect(result.isError).toBeFalsy();
			expect(updateExecutionLease.transfer).toHaveBeenCalledTimes(1);
			expect(updateExecutionLease.release).not.toHaveBeenCalled();
			expect(events).toEqual(["transfer", "exec"]);
			expect(executions[0].rowsAtSpawn[0]).toMatchObject({
				toolCallId: binding.toolCallId,
				executionAttempt: 1,
				status: "running",
			});
			expect(executions[0].params.cwd).toBe(target.cwd);
			expect(executions[0].handle.isExited()).toBe(false);
			// The parent tool_result ending is not background process-exit evidence.
			await db
				.update(narratorToolCalls)
				.set({ status: "success", completedAt: now })
				.where(eq(narratorToolCalls.id, binding.toolCallId));
			expect(taskRow().status).toBe("running");
			executions[0].send("hello from background\n");
			executions[0].finish();
			await bounded(updateExecutionLease.released);
			expect(updateExecutionLease.release).toHaveBeenCalledTimes(1);
			expect(taskRow()).toMatchObject({
				toolCallId: binding.toolCallId,
				executionAttempt: 1,
				status: "completed",
				output: "hello from background\n",
				exitCode: 0,
			});
		});

		test("concurrent duplicate actual attempts reject the second creation without a second spawn", async () => {
			const binding = await seedCall();
			const results = await Promise.allSettled([run(context(binding)), run(context(binding))]);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			const rejected = results.find((result) => result.status === "rejected");
			expect(rejected?.status === "rejected" && String(rejected.reason)).toContain(
				"already exists for this execution attempt",
			);
			expect(execCommand).toHaveBeenCalledTimes(1);
			expect(taskRow().toolCallId).toBe(binding.toolCallId);
		});

		test("terminal projection does not allow the same actual attempt to spawn again", async () => {
			const binding = await seedCall();
			await run(context(binding));
			executions[0].finish();
			await flush();
			expect(taskRow().status).toBe("completed");
			await expect(run(context(binding))).rejects.toThrow(
				"already exists for this execution attempt",
			);
			expect(execCommand).toHaveBeenCalledTimes(1);
		});

		test("ID generation failure happens before task persistence, lease transfer and spawn", async () => {
			const binding = await seedCall();
			const updateExecutionLease = lease();
			failId = true;
			await expect(run(context(binding, { updateExecutionLease }))).rejects.toThrow(
				"Injected ID generation failure",
			);
			expect(execCommand).not.toHaveBeenCalled();
			expect(updateExecutionLease.transfer).not.toHaveBeenCalled();
			expect(updateExecutionLease.release).not.toHaveBeenCalled();
			expect(db.select().from(backgroundTasks).all()).toEqual([]);
		});

		test("task PK collision rejects before a second spawn", async () => {
			const binding = await seedCall();
			await create(undefined, "bash_collision");
			fixedId = "collision";
			await expect(run(context(binding))).rejects.toThrow();
			expect(execCommand).not.toHaveBeenCalled();
			expect(taskRow().toolCallId).toBeNull();
		});

		test("DB insertion failure cannot transfer the lease or start a process", async () => {
			const binding = await seedCall();
			const updateExecutionLease = lease();
			sqlite.run(
				"CREATE TRIGGER reject_background_insert BEFORE INSERT ON background_tasks BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END",
			);
			await expect(run(context(binding, { updateExecutionLease }))).rejects.toThrow();
			expect(execCommand).not.toHaveBeenCalled();
			expect(updateExecutionLease.transfer).not.toHaveBeenCalled();
			expect(updateExecutionLease.release).not.toHaveBeenCalled();
			expect(db.select().from(backgroundTasks).all()).toEqual([]);
		});

		test("stop by alias cancels only its owner and retains source before and after delayed exit", async () => {
			const binding = await seedCall();
			const updateExecutionLease = lease();
			const ctx = context(binding, { updateExecutionLease });
			await run(ctx);
			const row = taskRow();
			const wrongOwner = await bashTool.execute(
				{ stop: row.id },
				context(undefined, { narratorId: OTHER }),
			);
			expect(wrongOwner.isError).toBe(true);
			expect(wrongOwner.output).toContain("does not belong");
			expect(taskRow().status).toBe("running");
			const listing = await teamStatusTool.execute({ action: "list_bash" }, ctx);
			expect(listing.output).toContain(`id=${row.id}`);
			expect(listing.output).toContain("canCancel=true");
			const result = await bashTool.execute({ stop: row.alias }, ctx);
			expect(result.isError).toBeFalsy();
			expect(result.output).toContain("has been cancelled");
			expect(executions[0].kill).toHaveBeenCalledTimes(1);
			expect(executions[0].params.signal?.aborted).toBe(true);
			expect(taskRow()).toMatchObject({
				status: "cancelled",
				toolCallId: binding.toolCallId,
				executionAttempt: 1,
			});
			expect(executions[0].handle.isExited()).toBe(false);
			expect(updateExecutionLease.release).not.toHaveBeenCalled();
			executions[0].finish(1);
			await bounded(updateExecutionLease.released);
			expect(taskRow()).toMatchObject({
				status: "cancelled",
				toolCallId: binding.toolCallId,
				executionAttempt: 1,
			});
			const stoppedListing = await teamStatusTool.execute({ action: "list_bash" }, ctx);
			expect(stoppedListing.output).toContain("status=cancelled");
			expect(stoppedListing.output).not.toContain("canCancel=true");
		});

		test.each([
			"completed",
			"failed",
			"timeout",
			"cancelled",
		] as const)("%s projection retains provenance even if initiating history is deleted", async (status) => {
			const binding = await seedCall();
			await create(binding);
			await db.delete(narratorToolCalls).where(eq(narratorToolCalls.id, binding.toolCallId));
			if (status === "completed") await backgroundTaskService.markCompleted("bash-direct", "ok", 0);
			if (status === "failed") await backgroundTaskService.markFailed("bash-direct", "error", 1);
			if (status === "timeout")
				await backgroundTaskService.markTimedOut("bash-direct", "timed out", 1);
			if (status === "cancelled") await backgroundTaskService.cancel("bash-direct");
			expect(taskRow()).toMatchObject({
				status,
				toolCallId: binding.toolCallId,
				executionAttempt: 1,
			});
		});

		test("restart stays non-replayable and preserves the source without claiming activity exit", async () => {
			const binding = await seedCall();
			await create(binding);
			expect(
				await backgroundTaskService.recoverStaleTasksAfterRestart(new Set(["bash-direct"])),
			).toBe(1);
			// Restart cannot prove cancellation or replay a possibly executed command.
			// The task projection records an unknown-outcome failure, not activity exit.
			expect(taskRow()).toMatchObject({
				status: "failed",
				output: "Execution outcome unknown after restart; the command was not rerun.",
				toolCallId: binding.toolCallId,
				executionAttempt: 1,
			});
			expect(
				db
					.select({ status: narratorToolCalls.status, attempt: narratorToolCalls.executionAttempt })
					.from(narratorToolCalls)
					.where(eq(narratorToolCalls.id, binding.toolCallId))
					.get(),
			).toEqual({ status: "running", attempt: 1 });
			expect(execCommand).not.toHaveBeenCalled();
			expect(drainPendingInjections(PARENT)).toEqual([]);
		});
	});
}
