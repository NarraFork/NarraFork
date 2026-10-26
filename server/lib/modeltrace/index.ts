import { bank, scoreModelTrace } from "./scoring";

export const MODELTRACE_EXPECTED_COUNT = 300;
export const MODELTRACE_MAX_TEXT_LENGTH = 10_000;
const MIN_COUNT = Math.max(80, Math.ceil(MODELTRACE_EXPECTED_COUNT * 0.55));
const MAX_COUNT = Math.ceil(MODELTRACE_EXPECTED_COUNT * 1.25);

type ParseError = "too_long" | "empty" | "fence" | "json" | "array" | "integer" | "range" | "count";

export class ModelTraceOutputError extends Error {
	constructor(public readonly reason: ParseError) {
		super(`Invalid ModelTrace sample: ${reason}`);
		this.name = "ModelTraceOutputError";
	}
}

/** Presentation-only wrapping is allowed; never salvage numbers from prose. */
export function parseModelTraceOutput(text: string): number[] {
	const fail = (reason: ParseError): never => {
		throw new ModelTraceOutputError(reason);
	};
	if (text.length > MODELTRACE_MAX_TEXT_LENGTH) fail("too_long");
	let body = text.trim();
	if (!body) fail("empty");
	if (/^(?:`{3}|~{3})/.test(body)) {
		const block = /^(`{3,}|~{3,})[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1$/i.exec(body);
		if (!block) return fail("fence");
		body = block[2].trim();
	}
	let values: unknown;
	try {
		values = JSON.parse(body);
	} catch {
		fail("json");
	}
	if (!Array.isArray(values)) return fail("array");
	if (values.length && !/^\[\s*\d+(?:\s*,\s*\d+)*\s*\]$/.test(body)) fail("integer");
	if (values.some((value) => !Number.isInteger(value) || value < 1 || value > 355)) fail("range");
	if (values.length < MIN_COUNT || values.length > MAX_COUNT) fail("count");
	return values;
}

export function buildModelTracePrompt(): string {
	// Keep the upstream Guard's numerical task; example numbers would bias the sample.
	return `现在仅执行一次数字指纹采样，不要继续之前的任务。直接选择 ${MODELTRACE_EXPECTED_COUNT} 个 1 到 355（含边界）的整数。允许重复；不要排序、平衡频数、修复重复，也不要刻意构造等差规律。必须由当前模型直接逐个生成，不得使用旧样本或委托其他模型、子代理。只输出一个完整 JSON 整数数组，不要解释或 Markdown 代码块。不要调用工具、读文件或运行代码；输出数组后立即结束。`;
}

function safeLabel(value: string): string {
	return value
		.slice(0, 200)
		.replace(/[\r\n\t]/g, " ")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/[\\`*_{}[\]()#+.!|~-]/g, "\\$&");
}

const errors: Record<ParseError, [string, string]> = {
	too_long: ["回答超过10000字符上限。", "The answer exceeds the 10,000-character limit."],
	empty: ["回答为空或没有文本。", "The answer is empty or contains no text."],
	fence: [
		"仅接受一个完整JSON代码块，不能附带其他内容。",
		"Only one complete JSON code block with no surrounding text is accepted.",
	],
	json: [
		"回答不是完整JSON数组；拒答、附带说明或截断不能评分。",
		"The answer is not complete JSON; refusals, prose and truncation cannot be scored.",
	],
	array: ["回答必须是JSON数组。", "The answer must be a JSON array."],
	integer: [
		"只接受字面整数，不能包含字符串、小数、符号或指数。",
		"Only literal integers are accepted, without strings, decimals, signs or exponents.",
	],
	range: ["每个整数必须位于1到355之间。", "Every integer must be within 1..355."],
	count: [
		"数字数量必须为165到375；样本过短或过长，不生成判断。",
		"The sample must contain 165–375 numbers; no inference is made for shorter or longer samples.",
	],
};

/** Local, bounded, single-sample analysis. No network, retries or follow-up prompts. */
export function analyzeModelTrace(text: string, configuredModel: string, locale = "zh-CN"): string {
	const en = !locale.toLowerCase().startsWith("zh");
	let numbers: number[];
	try {
		numbers = parseModelTraceOutput(text);
	} catch (error) {
		if (!(error instanceof ModelTraceOutputError)) throw error;
		return en
			? `## ModelTrace: no result\n\n${errors[error.reason][1]}\n\nNo model probabilities were calculated. Only one sampling round was scheduled; the provider's existing transport retry policy still applies.`
			: `## ModelTrace：无法评分\n\n${errors[error.reason][0]}\n\n未计算模型概率。仅安排一轮采样；底层请求沿用提供商现有重试策略。`;
	}
	const { results, families } = scoreModelTrace(numbers);
	// Exact, case-insensitive candidate ID matching only: aliases must not imply identity.
	const configured = configuredModel.trim().toLowerCase();
	const rank = results.findIndex((item) => item.model.toLowerCase() === configured);
	const percent = (probability: number) => `${(probability * 100).toFixed(2)}%`;
	const label = safeLabel(configuredModel) || (en ? "(unspecified)" : "（未指定）");
	const configuration =
		rank < 0
			? en
				? `Configured model: ${label} — not included in this candidate bank (exact ID matching; aliases are not inferred).`
				: `当前配置模型：${label} — 候选库未收录（精确ID匹配，不推断别名）。`
			: en
				? `Configured model: ${label} — rank ${rank + 1}/${results.length}, probability ${percent(results[rank].probability)}.`
				: `当前配置模型：${label} — 候选库排名 ${rank + 1}/${results.length}，概率 ${percent(results[rank].probability)}。`;
	const lines = [
		en ? "## ModelTrace local statistical report" : "## ModelTrace 本地统计报告",
		"",
		en
			? `Numbers: ${numbers.length} (target: 300); samples: 1; calibration: single-sample (1); candidates: ${bank.models.length}.`
			: `数字数：${numbers.length}（目标300）；样本数：1；校准：单样本（1）；候选模型：${bank.models.length}。`,
		"",
		configuration,
		"",
		en ? "### TOP 5 model probabilities" : "### TOP5 模型概率",
		"",
		...results
			.slice(0, 5)
			.map((item, index) => `${index + 1}. ${item.displayName} — ${percent(item.probability)}`),
		"",
		en ? "### Family probabilities" : "### 家族概率",
		"",
		...families.map((item) => `- ${item.displayName} — ${percent(item.probability)}`),
		"",
		en
			? "> These are closed-set relative probabilities within the bundled candidate bank, not proof of model identity or a provider audit. Unlisted models may resemble a listed candidate. The probe inherits the current conversation: instructions, history, sampling settings and context bias can alter the result. A single sample cannot establish model substitution. Only one sampling round was scheduled; the provider's existing transport retry policy still applies."
			: "> 这些是内置候选库内的闭集相对概率，不是模型身份的证明，也不是服务商审计。未收录模型也可能与某个候选相似。采样继承当前会话，指令、历史、采样参数及上下文偏差都可能影响结果；单次样本不足以认定模型替换。仅安排一轮采样；底层请求沿用提供商现有重试策略。",
	];
	if (numbers.length < MODELTRACE_EXPECTED_COUNT) {
		lines.push(
			"",
			en
				? "Sample is shorter than requested; interpret with extra caution."
				: "样本少于请求数量，请更加谨慎解读。",
		);
	}
	return lines.join("\n");
}
