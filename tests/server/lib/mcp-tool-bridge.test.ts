import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import type { ToolContext, ToolDefinition } from "../../../server/lib/agent/types";
import type { McpDirectoryEntry } from "../../../server/lib/mcp/manager";

const actualRegistry = { ...(await import("../../../server/lib/agent/tool-registry")) };
const registry = new actualRegistry.ToolRegistry();
const connected = new Set<string>();
const calls: Array<{ serverId: string; name: string; args: Record<string, unknown> }> = [];
const actualManager = { ...(await import("../../../server/lib/mcp/manager")) };
mock.module("../../../server/lib/agent/tool-registry", () => ({
	...actualRegistry,
	toolRegistry: registry,
}));
mock.module("../../../server/lib/mcp/manager", () => ({
	...actualManager,
	mcpManager: {
		isServerConnected: (id: string) => connected.has(id),
		callTool: async (serverId: string, name: string, args: Record<string, unknown>) => {
			calls.push({ serverId, name, args });
			return { content: [{ type: "text", text: `${serverId}/${name}` }] };
		},
	},
}));
const { prepareMcpTools } = await import("../../../server/lib/mcp/tool-bridge");

function entry(name: string, serverId = "server-1", serverName = "Fixture"): McpDirectoryEntry {
	return {
		serverId,
		serverName,
		tool: {
			name,
			description: `${name} description`,
			inputSchema: { type: "object", properties: { value: { type: "string" } } },
		},
	};
}
function unrelated(name: string): ToolDefinition {
	return {
		name,
		description: "not MCP",
		parameters: z.object({}),
		execute: async () => ({ output: "ok" }),
	};
}
async function publish(entries: McpDirectoryEntry[]) {
	const commit = await prepareMcpTools(entries);
	expect(commit()).toBe(true);
}
beforeEach(() => {
	for (const tool of registry.all()) registry.unregister(tool.name);
	connected.clear();
	connected.add("server-1");
	calls.length = 0;
});
afterAll(() => {
	mock.module("../../../server/lib/agent/tool-registry", () => actualRegistry);
	mock.module("../../../server/lib/mcp/manager", () => actualManager);
	mock.restore();
});

describe("MCP directory preparation and atomic delta commit", () => {
	test("preparation does not mutate the registry and identical data preserves all declaration identities", async () => {
		const directory = [entry("read"), entry("write")];
		const commit = await prepareMcpTools(directory);
		expect(registry.all()).toHaveLength(0);
		expect(commit()).toBe(true);
		const original = registry.get("mcp__fixture__read");
		const revision = registry.revision;
		await publish(structuredClone(directory));
		expect(registry.revision).toBe(revision);
		expect(registry.get("mcp__fixture__read")).toBe(original);
		expect(registry.get("mcp__fixture__read")?.rawJsonSchema).toBe(original?.rawJsonSchema);
		expect(registry.get("mcp__fixture__read")?.parameters).toBe(original?.parameters);
	});

	test("only actual changes replace declarations, removed tools do not disturb other producers", async () => {
		const read = entry("read");
		const write = entry("write");
		await publish([read, write, entry("remove")]);
		const same = registry.get("mcp__fixture__read");
		const changed = registry.get("mcp__fixture__write");
		const other = unrelated("fixture-other");
		registry.register(other);
		write.tool.description = "updated description";
		await publish([read, write, entry("added")]);
		expect(registry.get("mcp__fixture__read")).toBe(same);
		expect(registry.get("mcp__fixture__write")).not.toBe(changed);
		expect(registry.get("mcp__fixture__write")?.description).toContain("updated description");
		expect(registry.get("mcp__fixture__remove")).toBeUndefined();
		expect(registry.get("mcp__fixture__added")).toBeDefined();
		expect(registry.get("fixture-other")).toBe(other);
	});

	test("input schema changes are detected even when the directory object is reused", async () => {
		const tool = entry("read");
		await publish([tool]);
		const before = registry.get("mcp__fixture__read");
		tool.tool.inputSchema.properties = { value: { type: "number" } };
		await publish([tool]);
		expect(registry.get("mcp__fixture__read")).not.toBe(before);
		expect(registry.get("mcp__fixture__read")?.rawJsonSchema?.properties).toEqual({
			value: { type: "number" },
		});
		expect(before?.rawJsonSchema?.properties).toEqual({ value: { type: "string" } });
	});

	test("one object validator is shared across tools and leaves schema validation to the server", async () => {
		const read = entry("read");
		read.tool.inputSchema.required = ["value"];
		await publish([read, entry("write")]);
		const [first, second] = registry.all();
		expect(first.parameters).toBe(second.parameters);
		// Missing required fields and mismatched field types belong to the MCP server.
		expect(first.parameters.parse({})).toEqual({});
		expect(first.parameters.parse({ value: 42, dynamic: { nested: true } })).toEqual({
			value: 42,
			dynamic: { nested: true },
		});
		for (const invalid of [null, [], "text", 42]) {
			expect(first.parameters.safeParse(invalid).success).toBe(false);
		}
	});

	test("raw schemas retain annotations, references and dynamic constraints without global projection", async () => {
		const tool = entry("read");
		tool.tool.inputSchema = {
			type: "object",
			$defs: { value: { type: "string" } },
			properties: {
				value: { $ref: "#/$defs/value", "x-ui": "input" },
				zero: { const: 0 },
				map: { type: "object", additionalProperties: { type: "integer" } },
			},
			patternProperties: { "^tag_": { type: "string" } },
			additionalProperties: true,
			"x-catalog": "fixture",
		};
		const original = structuredClone(tool.tool.inputSchema);
		await publish([tool]);
		const [definition] = registry.all();
		expect(definition.rawJsonSchema).toEqual(original);
		expect(tool.tool.inputSchema).toEqual(original);
		// A declaration owns its snapshot even if a producer later mutates a nested schema.
		(tool.tool.inputSchema.properties?.value as Record<string, unknown>)["x-ui"] = "changed";
		expect(definition.rawJsonSchema).toEqual(original);
	});

	test.each([
		true,
		false,
		{ type: "number" },
	])("execution never filters dynamic arguments, even when additionalProperties is %j", async (additionalProperties) => {
		const tool = entry("read");
		tool.tool.inputSchema.additionalProperties = additionalProperties;
		await publish([tool]);
		const [definition] = registry.all();
		const args = { value: "input", dynamic: 42, nested: { extra: [1, 2] } };
		const parsed = definition.parameters.parse(args) as Record<string, unknown>;
		await definition.execute(parsed, {
			signal: new AbortController().signal,
		} as ToolContext);
		expect(calls).toEqual([{ serverId: "server-1", name: "read", args }]);
		expect(calls[0].args).toBe(parsed);
	});

	test("unused output schemas and server-side execution metadata do not rebuild model declarations", async () => {
		const tool = entry("read");
		await publish([tool]);
		const before = registry.get("mcp__fixture__read");
		const revision = registry.revision;
		tool.tool.outputSchema = { type: "object", $ref: "#/$defs/irrelevant" };
		tool.tool.execution = { taskSupport: "required" };
		await publish([tool]);
		expect(registry.revision).toBe(revision);
		expect(registry.get("mcp__fixture__read")).toBe(before);
	});

	test.each([
		[entry("a.b"), entry("a_b")],
		[entry("read", "one", "Same"), entry("read", "two", "Same")],
	])("normalized name collisions reject the whole preparation", async (left, right) => {
		await publish([entry("original")]);
		const before = registry.all();
		const revision = registry.revision;
		await expect(prepareMcpTools([left, right])).rejects.toThrow("name collision");
		expect(registry.revision).toBe(revision);
		expect(registry.all()).toEqual(before);
	});

	test("a non-MCP tool cannot be silently overwritten", async () => {
		const reserved = unrelated("mcp__fixture__read");
		registry.register(reserved);
		await expect(prepareMcpTools([entry("read")])).rejects.toThrow("non-MCP tool");
		expect(registry.get(reserved.name)).toBe(reserved);
	});

	test("a registry change during preparation makes commit a no-op until recomputed", async () => {
		await publish([entry("old")]);
		const previous = registry.get("mcp__fixture__old");
		const commit = await prepareMcpTools([entry("new")]);
		const other = unrelated("fixture-other");
		registry.register(other);
		const revision = registry.revision;
		expect(commit()).toBe(false);
		expect(registry.revision).toBe(revision);
		expect(registry.get("mcp__fixture__old")).toBe(previous);
		expect(registry.get("mcp__fixture__new")).toBeUndefined();
		await publish([entry("new")]);
		expect(registry.get("mcp__fixture__old")).toBeUndefined();
		expect(registry.get("mcp__fixture__new")).toBeDefined();
		expect(registry.get("fixture-other")).toBe(other);
	});

	test("rename changes the prefix but execution still targets the original server/tool identity", async () => {
		await publish([entry("read")]);
		await publish([entry("read", "server-1", "Renamed")]);
		expect(registry.get("mcp__fixture__read")).toBeUndefined();
		const definition = registry.get("mcp__renamed__read");
		expect(definition?.metadata).toMatchObject({
			mcpServerId: "server-1",
			mcpToolName: "read",
			mcpServerName: "Renamed",
		});
		expect(definition?.isAvailable?.()).toBe(true);
		const output = await definition?.execute({ value: "input" }, {
			signal: new AbortController().signal,
		} as ToolContext);
		expect(output?.output).toBe("server-1/read");
		expect(calls).toEqual([{ serverId: "server-1", name: "read", args: { value: "input" } }]);
		connected.clear();
		expect(definition?.isAvailable?.()).toBe(false);
	});

	test("large directory preparation yields without publishing partial tools", async () => {
		let clock = 0;
		const now = spyOn(performance, "now").mockImplementation(() => (clock += 9));
		const sleep = spyOn(Bun, "sleep");
		let heartbeats = 0;
		let partialPublication = false;
		const heartbeat = setImmediate(() => {
			heartbeats++;
			partialPublication ||= registry.all().length > 0;
		});
		try {
			const pending = prepareMcpTools(
				Array.from({ length: 100 }, (_, index) => entry(`tool-${index}`)),
			);
			expect(registry.all()).toHaveLength(0);
			const commit = await pending;
			expect(sleep).toHaveBeenCalledWith(0);
			expect(heartbeats).toBeGreaterThan(0);
			expect(partialPublication).toBe(false);
			expect(registry.all()).toHaveLength(0);
			expect(commit()).toBe(true);
			expect(registry.all()).toHaveLength(100);
		} finally {
			clearImmediate(heartbeat);
			sleep.mockRestore();
			now.mockRestore();
		}
	});
});
