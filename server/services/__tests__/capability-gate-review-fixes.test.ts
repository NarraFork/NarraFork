import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLLOW_PARENT_MODEL } from "@shared/model-inheritance";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	users,
} from "../../db/schema";
import { localBackend } from "../../lib/agent/execution/registry";
import { executeTool } from "../../lib/agent/tool-executor";
import { toolRegistry } from "../../lib/agent/tool-registry";
import { bashTool } from "../../lib/agent/tools/bash";
import { genUiTool } from "../../lib/agent/tools/gen-ui";
import { writeTool } from "../../lib/agent/tools/write";
import type { AgentConfig, AgentToolUse, ToolCallBinding } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import {
	BLOCKED_SKILLS_TRAIT_PREFIX,
	DISABLED_TOOLS_TRAIT_PREFIX,
	getBlockedSkills,
	getDisabledToolSet,
	upsertEncodedTrait,
} from "../../lib/narrator-custom-traits";
import { parseRuntimePolicyTraits, withRuntimePolicyTrait } from "../../lib/runtime-policy-trait";
import {
	controllerOf,
	modelPoolKeyOf,
	policySourceIdOf,
	runDeliverToOf,
} from "../../lib/runtime-source";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { narratorService } = await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");
const { handlePermission, resolvePermission } = await import("../narrator-permission");
const { buildFinalToolStartAuthorization } = await import("../tool-final-start-authorization");
const { resolveNarratorCapabilities, resetTraitLayerCaches } = await import(
	"../trait-layer-service"
);
const { executionPolicyEngine } = await import("../execution-policy/engine");
const { createExecutionTargetContext } = await import("../execution-policy/target-context");
const { permissionRuleService } = await import("../permission-rule-service");
const { reviewService } = await import("../review-service");
const { materializeLegacyDelegations } = await import("../legacy-delegation-materializer");

const skillBody = mock(async () => ({ output: "skill ran" }));
toolRegistry.register(writeTool);
toolRegistry.register(bashTool);
toolRegistry.register(genUiTool);
toolRegistry.register({
	name: "Skill",
	description: "fixture",
	parameters: z.object({ skill: z.string().optional(), name: z.string().optional() }),
	execute: skillBody,
});
let cwd: string;
let owner: string;
let root: string;
let writeSpy: ReturnType<typeof spyOn>;
let execSpy: ReturnType<typeof spyOn>;
let uiSpy: ReturnType<typeof spyOn>;
const now = () => new Date().toISOString();

beforeEach(async () => {
	cleanDb(sqlite);
	resetTraitLayerCaches();
	skillBody.mockClear();
	cwd = await mkdtemp(join(tmpdir(), "nf-capability-gates-"));
	owner = generateId();
	await db
		.insert(users)
		.values({ id: owner, username: owner, passwordHash: "fixture", createdAt: now() });
	root = await actor();
	writeSpy = spyOn(localBackend, "writeFileBytes");
	execSpy = spyOn(localBackend, "execCommand");
	uiSpy = spyOn(genUiTool, "execute");
});
afterEach(async () => {
	writeSpy.mockRestore();
	execSpy.mockRestore();
	uiSpy.mockRestore();
	for (const row of await db.select({ id: narrators.id }).from(narrators))
		executionPolicyEngine.invalidate(row.id);
	cleanDb(sqlite);
	await rm(cwd, { recursive: true, force: true });
});
afterAll(() => mock.module("../../db", () => realDb));

async function actor(extra: Partial<typeof narrators.$inferInsert> = {}) {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		cwd,
		ownerUserId: owner,
		permissionMode: "bypassPermissions",
		createdAt: now(),
		updatedAt: now(),
		...extra,
	});
	return id;
}
async function missing(path: string) {
	try {
		await access(path);
		return false;
	} catch {
		return true;
	}
}
async function fixture(id: string, name: string, input: Record<string, unknown>) {
	const messageId = generateId();
	const toolCallId = generateId();
	const toolUseId = generateId();
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: id,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: toolUseId, name, input }],
		createdAt: now(),
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId: id, messageId, seq: 1 });
	await db.insert(narratorToolCalls).values({
		id: toolCallId,
		narratorId: id,
		messageId,
		toolUseId,
		toolName: name,
		inputJson: input,
		status: "initializing",
		executionAttempt: 1,
		executionIdentityVersion: 1,
		createdAt: now(),
	});
	const binding: ToolCallBinding = { toolCallId, attempt: 1 };
	const config: AgentConfig = {
		narratorId: id,
		conversationId: generateId(),
		model: "test:model",
		provider: "test",
		cwd,
		userId: owner,
		signal: new AbortController().signal,
		requireToolCallBinding: true,
		workspaceContext: {
			revision: 0,
			deviceId: "local",
			cwd,
			pathFlavor: "posix",
			contextKey: id,
			capabilities: { switchDirectory: true },
		},
		permissionHandler: (tool, args, useId, options) =>
			handlePermission(id, config.signal, tool, args, useId, cwd, "en", undefined, options),
		onExecutionTargetResolved: (useId, target, receipt) =>
			narratorPersistence.updateToolCallExecutionTarget(id, useId, target, receipt),
		onExecutionPlanResolved: (useId, plan, receipt) =>
			narratorPersistence.updateToolCallExecutionPlan(id, useId, plan, receipt),
		onToolExecutionStarting: (useId, receipt, startedAt) =>
			narratorPersistence.claimToolCallExecution(id, useId, receipt, startedAt),
	};
	config.onToolExecutionFinalAuthorization = buildFinalToolStartAuthorization(config);
	const toolUse: AgentToolUse = { name, input, toolUseId };
	return {
		config,
		binding,
		toolUse,
		toolCallId,
		messageId,
		execute: () => executeTool(toolUse, config, { toolCallBinding: binding }),
	};
}

// Real permission receipts, final authorization, backend dispatch and file absence, not a mock policy.
describe("S4 read-only capability is stronger than bypassPermissions", () => {
	test("blocks GenUI create before its body or backend writes", async () => {
		await db
			.update(narrators)
			.set({ traits: withRuntimePolicyTrait([], { version: 1, readOnly: true }) })
			.where(eq(narrators.id, root));
		const f = await fixture(root, "GenUI", { action: "create", prefix: "denied" });
		const result = await f.execute();
		expect(result.isError).toBe(true);
		expect(result.output).toContain("read-only capability ceiling");
		expect(uiSpy).not.toHaveBeenCalled();
		expect(writeSpy).not.toHaveBeenCalled();
		expect(await missing(join(cwd, ".narrafork", "gen_ui"))).toBe(true);
	});
	test("positive control creates UI files when no read-only ceiling applies", async () => {
		const result = await (
			await fixture(root, "GenUI", { action: "create", prefix: "allowed" })
		).execute();
		expect(result.isError).not.toBe(true);
		expect(uiSpy).toHaveBeenCalledTimes(1);
		expect(writeSpy).toHaveBeenCalled();
		expect(await missing(join(cwd, ".narrafork", "gen_ui"))).toBe(false);
	});
	test("still executes a safe read-only Bash command", async () => {
		await db
			.update(narrators)
			.set({ traits: withRuntimePolicyTrait([], { version: 1, readOnly: true }) })
			.where(eq(narrators.id, root));
		const result = await (await fixture(root, "Bash", { command: "pwd", timeout: 2000 })).execute();
		expect(result.isError).not.toBe(true);
		expect(result.output).toContain(cwd);
		expect(execSpy).toHaveBeenCalled();
	});
});

// Explore/plan delegates keep Bash on the inherited permission mode; their prompt is
// the read-only guard, not the capability ceiling.
describe("explore delegate Bash follows the permission mode", () => {
	async function exploreChild(permissionMode: "default" | "acceptEdits") {
		await db.update(narrators).set({ permissionMode }).where(eq(narrators.id, root));
		const child = await narratorService.createSubagent({
			parentNarratorId: root,
			subagentType: "explore",
			cwd,
		});
		return child.id;
	}
	async function waitForPending(toolCallId: string) {
		for (let i = 0; i < 100; i++) {
			const call = await db.query.narratorToolCalls.findFirst({
				where: eq(narratorToolCalls.id, toolCallId),
			});
			if (call?.status === "pending") return;
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error("tool call never reached a pending approval");
	}

	for (const command of ["du -sh .", "touch effect.txt"]) {
		test(`runs ${command} after the user approves it`, async () => {
			const f = await fixture(await exploreChild("default"), "Bash", { command, timeout: 2000 });
			const running = f.execute();
			await waitForPending(f.toolCallId);
			expect(await resolvePermission(f.toolCallId, "allow", { userId: owner })).toBe(true);
			const result = await running;
			expect(result.isError).not.toBe(true);
			expect(execSpy).toHaveBeenCalled();
		});
	}

	test("auto-allows a worktree write under acceptEdits", async () => {
		const f = await fixture(await exploreChild("acceptEdits"), "Bash", {
			command: "touch effect.txt",
			timeout: 2000,
		});
		const result = await f.execute();
		expect(result.isError).not.toBe(true);
		expect(await missing(join(cwd, "effect.txt"))).toBe(false);
	});
});

describe("S6 source restrictions refreshed after real approval", () => {
	for (const explicit of [false, true]) {
		for (const restriction of ["disabled-tools", "blocked-skills", "all-skills"] as const) {
			test(`${explicit ? "no parent, explicit source" : "legacy source"}: ${restriction} prevents the approved body`, async () => {
				const id = await actor(
					explicit
						? { policySourceNarratorId: root, runtimeRegistrationJson: { version: 1 } }
						: {
								type: "subagent",
								variant: "subagent:general",
								parentNarratorId: root,
								aclRootNarratorId: root,
							},
				);
				if (!explicit) await materializeLegacyDelegations([id]);
				const isSkill = restriction !== "disabled-tools";
				const f = await fixture(
					id,
					isSkill ? "Skill" : "Write",
					isSkill
						? { skill: "fixture-skill" }
						: { file_path: join(cwd, "effect.txt"), content: "denied" },
				);
				let approved = false;
				f.config.onToolExecutionBefore = async () => {
					const call = await db.query.narratorToolCalls.findFirst({
						where: eq(narratorToolCalls.id, f.toolCallId),
					});
					expect(call?.permissionDecidedBy).toBe("auto");
					approved = true;
					const traits = isSkill
						? upsertEncodedTrait([], BLOCKED_SKILLS_TRAIT_PREFIX, {
								version: 1,
								all: restriction === "all-skills",
								names: ["fixture-skill"],
							})
						: upsertEncodedTrait([], DISABLED_TOOLS_TRAIT_PREFIX, { version: 1, tools: ["Write"] });
					await db.update(narrators).set({ traits }).where(eq(narrators.id, root));
					resetTraitLayerCaches();
				};
				const result = await f.execute();
				expect(approved).toBe(true);
				expect(result.isError).toBe(true);
				expect(result.output).toContain("current effective traits");
				expect(skillBody).not.toHaveBeenCalled();
				expect(writeSpy).not.toHaveBeenCalled();
				expect(await missing(join(cwd, "effect.txt"))).toBe(true);
			});
		}
	}
});

describe("S5 both fork entry points preserve policy and model sources", () => {
	for (const entry of ["forkNarrator", "forkFromMessages"] as const) {
		for (const shape of ["explicit", "legacy-explore", "legacy-default"] as const) {
			const legacy = shape !== "explicit";
			test(`${entry}: ${shape} preserves its source and ceiling`, async () => {
				const sourceTraits = upsertEncodedTrait(
					upsertEncodedTrait(
						withRuntimePolicyTrait([], { version: 1, tools: ["Read", "Bash", "WebSearch"] }),
						DISABLED_TOOLS_TRAIT_PREFIX,
						{ version: 1, tools: ["Bash"] },
					),
					BLOCKED_SKILLS_TRAIT_PREFIX,
					{ version: 1, all: false, names: ["blocked"] },
				);
				await db.update(narrators).set({ traits: sourceTraits }).where(eq(narrators.id, root));
				const denied = join(cwd, "denied");
				await permissionRuleService.createNarratorRule(root, {
					ruleType: "directoryBlacklist",
					value: { path: denied, denyLevel: "denyAll", targetKind: "host", pathFlavor: "posix" },
				});
				const id = await actor({
					model: FOLLOW_PARENT_MODEL,
					...(legacy
						? {
								type: "subagent",
								...(shape === "legacy-explore"
									? { variant: "primary", subagentType: "explore" }
									: {}),
								parentNarratorId: root,
							}
						: {
								policySourceNarratorId: root,
								runtimeRegistrationJson: {
									version: 1,
									modelPool: "explore",
									controller: { narratorId: root, actions: ["stop"] },
									run: {
										logicalRunId: generateId(),
										deliverTo: { narratorId: root, toolUseId: "source-tool" },
									},
								},
							}),
				});
				if (legacy) await materializeLegacyDelegations([id]);
				const f = await fixture(id, "Read", { file_path: join(cwd, "unused") });
				const before = await resolveNarratorCapabilities(id, owner);
				const fork =
					entry === "forkNarrator"
						? await narratorService.forkNarrator(id, null, { inheritMode: "fresh" })
						: await narratorService.forkFromMessages(id, [f.messageId]);
				const after = await resolveNarratorCapabilities(fork.id, owner);
				expect(policySourceIdOf(fork)).toBe(root);
				expect(after.policy).toEqual(before.policy);
				expect(getDisabledToolSet(after.traits.traits)).toEqual(new Set(["Bash"]));
				expect(getBlockedSkills(after.traits.traits).names).toEqual(new Set(["blocked"]));
				const context = await createExecutionTargetContext({
					backend: localBackend,
					target: {
						deviceId: "local",
						backendKind: "local",
						cwd,
						selectionSource: "session_default",
					},
				});
				const policy = await executionPolicyEngine.compile(fork.id, context);
				expect(
					policy.evaluatePath({ path: join(denied, "file"), operation: "read" }).decision,
				).toBe("deny");
				expect(fork.model).toBe(FOLLOW_PARENT_MODEL);
				expect(modelPoolKeyOf(fork)).toBe(shape === "legacy-default" ? "general" : "explore");
				expect(controllerOf(fork)).toBeNull();
				expect(runDeliverToOf(fork)).toBeUndefined();
				if (legacy) expect(parseRuntimePolicyTraits(fork.traits)).toHaveLength(1);
				// This is a live source, not a copied snapshot of its restrictions.
				await db
					.update(narrators)
					.set({ traits: withRuntimePolicyTrait(sourceTraits, { version: 1, tools: [] }) })
					.where(eq(narrators.id, root));
				expect((await resolveNarratorCapabilities(fork.id, owner)).policy.tools.builtin).toEqual(
					[],
				);
			});
		}
	}
});

describe("S8 review conversion only narrows existing ceilings", () => {
	for (const tools of [["Read"], []]) {
		test(`preserves own tools ${JSON.stringify(tools)}`, async () => {
			const projectId = generateId(),
				sourceChapterId = generateId(),
				reviewChapterId = generateId();
			await db.insert(projects).values({
				id: projectId,
				name: "fixture",
				gitPath: cwd,
				ownerUserId: owner,
				createdAt: now(),
				updatedAt: now(),
			});
			await db.insert(chapters).values([
				{
					id: sourceChapterId,
					projectId,
					title: "source",
					branch: "source",
					baseBranch: "main",
					worktreePath: cwd,
					createdAt: now(),
					updatedAt: now(),
				},
				{
					id: reviewChapterId,
					projectId,
					title: "review",
					branch: "review",
					baseBranch: "source",
					role: "review",
					reviewStatus: "concluded",
					reviewSourceChapterId: sourceChapterId,
					createdAt: now(),
					updatedAt: now(),
				},
			]);
			await db.update(narrators).set({ chapterId: sourceChapterId }).where(eq(narrators.id, root));
			const id = await actor({
				chapterId: reviewChapterId,
				traits: withRuntimePolicyTrait([], { version: 1, tools }),
			});
			const before = await resolveNarratorCapabilities(id, owner);
			await reviewService.convertToSubagent(reviewChapterId);
			const after = await resolveNarratorCapabilities(id, owner);
			expect(after.policy.tools.builtin).toEqual(before.policy.tools.builtin);
			expect(after.policy.tools.builtin).toEqual(tools);
			const row = await db.query.narrators.findFirst({ where: eq(narrators.id, id) });
			expect(parseRuntimePolicyTraits(row?.traits)).toHaveLength(2);
		});
	}
});
