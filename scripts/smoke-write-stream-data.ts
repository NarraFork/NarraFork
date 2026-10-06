export interface WriteStreamCase {
	chars: number;
	chunkChars?: number;
	intervalMs?: number;
	singleLine?: boolean;
	crlf?: boolean;
	theme?: "dark" | "light";
}

/** Deterministic syntax-bearing input shared by before/after real-browser fixtures. */
export function writeStreamText(test: WriteStreamCase): string {
	const chunks: string[] = [];
	let length = 0;
	let index = 0;
	const newline = test.crlf ? "\r\n" : "\n";
	if (test.singleLine) {
		chunks.push("export const records = [");
		length = chunks[0].length;
	}
	while (length < test.chars) {
		const line = test.singleLine
			? `{ id: ${index}, label: "entry-${index}-中文-😀", enabled: true }, `
			: `/* comment ${index} 中文 😀${newline} continued */${newline}export const entry${index} = { id: ${index}, label: \`value-${index}\`, enabled: true };${newline}`;
		chunks.push(line);
		length += line.length;
		index++;
	}
	return chunks.join("").slice(0, test.chars);
}

export function percentile(values: readonly number[], fraction: number): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}
