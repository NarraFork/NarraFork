import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@server/lib/agent/types";
import { settings } from "@server/lib/settings";
import { z } from "zod";
import type { CustomSubagentDef } from "../custom-subagent-service";
import { resolveToolFilter } from "../subagent-tools";

const originalMcpServers = settings.mcpServers;

function makeTool(name: string): ToolDefinition {
	return {
		name,
		description: "Test tool",
		parameters: z.object({}),
		execute: async () => ({ output: "ok" }),
	};
}

function makeMcpTool(serverId: string, toolName: string): ToolDefinition {
	return {
		...makeTool(`mcp__${serverId}__${toolName}`),
		metadata: {
			mcpServerId: serverId,
			mcpServerName: serverId,
			mcpToolName: toolName,
		},
	};
}

const readTool = makeTool("Read");
const grepTool = makeTool("Grep");
const askUserQuestionTool = makeTool("AskUserQuestion");
const mcpReadTool = makeMcpTool("configured", "read");
const mcpWriteTool = makeMcpTool("configured", "write");
const mcpAskTool = makeMcpTool("configured", "ask");
const mcpDeniedTool = makeMcpTool("configured", "denied");
const mcpUnsetTool = makeMcpTool("unconfigured", "unset");

function getFilter(subagentType: string, customDef?: CustomSubagentDef) {
	const filter = resolveToolFilter(subagentType, customDef);
	expect(filter).toBeDefined();
	return filter as NonNullable<typeof filter>;
}

beforeEach(() => {
	settings.mcpServers = [
		{
			id: "configured",
			name: "Configured MCP",
			transport: "stdio",
			command: "noop",
			enabled: true,
			defaultBehavior: "ask",
			toolPermissions: [
				{ toolName: "read", behavior: "readOnly" },
				{ toolName: "write", behavior: "readWrite" },
				{ toolName: "denied", behavior: "deny" },
			],
		},
		{
			id: "unconfigured",
			name: "Unconfigured MCP",
			transport: "stdio",
			command: "noop",
			enabled: true,
		},
	];
});

afterAll(() => {
	settings.mcpServers = originalMcpServers;
});

describe("resolveToolFilter", () => {
	test("explore and plan subagents only include readOnly MCP tools", () => {
		for (const subagentType of ["explore", "plan"]) {
			const filter = getFilter(subagentType);

			expect(filter(mcpReadTool)).toBe(true);
			expect(filter(askUserQuestionTool)).toBe(false);
			expect(filter(mcpWriteTool)).toBe(false);
			expect(filter(mcpAskTool)).toBe(false);
			expect(filter(mcpDeniedTool)).toBe(false);
			expect(filter(mcpUnsetTool)).toBe(false);
		}
	});

	test("general subagents include all non-denied MCP tools", () => {
		const filter = getFilter("general");

		expect(filter(mcpReadTool)).toBe(true);
		expect(filter(askUserQuestionTool)).toBe(false);
		expect(filter(mcpWriteTool)).toBe(true);
		expect(filter(mcpAskTool)).toBe(true);
		expect(filter(mcpUnsetTool)).toBe(true);
		expect(filter(mcpDeniedTool)).toBe(false);
	});

	test("custom subagents only include explicitly listed tools and still honor MCP deny", () => {
		const customDef: CustomSubagentDef = {
			name: "reviewer",
			description: "Custom reviewer",
			toolAccess: "custom",
			customTools: [
				"Read",
				"AskUserQuestion",
				"mcp__configured__write",
				"mcp__unconfigured__unset",
				"mcp__configured__denied",
			],
			defaultModel: "",
			prompt: "Review things.",
			location: "test",
		};
		const filter = getFilter("reviewer", customDef);

		expect(filter(readTool)).toBe(true);
		expect(filter(grepTool)).toBe(false);
		expect(filter(askUserQuestionTool)).toBe(false);
		expect(filter(mcpWriteTool)).toBe(true);
		expect(filter(mcpUnsetTool)).toBe(true);
		expect(filter(mcpAskTool)).toBe(false);
		expect(filter(mcpDeniedTool)).toBe(false);
	});
});
