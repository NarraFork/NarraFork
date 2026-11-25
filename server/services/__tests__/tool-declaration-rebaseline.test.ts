/**
 * A core tool that becomes available mid-session (a session turned into a team coordinator gains
 * `Team`): on a `replace_tools` epoch `requestToolDeclarationRebaseline` writes the rebaseline
 * notice an explicit load writes, once, and the next request opens a new epoch that declares the
 * tool. On an epoch that can append, nothing is written: the runtime's ordinary reconciliation
 * adds the tool as a `tool_loaded` notice.
 */
import { afterAll, beforeEach, expect, test } from "bun:test";
import { z } from "zod/v4";
import { db } from "../../db";
import { narrators } from "../../db/schema";
import { rebaselineRequests } from "../../lib/agent/tool-loading";
import { toolRegistry } from "../../lib/agent/tool-registry";
import { registerCoreTools } from "../../lib/agent/tools";
import { TEAM_TOOL_NAME } from "../../lib/agent/tools/team";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";

const { narratorService } = await import("../narrator-service");
const { reconcileEpoch } = await import("../narrator-epochs");
const { requestToolDeclarationRebaseline } = await import("../tool-loading-service");

if (!toolRegistry.get(TEAM_TOOL_NAME)) registerCoreTools();

const originalProviders = settings.anthropicProviders;
const provider = "team-rebaseline-tests";
beforeEach(() => {
	settings.anthropicProviders = [
		...(originalProviders ?? []),
		{
			id: provider,
			name: "Team rebaseline",
			prefix: provider,
			apiKey: "isolated-no-network",
			baseUrl: "https://example.invalid/v1",
			defaultModel: "claude-sonnet-5-5",
			officialApi: false,
		},
	];
});
afterAll(() => {
	settings.anthropicProviders = originalProviders;
});

const baseTool = {
	name: "RebaselineRead",
	description: "Read",
	parameters: z.object({}),
	rawJsonSchema: { type: "object", properties: {} },
	execute: async () => ({ output: "ok" }),
};

async function fixture(model: string) {
	const narratorId = generateId();
	const now = new Date().toISOString();
	await db
		.insert(narrators)
		.values({ id: narratorId, cwd: "/tmp", createdAt: now, updatedAt: now });
	const team = toolRegistry.get(TEAM_TOOL_NAME);
	if (!team) throw new Error("Team tool is not registered");
	const input = {
		narratorId,
		messages: [],
		managed: new Set<string>(),
		current: [] as string[],
		candidates: [baseTool],
		model,
		provider,
		registryRevision: "initial-registry",
		prompt: { contract: "Fixed contract", parts: [{ key: "workspace", text: "/repo" }] },
		noticeText: (kind: "tool_loaded" | "tool_unloaded", name: string) => `${kind}: ${name}`,
		resolveTarget: (target: string, from: string) => ({
			fingerprint: `${from}:${target}`,
			cacheTtlMs: 1,
		}),
	};
	return { narratorId, input, team };
}

const history = (id: string) => narratorService.getModelHistorySinceLastCompact(id);

test("a replace_tools epoch gets one rebaseline notice, and the next request declares the tool", async () => {
	const { narratorId, input, team } = await fixture("claude-sonnet-4");
	const first = await reconcileEpoch(input);
	expect(first.epoch?.strategy).toBe("replace_tools");
	expect(first.epoch?.baseToolNames).not.toContain(TEAM_TOOL_NAME);

	expect(await requestToolDeclarationRebaseline(narratorId, TEAM_TOOL_NAME)).toBe(true);
	expect(rebaselineRequests(await history(narratorId), first.epoch?.markerId)).toEqual(
		new Set([TEAM_TOOL_NAME]),
	);
	// Already pending: not written twice.
	expect(await requestToolDeclarationRebaseline(narratorId, TEAM_TOOL_NAME)).toBe(false);

	// The coordinator's next request offers Team among its candidates.
	const next = await reconcileEpoch({ ...input, candidates: [baseTool, team] });
	expect(next.opened).toBe(true);
	expect(next.epoch?.reason).toBe("tools");
	expect(next.epoch?.baseToolNames).toContain(TEAM_TOOL_NAME);
	// Declared now: no further notice.
	expect(await requestToolDeclarationRebaseline(narratorId, TEAM_TOOL_NAME)).toBe(false);
});

test("an epoch that can append, or no epoch at all, gets no notice", async () => {
	const { narratorId, input } = await fixture("claude-sonnet-5-5");
	expect(await requestToolDeclarationRebaseline(narratorId, TEAM_TOOL_NAME)).toBe(false);
	const first = await reconcileEpoch(input);
	expect(first.epoch?.strategy).not.toBe("replace_tools");
	expect(await requestToolDeclarationRebaseline(narratorId, TEAM_TOOL_NAME)).toBe(false);
	expect(rebaselineRequests(await history(narratorId), first.epoch?.markerId).size).toBe(0);
});
