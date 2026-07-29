/**
 * resolveOptionalToolState tests.
 *
 * The Browser dock panel offers a one-click "load browser tool" button when the
 * session has no Browser tool, so the state resolution must agree with what the
 * agent loop's toolFilter would decide:
 *  - unknown names are reported as such
 *  - a custom trait deny-list wins over a persisted load
 *  - persisted enabledTools count as loaded for a dormant (non-active) session
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { registerCoreTools } from "../../lib/agent/tools/index";
import {
	DISABLED_TOOLS_TRAIT_PREFIX,
	normalizeDisabledTools,
	upsertEncodedTrait,
} from "../../lib/narrator-custom-traits";
import { narratorService } from "../narrator-service";
import { resolveOptionalToolState } from "../narrator-session";

async function createStandaloneNarrator() {
	return narratorService.create({ locale: "en" });
}

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
