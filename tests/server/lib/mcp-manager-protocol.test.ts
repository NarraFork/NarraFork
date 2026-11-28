import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	CallToolRequestSchema,
	type CallToolResult,
	type JSONRPCMessage,
	ListToolsRequestSchema,
	type ListToolsResult,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type { ToolContext } from "../../../server/lib/agent/types";
import type { McpServerConfig } from "../../../server/lib/settings";
import type { ToolProgressPayload } from "../../../shared/tool-progress";

// Only configuration and transport selection are replaced. Protocol parsing, cancellation,
// SDK Client/Server and the output-validator implementation are real.
const actualSettings = { ...(await import("../../../server/lib/settings")) };
const actualTransports = { ...(await import("../../../server/lib/mcp/transports")) };
const config: McpServerConfig = {
	id: "sdk-fixture",
	name: "sdk-fixture",
	transport: "stdio",
	command: "not-executed",
	enabled: true,
	mode: "auto",
};
const settings = { mcpServers: [config] };
let clientTransport: Transport;
let server: Server;
let pages: Map<string | undefined, ListToolsResult | Error>;
let result: CallToolResult;
let callGate: (() => Promise<void>) | undefined;
let calls: string[];

mock.module("../../../server/lib/settings", () => ({ ...actualSettings, settings }));
mock.module("../../../server/lib/mcp/transports", () => ({
	...actualTransports,
	createTransport: () => clientTransport,
}));
const { mcpManager } = await import("../../../server/lib/mcp/manager");

function tool(name: string, extra: Partial<Tool> = {}): Tool {
	return { name, inputSchema: { type: "object", properties: {} }, ...extra };
}

/**
 * Delivers a progress notification and its tools/call result in one synchronous
 * burst, the way `StdioClientTransport.processReadBuffer` walks one stdout read.
 */
class SameReadTransport implements Transport {
	onmessage?: Transport["onmessage"];
	onclose?: () => void;
	onerror?: (error: Error) => void;

	async start(): Promise<void> {}

	async close(): Promise<void> {
		this.onclose?.();
	}

	async send(message: JSONRPCMessage): Promise<void> {
		const deliver = this.onmessage;
		// Notifications such as `initialized` have a method and no id.
		if (!deliver || !("method" in message) || !("id" in message)) return;
		if (message.method === "initialize") {
			deliver({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: "2025-11-25",
					capabilities: { tools: {} },
					serverInfo: { name: "same-read", version: "1" },
				},
			});
			return;
		}
		if (message.method === "tools/list") {
			deliver({
				jsonrpc: "2.0",
				id: message.id,
				result: { tools: [tool("plain")] },
			});
			return;
		}
		if (message.method === "tools/call") {
			const token = (message.params as { _meta?: { progressToken?: unknown } } | undefined)?._meta
				?.progressToken;
			if (token === undefined) throw new Error("tools/call had no progressToken");
			deliver({
				jsonrpc: "2.0",
				method: "notifications/progress",
				params: { progressToken: token, progress: 2, total: 3, message: "batch-3" },
			});
			deliver({
				jsonrpc: "2.0",
				id: message.id,
				result: { content: [{ type: "text", text: "ok" }] },
			});
		}
	}
}

beforeEach(async () => {
	settings.mcpServers = [{ ...config }];
	pages = new Map([[undefined, { tools: [tool("plain")] }]]);
	result = { content: [{ type: "text", text: "ok" }] };
	calls = [];
	callGate = undefined;
	mcpManager.prepareTools = null;
	const pair = InMemoryTransport.createLinkedPair();
	clientTransport = pair[0];
	server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async (request) => {
		const page = pages.get(request.params?.cursor);
		if (page instanceof Error) throw page;
		return page ?? { tools: [] };
	});
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		calls.push(request.params.name);
		await callGate?.();
		return result;
	});
	await server.connect(pair[1]);
});

afterEach(async () => {
	await mcpManager.disconnect(config.id);
	await server.close();
	mock.restore();
});
afterAll(() => {
	mock.module("../../../server/lib/settings", () => actualSettings);
	mock.module("../../../server/lib/mcp/transports", () => actualTransports);
});

describe("MCP uses one published directory without output-schema compilation", () => {
	test("real bridge preserves identities on refresh and rejects collisions atomically", async () => {
		const { prepareMcpTools } = await import("../../../server/lib/mcp/tool-bridge");
		const { toolRegistry } = await import("../../../server/lib/agent/tool-registry");
		mcpManager.prepareTools = prepareMcpTools;
		await mcpManager.connect(config);
		const definition = toolRegistry.all().find((t) => t.metadata?.mcpServerId === config.id);
		expect(definition).toBeDefined();
		if (!definition) throw new Error("MCP definition was not published");
		const schema = definition.rawJsonSchema;
		expect((await mcpManager.refresh(config.id)).ok).toBe(true);
		expect(toolRegistry.get(definition.name)).toBe(definition);
		expect(toolRegistry.get(definition.name)?.rawJsonSchema).toBe(schema);
		pages = new Map([[undefined, { tools: [tool("a.b"), tool("a_b")] }]]);
		expect((await mcpManager.refresh(config.id)).ok).toBe(false);
		expect(mcpManager.getAvailableTools().map((t) => t.tool.name)).toEqual(["plain"]);
		expect(toolRegistry.all().filter((t) => t.metadata?.mcpServerId === config.id)).toEqual([
			definition,
		]);
		expect(toolRegistry.get(definition.name)).toBe(definition);
		expect(await mcpManager.callTool(config.id, "plain", {})).toEqual({
			content: result.content,
			isError: undefined,
		});
		expect(calls).toEqual(["plain"]);
		await mcpManager.disconnect(config.id);
		expect(toolRegistry.get(definition.name)).toBeUndefined();
	});

	test("the real bridge sends dynamic arguments intact and lets the MCP server validate values", async () => {
		const { prepareMcpTools } = await import("../../../server/lib/mcp/tool-bridge");
		const { toolRegistry } = await import("../../../server/lib/agent/tool-registry");
		mcpManager.prepareTools = prepareMcpTools;
		pages.set(undefined, {
			tools: [
				tool("dynamic", {
					inputSchema: {
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
						additionalProperties: true,
					},
				}),
			],
		});
		const received: unknown[] = [];
		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const args = request.params.arguments;
			received.push(args);
			if (typeof args?.value !== "string") {
				return { content: [{ type: "text", text: "value must be a string" }], isError: true };
			}
			return { content: [{ type: "text", text: JSON.stringify(args) }] };
		});
		await mcpManager.connect(config);
		const definition = toolRegistry.all().find((t) => t.metadata?.mcpServerId === config.id);
		if (!definition) throw new Error("MCP definition was not published");
		const ctx = { signal: new AbortController().signal } as ToolContext;
		const args = { value: "valid", extra: { dynamic: [1, 2] } };
		const valid = await definition.execute(
			definition.parameters.parse(args) as Record<string, unknown>,
			ctx,
		);
		expect(JSON.parse(valid.output)).toEqual(args);
		const invalid = { ...args, value: 42 };
		const rejected = await definition.execute(
			definition.parameters.parse(invalid) as Record<string, unknown>,
			ctx,
		);
		expect(rejected.isError).toBe(true);
		expect(rejected.output).toBe("value must be a string");
		expect(received).toEqual([args, invalid]);
	});

	test("discovers a large directory and an unresolved output ref without compiling validators", async () => {
		const compile = spyOn(AjvJsonSchemaValidator.prototype, "getValidator").mockImplementation(
			() => {
				throw new Error("Discovery must not compile business output schemas");
			},
		);
		const highLevel = spyOn(Client.prototype, "listTools");
		pages.set(undefined, {
			tools: Array.from({ length: 231 }, (_, index) =>
				tool(`tool-${index}`, {
					outputSchema: {
						type: "object",
						properties: Object.fromEntries(
							Array.from({ length: 50 }, (_, field) => [
								`field-${field}`,
								{ type: "string", minLength: 1, maxLength: 100 },
							]),
						),
						...(index === 0 ? { $ref: "#/$defs/missing" } : {}),
					},
				}),
			),
		});
		await mcpManager.connect(config);
		expect(mcpManager.getServerStatuses()[0].status).toBe("connected");
		expect(mcpManager.getAvailableTools()).toHaveLength(231);
		expect((await mcpManager.refresh(config.id)).ok).toBe(true);
		expect(compile).not.toHaveBeenCalled();
		expect(highLevel).not.toHaveBeenCalled();
	});

	test("task-required metadata on an earlier page is enforced before sending", async () => {
		pages.set(undefined, {
			tools: [tool("required", { execution: { taskSupport: "required" } })],
			nextCursor: "next",
		});
		pages.set("next", {
			tools: [
				tool("plain", {
					outputSchema: {
						type: "object",
						properties: { value: { type: "number" } },
						required: ["value"],
					},
				}),
			],
		});
		result = {
			content: [{ type: "text", text: "text result" }],
			structuredContent: { value: "not a number" },
		};
		const highLevel = spyOn(Client.prototype, "callTool");
		await mcpManager.connect(config);
		await expect(mcpManager.callTool(config.id, "required", {})).rejects.toThrow(
			"requires task-based execution",
		);
		await expect(mcpManager.callTool(config.id, "unknown", {})).rejects.toThrow(
			"published directory",
		);
		expect(calls).toHaveLength(0);
		expect((await mcpManager.callTool(config.id, "plain", {})).content).toEqual(result.content);
		expect(calls).toEqual(["plain"]);
		expect(highLevel).not.toHaveBeenCalled();
	});

	test("failed refresh keeps the old directory and execution metadata together", async () => {
		pages.set(undefined, {
			tools: [tool("required", { execution: { taskSupport: "required" } }), tool("plain")],
		});
		await mcpManager.connect(config);
		const previous = mcpManager.getServerStatuses()[0].tools;
		pages.set(undefined, { tools: [tool("required")], nextCursor: "broken" });
		pages.set("broken", new Error("second page unavailable"));
		expect((await mcpManager.refresh(config.id)).ok).toBe(false);
		expect(mcpManager.getServerStatuses()[0].tools).toBe(previous);
		await expect(mcpManager.callTool(config.id, "required", {})).rejects.toThrow(
			"requires task-based execution",
		);
		expect((await mcpManager.callTool(config.id, "plain", {})).content).toEqual(result.content);
		expect(calls).toEqual(["plain"]);
	});

	test("tool discovery still validates the protocol shape", async () => {
		await mcpManager.connect(config);
		const previous = mcpManager.getServerStatuses()[0].tools;
		// Deliberately malformed wire data, not a business-schema failure.
		pages.set(undefined, {
			tools: [{ name: 42, inputSchema: { type: "object" } } as unknown as Tool],
		});
		expect((await mcpManager.refresh(config.id)).ok).toBe(false);
		expect(mcpManager.getServerStatuses()[0].tools).toBe(previous);
	});

	test("call result envelopes are checked while valid text/image/resource content is unchanged", async () => {
		await mcpManager.connect(config);
		result = {
			content: [
				{ type: "text", text: "text" },
				{ type: "image", data: "AA==", mimeType: "image/png" },
				{ type: "resource", resource: { uri: "fixture://resource", text: "document" } },
			],
			isError: true,
		};
		expect(await mcpManager.callTool(config.id, "plain", {})).toEqual(result);
		result = { content: [{ type: "text", text: 42 }] } as unknown as CallToolResult;
		await expect(mcpManager.callTool(config.id, "plain", {})).rejects.toThrow();
		expect(calls).toHaveLength(2);
	});

	test("structured-only content is serialized as text, without replay", async () => {
		await mcpManager.connect(config);
		result = { content: [], structuredContent: { value: 42, nested: { ok: true } } };
		const response = await mcpManager.callTool(config.id, "plain", {});
		expect(response.content).toEqual([{ type: "text", text: '{"value":42,"nested":{"ok":true}}' }]);
		expect(response.isError).toBeUndefined();
		const large = { value: "x".repeat(200_000) };
		result = { content: [], structuredContent: large };
		const capped = (await mcpManager.callTool(config.id, "plain", {})).content[0].text ?? "";
		const [notice, excerpt] = capped.split("\n");
		expect(notice).toBe("[structured content truncated: first 80000 of 200012 chars]");
		expect(excerpt).toBe(JSON.stringify(large).slice(0, 80_000));
		expect(calls).toEqual(["plain", "plain"]);
	});

	test("resource links and audio content pass through the validated envelope", async () => {
		await mcpManager.connect(config);
		result = {
			content: [
				{ type: "audio", data: "AA==", mimeType: "audio/wav" },
				{ type: "resource_link", uri: "file:///a.txt", name: "a.txt" },
			],
		};
		expect((await mcpManager.callTool(config.id, "plain", {})).content).toEqual(result.content);
	});

	test("discovery keeps its per-page timeout and tool calls forward AbortSignal", async () => {
		const requests = spyOn(Client.prototype, "request");
		pages.set(undefined, { tools: [tool("plain")], nextCursor: "next" });
		pages.set("next", { tools: [] });
		await mcpManager.connect(config);
		const listRequests = requests.mock.calls.filter(([request]) => request.method === "tools/list");
		expect(listRequests).toHaveLength(2);
		for (const call of listRequests) expect(call[2]?.timeout).toBe(30_000);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const finished = Promise.withResolvers<void>();
		callGate = async () => {
			entered.resolve();
			await release.promise;
			finished.resolve();
		};
		const controller = new AbortController();
		const pending = mcpManager.callTool(config.id, "plain", {}, controller.signal);
		try {
			await entered.promise;
			controller.abort(new Error("caller stopped MCP"));
			await expect(pending).rejects.toThrow("caller stopped MCP");
			const callRequest = requests.mock.calls.find(([request]) => request.method === "tools/call");
			expect(callRequest?.[2]?.signal).toBe(controller.signal);
			expect(calls).toEqual(["plain"]);
		} finally {
			release.resolve();
			await finished.promise;
		}
	});

	test("tool calls without onProgress do not request progress notifications", async () => {
		const requests = spyOn(Client.prototype, "request");
		let progressToken: unknown = "handler-did-not-run";
		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			progressToken = request.params._meta?.progressToken;
			return result;
		});
		await mcpManager.connect(config);
		const controller = new AbortController();
		await mcpManager.callTool(config.id, "plain", {}, controller.signal);
		const callRequest = requests.mock.calls.find(([request]) => request.method === "tools/call");
		expect(callRequest?.[2]?.signal).toBe(controller.signal);
		expect(callRequest?.[2]?.onprogress).toBeUndefined();
		expect(callRequest?.[2]?.timeout).toBeUndefined();
		expect(callRequest?.[2]?.resetTimeoutOnProgress).toBeUndefined();
		expect(progressToken).toBeUndefined();
	});

	test("onProgress receives each notifications/progress payload", async () => {
		const requests = spyOn(Client.prototype, "request");
		server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			const token = request.params._meta?.progressToken;
			if (token === undefined) throw new Error("tools/call had no progressToken");
			await extra.sendNotification({
				method: "notifications/progress",
				params: { progressToken: token, progress: 1, total: 3, message: "batch-2" },
			});
			await extra.sendNotification({
				method: "notifications/progress",
				params: { progressToken: token, progress: 2, total: 3, message: "batch-3" },
			});
			return result;
		});
		await mcpManager.connect(config);
		const received: unknown[] = [];
		await mcpManager.callTool(config.id, "plain", {}, undefined, (progress) => {
			received.push(progress);
		});
		expect(received).toEqual([
			{ progress: 1, total: 3, message: "batch-2" },
			{ progress: 2, total: 3, message: "batch-3" },
		]);
		const callRequest = requests.mock.calls.find(([request]) => request.method === "tools/call");
		expect(typeof callRequest?.[2]?.onprogress).toBe("function");
		expect(callRequest?.[2]?.timeout).toBeUndefined();
		expect(callRequest?.[2]?.resetTimeoutOnProgress).toBeUndefined();
	});

	test("execute turns MCP progress into structured progress and flushes the trailing frame", async () => {
		const { prepareMcpTools } = await import("../../../server/lib/mcp/tool-bridge");
		const { toolRegistry } = await import("../../../server/lib/agent/tool-registry");
		mcpManager.prepareTools = prepareMcpTools;
		server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			const token = request.params._meta?.progressToken;
			if (token === undefined) throw new Error("tools/call had no progressToken");
			await extra.sendNotification({
				method: "notifications/progress",
				params: { progressToken: token, progress: 1, total: 3, message: "batch-2" },
			});
			await extra.sendNotification({
				method: "notifications/progress",
				params: { progressToken: token, progress: 2, total: 3, message: "batch-3" },
			});
			return result;
		});
		await mcpManager.connect(config);
		const definition = toolRegistry.all().find((tool) => tool.metadata?.mcpServerId === config.id);
		if (!definition) throw new Error("MCP definition was not published");
		const payloads: ToolProgressPayload[] = [];
		const ctx = {
			signal: new AbortController().signal,
			emitStructuredProgress: (progress: ToolProgressPayload) => {
				payloads.push(progress);
			},
		} as ToolContext;
		await definition.execute({}, ctx);
		expect(payloads).toEqual([
			{ completed: 1, total: 3, currentItem: "batch-2" },
			{ completed: 2, total: 3, currentItem: "batch-3" },
		]);
		await Bun.sleep(400);
		expect(payloads).toEqual([
			{ completed: 1, total: 3, currentItem: "batch-2" },
			{ completed: 2, total: 3, currentItem: "batch-3" },
		]);
	});

	test("execute skips empty progress, keeps a zero with a total, and clips long messages", async () => {
		const { prepareMcpTools } = await import("../../../server/lib/mcp/tool-bridge");
		const { toolRegistry } = await import("../../../server/lib/agent/tool-registry");
		mcpManager.prepareTools = prepareMcpTools;
		let script: Array<{ progress: number; total?: number; message?: string }> = [];
		server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
			const token = request.params._meta?.progressToken;
			if (token === undefined) throw new Error("tools/call had no progressToken");
			for (const notice of script) {
				await extra.sendNotification({
					method: "notifications/progress",
					params: { progressToken: token, ...notice },
				});
			}
			return result;
		});
		await mcpManager.connect(config);
		const definition = toolRegistry.all().find((tool) => tool.metadata?.mcpServerId === config.id);
		if (!definition) throw new Error("MCP definition was not published");
		const payloads: ToolProgressPayload[] = [];
		const ctx = {
			signal: new AbortController().signal,
			emitStructuredProgress: (progress: ToolProgressPayload) => {
				payloads.push(progress);
			},
		} as ToolContext;
		const run = async (notices: typeof script) => {
			payloads.length = 0;
			script = notices;
			await definition.execute({}, ctx);
			return [...payloads];
		};
		expect(await run([{ progress: 0 }])).toEqual([]);
		expect(await run([{ progress: 0, total: 3 }])).toEqual([{ completed: 0, total: 3 }]);
		expect(await run([{ progress: 5, total: 0 }])).toEqual([{ completed: 5 }]);
		const message = "𐍈".repeat(81);
		expect(await run([{ progress: 1, total: 2, message }])).toEqual([
			{ completed: 1, total: 2, currentItem: `${"𐍈".repeat(80)}…` },
		]);
	});

	test("progress delivered in the same read as the tools/call result still reaches execute", async () => {
		clientTransport = new SameReadTransport();
		const { prepareMcpTools } = await import("../../../server/lib/mcp/tool-bridge");
		const { toolRegistry } = await import("../../../server/lib/agent/tool-registry");
		mcpManager.prepareTools = prepareMcpTools;
		await mcpManager.connect(config);
		const definition = toolRegistry
			.all()
			.find((entry) => entry.metadata?.mcpServerId === config.id);
		if (!definition) throw new Error("MCP definition was not published");
		const payloads: ToolProgressPayload[] = [];
		const ctx = {
			signal: new AbortController().signal,
			emitStructuredProgress: (progress: ToolProgressPayload) => {
				payloads.push(progress);
			},
		} as ToolContext;
		const output = await definition.execute({}, ctx);
		expect(payloads).toEqual([{ completed: 2, total: 3, currentItem: "batch-3" }]);
		expect(output.output).toBe("ok");
		expect(output.isError).toBeUndefined();
	});
});
