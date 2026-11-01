import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { getBuiltinRoutine, getBuiltinToolNames } from "../../../server/lib/builtin-routines";
import { settings } from "../../../server/lib/settings";
import {
	applyToolRoutineMode,
	isPreloadedMode,
	resolveEffectiveToolRoutineMode,
} from "../../../shared/routine-modes";
import { cleanDb } from "../../setup";

// The snapshot worker shares the preload-isolated file-backed database.
const { sqlite } = await import("../../../server/db");
const { closePrefixSnapshotStore } = await import(
	"../../../server/services/narrator-prefix-snapshots"
);
const savedRoutines = settings.routines;
const { OPTIONAL_TOOLS } = await import("../../../server/lib/agent/tools/index");
const { toolRegistry } = await import("../../../server/lib/agent/tool-registry");
const { loadOptionalTool, unloadOptionalTool, resolveOptionalToolState } = await import(
	"../../../server/services/narrator-session"
);
const NARRATOR_ID = "notification-registration-test";

beforeEach(async () => {
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	settings.routines = { disabledRoutines: [], enabledRoutines: [], toolModes: {} };
	sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
		NARRATOR_ID,
		"Notification registration",
		"2026-01-01",
		"2026-01-01",
	]);
});
afterAll(async () => {
	await closePrefixSnapshotStore();
	settings.routines = savedRoutines;
});

describe("Notification optional tool integration", () => {
	test("registry and routine expose the same optional tool", () => {
		const tool = OPTIONAL_TOOLS.get("Notification");
		expect(tool?.name).toBe("Notification");
		expect(toolRegistry.get("Notification")).toBe(tool);
		const routine = getBuiltinRoutine("notification");
		if (!routine?.tool) throw new Error("Notification routine missing");
		expect(routine.type).toBe("tool");
		expect(routine.defaultEnabled).not.toBe(true);
		expect(getBuiltinToolNames(routine.tool)).toEqual(["Notification"]);
		expect(isPreloadedMode(resolveEffectiveToolRoutineMode(routine, settings.routines).mode)).toBe(
			false,
		);
	});

	test("default unloaded tool can be loaded and unloaded for one session", async () => {
		expect((await resolveOptionalToolState(NARRATOR_ID, "Notification")).state).toBe("not_loaded");
		expect(await loadOptionalTool(NARRATOR_ID, "Notification")).toBe("loaded");
		expect(await loadOptionalTool(NARRATOR_ID, "Notification")).toBe("already_loaded");
		expect((await resolveOptionalToolState(NARRATOR_ID, "Notification")).state).toBe("loaded");
		expect(await unloadOptionalTool(NARRATOR_ID, "Notification")).toBe("unloaded");
		expect((await resolveOptionalToolState(NARRATOR_ID, "Notification")).state).toBe("not_loaded");
	});

	test("loading a tool the session already preloaded writes no load notice", async () => {
		const { activeNarrators } = await import("../../../server/services/narrator-session-state");
		activeNarrators.set(NARRATOR_ID, { _enabledOptionalTools: new Set(["Notification"]) } as never);
		try {
			// The handler only writes a notice row for "loaded"; a notice would move the
			// preloaded tool out of the request's fixed tool array.
			expect(await loadOptionalTool(NARRATOR_ID, "Notification")).toBe("already_loaded");
		} finally {
			activeNarrators.delete(NARRATOR_ID);
		}
	});

	test("resident preloads while manual and on-demand auto modes start unloaded", async () => {
		for (const mode of ["manual", "auto", "resident"] as const) {
			settings.routines = applyToolRoutineMode(settings.routines, "notification", mode);
			const state = await resolveOptionalToolState(NARRATOR_ID, "Notification");
			expect(state.mode).toBe(mode);
			expect(state.globallyEnabled).toBe(mode === "resident");
			expect(state.state).toBe(mode === "resident" ? "loaded" : "not_loaded");
		}
	});

	test("project mode takes precedence over a global resident setting", () => {
		const routine = getBuiltinRoutine("notification");
		if (!routine) throw new Error("Notification routine missing");
		const global = applyToolRoutineMode({}, "notification", "resident");
		const project = applyToolRoutineMode({}, "notification", "manual");
		expect(resolveEffectiveToolRoutineMode(routine, global, project)).toEqual({
			mode: "manual",
			source: "project",
		});
	});
});
