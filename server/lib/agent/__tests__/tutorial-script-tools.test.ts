/**
 * Every tool a tutorial script calls must actually exist.
 *
 * The tutorial executes its tool calls for real, so a script naming a tool that
 * has since been renamed or removed renders a broken card and the turn stalls
 * waiting for a result that never comes. Authoring-time there is no signal at all.
 *
 * This lives under `server/` rather than next to the lesson data because the
 * registry is host state: importing it from `shared/` would drag the whole server
 * module graph into files that bundled plugin code also consumes (see
 */

import { describe, expect, test } from "bun:test";
import { getTutorialScripts } from "@shared/tutorial/lessons";
import { canonicalizeToolName } from "../tool-name";
import { toolRegistry } from "../tool-registry";
import { registerCoreTools } from "../tools";

registerCoreTools();

const scripts = getTutorialScripts();

function scriptedToolReferences(): Array<{ lessonId: string; turnIndex: number; name: string }> {
	const refs: Array<{ lessonId: string; turnIndex: number; name: string }> = [];
	for (const [lessonId, script] of Object.entries(scripts)) {
		const turns = [...script.turns, script.fallbackTurn];
		for (const [turnIndex, turn] of turns.entries()) {
			for (const toolUse of turn.toolUses ?? []) {
				refs.push({ lessonId, turnIndex, name: toolUse.name });
			}
		}
	}
	return refs;
}

describe("tutorial scripts reference real tools", () => {
	test("the registry is populated (otherwise this suite passes vacuously)", () => {
		// Without this, a registration regression would make every assertion below
		// trivially true instead of failing.
		expect(toolRegistry.all().length).toBeGreaterThan(10);
		expect(toolRegistry.get("Read")).toBeDefined();
	});

	test("every scripted tool name resolves in the registry", () => {
		for (const { lessonId, turnIndex, name } of scriptedToolReferences()) {
			expect(
				toolRegistry.get(name),
				`${lessonId} turn ${turnIndex}: unknown tool "${name}"`,
			).toBeDefined();
		}
	});

	test("scripted tool names are already canonical", () => {
		// The loop canonicalizes names before anything keys off them (persistence,
		// field config, card rendering). A script using a legacy alias would still
		// work but would persist under a name the lesson copy does not mention.
		for (const { lessonId, turnIndex, name } of scriptedToolReferences()) {
			expect(canonicalizeToolName(name), `${lessonId} turn ${turnIndex}`).toBe(name);
		}
	});
});
