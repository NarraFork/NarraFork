import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import { createAgentMessageDelivery } from "../agent-message-delivery";
import { readSqliteModelHistorySignature } from "../agent-runtime/model-history-revision";
import { MODEL_HISTORY_REVISION_CONTRACT } from "../agent-runtime/model-history-revision-sql";
import type { ExecuteLoopOptions, ExecuteLoopResult } from "../narrator-executor";
import type { ActiveNarrator } from "../narrator-session-state";

/**
 * Exercises the real shared orchestrator and its control/persistence hooks. Only the
 * low-level model pass is scripted; caller/executor/orchestrator are never mocked.
 * Call snapshots are model-boundary fixture evidence, not proof of upstream processing.
 * Deliberately not covered here: real network/provider serialization, tool authorization,
 * transient backoff timing or full runner publication transactions.
 * Those remain separate integration contracts; custom fallback below checks visibility,
 * not permission enforcement. Each file is intended to run in its own Bun process.
 */
const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const provider = await import("../../lib/agent/provider");
const executor = await import("../narrator-executor");
const { isGitCommandToolResult, runAgentLoopUnlocked } = await import(
	"../agent-runtime/orchestrator"
);
const {
	tryClaimExecution,
	getExecutionOwner,
	getRunHold,
	isExecutionSuspended,
	setRunControl,
	setRunHold,
} = await import("../agent-runtime/ownership");
type RunControl = import("../agent-runtime/ownership").RunControl;
const { controlRun, startNarratorRun } = await import("../agent-runtime/run");
const {
	activeNarrators,
	drainNarratorAdmissionWork,
	getNarratorShutdownPendingCount,
	withNarratorWorkAdmission,
} = await import("../narrator-session-state");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const { settings } = await import("../../lib/settings");
const { createPublicationOutbox } = await import("../agent-runtime/publication-outbox");
const { acceptUserMessage } = await import("../narrator-session");
const { enqueueInboxAgent } = await import("../agent-runtime/inbox");
const MODEL = "orchestratorfixture:model";
const adapter: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async (messages) => ({
		history: messages.map((message) => ({ role: message.role, content: message.contentJson })),
		trailingToolResults: messages.flatMap((message) =>
			(message.toolCalls ?? [])
				.filter((tool) => tool.status === "success")
				.map((tool) => ({
					toolUseId: tool.toolUseId,
					output: tool.outputJson,
				})),
		),
	}),
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("Contract must not contact a model");
	},
	formatToolResult: (toolUseId, output, isError) => ({ toolUseId, output, isError }),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => {
		throw new Error("Contract must not generate titles");
	},
	generateWithMeta: async () => {
		throw new Error("Contract must not generate summaries");
	},
	generateWithHistory: async () => {
		throw new Error("Contract must not generate history");
	},
};
const unregister = provider.registerExternalProviderResolver({
	resolve: (name) => (name === "orchestratorfixture" ? adapter : null),
	listReadiness: () => [],
});
const ids = ["contract-parent", "contract-primary", "contract-child"];
const { compileDelegationCeiling } = await import("../custom-subagent-service");
const { withRuntimePolicyTrait } = await import("../../lib/runtime-policy-trait");
// The delegation's capability ceiling, compiled from its template at creation.
const childCeiling = withRuntimePolicyTrait([], await compileDelegationCeiling("general"));
beforeEach(async () => {
	backgroundOccupancyStore.resetForTests();
	cleanDb(sqlite);
	await backgroundOccupancyStore.start();
	settings.agent.autoContinuationMode = "off";
	const now = new Date().toISOString();
	for (const id of ["principal-a", "principal-b"]) {
		db.insert(users).values({ id, username: id, passwordHash: "fixture", createdAt: now }).run();
	}
	for (const id of ids)
		db.insert(narrators)
			.values({
				id,
				type: id === "contract-child" ? "subagent" : "primary",
				variant: id === "contract-child" ? "subagent:general" : "primary",
				parentNarratorId: id === "contract-child" ? "contract-parent" : null,
				// The delegated run delivers to its Agent call: registered, as startRun does.
				runtimeRegistrationJson:
					id === "contract-child"
						? {
								version: 1,
								run: {
									logicalRunId: "contract-run",
									deliverTo: { narratorId: "contract-parent", toolUseId: "origin-agent" },
								},
							}
						: null,
				traits: id === "contract-child" ? childCeiling : [],
				model: MODEL,
				cwd: process.env.HOME,
				autoContinuationOverride: "off",
				createdAt: now,
				updatedAt: now,
			})
			.run();
	backgroundOccupancyStore.refreshNarrators(ids);
	await backgroundOccupancyStore.flush();
});
afterEach(async () => {
	for (const id of ids) {
		getExecutionOwner(id)?.release();
		activeNarrators.delete(id);
		backgroundOccupancyStore.setRuntimeLive(id, false);
	}
	await backgroundOccupancyStore.flush();
	mock.restore();
});
afterAll(() => {
	backgroundOccupancyStore.resetForTests();
	unregister();
	mock.module("../../db", () => realDb);
});

const finished: ExecuteLoopResult = {
	finalText: "finished",
	hasError: false,
	shouldUpdateTitle: false,
	completedAssistantTurn: true,
	completedNaturally: true,
};
function active(id: string): ActiveNarrator {
	return {
		narratorId: id,
		conversationId: `${id}-conversation`,
		cwd: process.env.HOME as string,
		model: MODEL,
		provider: "orchestratorfixture",
		systemPrompt: null,
		events: new EventEmitter(),
		alive: true,
		locale: "en",
		abortController: new AbortController(),
		_enabledOptionalTools: new Set(),
		_disabledTools: new Set(),
		_blockedSkills: { all: false, names: new Set() },
		_substatus: new Set(),
	};
}
/**
 * Two shapes, one runtime: an ordinary session, and the same kind of session whose run
 * delivers its result to a tool call (the registration seeded above). Nothing else
 * distinguishes them; `kind` only names the fixture row.
 */
type Shape = {
	kind: "primary" | "subagent";
	executionSegmentId?: string;
	parentNarratorId?: string;
	parentToolUseId?: string;
};
const profiles: Shape[] = [
	{ kind: "primary" },
	{
		kind: "subagent",
		executionSegmentId: "profile-child-run-segment",
		parentNarratorId: "contract-parent",
		parentToolUseId: "origin-agent",
	},
];
function fixture(
	profile: Shape,
	script: Array<ExecuteLoopResult | ((options: ExecuteLoopOptions) => Promise<ExecuteLoopResult>)>,
) {
	const id = profile.kind === "primary" ? "contract-primary" : "contract-child";
	const session = active(id);
	const owner = tryClaimExecution(id, "run");
	if (!owner) throw new Error("Missing fixture owner");
	activeNarrators.set(id, session);
	// The live half of the run, as the run service mounts it.
	const runControl: RunControl = {
		startedAt: Date.now(),
		cancel: new AbortController(),
		timedOut: false,
		terminal: new Promise(() => {}),
		...(profile.parentNarratorId && profile.parentToolUseId
			? {
					deliverTo: {
						narratorId: profile.parentNarratorId,
						toolUseId: profile.parentToolUseId,
					},
				}
			: {}),
		executionSegmentId: profile.executionSegmentId,
	};
	setRunControl(owner, runControl);
	backgroundOccupancyStore.setRuntimeLive(id, true);
	const calls: ExecuteLoopOptions[] = [];
	spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
		expect(options.config.executionSegmentId).toBe(profile.executionSegmentId);
		calls.push(options);
		const step = script[calls.length - 1];
		if (!step) throw new Error("Unexpected extra model pass");
		return typeof step === "function" ? step(options) : { ...step };
	});
	return {
		calls,
		owner,
		session,
		runControl,
		run: (text = "same input") => runAgentLoopUnlocked(session, owner, text, undefined, runControl),
	};
}

describe("round token totals at the Stop hook", () => {
	for (const exit of ["normal", "workspace", "tool-limit", "throw"] as const) {
		test(`accounts every owned request before ${exit} exits`, async () => {
			const { hookService } = await import("../hook-service");
			const stopTotals: number[] = [];
			spyOn(hookService, "runHooks").mockImplementation(async (event, input) => {
				if (event === "Stop") stopTotals.push(input.total_tokens as number);
				return { outcome: "success" };
			});
			const h = fixture(profiles[0], [
				async (options) => {
					options.eventContext.accountRequestTokenUsage?.({
						inputTokens: 1000,
						completionTokens: 100,
					});
					options.eventContext.accountRequestTokenUsage?.({
						inputTokens: 1100,
						completionTokens: 100,
					});
					// Latest occupancy deliberately disagrees with request totals.
					options.eventContext.setTokenUsage({ inputTokens: 1, completionTokens: 1 });
					if (exit === "workspace") h.session._workspacePassInvalidated = true;
					if (exit === "tool-limit") options.config.onToolCallLimitExceeded?.(1);
					if (exit === "throw") throw new Error("scripted failure after usage");
					return { ...finished };
				},
				async (options) => {
					options.eventContext.accountRequestTokenUsage?.({ inputTokens: 10, completionTokens: 5 });
					return { ...finished };
				},
			]);
			await h.run();
			expect(stopTotals).toEqual([exit === "workspace" ? 2315 : 2300]);
		});
	}

	test("stale active callbacks cannot charge the replacement narrator or parent", async () => {
		const h = fixture(profiles[1], [
			async (options) => {
				const replacement = active("contract-child");
				activeNarrators.set("contract-child", replacement);
				options.eventContext.accountRequestTokenUsage?.({
					inputTokens: 1000,
					completionTokens: 100,
				});
				expect(replacement._requestTokenTotal).toBeUndefined();
				expect(h.session._requestTokenTotal).toBeUndefined();
				activeNarrators.set("contract-child", h.session);
				return { ...finished };
			},
		]);
		await h.run();
		expect(h.session._requestTokenTotal).toBeUndefined();
	});
});

describe("Bash Git command detection for status refresh", () => {
	test("uses parsed command nodes instead of matching argument text", async () => {
		expect(await isGitCommandToolResult("Bash", { command: "git status" }, "/tmp")).toBe(true);
		expect(await isGitCommandToolResult("Bash", { command: "git commit -m fix" }, "/tmp")).toBe(
			true,
		);
		expect(await isGitCommandToolResult("Bash", { command: "echo ok && git status" }, "/tmp")).toBe(
			true,
		);
		expect(await isGitCommandToolResult("Bash", { command: "echo git" }, "/tmp")).toBe(false);
		expect(await isGitCommandToolResult("Bash", { command: "printf git" }, "/tmp")).toBe(false);
		expect(await isGitCommandToolResult("Write", { command: "git status" }, "/tmp")).toBe(false);
	});
});

describe("tool Git status refresh", () => {
	test("invalidates at the write boundary and shares cached status in the trailing chapter broadcast", async () => {
		const statusCache = await import("../git-status-cache");
		const { gitService } = await import("../git-service");
		const ws = await import("../../websocket/narrator-ws");
		const repo = join(process.env.HOME as string, "git-track-fixture");
		statusCache.clearStatusCache();
		const summary = {
			hasChanges: true,
			staged: 0,
			unstaged: 1,
			untracked: 0,
			totalFiles: 1,
			files: [{ path: "changed.txt", status: " M" }],
			headSha: "fixture-head",
			branch: "feature",
		};
		const { coordinateGitStatusQuery, getLocalGitStatusQueryKey } = await import(
			"../git-status-query"
		);
		const query = mock(async () => summary);
		spyOn(gitService, "getStatusSummary").mockImplementation((path, options) =>
			coordinateGitStatusQuery(getLocalGitStatusQueryKey(path), query, options),
		);
		const ahead = spyOn(gitService, "getCommitsAhead").mockResolvedValue({
			count: 2,
			baseBranch: "main",
		});
		const invalidate = spyOn(statusCache, "invalidateStatus");
		const cachedRead = spyOn(statusCache, "getStatusSummaryCached");
		const broadcast = spyOn(ws, "broadcastToNarrator").mockImplementation(() => {});
		let verified = false;
		const h = fixture(profiles[0], [
			async (options) => {
				h.session._chapterId = "git-track-chapter";
				h.session._worktreePath = repo;
				h.session._baseBranch = "main";
				const scheduled: Array<() => void> = [];
				const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
					callback: () => void,
				) => {
					scheduled.push(callback);
					return scheduled.length as unknown as ReturnType<typeof setTimeout>;
				}) as typeof setTimeout);
				const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {});
				try {
					options.hooks?.onGitTrack?.("Write", "write-1", { file_path: "changed.txt" });
					expect(invalidate).toHaveBeenCalledTimes(1);
					options.hooks?.onGitTrack?.("Edit", "write-2", { file_path: "changed.txt" });
					expect(invalidate).toHaveBeenCalledTimes(2);
					expect(query).not.toHaveBeenCalled();
					expect(clear).toHaveBeenCalledTimes(1);
					expect(scheduled).toHaveLength(2);
				} finally {
					timer.mockRestore();
					clear.mockRestore();
				}

				// A directory subscriber already refreshed after the latest write.
				await statusCache.getStatusSummaryCached(repo);
				expect(query).toHaveBeenCalledTimes(1);
				cachedRead.mockClear();
				scheduled[1]();
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(invalidate).toHaveBeenCalledTimes(2);
				expect(query).toHaveBeenCalledTimes(1);
				expect(cachedRead).toHaveBeenCalledWith(repo);
				expect(ahead).toHaveBeenCalledWith(repo, "main");
				expect(
					broadcast.mock.calls.some(
						([, message]) =>
							message.type === "git_status" &&
							message.toolUseId === "write-2" &&
							message.chapterId === "git-track-chapter" &&
							message.commitsAhead === 2 &&
							message.baseBranch === "main" &&
							!("files" in message.status),
					),
				).toBe(true);
				verified = true;
				return { ...finished };
			},
		]);
		try {
			await h.run();
			expect(h.calls).toHaveLength(1);
			expect(verified).toBe(true);
		} finally {
			statusCache.clearStatusCache();
		}
	});
});

describe("subagent signed source projection", () => {
	function seed() {
		// cleanDb deletes fixture data, including the installation marker, but not shipped triggers.
		// Restore only that private fixture row so these tests exercise a trusted production guard.
		sqlite
			.query(
				"INSERT INTO model_history_revision_contracts (id, installed_version) VALUES ('model-history', ?)",
			)
			.run(MODEL_HISTORY_REVISION_CONTRACT);
		expect(readSqliteModelHistorySignature(sqlite, "contract-child").trusted).toBe(true);
		const now = new Date().toISOString();
		db.insert(narratorMessages)
			.values({
				id: "signed-subagent-history",
				narratorId: "contract-child",
				parentToolUseId: "origin-agent",
				role: "assistant",
				contentJson: [{ type: "text", text: "signed original" }],
				contentText: "signed original",
				createdAt: now,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({
				id: "signed-subagent-ref",
				narratorId: "contract-child",
				messageId: "signed-subagent-history",
				seq: 0,
			})
			.run();
	}
	test("retains trusted raw rows while clearing placement only in detached provider rows", async () => {
		seed();
		const build = adapter.buildHistory;
		let projected = false;
		spyOn(adapter, "buildHistory").mockImplementation(async (...args) => {
			const row = args[0].find((message) => message.id === "signed-subagent-history");
			expect(row?.parentToolUseId).toBeNull();
			projected = true;
			return build(...args);
		});
		const h = fixture(profiles[1], [finished]);
		expect((await h.run()).hasError).toBe(false);
		expect(projected).toBe(true);
		expect(h.calls).toHaveLength(1);
		expect(
			db
				.select()
				.from(narratorMessages)
				.where(eq(narratorMessages.id, "signed-subagent-history"))
				.get()?.parentToolUseId,
		).toBe("origin-agent");
	});
	test("a body edit during detached provider projection sends the loaded snapshot", async () => {
		seed();
		const build = adapter.buildHistory;
		let projected = false;
		spyOn(adapter, "buildHistory").mockImplementation(async (...args) => {
			expect(
				args[0].find((message) => message.id === "signed-subagent-history")?.parentToolUseId,
			).toBeNull();
			projected = true;
			db.update(narratorMessages)
				.set({ contentJson: [{ type: "text", text: "late body edit" }] })
				.where(eq(narratorMessages.id, "signed-subagent-history"))
				.run();
			return build(...args);
		});
		const h = fixture(profiles[1], [finished]);
		expect((await h.run()).hasError).toBe(false);
		expect(projected).toBe(true);
		expect(h.calls).toHaveLength(1);
	});
});

describe("real shared orchestrator profile contract", () => {
	for (const kind of ["references", "bash", "official-references"] as const) {
		test(`primary: spilled ${kind} survive materialization and start the next pass`, async () => {
			const oldHome = process.env.NARRAFORK_HOME;
			const home = mkdtempSync(join(tmpdir(), "nf-orchestrator-spill-"));
			process.env.NARRAFORK_HOME = home;
			const { settings: providerSettings } = await import("../../lib/settings");
			const originalAnthropic = providerSettings.anthropicProviders;
			try {
				const { enqueueBufferedMessage } = await import("../narrator-buffer");
				const service = await import("../narrator-service");
				const bash = spyOn(service, "handleBashCommand").mockResolvedValue({
					type: "bash",
					id: "fixture-bash",
					output: "fixture",
					isError: false,
				});
				const command = `printf '${"x".repeat(3 * 1024)}'`;
				const snapshot = {
					type: "file_reference" as const,
					reference: { id: "ref", deviceId: "local", path: "/saved.ts", label: "saved.ts" },
					snapshotText: "saved-content-".repeat(1024),
					snapshotHash: "hash",
					capturedAt: new Date().toISOString(),
				};
				const official = kind === "official-references";
				const references = kind !== "bash";
				if (official) {
					providerSettings.anthropicProviders = [
						{
							id: "contract-official",
							name: "Official",
							prefix: "contract-official",
							apiKey: "isolated-test-no-network",
							baseUrl: "https://example.invalid/v1",
							defaultModel: "claude-sonnet-4",
							officialApi: true,
						},
					];
					// A system injection lands after the adopted input, before the pass is built.
					const history = await import("../narrator-service");
					const load = history.narratorService.getModelHistorySinceLastCompact.bind(
						history.narratorService,
					);
					let loads = 0;
					spyOn(history.narratorService, "getModelHistorySinceLastCompact").mockImplementation(
						async (...args) => {
							if (++loads === 2) {
								const { deliverInjection } = await import("../narrator-injection");
								await deliverInjection("contract-primary", {
									content: "trailing system hint",
									source: "contract_hint",
								});
							}
							return load(...args);
						},
					);
				}
				let spillPath = "";
				let id = "";
				const h = fixture({ kind: "primary" }, [
					async () => {
						const accepted = await enqueueBufferedMessage(
							"contract-primary",
							"queued prompt",
							undefined,
							null,
							null,
							null,
							undefined,
							"back",
							kind === "bash" ? command : null,
							references ? [snapshot] : undefined,
						);
						expect(accepted.ok).toBe(true);
						id = accepted.id;
						const row = db
							.select()
							.from(narratorBufferedMessages)
							.where(eq(narratorBufferedMessages.id, id))
							.get();
						const metadata = JSON.parse(row?.metadataJson ?? "{}");
						spillPath = kind === "bash" ? metadata.bashCommandPath : metadata.fileReferencesPath;
						expect(existsSync(spillPath)).toBe(true);
						return { ...finished };
					},
					async (options) => {
						expect(existsSync(spillPath)).toBe(false);
						if (references) expect(options.userText).toContain(snapshot.snapshotText);
						if (official) {
							// Official provider: the snapshot is the current input exactly once,
							// never a second copy in history; the trailing sys row is kept.
							expect(options.userText.split(snapshot.snapshotText).length).toBe(2);
							const history = JSON.stringify(options.history);
							expect(history).not.toContain(snapshot.snapshotText);
							// Official semantics: the trailing sys row stays a system message in history.
							expect(options.history).toEqual(
								expect.arrayContaining([
									expect.objectContaining({
										role: "system",
										content: expect.stringContaining("trailing system hint"),
									}),
								]),
							);
						}
						// The Bash double does not append a tool result, so history rebuilding
						// may recover the queued prompt as the trailing current user turn.
						return { ...finished };
					},
				]);
				if (official) {
					h.session.model = "contract-official:claude-sonnet-4";
					h.session.provider = "contract-official";
					db.update(narrators)
						.set({ model: "contract-official:claude-sonnet-4" })
						.where(eq(narrators.id, "contract-primary"))
						.run();
				}
				const result = await h.run();
				expect(result.hasError).toBe(false);
				expect(h.calls).toHaveLength(2);
				expect(
					db
						.select()
						.from(narratorBufferedMessages)
						.where(eq(narratorBufferedMessages.id, id))
						.get()?.state,
				).toBe("materialized");
				if (kind === "bash") {
					expect(bash).toHaveBeenCalledTimes(1);
					expect(bash.mock.calls[0][1]).toBe(command);
				} else expect(bash).not.toHaveBeenCalled();
			} finally {
				providerSettings.anthropicProviders = originalAnthropic;
				if (oldHome === undefined) delete process.env.NARRAFORK_HOME;
				else process.env.NARRAFORK_HOME = oldHome;
				rmSync(home, { recursive: true, force: true });
			}
		});
	}
	test("the run entry inherits runtime character hooks and excludes the legacy summary", async () => {
		const summary = "入口历史摘要😀";
		db.update(narrators)
			.set({
				contextSummary: summary,
				contextSummaryChars: 0,
				systemPrompt: "actual entry custom policy",
			})
			.where(eq(narrators.id, "contract-child"))
			.run();
		let systemPrompt = "";
		backgroundOccupancyStore.refreshNarrator("contract-child");
		await backgroundOccupancyStore.flush();
		const pass = spyOn(executor, "executeAgentLoop").mockImplementation(async (options) => {
			systemPrompt = options.config.systemPrompt ?? "";
			expect(systemPrompt).toContain(summary);
			// A run that delivers to a call gets a file-change segment of its own.
			expect(options.config.executionSegmentId).toBeString();
			await options.config.onToolsCharacters?.(456);
			return finished;
		});
		const handle = await startNarratorRun({
			narratorId: "contract-child",
			locale: "en",
			text: "entry input",
			principal: null,
			deliver: false,
		});
		const result = await handle.terminal;
		expect(result.hasError).toBe(false);
		expect(pass).toHaveBeenCalledTimes(1);
		expect(
			db.select().from(narrators).where(eq(narrators.id, "contract-child")).get(),
		).toMatchObject({
			contextSystemChars: systemPrompt.length - summary.length,
			contextToolsChars: 456,
			contextSummaryChars: 0,
		});
	});

	for (const profile of profiles) {
		test(`${profile.kind}: clearing compact summary clears its character cache without changing history version`, async () => {
			const h = fixture(profile, [
				async (options) => {
					const before = db
						.select()
						.from(narrators)
						.where(eq(narrators.id, h.session.narratorId))
						.get();
					expect(before?.contextSummaryChars).toBe(6);
					expect(options.hooks?.onClearCompactSummary).toBeFunction();
					await options.hooks?.onClearCompactSummary?.();
					const after = db
						.select()
						.from(narrators)
						.where(eq(narrators.id, h.session.narratorId))
						.get();
					expect(after?.contextSummary).toBeNull();
					expect(after?.contextSummaryChars).toBe(0);
					expect(after?.messageVersion).toBe(before?.messageVersion);
					return finished;
				},
			]);
			db.update(narrators)
				.set({ contextSummary: "cached", contextSummaryChars: 6 })
				.where(eq(narrators.id, h.session.narratorId))
				.run();
			backgroundOccupancyStore.refreshNarrator(h.session.narratorId);
			await backgroundOccupancyStore.flush();
			expect((await h.run()).hasError).toBe(false);
		});

		test(`${profile.kind}: final prompt and bound tools character callback reach runtime cache`, async () => {
			const summary = "持久摘要😀";
			// The session's own stored base prompt, for either shape.
			db.update(narrators)
				.set({ systemPrompt: "actual custom session prompt" })
				.where(eq(narrators.id, profile.kind === "primary" ? "contract-primary" : "contract-child"))
				.run();
			const h = fixture(profile, [
				async (options) => {
					await options.config.onToolsCharacters?.(321);
					const row = db
						.select()
						.from(narrators)
						.where(eq(narrators.id, h.session.narratorId))
						.get();
					expect(row?.contextSystemChars).toBe(
						(options.config.systemPrompt?.length ?? 0) - summary.length,
					);
					expect(row?.contextToolsChars).toBe(321);
					return finished;
				},
			]);
			db.update(narrators)
				.set({ contextSummary: summary, contextSummaryChars: 0 })
				.where(eq(narrators.id, h.session.narratorId))
				.run();
			backgroundOccupancyStore.refreshNarrator(h.session.narratorId);
			await backgroundOccupancyStore.flush();
			expect((await h.run()).hasError).toBe(false);
		});

		test(`${profile.kind}: detached ownership outlives the loop admission lease`, async () => {
			const tail = Promise.withResolvers<void>();
			let tracked: Promise<void> | undefined;
			const h = fixture(profile, [
				async (options) => {
					const track = options.config.trackDetachedToolResult;
					if (!track) throw new Error("Missing detached owner callback");
					tracked = track(tail.promise);
					return finished;
				},
			]);
			try {
				await withNarratorWorkAdmission(h.session.narratorId, () => h.run());
				expect(getNarratorShutdownPendingCount()).toBeGreaterThan(0);
				let drained = false;
				const drain = drainNarratorAdmissionWork(new AbortController().signal).then(() => {
					drained = true;
				});
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(drained).toBe(false);
				tail.resolve();
				await drain;
				expect(drained).toBe(true);
				expect(getNarratorShutdownPendingCount()).toBe(0);
			} finally {
				tail.resolve();
				await tracked;
			}
		});

		test(`${profile.kind}: production detached callback persists after the loop has returned`, async () => {
			const h = fixture(profile, [finished]);
			await h.run();
			const callback = h.calls[0].config.onDetachedToolResult;
			expect(callback).toBeFunction();
			if (!callback) throw new Error("Missing production detached callback");
			const narratorId = h.session.narratorId;
			const now = new Date().toISOString();
			await db.insert(narratorMessages).values({
				id: "detached-message",
				narratorId,
				role: "assistant",
				parentToolUseId: profile.kind === "subagent" ? profile.parentToolUseId : null,
				contentJson: [{ type: "tool_use", id: "detached-call", name: "Write", input: {} }],
				createdAt: now,
			});
			await db.insert(narratorMessageRefs).values({
				id: "detached-ref",
				narratorId,
				messageId: "detached-message",
				seq: 100,
			});
			await db.insert(narratorToolCalls).values({
				id: "detached-row",
				narratorId,
				messageId: "detached-message",
				toolUseId: "detached-call",
				toolName: "Write",
				inputJson: {},
				executionAttempt: 1,
				executionIdentityVersion: 1,
				status: "fail",
				errorMessage: "Narrator interrupted by user",
				createdAt: now,
			});
			await callback({
				type: "tool_result",
				toolUseId: "detached-call",
				toolName: "Write",
				toolCallBinding: { toolCallId: "detached-row", attempt: 1 },
				output: "actual post-abort output",
				isError: false,
			});
			expect(
				await db.query.narratorToolCalls.findFirst({
					where: eq(narratorToolCalls.id, "detached-row"),
				}),
			).toMatchObject({
				status: "success",
				errorMessage: null,
				outputJson: "actual post-abort output",
			});
		});

		test(`${profile.kind}: one completed pass retains model input and profile event identity`, async () => {
			const h = fixture(profile, [finished]);
			const result = await h.run();
			expect(result).toMatchObject({ started: true, finalText: "finished", hasError: false });
			expect(h.calls).toHaveLength(1);
			expect(h.calls[0].userText).toBe('<sender kind="system" />\nsame input');
			expect(h.calls[0].config.model).toBe(MODEL);
			expect(h.calls[0].eventContext).toMatchObject({
				narratorId: h.session.narratorId,
				broadcastTargetId: profile.kind === "primary" ? h.session.narratorId : "contract-parent",
				parentToolUseId: profile.kind === "primary" ? undefined : "origin-agent",
			});
		});

		test(`${profile.kind}: payment-required result fails the run without another model pass`, async () => {
			const h = fixture(profile, [
				{
					...finished,
					completedNaturally: false,
					paymentRequired: { message: "fixture balance exhausted", resumeAction: "retry" },
				},
			]);
			const result = await h.run();
			expect(result).toMatchObject({ started: true, hasError: true });
			expect(h.calls).toHaveLength(1);
			expect(result.lastPass?.paymentRequired?.message).toBe("fixture balance exhausted");
		});

		test(`${profile.kind}: exhausted stateless provider retry cannot multiply into outer model calls`, async () => {
			const diagnostics = {
				schema: "narrafork.error-diagnostics.v1" as const,
				recordingRequestId: "exhausted-attempt",
				apiRequestId: "exhausted-row",
				requestId: "upstream-exhausted",
			};
			const h = fixture(profile, [
				{
					...finished,
					completedNaturally: false,
					retryableError: "fixture exhausted provider retries",
					retryableDiagnostics: diagnostics,
				},
			]);
			const result = await h.run();
			expect(result).toMatchObject({ started: true, hasError: true });
			expect(h.calls).toHaveLength(1);
			expect(result.lastPass?.retryableError).toBe("fixture exhausted provider retries");
			const rows = db
				.select()
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, h.session.narratorId))
				.all();
			expect(rows.find((row) => row.contentText?.startsWith("[Error]"))?.contentJson).toEqual([
				{ type: "error", message: "fixture exhausted provider retries", diagnostics },
			]);
		});

		test(`${profile.kind}: resumable continuation exhaustion persists the last failure's exact request`, async () => {
			const attempts = Array.from({ length: 4 }, (_, index) => ({
				...finished,
				completedNaturally: false,
				interrupted: true,
				interruptedReason: "resumable_error" as const,
				interruptionError: `upstream failure ${index}`,
				interruptionDiagnostics: {
					schema: "narrafork.error-diagnostics.v1" as const,
					recordingRequestId: `resume-attempt-${index}`,
					apiRequestId: `resume-row-${index}`,
					requestId: `upstream-resume-${index}`,
				},
			}));
			const h = fixture(profile, attempts);
			const result = await h.run();
			expect(result).toMatchObject({ hasError: true, finalText: "upstream failure 3" });
			expect(h.calls).toHaveLength(4);
			const rows = db
				.select()
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, h.session.narratorId))
				.all();
			expect(rows.find((row) => row.contentText?.startsWith("[Error]"))?.contentJson).toEqual([
				{
					type: "error",
					message: "upstream failure 3",
					diagnostics: attempts[3].interruptionDiagnostics,
				},
			]);
		});

		for (const naturallyDone of [true, false]) {
			test(`${profile.kind}: late compact ${naturallyDone ? "does not restart natural completion" : "replays interrupted history exactly once"}`, async () => {
				const { markActiveHistoryCompactPending, hasPendingHistoryCompact } = await import(
					"../narrator-session-state"
				);
				const h = fixture(profile, [
					async (options) => {
						expect(markActiveHistoryCompactPending(options.config.narratorId, 2)).toBe(true);
						return { ...finished, completedNaturally: naturallyDone };
					},
					finished,
				]);
				const result = await h.run();
				expect(result.hasError).toBe(false);
				expect(h.calls).toHaveLength(naturallyDone ? 1 : 2);
				if (!naturallyDone) {
					expect(h.calls[1].userText).toBe("");
					expect(hasPendingHistoryCompact(h.session.narratorId)).toBe(false);
				}
			});
		}

		test(`${profile.kind}: interrupted continuation rebuilds history and takes exactly one extra pass`, async () => {
			const h = fixture(profile, [
				{
					...finished,
					completedNaturally: false,
					interrupted: true,
					interruptedReason: "completion_limit",
				},
				finished,
			]);
			const result = await h.run();
			expect(result.hasError).toBe(false);
			expect(h.calls).toHaveLength(2);
			const rows = db
				.select()
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, h.session.narratorId))
				.all();
			expect(rows.filter((row) => row.role === "user")).toHaveLength(1);
			expect(rows[0].origin).toBe("system");
			const content = rows[0].contentText;
			if (!content) throw new Error("Continuation must persist nonempty prompt text");
			expect(JSON.stringify(h.calls[1].history)).toContain(content);
			expect(h.calls[1].config.model).toBe(h.calls[0].config.model);
			expect(getExecutionOwner(h.session.narratorId)).toBe(h.owner);
		});

		test(`${profile.kind}: pure tool replay does not fabricate a continuation user message`, async () => {
			const h = fixture(profile, [
				async (options) => {
					const narratorId = options.config.narratorId;
					const now = new Date().toISOString();
					db.insert(narratorMessages)
						.values({
							id: "replay-message",
							narratorId,
							role: "assistant",
							contentJson: [{ type: "tool_use", id: "read-replay", name: "Read", input: {} }],
							createdAt: now,
						})
						.run();
					db.insert(narratorMessageRefs)
						.values({ id: "replay-ref", narratorId, messageId: "replay-message", seq: 1 })
						.run();
					db.insert(narratorToolCalls)
						.values({
							id: "replay-tool",
							narratorId,
							messageId: "replay-message",
							toolUseId: "read-replay",
							toolName: "Read",
							status: "success",
							executionIdentityVersion: 1,
							executionAttempt: 2,
							outputJson: "persisted replay output",
							createdAt: now,
						})
						.run();
					return {
						...finished,
						completedNaturally: false,
						interrupted: true,
						shouldReplayInterruptedToolResultTurn: true,
					};
				},
				finished,
			]);
			const result = await h.run();
			expect(result.hasError).toBe(false);
			expect(h.calls.map((call) => call.userText)).toEqual([
				'<sender kind="system" />\nsame input',
				"",
			]);
			expect(
				db.select().from(narratorMessages).where(eq(narratorMessages.role, "user")).all(),
			).toEqual([]);
			expect(h.calls[1].trailingToolResults).toEqual([
				{ toolUseId: "read-replay", output: "persisted replay output" },
			]);
		});

		test(`${profile.kind}: actual after-tools materialization remains unadopted until its request callback`, async () => {
			const h = fixture(profile, [
				async (options) => {
					const store = createPublicationOutbox(db);
					const run = {
						producerKind: "agent" as const,
						taskId: "contract-parent",
						recipientId: h.session.narratorId,
						logicalRunId: "after-tools-run",
					};
					// Completion notices project the immutable result snapshot, not the
					// intent's scheduling summary. Seed the same pointer a real producer uses.
					db.insert(narratorMessages)
						.values({
							id: "after-tools-result",
							narratorId: "contract-parent",
							role: "assistant",
							contentJson: [{ type: "text", text: "after-tools ready" }],
							contentText: "after-tools ready",
							createdAt: new Date().toISOString(),
						})
						.run();
					store.reserveRunSlots(run);
					store.commitIntent({
						...run,
						eventKind: "completed",
						summary: "after-tools ready",
						resultRef: "message-original:after-tools-result",
					});
					store.transferNext(h.session.narratorId, "agent");
					const injection = await options.config.getAfterToolsInjections?.();
					expect(typeof injection).toBe("object");
					if (!injection || typeof injection === "string")
						throw new Error("Missing adoption packet");
					expect(injection.text).toContain("after-tools ready");
					const before = db.select().from(narratorBufferedMessages).get();
					expect(before).toMatchObject({ state: "materialized", adoptedAt: null });
					expect(injection.onConsumed).toBeFunction();
					injection.onConsumed?.();
					await new Promise<void>((resolve) => setImmediate(resolve));
					expect(db.select().from(narratorBufferedMessages).get()?.adoptedAt).toBeString();
					return finished;
				},
			]);
			expect((await h.run()).hasError).toBe(false);
			expect(h.calls).toHaveLength(1);
		});
	}

	for (const scenario of [
		{ name: "feedback soft-stop", recipient: "principal-a", softStop: true },
		{ name: "different principal", recipient: "principal-b", softStop: false },
	]) {
		test(`child ${scenario.name} stays queued until the next pass adopts its exact user`, async () => {
			const order: string[] = [];
			const feedback = `${scenario.name} input`;
			const h = fixture(profiles[1], [
				async (options) => {
					expect(options.config.userId).toBe("principal-a");
					const accepted = await acceptUserMessage("contract-child", feedback, {
						userId: scenario.recipient,
						queueMode: scenario.softStop ? "tool" : "turn",
						queueOnly: true,
					});
					if (!accepted.buffered) throw new Error("expected queued input");
					order.push("queued");
					if (scenario.softStop) expect(await options.config.shouldStop?.()).toBe(true);
					const injection = await options.config.getAfterToolsInjections?.();
					const text = typeof injection === "string" ? injection : injection?.text;
					expect(text ?? "").not.toContain(feedback);
					expect(
						db
							.select()
							.from(narratorBufferedMessages)
							.where(eq(narratorBufferedMessages.id, accepted.id))
							.get()?.state,
					).toBe("queued");
					order.push("old-pass-stopped");
					return { ...finished, completedNaturally: false, hadToolUses: true };
				},
				async (options) => {
					expect(options.config.userId).toBe(scenario.recipient);
					expect(options.userText).toContain(feedback);
					order.push("feedback-before-next-tool");
					const message = db
						.select()
						.from(narratorMessages)
						.where(eq(narratorMessages.contentText, feedback))
						.get();
					expect(message).toMatchObject({
						createdBy: scenario.recipient,
						parentToolUseId: "origin-agent",
					});
					return finished;
				},
			]);
			h.session._currentUserId = "principal-a";
			expect((await h.run()).hasError).toBe(false);
			expect(h.calls).toHaveLength(2);
			expect(order).toEqual(["queued", "old-pass-stopped", "feedback-before-next-tool"]);
		});
	}

	test("same-principal child Send input can adopt after tools with real dual placement and no new pass", async () => {
		const ws = await import("../../websocket/narrator-ws");
		const broadcast = spyOn(ws, "broadcastToNarrator").mockImplementation(() => {});
		const text = "same principal after-tools input";
		const h = fixture(profiles[1], [
			async (options) => {
				// Direct human input has an explicit queue mode and restarts a pass.
				// The in-pass conversational path is a receipted parent Send delivery.
				const now = new Date().toISOString();
				db.insert(narratorMessages)
					.values({
						id: "after-tools-send",
						narratorId: "contract-parent",
						role: "assistant",
						contentJson: [],
						createdAt: now,
					})
					.run();
				db.insert(narratorToolCalls)
					.values({
						id: "after-tools-send-call",
						narratorId: "contract-parent",
						messageId: "after-tools-send",
						toolUseId: "after-tools-send-use",
						toolName: "Send",
						status: "running",
						executionAttempt: 1,
						executionIdentityVersion: 1,
						createdAt: now,
					})
					.run();
				const delivery = createAgentMessageDelivery(
					"contract-child",
					{
						id: "contract-parent",
						title: "Parent",
						label: "parent",
						type: "primary",
						isParent: true,
					},
					"after-tools-send-use",
					text,
					{ toolCallId: "after-tools-send-call", attempt: 1 },
				);
				const accepted = (await enqueueInboxAgent(delivery, text, { createdBy: "principal-a" }))
					.delivery;
				expect(await options.config.shouldStop?.()).toBe(false);
				const packet = await options.config.getAfterToolsInjections?.();
				if (!packet || typeof packet === "string") throw new Error("Missing after-tools packet");
				expect(packet.text).toContain(text);
				const row = db
					.select()
					.from(narratorBufferedMessages)
					.where(eq(narratorBufferedMessages.id, accepted.id))
					.get();
				expect(row).toMatchObject({ state: "materialized", adoptedAt: null });
				const message = db
					.select()
					.from(narratorMessages)
					.where(eq(narratorMessages.id, row?.recipientMessageId ?? ""))
					.get();
				// The Send author is the message's attribution; placement follows the run.
				expect(message?.contentText).toContain(text);
				expect(message).toMatchObject({ parentToolUseId: "origin-agent" });
				// One adopted agent message, projected to both audiences (the session's own
				// page and the destination's tool card) by the one injection writer.
				const projected = broadcast.mock.calls.filter(
					([, event]) =>
						(event.type === "message" || event.type === "user_message") &&
						typeof event.message === "object" &&
						event.message !== null &&
						"id" in event.message &&
						event.message.id === message?.id,
				);
				expect(projected.map(([id]) => id)).toEqual(["contract-parent", "contract-child"]);
				packet.onConsumed?.();
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(
					db
						.select()
						.from(narratorBufferedMessages)
						.where(eq(narratorBufferedMessages.id, accepted.id))
						.get()?.adoptedAt,
				).toBeString();
				return finished;
			},
		]);
		h.session._currentUserId = "principal-a";
		expect((await h.run()).hasError).toBe(false);
		expect(h.calls).toHaveLength(1);
	});

	test("missing custom child definition retains readonly fallback in the real pass policy", async () => {
		const { toolRegistry } = await import("../../lib/agent/tool-registry");
		// A custom template missing at creation compiles fail-closed.
		db.update(narrators)
			.set({
				variant: "subagent:custom-missing-definition",
				traits: withRuntimePolicyTrait(
					[],
					await compileDelegationCeiling("custom-missing-definition"),
				),
			})
			.where(eq(narrators.id, "contract-child"))
			.run();
		const h = fixture(profiles[1], [finished]);
		expect((await h.run()).hasError).toBe(false);
		const read = toolRegistry.get("Read");
		const write = toolRegistry.get("Write");
		if (!read || !write) throw new Error("Core tools must be registered");
		expect(h.calls[0].config.toolFilter?.(read)).toBe(true);
		expect(h.calls[0].config.toolFilter?.(write)).toBe(false);
	});

	test("child stream reaches both audiences through the real event handler with different origin projection", async () => {
		const ws = await import("../../websocket/narrator-ws");
		const { processEvent } = await import("../narrator-event-handler");
		const broadcast = spyOn(ws, "broadcastToNarrator").mockImplementation(() => {});
		const h = fixture(profiles[1], [
			async (options) => {
				await processEvent(
					{ type: "stream_text", text: "child output" },
					options.eventContext,
					options.hooks,
				);
				return finished;
			},
		]);
		expect((await h.run()).hasError).toBe(false);
		const stream = broadcast.mock.calls.filter(([, message]) => message.type === "stream_event");
		expect(stream).toHaveLength(2);
		expect(stream[0]).toEqual([
			"contract-parent",
			expect.objectContaining({
				event: expect.objectContaining({
					subagentToolUseId: "origin-agent",
					subagentNarratorId: "contract-child",
				}),
			}),
		]);
		expect(stream[1][0]).toBe("contract-child");
		expect(stream[1][1]).toMatchObject({ event: { delta: { text: "child output" } } });
		expect(JSON.stringify(stream[1][1])).not.toContain("subagentToolUseId");
	});

	test("child doing Spec work exhausts the real per-run continuation budget without changing task status", async () => {
		const { writeSpecFile, readSpecFile } = await import("../spec-vfs-service");
		const { resolveNarratorRuntimePolicy } = await import("../trait-layer-service");
		const MAX_SUBAGENT_CONTINUATION_PASSES = (await resolveNarratorRuntimePolicy("contract-child"))
			.continuation.maxPasses;
		if (MAX_SUBAGENT_CONTINUATION_PASSES === null)
			throw new Error("Expected a compiled delegation budget");
		await db
			.update(narrators)
			.set({ autoContinuationOverride: "always" })
			.where(eq(narrators.id, "contract-child"));
		await writeSpecFile(
			"contract-child",
			"spec://tasks.json",
			JSON.stringify({ tasks: [{ text: "finite fixture work", status: "doing" }] }),
		);
		const h = fixture(
			profiles[1],
			Array.from({ length: MAX_SUBAGENT_CONTINUATION_PASSES + 1 }, () => ({
				...finished,
				hadToolUses: true,
			})),
		);
		const result = await h.run();
		expect(result.hasError).toBe(false);
		expect(h.calls).toHaveLength(MAX_SUBAGENT_CONTINUATION_PASSES + 1);
		expect(result.finalText).toContain("budget");
		expect((await readSpecFile("contract-child", "spec://tasks.json"))?.content).toContain(
			'"doing"',
		);
	});

	/** Hold the fixture run; the returned function waits until it parks at the hold. */
	function heldRun(h: ReturnType<typeof fixture>) {
		setRunHold(h.session.narratorId, { released: false });
		return async () => {
			const deadline = Date.now() + 3_000;
			while (!h.runControl.wake) {
				if (Date.now() > deadline) throw new Error("Held run never parked");
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
		};
	}
	async function queueUserInput(id: string, text: string) {
		const { enqueueBufferedMessage } = await import("../narrator-buffer");
		const accepted = await enqueueBufferedMessage(id, text);
		expect(accepted.ok).toBe(true);
	}
	/** End a parked/running fixture run so the test can await it. */
	async function endRun(h: ReturnType<typeof fixture>, run: Promise<unknown>) {
		h.runControl.cancel.abort("cleanup");
		h.runControl.wake?.("cancel");
		setRunHold(h.session.narratorId, undefined);
		await run;
	}

	for (const profile of profiles) {
		test(`${profile.kind}: a held run parks on the same owner and resumes for queued input`, async () => {
			const h = fixture(profile, [finished, finished]);
			const parked = heldRun(h);
			const run = h.run();
			try {
				await parked();
				expect(isExecutionSuspended(h.session.narratorId)).toBe(true);
				expect(tryClaimExecution(h.session.narratorId, "run")).toBeNull();
				await queueUserInput(h.session.narratorId, "manual resume");
				// Released first, so the next natural completion ends the run.
				setRunHold(h.session.narratorId, { released: true });
				h.runControl.wake?.("input");
				expect((await run).hasError).toBe(false);
				expect(h.calls).toHaveLength(2);
				expect(h.calls[1].userText).toContain("manual resume");
				expect(getExecutionOwner(h.session.narratorId)).toBe(h.owner);
			} finally {
				await endRun(h, run);
			}
		});

		test(`${profile.kind}: Stop of a held turn parks the run instead of ending it`, async () => {
			/*
			 * A local Stop aborts the session's turn controller. For a held run that ends
			 * the current turn only: the run parks at its hold (same owner, same run, no
			 * delivery) and the user's next input continues it.
			 */
			const h = fixture(profile, [
				async () => {
					expect(await controlRun(h.session.narratorId, { kind: "stop" })).toBe(true);
					expect(h.runControl.cancel.signal.aborted).toBe(false);
					return { ...finished, aborted: true, completedNaturally: false };
				},
				finished,
			]);
			const parked = heldRun(h);
			const run = h.run();
			try {
				await parked();
				expect(getRunHold(h.session.narratorId)).toBeDefined();
				expect(isExecutionSuspended(h.session.narratorId)).toBe(true);
				expect(getExecutionOwner(h.session.narratorId)).toBe(h.owner);
				await queueUserInput(h.session.narratorId, "after stop");
				setRunHold(h.session.narratorId, { released: true });
				h.runControl.wake?.("input");
				const result = await run;
				expect(result.hasError).toBe(false);
				expect(h.calls).toHaveLength(2);
				expect(h.calls[1].userText).toContain("after stop");
			} finally {
				await endRun(h, run);
			}
		});

		test(`${profile.kind}: a stop during a transient-retry backoff also parks a held run`, async () => {
			/*
			 * A stop can land at any await of a pass. One during the retry backoff must
			 * reach the same hold transition, not the retry's own abort exit.
			 */
			const recovery = await import("../narrator-recovery");
			let h: ReturnType<typeof fixture> | undefined;
			spyOn(recovery, "handleTransientError").mockImplementation(async () => {
				if (h) await controlRun(h.session.narratorId, { kind: "stop" });
				return { shouldRetry: false, delayMs: 0 };
			});
			h = fixture(profile, [
				// A silent disconnect takes the backoff path even on a stateless provider.
				{
					...finished,
					completedNaturally: false,
					completedAssistantTurn: false,
					silentDisconnect: true,
				},
				finished,
			]);
			const fixtureRun = h;
			const parked = heldRun(fixtureRun);
			const run = fixtureRun.run();
			try {
				await parked();
				expect(getRunHold(fixtureRun.session.narratorId)).toBeDefined();
				expect(fixtureRun.runControl.cancel.signal.aborted).toBe(false);
				await queueUserInput(fixtureRun.session.narratorId, "after backoff stop");
				setRunHold(fixtureRun.session.narratorId, { released: true });
				fixtureRun.runControl.wake?.("input");
				expect((await run).hasError).toBe(false);
				expect(fixtureRun.calls.at(-1)?.userText).toContain("after backoff stop");
			} finally {
				await endRun(fixtureRun, run);
			}
		});

		test(`${profile.kind}: a Stop of a run that is NOT held ends the run`, async () => {
			const h = fixture(profile, [
				async () => {
					expect(await controlRun(h.session.narratorId, { kind: "stop" })).toBe(true);
					return { ...finished, aborted: true, completedNaturally: false };
				},
			]);
			const result = await h.run();
			expect(result.aborted).toBe(true);
			expect(h.calls).toHaveLength(1);
			expect(h.runControl.wake).toBeUndefined();
			expect(h.runControl.cancel.signal.aborted).toBe(true);
		});

		test(`${profile.kind}: interrupt input cancels current IO and is adopted in the same run`, async () => {
			const h = fixture(profile, [
				async (options) => {
					const { acceptUserMessage } = await import("../narrator-session");
					const accepted = await acceptUserMessage(h.session.narratorId, "urgent input", {
						queueMode: "interrupt",
					});
					expect(accepted.buffered).toBe(true);
					// The current provider request / tool IO is cancelled…
					expect(options.config.urgentGuidanceSignal?.aborted).toBe(true);
					// …but not the turn, the run or its caller, and no user interrupt is recorded.
					expect(options.config.signal.aborted).toBe(false);
					expect(h.runControl.cancel.signal.aborted).toBe(false);
					return { ...finished, completedNaturally: false, hadToolUses: true };
				},
				async (options) => {
					expect(options.userText).toContain("urgent input");
					// Each pass gets a fresh urgent channel.
					expect(options.config.urgentGuidanceSignal?.aborted).toBe(false);
					return finished;
				},
			]);
			const result = await h.run();
			expect(result.hasError).toBe(false);
			expect(result.aborted).toBeFalsy();
			expect(h.calls).toHaveLength(2);
			expect(getExecutionOwner(h.session.narratorId)).toBe(h.owner);
			expect(
				db
					.select({ reason: narrators.lastStopReason })
					.from(narrators)
					.where(eq(narrators.id, h.session.narratorId))
					.get()?.reason,
			).not.toBe("user_interrupt");
		});

		test(`${profile.kind}: interrupt input to a held run is adopted in the same run, hold kept`, async () => {
			const h = fixture(profile, [
				async (options) => {
					const { acceptUserMessage } = await import("../narrator-session");
					await acceptUserMessage(h.session.narratorId, "held urgent", { queueMode: "interrupt" });
					expect(options.config.urgentGuidanceSignal?.aborted).toBe(true);
					expect(options.config.signal.aborted).toBe(false);
					return { ...finished, completedNaturally: false, hadToolUses: true };
				},
				async (options) => {
					expect(options.userText).toContain("held urgent");
					return finished;
				},
			]);
			const parked = heldRun(h);
			const run = h.run();
			try {
				await parked();
				expect(h.calls).toHaveLength(2);
				expect(getRunHold(h.session.narratorId)).toEqual({ released: false });
				expect(h.runControl.cancel.signal.aborted).toBe(false);
			} finally {
				await endRun(h, run);
			}
		});
	}

	test("PG finalizer/consumption contract has no SQLite cleanup fallthrough", async () => {
		const source = await Bun.file(
			new URL("../agent-runtime/orchestrator.ts", import.meta.url),
		).text();
		expect(source).toContain("cleanupBufferedTextFilesAsync");
		expect(source).not.toContain("cleanupBufferedTextFiles(");
		expect(source).toContain("function hasPostgresRuntime()");
		expect(source).toContain("Skipping pending model restore");
		expect(source).toContain("Skipping persisted transient substatus cleanup");
		expect(source).not.toContain("const narr = await db.query.narrators.findFirst");
		const subagentSource = await Bun.file(
			new URL("../subagent-executor.ts", import.meta.url),
		).text();
		expect(subagentSource).not.toContain("cleanupBufferedTextFiles(");
	});
});

for (const profile of profiles) {
	test(`${profile.kind}: real keyword knowledge hit has the same system sender live and in history`, async () => {
		const { knowledgeService } = await import("../knowledge-service");
		const { narratorPersistence } = await import("../narrator-persistence");
		const { buildRuntimeHistory } = await import("../agent-runtime/history");
		const { projectMessageSenderText } = await import("../../lib/agent/sender-projection");
		const previousMode = settings.knowledge.injectMode;
		settings.knowledge.injectMode = "summary";
		try {
			const collection = await knowledgeService.createCollection({
				name: `Sender knowledge ${profile.kind}`,
				ownerUserId: "principal-a",
			});
			const keyword = `senderkeyword${profile.kind}`;
			const entry = await knowledgeService.createEntry({
				collectionId: collection.id,
				title: `Sender regression ${profile.kind}`,
				content: "Real knowledge evidence",
				keywords: [keyword],
				authorUserId: "principal-a",
			});
			const h = fixture(profile, [finished]);
			h.session._currentUserId = "principal-a";
			const request = `Please recall ${keyword}`;
			await narratorPersistence.persistUserMessage(
				h.session.narratorId,
				request,
				undefined,
				undefined,
				"principal-a",
				undefined,
				profile.kind === "subagent" ? { parentToolUseId: profile.parentToolUseId } : undefined,
			);
			expect((await h.run(request)).hasError).toBe(false);
			expect(h.calls).toHaveLength(1);
			const rawMessages = await (
				await import("../narrator-service")
			).narratorService.getModelHistorySinceLastCompact(h.session.narratorId);
			const knowledge = rawMessages.find(
				(message) => message.role === "sys" && message.contentText?.includes(entry.id),
			);
			if (!knowledge?.contentText)
				throw new Error("Real keyword lookup did not persist a knowledge hit");
			const projected = projectMessageSenderText(knowledge, knowledge.contentText);
			expect(projected).toStartWith('<sender kind="system" />\n');
			expect(h.calls[0].userText).toStartWith(
				'<sender kind="human" id="principal-a" name="principal-a" />\n',
			);
			expect(h.calls[0].userText).toContain(`\n\n${projected}`);
			expect(h.calls[0].userText.match(/<sender kind="system"/g)).toHaveLength(1);
			expect(knowledge.contentText).not.toContain("<sender ");
			const rebuilt = await buildRuntimeHistory({
				narratorId: h.session.narratorId,
				model: MODEL,
				provider: "orchestratorfixture",
				sourceMessages: rawMessages,
			});
			expect(JSON.stringify(rebuilt.history)).toContain(JSON.stringify(projected).slice(1, -1));
			expect(h.session._currentUserId).toBe("principal-a");
		} finally {
			settings.knowledge.injectMode = previousMode;
		}
	});
}
