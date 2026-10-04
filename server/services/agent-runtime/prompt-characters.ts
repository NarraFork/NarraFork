/** Count the final prompt without counting a separately cached compact summary twice. */
export function countRuntimeSystemCharacters(
	prompt: string | null | undefined,
	contextSummary: string | null | undefined,
	summaryRange?: { start: number; end: number },
): number {
	if (!prompt) return 0;
	// The summary is a distinct category even when legacy rows have no cached count yet.
	if (!contextSummary) return prompt.length;
	// Construction metadata scopes primary prompts; subagent adapters return only their
	// final text, so locate the exact persisted summary, never a guessed section title.
	const start = summaryRange?.start ?? 0;
	const end = summaryRange?.end ?? prompt.length;
	const index = prompt.indexOf(contextSummary, start);
	if (index < start || index + contextSummary.length > end) return prompt.length;
	return prompt.length - contextSummary.length;
}
