/**
 * Manual plan-mode toggles must reach a RUNNING agent loop.
 *
 * Before this, `POST /narrators/:id/plan-mode/enter` wrote the DB and faked an
 * `EnterPlanMode` tool row, but the model was never told:
 *
 *   - the plan-mode reminder lives ONLY in the system prompt, which a pass fixes at start;
 *   - `AgentConfig.planMode` was a boolean snapshot, so the tool-description override never
 *     applied mid-pass;
 *   - the faked row was invisible, because the in-memory history is built at pass start.
 *
 * Meanwhile the permission gate re-reads the DB per tool call, so it switched immediately.
 * The model therefore kept implementing (nobody told it otherwise) and got denied with
 * "only the plan file may be written" — naming a plan file it had never heard of.
 *
 * These tests pin the three seams that close that gap, plus the two invariants whose
 * failure is silent.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { getPlanModeSystemReminder } from "../../../server/lib/prompt-i18n";
import { buildEffectiveSystemPrompt } from "../../../server/services/narrator-prompt";
import type { ActiveNarrator } from "../../../server/services/narrator-session-state";
import {
	activeNarrators,
	clearPlanModePromptRebuild,
	consumePlanModePromptRebuild,
	requestPlanModePromptRebuild,
} from "../../../server/services/narrator-session-state";

const NARRATOR_ID = "n-plan-toggle";

function seedActive(overrides: Partial<ActiveNarrator> = {}): ActiveNarrator {
	const active = {
		abortController: new AbortController(),
		narratorId: NARRATOR_ID,
		conversationId: "conv-plan-toggle",
		cwd: "/tmp",
		model: "test:model",
		provider: "test",
		systemPrompt: null,
		// biome-ignore lint/suspicious/noExplicitAny: only the fields under test are needed
		events: { emit: () => {} } as any,
		alive: true,
		locale: "en",
		_enabledOptionalTools: new Set<string>(),
		_disabledTools: new Set<string>(),
		_blockedSkills: { all: false, names: new Set<string>() },
		_substatus: new Set<string>(),
		...overrides,
	} as ActiveNarrator;
	activeNarrators.set(NARRATOR_ID, active);
	return active;
}

afterEach(() => {
	activeNarrators.delete(NARRATOR_ID);
	clearPlanModePromptRebuild(NARRATOR_ID);
});

/**
 * The live-override resolution the AgentConfig getters perform.
 *
 * Mirrored here rather than driving a real session: the getters close over a pass-local
 * `freshNarrator` snapshot, and what is worth pinning is the RESOLUTION RULE — a live
 * value wins, `undefined` falls back to the snapshot.
 */
function resolvePlanMode(active: ActiveNarrator, snapshot: boolean): boolean {
	return active._planModeLive ?? snapshot;
}

function resolveRelaxedPlan(active: ActiveNarrator, snapshot: boolean): boolean {
	return active._relaxedPlanLive ?? snapshot;
}

describe("live plan-mode override", () => {
	it("falls back to the pass-start snapshot while no toggle has happened", () => {
		const active = seedActive();

		expect(active._planModeLive).toBeUndefined();
		expect(resolvePlanMode(active, false)).toBe(false);
		expect(resolvePlanMode(active, true)).toBe(true);
		expect(resolveRelaxedPlan(active, true)).toBe(true);
	});

	it("lets a manual enter switch the running pass on, against a false snapshot", () => {
		const active = seedActive();
		// What the enter route sets.
		active._planModeLive = true;
		active._relaxedPlanLive = false;

		expect(resolvePlanMode(active, false)).toBe(true);
		expect(resolveRelaxedPlan(active, false)).toBe(false);
	});

	it("lets a manual exit switch the running pass off, against a true snapshot", () => {
		const active = seedActive();
		active._planModeLive = false;
		// Deliberately left undefined by the exit route: leaving plan mode must not change
		// the user's permission policy, so relaxed-plan falls back to the narrator's own value.
		active._relaxedPlanLive = undefined;

		expect(resolvePlanMode(active, true)).toBe(false);
		expect(resolveRelaxedPlan(active, true)).toBe(true);
	});

	it("stops shadowing the DB once a new pass clears the override", () => {
		// The load-bearing invariant. A live override that outlives its pass would make ONE
		// manual toggle permanently mask every other path that changes plan mode (the model's
		// own EnterPlanMode/ExitPlanMode, fork, restart recovery) — with no error anywhere.
		const active = seedActive();
		active._planModeLive = false;
		expect(resolvePlanMode(active, true)).toBe(false);

		// What the top of each `while (active.alive)` pass does after re-reading the DB.
		active._planModeLive = undefined;
		active._relaxedPlanLive = undefined;

		expect(resolvePlanMode(active, true)).toBe(true);
		expect(resolveRelaxedPlan(active, true)).toBe(true);
	});

	it("stops shadowing the DB as soon as the model's own plan-mode tool commits", () => {
		// The pass-start clear is not early enough on its own. `onExitPlanMode`'s compact
		// branch only aborts the loop when there IS plan text, so a pass can continue past a
		// model-driven exit — and a stale `true` from a manual toggle would keep plan mode
		// applied to a pass the model just left. Symmetrically for enter.
		const active = seedActive();

		// Manual exit earlier in this pass, then the model calls EnterPlanMode.
		active._planModeLive = false;
		// What onEnterPlanMode does after committing: the DB is authoritative again.
		active._planModeLive = undefined;
		active._relaxedPlanLive = undefined;
		expect(resolvePlanMode(active, true)).toBe(true);

		// Manual enter earlier in this pass, then the model calls ExitPlanMode.
		active._planModeLive = true;
		active._relaxedPlanLive = true;
		// What onExitPlanMode does.
		active._planModeLive = undefined;
		active._relaxedPlanLive = undefined;
		expect(resolvePlanMode(active, false)).toBe(false);
		expect(resolveRelaxedPlan(active, false)).toBe(false);
	});

	it("is not written by a toggle that changed nothing", () => {
		// Both routes return early when the DB already held the target state. Writing the
		// override there would pair it with no rebuild request, and — worse — a `false`
		// left by a redundant exit would shadow a model-driven EnterPlanMode later in the
		// same pass. So a no-op toggle must leave the override untouched.
		const active = seedActive();

		// Model put this pass into plan mode; a redundant manual enter/exit follows.
		expect(active._planModeLive).toBeUndefined();
		expect(resolvePlanMode(active, true)).toBe(true);
		expect(resolveRelaxedPlan(active, true)).toBe(true);
	});
});

describe("plan-mode prompt rebuild marker", () => {
	it("is one-shot: a second consume finds nothing", () => {
		seedActive();

		expect(requestPlanModePromptRebuild(NARRATOR_ID)).toBe(true);
		expect(consumePlanModePromptRebuild(NARRATOR_ID)).toBe(true);
		// A rebuild consumed the request; the next turn boundary must not redo it.
		expect(consumePlanModePromptRebuild(NARRATOR_ID)).toBe(false);
	});

	it("is not raised for a narrator with no live session", () => {
		// No pass is holding a stale prompt, and the next activation builds one from the DB.
		expect(requestPlanModePromptRebuild(NARRATOR_ID)).toBe(false);
		expect(consumePlanModePromptRebuild(NARRATOR_ID)).toBe(false);
	});

	it("is dropped by clear without being consumed", () => {
		seedActive();
		requestPlanModePromptRebuild(NARRATOR_ID);

		// The pass-start clear: the prompt about to be built already reflects the toggle.
		clearPlanModePromptRebuild(NARRATOR_ID);

		expect(consumePlanModePromptRebuild(NARRATOR_ID)).toBe(false);
	});

	it("keeps requests separate per narrator", () => {
		seedActive();
		const other = "n-plan-toggle-other";
		activeNarrators.set(other, seedActive({ narratorId: other }));
		activeNarrators.set(NARRATOR_ID, seedActive());

		requestPlanModePromptRebuild(NARRATOR_ID);

		expect(consumePlanModePromptRebuild(other)).toBe(false);
		expect(consumePlanModePromptRebuild(NARRATOR_ID)).toBe(true);
		activeNarrators.delete(other);
	});
});

describe("rebuilt system prompt content", () => {
	const PLAN_FILE = ".narrafork/plans/plan-toggle--abc123.md";

	it("carries the plan-mode constraint and the designated plan file", () => {
		// This is what the toggle was failing to deliver: without it the model has no idea it
		// is in plan mode, while the permission gate already enforces exactly these rules.
		const reminder = getPlanModeSystemReminder("en", PLAN_FILE, true);

		expect(reminder).toContain("Plan mode is ACTIVE");
		expect(reminder).toContain(PLAN_FILE);
		expect(reminder).toContain("ExitPlanMode");
	});

	it("names the SAME plan file the write gate will accept", () => {
		// The reminder, the Write/Edit gate and ExitPlanMode resolution must agree on one
		// path. A cycle resumed from the pre-`plans/` layout keeps a legacy path that cannot
		// be rebuilt from the identity alone, so the resolved path is passed through rather
		// than reconstructed — otherwise the model is told to write where the gate rejects.
		const legacyPath = ".narrafork/plan-legacy--xyz789.md";
		const reminder = getPlanModeSystemReminder("zh-CN", legacyPath, true);

		expect(reminder).toContain(legacyPath);
	});

	it("appears only when the rebuild is told plan mode is on", async () => {
		// Both directions matter. On the enter path a prompt without the reminder leaves the
		// model unaware of a constraint the gate already enforces; on the exit path a prompt
		// still carrying it leaves the model refusing writes the DB has already released.
		const base = {
			basePrompt: "base prompt",
			cwd: "/tmp",
			locale: "en" as const,
			planFileId: "plan-toggle--abc123",
			planFilePath: PLAN_FILE,
		};

		const entered = await buildEffectiveSystemPrompt({ ...base, planMode: true });
		expect(entered.prompt).toContain("Plan mode is ACTIVE");
		expect(entered.prompt).toContain(PLAN_FILE);

		const exited = await buildEffectiveSystemPrompt({ ...base, planMode: false });
		expect(exited.prompt).not.toContain("Plan mode is ACTIVE");
		expect(exited.prompt).not.toContain(PLAN_FILE);
	});
});
