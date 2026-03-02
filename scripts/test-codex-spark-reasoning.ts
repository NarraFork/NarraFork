/**
 * 测试 Codex 模型是否有 reasoning 信号（默认 gpt-5.3-codex）。
 *
 * 默认会跑两组：
 * 1) auto（不传 reasoningEffort）
 * 2) high（传 reasoningEffort=high）
 *
 * 观察信号：
 * - SSE 中是否出现 event.reasoning 增量
 * - usage 中是否出现 reasoningTokens > 0
 *
 * 用法：
 *   bun scripts/test-codex-spark-reasoning.ts
 *   bun scripts/test-codex-spark-reasoning.ts --single --effort high
 *   bun scripts/test-codex-spark-reasoning.ts --model gpt-5.3-codex
 *   bun scripts/test-codex-spark-reasoning.ts --prompt "请先思考再回答：..."
 *   bun scripts/test-codex-spark-reasoning.ts --timeout-ms 120000
 */

import { randomUUID } from "node:crypto";
import { CodexProvider } from "../server/lib/agent/codex-provider";

type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

interface CaseResult {
	label: string;
	reasoningEffort?: ReasoningEffort;
	ok: boolean;
	error?: string;
	textChars: number;
	reasoningChars: number;
	usageEvents: number;
	maxReasoningTokens: number;
	hasReasoningDelta: boolean;
	hasReasoningTokenUsage: boolean;
	hasReasoning: boolean;
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag);
}

function getArgValue(args: string[], key: string): string | undefined {
	const idx = args.indexOf(key);
	if (idx < 0) return undefined;
	return args[idx + 1];
}

function parseEffort(v?: string): ReasoningEffort | undefined {
	if (!v) return undefined;
	if (v === "low" || v === "medium" || v === "high" || v === "xhigh") return v;
	throw new Error(`无效 --effort=${v}，必须是 low|medium|high|xhigh`);
}

function printHelp(): void {
	console.log(`\n测试 Codex 模型 reasoning\n
参数：
  --model <id>        模型（默认 gpt-5.3-codex）
  --prompt <text>     测试 prompt
  --effort <level>    low|medium|high|xhigh
  --single            只跑一组（默认会跑 auto + high 两组）
  --timeout-ms <n>    每组超时毫秒（默认 90000）
  --help              显示帮助
`);
}

async function runOneCase(options: {
	model: string;
	prompt: string;
	timeoutMs: number;
	label: string;
	reasoningEffort?: ReasoningEffort;
}): Promise<CaseResult> {
	const { model, prompt, timeoutMs, label, reasoningEffort } = options;
	const provider = new CodexProvider();
	const history: unknown[] = [];

	provider.injectSystemPrompt(
		history,
		"You are a coding assistant. Please answer in Simplified Chinese.",
		model,
		"zh-CN",
	);

	let text = "";
	let reasoning = "";
	let usageEvents = 0;
	let maxReasoningTokens = 0;

	const abortController = new AbortController();
	const timer = setTimeout(() => {
		abortController.abort(new Error(`Timeout after ${timeoutMs}ms`));
	}, timeoutMs);

	try {
		for await (const event of provider.chat({
			conversationId: randomUUID(),
			content: prompt,
			model,
			cwd: process.cwd(),
			history: [...history],
			tools: [],
			toolResults: [],
			signal: abortController.signal,
			reasoningEffort,
		})) {
			if (event.invalidState) {
				throw new Error(`${event.invalidState.reason}: ${event.invalidState.message}`);
			}
			if (event.text) {
				text += event.text;
			}
			if (event.reasoning) {
				reasoning += event.reasoning;
			}
			if (event.usage) {
				usageEvents++;
				maxReasoningTokens = Math.max(maxReasoningTokens, event.usage.reasoningTokens ?? 0);
			}
		}

		const hasReasoningDelta = reasoning.trim().length > 0;
		const hasReasoningTokenUsage = maxReasoningTokens > 0;
		return {
			label,
			reasoningEffort,
			ok: true,
			textChars: text.length,
			reasoningChars: reasoning.length,
			usageEvents,
			maxReasoningTokens,
			hasReasoningDelta,
			hasReasoningTokenUsage,
			hasReasoning: hasReasoningDelta || hasReasoningTokenUsage,
		};
	} catch (err) {
		return {
			label,
			reasoningEffort,
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			textChars: text.length,
			reasoningChars: reasoning.length,
			usageEvents,
			maxReasoningTokens,
			hasReasoningDelta: false,
			hasReasoningTokenUsage: false,
			hasReasoning: false,
		};
	} finally {
		clearTimeout(timer);
	}
}

function printCaseResult(r: CaseResult): void {
	console.log(`\n=== ${r.label} ===`);
	console.log(`reasoningEffort: ${r.reasoningEffort ?? "auto(未传)"}`);
	if (!r.ok) {
		console.log(`❌ 失败: ${r.error}`);
		return;
	}
	console.log(`textChars: ${r.textChars}`);
	console.log(`reasoningChars: ${r.reasoningChars}`);
	console.log(`usageEvents: ${r.usageEvents}`);
	console.log(`maxReasoningTokens: ${r.maxReasoningTokens}`);
	console.log(`hasReasoningDelta: ${r.hasReasoningDelta}`);
	console.log(`hasReasoningTokenUsage: ${r.hasReasoningTokenUsage}`);
	console.log(`hasReasoning(综合): ${r.hasReasoning ? "✅ YES" : "❌ NO"}`);
}

async function main() {
	const args = process.argv.slice(2);
	if (hasFlag(args, "--help")) {
		printHelp();
		process.exit(0);
	}

	const model = getArgValue(args, "--model") ?? "gpt-5.3-codex";
	const prompt =
		getArgValue(args, "--prompt") ??
		"请先进行充分思考，再只输出最终结果：计算 (12345 * 6789) - (2222 * 3333)";
	const timeoutMs = Number.parseInt(getArgValue(args, "--timeout-ms") ?? "90000", 10);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error("--timeout-ms 必须是正整数");
	}

	const effort = parseEffort(getArgValue(args, "--effort"));
	const single = hasFlag(args, "--single");

	const cases: Array<{ label: string; reasoningEffort?: ReasoningEffort }> = single
		? [{ label: "single", reasoningEffort: effort }]
		: effort
			? [
					{ label: "auto-baseline", reasoningEffort: undefined },
					{ label: `effort-${effort}`, reasoningEffort: effort },
				]
			: [
					{ label: "auto-baseline", reasoningEffort: undefined },
					{ label: "effort-high", reasoningEffort: "high" },
				];

	console.log("\n=== Codex Reasoning Probe ===");
	console.log(`model: ${model}`);
	console.log(`timeoutMs: ${timeoutMs}`);
	console.log(`prompt: ${prompt}`);

	const results: CaseResult[] = [];
	for (const c of cases) {
		const result = await runOneCase({
			model,
			prompt,
			timeoutMs,
			label: c.label,
			reasoningEffort: c.reasoningEffort,
		});
		results.push(result);
		printCaseResult(result);
	}

	const best = results.find((r) => r.ok && r.hasReasoning);
	console.log("\n=== 结论 ===");
	if (best) {
		console.log(`✅ 检测到 reasoning 信号（case=${best.label}）`);
	} else {
		console.log("❌ 未检测到 reasoning 信号");
		console.log("   注意：某些网关可能不回传 reasoning delta / reasoning tokens。\n");
	}
}

main().catch((err) => {
	console.error("\n❌ 脚本执行失败:", err instanceof Error ? err.message : String(err));
	process.exit(1);
});
