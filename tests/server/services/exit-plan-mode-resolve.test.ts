import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({ db, sqlite }));

const { resolveExitPlanModeInput } = await import("../../../server/services/narrator-permission");
const { activeNarrators } = await import("../../../server/services/narrator-session-state");
const { settings } = await import("../../../server/lib/settings");

const NARRATOR_ID = "n-exit-plan";

let cwd: string;
let previousAllowInline: boolean;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "narrafork-exit-plan-"));
	previousAllowInline = settings.agent.planModeAllowInlinePlan;
	settings.agent.planModeAllowInlinePlan = true;
});

afterEach(() => {
	settings.agent.planModeAllowInlinePlan = previousAllowInline;
	activeNarrators.delete(NARRATOR_ID);
	rmSync(cwd, { recursive: true, force: true });
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.restore();
});

/** Register an active narrator whose only relevant field is the plan file id. */
function setActive(planFileId?: string) {
	// resolveExitPlanModeInput only reads `_planFileId`; cast a minimal stub.
	activeNarrators.set(NARRATOR_ID, { _planFileId: planFileId } as never);
}

describe("resolveExitPlanModeInput — inline_plan normalization", () => {
	it("normalizes a valid inline_plan into the canonical `plan` field", () => {
		setActive(undefined);
		const plan = "## Step 1\n\nDo the thing.\n\n## Step 2\n\nDo the other thing.";
		const result = resolveExitPlanModeInput(NARRATOR_ID, cwd, { inline_plan: plan });

		expect(result.ok).toBe(true);
		expect(result.input.plan).toBe(plan);
		// Model-facing field is stripped after normalization.
		expect("inline_plan" in result.input).toBe(false);
		expect(result.resolvedFromFile).toBe(false);
	});

	it("still accepts the legacy `plan` field for backward compatibility", () => {
		setActive(undefined);
		const plan = "## Plan\n\nStep one.\nStep two.";
		const result = resolveExitPlanModeInput(NARRATOR_ID, cwd, { plan });

		expect(result.ok).toBe(true);
		expect(result.input.plan).toBe(plan);
	});
});

describe("resolveExitPlanModeInput — path-reference rejection", () => {
	it("rejects a `plan_path: <path>` reference string", () => {
		setActive(undefined);
		const result = resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			inline_plan: "plan_path: E:/Mod Project/Who-Am-I-Core/PLAN_SINGLE_SLOT_SYNC.md",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("inline_plan");
			// Corrective message must not be mistaken for a real plan.
			expect(result.message.toLowerCase()).toContain("path");
		}
		// Junk is not carried through as a plan.
		expect(result.input.plan).toBeUndefined();
		expect("inline_plan" in result.input).toBe(false);
	});

	it("rejects a bare Windows path to a markdown file", () => {
		setActive(undefined);
		const result = resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			inline_plan: "E:/Mod Project/Who-Am-I-Core/PLAN_SINGLE_SLOT_SYNC.md",
		});
		expect(result.ok).toBe(false);
	});

	it("rejects a `.narrafork/plan-*.md` short reference", () => {
		setActive(undefined);
		const result = resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			inline_plan: ".narrafork/plan-happy-cat.md",
		});
		expect(result.ok).toBe(false);
	});

	it("does NOT flag a multi-line plan that merely mentions a path", () => {
		setActive(undefined);
		const plan =
			"## Plan\n\nUpdate the config at E:/Mod Project/config.md and rebuild.\n\nThen run tests.";
		const result = resolveExitPlanModeInput(NARRATOR_ID, cwd, { inline_plan: plan });

		expect(result.ok).toBe(true);
		expect(result.input.plan).toBe(plan);
	});
});

describe("resolveExitPlanModeInput — file resolution precedence", () => {
	it("prefers the designated plan file and ignores inline junk", () => {
		const planFileId = "happy-cat";
		setActive(planFileId);
		const fileContent = "## File Plan\n\nThis is the real plan from disk.";
		mkdirSync(join(cwd, ".narrafork"), { recursive: true });
		writeFileSync(join(cwd, ".narrafork", `plan-${planFileId}.md`), fileContent, "utf-8");

		const result = resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			inline_plan: "plan_path: E:/whatever.md",
		});

		expect(result.ok).toBe(true);
		expect(result.resolvedFromFile).toBe(true);
		expect(result.input.plan).toBe(fileContent);
		expect(result.input._planFile).toBe(`.narrafork/plan-${planFileId}.md`);
		// Inline field dropped in favor of the file body.
		expect("inline_plan" in result.input).toBe(false);
	});
});

describe("resolveExitPlanModeInput — inline disabled", () => {
	it("strips both plan and inline_plan when inline plans are disabled", () => {
		settings.agent.planModeAllowInlinePlan = false;
		setActive(undefined);
		const result = resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			plan: "some inline plan",
			inline_plan: "another inline plan",
		});

		expect(result.ok).toBe(false);
		expect(result.input.plan).toBeUndefined();
		expect("inline_plan" in result.input).toBe(false);
	});
});
