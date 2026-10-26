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
import { changeLoadedToolGroup, getToolSearchCandidates } from "../tool-loading-service";
import { resetTraitLayerCaches } from "../trait-layer-service";

registerCoreTools();
const savedServers = settings.mcpServers;
const savedRoutines = settings.routines;
const created: string[] = [];
const NAMES = ["mcp__search_fixture__calendar", "mcp__search_fixture__events"];
const marker = "mcp-server:search-fixture";
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
					{ toolUseId: "search", name: "ToolSearch", input: { query: "calendar" } },
					...(parallelSearches
						? [{ toolUseId: "search-2", name: "ToolSearch", input: { query: "calendar" } }]
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
afterEach(async () => {
	settings.mcpServers = savedServers;
	settings.routines = savedRoutines;
	resetTraitLayerCaches();
	for (const name of NAMES) toolRegistry.unregister(name);
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

test("real ToolSearch loads an MCP group and deduplicates concurrent repeat searches", async () => {
	const id = await fixture();
	const websocket = await import("../../websocket/narrator-ws");
	const broadcasts: unknown[] = [];
	const broadcast = spyOn(websocket, "broadcastToNarrator").mockImplementation((_id, event) => {
		broadcasts.push(event);
	});
	try {
		const results = await Promise.all([
			toolSearchTool.execute({ query: "calendar" }, context(id)),
			toolSearchTool.execute({ query: "calendar" }, context(id)),
		]);
		expect(results.map((r) => JSON.parse(r.output).results[0].status).sort()).toEqual([
			"already_loaded",
			"loaded",
		]);
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, id) });
		expect(row?.enabledTools).toEqual([marker]);
		const rows = await notices(id);
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows[0]?.contentJson)).toContain("definitionSnapshots");
		expect(JSON.stringify(rows[0]?.contentJson)).toContain(NAMES[0]);
		expect(
			broadcasts.filter((event) => (event as { type?: string }).type === "user_message"),
		).toHaveLength(1);
	} finally {
		broadcast.mockRestore();
	}
});

test("marker plus legacy concrete names is normalized even on an already-loaded hit", async () => {
	const id = await fixture();
	await db
		.update(narrators)
		.set({ enabledTools: [marker, ...NAMES] })
		.where(eq(narrators.id, id));
	const result = await toolSearchTool.execute({ query: "calendar" }, context(id));
	expect(JSON.parse(result.output).results[0].status).toBe("already_loaded");
	expect(
		(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.enabledTools,
	).toEqual([marker]);
	expect(await notices(id)).toHaveLength(0);
});

test("legacy concrete names without a durable marker do not authorize a group", async () => {
	const id = await fixture();
	await db.update(narrators).set({ enabledTools: NAMES }).where(eq(narrators.id, id));
	const result = await toolSearchTool.execute({ query: "calendar" }, context(id));
	expect(JSON.parse(result.output).results[0].status).toBe("loaded");
	expect(
		(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.enabledTools,
	).toEqual([marker]);
	const rows = await notices(id);
	expect(rows).toHaveLength(1);
	expect((rows[0]?.contentJson as { toolNames?: string[] }[])[0]?.toolNames).toEqual(NAMES);
});

test("mode, live deny, trait and unavailable tools stay out of search", async () => {
	const id = await fixture();
	const server = settings.mcpServers?.[0];
	if (!server) throw new Error("Missing fixture server");
	settings.mcpServers = [{ ...server, mode: "resident" }];
	expect((await getToolSearchCandidates(id)).some((group) => group.id === marker)).toBe(false);
	settings.mcpServers = [
		{
			...settings.mcpServers[0],
			mode: "auto",
			toolPermissions: [{ toolName: "events", behavior: "deny", enabled: true }],
		},
	];
	expect(
		(await getToolSearchCandidates(id)).find((group) => group.id === marker)?.toolNames,
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
	expect((await getToolSearchCandidates(id)).some((group) => group.id === marker)).toBe(false);
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
		(await getToolSearchCandidates(id)).find((group) => group.id === marker)?.toolNames,
	).toEqual([NAMES[1]]);
	const { resolveRuntimePolicy, compileDelegationPolicy } = await import("../agent-runtime/policy");
	const ctx = {
		...context(id),
		runtimePolicy: resolveRuntimePolicy([compileDelegationPolicy({ template: "explore" })]),
	};
	expect((await getToolSearchCandidates(id, null, ctx)).some((group) => group.id === marker)).toBe(
		false,
	);
});

test("a stale search hit is reauthorized against one fresh commit catalog", async () => {
	const id = await fixture();
	const stale = (await getToolSearchCandidates(id)).find((group) => group.id === marker);
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
		const result = await toolSearchTool.execute({ query: "calendar" }, ctx);
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
	await expect(toolSearchTool.execute({ query: "calendar" }, ctx)).rejects.toThrow(
		"cancelled tool search",
	);
	expect(await notices(id)).toHaveLength(0);
});

test("bounded snapshots reject oversized schemas before cloning and protect the final epoch budget", async () => {
	const id = await fixture();
	const { snapshotToolDefinitions } = await import("../../lib/agent/tool-loading");
	const server = settings.mcpServers?.[0];
	if (!server) throw new Error("missing fixture server");
	const secondMarker = "mcp-server:search-fixture-second";
	settings.mcpServers = [server, { ...server, id: "search-fixture-second", name: "Calendar 2" }];
	for (const [index, name] of NAMES.entries()) {
		const tool = toolRegistry.get(name);
		if (!tool) throw new Error("missing fixture tool");
		toolRegistry.register({
			...tool,
			metadata: {
				...tool.metadata,
				mcpServerId: index === 0 ? server.id : "search-fixture-second",
			},
			rawJsonSchema: { type: "object", description: "x".repeat(100_000) },
		});
	}
	expect(snapshotToolDefinitions([NAMES[0]])).toHaveLength(1);
	expect(() => snapshotToolDefinitions(NAMES)).toThrow("serialization budget");
	await changeLoadedToolGroup(
		id,
		{ id: marker, marker, description: "calendar", toolNames: [NAMES[0]] },
		true,
	);
	await expect(
		changeLoadedToolGroup(
			id,
			{
				id: secondMarker,
				marker: secondMarker,
				description: "calendar",
				toolNames: [NAMES[1]],
			},
			true,
		),
	).rejects.toThrow("serialization budget");
	expect(await notices(id)).toHaveLength(1);
	expect(
		(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.enabledTools,
	).toEqual([marker]);
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
	expect((requests[1]?.tools as { name: string }[]).map((tool) => tool.name)).toEqual(
		expect.arrayContaining(NAMES),
	);
	expect(calls).toBe(1);
	expect(outputs.some((output) => output.includes("calendar executed"))).toBe(true);
	expect(await notices(id)).toHaveLength(1);
	expect(
		(await db.query.narrators.findFirst({ where: eq(narrators.id, id) }))?.enabledTools,
	).toEqual([marker]);
});
