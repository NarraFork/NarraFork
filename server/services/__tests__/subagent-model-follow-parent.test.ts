import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { FOLLOW_PARENT_MODEL } from "../../../shared/model-inheritance";
import type { AgentConfig } from "../../lib/agent";
import type { ExecuteLoopOptions, ExecuteLoopResult } from "../narrator-executor";

const CHILD_ENV = "NARRAFORK_SUBAGENT_MODEL_FOLLOW_TEST_CHILD";

// Service module mocks must never escape into another test file's module registry.
if (process.env[CHILD_ENV] !== "1") {
	test("subagent model inheritance: isolated real-DB execution chain", async () => {
		const env: NodeJS.ProcessEnv = { ...process.env, [CHILD_ENV]: "1" };
		delete env.NARRAFORK_HOME;
		const child = Bun.spawn([process.execPath, "test", "--isolate", import.meta.path], {
			cwd: resolve(import.meta.dir, "../../.."),
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const timer = setTimeout(() => child.kill(), 45_000);
		const readBounded = async (stream: ReadableStream<Uint8Array>) => {
			const reader = stream.getReader();
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				bytes += value.byteLength;
				if (bytes > 512 * 1024) {
					child.kill();
					throw new Error("Isolated test output exceeded 512 KiB");
				}
				chunks.push(value);
			}
			return Buffer.concat(chunks).toString("utf8");
		};
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				readBounded(child.stdout),
				readBounded(child.stderr),
			]);
			expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
			expect(stderr).toContain("0 fail");
			expect(stderr).toMatch(/[1-9]\d* pass/);
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null) child.kill();
		}
	}, 50_000);
} else {
	const { eq } = await import("drizzle-orm");
	const { getTestDb, cleanDb } = await import("../../../tests/setup");
	const { db, sqlite } = getTestDb();
	mock.module("../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

	const configs: AgentConfig[] = [];
	const executions: ExecuteLoopOptions[] = [];
	const broadcasts: Array<{ target: string; event: Record<string, unknown> }> = [];
	mock.module("../narrator-executor", () => ({
		executeAgentLoop: async (options: ExecuteLoopOptions): Promise<ExecuteLoopResult> => {
			configs.push(options.config);
			executions.push(options);
			return {
				finalText: "isolated follow-parent result",
				hasError: false,
				shouldUpdateTitle: false,
				completedAssistantTurn: true,
				completedNaturally: true,
			};
		},
	}));
	const realCompletionQueue = { ...(await import("../bg-completion-queue")) };
	mock.module("../bg-completion-queue", () => ({
		...realCompletionQueue,
		pushBgCompletionNotification: () => {},
	}));
	const realWebsocket = { ...(await import("../../websocket/narrator-ws")) };
	mock.module("../../websocket/narrator-ws", () => ({
		...realWebsocket,
		broadcastToNarrator: (target: string, event: Record<string, unknown>) => {
			broadcasts.push({ target, event });
		},
	}));
	const { gitService } = await import("../git-service");
	spyOn(gitService, "isGitRepo").mockResolvedValue(false);
	const network = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			() => {
				throw new Error("Network access is forbidden in the follow-parent test");
			},
			{ preconnect: () => {} },
		),
	);
	const { settings, FOLLOW_DEFAULT_MODEL } = await import("../../lib/settings");
	const { narrators } = await import("../../db/schema");
	const { narratorService } = await import("../narrator-service");
	const { runSubagent, startContinuedSubagent, waitForBackgroundTask } = await import(
		"../subagent-runner"
	);
	const { resumeSubagent } = await import("../subagent-resume");
	const { resolveSubagentModelForRun } = await import("../subagent-model");
	const { clearAliasRegistry } = await import("../subagent-alias");
	const { upsertEncodedTrait, SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX } = await import(
		"../../lib/narrator-custom-traits"
	);
	const A = "anthropic:claude-sonnet-4-20250514";
	const B = "anthropic:claude-opus-4-20250514";
	const C = "anthropic:claude-3-5-haiku-20241022";
	const PARENT = "follow-parent-narrator";
	const TOOL = "follow-parent-agent-tool";

	beforeEach(async () => {
		cleanDb(sqlite);
		clearAliasRegistry(PARENT);
		configs.length = 0;
		executions.length = 0;
		broadcasts.length = 0;
		network.mockClear();
		settings.anthropicProviders = [
			{
				id: "isolated-anthropic",
				name: "Isolated test adapter",
				prefix: "anthropic",
				apiKey: "not-a-real-api-key",
				baseUrl: "https://subagent-follow-parent.invalid",
				defaultModel: "claude-sonnet-4-20250514",
			},
		];
		settings.agent.defaultModel = A;
		settings.agent.defaultReasoningEffort = "low";
		settings.agent.subagentModels = { explore: "", plan: "", search: "", review: "" };
		settings.agent.subagentAllowedModels = { explore: [A, B, C], plan: [], general: [A, B, C] };
		settings.agent.subagentModelReasoningEfforts = {};
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: PARENT,
			type: "primary",
			variant: "primary",
			model: A,
			cwd: process.env.HOME,
			createdAt: now,
			updatedAt: now,
		});
	});

	afterAll(() => {
		mock.restore();
		sqlite.close();
	});

	async function create(model?: string) {
		const child = await narratorService.createSubagent({
			parentNarratorId: PARENT,
			subagentType: "general",
			subagentOriginKind: "standalone",
			cwd: process.env.HOME as string,
			model,
		});
		await narratorService.updateStatus(child.id, "idle");
		return narratorService.getById(child.id);
	}

	async function drive(subagentId: string, entry: "continue" | "resume" = "continue") {
		const started =
			entry === "resume"
				? await resumeSubagent({
						subagentId,
						intent: "follow_up",
						actor: "user",
						prompt: "Run with the currently selected model.",
						locale: "en",
						skipConclusionDelivery: true,
					})
				: await startContinuedSubagent({
						subagentId,
						parentNarratorId: PARENT,
						toolUseId: TOOL,
						prompt: "Run with the currently selected model.",
						signal: new AbortController().signal,
						locale: "en",
					});
		expect(started.terminalCompletion).toBeDefined();
		expect(await started.terminalCompletion).toContain("isolated follow-parent result");
	}

	async function spawn(
		options: { model?: string; subagentType?: string; background?: boolean } = {},
	) {
		const previous = new Set(configs.map((config) => config.narratorId));
		await runSubagent({
			parentNarratorId: PARENT,
			toolUseId: TOOL,
			subagentType: options.subagentType ?? "general",
			prompt: "Return without using tools.",
			cwd: process.env.HOME as string,
			title: "follow-parent worker",
			signal: new AbortController().signal,
			locale: "en",
			...options,
		});
		const rows = await db.query.narrators.findMany({
			where: eq(narrators.parentNarratorId, PARENT),
			limit: 10,
		});
		const fresh = rows.filter((row) => !previous.has(row.id));
		expect(fresh).toHaveLength(1);
		const child = fresh[0];
		if (options.background) {
			const completion = await waitForBackgroundTask(child.id, 3_000);
			expect(completion.status).toBe("completed");
		}
		return narratorService.getById(child.id);
	}

	async function assertRun(childId: string, model: string, stored = FOLLOW_PARENT_MODEL) {
		expect(configs.at(-1)).toMatchObject({ narratorId: childId, model });
		expect((await narratorService.getById(childId)).model).toBe(stored);
		expect((await narratorService.getById(childId)).status).toBe("idle");
		const starts = broadcasts.filter(({ event }) => event.type === "subagent_started");
		expect(starts.at(-1)).toMatchObject({
			target: PARENT,
			event: {
				subagentNarratorId: childId,
				model: stored === FOLLOW_PARENT_MODEL ? FOLLOW_PARENT_MODEL : model,
			},
		});
		expect(network).not.toHaveBeenCalled();
	}

	describe("live parent model through real creation, continuation and executor configuration", () => {
		for (const entry of ["continue", "resume"] as const) {
			test(`${entry}: real create stores inheritance and re-reads parent A -> B`, async () => {
				const child = await create();
				expect(child.model).toBe(FOLLOW_PARENT_MODEL);
				await drive(child.id, entry);
				await assertRun(child.id, A);
				await narratorService.updateModel(PARENT, B);
				await drive(child.id, entry);
				await assertRun(child.id, B);
				expect(configs.map((config) => config.model)).toEqual([A, B]);
			});
		}

		for (const background of [false, true]) {
			test(`${background ? "background" : "foreground"}: new spawn and existing continuation follow B`, async () => {
				const first = await spawn({ background });
				await assertRun(first.id, A);
				await narratorService.updateModel(PARENT, B);
				const second = await spawn({ background });
				await assertRun(second.id, B);
				await drive(first.id);
				await assertRun(first.id, B);
			});
		}

		for (const pin of ["explicit", "type preference"] as const) {
			test(`${pin}: parent A -> B leaves the selected child pinned to A`, async () => {
				if (pin === "type preference") settings.agent.subagentModels.explore = A;
				const options = pin === "explicit" ? { model: A } : { subagentType: "explore" };
				const first = await spawn(options);
				await assertRun(first.id, A, A);
				await narratorService.updateModel(PARENT, B);
				await drive(first.id);
				await assertRun(first.id, A, A);
				const second = await spawn(options);
				await assertRun(second.id, A, A);
			});
		}

		for (const historyModel of [A, undefined]) {
			test(`prepared history from ${historyModel ?? "an unspecified model"} is rebuilt after parent switches to B`, async () => {
				const child = await create();
				const savedMarker = "PERSISTED_SUBAGENT_TRANSCRIPT";
				const preparedMarker = "PREPARED_HISTORY_FOR_OLD_MODEL";
				await narratorService.persistSubagentUserMessage(child.id, savedMarker, TOOL);
				await narratorService.updateModel(PARENT, B);
				const started = await startContinuedSubagent({
					subagentId: child.id,
					parentNarratorId: PARENT,
					toolUseId: TOOL,
					prompt: "Continue using the current model, not the old prepared transcript.",
					signal: new AbortController().signal,
					locale: "en",
					initialHistory: [{ role: "user", content: preparedMarker }],
					initialTrailingToolResults: [],
					initialHistoryModel: historyModel,
				});
				expect(await started.terminalCompletion).toContain("isolated follow-parent result");
				await assertRun(child.id, B);
				const childExecutions = executions.filter((run) => run.config.narratorId === child.id);
				expect(childExecutions).toHaveLength(1);
				const history = JSON.stringify(childExecutions[0].history);
				expect(history).not.toContain(preparedMarker);
				expect(history).toContain(savedMarker);
			});
		}

		test("parent __default__ follows a changed global model on both resume and new spawn", async () => {
			await narratorService.updateModel(PARENT, FOLLOW_DEFAULT_MODEL);
			const first = await spawn();
			await assertRun(first.id, A);
			settings.agent.defaultModel = B;
			await drive(first.id, "resume");
			await assertRun(first.id, B);
			const second = await spawn();
			await assertRun(second.id, B);
			expect((await narratorService.getById(PARENT)).model).toBe(FOLLOW_DEFAULT_MODEL);
		});

		test("parent outside the pool falls back legally, stores inheritance, then follows a newly allowed parent", async () => {
			settings.agent.subagentAllowedModels.general = [A];
			const child = await spawn();
			await narratorService.updateModel(PARENT, B);
			settings.agent.subagentAllowedModels.general = [C];
			await drive(child.id);
			await assertRun(child.id, C);
			expect(await resolveSubagentModelForRun(await narratorService.getById(child.id))).toEqual({
				modelRef: C,
				model: C,
			});
			const second = await spawn();
			await assertRun(second.id, C);
			settings.agent.subagentAllowedModels.general = [C, B];
			await drive(second.id);
			await assertRun(second.id, B);
		});

		test("a rejected type preference does not pin a fallback child", async () => {
			settings.agent.subagentModels.explore = C;
			settings.agent.subagentAllowedModels.explore = [A, B];
			const child = await spawn({ subagentType: "explore" });
			await assertRun(child.id, A);
			await narratorService.updateModel(PARENT, B);
			await drive(child.id);
			await assertRun(child.id, B);
		});

		test("a later type preference does not replace a following child's parent", async () => {
			const child = await spawn({ subagentType: "explore" });
			settings.agent.subagentModels.explore = A;
			await narratorService.updateModel(PARENT, B);
			await drive(child.id);
			await assertRun(child.id, B);
		});

		for (const entry of ["continue", "resume"] as const) {
			test(`${entry}: a newly explicit-empty trait pool refuses execution, as does a new spawn`, async () => {
				const child = await spawn();
				const traits = upsertEncodedTrait([], SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, {
					version: 1,
					pools: { general: [] },
				});
				await db.update(narrators).set({ traits }).where(eq(narrators.id, PARENT));
				await expect(drive(child.id, entry)).rejects.toThrow("No models are allowed");
				await expect(spawn()).rejects.toThrow("No models are allowed");
				expect(configs).toHaveLength(1);
				expect((await narratorService.getById(child.id)).model).toBe(FOLLOW_PARENT_MODEL);
				expect((await narratorService.getById(child.id)).status).toBe("idle");
			});
		}

		test("manually changing a child to a concrete model stops following", async () => {
			const child = await spawn();
			await narratorService.updateModel(child.id, C);
			await narratorService.updateModel(PARENT, B);
			await drive(child.id, "resume");
			await assertRun(child.id, C, C);
		});

		test("legacy concrete rows stay pinned, while legacy null rows use the global model", async () => {
			const concrete = await create(A);
			const legacyNull = await create();
			await db.update(narrators).set({ model: null }).where(eq(narrators.id, legacyNull.id));
			await narratorService.updateModel(PARENT, B);
			settings.agent.defaultModel = C;
			await drive(concrete.id);
			await assertRun(concrete.id, A, A);
			await drive(legacyNull.id);
			expect(configs.at(-1)).toMatchObject({ narratorId: legacyNull.id, model: C });
			expect((await narratorService.getById(legacyNull.id)).model).toBeNull();
			expect(
				await resolveSubagentModelForRun(await narratorService.getById(legacyNull.id)),
			).toEqual({
				modelRef: FOLLOW_DEFAULT_MODEL,
				model: C,
			});
			expect(network).not.toHaveBeenCalled();
		});

		test("queued /new on a FOLLOW_PARENT source materializes the model instead of the sentinel", async () => {
			const child = await spawn();
			expect(child.model).toBe(FOLLOW_PARENT_MODEL);
			const { executeQueuedNewCommand } = await import("../narrator-session");
			const active = {
				narratorId: child.id,
				cwd: process.env.HOME as string,
			} as Parameters<typeof executeQueuedNewCommand>[0];
			const newId = await executeQueuedNewCommand(
				active,
				{
					id: "queued-new-follow-parent",
					text: "/new",
					bufferedAt: new Date().toISOString(),
					createdBy: null,
				},
				"",
			);
			const created = await narratorService.getById(newId);
			// The new session is an independent primary: materialized pin, not inheritance.
			expect(created.model).toBe(A);
			expect(created.type).toBe("primary");
			expect(created.model).not.toBe(FOLLOW_PARENT_MODEL);
			await narratorService.updateModel(PARENT, B);
			expect((await narratorService.getById(newId)).model).toBe(A);
		});

		test("queued /new keeps a concrete source model unchanged", async () => {
			const child = await spawn({ model: C });
			expect(child.model).toBe(C);
			const { executeQueuedNewCommand } = await import("../narrator-session");
			const active = {
				narratorId: child.id,
				cwd: process.env.HOME as string,
			} as Parameters<typeof executeQueuedNewCommand>[0];
			const newId = await executeQueuedNewCommand(
				active,
				{
					id: "queued-new-concrete",
					text: "/new",
					bufferedAt: new Date().toISOString(),
					createdBy: null,
				},
				"",
			);
			expect((await narratorService.getById(newId)).model).toBe(C);
		});

		test("queued /new materializes the live parent model after a parent switch", async () => {
			const child = await spawn();
			await narratorService.updateModel(PARENT, B);
			const { executeQueuedNewCommand } = await import("../narrator-session");
			const active = {
				narratorId: child.id,
				cwd: process.env.HOME as string,
			} as Parameters<typeof executeQueuedNewCommand>[0];
			const newId = await executeQueuedNewCommand(
				active,
				{
					id: "queued-new-after-switch",
					text: "/new",
					bufferedAt: new Date().toISOString(),
					createdBy: null,
				},
				"",
			);
			expect((await narratorService.getById(newId)).model).toBe(B);
		});
	});
}
