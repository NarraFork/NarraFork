/**
 * Verify OpenAI provider tool calling end-to-end.
 *
 * Usage:  bun run scripts/test-openai-tools.ts
 *
 * What it does:
 *   1. Loads project settings (reads ~/.narrafork/settings.json for apiKey / baseUrl)
 *   2. Registers core tools and formats them via OpenAIProvider.formatTools()
 *   3. Prints the first tool's JSON schema so you can visually inspect it
 *   4. Builds a minimal messages array (system + user asking to read a file)
 *   5. Sends a real streaming request to the OpenAI API
 *   6. Prints every SSE line and parsed event so you can see whether tool_calls come back
 */

import { OpenAIProvider } from "../server/lib/agent/openai-provider";
import { toolRegistry } from "../server/lib/agent/tool-registry";
import { registerCoreTools } from "../server/lib/agent/tools";
import {
	getOpenaiProviderConfig,
	parseModelId,
	resolveProvider,
	settings,
} from "../server/lib/settings";

// ── 1. Check settings ──────────────────────────────────────────────
console.log("=== Settings ===");
console.log(
	"  openai.apiKey:",
	settings.openaiProviders?.[0]?.apiKey
		? `${settings.openaiProviders[0].apiKey.slice(0, 8)}...`
		: "(not set)",
);
console.log("  openai.baseUrl:", settings.openaiProviders?.[0]?.baseUrl ?? "(default)");
console.log("  agent.defaultModel:", settings.agent.defaultModel);

const model = settings.openaiProviders?.[0]?.defaultModel ?? settings.agent.defaultModel;
const { model: bareModel } = parseModelId(model);
const resolved = resolveProvider(model);
console.log(`  resolved model: ${model} → provider=${resolved}, bareModel=${bareModel}`);

if (resolved !== "openai") {
	console.error("\n❌ Model does not resolve to openai provider. Check settings.");
	process.exit(1);
}

// ── 2. Register tools & format ─────────────────────────────────────
registerCoreTools();
const providerConfig = getOpenaiProviderConfig();
if (!providerConfig) {
	console.error("❌ No OpenAI provider configured.");
	process.exit(1);
}
const provider = new OpenAIProvider(providerConfig);
const allTools = toolRegistry.all().filter((t) => !t.isAvailable || t.isAvailable());
const formatted = provider.formatTools(allTools) as Array<{
	type: string;
	function: { name: string; description: string; parameters: Record<string, unknown> };
}>;

console.log(`\n=== Tools (${formatted.length}) ===`);
for (const t of formatted) {
	console.log(`  ${t.function.name}`);
}

// Print first tool schema in full
console.log("\n=== First tool schema (Bash) ===");
const bashTool = formatted.find((t) => t.function.name === "Bash");
if (bashTool) {
	console.log(JSON.stringify(bashTool, null, 2));
}

// ── 3. Build request body ──────────────────────────────────────────
const apiKey = settings.openaiProviders?.[0]?.apiKey;
const baseUrl = (settings.openaiProviders?.[0]?.baseUrl || "https://api.openai.com/v1").replace(
	/\/+$/,
	"",
);

if (!apiKey) {
	console.error("\n❌ No openai.apiKey configured.");
	process.exit(1);
}

const systemPrompt = `You are an AI coding assistant with access to tools for reading, writing, and editing files, running shell commands, searching codebases, and more. You MUST use your tools to accomplish tasks — do not just describe what you would do. When the user asks you to do something, take action by calling the appropriate tools.

## Current Working Directory

\`${process.cwd()}\``;

const messages = [
	{ role: "system", content: systemPrompt },
	{ role: "user", content: "读取当前目录下的 package.json 文件" },
];

const body = {
	model: bareModel,
	messages,
	tools: formatted,
	stream: true,
	stream_options: { include_usage: true },
};

console.log("\n=== Request body (without messages/tools detail) ===");
console.log(
	JSON.stringify(
		{
			model: body.model,
			messageCount: body.messages.length,
			toolCount: body.tools.length,
			stream: body.stream,
			stream_options: body.stream_options,
		},
		null,
		2,
	),
);

// ── 4. Send request & parse SSE ────────────────────────────────────
console.log(`\n=== Sending to ${baseUrl}/chat/completions ===\n`);

const response = await fetch(`${baseUrl}/chat/completions`, {
	method: "POST",
	headers: {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
	},
	body: JSON.stringify(body),
});

console.log(`HTTP ${response.status} ${response.statusText}`);
console.log("Content-Type:", response.headers.get("content-type"));

if (!response.ok) {
	const errText = await response.text();
	console.error("\n❌ API error:", errText);
	process.exit(1);
}

if (!response.body) {
	console.error("\n❌ No response body");
	process.exit(1);
}

// Read SSE stream (with timeout)
const decoder = new TextDecoder();
const reader = response.body.getReader();
let buffer = "";
let lineNum = 0;
let hasToolCalls = false;
let textContent = "";
let finishReason = "";
let reasoningChunks = 0;
const startTime = Date.now();
const TIMEOUT_MS = 90_000;
let _foundToolCall = false;

console.log("\n--- SSE Stream ---");

while (true) {
	if (Date.now() - startTime > TIMEOUT_MS) {
		console.log("\n⏰ Timeout reached, stopping stream read.");
		reader.cancel();
		break;
	}
	const { done, value } = await reader.read();
	if (done) break;
	buffer += decoder.decode(value, { stream: true });

	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		lineNum++;

		if (trimmed === "data: [DONE]") {
			console.log(`[${lineNum}] [DONE]`);
			continue;
		}

		if (!trimmed.startsWith("data: ")) continue;

		try {
			const chunk = JSON.parse(trimmed.slice(6));
			const choice = chunk.choices?.[0];

			// Only print interesting lines (not pure reasoning tokens)
			const isReasoning =
				choice?.delta?.reasoning_content && !choice?.delta?.content && !chunk.item;
			if (isReasoning) {
				reasoningChunks++;
				if (reasoningChunks <= 3) {
					console.log(`[${lineNum}] (reasoning) ${choice.delta.reasoning_content}`);
				} else if (reasoningChunks === 4) {
					console.log(`  ... (suppressing further reasoning chunks)`);
				}
			} else {
				console.log(`[${lineNum}] ${trimmed.slice(0, 500)}`);
			}

			if (choice?.delta?.tool_calls) {
				hasToolCalls = true;
				console.log(`  → STANDARD TOOL CALL:`, JSON.stringify(choice.delta.tool_calls));
			}
			// Responses API: tool call in item field
			if (chunk.item?.call_id || chunk.item?.name || chunk.item?.type === "function_call") {
				_foundToolCall = true;
				console.log(`  → RESPONSES API ITEM:`, JSON.stringify(chunk.item, null, 2).slice(0, 500));
			}
			// Responses API: arguments delta at top level
			if (typeof chunk.delta === "string" && chunk.id?.startsWith("fc_")) {
				_foundToolCall = true;
				console.log(
					`  → RESPONSES API ARG DELTA:`,
					JSON.stringify({ id: chunk.id, delta: chunk.delta }),
				);
			}
			// Responses API: item completed
			if (chunk.item?.call_id && chunk.item?.status === "completed") {
				console.log(`  → RESPONSES API COMPLETED:`, chunk.item.call_id);
				// We've seen the full tool call cycle — can stop early
				console.log("\n✅ Tool call detected and completed via Responses API format!");
				reader.cancel();
				process.exit(0);
			}
			if (choice?.delta?.content) {
				textContent += choice.delta.content;
			}
			if (choice?.finish_reason) {
				finishReason = choice.finish_reason;
			}
		} catch {
			// ignore parse errors
		}
	}
}

// Process remaining buffer
if (buffer.trim()) {
	console.log(`[final] ${buffer.trim().slice(0, 300)}`);
}

console.log("\n--- Summary ---");
console.log(`  Total SSE lines: ${lineNum}`);
console.log(`  Has tool_calls: ${hasToolCalls}`);
console.log(`  Finish reason: ${finishReason}`);
console.log(`  Text content length: ${textContent.length}`);
if (textContent && !hasToolCalls) {
	console.log(`  Text preview: ${textContent.slice(0, 300)}`);
}

if (hasToolCalls) {
	console.log("\n✅ Model IS calling tools — the provider implementation works.");
} else {
	console.log("\n⚠️  Model did NOT call tools. Possible causes:");
	console.log("  1. API gateway stripping 'tools' field from request");
	console.log("  2. Model choosing text response over tool call");
	console.log("  3. API not supporting function calling");
}
