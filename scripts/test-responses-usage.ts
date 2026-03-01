/**
 * Test Responses API usage parsing (reasoning tokens, cached tokens, etc.)
 *
 * Usage: bun run scripts/test-responses-usage.ts
 */

import { OpenAIProvider } from "../server/lib/agent/openai-provider";
import { toolRegistry } from "../server/lib/agent/tool-registry";
import { registerCoreTools } from "../server/lib/agent/tools";
import { getOpenaiProviderConfig } from "../server/lib/settings";

console.log("=== Responses API Usage Parsing Test ===\n");

// Setup
registerCoreTools();
const providerConfig = getOpenaiProviderConfig("bob_cx");
if (!providerConfig) {
	console.error("❌ No provider with prefix 'bob_cx' found.");
	process.exit(1);
}

console.log(`Provider: ${providerConfig.name}`);
console.log(`API Mode: ${providerConfig.apiMode}`);
console.log(`Model: gpt-5.3-codex\n`);

const provider = new OpenAIProvider(providerConfig);
const allTools = toolRegistry.all().filter((t) => !t.isAvailable || t.isAvailable());
const tools = provider.formatTools(allTools);

// Build request
const systemPrompt = `You are an AI coding assistant.

## Current Working Directory

\`${process.cwd()}\``;

const history: unknown[] = [];
provider.injectSystemPrompt(history, systemPrompt, "gpt-5.3-codex", "zh-CN");

const userMessage = "读取 package.json 文件";

console.log("User message:", userMessage);
console.log("\n--- Streaming response ---\n");

let usageEvents = 0;
let lastUsage: {
	promptTokens?: number;
	completionTokens?: number;
	reasoningTokens?: number;
	cachedInputTokens?: number;
} | null = null;

try {
	const stream = provider.chat({
		model: "gpt-5.3-codex",
		content: userMessage,
		history,
		tools,
		toolResults: [],
		images: [],
	});

	for await (const event of stream) {
		if (event.text) {
			process.stdout.write(event.text);
		}

		if (event.usage) {
			usageEvents++;
			lastUsage = event.usage;
			console.log("\n\n📊 Usage event received:", {
				promptTokens: event.usage.promptTokens,
				completionTokens: event.usage.completionTokens,
				reasoningTokens: event.usage.reasoningTokens,
				cachedInputTokens: event.usage.cachedInputTokens,
			});
		}

		// Don't break early - wait for usage info
		if (event.invalidState) {
			console.error(`\n\n❌ Error: ${event.invalidState.message}`);
			process.exit(1);
		}
	}

	console.log("\n\n--- Summary ---");
	console.log(`Usage events received: ${usageEvents}`);

	if (lastUsage) {
		console.log("\nFinal usage:");
		console.log(`  Prompt tokens: ${lastUsage.promptTokens ?? "N/A"}`);
		console.log(`  Completion tokens: ${lastUsage.completionTokens ?? "N/A"}`);
		console.log(`  Reasoning tokens: ${lastUsage.reasoningTokens ?? "N/A"}`);
		console.log(`  Cached input tokens: ${lastUsage.cachedInputTokens ?? "N/A"}`);

		if (lastUsage.promptTokens != null) {
			console.log("\n✅ SUCCESS: Usage information parsed correctly!");
		} else {
			console.log("\n⚠️  Usage event received but promptTokens is missing");
		}
	} else {
		console.log("\n⚠️  No usage events received");
		console.log("   This may be normal if the gateway doesn't send usage info");
	}

	process.exit(0);
} catch (err) {
	console.error("\n\n❌ Request failed:", err);
	process.exit(1);
}
