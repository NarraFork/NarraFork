/**
 * The Terminal tool's input escapes. The model writes Enter as a literal `\n` and control
 * keys as `\x03`; this turns them into the bytes sent to the PTY.
 */
export function processTerminalEscapes(input: string): string {
	return input
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}
