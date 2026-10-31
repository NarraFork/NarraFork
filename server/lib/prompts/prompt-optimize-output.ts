/**
 * Text-only fallback for prompt optimization. Remove explicit outer packaging,
 * never extract embedded examples or rewrite the prompt's body. Validated
 * structured fields bypass this helper entirely.
 */
const LEADING_THINKING_BLOCK = /^<(thinking|think|reasoning)>[\s\S]*?<\/\1\s*>\s*/i;
const PREAMBLE = /^(?:Here is the optimized prompt|Optimized prompt|优化后的提示词)[:：]$/i;
const WRAPPING_EMPHASIS = /^(\*\*|__|\*|_)(.*?)\1$/;

function stripLeadingPreamble(text: string, original: string): string {
	const newline = text.indexOf("\n");
	if (newline === -1) return text;
	const label = text.slice(0, newline).trim();
	if (original.trimStart().startsWith(label)) return text;
	return PREAMBLE.test(label.replace(WRAPPING_EMPHASIS, "$2").trim())
		? text.slice(newline + 1).trim()
		: text;
}

function stripWrappingQuotes(text: string): string {
	if (text.length < 2) return text;
	const first = text[0];
	const last = text[text.length - 1];
	return (first === '"' && last === '"') || (first === "'" && last === "'")
		? text.slice(1, -1).trim()
		: text;
}

function stripWrappingFence(text: string): string {
	const lines = text.split("\n");
	if (lines.length <= 2 || !/^```[^`]*$/.test(lines[0]) || lines.at(-1) !== "```") {
		return text;
	}
	// Separate fenced examples are content, not a single enclosing wrapper.
	if (lines.slice(1, -1).some((line) => line.startsWith("```"))) return text;
	return lines.slice(1, -1).join("\n").trim();
}

/** Return the original draft if explicit wrapper removal leaves nothing usable. */
export function normalizeOptimizedPrompt(raw: string, original: string): string {
	let result = raw.trim().replace(LEADING_THINKING_BLOCK, "");
	result = stripLeadingPreamble(result, original);
	result = stripWrappingQuotes(result);
	result = stripWrappingFence(result);
	return result || original;
}
