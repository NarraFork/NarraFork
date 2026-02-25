/**
 * Raw SSE dump: see exactly what the /responses endpoint returns.
 * Usage: bun run scripts/dump-responses-sse.ts
 */

import { parseModelId, settings } from "../server/lib/settings";

const apiKey = settings.openaiProviders?.[0]?.apiKey;
const baseUrl = (settings.openaiProviders?.[0]?.baseUrl || "https://api.openai.com/v1").replace(
	/\/+$/,
	"",
);
const model = parseModelId(settings.openaiProviders?.[0]?.defaultModel ?? "gpt-5").model;

const body = {
	model,
	messages: [
		{ role: "developer", content: "You are a coding assistant. You MUST use tools." },
		{ role: "user", content: "Use the Read tool to read package.json." },
	],
	tools: [
		{
			type: "function",
			function: {
				name: "Read",
				description: "Read a file.",
				parameters: {
					type: "object",
					properties: {
						file_path: { type: "string", description: "Path to the file to read" },
					},
					required: ["file_path"],
				},
			},
		},
	],
	stream: true,
};

console.log(`POST ${baseUrl}/chat/completions`);
console.log(`model: ${model}\n`);

const resp = await fetch(`${baseUrl}/chat/completions`, {
	method: "POST",
	headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
	body: JSON.stringify(body),
});

if (!resp.ok) {
	console.error(`HTTP ${resp.status}: ${await resp.text()}`);
	process.exit(1);
}

const decoder = new TextDecoder();
const reader = resp.body!.getReader();
let buffer = "";
let lineNum = 0;

while (true) {
	const { done, value } = await reader.read();
	if (done) break;
	buffer += decoder.decode(value, { stream: true });
	const lines = buffer.split("\n");
	buffer = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		lineNum++;
		// Try to extract the event type
		if (line.startsWith("event:")) {
			console.log(`\n--- ${line} ---`);
		} else if (line.startsWith("data: ")) {
			try {
				const obj = JSON.parse(line.slice(6));
				const type = obj.type ?? "?";
				// Print type + key fields only
				const keys = Object.keys(obj)
					.filter((k) => k !== "type")
					.join(",");
				console.log(`  type=${type}  keys=[${keys}]`);
				// Print interesting fields
				if (obj.delta) console.log(`    delta: ${JSON.stringify(obj.delta).slice(0, 120)}`);
				if (obj.item) {
					const item = obj.item;
					console.log(
						`    item: type=${item.type} id=${item.id?.slice(0, 20)} name=${item.name ?? "-"} call_id=${item.call_id?.slice(0, 20) ?? "-"} status=${item.status ?? "-"}`,
					);
					if (item.arguments) console.log(`    item.arguments: ${item.arguments.slice(0, 80)}`);
				}
				if (obj.content_index !== undefined) console.log(`    content_index: ${obj.content_index}`);
				if (obj.output_index !== undefined) console.log(`    output_index: ${obj.output_index}`);
				if (obj.response?.status) console.log(`    response.status: ${obj.response.status}`);
				if (obj.response?.tools)
					console.log(`    response.tools: ${JSON.stringify(obj.response.tools).slice(0, 300)}`);
			} catch {
				console.log(`  [raw] ${line.slice(0, 200)}`);
			}
		} else {
			console.log(`  ${line.slice(0, 200)}`);
		}
	}
}

console.log(`\n--- Done (${lineNum} lines) ---`);
process.exit(0);
