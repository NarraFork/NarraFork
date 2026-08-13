/**
 * Setup Assistant narrator persistence.
 *
 * Covers what needs the DB and the narrator service:
 *  - create() preinstalls Terminal (a PTY, which package managers and sudo want)
 *  - the kind must be standalone (a chapterId is rejected)
 *  - the authorization choice actually lands on the narrator row
 *
 * The pure prompt/briefing/authorization-mapping assertions live in
 * server/lib/prompts/__tests__/setup-assistant-prompt.test.ts, which imports only
 * the prompt leaf module and so runs without this suite's service graph.
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME.
 */
import { describe, expect, test } from "bun:test";
import { OPTIONAL_TOOLS } from "../../lib/agent/tools/index";
import { SETUP_KIND_PRELOAD_TOOLS, SETUP_KIND_TRAIT } from "../../lib/agent/tools/setup-kind";
import { resolveDangerReflectionLevel } from "../../lib/boolean-override";
import { resolveSetupAuthorization } from "../../lib/prompt-i18n";
import { narratorService } from "../narrator-service";

const TAG = Date.now();

describe("setup kind preload tools", () => {
	test("every preloaded tool is a real optional tool", () => {
		// A name outside OPTIONAL_TOOLS would be written into enabledTools and then
		// silently dropped at session start, leaving the narrator with no PTY.
		for (const tool of SETUP_KIND_PRELOAD_TOOLS) {
			expect(OPTIONAL_TOOLS.has(tool)).toBe(true);
		}
	});
});

describe("create() preinstall", () => {
	test("preinstalls Terminal, marks the trait, and applies the default prompt", async () => {
		const narrator = await narratorService.create({ kind: "setup", locale: "en" });
		const tools = (narrator.enabledTools as string[] | null) ?? [];
		for (const tool of SETUP_KIND_PRELOAD_TOOLS) expect(tools).toContain(tool);
		const traits = (narrator.traits as string[] | null) ?? [];
		expect(traits).toContain(SETUP_KIND_TRAIT);
		expect(traits).toContain("standalone");
		expect(narrator.systemPrompt).toContain("Setup Assistant");
	});

	test("a supplied systemPrompt (the briefed one) overrides the default", async () => {
		const narrator = await narratorService.create({
			kind: "setup",
			systemPrompt: "custom setup instructions",
		});
		expect(narrator.systemPrompt).toBe("custom setup instructions");
	});

	test("setup kind with a chapterId is rejected (must be standalone)", async () => {
		expect(
			narratorService.create({ kind: "setup", chapterId: `some-chapter-${TAG}` }),
		).rejects.toThrow();
	});
});

describe("authorization is carried into the narrator row", () => {
	test("full authority persists bypassPermissions + strict reflection", async () => {
		const { permissionMode, dangerReflectionOverride } = resolveSetupAuthorization("full");
		const narrator = await narratorService.create({
			kind: "setup",
			locale: "en",
			permissionMode,
			dangerReflectionOverride,
		});
		expect(narrator.permissionMode).toBe("bypassPermissions");
		expect(narrator.dangerReflectionOverride).toBe("strict");
		// Pinned, not inherited: an instance default of "off" must not disable the
		// review turn for a narrator that raises no approval cards.
		expect(resolveDangerReflectionLevel(narrator.dangerReflectionOverride, "off")).toBe("strict");
	});

	test("standard authority persists the default mode and inherits reflection", async () => {
		const { permissionMode, dangerReflectionOverride } = resolveSetupAuthorization("default");
		const narrator = await narratorService.create({
			kind: "setup",
			locale: "en",
			permissionMode,
			dangerReflectionOverride,
		});
		expect(narrator.permissionMode).toBe("default");
		expect(narrator.dangerReflectionOverride).toBe("inherit");
		expect(resolveDangerReflectionLevel(narrator.dangerReflectionOverride, "standard")).toBe(
			"standard",
		);
	});
});
