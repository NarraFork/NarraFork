/**
 * resolveOptionalToolState tests.
 *
 * The Browser dock panel offers a one-click "load browser tool" button when the
 * session has no Browser tool, so the state resolution must agree with what the
 * agent loop's toolFilter would decide:
 *  - unknown names are reported as such
 *  - a custom trait deny-list wins over a persisted load
 *  - persisted enabledTools count as loaded for a dormant (non-active) session
 *  - the three-position routine mode decides preloading, project layer first
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ToolRoutineMode } from "@shared/routine-modes";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { narrators, projects } from "../../db/schema";
import { registerCoreTools } from "../../lib/agent/tools/index";
import { generateId } from "../../lib/id";
import {
	DISABLED_TOOLS_TRAIT_PREFIX,
	normalizeDisabledTools,
	upsertEncodedTrait,
} from "../../lib/narrator-custom-traits";
import { settings } from "../../lib/settings";
import { narratorService } from "../narrator-service";
import { resolveOptionalToolState } from "../narrator-session";

async function createStandaloneNarrator() {
	return narratorService.create({ locale: "en" });
}

const createdProjects: string[] = [];
const createdNarrators: string[] = [];

/**
 * Mutate the in-memory settings object rather than calling `saveSettings`, so the
 * test never writes a real settings file — `resolveOptionalToolState` reads the
 * same singleton either way.
 */
function setGlobalToolMode(routineId: string, mode: ToolRoutineMode | null): void {
	const toolModes = { ...(settings.routines?.toolModes ?? {}) };
	if (mode) {
		toolModes[routineId] = mode;
	} else {
		delete toolModes[routineId];
	}
	settings.routines = {
		disabledRoutines: settings.routines?.disabledRoutines ?? [],
		enabledRoutines: settings.routines?.enabledRoutines ?? [],
		toolModes,
	};
}

async function createProjectWithToolMode(
	routineId: string,
	mode: ToolRoutineMode,
): Promise<string> {
	const now = new Date().toISOString();
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: `Tool mode project ${projectId.slice(0, 6)}`,
		chapterSettings: JSON.stringify({ routines: { toolModes: { [routineId]: mode } } }),
		createdAt: now,
		updatedAt: now,
	});
	createdProjects.push(projectId);
	return projectId;
}

async function createNarratorInProject(projectId: string): Promise<string> {
	const narrator = await narratorService.create({ locale: "en", contextProjectId: projectId });
	createdNarrators.push(narrator.id);
	return narrator.id;
}

afterEach(async () => {
	setGlobalToolMode("browser", null);
	// Narrators reference the project via contextProjectId, so they go first or
	// the project delete trips the foreign key.
	if (createdNarrators.length > 0) {
		await db.delete(narrators).where(inArray(narrators.id, createdNarrators.splice(0)));
	}
	if (createdProjects.length > 0) {
		await db.delete(projects).where(inArray(projects.id, createdProjects.splice(0)));
	}
});

describe("resolveOptionalToolState", () => {
	test("reports unknown_tool for names outside OPTIONAL_TOOLS", async () => {
		const narrator = await createStandaloneNarrator();
		const result = await resolveOptionalToolState(narrator.id, "NotARealTool");
		expect(result.state).toBe("unknown_tool");
	});

	test("a fresh narrator has no Browser tool loaded", async () => {
		const narrator = await createStandaloneNarrator();
		const result = await resolveOptionalToolState(narrator.id, "Browser");
		// The browser routine is not defaultEnabled, so nothing enables it yet.
		expect(result.globallyEnabled).toBe(false);
		expect(result.state).toBe("not_loaded");
	});

	test("persisted enabledTools makes it loaded without an active session", async () => {
		const narrator = await createStandaloneNarrator();
		await db
			.update(narrators)
			.set({ enabledTools: ["Browser"] })
			.where(eq(narrators.id, narrator.id));
		const result = await resolveOptionalToolState(narrator.id, "Browser");
		expect(result.state).toBe("loaded");
	});

	test("a custom trait deny-list wins over a persisted load", async () => {
		// normalizeDisabledTools drops names absent from the registry.
		registerCoreTools();
		const narrator = await createStandaloneNarrator();
		const disabled = normalizeDisabledTools(["Browser"]);
		expect(disabled.tools).toContain("Browser");
		await db
			.update(narrators)
			.set({
				enabledTools: ["Browser"],
				traits: upsertEncodedTrait(narrator.traits, DISABLED_TOOLS_TRAIT_PREFIX, disabled),
			})
			.where(eq(narrators.id, narrator.id));
		const result = await resolveOptionalToolState(narrator.id, "Browser");
		expect(result.state).toBe("disabled_by_trait");
	});

	test("throws for a missing narrator", async () => {
		expect(resolveOptionalToolState("does-not-exist", "Browser")).rejects.toThrow();
	});
});

describe("resolveOptionalToolState — routine modes", () => {
	test("a globally resident tool is loaded without any per-narrator state", async () => {
		const narrator = await createStandaloneNarrator();
		createdNarrators.push(narrator.id);
		setGlobalToolMode("browser", "resident");

		const result = await resolveOptionalToolState(narrator.id, "Browser");
		expect(result.mode).toBe("resident");
		expect(result.globallyEnabled).toBe(true);
		expect(result.state).toBe("loaded");
	});

	test("auto does not preload — toolsearch is not implemented yet", async () => {
		const narrator = await createStandaloneNarrator();
		createdNarrators.push(narrator.id);
		setGlobalToolMode("browser", "auto");

		const result = await resolveOptionalToolState(narrator.id, "Browser");
		expect(result.mode).toBe("auto");
		expect(result.globallyEnabled).toBe(false);
		expect(result.state).toBe("not_loaded");
	});

	test("manual does not preload", async () => {
		const narrator = await createStandaloneNarrator();
		createdNarrators.push(narrator.id);
		setGlobalToolMode("browser", "manual");

		const result = await resolveOptionalToolState(narrator.id, "Browser");
		expect(result.mode).toBe("manual");
		expect(result.state).toBe("not_loaded");
	});

	test("a project resident override loads it for a narrator in that project", async () => {
		// Before modes, a project-level enable on a tool routine was silently inert:
		// only global settings were consulted when a session was built.
		setGlobalToolMode("browser", "manual");
		const projectId = await createProjectWithToolMode("browser", "resident");
		const narratorId = await createNarratorInProject(projectId);

		const result = await resolveOptionalToolState(narratorId, "Browser");
		expect(result.mode).toBe("resident");
		expect(result.state).toBe("loaded");
	});

	test("a project manual override wins over a globally resident tool", async () => {
		setGlobalToolMode("browser", "resident");
		const projectId = await createProjectWithToolMode("browser", "manual");
		const narratorId = await createNarratorInProject(projectId);

		const result = await resolveOptionalToolState(narratorId, "Browser");
		expect(result.mode).toBe("manual");
		expect(result.state).toBe("not_loaded");
	});

	test("a trait deny-list still wins over a resident mode", async () => {
		registerCoreTools();
		setGlobalToolMode("browser", "resident");
		const narrator = await createStandaloneNarrator();
		createdNarrators.push(narrator.id);
		const disabled = normalizeDisabledTools(["Browser"]);
		await db
			.update(narrators)
			.set({ traits: upsertEncodedTrait(narrator.traits, DISABLED_TOOLS_TRAIT_PREFIX, disabled) })
			.where(eq(narrators.id, narrator.id));

		const result = await resolveOptionalToolState(narrator.id, "Browser");
		expect(result.state).toBe("disabled_by_trait");
	});
});
