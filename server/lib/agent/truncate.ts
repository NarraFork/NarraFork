const DEFAULT_MAX_LENGTH = 30_000;

/**
 * Truncate tool output to prevent oversized responses from blowing up context.
 * Keeps the head and tail of the output with a truncation notice in the middle.
 */
export function truncateOutput(text: string, maxLength = DEFAULT_MAX_LENGTH): string {
	if (text.length <= maxLength) return text;

	const headSize = Math.floor(maxLength * 0.6);
	const tailSize = Math.floor(maxLength * 0.3);
	const head = text.slice(0, headSize);
	const tail = text.slice(-tailSize);
	const omitted = text.length - headSize - tailSize;

	return `${head}\n\n... [${omitted} characters truncated] ...\n\n${tail}`;
}
