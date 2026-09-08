import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import type { ReasoningEffort } from "../../../shared/reasoning-effort";
import type { AgentConfig } from "../../lib/agent";
import type { ExecuteLoopOptions, ExecuteLoopResult } from "../narrator-executor";

const CHILD_ENV = "NARRAFORK_SUBAGENT_EFFORT_TEST_CHILD";

// Bun module mocks survive mock.restore(). Keep all service mocks in a fresh test
// process, including when this file is part of a larger test invocation. Running
// the same file avoids a fixture that might accidentally be discovered separately.
if (process.env[CHILD_ENV] !== "1") {
	test("subagent reasoning effort: isolated real-DB execution chain", async () => {
		const env: NodeJS.ProcessEnv = { ...process.env, [CHILD_ENV]: "1" };
		// Let tests/preload.ts allocate the child's own HOME and database directory.
		delete env.NARRAFORK_HOME;
		const child = Bun.spawn([process.execPath, "test", import.meta.path], {
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
	mock.module("../../db", () => ({ db, sqlite }));

	const configs: AgentConfig[] = [];
	const broadcasts: Array<{ target: string; event: Record<string, unknown> }> = [];
	mock.module("../narrator-executor", () => ({
		executeAgentLoop: async ({ config }: ExecuteLoopOptions): Promise<ExecuteLoopResult> => {
			configs.push(config);
			return {
				finalText: "isolated model result",
				hasError: false,
				shouldUpdateTitle: false,
				completedAssistantTurn: true,
				completedNaturally: true,
			};
		},
	}));
	// Completing a background child must not wake a real primary narrator loop.
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
	// These sessions have no worktree; avoid even a git probe in this test.
	const { gitService } = await import("../git-service");
	spyOn(gitService, "isGitRepo").mockResolvedValue(false);
	const forbiddenFetch = Object.assign(
		() => {
			throw new Error("Network access is forbidden in the subagent effort test");
		},
		{ preconnect: () => {} },
	);
	const network = spyOn(globalThis, "fetch").mockImplementation(forbiddenFetch);
	const { settings } = await import("../../lib/settings");
	const { narrators, narratorMessages } = await import("../../db/schema");
	const { narratorService } = await import("../narrator-service");
	const realCreateSubagent = narratorService.createSubagent;
	const creationInputs: Parameters<typeof realCreateSubagent>[0][] = [];
	spyOn(narratorService, "createSubagent").mockImplementation((input) => {
		creationInputs.push(input);
		return realCreateSubagent.call(narratorService, input);
	});
	const { runSubagent, startContinuedSubagent, waitForBackgroundTask } = await import(
		"../subagent-runner"
	);
	const { upsertEncodedTrait, SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX } = await import(
		"../../lib/narrator-custom-traits"
	);
	const encodeSubagentModelsTrait = (pools: Record<string, unknown[]>) =>
		upsertEncodedTrait([], SUBAGENT_MODEL_RESTRICTION_TRAIT_PREFIX, { version: 1, pools })[0];
	const { clearAliasRegistry } = await import("../subagent-alias");
	const { activeSubagentSettings } = await import("../narrator-session-state");
	const MODEL = "anthropic:claude-sonnet-4-20250514";
	const PARENT = "reasoning-effort-parent";
	const TOOL = "reasoning-effort-agent-tool";

	beforeEach(() => {
		cleanDb(sqlite);
		clearAliasRegistry(PARENT);
		configs.length = 0;
		creationInputs.length = 0;
		broadcasts.length = 0;
		network.mockClear();
		// History rebuilding uses the real adapter but can never send a request:
		// execution is mocked below it, fetch throws, and this endpoint is invalid.
		settings.anthropicProviders = [
			{
				id: "isolated-anthropic",
				name: "Isolated test adapter",
				prefix: "anthropic",
				apiKey: "not-a-real-api-key",
				baseUrl: "https://subagent-effort.invalid",
				defaultModel: "claude-sonnet-4-20250514",
			},
		];
		settings.agent.defaultModel = MODEL;
		settings.agent.defaultReasoningEffort = "low";
		settings.agent.subagentAllowedModels = { explore: [], plan: [], general: [MODEL] };
		settings.agent.subagentModelReasoningEfforts = {};
	});

	afterAll(() => {
		mock.restore();
		sqlite.close();
	});

	async function seedParent(effort: ReasoningEffort | null = null, traits: string[] = []) {
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: PARENT,
			type: "primary",
			variant: "primary",
			model: MODEL,
			reasoningEffort: effort,
			traits,
			cwd: process.env.HOME,
			createdAt: now,
			updatedAt: now,
		});
	}

	async function run(effort?: ReasoningEffort, background = false) {
		const result = await runSubagent({
			parentNarratorId: PARENT,
			toolUseId: TOOL,
			subagentType: "general",
			prompt: "Return an isolated test result without tools.",
			cwd: process.env.HOME as string,
			title: "reasoning effort worker",
			signal: new AbortController().signal,
			locale: "en",
			model: MODEL,
			reasoningEffort: effort,
			background,
		});
		const rows = await db.query.narrators.findMany({
			where: eq(narrators.parentNarratorId, PARENT),
			limit: 2,
		});
		expect(rows).toHaveLength(1);
		const child = rows[0];
		if (background) {
			expect(result).toContain("background");
			const completion = await waitForBackgroundTask(child.id, 3_000);
			expect(completion.status).toBe("completed");
			expect(completion.result).toContain("isolated model result");
		} else {
			expect(result).toContain("isolated model result");
		}
		return narratorService.getById(child.id);
	}

	async function assertChain(
		child: Awaited<ReturnType<typeof run>>,
		stored: ReasoningEffort | null,
		effective: ReasoningEffort,
		runs = 1,
	) {
		expect(creationInputs).toHaveLength(1);
		expect(child.reasoningEffort).toBe(stored);
		expect(child.model).toBe(MODEL);
		expect(child.status).toBe("idle");
		expect(configs.filter((config) => config.narratorId === child.id)).toHaveLength(runs);
		expect(configs.at(-1)).toMatchObject({
			narratorId: child.id,
			parentNarratorId: PARENT,
			model: MODEL,
			reasoningEffort: effective,
		});
		const starts = broadcasts.filter(({ event }) => event.type === "subagent_started");
		expect(starts).toHaveLength(runs);
		expect(starts.at(-1)).toMatchObject({
			target: PARENT,
			event: {
				subagentNarratorId: child.id,
				toolUseId: TOOL,
				model: MODEL,
				reasoningEffort: effective,
			},
		});
		const messages = await db.query.narratorMessages.findMany({
			where: eq(narratorMessages.narratorId, child.id),
			limit: 10,
		});
		expect(messages.filter((message) => message.role === "user")).toHaveLength(runs);
		expect(messages[0].parentToolUseId).toBe(TOOL);
		expect(activeSubagentSettings.has(child.id)).toBe(false);
		expect(network).not.toHaveBeenCalled();
	}

	describe("runSubagent -> real creation/SQLite -> real executor config and start event", () => {
		for (const background of [false, true]) {
			for (const [fixed, explicit] of [
				["high", "medium"],
				["none", "high"],
				["medium", "high"],
			] as const) {
				test(`${background ? "background" : "foreground"}: fixed ${fixed} overrides ${explicit}`, async () => {
					await seedParent("xhigh");
					settings.agent.subagentModelReasoningEfforts = { general: { [MODEL]: fixed } };
					const child = await run(explicit, background);
					expect(creationInputs[0].reasoningEffort).toBe(fixed);
					await assertChain(child, fixed, fixed);
				});
			}
		}

		test("unconfigured pool preserves the explicit tool effort", async () => {
			await seedParent("high");
			await assertChain(await run("medium"), "medium", "medium");
			expect(creationInputs[0].reasoningEffort).toBe("medium");
		});

		test("unconfigured pool inherits the parent's explicit effort", async () => {
			await seedParent("high");
			await assertChain(await run(), "high", "high");
			expect(creationInputs[0].reasoningEffort).toBeUndefined();
		});

		for (const mapState of ["missing", "empty", "unmatched"] as const) {
			test(`${mapState} effort map follows global default without persisting it`, async () => {
				await seedParent();
				if (mapState === "missing") delete settings.agent.subagentModelReasoningEfforts;
				if (mapState === "unmatched") {
					settings.agent.subagentModelReasoningEfforts = {
						general: { "anthropic:other-model": "high" },
						explore: { [MODEL]: "max" },
					};
				}
				await assertChain(await run(), null, "low");
				expect(creationInputs[0].reasoningEffort).toBeUndefined();
			});
		}

		test("trait pool fixed effort reaches real creation and executor", async () => {
			await seedParent("xhigh", [
				encodeSubagentModelsTrait({ general: [{ model: MODEL, reasoningEffort: "high" }] }),
			]);
			await assertChain(await run("medium"), "high", "high");
		});

		test("trait pool without effort does not inherit the global pool's fixed effort", async () => {
			await seedParent("xhigh", [encodeSubagentModelsTrait({ general: [{ model: MODEL }] })]);
			settings.agent.subagentModelReasoningEfforts = { general: { [MODEL]: "high" } };
			await assertChain(await run("medium"), "medium", "medium");
		});

		for (const background of [false, true]) {
			test(`${background ? "background" : "foreground"} continuation retains saved effort after parent and pool changes`, async () => {
				await seedParent("medium");
				settings.agent.subagentModelReasoningEfforts = { general: { [MODEL]: "high" } };
				const child = await run("medium", background);
				await assertChain(child, "high", "high");
				settings.agent.subagentModelReasoningEfforts = { general: { [MODEL]: "none" } };
				await db.update(narrators).set({ reasoningEffort: "low" }).where(eq(narrators.id, PARENT));
				const continued = await startContinuedSubagent({
					subagentId: child.id,
					parentNarratorId: PARENT,
					toolUseId: TOOL,
					prompt: "Continue the same isolated task.",
					signal: new AbortController().signal,
					locale: "en",
					preserveBackground: background,
				});
				expect(await continued.terminalCompletion).toContain("isolated model result");
				await assertChain(await narratorService.getById(child.id), "high", "high", 2);
			});
		}

		test("continuation with null effort follows changed global default, not new parent pool", async () => {
			await seedParent();
			const child = await run();
			await assertChain(child, null, "low");
			settings.agent.defaultReasoningEffort = "xhigh";
			settings.agent.subagentModelReasoningEfforts = { general: { [MODEL]: "none" } };
			const continued = await startContinuedSubagent({
				subagentId: child.id,
				parentNarratorId: PARENT,
				toolUseId: TOOL,
				prompt: "Continue with the current global default.",
				signal: new AbortController().signal,
				locale: "en",
			});
			expect(await continued.terminalCompletion).toContain("isolated model result");
			await assertChain(await narratorService.getById(child.id), null, "xhigh", 2);
		});
	});
}
