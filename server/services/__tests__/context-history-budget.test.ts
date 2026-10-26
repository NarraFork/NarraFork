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
		const candidates = [] as const;
		const load = spyOn(narratorService, "getModelHistorySinceLastCompact").mockImplementation(
			async () => {
				calls.push("load");
				return [];
			},
		);
		const reconcile = spyOn(epochs, "reconcileEpoch").mockImplementation(async (input) => {
			calls.push("reconcile");
			expect([...input.managed]).toEqual([`mcp__request_${request}`]);
			expect([...input.current]).toEqual(request === 2 ? [] : [`mcp__request_${request}`]);
			expect(input.candidates).toBe(candidates);
			return { changed: true, epoch: { toolNames: [...input.current] } };
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
				getToolLoading: () => {
					getterCalls++;
					return { managed, current, candidates };
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
			for (let i = 0; i < 3; i++) await context.rebuildRequestHistory();
			expect(calls).toEqual(
				Array.from({ length: 3 }, () => ["refresh", "load", "reconcile", "load", "project"]).flat(),
			);
			expect(getterCalls).toBe(3);
		} finally {
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
	test("source and provider projection share one deadline instead of receiving two 10s budgets", async () => {
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
				expect(options.deadline).toBe(sharedDeadline);
				expect(options.attachmentSignal).toBe(controller.signal);
				expect((options.deadline ?? 0) - Date.now()).toBe(2000);
				now += 3000;
				return prepared();
			},
		);
		try {
			await expect(hooks(controller.signal).onBeforeTurn(1, { force: true })).rejects.toThrow(
				"10s budget",
			);
		} finally {
			load.mockRestore();
			build.mockRestore();
			clock.mockRestore();
		}
	});
});
