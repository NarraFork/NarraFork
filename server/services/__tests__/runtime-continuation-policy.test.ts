import { describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { generateId } from "../../lib/id";
import { parseRuntimePolicyTraits, withRuntimePolicyTrait } from "../../lib/runtime-policy-trait";
import { settings } from "../../lib/settings";
import { runtimeBasePrompt } from "../agent-runtime/orchestrator";
import { resolveRuntimePolicy } from "../agent-runtime/policy";
import { startNarratorRun } from "../agent-runtime/run";
import { compileDelegationCeiling } from "../custom-subagent-service";
import { materializeLegacyDelegations } from "../legacy-delegation-materializer";
import * as executor from "../narrator-executor";
import { narratorService } from "../narrator-service";
import { maybeStartContinuation } from "../narrator-session";
import type { ActiveNarrator } from "../narrator-session-state";
import { specVfsService, writeSpecFile } from "../spec-vfs-service";
import { resolveNarratorRuntimePolicy } from "../trait-layer-service";
import { createSpecContinuationState } from "../turn-continuation-decisions";

async function fixture(
	options: { delegated?: boolean; delivered?: boolean; legacy?: boolean } = {},
) {
	const id = generateId();
	const recipient = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: recipient,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		createdAt: now,
		updatedAt: now,
	});
	const registration = options.delivered
		? {
				version: 1 as const,
				run: {
					logicalRunId: generateId(),
					deliverTo: { narratorId: recipient, toolUseId: generateId() },
				},
			}
		: null;
	await db.insert(narrators).values({
		id,
		type: options.legacy ? "subagent" : "primary",
		variant: options.legacy ? "subagent:general" : "primary",
		parentNarratorId: options.legacy ? recipient : null,
		traits: options.delegated
			? withRuntimePolicyTrait(["standalone"], await compileDelegationCeiling("general"))
			: ["standalone"],
		runtimeRegistrationJson: registration,
		autoContinuationOverride: "always",
		createdAt: now,
		updatedAt: now,
	});
	const active = { narratorId: id, locale: "en" } as ActiveNarrator;
	return { id, recipient, active, registration };
}
const doing = { text: "Finish requested work", status: "doing", protected: false };
const todo = { ...doing, status: "todo" };
async function tasks(id: string, task = todo) {
	await writeSpecFile(id, "spec://tasks.json", JSON.stringify({ tasks: [task] }), {
		actor: "agent",
		createdBy: "assistant",
	});
}
async function storedStatus(id: string) {
	return JSON.parse((await specVfsService.readTasksFileForNarrator(id)).content).tasks[0].status;
}

describe("A1 policy owns continuation, not deliverTo", () => {
	test("the same ordinary session promotes todo with or without a result destination", async () => {
		const h = await fixture();
		await tasks(h.id);
		const bare = await maybeStartContinuation(h.active, false);
		expect(await storedStatus(h.id)).toBe("doing");
		await tasks(h.id);
		await db
			.update(narrators)
			.set({
				runtimeRegistrationJson: {
					version: 1,
					run: {
						logicalRunId: generateId(),
						deliverTo: { narratorId: h.recipient, toolUseId: generateId() },
					},
				},
			})
			.where(eq(narrators.id, h.id));
		const delivered = await maybeStartContinuation(h.active, false);
		expect(await storedStatus(h.id)).toBe("doing");
		expect(delivered).toBe(bare);
	});
	for (const delivered of [false, true]) {
		test(`delegation ceiling without role, deliverTo=${delivered}: todo stays queued, six passes only`, async () => {
			const h = await fixture({ delegated: true, delivered });
			await tasks(h.id);
			expect(await maybeStartContinuation(h.active, false)).toBeNull();
			expect(await storedStatus(h.id)).toBe("todo");
			await tasks(h.id, doing);
			const state = createSpecContinuationState();
			for (let pass = 1; pass <= 6; pass++) {
				expect(
					await maybeStartContinuation(h.active, false, {
						state,
						cause: pass % 2 ? "spec" : "maxTurns",
					}),
				).toContain(`Self-continuations left: ${6 - pass}`);
				expect(state.passes).toBe(pass);
			}
			expect(await maybeStartContinuation(h.active, false, { state })).toBeNull();
			expect(state.stop?.reason).toBe("passLimit");
		});
	}
	test("a materialized legacy delegation carries the template continuation ceiling", async () => {
		const h = await fixture({ legacy: true });
		expect(await materializeLegacyDelegations([h.id])).toBe(1);
		const row = await narratorService.getById(h.id);
		expect(row.runtimeRegistrationJson).not.toBeNull();
		expect(parseRuntimePolicyTraits(row.traits)).toHaveLength(1);
		expect((await resolveNarratorRuntimePolicy(h.id)).continuation).toEqual({
			promoteTodo: false,
			maxPasses: 6,
		});
		await tasks(h.id);
		expect(await maybeStartContinuation(h.active, false)).toBeNull();
		expect(await storedStatus(h.id)).toBe("todo");
		await tasks(h.id, doing);
		const state = createSpecContinuationState();
		for (let pass = 0; pass < 6; pass++)
			expect(await maybeStartContinuation(h.active, false, { state })).not.toBeNull();
		expect(await maybeStartContinuation(h.active, false, { state })).toBeNull();
		expect(state.stop?.reason).toBe("passLimit");
	});
	test("every declaring layer only narrows promotion and budgets, independent of order", () => {
		const declarations = [
			{ version: 1 as const, continuation: { promoteTodo: false, maxPasses: 4 } },
			{ version: 1 as const, continuation: { promoteTodo: true, maxPasses: 20 } },
			{ version: 1 as const, continuation: { maxPasses: 2 } },
		];
		expect(resolveRuntimePolicy([]).continuation).toEqual({ promoteTodo: true, maxPasses: null });
		for (const layers of [declarations, [...declarations].reverse()]) {
			expect(resolveRuntimePolicy(layers).continuation).toEqual({
				promoteTodo: false,
				maxPasses: 2,
			});
		}
	});
	test("actual ordinary loop still continues a queued task when a destination is registered", async () => {
		const h = await fixture({ delivered: true });
		const before = settings.anthropicProviders;
		settings.anthropicProviders = [
			{
				id: "continuation-test",
				name: "Continuation test",
				prefix: "continuationtest",
				apiKey: "test-only",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "claude-sonnet-4",
			},
		];
		await db
			.update(narrators)
			.set({ model: "continuationtest:claude-sonnet-4" })
			.where(eq(narrators.id, h.id));
		await tasks(h.id);
		let passes = 0;
		const model = spyOn(executor, "executeAgentLoop").mockImplementation(async () => {
			passes++;
			if (passes > 1) await tasks(h.id, { ...doing, status: "done" });
			return {
				finalText: "requested work finished",
				hasError: false,
				shouldUpdateTitle: false,
				hadToolUses: true,
				completedNaturally: true,
			};
		});
		try {
			const run = await startNarratorRun({
				narratorId: h.id,
				text: "",
				locale: "en",
				principal: null,
				foreground: true,
				binding: { deliverTo: h.registration?.run.deliverTo },
			});
			expect((await run.terminal).hasError).toBe(false);
			expect(passes).toBe(2);
		} finally {
			model.mockRestore();
			settings.anthropicProviders = before;
		}
	});
});

describe("A3 prompt projections do not classify control grants as roles", () => {
	const base = {
		systemPrompt: "BASE",
		type: "primary",
		variant: "primary",
		runtimeRegistrationJson: {
			version: 1,
			controller: { narratorId: "controller", actions: ["steer"] },
		},
	};
	test("an ordinary control grant adds no reporting role or Await prohibition", () => {
		const prompt = runtimeBasePrompt(base, "en", resolveRuntimePolicy([]));
		expect(prompt).toBe("BASE");
		expect(prompt).not.toContain("Await");
		expect(prompt).not.toContain("parent");
	});
	test("delegation interaction restrictions come from the ceiling even without any relationship", async () => {
		const policy = resolveRuntimePolicy([await compileDelegationCeiling("general")]);
		for (const locale of ["en", "zh-CN"] as const) {
			const prompt = runtimeBasePrompt({ systemPrompt: "BASE" }, locale, policy);
			expect(prompt).toContain("Await(agent)");
			expect(prompt).not.toContain("await=true");
			expect(prompt).toContain("AskUserQuestion");
			expect(prompt).not.toContain("parent");
		}
	});
	test("delivery names deliverTo, never a different controller or cancelWith caller", () => {
		for (const waiting of [false, true]) {
			const row = {
				...base,
				runtimeRegistrationJson: {
					...base.runtimeRegistrationJson,
					run: {
						logicalRunId: "run",
						deliverTo: { narratorId: "result-recipient", toolUseId: "tool" },
						cancelWith: {
							narratorId: waiting ? "result-recipient" : "different-caller",
							toolCallId: "call",
							attempt: 1,
						},
					},
				},
			};
			const prompt = runtimeBasePrompt(row, "en", resolveRuntimePolicy([]));
			expect(prompt).toContain('narrator "result-recipient"');
			expect(prompt).not.toContain("controller");
			expect(prompt).not.toContain("different-caller");
			expect(prompt?.includes("caller is waiting")).toBe(waiting);
			expect(prompt).not.toContain("Await(agent)");
			expect(prompt).not.toContain("must be asynchronous");
		}
	});
});
