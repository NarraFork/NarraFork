/**
 * Layered trait enforcement end-to-end through the real database.
 *
 * The pure merge algebra is covered in lib/__tests__/trait-layers.test.ts and the
 * flattening in lib/__tests__/trait-resolution.test.ts. What this file proves is
 * that the layers actually reach the runtime:
 *
 *  - a project-level restriction applies to a narrator that declares nothing
 *  - an enforced project restriction cannot be relaxed by the narrator
 *  - a non-enforced one can
 *  - with no upper layers, behaviour is exactly what it was before layering
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { narrators, projects, userPreferences, users } from "../../db/schema";
import { registerCoreTools } from "../../lib/agent/tools/index";
import { generateId } from "../../lib/id";
import { DISABLED_TOOLS_TRAIT_PREFIX, upsertEncodedTrait } from "../../lib/narrator-custom-traits";
import { withEnforcedKeys } from "../../lib/trait-resolution";
import { narratorService } from "../narrator-service";
import { resolveOptionalToolState } from "../narrator-session";
import { resetTraitLayerCaches } from "../trait-layer-service";

registerCoreTools();

// Browser is an optional tool, so resolveOptionalToolState reports on it.
const OPTIONAL_TOOL = "Browser";

const createdProjects: string[] = [];
const createdUsers: string[] = [];

const createdNarrators: string[] = [];

afterEach(async () => {
	resetTraitLayerCaches();
	// Narrators reference the project via contextProjectId, so they must go first
	// or the project delete trips the foreign key.
	if (createdNarrators.length > 0) {
		await db.delete(narrators).where(inArray(narrators.id, createdNarrators.splice(0)));
	}
	if (createdProjects.length > 0) {
		await db.delete(projects).where(inArray(projects.id, createdProjects.splice(0)));
	}
	if (createdUsers.length > 0) {
		const ids = createdUsers.splice(0);
		await db.delete(userPreferences).where(inArray(userPreferences.userId, ids));
		await db.delete(users).where(inArray(users.id, ids));
	}
});

function disabledTools(tools: string[]): string[] {
	return upsertEncodedTrait([], DISABLED_TOOLS_TRAIT_PREFIX, { version: 1, tools });
}

async function createProject(traits: string[]): Promise<string> {
	const now = new Date().toISOString();
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: `Trait layer project ${projectId.slice(0, 6)}`,
		traits,
		createdAt: now,
		updatedAt: now,
	});
	createdProjects.push(projectId);
	return projectId;
}

async function createNarratorInProject(
	projectId: string | null,
	narratorTraits: string[],
): Promise<string> {
	const narrator = await narratorService.create({
		locale: "en",
		...(projectId ? { contextProjectId: projectId } : {}),
	});
	createdNarrators.push(narrator.id);
	if (narratorTraits.length > 0) {
		await db.update(narrators).set({ traits: narratorTraits }).where(eq(narrators.id, narrator.id));
	}
	return narrator.id;
}

describe("project layer reaches the runtime", () => {
	test("a project restriction disables a tool for a narrator that declares nothing", async () => {
		const projectId = await createProject(disabledTools([OPTIONAL_TOOL]));
		const narratorId = await createNarratorInProject(projectId, []);

		const state = await resolveOptionalToolState(narratorId, OPTIONAL_TOOL);
		expect(state.state).toBe("disabled_by_trait");
	});

	test("without any upper layer the tool is not reported as trait-disabled", async () => {
		// Same narrator shape, no project traits: this is the pre-layering baseline.
		const projectId = await createProject([]);
		const narratorId = await createNarratorInProject(projectId, []);

		const state = await resolveOptionalToolState(narratorId, OPTIONAL_TOOL);
		expect(state.state).not.toBe("disabled_by_trait");
	});

	test("a standalone narrator (no project) is unaffected by layering", async () => {
		const narratorId = await createNarratorInProject(null, []);
		const state = await resolveOptionalToolState(narratorId, OPTIONAL_TOOL);
		expect(state.state).not.toBe("disabled_by_trait");
	});

	test("the narrator's own restriction still applies on its own", async () => {
		const projectId = await createProject([]);
		const narratorId = await createNarratorInProject(projectId, disabledTools([OPTIONAL_TOOL]));
		const state = await resolveOptionalToolState(narratorId, OPTIONAL_TOOL);
		expect(state.state).toBe("disabled_by_trait");
	});
});

describe("enforced vs default strength", () => {
	test("a narrator may relax a non-enforced project restriction", async () => {
		const projectId = await createProject(disabledTools([OPTIONAL_TOOL]));
		// The narrator declares an explicitly empty deny-list.
		const narratorId = await createNarratorInProject(projectId, disabledTools([]));

		const state = await resolveOptionalToolState(narratorId, OPTIONAL_TOOL);
		expect(state.state).not.toBe("disabled_by_trait");
	});

	test("a narrator may NOT relax an enforced project restriction", async () => {
		const projectId = await createProject(
			withEnforcedKeys(disabledTools([OPTIONAL_TOOL]), { disabledTools: true }),
		);
		const narratorId = await createNarratorInProject(projectId, disabledTools([]));

		const state = await resolveOptionalToolState(narratorId, OPTIONAL_TOOL);
		expect(state.state).toBe("disabled_by_trait");
	});
});

describe("layer cache invalidation", () => {
	test("a project trait change takes effect after invalidation", async () => {
		const projectId = await createProject([]);
		const narratorId = await createNarratorInProject(projectId, []);
		expect((await resolveOptionalToolState(narratorId, OPTIONAL_TOOL)).state).not.toBe(
			"disabled_by_trait",
		);

		await db
			.update(projects)
			.set({ traits: disabledTools([OPTIONAL_TOOL]) })
			.where(eq(projects.id, projectId));
		const { invalidateProjectTraitLayer } = await import("../trait-layer-service");
		invalidateProjectTraitLayer(projectId);

		expect((await resolveOptionalToolState(narratorId, OPTIONAL_TOOL)).state).toBe(
			"disabled_by_trait",
		);
	});
});
