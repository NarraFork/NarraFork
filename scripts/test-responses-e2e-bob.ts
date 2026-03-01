/**
 * End-to-end test: send a real Responses API request to bob_cx with gpt-5.3-codex
 *
 * Usage: bun run scripts/test-responses-e2e-bob.ts
 */

import { OpenAIProvider } from "../server/lib/agent/openai-provider";
import { toolRegistry } from "../server/lib/agent/tool-registry";
import { registerCoreTools } from "../server/lib/agent/tools";
import { getOpenaiProviderConfig } from "../server/lib/settings";

console.log("=== Responses API E2E Test (bob_cx + gpt-5.3-codex) ===\n");

// Setup
registerCoreTools();
const providerConfig = getOpenaiProviderConfig("bob_cx");
if (!providerConfig) {
	console.error("❌ No provider with prefix 'bob_cx' found.");
	process.exit(1);
}

console.log(`Provider: ${providerConfig.name}`);
console.log(`API Mode: ${providerConfig.apiMode}`);
console.log(`Base URL: ${providerConfig.baseUrl}`);
console.log(`Model: gpt-5.3-codex\n`);

const provider = new OpenAIProvider(providerConfig);
const allTools = toolRegistry.all().filter((t) => !t.isAvailable || t.isAvailable());
const tools = provider.formatTools(allTools);

console.log(`Registered ${tools.length} tools\n`);

// Build request
const systemPrompt = `You are an AI coding assistant with access to tools. You MUST use your tools to accomplish tasks.

## Current Working Directory

\`${process.cwd()}\``;

const history: unknown[] = [];
provider.injectSystemPrompt(history, systemPrompt, "gpt-5.3-codex", "zh-CN");

const userMessage = "读取当前目录下的 package.json 文件，告诉我项目名称";

console.log("User message:", userMessage);
console.log("\n--- Streaming response ---\n");

let hasToolCall = false;
let textContent = "";
const toolCalls: Array<{ id: string; name: string; args: string }> = [];

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
			textContent += event.text;
		}

		if (event.reasoning) {
			// Suppress reasoning output for cleaner logs
		}

		if (event.toolUseChunk) {
			const chunk = event.toolUseChunk;
			if (!chunk.stop) {
				// Tool call started or argument streaming
				if (chunk.input === undefined) {
					console.log(`\n\n🔧 Tool call started: ${chunk.name} (${chunk.toolUseId})`);
					hasToolCall = true;
					toolCalls.push({ id: chunk.toolUseId, name: chunk.name, args: "" });
				} else {
					// Accumulate arguments
					const tc = toolCalls.find((t) => t.id === chunk.toolUseId);
					if (tc) tc.args += chunk.input;
				}
			} else {
				// Tool call completed
				const tc = toolCalls.find((t) => t.id === chunk.toolUseId);
				if (tc) {
					console.log(`   Arguments: ${tc.args.slice(0, 100)}${tc.args.length > 100 ? "..." : ""}`);
				}
			}
		}

		if (event.toolUses) {
			// Fallback: some providers send complete tool_uses instead of chunks
			for (const tu of event.toolUses) {
				console.log(`\n\n🔧 Tool call: ${tu.name} (${tu.toolUseId})`);
				console.log(`   Arguments: ${JSON.stringify(tu.input).slice(0, 100)}`);
				hasToolCall = true;
			}
		}

		if (event.invalidState) {
			console.error(`\n\n❌ Error: ${event.invalidState.message}`);
			process.exit(1);
		}
	}

	console.log("\n\n--- Summary ---");
	console.log(`Text length: ${textContent.length}`);
	console.log(`Tool calls: ${hasToolCall ? toolCalls.length : 0}`);

	if (hasToolCall) {
		console.log("\n✅ SUCCESS: Model called tools via Responses API!");
		for (const tc of toolCalls) {
			console.log(`   - ${tc.name}`);
		}
	} else {
		console.log("\n⚠️  Model did NOT call tools. Possible issues:");
		console.log("   1. Gateway not forwarding tools field");
		console.log("   2. Model choosing text response");
		console.log("   3. Tool format incompatible with this endpoint");
	}

	process.exit(hasToolCall ? 0 : 1);
} catch (err) {
	console.error("\n\n❌ Request failed:", err);
	process.exit(1);
}
