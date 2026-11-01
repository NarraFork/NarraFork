import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { cleanDb } from "../../../tests/setup";
import { db, sqlite } from "../../db";
import { narratorMessages, narrators, users } from "../../db/schema";
import type { ChatParams, ProviderAdapter } from "../../lib/agent/provider";
import { toolRegistry } from "../../lib/agent/tool-registry";
import { registerCoreTools } from "../../lib/agent/tools/index";
import { toolSearchTool } from "../../lib/agent/tools/tool-search";
import type { AgentConfig, ToolContext } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import { DISABLED_TOOLS_TRAIT_PREFIX, upsertEncodedTrait } from "../../lib/narrator-custom-traits";
import { settings } from "../../lib/settings";
import { handleLoadToolCommand, narratorService } from "../narrator-service";
import { mcpToolMarker, parseMcpToolMarker } from "../tool-load-markers";
import { changeLoadedToolGroup, getToolSearchCandidates } from "../tool-loading-service";
import { resetTraitLayerCaches } from "../trait-layer-service";

registerCoreTools();
const savedServers = settings.mcpServers;
const savedRoutines = settings.routines;
const created: string[] = [];
const NAMES = ["mcp__search_fixture__calendar", "mcp__search_fixture__events"];
const marker = "mcp-server:search-fixture";
const selectedMarker = mcpToolMarker("search-fixture", NAMES[0]);
let calls = 0;
let parallelSearches = false;
let requests: ChatParams[] = [];
const provider: ProviderAdapter = {
	formatTools: (tools) => tools.map((tool) => ({ name: tool.name, parameters: tool.parameters })),
	buildHistory: async () => ({ history: [] }),
	injectSystemPrompt() {},
	async *chat(params) {
		requests.push(params);
		if (requests.length === 1)
			yield {
				toolUses: [
					{ toolUseId: "search", name: "ToolSearch", input: { query: NAMES[0], limit: 1 } },
					...(parallelSearches
						? [{ toolUseId: "search-2", name: "ToolSearch", input: { query: NAMES[0], limit: 1 } }]
						: []),
				],
			};
		else if (requests.length === 2)
			yield { toolUses: [{ toolUseId: "calendar", name: NAMES[0], input: {} }] };
		else yield { text: "done" };
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};
const originalProvider = { ...(await import("../../lib/agent/provider")) };
mock.module("../../lib/agent/provider", () => ({
	...originalProvider,
	getProvider: () => provider,
	resolveProviderAndModel: () => ({
		requestedProvider: "test",
		requestedModel: "test:toolsearch",
		provider: "test",
		adapter: provider,
		model: "test:toolsearch",
	}),
}));
const { agentLoop } = await import("../../lib/agent/loop");
async function fixture() {
	settings.routines = { disabledRoutines: [], enabledRoutines: [], toolModes: {} };
	settings.mcpServers = [
		{
			id: "search-fixture",
			name: "Calendar",
			mode: "auto",
			enabled: true,
			transport: "stdio",
			command: "unused",
		},
	];
	for (const name of NAMES)
		toolRegistry.register({
			name,
			description: "calendar meetings 日历",
			parameters: z.object({ timezone: z.string().optional() }),
			metadata: {
				mcpServerId: "search-fixture",
				mcpToolName: name.endsWith("events") ? "events" : "calendar",
			},
			execute: async () => {
				calls++;
				return { output: "calendar executed" };
			},
		});
	const row = await narratorService.create({ locale: "en" });
	created.push(row.id);
	return row.id;
}
function context(narratorId: string): ToolContext {
	return {
		narratorId,
		cwd: process.cwd(),
		locale: "en",
		signal: new AbortController().signal,
		requestPermission: async () => ({ behavior: "allow" }),
	};
}
async function notices(id: string) {
	return (
		await db.select().from(narratorMessages).where(eq(narratorMessages.narratorId, id))
	).filter((row) => JSON.stringify(row.contentJson).includes('"type":"tool_loaded"'));
}
async function openPrefixEpoch(
	id: string,
	strategy: "replace_tools" | "custom_injection",
	baseToolNames: string[] = [],
) {
	const { snapshotToolDefinitions } = await import("../narrator-epochs");
	const { putPrefixToolDefinitions, putPrefixText } = await import("../narrator-prefix-snapshots");
	const { narratorStore } = await import("../narrator-store");
	const definitions = baseToolNames.map((name) => {
		const tool = toolRegistry.get(name);
		if (!tool) throw new Error(`Missing fixture tool ${name}`);
		return tool;
	});
	return narratorStore.openEpoch(id, {
		reason: "initial",
		toolNames: baseToolNames,
		baseToolNames,
		strategy,
		prefix: {
			contract: await putPrefixText("Frozen tool load fixture"),
			parts: [],
			tools: await putPrefixToolDefinitions(snapshotToolDefinitions(definitions)),
		},
	});
}

afterEach(async () => {
	settings.mcpServers = savedServers;
	settings.routines = savedRoutines;
	resetTraitLayerCaches();
	for (const name of NAMES) toolRegistry.unregister(name);
	await (await import("../narrator-prefix-snapshots")).closePrefixSnapshotStore();
	cleanDb(sqlite);
	created.length = 0;
	calls = 0;
	parallelSearches = false;
	requests = [];
});
afterAll(() => {
	mock.module("../../lib/agent/provider", () => originalProvider);
	mock.restore();
});

test("real ToolSearch loads only one MCP tool and deduplicates concurrent repeat searches", async () => {
	const id = await fixture();
	const websocket = await import("../../websocket/narrator-ws");
	const broadcasts: unknown[] = [];
	const broadcast = spyOn(websocket, "broadcastToNarrator").mockImplementation((_id, event) => {
		broadcasts.push(event);
	});
	try {
		const results = await Promise.all([
			toolSearchTool.execute({ query: NAMES[0], limit: 1 }, context(id)),
			toolSearchTool.execute({ query: NAMES[0], limit: 1 }, context(id)),
		]);
		expect(results.map((r) => JSON.parse(r.output).results[0].status).sort()).toEqual([
			"already_loaded",
			"loaded",
		]);
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, id) });
		expect(row?.enabledTools).toEqual([selectedMarker]);
		const rows = await notices(id);
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows[0]?.contentJson)).not.toContain("definitionSnapshots");
		const snapshotRef = (rows[0]?.contentJson as { definitionSnapshotRef?: string }[])[0]
			?.definitionSnapshotRef;
		expect(typeof snapshotRef).toBe("string");
		if (!snapshotRef) throw new Error("Missing persisted tool definition snapshot");
		const { getPrefixToolDefinitions } = await import("../narrator-prefix-snapshots");
		const definitions = await getPrefixToolDefinitions(snapshotRef);
		expect(definitions).toHaveLength(1);
		expect(definitions[0]).toMatchObject({
			name: NAMES[0],
			description: "calendar meetings 日历",
			parameters: { type: "object", properties: { timezone: { type: "string" } } },
		});
		expect(JSON.stringify(rows[0]?.contentJson)).toContain(NAMES[0]);
		expect(JSON.stringify(rows[0]?.contentJson)).not.toContain(NAMES[1]);
		expect(
			broadcasts.filter((event) => (event as { type?: string }).type === "user_message"),
		).toHaveLength(1);
	} finally {
		broadcast.mockRestore();
	}
});

test("pre-baseline load events retain their snapshots after registry replacement", async () => {
	const id = await fixture();
	const group = (await getToolSearchCandidates(id)).find((candidate) => candidate.id === NAMES[0]);
	if (!group) throw new Error("Missing candidate");
	const snapshots = await import("../narrator-prefix-snapshots");
	expect(await changeLoadedToolGroup(id, group, true)).toBe("loaded");
	const firstRows = await notices(id);
	const firstBlock = (firstRows[0]?.contentJson as { definitionSnapshotRef?: string }[])[0];
	if (!firstBlock?.definitionSnapshotRef) throw new Error("Missing first snapshot");
	const original = await snapshots.getPrefixToolDefinitions(firstBlock.definitionSnapshotRef);
	const tool = toolRegistry.get(NAMES[0]);
	if (!tool) throw new Error("Missing registered tool");
	toolRegistry.register({
		...tool,
		description: "Updated calendar definition",
		rawJsonSchema: { type: "object", properties: { month: { type: "integer" } } },
	});
	expect(await changeLoadedToolGroup(id, group, false)).toBe("unloaded");
	expect(await changeLoadedToolGroup(id, group, true)).toBe("loaded");
	const rows = await notices(id);
	expect(rows).toHaveLength(2);
	const newRef = (rows[1]?.contentJson as { definitionSnapshotRef?: string }[])[0]
		?.definitionSnapshotRef;
	if (!newRef) throw new Error("Missing second snapshot");
	expect(newRef).not.toBe(firstBlock.definitionSnapshotRef);
	expect(await snapshots.getPrefixToolDefinitions(firstBlock.definitionSnapshotRef)).toEqual(
		original,
	);
	expect(await snapshots.getPrefixToolDefinitions(newRef)).toMatchObject([
		{ name: NAMES[0], description: "Updated calendar definition" },
	]);
	expect(rows[0]?.contentJson).toEqual(firstRows[0]?.contentJson);
});

test.each([
	"base",
	"addition",
] as const)("same-epoch reload keeps the first %s definition in persisted and recovered declarations", async (origin) => {
	const id = await fixture();
	const group = (await getToolSearchCandidates(id)).find((candidate) => candidate.id === NAMES[0]);
	if (!group) throw new Error("Missing candidate");
	const { snapshotToolDefinitions, toolLoadingEpochOf } = await import("../narrator-epochs");
	const { deriveToolLoadingState, projectToolLoadingHistory, selectRequestTools } = await import(
		"../../lib/agent/tool-loading"
	);
	const strategy = origin === "base" ? "replace_tools" : "custom_injection";
	if (origin === "addition") await openPrefixEpoch(id, strategy);
	expect(await changeLoadedToolGroup(id, group, true)).toBe("loaded");
	if (origin === "base") await openPrefixEpoch(id, strategy, [NAMES[0]]);
	const firstRows = await notices(id);
	const firstRef = (firstRows[0]?.contentJson as { definitionSnapshotRef?: string }[])[0]
		?.definitionSnapshotRef;
	if (!firstRef) throw new Error("Missing first snapshot");
	const beforeHistory = await narratorService.getModelHistorySinceLastCompact(id);
	const beforeEpoch = await toolLoadingEpochOf(id, beforeHistory);
	const beforeState = deriveToolLoadingState(
		beforeHistory,
		new Set(NAMES),
		[NAMES[0]],
		beforeEpoch,
		[],
	);
	const beforeDeclarations = snapshotToolDefinitions(
		selectRequestTools([], beforeState, strategy).tools,
	);
	const beforeProjection = projectToolLoadingHistory(
		beforeHistory,
		beforeState,
		strategy,
		() => null,
	);
	const tool = toolRegistry.get(NAMES[0]);
	if (!tool) throw new Error("Missing tool");
	toolRegistry.register({
		...tool,
		description: "Updated incompatible calendar definition",
		rawJsonSchema: {
			type: "object",
			properties: { month: { type: "integer" } },
			required: ["month"],
		},
	});
	expect(await changeLoadedToolGroup(id, group, false)).toBe("unloaded");
	expect(await changeLoadedToolGroup(id, group, true)).toBe("loaded");
	const loadRows = await notices(id);
	const reloadedRef = (loadRows[1]?.contentJson as { definitionSnapshotRef?: string }[])[0]
		?.definitionSnapshotRef;
	expect(reloadedRef).toBe(firstRef);

	// Recovery has no live definition to fall back to and must still use the original wire declaration.
	toolRegistry.unregister(NAMES[0]);
	const recoveredHistory = await narratorService.getModelHistorySinceLastCompact(id);
	const recoveredEpoch = await toolLoadingEpochOf(id, recoveredHistory);
	const recoveredState = deriveToolLoadingState(
		recoveredHistory,
		new Set(NAMES),
		[NAMES[0]],
		recoveredEpoch,
		[],
	);
	expect(snapshotToolDefinitions(selectRequestTools([], recoveredState, strategy).tools)).toEqual(
		beforeDeclarations,
	);
	expect(recoveredEpoch?.definitionSnapshots).toEqual(beforeEpoch?.definitionSnapshots);
	const recoveredProjection = projectToolLoadingHistory(
		recoveredHistory,
		recoveredState,
		strategy,
		() => null,
	);
	for (const row of beforeProjection) {
		expect(recoveredProjection.find((candidate) => candidate.id === row.id)).toEqual(row);
	}
	expect(JSON.stringify(recoveredProjection)).not.toContain(
		"Updated incompatible calendar definition",
	);
	if (origin === "addition") expect(JSON.stringify(recoveredProjection)).toContain("timezone");
});

test("snapshot persistence failure cannot publish a load or change enabled tools", async () => {
	const id = await fixture();
	const snapshots = await import("../narrator-prefix-snapshots");
	const put = spyOn(snapshots, "putPrefixToolDefinitions").mockRejectedValue(
		new Error("snapshot write failed"),
	);
	try {
		await expect(
			changeLoadedToolGroup(
				id,
				{
					id: marker,
					marker,
					description: "calendar",
					toolNames: NAMES,
				},
				true,
			),
		).rejects.toThrow("snapshot write failed");
		expect(await notices(id)).toHaveLength(0);
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.enabledTools ?? [],
		).toEqual([]);
	} finally {
		put.mockRestore();
	}
});

test("replace-tools prefix refuses new declarations without changing state or opening an epoch", async () => {
	const id = await fixture();
	const epoch = await openPrefixEpoch(id, "replace_tools");
	const result = await toolSearchTool.execute({ query: NAMES[0], limit: 1 }, context(id));
	const output = JSON.parse(result.output);
	expect(output.results[0].status).toBe("error");
	expect(output.results[0].error).toContain("cannot append new tool definitions");
	expect(output.results[0].error).toContain("Compact the conversation or switch models");
	expect(await notices(id)).toHaveLength(0);
	expect(
		(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.enabledTools ?? [],
	).toEqual([]);
	const messages = await narratorService.getModelHistorySinceLastCompact(id);
	expect(
		messages
			.filter((message) => (message.contentJson as { type?: string }[])[0]?.type === "epoch")
			.map((message) => message.id),
	).toEqual([epoch.id]);
});

test("replace-tools prefix permits unloading and reloading an already declared base tool", async () => {
	const id = await fixture();
	const group = (await getToolSearchCandidates(id)).find((candidate) => candidate.id === NAMES[0]);
	if (!group) throw new Error("Missing candidate");
	expect(await changeLoadedToolGroup(id, group, true)).toBe("loaded");
	await openPrefixEpoch(id, "replace_tools", [NAMES[0]]);
	expect(await changeLoadedToolGroup(id, group, false)).toBe("unloaded");
	expect(await changeLoadedToolGroup(id, group, true)).toBe("loaded");
});

test("a blocked new tool does not prevent another search hit from re-enabling its base declaration", async () => {
	const id = await fixture();
	await openPrefixEpoch(id, "replace_tools", [NAMES[0]]);
	const result = await toolSearchTool.execute({ query: "calendar", limit: 2 }, context(id));
	const results = JSON.parse(result.output).results as {
		group: string;
		status: string;
		error?: string;
	}[];
	expect(results.find((item) => item.group === NAMES[0])?.status).toBe("loaded");
	expect(results.find((item) => item.group === NAMES[1])).toMatchObject({
		status: "error",
		error: expect.stringContaining(NAMES[1]),
	});
	expect(
		(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.enabledTools,
	).toEqual([selectedMarker]);
	const rows = await notices(id);
	expect(rows).toHaveLength(1);
	expect((rows[0]?.contentJson as { toolNames: string[] }[])[0]?.toolNames).toEqual([NAMES[0]]);
});

test("explicit custom-injection epoch accepts additions without replacing the baseline", async () => {
	const id = await fixture();
	const epoch = await openPrefixEpoch(id, "custom_injection");
	const result = await toolSearchTool.execute({ query: NAMES[0], limit: 1 }, context(id));
	expect(JSON.parse(result.output).results[0].status).toBe("loaded");
	const messages = await narratorService.getModelHistorySinceLastCompact(id);
	const epochs = messages.filter(
		(message) => (message.contentJson as { type?: string }[])[0]?.type === "epoch",
	);
	expect(epochs.map((message) => message.id)).toEqual([epoch.id]);
	expect(epochs[0]?.contentJson).toEqual(epoch.contentJson);
	expect(await notices(id)).toHaveLength(1);
});

test("marker plus legacy concrete names is normalized even on an already-loaded hit", async () => {
	const id = await fixture();
	await db
		.update(narrators)
		.set({ enabledTools: [marker, ...NAMES] })
		.where(eq(narrators.id, id));
	const result = await toolSearchTool.execute({ query: NAMES[0], limit: 1 }, context(id));
	expect(JSON.parse(result.output).results[0].status).toBe("already_loaded");
	expect(
		(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.enabledTools,
	).toEqual([marker]);
	expect(await notices(id)).toHaveLength(0);
});

test("legacy resident concrete names do not become explicit selections after switching to auto", async () => {
	const id = await fixture();
	const server = settings.mcpServers?.[0];
	if (!server) throw new Error("Missing fixture server");
	settings.mcpServers = [{ ...server, mode: "resident" }];
	await db.update(narrators).set({ enabledTools: NAMES }).where(eq(narrators.id, id));
	expect((await getToolSearchCandidates(id)).some((group) => group.id === NAMES[0])).toBe(false);
	settings.mcpServers = [{ ...server, mode: "auto" }];
	const result = await toolSearchTool.execute({ query: NAMES[0], limit: 1 }, context(id));
	expect(JSON.parse(result.output).results[0].status).toBe("loaded");
	expect(
		(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.enabledTools,
	).toEqual([selectedMarker]);
	const rows = await notices(id);
	expect(rows).toHaveLength(1);
	expect((rows[0]?.contentJson as { toolNames?: string[] }[])[0]?.toolNames).toEqual([NAMES[0]]);
});

test("mode, live deny, trait and unavailable tools stay out of search", async () => {
	const id = await fixture();
	const server = settings.mcpServers?.[0];
	if (!server) throw new Error("Missing fixture server");
	settings.mcpServers = [{ ...server, mode: "resident" }];
	expect((await getToolSearchCandidates(id)).some((group) => group.id === NAMES[0])).toBe(false);
	settings.mcpServers = [
		{
			...settings.mcpServers[0],
			mode: "auto",
			toolPermissions: [{ toolName: "events", behavior: "deny", enabled: true }],
		},
	];
	expect(
		(await getToolSearchCandidates(id)).find((group) => group.id === NAMES[0])?.toolNames,
	).toEqual([NAMES[0]]);
	await db
		.update(narrators)
		.set({
			traits: upsertEncodedTrait([], DISABLED_TOOLS_TRAIT_PREFIX, {
				version: 1,
				tools: [NAMES[0]],
			}),
		})
		.where(eq(narrators.id, id));
	resetTraitLayerCaches();
	expect((await getToolSearchCandidates(id)).some((group) => group.id === NAMES[0])).toBe(false);
});

test("SQLite failure rolls back both notice and state", async () => {
	const id = await fixture();
	sqlite.run(
		"CREATE TRIGGER fail_tool_load BEFORE UPDATE OF enabled_tools ON narrators BEGIN SELECT RAISE(ABORT, 'atomic tool load failure'); END",
	);
	try {
		await expect(
			changeLoadedToolGroup(
				id,
				{ id: marker, marker, description: "calendar", toolNames: NAMES },
				true,
			),
		).rejects.toThrow("atomic tool load failure");
		expect(await notices(id)).toHaveLength(0);
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.enabledTools ?? [],
		).toEqual([]);
	} finally {
		sqlite.run("DROP TRIGGER fail_tool_load");
	}
});

test("builtin modes, availability and runtime ceilings are applied before ranking", async () => {
	const id = await fixture();
	settings.routines = {
		disabledRoutines: [],
		enabledRoutines: [],
		toolModes: { recall: "auto", terminal: "manual", browser: "resident", narrafork_admin: "auto" },
	};
	const candidates = await getToolSearchCandidates(id);
	expect(candidates.some((group) => group.toolNames.includes("Recall"))).toBe(true);
	expect(
		candidates.some(
			(group) =>
				group.toolNames.includes("Terminal") ||
				group.toolNames.includes("Browser") ||
				group.toolNames.includes("NarraForkAdmin"),
		),
	).toBe(false);
	const tool = toolRegistry.get(NAMES[0]);
	if (!tool) throw new Error("missing fixture tool");
	toolRegistry.register({ ...tool, isAvailable: () => false });
	expect(
		(await getToolSearchCandidates(id))
			.filter((group) => NAMES.includes(group.id))
			.map((group) => group.id),
	).toEqual([NAMES[1]]);
	const { resolveRuntimePolicy, compileDelegationPolicy } = await import("../agent-runtime/policy");
	const ctx = {
		...context(id),
		runtimePolicy: resolveRuntimePolicy([compileDelegationPolicy({ template: "explore" })]),
	};
	expect(
		(await getToolSearchCandidates(id, null, ctx)).some((group) => group.id === NAMES[0]),
	).toBe(false);
});

test("a stale search hit is reauthorized against one fresh commit catalog", async () => {
	const id = await fixture();
	const stale = (await getToolSearchCandidates(id)).find((group) => group.id === NAMES[0]);
	if (!stale) throw new Error("missing stale candidate");
	const server = settings.mcpServers?.[0];
	if (!server) throw new Error("missing fixture server");
	settings.mcpServers = [{ ...server, mode: "resident" }];
	const finalAuthorization = mock(() => {});
	const ctx = { ...context(id), assertFinalExecutionPermission: finalAuthorization };
	expect(await changeLoadedToolGroup(id, stale, true, null, ctx)).toBe("denied");
	expect(finalAuthorization).not.toHaveBeenCalled();
	expect(await notices(id)).toHaveLength(0);
});

test("final execution authorization precedes the atomic notice and state commit", async () => {
	const id = await fixture();
	const { narratorStore } = await import("../narrator-store");
	const original = narratorStore.appendToolChange;
	let authorized = false;
	const append = spyOn(narratorStore, "appendToolChange").mockImplementation(async (...args) => {
		expect(authorized).toBe(true);
		return original(...args);
	});
	try {
		const recheckAuthorization = mock(async () => {});
		const ctx = {
			...context(id),
			recheckAuthorization,
			assertFinalExecutionPermission: () => {
				authorized = true;
			},
		};
		const result = await toolSearchTool.execute({ query: NAMES[0], limit: 1 }, ctx);
		expect(JSON.parse(result.output).results[0].status).toBe("loaded");
		expect(recheckAuthorization).toHaveBeenCalledTimes(2);
		expect(append).toHaveBeenCalledTimes(1);
	} finally {
		append.mockRestore();
	}
});

test("ToolSearch propagates cancellation instead of converting it to a hit error", async () => {
	const id = await fixture();
	const controller = new AbortController();
	let checks = 0;
	const ctx = {
		...context(id),
		signal: controller.signal,
		recheckAuthorization: async () => {
			if (++checks === 2) controller.abort(new Error("cancelled tool search"));
		},
	};
	await expect(toolSearchTool.execute({ query: NAMES[0], limit: 1 }, ctx)).rejects.toThrow(
		"cancelled tool search",
	);
	expect(await notices(id)).toHaveLength(0);
});

test("explicit server load accepts 281 realistic tool schemas without snapshot budgets", async () => {
	const id = await fixture();
	const names = Array.from(
		{ length: 279 },
		(_, index) => `mcp__search_fixture__operation_${index}`,
	);
	const rawJsonSchema = {
		type: "object",
		properties: Object.fromEntries(
			["project", "path", "query", "language", "cursor", "sort", "scope", "filter"].map((name) => [
				name,
				{
					type: "string",
					description: `The ${name} to use when querying project resources and returning matching records.`,
				},
			]),
		),
	};
	try {
		for (const name of names) {
			toolRegistry.register({
				name,
				description: "Query project resources",
				parameters: z.object({}),
				rawJsonSchema,
				metadata: { mcpServerId: "search-fixture", mcpToolName: name },
				execute: async () => ({ output: "ok" }),
			});
		}
		expect(JSON.stringify(rawJsonSchema).length * names.length).toBeGreaterThan(192 * 1024);
		expect(
			await changeLoadedToolGroup(
				id,
				{ id: marker, marker, description: "calendar", toolNames: [...NAMES, ...names] },
				true,
			),
		).toBe("loaded");
		const rows = await notices(id);
		expect(rows).toHaveLength(1);
		expect((rows[0]?.contentJson as { toolNames?: string[] }[])[0]?.toolNames).toHaveLength(281);
		expect(JSON.stringify(rows[0]?.contentJson)).not.toContain("definitionSnapshots");
	} finally {
		for (const name of names) toolRegistry.unregister(name);
	}
});

test("large catalogs use metadata for discovery and materialize only selected definitions", async () => {
	const id = await fixture();
	const names = Array.from({ length: 4100 }, (_, index) => `mcp__search_fixture__catalog_${index}`);
	const schema = z.object({});
	let schemaReads = 0;
	try {
		for (const name of names) {
			toolRegistry.register({
				name,
				description: "Project resource query",
				parameters: schema,
				get rawJsonSchema(): Record<string, unknown> {
					schemaReads++;
					return { type: "object", properties: {} };
				},
				metadata: { mcpServerId: "search-fixture", mcpToolName: name },
				execute: async () => ({ output: "ok" }),
			});
		}
		await getToolSearchCandidates(id);
		expect(schemaReads).toBe(0);
		const target = names[names.length - 1];
		const result = await toolSearchTool.execute({ query: target, limit: 1 }, context(id));
		expect(JSON.parse(result.output).results).toEqual([{ group: target, status: "loaded" }]);
		expect(schemaReads).toBe(1);
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.enabledTools,
		).toEqual([mcpToolMarker("search-fixture", target)]);
		expect(
			await changeLoadedToolGroup(
				id,
				{ id: marker, marker, description: "calendar", toolNames: [...NAMES, ...names] },
				true,
			),
		).toBe("loaded");
	} finally {
		for (const name of names) toolRegistry.unregister(name);
	}
});

test("failed notice transaction leaves persisted load state unchanged", async () => {
	const id = await fixture();
	const { narratorStore } = await import("../narrator-store");
	const original = narratorStore.appendToolChange;
	narratorStore.appendToolChange = async () => {
		throw new Error("injected persistence failure");
	};
	try {
		await expect(
			changeLoadedToolGroup(
				id,
				{ id: marker, marker, description: "calendar", toolNames: NAMES },
				true,
			),
		).rejects.toThrow("injected");
		expect(
			(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.enabledTools ?? [],
		).toEqual([]);
	} finally {
		narratorStore.appendToolChange = original;
	}
});

test("manual /load displays the service-side admin denial instead of a success", async () => {
	const id = await fixture();
	const command = {
		resolved: true as const,
		loadTool: "NarraForkAdmin",
		rawCommand: "/load NarraForkAdmin",
	};
	const denied = await handleLoadToolCommand(id, command, "en");
	expect(denied.loaded).toBe(false);
	let rows = await db.select().from(narratorMessages).where(eq(narratorMessages.narratorId, id));
	expect(rows.some((row) => row.contentText?.includes("Only administrators"))).toBe(true);
	expect(rows.some((row) => row.contentText?.includes("Tool loaded:"))).toBe(false);
	const adminId = generateId();
	await db.insert(users).values({
		id: adminId,
		username: `tool-search-admin-${generateId(6)}`,
		passwordHash: "test",
		role: "admin",
		createdAt: new Date().toISOString(),
	});
	expect((await handleLoadToolCommand(id, command, "en", adminId)).loaded).toBe(true);
	rows = await db.select().from(narratorMessages).where(eq(narratorMessages.narratorId, id));
	expect(rows.some((row) => row.contentText?.includes("Tool loaded:"))).toBe(true);
});

test("manual /load displays a localized trait denial and never reports success", async () => {
	const id = await fixture();
	await db
		.update(narrators)
		.set({
			traits: upsertEncodedTrait([], DISABLED_TOOLS_TRAIT_PREFIX, {
				version: 1,
				tools: ["Recall"],
			}),
		})
		.where(eq(narrators.id, id));
	resetTraitLayerCaches();
	const result = await handleLoadToolCommand(
		id,
		{ resolved: true, loadTool: "Recall", rawCommand: "/load Recall" },
		"zh-CN",
	);
	expect(result.loaded).toBe(false);
	const rows = await db.select().from(narratorMessages).where(eq(narratorMessages.narratorId, id));
	expect(rows.some((row) => row.contentText?.includes("自定义 trait"))).toBe(true);
	expect(rows.some((row) => row.contentText?.includes("工具加载成功"))).toBe(false);
	expect(await notices(id)).toHaveLength(0);
});

test("manual /load reports a client-visible error when the prefix cannot append tools", async () => {
	const id = await fixture();
	await openPrefixEpoch(id, "replace_tools");
	// Await normally: Bun's promise matcher can starve an already-running worker's messages.
	let failure: unknown;
	try {
		await handleLoadToolCommand(
			id,
			{ resolved: true, loadTool: "Recall", rawCommand: "/load Recall" },
			"en",
		);
	} catch (error) {
		failure = error;
	}
	expect(failure).toMatchObject({
		statusCode: 400,
		message: expect.stringContaining("cannot append new tool definitions"),
	});
	expect(await notices(id)).toHaveLength(0);
	expect(
		(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.enabledTools ?? [],
	).toEqual([]);
});

test("manual /load writes a localized model notice and description", async () => {
	const id = await fixture();
	const result = await handleLoadToolCommand(
		id,
		{ resolved: true, loadTool: "Recall", rawCommand: "/load Recall" },
		"zh-CN",
	);
	expect(result.loaded).toBe(true);
	const rows = await notices(id);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.contentText).toContain("可选工具");
	expect(rows[0]?.contentText).not.toContain("The optional tool");
	const all = await db.select().from(narratorMessages).where(eq(narratorMessages.narratorId, id));
	expect(all.some((row) => row.contentText?.includes("工具加载成功"))).toBe(true);
});

test("ToolSearch schemas appear on the next request in the same agent turn, then MCP executes", async () => {
	const id = await fixture();
	parallelSearches = true;
	const current = new Set<string>();
	const candidates = toolRegistry.all();
	const config = {
		narratorId: id,
		conversationId: "toolsearch",
		model: "test:toolsearch",
		provider: "test",
		cwd: process.cwd(),
		signal: new AbortController().signal,
		onToolExecutionFinalAuthorization: async () => ({ assertStillCurrent() {} }),
		permissionHandler: async () => ({ behavior: "allow" as const }),
		toolFilter: (tool: { name: string }) => tool.name === "ToolSearch" || NAMES.includes(tool.name),
		isToolLoaded: (name: string) => current.has(name),
		toolLoading: { managed: new Set(NAMES), base: new Set<string>(), loaded: [], current },
		toolCandidates: candidates,
		onBeforeTurn: async () => {
			const row = await db.query.narrators.findFirst({ where: eq(narrators.id, id) });
			for (const name of row?.enabledTools ?? []) {
				current.add(name);
				if (name === marker) for (const member of NAMES) current.add(member);
				const selection = parseMcpToolMarker(name);
				if (selection) current.add(selection.canonicalName);
			}
			return {
				history: [],
				rows: [],
				toolCandidates: candidates,
				toolLoading: {
					managed: new Set(NAMES),
					base: new Set<string>(),
					loaded: NAMES.filter((name) => current.has(name)),
					current,
				},
			};
		},
	} as AgentConfig;
	const outputs: string[] = [];
	for await (const event of agentLoop(config, "find my calendar", { rows: [] }))
		if (event.type === "tool_result") outputs.push(event.output);
	expect(
		outputs
			.slice(0, 2)
			.map((output) => JSON.parse(output).results[0].status)
			.sort(),
	).toEqual(["already_loaded", "loaded"]);
	expect((requests[0]?.tools as { name: string }[]).map((tool) => tool.name)).not.toContain(
		NAMES[0],
	);
	expect(requests[1]?.toolLoadingStrategy).toBe("replace_tools");
	expect((requests[1]?.tools as { name: string }[]).map((tool) => tool.name)).toContain(NAMES[0]);
	expect((requests[1]?.tools as { name: string }[]).map((tool) => tool.name)).not.toContain(
		NAMES[1],
	);
	expect(calls).toBe(1);
	expect(outputs.some((output) => output.includes("calendar executed"))).toBe(true);
	expect(await notices(id)).toHaveLength(1);
	expect(
		(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.enabledTools,
	).toEqual([selectedMarker]);
});
