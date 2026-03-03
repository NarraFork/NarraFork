/**
 * Test the Responses API message structure by simulating the agent loop flow.
 * Usage: bun run scripts/test-responses-history.ts
 */

import { OpenAIProvider } from "../server/lib/agent/openai-provider";
import { toolRegistry } from "../server/lib/agent/tool-registry";
import { registerCoreTools } from "../server/lib/agent/tools";
import { getOpenaiProviderConfig } from "../server/lib/settings";

registerCoreTools();
const providerConfig = getOpenaiProviderConfig();
if (!providerConfig) {
	console.error("❌ No OpenAI provider configured.");
	process.exit(1);
}
const provider = new OpenAIProvider(providerConfig);

console.log("apiMode:", provider.apiMode);

// Simulate the agent loop history building
const history: unknown[] = [];

// 1. injectSystemPrompt
provider.injectSystemPrompt(
	history,
	"You are a coding assistant.\n\n## CWD\n`/tmp`",
	"gpt-5",
	"zh-CN",
);

console.log("\n=== After injectSystemPrompt ===");
console.log(JSON.stringify(history, null, 2));

// 2. First chat() call — simulate what chat() builds
const _tools = provider.formatTools(
	toolRegistry.all().filter((t) => !t.isAvailable || t.isAvailable()),
);
const messages1 = [...history];
// In Responses API mode, convertHistoryToResponsesApi is called
// (but history is already in correct format from injectSystemPrompt)
messages1.push({ role: "user", content: "读取 package.json" } as unknown);

console.log("\n=== Turn 0: messages sent to API ===");
for (const [i, m] of messages1.entries()) {
	const msg = m as Record<string, unknown>;
	const roleOrType = String(msg.role ?? msg.type ?? "?");
	const name = typeof msg.name === "string" ? msg.name : undefined;
	const callId = typeof msg.call_id === "string" ? msg.call_id : undefined;
	console.log(
		`  [${i}] ${roleOrType} ${name ? `(${name})` : ""} ${callId ? `call_id=${callId}` : ""}`,
	);
}

// 3. Simulate model response: text + tool call
const assistantText = "读取 package.json 文件。";
const toolUses = [{ toolUseId: "call_abc123", name: "Read", input: { file_path: "package.json" } }];

// 4. pushUserTurn (first turn, no tool results)
provider.pushUserTurn(history, "读取 package.json", "gpt-5", []);

// 5. pushAssistantTurn
provider.pushAssistantTurn(history, assistantText, toolUses);

console.log("\n=== After Turn 0 pushAssistantTurn ===");
for (const [i, m] of history.entries()) {
	const msg = m as Record<string, unknown>;
	const roleOrType = String(msg.role ?? msg.type ?? "?");
	const name = typeof msg.name === "string" ? msg.name : undefined;
	const callId = typeof msg.call_id === "string" ? msg.call_id : undefined;
	console.log(
		`  [${i}] ${roleOrType} ${name ? `(${name})` : ""} ${callId ? `call_id=${callId}` : ""}`,
	);
}

// 6. Format tool result
const toolResult = provider.formatToolResult("call_abc123", "file content here...", false);
console.log("\n=== Tool result format ===");
console.log(JSON.stringify(toolResult, null, 2));

const pendingToolResults = [toolResult];

// 7. Turn 1: pushUserTurn with tool results (happens AFTER chat() in the loop,
//    but we need to see what chat() would receive)
// In the actual loop, chat() is called BEFORE pushUserTurn.
// So at Turn 1, chat() receives:
//   history = [developer, user, assistant, function_call]
//   toolResults = [function_call_output]

console.log("\n=== Turn 1: messages that chat() would build ===");
const messages2 = [...history]; // history doesn't have tool results yet
// Simulate convertHistoryToResponsesApi (should be no-op if already in correct format)
// Then append tool results
for (const tr of pendingToolResults) {
	messages2.push(tr);
}
// No user message (content is "")

for (const [i, m] of messages2.entries()) {
	const msg = m as Record<string, unknown>;
	const contentPreview = msg.content != null ? String(msg.content).slice(0, 50) : "";
	const outputPreview = msg.output != null ? String(msg.output).slice(0, 50) : "";
	const argsPreview = msg.arguments != null ? String(msg.arguments).slice(0, 50) : "";
	const preview = contentPreview || outputPreview || argsPreview;
	const roleOrType = String(msg.role ?? msg.type ?? "?");
	const name = typeof msg.name === "string" ? msg.name : undefined;
	const callId = typeof msg.call_id === "string" ? msg.call_id : undefined;
	console.log(
		`  [${i}] ${roleOrType} ${name ? `(${name})` : ""} ${callId ? `call_id=${callId}` : ""} ${preview}`,
	);
}

// 8. Now simulate pushUserTurn for Turn 1 (happens after chat())
provider.pushUserTurn(history, "", "gpt-5", pendingToolResults);

// 9. Simulate Turn 1 assistant response with another tool call
provider.pushAssistantTurn(history, "让我再搜索一下。", [
	{ toolUseId: "call_def456", name: "Grep", input: { pattern: "test" } },
]);

const toolResult2 = provider.formatToolResult("call_def456", "grep results...", false);

console.log("\n=== Turn 2: messages that chat() would build ===");
const messages3 = [...history];
messages3.push(toolResult2);

for (const [i, m] of messages3.entries()) {
	const msg = m as Record<string, unknown>;
	const contentPreview = msg.content != null ? String(msg.content).slice(0, 50) : "";
	const outputPreview = msg.output != null ? String(msg.output).slice(0, 50) : "";
	const argsPreview = msg.arguments != null ? String(msg.arguments).slice(0, 50) : "";
	const preview = contentPreview || outputPreview || argsPreview;
	const roleOrType = String(msg.role ?? msg.type ?? "?");
	const name = typeof msg.name === "string" ? msg.name : undefined;
	const callId = typeof msg.call_id === "string" ? msg.call_id : undefined;
	console.log(
		`  [${i}] ${roleOrType} ${name ? `(${name})` : ""} ${callId ? `call_id=${callId}` : ""} ${preview}`,
	);
}

// Validate structure
console.log("\n=== Validation ===");
let valid = true;
for (const [i, m] of messages3.entries()) {
	const msg = m as Record<string, unknown>;
	if (msg.role === "tool") {
		console.log(
			`❌ [${i}] Found role="tool" — should be type="function_call_output" in Responses API`,
		);
		valid = false;
	}
	if (msg.role === "system") {
		console.log(`❌ [${i}] Found role="system" — should be role="developer" in Responses API`);
		valid = false;
	}
	if (msg.role === "assistant" && msg.tool_calls != null) {
		console.log(
			`❌ [${i}] Found assistant with tool_calls — should be separate function_call items`,
		);
		valid = false;
	}
}
if (valid) {
	console.log("✅ All messages in correct Responses API format");
}
