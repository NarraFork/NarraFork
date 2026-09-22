import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";
import type { ProviderAdapter } from "../../lib/agent/provider";
import type { ExecuteLoopOptions, ExecuteLoopResult } from "../narrator-executor";
import type { ActiveNarrator } from "../narrator-session-state";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const executor = await import("../narrator-executor");
const { runAgentLoopUnlocked } = await import("../agent-runtime/orchestrator");
const { narratorService } = await import("../narrator-service");
const { getExecutionOwner, tryClaimExecution } = await import("../agent-runtime/ownership");
const { activeNarrators } = await import("../narrator-session-state");
const { updateNarratorModel, updateNarratorReasoningEffort, settleNarratorRuntimeModel } =
	await import("../narrator-session");
const { settings, saveSettings } = await import("../../lib/settings");
const websocket = await import("../../websocket/narrator-ws");
const { nugAvailabilityPoller } = await import("../../lib/nug-availability-poller");
const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
const providerBuilds: string[] = [];
const adapter: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: async (_messages, model) => {
		providerBuilds.push(model);
		return {
			history: [{ protocol: "inheritfixture", source: "rebuilt" }],
			trailingToolResults: [],
		};
	},
	injectSystemPrompt: () => {},
	chat() {
		throw new Error("This runtime test must not contact a provider");
	},
	formatToolResult: () => ({}),
	pushUserTurn: () => {},
	pushAssistantTurn: () => {},
	generate: async () => {
		throw new Error("This runtime test must not generate titles");
	},
	generateWithMeta: async () => {
		throw new Error("This runtime test must not generate summaries");
	},
	generateWithHistory: async () => {
		throw new Error("This runtime test must not generate history");
	},
};
const otherAdapter: ProviderAdapter = {
	...adapter,
	buildHistory: async (_messages, model) => {
		providerBuilds.push(`otherfixture:${model}`);
		return { history: [{ protocol: "otherfixture", source: "rebuilt" }], trailingToolResults: [] };
	},
};
const unregister = registerExternalProviderResolver((name) =>
	name === "inheritfixture" ? adapter : name === "otherfixture" ? otherAdapter : null,
);
const PARENT = "inherit-parent";
const CHILD = "inherit-child";
const A = "inheritfixture:a";
const B = "inheritfixture:b";
const finished: ExecuteLoopResult = {
	finalText: "finished",
	hasError: false,
	shouldUpdateTitle: false,
	completedAssistantTurn: true,
	completedNaturally: true,
};
let broadcasts: Array<Record<string, unknown>> = [];
beforeEach(() => {
	cleanDb(sqlite);
	settings.agent.autoContinuationMode = "off";
	settings.agent.defaultModel = A;
	settings.agent.subagentAllowedModels = { explore: [], plan: [], general: [A, B] };
	settings.agent.subagentModelReasoningEfforts = {};
	providerBuilds.length = 0;
	broadcasts = [];
	spyOn(websocket, "broadcastToNarrator").mockImplementation((_id, event) => {
		broadcasts.push(event as unknown as Record<string, unknown>);
	});
	const now = new Date().toISOString();
	for (const id of [PARENT, CHILD]) {
		db.insert(narrators)
			.values({
				id,
				type: id === CHILD ? "subagent" : "primary",
				variant: id === CHILD ? "subagent:general" : "primary",
				parentNarratorId: id === CHILD ? PARENT : null,
				subagentType: id === CHILD ? "general" : null,
				model: id === CHILD ? FOLLOW_PARENT_MODEL : A,
				cwd: process.env.HOME,
				autoContinuationOverride: "off",
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}
});
afterEach(async () => {
	const active = activeNarrators.get(CHILD);
	if (active) {
		await active._modelRefreshPending;
		getExecutionOwner(CHILD)?.release();
		activeNarrators.delete(CHILD);
	}
	mock.restore();
});
afterAll(() => {
	unregister();
	mock.module("../../db", () => realDb);
});

function writeModel(id: string, model: string) {
	db.update(narrators).set({ model }).where(eq(narrators.id, id)).run();
	updateNarratorModel(id, model);
}

function fixture(
	script: (options: ExecuteLoopOptions, active: ActiveNarrator) => Promise<ExecuteLoopResult>,
	primary = false,
	initialModel = B,
) {
	const active: ActiveNarrator = {
		narratorId: CHILD,
		conversationId: "inherit-conversation",
		cwd: process.env.HOME as string,
		model: B,
		provider: "inheritfixture",
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
	const owner = tryClaimExecution(CHILD, primary ? "primary" : "subagent");
	if (!owner) throw new Error("Missing test execution owner");
	activeNarrators.set(CHILD, active);
	spyOn(executor, "executeAgentLoop").mockImplementation((options) => script(options, active));
	return {
		active,
		run: () =>
			runAgentLoopUnlocked(
				active,
				owner,
				"fixture input",
				undefined,
				primary
					? { kind: "primary" }
					: {
							kind: "subagent",
							parentNarratorId: PARENT,
							parentToolUseId: "inherit-origin",
							subagentType: "general",
							systemPrompt: "fixture prompt",
							initialModel,
							initialHistory: [{ protocol: "obsolete-provider", source: "snapshot" }],
						},
			),
	};
}

describe("shared orchestrator inherited runtime model", () => {
	test("DB inheritance beats initial snapshot; inactive parent changes apply at next request", async () => {
		let checked = false;
		const f = fixture(async ({ config }, active) => {
			expect(active.model).toBe(A);
			expect(config.model).not.toBe(FOLLOW_PARENT_MODEL);
			expect(activeNarrators.has(PARENT)).toBe(false);
			writeModel(PARENT, B);
			const next = await config.getRuntimeSettingsOverride?.();
			expect(next?.model).toBe(B);
			expect(active._modelSelectionRef).toBe(FOLLOW_PARENT_MODEL);
			expect(active.abortController.signal.aborted).toBe(false);
			expect(
				db.select({ model: narrators.model }).from(narrators).where(eq(narrators.id, CHILD)).get()
					?.model,
			).toBe(FOLLOW_PARENT_MODEL);
			checked = true;
			return finished;
		});
		await f.run();
		expect(checked).toBe(true);
		expect(providerBuilds.length).toBeGreaterThan(0);
		expect(providerBuilds).not.toContain(FOLLOW_PARENT_MODEL);
		expect(
			broadcasts.some(
				(event) => event.type === "model_changed" && event.model === FOLLOW_PARENT_MODEL,
			),
		).toBe(true);
		expect(
			broadcasts.some((event) => event.type === "model_settings_changed" && event.model === B),
		).toBe(true);
	});

	test("a DB pin overrides an older executor model and its prebuilt history", async () => {
		db.update(narrators).set({ model: B }).where(eq(narrators.id, CHILD)).run();
		let checked = false;
		const f = fixture(
			async ({ history }, active) => {
				expect(active.model).toBe(B);
				expect(history).toEqual([{ protocol: "inheritfixture", source: "rebuilt" }]);
				checked = true;
				return finished;
			},
			false,
			A,
		);
		await f.run();
		expect(checked).toBe(true);
	});

	test("first-pass followers rebuild history even if an upstream refresh relabelled the old snapshot", async () => {
		const otherModel = "otherfixture:b";
		db.update(narrators).set({ model: otherModel }).where(eq(narrators.id, PARENT)).run();
		settings.agent.subagentAllowedModels.general = [otherModel];
		let checked = false;
		const f = fixture(
			async ({ history, config }, active) => {
				expect(active.model).toBe(otherModel);
				expect(config.provider).toBe("otherfixture");
				expect(history).toEqual([{ protocol: "otherfixture", source: "rebuilt" }]);
				checked = true;
				return finished;
			},
			false,
			otherModel,
		);
		await f.run();
		expect(checked).toBe(true);
	});

	test("a manual selection during pass snapshot loading cannot be overwritten by the stale row", async () => {
		const original = narratorService.getById;
		let reads = 0;
		spyOn(narratorService, "getById").mockImplementation(async (...args) => {
			const row = await original(...args);
			if (args[0] === CHILD && ++reads === 2) writeModel(CHILD, B);
			return row;
		});
		let checked = false;
		const f = fixture(async (_options, active) => {
			expect(active.model).toBe(B);
			expect(active._modelSelectionRef).toBe(B);
			checked = true;
			return finished;
		});
		await f.run();
		expect(checked).toBe(true);
	});

	test("a parent's disallowed model cannot bypass the child's allowed pool", async () => {
		settings.agent.subagentAllowedModels.general = [A];
		let checked = false;
		const f = fixture(async ({ config }, active) => {
			writeModel(PARENT, B);
			await config.getRuntimeSettingsOverride?.();
			expect(active.model).toBe(A);
			checked = true;
			return finished;
		});
		await f.run();
		expect(checked).toBe(true);
	});

	test("manual API selection of __parent__ resolves before supplying an override", async () => {
		db.update(narrators).set({ model: B }).where(eq(narrators.id, CHILD)).run();
		let checked = false;
		const f = fixture(async ({ config }, active) => {
			expect(active.model).toBe(B);
			writeModel(CHILD, FOLLOW_PARENT_MODEL);
			const next = await config.getRuntimeSettingsOverride?.();
			expect(next?.model).toBe(A);
			expect(active._modelRef).toBe(A);
			checked = true;
			return finished;
		});
		await f.run();
		expect(checked).toBe(true);
	});

	test("default changes are rechecked against pool authorization", async () => {
		db.update(narrators).set({ model: "__default__" }).where(eq(narrators.id, PARENT)).run();
		settings.agent.subagentAllowedModels.general = [A];
		let checked = false;
		const f = fixture(async ({ config }, active) => {
			expect(active.model).toBe(A);
			settings.agent.defaultModel = B;
			saveSettings(settings);
			await config.getRuntimeSettingsOverride?.();
			expect(active.model).toBe(A);
			checked = true;
			return finished;
		});
		await f.run();
		expect(checked).toBe(true);
	});

	test("an allowed default change reaches a following child's next request", async () => {
		db.update(narrators).set({ model: "__default__" }).where(eq(narrators.id, PARENT)).run();
		let checked = false;
		const f = fixture(async ({ config }, active) => {
			expect(active.model).toBe(A);
			settings.agent.defaultModel = B;
			saveSettings(settings);
			const next = await config.getRuntimeSettingsOverride?.();
			expect(next?.model).toBe(B);
			expect(active._modelSelectionRef).toBe(FOLLOW_PARENT_MODEL);
			checked = true;
			return finished;
		});
		await f.run();
		expect(checked).toBe(true);
	});

	test("parent changes cancel model-unavailable waiting but do not abort the turn", async () => {
		let passes = 0;
		const f = fixture(async (_options, active) => {
			passes++;
			if (passes === 1) {
				return {
					...finished,
					hasError: true,
					completedNaturally: false,
					modelUnavailable: {
						message: "fixture unavailable",
						provider: "inheritfixture",
						model: A,
						providerId: "fixture-provider",
						nugModelId: "fixture-model",
					},
				};
			}
			expect(active.model).toBe(B);
			expect(active.abortController.signal.aborted).toBe(false);
			return finished;
		});
		const waiting = spyOn(nugAvailabilityPoller, "waitForModelAvailable").mockImplementation(
			async ({ signal }) => {
				const result = new Promise<"aborted">((resolve) => {
					if (signal.aborted) resolve("aborted");
					else signal.addEventListener("abort", () => resolve("aborted"), { once: true });
				});
				writeModel(PARENT, B);
				return result;
			},
		);
		await f.run();
		expect(waiting).toHaveBeenCalledTimes(1);
		expect(passes).toBe(2);
	});

	test("fixed pool reasoning wins over a follower's DB and live manual effort", async () => {
		settings.agent.subagentModelReasoningEfforts = { general: { [A]: "low", [B]: "medium" } };
		db.update(narrators).set({ reasoningEffort: "high" }).where(eq(narrators.id, CHILD)).run();
		let checked = false;
		const f = fixture(async ({ config }, active) => {
			expect(config.reasoningEffort).toBe("low");
			updateNarratorReasoningEffort(CHILD, "high");
			expect(active.reasoningEffort).toBe("low");
			writeModel(PARENT, B);
			const next = await config.getRuntimeSettingsOverride?.();
			expect(next?.reasoningEffort).toBe("medium");
			expect(active._reasoningEffortRef).toBe("high");
			checked = true;
			return finished;
		});
		await f.run();
		expect(checked).toBe(true);
	});

	test("legacy pins keep their own effort and do not acquire the inherited pool effort", async () => {
		settings.agent.subagentModelReasoningEfforts = { general: { [B]: "low" } };
		db.update(narrators)
			.set({ model: B, reasoningEffort: "high" })
			.where(eq(narrators.id, CHILD))
			.run();
		let checked = false;
		const f = fixture(async ({ config }, active) => {
			expect(config.reasoningEffort).toBe("high");
			updateNarratorReasoningEffort(CHILD, "medium");
			expect(active.reasoningEffort).toBe("medium");
			checked = true;
			return finished;
		});
		await f.run();
		expect(checked).toBe(true);
	});

	test("temporary overrides restore the original follower reference in the database", async () => {
		db.update(narrators)
			.set({ model: B, pendingModelRestore: FOLLOW_PARENT_MODEL })
			.where(eq(narrators.id, CHILD))
			.run();
		const f = fixture(async () => finished, true);
		await f.run();
		await settleNarratorRuntimeModel(f.active);
		const row = db.select().from(narrators).where(eq(narrators.id, CHILD)).get();
		expect(row?.model).toBe(FOLLOW_PARENT_MODEL);
		expect(row?.pendingModelRestore).toBeNull();
	});
});
