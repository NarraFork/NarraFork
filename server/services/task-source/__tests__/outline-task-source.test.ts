/**
 * The outline task source (outline P2, PR 3): the shared task-source contract, the store
 * scenarios (also run on PostgreSQL), its own wording, the continuation rules of design §4.8 and
 * D27a–c through the real continuation reader, and one end-to-end run of an outline session.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`; every case makes its own sessions.
 * `outline.enabled` is switched on before each case (the preload restores settings after it).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { narrators } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import { withRuntimePolicyTrait } from "../../../lib/runtime-policy-trait";
import { settings } from "../../../lib/settings";
import { compileDelegationCeiling } from "../../custom-subagent-service";
import { maybeStartContinuation, readSpecContinuationState } from "../../narrator-session";
import type { ActiveNarrator } from "../../narrator-session-state";
import { outlineStore } from "../../outline/store";
import * as outlineWrite from "../../outline/write";
import { specVfsService, writeSpecFile } from "../../spec-vfs-service";
import {
	createSpecContinuationState,
	specContinuationStopNote,
} from "../../turn-continuation-decisions";
import { taskSourceForNarrator } from "../index";
import {
	finishPrerequisite,
	OUTLINE_TASK_SOURCE_SCENARIOS,
	type OutlineScenarioContext,
	seedOutlineTasks,
	taskState,
} from "./outline-task-source-scenarios";
import { describeTaskSourceContract } from "./task-source-contract.harness";

const NOW = "2026-10-31T00:00:00.000Z";
// The test preload restores settings after every test, so the switch is set before each.
beforeEach(() => {
	settings.outline.enabled = true;
});

async function session(
	options: {
		backend?: "spec" | "outline";
		owner?: string | null;
		mode?: "inherit" | "always" | "blockStop" | "protectedOnly" | "off";
	} = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "default",
		permissionMode: "default",
		status: "idle",
		taskBackend: options.backend ?? "outline",
		ownerUserId: options.owner ?? null,
		autoContinuationOverride: options.mode ?? "inherit",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

async function subagent(
	rootId: string,
	options: {
		backend?: "spec" | "outline";
		mode?: "inherit" | "always" | "blockStop" | "protectedOnly" | "off";
	} = {},
): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		type: "subagent",
		variant: "subagent:general",
		subagentType: "general",
		parentNarratorId: rootId,
		aclRootNarratorId: rootId,
		traits: withRuntimePolicyTrait(["standalone"], await compileDelegationCeiling("general")),
		model: "default",
		permissionMode: "default",
		status: "idle",
		taskBackend: options.backend ?? "spec",
		autoContinuationOverride: options.mode ?? "protectedOnly",
		createdAt: NOW,
		updatedAt: NOW,
	});
	return id;
}

const scenarioContext: OutlineScenarioContext = {
	session: (options) => session(options),
	subagent: (rootId, options) => subagent(rootId, options),
};

const restores: Array<() => void> = [];
afterEach(() => {
	for (const restore of restores.splice(0)) restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// The shared contract
// ─────────────────────────────────────────────────────────────────────────────

describeTaskSourceContract({
	backend: "outline",
	createNarrator: () => session(),
	seedTasks: async (narratorId, tasks) => {
		await seedOutlineTasks(narratorId, tasks);
	},
	// Until the behavior-fence page exists (plan PR 4), an outline session's fence is the one the
	// person and plugins write in its Dynamic Spec namespace.
	seedBehaviorFence: async (narratorId, text) => {
		await writeSpecFile(narratorId, "spec://behavior_fence", text, { actor: "user" });
	},
	/** Unreadable for one narrator: its claimed tasks and its fence cannot be read. */
	async makeUnreadable(narratorId) {
		const realClaimed = outlineStore.listClaimedTasks;
		const realReadFile = specVfsService.readSpecFile;
		const claimed = spyOn(outlineStore, "listClaimedTasks").mockImplementation(
			async (id, limit) => {
				if (id === narratorId) throw new Error("outline unreadable");
				return realClaimed.call(outlineStore, id, limit);
			},
		);
		const readFile = spyOn(specVfsService, "readSpecFile").mockImplementation(async (id, uri) => {
			if (id === narratorId) throw new Error("spec file unreadable");
			return realReadFile(id, uri);
		});
		return () => {
			claimed.mockRestore();
			readFile.mockRestore();
		};
	},
});

describe("outline task source on SQLite", () => {
	for (const scenario of OUTLINE_TASK_SOURCE_SCENARIOS) {
		test(scenario.name, () => scenario.run(scenarioContext));
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// Wording: outline vocabulary, the task's address, both locales
// ─────────────────────────────────────────────────────────────────────────────

const SPEC_WORDS = /spec:\/\/|tasks\.json|Dynamic Spec|taskReflection/;

describe("outline task source wording", () => {
	test("the continuation names the task it chose by its address, in outline words", async () => {
		const id = await session();
		await seedOutlineTasks(id, [{ text: "Write the parser", status: "doing", protected: true }]);
		const { address } = await taskState(id, "Write the parser");
		const source = await taskSourceForNarrator(id);
		const { openTask } = await source.prepareContinuation({ promoteTodo: true });
		if (!openTask) throw new Error("expected a task");
		for (const [locale, marker, person] of [
			["en", "system message", "set by a person"],
			["zh-CN", "系统消息", "人建任务"],
		] as const) {
			const open = source.continuationPrompt({ form: "open", task: openTask, locale });
			const bounded = source.continuationPrompt({
				form: "bounded",
				task: openTask,
				cause: "maxTurns",
				passes: 1,
				maxPasses: 6,
				canAskUserQuestion: false,
				locale,
			});
			for (const prompt of [open, bounded]) {
				expect(prompt).toContain(`\`${address}\` Write the parser`);
				expect(prompt).toContain(marker);
				expect(prompt).toContain(person);
				expect(prompt).toContain("OutlineEdit");
				expect(prompt).not.toMatch(SPEC_WORDS);
			}
		}
		// The four outcomes of an ordinary session's prompt.
		const en = source.continuationPrompt({ form: "open", task: openTask, locale: "en" });
		for (const outcome of ["Already done", "keep working", "AskUserQuestion", "No longer matches"])
			expect(en).toContain(outcome);
	});

	test("a waiting target asks to unblock or ask a person; a turn-budget pass names no task", async () => {
		const id = await session();
		const source = await taskSourceForNarrator(id);
		const task = { text: "Ship it", protected: false, status: "blocked" as const };
		const waiting = source.continuationPrompt({ form: "open", task, locale: "en" });
		expect(waiting).toContain("every task is waiting");
		expect(waiting).toContain("add a task for that under it");
		expect(waiting).not.toMatch(SPEC_WORDS);
		const budget = source.continuationPrompt({
			form: "bounded",
			task: { text: "", protected: false, status: "doing" },
			cause: "maxTurns",
			passes: 2,
			maxPasses: 6,
			canAskUserQuestion: false,
			locale: "en",
			turnBudgetOnly: true,
		});
		expect(budget).toContain("turn budget");
		expect(budget).toContain("Self-continuations left: 4");
		expect(budget).not.toContain("Current task");
		expect(budget).not.toMatch(SPEC_WORDS);
	});

	test("interrupt note, compact context and digest text carry addresses, no spec words", async () => {
		const id = await session();
		await seedOutlineTasks(id, [
			{ text: "Write the parser", status: "doing" },
			{ text: "Waiting on access", status: "blocked" },
		]);
		const { address } = await taskState(id, "Write the parser");
		const source = await taskSourceForNarrator(id);
		const { tasks } = await source.openTasks();
		for (const locale of ["en", "zh-CN"] as const) {
			const note = source.interruptGuardNote(tasks, locale);
			expect(note.content).toContain(`\`${address}\` Write the parser`);
			expect(note.content).not.toMatch(SPEC_WORDS);
			expect(note.body).toMatchObject({ kind: "tasks", taskBackend: "outline" });
			const compact = await source.compactContext(locale);
			expect(compact).toContain(address);
			expect(compact).not.toMatch(SPEC_WORDS);
		}
		const { sideCarBodyWithText } = await import("../../../lib/sidecar-templates");
		const digest = await source.taskDigest();
		if (digest?.kind !== "tasks") throw new Error("expected a digest");
		for (const locale of ["en", "zh-CN"] as const) {
			const text = sideCarBodyWithText(
				"living_work_spec",
				{ ...digest, taskBackend: "outline" },
				locale,
			).content;
			expect(text).toContain(address);
			expect(text).toContain("waiting:");
			expect(text).not.toMatch(SPEC_WORDS);
			for (const variant of ["emptyNever", "emptyDone"] as const) {
				const empty = sideCarBodyWithText(
					"living_work_spec",
					{ kind: "tasks", variant, taskBackend: "outline" },
					locale,
				).content;
				expect(empty).toContain("OutlineEdit");
				expect(empty).not.toMatch(SPEC_WORDS);
			}
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Continuation through the real reader (design §4.8, D27a–c)
// ─────────────────────────────────────────────────────────────────────────────

const activeOf = (narratorId: string) => ({ narratorId, locale: "en" }) as ActiveNarrator;

describe("outline continuation (D27a: protectedOnly looks at person-created tasks)", () => {
	test("continues only while a person-created task is open; the target is the first candidate", async () => {
		const id = await session({ mode: "protectedOnly" });
		await seedOutlineTasks(id, [{ text: "Refactor the lexer", status: "doing" }]);
		expect(await maybeStartContinuation(activeOf(id), false)).toBeNull();

		await seedOutlineTasks(id, [
			{ text: "Refactor the lexer", status: "doing" },
			{ text: "The person's goal", status: "todo", protected: true },
		]);
		const prompt = await maybeStartContinuation(activeOf(id), false);
		const { address } = await taskState(id, "Refactor the lexer");
		expect(prompt).toContain(`\`${address}\` Refactor the lexer`);
		expect(prompt).not.toContain("The person's goal");
	});

	test("promotion lands before the mode is consulted, as in spec", async () => {
		const id = await session({ mode: "protectedOnly" });
		await seedOutlineTasks(id, [{ text: "Plain step", status: "todo" }]);
		expect(await maybeStartContinuation(activeOf(id), false)).toBeNull();
		const { block, claim } = await taskState(id, "Plain step");
		expect(block.taskJson?.status).toBe("doing");
		expect(claim?.holderNarratorId).toBe(id);
	});

	test("always continues the session's own tasks; off does not", async () => {
		const id = await session({ mode: "always" });
		await seedOutlineTasks(id, [{ text: "Plain step", status: "doing" }]);
		expect(await maybeStartContinuation(activeOf(id), false)).toContain("Plain step");
		await db.update(narrators).set({ autoContinuationOverride: "off" }).where(eq(narrators.id, id));
		expect(await maybeStartContinuation(activeOf(id), false)).toBeNull();
	});
});

describe("outline continuation (D27b: waiting replaces blocked)", () => {
	test("every candidate waiting: the prompt says split out an unblocking task or ask", async () => {
		const id = await session({ mode: "always" });
		await seedOutlineTasks(id, [{ text: "Deploy to staging", status: "blocked" }]);
		const prompt = await maybeStartContinuation(activeOf(id), false);
		expect(prompt).toContain("every task is waiting");
		expect(prompt).toContain("Deploy to staging");
	});

	test("blockStop stops when every candidate waits, and continues once the wait is gone", async () => {
		const id = await session({ mode: "blockStop" });
		await seedOutlineTasks(id, [{ text: "Deploy to staging", status: "blocked" }]);
		expect(await maybeStartContinuation(activeOf(id), false)).toBeNull();
		await finishPrerequisite(id);
		const prompt = await maybeStartContinuation(activeOf(id), false);
		expect(prompt).toContain("Outline task continuation (system message");
		expect(prompt).toContain("Deploy to staging");
	});

	test("a task the session can start comes before a waiting one", async () => {
		const id = await session({ mode: "blockStop" });
		await seedOutlineTasks(id, [
			{ text: "Deploy to staging", status: "blocked" },
			{ text: "Write the notes", status: "todo" },
		]);
		const prompt = await maybeStartContinuation(activeOf(id), false);
		expect(prompt).toContain("Write the notes");
		expect((await taskState(id, "Write the notes")).claim?.holderNarratorId).toBe(id);
	});

	test("a claim refused by the write path is not a crash: the tasks are read again", async () => {
		const id = await session({ mode: "always" });
		const other = await session();
		await seedOutlineTasks(id, [{ text: "Contested step", status: "todo" }]);
		const { block } = await taskState(id, "Contested step");
		const real = outlineWrite.writeOutline;
		const write = spyOn(outlineWrite, "writeOutline").mockImplementationOnce(async (input) => {
			// Another session starts the task between the read and the claim.
			await real({
				spaceId: block.spaceId,
				ops: [{ op: "setTask", block: { id: block.id }, task: { status: "doing" } }],
				actor: { kind: "agent", id: other },
				narratorId: other,
				responsibleUserId: null,
			});
			return await real(input);
		});
		restores.push(() => write.mockRestore());
		expect(await readSpecContinuationState(id)).toEqual({ openTask: null, protectedOpenCount: 0 });
		expect(write).toHaveBeenCalledTimes(1);
		expect((await taskState(id, "Contested step")).claim?.holderNarratorId).toBe(other);
	});
});

describe("outline continuation (D27c: subagents continue on their turn budget only)", () => {
	test("a pass that ended on its own is not continued, whatever the root's tasks", async () => {
		const root = await session({ mode: "always" });
		await seedOutlineTasks(root, [{ text: "Root work", status: "doing", protected: true }]);
		const sub = await subagent(root, { mode: "always" });
		expect(await maybeStartContinuation(activeOf(sub), false, { cause: "spec" })).toBeNull();
	});

	test("a spent turn budget is continued (protectedOnly does not stop it) up to six passes", async () => {
		const root = await session();
		const sub = await subagent(root, { mode: "protectedOnly" });
		const state = createSpecContinuationState();
		for (let pass = 1; pass <= 6; pass++) {
			const prompt = await maybeStartContinuation(activeOf(sub), false, {
				state,
				cause: "maxTurns",
			});
			expect(prompt).toContain("turn budget");
			expect(prompt).toContain(`Self-continuations left: ${6 - pass}`);
			expect(prompt).not.toMatch(SPEC_WORDS);
			expect(state.passes).toBe(pass);
		}
		expect(
			await maybeStartContinuation(activeOf(sub), false, { state, cause: "maxTurns" }),
		).toBeNull();
		expect(state.stop?.reason).toBe("passLimit");
		// What its recipient is told when the run ends: no task list it never had.
		expect(state.turnBudgetOnly).toBe(true);
		if (!state.stop) throw new Error("expected a stop");
		const note = specContinuationStopNote(state.stop, "en", { turnBudgetOnly: true });
		expect(note).toContain("before giving a final reply");
		expect(note).not.toMatch(SPEC_WORDS);
	});

	test("the stall rule still stops it, and off still means off", async () => {
		const root = await session();
		const stalled = await subagent(root);
		const active = { ...activeOf(stalled), _continuationSuppressed: true } as ActiveNarrator;
		const state = createSpecContinuationState();
		expect(await maybeStartContinuation(active, false, { state, cause: "maxTurns" })).toBeNull();
		expect(state.stop?.reason).toBe("stalled");

		const off = await subagent(root, { mode: "off" });
		expect(await maybeStartContinuation(activeOf(off), false, { cause: "maxTurns" })).toBeNull();
	});
});
