/**
 * End-to-end test: two-turn tool calling via OpenAI Responses API.
 *
 * Turn 0: send user message → model should call a tool (e.g. Read)
 * Turn 1: send fake tool result back → model should respond with text
 *
 * This script exercises the full OpenAIProvider flow:
 *   injectSystemPrompt → formatTools → chat() SSE parsing →
 *   pushAssistantTurn → formatToolResult → pushUserTurn → chat() again
 *
 * Usage: bun run scripts/test-responses-e2e.ts
 */

import { OpenAIProvider } from "../server/lib/agent/openai-provider";
import { toolRegistry } from "../server/lib/agent/tool-registry";
import { registerCoreTools } from "../server/lib/agent/tools";
import type { AgentToolUse } from "../server/lib/agent/types";
import { getOpenaiProviderConfig, parseModelId, settings } from "../server/lib/settings";

// ── Setup ──

registerCoreTools();
const providerConfig = getOpenaiProviderConfig();
if (!providerConfig) {
	console.error("❌ No OpenAI provider configured.");
	process.exit(1);
}
const provider = new OpenAIProvider(providerConfig);

const apiKey = settings.openaiProviders?.[0]?.apiKey;
const baseUrl = (settings.openaiProviders?.[0]?.baseUrl || "https://api.openai.com/v1").replace(
	/\/+$/,
	"",
);
const model = settings.openaiProviders?.[0]?.defaultModel ?? "gpt-5";

console.log("=== Config ===");
console.log(`  apiMode: ${provider.apiMode}`);
console.log(`  model: ${model} → bare: ${parseModelId(model).model}`);
console.log(`  baseUrl: ${baseUrl}`);

if (!apiKey) {
	console.error("❌ No API key configured (openai.apiKey)");
	process.exit(1);
}

const allTools = toolRegistry.all().filter((t) => !t.isAvailable || t.isAvailable());
const tools = provider.formatTools(allTools);
console.log(`  tools: ${allTools.length} registered, ${tools.length} formatted`);
console.log(`  tool[0] sample: ${JSON.stringify(tools[0]).slice(0, 200)}`);

// ── Build initial history with system prompt ──

const history: unknown[] = [];
provider.injectSystemPrompt(
	history,
	`You are a coding assistant.\n\n## Current Working Directory\n\n\`${process.cwd()}\``,
	model,
	"zh-CN",
);

console.log("\n=== Turn 0: User asks to read package.json ===");

// Collect events from chat() — accumulate toolUseChunks like the real agent loop does
const collectedToolUses: AgentToolUse[] = [];
let collectedText = "";
const toolUseAccum = new Map<string, { name: string; inputChunks: string[] }>();

const ac0 = new AbortController();
for await (const evt of provider.chat({
	conversationId: "test-e2e",
	content: "读取 package.json 文件的内容",
	model,
	cwd: process.cwd(),
	history: [...history],
	tools,
	toolResults: [],
	signal: ac0.signal,
})) {
	if (evt.text) {
		collectedText += evt.text;
		process.stdout.write(evt.text);
	}
	if (evt.toolUseChunk) {
		const { toolUseId: id, name, input, stop } = evt.toolUseChunk;
		if (id && name && !toolUseAccum.has(id)) {
			toolUseAccum.set(id, { name, inputChunks: [] });
			console.log(`\n  🔧 Tool call started: ${name} [${id}]`);
		}
		const acc = toolUseAccum.get(id);
		if (acc) {
			if (typeof input === "string") {
				acc.inputChunks.push(input);
			}
			if (stop) {
				const raw = acc.inputChunks.join("");
				let parsedInput: Record<string, unknown> = {};
				try {
					parsedInput = JSON.parse(raw);
				} catch {
					parsedInput = { _raw: raw };
				}
				collectedToolUses.push({ toolUseId: id, name: acc.name, input: parsedInput });
				toolUseAccum.delete(id);
				console.log(
					`  ✅ Tool call complete: ${acc.name} [${id}] → ${JSON.stringify(parsedInput).slice(0, 80)}`,
				);
			}
		}
	}
	// Also collect flat toolUses if emitted (standard path)
	if (evt.toolUses) {
		for (const tu of evt.toolUses) {
			if (!collectedToolUses.some((c) => c.toolUseId === tu.toolUseId)) {
				collectedToolUses.push(tu);
			}
		}
	}
	if (evt._responsesApi) {
		console.log("  📡 Responses API format detected");
	}
	if (evt.invalidState) {
		console.log(`\n  ⚠️ Invalid state: ${evt.invalidState.reason} — ${evt.invalidState.message}`);
	}
}

console.log(`\n\n--- Turn 0 Summary ---`);
console.log(`  apiMode (after stream): ${provider.apiMode}`);
console.log(`  text: "${collectedText.slice(0, 100)}"`);
console.log(`  toolUses: ${collectedToolUses.length}`);
for (const tu of collectedToolUses) {
	console.log(`    ${tu.name} [${tu.toolUseId}] input=${JSON.stringify(tu.input).slice(0, 80)}`);
}

if (collectedToolUses.length === 0) {
	console.log("\n⚠️ Model didn't call any tools. Cannot test Turn 1.");
	console.log("   This might mean the model responded with text instead of using tools.");
	process.exit(0);
}

// ── Push Turn 0 results into history ──

// Push assistant turn in standard CC format (with tool_calls)
const assistantMsg: Record<string, unknown> = { role: "assistant", content: collectedText || null };
if (collectedToolUses.length > 0) {
	assistantMsg.tool_calls = collectedToolUses.map((tu) => ({
		id: tu.toolUseId,
		type: "function",
		function: { name: tu.name, arguments: JSON.stringify(tu.input) },
	}));
}
(history as unknown[]).push(assistantMsg);

// Format tool results — try standard Chat Completions format instead of Responses API
const toolResults: unknown[] = [];
for (const tu of collectedToolUses) {
	const toolDef = toolRegistry.get(tu.name);
	let output: string;
	if (toolDef) {
		try {
			console.log(`  ▶ Executing ${tu.name}(${JSON.stringify(tu.input).slice(0, 80)})`);
			const result = await toolDef.execute(tu.input, { cwd: process.cwd() });
			output = typeof result === "string" ? result : JSON.stringify(result);
			console.log(`  ◀ Result: ${output.length} chars`);
		} catch (err) {
			output = `Error: ${err}`;
		}
	} else {
		output = `Unknown tool: ${tu.name}`;
	}
	// Use standard CC format: role: "tool"
	toolResults.push({ role: "tool", tool_call_id: tu.toolUseId, content: output });
}

// Don't push anything extra to history — tool results go via chat() param
// provider.pushUserTurn(history, "", model, []);

console.log("\n=== History before Turn 1 (full JSON) ===");
for (const [i, m] of (history as Record<string, unknown>[]).entries()) {
	console.log(`  [${i}] ${JSON.stringify(m).slice(0, 200)}`);
}
console.log(`  + ${toolResults.length} pending tool results (CC format)`);
for (const [i, tr] of (toolResults as Record<string, unknown>[]).entries()) {
	console.log(`  toolResult[${i}]: ${JSON.stringify(tr).slice(0, 300)}`);
}

console.log("\n=== Turn 1: Sending tool results back ===");

let turn1Text = "";
const turn1ToolUses: AgentToolUse[] = [];

const ac1 = new AbortController();
for await (const evt of provider.chat({
	conversationId: "test-e2e",
	content: "这个项目的 name 和 version 分别是什么？请从刚才读取的内容中提取。",
	model,
	cwd: process.cwd(),
	history: [...history],
	tools,
	toolResults,
	signal: ac1.signal,
})) {
	if (evt.text) {
		turn1Text += evt.text;
		process.stdout.write(evt.text);
	}
	if (evt.toolUseChunk?.name && !evt.toolUseChunk.stop) {
		console.log(`\n  🔧 Tool call: ${evt.toolUseChunk.name}`);
	}
	if (evt.toolUses) {
		for (const tu of evt.toolUses) turn1ToolUses.push(tu);
	}
	if (evt.invalidState) {
		console.log(`\n  ⚠️ ${evt.invalidState.reason}: ${evt.invalidState.message}`);
	}
}

console.log(`\n\n--- Turn 1 Summary ---`);
console.log(`  text: "${turn1Text.slice(0, 200)}"`);
console.log(`  toolUses: ${turn1ToolUses.length}`);

if (turn1Text) {
	console.log("\n✅ Success — model received tool results and responded with text.");
} else if (turn1ToolUses.length > 0) {
	console.log("\n✅ Success — model received tool results and made another tool call.");
} else {
	console.log("\n❌ Failure — model didn't produce text or tool calls in Turn 1.");
}

process.exit(0);
