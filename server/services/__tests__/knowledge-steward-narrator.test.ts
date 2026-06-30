/**
 * Knowledge Steward narrator type tests.
 *
 * Covers the specialized standalone "knowledge" kind:
 *  - trait detection (isKnowledgeStewardNarrator)
 *  - the deny-set is safe (contains ONLY unrelated content tools, NEVER control/reflection tools)
 *  - create() preinstalls the knowledge toolset + steward prompt; KnowledgeAdmin only for admins
 *  - the steward system prompt is bilingual
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../db";
import { users } from "../../db/schema";
import {
	KNOWLEDGE_KIND_DENY_CORE,
	KNOWLEDGE_KIND_PRELOAD_TOOLS,
	KNOWLEDGE_KIND_PRELOAD_TOOLS_ADMIN,
} from "../../lib/agent/tools/index";
import { isKnowledgeStewardNarrator, KNOWLEDGE_KIND_TRAIT } from "../../lib/narrator-utils";
import { buildKnowledgeStewardSystemPrompt } from "../../lib/prompt-i18n";
import { narratorService } from "../narrator-service";

const TAG = Date.now();

beforeAll(async () => {
	const now = new Date().toISOString();
	await db.insert(users).values({
		id: `ks-user-${TAG}`,
		username: `ks-user-${TAG}`,
		passwordHash: "x",
		role: "user",
		createdAt: now,
	});
});

describe("trait detection", () => {
	test("isKnowledgeStewardNarrator recognizes the trait", () => {
		expect(isKnowledgeStewardNarrator([KNOWLEDGE_KIND_TRAIT])).toBe(true);
		expect(isKnowledgeStewardNarrator(["standalone", KNOWLEDGE_KIND_TRAIT])).toBe(true);
		expect(isKnowledgeStewardNarrator(["standalone"])).toBe(false);
		expect(isKnowledgeStewardNarrator(null)).toBe(false);
		expect(isKnowledgeStewardNarrator(JSON.stringify([KNOWLEDGE_KIND_TRAIT]))).toBe(true);
	});
});

describe("deny-set safety (risk #2 guard)", () => {
	test("deny-set contains only unrelated content tools, never control/reflection tools", () => {
		// The deny-set must never strip tools the agent loop needs to function.
		const FORBIDDEN_IN_DENY = [
			"EnterPlanMode",
			"ExitPlanMode",
			"StartPipeline",
			"EndPipeline",
			"DangerConfirm",
			"DangerCancel",
			"ExitPlanConfirm",
			"ExitPlanConfirmAndCompact",
			"ExitPlanRevise",
			"GoalCompleteConfirm",
			"GoalCompleteRevise",
			"GetGoals",
			"AddGoal",
			"UpdateGoal",
			"Task",
			"TaskCreate",
			"AskUserQuestion",
			"Skill",
			// knowledge + file-read tools must stay available too
			"Read",
			"Glob",
			"Grep",
			"Bash",
			"KnowledgeSearch",
			"KnowledgeRead",
		];
		for (const name of FORBIDDEN_IN_DENY) {
			expect(KNOWLEDGE_KIND_DENY_CORE.has(name)).toBe(false);
		}
		// It should be small and only target web tools in this iteration.
		for (const denied of KNOWLEDGE_KIND_DENY_CORE) {
			expect(["WebSearch", "WebFetch"]).toContain(denied);
		}
	});
});

describe("create() preinstall", () => {
	test("non-admin steward: preinstalls knowledge tools WITHOUT KnowledgeAdmin + steward prompt", async () => {
		const narrator = await narratorService.create({
			kind: "knowledge",
			creatorIsAdmin: false,
			locale: "en",
		});
		const tools = (narrator.enabledTools as string[] | null) ?? [];
		for (const t of KNOWLEDGE_KIND_PRELOAD_TOOLS) expect(tools).toContain(t);
		expect(tools).not.toContain(KNOWLEDGE_KIND_PRELOAD_TOOLS_ADMIN);
		const traits = (narrator.traits as string[] | null) ?? [];
		expect(traits).toContain(KNOWLEDGE_KIND_TRAIT);
		expect(traits).toContain("standalone");
		// Default steward prompt applied.
		expect(narrator.systemPrompt).toContain("Knowledge Steward");
	});

	test("admin steward: also preinstalls KnowledgeAdmin", async () => {
		const narrator = await narratorService.create({
			kind: "knowledge",
			creatorIsAdmin: true,
			locale: "en",
		});
		const tools = (narrator.enabledTools as string[] | null) ?? [];
		expect(tools).toContain(KNOWLEDGE_KIND_PRELOAD_TOOLS_ADMIN);
	});

	test("a supplied systemPrompt overrides the default steward prompt", async () => {
		const narrator = await narratorService.create({
			kind: "knowledge",
			creatorIsAdmin: false,
			systemPrompt: "custom steward instructions",
		});
		expect(narrator.systemPrompt).toBe("custom steward instructions");
	});

	test("knowledge kind with a chapterId is rejected (must be standalone)", async () => {
		expect(
			narratorService.create({
				kind: "knowledge",
				chapterId: "some-chapter",
				creatorIsAdmin: false,
			}),
		).rejects.toThrow();
	});

	test("named + knowledge steward coexist: enabledTools merges GroupControl + knowledge tools", async () => {
		const narrator = await narratorService.create({
			kind: "knowledge",
			makeNamed: true,
			handle: `ks-named-${TAG}`,
			creatorIsAdmin: false,
			locale: "en",
		});
		const tools = (narrator.enabledTools as string[] | null) ?? [];
		// Named contributes GroupControl…
		expect(tools).toContain("GroupControl");
		// …and knowledge contributes its toolset — neither clobbers the other.
		for (const t of KNOWLEDGE_KIND_PRELOAD_TOOLS) expect(tools).toContain(t);
		// No duplicates.
		expect(new Set(tools).size).toBe(tools.length);
		const traits = (narrator.traits as string[] | null) ?? [];
		expect(traits).toContain("named");
		expect(traits).toContain(KNOWLEDGE_KIND_TRAIT);
	});

	test("plain narrator (neither named nor knowledge) has no preinstalled tools", async () => {
		const narrator = await narratorService.create({ creatorIsAdmin: false });
		expect(narrator.enabledTools ?? null).toBeNull();
	});
});

describe("steward system prompt", () => {
	test("is bilingual and mentions the import discipline", () => {
		const en = buildKnowledgeStewardSystemPrompt("en");
		const zh = buildKnowledgeStewardSystemPrompt("zh-CN");
		expect(en).toContain("Knowledge Steward");
		expect(en).toContain("THREE-PHASE");
		expect(zh).toContain("知识库管家");
		expect(zh).toContain("三段式");
		// Fallback to en for unknown locale.
		expect(buildKnowledgeStewardSystemPrompt("xx" as never)).toContain("Knowledge Steward");
	});
});
