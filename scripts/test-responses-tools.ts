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
const firstTool = formatted[0] as Record<string, unknown> | undefined;
console.log(`   First tool structure:`, {
	type: firstTool?.type,
	hasName: !!firstTool?.name,
	hasDescription: !!firstTool?.description,
	hasParameters: !!firstTool?.parameters,
	hasStrict: firstTool ? "strict" in firstTool : false,
	strictValue: firstTool?.strict,
});

if (!firstTool || firstTool.type !== "function" || !firstTool.name || !("strict" in firstTool)) {
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
for (const entry of history) {
	const msg = entry as Record<string, unknown>;
	const msgType = String(msg.type ?? msg.role ?? "unknown");
	const content = msg.content;
	const preview =
		msg.type === "function_call"
			? `${String(msg.name ?? "")}(... )`
			: msg.type === "function_call_output"
				? `output for ${String(msg.call_id ?? "")}`
				: Array.isArray(content)
					? `[${content.length} parts: ${String((content[0] as Record<string, unknown> | undefined)?.type ?? "")}]`
					: typeof content === "string"
						? content.slice(0, 50)
						: JSON.stringify(content).slice(0, 50);
	console.log(`   - ${msgType}: ${preview}`);
}

console.log("   Trailing tool results:", trailingToolResults);

// Check format
const historyRecords = history as Array<Record<string, unknown>>;
const userMsg = historyRecords.find((m) => m.role === "user");
const assistantMsg = historyRecords.find((m) => m.role === "assistant");
const functionCall = historyRecords.find((m) => m.type === "function_call");

const userContent = Array.isArray(userMsg?.content)
	? (userMsg.content as Array<Record<string, unknown>>)
	: null;
const assistantContent = Array.isArray(assistantMsg?.content)
	? (assistantMsg.content as Array<Record<string, unknown>>)
	: null;

const checks = [
	{
		name: "User content is array",
		pass: !!userContent,
	},
	{
		name: "User content has input_text",
		pass: !!userContent && userContent[0]?.type === "input_text",
	},
	{
		name: "Assistant content is array",
		pass: !!assistantContent,
	},
	{
		name: "Assistant content has output_text",
		pass: !!assistantContent && assistantContent[0]?.type === "output_text",
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
			(trailingToolResults[0] as Record<string, unknown>).type === "function_call_output",
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
