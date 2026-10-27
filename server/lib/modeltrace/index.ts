import type { ModelTraceResultBlock } from "@shared/modeltrace-result";
import { scoreModelTrace } from "./scoring";

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

/** Local single-sample analysis, containing only the five ranked candidates. */
export function analyzeModelTrace(text: string, locale = "zh-CN"): ModelTraceResultBlock {
	let numbers: number[];
	try {
		numbers = parseModelTraceOutput(text);
	} catch (error) {
		if (!(error instanceof ModelTraceOutputError)) throw error;
		return {
			type: "modeltrace_result",
			results: [],
			error: errors[error.reason][locale.toLowerCase().startsWith("zh") ? 0 : 1],
		};
	}
	return {
		type: "modeltrace_result",
		results: scoreModelTrace(numbers)
			.results.slice(0, 5)
			.map(({ model, displayName, probability }) => ({
				model,
				displayName,
				probability,
			})),
	};
}
