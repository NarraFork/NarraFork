/**
 * Tool routine mode tests.
 *
 * The three-position switch replaced a boolean, so the derivation has to keep
 * reading old configs correctly (a `enabledRoutines` entry written before this
 * existed still means "resident") and keep writing them (a downgrade, or the
 * `NarraForkAdmin` tool editing `enabledRoutines` directly, must not disagree
 * with `toolModes`). Those two directions are what these tests pin down.
 */
import { describe, expect, test } from "bun:test";
import {
	applyToolRoutineMode,
	clearToolRoutineMode,
	isPreloadedMode,
	normalizeToolRoutineMode,
	normalizeToolRoutineModeOverride,
	type RoutineModeConfig,
	resolveEffectiveToolRoutineMode,
	resolveProjectToolRoutineModeOverride,
	resolveToolRoutineMode,
} from "./routine-modes";

const optIn = { id: "browser" };
const defaultOn = { id: "terminal", defaultEnabled: true };

describe("normalizeToolRoutineMode", () => {
	test("accepts the three positions and rejects everything else", () => {
		expect(normalizeToolRoutineMode("manual")).toBe("manual");
		expect(normalizeToolRoutineMode("auto")).toBe("auto");
		expect(normalizeToolRoutineMode("resident")).toBe("resident");
		expect(normalizeToolRoutineMode("global")).toBeNull();
		expect(normalizeToolRoutineMode("enabled")).toBeNull();
		expect(normalizeToolRoutineMode(true)).toBeNull();
		expect(normalizeToolRoutineMode(undefined)).toBeNull();
	});

	test("the override variant additionally accepts 'global'", () => {
		expect(normalizeToolRoutineModeOverride("global")).toBe("global");
		expect(normalizeToolRoutineModeOverride("auto")).toBe("auto");
		expect(normalizeToolRoutineModeOverride("nonsense")).toBeNull();
	});
});

describe("resolveToolRoutineMode — legacy compatibility", () => {
	test("an unconfigured opt-in routine is manual", () => {
		expect(resolveToolRoutineMode(optIn, {})).toBe("manual");
		expect(resolveToolRoutineMode(optIn, undefined)).toBe("manual");
	});

	test("a legacy enabledRoutines entry reads as resident", () => {
		expect(resolveToolRoutineMode(optIn, { enabledRoutines: ["browser"] })).toBe("resident");
	});

	test("a defaultEnabled routine is resident until blacklisted", () => {
		expect(resolveToolRoutineMode(defaultOn, {})).toBe("resident");
		expect(resolveToolRoutineMode(defaultOn, { disabledRoutines: ["terminal"] })).toBe("manual");
	});

	test("an explicit toolModes entry wins over the legacy lists", () => {
		// This combination is what a stale legacy writer leaves behind; the new
		// field must be the authority or the UI would show a position the session
		// build does not honour.
		const mode = resolveToolRoutineMode(optIn, {
			enabledRoutines: ["browser"],
			toolModes: { browser: "auto" },
		});
		expect(mode).toBe("auto");
	});

	test("an unrecognized toolModes value falls through to the legacy lists", () => {
		expect(
			resolveToolRoutineMode(optIn, {
				enabledRoutines: ["browser"],
				toolModes: { browser: "bogus" },
			}),
		).toBe("resident");
	});
});

describe("project layer", () => {
	test("no project entry means follow global", () => {
		expect(resolveProjectToolRoutineModeOverride(optIn, undefined)).toBe("global");
		expect(resolveProjectToolRoutineModeOverride(optIn, {})).toBe("global");
	});

	test("defaultEnabled is not read as a project opinion", () => {
		// Otherwise every default-on routine would look permanently pinned at the
		// project level and "follow global" would be unreachable in the UI.
		expect(resolveProjectToolRoutineModeOverride(defaultOn, {})).toBe("global");
	});

	test("a project mode overrides the global mode", () => {
		const result = resolveEffectiveToolRoutineMode(
			optIn,
			{ toolModes: { browser: "resident" } },
			{ toolModes: { browser: "manual" } },
		);
		expect(result).toEqual({ mode: "manual", source: "project" });
	});

	test("a project override can turn a globally manual tool resident", () => {
		const result = resolveEffectiveToolRoutineMode(
			optIn,
			{},
			{ toolModes: { browser: "resident" } },
		);
		expect(result).toEqual({ mode: "resident", source: "project" });
	});

	test("legacy project lists still act as overrides", () => {
		expect(resolveEffectiveToolRoutineMode(optIn, {}, { enabledRoutines: ["browser"] })).toEqual({
			mode: "resident",
			source: "project",
		});
		expect(
			resolveEffectiveToolRoutineMode(
				optIn,
				{ enabledRoutines: ["browser"] },
				{ disabledRoutines: ["browser"] },
			),
		).toEqual({ mode: "manual", source: "project" });
	});

	test("an empty project layer defers to global", () => {
		expect(resolveEffectiveToolRoutineMode(optIn, { toolModes: { browser: "auto" } }, {})).toEqual({
			mode: "auto",
			source: "global",
		});
	});
});

describe("retired scheduled task loading preferences", () => {
	const routine = { id: "scheduled_task" };
	const legacy: RoutineModeConfig[] = [
		{ toolModes: { scheduled_task_admin: "manual" } },
		{ toolModes: { scheduled_task_admin: "auto" } },
		{ toolModes: { scheduled_task_admin: "resident" } },
		{ enabledRoutines: ["scheduled_task_admin"] },
		{ disabledRoutines: ["scheduled_task_admin"] },
	];

	test("reads old modes and lists in global and project layers", () => {
		const modes = ["manual", "auto", "resident", "resident", "manual"] as const;
		for (const [index, config] of legacy.entries()) {
			expect(resolveToolRoutineMode(routine, config)).toBe(modes[index]);
			expect(
				resolveEffectiveToolRoutineMode(routine, { toolModes: { scheduled_task: "auto" } }, config),
			).toEqual({ mode: modes[index], source: "project" });
		}
	});

	test("any explicit canonical setting wins over every retired setting in its layer", () => {
		for (const oldConfig of legacy) {
			for (const mode of ["manual", "auto", "resident"] as const) {
				const config = {
					...oldConfig,
					toolModes: { ...oldConfig.toolModes, scheduled_task: mode },
				};
				expect(resolveToolRoutineMode(routine, config)).toBe(mode);
				expect(resolveProjectToolRoutineModeOverride(routine, config)).toBe(mode);
			}
			for (const [field, mode] of [
				["enabledRoutines", "resident"],
				["disabledRoutines", "manual"],
			] as const) {
				const config = { ...oldConfig, [field]: ["scheduled_task"] };
				expect(resolveToolRoutineMode(routine, config)).toBe(mode);
				expect(resolveProjectToolRoutineModeOverride(routine, config)).toBe(mode);
			}
		}
	});

	test("an explicit global or invalid new mode cannot revive the old resident setting", () => {
		for (const mode of ["global", "invalid"]) {
			const config = {
				toolModes: { scheduled_task: mode, scheduled_task_admin: "resident" },
				enabledRoutines: ["scheduled_task_admin"],
			};
			expect(resolveToolRoutineMode(routine, config)).toBe("manual");
			expect(
				resolveEffectiveToolRoutineMode(routine, { toolModes: { scheduled_task: "auto" } }, config),
			).toEqual({ mode: "auto", source: "global" });
		}
	});

	test("writing or clearing the new preference removes old keys without mutating input", () => {
		const original = {
			toolModes: { scheduled_task_admin: "resident", browser: "auto" },
			enabledRoutines: ["scheduled_task_admin", "recall"],
			disabledRoutines: ["scheduled_task_admin", "eval"],
			commands: ["keep"],
		};
		const snapshot = structuredClone(original);
		for (const mode of ["manual", "auto", "resident"] as const) {
			const written = applyToolRoutineMode(original, routine.id, mode);
			expect(resolveToolRoutineMode(routine, written)).toBe(mode);
			expect(written.toolModes).not.toHaveProperty("scheduled_task_admin");
			expect(written.enabledRoutines).not.toContain("scheduled_task_admin");
			expect(written.disabledRoutines).not.toContain("scheduled_task_admin");
			expect(clearToolRoutineMode(written, routine.id)).toEqual({
				toolModes: { browser: "auto" },
				enabledRoutines: ["recall"],
				disabledRoutines: ["eval"],
				commands: ["keep"],
			});
		}
		expect(
			resolveProjectToolRoutineModeOverride(routine, clearToolRoutineMode(original, routine.id)),
		).toBe("global");
		expect(original).toEqual(snapshot);
	});
});

describe("isPreloadedMode", () => {
	test("only resident preloads; auto is loaded on demand", () => {
		expect(isPreloadedMode("resident")).toBe(true);
		expect(isPreloadedMode("manual")).toBe(false);
		// Auto groups enter the tool table through ToolSearch, not session preloading.
		expect(isPreloadedMode("auto")).toBe(false);
	});
});

describe("applyToolRoutineMode", () => {
	test("resident writes the mode and the legacy whitelist together", () => {
		const next = applyToolRoutineMode({}, "browser", "resident");
		expect(next.toolModes).toEqual({ browser: "resident" });
		expect(next.enabledRoutines).toEqual(["browser"]);
		expect(next.disabledRoutines).toEqual([]);
	});

	test("manual writes the mode and the legacy blacklist together", () => {
		const next = applyToolRoutineMode({ enabledRoutines: ["browser"] }, "browser", "manual");
		expect(next.toolModes).toEqual({ browser: "manual" });
		expect(next.enabledRoutines).toEqual([]);
		expect(next.disabledRoutines).toEqual(["browser"]);
	});

	test("auto lands in neither legacy list, so an old reader sees 'not enabled'", () => {
		const next = applyToolRoutineMode({ enabledRoutines: ["browser"] }, "browser", "auto");
		expect(next.toolModes).toEqual({ browser: "auto" });
		expect(next.enabledRoutines).toEqual([]);
		expect(next.disabledRoutines).toEqual([]);
	});

	test("the written config resolves back to the mode that was set", () => {
		for (const mode of ["manual", "auto", "resident"] as const) {
			const next = applyToolRoutineMode({}, "browser", mode);
			expect(resolveToolRoutineMode(optIn, next)).toBe(mode);
		}
	});

	test("other routines and unrelated keys are left alone", () => {
		const next = applyToolRoutineMode(
			{
				enabledRoutines: ["recall"],
				disabledRoutines: ["eval"],
				toolModes: { recall: "resident" },
			},
			"browser",
			"resident",
		);
		expect(next.enabledRoutines).toEqual(["recall", "browser"]);
		expect(next.disabledRoutines).toEqual(["eval"]);
		expect(next.toolModes).toEqual({ recall: "resident", browser: "resident" });
	});

	test("does not mutate its input", () => {
		const config = { enabledRoutines: ["browser"], toolModes: { browser: "resident" } };
		applyToolRoutineMode(config, "browser", "manual");
		expect(config).toEqual({ enabledRoutines: ["browser"], toolModes: { browser: "resident" } });
	});
});

describe("clearToolRoutineMode", () => {
	test("removes every trace so the layer above applies", () => {
		const next = clearToolRoutineMode(
			{ enabledRoutines: ["browser", "recall"], toolModes: { browser: "auto" } },
			"browser",
		);
		expect(next.toolModes).toEqual({});
		expect(next.enabledRoutines).toEqual(["recall"]);
		expect(resolveProjectToolRoutineModeOverride(optIn, next)).toBe("global");
	});
});
