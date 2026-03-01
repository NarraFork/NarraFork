/**
 * Test OpenAI Responses API tool calling with correct message format.
 *
 * Usage: bun run scripts/test-responses-tools.ts
 */

import { OpenAIProvider } from "../server/lib/agent/openai-provider";
import { toolRegistry } from "../server/lib/agent/tool-registry";
import { registerCoreTools } from "../server/lib/agent/tools";
import { getOpenaiProviderConfig } from "../server/lib/settings";

console.log("=== Testing Responses API Tool Format ===\n");

// Register tools
registerCoreTools();
const providerConfig = getOpenaiProviderConfig("bob_cx");
if (!providerConfig) {
	console.error("❌ No OpenAI provider configured with prefix 'bob_cx'.");
	process.exit(1);
}

console.log(`Using provider: ${providerConfig.name} (${providerConfig.prefix})`);
console.log(`API mode: ${providerConfig.apiMode}`);
console.log(`Base URL: ${providerConfig.baseUrl}\n`);

const provider = new OpenAIProvider(providerConfig);
const testModel = "gpt-5.3-codex";

const allTools = toolRegistry.all().filter((t) => !t.isAvailable || t.isAvailable());
const formatted = provider.formatTools(allTools);

console.log("1. Tool Format Check:");
console.log(`   Total tools: ${formatted.length}`);
const firstTool = formatted[0] as any;
console.log(`   First tool structure:`, {
	type: firstTool.type,
	hasName: !!firstTool.name,
	hasDescription: !!firstTool.description,
	hasParameters: !!firstTool.parameters,
	hasStrict: "strict" in firstTool,
	strictValue: firstTool.strict,
});

if (firstTool.type !== "function" || !firstTool.name || !("strict" in firstTool)) {
	console.error("\n❌ Tool format is incorrect for Responses API!");
	console.error("   Expected: { type: 'function', name, description, parameters, strict }");
	console.error("   Got:", JSON.stringify(firstTool, null, 2).slice(0, 300));
	process.exit(1);
}

console.log("   ✅ Tool format is correct\n");

// Test message conversion
console.log("2. Message Format Check:");

// Build history using provider's method
// Simulate a conversation: user → assistant with tool call → tool result → user
const { history, trailingToolResults } = await provider.buildHistory(
	[
		{
			id: "msg_1",
			narratorId: "test",
			role: "user" as const,
			contentText: "Hello",
			contentJson: [],
			toolCalls: [],
			parentToolUseId: null,
			createdAt: new Date(),
		},
		{
			id: "msg_2",
			narratorId: "test",
			role: "assistant" as const,
			contentText: "Hi! How can I help?",
			contentJson: [{ type: "text", text: "Hi! How can I help?" }],
			toolCalls: [
				{
					toolUseId: "call_123",
					toolName: "Read",
					inputJson: { file_path: "test.txt" },
					outputJson: "file content",
					status: "success" as const,
				},
			],
			parentToolUseId: null,
			createdAt: new Date(),
		},
		{
			id: "msg_3",
			narratorId: "test",
			role: "user" as const,
			contentText: "Thanks",
			contentJson: [],
			toolCalls: [],
			parentToolUseId: null,
			createdAt: new Date(),
		},
	],
	testModel,
);

console.log("   Converted messages:");
for (const msg of history as any[]) {
	const msgType = msg.type || msg.role;
	const preview =
		msg.type === "function_call"
			? `${msg.name}(${msg.arguments?.slice(0, 30)}...)`
			: msg.type === "function_call_output"
				? `output for ${msg.call_id}`
				: Array.isArray(msg.content)
					? `[${msg.content.length} parts: ${msg.content[0]?.type}]`
					: typeof msg.content === "string"
						? msg.content.slice(0, 50)
						: JSON.stringify(msg.content).slice(0, 50);
	console.log(`   - ${msgType}: ${preview}`);
}

console.log("   Trailing tool results:", trailingToolResults);

// Check format
const userMsg = (history as any[]).find((m) => m.role === "user");
const assistantMsg = (history as any[]).find((m) => m.role === "assistant");
const functionCall = (history as any[]).find((m) => m.type === "function_call");
const _functionOutput = (history as any[]).find((m) => m.type === "function_call_output");

const checks = [
	{
		name: "User content is array",
		pass: !!userMsg && Array.isArray(userMsg.content),
	},
	{
		name: "User content has input_text",
		pass: !!userMsg && Array.isArray(userMsg.content) && userMsg.content[0]?.type === "input_text",
	},
	{
		name: "Assistant content is array",
		pass: !!assistantMsg && Array.isArray(assistantMsg.content),
	},
	{
		name: "Assistant content has output_text",
		pass:
			!!assistantMsg &&
			Array.isArray(assistantMsg.content) &&
			assistantMsg.content[0]?.type === "output_text",
	},
	{
		name: "Function call has type field",
		pass: !!functionCall && functionCall.type === "function_call",
	},
	{
		name: "Function output in trailing results",
		pass:
			Array.isArray(trailingToolResults) &&
			trailingToolResults.length > 0 &&
			(trailingToolResults[0] as any).type === "function_call_output",
	},
];

console.log("\n   Format checks:");
for (const check of checks) {
	console.log(`   ${check.pass ? "✅" : "❌"} ${check.name}`);
}

const allPassed = checks.every((c) => c.pass);
if (!allPassed) {
	console.error("\n❌ Message format conversion failed!");
	console.error("   Full history:", JSON.stringify(history, null, 2));
	process.exit(1);
}

console.log("\n✅ All checks passed! Responses API format is correct.");
process.exit(0);
