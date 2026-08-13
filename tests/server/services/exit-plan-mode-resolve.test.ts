import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExecutionBackend,
	FileStat,
	ReadBytesOptions,
	ReadBytesResult,
} from "../../../server/lib/agent/execution/backend";
import { targetPathSemantics } from "../../../server/lib/agent/execution/path-semantics";
import type { ToolExecutionTarget } from "../../../server/lib/agent/types";
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

beforeEach(async () => {
	cwd = mkdtempSync(join(tmpdir(), "narrafork-exit-plan-"));
	previousAllowInline = settings.agent.planModeAllowInlinePlan;
	settings.agent.planModeAllowInlinePlan = true;
});

afterEach(async () => {
	settings.agent.planModeAllowInlinePlan = previousAllowInline;
	activeNarrators.delete(NARRATOR_ID);
	rmSync(cwd, { recursive: true, force: true });
	cleanDb(sqlite);
});

afterAll(async () => {
	mock.module("../../../server/db", () => realDbModule);
	mock.restore();
});

/** Register an active narrator whose only relevant field is the plan file id. */
function setActive(planFileId?: string, planFilePath?: string) {
	activeNarrators.set(NARRATOR_ID, {
		_planFileId: planFileId,
		_planFilePath: planFilePath,
	} as never);
}

type FakePlanEntry = {
	stat: FileStat | null;
	read?: ReadBytesResult;
};

function makeFakeBackend(
	entries: Record<string, FakePlanEntry>,
	options: {
		supportsFsStatResolvedPath?: boolean;
		supportsFsReadAtomicResolvedPath?: boolean;
		includeResolvedPath?: boolean;
	} = {},
) {
	const calls = {
		stat: [] as string[],
		read: [] as string[],
		expectedResolvedPath: [] as Array<string | undefined>,
	};
	const includeResolvedPath = options.includeResolvedPath !== false;
	const backend = {
		deviceId: "remote-plan-test",
		kind: "remote",
		defaultCwd: "/remote/work",
		platform: { os: "linux", arch: "x64" },
		paths: targetPathSemantics("posix"),
		pathFlavor: "posix",
		runtimeGeneration: 1,
		supportsFsStatResolvedPath: options.supportsFsStatResolvedPath ?? true,
		supportsFsReadAtomicResolvedPath: options.supportsFsReadAtomicResolvedPath ?? true,
		statFile: async (path: string) => {
			calls.stat.push(path);
			const exact = entries[path]?.stat;
			if (exact) {
				return includeResolvedPath
					? { ...exact, resolvedPath: exact.resolvedPath ?? path }
					: { ...exact };
			}
			const isParentDir =
				path === "/remote/work" ||
				Object.keys(entries).some((entryPath) => entryPath.startsWith(`${path}/`));
			return isParentDir
				? {
						isFile: false,
						isDirectory: true,
						size: 0,
						...(includeResolvedPath ? { resolvedPath: path } : {}),
					}
				: null;
		},
		readFileBytes: async (path: string, readOptions?: ReadBytesOptions) => {
			calls.read.push(path);
			calls.expectedResolvedPath.push(readOptions?.expectedResolvedPath);
			const result = entries[path]?.read ?? {
				bytes: new Uint8Array(),
				truncated: false,
				totalSize: 0,
			};
			return {
				...result,
				resolvedPath: result.resolvedPath ?? readOptions?.expectedResolvedPath,
			};
		},
	} as unknown as ExecutionBackend;
	return { backend, calls };
}

describe("resolveExitPlanModeInput — inline_plan normalization", async () => {
	it("normalizes a valid inline_plan into the canonical `plan` field", async () => {
		setActive(undefined);
		const plan = "## Step 1\n\nDo the thing.\n\n## Step 2\n\nDo the other thing.";
		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, { inline_plan: plan });

		expect(result.ok).toBe(true);
		expect(result.input.plan).toBe(plan);
		// Model-facing field is stripped after normalization.
		expect("inline_plan" in result.input).toBe(false);
		expect(result.resolvedFromFile).toBe(false);
	});

	it("still accepts the legacy `plan` field for backward compatibility", async () => {
		setActive(undefined);
		const plan = "## Plan\n\nStep one.\nStep two.";
		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, { plan });

		expect(result.ok).toBe(true);
		expect(result.input.plan).toBe(plan);
	});
});

describe("resolveExitPlanModeInput — path-reference rejection", async () => {
	it("rejects a `plan_path: <path>` reference string", async () => {
		setActive(undefined);
		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, {
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

	it("rejects a bare Windows path to a markdown file", async () => {
		setActive(undefined);
		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			inline_plan: "E:/Mod Project/Who-Am-I-Core/PLAN_SINGLE_SLOT_SYNC.md",
		});
		expect(result.ok).toBe(false);
	});

	it("rejects a `.narrafork/plan-*.md` short reference", async () => {
		setActive(undefined);
		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			inline_plan: ".narrafork/plan-happy-cat.md",
		});
		expect(result.ok).toBe(false);
	});

	it("does NOT flag a multi-line plan that merely mentions a path", async () => {
		setActive(undefined);
		const plan =
			"## Plan\n\nUpdate the config at E:/Mod Project/config.md and rebuild.\n\nThen run tests.";
		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, { inline_plan: plan });

		expect(result.ok).toBe(true);
		expect(result.input.plan).toBe(plan);
	});
});

/**
 * Once plan content exists in the designated plan file, an inline submission is
 * refused instead of quietly winning.
 *
 * The plan file is not a convenience copy: it is where the model's planning work
 * was actually recorded, and in strict plan mode it is the only path Write/Edit
 * are allowed to touch. Letting an inline body through would present the user one
 * artifact while discarding the other, and the discarded one is usually the more
 * complete of the two.
 *
 * The probe is advisory: it may only refuse by PROVING a conflict. An unreadable
 * or oversized file proves nothing, and failing there would be worse than
 * allowing the inline plan — file mode already rejects legacy executors, so
 * inline has to remain usable on them.
 */
describe("resolveExitPlanModeInput — inline blocked by a written plan file", async () => {
	function writeDesignatedPlan(planFileId: string, body: string) {
		mkdirSync(join(cwd, ".narrafork"), { recursive: true });
		writeFileSync(join(cwd, ".narrafork", `plan-${planFileId}.md`), body, "utf-8");
	}

	const INLINE = "## Inline plan\n\nA complete inline body.";

	it("refuses an inline plan and names the file mode to use instead", async () => {
		const planFileId = "conflict-written";
		setActive(planFileId);
		writeDesignatedPlan(planFileId, "## File plan\n\nThe work actually recorded.");

		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, { inline_plan: INLINE });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain('mode="file"');
			expect(result.message).toContain(`.narrafork/plan-${planFileId}.md`);
		}
		// Neither body is submitted — the file content must not be silently
		// substituted for the inline declaration either.
		expect(result.input.plan).toBeUndefined();
		expect(result.resolvedFromFile).toBe(false);
	});

	it('refuses an explicitly declared mode="inline" the same way', async () => {
		const planFileId = "conflict-declared";
		setActive(planFileId);
		writeDesignatedPlan(planFileId, "## File plan\n\nAlready written.");

		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			mode: "inline",
			inline_plan: INLINE,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain('mode="file"');
	});

	it('still submits the file plan for mode="file"', async () => {
		const planFileId = "conflict-file-mode";
		setActive(planFileId);
		const body = "## File plan\n\nSubmitted as declared.";
		writeDesignatedPlan(planFileId, body);

		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			mode: "file",
			inline_plan: INLINE,
		});

		expect(result.ok).toBe(true);
		expect(result.resolvedFromFile).toBe(true);
		expect(result.input.plan).toBe(body);
	});

	it("allows an inline plan when no plan file was written", async () => {
		setActive("conflict-absent");

		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, { inline_plan: INLINE });

		expect(result.ok).toBe(true);
		expect(result.input.plan).toBe(INLINE);
		expect(result.resolvedFromFile).toBe(false);
	});

	it("allows an inline plan when the plan file exists but is blank", async () => {
		// A file the model created and never filled is not planning work.
		const planFileId = "conflict-blank";
		setActive(planFileId);
		writeDesignatedPlan(planFileId, "   \n\n");

		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, { inline_plan: INLINE });

		expect(result.ok).toBe(true);
		expect(result.input.plan).toBe(INLINE);
	});

	it("does not apply in relaxed plan mode, where the plan path is model-chosen", async () => {
		const planFileId = "conflict-relaxed";
		setActive(planFileId);
		writeDesignatedPlan(planFileId, "## Some markdown the model wrote earlier.");

		const result = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{ inline_plan: INLINE },
			"en",
			true,
		);

		expect(result.ok).toBe(true);
		expect(result.input.plan).toBe(INLINE);
	});

	it("allows an inline plan when the plan file cannot be read at all", async () => {
		// A legacy executor rejects file-mode submission outright, so a probe failure
		// must not also close the inline path — that would strand the narrator.
		setActive("conflict-legacy");
		const remotePath = "/remote/work/.narrafork/plan-conflict-legacy.md";
		const { backend, calls } = makeFakeBackend(
			{
				[remotePath]: {
					stat: { isFile: true, isDirectory: false, size: 20 },
					read: {
						bytes: new TextEncoder().encode("# file plan"),
						truncated: false,
						totalSize: 20,
					},
				},
			},
			{
				supportsFsStatResolvedPath: false,
				supportsFsReadAtomicResolvedPath: false,
				includeResolvedPath: false,
			},
		);

		const result = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{ inline_plan: INLINE },
			"en",
			false,
			backend,
			{
				deviceId: backend.deviceId,
				backendKind: "remote",
				cwd: "/remote/work",
				resolvedFilePath: remotePath,
				selectionSource: "explicit",
			},
			".narrafork/plan-conflict-legacy.md",
		);

		expect(result.ok).toBe(true);
		expect(result.input.plan).toBe(INLINE);
		expect(calls.read).toEqual([]);
	});

	it("keeps the plan-identity boundary fatal even during the advisory probe", async () => {
		// A malformed plan identity is a boundary violation, not an unreadable file,
		// so the probe's tolerance must not downgrade it.
		setActive("../escape");

		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, { inline_plan: INLINE });

		expect(result.ok).toBe(false);
		expect(result.input.plan).toBeUndefined();
	});
});

/**
 * `mode` declares where the plan comes from and is VERIFIED, not reinterpreted.
 *
 * Without it the source was inferred purely from which optional fields were
 * present, so a model that declared an inline plan but forgot the body silently
 * had a previous cycle's plan file submitted under its name.
 */
describe("resolveExitPlanModeInput — declared mode", async () => {
	/** Write the designated plan file so a wrong fallback would be observable. */
	function writeDesignatedPlan(planFileId: string, body: string) {
		mkdirSync(join(cwd, ".narrafork"), { recursive: true });
		writeFileSync(join(cwd, ".narrafork", `plan-${planFileId}.md`), body, "utf-8");
	}

	it('rejects mode="inline" with no plan body instead of reading the plan file', async () => {
		const planFileId = "declared-inline";
		setActive(planFileId);
		writeDesignatedPlan(planFileId, "## Stale file plan\n\nFrom a previous cycle.");

		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, { mode: "inline" });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("inline_plan");
		// The stale file must NOT be submitted under the model's inline declaration.
		expect(result.input.plan).toBeUndefined();
		expect(result.resolvedFromFile).toBe(false);
	});

	it('accepts mode="inline" with a real body', async () => {
		setActive(undefined);
		const plan = "## Inline Plan\n\nDo the declared work.";
		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, { mode: "inline", plan });

		expect(result.ok).toBe(true);
		expect(result.input.plan).toBe(plan);
		expect(result.resolvedFromFile).toBe(false);
	});

	it('reads the plan file for mode="file" and ignores a stray inline_plan', async () => {
		const planFileId = "declared-file";
		setActive(planFileId);
		const fileContent = "## File Plan\n\nThe authoritative plan.";
		writeDesignatedPlan(planFileId, fileContent);

		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			mode: "file",
			inline_plan: "## Contradictory inline plan",
		});

		expect(result.ok).toBe(true);
		expect(result.resolvedFromFile).toBe(true);
		expect(result.input.plan).toBe(fileContent);
	});

	it('does not fall back to inline_plan when a declared mode="file" plan is missing', async () => {
		setActive(undefined);
		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			mode: "file",
			inline_plan: "## Inline body that must not rescue a declared file plan",
		});

		expect(result.ok).toBe(false);
		expect(result.input.plan).toBeUndefined();
	});

	it('rejects mode="inline" when the instance disables inline plans', async () => {
		settings.agent.planModeAllowInlinePlan = false;
		setActive(undefined);

		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			mode: "inline",
			inline_plan: "## Inline Plan\n\nShould be refused.",
		});

		expect(result.ok).toBe(false);
		expect(result.input.plan).toBeUndefined();
	});

	it("still infers the source when mode is absent or unrecognized", async () => {
		// Required in the model-facing schema, but a dropped field must not make
		// the tool unusable — inference remains the fallback.
		setActive(undefined);
		const plan = "## Inline Plan\n\nNo mode declared.";

		const missing = await resolveExitPlanModeInput(NARRATOR_ID, cwd, { plan });
		expect(missing.ok).toBe(true);
		expect(missing.input.plan).toBe(plan);

		const garbage = await resolveExitPlanModeInput(NARRATOR_ID, cwd, { mode: "nonsense", plan });
		expect(garbage.ok).toBe(true);
		expect(garbage.input.plan).toBe(plan);
	});

	it("accepts a declared mode case-insensitively", async () => {
		setActive(undefined);
		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			mode: " INLINE ",
			plan: "## Inline Plan\n\nDeclared loudly.",
		});

		expect(result.ok).toBe(true);
	});
});

describe("resolveExitPlanModeInput — file resolution precedence", async () => {
	it("prefers the designated plan file and ignores inline junk", async () => {
		const planFileId = "happy-cat";
		setActive(planFileId);
		const fileContent = "## File Plan\n\nThis is the real plan from disk.";
		mkdirSync(join(cwd, ".narrafork"), { recursive: true });
		writeFileSync(join(cwd, ".narrafork", `plan-${planFileId}.md`), fileContent, "utf-8");

		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			inline_plan: "plan_path: E:/whatever.md",
		});

		expect(result.ok).toBe(true);
		expect(result.resolvedFromFile).toBe(true);
		expect(result.input.plan).toBe(fileContent);
		expect(result.input._planFile).toBe(`.narrafork/plan-${planFileId}.md`);
		// Inline field dropped in favor of the file body.
		expect("inline_plan" in result.input).toBe(false);
	});

	it("refuses an inline plan once the designated remote file holds plan content", async () => {
		// A written plan file IS the artifact the user must review. Accepting an
		// inline body alongside it would show one artifact and silently discard the
		// other, so the inline submission is refused rather than either one winning.
		const remotePath = "/remote/work/.narrafork/plan-inline-choice.md";
		setActive("inline-choice");
		const { backend, calls } = makeFakeBackend({
			[remotePath]: {
				stat: { isFile: true, isDirectory: false, size: 11 },
				read: {
					bytes: new TextEncoder().encode("# file plan"),
					truncated: false,
					totalSize: 11,
				},
			},
		});
		const inlinePlan = "# inline plan\n\nUse this complete submission.";

		const result = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{ inline_plan: inlinePlan },
			"en",
			false,
			backend,
			{
				deviceId: backend.deviceId,
				backendKind: "remote",
				cwd: "/remote/work",
				resolvedFilePath: remotePath,
				selectionSource: "explicit",
			},
			".narrafork/plan-inline-choice.md",
		);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain('mode="file"');
		// Neither body is submitted: the file content must not be swapped in under
		// the model's inline declaration either.
		expect(result.input.plan).toBeUndefined();
		expect(result.resolvedFromFile).toBe(false);
		// The conflict can only be proven by actually reading the file.
		expect(calls.read).toEqual([remotePath]);
	});

	it("does not read a residual plan file from a previous identity", async () => {
		const oldPath = "/remote/work/.narrafork/plan-same-prefix--old.md";
		const newPath = "/remote/work/.narrafork/plan-same-prefix--new.md";
		setActive("same-prefix--new");
		const { backend, calls } = makeFakeBackend({
			[oldPath]: {
				stat: { isFile: true, isDirectory: false, size: 12 },
				read: {
					bytes: new TextEncoder().encode("# stale plan"),
					truncated: false,
					totalSize: 12,
				},
			},
		});

		const result = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{ inline_plan: "# current inline plan" },
			"en",
			false,
			backend,
			{
				deviceId: "remote-plan-test",
				backendKind: "remote",
				cwd: "/remote/work",
				resolvedFilePath: newPath,
				selectionSource: "explicit",
			},
			`.narrafork/plan-same-prefix--new.md`,
		);

		expect(result.ok).toBe(true);
		expect(result.input.plan).toBe("# current inline plan");
		expect(calls.read).toEqual([]);
	});
});

describe("resolveExitPlanModeInput — strict designated path", async () => {
	it("rejects a hidden custom plan_file_path in strict mode", async () => {
		setActive("strict-plan");
		mkdirSync(join(cwd, ".narrafork"), { recursive: true });
		writeFileSync(join(cwd, ".narrafork", "plan-strict-plan.md"), "# Designated plan");
		writeFileSync(join(cwd, "alternate.md"), "# Alternate plan");

		const result = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{ plan_file_path: "alternate.md" },
			"en",
			false,
			undefined,
			undefined,
			".narrafork/plan-strict-plan.md",
		);

		expect(result.ok).toBe(false);
		expect(result.input.plan_file_path).toBeUndefined();
	});

	it("accepts the hidden path only when it names the designated strict plan file", async () => {
		setActive("strict-plan");
		mkdirSync(join(cwd, ".narrafork"), { recursive: true });
		writeFileSync(join(cwd, ".narrafork", "plan-strict-plan.md"), "# Designated plan");

		const result = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{ plan_file_path: ".narrafork/plan-strict-plan.md" },
			"en",
			false,
			undefined,
			undefined,
			".narrafork/plan-strict-plan.md",
		);

		expect(result.ok).toBe(true);
		expect(result.input.plan).toBe("# Designated plan");
	});
});

describe("resolveExitPlanModeInput — strict identity boundary", async () => {
	it("rejects a persisted plan identity containing path separators", async () => {
		setActive("../escape");
		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			inline_plan: "# inline plan",
		});

		expect(result.ok).toBe(false);
		expect(result.resolvedFromFile).toBe(false);
		expect(result.input.plan).toBeUndefined();
	});
});

describe("resolveExitPlanModeInput — inline disabled", async () => {
	it("strips both plan and inline_plan when inline plans are disabled", async () => {
		settings.agent.planModeAllowInlinePlan = false;
		setActive(undefined);
		const result = await resolveExitPlanModeInput(NARRATOR_ID, cwd, {
			plan: "some inline plan",
			inline_plan: "another inline plan",
		});

		expect(result.ok).toBe(false);
		expect(result.input.plan).toBeUndefined();
		expect("inline_plan" in result.input).toBe(false);
	});
});

describe("resolveExitPlanModeInput — backend binding", async () => {
	const remoteTarget: ToolExecutionTarget = {
		deviceId: "remote-plan-test",
		backendKind: "remote",
		cwd: "/remote/work",
		resolvedFilePath: "/remote/work/.narrafork/plan-remote-plan.md",
		selectionSource: "explicit",
	};

	it("reads the designated plan from the frozen remote backend", async () => {
		setActive("remote-plan");
		const remotePath = "/remote/work/.narrafork/plan-remote-plan.md";
		const { backend, calls } = makeFakeBackend({
			[remotePath]: {
				stat: { isFile: true, isDirectory: false, size: 22 },
				read: {
					bytes: new TextEncoder().encode("# Remote plan\n\nShip it."),
					truncated: false,
					totalSize: 22,
				},
			},
		});

		const result = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{},
			"en",
			false,
			backend,
			remoteTarget,
			".narrafork/plan-remote-plan.md",
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.input.plan).toBe("# Remote plan\n\nShip it.");
			expect(result.input._planFile).toBe(".narrafork/plan-remote-plan.md");
		}
		expect(calls.stat).toEqual([remotePath]);
		expect(calls.read).toEqual([remotePath]);
		expect(calls.expectedResolvedPath).toEqual([remotePath]);
	});

	it("requires an executor upgrade for a legacy file-based plan", async () => {
		setActive("legacy-remote-plan");
		const remotePath = "/remote/work/.narrafork/plan-legacy-remote-plan.md";
		const { backend, calls } = makeFakeBackend(
			{
				[remotePath]: {
					stat: { isFile: true, isDirectory: false, size: 12 },
					read: {
						bytes: new TextEncoder().encode("# legacy plan"),
						truncated: false,
						totalSize: 12,
					},
				},
			},
			{
				supportsFsStatResolvedPath: false,
				supportsFsReadAtomicResolvedPath: false,
				includeResolvedPath: false,
			},
		);

		const result = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{},
			"en",
			false,
			backend,
			{ ...remoteTarget, resolvedFilePath: remotePath },
			`.narrafork/plan-legacy-remote-plan.md`,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toMatch(/upgrade.*executor|executor.*upgrade/i);
			expect(result.message).not.toMatch(/regular Markdown|invalid path/i);
		}
		expect(calls.read).toEqual([]);
	});

	it("allows a complete inline plan on a legacy executor without filesystem RPCs", async () => {
		setActive("legacy-inline-plan");
		const remotePath = "/remote/work/.narrafork/plan-legacy-inline-plan.md";
		const { backend, calls } = makeFakeBackend(
			{},
			{
				supportsFsStatResolvedPath: false,
				supportsFsReadAtomicResolvedPath: false,
				includeResolvedPath: false,
			},
		);
		const inlinePlan = "# Inline plan\n\nNo remote file read is needed.";

		const result = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{ inline_plan: inlinePlan },
			"en",
			false,
			backend,
			{ ...remoteTarget, resolvedFilePath: remotePath },
			".narrafork/plan-legacy-inline-plan.md",
		);

		expect(result.ok).toBe(true);
		expect(result.input.plan).toBe(inlinePlan);
		expect(result.resolvedFromFile).toBe(false);
		expect(calls.stat).toEqual([]);
		expect(calls.read).toEqual([]);
	});

	it("requires atomic-read support even when canonical fs.stat is available", async () => {
		setActive("stat-only-plan");
		const remotePath = "/remote/work/.narrafork/plan-stat-only-plan.md";
		const { backend, calls } = makeFakeBackend(
			{
				[remotePath]: {
					stat: { isFile: true, isDirectory: false, size: 6 },
					read: {
						bytes: new TextEncoder().encode("# plan"),
						truncated: false,
						totalSize: 6,
					},
				},
			},
			{ supportsFsReadAtomicResolvedPath: false },
		);

		const result = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{},
			"en",
			false,
			backend,
			{ ...remoteTarget, resolvedFilePath: remotePath },
			".narrafork/plan-stat-only-plan.md",
		);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toMatch(/atomic|upgrade/i);
		expect(calls.stat).toEqual([]);
		expect(calls.read).toEqual([]);
	});

	it("fails closed before reading an external path without a whitelist", async () => {
		setActive("remote-plan");
		const { backend, calls } = makeFakeBackend({
			"/remote/outside/plan.md": {
				stat: { isFile: true, isDirectory: false, size: 8 },
				read: {
					bytes: new TextEncoder().encode("# plan"),
					truncated: false,
					totalSize: 6,
				},
			},
		});
		const target = { ...remoteTarget, resolvedFilePath: "/remote/outside/plan.md" };

		const result = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{ plan_file_path: "/remote/outside/plan.md" },
			"en",
			true,
			backend,
			target,
			undefined,
		);

		expect(result.ok).toBe(false);
		expect(calls.stat).toEqual(["/remote/outside/plan.md"]);
		expect(calls.read).toEqual([]);
	});

	it("allows an external Markdown plan only through a read whitelist", async () => {
		setActive("remote-plan");
		const remotePath = "/remote/outside/plan.md";
		const { backend, calls } = makeFakeBackend({
			[remotePath]: {
				stat: { isFile: true, isDirectory: false, size: 6 },
				read: {
					bytes: new TextEncoder().encode("# plan"),
					truncated: false,
					totalSize: 6,
				},
			},
		});
		const target = { ...remoteTarget, resolvedFilePath: remotePath };

		const result = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{ plan_file_path: remotePath },
			"en",
			true,
			backend,
			target,
			undefined,
			{
				whitelistDirs: [{ path: "/remote/outside", accessLevel: "readOnly", enabled: true }],
				blacklistDirs: [],
			},
		);

		expect(result.ok).toBe(true);
		expect(calls.stat).toEqual([remotePath]);
		expect(calls.read).toEqual([remotePath]);
		expect(calls.expectedResolvedPath).toEqual([remotePath]);
	});

	it("rejects blacklist, directories, and truncated files before exposing content", async () => {
		setActive("remote-plan");
		const remotePath = "/remote/outside/plan.md";
		const { backend, calls } = makeFakeBackend({
			[remotePath]: {
				stat: { isFile: false, isDirectory: true, size: 0 },
			},
		});
		const target = { ...remoteTarget, resolvedFilePath: remotePath };
		const denied = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{ plan_file_path: remotePath },
			"en",
			true,
			backend,
			target,
			undefined,
			{
				whitelistDirs: [{ path: "/remote/outside", accessLevel: "readOnly", enabled: true }],
				blacklistDirs: [{ path: "/remote/outside", denyLevel: "denyAll", enabled: true }],
			},
		);
		expect(denied.ok).toBe(false);
		expect(calls.read).toEqual([]);

		const truncatedPath = "/remote/work/plan.md";
		const truncated = makeFakeBackend({
			[truncatedPath]: {
				stat: { isFile: true, isDirectory: false, size: 4 },
				read: { bytes: new Uint8Array([35]), truncated: true, totalSize: 4 },
			},
		});
		const truncatedResult = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{ plan_file_path: truncatedPath },
			"en",
			true,
			truncated.backend,
			{ ...remoteTarget, resolvedFilePath: truncatedPath },
			undefined,
			{ whitelistDirs: [], blacklistDirs: [] },
		);
		expect(truncatedResult.ok).toBe(false);
		expect(truncated.calls.read).toEqual([truncatedPath]);
	});

	it("rejects a custom path that disagrees with the frozen execution target", async () => {
		setActive("remote-plan");
		const { backend, calls } = makeFakeBackend({
			"/remote/outside/other.md": {
				stat: { isFile: true, isDirectory: false, size: 6 },
			},
		});

		const result = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{ plan_file_path: "/remote/outside/other.md" },
			"en",
			true,
			backend,
			remoteTarget,
			undefined,
			{
				whitelistDirs: [{ path: "/remote/outside", accessLevel: "readOnly", enabled: true }],
				blacklistDirs: [],
			},
		);

		expect(result.ok).toBe(false);
		expect(calls.stat).toEqual([]);
		expect(calls.read).toEqual([]);
	});

	it("re-authorizes a remote symlink against its canonical target", async () => {
		const linkedPath = "/remote/work/linked-plan.md";
		const canonicalPath = "/remote/outside/secret/plan.md";
		const { backend, calls } = makeFakeBackend({
			[linkedPath]: {
				stat: {
					isFile: true,
					isDirectory: false,
					size: 6,
					resolvedPath: canonicalPath,
				},
			},
			[canonicalPath]: {
				stat: { isFile: true, isDirectory: false, size: 6 },
				read: {
					bytes: new TextEncoder().encode("# plan"),
					truncated: false,
					totalSize: 6,
				},
			},
		});

		const result = await resolveExitPlanModeInput(
			NARRATOR_ID,
			cwd,
			{ plan_file_path: linkedPath },
			"en",
			true,
			backend,
			{ ...remoteTarget, resolvedFilePath: linkedPath },
			undefined,
			{
				whitelistDirs: [{ path: "/remote/outside", accessLevel: "readOnly", enabled: true }],
				blacklistDirs: [{ path: "/remote/outside/secret", denyLevel: "denyAll", enabled: true }],
			},
		);

		expect(result.ok).toBe(false);
		expect(calls.read).toEqual([]);
	});

	it("rejects a symlink whose canonical target escapes into a blacklist", async () => {
		const outside = mkdtempSync(join(tmpdir(), "narrafork-exit-plan-outside-"));
		try {
			const secretDir = join(outside, "secret");
			mkdirSync(secretDir, { recursive: true });
			writeFileSync(join(secretDir, "plan.md"), "# Escaped plan");
			symlinkSync(join(secretDir, "plan.md"), join(cwd, "linked-plan.md"));

			const result = await resolveExitPlanModeInput(
				NARRATOR_ID,
				cwd,
				{ plan_file_path: "linked-plan.md" },
				"en",
				true,
				undefined,
				undefined,
				undefined,
				{
					whitelistDirs: [{ path: outside, accessLevel: "readOnly", enabled: true }],
					blacklistDirs: [{ path: secretDir, denyLevel: "denyAll", enabled: true }],
				},
			);

			expect(result.ok).toBe(false);
			expect(result.resolvedFromFile).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
