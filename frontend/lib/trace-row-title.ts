/**
 * Split a row title into its BOLD tool name and the rest.
 *
 * The adapter joins them as `"Name · summary"` (`toolTraceItem`), and the measured row
 * carries `toolName` alongside, so the split is a prefix check rather than a parse of the
 * separator — a summary containing its own `·` cannot confuse it.
 *
 * Returns null when the title is not that shape (a reasoning step, a caller-supplied
 * `resolveToolTitle`, a truncated title whose name was cut), in which case the title is
 * drawn verbatim. Height-neutral either way: same text, same single line.
 */
export function splitTraceRowTitle(
	title: string | undefined,
	toolName: string | undefined,
): { name: string; detail: string } | null {
	if (!title || !toolName) return null;
	// `Task` is displayed as `Agent`, so match what the adapter actually wrote.
	const displayName = toolName === "Task" ? "Agent" : toolName;
	if (!title.startsWith(displayName)) return null;
	const rest = title.slice(displayName.length);
	if (rest.length === 0) return { name: displayName, detail: "" };
	// The adapter's separator, and nothing else, may follow the name.
	if (!rest.startsWith(" · ")) return null;
	return { name: displayName, detail: rest.slice(3) };
}
