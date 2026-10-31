import { describe, expect, spyOn, test } from "bun:test";
import * as runtimeHistory from "../agent-runtime/history";
import * as epochs from "../narrator-epochs";
import { narratorService } from "../narrator-service";
import { buildContextManagementHooks } from "../narrator-session";

function prepared(): runtimeHistory.PreparedRuntimeHistory {
	return {
		history: [],
		sourceMessages: [],
		modelMessages: [],
		replayedInjectionMessageIds: [],
		currentText: "",
		currentInputText: "",
		currentInputPersisted: false,
		endsWithToolResults: false,
		endsWithInput: false,
	};
}
function hooks(signal: AbortSignal) {
	return buildContextManagementHooks({
		narratorId: "budget-rebuild",
		locale: "en",
		getModel: () => "model",
		getProvider: () => "anthropic",
		attachmentSignal: signal,
		rebuildSystemPrompt: async () => "system",
	});
}

describe("compact/plan-toggle/forced context rebuild budget", () => {
	test("every inner request refreshes membership and reconciles before projecting reloaded epoch rows", async () => {
		const calls: string[] = [];
		const managed = new Set<string>();
		const current = new Set<string>();
		let request = 0;
		let getterCalls = 0;
		const signal = new AbortController().signal;
		const candidates = [] as const;
		const load = spyOn(narratorService, "getModelHistorySinceLastCompact").mockImplementation(
			async () => {
				calls.push("load");
				return [];
			},
		);
		const reconcile = spyOn(epochs, "reconcileEpoch").mockImplementation(async (input) => {
			calls.push("reconcile");
			const loading = await input.refreshTools?.();
			expect([...(loading?.managed ?? [])]).toEqual([`mcp__request_${request}`]);
			expect([...(loading?.current ?? [])]).toEqual(
				request === 2 ? [] : [`mcp__request_${request}`],
			);
			expect(loading?.candidates).toBe(candidates);
			expect(input.signal).toBe(signal);
			expect(loading?.prompt).toEqual({
				contract: "fixed contract",
				parts: [{ key: "workspace", text: `cwd-${request}` }],
			});
			return {
				changed: true,
				loading,
				epoch: { toolNames: [...(loading?.current ?? [])] },
				systemPrompt: "frozen initial system",
			};
		});
		const build = spyOn(runtimeHistory, "buildRuntimeHistory").mockImplementation(
			async (options) => {
				calls.push("project");
				expect(options.toolLoading?.candidates).toBe(candidates);
				expect(options.toolLoading?.epoch?.toolNames).toEqual(
					request === 2 ? [] : [`mcp__request_${request}`],
				);
				return prepared();
			},
		);
		try {
			const context = buildContextManagementHooks({
				narratorId: "request-refresh",
				locale: "en",
				getModel: () => "model",
				getProvider: () => "anthropic",
				attachmentSignal: signal,
				buildPrefixPrompt: async () => {
					calls.push("prompt");
					return {
						contract: "fixed contract",
						parts: [{ key: "workspace", text: `cwd-${request}` }],
					};
				},
				getToolLoading: () => {
					getterCalls++;
					return { managed: new Set(managed), current: new Set(current), candidates };
				},
				refreshToolLoading: async () => {
					calls.push("refresh");
					request++;
					managed.clear();
					current.clear();
					managed.add(`mcp__request_${request}`);
					if (request !== 2) current.add(`mcp__request_${request}`);
				},
			});
			for (let i = 0; i < 3; i++) {
				const result = await context.rebuildRequestHistory();
				expect(result.systemPrompt).toBe("frozen initial system");
			}
			expect(calls).toEqual(
				Array.from({ length: 3 }, () => [
					"reconcile",
					"refresh",
					"prompt",
					"load",
					"project",
				]).flat(),
			);
			expect(getterCalls).toBe(6);
		} finally {
			load.mockRestore();
			reconcile.mockRestore();
			build.mockRestore();
		}
	});
	test.each([
		"publish",
		"reload",
	] as const)("retries a compact race during %s and projects authoritative tools and rows", async (race) => {
		let promptBuilds = 0;
		let reconciliation = 0;
		let selectedModel = "model";
		let selectedProvider = "anthropic";
		let current = new Set<string>();
		const managed = new Set(["newly-loaded"]);
		const candidates = [] as const;
		const lockedRows: Awaited<ReturnType<typeof narratorService.getModelHistorySinceLastCompact>> =
			[];
		const load = spyOn(narratorService, "getModelHistorySinceLastCompact").mockResolvedValue([]);
		const compact = spyOn(epochs, "currentCompactMessageId").mockResolvedValue("compact-2");
		const reconcile = spyOn(epochs, "reconcileEpoch").mockImplementation(async (input) => {
			reconciliation++;
			expect(input.model).toBe("model");
			expect(input.provider).toBe("anthropic");
			selectedModel = "queued-model";
			selectedProvider = "queued-provider";
			// /load committed while the request was queued for the shared tool lock.
			current = new Set(["newly-loaded"]);
			const loading = await input.refreshTools?.();
			expect(loading?.prompt?.compactMessageId).toBe(`compact-${reconciliation}`);
			expect([...(loading?.current ?? [])]).toEqual(["newly-loaded"]);
			expect(loading?.prompt?.parts).toEqual([
				{ key: "runtime.hints", text: [...(loading?.current ?? [])].join(", ") },
			]);
			if (reconciliation === 1 && race === "publish") throw new epochs.PrefixContextChangedError();
			return {
				changed: reconciliation === 1,
				epoch: { toolNames: ["newly-loaded"] },
				loading,
				sourceMessages: lockedRows,
				systemPrompt: "compact-2 frozen baseline",
			};
		});
		const build = spyOn(runtimeHistory, "buildRuntimeHistory").mockImplementation(
			async (options) => {
				expect(options.sourceMessages).toBe(lockedRows);
				expect(options.model).toBe("model");
				expect(options.provider).toBe("anthropic");
				expect([...(options.toolLoading?.current ?? [])]).toEqual(["newly-loaded"]);
				return prepared();
			},
		);
		try {
			const context = buildContextManagementHooks({
				narratorId: "prefix-race",
				locale: "en",
				getModel: () => selectedModel,
				getProvider: () => selectedProvider,
				buildPrefixPrompt: async (identity) => {
					expect(identity).toEqual({ model: "model", provider: "anthropic" });
					return {
						contract: "contract",
						parts: [{ key: "runtime.hints", text: [...current].join(", ") }],
						compactMessageId: `compact-${++promptBuilds}`,
					};
				},
				getToolLoading: () => ({
					managed: new Set(managed),
					current: new Set(current),
					candidates,
				}),
			});
			const result = await context.rebuildRequestHistory();
			expect(promptBuilds).toBe(2);
			expect(reconciliation).toBe(2);
			expect(result.systemPrompt).toBe("compact-2 frozen baseline");
			expect(build).toHaveBeenCalledTimes(1);
			expect(load).toHaveBeenCalledTimes(race === "reload" ? 1 : 0);
		} finally {
			compact.mockRestore();
			load.mockRestore();
			reconcile.mockRestore();
			build.mockRestore();
		}
	});

	test("forwards active cancellation to the source loader and does not build after abort", async () => {
		const controller = new AbortController();
		let passedDeadline: number | undefined;
		const load = spyOn(narratorService, "getModelHistorySinceLastCompact").mockImplementation(
			async (_id, _limit, options) => {
				expect(options?.signal).toBe(controller.signal);
				passedDeadline = options?.deadline;
				return new Promise((_, reject) =>
					controller.signal.addEventListener("abort", () => reject(new Error("source cancelled")), {
						once: true,
					}),
				);
			},
		);
		const build = spyOn(runtimeHistory, "buildRuntimeHistory").mockImplementation(async () =>
			prepared(),
		);
		try {
			const rebuilding = hooks(controller.signal).onBeforeTurn(1, { force: true });
			controller.abort();
			await expect(rebuilding).rejects.toThrow("source cancelled");
			expect(passedDeadline).toBeGreaterThan(Date.now());
			expect(build).not.toHaveBeenCalled();
		} finally {
			load.mockRestore();
			build.mockRestore();
		}
	});
	test("a short source read deadline does not become a total request-preparation limit", async () => {
		const controller = new AbortController();
		let now = 100_000;
		let sharedDeadline: number | undefined;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const load = spyOn(narratorService, "getModelHistorySinceLastCompact").mockImplementation(
			async (_id, _limit, options) => {
				sharedDeadline = options?.deadline;
				now += 8000;
				return [];
			},
		);
		const build = spyOn(runtimeHistory, "buildRuntimeHistory").mockImplementation(
			async (options) => {
				expect(options.deadline).toBeUndefined();
				expect(options.attachmentSignal).toBe(controller.signal);
				expect((sharedDeadline ?? 0) - Date.now()).toBe(2000);
				now += 3000;
				return prepared();
			},
		);
		try {
			const result = await hooks(controller.signal).onBeforeTurn(1, { force: true });
			expect(result?.systemPrompt).toBe("system");
			expect(now).toBe(111_000);
		} finally {
			load.mockRestore();
			build.mockRestore();
			clock.mockRestore();
		}
	});
});
