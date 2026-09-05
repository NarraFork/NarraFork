import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { SHELL_TOOL_NAME } from "@server/lib/agent/tools/bash";
import type { ToolDefinition } from "@server/lib/agent/types";
import { type BuiltinSubagentType, getSubagentPrompt } from "@server/lib/prompts/subagents";
import { settings } from "@server/lib/settings";
import type { Locale } from "@shared/i18n-locales";
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
const contextAskTool = makeTool("ContextAsk");
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
			expect(filter(contextAskTool)).toBe(true);
			expect(filter(makeTool("Write"))).toBe(false);
			expect(filter(makeTool("Edit"))).toBe(false);
			expect(filter(askUserQuestionTool)).toBe(false);
			expect(filter(mcpWriteTool)).toBe(false);
			expect(filter(mcpAskTool)).toBe(false);
			expect(filter(mcpDeniedTool)).toBe(false);
			expect(filter(mcpUnsetTool)).toBe(false);
		}
	});

	test("review subagents use an explicit read-only filter", () => {
		const filter = getFilter("review");
		expect(filter(readTool)).toBe(true);
		expect(filter(grepTool)).toBe(true);
		expect(filter(contextAskTool)).toBe(true);
		expect(filter(makeTool(SHELL_TOOL_NAME))).toBe(true);
		expect(filter(makeTool("Write"))).toBe(false);
		expect(filter(makeTool("Edit"))).toBe(false);
		expect(filter(mcpReadTool)).toBe(true);
		expect(filter(mcpWriteTool)).toBe(false);
	});

	test("search subagents can query sibling context without gaining write tools", () => {
		const filter = getFilter("search");
		expect(filter(contextAskTool)).toBe(true);
		expect(filter(makeTool("Write"))).toBe(false);
	});

	test("general subagents retain file write tools and include all non-denied MCP tools", () => {
		const filter = getFilter("general");

		expect(filter(makeTool("Write"))).toBe(true);
		expect(filter(makeTool("Edit"))).toBe(true);
		expect(filter(mcpReadTool)).toBe(true);
		expect(filter(contextAskTool)).toBe(true);
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
		expect(filter(contextAskTool)).toBe(false);
		expect(filter(askUserQuestionTool)).toBe(false);
		expect(filter(mcpWriteTool)).toBe(true);
		expect(filter(mcpUnsetTool)).toBe(true);
		expect(filter(mcpAskTool)).toBe(false);
		expect(filter(mcpDeniedTool)).toBe(false);
	});
});

/**
 * The prompt and the tool whitelist are separate files, and they silently drifted
 * once already: the whitelist dropped Write/Edit while the prompts still ordered
 * explore/plan subagents to "use Write to output your findings to the conclusion
 * file". Nothing failed — the subagent just burned turns calling a tool it did not
 * have. These tests bind the two together, so removing a tool from the whitelist
 * without fixing the prompt (or vice versa) fails here instead of in production.
 */
describe("explore/plan prompts match the read-only tool whitelist", () => {
	const readOnlyTypes: BuiltinSubagentType[] = ["explore", "plan"];
	const locales: Locale[] = ["en", "zh-CN"];

	test("no prompt instructs the agent to write a conclusion file", () => {
		for (const type of readOnlyTypes) {
			for (const locale of locales) {
				const prompt = getSubagentPrompt(type, locale);
				expect(prompt).toBeTruthy();
				const text = prompt as string;

				// "conclusion file" as an output CHANNEL is gone in both languages.
				// Plain "conclusion"/"结论" is still legitimate — it names the deliverable.
				expect(text).not.toContain("conclusion file");
				expect(text).not.toContain("结论文件");
				// The prompt must not claim Write/Edit access nor promise redirection.
				expect(text).not.toContain("use Write");
				expect(text).not.toContain("使用 Write");
				expect(text).not.toContain("automatically redirected");
				expect(text).not.toContain("自动重定向");
			}
		}
	});

	test("every prompt states that the final response is the output channel", () => {
		for (const type of readOnlyTypes) {
			expect(getSubagentPrompt(type, "en")).toContain("final response");
			expect(getSubagentPrompt(type, "zh-CN")).toContain("最终回复");
		}
	});

	test("prompts deny Write/Edit access exactly as the filter does", () => {
		for (const type of readOnlyTypes) {
			const filter = getFilter(type);
			// The claim the prompt makes...
			expect(getSubagentPrompt(type, "en")).toContain("You do not have Write or Edit access");
			expect(getSubagentPrompt(type, "zh-CN")).toContain("你没有 Write 或 Edit 权限");
			// ...must be the truth the runtime enforces.
			expect(filter(makeTool("Write"))).toBe(false);
			expect(filter(makeTool("Edit"))).toBe(false);
		}
	});
});
