/**
 * Behaviour pins for a subagent's bounded self-continuation (registry sources
 * `spec-continuation` and `max-turns-spec-continuation`).
 *
 * ## Why the bound uses pure-function tests
 *
 * This code decides "give the model another pass". Getting it wrong is not a cosmetic
 * bug: an unbounded loop burns money and holds the parent's tool call open forever. So
 * the bound needs tests that pin the exact pass at which it stops — and driving
 * `runSubagentLoop` to that point would need `mock.module`, which in Bun is process-wide
 * pollution. The repository's established seam for loop decisions is a pure planner
 * (`planSubagentInterruption`, `planSubagentPaymentRequired`, …); the bound lives there,
 * so it is testable by simulating the loop's own state threading — which is exactly what
 * the loop body does with the returned plan.
 *
 * The spec-isolation tests use the real spec service. The request-delivery regressions
 * below additionally drive the real executor with real persisted rows and provider
 * history builders; only the next model-pass boundary is spied on and restored.
 */

import { describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators, narratorToolCalls } from "../../db/schema";
import { projectSenderText } from "../../lib/agent/sender-projection";
import { generateId } from "../../lib/id";
import { deleteNugCachedModels, setNugCachedModels } from "../../lib/nug-model-cache";
import { settings, usesStatefulModel } from "../../lib/settings";
import type { ExecuteLoopOptions, ExecuteLoopResult } from "../narrator-executor";
import * as narratorExecutor from "../narrator-executor";
import * as narratorRecovery from "../narrator-recovery";
import { narratorService } from "../narrator-service";
import { writeSpecFile } from "../spec-vfs-service";
import { executeSubagent, readSubagentSpecContinuationState } from "../subagent-executor";
import {
	buildSubagentContinuationPrompt,
	computeContinuationStallState,
	createSubagentContinuationState,
	MAX_SUBAGENT_CONTINUATION_PASSES,
	planSubagentContinuation,
	type SubagentContinuationCause,
	subagentContinuationStopNote,
} from "../turn-continuation-decisions";

const DOING = { text: "Finish the migration", protected: false, status: "doing" as const };
const BLOCKED = { text: "Needs a credential", protected: false, status: "blocked" as const };

/** A pass that ran tools — i.e. made progress, so the stall counter resets. */
const PROGRESS: Pick<ExecuteLoopResult, "hadToolUses" | "taskReflectionDenialFingerprint"> = {
	hadToolUses: true,
};
/** A pass that answered with prose only — no tools, so it counts as a stall. */
const NO_PROGRESS: Pick<ExecuteLoopResult, "hadToolUses" | "taskReflectionDenialFingerprint"> = {
	hadToolUses: false,
};

/**
 * Drive the planner the way the loop body does: thread the returned counters back in,
 * and stop as soon as it declines to continue.
 *
 * Returns every plan produced, so a test can assert on the sequence rather than only on
 * the final state — "it stopped eventually" is not the property that matters, "it stopped
 * on pass N" is.
 */
function runPasses(input: {
	cause?: SubagentContinuationCause;
	results: ReadonlyArray<
		Pick<ExecuteLoopResult, "hadToolUses" | "taskReflectionDenialFingerprint">
	>;
	openTask?: { text: string; protected: boolean; status: "doing" | "blocked" } | null;
	/** Safety net: if the bound is broken, fail loudly instead of hanging the suite. */
	hardCap?: number;
}) {
	const state = createSubagentContinuationState();
	const plans: ReturnType<typeof planSubagentContinuation>[] = [];
	const hardCap = input.hardCap ?? 50;
	for (let i = 0; i < hardCap; i++) {
		const result = input.results[Math.min(i, input.results.length - 1)];
		const plan = planSubagentContinuation({
			cause: input.cause ?? "spec",
			mode: "always",
			openTask: input.openTask === undefined ? DOING : input.openTask,
			protectedOpenCount: 0,
			previous: state,
			result: result as Pick<ExecuteLoopResult, "hadToolUses" | "taskReflectionDenialFingerprint">,
		});
		plans.push(plan);
		// Exactly what the loop body writes back.
		state.stall = plan.stall;
		state.grantedKind = plan.grantedKind;
		if (plan.action !== "continue") return { plans, state };
		state.passes = plan.passes;
	}
	throw new Error(`Continuation did not terminate within ${hardCap} passes — the bound is broken`);
}

describe("the bound actually bounds", () => {
	test("a model that keeps working still stops at the per-run pass cap", () => {
		// The load-bearing case. Every pass calls tools, so the stall counter never fires —
		// this is the alternation the stall rule alone cannot catch, and it is why a subagent
		// needs a pass cap the primary narrator does not: a primary session is long-lived and
		// watched by a human, while this run holds its parent's tool call open the whole time.
		const { plans } = runPasses({ results: [PROGRESS] });
		const continued = plans.filter((plan) => plan.action === "continue");
		expect(continued).toHaveLength(MAX_SUBAGENT_CONTINUATION_PASSES);
		const last = plans[plans.length - 1];
		expect(last).toMatchObject({ action: "stop", reason: "passLimit" });
	});

	test("the pass counter advances by exactly one per granted pass", () => {
		// A counter that failed to advance would read as "bounded" while looping forever.
		const { plans } = runPasses({ results: [PROGRESS] });
		const passes = plans
			.filter((plan) => plan.action === "continue")
			.map((plan) => (plan as { passes: number }).passes);
		expect(passes).toEqual(
			Array.from({ length: MAX_SUBAGENT_CONTINUATION_PASSES }, (_, i) => i + 1),
		);
	});

	test("a model producing nothing stops on the stall rule, well before the pass cap", () => {
		// No tools on any pass. This must stop sooner than `passLimit` and report `stalled`,
		// because "you were given passes and did nothing" is a different message to the
		// parent than "you ran out of budget while working".
		const { plans } = runPasses({ results: [NO_PROGRESS] });
		const continued = plans.filter((plan) => plan.action === "continue");
		expect(continued.length).toBeLessThan(MAX_SUBAGENT_CONTINUATION_PASSES);
		expect(plans[plans.length - 1]).toMatchObject({ action: "stop", reason: "stalled" });
	});

	test("the same repeated protected-task rejection stops it even while tools run", () => {
		// `hadToolUses: true` here — the model IS calling tools, it just keeps attempting one
		// mutation that taskReflection keeps rejecting. Without the fingerprint arm of the
		// stall rule this would run to the pass cap re-attempting the same rejected edit.
		const { plans } = runPasses({
			results: [{ hadToolUses: true, taskReflectionDenialFingerprint: "same-change" }],
		});
		expect(plans[plans.length - 1]).toMatchObject({ action: "stop", reason: "stalled" });
		expect(plans.filter((plan) => plan.action === "continue").length).toBeLessThan(
			MAX_SUBAGENT_CONTINUATION_PASSES,
		);
	});

	test("real progress between stalls resets the stall count but not the pass budget", () => {
		// Alternating no-tools / tools would defeat a bound built only on consecutive stalls.
		// The pass cap is what stops it, and the reported reason must say so.
		const { plans } = runPasses({ results: [NO_PROGRESS, PROGRESS] });
		expect(plans[plans.length - 1]).toMatchObject({ action: "stop", reason: "passLimit" });
	});

	test("a blocked task gets exactly one continuation", () => {
		// Inherited from the primary rule (`kind: "blocked"` has a limit of 1): a blocked task
		// is nudged once, and a model that answers that nudge with prose is not nudged again.
		//
		// One grant, not zero, because the FIRST pass of a run is the parent's dispatched
		// prompt — not a continuation — so it is not judged. The pass that follows it is.
		const { plans } = runPasses({ results: [NO_PROGRESS], openTask: BLOCKED });
		expect(plans.filter((plan) => plan.action === "continue")).toHaveLength(1);
		expect(plans[plans.length - 1]).toMatchObject({ action: "stop", reason: "stalled" });
	});

	test("the parent's own dispatched pass is never charged as a stall", () => {
		// The regression this guards: judging every pass (rather than only granted
		// continuations) charged the parent's prompt as a no-progress continuation. A
		// subagent that replied in prose to its dispatch then got ZERO continuations, so an
		// open `doing` task was silently abandoned — the exact defect D6 was meant to close.
		const first = planSubagentContinuation({
			cause: "spec",
			mode: "always",
			openTask: DOING,
			protectedOpenCount: 0,
			previous: createSubagentContinuationState(),
			result: NO_PROGRESS,
		});
		expect(first).toMatchObject({ action: "continue", passes: 1, grantedKind: "task" });
		expect(first.stall).toEqual({ count: 0, key: undefined });
	});

	test("the max-turns cause shares ONE budget with the spec cause", () => {
		// Two causes with separate budgets could take turns and double the real bound. The
		// counter is per run, so a run that alternates causes still stops at the same total.
		const state = createSubagentContinuationState();
		let granted = 0;
		for (let i = 0; i < 50; i++) {
			const plan = planSubagentContinuation({
				cause: i % 2 === 0 ? "maxTurns" : "spec",
				mode: "always",
				openTask: DOING,
				protectedOpenCount: 0,
				previous: state,
				result: PROGRESS,
			});
			state.stall = plan.stall;
			state.grantedKind = plan.grantedKind;
			if (plan.action !== "continue") break;
			state.passes = plan.passes;
			granted++;
		}
		expect(granted).toBe(MAX_SUBAGENT_CONTINUATION_PASSES);
	});

	test("max-turns continuation is NOT bounded by turn counts", () => {
		// Pinned as a statement of intent: the planner takes no turn count at all. Each
		// continuation pass gets a fresh turn budget upstream, so a bound derived from turns
		// would be no bound. If someone later adds a turn-count input, this fails.
		const plan = planSubagentContinuation({
			cause: "maxTurns",
			mode: "always",
			openTask: DOING,
			protectedOpenCount: 0,
			previous: createSubagentContinuationState(),
			result: PROGRESS,
		});
		expect(plan.action).toBe("continue");
		expect(Object.keys(plan)).not.toContain("turns");
	});
});

describe("when continuation must not happen at all", () => {
	test("no open task means no continuation", () => {
		const plan = planSubagentContinuation({
			cause: "spec",
			mode: "always",
			openTask: null,
			protectedOpenCount: 0,
			previous: createSubagentContinuationState(),
			result: NO_PROGRESS,
		});
		expect(plan.action).toBe("none");
	});

	test("`off` wins over any cause — a subagent has no /goal escape hatch", () => {
		// The primary side has `explicitStart` for a user-typed `/goal`. A subagent has no
		// such command, so `off` is absolute here; anything else would let a dispatched run
		// override an operator's setting.
		for (const cause of ["spec", "maxTurns"] as const) {
			expect(
				planSubagentContinuation({
					cause,
					mode: "off",
					openTask: DOING,
					protectedOpenCount: 0,
					previous: createSubagentContinuationState(),
					result: PROGRESS,
				}).action,
			).toBe("none");
		}
	});

	test("`protectedOnly` continues only while a protected task is open", () => {
		const base = {
			cause: "spec" as const,
			mode: "protectedOnly" as const,
			openTask: DOING,
			previous: createSubagentContinuationState(),
			result: PROGRESS,
		};
		expect(planSubagentContinuation({ ...base, protectedOpenCount: 0 }).action).toBe("none");
		expect(planSubagentContinuation({ ...base, protectedOpenCount: 1 }).action).toBe("continue");
	});

	test("`blockStop` stops on a blocked-only spec but still continues a doing task", () => {
		const base = {
			cause: "spec" as const,
			mode: "blockStop" as const,
			protectedOpenCount: 0,
			previous: createSubagentContinuationState(),
			result: PROGRESS,
		};
		expect(planSubagentContinuation({ ...base, openTask: BLOCKED }).action).toBe("none");
		expect(planSubagentContinuation({ ...base, openTask: DOING }).action).toBe("continue");
	});

	test("suppressed (abort / error) never continues, whatever the spec says", () => {
		expect(
			planSubagentContinuation({
				cause: "spec",
				mode: "always",
				openTask: DOING,
				protectedOpenCount: 0,
				previous: createSubagentContinuationState(),
				result: PROGRESS,
				suppressed: true,
			}).action,
		).toBe("none");
	});

	test("declining preserves the caller's stall state rather than zeroing it", () => {
		// The loop writes `plan.stall` back unconditionally. If a decline returned a fresh
		// zero, one `mode: "off"` pass in the middle of a run would erase the accumulated
		// stall count and let the bound restart.
		const previous = { passes: 2, stall: { count: 2, key: "no-tools:task" } };
		const plan = planSubagentContinuation({
			cause: "spec",
			mode: "off",
			openTask: DOING,
			protectedOpenCount: 0,
			previous,
			result: NO_PROGRESS,
		});
		expect(plan.stall).toEqual({ count: 2, key: "no-tools:task" });
	});
});

describe("the stop note the parent receives", () => {
	// A subagent owes its parent a tool_result. The bound stopping a run is not an error
	// (the work that happened is real), so the ONLY thing distinguishing a bounded stop
	// from a finished answer is this text.
	const stalled = {
		action: "stop" as const,
		cause: "spec" as const,
		reason: "stalled" as const,
		passes: 2,
		stall: { count: 3, key: "no-tools:task" },
	};
	const passLimit = { ...stalled, reason: "passLimit" as const };

	test("names the stall cause and says work is still open", () => {
		const note = subagentContinuationStopNote(stalled, "en");
		expect(note).toContain("no effective progress");
		expect(note).toContain("spec://tasks.json still has open work");
	});

	test("names the pass budget, including the number", () => {
		const note = subagentContinuationStopNote(passLimit, "en");
		expect(note).toContain(String(MAX_SUBAGENT_CONTINUATION_PASSES));
		expect(note).toContain("dispatch again");
	});

	test("the two reasons are distinguishable, not one generic sentence", () => {
		expect(subagentContinuationStopNote(stalled, "en")).not.toBe(
			subagentContinuationStopNote(passLimit, "en"),
		);
	});

	test("both reasons are localized", () => {
		for (const plan of [stalled, passLimit]) {
			const zh = subagentContinuationStopNote(plan, "zh-CN");
			expect(zh).toContain("自动续跑已停止");
			expect(zh).not.toBe(subagentContinuationStopNote(plan, "en"));
		}
	});
});

describe("the continuation prompt", () => {
	test("states that the budget is finite, and what remains", () => {
		// Without this a subagent has no way to know its self-continuations end, so it may
		// keep deferring the summary it owes its parent to a pass that never comes.
		const prompt = buildSubagentContinuationPrompt({
			cause: "spec",
			task: DOING,
			passes: 1,
			locale: "en",
		});
		expect(prompt).toContain(String(MAX_SUBAGENT_CONTINUATION_PASSES - 1));
		expect(prompt).toContain("Self-continuations left");
	});

	test("the remaining count reaches zero on the last pass and never goes negative", () => {
		const last = buildSubagentContinuationPrompt({
			cause: "spec",
			task: DOING,
			passes: MAX_SUBAGENT_CONTINUATION_PASSES,
			locale: "en",
		});
		expect(last).toContain("Self-continuations left: 0");
		const overshoot = buildSubagentContinuationPrompt({
			cause: "spec",
			task: DOING,
			passes: MAX_SUBAGENT_CONTINUATION_PASSES + 5,
			locale: "en",
		});
		// A negative "continuations left" would read as nonsense to the model; clamped.
		expect(overshoot).toContain("Self-continuations left: 0");
		expect(overshoot).not.toMatch(/left: -\d/);
	});

	test("the max-turns cause says the BUDGET ended the pass, not the work", () => {
		// The failure this prevents: a model told only "you were given another pass" after a
		// max-turns cut reads it as a verdict on its work and redoes finished changes.
		const prompt = buildSubagentContinuationPrompt({
			cause: "maxTurns",
			task: DOING,
			passes: 1,
			locale: "en",
		});
		expect(prompt).toContain("turn budget");
		expect(prompt).toContain("not a judgement on your work");
	});

	test("it identifies itself as system-generated, not the user or the parent", () => {
		// The primary prompt learned this the hard way: a restated task read as the user
		// insisting the work was unfinished. A subagent has a second possible speaker to
		// disclaim — its parent — since a real parent instruction arrives the same way.
		for (const locale of ["en", "zh-CN"] as const) {
			const prompt = buildSubagentContinuationPrompt({
				cause: "spec",
				task: DOING,
				passes: 1,
				locale,
			});
			if (locale === "en") {
				expect(prompt).toContain("not the user and not your parent speaking");
			} else {
				expect(prompt).toContain("不是用户或父级发言");
			}
		}
	});

	test("it offers reporting back instead of AskUserQuestion, which a subagent lacks", () => {
		// `DISALLOWED_SUBAGENT_TOOLS` removes AskUserQuestion. The primary blocked prompt
		// tells the model to ask the user; reproducing that here would order a subagent to
		// call a tool it does not have, and the observed cost of a blocked task with no legal
		// exit is a model that loops.
		const prompt = buildSubagentContinuationPrompt({
			cause: "spec",
			task: BLOCKED,
			passes: 1,
			locale: "en",
		});
		// The tool may be NAMED (saying "you don't have it" is the useful part, since the
		// embedded blocked-task rule speaks of asking a question); what must not appear is an
		// instruction to call it. The legal exit offered instead is ending the run.
		expect(prompt).toContain("you have no AskUserQuestion");
		expect(prompt).not.toMatch(/ask with AskUserQuestion|use AskUserQuestion/);
		expect(prompt).toContain("end this run");
		// And it must still carry the shared blocked-task rule rather than restating it.
		expect(prompt).toContain("add a concrete actionable unblock task");
	});

	test("it names ONE task and says the rest are still in the file", () => {
		// A model that reads the single named task as the whole file "restores" the others by
		// rewriting tasks.json, destroying entries that were fine.
		const prompt = buildSubagentContinuationPrompt({
			cause: "spec",
			task: DOING,
			passes: 1,
			locale: "en",
		});
		expect(prompt).toContain("this one only");
		expect(prompt).toContain("edit in place");
	});

	test("a protected task carries its taskReflection warning", () => {
		const prompt = buildSubagentContinuationPrompt({
			cause: "spec",
			task: { ...DOING, protected: true },
			passes: 1,
			locale: "en",
		});
		expect(prompt).toContain("[protected]");
		expect(prompt).toContain("taskReflection");
	});
});

describe("the shared stall rule is genuinely shared", () => {
	test("the subagent planner's classification matches computeContinuationStallState", () => {
		// The whole point of reusing the primary's rule is that there is ONE rule. If the
		// planner ever grew its own classification, the two audiences would drift again —
		// which is the bug class the registry exists to prevent.
		const cases: Array<Pick<ExecuteLoopResult, "hadToolUses" | "taskReflectionDenialFingerprint">> =
			[
				{ hadToolUses: true },
				{ hadToolUses: false },
				{ hadToolUses: true, taskReflectionDenialFingerprint: "abc" },
			];
		for (const result of cases) {
			for (const grantedKind of ["task", "blocked"] as const) {
				const previous = {
					passes: 0,
					stall: { count: 1, key: "no-tools:task" },
					grantedKind,
				};
				const plan = planSubagentContinuation({
					cause: "spec",
					mode: "always",
					openTask: DOING,
					protectedOpenCount: 0,
					previous,
					result,
				});
				const expected = computeContinuationStallState(grantedKind, result, previous.stall);
				expect(plan.stall).toEqual({ count: expected.count, key: expected.key });
				expect(plan.action === "stop" && plan.reason === "stalled").toBe(expected.suppressed);
			}
		}
	});

	test("the judged kind is the kind that was GRANTED, not the task open right now", () => {
		// A model may edit its own spec during the pass. The stall counter is judging "did
		// the continuation I granted accomplish anything", so it must use the granted kind:
		// a blocked grant has a limit of 1 while a task grant has 3, and reading the current
		// task's status instead would silently switch limits mid-run.
		const previous = { passes: 1, stall: { count: 0 }, grantedKind: "blocked" as const };
		const plan = planSubagentContinuation({
			cause: "spec",
			mode: "always",
			// Now a `doing` task, but the grant being judged was for a blocked one.
			openTask: DOING,
			protectedOpenCount: 0,
			previous,
			result: NO_PROGRESS,
		});
		// blocked's limit is 1, so one no-progress pass is already terminal.
		expect(plan).toMatchObject({ action: "stop", reason: "stalled" });
		expect(plan.stall.key).toBe("no-tools:blocked");
	});
});

describe("the spec read is the SUBAGENT's own namespace", () => {
	// Spec files are keyed by narratorId (`spec_namespaces.narratorId`), so reading the
	// parent's would continue a subagent for tasks it never had — and would look like a
	// model defect, since the injected reminder would name an unfamiliar task.
	test("a subagent sees its own doing task, and its parent's does not leak in", async () => {
		const { db } = await import("../../db");
		const { narrators } = await import("../../db/schema");
		const { generateId } = await import("../../lib/id");
		const { writeSpecFile } = await import("../spec-vfs-service");

		const parentId = generateId();
		const childId = generateId();
		const now = new Date().toISOString();
		for (const [id, variant] of [
			[parentId, "primary"],
			[childId, "subagent:general"],
		] as const) {
			await db.insert(narrators).values({
				id,
				type: variant === "primary" ? "primary" : "subagent",
				variant,
				traits: ["standalone"],
				model: "default",
				permissionMode: "default",
				status: "idle",
				createdAt: now,
				updatedAt: now,
			});
		}

		await writeSpecFile(
			parentId,
			"spec://tasks.json",
			`${JSON.stringify({ tasks: [{ text: "PARENT task", status: "doing" }] }, null, "\t")}\n`,
			{ actor: "agent", createdBy: "assistant" },
		);
		await writeSpecFile(
			childId,
			"spec://tasks.json",
			`${JSON.stringify(
				{ tasks: [{ text: "CHILD task", status: "doing", protected: true }] },
				null,
				"\t",
			)}\n`,
			{ actor: "agent", createdBy: "assistant", allowProtectedTaskMutation: true },
		);

		const child = await readSubagentSpecContinuationState(childId);
		expect(child.openTask).toEqual({ text: "CHILD task", protected: true, status: "doing" });
		expect(child.protectedOpenCount).toBe(1);

		const parent = await readSubagentSpecContinuationState(parentId);
		expect(parent.openTask?.text).toBe("PARENT task");
	});

	test("a subagent whose own spec is empty gets no continuation, even beside a busy parent", async () => {
		const { db } = await import("../../db");
		const { narrators } = await import("../../db/schema");
		const { generateId } = await import("../../lib/id");
		const { writeSpecFile } = await import("../spec-vfs-service");

		const parentId = generateId();
		const childId = generateId();
		const now = new Date().toISOString();
		for (const id of [parentId, childId]) {
			await db.insert(narrators).values({
				id,
				type: id === childId ? "subagent" : "primary",
				variant: id === childId ? "subagent:general" : "primary",
				traits: ["standalone"],
				model: "default",
				permissionMode: "default",
				status: "idle",
				createdAt: now,
				updatedAt: now,
			});
		}
		await writeSpecFile(
			parentId,
			"spec://tasks.json",
			`${JSON.stringify({ tasks: [{ text: "parent still working", status: "doing" }] }, null, "\t")}\n`,
			{ actor: "agent", createdBy: "assistant" },
		);

		const child = await readSubagentSpecContinuationState(childId);
		expect(child.openTask).toBeNull();
		// And the planner therefore declines, which is the behaviour that matters.
		expect(
			planSubagentContinuation({
				cause: "spec",
				mode: "always",
				openTask: child.openTask,
				protectedOpenCount: child.protectedOpenCount,
				previous: createSubagentContinuationState(),
				result: PROGRESS,
			}).action,
		).toBe("none");
	});

	test("a doing task outranks a blocked one, and a blocked-only spec reports blocked", async () => {
		const { db } = await import("../../db");
		const { narrators } = await import("../../db/schema");
		const { generateId } = await import("../../lib/id");
		const { writeSpecFile } = await import("../spec-vfs-service");

		const bothId = generateId();
		const blockedOnlyId = generateId();
		const now = new Date().toISOString();
		for (const id of [bothId, blockedOnlyId]) {
			await db.insert(narrators).values({
				id,
				type: "subagent",
				variant: "subagent:general",
				traits: ["standalone"],
				model: "default",
				permissionMode: "default",
				status: "idle",
				createdAt: now,
				updatedAt: now,
			});
		}
		await writeSpecFile(
			bothId,
			"spec://tasks.json",
			`${JSON.stringify(
				{
					tasks: [
						{ text: "stuck", status: "blocked" },
						{ text: "in flight", status: "doing" },
					],
				},
				null,
				"\t",
			)}\n`,
			{ actor: "agent", createdBy: "assistant" },
		);
		await writeSpecFile(
			blockedOnlyId,
			"spec://tasks.json",
			`${JSON.stringify({ tasks: [{ text: "only stuck", status: "blocked" }] }, null, "\t")}\n`,
			{ actor: "agent", createdBy: "assistant" },
		);

		expect((await readSubagentSpecContinuationState(bothId)).openTask?.status).toBe("doing");
		expect((await readSubagentSpecContinuationState(blockedOnlyId)).openTask?.status).toBe(
			"blocked",
		);
	});

	test("a `todo`-only spec does not continue the run", async () => {
		// Deliberately different from the primary path, which promotes a `todo` to `doing`.
		// A promotion here would let a subagent grant itself work its parent never asked
		// for: a queue of todos it wrote is planning, not an instruction to keep going.
		const { db } = await import("../../db");
		const { narrators } = await import("../../db/schema");
		const { generateId } = await import("../../lib/id");
		const { writeSpecFile } = await import("../spec-vfs-service");

		const id = generateId();
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id,
			type: "subagent",
			variant: "subagent:general",
			traits: ["standalone"],
			model: "default",
			permissionMode: "default",
			status: "idle",
			createdAt: now,
			updatedAt: now,
		});
		await writeSpecFile(
			id,
			"spec://tasks.json",
			`${JSON.stringify({ tasks: [{ text: "later", status: "todo" }] }, null, "\t")}\n`,
			{ actor: "agent", createdBy: "assistant" },
		);

		const state = await readSubagentSpecContinuationState(id);
		expect(state.openTask).toBeNull();
	});

	test("an unreadable spec yields no task rather than throwing into the loop", async () => {
		// A spec read that fails must not extend a run and must not break the loop's
		// end-of-pass path: the run should simply finish.
		const state = await readSubagentSpecContinuationState("no-such-narrator-id");
		expect(state).toEqual({ openTask: null, protectedOpenCount: 0 });
	});
});

describe("persisted continuation reaches the next executor request", () => {
	async function runContinuation(
		cause: SubagentContinuationCause,
		route: "compatible" | "official" | "nug" | "responses",
		options: { blocked?: boolean; retry?: boolean; hints?: boolean; noTools?: boolean } = {},
	) {
		const prefix = `spec_${route}`;
		const baseModel = route === "responses" ? "gpt-5" : "claude-sonnet-4";
		const savedOpenaiProviders = settings.openaiProviders;
		const providerConfig = {
			id: generateId(),
			name: "Spec continuation regression",
			prefix,
			apiKey: "test-only",
			baseUrl: "https://example.invalid/v1",
			defaultModel: baseModel,
		};
		const model = `${prefix}:${route === "nug" ? "anthropic:" : ""}${baseModel}`;
		if (route === "responses") {
			settings.openaiProviders = [{ ...providerConfig, apiMode: "responses" }];
		} else if (route === "nug") {
			settings.nugProviders = [providerConfig];
			setNugCachedModels(providerConfig.id, [
				{
					id: "anthropic:claude-sonnet-4",
					channel: "anthropic",
					channelType: "anthropic",
					model: "claude-sonnet-4",
					available: true,
				},
			]);
		} else {
			settings.anthropicProviders = [{ ...providerConfig, officialApi: route === "official" }];
		}

		const parentNarratorId = generateId();
		const narratorId = generateId();
		const toolUseId = generateId();
		const completedToolId = generateId();
		const now = new Date().toISOString();
		for (const id of [parentNarratorId, narratorId]) {
			await db.insert(narrators).values({
				id,
				type: id === narratorId ? "subagent" : "primary",
				variant: id === narratorId ? "subagent:general" : "primary",
				parentNarratorId: id === narratorId ? parentNarratorId : null,
				traits: ["standalone"],
				model,
				autoContinuationOverride: "always",
				createdAt: now,
				updatedAt: now,
			});
		}
		const task = options.blocked ? BLOCKED : DOING;
		await writeSpecFile(narratorId, "spec://tasks.json", JSON.stringify({ tasks: [task] }), {
			actor: "agent",
			createdBy: "assistant",
		});
		const prompt = "DISPATCH_MARKER finish the delegated work";
		await narratorService.persistSubagentUserMessage(narratorId, prompt, toolUseId);

		const requests: Pick<ExecuteLoopOptions, "userText" | "history" | "trailingToolResults">[] = [];
		const retry = spyOn(narratorRecovery, "handleTransientError").mockResolvedValue({
			shouldRetry: true,
			delayMs: 0,
		});
		const executor = spyOn(narratorExecutor, "executeAgentLoop").mockImplementation(
			async (input) => {
				requests.push({
					userText: input.userText,
					history: structuredClone(input.history),
					trailingToolResults: structuredClone(input.trailingToolResults),
				});
				const success = { finalText: "done", hasError: false, shouldUpdateTitle: false };
				if (requests.length === 1) {
					if (options.hints) {
						await input.config.deliverInjectionRow?.({
							content: "HISTORICAL_SYS_HINT",
							source: "knowledge_base_hint",
						});
					}
					await narratorService.persistAssistantMessage(narratorId, {
						uuid: generateId(),
						session_id: generateId(),
						parent_tool_use_id: toolUseId,
						message: {
							content: [
								{ type: "text", text: "already performed the first step" },
								...(options.noTools
									? []
									: [{ type: "tool_use", id: completedToolId, name: "Read", input: {} }]),
							],
						},
					});
					await db
						.update(narratorToolCalls)
						.set({ status: "success", outputJson: "TOOL_RESULT_MARKER" })
						.where(eq(narratorToolCalls.toolUseId, completedToolId));
					if (options.hints) {
						await input.config.deliverInjectionRow?.({
							content: "FRESH_SYS_HINT",
							source: "knowledge_base_hint",
						});
					}
					return {
						...success,
						hadToolUses: !options.noTools,
						maxTurnsExceeded: cause === "maxTurns",
					};
				}
				if (options.retry && requests.length === 2) {
					return { ...success, retryableError: "test transient failure" };
				}
				// Close the task from the next pass, so the real continuation planner stops.
				await writeSpecFile(
					narratorId,
					"spec://tasks.json",
					JSON.stringify({ tasks: [{ ...task, status: "done" }] }),
					{ actor: "agent", createdBy: "assistant" },
				);
				return success;
			},
		);
		try {
			expect(process.env.NARRAFORK_TEST).toBe("1");
			const result = await executeSubagent({
				narratorId,
				parentNarratorId,
				toolUseId,
				subagentType: "general",
				prompt,
				cwd: process.env.HOME as string,
				model,
				provider: prefix,
				locale: "en",
				signal: new AbortController().signal,
				systemPrompt: "Test subagent",
				initialHistory: [],
			});
			// Use the real configured provider classification, never a mocked identity:
			// Anthropic exhausted its inner retries; Responses can rebuild a stateful session.
			const stateful = usesStatefulModel(prefix, model);
			expect(stateful).toBe(route === "responses");
			const exhaustedStateless = !!options.retry && !stateful;
			expect(result.hasError).toBe(exhaustedStateless);
			expect(requests).toHaveLength(options.retry && stateful ? 3 : 2);
			expect(retry).toHaveBeenCalledTimes(options.retry && stateful ? 1 : 0);
			if (exhaustedStateless) {
				expect(result.finalText).toContain("test transient failure");
				expect((await readSubagentSpecContinuationState(narratorId)).openTask?.status).toBe(
					task.status,
				);
			}
			const rows = await narratorService.getModelHistorySinceLastCompact(narratorId);
			const injections = rows.filter(
				(row) => row.role === "sys" && row.contentText?.includes("Self-continuations left"),
			);
			// A retry must neither grant another Spec continuation nor spend its budget again.
			expect(injections).toHaveLength(1);
			const injection = injections[0];
			expect(injection?.parentToolUseId).toBe(toolUseId);
			const content = injection?.contentText;
			if (!content) throw new Error("expected the persisted continuation sys row");
			expect(content).toContain("Self-continuations left");
			// Stored audit text stays raw; the provider gets authenticated system identity.
			expect(content).not.toContain("<sender");
			const source = options.blocked ? "spec_blocked_continuation" : "spec_continuation";
			const modelContent = projectSenderText(content, { kind: "system", id: source, name: source });
			const freshHint = projectSenderText("FRESH_SYS_HINT", {
				kind: "system",
				id: "knowledge_base_hint",
				name: "knowledge_base_hint",
			});
			for (const request of requests.slice(1)) {
				// Assert the ACTUAL next pass input, not a manually concatenated BuiltHistory.
				if (route === "responses") {
					expect(request.userText).toBe("");
					expect(request.history).toContainEqual({
						role: "user",
						content: [{ type: "input_text", text: modelContent }],
					});
				} else if (route === "official") {
					expect(request.userText).toBe("");
					expect(request.history).toContainEqual({ role: "system", content: modelContent });
				} else {
					expect(request.userText).toBe(
						options.hints ? `${freshHint}\n\n${modelContent}` : modelContent,
					);
					expect(request.trailingToolResults).toEqual(
						options.noTools
							? []
							: [
									{
										tool_use_id: completedToolId,
										content: "TOOL_RESULT_MARKER",
										is_error: undefined,
									},
								],
					);
				}
				expect(request.userText).not.toContain("DISPATCH_MARKER");
				expect(JSON.stringify(request).match(/Self-continuations left/g)).toHaveLength(1);
				expect(JSON.stringify(request).match(/TOOL_RESULT_MARKER/g) ?? []).toHaveLength(
					options.noTools ? 0 : 1,
				);
				if (options.hints) {
					expect(request.userText).not.toContain("HISTORICAL_SYS_HINT");
					expect(JSON.stringify(request.history)).toContain("HISTORICAL_SYS_HINT");
					expect(JSON.stringify(request).match(/HISTORICAL_SYS_HINT/g)).toHaveLength(1);
					expect(JSON.stringify(request).match(/FRESH_SYS_HINT/g)).toHaveLength(1);
				}
			}
		} finally {
			executor.mockRestore();
			retry.mockRestore();
			if (route === "nug") deleteNugCachedModels(providerConfig.id);
			if (route === "responses") settings.openaiProviders = savedOpenaiProviders;
		}
	}

	for (const route of ["compatible", "official", "nug"] as const) {
		for (const cause of ["spec", "maxTurns"] as const) {
			test(`${route}: ${cause} sends the continuation once without losing tool results`, () =>
				runContinuation(cause, route));
		}
	}

	test("natural completion with no pending tools still sends the spec continuation", () =>
		runContinuation("spec", "compatible", { noTools: true }));

	for (const route of ["compatible", "official"] as const) {
		test(`${route}: only fresh sys hints join the continuation, each exactly once`, () =>
			runContinuation("spec", route, { hints: true }));
	}

	test("blocked-task sys prompt reaches the next compatible Anthropic pass", () =>
		runContinuation("spec", "compatible", { blocked: true }));

	test("stateless continuation failure does not multiply retries or spend the Spec budget twice", () =>
		runContinuation("spec", "compatible", { retry: true }));

	test("stateful Responses retry preserves one continuation sys row and one Spec budget grant", () =>
		runContinuation("spec", "responses", { retry: true }));
});
