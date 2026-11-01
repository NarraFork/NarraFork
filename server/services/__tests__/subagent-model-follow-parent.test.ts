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
	const { cleanDb } = await import("../../../tests/setup");
	// The snapshot worker shares the preload-isolated file-backed database.
	const { db, sqlite } = await import("../../db");
	const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");

	const configs: AgentConfig[] = [];
	const executions: ExecuteLoopOptions[] = [];
	const broadcasts: Array<{ target: string; event: Record<string, unknown> }> = [];
	mock.module("../narrator-executor", () => ({
		executeAgentLoop: async (options: ExecuteLoopOptions): Promise<ExecuteLoopResult> => {
			// A finished background child wakes its parent through the ordinary inbox; that
			// parent pass is outside what these cases measure, so only child runs are kept.
			if (options.config.narratorId !== "follow-parent-narrator") {
				configs.push(options.config);
				executions.push(options);
			}
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
	const { narrators, narratorMessages, narratorMessageRefs, narratorToolCalls } = await import(
		"../../db/schema"
	);
	const { narratorService } = await import("../narrator-service");
	const { runSubagent } = await import("../subagent-runner");
	const session = await import("../narrator-session");
	const { getExecutionOwner } = await import("../agent-runtime/ownership");
	const { hasNarratorAdmissionWork } = await import("../narrator-session-state");
	const { backgroundTaskService } = await import("../background-task-service");
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
		await closePrefixSnapshotStore();
		cleanDb(sqlite);
		clearAliasRegistry(PARENT);
		agentCalls = 0;
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
		settings.agent.subagentAllowedModels = { explore: [], plan: [], general: [] };
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

	afterAll(async () => {
		await closePrefixSnapshotStore();
		mock.restore();
	});

	/** A real persisted Agent attempt on the parent that a delegated run can deliver into. */
	let agentCalls = 0;
	async function agentCall() {
		const n = ++agentCalls;
		const now = new Date().toISOString();
		const toolUseId = `${TOOL}-${n}`;
		const messageId = `follow-parent-agent-message-${n}`;
		const toolCallId = `follow-parent-agent-row-${n}`;
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId: PARENT,
			role: "assistant",
			contentJson: [{ type: "tool_use", id: toolUseId, name: "Agent", input: {} }],
			createdAt: now,
		});
		await db
			.insert(narratorMessageRefs)
			.values({ id: `ref-${messageId}`, narratorId: PARENT, messageId, seq: n });
		await db.insert(narratorToolCalls).values({
			id: toolCallId,
			narratorId: PARENT,
			messageId,
			toolUseId,
			toolName: "Agent",
			inputJson: {},
			executionIdentityVersion: 1,
			executionAttempt: 1,
			executionStartedAt: now,
			status: "running",
			createdAt: now,
		});
		return { toolUseId, binding: { toolCallId, attempt: 1 } };
	}

	async function create(model?: string) {
		const call = await agentCall();
		const child = await narratorService.createSubagent({
			parentNarratorId: PARENT,
			originToolCallId: call.binding.toolCallId,
			subagentType: "general",
			title: "follow-parent worker",
			cwd: process.env.HOME as string,
			model,
		});
		await narratorService.updateStatus(child.id, "idle");
		return narratorService.getById(child.id);
	}

	/** Wait until the session's run (started by an input path) has ended. */
	async function settled(subagentId: string, before: number) {
		const runs = () => configs.filter((config) => config.narratorId === subagentId).length;
		const deadline = Date.now() + 3_000;
		while (
			(runs() === before ||
				getExecutionOwner(subagentId) ||
				hasNarratorAdmissionWork(subagentId)) &&
			Date.now() < deadline
		)
			await Bun.sleep(5);
		expect(runs()).toBe(before + 1);
	}

	/**
	 * Run an existing session again through the ordinary entries every session uses:
	 * a new message ("continue") or a bare continue ("resume").
	 */
	async function drive(subagentId: string, entry: "continue" | "resume" = "continue") {
		const before = configs.filter((config) => config.narratorId === subagentId).length;
		if (entry === "resume") {
			const continued = await session.continueNarrator(subagentId, "en", false, null);
			expect(continued.ok).toBe(true);
			await continued.terminal;
		} else {
			await session.sendMessage(
				subagentId,
				"Run with the currently selected model.",
				undefined,
				"en",
				false,
				null,
				null,
			);
		}
		await settled(subagentId, before);
		expect(executions.at(-1)?.config.narratorId).toBe(subagentId);
	}

	async function spawn(
		options: { model?: string; subagentType?: string; background?: boolean } = {},
	) {
		const previous = new Set(
			(await db.query.narrators.findMany({ where: eq(narrators.parentNarratorId, PARENT) })).map(
				(row) => row.id,
			),
		);
		const call = await agentCall();
		await runSubagent({
			parentNarratorId: PARENT,
			toolUseId: call.toolUseId,
			toolCallBinding: call.binding,
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
			const completion = await backgroundTaskService.waitForCompletion(child.id, 3_000);
			expect(completion.status).toBe("completed");
		}
		return narratorService.getById(child.id);
	}

	async function assertRun(
		childId: string,
		model: string,
		stored = FOLLOW_PARENT_MODEL,
		/** Creation events to skip (emitted before a later manual model change). */
		sinceStart = 0,
	) {
		expect(configs.at(-1)).toMatchObject({ narratorId: childId, model });
		expect((await narratorService.getById(childId)).model).toBe(stored);
		expect((await narratorService.getById(childId)).status).toBe("idle");
		// The creation card shows the stored selection: the sentinel when following,
		// otherwise the pinned model the child was created with.
		const starts = broadcasts.filter(
			({ event }) => event.type === "subagent_started" && event.subagentNarratorId === childId,
		);
		for (const start of starts.slice(sinceStart))
			expect(start).toMatchObject({
				target: PARENT,
				event: { model: stored === FOLLOW_PARENT_MODEL ? FOLLOW_PARENT_MODEL : stored },
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

		test("a continued run rebuilds its history from the persisted transcript for the new parent model", async () => {
			// A real delegation: its first run registers where it delivers, so its turns
			// placed under that call are its own top-level history.
			const child = await spawn();
			const savedMarker = "PERSISTED_SUBAGENT_TRANSCRIPT";
			const origin = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.id, child.originToolCallId ?? ""),
			});
			await narratorService.persistSubagentUserMessage(
				child.id,
				savedMarker,
				origin?.toolUseId ?? TOOL,
			);
			await narratorService.updateModel(PARENT, B);
			const before = executions.length;
			await drive(child.id, "resume");
			await assertRun(child.id, B);
			const continued = executions
				.slice(before)
				.filter((run) => run.config.narratorId === child.id);
			expect(continued).toHaveLength(1);
			expect(JSON.stringify(continued[0].history)).toContain(savedMarker);
		});

		test("a materialized legacy delegation keeps its persisted transcript when continued", async () => {
			// A row from before registrations existed: no registration, no policy source.
			// Materialization stores its mount and source, so the turns it placed under that
			// call stay in the model history and it still follows its parent's model.
			const child = await create();
			const origin = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.id, child.originToolCallId ?? ""),
			});
			sqlite.run(
				"UPDATE narrators SET runtime_registration_json = NULL, policy_source_narrator_id = NULL WHERE id = ?",
				[child.id],
			);
			const savedMarker = "LEGACY_PERSISTED_TRANSCRIPT";
			await narratorService.persistSubagentUserMessage(
				child.id,
				savedMarker,
				origin?.toolUseId ?? TOOL,
			);
			const { materializeLegacyDelegations } = await import("../legacy-delegation-materializer");
			expect(await materializeLegacyDelegations([child.id])).toBe(1);
			await drive(child.id, "resume");
			const continued = executions.filter((run) => run.config.narratorId === child.id);
			expect(continued).toHaveLength(1);
			expect(JSON.stringify(continued[0].history)).toContain(savedMarker);
		});

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

		test("a __default__ parent is labelled with the configured default, but still routes live", async () => {
			await narratorService.updateModel(PARENT, FOLLOW_DEFAULT_MODEL);
			const child = await spawn();
			const first = await resolveSubagentModelForRun(await narratorService.getById(child.id));
			// The display never shows the raw sentinel.
			expect(first.model).toBe(A);
			expect(first.inheritance).toMatchObject({ source: "parent", model: A, parentModel: A });
			// Every run re-resolves, so the label tracks a later global change too.
			settings.agent.defaultModel = B;
			const second = await resolveSubagentModelForRun(await narratorService.getById(child.id));
			expect(second.model).toBe(B);
			expect(second.inheritance).toMatchObject({ model: B, parentModel: B });
		});

		test("parent outside the pool falls back legally, stores inheritance, then follows a newly allowed parent", async () => {
			settings.agent.subagentAllowedModels.general = [A];
			const child = await create();
			await narratorService.updateModel(PARENT, B);
			settings.agent.subagentAllowedModels.general = [C];
			await drive(child.id);
			await assertRun(child.id, C);
			expect(await resolveSubagentModelForRun(await narratorService.getById(child.id))).toEqual({
				modelRef: C,
				model: C,
				inheritance: { source: "pool-fallback", model: C, parentModel: B, poolKey: "general" },
			});
			const second = await create();
			await drive(second.id);
			await assertRun(second.id, C);
			settings.agent.subagentAllowedModels.general = [C, B];
			await drive(second.id);
			await assertRun(second.id, B);
		});

		for (const background of [false, true]) {
			for (const poolSource of ["settings", "traits"] as const) {
				test(`${background ? "background" : "foreground"}: ${poolSource} pool's first entry beats an allowed parent and type preference`, async () => {
					settings.agent.subagentModels.explore = B;
					if (poolSource === "settings") {
						settings.agent.subagentAllowedModels.explore = [C, A, B];
					} else {
						const traits = upsertEncodedTrait([], SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, {
							version: 1,
							pools: {
								explore: [{ model: C, reasoningEffort: "max" }, { model: A }, { model: B }],
							},
						});
						await db.update(narrators).set({ traits }).where(eq(narrators.id, PARENT));
					}
					const child = await spawn({ subagentType: "explore", background });
					await assertRun(child.id, C, C);
					if (poolSource === "traits") {
						expect(configs.at(-1)?.reasoningEffort).toBe("max");
					}
					await narratorService.updateModel(PARENT, B);
					await drive(child.id, "resume");
					await assertRun(child.id, C, C);
					const explicit = await spawn({ subagentType: "explore", background, model: A });
					await assertRun(explicit.id, A, A);
					await expect(
						spawn({ subagentType: "explore", model: "anthropic:not-allowed" }),
					).rejects.toThrow("No candidate model");
				});
			}
		}

		test("pool default skips a disallowed parent and global default without an inheritance warning", async () => {
			settings.agent.subagentAllowedModels.general = [C, A];
			await narratorService.updateModel(PARENT, B);
			const child = await spawn();
			await assertRun(child.id, C, C);
			expect(await resolveSubagentModelForRun(await narratorService.getById(child.id))).toEqual({
				modelRef: C,
				model: C,
			});
		});

		test("legacy follow result is reported to the card and fallback is explained to the parent", async () => {
			const { getRecentSubagentModelInheritance, formatSubagentModelFallbackNote } = await import(
				"../subagent-model"
			);
			settings.agent.subagentAllowedModels.general = [A, B];
			const followed = await create();
			await drive(followed.id);
			// The card reads the run's recorded decision (activity snapshot).
			expect(getRecentSubagentModelInheritance(followed.id)).toEqual({
				source: "parent",
				model: A,
				parentModel: A,
				poolKey: "general",
			});
			settings.agent.subagentAllowedModels.general = [C];
			await drive(followed.id);
			const note = formatSubagentModelFallbackNote(getRecentSubagentModelInheritance(followed.id));
			expect(note).toContain(`the parent model "${A}" is not in the allowed "general"`);
			expect(note).toContain(`ran on "${C}" instead`);
		});

		test("reasoning effort: pool tier > child override > parent override > default", async () => {
			const { subagentRunReasoningEffort } = await import("../subagent-model");
			// Parent override reaches a child with no override of its own.
			await narratorService.updateReasoningEffort(PARENT, "high");
			const child = await spawn();
			expect(configs.at(-1)).toMatchObject({ narratorId: child.id, reasoningEffort: "high" });
			const run = await resolveSubagentModelForRun(await narratorService.getById(child.id));
			expect(run.parentReasoningEffort).toBe("high");
			// A later parent change is picked up on the next run.
			await narratorService.updateReasoningEffort(PARENT, "medium");
			await drive(child.id);
			expect(configs.at(-1)).toMatchObject({ narratorId: child.id, reasoningEffort: "medium" });
			// The child's own override wins over the parent.
			await narratorService.updateReasoningEffort(child.id, "low");
			await drive(child.id);
			expect(configs.at(-1)).toMatchObject({ narratorId: child.id, reasoningEffort: "low" });
			// Precedence as a pure rule, including the fixed pool tier.
			expect(
				subagentRunReasoningEffort(
					{ reasoningEffort: "max", parentReasoningEffort: "high" },
					"low",
					"none",
				),
			).toBe("max");
			expect(subagentRunReasoningEffort({ parentReasoningEffort: "high" }, null, "none")).toBe(
				"high",
			);
			expect(subagentRunReasoningEffort({}, null, "none")).toBe("none");
		});

		test("a following child stores no tier; a pinned child keeps its creation snapshot", async () => {
			await narratorService.updateReasoningEffort(PARENT, "high");
			const following = await spawn();
			expect(following.reasoningEffort).toBeNull();
			const pinned = await spawn({ model: A });
			expect(pinned.reasoningEffort).toBe("high");
			await narratorService.updateReasoningEffort(PARENT, "medium");
			await drive(pinned.id);
			expect(configs.at(-1)).toMatchObject({ narratorId: pinned.id, reasoningEffort: "high" });
		});

		test("a rejected type preference uses and pins the pool default", async () => {
			settings.agent.subagentModels.explore = C;
			settings.agent.subagentAllowedModels.explore = [A, B];
			const child = await spawn({ subagentType: "explore" });
			await assertRun(child.id, A, A);
			await narratorService.updateModel(PARENT, B);
			await drive(child.id);
			await assertRun(child.id, A, A);
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
			await assertRun(child.id, C, C, 1);
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
